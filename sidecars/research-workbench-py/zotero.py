# -*- coding: utf-8 -*-
"""Zotero 接入（只读）—— 笔记页用。

抄原版「科研工作台」的接入约定（它的 packages/connectors/src/zotero.ts 与
.agents/roles/zotero-local.md）：

  · 只走 Zotero **本机 Local API**（默认 http://127.0.0.1:23119/api/）；
  · **绝不打开/读取/写入 zotero.sqlite，不复制附件，不在后台同步**；
  · 请求头 Zotero-API-Version: 3；分页 limit/start；总数看 `Total-Results` 响应头；
  · 只允许 loopback（非 127.0.0.1/localhost 直接报错）；
  · 能力探测：/connector/ping 看「起没起」，/api/users/0/items 看「读不读得了」，
    没探测成功就不显示「已连接」，中文说清原因（未启动 / 版本太老 / 超时）；
  · 本模块**只读**。写回 Zotero 仍走既有 preview/confirm 流程（integrations.zotero_preview）。

Zotero 7+ 的接口：
  GET /api/users/0/items?format=json&limit=&start=&q=
  GET /api/users/0/collections?format=json&limit=
  GET /api/users/0/collections/<key>/items?format=json&limit=&start=
"""
from __future__ import annotations

import html
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

DEFAULT_BASE = os.environ.get("ZOTERO_LOCAL_API", "http://127.0.0.1:23119")
API_VERSION = "3"
PING_TIMEOUT = 2
READ_TIMEOUT = 8
MAX_LIMIT = 100
LOOPBACK = {"127.0.0.1", "localhost", "::1", "[::1]"}


class ZoteroError(RuntimeError):
    """带中文人话的失败原因（前端直接显示）。"""


# --------------------------------------------------------------------------- #
# 传输层
# --------------------------------------------------------------------------- #
def _base(value: str | None = None) -> str:
    base = (value or DEFAULT_BASE).rstrip("/")
    parts = urllib.parse.urlparse(base)
    if parts.hostname not in LOOPBACK:
        raise ZoteroError("只允许本机 Zotero（地址必须是 127.0.0.1 或 localhost）。")
    return base


def _api_url(base: str, path: str, params: dict[str, Any] | None = None) -> str:
    url = base + "/api" + path
    query = {"format": "json"}
    for key, value in (params or {}).items():
        if value is None or value == "":
            continue
        query[key] = value
    return url + "?" + urllib.parse.urlencode(query)


