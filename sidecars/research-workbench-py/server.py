"""科研工作 1.0 · 本地服务

纯标准库 HTTP 服务，把 workflow.py 的能力暴露给 web/index.html 单页界面。
启动后自动开一个 Edge 应用窗口（无浏览器边框），失败则退回默认浏览器。

    py -3.10 server.py [--port 8765] [--no-open]
"""
from __future__ import annotations

import hashlib
import json
import re
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import papertran                 # 论文翻译页：PDF 服务 / 元数据 / BabelDOC 任务
import rss                       # 情报日报：RSS 抓取/解析
import vault                     # 知识库：Obsidian Vault 扫描 / 状态写回
import workflow
import schedule                  # 定时任务：抄原版 automation（只在应用活着时调度）
import team                      # 团队：Leader + Partner 成员 + 派活队列（抄 AionUi Teams）
import zotero                    # Zotero 本机 Local API 只读接入（笔记页；不碰 zotero.sqlite）
from research_core import ResearchDB
from workflow import (ACTION, CUSTOM_WIRES, OAUTH_CONSOLE, PROVIDER_CATALOG, STAGES, STAGE_LABEL,
                      TOOL_SPECS, USABLE_WIRES, WIRE_LABEL, WorkflowDB, chat, compose_draft,
                      discover_models, litgraph, make_project_tree, run_agent, run_idea, run_outline, run_write, run_review,
                      outline_read, outline_write, doc_read, doc_write, doc_seed, OUTLINE_TEMPLATE,
                      cite_read, cite_add, cite_sync, conv_files, conv_run, conv_compile, conv_open,
                      en_state, en_run, CONV_FORMATS, _safe_path,
                      stage_download_selected, test_provider,
                      deepread_kick, deepread_state, deepread_stop)

HERE = Path(__file__).resolve().parent
WEB = HERE / "web"
DB_PATH = Path(os.environ.get("RESEARCH_WORKBENCH_DB", HERE / "data" / "research.sqlite3"))
schedule.DB_PATH = DB_PATH          # 定时任务共用同一个库（schedule 不反向 import server）
team.DB_PATH = DB_PATH              # 团队共用同一个库
UPLOADS = HERE / "data" / "uploads"
PORT = 8765
CARD_W, CARD_H = 1117, 625      # 「开始卡片」尺寸（CSS 逻辑像素）
CARD_PIN = True                 # True=窗口一直钉在卡片尺寸；点「进入」走 /api/win/maximize 后放掉
APP_TITLE = "科研工作 1.0"      # 窗口标题前缀（web/index.html 会追加 " · v<构建戳>"）
STAMP = 0                       # web/index.html 的时间戳；无边框窗口靠它认「自己那扇窗」


def _app_windows() -> list[tuple[int, str]]:
    """我们自己的 Edge app 窗口：(hwnd, 标题)。标题目录里带构建戳，用来认是哪一版。"""
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    found: list[tuple[int, str]] = []
    cb_t = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def cb(h: int, _l: int) -> bool:
        n = u.GetWindowTextLengthW(h)
        if n:
            buf = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(h, buf, n + 1)
            if buf.value.startswith(APP_TITLE) and "Microsoft" not in buf.value:   # 排除浏览器标签页窗口（标题带 " - Microsoft Edge"）
                found.append((h, buf.value))
        return True

    u.EnumWindows(cb_t(cb), 0)
    return found


def _front(hwnd: int) -> None:
    """最小化的先还原，再置前。纯 --app 复用只会聚焦、不会把最小化窗口弹回来。
    背景进程 SetForegroundWindow 会被前台锁拒绝 → 先 AttachThreadInput 到当前前台线程再设。"""
    import ctypes
    u = ctypes.windll.user32
    k = ctypes.windll.kernel32
    if u.IsIconic(hwnd):
        u.ShowWindow(hwnd, 9)                    # SW_RESTORE
    fg = u.GetForegroundWindow()
    tid_fg = u.GetWindowThreadProcessId(fg, None)
    tid_me = k.GetCurrentThreadId()
    if tid_fg and tid_fg != tid_me:
        u.AttachThreadInput(tid_me, tid_fg, True)
        u.SetForegroundWindow(hwnd)
        u.AttachThreadInput(tid_me, tid_fg, False)
    else:
        u.SetForegroundWindow(hwnd)
    if u.GetForegroundWindow() != hwnd:
        u.SwitchToThisWindow(hwnd, True)         # 兜底
    u.BringWindowToTop(hwnd)


def _maximize(hwnd: int) -> None:
    """--start-maximized 有时不生效（窗口起来是近似全屏但没最大化）→ 补一刀。"""
    import ctypes
    u = ctypes.windll.user32
    if not u.IsZoomed(hwnd):
        u.ShowWindow(hwnd, 3)                        # SW_MAXIMIZE


def edge() -> str | None:
    for cand in (os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
                 os.path.join(os.environ.get("ProgramFiles", ""), "Microsoft", "Edge", "Application", "msedge.exe")):
        if cand and Path(cand).is_file():
            return cand
    return None


def _work_area() -> tuple[int, int, int, int]:
    """主屏工作区（物理像素）：(x, y, 宽, 高)。任务栏在上下左右哪边都算进去了。"""
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    u.SetProcessDPIAware()                      # 不声明的话读到的是被缩放过的假坐标
    r = wintypes.RECT()
    u.SystemParametersInfoW(0x0030, 0, ctypes.byref(r), 0)     # SPI_GETWORKAREA
    return r.left, r.top, r.right - r.left, r.bottom - r.top


def _win_hwnd() -> int:
    """我们自己那扇窗：标题里带同一个构建戳，且**属于本进程** —— Edge 兜底窗会共用同一个标题戳，
    只按标题认的话「窄栏/最大化」可能打到那扇带黑标题栏的兜底窗上（实测踩到过两扇同时在）。"""
    import ctypes
    from ctypes import wintypes
    same = [(h, t) for h, t in _app_windows() if f"v{STAMP}" in t]
    if not same:
        return 0
    me = os.getpid()
    for h, _t in same:
        pid = wintypes.DWORD()
        ctypes.windll.user32.GetWindowThreadProcessId(h, ctypes.byref(pid))
        if pid.value == me:
            return h
    return same[0][0]


def _set_client_rect(h: int, x: int, y: int, w: int, hh: int) -> None:
    """把**客户区**（= 页面 viewport，不是窗口矩形）钉到 (x, y, w, hh)，物理像素。
    补过 WS_THICKFRAME 的无边框窗，窗口矩形比客户区大一圈（实测 19 物理像素）——
    只钉窗口矩形的话客户区会小一圈，界面顶上就露一条非客户区色带
    （2026-10-07 用户报的「点进去后上边界还有一点黑框」就是它）。所以先放一次量出边框差量，
    再把窗口按差量放大、客户区左上角对准目标；多出来的边框落到工作区外/任务栏下。"""
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    u.SetWindowPos(h, 0, x, y, w, hh, 0x0004 | 0x0010)          # SWP_NOZORDER | SWP_NOACTIVATE
    cr = wintypes.RECT()
    u.GetClientRect(h, ctypes.byref(cr))
    pt = wintypes.POINT(0, 0)
    u.ClientToScreen(h, ctypes.byref(pt))
    dw, dh = w - (cr.right - cr.left), hh - (cr.bottom - cr.top)
    if dw or dh:
        u.SetWindowPos(h, 0, x - (pt.x - x), y - (pt.y - y), w + dw, hh + dh, 0x0004 | 0x0010)


def _fit(h: int, zoom: bool) -> None:
    """把窗口钉到工作区（zoom）或缩回工作区的 3/4（还原），一律物理像素。
    WinForms 自己的 WindowState.Maximized 对无边框窗会盖住任务栏，所以不用它。"""
    import ctypes
    u = ctypes.windll.user32
    if u.IsIconic(h):
        u.ShowWindow(h, 9)                                          # SW_RESTORE：最小化的窗 SetWindowPos 钉不回来
    x, y, w, hh = _work_area()
    if not zoom:
        x, y, w, hh = x + w // 8, y + hh // 8, w * 3 // 4, hh * 3 // 4
    _set_client_rect(h, x, y, w, hh)


def _fit_card(h: int, w: int = CARD_W, hh: int = CARD_H) -> None:
    """把窗口钉成「开始卡片」的大小（CSS 逻辑像素 → 物理）并居中。点「进入」后
    前端打 /api/win/maximize → CARD_PIN 放掉、铺回工作区。"""
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    if u.IsIconic(h):
        u.ShowWindow(h, 9)
    x, y, w0, h0 = _work_area()
    s = _dpi_scale()
    W, H = int(round(w * s)), int(round(hh * s))
    X, Y = x + (w0 - W) // 2, y + (h0 - H) // 2
    _set_client_rect(h, X, Y, W, H)


