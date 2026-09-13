# Task 8：全界面 UX、可访问性和发布验收

状态：IN_REVIEW（实现与本地门禁完成；Windows x64 NSIS 构建/安装/启动/卸载 smoke 已在 0.0.2 发布轮执行并留证 → [`21-windows-nsis-0.0.2-release.md`](21-windows-nsis-0.0.2-release.md)；真实 Zotero/Obsidian/CLI 验收、打包态逐页 UI 回归、深浅色成对截图仍未执行）

## 目标

完成所有页面的一致交互和发布前证据，不仅修一张文献检索截图。

## 审计范围

- Shell：主 Sidebar 窄屏抽屉、主题按钮 label/title、Tabs、项目上下文、状态栏。
- Literature：帮助、滚动、Collection、全选、空态、错误重试、假 tabs、响应式。
- Zotero：Collection 树键盘语义、items 全选、能力状态、只读/可写文案。
- Obsidian：批量模式、树/编辑/预览同高、目录和路径错误。
- Agent：历史抽屉、长 Inspector、账本事件、reduced-motion。
- Dashboard/Project Space/Calendar/Tasks/Matrix/Settings：原地 retry、嵌入滚动、键盘等价操作、删除确认和全选。

## 本轮修复（含证据）

| # | 缺陷（修复前） | 修复 | 证据 |
|---:|---|---|---|
| 1 | Dashboard 五张资源卡只显示“读取失败，请打开 X 页重试”，错误态没有原地重试入口 | `features/pages.tsx` 五个卡片改用共享 `ErrorState compact` + `onRetry={() => void query.refetch()}`；`components/states.tsx` 新增可选 `retryLabel`，让五个同名“重试”按钮各自具备唯一的可访问名（如“重试读取今日任务”） | 代码路径 + `pnpm typecheck`/`pnpm build`；**未在 e2e 中注入失败验证**，原因见「未验证」第 4 条 |
| 2 | Project Space 内嵌 `LiteratureMatrixPage` 造成嵌套 `.page-scroll`（内层抢滚轮、出现双滚动条） | `matrix.tsx` 新增 `embedded` prop，嵌入时渲染 `.matrix-embedded` 而不是 `.page-scroll`；`project-space.tsx` 传 `embedded` | e2e `embedded matrix single-scroller: ok`：项目空间恰好 1 个 `.page-scroll`、1 个 `.matrix-embedded`，且嵌入根自身不产生滚动 |
| 3 | ≤720px 时 CSS 已把 Sidebar 强制为 68px 图标栏，而折叠按钮仍显示“折叠侧栏 / aria-pressed=false”，点击无效（假状态）；文献页 `.literature-focus-shell > .sidebar` 在窄屏保留 200px | `App.tsx` 新增 `useNarrowViewport()`（`matchMedia('(max-width: 720px)')`）与 `narrowNavOpen`，用同一派生值驱动 class 与 `aria-pressed`/`aria-expanded`/label；窄屏打开为覆盖式抽屉（scrim + Esc 关闭 + 选择导航后自动收起）；移除 `document.querySelector('.sidebar')` 的 DOM 改写，改为 prop 驱动并保留 localStorage 偏好 | e2e `narrow sidebar drawer semantics: ok`（720px：rail 68 且 aria-pressed=true → 点击后抽屉 ≥180、label 可见、scrim 存在、aria-expanded=true → Escape 关闭 → 抽屉内点导航后自动收起） |
| 4 | 320px 下 `.topbar` 的快速 Todo 输入与“添加 Todo”被 `main-content` 裁掉，不可用；Zotero 三列工作区（14rem+1fr+14rem≈480px）在窄屏给页面带来 47px 横向滚动（实测 `documentElement.scrollLeft` 可移 47px） | `styles.css` 新增 Task 08 窄屏块：topbar/quick-todo/global-search 可收缩且不外溢；Zotero 工作区及其折叠变体在 ≤720px 折叠为单列；文献页 focus rail 窄屏固定 68px | e2e `responsive overflow sweep (1440/1080/720/320): ok`：10 个页面 × 4 个宽度，文档横向溢出 = 0，且无交互控件越出视口（豁免有意的横向滚动容器，如任务看板） |
| 5 | Agent 输入区固定宽度（`.agent-inline-input` 128px、`.agent-model-input` 168px）在 768px 溢出被裁；`≤720px` 规则把 `.agent-history-panel` 设为 `display:none`，对话历史完全不可达 | `styles.css` 新增 ≤900px 规则让 composer 配置项可收缩；窄屏保留 48px 历史 rail（含展开按钮），展开时改为覆盖式面板 | e2e 溢出扫描覆盖 Agent 页（1440/1080/720/320 全 0 越界）；历史 rail 的可达性由 `展开对话历史` 按钮 + 覆盖面板 CSS 保证，未做 320px 下的交互断言（见「未验证」第 3 条） |
| 6 | 帮助入口此前是裸 `?` 字形（Task 3 已修为 `CircleHelp` + Radix Dialog） | 本轮未改代码；补充窄屏可见性验收 | e2e 既有 `literature help dialog: ok`（按名打开、内容存在、Esc 后焦点回到触发器）+ 本轮 `help entry visible/actionable at 320px: ok`（可见、不越界、可打开对话框） |
| 7 | Inspector / Agent 长内容可滚动性无验收证据 | 未改代码（两处 CSS 已是单滚动容器）；新增结构化验收 | e2e `long-content scroll contract (Inspector/Agent): ok`：向 `.literature-inspector-scroll` 与 `.agent-thread-messages` 注入 4000px 内容后断言 `overflow-y: auto/scroll` 且 `scrollTop > 0` 且 `clientHeight ≤ 视口高度`（不撑大页面） |
| 8 | `docs/development-progress.csv` 被 `AGENTS.md`、`docs/README.md`、`docs/plan/*` 引用但仓库中不存在 | 新建 `docs/development-progress.csv`，如实记录 00–08 的状态与证据路径 | 文件本身；`pnpm test:e2e` 等证据路径见下 |

