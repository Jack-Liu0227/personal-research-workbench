#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""literature-review-push 的本地可执行 helper（源目录：.agents/skills/literature-review-push/）。

只做机械操作：归一化 →（可选）多源检索 → 去重 → 纳入计数 → 证据行草稿 → 引用核验入口 → 正文 lint。
综述正文由 agent 写；本 helper 绝不生成正文，也不声称读过没读过的证据。

复用的唯一核心：`../literature-matrix/scripts/litmatrix.py`（同处 .agents/skills 单一源目录，
构建镜像整树复制，打包后同级仍可解析）；核心不复制第二份，只在这里改写诊断前缀。

  normalize  输入归一化（主题/综述类型/时间窗/来源/语言/项目/输出目录）
  plan       离线检索计划（不发网络请求）
  search     可选多源检索：openalex / arxiv / europepmc / crossref（+ 工作台注入上下文）
  dedupe     DOI → PMID → arXiv → Zotero key →（标题+年份+第一作者）
  extract    证据行草稿（缺失一律「未报告」；推断必须以「推断：」开头）
  verify     引用核验入口（离线比对本次记录集；不在记录集内一律 unresolvable）
  lint       校验正文是否符合 Artifact/Obsidian 投影合同
  self-test  离线自检：核心复用 + review 专属步骤的确定性断言

硬边界：仅标准库；网络默认关闭（--online 才请求）；无需也不保存任何 API key；不读
zotero.sqlite / *.sqlite / .obsidian / .env* / ~/.pi；不写 Zotero/Obsidian/仓库，只写
--cache-dir 与 --manifest-dir（默认系统缓存目录）；诊断码只用 REVIEW_ 前缀。

退出码：0 = ok/degraded/empty；1 = blocked；2 = failed。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SKILL_KEY = "literature-review-push"
DIAG_PREFIX = "REVIEW"
CORE_PREFIX = "MATRIX"
CORE_RELATIVE = ("literature-matrix", "scripts")
REVIEW_TYPES = ("narrative", "scoping", "systematic-lite", "mapping")


def load_core():
    core_dir = Path(__file__).resolve().parents[2].joinpath(*CORE_RELATIVE)
    if not (core_dir / "litmatrix.py").is_file():
        payload = {
            "schemaVersion": "1.0.0",
            "skillKey": SKILL_KEY,
            "command": "bootstrap",
            "status": "blocked",
            "diagnostics": [{"code": "REVIEW_CORE_MISSING", "severity": "blocked", "message": f"找不到机械核心：{core_dir}", "nextStep": "保持 .agents/skills 单一源目录完整", "source": None}],
        }
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        raise SystemExit(1)
    sys.path.insert(0, str(core_dir))
    import litmatrix as core  # 延迟导入，缺失时给出结构化阻断

    core.SKILL_KEY = SKILL_KEY
    core.DIAG_PREFIX = DIAG_PREFIX
    return core


CORE = load_core()


def retag(diagnostics):
    return [{**item, "code": str(item.get("code", "")).replace(CORE_PREFIX + "_", DIAG_PREFIX + "_")} for item in (diagnostics or [])]


def load_contract():
    path = Path(__file__).resolve().parent.parent / "schema" / "contract.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    if raw.get("skillKey") != SKILL_KEY or raw.get("diagnosticPrefix") != DIAG_PREFIX:
        raise ValueError("contract skillKey/diagnosticPrefix mismatch")
    return raw