def _get(url: str, timeout: int = READ_TIMEOUT) -> tuple[int, dict[str, str], Any]:
    request = urllib.request.Request(url, headers={
        "Zotero-API-Version": API_VERSION,
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            headers = {k.lower(): v for k, v in response.headers.items()}
            body: Any = json.loads(raw.decode("utf-8", "replace")) if raw else None
            return response.status, headers, body
    except urllib.error.HTTPError as exc:                       # 404 = 版本太老（没有本机 API）
        return exc.code, {k.lower(): v for k, v in (exc.headers or {}).items()}, None
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        raise ZoteroError("连不上 Zotero 本机接口（%s）：%s" % (url.split("?")[0], reason)) from exc
    except TimeoutError as exc:
        raise ZoteroError("Zotero 响应超时（%s 秒）。" % timeout) from exc


def _ping(base: str) -> tuple[bool, str]:
    """Zotero 的 connector 服务器：5/6/7 都有，用来区分「没启动」和「版本太老」。"""
    try:
        with urllib.request.urlopen(base + "/connector/ping", timeout=PING_TIMEOUT) as response:
            response.read(64)
        return True, ""
    except Exception as exc:                                     # noqa: BLE001 — 探活失败一律当没启动
        return False, str(exc)


# --------------------------------------------------------------------------- #
# 条目 / 分类
# --------------------------------------------------------------------------- #
def _first(value: Any) -> Any:
    """Zotero 的字段可能是标量，也可能是 {value: ...} 包装。"""
    if isinstance(value, dict):
        return value.get("value", "")
    return value


def creator_name(creator: dict[str, Any]) -> str:
    if creator.get("name"):
        return str(creator["name"]).strip()
    last = str(creator.get("lastName") or "").strip()
    first = str(creator.get("firstName") or "").strip()
    if last and first:
        return "%s %s" % (last, first)
    return last or first


def year_of(date: Any) -> str:
    match = re.search(r"\d{4}", str(_first(date) or ""))
    return match.group(0) if match else ""


def html_to_text(value: Any) -> str:
    """把 Zotero 笔记的 HTML 拧成纯文本（够写进 markdown 就行，不追求完美）。"""
    text = str(value or "")
    if not text:
        return ""
    text = re.sub(r"(?is)<(script|style).*?</\1>", "", text)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(p|div|li|h[1-6]|tr)>", "\n", text)
    text = re.sub(r"(?i)<li[^>]*>", "- ", text)
    text = re.sub(r"(?i)<h[1-6][^>]*>", "\n## ", text)
    text = re.sub(r"(?is)<(b|strong)[^>]*>(.*?)</\1>", r"**\2**", text)
    text = re.sub(r"(?is)<(i|em)[^>]*>(.*?)</\1>", r"*\2*", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def normalize(item: dict[str, Any]) -> dict[str, Any]:
    """Zotero item → 本应用用的扁平结构（前端列表/编辑器都用它）。"""
    data = item.get("data") or {}
    meta = item.get("meta") or {}
    creators = [creator_name(c) for c in (data.get("creators") or []) if creator_name(c)]
    tags = [str(_first(t.get("tag") if isinstance(t, dict) else t)).strip()
            for t in (data.get("tags") or [])]
    return {
        "key": str(item.get("key") or data.get("key") or ""),
        "version": item.get("version") or meta.get("version") or 0,
        "type": str(data.get("itemType") or ""),
        "title": str(_first(data.get("title")) or "").strip() or "(无标题)",
        "creators": creators[:8],
        "creators_all": creators,
        "year": year_of(data.get("date")),
        "venue": str(_first(data.get("publicationTitle")) or _first(data.get("proceedingsTitle")) or "").strip(),
        "doi": str(_first(data.get("DOI")) or "").strip(),
        "url": str(_first(data.get("url")) or "").strip(),
        "abstract": html_to_text(data.get("abstractNote")),
        "note": html_to_text(data.get("note")),
        "citation": str(data.get("citationKey") or meta.get("citationKey") or "").strip(),
        "tags": [t for t in tags if t],
        "collections": list(data.get("collections") or []),
    }


def as_note(item: dict[str, Any]) -> dict[str, str]:
    """把条目变成一篇本地 Markdown 笔记的内容（题录 + 摘要 + Zotero 笔记正文）。"""
    it = normalize(item)
    head = [f"# {it['title']}", ""]
    line = " · ".join(x for x in [", ".join(it["creators"]) or "作者未填",
                                 it["year"], it["venue"]] if x)
    head.append("- " + line)
    if it["doi"]:
        head.append(f"- DOI: [{it['doi']}](https://doi.org/{it['doi']})")
    if it["url"]:
        head.append(f"- 链接: {it['url']}")
    head.append(f"- Zotero: `{it['key']}`" + (f" · {it['citation']}" if it["citation"] else ""))
    if it["tags"]:
        head.append("- 标签: " + " ".join("#" + t.replace(" ", "-") for t in it["tags"]))
    body = list(head)
    if it["abstract"]:
        body += ["", "## 摘要", "", it["abstract"]]
    if it["note"]:
        body += ["", "## Zotero 笔记", "", it["note"]]
    body += ["", "## 我的批注", "", "（在这里写）", ""]
    title = it["title"][:160] or "Zotero 条目"
    if it["year"]:
        title = f"{title}（{it['year']}）"
    return {"title": title[:160], "content": "\n".join(body)}


# --------------------------------------------------------------------------- #
# 对外四个动作
# --------------------------------------------------------------------------- #
def status(base: str | None = None) -> dict[str, Any]:
    root = _base(base)
    alive, why = _ping(root)
    if not alive:
        return {"connected": False, "readable": False, "base": root,
                "message": "Zotero 没启动（%s 无响应）。打开 Zotero 再点一次。" % root.replace("http://", ""),
                "detail": why[:120]}
    try:
        _, headers, body = _get(_api_url(root, "/users/0/items", {"limit": 1}))
        if not isinstance(body, list):
            raise ZoteroError("Zotero 返回了非预期的内容。")
        total = headers.get("total-results")
        return {"connected": True, "readable": True, "base": root, "total": int(total) if str(total or "").isdigit() else None,
                "message": "Zotero 已连接（本机只读）。" + (f"  库内 {total} 条。" if total else "")}
    except ZoteroError as exc:
        return {"connected": True, "readable": False, "base": root,
                "message": "Zotero 已启动，但本机 API 读不了：%s（需要 Zotero 7 及以上；"
                           "设置→高级 里本机 API 要打开）。" % exc, "detail": str(exc)[:160]}


def collections(base: str | None = None, limit: int = MAX_LIMIT) -> dict[str, Any]:
    root = _base(base)
    _, _, body = _get(_api_url(root, "/users/0/collections", {"limit": min(limit, MAX_LIMIT)}))
    rows = body if isinstance(body, list) else []
    out = []
    for row in rows:
        data = row.get("data") or {}
        out.append({"key": str(row.get("key") or ""), "name": str(data.get("name") or "(未命名分类)"),
                    "parent": str(data.get("parentCollection") or "") or None,
                    "count": int((row.get("meta") or {}).get("numItems") or 0)})
    out.sort(key=lambda c: c["name"])
    return {"collections": out, "count": len(out)}


def items(base: str | None = None, collection: str = "", q: str = "",
          start: int = 0, limit: int = 50) -> dict[str, Any]:
    root = _base(base)
    limit = max(1, min(int(limit or 50), MAX_LIMIT))
    start = max(0, int(start or 0))
    path = f"/users/0/collections/{urllib.parse.quote(collection)}/items" if collection else "/users/0/items"
    params: dict[str, Any] = {"limit": limit, "start": start or None, "sort": "dateModified", "direction": "desc"}
    if q:
        params["q"] = q
        params["qmode"] = "everything"
    _, headers, body = _get(_api_url(root, path, params))
    raw = body if isinstance(body, list) else []
    total_raw = headers.get("total-results")
    total = int(total_raw) if str(total_raw or "").isdigit() else None
    rows = [normalize(row) for row in raw]
    return {"items": rows, "start": start, "returned": len(rows), "total": total,
            "hasMore": (start + len(rows)) < total if total is not None else len(rows) >= limit}


def note_for(base: str | None = None, key: str = "") -> dict[str, str]:
    """按 item key 取一条，产出「可直接存成笔记」的 title/content（不落盘）。"""
    root = _base(base)
    key = str(key or "").strip()
    if not key:
        raise ZoteroError("缺少条目 key。")
    _, _, body = _get(_api_url(root, f"/users/0/items/{urllib.parse.quote(key)}"))
    item = body.get("data") and body or ((body or [{}])[0] if isinstance(body, list) else body)
    if not isinstance(item, dict) or not item:
        raise ZoteroError("Zotero 里没找到条目 %s。" % key)
    return as_note(item)


if __name__ == "__main__":                                        # 手跑自检：python zotero.py [base]
    import sys
    print(json.dumps(status(sys.argv[1] if len(sys.argv) > 1 else None), ensure_ascii=False, indent=1))
