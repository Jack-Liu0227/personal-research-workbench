# Agent roles

本轮新增 Agent Runtime 角色，负责 Codex/Pi 的运行时适配、Agent run/event、自动化和收件箱；完整边界见 [agent-runtime.md](agent-runtime.md) 与 [docs/plan/08-Agent运行时.md](../../docs/plan/08-Agent运行时.md)。该角色不得绕过 Architecture & Contracts、Database、Desktop Backend、Integrations 或 QA gate。

本目录采用“两层角色”模型，服务于 `docs/development/01` 至 `09` 的研究-MVP 开发；模块产品计划固定维护在 `docs/plan/00` 至 `08`：

1. **功能 owner** 对一个用户可验收的纵切面负责，维护该功能的验收标准、实现拆分和 handoff。
2. **平台/gate owner** 维护共享合同、基础设施和独立质量门禁。功能 owner 不得绕过平台 owner 直接修改共享热点。

角色文件不是人格描述，而是可执行的任务书。每次派工必须附带：

`Objective / Spec / Non-goals / Editable paths / Read-only dependencies / Frozen contracts / Required evidence / Stop conditions / Receiving role`

## 九个功能 owner

| 功能 | 角色文件 | 主要写集 | 依赖/交接 |
| --- | --- | --- | --- |
| 01 任务看板与 Todo | [task-board-todo](task-board-todo.md) | `features/tasks.tsx`、`features/board.tsx`；演示数据脚本 | Database、Workspace Service、Frontend |
| 02 Obsidian 连接 | [obsidian-connection](obsidian-connection.md) | `features/obsidian.tsx`、设置页 Obsidian 区；经授权的 Obsidian adapter slice | Integrations、Desktop Backend、Workspace Service |
| 03 项目空间 | [project-space](project-space.md) | `features/project-space.tsx` | 01/02/04/05/06/07 的稳定查询与文件关联合同；Wave 2 |
| 04 文献批量与 Zotero 导入 | [literature-zotero-import](literature-zotero-import.md) | `features/research/literature.tsx` | Zotero Local、Desktop Backend、Workspace Service |
| 05 Obsidian 项目目录 | [obsidian-project-layout](obsidian-project-layout.md) | 独立 layout service 模块；目录聚合映射 | Obsidian Connection、Database、Workspace Service；Wave 2 |
| 06 Zotero 本机联动 | [zotero-local](zotero-local.md) | `features/zotero.tsx`、经授权的 Zotero adapter slice | Integrations、Desktop Backend、Workspace Service |
| 07 展开式日历 | [calendar](calendar.md) | `features/calendar.tsx` | Database、Workspace Service、Frontend |
| 08 Shell/标签/全局右键 | [shell-context-tabs](shell-context-tabs.md) | `App.tsx`、`WorkspaceTabs`、Shell context menu | Architecture Contracts、Frontend、Desktop Backend；Wave 1 |
| 09 Agent 运行时与自动化 | [agent-runtime](agent-runtime.md) | `packages/agent-runtime`、Agent Coordinator、Agent 页面与 MCP 只读工具 | Architecture Contracts、Database、Desktop Backend、Integrations、Literature/Zotero、QA、Review/Security；本轮 IN_REVIEW |

“主要写集”不等于永久授予权限。每个 wave 仍只允许一个 worktree/agent 写一个文件；跨写集修改必须由共享 owner 串行应用。

## 必要的平台与 gate owner

| 角色 | 角色文件 | 唯一责任 |
| --- | --- | --- |
| Supervisor | [supervisor](supervisor.md) | 产品决策、依赖 DAG、wave 调度、CSV、最终验收；不自批安全 |
| Architecture & Contracts | [architecture-contracts](architecture-contracts.md) | 受 Supervisor 委托维护 `packages/contracts`、ID/authority/revision 语义和 ADR |
| Database | [database](database.md) | schema、migration、repository、事务和索引；功能角色只能提交变更提案 |
| Workspace Service | [workspace-service](workspace-service.md) | `packages/workspace-service` 的跨实体读写、错误和事务编排 |
| Frontend Platform | [frontend](frontend.md) | 共享查询/组件/样式/可访问性基础；功能页面由对应 feature owner 负责 |
| Desktop Backend | [desktop-backend](desktop-backend.md) | Main/Preload/Core、受控外部打开、进程隔离和 Windows 打包 |
| Integrations Platform | [integrations](integrations.md) | Link Registry、IntegrationCoordinator、适配器基线和外部写入安全评审 |
| QA & Acceptance | [qa](qa.md) | 跨层验收、重启持久化、真实连接和 Windows x64 smoke；不代替 owner 修复 |
| Review & Security | [review-security](review-security.md) | 独立安全、隐私、数据损失、RCE、许可证和发布门禁 |
| AI 执行角色（旧） | **已归档** | 旧 V2 AI 执行角色不再作为入口；Codex/Pi 第一轮由 [Agent Runtime](agent-runtime.md) 负责，仍受 read-only、safeStorage、Approval/Outbox 和 QA/Security gate 约束 |

## 推荐并行波次

### Wave 0：冻结共享面（必须先完成）

Supervisor、Architecture & Contracts、Database、Workspace Service 先冻结 V2 DTO、ID 关系、revision、日期/timezone、虚拟日历事件、`ResourceLink`、`WorkspaceTab` 和 service method。任何功能代理在此之前只能读代码和提交 proposal。

### Wave 1：无共享写集的功能实现

