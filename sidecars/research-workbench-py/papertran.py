"""「论文翻译」这一页的后端：PDF 文件、元数据抽取、BabelDOC 翻译任务、中文笔记。

三件事各自独立，都不动业务库结构（只读 papers 表 + 复用 md_notes）：
  · pdf_path(db, pid)        -> 找到那篇 PDF 的真实路径（来源是我们自己的入库记录）
  · paper_meta(db, pid)      -> DOI / 题目 / 关键词 / 发表时间，取不到给 ""（前端显示「暂无信息」）
  · start(db, ...)           -> 后台跑 BabelDOC（默认输出**同页左右对照**），进度写进进程内状态表
  · note_from_translation()  -> 把译文（mono.pdf）逐页文字抽出来，建成**绑定到项目**的笔记
"""
from __future__ import annotations

import pdfio            # PDF 读写（pypdf/pdfplumber，见 pdfio.py）
import json
import os
import re
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

# BabelDOC 实测：模型/字体走本机缓存，只有 tiktoken 小文件首次要联网（已灌进缓存）
BABELDOC_CMD = ["uv", "tool", "run", "babeldoc"]

# 从 pythonw（无控制台）里起控制台程序，Windows 会给子进程新建一个黑窗；
# 用户一关这个黑窗，子进程就收到控制台事件、以 0xC000013A 退出 —— 表现就是
# 「点翻译弹黑窗然后卡住」。所以子进程必须不创建控制台。
_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
_CREATE_NEW_PROCESS_GROUP = 0x00000200 if os.name == "nt" else 0   # 控制台事件不再传播给子进程
STALL_SECONDS = 900                        # 多久没有任何输出就判定卡死（版式识别偶尔会安静几分钟）
ZHIPU_BASE = "https://open.bigmodel.cn/api/paas/v4"
ZHIPU_MODEL = "glm-4-flash"
QPS_TOTAL = int(os.environ.get("RW_TRANS_QPS", "8"))      # 全局并发上限（DeepSeek 的并发上限跟余额挂钩，别超）
CHUNK_PARALLEL = int(os.environ.get("RW_TRANS_PARALLEL", "3"))   # 同时跑几段
CHUNK_MAX = int(os.environ.get("RW_TRANS_CHUNKS", "3"))           # 整篇切几段（每段都要重跑一次版式模型，段多反而更慢）     # 翻译并发上限（原来 4，太保守；不满意就设这个环境变量）
JOBS: dict[str, dict[str, Any]] = {}          # paper_id -> 翻译任务状态（进程内，够用）
_LOCK = threading.Lock()
_LOG_LOCK = threading.Lock()      # 多段并行时日志文件是共享的
_SPLICE_LOCK = threading.Lock()   # 拼接译文必须串行，否则页序会乱

DOI_RE = re.compile(r"\b10\.\d{4,9}/[-._;()/:A-Za-z0-9]+")
KW_RE = re.compile(r"(?i)key\s?words?\s*[:：]?\s*(.{5,240})")


# ---------------- PDF 文件 ----------------
def pdf_path(db: Any, paper_id: str) -> Path | None:
    row = db.db.execute("SELECT source_path FROM papers WHERE id=?", (paper_id,)).fetchone()
    if not row:
        return None
    p = Path(row["source_path"])
    return p if p.is_file() and p.suffix.lower() == ".pdf" else None


# ---------------- 元数据 ----------------
def _crossref(doi: str, timeout: float = 12) -> dict[str, Any]:
    """按 DOI 反查 Crossref 补全题目/时间/关键词/作者（直连；代理关着也能用）。"""
    env = {k: v for k, v in os.environ.items() if not k.lower().endswith("_proxy")}
    req = urllib.request.Request(f"https://api.crossref.org/works/{urllib.parse.quote(doi)}",
                                 headers={"User-Agent": "research-workbench/1.0 (mailto:local)"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=timeout) as r:                # 显式不走代理
        return json.load(r).get("message", {}) or {}


_META_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}   # 同一篇别反复去 Crossref（笔记模式也用它取短名）