def _fit_side(h: int, width: int = 580) -> None:
    """窄栏：钉到屏幕右缘、全高（读论文时把工作台放旁边随手记）。"""
    import ctypes
    u = ctypes.windll.user32
    if u.IsIconic(h):
        u.ShowWindow(h, 9)
    x, y, w, hh = _work_area()
    _set_client_rect(h, x + w - width, y, width, hh)


def _resizable(h: int) -> bool:
    """给无边框窗补上缩放边框 WS_THICKFRAME —— 只加边框、不加 WS_CAPTION，所以黑标题栏不会回来。
    缺了它窗口就没法拖边改宽窄（实测样式 0x16010000 里没有 THICKFRAME）。"""
    import ctypes
    u = ctypes.windll.user32
    GWL_STYLE, THICK = -16, 0x00040000
    st = u.GetWindowLongW(h, GWL_STYLE)
    if not st & THICK:
        u.SetWindowLongW(h, GWL_STYLE, st | THICK)
        u.SetWindowPos(h, 0, 0, 0, 0, 0, 0x0020 | 0x0002 | 0x0001 | 0x0004)   # FRAMECHANGED|NOMOVE|NOSIZE|NOZORDER
    return bool(u.GetWindowLongW(h, GWL_STYLE) & THICK)


def _win(action: str) -> dict[str, Any]:
    """无边框窗口右上角那三个按钮。WinForms 没有标题栏了，就用 Win32 直接下命令
    （跟 _front/_maximize 一样从别的线程调就行，不需要 pywebview 的界面线程）。"""
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    h = _win_hwnd()
    if not h:
        return {"error": "没找到窗口"}
    if action == "minimize":
        u.ShowWindow(h, 6)                                     # SW_MINIMIZE
    elif action == "maximize":
        global CARD_PIN                 # 卡片阶段结束 → 之后不再往卡片尺寸钉
        CARD_PIN = False
        x, y, w, hh = _work_area()
        cr = wintypes.RECT()
        u.GetClientRect(h, ctypes.byref(cr))
        zoom = abs((cr.right - cr.left) - w) <= 2 and abs((cr.bottom - cr.top) - hh) <= 2
        _fit(h, not zoom)
        return {"ok": action, "zoomed": not zoom}              # 前端按这个换图形（铺满=还原图标）
    elif action == "close":
        u.PostMessageW(h, 0x0010, 0, 0)                        # WM_CLOSE
    elif action == "narrow":
        _resizable(h)                                          # 顺手把缩放边框补上，之后也能手拖
        _fit_side(h, 580)
        return {"ok": action, "narrow": True}
    elif action == "wide":
        _fit(h, True)
        return {"ok": action, "narrow": False}
    else:
        return {"error": f"不认识的动作 {action}"}
    return {"ok": action}


def _webview_window(url: str, stamp: int) -> bool:
    """自己的无边框窗口（WebView2 / pywebview）。起来就阻塞到关窗、返回 True；
    起不来（没装 pywebview / WebView2 运行时）返回 False，调用方退回 Edge --app。"""
    try:
        import webview
    except Exception:
        return False
    icon = HERE / "build" / "icon.ico"
    x, y, w, h = _work_area()
    s = _dpi_scale()      # pywebview 把 x/y/宽高当逻辑像素再乘 DPI，先除回去，起来后再钉准
    cw, ch = int(round(CARD_W * s)), int(round(CARD_H * s))   # 先按「开始卡片」大小居中开窗，「进入」再铺满
    x, y, w, h = x + (w - cw) // 2, y + (h - ch) // 2, cw, ch
    if os.environ.get("RW_DEBUG_CDP"):     # 给验证用的：RW_DEBUG_CDP=9333 就能用 CDP 连进这扇窗读 DOM
        webview.settings["REMOTE_DEBUGGING_PORT"] = int(os.environ["RW_DEBUG_CDP"])
    threading.Thread(target=_watch_restore, daemon=True).start()
    try:
        webview.create_window(
            f"{APP_TITLE} · v{stamp}", url + "&pw=1",
            frameless=True, easy_drag=False,      # 拖动靠 .pywebview-drag-region（顶栏），不是抓哪儿拖哪儿
            x=int(x / s), y=int(y / s), width=int(w / s), height=int(h / s),
            min_size=(int(420 / s), int(380 / s)), background_color="#111821")   # 逻辑像素！专注模式的「窄栏」只有 580 物理，按 DPI 反算，否则会把窗口钳在 ~690 宽
        webview.start(gui="edgechromium", private_mode=False,   # 关掉隐私模式，localStorage/头像才留得住
                      storage_path=str(HERE / "data" / "webview"),
                      icon=str(icon) if icon.is_file() else None,
                      func=lambda: _fit_after())
        return True                                   # 关窗 → 这里返回 → main 退出 → 服务一起停
    except Exception:
        log = HERE / "data" / "server-error.log"
        log.write_text(traceback.format_exc(), encoding="utf-8")
        return False


def _nudge(h: int) -> None:
    """把宽度改掉 1px 再改回来，逼 WebView2 重排重绘（肉眼看不出来）。"""
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    r = wintypes.RECT()
    u.GetWindowRect(h, ctypes.byref(r))
    w, hh = r.right - r.left, r.bottom - r.top
    u.SetWindowPos(h, 0, r.left, r.top, w - 1, hh, 0x0004 | 0x0010)
    u.SetWindowPos(h, 0, r.left, r.top, w, hh, 0x0004 | 0x0010)


def _watch_restore() -> None:
    """WebView2 被「别的进程」从最小化还原后自己不重绘 —— 实测整扇窗全黑（任务栏点回来、
    再双击快捷方式都算这类）。这里盯着「最小化 → 可见」这一刻抖一下，把画面逼回来。"""
    import ctypes
    u = ctypes.windll.user32
    was = False
    while True:
        time.sleep(0.7)
        h = _win_hwnd()
        if not h:
            continue
        now = bool(u.IsIconic(h))
        if was and not now:
            _nudge(h)
        was = now


def _dpi_scale() -> float:
    import ctypes
    try:
        return ctypes.windll.user32.GetDpiForSystem() / 96
    except Exception:
        return 1.0


def _fit_after() -> None:
    """窗口起来后把矩形钉到工作区。WinForms 的 AutoScaleMode.Dpi 会在窗口 show 之后
    自己重排一次尺寸（实测 2488x1600 被打回 1866x1200 居中），所以 4 秒内每隔 100ms
    检查一次，偏了就再钉一次；钉住了就不再碰（避免反复重排把页面刷花）。
    卡片尺寸由 CARD_W/CARD_H 定；CARD_PIN 被 /api/win/maximize 放掉后就回归「铺满工作区」。"""
    pinned = False
    for _ in range(40):
        h = _win_hwnd()
        if h and CARD_PIN and not _at_card(h):
            _fit_card(h)
        if h and not pinned:                     # 首次拿到窗口就补缩放边框（之后能拖边改宽窄）
            pinned = _resizable(h)
        time.sleep(0.1)


def _at_card(h: int) -> bool:
    """窗口的客户区是不是已经到了卡片大小（CSS 逻辑像素）；卡片是居中钉的，位置不管。"""
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    s = _dpi_scale()
    W, H = int(round(CARD_W * s)), int(round(CARD_H * s))
    r = wintypes.RECT()
    u.GetClientRect(h, ctypes.byref(r))
    return abs((r.right - r.left) - W) <= 2 and abs((r.bottom - r.top) - H) <= 2


def _at_work_area(h: int) -> bool:
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    x, y, w, hh = _work_area()
    r = wintypes.RECT()
    u.GetClientRect(h, ctypes.byref(r))            # 客户区 = 页面 viewport；窗口矩形被边框撑大了，别拿它比
    return abs((r.right - r.left) - w) <= 2 and abs((r.bottom - r.top) - hh) <= 2


def catalog_cards(db: Any) -> list[dict[str, Any]]:
    """内置目录里 40 家各一张卡片（对齐科研工作台的「模型与 Agent」面板），再挂上用户自定义的。
    库里没有行也照样出卡片 —— 这就是「每家都有卡片」的来源；Key 只回 key_present。"""
    rows = {p["id"]: p for p in db.providers()}
    cards: list[dict[str, Any]] = []
    for pid, c in PROVIDER_CATALOG.items():
        r = rows.pop(pid, None) or {}
        wire = c["wire"] or "openai-completions"
        cards.append({
            "id": pid, "name": c["name"], "base_url": c["base_url"] or "",
            "wire": wire, "wire_label": WIRE_LABEL.get(wire, wire),
            "auth": c["auth"], "n_models": c["n_models"], "builtin_models": c["models"],
            "key_present": bool(r.get("api_key")), "models": r.get("models") or [],
            "source": "builtin", "enabled": bool(r.get("enabled")),
            "usable": wire in USABLE_WIRES, "console": OAUTH_CONSOLE.get(pid, ""),
        })
    for pid, r in rows.items():                       # 用户自定义
        wire = r["api"]
        cards.append({
            "id": pid, "name": r["name"], "base_url": r["base_url"],
            "wire": wire, "wire_label": WIRE_LABEL.get(wire, wire),
            "auth": ["apiKey"], "n_models": len(r.get("models") or []), "builtin_models": [],
            "key_present": bool(r.get("api_key")), "models": r.get("models") or [],
            "source": "custom", "enabled": bool(r.get("enabled")),
            "usable": wire in USABLE_WIRES, "console": "",
        })
    return cards