def normalize_review_inputs(raw, contract, overrides=None):
    merged = dict(raw or {})
    for key, value in (overrides or {}).items():
        if value is not None:
            merged[key] = value
    diagnostics, inputs = [], {}
    topic, topic_diag = CORE.normalize_topic(merged.get("topic"))
    if topic_diag:
        diagnostics.append(retag([topic_diag])[0])
    inputs["topic"] = topic

    spec = contract["inputs"]["reviewType"]
    review_type = merged.get("reviewType", spec["default"])
    if isinstance(review_type, str):
        review_type = review_type.strip().lower()
    if review_type not in spec["allowed"]:
        diagnostics.append(CORE.diag("REVIEW_INPUT_TYPE_INVALID", "blocked", f"reviewType 只接受 {', '.join(spec['allowed'])}，收到 {merged.get('reviewType')!r}", next_step="例如 --review-type scoping"))
        review_type = None
    inputs["reviewType"] = review_type

    window_spec = contract["inputs"]["lookbackDays"]
    window = CORE._coerce_int(merged.get("lookbackDays", window_spec["default"]))
    if window is None or window < window_spec["minimum"] or window > window_spec["maximum"]:
        diagnostics.append(CORE.diag("REVIEW_INPUT_WINDOW_INVALID", "blocked", f"lookbackDays 必须是 {window_spec['minimum']}..{window_spec['maximum']} 的整数，收到 {merged.get('lookbackDays')!r}"))
        window = None
    inputs["lookbackDays"] = window

    sources, source_diag = CORE.normalize_sources(merged.get("sources"), contract)
    if source_diag:
        diagnostics.append(retag([source_diag])[0])
    inputs["sources"] = sources if sources is not None else []

    language = merged.get("responseLanguage") or contract["language"]["default"]
    if language not in contract["language"]["allowed"]:
        diagnostics.append(CORE.diag("REVIEW_INPUT_LANGUAGE_INVALID", "blocked", f"responseLanguage 只接受 {', '.join(contract['language']['allowed'])}，收到 {language!r}"))
        language = None
    inputs["responseLanguage"] = language

    folder, folder_diag = CORE.normalize_output_folder(merged.get("outputFolder"), contract)
    if folder_diag:
        diagnostics.append(retag([folder_diag])[0])
    inputs["outputFolder"] = folder

    project = merged.get("project")
    inputs["project"] = project.strip() or None if isinstance(project, str) else None
    inputs["unreportedToken"] = contract["evidence"]["row"]["unreportedValue"]
    inputs["inferencePrefix"] = contract["evidence"]["row"]["inferencePrefix"]
    return inputs, diagnostics


def availability(coverage, diagnostics):
    unavailable = list(coverage.get("unavailable") or []) + list(coverage.get("failed") or [])
    skipped = list(coverage.get("skippedOffline") or [])
    if unavailable or skipped:
        diagnostics.append(CORE.diag("REVIEW_SOURCES_UNAVAILABLE", "warning", f"部分来源不可用：{', '.join(unavailable) or '离线跳过 ' + ','.join(skipped)}", next_step="补 --context 或加 --online 后重跑；覆盖状态必须如实写进正文"))
    return diagnostics


def select_rows(deduped, diagnostics):
    """把去重后的记录变成可核对的候选行；只读来源元数据，不下载、不解析全文。"""
    rows, metadata_only = [], 0
    for record in deduped["records"]:
        identity = CORE.identity_label(record["identifiers"])
        if not identity:
            continue
        fulltext = record.get("fulltext") or {}
        level = record.get("evidenceLevel")
        if level != "abstract":
            metadata_only += 1
        rows.append({
            "identifier": identity,
            "source": ", ".join(record.get("sourceIds") or []),
            "studyType": record.get("sourceType"),
            "evidenceLevel": level,
            "title": record.get("title"),
            "year": record.get("year"),
            "firstAuthor": record.get("firstAuthor"),
            "abstractExcerpt": (record.get("abstract") or "")[:600] or None,
            "fulltextLinkAvailable": bool(fulltext.get("linkAvailable")),
            "fulltextLink": fulltext.get("link"),
            "provenance": record.get("provenance"),
        })
    if metadata_only:
        diagnostics.append(CORE.diag("REVIEW_FULLTEXT_UNAVAILABLE", "warning", f"{metadata_only} 条记录只有元数据（无摘要、未读全文）：不得当成事实性证据", next_step="补全文，或把相关陈述降级为「缺口」并说明"))
    return rows


def unreported(value, token="未报告"):
    return value if value not in (None, "", []) else token


