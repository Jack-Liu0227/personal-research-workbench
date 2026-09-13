---
name: literature-matrix
version: "1.0.0"
description: "按指定主题、时间范围、来源与字段模板生成带证据和引用的文献矩阵推送（Markdown 正文），用于横向比较同一主题下的方法、数据、样本与结论，并给出项目分类；不直接写入 Zotero/Obsidian。"
argument-hint: 'literature-matrix 主题="长上下文检索" 时间=90天 来源=zotero,obsidian,web 语言=zh-CN 项目=长上下文 输出=每日资讯推送'
allowed-tools: Read, Grep, Glob, Bash, Write
user-invocable: true
license: Project-owned (this repository)
metadata:
  workbench:
    skillKey: literature-matrix
    availability: shipped
    sourceDirectory: .agents/skills/literature-matrix
    catalogEntry: packages/contracts/src/research.ts (AGENT_SCHEDULE_SKILL_CATALOG)
    registryModule: packages/workspace-service/src/skill-registry.ts
    requiredInputs:
      - topic
      - lookbackDays
      - sources
      - responseLanguage
      - project
      - outputFolder
      - fieldTemplate
    defaultResponseLanguage: zh-CN
    responseLanguages:
      - zh-CN
      - en
    outputs:
      - artifactMarkdown
    externalWrites: none
    writesToZotero: false
    writesToObsidian: false
    networkAccess: optional
---

# literature-matrix — 指定主题的文献矩阵推送

把一个「主题 + 时间窗 + 来源集合」变成一张可核对的 Markdown 文献矩阵：**每一行是一篇真实存在的文献，每一列是一个可比较字段，每个单元格要么带证据，要么明确写「未报告」**。矩阵的正文交给工作台既有的 Artifact / Obsidian 投影流程落盘，本 skill 自己不写任何外部库。

## 何时使用

- 用户要求「按主题横向对比一批文献」「做一张文献矩阵/对比表/字段表」「把某个主题下最近的论文按方法-数据-结论排开」。
- 输出需要保留可追溯的证据与引用，且需要区分「原文报告了什么」与「矩阵里的比较字段」。

## 何时不要使用

- 需要的是叙述性综述、研究缺口分析或证据链串联 → 使用 `literature-review-push`。
- 需要的是「近 30 天社区讨论/资讯」→ 使用 `last30days`。
- 需要抓取、导入或改写 Zotero 条目（写库、加标签、建集合）→ 不属于任何 skill；必须走 Zotero 能力探测 + 预览 + 显式确认 + revision/CAS 的写入入口。

## 输入参数

| 参数 | 必填 | 默认 | 语义与校验 |
| --- | --- | --- | --- |
| `topic` | 是 | 无 | 矩阵主题，非空、去首尾空白、≤200 字符。缺失或为空 → `MATRIX_INPUT_TOPIC_MISSING`，**阻断并且不产出矩阵**（不许自行猜测或放宽主题）。 |
| `lookbackDays` | 否 | `30` | 检索回看天数，整数 `1..365`。越界或非整数 → `MATRIX_INPUT_WINDOW_INVALID`。 |
| `sources` | 否 | `[]` = 全部当前可用来源 | 小写来源名列表（与工作台/引擎的来源标识一致），最多 24 项、去重。空列表表示「使用当前所有可用来源」。请求了但不可用的来源只能记入覆盖状态，不得替换成编造的来源。 |
| `responseLanguage` | 否 | `zh-CN` | 正文语言，取值仅 `zh-CN` / `en`（与 `AgentResponseLanguageSchema` 同一合同）。 |
| `project` | 否 | 无 | 项目上下文。只使用本次运行**显式注入**的文献上下文（工作台会在 prompt 里给出被选中的文献 ID/标题，并在 run ledger 记录 `run:context`）；不得隐式遍历项目的全部论文库。 |
| `outputFolder` | 否 | `每日资讯推送` | 正文落盘的 Vault 相对目录。校验由工作台合同负责（禁止绝对路径、`..` 穿越、空组件、`.obsidian`、保留设备名与控制字符）；本 skill 不得自行创建目录或写文件。 |
| `fieldTemplate` | 否 | 默认字段集（见「矩阵字段模板」） | 只允许**增加/裁剪可选列**；`标识`、`证据`、`引用` 三类列不可删除。 |