def paper_meta(db: Any, paper_id: str) -> dict[str, Any]:
    path = pdf_path(db, paper_id)
    if not path:
        return {"error": "找不到这篇 PDF 的文件"}
    try:
        mt = path.stat().st_mtime
    except OSError:
        mt = 0.0
    hit = _META_CACHE.get(str(path))
    if hit and hit[0] == mt and len(hit[1]) > 1:
        return dict(hit[1])
    out: dict[str, Any] = {"filename": path.name, "doi": "", "title": "", "keywords": "",
                           "published": "", "authors": "", "pages": 0, "source": ""}
    out["pages"] = pdfio.page_count(path)
    text = pdfio.text(path, limit=3)
    _meta = pdfio.meta(path)
    out["title"] = _meta["title"] or pdfio.biggest_title(path)
    out["published"] = _meta["creation"][:10].replace("D:", "")
    m = DOI_RE.search(text)
    if m:
        out["doi"] = m.group(0).rstrip(".,;)")
    kw = KW_RE.search(text)
    if kw:
        out["keywords"] = re.sub(r"\s+", " ", kw.group(1)).strip()[:200]
    if out["doi"]:                                              # 有 DOI 就再去 Crossref 补全
        try:
            msg = _crossref(out["doi"])
            out["source"] = "crossref"
            out["title"] = (msg.get("title") or [out["title"]])[0][:300]
            subs = msg.get("subject") or []
            if subs and len(out["keywords"]) < 5:
                out["keywords"] = "，".join(subs[:8])
            dp = (msg.get("published-print") or msg.get("published-online") or msg.get("issued") or {}).get("date-parts") or []
            if dp and dp[0]:
                out["published"] = "-".join(f"{x:02d}" if i else f"{x}" for i, x in enumerate(dp[0]))
            names = [f"{a.get('given','')} {a.get('family','')}".strip() for a in (msg.get("author") or [])[:6]]
            out["authors"] = "、".join(n for n in names if n)
        except Exception as exc:
            out["source"] = f"crossref 失败：{type(exc).__name__}"
    if len(_META_CACHE) > 64:
        _META_CACHE.clear()
    _META_CACHE[str(path)] = (mt, dict(out))
    return out


# ---------------- 翻译任务（BabelDOC） ----------------
def _llm_cfg(db: Any) -> dict[str, str]:
    """优先用应用里配好的模型；没有就退回环境里的智谱（实测可用）。"""
    try:
        m = db.active_model() or {}
    except Exception:
        m = {}
    base = (m.get("base_url") or "").strip()
    key = (m.get("api_key") or "").strip()
    if base and key:
        return {"base": base, "key": key, "model": (m.get("model") or ZHIPU_MODEL).strip()}
    return {"base": ZHIPU_BASE, "key": os.environ.get("ZHIPUAI_API_KEY", "").strip(), "model": ZHIPU_MODEL}


def out_paths(pdf: Path, out_dir: Path) -> tuple[Path, Path]:
    """babeldoc 的产物名：<name>.no_watermark.zh.{dual,mono}.pdf"""
    return (out_dir / f"{pdf.stem}.no_watermark.zh.dual.pdf",
            out_dir / f"{pdf.stem}.no_watermark.zh.mono.pdf")


def _state_path(out_dir: Path, paper_id: str) -> Path:
    return out_dir / f"trans_{paper_id[:8]}.json"


def _save_state(out_dir: Path, paper_id: str, pages_done: int, total: int, done: bool) -> None:
    """译文是边翻边落盘的，所以「文件在不在」不等于「翻完了」—— 单独记一份状态，靠它判断缓存/续翻。"""
    try:
        _state_path(out_dir, paper_id).write_text(
            json.dumps({"pages_done": pages_done, "total": total, "done": done}, ensure_ascii=False),
            encoding="utf-8")
    except OSError:
        pass


def _read_state(out_dir: Path, paper_id: str) -> dict[str, Any]:
    try:
        return json.loads(_state_path(out_dir, paper_id).read_text(encoding="utf-8"))
    except Exception:
        return {}


def status(paper_id: str) -> dict[str, Any]:
    with _LOCK:
        return dict(JOBS.get(paper_id) or {"state": "idle"})


