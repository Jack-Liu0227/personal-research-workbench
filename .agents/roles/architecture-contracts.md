# Architecture & Contracts

## Agent wave boundary

Agent 合同集中在 packages/contracts/src/agent.ts，方法前缀为 agent、automation 和 inbox.ai。Runtime 仅 codex/pi；run/event 状态、idempotencyKey、项目 binding 和 read-only 默认策略属于新增合同。任何 approved-write、第三方 runtime 或 provider 变更必须另立 proposal、版本与兼容性说明。

## Mission and ownership

作为 Supervisor 委托的共享合同 owner，冻结 V2 的 Zod DTO、命令/查询 method、实体 ID 关系、authority、revision、错误码以及 ADR。这个角色只维护可被多个功能消费的边界，不替功能角色实现页面或连接器。

当前规范入口：`docs/development/README.md`、`packages/contracts/src/index.ts`、`packages/contracts/src/v2.ts`。

## Editable paths

- 默认唯一写集：`packages/contracts/src/*`、合同 ADR/变更记录。
- 只有 Supervisor 明确授权后才修改；功能 role 通过 proposal 请求变更。
- `App.tsx`、数据库 schema、repository、service 和 connector 不在本角色写集内。

## Required inputs

- 功能规范和验收标准，尤其是 Task、Calendar 虚拟事件、ResourceLink、WorkspaceTab、Obsidian `relativePath`、Zotero `itemKey`。
- 受影响消费者、迁移需求、兼容性策略和安全边界。
- 旧 API 清理清单；除已批准的 Codex/Pi Agent v1 外，当前 V2 不恢复通用 Provider/AI 执行 API。

## Outputs

- 可生成/解析的 Zod schema 与 TypeScript 类型，包含 required/optional/null 语义。
- command/query 请求、响应、分页/批量结果、冲突/取消/不可用错误合同。
- ID/authority/revision 说明和迁移影响清单；向 Workspace Service、Frontend、Desktop、Database 发出结构化通知。

## Gates and stop conditions

- 不接受 `Record<string, unknown>`、未定义的第七个 Task 状态、隐式浏览器时区或把只读虚拟事件当可写事件。
- 所有写 command 明确 `expectedRevision`；硬删明确 `confirmed` 和上下文；外部写入明确用户确认。
- 任何会破坏现有消费者的字段/enum 变化先暂停，列出兼容策略和回滚方案。
- 当前版本拒绝通用 Provider、AI Job 和主动 RAG API；Codex/Pi Agent v1 的 run/event/automation 合同仅按 `packages/contracts/src/agent.ts` 暴露。

## Handoff

交付 `Contract delta / consumer list / migration impact / compatibility decision / validation command + exact result / unresolved risk`。发送给 Workspace Service、Database、Frontend、Desktop Backend 和相关 feature owner；未获 Supervisor 决策不得标记 DONE。
