# Task Board & Todo

## Mission and ownership

负责 `docs/development/01-tasks-board.md` 与 `docs/plan/02-任务.md` 的端到端结果：只保留“我的任务”入口（移除 FOCUS 分组/页面）、完整看板和列表、归档/恢复/硬删、无项目 Todo 随记、日期筛选、跨页批量操作，以及中文/右键/键盘等价入口。看板、列表、日历、仪表盘和项目空间必须复用同一套 Task Command。

## Editable paths

- 主写集：`apps/desktop/src/renderer/src/features/tasks.tsx`、`features/board.tsx`。
- 演示数据脚本可以新增在既有 scripts 约定下，但必须只接受显式 `--database`。
- `features/pages.tsx`、`features/queries.ts`、contracts、database、service 和共享 UI 只读；需要改变时提交 proposal 给相应 owner。
- `features/forms.tsx` 默认仍由 Frontend Platform 维护；本轮经 Supervisor 明确授权，仅可增加 `CreateTaskDialog` 的受控 `open/onOpenChange/defaultColumnId/defaultStatus` 兼容 props，不得扩大到其他表单或业务语义。

## Required inputs

- 冻结的 Task DTO/commands、revision 和软删/硬删规则。
- Workspace Service 的分页、日期 `[from,to)`、批量失败明细和 timezone 行为。
- Frontend Platform 的中文 token、ContextMenu、键盘/焦点和查询失效接口。

## Outputs

- 五个主状态列加归档视图、统一拖动/键盘/右键状态移动、Inspector 更新；不创建 Focus 专用页面。
- Todo 随记快速捕获时 `projectId=null` 且不强制选项目；用户可在“我的任务”中主动补全。跨页 `none/page/all-results/explicit` 选择与批量进度/失败明细。
- 今天/明天/未来 7 天/逾期/无日期/自定义区间筛选；隔离的 `seed:demo`/`clear:demo` 行为说明。

## Gates and stop conditions

- 归档是可恢复软删；单任务“直接删除”允许任意生命周期但必须显式确认，批量硬删仅限已归档，不能静默丢数据。
- 不在 Renderer 过滤全部任务、不写 SQL、不直接调用 IPC/外部服务、不把 Todo 写进 Obsidian。
- revision 冲突或部分失败不能显示成功；跨时区边界交给 Service/SQLite。
- 若发现共享文件冲突、未冻结状态或缺失命令，暂停并通知 Supervisor/Workspace Service。

## Verification

记录实际运行的 `pnpm typecheck`、`pnpm build`（以及 Supervisor 要求的其他命令）、隔离数据库路径和人工验收步骤。

## Handoff

交付 `Outcome / paths / contract or service requests / command results / screenshots or flow evidence / risks / next role (Frontend + QA)`。
