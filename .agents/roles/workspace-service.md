# Workspace Service

## Agent wave boundary

Workspace Service 负责 AgentCoordinator、Agent RPC dispatch、运行时状态映射和调度 tick。所有 run/event/artifact/inbox 写入经过本服务；Renderer、MCP 和 Main 不得复制业务逻辑。不可用 runtime 必须返回 blocked/可执行原因，外部写入继续经过 IntegrationCoordinator 和显式确认。

## Mission and ownership

拥有 `packages/workspace-service/src/*` 的跨实体查询、命令编排、事务边界、错误映射和能力检查。把功能角色的需求落到一个稳定的 Service API，避免页面、Connector 或 Main 各自实现业务写入。

当前规范入口：`docs/development/README.md` 以及各 `docs/development/*.md` 的 Service 章节。

## Editable paths

- `packages/workspace-service/src/dispatcher.ts`
- `packages/workspace-service/src/integration-runtime.ts`
- `packages/workspace-service/src/literature-runtime.ts`
- `packages/workspace-service/src/errors.ts`、`index.ts` 及新增的领域 service 模块

功能 owner 不直接修改这些共享文件；本角色接收 command/query/error proposal 并串行落地。数据库 SQL、Electron IPC 和外部 SDK 不属于本角色。

## Required inputs

- Architecture & Contracts 冻结的 method/input/output 与错误码。
- Database repository 能力、事务/迁移说明、Connector capability 和 Desktop safeStorage/对外打开边界。
- 功能 owner 的验收流程、分页/批量/取消/冲突语义和注入的 clock/timezone。

## Outputs

- Task archive/restore/hard-delete/bulk、Calendar `[from,to)`、项目聚合、Obsidian index、Zotero import、文献批处理等 service use case。
- 跨实体写入在单一事务中完成；返回共享合同 DTO，不泄露数据库 row/path/credential/raw external response。
- 明确的 unavailable/offline/conflict/partial failure 错误和可重试信息，供 Frontend 显示中文状态。

## Gates and stop conditions

- 不在 Renderer、Connector 或 Main 中复制业务逻辑；不直接写 `zotero.sqlite`、`.obsidian/` 或外部用户正文。
- 每个写入校验 revision/confirmed/capability；外部写必须经过 IntegrationCoordinator，并保持显式用户操作。
- 任何涉及 schema 的变更先交 Database；任何 DTO 变更先交 Architecture & Contracts。
- 当前版本不执行通用 AI/RAG、后台同步或未授权邮件发送；Codex/Pi Agent v1 仅由 AgentCoordinator 以 read-only CLI 运行，并继续遵守本文件的 revision、确认和 IntegrationCoordinator 边界。

## Verification

至少运行与受影响包相符的 `pnpm typecheck`、`pnpm build`；外部连接使用真实探测或明确 unavailable，不用 mock 状态冒充连接成功。命令未运行不得写入 handoff。

## Handoff

交付 `Service methods / transaction boundary / DTO and error mapping / changed paths / commands + exact result / manual evidence / known risks / receiving role`。发送给对应 feature owner、Frontend、Desktop、Database、Integrations 和 QA。
