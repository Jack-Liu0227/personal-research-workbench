# Agent 运行时与自动化计划

## 2026-09-08 最新需求与验收（以本节为准）

- Runtime 增加显式启用/禁用按钮；禁用后任务、调度和文献上下文不得调用该 Agent。
- 权限选项由对应 CLI 的真实 capability probe 生成，显示来源、版本、命令和探测失败原因。
- 设置页按已安装、可用、未安装、未检测和默认 Agent 模块展示，支持测试连接、编辑和设为默认。
- 代理使用独立 profile/binding；凭据仍由 safeStorage 管理，不进入 SQLite。
- last30days 固定使用仓库锁定的上游 skill；无 Key 也可运行，可选来源缺失不得阻塞主流程。
- 文献上下文接受检索/Zotero 选中的 citation key、abstract、URL 和导出文件元数据。

状态：PARTIAL。动态权限、独立代理绑定和文献上下文接入仍需完成安全与 E2E 验收。

状态：IN_REVIEW（第一轮代码已接入，等待 QA 与 Review/Security 独立验收）  
范围：Codex CLI、Pi CLI；后续运行时必须通过同一适配器契约加入。

## 目标

把 Agent 作为现有 Workspace Service 的一个受控模块，复用当前的 Zod 合同、SQLite 权威数据、Core Utility Process、Preload 白名单和 MCP named-pipe 服务。第一轮覆盖：

- Codex/Pi 可执行文件探测、路径配置、能力状态和按 runtime 配置的 HTTP(S) 代理开关；
- 研究工作流按需运行，保存 run/event/artifact/inbox；
- read-only 默认工具策略，取消、重试、运行详情和事件分页；
- 项目级 runtime binding；
- 每日 cron 规则与应用存活期间调度，启动最多补跑一次；
- MCP 只读工具读取 runtime、run、event、automation 和 inbox 状态；
- Zotero/文献工作流通过已有 Literature/Zotero Service 数据进入 Agent 上下文：按需运行读取选定 Paper，项目运行读取项目 Paper、literature matrix 与未归档 Task；不直接读取 zotero.sqlite。

## 非目标与硬约束

