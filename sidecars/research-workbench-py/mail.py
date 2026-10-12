"""mail.py —— 邮箱（IMAP 收信 / SMTP 发信），移植自 lit 的 src/mail.js。

lit 用的是 Node 的 imapflow + mailparser + nodemailer；这里全部用 Python 标准库
（imaplib / smtplib / email）重写，模板方法一一对应：
    open_client / test_account / list_folders / list_messages / peek_recent
    get_message / get_attachment / set_seen / mark_all_seen / delete_message / send_mail
账户存 data/mail.json（和 lit 一样只放本机，含授权码，不上传）。
"""
from __future__ import annotations

import base64
import email
import email.header
import email.policy
import email.utils
import imaplib
import json
import os
import re
import smtplib
import socket
import ssl
import threading
import time
import uuid
from email.message import EmailMessage
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("RESEARCH_WORKBENCH_DATA", HERE / "data"))
MAIL_FILE = DATA_DIR / "mail.json"

# ---------- 常见邮箱服务商预设（与 lit MAIL_PROVIDERS 逐字一致） ----------
MAIL_PROVIDERS: dict[str, dict[str, Any]] = {
    "163": {"label": "网易 163 邮箱", "imapHost": "imap.163.com", "imapPort": 993, "imapSecure": True,
            "smtpHost": "smtp.163.com", "smtpPort": 465, "smtpSecure": True,
            "note": "先在网页版邮箱「设置 → POP3/SMTP/IMAP」中开启 IMAP/SMTP 服务，密码请填生成的 16 位授权码（不是网页登录密码）。"},
    "126": {"label": "网易 126 邮箱", "imapHost": "imap.126.com", "imapPort": 993, "imapSecure": True,
            "smtpHost": "smtp.126.com", "smtpPort": 465, "smtpSecure": True,
            "note": "同样需要在网页版开启 IMAP/SMTP 服务，密码填授权码。"},
    "yeah": {"label": "网易 yeah.net", "imapHost": "imap.yeah.net", "imapPort": 993, "imapSecure": True,
             "smtpHost": "smtp.yeah.net", "smtpPort": 465, "smtpSecure": True,
             "note": "同样需要在网页版开启 IMAP/SMTP 服务，密码填授权码。"},
    "qq": {"label": "QQ 邮箱 / Foxmail", "imapHost": "imap.qq.com", "imapPort": 993, "imapSecure": True,
           "smtpHost": "smtp.qq.com", "smtpPort": 465, "smtpSecure": True,
           "note": "网页版「设置 → 账户 → IMAP/SMTP 服务」开启后生成授权码，密码填授权码。"},
    "exmail": {"label": "腾讯企业邮", "imapHost": "imap.exmail.qq.com", "imapPort": 993, "imapSecure": True,
               "smtpHost": "smtp.exmail.qq.com", "smtpPort": 465, "smtpSecure": True,
               "note": "使用企业邮账号密码或客户端专用密码。"},
    "gmail": {"label": "Gmail", "imapHost": "imap.gmail.com", "imapPort": 993, "imapSecure": True,
              "smtpHost": "smtp.gmail.com", "smtpPort": 465, "smtpSecure": True,
              "note": "需开启两步验证，并使用「应用专用密码」。在部分网络环境下需要代理才能连接。"},
    "outlook": {"label": "Outlook / Hotmail", "imapHost": "outlook.office365.com", "imapPort": 993, "imapSecure": True,
                "smtpHost": "smtp.office365.com", "smtpPort": 587, "smtpSecure": False,
                "note": "若开启了两步验证，请使用应用密码。"},
    "sina": {"label": "新浪邮箱", "imapHost": "imap.sina.com", "imapPort": 993, "imapSecure": True,
             "smtpHost": "smtp.sina.com", "smtpPort": 465, "smtpSecure": True,
             "note": "需在网页版开启 IMAP/SMTP 服务。"},
    "aliyun": {"label": "阿里云邮箱", "imapHost": "imap.aliyun.com", "imapPort": 993, "imapSecure": True,
               "smtpHost": "smtp.aliyun.com", "smtpPort": 465, "smtpSecure": True, "note": ""},
    "custom": {"label": "自定义 / 学校企业邮箱", "imapHost": "", "imapPort": 993, "imapSecure": True,
               "smtpHost": "", "smtpPort": 465, "smtpSecure": True,
               "note": "请向学校 / 单位信息中心索取 IMAP 与 SMTP 服务器地址及端口。"},
}


