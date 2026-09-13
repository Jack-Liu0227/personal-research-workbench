#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""literature-matrix 的本地可执行 helper（唯一源目录：.agents/skills/literature-matrix/scripts/）。

设计目标：把「主题 + 时间窗 + 来源集合」变成可核对、可复现、可失败但不能造假的机械操作。

  normalize  输入归一化（主题/时间窗/来源/语言/项目/输出目录/字段模板）
  plan       离线检索计划：每个来源的 URL、参数、限流与缓存策略（不发网络请求）
  search     可选多源检索：openalex / arxiv / europepmc / crossref（+ 工作台注入上下文）
  dedupe     DOI → PMID → arXiv → Zotero key →（标题+年份+第一作者）去重与合并
  extract    证据字段提取草稿（单元格带证据层级；缺口一律写「未报告」，绝不生成内容）
  verify     引用核验入口（离线比对本次记录；--online 才解析 DOI/PMID/arXiv）
  lint       校验最终 Markdown 正文是否符合 Artifact/Obsidian 投影合同
  self-test  离线自检：每一步都有确定性的夹具断言

硬边界（与 schema/contract.json 共同声明）：
* 只用 Python 标准库；不安装依赖，不改网络/代理配置。
* 网络默认关闭；只有显式 --online 才发请求；每源失败/限流/空结果都如实记录，绝不当作空结果。
* 不需要也不保存任何 API key；不读环境变量里的凭据，不发 Authorization 头，不读 ~/.pi。
* 不读 zotero.sqlite、不读 .obsidian/、不读 .env*、不读任意 *.sqlite（路径守卫硬拒绝）。
* 不写 Zotero/Obsidian/Vault/工作台数据库；只写 --cache-dir 与 --manifest-dir（默认在系统缓存目录）。
* 不伪造论文、引用、指标或覆盖范围；证据不足一律「未报告」或丢弃并计数。
* 许可证：项目自有（本仓库）。仅参考公开方案的设计模式（Apache-2.0/MIT/CC0/CC-BY），未复制第三方代码。
* 人工核验边界：所有输出带 humanReview，helper 结论必须由人核对后才能进入正文。

退出码：0 = ok/degraded/empty（空结果是合法结果）；1 = blocked；2 = failed。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

SKILL_KEY = "literature-matrix"
DIAG_PREFIX = "MATRIX"
CONTRACT_PATH = Path("schema") / "contract.json"
ENVELOPE_SCHEMA_VERSION = "1.0.0"
HTTP_TIMEOUT_SECONDS = 20
ABSTRACT_EXCERPT_CHARS = 600
USER_AGENT = "prw-literature-matrix/1.0.0 (+local research workbench; python-stdlib)"

STATUS_EXIT = {"ok": 0, "empty": 0, "degraded": 0, "blocked": 1, "failed": 2}


# ------------------------------------------------------------------ 诊断与信封


def diag(code, severity, message, source=None, next_step=None, detail=None):
    entry = {"code": code, "severity": severity, "message": message, "source": source, "nextStep": next_step}
    if detail is not None:
        entry["detail"] = detail
    return entry


def has_severity(diagnostics, severity):
    return any(item.get("severity") == severity for item in diagnostics)


def resolve_status(diagnostics, *, empty=False, degraded=False):
    if has_severity(diagnostics, "blocked"):
        return "blocked"
    if has_severity(diagnostics, "failed"):
        return "failed"
    if empty:
        return "empty"
    if degraded or has_severity(diagnostics, "warning"):
        return "degraded"
    return "ok"


def now_iso(now=None):
    if now:
        return now
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def human_review(contract, extra=None):
    spec = contract["humanVerification"]
    entry = {"required": spec["required"], "mustCheck": list(spec["mustCheck"]), "neverClaim": list(spec["neverClaim"])}
    if extra:
        entry["focus"] = extra
    return entry


def emit(envelope):
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:  # pragma: no cover
        pass
    sys.stdout.write(json.dumps(envelope, ensure_ascii=False, indent=2) + "\n")
    return STATUS_EXIT.get(envelope.get("status", "failed"), 2)


def make_envelope(command, status, *, data=None, diagnostics=None, coverage=None, inputs=None, network=None, review=None, now=None):
    return {
        "schemaVersion": ENVELOPE_SCHEMA_VERSION,
        "skillKey": SKILL_KEY,
        "command": command,
        "status": status,
        "generatedAt": now_iso(now),
        "inputs": inputs,
        "diagnostics": diagnostics or [],
        "coverage": coverage if coverage is not None else {},
        "network": network if network is not None else {"enabled": False, "requests": []},
        "humanReview": review if review is not None else {"required": True},
        "data": data if data is not None else {},
    }


# ------------------------------------------------------------------ 合同


class ContractError(Exception):
    def __init__(self, diagnostic):
        super().__init__(diagnostic["code"])
        self.diagnostic = diagnostic


def skill_root():
    return Path(__file__).resolve().parent.parent


def load_contract():
    root = skill_root()
    path = root / CONTRACT_PATH
    if root.name != SKILL_KEY:
        raise ContractError(diag("MATRIX_CONTRACT_MISPLACED", "blocked", f"helper 必须位于 {SKILL_KEY}/scripts/ 下，当前为 {root.name!r}", next_step="放回 <skill root>/scripts/，不要复制到第二个源目录"))
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ContractError(diag("MATRIX_CONTRACT_MISSING", "blocked", f"缺少合同文件 {CONTRACT_PATH.as_posix()}", next_step="恢复 skill 目录内的 schema/contract.json"))
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ContractError(diag("MATRIX_CONTRACT_INVALID", "blocked", f"合同文件无法解析：{error}", next_step="修复 schema/contract.json 的 JSON 语法"))
    if raw.get("skillKey") != SKILL_KEY or raw.get("diagnosticPrefix") != DIAG_PREFIX:
        raise ContractError(diag("MATRIX_CONTRACT_INVALID", "blocked", "合同文件的 skillKey/diagnosticPrefix 与本 helper 不匹配"))
    return raw


# ------------------------------------------------------------------ 路径守卫


FORBIDDEN_SUFFIXES = (".sqlite", ".sqlite3")
FORBIDDEN_NAMES = {"zotero.sqlite", "zotero.sqlite-journal"}


def guard_path(raw_path, *, purpose="read"):
    if raw_path in (None, ""):
        return None
    try:
        candidate = Path(str(raw_path)).expanduser()
    except Exception:
        return diag("MATRIX_FORBIDDEN_PATH", "blocked", f"无法识别的路径（{purpose}）")
    lowered = [part.lower() for part in candidate.parts]
    name = candidate.name.lower()
    if name in FORBIDDEN_NAMES or name.endswith(FORBIDDEN_SUFFIXES):
        return diag("MATRIX_FORBIDDEN_PATH", "blocked", f"拒绝访问 SQLite/Zotero 数据库（{purpose}）", next_step="改用工作台已有的 Zotero 能力/写入入口；本 helper 不读数据库文件")
    if ".obsidian" in lowered:
        return diag("MATRIX_FORBIDDEN_PATH", "blocked", f"拒绝访问 .obsidian/（{purpose}）", next_step="Vault 内容只由工作台投影层提供")
    if name.startswith(".env"):
        return diag("MATRIX_FORBIDDEN_PATH", "blocked", f"拒绝读取凭据类文件（{purpose}）：{name}", next_step="helper 不需要任何凭据")
    try:
        home = Path.home().resolve()
        resolved = candidate.resolve() if candidate.exists() else candidate
        pi_dir = (home / ".pi").resolve()
        if resolved == pi_dir or pi_dir in resolved.parents:
            return diag("MATRIX_FORBIDDEN_PATH", "blocked", f"拒绝访问 ~/.pi（{purpose}）", next_step="helper 不使用 Pi CLI/授权状态")
    except Exception:
        pass
    return None


def default_cache_dir(contract):
    name = contract.get("skillKey", SKILL_KEY)
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("TEMP") or "."
        return Path(base) / "prw-literature-cache" / name
    base = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(base) / "prw-literature-cache" / name


def safe_cache_dir(explicit, contract):
    if explicit:
        guard = guard_path(explicit, purpose="cache-dir")
        if guard:
            raise ContractError(guard)
        return Path(explicit).expanduser()
    return default_cache_dir(contract)


# ------------------------------------------------------------------ 输入归一化


def _coerce_int(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and re.fullmatch(r"\s*[+-]?\d+\s*", value):
        return int(value.strip())
    return None


def normalize_topic(value):
    if value is None:
        return None, diag("MATRIX_INPUT_TOPIC_MISSING", "blocked", "缺少主题：矩阵需要一个明确的主题才能检索", next_step="提供主题关键词")
    if not isinstance(value, str):
        return None, diag("MATRIX_INPUT_TOPIC_INVALID", "blocked", "主题必须是字符串")
    cleaned = re.sub(r"\s+", " ", value).strip()
    if cleaned == "":
        return None, diag("MATRIX_INPUT_TOPIC_MISSING", "blocked", "主题为空：矩阵需要一个明确的主题才能检索", next_step="提供主题关键词")
    if len(cleaned) > 200:
        return None, diag("MATRIX_INPUT_TOPIC_INVALID", "blocked", f"主题超过 200 字符（{len(cleaned)}）", next_step="缩短主题或拆成多个运行")
    return cleaned, None


def normalize_sources(value, contract):
    spec = contract["inputs"]["sources"]
    allowed = set(spec["allowed"])
    aliases = spec.get("aliases", {})
    if value in (None, ""):
        raw_items = []
    elif isinstance(value, str):
        raw_items = [part for part in re.split(r"[,\s;，]+", value) if part]
    elif isinstance(value, (list, tuple)):
        raw_items = list(value)
    else:
        return None, diag("MATRIX_INPUT_SOURCES_INVALID", "blocked", "sources 必须是列表或逗号分隔字符串", next_step="例如 --sources openalex,arxiv")
    resolved, unknown = [], []
    for item in raw_items:
        if not isinstance(item, str):
            unknown.append(repr(item))
            continue
        name = item.strip().lower()
        if name == "":
            continue
        if name in aliases:
            for expanded in aliases[name]:
                if expanded not in resolved:
                    resolved.append(expanded)
            continue
        if name not in allowed:
            unknown.append(name)
            continue
        if name not in resolved:
            resolved.append(name)
    if unknown:
        return None, diag("MATRIX_INPUT_SOURCES_INVALID", "blocked", f"未知来源名：{', '.join(sorted(set(unknown)))}", next_step=f"只接受 {', '.join(spec['allowed'])}（web 展开为四个网络来源）")
    if len(resolved) > spec["maxItems"]:
        return None, diag("MATRIX_INPUT_SOURCES_INVALID", "blocked", f"来源数量超过 {spec['maxItems']}")
    return resolved, None


def normalize_output_folder(value, contract):
    default = contract["inputs"]["outputFolder"]["default"]
    if value in (None, ""):
        return default, None
    if not isinstance(value, str):
        return None, diag("MATRIX_INPUT_OUTPUT_FOLDER_INVALID", "blocked", "outputFolder 必须是字符串")
    text = value.strip().replace("\\", "/")
    parts = [part for part in text.split("/") if part != ""]
    if text.startswith("/") or re.match(r"^[A-Za-z]:", text) or text.startswith("//"):
        return None, diag("MATRIX_INPUT_OUTPUT_FOLDER_INVALID", "blocked", "outputFolder 必须是 Vault 相对目录，不允许绝对路径/UNC", next_step="使用如 每日资讯推送/文献矩阵")
    reserved = {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1, 10)], *[f"LPT{i}" for i in range(1, 10)]}
    for part in parts:
        if part in ("..", "."):
            return None, diag("MATRIX_INPUT_OUTPUT_FOLDER_INVALID", "blocked", "outputFolder 不允许 .. 或 . 组件")
        if part.lower() == ".obsidian":
            return None, diag("MATRIX_INPUT_OUTPUT_FOLDER_INVALID", "blocked", "outputFolder 不得指向 .obsidian/")
        if part.split(".")[0].upper() in reserved:
            return None, diag("MATRIX_INPUT_OUTPUT_FOLDER_INVALID", "blocked", f"outputFolder 含 Windows 保留设备名：{part}")
        if any(ord(ch) < 32 for ch in part):
            return None, diag("MATRIX_INPUT_OUTPUT_FOLDER_INVALID", "blocked", "outputFolder 含控制字符")
    if len(text) > 200:
        return None, diag("MATRIX_INPUT_OUTPUT_FOLDER_INVALID", "blocked", "outputFolder 过长（>200 字符）")
    return "/".join(parts) or default, None


