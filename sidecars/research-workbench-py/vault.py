"""知识库（Obsidian Vault）读写。

边界规则照 personal-research-workbench 的 `connectors/obsidian.ts`：只碰「已授权 Vault」内的
Markdown，路径/符号链接/敏感目录全部在服务端校验，永不写 `.obsidian/`、越界直接拒、只改
frontmatter 里要改的那几个键（正文一字不动）。

frontmatter 只做最小 YAML 子集（`key: value` 一行一个），够 阅读状态/吸收状态/创建日期 用。
状态口径照 Baixiao-Reading-Cockpit：阅读状态 未读|在读|已读，吸收状态 待沉淀|已沉淀|无需沉淀，
缺属性算「未读 / 待沉淀」；写状态时顺带补 状态更新时间、首次进「在读」补 开始阅读、首次进「已读」补 完成阅读。
"""
from __future__ import annotations

import datetime as dt
import os
import re
import urllib.parse
from pathlib import Path

READING = ("未读", "在读", "已读")
ABSORPTION = ("待沉淀", "已沉淀", "无需沉淀")
IGNORED = {".obsidian", ".trash", ".git", "node_modules"}
MAX_FILES = 20000          # 单次扫描最多读多少篇（大库防卡）
MAX_BYTES = 2 * 1024 * 1024
RETURN_LIMIT = 3000        # 回给前端的笔记条数上限（前端只做展示/筛选，超了也能用）


class VaultError(Exception):
    """路径越界、Vault 不合法、字段不合法 —— 前端直接把 message 显示出来。"""


def _today() -> str:
    return dt.date.today().isoformat()


def vault_root(value: str) -> Path:
    raw = (value or "").strip().strip('"').strip("'")
    if not raw or not os.path.isabs(raw):
        raise VaultError("Vault 必须是绝对路径")
    root = Path(raw).resolve()
    if not root.is_dir():
        raise VaultError("Vault 目录不存在：" + str(root))
    if any(seg.lower() == ".obsidian" for seg in root.parts):
        raise VaultError("Vault 不能位于 .obsidian 内部")
    return root


def note_path(root: Path, rel: str) -> Path:
    rel = (rel or "").replace("\\", "/").lstrip("/")
    if not rel:
        raise VaultError("缺笔记路径")
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        raise VaultError("笔记不在这个 Vault 里")
    if any(seg.lower() in IGNORED or seg.startswith(".") for seg in target.relative_to(root).parts[:-1]):
        raise VaultError("跳过敏感目录")
    if target.suffix.lower() != ".md":
        raise VaultError("只处理 Markdown")
    return target


FM_RE = re.compile(r"\A---[^\S\r\n]*\r?\n(.*?)^---[^\S\r\n]*\r?\n?", re.S | re.M)
DATE_RE = re.compile(r"(\d{4})-(\d{1,2})-(\d{1,2})")


def date_key(value) -> str:
    """把 frontmatter 里的日期写成 YYYY-MM-DD；认不出来返回空串（= 不信这个日期）。"""
    m = DATE_RE.search(str(value or ""))
    if not m:
        return ""
    y, mo, d = (int(x) for x in m.groups())
    try:
        return dt.date(y, mo, d).isoformat()
    except ValueError:
        return ""


def split_frontmatter(text: str) -> tuple[dict, str, str]:
    """→ (frontmatter 字典, frontmatter 原文, 正文)。没有 frontmatter 时正文 = 全文。"""
    m = FM_RE.match(text)
    if not m:
        return {}, "", text
    raw = m.group(1)
    fm: dict[str, str] = {}
    for line in raw.splitlines():
        if not line.strip() or line.lstrip().startswith("#") or ":" not in line:
            continue
        k, v = line.split(":", 1)
        fm[k.strip()] = v.strip().strip('"').strip("'")
    return fm, raw, text[m.end():]


def _yaml_value(v) -> str:
    s = str(v)
    return s if re.fullmatch(r"[\w\u4e00-\u9fff./+@-]+", s) else '"%s"' % s.replace('"', "'")


def write_frontmatter(path: Path, updates: dict) -> list[str]:
    """只动 updates 里这几个键，其余行与正文原样保留。→ 实际改动的键。"""
    text = path.read_text(encoding="utf-8", errors="replace")
    fm, raw, body = split_frontmatter(text)
    changed = [k for k, v in updates.items() if fm.get(k) != _yaml_value(v)]
    if not changed:
        return []
    lines = raw.splitlines() if raw else []
    for k in changed:
        new = "%s: %s" % (k, _yaml_value(updates[k]))
        for i, line in enumerate(lines):
            if line.split(":", 1)[0].strip() == k:
                lines[i] = new
                break
        else:
            lines.append(new)
    head = "---\n" + "\n".join(lines) + "\n---\n"
    out = head if raw else head + "\n" + body
    if raw:
        out += body if body.startswith("\n") else "\n" + body
    path.write_text(out, encoding="utf-8")
    return changed


def _tags(fm: dict, body: str) -> list[str]:
    raw = re.sub(r"[\[\]'\"]", "", str(fm.get("tags") or fm.get("标签") or ""))
    tags = [t.strip().lstrip("#") for t in re.split(r"[,\s]+", raw) if t.strip()]
    if not tags:
        tags = re.findall(r"(?<!\w)#([\w\u4e00-\u9fff/-]{2,})", body[:6000])
    return tags[:6]