def settings_meta() -> dict[str, Any]:
    """工具 = 本 app 的 TOOL_SPECS；技能 = 本机 Hermes skills；MCP = 本机 Hermes 配置里的服务器。只读。"""
    tools = [{"name": t["function"]["name"], "desc": (t["function"].get("description") or "")}
             for t in workflow.TOOL_SPECS]
    skills, mcp = [], []
    sk = Path(os.environ.get("LOCALAPPDATA", "")) / "hermes" / "skills"
    for f in (sorted(sk.glob("*/SKILL.md")) + sorted(sk.glob("*/*/SKILL.md")))[:80]:
        try:
            head = f.read_text(encoding="utf-8", errors="replace")[:1200]
            m = re.search(r"^description:\s*(.+)$", head, re.M)
            skills.append({"name": f.parent.name, "desc": (m.group(1).strip().strip('"\'') if m else ""),
                           "dir": str(f.parent)})
        except OSError:
            pass
    cfg = Path(os.environ.get("LOCALAPPDATA", "")) / "hermes" / "config.yaml"
    if cfg.is_file():
        try:
            import yaml
            data = yaml.safe_load(cfg.read_text(encoding="utf-8", errors="replace")) or {}
            servers = data.get("mcp_servers") or data.get("mcp") or {}
            if isinstance(servers, list):
                servers = {str(x.get("name") or i): x for i, x in enumerate(servers) if isinstance(x, dict)}
            for name, spec in servers.items():
                if name == "servers" and isinstance(spec, dict):
                    for n2, s2 in spec.items():
                        mcp.append({"name": n2, "cmd": str(s2.get("command") or s2.get("url") or "")[:120]})
                else:
                    mcp.append({"name": name, "cmd": str((spec or {}).get("command") or (spec or {}).get("url") or "")[:120]})
        except Exception as exc:
            mcp = [{"name": "（读取 Hermes 配置失败）", "cmd": str(exc)[:80]}]
    sk_all = len(list(sk.glob("*/SKILL.md"))) + len(list(sk.glob("*/*/SKILL.md"))) if sk.is_dir() else 0
    return {"tools": tools, "skills": skills, "skills_total": sk_all, "mcp": mcp,
            "hermes_dir": str(sk), "mcp_cfg": str(cfg)}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args: Any) -> None:  # 静默
        pass

    # ---------- 基础设施 ----------
    def _send(self, code: int, body: bytes, ctype: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    MIME = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
            ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
            ".json": "application/json; charset=utf-8", ".woff2": "font/woff2"}

    def _static(self, rel: str) -> None:
        """web/ 下的静态文件（只给 /vendor/ 用：农历库 lunar.js）。防目录穿越。"""
        target = (WEB / urllib.parse.unquote(rel).lstrip("/")).resolve()
        if WEB.resolve() not in target.parents or not target.is_file():
            return self._send(404, b"not found", "text/plain; charset=utf-8")
        self._send(200, target.read_bytes(), self.MIME.get(target.suffix.lower(), "application/octet-stream"))

    @staticmethod
    def _scrub(v: Any) -> Any:
        """出站脱敏：api_key 一律不回给前端（本机也一样，少一个泄漏面）。"""
        if isinstance(v, dict):
            return {k: ("***" if (k == "api_key" and v[k]) else ("" if k == "api_key" else Handler._scrub(x)))
                    for k, x in v.items()}
        if isinstance(v, list):
            return [Handler._scrub(x) for x in v]
        return v

    def _json(self, payload: Any, code: int = 200) -> None:
        payload = self._scrub(payload)
        self._send(code, json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8"), "application/json; charset=utf-8")

    def _body(self) -> dict[str, Any]:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {}

    # ---------- 路由 ----------
    def _upload(self, q: dict[str, list[str]]) -> None:
        """附件上传：原始字节走 body，文件名/任务走 query（避开 multipart 解析，本地单机够用）。
        PDF 顺手入库到当前任务 —— 只有这样 Agent 的 paper_read 才真读得到它。"""
        name = Path(urllib.parse.unquote(q.get("name", ["file"])[0])).name or "file"
        task_id = q.get("task_id", [""])[0]
        blob = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if not blob:
            return self._json({"error": "空文件"}, 400)
        UPLOADS.mkdir(parents=True, exist_ok=True)
        dest = UPLOADS / f"{hashlib.sha256(blob).hexdigest()[:12]}_{name}"
        if not dest.exists():                       # 同内容重传只留一份
            dest.write_bytes(blob)
        out: dict[str, Any] = {"name": name, "path": str(dest), "size": len(blob),
                               "ext": name.rsplit(".", 1)[-1].lower()}
        if task_id and out["ext"] == "pdf":
            try:
                with WorkflowDB(DB_PATH) as db:
                    paper = db.ingest_pdf(task_id, dest)
                out.update({"paper_id": paper["id"], "pages": len(paper["pages"]), "ocr": paper["ocr_status"]})
            except Exception as exc:                # 入库失败不影响「附件已存下」这个事实
                out["ingest_error"] = f"{type(exc).__name__}: {exc}"
        return self._json(out)


    # ---------------- 邮箱（IMAP / SMTP，移植 lit 的 src/mailRoutes.js） ----------------
    _RE_MAIL_MSG = re.compile(r"^/api/mail/accounts/([^/]+)/messages/(\d+)(?:/attachments/(\d+))?$")
    _RE_MAIL_SEEN_ALL = re.compile(r"^/api/mail/accounts/([^/]+)/messages/seen-all$")
    _RE_MAIL_SEEN = re.compile(r"^/api/mail/accounts/([^/]+)/messages/(\d+)/seen$")
    _RE_MAIL_ACC = re.compile(r"^/api/mail/accounts/([^/]+)(?:/(test|folders|send))?$")

    def _mail_id(self, path: str) -> str:
        for rx in (self._RE_MAIL_SEEN_ALL, self._RE_MAIL_SEEN, self._RE_MAIL_MSG, self._RE_MAIL_ACC):
            m = rx.match(path)
            if m:
                return urllib.parse.unquote(m.group(1))
        return ""

    def _mail_route(self, method: str, path: str, q: dict, data: dict | None) -> bool:
        """邮箱相关路由；命中返回真值，调用方直接 return。"""
        if not path.startswith("/api/mail"):
            return False
        import mail as M
        data = data or {}

        def pick(key: str, default: Any = None) -> Any:
            v = q.get(key)
            if v:
                return v[0]
            return data.get(key, default)

        if path == "/api/mail/providers":
            self._json(M.MAIL_PROVIDERS)
            return True

        if path == "/api/mail/accounts":
            if method == "GET":
                self._json([M.public_account(a) for a in M.list_mail_accounts()])
                return True
            if method == "POST":
                acc = M.normalize_account_input(data, {})
                err = M.validate_account(acc)
                if err:
                    self._json({"error": err}, 400)
                    return True
                if any(a.get("email") == acc["email"] for a in M.list_mail_accounts()):
                    self._json({"error": "该邮箱已经添加过了"}, 400)
                    return True
                acc["id"] = M.new_id()
                acc["createdAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
                M.upsert_mail_account(acc)
                self._json(M.public_account(acc))
                return True

        if path == "/api/mail/test" and method == "POST":
            acc = M.normalize_account_input(data, {})
            err = M.validate_account(acc)
            if err:
                self._json({"error": err}, 400)
                return True
            try:
                self._json(M.test_account(acc))
            except Exception as exc:
                self._json({"error": M.describe_mail_error(exc)}, 400)
            return True

        if path == "/api/mail/notify" and method == "GET":
            accounts = M.list_mail_accounts()
            if not accounts:
                self._json({"accounts": [], "totalUnread": 0})
                return True
            try:
                since_map = json.loads(pick("since") or "{}") or {}
            except ValueError:
                since_map = {}
            out = []
            for acc in accounts:
                folder = acc.get("notifyFolder") or "INBOX"
                try:
                    info = M.peek_recent(acc, folder, 15)
                    latest = info["latest"]
                    newest = latest[0]["uid"] if latest else 0
                    since = since_map.get(acc["id"])
                    fresh = [m for m in latest if (not m["seen"]) and int(m["uid"] or 0) > int(since)] if since is not None else []
                    out.append({"id": acc["id"], "email": acc.get("email"), "label": acc.get("label") or acc.get("email"),
                                "folder": folder, "unseen": info["unseen"], "exists": info["exists"],
                                "newestUid": newest, "fresh": fresh, "error": "",
                                "baseline": int(since) if since is not None else newest})
                except Exception as exc:
                    out.append({"id": acc["id"], "email": acc.get("email"), "label": acc.get("label") or acc.get("email"),
                                "folder": folder, "error": M.describe_mail_error(exc)})
            self._json({"accounts": out, "totalUnread": sum(x.get("unseen") or 0 for x in out)})
            return True

        if path == "/api/mail/translate" and method == "POST":
            # lit 那边走它自己的翻译模块；我们直接用手上配好的模型翻（前端拿 data.translation）
            text = (data.get("text") or "").strip()
            if not text:
                self._json({"error": "这封邮件没有可翻译的正文"}, 400)
                return True
            with WorkflowDB(DB_PATH) as db:
                profile = db.active_model()
            if not profile:
                self._json({"error": "还没配置模型：去「模型」页加一个，再回来翻译"}, 400)
                return True
            try:
                out = chat(profile, [
                    {"role": "system", "content": "把用户给的邮件正文翻译成简体中文，保留段落与列表结构，只输出译文本身，不要解释。"},
                    {"role": "user", "content": text[:6000]},
                ], temperature=0.1)
                self._json({"translation": (out or "").strip() or "(模型返回空)"})
            except Exception as exc:
                self._json({"error": f"翻译失败：{exc}"}, 400)
            return True

        m_list = re.match(r"^/api/mail/accounts/([^/]+)/messages$", path)
        if m_list and method == "GET":
            acc = M.get_mail_account(urllib.parse.unquote(m_list.group(1)))
            if not acc:
                self._json({"error": "账户不存在"}, 404)
                return True
            try:
                self._json(M.list_messages(acc, pick("folder", "INBOX"), int(pick("page", 1) or 1),
                                           int(pick("pageSize", 30) or 30), pick("search", "") or ""))
            except Exception as exc:
                self._json({"error": M.describe_mail_error(exc)}, 400)
            return True

        m_seen_all = self._RE_MAIL_SEEN_ALL.match(path)
        if m_seen_all and method == "POST":
            acc = M.get_mail_account(self._mail_id(path))
            if not acc:
                self._json({"error": "账户不存在"}, 404)
                return True
            try:
                self._json(M.mark_all_seen(acc, pick("folder", "INBOX")))
            except Exception as exc:
                self._json({"error": M.describe_mail_error(exc)}, 400)
            return True

        m_seen = self._RE_MAIL_SEEN.match(path)
        if m_seen and method == "POST":
            acc = M.get_mail_account(self._mail_id(path))
            if not acc:
                self._json({"error": "账户不存在"}, 404)
                return True
            try:
                seen = data.get("seen")
                self._json(M.set_seen(acc, pick("folder", "INBOX"), m_seen.group(2), True if seen is None else bool(seen)))
            except Exception as exc:
                self._json({"error": M.describe_mail_error(exc)}, 400)
            return True

        m_msg = self._RE_MAIL_MSG.match(path)
        if m_msg:
            acc = M.get_mail_account(self._mail_id(path))
            if not acc:
                self._json({"error": "账户不存在"}, 404)
                return True
            folder = pick("folder", "INBOX")
            if method == "GET" and m_msg.group(4) is not None:
                try:
                    att = M.get_attachment(acc, folder, m_msg.group(2), int(m_msg.group(4)))
                except Exception as exc:
                    self._json({"error": M.describe_mail_error(exc)}, 404)
                    return True
                self.send_response(200)
                self.send_header("Content-Type", att["contentType"])
                self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + urllib.parse.quote(att["filename"]))
                self.send_header("Content-Length", str(len(att["content"])))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(att["content"])
                return True
            if method == "GET":
                try:
                    self._json(M.get_message(acc, folder, m_msg.group(2)))
                except Exception as exc:
                    self._json({"error": M.describe_mail_error(exc)}, 404)
                return True
            if method == "DELETE":
                try:
                    self._json(M.delete_message(acc, folder, m_msg.group(2)))
                except Exception as exc:
                    self._json({"error": M.describe_mail_error(exc)}, 400)
                return True

        m_acc = self._RE_MAIL_ACC.match(path)
        if m_acc:
            acc = M.get_mail_account(self._mail_id(path))
            if not acc:
                self._json({"error": "账户不存在"}, 404)
                return True
            what = m_acc.group(2)
            if method == "DELETE" and not what:
                M.delete_mail_account(acc["id"])
                self._json({"ok": True})
                return True
            if method in ("PATCH", "POST") and not what:
                merged = M.normalize_account_input(data, acc)
                err = M.validate_account(merged)
                if err:
                    self._json({"error": err}, 400)
                    return True
                merged["id"] = acc["id"]
                M.upsert_mail_account(merged)
                self._json(M.public_account(merged))
                return True
            if method == "POST" and what == "test":
                try:
                    self._json(M.test_account(acc))
                except Exception as exc:
                    self._json({"error": M.describe_mail_error(exc)}, 400)
                return True
            if method == "GET" and what == "folders":
                try:
                    self._json(M.list_folders(acc))
                except Exception as exc:
                    self._json({"error": M.describe_mail_error(exc)}, 400)
                return True
            if what == "send" and method == "POST":
                try:
                    self._json(M.send_mail(acc, data.get("to", ""), data.get("cc", ""),
                                           data.get("subject", ""), data.get("text", ""), data.get("html", "")))
                except Exception as exc:
                    self._json({"error": M.describe_mail_error(exc)}, 400)
                return True

        if path.startswith("/api/mail"):
            self._json({"error": "not found"}, 404)
            return True
        return False


    def do_PATCH(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path, q = parsed.path, urllib.parse.parse_qs(parsed.query)
        if not self._mail_route("PATCH", path, q, self._body()):
            self._json({"error": "not found"}, 404)

    def do_DELETE(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path, q = parsed.path, urllib.parse.parse_qs(parsed.query)
        if not self._mail_route("DELETE", path, q, self._body()):
            self._json({"error": "not found"}, 404)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path, q = parsed.path, urllib.parse.parse_qs(parsed.query)
        try:
            if path in ("/", "/index.html"):
                return self._send(200, (WEB / "index.html").read_bytes(), "text/html; charset=utf-8")
            if path.startswith("/vendor/"):
                return self._static(path)
            if self._mail_route("GET", path, q, None):
                return
            if path == "/api/win/state":
                h = _win_hwnd()
                return self._json({"zoomed": bool(h and _at_work_area(h))})
            if path == "/api/litgraph":
                tid = (q.get("task") or [""])[0]
                with WorkflowDB(DB_PATH) as db:
                    return self._json(litgraph(db, tid))
            if path == "/api/state":
                with WorkflowDB(DB_PATH) as db:
                    active = db.active_model()
                    return self._json({
                        "tasks": [{**dict(t), "stage_now": db.stage_now(t["id"], t["stage"])} for t in db.tasks()],
                        "chats": db.chats(),
                        "assistants": db.assistants(),
                        "models": [{**m, "api_key": "***" if m["api_key"] else ""} for m in db.models()],
                        "active": (lambda m: ({**m, "api_key": "***"} if m and m["api_key"] else m))(active),
                        "active_model": (lambda m: ({**m, "api_key": "***"} if m and m["api_key"] else m))(active),
                        "events": db.events(q.get("month", [None])[0]),
                        "notes": [{k: n[k] for k in ("id", "task_id", "title", "created_at")} for n in db.notes()],
                        "stages": [{"key": s, "label": STAGE_LABEL[s]} for s in STAGES],
                    })
            if path == "/api/task":
                with WorkflowDB(DB_PATH) as db:
                    tid = q["id"][0]
                    s = db.summary(tid)
                    return self._json({
                        "task": s["task"], "summary": s, "steps": db.steps(tid),
                        "stage_map": db.stage_map(tid), "results": db.results(tid),
                        "notes": [{k: n[k] for k in ("id", "title", "created_at")} for n in db.notes(tid)],
                        "papers": s["papers"], "evidence": s["evidence"],
                        "paper_list": db.papers_of(tid),
                        "evidence_list": [dict(r) for r in db.evidence(tid)],
                    })
            if path == "/api/note":
                with WorkflowDB(DB_PATH) as db:
                    return self._json(db.note(q["id"][0]))
            if path == "/api/notes":
                with WorkflowDB(DB_PATH) as db:
                    tid = q.get("id", [None])[0]
                    return self._json({"notes": db.notes(tid) if tid else db.notes()})
            if path == "/api/chat":
                with WorkflowDB(DB_PATH) as db:
                    return self._json({"messages": db.messages(q["id"][0])})
            if path == "/api/doc/state":                  # 确认大纲 / 论文撰写 / 稿件审查 共用的「左边那份文件」
                step = (q.get("step") or ["outline"])[0]
                with WorkflowDB(DB_PATH) as db:
                    tid = q["id"][0]
                    return self._json({"step": step, "out": str(db.out_dir(tid)),
                                       "long": db.memory(tid, "long"),
                                       "messages": db.messages(tid, step),
                                       **doc_read(db, tid, step)})
            if path == "/api/en/state":                   # 中译英：默认源（正文.md）+ 上次译文
                with WorkflowDB(DB_PATH) as db:
                    return self._json(en_state(db, q["id"][0]))
            if path == "/api/doc/cite":                   # 后台引用台账（读之前先按当前正文同步状态）
                with WorkflowDB(DB_PATH) as db:
                    return self._json(cite_read(db, q["id"][0]))
            if path == "/api/conv/files":                 # 格式转换：左边文件区
                with WorkflowDB(DB_PATH) as db:
                    return self._json(conv_files(db, q["id"][0]))
            if path == "/api/conv/read":                  # 打开一个文件（代码区）
                with WorkflowDB(DB_PATH) as db:
                    p = _safe_path(q.get("path", [""])[0])
                    if not p.is_file():
                        return self._json({"error": "文件不存在"}, 404)
                    if p.suffix.lower() in (".docx", ".pdf"):
                        return self._json({"path": str(p), "binary": True, "ext": p.suffix.lower()[1:], "text": ""})
                    text = p.read_text(encoding="utf-8", errors="replace")
                    cap = int(q.get("cap", ["200000"])[0])
                    return self._json({"path": str(p), "name": p.name, "ext": p.suffix.lower()[1:],
                                       "text": text[:cap], "truncated": len(text) > cap, "bytes": len(text)})
            if path == "/api/file":                       # 把项目里的文件发出去（PDF 给 iframe 预览用）
                p = _safe_path(q.get("path", [""])[0])
                if not p.is_file():
                    return self._send(404, b"not found", "text/plain; charset=utf-8")
                ext = p.suffix.lower()
                ctype = {".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
                         ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".md": "text/markdown; charset=utf-8",
                         ".tex": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8",
                         ".html": "text/html; charset=utf-8"}.get(ext, "application/octet-stream")
                extra = {"Content-Disposition": f'inline; filename="{p.name}"'} if (ext == ".pdf" or q.get("inline")) else None
                return self._send(200, p.read_bytes(), ctype, extra)
            if path == "/api/outline/state":              # 旧路径（确认大纲）
                with WorkflowDB(DB_PATH) as db:
                    tid = q["id"][0]
                    return self._json({"out": str(db.out_dir(tid)), "long": db.memory(tid, "long"),
                                       "messages": db.messages(tid, "outline"),
                                       **outline_read(db, tid)})
            if path == "/api/idea/memory":
                with WorkflowDB(DB_PATH) as db:
                    tid = q["id"][0]
                    db.seed_long_memory(tid)
                    return self._json({
                        "out": str(db.out_dir(tid)),
                        "long": db.memory(tid, "long"),
                        "short": [{"role": m["role"], "content": m["content"], "created_at": m["created_at"],
                                   "events": m.get("events") or []} for m in db.messages(tid)],
                    })
            if path == "/api/vault/scan":              # 知识库：扫一遍已授权 Vault（路径参数走 query）
                try:
                    return self._json(vault.scan((q.get("vault") or [""])[0]))
                except vault.VaultError as exc:
                    return self._json({"error": str(exc)}, 400)
            if path == "/api/folder/pick":
                return self._json(self._pick_folder((q.get("initial") or [""])[0],
                                                    (q.get("title") or [""])[0] or "选择产出文件夹"))
            if path == "/api/deepread/status":           # 精读进度（前端每 2 秒问一次）
                return self._json(deepread_state((q.get("task_id") or [""])[0]) or {"phase": ""})
            if path == "/api/settings/meta":            # 设置页分区要的元数据：工具 / 技能 / MCP
                return self._json(settings_meta())
            if path == "/api/teams":                     # 团队清单（多团队：3 固定 + 2 机动）
                try:
                    return self._json(team.teams())
                except ValueError as exc:
                    return self._json({"error": str(exc), "teams": []}, 400)
            if path == "/api/team/chat":                 # 团队 v2：成员（从助手选）+ 群记录 + 接力状态
                try:
                    return self._json(team.chat_state((q.get("scope") or [""])[0]))
                except ValueError as exc:
                    return self._json({"error": str(exc)}, 400)
            if path == "/api/team":                      # 团队看板：成员状态 + 派活队列 + 运行事件
                try:
                    return self._json(team.board((q.get("id") or [""])[0]))
                except ValueError as exc:
                    return self._json({"error": str(exc), "members": [], "tasks": [], "counts": {}}, 400)
            if path == "/api/schedules":                 # 定时任务页：规则 + 最近运行（照原版两块结构）
                with WorkflowDB(DB_PATH) as db:
                    return self._json({"schedules": db.schedules(), "runs": db.schedule_runs(),
                                       "freq": schedule.FREQ_LABELS, "run_status": schedule.RUN_STATUS,
                                       "retryable": sorted(schedule.RETRYABLE)})
            if path == "/api/mdnotes":
                with WorkflowDB(DB_PATH) as db:
                    return self._json({"notes": db.md_notes()})
            if path == "/api/zotero/status":            # Zotero 本机只读接入（笔记页用）
                return self._json(zotero.status(q.get("base", [""])[0] or None))
            if path == "/api/zotero/collections":
                try:
                    return self._json(zotero.collections(q.get("base", [""])[0] or None))
                except zotero.ZoteroError as exc:
                    return self._json({"error": str(exc), "collections": []}, 400)
            if path == "/api/zotero/items":
                try:
                    return self._json(zotero.items(
                        q.get("base", [""])[0] or None,
                        (q.get("collection") or [""])[0],
                        (q.get("q") or [""])[0],
                        int((q.get("start") or ["0"])[0] or 0),
                        int((q.get("limit") or ["50"])[0] or 50)))
                except (zotero.ZoteroError, ValueError) as exc:
                    return self._json({"error": str(exc), "items": []}, 400)
            if path == "/api/zotero/note":              # 条目 → 可存成笔记的 title/content（不落盘）
                try:
                    return self._json(zotero.note_for(q.get("base", [""])[0] or None,
                                                      (q.get("key") or [""])[0]))
                except zotero.ZoteroError as exc:
                    return self._json({"error": str(exc)}, 400)
            if path == "/api/pdf":                       # 论文翻译页的阅读器：按入库记录回吐 PDF 字节
                with WorkflowDB(DB_PATH) as db:
                    f = papertran.pdf_path(db, (q.get("id") or [""])[0])
                if not f:
                    return self._send(404, b"not found", "text/plain; charset=utf-8")
                return self._send(200, f.read_bytes(), "application/pdf",
                                  {"Content-Disposition": f'inline; filename="{f.name}"'})
            if path == "/api/trans/file":                # 译文（mono=纯中文 / dual=左右对照）
                kind = (q.get("kind") or ["mono"])[0]
                with WorkflowDB(DB_PATH) as db:
                    pid = (q.get("id") or [""])[0]
                    src = papertran.pdf_path(db, pid)
                    tid = (q.get("task") or [""])[0]
                    out = db.pdir(tid, "文献库") if tid else (HERE / "data" / "out")
                if not src:
                    return self._send(404, b"not found", "text/plain; charset=utf-8")
                f = papertran.out_paths(src, out)[0 if kind == "dual" else 1]
                if not f.is_file():
                    return self._send(404, b"no translation", "text/plain; charset=utf-8")
                return self._send(200, f.read_bytes(), "application/pdf",
                                  {"Content-Disposition": f'inline; filename="{f.name}"'})
            if path == "/api/pdftext":                    # 每页词坐标（前端自己铺文字层；kind=mono 是中文那栏）
                kind = (q.get("kind") or ["src"])[0]
                with WorkflowDB(DB_PATH) as db:
                    f = papertran.pdf_path(db, (q.get("id") or [""])[0])
                    tid = (q.get("task") or [""])[0]
                    out = db.pdir(tid, "文献库") if tid else (HERE / "data" / "out")
                if not f:
                    return self._json({"error": "找不到这篇 PDF 的文件"}, 404)
                if kind == "mono":
                    f = papertran.out_paths(f, out)[1]
                    if not f.is_file():
                        return self._json({"error": "还没有译文"}, 404)
                return self._json(papertran.pdf_words(f, int((q.get("pages") or ["0"])[0] or 0)))
            if path == "/api/papermeta":
                with WorkflowDB(DB_PATH) as db:
                    return self._json(papertran.paper_meta(db, (q.get("id") or [""])[0]))
            if path == "/api/trans/status":
                return self._json(papertran.status((q.get("id") or [""])[0]))
            if path == "/api/rss/sources":
                with WorkflowDB(DB_PATH) as db:
                    return self._json({"sources": db.rss_sources(), "defaults": rss.DEFAULT_SOURCES})
            if path == "/api/rss/items":
                with WorkflowDB(DB_PATH) as db:
                    sid = (q.get("source") or [""])[0]
                    kw = (q.get("q") or [""])[0].strip()
                    yr = (q.get("year") or [""])[0].strip()
                    return self._json({"items": db.rss_items(sid, kw, yr),
                                       "total": db.rss_count(sid, kw, yr)})
            if path == "/api/tools":
                return self._json({"tools": [{"name": t["function"]["name"],
                                              "description": t["function"]["description"]} for t in TOOL_SPECS]})
            if path == "/api/providers":
                with WorkflowDB(DB_PATH) as db:
                    return self._json({"providers": catalog_cards(db),
                                       "wires": [{"id": w, "label": WIRE_LABEL.get(w, w)} for w in CUSTOM_WIRES],
                                       "default": db.provider_default()})
            if path == "/api/find":
                needle = (q.get("q", [""])[0] or "").strip().lower()
                hits = []
                with WorkflowDB(DB_PATH) as db:
                    if needle:
                        for t in db.tasks():
                            if needle in t["title"].lower() or needle in (t["question"] or "").lower():
                                hits.append({"kind": "任务", "id": t["id"], "title": t["title"], "sub": t["question"]})
                        for n in db.notes():
                            if needle in n["title"].lower() or needle in n["markdown"].lower():
                                hits.append({"kind": "笔记", "id": n["task_id"], "title": n["title"], "sub": n["created_at"][:16].replace("T", " ")})
                        for r in db.db.execute("SELECT id,task_id,title,source,year FROM search_cache"):
                            if needle in (r["title"] or "").lower():
                                hits.append({"kind": "文献", "id": r["task_id"], "title": r["title"], "sub": f"{r['source']} {r['year']}"})
                        # evidence 没有 task_id，靠 papers 关联（原来直接 SELECT task_id 会 500）
                        for e in db.db.execute("SELECT e.field, e.value, e.excerpt, p.task_id AS task_id"
                                               " FROM evidence e JOIN papers p ON p.id = e.paper_id"):
                            if needle in (e["value"] or "").lower() or needle in (e["excerpt"] or "").lower():
                                hits.append({"kind": "证据", "id": e["task_id"], "title": f"{e['field']}: {e['value']}", "sub": e["excerpt"][:120]})
                        for ev in db.events():
                            if needle in ev["title"].lower():
                                hits.append({"kind": "日程", "id": ev["task_id"] or "", "title": ev["title"], "sub": ev["date"]})
                return self._json({"q": needle, "hits": hits[:60]})
            return self._json({"error": "not found"}, 404)
        except ValueError as exc:                 # 用法/前置条件不对 → 400（不是服务端故障）
            self._json({"error": str(exc)}, 400)
        except KeyError as exc:
            self._json({"error": f"找不到对象：{exc}"}, 404)
        except Exception as exc:  # 界面永远拿到可读错误
            self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path, q = parsed.path, urllib.parse.parse_qs(parsed.query)
        if path == "/api/upload":
            return self._upload(q)
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            return self._json({"error": "只接受 application/json"}, 415)
        origin = (self.headers.get("Origin") or "").strip()
        if origin and not re.match(r"^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$", origin):
            return self._json({"error": "来源不被允许"}, 403)
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":                      # 挡跨站「简单请求」：非 JSON 一律不收
            return self._json({"error": "只接受 application/json"}, 415)
        origin = (self.headers.get("Origin") or "").strip()
        if origin and not re.match(r"^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$", origin):
            return self._json({"error": "来源不被允许"}, 403)
        data = self._body()
        if self._mail_route("POST", path, q, data):
            return
        if path == "/api/vault/status":            # 看板上的状态写回笔记 frontmatter
            try:
                out = vault.set_status(str(data.get("vault") or ""), str(data.get("path") or ""),
                                       str(data.get("field") or ""), str(data.get("value") or ""))
                return self._json({**out, **vault.scan(str(data.get("vault") or ""))})
            except vault.VaultError as exc:
                return self._json({"error": str(exc)}, 400)
        if path == "/api/vault/open":              # 「在 Obsidian 打开」
            try:
                return self._json(vault.open_in_obsidian(str(data.get("vault") or ""), str(data.get("path") or "")))
            except vault.VaultError as exc:
                return self._json({"error": str(exc)}, 400)
        if path.startswith("/api/win/"):
            return self._json(_win(path.rsplit("/", 1)[-1]))
        if path == "/api/agent":
            return self._sse(data)
        if path == "/api/idea":
            return self._sse(data, "idea")
        if path == "/api/outline":
            return self._sse(data, "outline")
        if path == "/api/write":
            return self._sse(data, "write")
        if path == "/api/review":
            return self._sse(data, "review")
        if path == "/api/chat/clear":
            try:
                with WorkflowDB(DB_PATH) as db:
                    return self._json({"cleared": db.clear_messages(data.get("task_id", ""))})
            except Exception as exc:
                return self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)
        try:
            with WorkflowDB(DB_PATH) as db:
                if path == "/api/mdnotes/save":
                    tid = data.get("task_id")
                    return self._json({"note": db.save_md_note(data.get("id", ""), data.get("title", ""),
                                                               data.get("content", ""), None if tid is None else str(tid))})

                if path.startswith("/api/assistant/") or path == "/api/chat/assistant":
                    b = data or {}
                    try:
                        with WorkflowDB(DB_PATH) as db:
                            if path == "/api/chat/assistant":
                                db.set_chat_assistant(b.get("id", ""), b.get("assistant_id", ""))
                                return self._json({"ok": True})
                            if path == "/api/assistant/save":
                                fid = (b.get("id") or "").strip() or ("a-" + os.urandom(4).hex())
                                return self._json({"assistant": db.assistant_save(fid, name=b.get("name"),
                                    avatar=b.get("avatar"), description=b.get("description"), rules=b.get("rules"),
                                    prompts=json.dumps(b.get("prompts") or [], ensure_ascii=False), model_id=b.get("model_id"))})
                            if path == "/api/assistant/delete":
                                db.assistant_delete(b.get("id", ""))
                                return self._json({"ok": True})
                    except ValueError as exc:
                        return self._json({"error": str(exc)}, 400)
                if path.startswith("/api/teams/"):           # 建 / 改名 / 解散 团队
                    b = data or {}
                    try:
                        if path == "/api/teams/new":
                            return self._json({"team": team.new_team(b.get("kind", "temp"), b.get("name", ""))})
                        if path == "/api/teams/rename":
                            return self._json({"team": team.rename_team(b.get("id", ""), b.get("name", ""))})
                        if path == "/api/teams/dissolve":
                            return self._json(team.dissolve(b.get("id", "")))
                    except ValueError as exc:
                        return self._json({"error": str(exc)}, 400)
                if path.startswith("/api/team/chat/"):      # 团队 v2：选助手 / 移人 / 说话（接力）/ 停止
                    b = data or {}
                    try:
                        if path == "/api/team/chat/member":
                            return self._json({"member": team.add_assistant(
                                b.get("scope", ""), b.get("assistant_id", ""))})
                        if path == "/api/team/chat/remove":
                            return self._json(team.remove_member(b.get("member_id", "")))
                        if path == "/api/team/chat/say":
                            return self._json(team.say(b.get("scope", ""), b.get("text", "")))
                        if path == "/api/team/chat/stop":
                            return self._json(team.stop(b.get("scope", "")))
                    except ValueError as exc:
                        return self._json({"error": str(exc)}, 400)

                if path.startswith("/api/team/"):           # 团队：成员增删改 / 派活 / 取消 / 重试
                    b = data or {}
                    if path == "/api/team/member/add":
                        return self._json({"member": team.add_member(
                            b.get("id", ""), b.get("name", ""), b.get("step", ""), b.get("prompt", ""))})
                    if path == "/api/team/member/update":
                        return self._json({"member": team.update_member(
                            b.get("member_id", ""), name=b.get("name"), step=b.get("step"), prompt=b.get("prompt"))})
                    if path == "/api/team/member/remove":
                        return self._json(team.remove_member(b.get("member_id", "")))
                    if path == "/api/team/assign":
                        return self._json({"task": team.assign(
                            b.get("id", ""), b.get("member", ""), b.get("prompt", ""),
                            b.get("title", ""), "manual" if b.get("manual") else "leader")})
                    if path == "/api/team/task/cancel":
                        return self._json(team.cancel(b.get("row_id", "")))
                    if path == "/api/team/task/retry":
                        return self._json(team.retry(b.get("row_id", "")))
                if path.startswith("/api/schedule/"):      # 定时任务：保存/启停/删除/立即运行/删运行记录
                    if path == "/api/schedule/save":
                        name = str(data.get("name") or "").strip()
                        if not name:
                            return self._json({"error": "任务名称必填"}, 400)
                        if not str(data.get("prompt") or "").strip():
                            return self._json({"error": "Prompt 必填（到点了要让 Agent 做什么）"}, 400)
                        ok, why = schedule.valid(str(data.get("cron") or ""))
                        if not ok:
                            return self._json({"error": why}, 400)
                        folder_ok, folder = schedule.inspect_output_dir(str(data.get("output_dir") or "定时任务"))
                        if not folder_ok:
                            return self._json({"error": folder}, 400)
                        enabled = bool(data.get("enabled", True))
                        with WorkflowDB(DB_PATH) as wdb:
                            row = wdb.schedule_save({"id": data.get("id"), "name": name,
                                                     "prompt": str(data.get("prompt") or "").strip(),
                                                     "project_id": str(data.get("project_id") or ""),
                                                     "frequency": str(data.get("frequency") or "daily"),
                                                     "cron": str(data.get("cron") or "0 9 * * *"),
                                                     "output_dir": folder, "enabled": enabled,
                                                     "next_run_at": (schedule.next_run_at(str(data.get("cron") or ""))
                                                                    if (enabled and str(data.get("frequency") or "") != "manual") else "")})
                        return self._json({"schedule": row})
                    if path == "/api/schedule/toggle":
                        with WorkflowDB(DB_PATH) as wdb:
                            row = wdb.schedule(str(data.get("id") or ""))
                            if not row:
                                return self._json({"error": "找不到这个定时任务"}, 404)
                            enabled = bool(data.get("enabled"))
                            wdb.schedule_set_enabled(row["id"], enabled)
                            wdb.schedule_mark_run(row["id"], row["last_run_at"],
                                                  schedule.next_run_at(row["cron"]) if enabled else "")
                            return self._json({"schedule": wdb.schedule(row["id"])})
                    if path == "/api/schedule/delete":
                        with WorkflowDB(DB_PATH) as wdb:
                            wdb.schedule_delete(str(data.get("id") or ""))
                        return self._json({"deleted": True})
                    if path == "/api/schedule/run":        # 立即运行：丢后台线程（模型调用几十秒，别挂住请求）
                        with WorkflowDB(DB_PATH) as wdb:
                            row = wdb.schedule(str(data.get("id") or ""))
                        if not row:
                            return self._json({"error": "找不到这个定时任务"}, 404)
                        threading.Thread(target=lambda: schedule.run_once(row, trigger="manual"),
                                         daemon=True, name="schedule-manual").start()
                        return self._json({"queued": True})
                    if path == "/api/schedule/run/delete":
                        with WorkflowDB(DB_PATH) as wdb:
                            return self._json({"deleted": wdb.schedule_run_delete(data.get("ids") or [])})
                    return self._json({"error": "未知的定时任务操作"}, 404)
                if path == "/api/mdnotes/delete":
                    db.delete_md_note(data.get("id", ""))
                    return self._json({"deleted": True})
                if path == "/api/trans/start":
                    tid = (data.get("task_id") or "").strip()
                    pid = (data.get("id") or "").strip()
                    with WorkflowDB(DB_PATH) as db:
                        out = db.pdir(tid, "文献库") if tid else (HERE / "data" / "out")
                        return self._json(papertran.start(db, pid, out, str(data.get("pages") or ""),
                                                          bool(data.get("force"))))
                if path == "/api/en/run":                   # 一键翻译（中文 markdown → 英文 markdown）
                    with WorkflowDB(DB_PATH) as db:
                        return self._json(en_run(db, (data.get("task_id") or "").strip(),
                                                 data.get("text") or "", data.get("name") or ""))
                if path == "/api/conv/compile":              # 编译代码区打开的那份 .tex
                    return self._json(conv_compile(data.get("path", "")))
                if path == "/api/conv/open":                 # 用系统默认程序打开
                    return self._json(conv_open(data.get("path", "")))
                if path == "/api/conv/save":                # 手改文件（代码区保存）
                    p = _safe_path(data.get("path", ""))
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_text(data.get("text", ""), encoding="utf-8")
                    return self._json({"ok": True, "path": str(p), "bytes": p.stat().st_size})
                if path == "/api/conv/run":                 # 一键格式转换（latex 会编译出 PDF）
                    with WorkflowDB(DB_PATH) as db:
                        return self._json(conv_run(db, (data.get("task_id") or "").strip(),
                                                   data.get("format") or "docx", data.get("source") or ""))
                if path == "/api/doc/seed":                # 起稿（确认大纲=模板；撰写=按框架搭骨架）
                    with WorkflowDB(DB_PATH) as db:
                        return self._json(doc_seed(db, (data.get("task_id") or "").strip(),
                                                   data.get("step") or "outline"))
                if path == "/api/doc/save":                # 手动改/用回复落盘（三步共用）
                    with WorkflowDB(DB_PATH) as db:
                        return self._json(doc_write(db, (data.get("task_id") or "").strip(),
                                                    data.get("step") or "outline",
                                                    data.get("markdown", "")))
                if path == "/api/outline/seed":           # 旧路径
                    tid = (data.get("task_id") or "").strip()
                    with WorkflowDB(DB_PATH) as db:
                        cur = outline_read(db, tid)
                        if not cur["exists"]:
                            cur = outline_write(db, tid, OUTLINE_TEMPLATE)
                        return self._json(cur)
                if path == "/api/outline/save":           # 手动改框架（左边直接编辑时用）
                    with WorkflowDB(DB_PATH) as db:
                        return self._json(outline_write(db, (data.get("task_id") or "").strip(),
                                                        data.get("markdown", "")))
                if path == "/api/paper/note":
                    tid = (data.get("task_id") or "").strip()
                    with WorkflowDB(DB_PATH) as db:
                        out = db.pdir(tid, "文献库") if tid else (HERE / "data" / "out")
                        return self._json(papertran.reading_note(db, tid, (data.get("id") or "").strip(), out))
                if path == "/api/rss/refresh":
                    return self._json(rss.refresh(db))
                if path == "/api/task/create":
                    base = (data.get("base_dir") or "").strip()
                    tid = db.create_task(data.get("title", ""), data.get("question", ""),
                                         data.get("material_system") or data.get("material", ""), base)
                    made = make_project_tree(base, db.summary(tid)["task"]) if base else []
                    return self._json({"task_id": tid, "base_dir": base, "dirs": made})
                if path == "/api/task/delete":
                    return self._json(db.delete_task(data.get("id", "")))
                if path == "/api/chat/create":
                    return self._json({"chat": db.chat(db.create_chat(data.get("title", "")))})
                if path == "/api/chat/delete":
                    cid = data.get("id", "")
                    db.clear_messages(cid)
                    return self._json(db.delete_chat(cid))
                if path == "/api/chat/rename":               # 对话改名（照 AionUi 标题点击改名）
                    b = data or {}
                    with WorkflowDB(DB_PATH) as db:
                        db.db.execute("UPDATE chats SET title=?, updated_at=? WHERE id=?",
                                      ((b.get("title") or "").strip()[:120] or "新对话", workflow.now(), b.get("id", "")))
                        db.db.commit()
                    return self._json({"ok": True})
                if path == "/api/chat/outdir":
                    cid = data.get("id", "")
                    picked = (data.get("dir") or "").strip()
                    if not picked:                       # 没给路径 = 弹本机原生选择框
                        got = self._pick_folder(db.chat(cid)["out_dir"])
                        if got.get("error"):
                            return self._json(got, 500)
                        if not picked:
                            picked = got.get("dir", "")
                        if not picked:
                            return self._json({"cancelled": True})
                    return self._json({"chat": db.update_chat(cid, out_dir=picked)})
                if path == "/api/calendar/add":
                    return self._json(db.add_event(data.get("title", ""), data.get("date", ""), data.get("task_id"), data.get("kind", "milestone"), data.get("note", "")))
                if path == "/api/calendar/delete":
                    db.delete_event(data.get("id", ""))
                    return self._json({"deleted": True})
                if path == "/api/calendar/toggle":
                    done = data.get("done")
                    return self._json(db.toggle_event(data.get("id", ""), None if done is None else bool(done)))
                if path == "/api/models/add":
                    return self._json(db.add_model(data.get("name", ""), data.get("base_url", ""), data.get("model", ""), data.get("api_key", ""), bool(data.get("activate"))))
                if path == "/api/models/active":
                    return self._json(db.set_active(data.get("id", "")))
                if path == "/api/models/delete":
                    db.delete_model(data.get("id", ""))
                    return self._json({"deleted": True})
                if path == "/api/models/test":
                    prof = db.model(data.get("id", "")) if data.get("id") else db.active_model()
                    reply = chat(prof, [{"role": "user", "content": "只回复两个字：可用"}], max_tokens=64, timeout=60)
                    return self._json({"ok": True, "reply": reply})
                if path == "/api/providers/add":
                    p = db.add_provider(data.get("name", ""), data.get("base_url", ""),
                                        data.get("api", "openai-chat"), data.get("api_key", ""))
                    return self._json({**{k: v for k, v in p.items() if k != "api_key"}, "key_present": bool(p["api_key"])})
                if path == "/api/providers/key":
                    p = db.set_provider_key(data.get("id", ""), data.get("api_key", ""))
                    return self._json({**{k: v for k, v in p.items() if k != "api_key"}, "key_present": bool(p["api_key"])})
                if path == "/api/providers/delete":
                    db.delete_provider(data.get("id", ""))
                    return self._json({"deleted": True})
                if path == "/api/providers/model":
                    p = db.adopt_model(data.get("id", ""), data.get("model", ""), bool(data.get("on", True)))
                    return self._json({**{k: v for k, v in p.items() if k != "api_key"}, "key_present": bool(p["api_key"])})
                if path == "/api/providers/default":
                    return self._json({"default": db.set_default(data.get("id", ""), data.get("model", ""))})
                if path == "/api/providers/discover":
                    p = db.provider(data.get("id", ""))
                    return self._json({"candidates": discover_models(p["base_url"], p["api_key"])})
                if path == "/api/providers/test":
                    p = db.provider(data.get("id", ""))
                    model = data.get("model") or (p["models"][0] if p["models"] else "")
                    if not model:
                        raise ValueError("先采用或填写一个模型，再测试")
                    return self._json({"model": model,
                                       "reply": test_provider(p["base_url"], p["api_key"], model)})
                if path == "/api/deepread/stop":             # 停精读（当前这篇读完后不再往下读）
                    return self._json(deepread_stop(data.get("task_id", "")))
                if path.startswith("/api/workflow/"):
                    stage = path.rsplit("/", 1)[-1]
                    tid = data.get("task_id", "")
                    if stage == "idea":
                        return self._json(ACTION["idea"](db, tid, data.get("idea", "")))
                    if stage == "search":
                        srcs = data.get("sources") or None
                        return self._json(ACTION["search"](db, tid, data.get("query", ""), srcs, int(data.get("rows", 10))))
                    if stage == "download":
                        ids = data.get("result_ids")
                        if ids:
                            return self._json(stage_download_selected(db, tid, list(ids)))
                        return self._json(ACTION["download"](db, tid, data.get("result_id", "")))
                    if stage == "deepread":                     # 一键精读：扔后台跑，立刻返回（前端轮询进度、可停）
                        return self._json(deepread_kick(str(DB_PATH), tid))
                    if stage == "queue":                        # 下载精读面板的实时数据
                        items = db.queue(tid)
                        return self._json({
                            "location": str(db.pdir(tid, "文献库")),
                            "selected": len(items),
                            "downloaded": len([i for i in items if i["status"] == "downloaded"]),
                            "pending": len([i for i in items if i["status"] == "queued"]),
                            "manual": [i for i in items if i["status"] == "manual"],
                            "items": items,
                        })
                    if stage in ("read", "notes"):
                        ref = data.get("note_id") or data.get("paper_id") or data.get("ref_id", "")
                        if stage == "notes":
                            return self._json(ACTION["notes"](db, tid, ref, data.get("vault") or None, bool(data.get("apply"))))
                        return self._json(ACTION["read"](db, tid, ref))
                    if stage == "write":
                        return self._json(ACTION["write"](db, tid, data.get("title", ""), data.get("section", "引言")))
                    if stage == "review":
                        return self._json(ACTION["review"](db, tid, data.get("draft") or compose_draft(db, tid)))
                    if stage == "convert":
                        return self._json(ACTION["convert"](db, tid, data.get("markdown") or compose_draft(db, tid),
                                                            data.get("format", "docx"), data.get("name", "paper")))
                    return self._json({"error": f"未知步骤 {stage}"}, 404)
            return self._json({"error": "not found"}, 404)
        except ValueError as exc:                 # 用法/前置条件不对 → 400
            self._json({"error": str(exc)}, 400)
        except KeyError as exc:
            self._json({"error": f"找不到对象：{exc}"}, 404)
        except Exception as exc:
            self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    # ---------- Agent 事件流（SSE，close-delimited） ----------
    def _sse(self, data: dict[str, Any], step: str = "") -> None:
        self.protocol_version = "HTTP/1.0"  # 无 Content-Length 时按关闭分帧
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        def emit(ev: dict[str, Any]) -> None:
            try:
                self.wfile.write(("data: " + json.dumps(ev, ensure_ascii=False, default=str) + "\n\n").encode("utf-8"))
                self.wfile.flush()
            except OSError:
                pass

        db = WorkflowDB(DB_PATH)
        try:
            runners = {"idea": run_idea, "outline": run_outline, "write": run_write, "review": run_review}
            (runners.get(step) or run_agent)(db, data.get("task_id", ""), data.get("message", ""), emit)
        except Exception as exc:
            emit({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
            emit({"type": "done", "content": ""})
        finally:
            db.close()


    # ---------- 通用 Agent 对话（不绑项目） ----------
    def _pick_folder(self, initial: str = "", title: str = "选择产出文件夹") -> dict[str, Any]:
        """弹本机原生「选择文件夹」对话框（服务就跑在这台机器上）。
        放子进程里跑：Tk 必须在它自己的主线程里建，HTTP 处理线程里建不可靠。"""
        helper = ("import sys, pathlib, tkinter as tk, tkinter.filedialog as fd\n"
                  "r = tk.Tk(); r.withdraw(); r.attributes('-topmost', True)\n"
                  "p = fd.askdirectory(title=sys.argv[3] or '选择产出文件夹', initialdir=sys.argv[2] or str(pathlib.Path.home()))\n"
                  "r.destroy(); Path(sys.argv[1]).write_text(p or '', encoding='utf-8')\n")
        tmp = Path(tempfile.mkstemp(suffix=".txt")[1])
        try:
            proc = subprocess.run([sys.executable, "-c", helper, str(tmp), initial or "", title or ""],
                                  capture_output=True, timeout=600)
            if proc.returncode != 0:
                return {"error": "打不开文件夹选择框：" + proc.stderr.decode("utf-8", "replace").strip()[:200]}
            return {"dir": tmp.read_text(encoding="utf-8").strip()}
        except Exception as exc:
            return {"error": f"打不开文件夹选择框：{type(exc).__name__}: {exc}"}
        finally:
            tmp.unlink(missing_ok=True)


def main() -> int:
    port = PORT
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])
    if not (WEB / "index.html").is_file():
        print("缺少 web/index.html"); return 2
    # 端口已占用 → 认为实例已在运行，直接开窗口
    with socket.socket() as probe:
        busy = probe.connect_ex(("127.0.0.1", port)) == 0
    # URL 带上 index.html 的时间戳：同一个 URL 的 --app 窗口会被 Edge 直接聚焦复用、
    # 不重新加载（实测：再发一次启动命令窗口数不变）→ 界面改了还看旧的。带戳就必定新开一扇。
    stamp = int((WEB / "index.html").stat().st_mtime)
    global STAMP
    STAMP = stamp
    url = f"http://127.0.0.1:{port}/?v={stamp}"
    if busy:
        print(f"科研工作 1.0 已在运行：{url}")
    else:
        WorkflowDB(DB_PATH).close()
        srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        schedule.start()          # 定时任务：只有真正拥有服务端口的进程才调度（第二个实例不重复跑）
        team.start_worker()       # 团队派活队列（串行：一次跑一个成员）
        print(f"科研工作 1.0 已启动：{url}")
    if "--no-open" not in sys.argv:
        # 已经有「这一版」的窗口 → 把它从最小化恢复并置前，不再开新的
        same = [h for h, title in _app_windows() if f"v{stamp}" in title]
        if same:
            for h in same:
                _front(h)
        elif not busy and _webview_window(url, stamp):
            # 自己的无边框窗口（没有系统标题栏，顶栏是页面自己画的）→ 关窗即退出
            return 0
        else:
            exe = edge()
            try:
                if exe:
                    # 退回 Edge --app（旧路径，会带一条系统标题栏）；默认铺满屏幕
                    subprocess.Popen([exe, f"--app={url}", "--start-maximized"],
                                     creationflags=0x00000008)  # DETACHED_PROCESS
                    for _ in range(12):                       # 等窗口起来再置前（新开的也不保证在前）
                        time.sleep(0.5)
                        opened = [h for h, t in _app_windows() if f"v{stamp}" in t]
                        if opened:
                            _front(opened[0]); _maximize(opened[0]); break
                else:
                    webbrowser.open(url)
            except OSError:
                webbrowser.open(url)
    if busy:
        return 0
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except BaseException:  # pythonw 下没有控制台，错误必须落盘，否则双击后“什么都没发生”
        log = HERE / "data" / "server-error.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text(traceback.format_exc(), encoding="utf-8")
        raise SystemExit(1)