## 验收（实际执行）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | PASS（`packages/*` + `apps/desktop` 全部 Done） |
| `pnpm test` | **intentional no-op**：`node -e "console.log('Test suite intentionally removed; use typecheck and build gates.')"`，不宣称测试通过 |
| `pnpm build` | PASS（main/preload/renderer 全部构建成功） |
| `pnpm test:e2e` | PASS（真实 Electron + 隔离 profile；含本轮 6 组新断言） |
| `pnpm package:win` | **未运行（BLOCKED）**，见「未验证」第 5 条 |

`pnpm test:e2e` 本轮新增输出：

```
responsive overflow sweep (1440/1080/720/320): ok
narrow sidebar drawer semantics: ok
help entry visible/actionable at 320px: ok
embedded matrix single-scroller: ok
long-content scroll contract (Inspector/Agent): ok
responsive screenshots: <profile>\shell-<width>.png
e2e: PASS
```

## 截图与证据路径

`scripts/e2e-electron.cjs` 在隔离 profile（`%TEMP%\prw-workbench-e2e-*`）下产出：`shell-1440/1280/1050/768/320.png`、
`literature-smoke.png`、`agent-smoke.png`、`schedule-smoke.png`、`date-range-picker-smoke.png`。
本次运行的副本已归档到本地（`release*/` 被 `.gitignore` 忽略，不入库）：`release/ui-evidence-2026-09-13/`。

截图数据为新建隔离 profile 的真实空态（无演示数据），主题为当前系统主题。

## 未验证（保持 IN_REVIEW / BLOCKED 的部分）

1. **320/768/1050 属于 CSS/React 契约，不是打包应用可达到的窗口宽度**：`main/index.ts#createWindow` 固定 `minWidth: 1080`、`minHeight: 680`。窄屏断言只在 e2e 用 `win.setMinimumSize(320, 400)` 探针下成立；本轮未改动该最小值。
2. **深/浅色成对截图未做**：只截当前主题；`Theme`/`reduced-motion` 只做了静态复核（`motion-reduce:` 用法与 `transition` 类），未做逐页对比。
3. **键盘全流程未遍历**：已有断言为帮助对话框 Esc 焦点回归、抽屉 Esc 关闭、原生 checkbox 空格全选（Task 04 e2e）；未做整页 Tab 顺序/焦点陷阱遍历，Zotero Collection 树键盘语义未新增断言。
4. **Dashboard 原地 retry 无法在 e2e 中制造失败**：`preload` 用 `contextBridge.exposeInMainWorld` + `Object.freeze` 暴露 `window.workbench`，renderer 侧实测不可写（`Object.isFrozen(window.workbench.v2) === true`，赋值静默失败），隔离 profile 也没有可安全破坏的依赖，因此该项只有类型/代码路径证据，没有端到端失败注入证据。
5. **Windows x64 NSIS 已执行但仍有缺口**：0.0.2 轮次已构建真实安装包并完成安装/首次启动/隔离 profile 启动/卸载 smoke，证据（SHA-256、`_prw_migrations` 29 条、默认三条启用规则、`resources/skills` 与 `sidecars` 落盘、快捷方式与注册表项清理）见 [`21-windows-nsis-0.0.2-release.md`](21-windows-nsis-0.0.2-release.md)。仍缺：安装包**未签名**、无自动更新、未对打包态应用做逐页 UI/E2E 回归；且本机存在可复现的 `.asar` 环境锁，使默认 `pnpm package:win` 解包路径失败并导致卸载残留 `resources/*.asar`（细节与替代构建命令见同一文件）。该门禁不记为完全通过。
6. **真实外部服务未在本轮重跑**：真实 Zotero 9/10 只读/写授权（Task 3）、真实用户 Vault 场景（Task 5）、真实 Codex/Pi 凭据运行（Task 6）、cron 到点投递（Task 7）沿用各自任务文件的 BLOCKED 结论。

## 发布规则

- `pnpm test` 为 intentional no-op：如实记录，不宣称测试通过。
- `docs/development-progress.csv` 已创建并维护（此前被文档引用但缺失）。
- 任何未通过真实服务验收的功能保持 PARTIAL/IN_REVIEW/BLOCKED。