def get_provider(key: str | None) -> dict[str, Any]:
    return MAIL_PROVIDERS.get(str(key or ""), MAIL_PROVIDERS["custom"])


# ---------- 账户存储（mail.json） ----------
_LOCK = threading.RLock()          # ponytail: 一把全局锁；本地单人用，量级完全够。要并发再说。
_CONN: dict[str, dict[str, Any]] = {}      # account_id -> {conn, last}
CACHE_IDLE_S = 5 * 60


def _read_json() -> dict[str, Any]:
    try:
        return json.loads(MAIL_FILE.read_text(encoding="utf-8")) or {}
    except (OSError, ValueError):
        return {}


def _write_json(obj: dict[str, Any]) -> None:
    MAIL_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = MAIL_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(MAIL_FILE)


def list_mail_accounts() -> list[dict[str, Any]]:
    data = _read_json()
    items = data.get("accounts") if isinstance(data, dict) else None
    return [a for a in (items or []) if isinstance(a, dict) and a.get("id")]


def get_mail_account(account_id: str) -> dict[str, Any] | None:
    return next((a for a in list_mail_accounts() if a.get("id") == account_id), None)


def upsert_mail_account(acc: dict[str, Any]) -> dict[str, Any]:
    data = _read_json()
    items = [a for a in (data.get("accounts") or []) if isinstance(a, dict)]
    items = [a for a in items if a.get("id") != acc["id"]] + [acc]
    data["accounts"] = items
    _write_json(data)
    return acc


def delete_mail_account(account_id: str) -> None:
    data = _read_json()
    data["accounts"] = [a for a in (data.get("accounts") or []) if a.get("id") != account_id]
    _write_json(data)
    drop_connection(account_id)


def new_id() -> str:
    return uuid.uuid4().hex


def public_account(acc: dict[str, Any]) -> dict[str, Any]:
    out = {k: v for k, v in acc.items() if k != "password"}
    out["hasPassword"] = bool(acc.get("password"))
    return out


def normalize_account_input(body: dict[str, Any], base: dict[str, Any] | None = None) -> dict[str, Any]:
    """把前端提交的表单与预设服务商合并成完整账户对象（对齐 lit normalizeAccountInput）。"""
    base = base or {}
    provider = str(body.get("provider") or base.get("provider") or "163").strip() or "163"
    preset = get_provider(provider)
    email_addr = str(body.get("email") if body.get("email") is not None else base.get("email") or "").strip()
    pwd = base.get("password") or ""
    if body.get("password"):
        pwd = str(body["password"])

    def pick(key: str) -> Any:
        v = body.get(key, base.get(key))
        return v

    def or_(v: Any, default: Any) -> Any:
        return default if v is None or v == "" else v

    return {
        **base,
        "label": str(or_(body.get("label", base.get("label")), "") or "").strip() or email_addr,
        "displayName": str(or_(body.get("displayName", base.get("displayName")), "") or "").strip(),
        "email": email_addr,
        "password": pwd,
        "provider": provider,
        "imapHost": str(or_(pick("imapHost"), preset["imapHost"]) or "").strip(),
        "imapPort": int(or_(pick("imapPort"), preset["imapPort"]) or 993),
        "imapSecure": or_(pick("imapSecure"), preset["imapSecure"] is not False) is not False,
        "smtpHost": str(or_(pick("smtpHost"), preset["smtpHost"]) or "").strip(),
        "smtpPort": int(or_(pick("smtpPort"), preset["smtpPort"]) or 465),
        "smtpSecure": or_(pick("smtpSecure"), preset["smtpSecure"] is not False) is not False,
        "allowSelfSigned": bool(or_(pick("allowSelfSigned"), False)),
    }


def validate_account(acc: dict[str, Any]) -> str:
    if not acc.get("email") or not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", str(acc.get("email"))):
        return "请填写正确的邮箱地址"
    if not acc.get("password"):
        return "请填写授权码 / 密码"
    if not acc.get("imapHost"):
        return "请填写 IMAP 服务器地址（可在「服务商」处选择预设）"
    return ""