def extract_review(deduped, inputs, contract, diagnostics):
    """证据行草稿：结构由 helper 给，claim/样本量/限制必须由读过证据的人填。"""
    token = contract["evidence"]["row"]["unreportedValue"]
    rows = select_rows(deduped, diagnostics)
    draft, gaps = [], []
    for row in rows:
        cells = {
            "identifier": {"value": row["identifier"], "status": "reported", "evidence": row["evidenceLevel"]},
            "source": {"value": unreported(row["source"], token), "status": "reported" if row["source"] else "unreported", "evidence": row["evidenceLevel"]},
            "studyType": {"value": unreported(row["studyType"], token), "status": "reported" if row["studyType"] else "unreported", "evidence": row["evidenceLevel"]},
            "evidenceLevel": {"value": row["evidenceLevel"], "status": "derived", "evidence": "helper 只可能给「摘要/元数据」；全文只能由读过全文的人改写"},
            "claim": {"value": token, "status": "unreported", "evidence": None, "guidance": "必须由人/模型读过证据后填写；推断以「推断：」开头并给出依据引用"},
            "sampleOrScale": {"value": token, "status": "unreported"},
            "limitations": {"value": token, "status": "unreported"},
            "fulltextLink": {"value": unreported(row["fulltextLink"], token), "status": "reported" if row["fulltextLink"] else "unreported"},
            "gap": {"value": token, "status": "unreported"},
        }
        draft.append({"identifier": row["identifier"], "title": row["title"], "year": row["year"], "firstAuthor": row["firstAuthor"], "abstractExcerpt": row["abstractExcerpt"], "fulltextRead": False, "provenance": row["provenance"], "cells": cells})
        missing = [key for key, cell in cells.items() if cell["status"] == "unreported"]
        if missing:
            gaps.append({"identifier": row["identifier"], "missingFields": missing, "nextStep": "读摘要/全文后补齐，或改写为「研究缺口」条目（缺口陈述 + 判定依据 + 下一步）"})
    return {"rows": draft, "gaps": gaps, "reviewType": inputs.get("reviewType"), "evidenceLevels": contract["evidence"]["levels"], "counts": {"rows": len(draft), "gapRows": len(gaps)}}


def lint_review_body(text, contract):
    """把投影合同变成可执行的正文检查（不判断学术质量，只判断结构/可核验性/泄漏）。"""
    projection = contract["projection"]
    body = text or ""
    checks = []

    def add(check_id, status, code, detail):
        checks.append({"id": check_id, "status": status, "code": code, "detail": detail})

    add("body_frontmatter", "fail" if body.lstrip().startswith("---") else "pass", "REVIEW_BODY_FRONTMATTER", "投影层写 frontmatter；正文不得自带 YAML frontmatter")
    add("body_h1", "fail" if re.search(r"^#\s", body, re.M) else "pass", "REVIEW_BODY_H1", "正文不得出现一级标题（投影层写标题）")

    positions, missing = [], []
    for section in projection["requiredSections"]:
        index = body.find(section)
        if index >= 0:
            positions.append((index, section))
        else:
            missing.append(section)
    add("body_sections", "fail" if missing else "pass", "REVIEW_BODY_SECTION_MISSING", f"缺少必需小节：{'、'.join(missing)}" if missing else f"{len(projection['requiredSections'])} 个必需小节均存在")
    ordered = positions == sorted(positions)
    add("body_section_order", "fail" if not ordered else "pass", "REVIEW_BODY_SECTION_ORDER", "小节顺序必须与投影合同一致" if not ordered else "小节顺序正确")

    excerpt = body[: projection["maxExcerptChars"]]
    excerpt_missing = [section for section in projection["selfContainedWithinExcerpt"] if section not in excerpt]
    citation_lines = [line for line in excerpt.splitlines() if CORE.identifiers_from_text(line)]
    gap = "、".join(excerpt_missing) or "带持久标识的引用行"
    add("body_excerpt_selfcontained", "fail" if (excerpt_missing or not citation_lines) else "pass", "REVIEW_BODY_EXCERPT_INCOMPLETE", f"前 {projection['maxExcerptChars']} 字符缺少：{gap}" if (excerpt_missing or not citation_lines) else f"前 {projection['maxExcerptChars']} 字符已含范围/覆盖/引用行")

    inferred = "推断" in body and "推断：" not in body
    add("body_inference_prefix", "fail" if inferred else "pass", "REVIEW_BODY_INFERENCE_UNMARKED", "出现「推断」却没有「推断：」前缀：事实与推断混写" if inferred else "未出现未标注的推断")
    placeholders = [token for token in contract["evidence"]["row"]["forbiddenPlaceholders"] if token in body]
    add("body_placeholders", "warn" if placeholders else "pass", "REVIEW_BODY_PLACEHOLDER", f"出现占位/近似值 {'、'.join(placeholders)}：缺失字段请写「未报告」" if placeholders else "未发现占位符")
    coverage_stated = "覆盖" in body and ("部分覆盖" in body or "完整覆盖" in body)
    add("body_coverage_statement", "warn" if not coverage_stated else "pass", "REVIEW_BODY_COVERAGE_MISSING", "正文未声明覆盖状态（部分覆盖/完整覆盖）" if not coverage_stated else "已声明覆盖状态")

    leaks = []
    if CORE.ABSOLUTE_PATH_RE.search(body):
        leaks.append("绝对路径")
    if CORE.CREDENTIAL_RE.search(body):
        leaks.append("凭据类内容")
    if CORE.TOOL_LOG_RE.search(body):
        leaks.append("工具日志/命令回显")
    add("body_leaks", "fail" if leaks else "pass", "REVIEW_BODY_LEAK", f"正文含：{'、'.join(leaks)}" if leaks else "无绝对路径/凭据/工具日志")
    has_citation = any(CORE.identifiers_from_text(line) for line in body.splitlines())
    add("body_citation_present", "fail" if not has_citation else "pass", "REVIEW_BODY_CITATION_MISSING", "正文没有任何带持久标识的引用行，无法核验" if not has_citation else "正文含可核验引用行")

    fails = [check for check in checks if check["status"] == "fail"]
    warns = [check for check in checks if check["status"] == "warn"]
    summary = {"pass": len(checks) - len(fails) - len(warns), "warn": len(warns), "fail": len(fails), "citationLines": len(citation_lines)}
    diagnostics = [CORE.diag(check["code"], "blocked" if check["status"] == "fail" else "warning", check["detail"], next_step="修正正文后重跑 lint；仍不过则在正文里如实标注差距") for check in checks if check["status"] in ("fail", "warn")]
    return {"checks": checks, "summary": summary, "lintPassed": not fails}, diagnostics