- 不把凭据、CLI auth、.pi 或 CODEX_HOME 写入 SQLite；CLI 子进程不继承 ambient credential 环境变量。代理仅允许无凭据的 HTTP(S) URL，可由设置显式开启后注入 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`。Codex/Pi 运行时沿用各自本机 CLI 配置目录，由 CLI 自己完成 OAuth/API key 读取；工作台只调用 `codex login status` / `pi auth check --no-refresh` 做布尔状态探测，不读取、复制或回显 auth 文件和 token。
- 不开放 unattended 外部写入。approved-write 仅作为合同状态，当前 UI 和调度均固定 read-only。
- 不让 Renderer 访问 Node、SQLite、原始 named pipe 或通用 IPC；仅使用 window.workbench.agent。
- 不把 Obsidian 正文复制进数据库，不写 .obsidian/；Zotero 只走 Local/Web API。
- 不将 Codex/Pi 的供应商身份和 wire API 混为一谈；后续 provider 扩展另立合同。
- 应用关闭时不运行任务；启动 catch-up 最多一个 due schedule。

## 当前实现

### 数据与合同

- packages/contracts/src/agent.ts：runtime、connector、binding、run、event、approval、automation、inbox 和 agent.* / automation.* / inbox.ai.* RPC。
- packages/database/src/migrations.ts：migration 9 创建 Agent 基础表，migration 10 增加 idempotency_key 唯一索引，migration 11 增加 agent_status 查询索引，migration 13 增加每个 runtime 的可选代理开关与 HTTP(S)/NO_PROXY 配置，migration 22 增加归一化账本 `agent_run_records`（含历史回填，见下文增量）。
- packages/database/src/repository.ts：connector health、binding、managed run、event append/page、artifact/inbox、idempotent lookup。
- 调度 run 使用 `jobId = schedule.id`，按需 run 保持空值；Agent 列表支持 status/project 过滤和自动化 run 过滤。

### 执行与传输

- packages/agent-runtime：AgentRuntimeAdapter，只包含 Codex/Pi CLI adapter；CLI 输出既映射为 append-only events（诊断/兼容），也归一化为账本记录 `AgentRunRecordDraft`（渲染权威，见下文增量），prompt 通过 stdin（避免 Windows 命令行长度/注入问题），进程有 timeout/cancel。Codex 通过每次命令的 `projects.<runDir>.trust_level=trusted` 覆盖信任当前生成目录；Pi 使用 `--approve` 仅确认本次隔离 run 目录。运行时子进程不继承 ambient shell 代理/credential，只有设置中按 runtime 显式开启且通过 HTTP(S) URL 校验后才注入代理变量；CLI 登录目录由适配器显式指向本机默认目录，以复用用户已经完成的登录。
- packages/workspace-service/src/agent-coordinator.ts：resolve binding（含 fallback runtime）→ probe runtime → create run dir → start process → persist events → artifact/inbox projection。
- 自动化规则复用现有 Schedule 表；v1 不扩展旧表的 runtime 列，项目级规则使用 Agent binding，未绑定项目默认 Pi。
- 保存启用规则时立即计算 `nextRunAt`；每次执行后按 Cron 推进到下一次，避免 30 秒 tick 重复消费同一到期点。
- 调度器对规则 ID 保持进程内运行锁；长时间运行或启动 tick 与定时 tick 重叠时不会重复启动同一规则，异常会释放锁并保留下一次可重试状态。
- packages/workspace-service/src/host.ts：Agent RPC 与既有 V2 RPC 共用 Core host，启动时先将遗留的 planned/queued/running/waiting_confirmation run 收敛为 failed，再执行一次 schedule tick，每 30 秒轮询。
- apps/desktop/src/main/ipc.ts、src/core/client.ts、src/preload/index.ts：新增独立 workbench:agent:v1 白名单通道。
- packages/workspace-mcp：新增只读 Agent 状态工具，仍通过握手 token 的 service pipe。

### UI

- apps/desktop/src/renderer/src/features/agent/：runtime 探测/可执行文件路径保存、按需运行、完整会话历史栏、「对话 / 轨迹」双视图、仅新对话显示的快捷指令、AI inbox。
- App.tsx 将 Agent 与定时任务作为 WorkspaceRoute=agent/automation 内嵌到同一 Sidebar、折叠、Topbar、标签栏、Inspector 和状态栏；Agent 内容区保持 AionUI composer 交互，定时任务独立为左侧导航页面。

## Runtime matrix

| Runtime | Transport | Structured output | MCP hook | 默认工具策略 | 当前事实 |
| --- | --- | --- | --- | --- | --- |
| Codex | CLI | codex exec --json | 通过 PRW_SERVICE_INFO 暴露；每次仅信任生成的 run 目录 | --sandbox read-only（运行目录显式 `--skip-git-repo-check`） | 启动时真实 --version 探测 |
| Pi | CLI | pi --mode json --no-session | 通过 PRW_SERVICE_INFO 暴露，--mcp-config 预留给已校验的适配器 | --tools read,grep,find,ls | 启动时真实 --version 探测 |

不可用 runtime 必须显示 blocked/不可用原因，不得显示为成功或伪造连接。

## 后续迭代

### AionUI compatibility slice (2026-08-30)

The first Agent page was expanded to match the stable AionUI interaction model:

- persisted conversations and ordered messages (`agent_conversations` and `agent_messages`), with a new-chat action and project/runtime/model/assistant selectors;
- a conversation-linked run (`AgentRunRecord.conversationId`) that rehydrates prior messages into the prompt and writes the assistant response back to the same session;
- schedule fields for runtime, model, assistant, frequency preset, execution mode (`new_conversation` or `existing`), prompt, project and optional conversation binding;
- a separate 定时任务 route with schedule list actions for enable/disable, edit, run-now and archive, while preserving the local-only scheduler rule;
- read-only MCP inspection for conversation lists and message history.

Frequency presets populate the corresponding Cron expression in the UI; `manual`
is intentionally run-only (`nextRunAt = null`) and can still be triggered with
Run now. Other presets remain editable Cron values so users can refine the exact
time/weekday without changing the persisted compatibility field.

This is compatibility of the Agent/data contract, not a claim that PRW has AionUI's built-in file-write, full-auto, remote-agent or 24/7 behavior. `workspacePath` is persisted as an explicit future workspace selector but is not used to bypass PRW's safe per-run directory. Approved-write and unattended external writes remain disabled.

The implementation was informed by AionUI's public scheduled-task contract (Agent + model, assistant, workspace, frequency, execution mode, prompt) and its conversation-bound execution model. See the official [Scheduled Tasks Guide](https://github.com/iOfficeAI/AionUi/wiki/Scheduled-Tasks-Guide) and [AionUI repository](https://github.com/iOfficeAI/AionUi).

### Visual and functional acceptance (2026-08-31)

The live Windows Electron Agent workspace was exercised at 2160×1380 with Orca. Agent is embedded in the standard shell so Sidebar collapse behavior is identical to other workspaces; the AionUI-style composer, runtime health indicators, project binding, Inspector and status footer rendered without visible clipping or overlap. The separate 定时任务 page passed schedule save, enable/disable, edit, run-now and archive paths. Native select automation could not reliably choose a non-default option in this run; the daily preset (`0 9 * * *`) was therefore used as the observable acceptance path, while the preset-to-Cron code path remains covered by the implementation.

The conversation view was then aligned with the referenced AionUI page: a persistent inner history rail lists active conversations, the selected thread renders all ordered messages in a scrollable stream, and the composer is docked at the bottom. “试试这些指令” is an opening-state affordance only; it is hidden for an existing thread and after the first send. Legacy authentication/trust-directory/network test noise is replaced at the presentation boundary with a safe retry hint; SQLite rows are not rewritten. Settings exposes independent Codex/Pi proxy toggles and HTTP_PROXY/HTTPS_PROXY/NO_PROXY fields; scheduled and manual runs share the same explicit connector proxy policy.

Acceptance fixes include independent schedule model/assistant/workspace form state, retry model rehydration from the linked conversation, manual schedules remaining run-only, schedule cursor advancement after successful execution, transient-error retry preservation, prompt-history de-duplication, and repository read-boundary redaction for legacy absolute paths/tokens. Redaction is presentation-only for pre-existing SQLite rows and does not rewrite user data.

The latest live acceptance additionally verifies that sending from the embedded
Agent composer does not navigate away from the Agent workspace. A real Codex
read-only prompt produced `command_execution` events and `TOOL_STREAM_OK`; the
renderer shows the event timeline while running, coalesces started/completed
tool envelopes by item id, filters diagnostic envelopes from assistant text,
and rehydrates the completed conversation after reload. A scheduled
`daily_digest` run carries `schedule.id` in `run.jobId`; on success the host
writes a run-specific Markdown note to the enabled Obsidian Vault under
`每日文献推送/YYYY-MM-DD-daily_digest-<schedule8>-<run8>.md`. Obsidian failures
remain non-fatal and leave the SQLite artifact authoritative.

The current status remains `IN_REVIEW`: typecheck, build, MCP build and the repository's intentional no-op test command passed; local Codex/Pi credential/model generation has now been smoke-tested through the installed CLIs (`codex login status`, `pi auth check --no-refresh`, and read-only prompt execution). A dedicated E2E script, independent Review/Security approval and Windows x64 NSIS smoke remain release gates. Local model, thinking and permission values are displayed from non-secret profiles; raw CLI auth files and tokens are never opened or copied by the workbench.

1. QA：隔离数据库验证 migration 9/10、重启恢复、idempotency、取消/超时和 UI 键盘流程。
2. Review/Security：审查 CLI 环境变量、run directory 权限、MCP 配置注入、日志脱敏和 approved-write gate。
3. Desktop：补充 packaged Windows x64 smoke；确认 workbench://app sender trust 不被开发 URL 放宽。
4. Integrations/Literature/Zotero：定义只读上下文投影与显式 preview/confirmation 写回。
5. 第二轮：durable outbox、approval 表/决策、三方冲突、通知渠道和可选 runtime adapter；每项需新增迁移与合同版本。

### Session transcript and panel interaction baseline (2026-08-31)

- Agent history supports revision-checked bulk archive through
  `agent.conversations.archiveBulk`; the UI exposes per-conversation checkboxes,
  select-all for the active filter and one confirmed “delete selected” action.
  The operation is a single SQLite transaction, so a stale selection fails as a
  whole instead of partially deleting history. The existing per-item delete
  remains the same archive semantic and is not described as hard deletion.
- Each conversation is mirrored to one app-owned
  `agent-sessions/<conversation-id>.json` snapshot. The snapshot contains the
  validated conversation metadata and redacted ordered messages and is written
  atomically after create, user/assistant append, status changes and archive.
  SQLite remains the authoritative source for queries, revisions and runtime
  recovery; a projection write failure is non-fatal and retried on the next
  conversation mutation.
- Tool execution rows are collapsed by default. `查看步骤` is a keyboard-focusable
  disclosure control with an explicit count and status summary; expanding it
  reveals the coalesced tool timeline while the assistant text remains visible
  in the normal message stream.
- The inner Agent history rail and the shared right Inspector each have a
  persisted collapse state (`localStorage`) with an accessible expand/collapse
  button. Collapsed rails retain a visible affordance and new-conversation
  action rather than disappearing silently.

This baseline was implemented with the Frontend/UI review rules: native
buttons and checkboxes, visible focus rings, destructive confirmation, explicit
expanded state, and no hover-only controls. No claim is made that session files
replace SQLite or that an external agent runtime has been made writable.

Verification for this baseline: `pnpm typecheck` PASS, `pnpm test` PASS as the
repository's intentional no-op, and `pnpm build` PASS (Electron main, preload
and renderer bundles). No dedicated E2E script was run because the repository
does not define `test:e2e`.

### 归一化账本与「对话 / 轨迹」双视图（2026-09-09 增量）

Agent 页面从「渲染层读原始 CLI JSON 并启发式猜测」改为 dsh 式的**持久化归一化账本 + 客户端投影**。账本在 Core 内生成，Renderer 只读账本；原始 provider payload 不再是渲染源。dsh（`@deepseek-ai/dsh` 0.1.0-rc.6，MIT）仅作形式参考，未复制其代码，未引入其运行时。

**数据与合同**

- migration 22 `agent_run_records`：`record_key`（适配器自有的稳定身份）+ `seq`（首次插入按 run 递增，此后不变）+ `kind`（`user | assistant | reasoning | tool | subtool | system | context | diagnostic | compacted | error | turn_end`）+ `turn`/`step` + `status`（`info | running | completed | failed | canceled`）+ `title`/`detail` + `input_text`/`output_text` + `tool_name`/`call_id`/`parent_id` + `started_at`/`finished_at`/`duration_ms` + `usage_json` + `truncated`。约束：`UNIQUE(run_id, seq)`、`UNIQUE(run_id, record_key)`；索引 `agent_run_records_run_seq_idx`、`agent_run_records_run_key_idx`、`agent_run_records_run_created_idx`、`agent_runs_conversation_created_idx`。
- 历史 run 回填在同一条 migration 内用 SQL 完成（`agent_messages` user → `agent_run_events` → `agent_messages` assistant，`record_key = 'legacy:' || origin_id`），只对缺少 assistant 消息事件的 run 生效；回填数据是当时已脱敏/已截断的 payload 投影，缺失字段显示 `—`，不编造。
- 契约新增 `AgentRecordKindSchema`、`AgentUsageSchema`、`AgentRunRecordEntrySchema`、`AgentRunRecordDraft`、`AgentRunRecordsPageInputSchema`、`AgentConversationRecordsInputSchema`、`AgentLedgerPushSchema`；RPC 新增 `agent.runs.recordsPage`（尾部分页 / `beforeSeq` 向前 / `afterSeq` 增量）与 `agent.conversations.records`（尾部窗口，加载更早靠放大 `limit`，不做游标）。`AgentRunRecordDraft` 的 `turn`/`step` 沿用「省略 = 未指定」规则：更新保留库内旧值，插入回退 `0`。
- `agent.runs.eventsPage` 保留为诊断/兼容路径，Chat 与轨迹不再使用。

**归一化层**（`packages/agent-runtime/src/ledger/`）

- `codex.ts`/`pi.ts` 把 CLI 事件映射为账本记录；映射表是 `Record<..., AgentRecordKind>` + 穷尽分支，未知 item/event 会**编译期报错**，运行期回退为通用 `tool` 卡片或 `diagnostic`（原始已脱敏 JSON 放进 `output_text`，展开可见），不再静默丢弃。CLI stderr 也变成 `diagnostic` 记录，失败 run 不再只有一句通用文案。
- 流式文本靠 `record_key` **原地更新**同一行（`detail` 始终是当前全文），不为每个 delta 追加行；`seq` 保持首次插入时的值，因此轨迹锚点稳定。
- **记录终态收敛**：`finish()` 与 turn 边界都会关闭所有仍为 `running` 的记录（进程中途退出、被取消、turn 未发 `turn.completed` 的情况），Pi 的 reasoning 记录在 `message_end` 关闭。这是本轮发现并修复的真实缺陷：此前被中断的 run 会永远显示呼吸中的「Thinking」/工具行。关闭 draft 不携带 `turn`/`step`，由 repository 保留记录原有层级。

**Core 与传输**

- `agent-coordinator` 的写入路径改为 `upsertAgentRunRecord`（按 `record_key` 更新或插入）+ 按 run 合并节流的 ledger emitter（≤100ms 一批，run 终态额外推一次）；抽文本的启发式已删除。`agent_messages` 保留为兼容写入与搜索索引，不再是 Chat 渲染源。
- 新增推送方向：`workbench:agent:ledger-subscribe` / `workbench:agent:ledger-push`。订阅走既有 `isTrustedSender(event, getWindow(), developmentUrl)` 闸门（打包态只认 `workbench://app`），入参经 Zod 校验，只向已订阅该 `runId` 的 `webContents` 发送，窗口关闭即清理；preload 只暴露 `agent.runs.subscribe(runId, handler)`，每条推送再经 `AgentLedgerPushSchema` 校验且 `runId` 必须属于当前订阅集合。订阅失败时降级为轮询，stats 行显示「实时通道不可用（轮询）」。
- 脱敏与截断沿用既有 `redactAgentPayload` + 单字段 64KB 上限（超限置 `truncated`）。
- **Review Security 过闸发现并经修复的真实缺陷（2026-09-09）**：账本文本字段此前只经过值形态的 `redactAgentText`，而唯一做键名匹配的 `redactAgentPayload` 只服务于 `agent_run_events.payload`；两者已不是同一列表。后果是工具入参/结果与未知事件以 **JSON 字符串**形态进入账本时（`{"api_key":"…"}`）不会被掩码，凭据会落库并显示在工具卡片与轨迹 inspector。修复方式是在共享文本策略 `redactAgentText` 中插入 `SECRET_JSON_PAIR` 规则（键名匹配 `token|secret|api[_-]?key|authorization|password|credential|cookie` 时掩码其引号字符串值），写入与读取两条路径同时生效；`tool_name`/`call_id` 也改为经过同一规则（`parent_id` 例外，见下）。刻意限定为「引号字符串值」：`{"max_tokens": 4096}` 这类数值配置保持可读。同一轮修复：`diagnostic` 记录按 run 封顶（前 200 条逐行保留，之后折叠进单条自覆盖的 `diagnostic:tail`，上限 16 000 字符），推送批次改为按记录数与累计字符双封顶（500 条 / 2 000 000 字符），订阅集合在 `did-start-navigation` 时清空，避免页面刷新继承上一份文档的订阅。
- **复核轮再修的两处**：①清空订阅的导航判定必须排除同文档导航（`isSameDocument`）——仓库现存代码 `features/calendar.tsx:137` 会改 `window.location.hash`，而该事件对片段/历史导航同样触发，否则一次哈希跳转就会在本 run 剩余时间内静默中止实时推送（数据由 1.5s 轮询兵底，但状态行会误报「已连接」）。②`parentId` 的脱敏被回退：它是指向另一行 `recordKey` 的不透明交叉引用，而 `recordKey` 是 upsert 主键必须原样存储，只脱敏一侧会让 subtool 丢失嵌套；`toolName`/`callId` 作为展示字段仍脱敏，父记录的 `title`/`detail` 也仍脱敏。
- 构建卫生：`pnpm build` 会留下转译产物 `apps/desktop/electron.vite.config.<timestamp>.mjs` 且 `.gitignore` 无对应规则（`git add -A` 会把生成配置提交进去）——已加入 `.gitignore` 并删除残留文件。

