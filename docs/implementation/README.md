# 科研工作台完整实施路线

本目录记录每个可交付子任务。每个任务必须按顺序完成、验证并在任务文件中记录证据；未运行的命令和未通过真实外部服务验收的能力不得标记为完成。

## 顺序

| 顺序 | 文件 | 目标 | 状态 |
|---:|---|---|---|
| 0 | `00-repository-ui-audit.md` | 记录当前界面、功能和风险基线 | DONE（静态审计） |
| 1 | `01-last30days-skill.md` | 让锁定的 last30days skill 可诊断、可运行、可打包 | IN_REVIEW（真实 Pi、cron tick、NSIS smoke 和 gitlink 入库策略仍 BLOCKED，见任务文件「未验证」） |
| 2 | `02-daily-literature-push.md` | 把每日推送接到 Agent、SQLite Artifact/Inbox、Obsidian | IN_REVIEW（真实 CLI 端到端验收 BLOCKED） |
| 3 | `03-literature-zotero-ux.md` | 修复帮助、滚动、预览、Collection 和写入确认 | IN_REVIEW（实现完成并过 typecheck/build/e2e；真实 Zotero 9/10 只读与写入验收 BLOCKED） |
| 4 | `04-selection-and-batch.md` | 统一所有可多选列表的全选/半选/边界 | IN_REVIEW（实现完成并过 typecheck/build/e2e；逐列表人工点检未覆盖，见任务文件「未验证」） |
| 5 | `05-obsidian-literature-management.md` | 完善 Obsidian 文献分类、矩阵、综述和安全写入 | IN_REVIEW（实现完成并过 typecheck/build/e2e/聚焦单测；真实用户 Vault 场景未验收，见任务文件「未验证」） |
| 6 | `06-agent-context-and-skills.md` | 完善 Agent、技能上下文、权限和文献上下文 | IN_REVIEW（凭据/skill/approval 链路复核完成并过 typecheck/build/e2e/聚焦单测；真实 Codex/Pi 凭据运行 BLOCKED，见任务文件「未验证」） |
| 7 | `07-scheduling-and-delivery.md` | 完善每日规则、幂等、重试和投递状态 | IN_REVIEW（实现完成并过 typecheck/build/e2e/聚焦检查 25/25；真实 cron 到点、真实模型运行与真实 Vault 未验收，见任务文件「未验证」） |
| 8 | `08-ui-release-acceptance.md` | 全界面 UX/A11y/响应式、E2E、文档和 Windows 验收 | IN_REVIEW（实现完成并过 typecheck/build/test:e2e，含 1440/1080/720/320 溢出扫描、窄屏抽屉、320px 帮助入口、嵌入 Matrix 单滚动容器、Inspector/Agent 长内容滚动契约，以及 320/768/1050/1280/1440 截图；`pnpm package:win` 未运行、Windows 安装/卸载与真实外部服务验收 BLOCKED，见任务文件「未验证」） |

## 统一验收原则

- SQLite 是 Workbench 自有数据的权威源；正文由 Obsidian 文件权威，Zotero 由 Zotero API 权威。
- 外部写入必须 capability probe、preview、显式确认、revision/CAS 和逐条回执。
- `generated` 只表示生成 RIS/BibTeX，不表示已导入 Zotero。
- 所有列表选择必须说明“当前页/当前筛选结果/已加载结果”，不能把部分加载当成全选全库。
- 每项任务完成后更新本目录文件和 `.codex-tasks/20260913-literature-workbench/PROGRESS.md`，并运行任务文件中的验证命令。
- 持续状态与证据统一记录在 `docs/development-progress.csv`（本轮补齐，此前被引用但缺失）。

## 第二批任务（09–16，账本 `.codex-tasks/20260913-zotero-daily-push/`）

| 顺序 | 文件 | 目标 | 状态 |
|---:|---|---|---|
| 09 | `09-zotero-write-entry.md` | Zotero 写入入口 | 见账本 Task 02 |
| 10 | `10-literature-url-open.md` | 文献 URL 经 Main 白名单跳转 | 见账本 Task 03（IN_REVIEW） |
| 11 | `11-connection-bulk-delete.md` | 设置页工具连接记录全选/逐条删除/批量删除 | IN_REVIEW（UI 接线完成并过 typecheck/build/聚焦测试 5/5；e2e 只覆盖空列表分支，带记录的行级选择未断言） |
| 12–16 | `12-automation-editor.md` … `16-final-qa.md` | 自动化编辑器、两个新 skill、最终 QA | 未由本任务跟踪（按账本顺序执行） |
| 17 | `17-sync-record-bulk-delete.md` | 设置页「最近同步」记录全选/半选/清除/逐条删除/批量删除 | IN_REVIEW（实现完成并过聚焦测试 5/5、相关工程 typecheck、`electron-vite build`；UI 交互无运行时断言，见任务文件「未验证」） |
| 18 | `18-default-schedule-rules.md` | 新装/迁移后默认恰好三条已启用规则 | 见文件内证据 |
| 19 | `19-workbench-followups.md` | 本轮工作台增强（批量删除、Zotero 写入入口、每日推送日历投影、可调布局） | IN_REVIEW（typecheck/build/test:e2e + 聚焦测试 PASS；真实 Zotero/Vault/cron/模型/NSIS 见「未验收与安全边界」） |
| 20 | `20-zotero-two-sided-delete.md` | Zotero 条目两侧删除（官方 Local API 永久删除 + 本地投影归档） | IN_REVIEW（typecheck/build/test:e2e + `test:zotero-connector` 19/19、`test:zotero-write` 20/20、`test:zotero-delete` 7/7 PASS；真实 Zotero 授权与远程删除 round-trip 未验收） |