GOOD_BODY = (
    "## 综述问题与范围\n\n问题：长上下文检索的评测方法；类型：scoping；时间窗：最近 180 天。\n\n"
    "## 覆盖与来源状态\n\n本次为部分覆盖：openalex 已被限流未取回，事实仅代表 europepmc + crossref。\n\n"
    "## 证据主线\n\n- DOI:10.1234/abc.2025.001 报告了长上下文基准（证据层级：摘要）。\n\n"
    "## 事实与推断\n\n事实：\n\n- 该基准覆盖三个数据集（Wei Zhang et al., 2025 · DOI:10.1234/abc.2025.001）。\n\n"
    "推断：\n\n- 推断：方法可能不可迁移到多模态场景，依据 DOI:10.1234/abc.2025.001，不确定性高。\n\n"
    "## 研究缺口\n\n- 缺口：样本量未报告；依据：DOI:10.1234/abc.2025.001 只给元数据；下一步：读全文核对。\n\n"
    "## 引用清单\n\n1. Wei Zhang et al., 2025 · DOI:10.1234/abc.2025.001 · 来源 europepmc\n"
)
BAD_BODY = (
    "---\ntitle: 手写 frontmatter\n---\n\n# 一级标题\n\n## 综述问题与范围\n\n路径泄漏：C:\\Users\\someone\\vault\\note.md\n\n"
    "## 证据主线\n\n参考 PDF 见附件（无标识）。\n\n## 事实与推断\n\n推断这部分没有前缀。样本量 N/A。\n\n## 研究缺口\n"
)
FIXTURE_PAYLOAD = {
    "records": [
        {"source": "europepmc", "doi": "10.1234/abc.2025.001", "title": "Long-context retrieval benchmark", "authors": ["Wei Zhang"], "year": 2025, "abstract": "We evaluate long-context retrieval.", "pmid": "12345678"},
        {"source": "crossref", "doi": "https://doi.org/10.1234/ABC.2025.001", "title": "Long-context retrieval benchmark", "authors": ["Wei Zhang"], "year": 2025},
        {"source": "zotero", "zoteroKey": "ABCD1234", "title": "Zotero-only note", "authors": ["Li Chen"], "year": 2024},
        {"source": "openalex", "title": None, "authors": []},
    ]
}