def _env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.lower().endswith("_proxy")}
    env["HF_HUB_OFFLINE"] = "1"                                 # 版式模型本机已有缓存
    env["HF_HUB_DISABLE_TELEMETRY"] = "1"
    env["TIKTOKEN_CACHE_DIR"] = os.path.expanduser("~/.cache/babeldoc/tiktoken")
    env["NO_PROXY"] = "*"
    env["PYTHONUNBUFFERED"] = "1"                               # 不然日志/progress 全憋在缓冲区里，UI 看不出进度
    env["PYTHONIOENCODING"] = "utf-8"
    env["COLUMNS"] = "220"                                      # rich 按 80 列换行会把 "12/40" 截成 "12/…"
    return env


def _parse_pages(s: str) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for part in (s or "").split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            out.append((int(a), int(b)))
        else:
            out.append((int(part), int(part)))
    return out


def _plan(n: int) -> list[tuple[int, int]]:
    """分批顺序：先单独翻第 1 页（他要「第一页好了先展示第一页」），往后按批推。
    页多了就均分成 CHUNK_MAX 段 —— 每段都要重跑一次版式模型，段数太多反而更慢。"""
    if n <= 0:
        return []
    if n == 1:
        return [(1, 1)]
    if n > 12:
        size = -(-n // max(1, CHUNK_MAX))
    else:
        size = 3
    parts, a = [(1, 1)], 2
    while a <= n:
        b = min(n, a + size - 1)
        parts.append((a, b))
        a = b + 1
    return parts


def start(db: Any, paper_id: str, out_dir: Path, pages: str = "", force: bool = False) -> dict[str, Any]:
    path = pdf_path(db, paper_id)
    if not path:
        return {"error": "找不到这篇 PDF 的文件"}
    out_dir.mkdir(parents=True, exist_ok=True)
    dual, mono = out_paths(path, out_dir)
    cfg = _llm_cfg(db)
    if not cfg["key"]:
        return {"error": "没有可用的翻译模型：先去「模型」页配一家，或让环境里有 ZHIPUAI_API_KEY"}
    st = _read_state(out_dir, paper_id)
    with _LOCK:
        job = JOBS.get(paper_id)
        if job and job.get("state") == "running":
            return {"ok": True, "already": True, **job}
        if mono.is_file() and st.get("done") and not force:     # 只有状态文件说翻完了才算缓存
            JOBS[paper_id] = {"state": "done", "pct": 100, "msg": "已有译文（缓存）", "mono": str(mono),
                              "dual": str(dual) if dual.is_file() else "", "cached": True,
                              "pages_done": st.get("total") or 0, "total_pages": st.get("total") or 0}
            return {"ok": True, "cached": True, **JOBS[paper_id]}
        JOBS[paper_id] = {"state": "running", "pct": 0, "msg": "启动中…", "mono": str(mono) if mono.is_file() else "",
                          "dual": "", "pages_done": 0, "total_pages": 0}
    n = 0
    try:
        n = pdfio.page_count(path)
    except Exception:
        pass
    plan = _parse_pages(pages) or _plan(n)
    if not pages and mono.is_file():
        keep = int(st.get("pages_done") or 0)                # 上次翻到一半：从没翻的那段接着来
        if 0 < keep < n:
            plan = [c for c in plan if c[0] > keep] or _plan(n)
            with _LOCK:
                JOBS[paper_id] = {**JOBS[paper_id], "pages_done": keep, "total_pages": n,
                                  "pct": int(keep * 100 / max(1, n)),
                                  "msg": f"接着翻（第 1-{keep} 页已翻好）"}
    _save_state(out_dir, paper_id, int(st.get("pages_done") or 0) if mono.is_file() else 0, n, False)
    threading.Thread(target=_run, args=(paper_id, path, out_dir, cfg, plan, mono, _env()), daemon=True).start()
    return {"ok": True, "state": "running", "chunks": len(plan), "total_pages": n}


_PROG = re.compile(r"(\d+)\s*/\s*(\d+)")
_PHASES = (("doclayout", "识别版式"), ("parse page layout", "识别版式"), ("term extractor", "抽术语表"),
           ("glossary", "抽术语表"), ("translating", "翻译正文"), ("translate", "翻译正文"),
           ("save", "写回 PDF"), ("write", "写回 PDF"))


def _phase(line: str) -> str:
    low = line.lower()
    for k, v in _PHASES:
        if k in low:
            return v
    return ""


def _why(code: int) -> str:
    """把 Windows 的魔数退出码翻成人话，免得界面只显示一串数字。"""
    return {3221225786: "：子进程被控制台事件中断（黑窗被关掉/按了 Ctrl+C）",
            3221225477: "：子进程崩溃（访问冲突）",
            -9: "：看门狗判定卡死后终止"}.get(code, "")


def _spawn(paper_id: str, cmd: list[str], env: dict[str, str], fh: Any, a: int, b: int) -> int:
    """跑一段 babeldoc：日志边写边刷新，状态里同步进度"""
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, text=True, encoding="utf-8",
                            errors="replace", env=env,
                            creationflags=_CREATE_NO_WINDOW | _CREATE_NEW_PROCESS_GROUP)
    phase, done, tot = "", 0, 0
    last = [time.monotonic()]

    def _watch() -> None:                  # 卡死看门狗：读循环会阻塞在 readline 上，只能另起线程盯
        while proc.poll() is None:
            if time.monotonic() - last[0] > STALL_SECONDS:
                fh.write(f"!!! 超过 {STALL_SECONDS}s 没有任何输出，判定卡死并终止\n")
                fh.flush()
                proc.kill()
                return
            time.sleep(5)

    threading.Thread(target=_watch, daemon=True).start()
    for line in proc.stdout or []:
        last[0] = time.monotonic()
        with _LOG_LOCK:
            fh.write(line)
            fh.flush()
        ph = _phase(line)
        if ph:
            phase = ph
        if "translate" in line.lower() or "-----" in line or "━" in line:
            for cand in _PROG.finditer(line):        # 只认 "已完成/总数"（时间戳 0:00:10/0:00:06 会被 done>total 挡掉）
                x, y = int(cand.group(1)), int(cand.group(2))
                if 0 < x <= y:
                    done, tot = x, y
                    break
        msg = f"第 {a}-{b} 页 · {phase or '准备中'}" + (f" {done}/{tot}" if tot else "")
        with _LOCK:
            JOBS[paper_id] = {**JOBS.get(paper_id, {}), "state": "running", "msg": msg}
    return proc.wait()


