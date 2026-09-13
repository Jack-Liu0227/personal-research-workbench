# Task 4：统一全选与批量操作

状态：IN_REVIEW（实现完成并通过 `pnpm typecheck` / `pnpm build` / `pnpm test:e2e`；逐列表人工点检与部分列表的交互断言未全部覆盖，见文末「未验证」）
依赖 Task 3

## 目标

所有真正支持多选的列表都提供一致的当前页/当前筛选结果全选、清除、半选和选择范围说明。

## 实施步骤

1. 抽出唯一的选择控件：native checkbox + `indeterminate` + `aria-label` + 可见计数 + `清除选择` + 强制范围说明。
2. 逐列表接入，并为每个列表写清「全选」的真实边界（当前页 / 已加载页 / 当前筛选 / 单页上限 / 未渲染条数）。
3. 修复 Obsidian 文件树批量入口（`showSelection` 从未传入 `TreeBranch`）并区分目录与文件选择域。
4. 分页、筛选、Collection、项目切换时给出明确的保留或清除策略。
5. 批量删除/归档/外部写入保持确认 + CAS + 逐条回执。
6. 流程起始处的项目绑定默认到「最近使用的项目」，同时保留显式「未分类」。

## 实现记录

1. 共享控件 `apps/desktop/src/renderer/src/components/selection.tsx`（新增）：
   - `SelectionCheckbox`：native checkbox，`indeterminate` 通过 `ref` + `useEffect` 写入真实 DOM 属性（`node.indeterminate = indeterminate && !checked`），并保留调用方传入的 `aria-label`。
   - `SelectionBar`：`role="group"`，**`scope` 为必填**（列表之间「全选」的语义不同，文案必须写明生效范围）；计数在 `role="status" aria-live="polite"` 中显示 `已选 N / M` 或空选时的 `共 M`；提供 `清除选择`、`disabled`（空列表）和作为 children 的批量动作按钮。
   - 样式集中在既有唯一 `styles.css`：`.selection-bar*`；Agent 历史窄栏用 `.selection-bar-compact` 让范围文案换行而不溢出。
2. 最近项目默认 `apps/desktop/src/renderer/src/lib/recent-project.ts`（新增）：`workbench-recent-project:v1` 为 renderer-only localStorage（try/catch 包裹，与既有 `workbench-*` 偏好一致）；`useDefaultProjectId(projects)` 返回 `{ projectId, chooseProjectId, setProjectId }`。`chooseProjectId` 表示「用户显式选择」→ 立即生效并记住；`setProjectId` 用于程序化赋值（例如打开已有对话）→ 不覆盖记忆；显式选择「未分类」会清除记忆，使下一次流程同样默认不绑定。
3. Obsidian 文件树（`features/obsidian.tsx`）：
   - 根因修复：`selectionMode` 状态此前从未被渲染或传递，`TreeBranch` 的 `showSelection` 永远为 `false`，批量入口实际不可用。现在树头部新增 `批量选择` 开关（`aria-pressed`、`aria-label` 进入/退出批量选择），并把 `showSelection={selectionMode}` 传给 `TreeBranch`；退出时若仍有选择则清空并给出反馈。
   - 选择域区分：全选只在 `visibleFilePaths`（仅 `.md` 文件，不含目录）上生效，目录删除仍在「知识库分类」（只处理空文件夹）。
   - 真实可点击：既有 CSS `.vault-note-checkbox { opacity:0; pointer-events:none }` 只在 `.group:hover` 下恢复，而行容器没有 `group` 且 `pointer-events:none` 会拦截点击，导致批量模式下复选框既不可见也不可点。现在批量模式附加 `.vault-note-checkbox-active` 强制可见可点，行容器补 `group`。
   - 批量删除使用 `window.confirm` + 逐条 `NoteDeleteReceipt` 回执（区分 `deleted` 与删除前已不存在），中途失败如实说明不会回滚。
4. Literature（`features/research/literature.tsx`）：
   - 检索结果：`全选当前页`，范围文案写明「仅覆盖当前页筛选后的 N 条（本页 X 条、已加载 Y 条）；翻页保留已选、重新检索清空、绝不选中未加载页」；列表为空时 disabled。
   - 待分类：`全选当前结果`，范围写明「项目筛选「label」下已加载的 N 条（单页最多 100 条，不代表全部记录）」；新增 `分派到最近项目：X` 快捷动作。
   - 检索结果与待分类共用一个 id 集合，因此 `清除选择` 只清除属于该列表域的 id，计数也等于该域批量按钮实际作用的集合。