def run_self_test(contract):
    checks = []

    def expect(check_id, condition, detail):
        checks.append({"id": check_id, "status": "pass" if condition else "fail", "detail": detail})

    expect("core_reused", CORE.__name__ == "litmatrix" and CORE.SKILL_KEY == SKILL_KEY, "机械核心复用 ../literature-matrix/scripts/litmatrix.py，未复制第二份实现")
    expect("contract_identity", contract["skillKey"] == SKILL_KEY and contract["diagnosticPrefix"] == DIAG_PREFIX, "合同 skillKey / diagnosticPrefix 一致")
    expect("contract_review_types", tuple(contract["inputs"]["reviewType"]["allowed"]) == REVIEW_TYPES, f"综述类型：{', '.join(REVIEW_TYPES)}")

    good, good_diag = normalize_review_inputs({"topic": "long context", "reviewType": "scoping", "lookbackDays": "180", "sources": "web", "project": "长上下文"}, contract)
    expect("normalize_valid", not good_diag and good["reviewType"] == "scoping" and good["lookbackDays"] == 180 and good["sources"] == ["openalex", "arxiv", "europepmc", "crossref"], "合法输入归一化 + web 别名展开为 4 个网络来源")
    _, blank = normalize_review_inputs({"topic": "  ", "reviewType": "narrative"}, contract)
    expect("normalize_topic_missing", any(item["code"] == "REVIEW_INPUT_TOPIC_MISSING" for item in blank), "空主题结构化阻断")
    _, bad_type = normalize_review_inputs({"topic": "x", "reviewType": "systematic"}, contract)
    expect("normalize_type_invalid", any(item["code"] == "REVIEW_INPUT_TYPE_INVALID" for item in bad_type), "未知综述类型硬错误（不静默降级为 narrative）")
    _, bad_window = normalize_review_inputs({"topic": "x", "lookbackDays": 100000}, contract)
    expect("normalize_window_invalid", any(item["code"] == "REVIEW_INPUT_WINDOW_INVALID" for item in bad_window), "越界时间窗阻断")
    _, bad_source = normalize_review_inputs({"topic": "x", "sources": "wikipedia"}, contract)
    expect("normalize_sources_invalid", any(item["code"] == "REVIEW_INPUT_SOURCES_INVALID" for item in bad_source), "未知来源名硬错误")
    expect("guard_reused", bool(CORE.guard_path("zotero.sqlite")) and bool(CORE.guard_path(".obsidian/notes.md")), "路径守卫复用：拒绝 zotero.sqlite / .obsidian")

    records, _ = CORE.collect_records(FIXTURE_PAYLOAD, contract=contract)
    deduped = CORE.dedupe_records(records, contract)
    expect("dedupe_reused", len(records) == 4 and len(deduped["records"]) == 2 and len(deduped["duplicates"]) == 1 and len(deduped["dropped"]) == 1, f"去重：{len(records)} → {len(deduped['records'])}（合并 {len(deduped['duplicates'])}，无标识丢弃 {len(deduped['dropped'])}）")

    inputs, _ = normalize_review_inputs({"topic": "long context", "reviewType": "scoping"}, contract)
    diagnostics = []
    draft = extract_review(deduped, inputs, contract, diagnostics)
    expect("extract_rows", draft["counts"]["rows"] == 2 and draft["rows"][0]["cells"]["claim"]["value"] == "未报告", "证据行草稿：claim 默认「未报告」，helper 不生成内容")
    expect("extract_gaps", len(draft["gaps"]) == 2 and all(item["missingFields"] for item in draft["gaps"]), "每行产出缺口登记（缺失字段可核对）")
    expect("extract_fulltext_signal", any(item["code"] == "REVIEW_FULLTEXT_UNAVAILABLE" for item in diagnostics), "无摘要/未读全文的记录触发 REVIEW_FULLTEXT_UNAVAILABLE")

    citations = CORE.citations_from_payload([
        {"ref": "1", "doi": "10.1234/abc.2025.001", "claimedTitle": "Long-context retrieval benchmark", "claimedYear": 2025},
        {"ref": "2", "zoteroKey": "ZZZZ9999"},
    ])
    verified = CORE.verify_citations(citations, records=deduped["records"], contract=contract)
    results, summary = verified[0], verified[1]
    verify_diagnostics = verified[-1]
    expect("verify_offline", [item["status"] for item in results] == ["verified", "unresolvable"] and summary.get("allVerified") is False, f"离线核验：{','.join(item['status'] for item in results)}（未联网核验，不声称全量）")
    retagged = retag(verify_diagnostics)
    expect("verify_codes_retagged", bool(retagged) and all(item["code"].startswith(DIAG_PREFIX + "_") for item in retagged), "核验诊断码统一改写为 REVIEW_ 前缀（不泄出核心前缀）")

    good_lint, _ = lint_review_body(GOOD_BODY, contract)
    expect("lint_good_body", good_lint["lintPassed"], f"合规正文通过：{good_lint['summary']}")
    bad_lint, _ = lint_review_body(BAD_BODY, contract)
    bad_codes = {check["code"] for check in bad_lint["checks"] if check["status"] == "fail"}
    expect("lint_bad_body", not bad_lint["lintPassed"] and {"REVIEW_BODY_FRONTMATTER", "REVIEW_BODY_H1", "REVIEW_BODY_SECTION_MISSING", "REVIEW_BODY_INFERENCE_UNMARKED", "REVIEW_BODY_LEAK"} <= bad_codes, f"违规正文被拦：{', '.join(sorted(bad_codes))}")

    plan = [CORE.build_plan(CORE.source_by_id(contract, source_id), "long context", lookback_days=180, limit=25, contact_email=None, now="2026-01-15T00:00:00Z") for source_id in ("openalex", "crossref")]
    expect("plan_reused", plan[0]["params"]["filter"] == "from_publication_date:2025-07-19" and plan[0]["minIntervalSeconds"] == 1, "检索计划复用核心，按 --now 可复现")
    expect("plan_context_sources", CORE.build_plan(CORE.source_by_id(contract, "zotero"), "x", lookback_days=7, limit=5, contact_email=None, now="2026-01-15T00:00:00Z")["status"] == "context-required", "Zotero/Obsidian 标为需工作台注入上下文")

    module_text = Path(__file__).read_text(encoding="utf-8")
    foreign = [token for token in re.findall(r"\b(?:" + CORE_PREFIX + "|" + DIAG_PREFIX + ")_[A-Z_]+\b", module_text) if not token.startswith(DIAG_PREFIX + "_")]
    expect("diagnostic_prefix_consistency", not foreign, "本 helper 内的诊断码均以 REVIEW_ 开头" if not foreign else f"跨 skill 前缀：{foreign}")
    imports = set(re.findall(r"^(?:import|from)\s+([A-Za-z_][A-Za-z0-9_]*)", module_text, re.MULTILINE))
    expect("helper_stdlib_only", imports <= {"__future__", "argparse", "json", "re", "sys", "pathlib", "litmatrix"}, f"仅标准库 + 本仓库核心：{', '.join(sorted(imports))}")
    auth_header = "auth" + "orization"; secret_prefix = "s" + "k-"
    expect("helper_no_credentials", not re.search("(?i)" + auth_header + r"\s*[=:]", module_text) and secret_prefix not in module_text, "无 Authorization 头、无内置密钥")
    return checks


