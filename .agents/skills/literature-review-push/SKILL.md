---
name: literature-review-push
version: "1.0.0"
description: "按指定主题、综述类型、时间范围、来源与语言生成中文（可配置）证据链综述推送，严格区分事实、推断、缺口与引用，逐条可核对；不直接写入 Zotero/Obsidian，不自动投稿或发信。"
argument-hint: 'literature-review-push 主题="长上下文检索" 类型=narrative 时间=180天 来源=zotero,obsidian,web 语言=zh-CN'
allowed-tools: Read, Grep, Glob, Bash, Write
user-invocable: true
license: Project-owned (this repository)
metadata:
  workbench:
    skillKey: literature-review-push
    availability: shipped
    sourceDirectory: .agents/skills/literature-review-push
    catalogEntry: packages/contracts/src/research.ts (AGENT_SCHEDULE_SKILL_CATALOG)
    registryModule: packages/workspace-service/src/skill-registry.ts
    requiredInputs:
      - topic
      - reviewType
      - lookbackDays
      - sources
      - responseLanguage
      - project
      - outputFolder
    defaultResponseLanguage: zh-CN
    responseLanguages:
      - zh-CN
      - en
    reviewTypes:
      - narrative
      - scoping
      - mapping
      - systematic-lite
    outputs:
      - artifactMarkdown
    externalWrites: none
    writesToZotero: false
    writesToObsidian: false
    networkAccess: optional
---

# literature-review-push — 指定主题的证据链综述推送

把一个「主题 + 综述类型 + 时间窗 + 来源集合」变成一篇中文（可配置）的证据链综述：**每个事实性陈述都能追到具体文献与出处，每一条推断都标为推断，每一个缺口都说明为什么是缺口，每一处引用都真实可解析**。正文交给工作台既有的 Artifact / Obsidian 投影流程落盘。

## 何时使用

- 用户要求「写一篇关于 X 的综述/文献回顾/研究现状」「总结这个方向的证据链」「这个主题上已知什么、还不知道什么」，并且要求可核对引用。
- 需要按主题、时间窗和来源集合产出一篇可推送的正文（定时推送或手工执行）。

## 何时不要使用

- 需要的是逐篇横向对比表（方法-数据-结论字段矩阵）→ 使用 `literature-matrix`。
- 需要的是「近 30 天社区讨论/资讯」→ 使用 `last30days`。
- 需要写进 Zotero/Obsidian 库内部结构（条目、标签、集合、笔记元数据）→ 不属于本 skill；必须走工作台对应的写入入口与确认流程。

## 输入参数

| 参数 | 必填 | 默认 | 语义与校验 |
| --- | --- | --- | --- |
| `topic` | 是 | 无 | 综述主题，非空、去首尾空白、≤200 字符。缺失 → `REVIEW_INPUT_TOPIC_MISSING`，阻断并且不产出正文。 |
| `reviewType` | 否 | `narrative` | `narrative` / `scoping` / `mapping` / `systematic-lite`。非白名单取值 → `REVIEW_INPUT_TYPE_INVALID`（不静默降级成叙述式）。 |
| `lookbackDays` | 否 | `180` | 回看天数，整数 `1..365`。越界 → `REVIEW_INPUT_WINDOW_INVALID`。 |
| `sources` | 否 | `[]` = 全部当前可用来源 | 小写来源名列表，最多 24 项、去重。不可用来源只记入覆盖状态，不得替换成编造来源。 |
| `responseLanguage` | 否 | `zh-CN` | 正文语言，仅 `zh-CN` / `en`（与 `AgentResponseLanguageSchema` 同一合同）。 |
| `project` | 否 | 无 | 项目上下文。只使用本次运行**显式注入**的文献上下文（工作台在 prompt 中给出被选中的文献 ID/标题并记录 `run:context`）；不得隐式遍历整个项目库。 |
| `outputFolder` | 否 | `每日资讯推送` | 正文落盘的 Vault 相对目录；校验由工作台合同负责（禁止绝对路径、`..`、空组件、`.obsidian`、保留设备名与控制字符）。本 skill 不自行建目录、不写文件。 |