**Renderer**（`features/agent/` 取代单文件 `features/agent.tsx`）

- 页内两个 Tab：**对话**（Turn 分组流：user 行、assistant 文本（复用既有 `MarkdownPreview`）、Think 折叠行、工具卡片（名称 + 一行入参 + 状态点 + 耗时，展开看输出）、subtool 缩进、`diagnostic`/`error` 警示色、composer 上方**只读步骤条**（措辞为「本次运行步骤」，数据只来自账本，无工具记录时不渲染）、底部 sticky stats 行（turn 数、总耗时、usage 汇总、实时/轮询状态））与**轨迹**（等行高虚拟列表：`#seq` · kind 徽标 · 单行摘要 · 耗时 · 状态点，Turn 粗分隔线带耗时/用量，Step 内联标记，点击在右侧 fixed inspector 打开概览/Input/Output/Timing/用量/原始摘要，键盘 ↑↓ 与 j/k 移动、Esc 关闭，尾部 `beforeSeq` 向前分页）。
- 会话历史条、composer、Codex/Pi 运行时条与模型/思考深度/权限模式三个 `select` 的 `aria-label` 原样保留，Tab 切换不重复渲染这些控件。
- 删除渲染层启发式：`extractEventText`/`looksLikeToolEvent`/`looksLikeAssistantEvent`/`dedupeToolActivities`/`toolActivityKey`/`toolActivityState`/`eventLabel` 与 `LiveRunPanel` 的原始 JSON dump；`safeDisplayContent`/`safeDisplayTitle` 作为纵深防御保留。
- 未新增任何依赖（虚拟化、Tab、inspector 均为自写）。

