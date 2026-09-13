# V2 开发文档索引

本文档集区分当前已实现的基础功能与后续增强。当前事实优先级为：共享 Zod 合同、数据库 migration、当前代码、本文档和开发进度 CSV。测试源码已按用户要求删除，因此不再存在测试通过证据。

## 当前快照

| 能力 | 状态 | 代码/文档 |
| --- | --- | --- |
| V2 Shell、九个一级页面、Tabs、Inspector、状态栏 | 已实现基础功能 | `apps/desktop/src/renderer/src/App.tsx` |
| 项目、任务、看板、进度、持久化 | 已实现 | `packages/database`、`features/tasks.tsx` |
| Calendar CRUD 与任务/项目截止投影 | 已实现基础功能 | `features/calendar.tsx`、migration v5 |
| Crossref/OpenAlex/本地检索与导入 | 已实现基础功能 | `packages/workspace-service/src/literature-runtime.ts` |
| Obsidian Markdown 基础编辑 | 已实现基础功能 | `features/obsidian.tsx`、`packages/connectors` |
| Zotero Collections/Items/本地导入、Better BibTeX 批量导出与 RIS/BibTeX 中转包 | 已实现基础功能，待发布门禁 | `features/zotero.tsx`、`packages/connectors/src/zotero.ts` |
| Workspace Service + V2 Preload + 本机 MCP | 已实现基础链路 | `packages/workspace-service`、`packages/workspace-mcp` |
| Codex/Pi Agent 运行时、run/event/artifact/inbox、应用存活期间每日自动化 | 第一轮已接入，待 QA/Security 独立验收 | `packages/agent-runtime`、`features/agent.tsx`、[Agent 计划](plan/08-Agent运行时.md) |
| Windows 安装器、真实外部服务、完整发布门禁 | 未重新验收 | 见当前代码和发布环境 |

## 阅读路径

- [V2 总体架构](architecture/ARCHITECTURE.md)
- [V2 数据模型](architecture/DATA_MODEL.md)
- [仪表盘](plan/00-仪表盘.md)
- [日历](plan/01-日历.md)
- [任务](plan/02-任务.md)
- [项目空间](plan/03-项目空间.md)
- [文献检索](plan/04-文献检索.md)
- [Obsidian](plan/05-Obsidian.md)
- [Zotero](plan/06-Zotero.md)
- [设置](plan/07-设置.md)
- [Agent 运行时与自动化](plan/08-Agent运行时.md)

每个模块只有一个固定计划文件（`00–08`）；跨模块约束直接写入受影响的模块文件，并由 `docs/development-progress.csv` 记录实现证据。旧的总览、全局接入、文档一致性、V2 执行和 Vault 工作流合并稿已归档，不再作为活动计划源。

## 当前非目标

AnythingLLM 与 LLMWiki 当前提供配置和只读健康探测元数据，不承诺已接入 RAG/索引执行；Agent 使用应用内 Codex/Pi read-only runtime，定时任务仅在应用存活期间运行，并支持暂停/启用。Zotero 在 capability probe 允许且用户明确确认时可经受控 API 写入，否则生成可下载的 RIS/BibTeX 中转包；不会直接写 `zotero.sqlite` 或复制附件。应用关闭后的后台调度、远程 MCP、完整持久 Approval/checkpoint、PDF/向量检索、富文本引用、无人值守外部写回、durable outbox、备份恢复和代码签名仍属于后续阶段；桌面端已接入 GitHub Release 的用户确认式应用内更新。