# ---------- 连接缓存 ----------
def _ssl_context(acc: dict[str, Any]) -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    if acc.get("allowSelfSigned"):
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _build_client(acc: dict[str, Any]) -> imaplib.IMAP4:
    host = str(acc.get("imapHost") or "")
    port = int(acc.get("imapPort") or 993)
    if acc.get("imapSecure", True):
        conn: imaplib.IMAP4 = imaplib.IMAP4_SSL(host, port, ssl_context=_ssl_context(acc), timeout=25)
    else:
        conn = imaplib.IMAP4(host, port, timeout=25)
    try:
        # 网易邮箱强制要求客户端先发 ID，否则返回「Unsafe Login」
        conn.xatom("ID", '("name" "SciTerminal" "version" "1.0.0" "vendor" "SciTerminal")')
    except Exception:
        pass
    conn.login(str(acc.get("email")), str(acc.get("password")))
    return conn


def open_client(acc: dict[str, Any]) -> imaplib.IMAP4:
    """取（或建）一个已登录的 IMAP 连接；调用方必须持有 _LOCK。"""
    aid = str(acc.get("id"))
    entry = _CONN.get(aid)
    if entry:
        try:
            entry["conn"].noop()
            entry["last"] = time.time()
            return entry["conn"]
        except Exception:
            drop_connection(aid)
    conn = _build_client(acc)
    _CONN[aid] = {"conn": conn, "last": time.time()}
    return conn


def drop_connection(account_id: str) -> None:
    entry = _CONN.pop(account_id, None)
    if not entry:
        return
    try:
        entry["conn"].logout()
    except Exception:
        try:
            entry["conn"].shutdown()
        except Exception:
            pass


def prune_connections() -> None:
    now = time.time()
    for aid in [k for k, v in _CONN.items() if now - v["last"] > CACHE_IDLE_S]:
        drop_connection(aid)


# ---------- 工具 ----------
def _decode_mutf7(name: str) -> str:
    """IMAP 的 modified UTF-7（中文文件夹名）→ 可读文本。"""
    out: list[str] = []
    i = 0
    while i < len(name):
        ch = name[i]
        if ch == "&":
            j = name.find("-", i)
            if j < 0:
                out.append(name[i:])
                break
            chunk = name[i + 1:j]
            if not chunk:
                out.append("&")
            else:
                b64 = chunk.replace(",", "/")
                b64 += "=" * (-len(b64) % 4)
                try:
                    out.append(base64.b64decode(b64).decode("utf-16-be", "replace"))
                except Exception:
                    out.append(chunk)
            i = j + 1
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _hdr(raw: Any) -> str:
    if raw is None:
        return ""
    try:
        return str(email.header.make_header(email.header.decode_header(str(raw))))
    except Exception:
        return str(raw)


def _quote(value: str) -> str:
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _as_bytes(x: Any) -> bytes:
    if isinstance(x, bytes):
        return x
    if isinstance(x, tuple):
        return b"".join(_as_bytes(i) for i in x if i is not None)
    return b""


def _imap_error(e: Exception) -> str:
    raw = str(e)
    low = raw.lower()
    if "unsafe login" in low:
        return "网易邮箱拒绝了本次登录：请先在邮箱网页版开启 IMAP/SMTP 服务，并确认密码填的是授权码"
    if any(k in low for k in ("auth", "login", "credential", "invalid user", "password", "authenticate")):
        return "登录失败：邮箱地址或授权码不正确（网易 / QQ 邮箱必须使用授权码，不是网页登录密码）"
    if any(k in low for k in ("certificate", "self signed", "verify failed", "altnames")):
        return "服务器证书校验失败：若是学校 / 企业自建邮箱，可在账户设置中勾选「忽略证书校验」"
    if isinstance(e, (socket.timeout, TimeoutError)):
        return "无法连接邮件服务器：连接超时，请检查网络、服务器地址与端口是否正确（" + raw + "）"
    if isinstance(e, (ConnectionError, socket.gaierror, OSError)) and not isinstance(e, imaplib.IMAP4.error):
        return "无法连接邮件服务器：请检查网络、服务器地址与端口是否正确（" + raw + "）"
    if any(k in low for k in ("nonexistent", "no such mailbox", "mailbox not found", "select failed")):
        return "该邮件文件夹不存在或已被重命名，请刷新文件夹列表"
    if any(k in low for k in ("too many", "rate", "limit", "frequency")):
        return "操作过于频繁，请稍后再试"
    return raw or "未知错误"