**本轮刻意偏离计划的三处**（计划文档为经批准的决策记录，此处如实登记实施差异）

1. Tab 复用既有 `ResearchTabs` 组件（`role="group"` + `aria-pressed`），而不是计划写的 `role="tab"`；理由是仓库已有一致的可访问切换件，重复实现会分叉样式与键盘行为。
2. Tab 控件落在 `agent-thread-header` 之下、`.agent-thread-messages` 之上，而不是计划写的「置于 thread header 内」。
3. 历史回填用 migration 内的 SQL 完成，而不是计划中的 `ledger/legacy.ts` 归一化器；理由是回填源是已脱敏的 SQLite 行，纯 SQL 可原子执行、零运行时依赖，也避免在归一化器里再造一套 legacy 事件解析。

**明确不做**：交互式审批接管（`codex exec`/`pi -p` 均为非交互批处理，无审批通道，不显示假占位）、计划/todo 条（数据源未经真实 JSONL 证实，只做账本派生的「本次运行步骤」）、时间轴 Overview（TTFT/解码 span，待后续增量）、ACP 适配器 / dsh 运行时 / 进程内 Pi loop（账本接口保持传输无关，将来以「新增一个 adapter」接入）、账本保留策略与清理任务、新增 MCP 工具、markdown 渲染依赖。

