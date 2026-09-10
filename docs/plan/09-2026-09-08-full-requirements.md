# 2026-09-08 全量需求追踪与验收矩阵

本文件是用户最新界面与集成需求的增量追踪文档。既有模块计划仍是接口和架构的权威来源；本文件只记录新增需求、当前状态和验收门。未有命令或测试证据的项目不得标记为 DONE。

## 需求状态

| 编号 | 模块 | 要求 | 当前状态 | 验收责任 |
|---|---|---|---|---|
| R1 | Obsidian | 全高布局；编辑/预览尺寸一致；空目录可见；顶部仅文件夹分类；默认隐藏复选框 | PARTIAL | Obsidian Connection + Frontend + QA |
| R2 | Literature | 顶部搜索栏；真实分页和下一页；结果区约 5:1；可拖动分隔条；Inspector 左右折叠 | PARTIAL | Literature + Frontend |
| R3 | Literature/Zotero | 单条/批量按 DOI/URL 写入 Zotero item，预览、确认、逐条回执 | IN_REVIEW | Zotero Local + Integration + QA |
| R4 | Zotero | 移除重复 WORKBENCH/PAPER EXPORT；Collection 固定宽度；父子节点上下折叠；两侧左右折叠 | PARTIAL | Zotero Local + Frontend |
| R5 | Literature | 真实影响因子、来源和获取时间；缺失时不推断 | PARTIAL | Literature + QA |
| R6 | Tasks | 默认 createdAt；按钮切换 dueAt；看板列最大宽度和内部滚动 | IN_REVIEW | Task Board + Frontend |
| R7 | Agent Runtime | 权限来自对应 CLI 探测，不固定三档；Runtime 可启用/禁用 | NOT COMPLETE | Desktop Backend + Workspace Service + Security |
| R8 | Settings | Agent、权限、代理、自动化按模块管理；独立 proxy profile/binding | PARTIAL | Desktop Backend + Database + Frontend |
| R9 | Dashboard | ARTIFACTS/RECENT、AGENT/INBOX 只用真实数据，条目可跳转 | PARTIAL | Project Space + Frontend + QA |
| R10 | last30days | 使用锁定的上游 skill，无 Key 也可运行；可选源缺失非阻塞 | IN_REVIEW | Agent Runtime + QA |
| R11 | Project Space | 每块支持删除；确认、revision/CAS、审计和失败反馈 | PARTIAL | Project Space + Workspace Service |
| R12 | UX | 所有按钮有 title/aria-label/Tooltip；深色主题文字可见 | PLANNED | Frontend + QA |

## 公共契约增量

- Literature page response: `page`, `pageSize`, `total`, `hasNext`。
- Zotero item write preview/execute: stable item key、DOI/URL match、target collection、per-item outcome。
- Collection tree: node expansion state 与 sidebar collapse state 分离。
- Tasks: `dateField: createdAt | dueAt`。
- Agent: CLI capability、runtime enabled、proxy profile/binding。
- Obsidian: directory node 与 Markdown file node 分离。
- 所有新增 DTO 使用共享 Zod schema；外部写入走 IntegrationCoordinator，不写 `zotero.sqlite` 或 `.obsidian`。

## 验收命令

每个责任模块完成后运行：

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

此外需要受控 Zotero/Better BibTeX、last30days preflight、Agent CLI capability、深色主题截图和 Windows x64 安装启动证据。证据路径写入 `docs/development-progress.csv` 后才能提升状态。

## 非目标与安全边界

- 不修改 Zotero `zotero.sqlite`，不修改 Obsidian `.obsidian`。
- 删除测试数据只针对 Workbench 自有数据库 fixture/seed。
- 外部写入默认预览、明确确认、revision 检查和逐条失败反馈。
- 影响因子、Agent inbox、Artifact 和 Dashboard 指标缺失时显示空状态，不制造占位数据。

## 2026-09-08 用户补充需求对照（完整清单）