def describe_mail_error(e: Exception) -> str:
    return _imap_error(e)


def _folder_select(conn: imaplib.IMAP4, folder: str) -> int:
    typ, data = conn.select(_quote(folder or "INBOX"), readonly=False)
    if typ != "OK":
        raise imaplib.IMAP4.error(str(data[0] if data else "select failed"))
    try:
        return int(data[0])
    except (TypeError, ValueError):
        return 0


def _extract_headers(conn: imaplib.IMAP4, msgset: str, uid_mode: bool) -> dict[int, dict[str, str]]:
    """取 SUBJECT/FROM/TO/DATE 头（literal 形式，比解析 ENVELOPE 稳）。返回 {序号或uid: 头字典}"""
    cmd = "(BODY.PEEK[HEADER.FIELDS (SUBJECT FROM TO CC DATE)])"
    typ, data = (conn.uid("FETCH", msgset, cmd) if uid_mode else conn.fetch(msgset, cmd))
    out: dict[int, dict[str, str]] = {}
    if typ != "OK":
        return out
    for item in data:
        if not isinstance(item, tuple):
            continue
        head, raw = item[0], item[1]
        m = re.match(rb"(\d+)", _as_bytes(head))
        if not m or not raw:
            continue
        msg = email.message_from_bytes(raw)
        out[int(m.group(1))] = {
            "subject": _hdr(msg.get("Subject")) or "(无主题)",
            "fromName": _hdr(email.utils.parseaddr(_hdr(msg.get("From")))[0]),
            "fromAddress": email.utils.parseaddr(_hdr(msg.get("From")))[1],
            "to": _hdr(msg.get("To")),
            "date": email.utils.parsedate_to_datetime(msg.get("Date")).isoformat() if msg.get("Date") and email.utils.parsedate_to_datetime(msg.get("Date")) else None,
        }
    return out


def _extract_meta(conn: imaplib.IMAP4, msgset: str, uid_mode: bool) -> dict[int, dict[str, Any]]:
    """取 UID / FLAGS / RFC822.SIZE / BODYSTRUCTURE。"""
    typ, data = (conn.uid("FETCH", msgset, "(UID FLAGS RFC822.SIZE BODYSTRUCTURE)") if uid_mode
                 else conn.fetch(msgset, "(UID FLAGS RFC822.SIZE BODYSTRUCTURE)"))
    out: dict[int, dict[str, Any]] = {}
    if typ != "OK":
        return out
    for item in data:
        blob = _as_bytes(item)
        m = re.match(rb"(\d+)", blob)
        if not m:
            continue
        uid_m = re.search(rb"UID (\d+)", blob)
        flags_m = re.search(rb"FLAGS \(([^)]*)\)", blob)
        size_m = re.search(rb"RFC822\.SIZE (\d+)", blob)
        flags = flags_m.group(1).decode("ascii", "replace") if flags_m else ""
        bs = blob.upper()
        out[int(m.group(1))] = {
            "uid": int(uid_m.group(1)) if uid_m else 0,
            "seen": "\\SEEN" in flags.upper(),
            "flagged": "\\FLAGGED" in flags.upper(),
            "size": int(size_m.group(1)) if size_m else 0,
            # ponytail: BODYSTRUCTURE 只做子串判附件（lit 也是拿 bodystructure 递归判），要精确再上真解析器
            "hasAttachments": b"ATTACHMENT" in bs or b'"NAME"' in bs,
        }
    return out


# ---------- 对外能力 ----------
def test_account(acc: dict[str, Any]) -> dict[str, Any]:
    with _LOCK:
        conn = open_client(acc)
        exists = _folder_select(conn, "INBOX")
        typ, data = conn.list()
        folders = max(0, len(data or []) - 1) if typ == "OK" else 0
        return {"ok": True, "inboxMessages": exists, "folderCount": folders}


