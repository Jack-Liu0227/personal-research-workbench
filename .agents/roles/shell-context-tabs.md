# Shell, Context Menu & Tabs

## Agent wave boundary

Shell 只负责将 Agent route 注册到导航和 WorkspaceTab，页面业务逻辑留在 features/agent.tsx。新增 route 不得改变现有 tab 持久化、context-menu 和 sender trust 语义。

## Mission and ownership

负责 `docs/development/08-shell-context-tabs.md` 的全局交互壳：`App.tsx`、WorkspaceTabs、route/context 注册、移除 FOCUS 导航并统一“我的任务”入口、默认复用/显式新标签、重启恢复清理、全局 capability 驱动右键菜单和当前版本 AI UI 移除。

## Editable paths

- 唯一写集：`apps/desktop/src/renderer/src/App.tsx`、WorkspaceTabs 状态/组件及 Shell context-menu wiring。
- `components/ui.tsx`、全局样式、queries、preload/contracts 由平台 owner 写；功能页只能注册 capability/回调，不复制菜单或 tab 逻辑。

## Required inputs

- 冻结的 `WorkspaceTab`、`ContextMenuTarget`、capabilities、route/entity/context 合同和安全 preload API。
- 各领域可用命令/查询、未保存 Obsidian 编辑状态和 Frontend Platform 的中文键盘/焦点规范。

## Outputs

- 导航/项目切换/详情默认复用当前 tab；`+`、Ctrl/Command-click、右键“新标签”创建稳定 tab。
- 关闭当前/其他/右侧/全部、固定/复制、未保存 Markdown 的保存/放弃/取消保护；任务、文献、项目、笔记、日历、Zotero 条目的右键与 Shift+F10 等价入口。
- 从 UI、contract、service route 和主动依赖移除 AI Provider/Job/Prompt Template/Automation 入口；保留知识库映射查看。

## Gates and stop conditions

- 菜单只由 capability 生成，不能执行任意字符串命令；只读对象不显示危险写操作；不可实现菜单隐藏而非假按钮。
- 不把 `window.open`、generic IPC 或外部 SDK 暴露给 Renderer；未保存文件关闭前不丢数据。
- 任何新增 route/tab 字段、共享 ContextMenuTarget 或 AI route 争议先交 Architecture & Contracts/Supervisor。

## Verification

记录 1024×720/1440×900 的标签与菜单键盘流程、重启恢复、未保存保护、AI UI grep/人工证据和实际命令结果。

## Handoff

接收角色为 Frontend Platform、Desktop Backend、各 feature owner、QA、Review & Security。