def _splice_serial(dest: Path, part: Path, a: int, b: int) -> None:
    with _SPLICE_LOCK:                    # 多段并行时，拼页必须一个一个来
        _splice(dest, part, a, b)


def _trim_tail(mono: Path, src: Path, done_pages: int) -> None:
    """只裁「超出已翻页数 done_pages」的尾部原页 —— 那些是 babeldoc 为版式上下文带进来的
    未翻译页（实测要 1-2 页会给整篇）。

    为什么必须有 done_pages 这个上限：模型/接口出问题时 babeldoc 会把段落原样 fallback，
    这些「真译文页」的文字与原文**逐字相同**，只按文字判会把 38 页全删掉（踩过一次）。
    已翻页以内的页一律不动。

    ponytail: 判据仍是「文字与原文完全相同」。整页只有公式/图的页可能也满足而被删 ——
    这种页本来没有可翻的文字，代价可接受；真要精确就按页存一份「本页已翻」的标记。
    """
    try:
        a_texts = pdfio.page_texts(mono)
        b_texts = pdfio.page_texts(src)
        n = len(a_texts)
        keep = n
        while keep > 1 and keep > done_pages:
            i = keep - 1
            a = a_texts[i]
            b = b_texts[i] if i < len(b_texts) else ""
            if a and b and a == b:
                keep -= 1
            else:
                break
        if keep == n or keep < 1:
            return
        tmp = mono.with_name(mono.name + ".trim.pdf")
        pdfio.write_pages(tmp, [(mono, i) for i in range(keep)])
        os.replace(tmp, mono)
    except Exception:
        return