**验证证据（2026-09-09）**

- `pnpm typecheck` PASS（所有 workspace + Electron；含归一化映射的穷尽分支）。
- `pnpm build` PASS（Electron main / preload / renderer bundle）。
- `pnpm test:e2e` PASS（隔离 Windows Electron 冒烟）：两个 Tab 唯一、切到轨迹显示空态「还没有运行轨迹」、切回对话显示「准备好开始了吗？」、切换后 `select[aria-label="模型"]` 仍唯一、历史条删除按钮 count 为 0、Renderer 零 console error；证据截图含 `agent-trajectory-empty-smoke.png`。
- 合成库端到端演练（临时脚本，已删除，未提交）：临时 SQLite → migration → 归一化器 → repository upsert/list → 契约校验，覆盖 Codex 完整 turn、Pi 增量消息/工具/bash 增量、以及**进程中途退出**的 run；所有记录都收敛到终态，同 `record_key` 重放不新增行，`AgentRunRecordEntrySchema` 校验 0 failure。该演练不替代真实 run 校准。
- 脱敏回归检查（临时脚本，已删除）：经真实 `WorkbenchRepository`（内存 SQLite）写入再读回 9 组密钥形态样本，`cases=9 leaks=0`，`{"max_tokens": 4096}` 仍可读。诊断封顶检查：5 000 条 stderr → 200 条独立行 + 1 条折叠行，`distinctKeys=201`。
- 仍未执行：真实 Codex/Pi 模型运行的字段校准（会消耗用户额度，需用户触发）、`packages/agent-runtime/fixtures/` 真实 JSONL 存档、Windows x64 NSIS smoke。
- Review/Security 过闸结论（独立子代理，作者未自批）：首轮 **request changes**（P1 脱敏回归须先修、P2 诊断封顶）；两项修复后复核以**执行方式**验证通过（直接抽取文件中的正则与 `redactAgentText` 本体在 node 中重跑，并补做 ReDoS 检查：67KB 无密钥 JSON 单值 0.25ms、100KB 内含 3 000 个密钥对 1ms、0 泄漏），同时新增发现 `isSameDocument` 缺陷。第三轮对 `isSameDocument` 守卫、`parentId` 一致性与构建卫生逐项确认，**最终结论 approve，无阻断项**。
- 复核自述未对受限文件之外做验证（`pnpm build`/`pnpm test:e2e` 属 owner 自报）；三项修复后 owner 重跑 typecheck / build / e2e 全 PASS（证据目录 `prw-workbench-e2e-Zo95Ah`）。
- 复核保留的非阻断残留风险：值形态密钥（非密钥名键下的 `{"data":"sk-…"}`，需前缀/熵检测）仍在键名策略之外（属既存类别）；`recordKey` 为原样不透明 id 且无 detail 时可作为摘要回退渲染；JSON 键规则 fail-closed，会对仅包含关键词的键误掩（`"token_count"`）；preload 仍丢弃订阅的 `{ok:false}`（已约定下次改动契约时修复，不用超时判定）；Codex/Pi JSONL 字段校准仍为已接受的非目标（真实 CLIdiff 可能落入通用回退分支）。

