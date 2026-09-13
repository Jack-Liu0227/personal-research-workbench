# Task 7：每日规则、幂等和投递边界

状态：IN_REVIEW（实现经 typecheck/build/e2e + 聚焦检查 25/25 验证；真实 cron 到点触发、真实模型运行、真实用户 Vault 未验收，见文末「未验证」）
依赖 Task 2

## 目标

把“每日推送”从能运行的 demo 变成边界清晰、可恢复、可观察的应用内自动化。

## 实施步骤

1. 统一 schedule 的频率、cron、时区、默认主题、runtime、skill、project 和 outputFolder。
2. 保留应用存活期间调度的产品边界；启动每日 catch-up 最多一次，非 daily 规则只推进游标不伪造补跑。
3. 使用 schedule occurrence/idempotency key 防止重复执行，保存运行锁和失败后重试语义。
4. 让 Automation UI 显示下一次运行、最近运行、阻断原因、Artifact/Obsidian 投递状态。
5. 设计通知渠道扩展点：先本地 Inbox/Obsidian，远程 Telegram/Email/Webhook 需独立凭据、预览、用户授权和 outbox，不在本阶段偷偷启用。
6. 对 full-access、外部写入和浏览器 cookie 采集保持显式安全 gate。

## 本次收尾范围（接管中断工作，只补齐 Task 07 范围内缺口）

上一轮 Task 07 的进程在留下半成品后被中断。接管时的真实起点：

- `pnpm typecheck` 在 `packages/database/src/migrations.ts` 有反引号导致的 TypeScript 语法错误（本次开始前已手工修好）；修好后又暴露两个真实缺口。
- `packages/workspace-service/src/agent-coordinator.ts` 引用了 `@prw/contracts` 未导出的 `ScheduleOccurrenceSource` 类型。
- `apps/desktop/src/preload/index.ts` 的 `automation` 对象缺少契约已声明的 `history` / `retryRun`，而 dispatcher 已实现 `automation.runs.history` / `automation.runs.retry`——即「后端有投影、前端看不到」。
- `packages/database/src/research-repository.ts` 的 `toScheduleOccurrence` 把整行交给 `ScheduleOccurrenceSchema`（`strictObject`，不含 `updated_at`），**任何一次 occurrence 读取都会抛 `stored data failed validation`**，occurrence/cursor/history 链路在运行时实际不可用。
- Automation UI 没有最近运行/阻断原因/Artifact/Obsidian 投递的可见入口（步骤 4 未完成）。

本次未重新设计、未扩建 Task 08，只做上述收尾，并保留上一轮已有实现（migration 25、occurrence repository、tick/catch-up、dispatcher 路由、契约字段全部保留）。

## 收尾改动

1. `packages/contracts/src/agent.ts`：补出 `ScheduleOccurrenceSource` / `ScheduleOccurrenceStatus` 类型导出（与文件内其他 schema「schema + type」约定一致），修复 workspace-service 编译。
2. `apps/desktop/src/preload/index.ts`：接线 `automation.history(input?)` → `automation.runs.history`（`AutomationRunHistoryInputSchema.parse` + `z.array(AutomationRunHistoryEntrySchema)`）与 `automation.retryRun(runId)` → `automation.runs.retry`（`IdSchema.parse` + `AgentRunRecordSchema`），与契约 `WorkbenchAgentApiV1` 对齐。
3. `packages/database/src/research-repository.ts`：`toScheduleOccurrence` 显式投影契约字段（丢弃内部列 `updated_at`），修复 strictObject 解析失败；occurrence 的 claim/settle/list/history 读写链路随之可用。
4. `apps/desktop/src/renderer/src/features/automation.tsx`：新增「最近运行」面板（run 状态、occurrence 状态/来源、阻断/失败原因、Artifact 标题、Obsidian 已写入路径或跳过原因、空态说明），并对 failed/blocked/missed/canceled/partial 提供 `重试`（走 `automation.retryRun`，即重跑规则本身而非重放 run）；`Run now` 后同时刷新运行记录。
5. `scripts/daily-literature-push-check.ts`：新增 5 项聚焦检查（见下），覆盖 occurrence 账本、暂停语义、启动对账、迁移不复活暂停、历史投影字段；文件头注释同步。
6. `scripts/e2e-electron.cjs`：定时任务断言新增「最近运行」面板、空态/行态、`Artifact：`/`Obsidian：` 投递投影。
7. 文档：本文件、`docs/implementation/README.md`、根 `README.md` 定时任务段、`.codex-tasks/.../PROGRESS.md`、`TODO.csv`。

## 重点不变量与对应证据