输入字段与定时规则共享同一份合同（`AgentScheduleSkillRequiredInputSchema`）。以本次注入的规则值为准，不要读 UI 标签或对话历史里的旧值。

## 综述类型要求

| 类型 | 允许的写法 | 必须避免 |
| --- | --- | --- |
| `narrative` | 按脉络组织证据；允许叙述性衔接，但每个事实性句子都要有引用 | 把叙述当成检索协议；声称"全面覆盖" |
| `scoping` | 明确研究问题、范围边界、纳入/排除标准，统计"研究了多少篇、什么类型" | 给出效应量或确定性结论 |
| `mapping` | 按主题×方法（或问题×证据类型）交叉统计分布，指出空白格 | 用分布图代替结论 |
| `systematic-lite` | 报告检索式、时间窗、来源、去重后条数、筛选步骤与排除理由（**不声称**是 PRISMA 合规系统综述） | 声称已做完整系统综述/元分析；隐瞒未做全文筛选 |

类型只是报告结构，不改变证据标准：**任何类型都不得把"没有找到证据"写成"没有证据"。**

## 执行流程

1. **解析输入**：归一化并按上表校验；`topic` 缺失或 `reviewType` 非法立即阻断。
2. **能力预检**：确定本次实际可用的来源与文献上下文范围。预检失败（无来源/无网络/无权限）→ `REVIEW_SOURCES_UNAVAILABLE`，不产出正文。
3. **取证**：只在可用来源内检索/读取，逐条记录可复现出处（DOI、PMID、arXiv ID、Zotero item key、URL 或注入上下文论文 ID）。
4. **去重与分级**：同一文献按 `DOI → PMID → arXiv ID → Zotero item key → (标题+年份+第一作者)` 归一。**按证据强度分级**：原始研究 > 系统综述/元分析 > 预印本 > 观点/评论 > 二手报道，并在正文中标注每条证据的层级。
5. **组织证据链**：每条事实性陈述写 `结论 + 证据（引用） + 限制（原文自述）`。推断必须使用显式标记（见下）。
6. **分离事实 / 推断 / 缺口**：
   - **事实**：来源直接支持的陈述，紧跟引用；引用必须包含持久标识。
   - **推断**：跨证据的综合判断，句子必须以「推断：」开头并说明依据哪些引用、以及不确定性来源；不得把推断写成事实。
   - **缺口**：明确写出「为什么这是缺口」（没有研究 / 只有单一小型研究 / 只覆盖单一语言或单一数据集 / 相互矛盾），并给出可验证的下一步（需要什么数据或什么研究设计）。
7. **生成正文**：按「输出契约」输出 Markdown；对每一条引用给出可核对条目。
8. **落盘**：正文即本次运行的最终回答，由工作台投影写 Artifact / Inbox / Obsidian；本 skill 不写外部文件。
9. **自检**：执行「自检清单」，不过则修正后重出一次，仍不过则如实标注。

## 证据与引用要求

- 每个事实性断言后必须有 `(第一作者 et al., 年份 · 标识符)` 形式的引用；标识符必须是本次证据里真实出现的 DOI/PMID/arXiv ID/Zotero key/URL。
- **不得伪造引用**：不生成、不补全、不猜测 DOI / URL / 作者 / 期刊 / 卷期 / 页码 / 年份 / 样本量 / 效应量；不给不存在的研究编造标题；不把摘要里的话写成全文结论。
- **不得伪造成熟度**：不把预印本、单一数据集结果、动物实验或小样本研究写成领域共识；不省略原文自述的限制条件。
- 只使用本次证据与本次注入的文献上下文；不得引用模型记忆、常识或未在证据中出现的文献。找不到证据的陈述，要么删除，要么降级为「缺口」并说明。
- **缺失字段写「未报告」**：原文没有报告样本量、效应量、数据可得性等字段时，写「未报告」，不要用 `0`、`N/A`、`无`、`待补`、`约` 这类占位或近似值代替。
- 引用的粒度要求：一个引用块最多支撑一句话；一段结论需要多篇支撑时逐条列出，不要写「多项研究表明」而不给引用。
- 计数必须真实：`systematic-lite` / `scoping` / `mapping` 里报告的检索条数、去重后条数、纳入条数必须来自本次实际执行，不得估算。