def list_folders(acc: dict[str, Any]) -> list[dict[str, Any]]:
    order = {"\\Inbox": 0, "\\Sent": 1, "\\Drafts": 2, "\\Trash": 3, "\\Junk": 4, "\\Archive": 5}
    with _LOCK:
        conn = open_client(acc)
        typ, data = conn.list()
    rows: list[dict[str, Any]] = []
    for raw in data or []:
        line = _as_bytes(raw).decode("utf-8", "replace")
        m = re.match(r'\((?P<flags>[^)]*)\)\s+(?P<delim>"[^"]*"|NIL)\s+(?P<name>.*)', line)
        if not m:
            continue
        flags = m.group("flags")
        name_raw = m.group("name").strip()
        if name_raw.startswith('"') and name_raw.endswith('"'):
            name_raw = name_raw[1:-1]
        if not name_raw:
            continue
        special = ""
        for flag in ("\\Sent", "\\Drafts", "\\Trash", "\\Junk", "\\Archive", "\\Inbox"):
            if flag in flags:
                special = flag
                break
        if not special and name_raw.lower() == "inbox":
            special = "\\Inbox"
        rows.append({"path": name_raw, "name": _decode_mutf7(name_raw), "specialUse": special, "flagCount": 0})
    rows.sort(key=lambda f: (order.get(f["specialUse"], 9), f["name"]))
    return rows


def list_messages(acc: dict[str, Any], folder: str = "INBOX", page: int = 1,
                  page_size: int = 30, search: str = "") -> dict[str, Any]:
    pg = max(1, int(page or 1))
    size = min(100, max(5, int(page_size or 30)))
    keyword = str(search or "").strip()
    with _LOCK:
        conn = open_client(acc)
        exists = _folder_select(conn, folder)
        if keyword:
            q = _quote(keyword)
            typ, data = conn.uid("SEARCH", "CHARSET", "UTF-8", "OR", "SUBJECT", q, "OR", "FROM", q, "TO", q)
            if typ != "OK":
                typ, data = conn.uid("SEARCH", "CHARSET", "UTF-8", "SUBJECT", q)
            uids = sorted((int(x) for x in _as_bytes(data[0] if data else b"").split()), reverse=True)
            slice_ = uids[(pg - 1) * size: pg * size]
            if not slice_:
                return {"folder": folder, "page": pg, "pageSize": size, "total": len(uids), "exists": exists, "messages": []}
            msgset = ",".join(str(u) for u in slice_)
            meta = _extract_meta(conn, msgset, uid_mode=True)
            heads = _extract_headers(conn, msgset, uid_mode=True)
            msgs = []
            for u in slice_:
                m = dict(meta.get(u) or {})
                h = dict(heads.get(u) or {})
                filled = {"uid": u, "subject": h.get("subject") or "(无主题)", "fromName": h.get("fromName", ""),
                          "fromAddress": h.get("fromAddress", ""), "to": h.get("to", ""), "date": h.get("date"),
                          "size": m.get("size", 0), "seen": m.get("seen", False), "flagged": m.get("flagged", False),
                          "hasAttachments": m.get("hasAttachments", False)}
                msgs.append(filled)
            msgs.sort(key=lambda x: -(x["uid"] or 0))
            return {"folder": folder, "page": pg, "pageSize": size, "total": len(uids), "exists": exists, "messages": msgs}

        if not exists:
            return {"folder": folder, "page": pg, "pageSize": size, "total": 0, "exists": 0, "messages": []}
        end = max(1, exists - (pg - 1) * size)
        start = max(1, end - size + 1)
        if end < start:
            return {"folder": folder, "page": pg, "pageSize": size, "total": exists, "exists": exists, "messages": []}
        msgset = f"{start}:{end}"
        meta = _extract_meta(conn, msgset, uid_mode=False)
        heads = _extract_headers(conn, msgset, uid_mode=False)
        seqs = sorted(meta.keys())
        msgs = []
        for seq in seqs:
            m = dict(meta.get(seq) or {})
            h = dict(heads.get(seq) or {})
            msgs.append({"uid": m.get("uid", 0), "subject": h.get("subject") or "(无主题)",
                         "fromName": h.get("fromName", ""), "fromAddress": h.get("fromAddress", ""),
                         "to": h.get("to", ""), "date": h.get("date"), "size": m.get("size", 0),
                         "seen": m.get("seen", False), "flagged": m.get("flagged", False),
                         "hasAttachments": m.get("hasAttachments", False)})
        msgs.reverse()
        return {"folder": folder, "page": pg, "pageSize": size, "total": exists, "exists": exists, "messages": msgs}