`topic`、`lookbackDays`、`sources`、`responseLanguage` 与工作台定时规则共享同一份输入合同（`AgentScheduleSkillRequiredInputSchema`：`topic` / `sources` / `lookbackDays` / `outputFolder`）。运行参数以本次注入的规则为准，不要读 UI 标签或历史对话里的旧值。

## 执行流程

1. **解析输入**：按上表归一化参数。`topic` 为空立即以 `MATRIX_INPUT_TOPIC_MISSING` 失败（见「诊断输出」），不要先检索再补主题。
2. **能力预检**：先确认本次到底有哪些来源可用（注入的文献上下文、本次运行目录里的检索结果、可用来源报告）。这一步只决定「覆盖范围」，不允许为了凑满矩阵而伪造来源。
3. **取证**：只在可用来源内检索/读取。每个候选项必须留下可复现的出处（DOI、PMID、arXiv ID、Zotero item key、URL，或注入上下文里的论文 ID）。
4. **去重与同一性判定**：同一篇文献按 `DOI → PMID → arXiv ID → Zotero item key → (标题+年份+第一作者)` 顺序归一，只保留一条最优记录。**五个标识全部拿不到的条目不得进入矩阵**（计入 `MATRIX_EVIDENCE_INSUFFICIENT` 的丢弃计数）。
5. **逐列填充**：按字段模板逐列填写。只写来源或注入上下文里真实存在的内容；原文没有报告的字段写「未报告」，不要用 0、N/A、可能、大概、常被认为等词代替。
6. **生成正文**：按「输出契约」的小节顺序输出 Markdown（表格 + 关键对比 + 证据与引用）。
7. **落盘**：正文作为本次运行的最终回答交给工作台投影写 Artifact / Inbox / Obsidian；本 skill 不写任何外部文件。
8. **自检**：执行「自检清单」；任何一条不过就修正后重出一次，仍不过则在正文里如实标注。

## 证据与引用规则

- 每行必须带稳定标识符：`DOI` 优先，其次 `PMID` / `arXiv ID` / `Zotero item key` / `citationKey`；URL 只在没有任何持久标识时使用。
- 引用格式：`第一作者 et al., 年份` 后接标识符，例如 `Zhang et al., 2025 · https://doi.org/10.xxxx/yyyy` 或 `Zotero: ABCD1234`。
- **不得伪造引用**：不生成、不补全、不猜测 DOI / URL / 作者 / 期刊 / 卷期 / 页码 / 年份 / 引用数。任何拿不到出处的字段写「未报告」或整行丢弃，绝不"示例化"。
- 只使用本次检索到的记录与本次注入的文献上下文；**不得引用模型记忆、常识或未在本次证据里出现的文献**。
- 单元格区分证据来源：来自摘要、来自全文、来自元数据要在「证据」列或「证据与引用」小节里标明（例如 `证据：摘要`、`证据：全文第 4 节`）。无法区分时写「未报告证据层级」。
- 单篇文献的结论必须紧跟原文表述的限制条件（样本、任务、基线），不要把它升级成领域结论。

## 矩阵字段模板

**必填列**（顺序固定，不可删除）：

| 列 | 内容要求 |
| --- | --- |
| 标识 | DOI/PMID/arXiv/Zotero key 等持久标识，可直接解析 |
| 标题 | 原文标题（保留原语言，不做意译） |
| 作者·年份 | 第一作者 + 年份（原文元数据为准） |
| 来源·出处 | 期刊/会议/预印本平台 + 本次来源标识 |
| 研究类型 | 实验 / 方法 / 综述 / 数据集 / 立场文章 等（原文自述优先） |
| 方法·干预 | 方法、模型、系统或被比较的对象 |
| 数据·样本 | 数据集、样本量、语料或实验设置 |
| 主要结论 | 原文结论 + 该结论的证据位置 |
| 局限（原文自述） | 作者自己写出的局限；没有则「未报告」 |
| 与本主题的关系 | 直接相关 / 相邻方法 / 基线 / 反例 |
| 项目分类 | 使用本次注入的项目上下文分类；没有项目则写「未分类」 |