## 输出契约（Artifact / Obsidian 投影）

- 只输出**正文**（Markdown）。不要写 YAML frontmatter、不要写 `#` 一级标题、不要写来源页脚：投影层会写入 `workbench_*` frontmatter、标题和来源行。
- 正文以 `##` 小节开始，按此顺序：`## 综述问题与范围`、`## 覆盖与来源状态`、`## 证据主线`、`## 事实与推断`、`## 研究缺口`、`## 引用清单`。
  - `## 事实与推断` 用两组条目分列：事实每条带引用；推断每条以「推断：」开头并写明依据引用与不确定性。
  - `## 研究缺口` 每条给出「缺口陈述 + 判定依据 + 可验证的下一步」。
  - `## 引用清单` 逐条列出所有引用（第一作者·年份·标识符·来源），按正文出现顺序排列。
- 语言：`zh-CN`（默认）写简体中文正文；`en` 写英文正文。两种语言都逐字保留原始标题、作者名、期刊/会议名、标识符与 URL，不翻译、不改写。
- **正文前 4,000 字符必须自包含**：SQLite Artifact / Inbox 只保留有界摘录（上限 4,000 字符），完整正文只存在于 Obsidian note 与本次运行输出。综述摘要、覆盖状态与主要事实必须落在前 4,000 字符内。
- 不得把工具日志、命令行回显、绝对路径、凭据类内容写进正文；也不要在正文里粘贴大段原文（引用原文片段时长度有界并标注出处）。

## 空结果 / 来源降级 / 失败语义

| 情况 | 判定 | 正文写法 | 诊断码 |
| --- | --- | --- | --- |
| 主题合法但 0 篇证据 | 合法结果，**不是失败** | 明确写「本次时间窗与来源内未检索到可引用的证据」，列出来源/时间窗/检索式，并给放宽建议；**不得写成「无相关研究」** | `REVIEW_EMPTY_RESULT` |
| 部分来源不可用 | 降级运行 | `## 覆盖与来源状态` 逐条列出可用/不可用来源，声明「部分覆盖，结论仅代表已覆盖来源」 | `REVIEW_SOURCE_DEGRADED` |
| 全部来源不可用或预检失败 | 阻断 | 不产出正文，只输出失败说明与修复建议 | `REVIEW_SOURCES_UNAVAILABLE` |
| 只有摘要、无全文 | 降级运行 | 每条证据标注 `证据：摘要`，结论只写摘要能支持的强度 | `REVIEW_FULLTEXT_UNAVAILABLE` |
| 引用缺持久标识或不可解析 | 丢弃并计数，或降级为缺口 | 不把无法解析的引用写进 `## 引用清单`；丢弃条数写进覆盖状态 | `REVIEW_CITATION_UNVERIFIED` |
| 主题缺失 / 综述类型非法 / 时间窗非法 | 阻断 | 不产出正文，指出非法字段与合法取值 | `REVIEW_INPUT_TOPIC_MISSING` / `REVIEW_INPUT_TYPE_INVALID` / `REVIEW_INPUT_WINDOW_INVALID` |
| 检索或读取本身失败（网络、权限、工具不可用） | 失败 | 如实说明失败原因与修复建议；**不得用记忆或旧稿拼一篇综述** | `REVIEW_RUN_FAILED` |
| 被要求自动投稿/发信/上传 | 拒绝 | 说明边界，只产出正文交给用户决定 | `REVIEW_EXTERNAL_WRITE_REFUSED` |

**空结果、降级和失败都必须在正文里可见**，且不得把「没找到」写成领域性结论。

## 安全边界

- 不自动投稿、不发邮件、不发消息、不上传、不发布、不调用任何外部写入接口；推送只发生在工作台内的 Artifact / Inbox / Obsidian 投影。任何对外交付都必须由用户显式操作。
- 不写 Zotero、不写 Obsidian 库内部结构、不触碰 `.obsidian/`、`zotero.sqlite`、凭据或系统配置。
- 不读、不复制、不输出凭据类内容（API key、token、cookie、`.env`、连接记录密文）；不把凭据写进正文或日志。
- 不安装任何工具（pip/npm/pnpm/brew/apt），不改网络/代理配置，不运行首次配置向导，不交互式等待输入。
- 不声称学术合规：除非用户明确提供检索协议与筛选记录，否则不把输出描述为 PRISMA 合规或已注册的系统综述。
- 不声称「已导入 Zotero」「已写入 Vault」：本 skill 不产生任何外部写入结果。