def peek_recent(acc: dict[str, Any], folder: str = "INBOX", limit: int = 10) -> dict[str, Any]:
    n = max(1, min(50, int(limit or 10)))
    with _LOCK:
        conn = open_client(acc)
        exists = _folder_select(conn, folder)
        if not exists:
            return {"folder": folder, "exists": 0, "unseen": 0, "latest": []}
        start = max(1, exists - n + 1)
        msgset = f"{start}:{exists}"
        meta = _extract_meta(conn, msgset, uid_mode=False)
        heads = _extract_headers(conn, msgset, uid_mode=False)
    latest = []
    for seq, m in meta.items():
        h = heads.get(seq) or {}
        latest.append({"uid": m.get("uid", 0), "subject": h.get("subject") or "(无主题)",
                       "fromName": h.get("fromName", ""), "fromAddress": h.get("fromAddress", ""),
                       "date": h.get("date"), "seen": m.get("seen", False)})
    latest.sort(key=lambda x: -(x["uid"] or 0))
    return {"folder": folder, "exists": exists, "unseen": len([m for m in latest if not m["seen"]]), "latest": latest}


def _fetch_raw(acc: dict[str, Any], folder: str, uid: str) -> bytes:
    with _LOCK:
        conn = open_client(acc)
        _folder_select(conn, folder)
        typ, data = conn.uid("FETCH", str(uid), "(RFC822)")
    if typ != "OK":
        raise imaplib.IMAP4.error("邮件不存在或已被删除")
    for item in data or []:
        raw = _as_bytes(item)
        if raw and b"RFC822" in raw[:200] or (isinstance(item, tuple) and item[1]):
            pass
        if isinstance(item, tuple) and len(item) > 1 and item[1]:
            return item[1]
    raise imaplib.IMAP4.error("邮件不存在或已被删除")


def _iter_attachments(msg: email.message.Message):
    idx = 0
    for part in msg.walk():
        if part.get_content_maintype() == "multipart":
            continue
        filename = part.get_filename()
        cid = part.get("Content-ID")
        disp = (part.get("Content-Disposition") or "").lower()
        if filename or "attachment" in disp:
            yield idx, part, _hdr(filename) if filename else f"附件{idx + 1}", cid
            idx += 1


def shape_message(raw: bytes, uid: str) -> dict[str, Any]:
    """把一封 RFC822 原始邮件整理成前端要的结构（正文 html/text、附件、内嵌图 cid→data URL）。"""
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    html, text = "", ""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_maintype() == "multipart":
                continue
            disp = (part.get("Content-Disposition") or "").lower()
            if part.get_filename() or "attachment" in disp:
                continue
            try:
                body = part.get_content()
            except Exception:
                payload = part.get_payload(decode=True) or b""
                body = payload.decode(part.get_content_charset() or "utf-8", "replace")
            if part.get_content_type() == "text/html" and not html:
                html = body
            elif part.get_content_type() == "text/plain" and not text:
                text = body
    else:
        try:
            body = msg.get_content()
        except Exception:
            body = (msg.get_payload(decode=True) or b"").decode(msg.get_content_charset() or "utf-8", "replace")
        if msg.get_content_type() == "text/html":
            html = body
        else:
            text = body

    attachments = []
    for idx, part, filename, cid in _iter_attachments(msg):
        payload = part.get_payload(decode=True) or b""
        attachments.append({"index": idx, "filename": filename,
                            "contentType": part.get_content_type() or "application/octet-stream",
                            "size": len(payload), "inline": bool(cid) or (part.get("Content-Disposition") or "").startswith("inline")})

    # 内嵌图片 cid: → data URL，正文里的图才显示得出来（同 lit）
    if html and attachments:
        for idx, part, filename, cid in _iter_attachments(msg):
            if not cid:
                continue
            payload = part.get_payload(decode=True) or b""
            if not payload or len(payload) > 2 * 1024 * 1024:
                continue
            cid_clean = str(cid).strip().strip("<>")
            data_url = "data:%s;base64,%s" % (part.get_content_type() or "image/png",
                                              base64.b64encode(payload).decode("ascii"))
            html = html.replace("cid:" + cid_clean, data_url)

    from_p = email.utils.parseaddr(_hdr(msg.get("From")))
    return {
        "uid": int(uid),
        "subject": _hdr(msg.get("Subject")) or "(无主题)",
        "fromName": from_p[0], "fromAddress": from_p[1],
        "to": _hdr(msg.get("To")), "cc": _hdr(msg.get("Cc")),
        "replyTo": email.utils.parseaddr(_hdr(msg.get("Reply-To")))[1],
        "date": email.utils.parsedate_to_datetime(msg.get("Date")).isoformat() if msg.get("Date") and email.utils.parsedate_to_datetime(msg.get("Date")) else None,
        "messageId": (msg.get("Message-ID") or "").strip(),
        "html": html, "text": text, "attachments": attachments, "size": len(raw),
    }