def _splice(dest: Path, part: Path, a: int, b: int) -> None:
    """把 part 里第 a..b 页拼进累积译文（页序始终跟原文一一对应）。

    babeldoc 为版式上下文会多带页（实测要 1-2 页给整篇），所以只取 [a, b] 区间；
    文档只增不减：新段可能把页数往后推，乱序并行缺页时补空白页，保住页号一一对应。
    """
    tmp = dest.with_name(dest.name + ".tmp.pdf")
    if not dest.is_file():
        pdfio.write_pages(tmp, [(part, k) for k in range(a - 1, min(b, pdfio.page_count(part)))])
    else:
        old_n, new_n = pdfio.page_count(dest), pdfio.page_count(part)
        srcs: list[tuple[Path, int] | None] = []
        for k in range(max(old_n, b)):
            if (a - 1) <= k <= (b - 1) and k < new_n:
                srcs.append((part, k))
            elif k < old_n:
                srcs.append((dest, k))
            else:
                srcs.append(None)                     # 还没翻到的那页先占位，等它自己那段来填
        pdfio.write_pages(tmp, srcs, size=pdfio.page_size(part) if new_n else None)
    for _ in range(3):
        try:
            tmp.replace(dest)
            return
        except OSError:                              # 前端可能正读着这个文件，等一下再换
            time.sleep(0.4)

def _progress(paper_id: str, msg: str, done: int, total: int, log: Path,
              pct: int | None = None, mono: str = "") -> None:
    with _LOCK:
        cur = JOBS.get(paper_id, {})
        upd = {**cur, "state": "running", "msg": msg, "pages_done": done, "total_pages": total, "log": str(log)}
        if pct is not None:
            upd["pct"] = pct
        if mono:
            upd["mono"] = mono
        JOBS[paper_id] = upd


def _pages_done(paper_id: str) -> int:
    with _LOCK:
        return int(JOBS.get(paper_id, {}).get("pages_done") or 0)


def _balance_hint(tail: str) -> str:
    """从日志尾部认出发钱相关的错误，直接给人话（这类错重试没用，得充值/降并发）。"""
    low = tail.lower()
    if "insufficient balance" in low or "'code': 'invalid_request_error'" in low and "402" in low:
        return "API 余额不足（402 Insufficient Balance）—— 充值后再翻"
    if "concurrency" in low and "429" in low:
        return "并发超限（429）—— 充值提升额度，或把 RW_TRANS_PARALLEL 调小"
    return ""


def _fail(paper_id: str, mono: Path, total: int, log: Path, a: int, b: int, code: int) -> None:
    hint = ""
    try:
        hint = _balance_hint(log.read_text(encoding="utf-8", errors="replace")[-4000:])
    except Exception:
        pass
    with _LOCK:
        cur = JOBS.get(paper_id, {})
        JOBS[paper_id] = {**cur, "state": "partial" if mono.is_file() else "error",
                          "msg": (hint or f"翻到第 {a}-{b} 页时失败（退出码 {code}{_why(code)}）"),
                          "total_pages": total, "mono": str(mono) if mono.is_file() else "", "log": str(log)}


