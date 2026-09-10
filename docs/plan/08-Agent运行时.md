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
- packages/database/src/migrations.ts：migration 9 创建 Agent 基础表，migration 10 增加 idempotency_key 唯一索引，migration 11 增加 agent_status 查询索引，migration 13 增加每个 runtime 的可选代理开关与 HTTP(S)/NO_PROXY 配置。
- packages/database/src/repository.ts：connector health、binding、managed run、event append/page、artifact/inbox、idempotent lookup。
- 调度 run 使用 `jobId = schedule.id`，按需 run 保持空值；Agent 列表支持 status/project 过滤和自动化 run 过滤。

### 执行与传输

- packages/agent-runtime：AgentRuntimeAdapter，只包含 Codex/Pi CLI adapter；CLI 输出映射为 append-only events，prompt 通过 stdin（避免 Windows 命令行长度/注入问题），进程有 timeout/cancel。Codex 通过每次命令的 `projects.<runDir>.trust_level=trusted` 覆盖信任当前生成目录；Pi 使用 `--approve` 仅确认本次隔离 run 目录。运行时子进程不继承 ambient shell 代理/credential，只有设置中按 runtime 显式开启且通过 HTTP(S) URL 校验后才注入代理变量；CLI 登录目录由适配器显式指向本机默认目录，以复用用户已经完成的登录。
- packages/workspace-service/src/agent-coordinator.ts：resolve binding（含 fallback runtime）→ probe runtime → create run dir → start process → persist events → artifact/inbox projection。
- 自动化规则复用现有 Schedule 表；v1 不扩展旧表的 runtime 列，项目级规则使用 Agent binding，未绑定项目默认 Pi。
- 保存启用规则时立即计算 `nextRunAt`；每次执行后按 Cron 推进到下一次，避免 30 秒 tick 重复消费同一到期点。
- 调度器对规则 ID 保持进程内运行锁；长时间运行或启动 tick 与定时 tick 重叠时不会重复启动同一规则，异常会释放锁并保留下一次可重试状态。
- packages/workspace-service/src/host.ts：Agent RPC 与既有 V2 RPC 共用 Core host，启动时先将遗留的 planned/queued/running/waiting_confirmation run 收敛为 failed，再执行一次 schedule tick，每 30 秒轮询。
- apps/desktop/src/main/ipc.ts、src/core/client.ts、src/preload/index.ts：新增独立 workbench:agent:v1 白名单通道。
- packages/workspace-mcp：新增只读 Agent 状态工具，仍通过握手 token 的 service pipe。

### UI

- apps/desktop/src/renderer/src/features/agent.tsx：runtime 探测/可执行文件路径保存、按需运行、完整会话历史栏与消息流、仅新对话显示的快捷指令、AI inbox。
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