def get_message(acc: dict[str, Any], folder: str = "INBOX", uid: str = "") -> dict[str, Any]:
    if not uid:
        raise ValueError("缺少邮件编号")
    return shape_message(_fetch_raw(acc, folder, uid), uid)


def get_attachment(acc: dict[str, Any], folder: str = "INBOX", uid: str = "", index: int = 0) -> dict[str, Any]:
    raw = _fetch_raw(acc, folder, uid)
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    want = int(index or 0)
    for idx, part, filename, cid in _iter_attachments(msg):
        if idx == want:
            payload = part.get_payload(decode=True) or b""
            if not payload:
                raise ValueError("该附件不存在")
            return {"filename": filename, "contentType": part.get_content_type() or "application/octet-stream",
                    "content": payload}
    raise ValueError("该附件不存在")


def set_seen(acc: dict[str, Any], folder: str = "INBOX", uid: str = "", seen: bool = True) -> dict[str, Any]:
    with _LOCK:
        conn = open_client(acc)
        _folder_select(conn, folder)
        conn.uid("STORE", str(uid), "+FLAGS" if seen else "-FLAGS", "(\\Seen)")
    return {"ok": True, "seen": bool(seen)}


def mark_all_seen(acc: dict[str, Any], folder: str = "INBOX") -> dict[str, Any]:
    with _LOCK:
        conn = open_client(acc)
        _folder_select(conn, folder)
        typ, data = conn.uid("SEARCH", None, "UNSEEN")
        uids = [x for x in _as_bytes(data[0] if data else b"").split() if x.isdigit()]
        if uids:
            conn.uid("STORE", ",".join(u.decode() for u in uids), "+FLAGS", "(\\Seen)")
    return {"ok": True, "seen": True, "markedCount": len(uids)}


def delete_message(acc: dict[str, Any], folder: str = "INBOX", uid: str = "") -> dict[str, Any]:
    with _LOCK:
        conn = open_client(acc)
        _folder_select(conn, folder)
        conn.uid("STORE", str(uid), "+FLAGS", "(\\Deleted)")
        try:
            conn.expunge()
        except Exception:
            pass
    return {"ok": True}


def send_mail(acc: dict[str, Any], to: str = "", cc: str = "", subject: str = "",
              text: str = "", html: str = "") -> dict[str, Any]:
    if not acc.get("smtpHost"):
        raise ValueError("该账户未配置 SMTP 服务器，无法发信（可在邮箱管理中补填）")
    msg = EmailMessage()
    msg["From"] = f'"{acc.get("displayName")}" <{acc.get("email")}>' if acc.get("displayName") else str(acc.get("email"))
    msg["To"] = str(to or "").strip()
    if str(cc or "").strip():
        msg["Cc"] = str(cc).strip()
    msg["Subject"] = str(subject or "(无主题)")
    if text:
        msg.set_content(str(text))
    elif html:
        msg.set_content("（正文为 HTML，请用支持 HTML 的客户端查看）")
    if html:
        msg.add_alternative(str(html), subtype="html")

    host = str(acc.get("smtpHost"))
    port = int(acc.get("smtpPort") or 465)
    recipients = [x.strip() for x in re.split(r"[,;]", str(to or "") + "," + str(cc or "")) if x.strip()]
    if acc.get("smtpSecure", True):
        server = smtplib.SMTP_SSL(host, port, timeout=25, context=_ssl_context(acc))
    else:
        server = smtplib.SMTP(host, port, timeout=25)
        try:
            server.starttls(context=_ssl_context(acc))
        except smtplib.SMTPException:
            pass
    try:
        server.login(str(acc.get("email")), str(acc.get("password")))
        server.send_message(msg, from_addr=str(acc.get("email")), to_addrs=recipients)
    finally:
        try:
            server.quit()
        except Exception:
            pass
    return {"ok": True, "messageId": msg.get("Message-ID") or ""}