| 不变量 | 实现位置 | 证据 |
|---|---|---|
| 暂停 schedule 不被迁移重新启用 | migration 19 仅作用于 `revision = 0`；`saveSchedule` 落 `enabled = 0` 且 `next_run_at = NULL` | 聚焦检查「迁移：重跑 schedule 迁移不会复活用户暂停的规则」（重跑 16/18/19 后 `enabled=false`、`nextRunAt=null`）；e2e 暂停/启用断言 |
| occurrence / cursor 不丢失 | `claimScheduleOccurrence` 在同一事务内写 claim + 推进 cursor（CAS 在 revision） | 聚焦检查「occurrence：claim 与 cursor 前进同一事务…」 |
| 暂停规则不会被调度循环选中 | `listDueSchedules` 只取 `enabled && nextRunAt <= now`；暂停时 run now 只清空游标 | 聚焦检查「occurrence：暂停规则的手动运行只清空游标，不会重新启用」（含 `listDueSchedules` 断言） |
| 崩溃遗留的 claim 可见 | `reconcileClaimedScheduleOccurrences` 把遗留 claimed/running 结算为 `missed` + 具体原因 | 聚焦检查「occurrence：启动对账把崩溃遗留的 claim 结算为 missed 并保留原因」 |
| 重复 tick / Run now 幂等 | `schedule_occurrences.idempotency_key` UNIQUE；重复 key 返回既有行；`runAutomationNow` 复用既有 run | 聚焦检查「重复 key 不二次插入/推进」+ 既有检查「当天已有运行（完成/进行中）时不生成第二个 run」 |
| 失败后仍可重试且不脏改写历史 | 每日 key 在 failed/blocked/canceled/missed 时追加 `:retry:<ts>` | 既有检查「失败/阻断当天可重试（新 key + 新 run）」 |
| 每日推送目录统一 | migration 23 + `daily-literature.ts` 单一目录常量 | 既有检查「迁移 SQL 真实执行：旧目录/旧名称均改写为 每日文献推送」 |
| 最近 run / blocked / failed / skipped / Artifact / Obsidian 投递可见 | `listAutomationRunHistory` 投影 + Automation「最近运行」面板 + Agent 运行页 DeliveryStrip | 聚焦检查「历史投影带 occurrence/阻断原因/Artifact/Obsidian 投递结果」；e2e「最近运行」面板断言 |
| 不绕过 approval / revision | `retryAutomationRun` 重跑所属 schedule（沿用落库的 permissionMode/approvalPolicy/skill/occurrence 锁）；`save`/`claim` 全部走 revision CAS；full-access 需 `PRW_ALLOW_FULL_ACCESS_AUTOMATION=true` | 代码路径（`agent-coordinator.ts` `retryAutomationRun`/`runAutomationNow`/`saveAutomationRule`）+ 上述 CAS 检查 |
| 远程通知渠道不偷偷启用 | 仅本地 Inbox/Obsidian 投递；无 Telegram/Email/Webhook 发送代码 | 步骤 5 维持「扩展点」状态，未新增任何外发通道 |

## 证据

```powershell
pnpm typecheck        # PASS（10/10 workspace projects）
pnpm build            # PASS（out/main/index.cjs 56.12 kB、core-worker.cjs 1,787.92 kB、preload 310.98 kB；renderer index-BUycYeS8.js 2,051.78 kB / index-OzjydDFt.css 188.30 kB）
pnpm test:e2e         # PASS（含 schedule default/daily/pause-enable + 最近运行面板与空态断言；该隔离 profile 下 agent_runs/schedule_occurrences 均为 0 行，故带投递的行态不由此脚本证明）
pnpm test:daily-literature   # PASS 25/25（新增 occurrence 账本 4 项 + 历史投影 1 项）
```

聚焦检查新增覆盖（隔离 SQLite + 临时 Vault，无模型、无网络）：

1. occurrence claim 与 cursor 前进同一事务；重复 key 不二次插入 occurrence、不二次推进 cursor。
2. 暂停规则 run now 后 `enabled=false`、`nextRunAt=null`、不在 due 列表。
3. 启动对账把遗留 claim 结算为 `missed` 并保留具体原因（不静默丢时间点）。
4. 重跑 schedule 迁移（16/18/19）不会复活用户暂停的内置规则。
5. `listAutomationRunHistory` 返回 occurrence 状态/来源、阻断原因、Artifact 与 Obsidian 投递结果。

## 未验证（BLOCKED，不得计入 DONE）

- 真实 cron 到点触发（30 秒 tick 命中真实时间点）未观测：本环境只验证了幂等键语义、对账与 Run now 路径，未等待真实 09:00 到点。
- 真实模型运行未执行：没有可用的应用内凭据/自有 profile CLI 登录，未调用 Codex/Pi；因此「真实运行 → 真实推送 → 真实 Vault 写入」端到端未验收。
- 真实用户 Vault 未验收：仅临时 Vault + 隔离 Workbench DB；外部修改冲突、Vault 不可写、大批量场景未在真实 Vault 复核。
- 远程通知渠道（Telegram/Email/Webhook）为设计内未启用：无凭据、无预览确认、无 outbox，属明确不做而非缺陷。
- 进程关闭期间的调度行为只在代码与对账检查层验证，未做「真实关机 → 重启」观测。
- Automation「最近运行」的带投递行态未在 e2e 中渲染：e2e 隔离 profile 的 `agent_runs`/`schedule_occurrences` 均为 0 行，断言命中空态分支（`尚无定时运行记录`）；带 Artifact/Obsidian 投递的行态由聚焦检查「运行可见性：历史投影带 occurrence/阻断原因/Artifact/Obsidian 投递结果」覆盖。

## 遗留风险 / 附带发现（本次未改）

- `WorkbenchRepository.listAgentEvents(runId, afterSeq, limit)` 用 `seq > afterSeq` 过滤，而 `appendAgentEvent` 给每个 run 的首个事件分配 `seq = 0`：任何从 0 开始读取的调用者都会丢掉该 run 的第一条事件（HEAD 基线即如此，非本次引入）。Task 07 的投递事件总是排在生命周期事件之后，因此投递可见性不受影响；改动会同时影响 renderer 轮询的 `afterSeq` 语义，未在本任务内变更。
- `schedule_occurrences` 只按 `schedule_id/occurrence_at` 建索引，按 `run_id` 反查（运行页/历史投影）走表扫描；当前数据量下无影响，未新增索引。
