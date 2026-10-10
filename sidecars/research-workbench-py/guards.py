"""两个后台闸门（自动跑，不需要人记着）。

1) 引用核验 —— 治「编造文献 / 编造内容」。
   做法：正文 + 引用台账 + 库里真有的文献，三样对账。编的引用过不去。
   思路参照 NVIDIA/NeMo-Guardrails 的 self-check rail、RAGAS 的 faithfulness 指标，
   但这里是**确定性对账**：不花模型钱，也不会被模型自己说服（它没法把假 DOI 说成真的）。

2) 出站脱敏 —— 治「信息泄露」。
   所有发往模型的 prompt 都过一遍 PII / 密钥规则（规则层照 microsoft/presidio 与
   protectai/llm-guard 的做法），命中就地打码并记账，不阻断你手里的活。

用法：由 workflow.py 挂钩（chat_raw 出站前 + 撰写流水线里），这里只放纯函数，方便单测。
"""
from __future__ import annotations

import re
import time

# ============================== 闸门 2：出站脱敏 ==============================
# ponytail: 只做规则层（这层就是 presidio/llm-guard 里最常用的那几条）。要人名/地址这类
# 上下文相关实体，才需要装 presidio + spacy NER 模型；本地单人科研工具先不背这 500MB。
RULES: list[tuple[str, re.Pattern]] = [
    ("手机号", re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")),
    ("身份证", re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)")),
    ("邮箱", re.compile(r"[\w.+-]{1,64}@[\w-]+(?:\.[\w-]+)+")),
    ("银行卡", re.compile(r"(?<!\d)(?:\d{4}[ -]?){3}\d{4}(?!\d)")),
    ("密钥", re.compile(r"\b(?:sk|rk|pk|ghp|gho|ghs|glpat|xox[baprs]|AKIA|AIza|hf_)[-_A-Za-z0-9]{16,}\b")),
    ("令牌", re.compile(r"\bBearer\s+[A-Za-z0-9._\-]{20,}")),
    ("私钥", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|\Z)")),
]

LOG_PATH = None          # 由 workflow.py 设成输出目录里的「隐私命中.log」；None = 只回传不落盘


def scrub_text(text: str) -> tuple[str, list[str]]:
    """把一段文本里的个人信息/密钥换成 «X已脱敏»，返回 (新文本, 命中的类型列表)。"""
    hits: list[str] = []
    for name, rx in RULES:
        text = rx.sub(lambda _m, n=name: (hits.append(n), f"«{n}已脱敏»")[1], text)
    return text, hits


def scrub(messages: list[dict], note: str = "") -> list[dict]:
    """出站闸门：就地把 messages 里的文本内容打码（原地改，调用方不用管返回值）。"""
    hits: list[str] = []
    for msg in messages or []:
        c = msg.get("content")
        if isinstance(c, str):
            new, h = scrub_text(c)
            if h:
                msg["content"] = new
                hits += h
    if hits:
        line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} 拦下 {len(hits)} 处：{', '.join(sorted(set(hits)))} {note}\n"
        if LOG_PATH:
            try:
                with open(LOG_PATH, "a", encoding="utf-8") as f:
                    f.write(line)
            except OSError:
                pass
    return hits


# ============================== 闸门 1：引用核验 ==============================
# 正文里不该出现的行内引用（用户的约定：引用全记台账，正文保持通顺）
INLINE = re.compile(
    r"\[\s*\d{1,3}\s*\]"                                                    # [1] [12]
    r"|\b[A-Z][a-zA-Z\-']{2,}(?:\s+(?:et\s+al\.?|and|&|[A-Z][a-zA-Z\-']{2,}))?(?:\s+[A-Z][a-zA-Z\-']{2,})?\s*[,，]\s*(?:19|20)\d{2}\b"   # (Smith et al., 2024)
)
# ponytail: 作者-年份这条是模糊规则，宁可误报（只进报告让审查看一眼），也不要漏掉编造的引用。


def _nz(s: object) -> str:
    """归一化：只留字母数字和汉字，用来做模糊匹配（DOI 大小写、连字符、空格差异都吃掉）。"""
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", str(s or "").lower())


def _lib_blobs(papers: list[dict]) -> tuple[str, set[str]]:
    """把库里已入库文献拼成一大坨可对账文本 + 一份 id 集合。"""
    ids, parts = set(), []
    for p in papers or []:
        ids.add(str(p.get("id") or ""))
        parts.append(" ".join(str(v) for v in p.values() if isinstance(v, str)))
    return _nz(" ".join(parts)), ids