def normalize_field_template(value, contract):
    fields = contract["matrixFields"]
    required_ids = [field["id"] for field in fields["required"]]
    optional_ids = [field["id"] for field in fields["optional"]]
    if value in (None, {}):
        return {"columns": required_ids, "required": required_ids, "droppedOptional": optional_ids}, None
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as error:
            return None, diag("MATRIX_FIELD_TEMPLATE_INVALID", "blocked", f"fieldTemplate 不是合法 JSON：{error}")
    if not isinstance(value, dict):
        return None, diag("MATRIX_FIELD_TEMPLATE_INVALID", "blocked", "fieldTemplate 必须是对象")
    columns = value.get("columns", value.get("optional", []))
    if not isinstance(columns, list) or not all(isinstance(item, str) for item in columns):
        return None, diag("MATRIX_FIELD_TEMPLATE_INVALID", "blocked", "fieldTemplate.columns 必须是字符串列表")
    if "all" in columns:
        columns = required_ids + [item for item in optional_ids if item not in columns] + [item for item in columns if item != "all"]
    missing = [item for item in required_ids if item not in columns]
    if missing:
        return None, diag("MATRIX_FIELD_TEMPLATE_INVALID", "blocked", f"必填列不可删除：缺少 {', '.join(missing)}", next_step=f"必填列固定为 {', '.join(required_ids)}；只能增加/裁剪可选列")
    unknown = [item for item in columns if item not in required_ids + optional_ids]
    if unknown:
        return None, diag("MATRIX_FIELD_TEMPLATE_INVALID", "blocked", f"未知列：{', '.join(sorted(set(unknown)))}")
    if len(columns) > fields["maxColumns"]:
        return None, diag("MATRIX_FIELD_TEMPLATE_INVALID", "blocked", f"列数超过上限 {fields['maxColumns']}（收到 {len(columns)}）", next_step="超出的可选列并入「关键对比」小节")
    ordered = required_ids + [item for item in columns if item not in required_ids]
    return {"columns": ordered, "required": required_ids, "droppedOptional": [item for item in optional_ids if item not in ordered]}, None


def normalize_inputs(raw, contract, overrides=None):
    merged = dict(raw or {})
    for key, value in (overrides or {}).items():
        if value is not None:
            merged[key] = value
    diagnostics, inputs = [], {}
    topic, topic_diag = normalize_topic(merged.get("topic"))
    if topic_diag:
        diagnostics.append(topic_diag)
    inputs["topic"] = topic

    window_spec = contract["inputs"]["lookbackDays"]
    window = _coerce_int(merged.get("lookbackDays", window_spec["default"]))
    if window is None or window < window_spec["minimum"] or window > window_spec["maximum"]:
        diagnostics.append(diag("MATRIX_INPUT_WINDOW_INVALID", "blocked", f"lookbackDays 必须是 {window_spec['minimum']}..{window_spec['maximum']} 的整数，收到 {merged.get('lookbackDays')!r}", next_step="例如 --lookback-days 90"))
        window = None
    inputs["lookbackDays"] = window

    sources, sources_diag = normalize_sources(merged.get("sources"), contract)
    if sources_diag:
        diagnostics.append(sources_diag)
    inputs["sources"] = sources if sources is not None else []

    language_spec = contract["language"]
    language = merged.get("responseLanguage") or language_spec["default"]
    if language not in language_spec["allowed"]:
        diagnostics.append(diag("MATRIX_INPUT_LANGUAGE_INVALID", "blocked", f"responseLanguage 只接受 {', '.join(language_spec['allowed'])}，收到 {language!r}"))
        language = None
    inputs["responseLanguage"] = language

    folder, folder_diag = normalize_output_folder(merged.get("outputFolder"), contract)
    if folder_diag:
        diagnostics.append(folder_diag)
    inputs["outputFolder"] = folder

    project = merged.get("project")
    if project is not None and not isinstance(project, str):
        diagnostics.append(diag("MATRIX_INPUT_PROJECT_INVALID", "blocked", "project 必须是字符串或省略"))
        project = None
    if isinstance(project, str):
        project = project.strip() or None
        if project and len(project) > 120:
            diagnostics.append(diag("MATRIX_INPUT_PROJECT_INVALID", "blocked", "project 超过 120 字符"))
            project = None
    inputs["project"] = project

    template, template_diag = normalize_field_template(merged.get("fieldTemplate"), contract)
    if template_diag:
        diagnostics.append(template_diag)
    inputs["fieldTemplate"] = template
    inputs["unreportedToken"] = contract["evidence"]["cell"]["unreportedValue"]
    return inputs, diagnostics


def resolve_sources(requested, contract):
    """空列表 = 全部当前可用来源；返回 (sources, diagnostics)。"""
    available = [source["id"] for source in contract["sources"]]
    if not requested:
        return available, []
    resolved = [source for source in requested if source in available]
    return resolved, []


# ------------------------------------------------------------------ 标识符与记录

DOI_RE = re.compile(r"10\.\d{4,9}/[-._;()/:<>A-Za-z0-9]+")
PMID_RE = re.compile(r"\bPMID[:\s=]*(\d{6,9})\b", re.IGNORECASE)
ARXIV_RE = re.compile(r"\barXiv[:\s=]*((?:[a-z\-]+(?:\.[A-Z]{2})?/\d{7})|(?:\d{4}\.\d{4,5}))(?:v\d+)?", re.IGNORECASE)
ZOTERO_RE = re.compile(r"\bZotero[:\s=]*([A-Z0-9]{8})\b")


def norm_doi(value):
    if not isinstance(value, str) or not value.strip():
        return None
    text = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", value.strip(), flags=re.IGNORECASE)
    text = text.strip().rstrip(".,;)").lower()
    return text or None


def norm_pmid(value):
    if value in (None, ""):
        return None
    return re.sub(r"\D", "", str(value)) or None


def norm_arxiv(value):
    if not isinstance(value, str) or not value.strip():
        return None
    text = re.sub(r"^(?:https?://arxiv\.org/(?:abs|pdf)/|arxiv:\s*)", "", value.strip(), flags=re.IGNORECASE)
    text = re.sub(r"\.pdf$", "", text, flags=re.IGNORECASE)
    return re.sub(r"v\d+$", "", text, flags=re.IGNORECASE) or None


def norm_zotero(value):
    if not isinstance(value, str):
        return None
    text = value.strip().upper()
    return text if re.fullmatch(r"[A-Z0-9]{8}", text) else None


def weak_key(record):
    title_norm = re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", (record.get("title") or "").lower())
    if not title_norm:
        return None
    first_author = (record.get("authors") or [None])[0] or ""
    surname = re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", str(first_author).split(" ")[-1].lower()) if first_author else "unknown"
    year = record.get("year")
    return f"{title_norm}|{year if year is not None else 'unknown'}|{surname}"


def dedupe_key(record, order):
    ids = record.get("identifiers") or {}
    mapping = {"doi": ids.get("doi"), "pmid": ids.get("pmid"), "arxiv": ids.get("arxiv"), "zoteroKey": ids.get("zoteroKey"), "titleYearFirstAuthor": weak_key(record)}
    for key in order:
        if mapping.get(key):
            return key, mapping[key]
    return None, None


def identity_label(identifiers):
    parts = []
    for key, prefix in (("doi", "DOI:"), ("pmid", "PMID:"), ("pmcid", "PMCID:"), ("arxiv", "arXiv:"), ("zoteroKey", "Zotero:"), ("openalex", "OpenAlex:")):
        if identifiers.get(key):
            parts.append(f"{prefix}{identifiers[key]}")
    return " | ".join(parts) if parts else None


def identifiers_from_text(text):
    if not isinstance(text, str):
        return {}
    found = {}
    match = DOI_RE.search(text)
    if match:
        found["doi"] = norm_doi(match.group(0))
    match = PMID_RE.search(text)
    if match:
        found["pmid"] = norm_pmid(match.group(1))
    match = ARXIV_RE.search(text)
    if match:
        found["arxiv"] = norm_arxiv(match.group(1))
    match = ZOTERO_RE.search(text)
    if match:
        found["zoteroKey"] = norm_zotero(match.group(1))
    return {key: value for key, value in found.items() if value}


def reconstruct_abstract(inverted):
    if not isinstance(inverted, dict):
        return None
    pairs = [(position, word) for word, positions in inverted.items() if isinstance(positions, list) for position in positions if isinstance(position, int)]
    if not pairs:
        return None
    pairs.sort(key=lambda item: item[0])
    return " ".join(word for _, word in pairs)


def make_record(*, identifiers=None, title=None, authors=None, year=None, venue=None, source_type=None, abstract=None, url=None, source_id=None, source_record_id=None, metrics=None, fulltext=None, retrieved_at=None, extra=None):
    ids = {key: value for key, value in (identifiers or {}).items() if value}
    authors = [author for author in (authors or []) if author]
    has_abstract = isinstance(abstract, str) and abstract.strip() != ""
    record = {
        "identifiers": ids,
        "title": title.strip() if isinstance(title, str) and title.strip() else None,
        "authors": authors,
        "firstAuthor": authors[0] if authors else None,
        "year": year if isinstance(year, int) else None,
        "venue": venue or None,
        "sourceType": source_type or None,
        "abstract": abstract.strip() if has_abstract else None,
        "evidenceLevel": "abstract" if has_abstract else "metadata",
        "url": url or None,
        "sourceIds": [source_id] if source_id else [],
        "metrics": metrics if isinstance(metrics, dict) and metrics else None,
        "fulltext": fulltext if isinstance(fulltext, dict) else {"linkAvailable": False, "link": None, "checked": False, "note": "未取得来源的全文链接元数据"},
        "provenance": [{"source": source_id, "recordId": source_record_id, "retrievedAt": retrieved_at, "queryId": (extra or {}).get("queryId")}] if source_id else [],
        "mergedFrom": 1,
    }
    for key, value in (extra or {}).items():
        if key not in record:
            record[key] = value
    return record


