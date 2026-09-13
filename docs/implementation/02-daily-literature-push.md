# Task 2：每日文献推送闭环

状态：IN_REVIEW（Task 1 依赖已就绪；实现完成，真实 CLI + 真实 Vault 端到端验收 BLOCKED）

## 目标

把保存的研究主题/规则作为每日运行输入，通过 last30days skill 生成可追溯 Artifact 和 Inbox，并安全写入已授权 Obsidian Vault 的单一默认目录。

## 实施步骤

1. 统一“每日文献推送”目录名称、默认值、migration seed、UI、host fallback、Obsidian layout 和文档；不得同时使用“每日资讯推送”。
2. 明确规则字段：主题、来源、回看天数、时区、cron、runtime、model、skillKey、outputFolder、projectId、enabled、executionMode。
3. 运行前进行 runtime/skill/Python/网络/权限 capability probe；失败时生成 blocked diagnostic，不生成成功 Artifact。
4. 运行成功后写入 SQLite Artifact/Inbox，并将 Markdown 写入 `<outputFolder>/YYYY-MM-DD-daily_digest-<schedule8>-<run8>.md`，带 `workbench_kind: daily_literature` 和来源/时间/规则元数据。
5. Obsidian 写入继续使用 Vault containment、`.md` 限制、指纹/CAS 和原子写入；写入失败不抹掉 SQLite Artifact，但必须在 run UI 中可见。
6. 增加幂等键，避免 30 秒 tick、启动 catch-up 和重试重复生成同一日推送。
7. 在 Agent 运行页面展示 `OBSIDIAN_DAILY_NOTE_WRITTEN/SKIPPED`、输出路径的相对路径、Artifact/Inbox 跳转。

## 验收

```powershell
pnpm typecheck
pnpm build
pnpm test:e2e
```

真实验收：隔离 Workbench DB + 测试 Vault + 真实 CLI；验证暂停、恢复、启动最多补跑一次、重复 tick、Obsidian 外部修改冲突和失败后 Artifact 保留。

## Done when

每日规则在应用存活期间可稳定执行；失败原因、Artifact、Inbox、Markdown 投影和相对路径均可追溯；目录和文档无命名漂移；没有宣称实现了关闭应用后的后台推送。

## 实现记录

- 命名收敛：`packages/contracts/src/research.ts`（`ScheduleSchema`/`SaveScheduleInputSchema` 的 `outputFolder` 默认值）为唯一默认值来源；新增 migration 23 `daily_literature_push_closure` 把已安装库中的 `每日资讯推送` 目录与内置规则名称归一化为 `每日文献推送`（不修改历史 migration 15/16/18/19 的文本）；UI、host 兜底、Obsidian 目录、文档与脚本同步。
- 规则字段：`sources`（逗号分隔，空＝全部可用）与 `lookbackDays`（1–365）加入契约、`schedules` 表（`sources_json` 带 `json_valid` CHECK、`lookback_days` 带范围 CHECK）、repository 读写路径与 Automation UI；损坏的 `sources_json` 在读取时降级为 `[]`（全部可用）而不是让规则列表报错。
- 能力预检：`packages/workspace-service/src/skill-registry.ts` 增加 `probeLast30DaysCapability`（真实执行 `--diagnose`，结果缓存 60 秒并缓存失败，避免 30 秒 tick 反复起进程）与 `selectLast30DaysSources`（零可用来源/全部请求来源缺失 → `SKILL_SOURCES_UNAVAILABLE` 阻断；部分缺失 → 降级运行并在 briefing/ledger 记录不可用来源；探针失败 → `SKILL_PROBE_FAILED` 阻断）。阻断路径只建 blocked run + `run:skill-diagnostic` ledger，不产生成功 Artifact。
- 投递边界：新模块 `packages/workspace-service/src/daily-literature.ts` 统一目录名（越界/绝对路径/`.obsidian` 回退默认目录）、路径形状 `<outputFolder>/YYYY-MM-DD-daily_digest-<schedule8>-<run8>.md`、frontmatter（`workbench_kind: daily_literature` + 规则/运行/runtime/来源/回看天数/主题/生成时间）、正文摘要上限（4,000 字）、SQLite 投影（明示 Obsidian 正文权威或未写入原因）与 `deliverDailyLiterature`。host 的 `persistScheduledOutput` 直接复用同一函数，避免第二套实现。
- 安全写入：仍走 `IntegrationCoordinator.writeNote` → `writeObsidianNote`（Vault containment、`.md` 限制、原子 temp+rename）；投递以 `expectedFingerprint: null` 写入唯一路径，已存在文件触发 CAS 冲突而不是静默覆盖。
- 幂等：日频率用 `${scheduleId}:daily:${localDateKey(occurrence, schedule.timezone)}`（30 秒 tick、启动 catch-up、多次触发收敛到同一 key，`start()` 通过 `getManagedAgentRunByIdempotency` 复用当天运行）；该日上一次运行处于 `blocked/failed/canceled/missed` 时才追加 `:retry:<now>`，让“修好网络再跑一次”产生新运行而不污染历史运行。
- 运行可见性：投递结果追加为 run 事件 `OBSIDIAN_DAILY_NOTE_WRITTEN`（message/relativePath/artifactId）或 `OBSIDIAN_DAILY_NOTE_SKIPPED`（message/reason/artifactId）；非 `daily_digest` 的定时运行不产生该事件。Agent 运行页新增投递状态条（状态、相对路径或跳过原因、Artifact/Inbox 跳转）。
- 顺序保证：投递发生在 Artifact/Inbox 写入之前，Artifact 内容记录投递结果；写入抛错被转成 `SKIPPED/WRITE_FAILED` 并保留 SQLite 侧 Artifact 与正文摘要。