def scan(value: str) -> dict:
    """扫一遍 Vault：每篇笔记的状态/日期/标签 + 顶部统计 + 近一年热力图数据。"""
    root = vault_root(value)
    notes: list[dict] = []
    skipped = 0
    for p in sorted(root.rglob("*.md")):
        rel = p.relative_to(root)
        if any(seg.startswith(".") or seg in IGNORED for seg in rel.parts[:-1]):
            continue
        if len(notes) >= MAX_FILES:
            skipped += 1
            continue
        try:
            st = p.stat()
            if st.st_size > MAX_BYTES:
                skipped += 1
                continue
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            skipped += 1
            continue
        fm, _raw, body = split_frontmatter(text)
        created_fm = date_key(fm.get("创建日期") or fm.get("date"))
        reading = fm.get("阅读状态") if fm.get("阅读状态") in READING else "未读"
        absorption = fm.get("吸收状态") if fm.get("吸收状态") in ABSORPTION else "待沉淀"
        notes.append({
            "path": rel.as_posix(),
            "title": str(fm.get("title") or p.stem),
            "folder": rel.parent.as_posix() if str(rel.parent) != "." else "根目录",
            "rootFolder": rel.parts[0] if len(rel.parts) > 1 else "",
            "reading": reading,
            "absorption": absorption,
            "created": created_fm or dt.date.fromtimestamp(st.st_mtime).isoformat(),
            "createdFromFrontmatter": bool(created_fm),
            "completed": date_key(fm.get("完成阅读")),
            "statusUpdated": date_key(fm.get("状态更新时间")),
            "modified": int(st.st_mtime),
            "tags": _tags(fm, body),
            "words": len(re.sub(r"\s+", "", body)),
        })
    return {"vault": str(root), "name": root.name, "skipped": skipped,
            "stats": _stats(notes), "days": _days(notes), "notes": notes[:RETURN_LIMIT]}


def _stats(notes: list[dict]) -> dict:
    total = len(notes)
    read = [n for n in notes if n["reading"] == "已读"]
    unread = [n for n in notes if n["reading"] == "未读"]
    limit = (dt.date.today() - dt.timedelta(days=30)).isoformat()
    return {
        "total": total,
        "unread": len(unread),
        "reading": sum(1 for n in notes if n["reading"] == "在读"),
        "read": len(read),
        "pending": sum(1 for n in read if n["absorption"] == "待沉淀"),
        "longUnread": sum(1 for n in unread if n["created"] < limit),
        "todayAdded": sum(1 for n in notes if n["createdFromFrontmatter"] and n["created"] == _today()),
        "rate": round(len(read) / total * 100) if total else 0,
        "words": sum(n["words"] for n in notes),
    }


def _days(notes: list[dict]) -> list[dict]:
    """近 365 天，每格 = 当天入库(创建日期)/完成阅读/仍待沉淀。口径与顶部统计一致。"""
    today = dt.date.today()
    dates = [(today - dt.timedelta(days=off)).isoformat() for off in range(364, -1, -1)]
    rows = {d: {"date": d, "added": 0, "read": 0, "pending": 0} for d in dates}
    for n in notes:
        if n["createdFromFrontmatter"] and n["created"] in rows:
            rows[n["created"]]["added"] += 1
        if n["completed"] and n["completed"] in rows:
            rows[n["completed"]]["read"] += 1
            if n["absorption"] == "待沉淀":
                rows[n["completed"]]["pending"] += 1
    return [rows[d] for d in dates]


def set_status(value: str, rel: str, field: str, status: str) -> dict:
    """把看板上的状态写回笔记 frontmatter（顺带补时间戳，正文不动）。"""
    root = vault_root(value)
    p = note_path(root, rel)
    if field not in ("阅读状态", "吸收状态"):
        raise VaultError("只支持写 阅读状态 / 吸收状态")
    allowed = READING if field == "阅读状态" else ABSORPTION
    if status not in allowed:
        raise VaultError("不认识的%s：%s" % (field, status))
    if not p.is_file():
        raise VaultError("笔记不存在：" + rel)
    fm, _raw, _body = split_frontmatter(p.read_text(encoding="utf-8", errors="replace"))
    updates = {field: status, "状态更新时间": _today()}
    if field == "阅读状态" and status == "在读" and not fm.get("开始阅读"):
        updates["开始阅读"] = _today()
    if field == "阅读状态" and status == "已读" and not fm.get("完成阅读"):
        updates["完成阅读"] = _today()
    return {"ok": True, "path": rel, "field": field, "value": status,
            "changed": write_frontmatter(p, updates)}


def open_in_obsidian(value: str, rel: str = "") -> dict:
    """交给 Windows 协议处理器打开（没装 Obsidian 就什么也不会发生，前端照常提示失败）。"""
    root = vault_root(value)
    uri = "obsidian://open?vault=" + urllib.parse.quote(root.name)
    if rel:
        uri += "&file=" + urllib.parse.quote(rel[:-3] if rel.lower().endswith(".md") else rel)
    try:
        os.startfile(uri)          # noqa: S606 —— Windows 专用，交给协议处理器
    except OSError as exc:
        raise VaultError("打不开 Obsidian：%s" % exc) from exc
    return {"ok": True, "uri": uri}


if __name__ == "__main__":       # 手跑自检：py -3.10 vault.py <vault 绝对路径>
    import sys

    out = scan(sys.argv[1] if len(sys.argv) > 1 else "")
    print(json.dumps({k: v for k, v in out.items() if k != "notes"}, ensure_ascii=False, indent=1))
