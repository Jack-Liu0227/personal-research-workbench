# Task 07 — literature-matrix skill

## 范围

新增可注册 `literature-matrix` skill，源文件直接放在 `.agents/skills/literature-matrix/`。所有 Agent runtime 从 `.agents/skills` 读取；打包资源只能由该源目录构建镜像。输入为指定主题、时间范围、来源和字段模板；输出为带证据、引用、比较字段和项目分类的文献矩阵推送。

## 安全

不直接写 Zotero/Obsidian；正文通过现有 Artifact/Obsidian 投影流程，外部写入仍由 IntegrationCoordinator 管理。

## 注册状态（Task 07 收尾）

- 排程合同：`AGENT_SCHEDULE_SKILL_CATALOG` 中 `availability: 'shipped'`（此前 `reserved`）；regsitry 常量 `LITERATURE_{MATRIX,REVIEW_PUSH}_SKILL_KEY`。
- 执行合同（指令型，无本地引擎）：`skill-registry.ts` 新增 `INSTRUCTION_SKILL_KEYS` / `InstructionSkillRuntime` / `resolveInstructionSkill`，由 Agent runtime 读取并逐步执行 `.agents/skills/<key>/SKILL.md`（Pi 走 `--skill`，两种 runtime 都在 prompt 里注入全文）。不复制调度逻辑：仍复用 `resolveAgentSkill` → 统一 run ledger / skillSnapshot / Artifact+Inbox+Obsidian 投影。
- 安全校验（注入前，结构化阻断）：路径必须位于该 skill 目录内（拒绝绝对路径/盘符/`..`/空组件 → `SKILL_FILE_UNSAFE`）；frontmatter `name` 必须等于 skillKey 且正文非空、未超 400k 字符（→ `SKILL_FILE_INVALID`）；文件缺失 → `SKILL_MISSING`。未知 skill 仍为 `SKILL_UNSUPPORTED`。
- 镜像：`resources/skills/<key>` 仅由构建从 `.agents/skills` 生成，仓库内无第二份手工副本。
- 已验证（离线，2026-09-13 会话内实测）：`node scripts/literature-skills-smoke.cjs` → **25 passed, 0 failed, 0 blocked**（原 21 项结构/registry/注入/阻断/镜像 + 新增 4 项 helper 检查：合同可解析且 `skillKey`/`diagnosticPrefix` 一致、四路网络来源 `auth=none`、合同禁用 `zotero.sqlite`、两个 helper 的 `self-test` 必须 `status=ok` 且无跳 skill 诊断码）。helper 自身：`python scripts/litmatrix.py self-test` → **38/38 passed**。
- **未运行**：`pnpm typecheck`、`pnpm test:literature-skills`、`pnpm test:last30days`（本次会话运行器禁止子进程落盘/写仓库，故未能执行；已用直接 node/python 进口替代）。
- **IN_REVIEW**：真实模型运行的端到端输出与真实联网检索均未完成全量验证；在一次真实运行产出带证据正文并落到 Artifact/Obsidian 之前，不视为端到端验收。

## 联网增强（用户需求 7）

- 新增文件：`scripts/litmatrix.py`（Python 标准库，无第三方依赖；子命令 `normalize|plan|search|dedupe|extract|verify|lint|self-test`，状态 `ok|empty|degraded|blocked|failed` → 退出码 `0|0|0|1|2`），`schema/contract.json`（输入/来源/去重顺序/矩阵字段/投影/诊断码/缓存/安全/人工核验边界）。
- 联网范围：OpenAlex / arXiv / Europe PMC / Crossref，四者均免密钥（`auth: none`）；默认离线，仅 `--online` 发请求；不需要也不保存 API key，不读环境变量凭据，不发 `Authorization` 头，不读 `~/.pi`；只写 `--cache-dir`/`--manifest-dir`（默认 `%LOCALAPPDATA%\prw-literature-cache\literature-matrix`，在仓库外）。
- 已实测的离线行为（exit 0 / 1 已核对）：`plan --sources web --now …` → 4 个来源且确定性；`normalize --topic "  " --sources wikipedia` → exit 1（`MATRIX_INPUT_TOPIC_MISSING` + `MATRIX_INPUT_SOURCES_INVALID`）；`extract --context -` → 2 行×11 列、12 个 `未报告` 单元格；`lint` 对合规正文 `ok`、对含 frontmatter/一级标题/绝对路径/漏推断前缀的正文 `blocked`。
- 受限真实网络探测（1 次，保留来源+失败状态）：`search --online --sources openalex,europepmc,arxiv,crossref --limit 3 --lookback-days 365 --timeout 25` → Europe PMC 200、Crossref 200（6 条），OpenAlex **429**（`MATRIX_SOURCE_RATE_LIMITED`），arXiv **400**（`MATRIX_SOURCE_REQUEST_INVALID`，随后修正参数编码），整体 `degraded` 且 `coverageComplete=false`——失败未被当作空结果。
- 人为边界：`extract` 只产草稿（方法/数据/结论/限制/关联均 `未报告`），`verify` 仅离线比对本次记录集（不联网解析 DOI/PMID）；每条引用、每个 `未报告` 仍需人工核对。