OVERRIDES = {
    "topic": "topic",
    "review_type": "reviewType",
    "lookback_days": "lookbackDays",
    "sources": "sources",
    "language": "responseLanguage",
    "project": "project",
    "output_folder": "outputFolder",
}
COMMANDS = ("normalize", "plan", "search", "dedupe", "extract", "verify", "lint", "self-test")
LEGACY_MANIFEST = "literature-review-push"


def read_text_file(path):
    if path == "-":
        return sys.stdin.read()
    guard = CORE.guard_path(path, purpose="body")
    if guard:
        return None
    return Path(path).read_text(encoding="utf-8")


def make_parser():
    parser = argparse.ArgumentParser(prog="litreview.py", description="literature-review-push 本地 helper：离线优先、网络可选、免密钥、仅标准库")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in COMMANDS:
        child = sub.add_parser(name, help={"self-test": "离线自检"}.get(name))
        CORE.add_input_args(child)
        child.add_argument("--review-type", help="综述类型：narrative,scoping,systematic-lite,mapping")
        if name in ("search", "dedupe", "extract", "verify"):
            CORE.add_record_args(child)
        if name == "search":
            child.add_argument("--online", action="store_true", help="显式开启联网（默认离线）")
            child.add_argument("--limit", type=int, default=25)
            child.add_argument("--contact-email", help="可选的 OpenAlex polite-pool 邮箱；不填也能用，不会保存")
        if name == "verify":
            child.add_argument("--citations", help="引用列表 JSON（或 - 读 stdin）")
            child.add_argument("--body", help="Markdown 正文（自动抽取引用行）")
        if name == "lint":
            child.add_argument("--body", help="Markdown 正文文件（或 - 读 stdin）")
    return parser


