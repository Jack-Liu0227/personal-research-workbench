# V2 开发文档索引

本文档集区分当前已实现的基础功能与后续增强。当前事实优先级为：共享 Zod 合同、数据库 migration、当前代码、本文档和开发进度 CSV。根 `pnpm test` 是空入口；验收证据来自命名脚本、`pnpm -r typecheck`、构建和 E2E。

## 当前快照

| 能力 | 状态 | 代码/文档 |
| --- | --- | --- |
| V2 Shell、研究页面、Tabs、Inspector、状态栏 | 已实现基础功能 | `apps/desktop/src/renderer/src/App.tsx` |
| 项目、任务、看板、进度、持久化 | 已实现 | `packages/database`、`features/tasks.tsx` |
| Calendar CRUD 与任务/项目截止投影 | 已实现基础功能 | `features/calendar.tsx`、migration v5 |
| Crossref/OpenAlex/本地检索与导入 | 已实现基础功能 | `packages/workspace-service/src/literature-runtime.ts` |
| Obsidian Markdown 基础编辑 | 已实现基础功能 | `features/obsidian.tsx`、`packages/connectors` |
| Zotero Collections/Items/本地导入、Better BibTeX 批量导出与 RIS/BibTeX 中转包 | 已实现基础功能，待发布门禁 | `features/zotero.tsx`、`packages/connectors/src/zotero.ts` |
| Workspace Service + V2 Preload + 本机 MCP | 已实现基础链路 | `packages/workspace-service`、`packages/workspace-mcp` |
| 进程内 Pi Agent、run/event/ledger/inbox、MCP 业务工具、应用存活期间自动化 | 已接入，外部写入仍需用户确认；待 QA/Security 独立验收 | `packages/agent-runtime`、`packages/workspace-mcp`、`features/agent/index.tsx`、[Agent 计划](plan/08-Agent运行时.md) |
| Windows 安装器、真实外部服务、完整发布门禁 | 未重新验收 | 见当前代码和发布环境 |

## 阅读路径

- [Quick Start](QUICK_START.md)
- [Agent 使用教程](AGENT_USER_GUIDE.md)

- [后端实现：进程内 Pi Agent](implementation/24-pi-inprocess-agent-backend.md)
- [前端实现：Agent 对话与设置](implementation/25-agent-conversation-ui-and-settings.md)
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

## 当前边界

AnythingLLM 与 LLMWiki 当前提供配置和只读健康探测元数据，不承诺已接入 RAG/索引执行；Agent 使用应用内进程内 Pi runtime，定时任务仅在应用存活期间运行，并支持暂停/启用。Agent 可读取定时规则、运行历史和非秘密参数；规则编辑仍在定时任务页面完成。Zotero/Obsidian 外部写入统一走 `.request` → preview/fingerprint → 用户确认 → IntegrationCoordinator，不能无人值守；不会直接写 `zotero.sqlite` 或 `.obsidian/`。应用关闭后的后台调度、远程 MCP、PDF/向量检索、富文本引用、durable outbox、备份恢复、真实 Windows 安装/OAuth/外部写入 smoke 和代码签名仍需独立环境验收。