def coerce_record(raw, source_id):
    if not isinstance(raw, dict):
        return None, "record-not-an-object"
    if "identifiers" in raw and "evidenceLevel" in raw:
        record = dict(raw)
        record.setdefault("identifiers", {})
        record.setdefault("sourceIds", [source_id] if source_id else [])
        record.setdefault("provenance", [])
        record.setdefault("mergedFrom", 1)
        record.setdefault("abstract", None)
        return record, None
    identifiers = {key: value for key, value in (raw.get("identifiers") or {}).items() if value}
    for key, normalizer in (("doi", norm_doi), ("pmid", norm_pmid), ("arxiv", norm_arxiv), ("zoteroKey", norm_zotero)):
        if not identifiers.get(key) and raw.get(key):
            identifiers[key] = normalizer(raw.get(key))
    if not identifiers.get("pmcid") and raw.get("pmcid"):
        identifiers["pmcid"] = norm_pmid(raw.get("pmcid"))
    identifiers = {key: value for key, value in identifiers.items() if value}
    authors_raw = raw.get("authors") or ([raw.get("author")] if raw.get("author") else [])
    authors = [author if isinstance(author, str) else json.dumps(author, ensure_ascii=False) for author in authors_raw]
    record = make_record(
        identifiers=identifiers,
        title=raw.get("title"),
        authors=authors,
        year=_coerce_int(raw.get("year")),
        venue=raw.get("venue") or raw.get("journal"),
        source_type=raw.get("type") or raw.get("itemType"),
        abstract=raw.get("abstract"),
        url=raw.get("url"),
        source_id=source_id or raw.get("source"),
        source_record_id=raw.get("id") or raw.get("itemKey"),
        metrics=raw.get("metrics"),
        fulltext=raw.get("fulltext") if isinstance(raw.get("fulltext"), dict) else None,
        retrieved_at=raw.get("retrievedAt"),
        extra={"queryId": raw.get("queryId")},
    )
    if not record["abstract"] and raw.get("abstractInvertedIndex"):
        record["abstract"] = reconstruct_abstract(raw["abstractInvertedIndex"])
        record["evidenceLevel"] = "abstract" if record["abstract"] else "metadata"
    return record, None


# ------------------------------------------------------------------ 来源适配器


def source_by_id(contract, source_id):
    for source in contract["sources"]:
        if source["id"] == source_id:
            return source
    return None


def day_offset(lookback_days, now=None):
    base = datetime.fromisoformat(now_iso(now).replace("Z", "+00:00")) if now else datetime.now(timezone.utc)
    return (base - timedelta(days=int(lookback_days))).date().isoformat()


def build_plan(source, query, *, lookback_days, limit, contact_email, now=None):
    sid = source["id"]
    if source["kind"] != "network":
        return {"id": sid, "kind": source["kind"], "label": source["label"], "status": "context-required", "url": None, "params": None, "requires": "--context <本次运行注入的文献上下文 JSON>", "notes": source["notes"]}
    start, today = day_offset(lookback_days, now), day_offset(0, now)
    if sid == "openalex":
        params = {"search": query, "per-page": str(min(limit, 200)), "filter": f"from_publication_date:{start}", "sort": "publication_date:desc"}
        if contact_email:
            params["mailto"] = contact_email
    elif sid == "arxiv":
        params = {"search_query": f'all:"{query}"', "start": "0", "max_results": str(min(limit, 100)), "sortBy": "submittedDate", "sortOrder": "descending"}
    elif sid == "europepmc":
        params = {"query": f'("{query}") AND (FIRST_PDATE:[{start} TO {today}])', "format": "json", "pageSize": str(min(limit, 100)), "resultType": "core"}
    elif sid == "crossref":
        params = {"query.bibliographic": query, "filter": f"from-pub-date:{start}", "rows": str(min(limit, 100)), "sort": "published", "order": "desc"}
        if contact_email:
            params["mailto"] = contact_email
    else:
        return {"id": sid, "kind": source["kind"], "label": source["label"], "status": "unavailable", "url": None, "params": None, "notes": "未实现的来源"}
    return {"id": sid, "kind": "network", "label": source["label"], "status": "planned", "url": source["baseUrl"], "params": params,
            "headers": {"User-Agent": USER_AGENT}, "minIntervalSeconds": source["minIntervalSeconds"], "cacheTtlSeconds": source["cacheTtlSeconds"],
            "auth": source["auth"], "keyless": True, "notes": source["notes"]}


def cache_paths(cache_dir, source_id, url, params):
    canonical = json.dumps({"url": url, "params": params}, ensure_ascii=False, sort_keys=True)
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    folder = Path(cache_dir) / source_id
    return folder, folder / f"{digest}.json", folder / f"{digest}.meta.json"


def cache_read(cache_dir, source_id, url, params, ttl, *, no_cache=False):
    _, body_path, meta_path = cache_paths(cache_dir, source_id, url, params)
    if no_cache or not body_path.exists() or not meta_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        fetched_at = datetime.fromisoformat(str(meta["fetchedAt"]).replace("Z", "+00:00"))
    except Exception:
        return None
    if ttl and (datetime.now(timezone.utc) - fetched_at).total_seconds() > ttl:
        return None
    try:
        return json.loads(body_path.read_text(encoding="utf-8")), meta
    except Exception:
        return None


def cache_write(cache_dir, source_id, url, params, payload, meta_extra):
    folder, body_path, meta_path = cache_paths(cache_dir, source_id, url, params)
    folder.mkdir(parents=True, exist_ok=True)
    fetched_at = now_iso()
    body_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    meta_path.write_text(json.dumps({"source": source_id, "url": url, "params": params, "fetchedAt": fetched_at, "license": "public API response", **meta_extra}, ensure_ascii=False, indent=2), encoding="utf-8")
    return fetched_at


def http_fetch(url, params, headers, *, timeout=HTTP_TIMEOUT_SECONDS):
    query = urllib.parse.urlencode(params, doseq=True, safe=':[]')
    full_url = f"{url}?{query}" if query else url
    request = urllib.request.Request(full_url, headers=headers, method="GET")
    started = time.time()
    def elapsed():
        return int((time.time() - started) * 1000)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - 公开 API，无凭据
            body = response.read().decode("utf-8", errors="replace")
            return {"ok": True, "status": response.status, "body": body, "url": full_url, "ms": elapsed(), "retryAfter": response.headers.get("Retry-After")}
    except urllib.error.HTTPError as error:
        try:
            body = error.read().decode("utf-8", errors="replace")
        except Exception:
            body = ""
        return {"ok": False, "status": error.code, "body": body, "url": full_url, "ms": elapsed(), "retryAfter": error.headers.get("Retry-After") if error.headers else None, "error": f"HTTP {error.code}"}
    except urllib.error.URLError as error:
        return {"ok": False, "status": None, "body": "", "url": full_url, "ms": elapsed(), "error": f"URLError: {error.reason}"}
    except TimeoutError:
        return {"ok": False, "status": None, "body": "", "url": full_url, "ms": elapsed(), "error": "timeout"}
    except Exception as error:  # pragma: no cover - 防御性
        return {"ok": False, "status": None, "body": "", "url": full_url, "ms": elapsed(), "error": f"{type(error).__name__}: {error}"}


def http_status_diagnostic(source_id, result):
    status = result.get("status")
    if status == 429:
        return diag("MATRIX_SOURCE_RATE_LIMITED", "warning", f"{source_id} 返回 429（限流）；本次未取得该来源数据", source=source_id, next_step="等待后重试；arXiv 要求同一连接请求间隔 ≥3s", detail=result.get("url"))
    if status in (401, 403):
        return diag("MATRIX_PERMISSION_DENIED", "failed", f"{source_id} 返回 {status}（访问被拒）", source=source_id, next_step="检查网络代理与来源访问策略；本 helper 不使用任何密钥", detail=result.get("url"))
    if status == 400:
        return diag("MATRIX_SOURCE_REQUEST_INVALID", "warning", f"{source_id} 返回 400（请求参数被拒）：{str(result.get('body'))[:160]}", source=source_id, next_step="检查检索式与过滤参数", detail=result.get("url"))
    if status is None:
        return diag("MATRIX_SOURCE_FAILED", "warning", f"{source_id} 网络请求失败：{result.get('error')}", source=source_id, next_step="确认网络可用后重试，或改为离线使用 --context", detail=result.get("url"))
    if status and status >= 500:
        return diag("MATRIX_SOURCE_FAILED", "warning", f"{source_id} 返回 {status}（服务端错误）", source=source_id, next_step="稍后重试；不要把失败当成空结果", detail=result.get("url"))
    return diag("MATRIX_SOURCE_FAILED", "warning", f"{source_id} 请求失败：{result.get('error') or status}", source=source_id, next_step="检查网络与参数后重试", detail=result.get("url"))


def parse_openalex(payload, retrieved_at):
    records = []
    for item in (payload or {}).get("results") or []:
        ids = item.get("ids") or {}
        best_oa = item.get("best_oa_location") or {}
        location = item.get("primary_location") or {}
        pdf_link = best_oa.get("pdf_url") or location.get("pdf_url")
        is_oa = bool((item.get("open_access") or {}).get("is_oa")) and bool(pdf_link)
        records.append(make_record(
            identifiers={"openalex": (item.get("id") or "").rsplit("/", 1)[-1] or None, "doi": norm_doi(item.get("doi") or ids.get("doi")),
                         "pmid": norm_pmid(ids.get("pmid")), "pmcid": norm_pmid(ids.get("pmcid")) if ids.get("pmcid") else None},
            title=item.get("title") or item.get("display_name"),
            authors=[(authorship.get("author") or {}).get("display_name") for authorship in (item.get("authorships") or [])[:12]],
            year=_coerce_int(item.get("publication_year")),
            venue=(location.get("source") or {}).get("display_name"),
            source_type=item.get("type"),
            abstract=reconstruct_abstract(item.get("abstract_inverted_index")),
            url=location.get("landing_page_url") or item.get("id"),
            source_id="openalex", source_record_id=item.get("id"),
            metrics={"citedByCount": item.get("cited_by_count")} if isinstance(item.get("cited_by_count"), int) else None,
            fulltext={"linkAvailable": is_oa, "link": pdf_link, "checked": False, "source": "openalex", "note": "按来源 OA 元数据标记，未下载全文"},
            retrieved_at=retrieved_at))
    return records


def parse_europepmc(payload, retrieved_at):
    records = []
    for item in ((payload or {}).get("resultList") or {}).get("result") or []:
        url_list = ((item.get("fullTextUrlList") or {}).get("fullTextUrl")) or []
        urls = [entry.get("url") for entry in url_list if isinstance(entry, dict) and entry.get("url")]
        link_available = str(item.get("isOpenAccess", "")).upper() == "Y" and bool(item.get("pmcid") or item.get("inEPMC") == "Y" or item.get("hasPDF") == "Y")
        authors = [part.strip() for part in (item.get("authorString") or "").rstrip(".").split(",") if part.strip()]
        records.append(make_record(
            identifiers={"doi": norm_doi(item.get("doi")), "pmid": norm_pmid(item.get("pmid")),
                         "pmcid": norm_pmid(item.get("pmcid")) if item.get("pmcid") else None, "europepmc": item.get("id") or None},
            title=(item.get("title") or "").rstrip("."), authors=authors, year=_coerce_int(item.get("pubYear")),
            venue=item.get("journalTitle") or (item.get("bookOrReportDetails") or {}).get("publisher"),
            source_type=((item.get("pubTypeList") or {}).get("pubType") or [None])[0],
            abstract=item.get("abstractText"),
            url=f"https://europepmc.org/article/{item.get('source')}/{item.get('id')}" if item.get("source") and item.get("id") else None,
            source_id="europepmc", source_record_id=item.get("id"),
            metrics={"citedByCount": item.get("citedByCount")} if isinstance(item.get("citedByCount"), int) else None,
            fulltext={"linkAvailable": link_available, "link": urls[0] if urls else None, "checked": False, "source": "europepmc", "note": "按 PMC/OA 元数据标记，未下载全文"},
            retrieved_at=retrieved_at))
    return records