def run_command(args, contract):
    command = args.command
    review = CORE.human_review(contract)

    if command == "self-test":
        checks = run_self_test(contract)
        failures = [check for check in checks if check["status"] == "fail"]
        diagnostics = [CORE.diag("REVIEW_SELF_TEST_FAILED", "failed", check["detail"], next_step="修复对应能力后再交付") for check in failures]
        return CORE.make_envelope(command, "failed" if failures else "ok", data={"checks": checks, "passed": len(checks) - len(failures), "total": len(checks)}, diagnostics=diagnostics, review=review)

    if command == "lint":
        body_path = args.body or "-"
        text = read_text_file(body_path)
        if text is None:
            return CORE.make_envelope(command, "blocked", data={}, diagnostics=[CORE.diag("REVIEW_FORBIDDEN_PATH", "blocked", "正文路径被安全守卫拒绝", next_step="换成仓库内相对路径或 - (stdin)")], review=review)
        result, diagnostics = lint_review_body(text, contract)
        return CORE.make_envelope(command, "blocked" if not result["lintPassed"] else CORE.resolve_status(diagnostics), data=result, diagnostics=diagnostics, coverage={"bodyChars": len(text)}, review=review)

    payload = CORE.read_payload(args.input_json, purpose="input") or {}
    overrides = {target: getattr(args, attribute) for attribute, target in OVERRIDES.items() if getattr(args, attribute, None) is not None}
    inputs, diagnostics = normalize_review_inputs(payload, contract, overrides)
    blocked = CORE.has_severity(diagnostics, "blocked")
    resolved, _ = CORE.resolve_sources(inputs["sources"], contract)

    if command == "normalize":
        return CORE.make_envelope(command, CORE.resolve_status(diagnostics), data={"inputs": inputs, "resolvedSources": resolved, "reviewTypes": list(REVIEW_TYPES), "networkRequires": "--online（默认离线）"}, diagnostics=diagnostics, inputs=inputs, review=review, now=args.now)

    plan = [] if blocked else [CORE.build_plan(CORE.source_by_id(contract, source_id), inputs["topic"], lookback_days=inputs["lookbackDays"], limit=getattr(args, "limit", 25), contact_email=getattr(args, "contact_email", None), now=args.now) for source_id in resolved]
    if command == "plan":
        return CORE.make_envelope(command, CORE.resolve_status(diagnostics), data={"inputs": inputs, "plan": plan, "note": "计划离线可产出；真正请求必须显式 --online"}, diagnostics=diagnostics, inputs=inputs, review=review, now=args.now)
    if blocked:
        return CORE.make_envelope(command, "blocked", data={"inputs": inputs, "plan": plan}, diagnostics=diagnostics, inputs=inputs, review=review, now=args.now)

    cache_dir = CORE.safe_cache_dir(getattr(args, "cache_dir", None), contract)
    context_records, context_diagnostics, _ = CORE.load_records(getattr(args, "context", None), contract)
    extra_records, extra_diagnostics, _ = CORE.load_records(getattr(args, "records", None), contract)
    diagnostics.extend(retag(context_diagnostics + extra_diagnostics))
    requests = []

    if command == "search":
        records, coverage, search_diagnostics, requests = CORE.run_search(plan, contract=contract, cache_dir=cache_dir, online=bool(args.online), no_cache=bool(args.no_cache), timeout=args.timeout, context_records=context_records, now=args.now)
        diagnostics.extend(retag(search_diagnostics))
        availability(coverage, diagnostics)
        deduped = CORE.dedupe_records(records + extra_records, contract)
        if not deduped["records"] and not CORE.has_severity(diagnostics, "failed"):
            diagnostics.append(CORE.diag("REVIEW_EMPTY_RESULT", "warning", "本次时间窗与来源内 0 条候选（合法结果，不是错误）", next_step="放宽时间窗/检索式或补来源后重跑；不得写成领域性结论"))
        data = {"inputs": inputs, "plan": plan, "counts": {"identified": len(records + extra_records), "deduplicated": len(deduped["records"]), "merged": len(deduped["duplicates"]), "dropped": len(deduped["dropped"]), "included": len(deduped["records"])}, "dedupe": deduped, "countRule": "identified/deduplicated/included 必须来自本次实际执行，不得估算"}
        status = CORE.resolve_status(diagnostics, empty=not deduped["records"], degraded=not coverage.get("coverageComplete", False))
    else:
        deduped = CORE.dedupe_records(context_records + extra_records, contract)
        coverage = {"requested": [], "used": sorted({sid for record in deduped["records"] for sid in (record.get("sourceIds") or [])}), "recordsIn": len(context_records + extra_records), "recordsOut": len(deduped["records"]), "coverageComplete": False, "statement": "离线命令不发网络请求：来源状态来自本次注入记录自身，不得写成完整覆盖。"}
        if command == "dedupe":
            data = {"inputs": inputs, "dedupe": deduped, "counts": {"identified": coverage["recordsIn"], "deduplicated": len(deduped["records"]), "merged": len(deduped["duplicates"]), "dropped": len(deduped["dropped"]), "included": len(deduped["records"])}}
            status = CORE.resolve_status(diagnostics, empty=not deduped["records"])
        elif command == "extract":
            if not deduped["records"]:
                diagnostics.append(CORE.diag("REVIEW_EMPTY_RESULT", "warning", "没有可用记录：无从生成证据行草稿", next_step="先用 search 或 --context 取得候选"))
            draft = extract_review(deduped, inputs, contract, diagnostics)
            data = {"inputs": inputs, **draft, "boundary": "草稿必须由人/模型读过证据后填 claim；推断以「推断：」开头并给出依据引用"}
            status = CORE.resolve_status(diagnostics, empty=not draft["rows"])
        else:  # verify
            citations_payload = CORE.read_payload(getattr(args, "citations", None), purpose="citations")
            citations = CORE.citations_from_payload(citations_payload) if citations_payload is not None else []
            body_path = getattr(args, "body", None)
            if body_path:
                body_text = read_text_file(body_path)
                citations.extend(CORE.citations_from_markdown(body_text or ""))
            verified = CORE.verify_citations(citations, records=deduped["records"], contract=contract, now=args.now)
            results, summary = verified[0], verified[1]
            diagnostics.extend(retag(verified[-1]))
            data = {"inputs": inputs, "summary": summary, "results": results, "boundary": "离线核验：只比对本次记录集（不解析 DOI/PMID 到外部库）；unresolvable 不等于引用造假，但不得作为已核实引用"}
            status = CORE.resolve_status(diagnostics, empty=not citations)
    manifest_dir = getattr(args, "manifest_dir", None)
    if manifest_dir:
        CORE.write_manifest(manifest_dir, f"{LEGACY_MANIFEST}-{command}.json", {"skillKey": SKILL_KEY, "command": command, "data": data, "diagnostics": diagnostics, "coverage": coverage, "requests": requests})
    return CORE.make_envelope(command, status, data=data, diagnostics=diagnostics, coverage=coverage, inputs=inputs, network={"online": bool(getattr(args, "online", False)), "requests": requests, "credentialsUsed": False}, review=review, now=args.now)


def main(argv=None):
    args = make_parser().parse_args(argv)
    contract = load_contract()
    try:
        envelope = run_command(args, contract)
    except CORE.ContractError as error:
        envelope = CORE.make_envelope(args.command, "blocked", data={}, diagnostics=[CORE.diag("REVIEW_RUN_FAILED", "blocked", f"合同/参数错误：{error}", next_step="检查合同文件与参数后重试")], review=CORE.human_review(contract), now=getattr(args, "now", None))
    except Exception as error:  # noqa: BLE001 - 失败必须结构化，不能静默
        envelope = CORE.make_envelope(args.command, "failed", data={}, diagnostics=[CORE.diag("REVIEW_RUN_FAILED", "failed", f"{type(error).__name__}: {error}", next_step="用 self-test 定位失败步骤后再交付")], review=CORE.human_review(contract), now=getattr(args, "now", None))
    return CORE.emit(envelope)


if __name__ == "__main__":
    raise SystemExit(main())