| 编号 | 最新需求 | 计划归属 | 当前状态 | 验收门 |
|---|---|---|---|---|
| U1 | 文献单条/批量通过 DOI/URL 写入 Zotero item | 04 文献检索、06 Zotero | IN_PROGRESS | 真实 Zotero API，预览/确认，逐条 receipt |
| U2 | 任务时间筛选默认创建时间，可按钮切换截止时间 | 02 任务 | IN_REVIEW | `dateField` 查询和 E2E 切换 |
| U3 | Agent 权限与对应 CLI capability 一致 | 08 Agent、07 设置 | IN_PROGRESS | 安装 CLI 探测、版本/参数来源显示 |
| U4 | Dashboard 所有数据真实且可跳转 | 00 仪表盘 | IN_PROGRESS | 空状态、真实 ID、跳转 E2E |
| U5 | 移除重复 WORKBENCH/PAPER EXPORT | 04 文献检索、06 Zotero | IN_PROGRESS | 路由和入口不存在，统一导出流程 |
| U6 | Zotero Collection 固定宽度、内部滚动、父子折叠、左右侧栏折叠 | 06 Zotero | IN_PROGRESS | 鼠标/键盘折叠及长列表视觉测试 |
| U7 | Obsidian 编辑/预览同宽同高并占满屏幕 | 05 Obsidian | PARTIAL | 模式切换尺寸快照一致 |
| U8 | 看板列最大宽度、超出后滚动 | 02 任务 | IN_REVIEW | 横向看板滚动、列内纵向滚动 |
| U9 | 文献结果分页/下一页、结果与 Inspector 5:1、拖动分隔条 | 04 文献检索 | IN_PROGRESS | 真实 `total/hasNext`、拖动和折叠 E2E |
| U10 | 影响因子真实来源、获取时间和缺失提示 | 04 文献检索 | PLANNED | 来源字段、时间戳、禁止推测 |
| U11 | 项目空间每个区块支持删除（含日历） | 03 项目空间、01 日历 | IN_PROGRESS | 二次确认、CAS、审计、失败回滚提示 |
| U12 | 所有按钮有功能提示，深色主题文字可见 | 07 设置、Frontend | PLANNED | Tooltip/aria/title 扫描和深色截图 |
| U13 | last30days 使用锁定上游 skill，无 Key 也可用 | 08 Agent | IN_REVIEW | preflight 无 Key 通过，可选源非阻塞 |

本表是用户需求的完整映射；各模块原计划中的旧入口或与上述行为冲突的描述以本表及对应模块文档最新章节为准。
# Proxy profiles

Agent proxy profiles and runtime bindings are persisted through the Workspace Service and guarded by revision CAS. Credentials are excluded from SQLite and remain a future safeStorage concern.

## 渐进式加载与中文推送实现记录

本轮未变更上表状态（roadmap 状态仍由 Supervisor 根据完整证据更新），已实现以下增量：

- App shell 不再被项目列表首个请求整页阻塞；项目加载/失败改为可重试的页内提示。
- Obsidian 递归索引按 profile/revision 使用 10 秒进程内元数据缓存和 in-flight 合并，搜索在缓存索引中过滤；写入、删除后失效。Renderer 删除重复 3 秒轮询，将索引刷新降为前台 15 秒，并使用 250ms 搜索延迟与局部 skeleton。
- Zotero capability、Collections、Items、Inspector link 拆分加载，关闭自动重试；未选择条目时不读取 links，未进入显式 Paper 选择路径时不全量读取 Papers。
- Agent capability probe 改为异步并行并使用 60 秒真实结果缓存；页面与 Automation 依赖按需加载。
- `last30days` 每日推送固定为中文正文，同时保留原始标题、来源、引语、URL 和 skill footer/citation contract。

验证：`pnpm typecheck` PASS；`pnpm build` PASS；`pnpm test:e2e` PASS；`pnpm test` 仅输出仓库声明的 intentional no-op。隔离 E2E shell 计时为 Agent 390ms、Zotero 393ms、Obsidian 390ms。真实 Vault、真实 Zotero/Better BibTeX、真实 Codex/Pi 及 200% 缩放/Windows 安装包人工验收仍待执行，不据此提升 DONE。