**可选列**：数据集可得性 / 评价指标 / 代码或数据链接 / 引用影响 / 复现风险 / 可迁移场景。

**可比性规则**：同一列必须同粒度、同口径。单位、样本量口径或评价指标不一致时，在单元格里标注差异，不要拼成一个数字；不要用「约」「左右」抹平差异。

## 输出契约（Artifact / Obsidian 投影）

- 只输出**正文**（Markdown）。不要写 YAML frontmatter、不要写 `#` 一级标题、不要写来源页脚：投影层会写入 `workbench_*` frontmatter、标题和来源行。
- 正文以 `##` 小节开始，按此顺序：`## 主题与范围`、`## 覆盖与来源状态`、`## 文献矩阵`、`## 关键对比`、`## 证据与引用`、`## 缺口与下一步`。
- 矩阵用 Markdown 表格：列数 ≤ 12（超出的可选列并入「关键对比」或拆分表格）；单元格 ≤ 40 字符；长文本放「关键对比」与「证据与引用」。
- 「证据与引用」小节逐行列出本文所有引用（标识符 + 引用位置），使读者不依赖任何临时文件即可核对。
- **正文前 4,000 字符必须自包含**：SQLite Artifact / Inbox 只保留有界摘录（上限 4,000 字符），完整正文只存在于 Obsidian note 与本次运行输出中。所以主题范围、覆盖状态、矩阵表头与关键结论必须落在前 4,000 字符内。
- 语言：`zh-CN`（默认）写简体中文正文；`en` 写英文正文。两种语言都逐字保留原始标题、作者名、期刊/会议名、标识符与 URL，不翻译、不改写。
- 不得把工具日志、命令行回显、绝对路径、凭据类内容（API key/token/cookie/.env）写进正文。

## 空结果 / 来源降级 / 失败语义

| 情况 | 判定 | 正文写法 | 诊断码 |
| --- | --- | --- | --- |
| 主题合法但检索到 0 篇 | 合法结果，**不是失败** | 明确写「本次时间窗与来源内未检索到匹配文献」，列出主题、时间窗、来源，并给出可执行的放宽建议 | `MATRIX_EMPTY_RESULT` |
| 请求的部分来源不可用 | 降级运行 | 在 `## 覆盖与来源状态` 逐条列出可用/不可用来源，并声明「本次为部分覆盖，结论仅代表已覆盖来源」 | `MATRIX_SOURCE_DEGRADED` |
| 请求的全部来源都不可用 | 阻断 | 不产出矩阵，只输出失败说明与修复建议 | `MATRIX_SOURCES_UNAVAILABLE` |
| 候选项缺持久标识 | 丢弃并计数 | 在覆盖状态里写「丢弃 N 条无持久标识候选」，不要放进矩阵 | `MATRIX_EVIDENCE_INSUFFICIENT` |
| 时间窗/参数非法 | 阻断 | 不产出矩阵，指出非法字段与合法范围 | `MATRIX_INPUT_WINDOW_INVALID` |
| 主题缺失 | 阻断 | 只问一次主题并停止 | `MATRIX_INPUT_TOPIC_MISSING` |
| 检索或读取本身失败（网络、权限、工具不可用） | 失败 | 如实说明失败原因与修复建议，**不得用记忆或旧结果补一篇矩阵** | `MATRIX_RUN_FAILED` |
| 被要求直接写 Zotero/Obsidian | 拒绝 | 说明边界并改为输出正文 | `MATRIX_EXTERNAL_WRITE_REFUSED` |

一切降级或失败都必须在正文里可见：**部分覆盖不得写成完整覆盖，空结果不得写成"没有相关研究"的领域结论。**

## 安全边界