## 自检清单（输出前必过）

1. 每个事实性句子都有可解析引用；引用清单与正文引用逐条一一对应。
2. 每条推断都以「推断：」标记，并写明依据引用与不确定性；事实与推断没有混排。
3. 每个缺口都写明判定依据与可验证的下一步；没有把「未检索到」写成「不存在」。
4. 引用清单里的每一条都来自本次证据，无编造 DOI/作者/年份/期刊/样本量。
5. 计数（检索条数/去重后条数/纳入条数）与本次实际执行一致；未做全文筛选已如实声明。
6. 覆盖状态与实际使用来源一致；降级已声明为部分覆盖，`证据：摘要` 已标注。
7. 正文没有 YAML frontmatter、没有 `#` 一级标题、没有绝对路径、没有凭据、没有工具日志。
8. 语言符合 `responseLanguage`（默认 `zh-CN`），原始标题/作者/期刊/URL 逐字保留。
9. 前 4,000 字符包含综述问题、覆盖状态与主要事实。

## 诊断输出

阻断或失败时，正文只包含一个结构化失败块（不要附带半成品综述），字段固定：

```text
状态: 阻断
诊断码: REVIEW_INPUT_TOPIC_MISSING
消息: 缺少主题：综述需要一个明确的主题才能检索
输入: 本次归一化后的参数（主题/类型/时间窗/来源/语言/项目/输出目录）
证据: 本次实际探测到的来源可用性与候选条数（无则写「未开始检索」）
下一步: 需要用户提供的一个动作（例如：给出主题或综述类型）
```

规则：

- 诊断码只用本文件列出的取值，不发明新码；不把失败写成成功，也不生成占位综述。
- 诊断信息只写相对路径或 `%REPO%/…` 形式，不写用户绝对路径。
- 真实联网检索与真实模型运行是否成功必须由运行输出证明；本 skill 的版本与结构通过不代表端到端已验证。

## 本地 helper（离线可执行，网络可选）

`.agents/skills/literature-review-push/` 自带一个机械层 helper，把本文档的规则变成本机可跑、可核对的操作；它**不写正文、不做文献判断**，只输出 JSON 信封：

- `scripts/litreview.py`（仅 Python 标准库；`python scripts/litreview.py self-test` 是离线冒烟，当前 22 项全过，退出码 0）。
- `schema/contract.json`（机器可读合同：输入/综述类型/来源/去重顺序/证据行字段/投影/诊断码/缓存/安全/人工核验边界）。
- 复用唯一机械核心 `.agents/skills/literature-matrix/scripts/litmatrix.py`（不复制第二份实现；构建镜像整树复制，打包后同级仍可解析），只改写诊断前缀。
- 子命令：`normalize`、`plan`、`search`、`dedupe`、`extract`、`verify`、`lint`、`self-test`；状态 `ok|empty|degraded|blocked|failed` 对应退出码 `0|0|0|1|2`；`--now` 固定时间戳保证可复现。

规则：

- **`reviewType` 硬校验**：只接受 `narrative`、`scoping`、`systematic-lite`、`mapping`；缺省是 `narrative`，未知类型一律阻断（`REVIEW_INPUT_TYPE_INVALID`），不静默降级。
- **默认离线**：只有显式 `--online` 才访问公开 API（OpenAlex / arXiv / Europe PMC / Crossref，四者均免密钥）。不需要也不保存任何 API key；不读环境变量里的凭据，不发 `Authorization` 头，不读 `~/.pi`。
- **缓存与写入**：只写 `--cache-dir` / `--manifest-dir`（默认操作系统缓存目录 `prw-literature-cache/literature-review-push`），永不写仓库、Vault、Zotero 或工作台数据库。
- **只读边界**：helper 拒绝 `zotero.sqlite`、`*.sqlite`、`.obsidian/**`、`.env*`、`~/.pi/**`（`REVIEW_FORBIDDEN_PATH`）；Zotero/Obsidian 条目只接受工作台在运行时注入的记录。
- **`extract` 只产草稿**：`claim`、样本量、限制、缺口一律 `未报告` + `unreported`；`证据层级` 由 helper 给「摘要/元数据」，**全文只能由真正读过全文的人改写**；无摘要且未读全文的记录标 `REVIEW_FULLTEXT_UNAVAILABLE`。
- **`verify` 是离线引用核验**：只比对本次记录集，不联网解析 DOI/PMID；`unresolvable` 不等于引用造假，但不得写成已核实。
- **`lint` 校验投影合同**：frontmatter、一级标题、`##` 小节集合与顺序、前 4,000 字符自包含（含至少一条带持久标识的引用行）、`推断：` 前缀、占位符、覆盖状态声明、绝对路径/凭据/工具日志。