def _run(paper_id: str, path: Path, out_dir: Path, cfg: dict[str, str],
         plan: list[tuple[int, int]], mono: Path, env: dict[str, str]) -> None:
    """按段翻，段与段**并行**（CHUNK_PARALLEL）；翻好一段立刻拼进 mono，UI 就能边翻边看。

    ponytail: 每段仍各自重跑一次版式模型（实测约 16s/段），所以段数被 CHUNK_MAX 压着。
    想再快就把整篇交给一个 babeldoc 进程跑 —— 代价是失去「第一页先出来」和断点续翻。
    """
    log = mono.parent / f"trans_{paper_id[:8]}.log"
    total = plan[-1][1] if plan else 0

    def one(idx: int, a: int, b: int) -> bool:
        part_dir = out_dir / "_parts" / f"p{a}-{b}"
        part_dir.mkdir(parents=True, exist_ok=True)
        with _LOG_LOCK:
            fh.write(f"\n===== 第 {a}-{b} 页（第 {idx}/{len(plan)} 段）=====\n")
            fh.flush()
        _progress(paper_id, f"正在翻第 {a}-{b} 页（第 {idx}/{len(plan)} 段）", a - 1, total, log)
        cmd = BABELDOC_CMD + ["--files", str(path), "--lang-in", "en", "--lang-out", "zh",
                              "--openai", "--openai-model", cfg["model"],
                              "--openai-base-url", cfg["base"], "--openai-api-key", cfg["key"],
                              "--watermark-output-mode", "no_watermark",
                              # 每段分到的并发 = 全局上限 / 段数（段并行后必须摊薄，否则撞余额决定的并发上限 429）
                              "--qps", str(max(1, QPS_TOTAL // max(1, CHUNK_PARALLEL))),
                              "--no-dual",                    # UI 只用单语译文，省掉对照版的生成
                              "--no-auto-extract-glossary",   # 省掉一整趟全篇术语抽取的 LLM 调用
                              "--pages", f"{a}-{b}",
                              "--working-dir", str(out_dir / "_work" / f"p{a}-{b}"),
                              "--output", str(part_dir)]
        code = _spawn(paper_id, cmd, env, fh, a, b)
        part_mono = part_dir / mono.name
        if code != 0 or not part_mono.is_file():
            with _LOG_LOCK:
                fh.write(f"!!! 这段失败：退出码 {code}\n")
                fh.flush()
            _fail(paper_id, mono, total, log, a, b, code)
            return False
        _splice_serial(mono, part_mono, a, b)
        _trim_tail(mono, path, max(_pages_done(paper_id), b))   # 只裁超出已翻范围的尾部原页
        done = max(_pages_done(paper_id), b)      # 并行完成顺序不定，进度只许往前走
        _save_state(out_dir, paper_id, done, total, False)
        _progress(paper_id, f"已翻好第 1-{done} 页 / 共 {total} 页", done, total, log,
                  pct=int(done * 100 / max(1, total)), mono=str(mono))
        return True

    try:
        with log.open("w", encoding="utf-8", errors="replace") as fh:
            futs = []
            with ThreadPoolExecutor(max_workers=max(1, min(CHUNK_PARALLEL, len(plan) or 1))) as ex:
                for idx, (a, b) in enumerate(plan, 1):
                    futs.append(ex.submit(one, idx, a, b))
                for f in as_completed(futs):
                    if not f.result():             # 有一段失败：停掉还没跑的，已翻好的留下
                        for g in futs:
                            g.cancel()
                        return
        _save_state(out_dir, paper_id, total, total, True)
        with _LOCK:
            JOBS[paper_id] = {**JOBS.get(paper_id, {}), "state": "done", "pct": 100, "msg": "完成",
                              "pages_done": total, "total_pages": total,
                              "mono": str(mono), "log": str(log)}
    except Exception as exc:
        with _LOCK:
            cur = JOBS.get(paper_id, {})
            JOBS[paper_id] = {**cur, "state": "partial" if mono.is_file() else "error",
                              "msg": f"{type(exc).__name__}: {exc}", "log": str(log)}
            _save_state(out_dir, paper_id, int(cur.get("pages_done") or 0), total, False)


# ---------------- 译文 → 中文笔记 ----------------
def pdf_words(path: Path, max_pages: int = 0) -> dict[str, Any]:
    """每页的词 + 坐标（PDF 点，左上原点），前端按缩放比铺文字层：
    自己能控、离线可用，还能让荧光笔的选区对准（pdf.js 的 renderTextLayer 在 WebView2 里会挂）。"""
    return {"pages": pdfio.pages_with_words(path, max_pages)}


def mono_pages(mono: Path) -> list[str]:
    return pdfio.page_texts(mono)


_CJK = re.compile(r"[\u3400-\u9fff]")


def only_chinese(text: str) -> str:
    """只留含中文的段落（部分翻译时未翻的页还是英文，用户要「光要中文」）。"""
    keep = [p.strip() for p in re.split(r"\n{2,}", text) if _CJK.search(p)]
    return "\n\n".join(keep)


def short_name(title: str, stem: str = "") -> str:
    """「阅读笔记」后面跟的论文短名：中文取前 10 字，英文取前 3 个词；取不到就用文件名（去哈希前缀）。"""
    t = re.sub(r"\s+", " ", (title or "").strip())
    if not t:
        t = re.sub(r"^[0-9a-f]{8,}_", "", stem or "").rsplit(".", 1)[0]
    if _CJK.search(t):
        head = t[:10]
    else:
        words = t.split(" ")
        head = " ".join(words[:3]) if len(words) > 3 else t
    head = head.strip(" .,:;-–—")
    if head and len(head) < len(t):
        head += "…"
    return head[:26]


def reading_note(db: Any, task_id: str, paper_id: str, out_dir: Path) -> dict[str, Any]:
    """点「笔记模式」调它：给这篇论文**复用或新建一篇「阅读笔记」**（空白、绑论文 + 绑项目），
    左边那份中文全文单独返回（不塞进笔记正文 —— 正文是他自己随记随写的地方）。"""
    path = pdf_path(db, paper_id)
    if not path:
        return {"error": "找不到这篇 PDF 的文件"}
    name = "阅读笔记 · " + (short_name(paper_meta(db, paper_id).get("title", ""), path.stem) or "未命名")
    note = db.md_note_by_paper(paper_id)
    if not note:
        note = db.save_md_note("", name, "", task_id, paper_id)
    else:                                              # 已有：补项目绑定 + 刷新自动名（他自己改过名就不动）
        t = note.get("title") or ""
        if (task_id and not note.get("task_id")) or (t.startswith("阅读笔记") and t != name):
            note = db.save_md_note(note["id"], name if t.startswith("阅读笔记") else t,
                                   note.get("content") or "", task_id, paper_id)
    _, mono = out_paths(path, out_dir)
    text, pages = "", 0
    if mono.is_file():
        kept = [only_chinese(t) for t in mono_pages(mono)]
        kept = [t for t in kept if t]
        pages = len(kept)
        text = "\n\n".join(kept)
    return {"note": note, "text": text, "pages": pages, "has_mono": mono.is_file()}


if __name__ == "__main__":                                     # 自带小样：不联网的那部分
    from datetime import datetime
    assert DOI_RE.search("see 10.1038/s41524-025-01554-0 for details").group(0) == "10.1038/s41524-025-01554-0"
    assert KW_RE.search("Keywords: machine learning, NLP, materials").group(1).startswith("machine learning")
    assert out_paths(Path("a/b/x.pdf"), Path("o"))[0].name == "x.no_watermark.zh.dual.pdf"
    assert _PROG.search("translate 12/100 0:01:42").groups() == ("12", "100")

    def prog(line: str) -> tuple[int, int]:            # _run 里那段挑 N/M 的逻辑，抽出来单独验
        if "translate" not in line.lower() and "-----" not in line and "━" not in line:
            return 0, 0
        for c in _PROG.finditer(line):
            a, b = int(c.group(1)), int(c.group(2))
            if 0 < a <= b:
                return a, b
        return 0, 0

    assert prog("translate ----- 37/94  0:01:42 0:00:11") == (37, 94)
    assert prog("translate ----- 10/6 0:00:10/0:00:06") == (0, 0)   # 时间戳冒名顶替的那种，丢掉
    assert prog("INFO doclayout:Loading ONNX model...") == (0, 0)
    assert _plan(1) == [(1, 1)] and _plan(2) == [(1, 1), (2, 2)]
    assert _plan(9) == [(1, 1), (2, 4), (5, 7), (8, 9)]            # 先给第 1 页，然后每 3 页一段
    p30 = _plan(30)
    assert sum(b - a + 1 for a, b in p30) == 30 and p30[0] == (1, 1) and len(p30) <= 8
    assert all(p30[i][1] + 1 == p30[i + 1][0] for i in range(len(p30) - 1))   # 段与段之间不留缝
    assert _parse_pages("2") == [(2, 2)] and _parse_pages("3-5") == [(3, 5)]
    assert short_name("Deep learning design of nanoscale polariton propagations") == "Deep learning design…"
    assert short_name("扭曲范德华多层结构中纳米尺度极化子传播") == "扭曲范德华多层结构中…"
    assert short_name("", "6bdd7f0c47bd_s41563-026-02723-2.pdf") == "s41563-026-02723-2"
    assert short_name("Short") == "Short"
    assert status("nope")["state"] == "idle"
    print("papertran.py 自检通过", datetime.now().strftime("%H:%M"))