- 不写 Zotero、不写 Obsidian、不触碰 `.obsidian/`、`zotero.sqlite`、凭据或系统配置；正文一律交给工作台既有的 Artifact / Obsidian 投影流程。
- 不读、不复制、不输出凭据类内容（API key、token、cookie、`.env`、连接记录密文）。
- 不自动外部写入：不发邮件、不投稿、不上传、不发布、不创建外部账号；任何外部写入都必须由用户在工作台里显式确认后走对应写入入口。
- 不安装任何工具（pip/npm/pnpm/brew/apt），不修改网络或代理配置，不运行首次配置向导。
- 不把「生成/导出」描述成「已导入 Zotero」：本 skill 不产生 Zotero 写入结果，也不声称产生了。

## 自检清单（输出前必过）

1. 矩阵每一行都有可直接解析的持久标识，且没有任何一行来自记忆或推测。
2. 每个单元格要么有证据，要么写「未报告」；没有 0/N/A 冒充缺失值。
3. 引用数量与「证据与引用」小节逐条一致，没有孤立引用。
4. 覆盖状态与实际使用的来源一致；降级已声明为部分覆盖。
5. 正文没有 YAML frontmatter、没有 `#` 一级标题、没有绝对路径、没有凭据类内容、没有工具日志。
6. 语言符合 `responseLanguage`（默认 `zh-CN`），原始标题/作者/期刊/URL 逐字保留。
7. 前 4,000 字符内已包含主题范围、覆盖状态、矩阵表头与关键结论。
8. 空结果/失败时给出的结论是「本次未检索到」，不是领域性判断。

## 诊断输出

阻断或失败时，正文只包含一个结构化失败块（不要附带半成品矩阵），字段固定、可复制给他人排障：

```text
状态: 阻断
诊断码: MATRIX_INPUT_TOPIC_MISSING
消息: 缺少主题：矩阵需要一个明确的主题才能检索
输入: 本次归一化后的参数（主题/时间窗/来源/语言/项目/输出目录）
证据: 本次实际探测到的来源可用性与候选条数（无则写「未开始检索」）
下一步: 需要用户提供的一个动作（例如：给出主题关键词）
```

规则：

- 诊断码只用本文件列出的取值，不发明新码；不把失败写成成功，也不生成占位矩阵。
- 诊断信息里只写相对路径或 `%REPO%/…` 形式，不写用户的绝对路径。
- 真实联网检索与真实模型运行是否成功，必须由本次运行的输出证明；本 skill 的版本与结构通过不代表端到端已验证。

## 本地 helper（离线可执行，网络可选）

`.agents/skills/literature-matrix/` 自带一个机械层 helper，把本文档的规则变成本机可跑、可核对的操作；它**不写正文、不做文献判断**，只输出 JSON 信封：

- `scripts/litmatrix.py`（仅 Python 标准库；`python scripts/litmatrix.py self-test` 是离线冒烟，当前 38 项全过，退出码 0）。
- `schema/contract.json`（机器可读合同：输入/来源/去重顺序/矩阵字段/投影/诊断码/缓存/安全/人工核验边界）。
- 子命令：`normalize`、`plan`、`search`、`dedupe`、`extract`、`verify`、`lint`、`self-test`；状态 `ok|empty|degraded|blocked|failed` 对应退出码 `0|0|0|1|2`；`--now` 固定时间戳，保证检索计划与信封可复现。

规则：

- **默认离线**：只有显式 `--online` 才访问公开 API（OpenAlex / arXiv / Europe PMC / Crossref，四者均免密钥）。不需要也不保存任何 API key；不读环境变量里的凭据，不发 `Authorization` 头，不读 `~/.pi`。
- **缓存与写入**：只写 `--cache-dir` / `--manifest-dir`（默认操作系统缓存目录 `prw-literature-cache/literature-matrix`），永不写仓库、Vault、Zotero 或工作台数据库。
- **只读边界**：helper 拒绝 `zotero.sqlite`、`*.sqlite`、`.obsidian/**`、`.env*`、`~/.pi/**`（`MATRIX_FORBIDDEN_PATH`）；Zotero/Obsidian 条目只接受工作台在运行时注入的记录。
- **`extract` 只产草稿**：正文列（方法/数据/结论/限制/关联）一律 `未报告` + `unreported`，必须由读过证据的人或模型回填；**`verify` 是离线引用核验**（只比对本次记录集），不联网解析 DOI/PMID，`unresolvable` 不等于引用造假，但不得当作已核实。
- **`lint` 校验投影合同**：frontmatter、一级标题、小节顺序、前 4,000 字符自包含、占位符、绝对路径、凭据、工具日志。