可并行启动：01、02、04、06、07、08。02/06 的 adapter 代码须由 Integrations Platform 先划定 delegated slice；08 独占 `App.tsx`/tabs；任何跨域改动回到平台 owner。每个功能完成后只能进入 `IN_REVIEW`。

### Wave 2：依赖聚合

先完成 05 的目录/layout 合同，再实现 03 项目空间聚合。两者都不得复制 Obsidian 正文、Paper 或 Task 的第二套业务逻辑，也不得加入 AI 执行入口。

### Wave 3：整合与门禁

Frontend Platform 做跨页面中文/键盘/右键一致性；QA 执行统一验收和隔离数据验证；Review & Security 独立复核。涉及安装包时由 Desktop Backend 提供真实 Windows x64 安装产物，QA 执行安装/重启/卸载 smoke，Supervisor 最后更新状态。

## 共享写集和冲突规则

| 写集 | 唯一 writer | 功能 owner 的做法 |
| --- | --- | --- |
| `packages/contracts/src/*` | Architecture & Contracts（Supervisor 决策） | 提交 DTO/兼容性 proposal，不重复定义类型 |
| `packages/database/src/schema.ts`、`migrations.ts`、`repository.ts` | Database | 提交 data-change request，不在页面或 service 写 SQL |
| `packages/workspace-service/src/*` | Workspace Service | 提交 command/query/error proposal，跨实体写入必须走 Service |
| `apps/desktop/src/renderer/src/App.tsx`、tabs/context menu | Shell/标签 owner | 通过 props/注册表接入，不在功能页复制 Shell 逻辑 |
| `apps/desktop/src/renderer/src/components/*`、`queries.ts`、全局样式 | Frontend Platform | 提交组件/查询需求，不创建第二套 design token 或 fetch 层 |
| `packages/connectors/src/obsidian.ts` | Obsidian Connection delegated slice + Integrations review | 只通过安全文件原语提案，保留 root/realpath/symlink 检查 |
| `packages/connectors/src/zotero.ts` | Zotero Local delegated slice + Integrations review | 只通过 Local/Web API，不读写 `zotero.sqlite` |

禁止两个 agent 同时修改同一文件。发生冲突时暂停较晚的 patch，由 writer 串行应用并在 handoff 中记录。

## 统一状态与 handoff

- 状态只用 `BACKLOG / READY / IN_PROGRESS / BLOCKED / IN_REVIEW / DONE`。
- 功能 owner 的 handoff 必须写：`Outcome / Changed paths / Contract or migration delta / Commands actually run + exact result / Manual evidence / Known risks / Next receiving role`。
- 未运行的命令、mock 的外部服务、只生成但未安装验证的 EXE、计划功能都不能写成完成。
- `DONE` 需要 QA 证据，并在涉及安全/外部写入/迁移/依赖许可/安装包时取得 Review & Security 或相应独立 gate。

## 设计参考

本分层借鉴公开的 role-based 和 orchestration 实践：Microsoft Agent Framework 区分 sequential/concurrent/handoff，并建议只对无依赖工作 fan-out；Microsoft VS Code 的 subagent 文档将 Planner、Architect、Implementer、Reviewer 分开并限制工具；Anthropic 的 orchestrator-worker 强调每个 worker 要有目标、输出格式和边界；MetaGPT/ChatDev 将产品、架构、实现、测试交接物结构化。参考：

- [Microsoft Agent Framework orchestration](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/)
- [Microsoft VS Code subagents](https://github.com/microsoft/vscode-docs/blob/main/docs/agents/subagents.md)
- [Anthropic multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [MetaGPT introduction](https://github.com/geekan/MetaGPT-docs/blob/main/src/en/guide/get_started/introduction.md)
- [ChatDev paper](https://aclanthology.org/2024.acl-long.810.pdf)

## 本轮调用入口

本轮以 `docs/development/README.md`、共享合同和 `docs/plan/00` 至 `08` 为执行基线。Supervisor 先完成 Wave 0 冻结，再为各功能纵切面分别调用对应 role；Agent Runtime 还必须经过 QA 与 Review/Security 独立门禁：

```text
task-board-todo.md
obsidian-connection.md
literature-zotero-import.md
zotero-local.md
calendar.md
shell-context-tabs.md
agent-runtime.md
```

每个 agent 必须在消息中收到 `Objective / Spec / Non-goals / Editable paths / Read-only dependencies / Frozen contracts / Required evidence / Stop conditions / Receiving role`，且只写自己的 editable paths。Supervisor 收齐所有 `worker_done` 后，才调用 `project-space.md`、`obsidian-project-layout.md`、`frontend.md`、`qa.md` 和 `review-security.md` 进入后续 wave。共享合同、migration、repository、dispatcher、App shell 和进度 CSV 仍遵守 one-writer 规则。

本轮已实际调度的并行 worker：Task Board lane quick-create（受 Supervisor 委托，在 `board.tsx` 外增加 `forms.tsx` 受控 props）、Zotero Local delegated connector（只写 `packages/connectors/src/zotero.ts`）、Literature session cleanup（受 Supervisor 委托串联 Contracts/Database/Workspace Service）、QA Wave 1 gate（只读验收）。每个 worker 的回报都必须区分已运行命令、未运行命令、真实外部状态和风险；任何一个 worker 未回报前不得把对应 wave 标成 `DONE`。

仓库当前未找到 `docs/operations/AGENT_PLAYBOOK.md`；角色以本 README、根目录 `AGENTS.md` 和各 `docs/development/*.md` 为可用约束，缺失 playbook 不得被假设为已读取或已执行。
