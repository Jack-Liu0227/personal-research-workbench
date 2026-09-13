# Task 07 — literature-review-push skill

## 范围

新增可注册 `literature-review-push` skill，源文件直接放在 `.agents/skills/literature-review-push/`。所有 Agent runtime 从 `.agents/skills` 读取；打包资源只能由该源目录构建镜像。输入为指定主题、综述类型、时间范围、来源和语言；输出为中文或指定语言的证据链综述推送，区分事实、推断、缺口和引用。

## 安全

不自动投稿、不发邮件、不伪造引用、不绕过 Zotero/Obsidian 边界；通过统一 Agent ledger、Artifact 和投影流程交付。

## 注册状态（Task 07 收尾）

- 排程合同：`AGENT_SCHEDULE_SKILL_CATALOG` 中 `availability: 'shipped'`（此前 `reserved`）；regsitry 常量 `LITERATURE_{MATRIX,REVIEW_PUSH}_SKILL_KEY`。
- 执行合同（指令型，无本地引擎）：`skill-registry.ts` 新增 `INSTRUCTION_SKILL_KEYS` / `InstructionSkillRuntime` / `resolveInstructionSkill`，由 Agent runtime 读取并逐步执行 `.agents/skills/<key>/SKILL.md`（Pi 走 `--skill`，两种 runtime 都在 prompt 里注入全文）。不复制调度逻辑：仍复用 `resolveAgentSkill` → 统一 run ledger / skillSnapshot / Artifact+Inbox+Obsidian 投影。
- 安全校验（注入前，结构化阻断）：路径必须位于该 skill 目录内（拒绝绝对路径/盘符/`..`/空组件 → `SKILL_FILE_UNSAFE`）；frontmatter `name` 必须等于 skillKey 且正文非空、未超 400k 字符（→ `SKILL_FILE_INVALID`）；文件缺失 → `SKILL_MISSING`。未知 skill 仍为 `SKILL_UNSUPPORTED`。
- 镜像：`resources/skills/<key>` 仅由构建从 `.agents/skills` 生成，仓库内无第二份手工副本。
- 已验证（离线，2026-09-13 会话内实测）：`node scripts/literature-skills-smoke.cjs` → **25 passed, 0 failed, 0 blocked**（新增 4 项 helper 检查，两个 skill 各 2 项）；review helper 自身：`python scripts/litreview.py self-test` → **22/22 passed**。
- **未运行**：`pnpm typecheck`、`pnpm test:literature-skills`、`pnpm test:last30days`（本次会话运行器禁止子进程落盘/写仓库，无法执行；已用直接 node/python 进口替代）。
- **IN_REVIEW**：真实模型运行的端到端输出与真实联网检索均未完成全量验证；在一次真实运行产出带证据正文并落到 Artifact/Obsidian 之前，不视为端到端验收。

## 联网增强（用户需求 7）

- 新增文件：`scripts/litreview.py`（Python 标准库；子命令 `normalize|plan|search|dedupe|extract|verify|lint|self-test`，状态 → 退出码与 matrix 一致的 `0|0|0|1|2`）、`schema/contract.json`（输入含 `reviewType`：`narrative|scoping|systematic-lite|mapping`，未知类型硬阻断）。
- **不复制机械核心**：`litreview.py` 直接复用 `.agents/skills/literature-matrix/scripts/litmatrix.py`（唯一核心），仅改写诊断前缀为 `REVIEW_*`；构建镜像整树复制 `.agents/skills`，因此打包后同级路径仍可解析。smoke 会校验两边的诊断前缀无跳 skill 泄漏。
- 已实测的离线行为：`normalize`（`web` 别名展开为 4 个网络来源；空主题/未知综述类型/越界时间窗/未知来源 4 个诊断均 `blocked`，exit 1）；`plan`（`openalex`/`crossref` `planned`，`zotero` → `context-required`）；`extract --context -` → 2 行草稿，`claim` = `未报告`，`REVIEW_FULLTEXT_UNAVAILABLE`；`verify --citations -` → 未落地记录集引用 `REVIEW_CITATION_UNVERIFIED`（离线，不声称已核实）；`lint` 对合规正文 `ok`（前 4,000 字符含范围/覆盖/引用行）、对含 frontmatter/一级标题/缺小节/绝对路径/漏推断前缀的正文 `blocked`（7 项 fail）。
- 联网范围与边界：与 matrix 相同的四个免密钥来源，默认离线，仅 `--online` 发请求；缓存默认 `%LOCALAPPDATA%\prw-literature-cache\literature-review-push`（仓库外）；不读 `zotero.sqlite`/`.obsidian`/`.env*`/`~/.pi`；不自动投稿、不发信、不写 Zotero/Obsidian。本次**未**对 review skill 单独发起真实网络探测（网络路径与 matrix 同代码同参数，已由 matrix 侧探测覆盖）。
- 计数诚实：`identified/deduplicated/included` 只来自本次实际执行；`search` 不完整时 `coverageComplete=false` 并要求正文声明「部分覆盖」。