helper 使用的诊断码（仍为 `MATRIX_` 前缀，含义同上文语义表）：`MATRIX_SOURCE_RATE_LIMITED`、`MATRIX_SOURCE_REQUEST_INVALID`、`MATRIX_SOURCE_FAILED`、`MATRIX_SOURCE_CONTEXT_MISSING`、`MATRIX_SOURCE_CONTEXT_UNUSED`、`MATRIX_PERMISSION_DENIED`、`MATRIX_NETWORK_DISABLED`、`MATRIX_CACHE_UNAVAILABLE`、`MATRIX_RECORDS_INVALID`、`MATRIX_INPUT_MISSING`、`MATRIX_INPUT_INVALID`、`MATRIX_INPUT_TOPIC_INVALID`、`MATRIX_INPUT_SOURCES_INVALID`、`MATRIX_INPUT_LANGUAGE_INVALID`、`MATRIX_INPUT_PROJECT_INVALID`、`MATRIX_INPUT_OUTPUT_FOLDER_INVALID`、`MATRIX_FIELD_TEMPLATE_INVALID`、`MATRIX_FORBIDDEN_PATH`、`MATRIX_CONTRACT_MISSING`、`MATRIX_CONTRACT_INVALID`、`MATRIX_CONTRACT_MISPLACED`、`MATRIX_CITATION_INPUT_MISSING`、`MATRIX_CITATION_UNVERIFIED`、`MATRIX_CITATION_MISMATCH`、`MATRIX_BODY_FRONTMATTER`、`MATRIX_BODY_SECTION_MISSING`、`MATRIX_BODY_SECTION_ORDER`、`MATRIX_BODY_EXCERPT_INCOMPLETE`、`MATRIX_BODY_TABLE_COLUMNS`、`MATRIX_BODY_ROW_WITHOUT_IDENTIFIER`、`MATRIX_BODY_PLACEHOLDER`、`MATRIX_BODY_COVERAGE_MISSING`、`MATRIX_BODY_LEAK`、`MATRIX_SELF_TEST_FAILED`、`MATRIX_RUN_FAILED`。

## 注册状态与版本

- 版本：`1.0.0`。唯一源文件：`.agents/skills/literature-matrix/SKILL.md`（`.agents/skills` 是全部 skill 的唯一手工维护源目录；`resources/skills` 只是构建时镜像）。
- 本构建中该 key 在排程合同里标记为 `shipped`：**已注册指令型执行合同**（`packages/workspace-service/src/skill-registry.ts`）。合同内容：运行时（Agent runtime）从 `.agents/skills/literature-matrix/SKILL.md`（或打包镜像 `resources/skills/literature-matrix/SKILL.md`）读取本文件全文并**逐步执行**；本 skill 没有本地引擎/解释器，也不会被复制到第二个源目录。注册表在注入前会校验：路径位于该 skill 目录内（拒绝绝对路径/`..` 穿越）、frontmatter `name` 与 skillKey 一致、正文非空且未超可注入上限；任一不通过则整次运行结构化阻断（`SKILL_MISSING` / `SKILL_FILE_UNSAFE` / `SKILL_FILE_INVALID`），不会退化为通用工作流。
- 输出路径：最终回答只包含**正文**；由工作台现有的 Artifact / Inbox / Obsidian 投影流程落盘（frontmatter、标题、来源行由投影层写入）。本 skill 不直接写 Zotero/Obsidian。
- 排程器里显示为**已安装可选择**；选中后运行会注入本文件全文、规则的主题/来源/回看天数/输出目录与语言规则。
- **IN_REVIEW**：已验证的只有（离线）skill 结构、registry 解析/阻断、注入文本与编辑器可选状态（`pnpm test:literature-skills`）。**真实模型运行与真实联网检索从未执行**：在一次真实运行产出带证据的正文并落到 Artifact/Obsidian 之前，不得声称该 skill 已端到端验收。任何 Agent runtime 也可直接读取并手工执行本文件。