## 验证证据

- pnpm typecheck：PASS（2026-08-30 21:49，所有 workspace + Electron）。
- pnpm build：PASS（2026-08-30 21:49，Electron main/preload/renderer bundle）。
- pnpm --filter @prw/workspace-mcp build：PASS（2026-08-30 21:32，MCP CLI/index bundle）。
- migration smoke：PASS（2026-08-30，:memory: 创建 2 个 builtin connectors，agent_runs.idempotency_key 与 agent_status 索引存在）；migration 13 的代理列已加入 schema，需由 QA 在隔离库补一次升级验证。
- managed-run repository smoke：映射包含 jobId/idempotencyKey，事件 payload 脱敏逻辑已覆盖；完整运行仍由 QA 隔离重启验收。
- runtime probe：PASS（2026-08-30，本机 Codex `codex-cli 0.151.0`、Pi `0.84.1` 均可探测；尚未执行真实模型生成）。
- adapter lifecycle smoke：PASS（2026-08-30，使用本地 Node stub 验证 stdin、started/progress/failed 事件和进程收敛；不代表真实模型生成）。
- schedule preview smoke：PASS（2026-08-30，Cron/IANA timezone 计算 nextRunAt）。
- pnpm test：仓库脚本为 intentional no-op；没有新增测试源。
- pnpm test:e2e：脚本不存在，不能宣称通过。
- pnpm package:win、真实 Codex/Pi、真实 Zotero/Obsidian 和独立安全门禁：仍待执行。