5. Zotero（`features/zotero.tsx`）：条目列表按页累积，故文案为 `全选已加载条目`，范围写明「单页最多 50 条、加载下一页保留已选、切换 Collection/查询词/连接会清空已选」（后两条由既有 reset effect 实现，文案与之对齐）；`导出项目标签` 默认最近项目并保留 `#未分类（不绑定项目）`。
6. Project Space（`features/project-space.tsx`）6 个列表统一：资源关系（全量、无分页）、项目笔记（仅当前渲染的 20 条，明确「超过 20 条的部分未渲染也不会被全选」）、项目文献（该项目全部未归档文献；动作改名为 `归档选中`，因为它调用 `papers.archive`）、项目日历（当选月可编辑事件 N 条，M−N 条只读投影不参与选择）、知识库分类（Vault 根级目录，仅空文件夹可删）。
7. Matrix（`features/research/matrix.tsx`）：范围写明当前项目筛选与「无分页」，并明确「删除为永久操作、不会删除原文献」。
8. Tasks（`features/tasks.tsx`）：接入共享 bar 并补半选；原 `选择当前页任务` 改名 `选择当前筛选结果`（任务列表无分页，`tasks.list` 不带上限），服务端批量语义的 `选择全部结果` 作为独立按钮保留；计数改为与过滤结果求交集，保证「已选 N」永远等于批量请求实际发送的集合。
9. Agent（`features/agent/index.tsx`）：
   - 历史栏接入共享 bar，范围写明当前筛选与「切换筛选会清除已隐藏的已选对话」，并新增 prune effect 让选择集合跟随可见集合（否则计数与 `归档选中` 作用的集合会不一致）。
   - 语义修正：按钮 `删除选中` → `归档选中`，对话动作 `aria-label` `删除对话：X` → `归档对话：X`，确认/成功/失败文案统一为「归档」，并说明归档只是从当前历史隐藏、本地记录仍可恢复（底层是 `conversations.archive` / `archiveBulk`，不是永久删除）。
   - 输入区的 `在项目中工作` 默认最近项目，`未分类（不绑定项目）` 保持显式可选；打开已有对话使用 `setProjectId`，不覆盖记忆的默认值。
10. `scripts/e2e-electron.cjs` 新增断言（均在既有导航路径上执行，无新增依赖）：
    - Project Space 知识库分类：bar 与范围文案存在、单条勾选后全选控件为半选（`checked=false` 且 `indeterminate=true`）、计数 `已选 1 /`、`清除选择` 回到 `共 `、键盘 Space 全选/再按一次清除。
    - Tasks：范围文案、单条勾选后的半选状态与计数、`清除选择` 复位。
    - Obsidian：批量模式外文件复选框数量为 0、`进入批量选择` 存在、进入后出现文件复选框、勾选一条后全选状态与文件域总数一致、`退出批量选择` 后复选框重新隐藏。
    - Literature：结果 bar 存在、边界文案含「全选仅覆盖当前页筛选后」、空列表时全选 disabled。
    - Zotero：条目 bar 存在、切换 Collection/查询词/连接清空已选的文案存在。
    - 最近项目默认：在 Agent 输入区选择项目后，Literature `导入项目` 与 Zotero `导出项目标签` 都默认该项目，且两侧都保留显式未分类 option。
    - Agent：对话动作选择器改为 `button[aria-label^="归档对话："]`（保持「打开应用不得创建对话」的断言有效）。

## 证据

```powershell
pnpm typecheck   # PASS（10/10 workspace projects）
pnpm build       # PASS（renderer index-*.js 2000.11 kB，index-*.css 185.15 kB）
pnpm test:e2e    # PASS（project-space category controls / task date filter + delete / Zotero bridge surface /
                 #        Obsidian combined editor/category controls 均包含本任务新增断言）
```

- e2e 覆盖的选择行为：空列表 disabled、单条选择、半选（`indeterminate`）、全选、清除、键盘 Space 切换、范围文案、最近项目默认。
- 只读与安全约束未变：多个 checkbox 的取值仅存于组件状态与 localStorage 偏好；批量删除/归档/外部写入仍走确认 + CAS + 逐条回执；renderer 未新增 Node/DB/凭据访问。

## 已修复的既有缺陷

- `showSelection` 从未传入 `TreeBranch`，Obsidian 批量选择入口与复选框全部不可用（同时修复了「不可见且 `pointer-events:none` 导致无法点击」的 CSS 缺口）。
- Obsidian 全选此前包含目录 `relativePath`，会静默选中未渲染的目录节点；现在只覆盖文件。
- Agent 历史把可恢复的归档写成「删除」「此操作不可撤销」；文案与实际 `archive` 语义不符。
- Tasks 的已选计数取自未过滤的选择集合，筛选后可能显示批量动作无法作用的条数；现在与过滤结果求交集。

## 已知遗留（未在本次范围修复）

- `features/project-space.tsx` 中的 prune effect 依赖 `query.data ?? []` 形式的派生数组；在查询尚未返回时该依赖每次渲染都是新数组，会重复触发一次 setState。属既有写法，本次未改动（不影响任务范围内行为，e2e 稳定通过）。
- `features/zotero.tsx` 的 Paper → Zotero 导出面板仍是不可达死代码（renderer 无 `paperToZotero.preview` 调用）；本次只同步其选择控件文案，入口归 Task 6。

## 未验证（不得据此标 DONE）

- 本任务交付 12 条选择 bar。e2e 只对 Project Space 分类、Tasks、Obsidian 文件树、Literature 检索结果、Zotero 条目、Agent 默认项目做了断言；**Matrix、Project Space 的资源关系/笔记/文献/日历、Literature 待分类**这些列表只验证了组件渲染与范围文案（或根本未渲染：该 e2e profile 无矩阵记录、无 Zotero 条目、未切到待分类 tab）。它们与已覆盖列表共用同一个组件与同一套计数逻辑，但逐列表的全选/半选/清除接线未逐条断言。
- Agent 历史栏 bar：e2e profile 中对话数为 0，该 bar 不渲染，因此其半选/清除/filter-prune 只有代码与类型层面保证，无运行断言。
- 「未分类会清除最近项目记忆」这一分支未断言。
- 12 条 bar 的窄屏/响应式截图点检（Task 8 范围）未做。
- 因此本任务状态保持 IN_REVIEW，待 Supervisor 判定；逐列表人工点检完成后才可考虑 DONE。