def parse_crossref(payload, retrieved_at):
    records = []
    for item in ((payload or {}).get("message") or {}).get("items") or []:
        issued = ((item.get("issued") or {}).get("date-parts") or [[None]])[0]
        authors = []
        for author in (item.get("author") or [])[:12]:
            if not isinstance(author, dict):
                continue
            name = " ".join(part for part in [author.get("given"), author.get("family")] if part) or author.get("name")
            if name:
                authors.append(name)
        pdf_link = next((link.get("URL") for link in (item.get("link") or []) if isinstance(link, dict) and "pdf" in str(link.get("content-type", "")).lower()), None)
        abstract = item.get("abstract")
        if isinstance(abstract, str):
            abstract = re.sub(r"^(?:Abstract|ABSTRACT)[:\s]*", "", re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", abstract)).strip()).strip()
        doi = norm_doi(item.get("DOI"))
        records.append(make_record(
            identifiers={"doi": doi},
            title=(item.get("title") or [None])[0], authors=authors, year=_coerce_int(issued[0] if issued else None),
            venue=(item.get("container-title") or [None])[0], source_type=item.get("type"), abstract=abstract or None,
            url=item.get("URL") or (f"https://doi.org/{doi}" if doi else None),
            source_id="crossref", source_record_id=item.get("DOI"),
            metrics={"citedByCount": item.get("is-referenced-by-count")} if isinstance(item.get("is-referenced-by-count"), int) else None,
            fulltext={"linkAvailable": bool(pdf_link), "link": pdf_link, "checked": False, "source": "crossref", "note": "仅链接元数据，未下载全文"},
            retrieved_at=retrieved_at))
    return records


def parse_arxiv(payload, retrieved_at):
    records = []
    text = payload if isinstance(payload, str) else json.dumps(payload or {})
    for entry in re.findall(r"<entry>([\s\S]*?)</entry>", text):
        def tag(name):
            match = re.search(fr"<{name}[^>]*>([\s\S]*?)</{name}>", entry)
            return re.sub(r"\s+", " ", match.group(1)).strip() if match else None

        raw_id = tag("id") or ""
        arxiv_id = norm_arxiv(raw_id)
        published = tag("published") or ""
        primary = re.search(r'<arxiv:primary_category[^>]*term="([^"]+)"', entry)
        records.append(make_record(
            identifiers={"arxiv": arxiv_id, "doi": norm_doi(tag("arxiv:doi"))},
            title=tag("title"),
            authors=[re.sub(r"\s+", " ", author).strip() for author in re.findall(r"<author>\s*<name>([\s\S]*?)</name>", entry)],
            year=_coerce_int(published[:4]) if published[:4].isdigit() else None,
            venue=tag("arxiv:journal_ref") or "arXiv (preprint)", source_type="preprint", abstract=tag("summary"),
            url=f"https://arxiv.org/abs/{arxiv_id}" if arxiv_id else (raw_id or None),
            source_id="arxiv", source_record_id=arxiv_id,
            fulltext={"linkAvailable": bool(arxiv_id), "link": f"https://arxiv.org/pdf/{arxiv_id}" if arxiv_id else None, "checked": False, "source": "arxiv", "note": "Atom 条目只提供摘要；PDF 链接存在但未下载"},
            retrieved_at=retrieved_at, extra={"arxivCategory": primary.group(1) if primary else None}))
    return records


def parse_payload(source_id, payload, retrieved_at):
    parsers = {"openalex": parse_openalex, "arxiv": parse_arxiv, "europepmc": parse_europepmc, "crossref": parse_crossref}
    parser = parsers.get(source_id)
    return parser(payload, retrieved_at) if parser else []


def load_context(path):
    guard = guard_path(path, purpose="context")
    if guard:
        raise ContractError(guard)
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        return payload.get("records") or []
    return payload if isinstance(payload, list) else []


# ------------------------------------------------------------------ 多源检索


def run_search(plan, *, contract, cache_dir, online, no_cache, timeout, context_records, now=None):
    records, requests, diagnostics = [], [], []
    coverage = {"requested": [], "used": [], "degraded": [], "unavailable": [], "failed": [], "skippedOffline": []}
    for source in plan:
        sid = source["id"]
        coverage["requested"].append(sid)
        if source["kind"] != "network":
            provided = [raw for raw in context_records if sid in (raw.get("sourceIds") or []) or raw.get("source") == sid]
            if provided:
                records.extend(provided)
                coverage["used"].append(sid)
            else:
                coverage["unavailable"].append(sid)
                diagnostics.append(diag("MATRIX_SOURCE_CONTEXT_MISSING", "warning", f"{sid} 需要本次运行注入的上下文（--context）；未提供，不计入覆盖", source=sid, next_step="由工作台注入被选中的文献，或从来源集合中移除该来源"))
            continue
        if not online:
            coverage["skippedOffline"].append(sid)
            diagnostics.append(diag("MATRIX_NETWORK_DISABLED", "info", f"{sid} 未检索：网络默认关闭（未传 --online）", source=sid, next_step="如需联网检索加 --online；离线时用 --context 注入文献"))
            continue
        source_spec = source_by_id(contract, sid)
        ttl = source_spec["cacheTtlSeconds"] if source_spec else 86400
        cached = cache_read(cache_dir, sid, source["url"], source["params"], ttl, no_cache=no_cache)
        if cached:
            payload, meta = cached
            requests.append({"source": sid, "url": meta.get("url"), "status": "cached", "httpStatus": meta.get("httpStatus"), "cached": True, "ms": 0})
            retrieved_at = meta.get("fetchedAt")
        else:
            result = http_fetch(source["url"], source["params"], source["headers"], timeout=timeout)
            requests.append({"source": sid, "url": source["url"], "status": "ok" if result["ok"] else "failed", "httpStatus": result.get("status"), "cached": False, "ms": result.get("ms"), "error": result.get("error")})
            if not result["ok"]:
                diagnostic = http_status_diagnostic(sid, result)
                diagnostics.append(diagnostic)
                (coverage["failed"] if diagnostic["severity"] == "failed" else coverage["degraded"]).append(sid)
                continue
            if sid == "arxiv":
                payload = result["body"]
            else:
                try:
                    payload = json.loads(result["body"])
                except json.JSONDecodeError as error:
                    diagnostics.append(diag("MATRIX_SOURCE_FAILED", "warning", f"{sid} 返回无法解析的响应：{error}", source=sid, next_step="稍后重试"))
                    coverage["degraded"].append(sid)
                    continue
            try:
                retrieved_at = cache_write(cache_dir, sid, source["url"], source["params"], payload, {"httpStatus": result.get("status"), "bytes": len(result["body"])})
            except OSError as error:
                diagnostics.append(diag("MATRIX_CACHE_UNAVAILABLE", "failed", f"无法写入缓存目录：{error}", source=sid, next_step="检查 --cache-dir 是否存在且可写"))
                coverage["failed"].append(sid)
                continue
        parsed = parse_payload(sid, payload, retrieved_at)
        if parsed:
            coverage["used"].append(sid)
        else:
            coverage["degraded"].append(sid)
            diagnostics.append(diag("MATRIX_SOURCE_DEGRADED", "warning", f"{sid} 在本次时间窗/检索式内返回 0 条", source=sid, next_step="放宽时间窗或检索式；不要把它记成有结果"))
        records.extend(parsed)
    coverage["coverageComplete"] = bool(coverage["requested"]) and not (coverage["degraded"] or coverage["unavailable"] or coverage["failed"] or coverage["skippedOffline"])
    coverage["statement"] = "本次为完整覆盖（所有请求来源均返回可用数据）；仍受各来源索引范围与检索式限制。" if coverage["coverageComplete"] else "本次为部分覆盖：结论只代表已覆盖来源，未覆盖/失败/跳过部分已在上表列出，不得写成完整覆盖。"
    if not records and online and not has_severity(diagnostics, "blocked") and not has_severity(diagnostics, "failed"):
        diagnostics.append(diag("MATRIX_EMPTY_RESULT", "info", "本次时间窗与来源内未检索到匹配文献（合法结果，不是错误）", next_step="放宽时间窗/检索式或增加来源后重试；不要写成领域性结论"))
    return records, coverage, diagnostics, requests


def collect_records(payload, *, context_records=None, contract=None, source_ids=None):
    """把 --records / --context 的多种形状归一为规范记录列表。"""
    records, problems = [], []
    if isinstance(payload, dict):
        raw_records = payload.get("records") or payload.get("results") or []
    else:
        raw_records = payload or []
    for raw in raw_records:
        source_id = raw.get("source") if isinstance(raw, dict) else None
        if source_id is None and isinstance(raw, dict):
            source_ids = raw.get("sourceIds") or []
            source_id = source_ids[0] if source_ids else None
        record, problem = coerce_record(raw, source_id)
        if problem:
            problems.append(problem)
            continue
        records.append(record)
    return records, problems


# ------------------------------------------------------------------ 去重


def dedupe_records(records, contract):
    order = contract["dedupe"]["order"]
    merged, index, duplicates, dropped = [], {}, [], []
    for record in records:
        key_name, key_value = dedupe_key(record, order)
        if key_name is None:
            dropped.append({"reason": contract["dedupe"]["dropReason"], "record": {"title": record.get("title"), "year": record.get("year"), "sourceIds": record.get("sourceIds")}})
            continue
        bucket = f"{key_name}:{key_value}"
        if bucket not in index:
            index[bucket] = len(merged)
            merged.append(record)
            continue
        kept = merged[index[bucket]]
        for field in ("title", "venue", "sourceType", "abstract", "url", "year"):
            if not kept.get(field) and record.get(field):
                kept[field] = record[field]
        if not kept.get("authors") and record.get("authors"):
            kept["authors"], kept["firstAuthor"] = record["authors"], record["firstAuthor"]
        for identifier, value in (record.get("identifiers") or {}).items():
            if value and not kept["identifiers"].get(identifier):
                kept["identifiers"][identifier] = value
        kept["sourceIds"] = sorted(set(kept.get("sourceIds", [])) | set(record.get("sourceIds", [])))
        kept["provenance"] = (kept.get("provenance") or []) + (record.get("provenance") or [])
        if not kept.get("metrics") and record.get("metrics"):
            kept["metrics"] = record["metrics"]
        if record.get("evidenceLevel") == "abstract" and kept.get("evidenceLevel") == "metadata":
            kept["evidenceLevel"] = "abstract"
        if (record.get("fulltext") or {}).get("linkAvailable") and not (kept.get("fulltext") or {}).get("linkAvailable"):
            kept["fulltext"] = record["fulltext"]
        kept["mergedFrom"] = int(kept.get("mergedFrom", 1)) + 1
        duplicates.append({"mergedInto": identity_label(kept["identifiers"]), "matchedOn": key_name, "duplicate": {"identifiers": record.get("identifiers"), "title": record.get("title"), "sourceIds": record.get("sourceIds")}})
    return {"records": merged, "duplicates": duplicates, "dropped": dropped}


# ------------------------------------------------------------------ 证据字段提取草稿


def evidence_label(record):
    return "摘要" if record.get("evidenceLevel") == "abstract" else "元数据"


def unreported_cell(field_id, guidance=None):
    entry = {"field": field_id, "value": "未报告", "status": "unreported", "evidence": None}
    if guidance:
        entry["guidance"] = guidance
    return entry


def reported_cell(field_id, value, evidence, guidance=None, status="reported"):
    entry = {"field": field_id, "value": value, "status": status, "evidence": evidence}
    if guidance:
        entry["guidance"] = guidance
    return entry


def extract_rows(dedupe_result, inputs, contract):
    definitions = {field["id"]: field for field in contract["matrixFields"]["required"] + contract["matrixFields"]["optional"]}
    columns = (inputs.get("fieldTemplate") or {}).get("columns") or list(definitions.keys())
    rows = []
    for record in dedupe_result["records"]:
        identity = identity_label(record["identifiers"])
        if not identity:
            continue
        cells = {}
        for column in columns:
            definition = definitions[column]
            guidance = definition.get("guidance")
            if column == "identifier":
                cells[column] = reported_cell(column, identity, "元数据")
            elif column == "title":
                cells[column] = reported_cell(column, record["title"], "元数据") if record.get("title") else unreported_cell(column, guidance)
            elif column == "authorYear":
                if record.get("firstAuthor") or record.get("year") is not None:
                    author = record.get("firstAuthor") or "未报告"
                    year = record.get("year") if record.get("year") is not None else "未报告"
                    cells[column] = reported_cell(column, f"{author} · {year}", "元数据")
                else:
                    cells[column] = unreported_cell(column, guidance)
            elif column == "venue":
                value = record.get("venue") or (f"来源标识：{', '.join(record.get('sourceIds') or [])}" if record.get("sourceIds") else None)
                cells[column] = reported_cell(column, value, "元数据") if value else unreported_cell(column, guidance)
            elif column == "studyType":
                cells[column] = reported_cell(column, record["sourceType"], "元数据", "来源类型字段，不是作者自述；原文自述优先，必要时由人改写并保留来源", status="derived") if record.get("sourceType") else unreported_cell(column, guidance)
            elif column == "projectClass":
                project = inputs.get("project")
                cells[column] = reported_cell(column, project or "未分类", None, "来自本次注入的项目上下文" if project else "本次运行未注入项目上下文，按合同写「未分类」", status="derived")
            elif column == "links":
                link = (record.get("fulltext") or {}).get("link") or record.get("url")
                cells[column] = reported_cell(column, link, "元数据") if link else unreported_cell(column, guidance)
            elif column == "citationImpact":
                metrics = record.get("metrics") or {}
                if isinstance(metrics.get("citedByCount"), int):
                    cells[column] = reported_cell(column, f"{metrics['citedByCount']}（来源：{', '.join(record.get('sourceIds') or []) or '未报告'}）", "元数据")
                else:
                    cells[column] = unreported_cell(column, "来源未报告引用计数；不得估算")
            else:
                cells[column] = unreported_cell(column, guidance or "需要由人/模型阅读本次摘要或全文后填写，并标注证据层级")
        abstract = record.get("abstract")
        excerpt = abstract[:ABSTRACT_EXCERPT_CHARS] if isinstance(abstract, str) and abstract else None
        rows.append({
            "identity": identity,
            "identifiers": record["identifiers"],
            "cells": cells,
            "abstractExcerpt": {"text": excerpt, "truncated": bool(abstract and len(abstract) > ABSTRACT_EXCERPT_CHARS), "evidenceLevel": record.get("evidenceLevel")} if excerpt else None,
            "fulltext": record.get("fulltext"),
            "unreportedFields": [column for column, entry in cells.items() if entry["status"] == "unreported"],
            "provenance": record.get("provenance"),
            "mergedFrom": record.get("mergedFrom", 1),
        })
    return {"columns": columns, "rows": rows, "maxColumns": contract["matrixFields"]["maxColumns"], "unreportedToken": contract["evidence"]["cell"]["unreportedValue"]}


# ------------------------------------------------------------------ 引用核验


def citations_from_payload(payload):
    if isinstance(payload, dict):
        entries = payload.get("citations") or payload.get("references") or []
    else:
        entries = payload or []
    citations = []
    normalizers = {"doi": norm_doi, "pmid": norm_pmid, "arxiv": norm_arxiv, "zoteroKey": norm_zotero}
    for position, entry in enumerate(entries, start=1):
        if isinstance(entry, str):
            citations.append({"ref": str(position), "raw": entry[:400], "identifiers": identifiers_from_text(entry), "claimedTitle": None, "claimedYear": None})
            continue
        if not isinstance(entry, dict):
            continue
        identifiers = {key: value for key, value in (entry.get("identifiers") or {}).items() if value}
        for key, normalizer in normalizers.items():
            if not identifiers.get(key) and entry.get(key):
                identifiers[key] = normalizer(entry.get(key))
        for source_text in (entry.get("raw"), entry.get("citation")):
            for key, value in identifiers_from_text(source_text or "").items():
                identifiers.setdefault(key, value)
        citations.append({"ref": str(entry.get("ref") or position), "raw": (entry.get("raw") or entry.get("citation") or "")[:400],
                          "identifiers": {key: value for key, value in identifiers.items() if value},
                          "claimedTitle": entry.get("claimedTitle") or entry.get("title"),
                          "claimedYear": _coerce_int(entry.get("claimedYear") or entry.get("year"))})
    return citations


def citations_from_markdown(text):
    citations, seen = [], set()
    for line in (text or "").splitlines():
        if not line.strip():
            continue
        identifiers = identifiers_from_text(line)
        if not identifiers:
            continue
        key = json.dumps(identifiers, sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        citations.append({"ref": f"line-{len(citations) + 1}", "raw": line.strip()[:400], "identifiers": identifiers, "claimedTitle": None, "claimedYear": None})
    return citations


def compare_claims(citation, record):
    def normalize(value):
        return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", str(value).lower())

    mismatches = []
    claimed_title = (citation.get("claimedTitle") or "").strip()
    if claimed_title and record.get("title"):
        if normalize(claimed_title) and normalize(claimed_title) not in normalize(record["title"]) and normalize(record["title"]) not in normalize(claimed_title):
            mismatches.append({"field": "title", "claimed": claimed_title, "resolved": record["title"]})
    claimed_year = citation.get("claimedYear")
    if claimed_year and record.get("year") and claimed_year != record["year"]:
        mismatches.append({"field": "year", "claimed": claimed_year, "resolved": record["year"]})
    return mismatches


def verify_citations(citations, *, records, contract, now=None):
    index = {}
    for record in records or []:
        for identifier, value in (record.get("identifiers") or {}).items():
            index.setdefault(f"{identifier}:{value}", record)
    results, diagnostics = [], []
    for citation in citations:
        identifiers = citation["identifiers"]
        entry = {"ref": citation["ref"], "raw": citation["raw"], "identifiers": identifiers, "source": "local-records"}
        if not identifiers:
            entry.update({"status": "unresolvable", "reason": "no_persistent_identifier", "resolved": None, "mismatches": []})
            results.append(entry)
            diagnostics.append(diag("MATRIX_CITATION_UNVERIFIED", "warning", f"引用 {citation['ref']} 没有可解析的持久标识，不得写入引用清单", next_step="补充 DOI/PMID/arXiv ID 或在正文中降级为缺口"))
            continue
        matched = next((index[f"{key}:{value}"] for key, value in identifiers.items() if f"{key}:{value}" in index), None)
        if matched is None:
            entry.update({"status": "unresolvable", "reason": "not_in_this_run", "resolved": None, "mismatches": []})
            if "zoteroKey" in identifiers:
                entry["reason"] = "zotero_key_needs_workbench"
                diagnostics.append(diag("MATRIX_CITATION_UNVERIFIED", "warning", f"引用 {citation['ref']} 只有 Zotero item key：必须在工作台内部核对，helper 不读 Zotero", next_step="在工作台里核对条目标题/年份后再引用"))
            else:
                diagnostics.append(diag("MATRIX_CITATION_UNVERIFIED", "warning", f"引用 {citation['ref']} 不在本次记录集中，无法核验", next_step="重新检索该标识，或不要引用它"))
            results.append(entry)
            continue
        mismatches = compare_claims(citation, matched)
        entry.update({"status": "mismatch" if mismatches else "verified", "resolved": {"title": matched.get("title"), "year": matched.get("year"), "firstAuthor": matched.get("firstAuthor"), "identifiers": matched.get("identifiers")}, "mismatches": mismatches})
        if mismatches:
            diagnostics.append(diag("MATRIX_CITATION_MISMATCH", "warning", f"引用 {citation['ref']} 与本次记录不一致：{', '.join(item['field'] for item in mismatches)}", next_step="修正引用或删除该陈述"))
        results.append(entry)
    verified = [item for item in results if item["status"] == "verified"]
    summary = {
        "total": len(results),
        "verified": len(verified),
        "mismatch": len([item for item in results if item["status"] == "mismatch"]),
        "unresolvable": len([item for item in results if item["status"] == "unresolvable"]),
        "allVerified": bool(results) and len(verified) == len(results),
        "note": "只有落本次记录集的引用才算 verified；helper 不声称核验过未核验的引用。",
    }
    return results, summary, diagnostics


# ------------------------------------------------------------------ 投影合同 lint

TOOL_LOG_RE = re.compile(r"^\s*(?:\$\s|>>>\s|Traceback \(most recent call last\))", re.M)
ABSOLUTE_PATH_RE = re.compile(r"(?:[A-Za-z]:[\\/](?:Users|Documents|AppData|Windows)[\\/]|/(?:home|Users|root)/)")
CREDENTIAL_RE = re.compile(r"(?:sk-[A-Za-z0-9]{16,}|api[_-]?key\s*[:=]\s*[\"']?[A-Za-z0-9_\-]{12,}|access[_-]?token\s*[:=]\s*[\"']?[A-Za-z0-9_\-]{12,}|BEGIN [A-Z ]*PRIVATE KEY)", re.IGNORECASE)
SEPARATOR_ROW_RE = re.compile(r"^\s*\|[\s:|-]+\|\s*$")
PLACEHOLDER_TOKENS = ["N/A", "n/a", "TBD", "待补", "待定"]


def lint_body(text, contract):
    projection = contract["projection"]
    body = text or ""
    checks = []

    def add(check_id, status, code, detail):
        checks.append({"id": check_id, "status": status, "code": code, "detail": detail})

    add("body_frontmatter", "fail" if body.lstrip().startswith("---") else "pass", "MATRIX_BODY_FRONTMATTER", "投影层负责 frontmatter；正文不得自带 YAML frontmatter")
    add("body_h1", "fail" if re.search(r"^#\s", body, re.M) else "pass", "MATRIX_BODY_H1", "正文不得出现一级标题（投影层写标题）")

    positions = []
    missing = []
    for section in projection["requiredSections"]:
        index = body.find(section)
        if index < 0:
            missing.append(section)
        else:
            positions.append((index, section))
    add("body_sections", "fail" if missing else "pass", "MATRIX_BODY_SECTION_MISSING", f"缺少必需小节：{', '.join(missing)}" if missing else f"{len(projection['requiredSections'])} 个必需小节均存在")
    ordered = positions == sorted(positions)
    add("body_section_order", "fail" if not ordered else "pass", "MATRIX_BODY_SECTION_ORDER", "小节顺序必须与投影合同一致" if not ordered else "小节顺序正确")

    excerpt = body[: projection["maxExcerptChars"]]
    anchors = [section for section in projection["selfContainedWithinExcerpt"] if section not in excerpt]
    has_table = any(line.lstrip().startswith("|") for line in excerpt.splitlines())
    problems = anchors + ([] if has_table else ["至少一个表格"])
    add("body_excerpt_selfcontained", "fail" if problems else "pass", "MATRIX_BODY_EXCERPT_INCOMPLETE", f"前 {projection['maxExcerptChars']} 字符内缺少：{', '.join(problems)}" if problems else f"前 {projection['maxExcerptChars']} 字符已包含范围/覆盖/矩阵表")

    lines = body.splitlines()
    matrix_start = body.find("## 文献矩阵")
    matrix_end = body.find("\n## ", matrix_start + 1) if matrix_start >= 0 else -1
    matrix_text = body[matrix_start:matrix_end if matrix_end > 0 else len(body)] if matrix_start >= 0 else ""
    table_lines = [line for line in matrix_text.splitlines() if line.lstrip().startswith("|")]
    header = table_lines[0] if table_lines else ""
    data_rows = [line for line in table_lines[1:] if not SEPARATOR_ROW_RE.match(line)]
    columns = [cell for cell in header.strip().strip("|").split("|")] if header else []
    column_problems = []
    if header and len(columns) > contract["matrixFields"]["maxColumns"]:
        column_problems.append(f"列数 {len(columns)} 超过上限 {contract['matrixFields']['maxColumns']}")
    if columns and "标识" not in header:
        column_problems.append("缺少必填列「标识」")
    add("body_table_columns", "fail" if column_problems else "pass", "MATRIX_BODY_TABLE_COLUMNS", "; ".join(column_problems) if column_problems else (f"矩阵表 {len(columns)} 列，含必填列" if columns else "未找到矩阵表（已由 excerpt 检查报告）"))

    bad_rows = [line[:80] for line in data_rows if not identifiers_from_text(line) and not re.search(r"https?://", line)]
    add("body_rows_identified", "fail" if bad_rows else "pass", "MATRIX_BODY_ROW_WITHOUT_IDENTIFIER", f"{len(bad_rows)} 行缺少可解析的持久标识（示例：{bad_rows[0]}）" if bad_rows else f"{len(data_rows)} 行均带持久标识或 URL")

    placeholders = [token for token in PLACEHOLDER_TOKENS if token in body]
    add("body_placeholders", "warn" if placeholders else "pass", "MATRIX_BODY_PLACEHOLDER", f"出现占位符 {', '.join(placeholders)}：缺失字段请写「未报告」" if placeholders else "未发现 N/A/TBD/待补 等占位符")
    coverage_stated = ("覆盖" in body) and ("部分覆盖" in body or "完整覆盖" in body)
    add("body_coverage_statement", "warn" if not coverage_stated else "pass", "MATRIX_BODY_COVERAGE_MISSING", "正文未声明覆盖状态（部分/完整），必须可见" if not coverage_stated else "已声明覆盖状态")

    leaks = []
    if ABSOLUTE_PATH_RE.search(body):
        leaks.append("绝对路径")
    if CREDENTIAL_RE.search(body):
        leaks.append("凭据类内容")
    if TOOL_LOG_RE.search(body):
        leaks.append("工具日志/命令回显")
    add("body_leaks", "fail" if leaks else "pass", "MATRIX_BODY_LEAK", f"正文含：{', '.join(leaks)}" if leaks else "无绝对路径/凭据/工具日志")

    fails = [check for check in checks if check["status"] == "fail"]
    warns = [check for check in checks if check["status"] == "warn"]
    data_rows_count = len(data_rows)
    return {
        "checks": checks,
        "summary": {"pass": len(checks) - len(fails) - len(warns), "warn": len(warns), "fail": len(fails), "matrixRows": data_rows_count, "columns": len(columns)},
        "lintPassed": not fails,
    }, [diag(check["code"], "blocked" if check["status"] == "fail" else "warning", check["detail"], next_step="修正正文后重出一次；仍不过则在正文里如实标注") for check in checks if check["status"] in ("fail", "warn")]


# ------------------------------------------------------------------ 离线自检

FIXTURE_CONTEXT = [
    {"source": "zotero", "zoteroKey": "ABCD1234", "title": "Long-context retrieval benchmark", "authors": ["Wei Zhang"], "year": 2025, "abstract": "We evaluate long-context retrieval on three benchmarks.", "venue": "Zotero Library"},
    {"source": "openalex", "doi": "10.1234/abc.2025.001", "pmid": "12345678", "title": "Long-context retrieval benchmark", "authors": ["Wei Zhang"], "year": 2025, "abstract": "Same paper, described by OpenAlex."},
    {"source": "crossref", "doi": "https://doi.org/10.1234/ABC.2025.001", "title": "Long-context retrieval benchmark", "authors": ["Wei Zhang"], "year": 2025},
    {"source": "arxiv", "arxiv": "arXiv:2501.01234v2", "title": "Sparse attention for long context", "authors": ["Li Chen"], "year": 2025, "abstract": "We propose a sparse attention variant."},
    {"source": "openalex", "title": None, "authors": [], "year": None},
]

GOOD_BODY = (
    "## 主题与范围\n\n主题：长上下文检索；时间窗：最近 90 天；来源：openalex、crossref。\n\n"
    "## 覆盖与来源状态\n\n本次为部分覆盖：arxiv 未检索，结论仅代表已覆盖来源。\n\n"
    "## 文献矩阵\n\n| 标识 | 标题 | 方法·干预 |\n| --- | --- | --- |\n"
    "| DOI:10.1234/abc.2025.001 | Long-context retrieval benchmark | 未报告 |\n\n"
    "## 关键对比\n\n同主题下仅一篇可用记录。\n\n"
    "## 证据与引用\n\n- Wei Zhang, 2025 · DOI:10.1234/abc.2025.001（证据层级：摘要）\n\n"
    "## 缺口与下一步\n\n方法列未报告，需读取全文后再补。\n"
)

BAD_BODY = (
    "---\ntitle: 手写的 frontmatter 不应存在\n---\n\n# 一级标题也不应存在\n\n"
    "## 主题与范围\n\n路径泄漏：C:\\Users\\someone\\vault\\note.md\n\n"
    "## 覆盖与来源状态\n\n部分覆盖\n\n"
    "## 文献矩阵\n\n| 标识 | 方法·干预 |\n| --- | --- |\n|  | N/A |\n| ??? | 未报告 |\n\n"
    "## 关键对比\n\n## 证据与引用\n\n## 缺口与下一步\n"
)


def run_self_test(contract):
    checks = []

    def expect(check_id, condition, detail):
        checks.append({"id": check_id, "status": "pass" if condition else "fail", "detail": detail if condition else f"未通过：{detail}"})

    expect("contract_identity", contract["skillKey"] == SKILL_KEY and contract["diagnosticPrefix"] == DIAG_PREFIX, "合同 skillKey/diagnosticPrefix 与 helper 一致")
    network_ids = [source["id"] for source in contract["sources"] if source["kind"] == "network"]
    expect("contract_network_sources", set(network_ids) == {"openalex", "arxiv", "europepmc", "crossref"}, f"网络来源：{', '.join(network_ids)}")
    expect("contract_dedupe_order", contract["dedupe"]["order"] == ["doi", "pmid", "arxiv", "zoteroKey", "titleYearFirstAuthor"], f"去重键序：{' → '.join(contract['dedupe']['order'])}")
    expect("contract_no_key_required", all(source["auth"] == "none" for source in contract["sources"] if source["kind"] == "network"), "所有网络来源均为免密钥")

    good, good_diag = normalize_inputs({"topic": "  long   context  ", "lookbackDays": "90", "sources": "Zotero, Obsidian, web", "responseLanguage": "en", "outputFolder": "每日资讯推送/文献矩阵", "project": "长上下文"}, contract)
    expect("normalize_valid", good is not None and not good_diag and good["topic"] == "long context" and good["lookbackDays"] == 90 and good["responseLanguage"] == "en", "合法输入被归一化（空白压缩/字符串天数/来源别名）")
    expect("normalize_source_alias", good["sources"] == ["zotero", "obsidian", "openalex", "arxiv", "europepmc", "crossref"], f"web 展开+小写+去重：{','.join(good['sources'])}")

    def blocked(field, value):
        _, diagnostics = normalize_inputs({"topic": "x", field: value}, contract)
        return [item["code"] for item in diagnostics]

    expect("normalize_topic_missing", "MATRIX_INPUT_TOPIC_MISSING" in blocked("topic", "   "), "空主题被结构化阻断")
    expect("normalize_window_invalid", "MATRIX_INPUT_WINDOW_INVALID" in blocked("lookbackDays", 0), "越界时间窗被阻断")
    expect("normalize_sources_invalid", "MATRIX_INPUT_SOURCES_INVALID" in blocked("sources", "wikipedia"), "未知来源名硬错误（不静默降级）")
    expect("normalize_language_invalid", "MATRIX_INPUT_LANGUAGE_INVALID" in blocked("responseLanguage", "fr"), "非白名单语言被阻断")
    expect("normalize_folder_traversal", "MATRIX_INPUT_OUTPUT_FOLDER_INVALID" in blocked("outputFolder", "../secrets"), "outputFolder 路径穿越被拒")
    expect("normalize_folder_obsidian", "MATRIX_INPUT_OUTPUT_FOLDER_INVALID" in blocked("outputFolder", ".obsidian/notes"), "outputFolder 指向 .obsidian 被拒")
    template, template_diag = normalize_field_template({"columns": ["identifier", "title"]}, contract)
    expect("template_required_columns", template is None and bool(template_diag) and template_diag["code"] == "MATRIX_FIELD_TEMPLATE_INVALID", "fieldTemplate 缺必填列被阻断")

    records, problems = collect_records(FIXTURE_CONTEXT, contract=contract)
    expect("records_coerced", len(records) == 5 and not problems, f"{len(records)} 条上下文记录被归一化")
    deduped = dedupe_records(records, contract)
    expect("dedupe_doi", len(deduped["records"]) == 3 and len(deduped["duplicates"]) == 1, f"DOI 大小写/URL 变体合并：留 {len(deduped['records'])} 条，合并 {len(deduped['duplicates'])} 条")
    expect("dedupe_drop_unidentified", len(deduped["dropped"]) == 1, "无任何持久标识的记录被移出矩阵并在诊断中可见")
    merged = next(record for record in deduped["records"] if record["identifiers"].get("doi"))
    expect("dedupe_merge_keeps_ids", merged["identifiers"].get("pmid") == "12345678" and merged["mergedFrom"] == 2, "合并后保留跨来源标识并计数 mergedFrom")

    inputs, _ = normalize_inputs({"topic": "long context", "sources": "zotero, openalex", "project": "长上下文"}, contract)
    rows = extract_rows(deduped, inputs, contract)
    expect("extract_rows", len(rows["rows"]) == 3 and rows["columns"][0] == "identifier", f"生成 {len(rows['rows'])} 行列草稿，首列为标识")
    first = rows["rows"][0]
    expect("extract_unreported", first["cells"]["method"]["value"] == "未报告" and first["cells"]["method"]["status"] == "unreported", "未读到的字段写「未报告」并标 unreported（不得空白）")
    expect("extract_evidence", first["cells"]["identifier"]["evidence"] == "元数据" and first["abstractExcerpt"] is not None, "每个单元格携带证据层级，摘要按证据层级标注")
    expect("extract_project_class", first["cells"]["projectClass"]["value"] == "长上下文", "projectClass 来自本次注入的项目上下文")
    citations = citations_from_payload([
        {"ref": "1", "doi": "https://doi.org/10.1234/ABC.2025.001", "claimedTitle": "Long-context retrieval benchmark", "claimedYear": 2025},
        {"ref": "2", "doi": "10.9999/not-in-this-run"},
        {"ref": "3", "zoteroKey": "ZZZZ9999"},
        {"ref": "4", "raw": "未带标识的散文引用"},
        {"ref": "5", "doi": "10.1234/abc.2025.001", "claimedYear": 2019},
    ])
    verify_results, verify_summary, verify_diag = verify_citations(citations, records=deduped["records"], contract=contract)
    expect("verify_statuses", [item["status"] for item in verify_results] == ["verified", "unresolvable", "unresolvable", "unresolvable", "mismatch"], f"核验状态：{','.join(item['status'] for item in verify_results)}")
    expect("verify_no_blanket_claim", verify_summary["allVerified"] is False and verify_summary["verified"] == 1, "只把落记录集的引用记为 verified，不声称全量核验")
    expect("verify_zotero_boundary", verify_results[2]["reason"] == "zotero_key_needs_workbench", "Zotero key 引用标记为需工作台人工核对")
    expect("verify_diagnostics", {"MATRIX_CITATION_UNVERIFIED", "MATRIX_CITATION_MISMATCH"} <= {item["code"] for item in verify_diag}, "核验产出结构化诊断码")
    markdown_citations = citations_from_markdown("- DOI:10.1234/abc.2025.001 · Long-context retrieval benchmark\n- 无标识陈述\n")
    expect("verify_markdown_scan", len(markdown_citations) == 1 and markdown_citations[0]["identifiers"]["doi"] == "10.1234/abc.2025.001", "能从 Markdown 正文扫出可核验引用行")

    good_lint, _ = lint_body(GOOD_BODY, contract)
    expect("lint_good_body", good_lint["lintPassed"] and good_lint["summary"]["matrixRows"] == 1, f"合规正文通过：{good_lint['summary']}")
    bad_lint, _ = lint_body(BAD_BODY, contract)
    bad_codes = {check["code"] for check in bad_lint["checks"] if check["status"] == "fail"}
    expect("lint_bad_body", not bad_lint["lintPassed"] and {"MATRIX_BODY_FRONTMATTER", "MATRIX_BODY_H1", "MATRIX_BODY_ROW_WITHOUT_IDENTIFIER", "MATRIX_BODY_LEAK"} <= bad_codes, f"违规正文被拦：{', '.join(sorted(bad_codes))}")
    plan = [build_plan(source_by_id(contract, sid), "long context", lookback_days=90, limit=10, contact_email=None, now="2026-01-15T00:00:00Z") for sid in ("openalex", "crossref")]
    plan_again = [build_plan(source_by_id(contract, sid), "long context", lookback_days=90, limit=10, contact_email=None, now="2026-01-15T00:00:00Z") for sid in ("openalex", "crossref")]
    expect("plan_deterministic", json.dumps(plan, sort_keys=True) == json.dumps(plan_again, sort_keys=True) and plan[0]["params"]["filter"] == "from_publication_date:2025-10-17", "同一 --now 下检索计划可复现")
    expect("plan_keyless", all("mailto" not in json.dumps(item["params"]) for item in plan) and plan[1]["params"]["query.bibliographic"] == "long context", "默认不发送联络邮箱，也不带任何密钥")
    context_plan = build_plan(source_by_id(contract, "zotero"), "x", lookback_days=7, limit=5, contact_email=None, now="2026-01-15T00:00:00Z")
    expect("plan_context_source", context_plan["status"] == "context-required", "Zotero/Obsidian 来源被标为需工作台注入上下文")

    atom = '<feed><entry><id>http://arxiv.org/abs/2501.01234v2</id><title>Sparse attention</title><author><name>Li Chen</name></author><published>2025-01-05T00:00:00Z</published><summary>We propose a variant.</summary><arxiv:doi>10.1234/arxiv.2025.001</arxiv:doi></entry></feed>'
    parsed = parse_arxiv(atom, "2026-01-15T00:00:00Z")
    expect("parse_arxiv_offline", len(parsed) == 1 and parsed[0]["identifiers"]["arxiv"] == "2501.01234" and parsed[0]["evidenceLevel"] == "abstract" and parsed[0]["fulltext"]["linkAvailable"] is True, "离线解析 arXiv Atom（版本号归一、摘要层级、PDF 链接标记）")
    cr_payload = {"message": {"items": [{"DOI": "10.5555/x.y", "title": ["A title"], "author": [{"given": "Ann", "family": "Lee"}], "issued": {"date-parts": [[2024, 5]]}, "container-title": ["J. Test"], "abstract": "<jats:p>Hello  world</jats:p>"}]}}
    cr_records = parse_crossref(cr_payload, "2026-01-15T00:00:00Z")
    expect("parse_crossref_offline", len(cr_records) == 1 and cr_records[0]["year"] == 2024 and cr_records[0]["abstract"] == "Hello world" and cr_records[0]["firstAuthor"] == "Ann Lee", "离线解析 Crossref（年份/作者/去 HTML 摘要）")
    oa_records = parse_openalex({"results": [{"id": "https://openalex.org/W1", "doi": "https://doi.org/10.5555/Z", "ids": {"pmid": "https://pubmed.ncbi.nlm.nih.gov/99999999"}, "display_name": "T", "publication_year": 2023, "abstract_inverted_index": {"World": [1], "Hello": [0]}, "open_access": {"is_oa": True}, "best_oa_location": {"pdf_url": "https://example.org/a.pdf"}}]}, "2026-01-15T00:00:00Z")
    expect("parse_openalex_offline", len(oa_records) == 1 and oa_records[0]["abstract"] == "Hello World" and oa_records[0]["identifiers"]["doi"] == "10.5555/z" and oa_records[0]["identifiers"]["pmid"] == "99999999", "离线重建 OpenAlex 倒排摘要与标识归一")

    guard_cases = [("zotero.sqlite", True), ("x/library.sqlite3", True), (".obsidian/notes.md", True), ("~/.pi/auth/api-keys.json", True), (".env.local", True), ("cache/openalex/abc.json", False)]
    expect("guard_paths", all(bool(guard_path(path)) == expected for path, expected in guard_cases), "路径守卫拒绝 sqlite/.obsidian/.env/~/.pi，放行缓存目录")

    module_text = Path(__file__).read_text(encoding="utf-8")
    prefix_re = re.compile("\\b(?:" + "MATRIX" + "|" + "REVIEW" + ")_[A-Z_]+\\b")
    wrong_prefix = [token for token in prefix_re.findall(module_text) if not token.startswith(DIAG_PREFIX + "_")]
    expect("diagnostic_prefix_consistency", not wrong_prefix, f"本 skill 的诊断码均以 {DIAG_PREFIX}_ 开头" if not wrong_prefix else f"跨 skill 前缀：{wrong_prefix}")
    secret_re = re.compile("(?:api[_-]?key|access[_-]?token|password|secret)\\s*=\\s*[\"'][A-Za-z0-9_-]{12,}[\"']", re.IGNORECASE)
    imports = set(re.findall(r"^(?:import|from)\\s+([A-Za-z_][A-Za-z0-9_]*)", module_text, re.MULTILINE))
    allowed_imports = {"argparse", "datetime", "hashlib", "json", "os", "pathlib", "re", "sys", "tempfile", "time", "urllib", "fcntl", "msvcrt"}
    expect("helper_stdlib_only", imports <= allowed_imports, f"仅标准库：{', '.join(sorted(imports))}")
    expect("helper_no_credentials", not re.search(r"(?i)authorization\s*[=:]", module_text) and not secret_re.search(module_text) and "os.environ" in module_text, "无 Authorization 头/内置密钥；缓存目录只从显式参数或环境变量读取")
    return checks


# ------------------------------------------------------------------ CLI

OVERRIDE_FIELDS = {
    "topic": "topic",
    "lookback_days": "lookbackDays",
    "sources": "sources",
    "language": "responseLanguage",
    "project": "project",
    "output_folder": "outputFolder",
    "field_template": "fieldTemplate",
}


def read_payload(path, purpose="input"):
    if path in (None, ""):
        return None
    if path == "-":
        return json.loads(sys.stdin.read() or "{}")
    guard = guard_path(path, purpose=purpose)
    if guard:
        raise ContractError(guard)
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ContractError(diag("MATRIX_INPUT_MISSING", "blocked", f"找不到输入文件：{path}", next_step="检查 --input-json/--records/--context/--body 的路径"))
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ContractError(diag("MATRIX_INPUT_INVALID", "blocked", f"输入文件无法解析：{error}"))


def build_inputs(args, contract):
    payload = read_payload(getattr(args, "input_json", None))
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        raise ContractError(diag("MATRIX_INPUT_INVALID", "blocked", "--input-json 必须是 JSON 对象"))
    overrides = {target: getattr(args, attribute) for attribute, target in OVERRIDE_FIELDS.items() if getattr(args, attribute, None) is not None}
    return normalize_inputs(payload, contract, overrides)


def load_records(paths, contract):
    records, diagnostics, sources_seen = [], [], set()
    for path in [item for item in (paths or []) if item]:
        payload = read_payload(path, purpose="records")
        if isinstance(payload, dict) and "data" in payload and isinstance(payload.get("data"), dict):
            data = payload["data"]
            payload = data.get("records") or (data.get("dedupe") or {}).get("records") or []
        batch, problems = collect_records(payload, contract=contract)
        if problems:
            diagnostics.append(diag("MATRIX_RECORDS_INVALID", "warning", f"记录文件含 {len(problems)} 个非对象条目：{', '.join(sorted(set(problems)))[:120]}", next_step="修正记录文件格式"))
        records.extend(batch)
    for record in records:
        sources_seen.update(record.get("sourceIds") or [])
    return records, diagnostics, sorted(sources_seen)


def write_manifest(manifest_dir, name, payload):
    if not manifest_dir:
        return None
    guard = guard_path(manifest_dir, purpose="manifest-dir")
    if guard:
        raise ContractError(guard)
    folder = Path(manifest_dir).expanduser()
    try:
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / name
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as error:
        raise ContractError(diag("MATRIX_CACHE_UNAVAILABLE", "failed", f"无法写入 manifest 目录：{error}", next_step="检查 --manifest-dir 是否存在且可写"))
    return str(path)


COMMANDS = ("normalize", "plan", "search", "dedupe", "extract", "verify", "lint", "self-test")


def add_input_args(parser):
    parser.add_argument("--input-json", help="输入参数 JSON（文件路径；- 读 stdin）")
    parser.add_argument("--topic")
    parser.add_argument("--lookback-days", type=int)
    parser.add_argument("--sources", help="逗号分隔：openalex,arxiv,europepmc,crossref,zotero,obsidian,web")
    parser.add_argument("--language")
    parser.add_argument("--project")
    parser.add_argument("--output-folder")
    parser.add_argument("--field-template")
    parser.add_argument("--now", help="固定时间戳（ISO8601），保证检索计划/信封可复现")


def add_record_args(parser):
    parser.add_argument("--records", action="append", help="已有记录 JSON（可重复；接受本 helper 的输出信封）")
    parser.add_argument("--context", action="append", help="本次运行注入的文献上下文 JSON（可重复）")
    parser.add_argument("--cache-dir", help="缓存目录（默认在系统缓存目录内，绝不会写进仓库）")
    parser.add_argument("--manifest-dir", help="额外写一份运行 manifest（诊断/覆盖/来源状态）")
    parser.add_argument("--no-cache", action="store_true", help="忽略缓存强制重新请求")
    parser.add_argument("--timeout", type=int, default=HTTP_TIMEOUT_SECONDS, help=f"单源超时秒数（默认 {HTTP_TIMEOUT_SECONDS}）")


def make_parser():
    parser = argparse.ArgumentParser(prog="litmatrix.py", description="literature-matrix 本地 helper：离线优先、网络可选、免密钥、标准库")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in COMMANDS:
        child = sub.add_parser(name, help=f"{name} 子命令")
        if name in ("normalize", "plan", "search", "dedupe", "extract"):
            add_input_args(child)
        if name in ("search", "dedupe", "extract", "verify"):
            add_record_args(child)
        if name == "search":
            child.add_argument("--online", action="store_true", help="显式开启联网检索（默认关闭；离线用 --context）")
            child.add_argument("--limit", type=int, default=25, help="每来源条数上限（默认 25）")
            child.add_argument("--contact-email", help="可选：OpenAlex/Crossref polite pool 联络邮箱（不写入仓库，也不必需）")
        if name == "verify":
            child.add_argument("--citations", help="引用清单 JSON：{citations:[{ref,doi|pmid|arxiv|zoteroKey,claimedTitle,claimedYear,raw}]}")
            child.add_argument("--body", help="已写好的 Markdown 正文（自动扫出带标识的引用行）；核验为离线核对，联网检索请用 search --online")
        if name == "lint":
            child.add_argument("--body", required=True, help="待校验的 Markdown 正文（- 读 stdin）")
    return parser


def run_command(args):
    contract = load_contract()
    command = args.command
    review = human_review(contract)

    if command == "self-test":
        checks = run_self_test(contract)
        failures = [check for check in checks if check["status"] == "fail"]
        diagnostics = [diag("MATRIX_SELF_TEST_FAILED", "failed", check["detail"], next_step="修复对应能力后再交付") for check in failures]
        return emit(make_envelope(command, "failed" if failures else "ok", data={"checks": checks, "passed": len(checks) - len(failures), "total": len(checks)}, diagnostics=diagnostics, review=review))

    if command == "lint":
        guard = guard_path(getattr(args, "body", None), purpose="body")
        if guard:
            raise ContractError(guard)
        if getattr(args, "body", None) == "-":
            text = sys.stdin.read()
        else:
            try:
                text = Path(args.body).read_text(encoding="utf-8")
            except FileNotFoundError:
                raise ContractError(diag("MATRIX_INPUT_MISSING", "blocked", f"找不到正文文件：{args.body}"))
        result, lint_diagnostics = lint_body(text, contract)
        status = "blocked" if not result["lintPassed"] else resolve_status(lint_diagnostics)
        return emit(make_envelope(command, status, data=result, diagnostics=lint_diagnostics, inputs={"bodyChars": len(text)}, review=review))

    inputs, diagnostics = build_inputs(args, contract)
    if command in ("dedupe", "extract", "verify"):
        non_applicable = {"MATRIX_INPUT_TOPIC_MISSING", "MATRIX_INPUT_TOPIC_INVALID", "MATRIX_INPUT_WINDOW_INVALID"}
        diagnostics = [item for item in diagnostics if item["code"] not in non_applicable]
    now = getattr(args, "now", None)
    blocked = has_severity(diagnostics, "blocked")
    limit = getattr(args, "limit", 25)

    if command == "normalize":
        resolved, _ = resolve_sources(inputs.get("sources") or [], contract)
        data = {"inputs": inputs, "resolvedSources": resolved, "networkSources": [source["id"] for source in contract["sources"] if source["kind"] == "network"], "networkRequires": "--online（默认离线）"}
        return emit(make_envelope(command, resolve_status(diagnostics), data=data, diagnostics=diagnostics, inputs=inputs, review=review, now=now))

    plan = []
    if command in ("plan", "search") and not blocked:
        resolved, _ = resolve_sources(inputs.get("sources") or [], contract)
        plan = [build_plan(source_by_id(contract, source_id), inputs["topic"], lookback_days=inputs["lookbackDays"], limit=limit, contact_email=getattr(args, "contact_email", None), now=now) for source_id in resolved]

    if command == "plan":
        data = {"inputs": inputs, "plan": plan, "limitations": [source["notes"] for source in contract["sources"] if source["kind"] == "network"], "note": "计划在离线状态下也能产出；真正请求必须显式 --online"}
        return emit(make_envelope(command, resolve_status(diagnostics), data=data, diagnostics=diagnostics, inputs=inputs, review=review, now=now))

    if blocked:
        return emit(make_envelope(command, "blocked", data={"inputs": inputs, "plan": plan}, diagnostics=diagnostics, inputs=inputs, review=review, now=now))

    cache_dir = safe_cache_dir(getattr(args, "cache_dir", None), contract)
    context_records, context_diag, context_sources = load_records(getattr(args, "context", None), contract)
    extra_records, extra_diag, extra_sources = load_records(getattr(args, "records", None), contract)
    diagnostics.extend(context_diag)
    diagnostics.extend(extra_diag)
    requests, coverage = [], {}

    if command == "search":
        records, coverage, search_diagnostics, requests = run_search(plan, contract=contract, cache_dir=cache_dir, online=bool(getattr(args, "online", False)), no_cache=bool(getattr(args, "no_cache", False)), timeout=args.timeout, context_records=context_records, now=now)
        diagnostics.extend(search_diagnostics)
        plan_ids = {item["id"] for item in plan}
        injected_extra = [record for record in context_records if not any(source_id in plan_ids for source_id in (record.get("sourceIds") or []))]
        if injected_extra:
            diagnostics.append(diag("MATRIX_SOURCE_CONTEXT_UNUSED", "warning", f"{len(injected_extra)} 条注入记录不在本次计划来源内：保留并标来源，但不计入来源覆盖", next_step="核对 --sources 与注入记录的来源是否一致"))
        pool = records + injected_extra + extra_records
        deduped = dedupe_records(pool, contract)
        status = resolve_status(diagnostics, empty=not pool, degraded=any(coverage.get(key) for key in ("degraded", "unavailable", "failed", "skippedOffline", "partial")))
        data = {"inputs": inputs, "plan": plan, "coverage": coverage, "dedupe": {"records": deduped["records"], "duplicates": deduped["duplicates"], "dropped": deduped["dropped"]}, "counts": {"raw": len(pool), "unique": len(deduped["records"]), "merged": len(deduped["duplicates"]), "dropped": len(deduped["dropped"])}, "evidenceLevels": contract["evidence"]["levels"]}
        return finish(command, status, data, diagnostics, coverage, inputs, review, now, cache_dir, requests, getattr(args, "manifest_dir", None))

    pool = context_records + extra_records
    deduped = dedupe_records(pool, contract)
    coverage = {"requested": [], "used": sorted(set(context_sources + extra_sources)), "recordsIn": len(pool), "recordsOut": len(deduped["records"]), "note": "离线命令不发网络请求；来源状态来自注入记录自身"}

    if command == "dedupe":
        status = resolve_status(diagnostics, empty=not deduped["records"])
        data = {"inputs": inputs, "dedupe": deduped, "sources": coverage["used"], "counts": {"raw": len(pool), "unique": len(deduped["records"]), "merged": len(deduped["duplicates"]), "dropped": len(deduped["dropped"])}, "rule": "按 DOI → PMID → arXiv → Zotero key →（标题+年份+第一作者）依次取键；无任何键则不进入矩阵"}
        return finish(command, status, data, diagnostics, coverage, inputs, review, now, cache_dir, requests, getattr(args, "manifest_dir", None))

    if command == "extract":
        rows = extract_rows(deduped, inputs, contract)
        status = resolve_status(diagnostics, empty=not rows["rows"])
        unreported_total = sum(len(row["unreportedFields"]) for row in rows["rows"])
        data = {"inputs": inputs, "columns": rows["columns"], "rows": rows["rows"], "unreportedToken": rows["unreportedToken"], "counts": {"rows": len(rows["rows"]), "cells": len(rows["rows"]) * len(rows["columns"]), "unreportedCells": unreported_total}, "boundary": "这是草稿：method/data/conclusion/limitations/relation 等列默认写「未报告」并标 unreported，必须由人或模型读过证据后填写，并保留证据层级"}
        return finish(command, status, data, diagnostics, coverage, inputs, review, now, cache_dir, requests, getattr(args, "manifest_dir", None))

    if command == "verify":
        citations_payload = read_payload(getattr(args, "citations", None), purpose="citations")
        citations = citations_from_payload(citations_payload) if citations_payload is not None else []
        body_path = getattr(args, "body", None)
        if body_path:
            guard = guard_path(body_path, purpose="body")
            if guard:
                raise ContractError(guard)
            try:
                text = sys.stdin.read() if body_path == "-" else Path(body_path).read_text(encoding="utf-8")
            except FileNotFoundError:
                raise ContractError(diag("MATRIX_INPUT_MISSING", "blocked", f"找不到正文文件：{body_path}"))
            citations.extend(citations_from_markdown(text))
        if not citations:
            diagnostics.append(diag("MATRIX_CITATION_INPUT_MISSING", "blocked", "没有可核验的引用：请提供 --citations 或 --body", next_step="给出引用清单或已写好的 Markdown 正文"))
            return emit(make_envelope(command, "blocked", data={"inputs": inputs, "citations": []}, diagnostics=diagnostics, inputs=inputs, review=review, now=now))
        results, summary, verify_diagnostics = verify_citations(citations, records=deduped["records"], contract=contract)
        diagnostics.extend(verify_diagnostics)
        status = resolve_status(diagnostics, empty=not results)
        data = {"inputs": inputs, "citations": results, "summary": summary, "recordsAvailable": len(deduped["records"]), "sources": coverage["used"], "boundary": "本命令只做离线核对：核对对象是本次 --records/--context 的记录集；未落入记录集的引用一律 unresolvable，绝不凭空写成已核验"}
        return finish(command, status, data, diagnostics, coverage, inputs, review, now, cache_dir, requests, getattr(args, "manifest_dir", None))


def finish(command, status, data, diagnostics, coverage, inputs, review, now, cache_dir, requests, manifest_dir):
    network = {"enabled": bool(requests), "cacheDir": str(cache_dir) if cache_dir else None, "requests": requests, "policy": "每源独立失败：限流/超时/权限不足/空结果只降级该来源，详见 diagnostics，绝不当作空结果"}
    envelope = make_envelope(command, status, data=data, diagnostics=diagnostics, coverage=coverage, inputs=inputs, network=network, review=review, now=now)
    if manifest_dir:
        envelope["data"]["manifestPath"] = write_manifest(manifest_dir, f"{command}-{envelope['generatedAt'].replace(':', '')}.json", {
            "schemaVersion": envelope["schemaVersion"],
            "skillKey": envelope["skillKey"],
            "command": command,
            "status": status,
            "generatedAt": envelope["generatedAt"],
            "inputs": inputs,
            "coverage": coverage,
            "network": network,
            "diagnostics": diagnostics,
            "humanReview": envelope["humanReview"],
            "counts": data.get("counts"),
            "note": "manifest 只记运行事实与失败状态：不含凭据，不写仓库/Vault/Zotero，可随时删除",
        })
    return emit(envelope)


def main(argv=None):
    parser = make_parser()
    args = parser.parse_args(argv)
    try:
        return run_command(args)
    except ContractError as error:
        command = getattr(args, "command", "unknown")
        return emit(make_envelope(command, "blocked", data={"inputs": {}, "hint": "修正后重跑；不要手改输出信封"}, diagnostics=[error.diagnostic], inputs={}, review={"required": True}))
    except Exception as error:  # 未预期错误也必须结构化（不静默、不半成品）
        command = getattr(args, "command", "unknown")
        return emit(make_envelope(
            command,
            "failed",
            data={"inputs": {}},
            diagnostics=[diag("MATRIX_RUN_FAILED", "failed", f"{type(error).__name__}: {error}", next_step="用 self-test 定位失败步骤后再交付；不要手改输出信封")],
            inputs={},
            review={"required": True},
        ))


if __name__ == "__main__":
    sys.exit(main())
