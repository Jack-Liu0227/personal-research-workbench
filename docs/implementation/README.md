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
| 21 | `21-windows-nsis-0.0.2-release.md` | 0.0.2 Windows x64 NSIS 构建、安装、首次启动与卸载 smoke | IN_REVIEW（真实安装包已构建并完成安装/启动/隔离 profile/卸载 smoke，证据含 SHA-256、迁移 29 条与默认三条规则；安装包未签名，自动更新与打包态逐页 UI 回归未做） |
| 22 | `22-windows-release-skill.md` | 发布自动化 skill（`.agents/skills/windows-release/`） | IN_REVIEW（`status`/`version --check`/`verify`/`smoke --dry-run`/`publish --dry-run` 已在真实仓库执行并复算出 0.0.2 安装包 SHA-256；`build`/`smoke`/`publish` 的实际执行段留给下一次发版，见文件内「未完成项」） |
| 23 | `23-windows-data-update-and-ui-refresh.md` | Windows 数据迁移、应用内更新与界面刷新 | 见文件内证据 |
| 24 | `24-pi-inprocess-agent-backend.md` | 进程内嵌入 Pi Agent、契约收窄与 Codex 下线（后端） | IN_REVIEW（`pnpm -r typecheck`/`pnpm build`/`pnpm test:e2e`、`test:agent-runtime-pi` 32/32、`test:agent-custom-providers` 4/4、`test:agent-discovery` 4/4 与设置/凭据测试通过；真实 provider 网络 run、真实模型发现、打包态 OAuth/wasm 仍未验收） |
| 25 | `25-agent-conversation-ui-and-settings.md` | 对话分组修复、Agent 页面瘦身、设置页模型认证、Provider Key/发现、魔法命令与研究 MCP 工具（前端） | IN_REVIEW（`pnpm -r typecheck`/`pnpm build`/`pnpm test:e2e`、`test:agent-ledger-grouping` 4/4、`agent-magic-commands` 2/2 与 MCP 工具面测试通过；真实 OAuth 往返、真实 Zotero/Obsidian Agent 外部写入确认流仍未验收） |
| 26 | `QUICK_START.md` / `AGENT_USER_GUIDE.md` | Agent 可读业务工具、外部写入确认、受控 skill/extension、主题可读性与用户教程 | IN_REVIEW（`pnpm -r typecheck`/`pnpm build`/`pnpm test:e2e`、Agent live 10/10；真实外部写入与 Windows 发布 smoke 仍由 QA/Release 独立验收） |