## 证据

- `pnpm typecheck`：PASS（全部 workspace 包与 desktop）。
- `pnpm build`：PASS（`pnpm --filter @prw/desktop build`）。
- `pnpm test:e2e`：PASS（隔离 Electron E2E；新增定时任务面板断言覆盖“命名无漂移”、来源/回看天数字段与能力预检提示）。
- `pnpm test:daily-literature`（新增 `scripts/daily-literature-push-check.ts`，jiti 运行，隔离临时 SQLite + 临时 Vault，无模型/网络调用）：20/20 PASS，覆盖
  1. 内置规则名称/目录/`lookbackDays` 归一化；
  2. migration 23 归一化 SQL 的真实执行（旧目录/旧名称被改写、旧目录残留=0）；
  3. `sources` 归一化去重与 `lookbackDays`/`outputFolder` round-trip；
  4. 损坏 `sources_json` 降级为“全部可用来源”且列表仍可读；
  5. `--diagnose` 解析、探针失败阻断、零可用/全部缺失阻断、部分缺失降级；
  6. 路径形状、frontmatter 元数据、目录越界/绝对路径/`.obsidian` 回退、摘要有界与投影语义；
  7. 非 `daily_digest` 跳过、`NO_VAULT`/`NO_SINK` 降级，非定时运行不产生投递结果；
  8. 真实 `IntegrationCoordinator` 写入临时 Vault（`.obsidian` 未被触碰、无第二套旧目录）；
  9. 同名文件外部修改 → CAS 冲突且不覆盖，失败后 SQLite 侧投影仍保留正文摘要与失败原因；
  10. 日粒度幂等键（同天稳定/次日轮换）、当天已有运行复用且不新增 run、失败后生成 `:retry:` 新 run 且历史 run 保留、非日频率仍用时间戳 key；
  11. run 事件载荷（WROTE/SKIPPED + 相对路径 + reason + artifactId），非每日投递不产生事件。

## BLOCKED（不计入 DONE）

- 真实 CLI（Codex/Pi）+ 真实 Vault 的端到端验收未在本环境执行：暂停/恢复、启动最多补跑一次（at-most-once catch-up）、30 秒 tick 重复触发、Obsidian 外部修改冲突、写入失败后 Artifact 保留，均只验证到幂等键/repository/投递边界层，未观测真实模型运行下的产物。
- cron 到点触发的真实推送未观测（仅验证 `runNow` 与幂等键语义）。
- 已知边界（未改）：`runs.eventsPage({afterSeq: 0})` 语义为 `seq > afterSeq`，因此 run 的第一个事件（`seq = 0`）不被该 API 返回。真实运行的投递事件总在多个生命周期事件之后，投递状态条不受影响；若未来某个 run 的首个事件就是投递结果，需要单独处理该 API 语义。