helper 使用的诊断码（仍为 `REVIEW_` 前缀，含义同上文语义表）：`REVIEW_SOURCES_UNAVAILABLE`、`REVIEW_FULLTEXT_UNAVAILABLE`、`REVIEW_EMPTY_RESULT`、`REVIEW_CITATION_UNVERIFIED`、`REVIEW_CITATION_MISMATCH`（由核验入口给出）、`REVIEW_INPUT_TOPIC_MISSING`、`REVIEW_INPUT_TYPE_INVALID`、`REVIEW_INPUT_WINDOW_INVALID`、`REVIEW_INPUT_SOURCES_INVALID`、`REVIEW_INPUT_LANGUAGE_INVALID`、`REVIEW_FORBIDDEN_PATH`、`REVIEW_CORE_MISSING`、`REVIEW_RUN_FAILED`、`REVIEW_SELF_TEST_FAILED`、`REVIEW_BODY_FRONTMATTER`、`REVIEW_BODY_H1`、`REVIEW_BODY_SECTION_MISSING`、`REVIEW_BODY_SECTION_ORDER`、`REVIEW_BODY_EXCERPT_INCOMPLETE`、`REVIEW_BODY_INFERENCE_UNMARKED`、`REVIEW_BODY_PLACEHOLDER`、`REVIEW_BODY_COVERAGE_MISSING`、`REVIEW_BODY_LEAK`、`REVIEW_BODY_CITATION_MISSING`。

## 注册状态与版本

- 版本：`1.0.0`。唯一源文件：`.agents/skills/literature-review-push/SKILL.md`（`.agents/skills` 是全部 skill 的唯一手工维护源目录；`resources/skills` 只是构建时镜像）。
- 本构建中该 key 在排程合同里标记为 `shipped`：**已注册指令型执行合同**（`packages/workspace-service/src/skill-registry.ts`）。合同内容：运行时（Agent runtime）从 `.agents/skills/literature-review-push/SKILL.md`（或打包镜像 `resources/skills/literature-review-push/SKILL.md`）读取本文件全文并**逐步执行**；本 skill 没有本地引擎/解释器，也不会被复制到第二个源目录。注册表在注入前会校验：路径位于该 skill 目录内（拒绝绝对路径/`..` 穿越）、frontmatter `name` 与 skillKey 一致、正文非空且未超可注入上限；任一不通过则整次运行结构化阻断（`SKILL_MISSING` / `SKILL_FILE_UNSAFE` / `SKILL_FILE_INVALID`），不会退化为通用工作流。
- 输出路径：最终回答只包含**正文**；由工作台现有的 Artifact / Inbox / Obsidian 投影流程落盘（frontmatter、标题、来源行由投影层写入）。本 skill 不直接写 Zotero/Obsidian。
- 排程器里显示为**已安装可选择**；选中后运行会注入本文件全文、规则的主题/来源/回看天数/输出目录与语言规则。
- **IN_REVIEW**：已验证的只有（离线）skill 结构、registry 解析/阻断、注入文本与编辑器可选状态（`pnpm test:literature-skills`）。**真实模型运行与真实联网检索从未执行**：在一次真实运行产出带证据的正文并落到 Artifact/Obsidian 之前，不得声称该 skill 已端到端验收。任何 Agent runtime 也可直接读取并手工执行本文件。