本轮收尾补充：运行面板现在会保留并展示调度写入 Obsidian 的
`OBSIDIAN_DAILY_NOTE_WRITTEN` / `OBSIDIAN_DAILY_NOTE_SKIPPED` 事件；生产门
禁 `pnpm check`（typecheck + desktop build）和 workspace-mcp build 均通过。

### 2026-09 implementation increment

Agent void RPCs now return JSON `null`; archive actions optimistically remove
conversations and roll back through the query cache on refresh. Codex/Pi
connectors expose model candidates and three CLI-aligned permission modes. The
transcript renders assistant deltas while a run is active and exposes
keyboard-expandable, redacted tool payload details. A project-pinned
`last30days` 3.22.0 checkout is packaged with the app; the seeded
`Last 30 days 每日资讯推送` schedule runs at 09:00 Asia/Shanghai after a topic
is supplied and writes to the safe `每日资讯推送` Obsidian folder. Full-access
scheduled runs remain behind the explicit `PRW_ALLOW_FULL_ACCESS_AUTOMATION`
security gate.

### 中文每日推送与渐进加载增量

- `last30days` 调度在运行时强制“简体中文正文、原文证据保留”：摘要、分析和要点使用中文；来源名、专有名词、URL、必要原文标题/引语及 skill 的 badge/citation/pass-through footer 保持原样。用户 Prompt 不能覆盖该输出与安全格式约束。
- CLI capability probe 已从同步子进程改为带超时的异步子进程；version、auth、help/permission、model catalog 在同一 runtime 内并行，Codex/Pi 继续并行。Pi 失败路径不再重复运行 `--list-models`。
- Workspace Service 对相同 runtime/executable 的真实探测结果缓存 60 秒并合并 in-flight 请求；保存配置和显式“探测”会失效/绕过缓存。`startOnce()` 仍校验 enabled、available 与权限，不因缓存绕过安全策略。
- Agent 页面在探测期间先显示历史、消息区和 composer，runtime bar 局部显示探测状态；Automation 只在打开新建/编辑表单后加载 conversations 与 runtime capability。

本轮验证：`pnpm typecheck` PASS；`pnpm test` 为仓库明确的 intentional no-op；`pnpm build` PASS；`pnpm test:e2e` PASS。隔离 Electron E2E 记录 Agent 页面 shell 约 390ms 可见，并验证中文推送说明。真实 Codex/Pi 模型运行与 Windows x64 NSIS smoke 仍未在本轮执行。
