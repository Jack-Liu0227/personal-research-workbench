# 本轮工作台增强（2026-09-13）

## 已实现范围

- 设置页 SYNC / RECENT：当前加载范围全选、indeterminate、清除、逐条删除、批量删除、二次确认和逐条 CAS 回执。记录采用软归档，不删除凭据、sync_runs、external_links 或外部数据。
- 定时任务 RUN HISTORY：复用同一选择与批量归档模式，显示当前范围和逐条结果。
- 默认定时任务：migration 28 通过 `INSERT OR IGNORE` 幂等创建并开启三条默认规则：`last30days`、`literature-matrix`、`literature-review-push`；不覆盖用户编辑、暂停、归档或同 skill 自定义规则。
- Zotero 文献写入：文献检索页增加 capability-gated 的写权限请求；请求后重新 probe，只有 probe 确认可写才显示成功。Zotero 9 缺少写授权时仍只读并提供 RIS/BibTeX fallback。
- Collection：预览与确认显示实际 Collection 名称，稳定 key 仅作为辅助信息；切换 Collection/格式会使旧 preview 失效。
- 项目分类：文献写入支持顶层项目选择，项目分类冻结在 preview/confirm/receipt，并生成精确的 `# <项目名>` 标签；混合项目默认归为未分类，不能猜测项目。
- Obsidian：长 Markdown 分节折叠、元信息 disclosure、树节点 aria-expanded、空状态和长文本换行；不改变 Markdown 写入路径。
- 三页可调布局：Literature、Obsidian、Zotero 使用统一 `ResizablePane`，支持拖动、方向键、Home/End、ARIA separator、最小/最大宽度、窄屏堆叠和 Inspector 内部滚动约束。
- 每日推送日历投影：`calendar.list` 在 Workspace Service 层把启用的 `daily_digest` 规则 `nextRunAt` 与持久化 occurrence/run/delivery ledger 投影为稳定 `daily-push:<scheduleId>:<occurrenceKey>` 只读事件；不创建第二套日历记录、不复制推送正文。计划、完成、阻断、跳过和失败保留真实来源状态；Artifact 与 Obsidian 路径仅来自运行 ledger。Renderer 的月/周/日/议程共用该查询，虚拟事件不可拖动、resize、改期或删除，Inspector 可打开定时任务/运行历史。
- 日历合同：`daily_push` 仅允许在只读投影中出现；`calendar.create/update/remove` 和用户事件编辑器拒绝每日推送类型；计划事件不携带运行、Artifact 或投递成功信息。

## 自动化验证

- `pnpm typecheck`：PASS。
- `pnpm build`：PASS。
- `pnpm test:e2e`：PASS，包含三条默认定时任务、SYNC/RECENT 入口、Zotero/文献、Obsidian、响应式和滚动检查。
- `pnpm test:calendar-daily-push`：3/3 PASS，覆盖计划/occurrence、禁用规则保留历史、`[from,to)`、类型过滤、稳定 ID、严格合同和不复制正文。
- `pnpm test:daily-literature`：25/25 PASS。
- `pnpm test:literature-skills`：25/25 PASS。
- `pnpm test`：PASS（仓库脚本明确为 intentional no-op）。
- `pnpm test:sync-run-bulk-delete`：5/5 PASS。
- `pnpm test:connection-bulk-delete`：5/5 PASS。
- `pnpm test:default-schedules`：6/6 PASS。
- `pnpm test:zotero-write`：10/10 PASS。
- `pnpm test:literature-zotero`：6/6 PASS。
- `pnpm test:markdown-sections`：6/6 PASS。
- `git diff --check`：无差异错误，仅 Windows 换行转换警告。

## 未验收与安全边界

以下仍保持 `IN_REVIEW` 或 `BLOCKED`，不能写成真实完成：

- Zotero 9/10 的真实授权 round-trip、Collection 实际落库和外部写入。
- 用户真实 Obsidian Vault、大批量索引和外部并发修改。
- cron 到点/启动补跑长期运行。
- 带 app-owned 凭据的 Pi/Codex 模型输出。
- Windows x64 NSIS 安装、启动、重启和卸载。
- 两个 instruction-only skill 的真实联网矩阵/综述正文。

本轮没有直接读写 `zotero.sqlite`、`.obsidian/` 或凭据；没有创建第二份 skill 源目录。
