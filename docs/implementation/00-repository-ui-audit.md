# Task 0：仓库与界面审计

状态：DONE（只读静态审计，未将功能标记为已交付）

## 已确认根因

### 右上角问号

- `apps/desktop/src/renderer/src/features/research/literature.tsx:333` 直接渲染文本 `?`，它不是未知字符，也不是系统图标。
- 点击后只调用 `setFeedback(...)`。
- `apps/desktop/src/renderer/src/styles.css:2431-2433` 隐藏文献页成功反馈，因此用户看不到帮助内容。
- 修复方向：使用 `CircleHelp`/`HelpCircle`，配合可见 popover/dialog、`aria-expanded`、Escape 和焦点管理。

### Inspector 预览滚动

- `literature.tsx:107-108` 把长文献正文和导入预览作为同一 `ResearchPanel` 的相邻内容。
- `styles.css:2344-2349` 对面板使用固定高度和内部滚动，窄屏又切换为自然高度，造成嵌套滚动和确认区不稳定。
- 修复方向：内容区唯一滚动；预览/操作区 sticky footer；生成预览后移动焦点并宣布状态。

### Collection 写入失效

- 搜索页在 `literature.tsx:206` 正确把 `targetCollectionKey: collectionKey` 放入 preview。
- `integration-runtime.ts:723` 把它传入 `writePaperToZotero`。
- 新建 item 在 `connectors/src/zotero.ts:851-865` 使用目标 Collection。
- 但已有 item 更新在 `connectors/src/zotero.ts:811-815` 使用 `projection.collections`，而 `paperProjection` 来源于本地 Paper 的旧 collections；当前选择未注入 PATCH。
- 修复方向：预览中冻结目标 Collection；更新时明确把目标 key 设置为 PATCH collections，并在回执中显示实际目标；若空值代表保留当前 Collection，必须明确协议和 UI 文案。

## 界面/功能缺口

- Literature staging 顶部没有全选。
- Zotero item 列表没有当前页全选。
- Obsidian `TreeBranch` 的 `showSelection` 未传入，批量选择 UI 与文件复选框断开。
- Zotero Paper→Zotero 维护了 `paperIds` 但当前页面没有可见 Paper selector，流程不可达。
- Literature Inspector 的“笔记”“相关文献”只是无效 tabs。
- Dashboard 资源卡失败后没有原地重试。
- Project Space 嵌入 Matrix 造成双重 `.page-scroll`。
- 小窗口主 Sidebar 没有抽屉/可用折叠；Agent history 窄屏隐藏后无重开入口。
- Collection 树在 button 内嵌套另一个 role=button，键盘语义不合法。
- Agent Inspector 长 Input/Output 可能被父容器裁切。
- 自定义 Agent 动画和 smooth scroll 未完整响应 reduced-motion。

## 参考证据

- `README.md`：功能现状和未完成清单。
- `docs/plan/04-文献检索.md`、`05-Obsidian.md`、`06-Zotero.md`、`08-Agent运行时.md`、`09-2026-09-08-full-requirements.md`：需求和历史验收边界。
- `packages/workspace-service/src/agent-coordinator.ts` 与 `packages/agent-runtime/src/index.ts`：last30days/Agent/调度主干。

## 验收限制

本任务没有把静态审计当作 E2E；真实 Zotero、Obsidian、CLI、Python、网络和 NSIS 仍需要后续任务验证。