def audit(draft: str, entries: list[dict], papers: list[dict], online: bool = False) -> dict:
    """逐条对账。返回 {"total","bad":[{code,where,what,msg}],"ok","inline"}。纯函数，不碰模型、不写文件。"""
    draft = draft or ""
    bad: list[dict] = []
    lines = draft.split("\n")

    for m in INLINE.finditer(draft):                                        # A. 正文里混进行内引用
        ln = draft[:m.start()].count("\n") + 1
        bad.append({"code": "INLINE", "where": f"正文 L{ln}", "what": m.group(0)[:44],
                    "msg": "正文里出现了行内引用（违反「引用只记台账、正文不插标号」的约定）→ 删掉它，改在台账里记一条"})

    blob, ids = _lib_blobs(papers)
    for i, e in enumerate(entries, 1):                                      # B/C/D. 台账条目
        tag = f"C{i}"
        title = (e.get("title") or "").strip()
        anchor = (e.get("anchor") or "").strip()
        doi, ntitle, pid = _nz(e.get("doi")), _nz(title), str(e.get("paper_id") or "").strip()

        if not anchor:
            bad.append({"code": "NOANCHOR", "where": tag, "what": title[:44],
                        "msg": "台账这条没给锚句（没法确认这处引用到底落在哪句上）"})
        elif anchor not in draft:
            bad.append({"code": "ANCHOR", "where": tag, "what": (title or anchor)[:44],
                        "msg": "锚句在正文里找不到 → 引用可能张冠李戴，或正文改过了没同步台账"})
            # 不 continue：失锚只是「对不上」，还要接着查它是不是编的（编造优先报）

        if pid and pid in ids:                                              # 库内 paper_id 对得上，够了
            continue

        if not (doi or ntitle or pid or e.get("url")):
            bad.append({"code": "NOSOURCE", "where": tag, "what": title[:44] or "（空条目）",
                        "msg": "这条引用没有任何可核对的落点（无 DOI、无链接、无 paper_id、无题名）→ 补上，否则算无据"})
            continue

        if doi and len(doi) > 8 and doi not in blob:
            msg = "DOI 在项目库里找不到对应文献 → 要么还没入库，要么这篇是编的"
            if online and not doi_resolves(e.get("doi")):
                msg = "DOI 在项目库里没有，且 Crossref 也查不到 → 高度疑似编造"
            bad.append({"code": "NOTINLIB", "where": tag, "what": f"{title[:30]} · DOI {e.get('doi')}", "msg": msg})
        elif ntitle and len(ntitle) > 6 and ntitle[:12] not in blob:
            bad.append({"code": "NOTINLIB", "where": tag, "what": title[:44],
                        "msg": "库里找不到这个题名（也可能是题名写法不同，人工确认一下这篇到底在不在库里）"})

    flagged = {b["where"] for b in bad if b["code"] != "INLINE"}          # 按条目去重，一条被报两次也只算一条
    return {"total": len(entries), "bad": bad, "ok": len(entries) - len(flagged),
            "inline": sum(1 for b in bad if b["code"] == "INLINE")}


def doi_resolves(doi: str, timeout: int = 3) -> bool:
    """联网核一次 DOI 是否真的存在（Crossref）。没网/超时返回 True = 不冤枉它，只降级不误杀。"""
    try:
        import json
        import urllib.request as u
        d = _nz(doi)
        req = u.Request(f"https://api.crossref.org/works/{doi}", headers={"User-Agent": "research-workbench/1.0"})
        with u.urlopen(req, timeout=timeout) as r:
            return bool(json.load(r).get("message", {}).get("DOI")) and d != ""
    except Exception:
        return True


def report(r: dict) -> str:
    """给人和给模型看的核验报告（有问题时落到项目里的「引用核验.md」）。"""
    head = f"# 引用核验\n\n> 机器对账：正文 + 引用台账 + 库内文献。台账 {r['total']} 条，对不上号 {len(r['bad'])} 条。\n\n"
    if not r["bad"]:
        return head + "全部对得上号。\n"
    body = "\n".join(f"- **{b['code']} · {b['where']}** {b['what']} —— {b['msg']}" for b in r["bad"])
    return head + body + "\n\n> 处置：ANCHOR/NOANCHOR 回正文把句子改回去或更新台账；NOTINLIB 要么把这篇文章入库，要么删掉这条引用；INLINE 把行内标号从正文里去掉。\n"


def audit_block(r: dict) -> str:
    """塞进审查 agent 的 system：把机器核出来的硬伤明明白白摆到它面前。"""
    if not r["bad"]:
        return "\n\n【机器核验（引用对账）】台账里的引用与库内文献全部对得上号。"
    lines = "\n".join(f"- {b['code']} · {b['where']}：{b['what']} → {b['msg']}" for b in r["bad"])
    return ("\n\n【机器核验（引用对账，这些是确定性检查出来的，必须逐条处理或说明为什么不动）】\n" + lines)
