# Task 18 — 三个默认定时任务

## 范围

新安装或迁移后，`定时任务` 页面默认存在**恰好三条已启用规则**：

| id | 名称 | skill | 主题 | 输出目录 | cron |
| --- | --- | --- | --- | --- | --- |
| `builtin.schedule.last30days` | `Last 30 days 每日资讯推送` | `last30days` | `AI 最新资讯` | `每日资讯推送` | `0 9 * * *` |
| `builtin.schedule.literature-matrix` | `文献矩阵推送` | `literature-matrix` | `长上下文检索` | `文献矩阵` | `0 9 * * *` |
| `builtin.schedule.literature-review-push` | `文献综述推送` | `literature-review-push` | `长上下文检索` | `文献综述` | `0 9 * * *` |

三条规则共用 `Asia/Shanghai`、`daily`、`codex`、`researcher`、`read-only` / `on-request`，`sources` 为空（＝全部可用来源），`lookbackDays = 30`。
`文献矩阵` / `文献综述` 是既有的 Obsidian 投影目录，不新增目录类别。

## 单一事实来源

- `DEFAULT_AGENT_SCHEDULE_RULES`（`packages/contracts/src/research.ts`）是冻结默认值的唯一契约；第一条由 `DEFAULT_DAILY_PUSH_SCHEDULE_INPUT` 展开，因此“新闻推送”与共享推送模板不会再分叉。
- migration 28 `three_builtin_schedule_rules`（`packages/database/src/migrations.ts`）携带相同字面量（SQL 无法 import）。两者漂移由 `packages/database/tests/default-schedules.test.ts` 直接判失败。

## 幂等与不覆盖用户意图

播种只使用 `INSERT OR IGNORE`，即“仅当规则不存在时写入”：

- 全新安装：三条规则全部创建（`last30days` 由 migration 15 建立，后续 16/18/19/23/26 归一化，migration 28 补齐缺失者）。
- 老库升级：只补齐缺失的规则，不新增重复行。
- 用户改过名称/主题/目录或暂停过的规则：`id` 已存在，逐字段保留，`revision` 与 `next_run_at` 游标都不变。
- 用户归档过的内置规则：同样是已存在的行，**不会**被复活（归档是显式用户意图）。
- 用户自建、且选择同一 skill 的规则：不会被合并、替换或删除。

## 已知取舍

- 三条规则的 cron 都是 `0 9 * * *`。启动补跑（`tickSchedules` 的 startup catch-up）最多只认领一条 daily 规则（按名称排序取首条，当前为 `Last 30 days …`），其余两条跳过本次补跑、等待各自下一个时间槽；三者的 `next_run_at` 游标相互独立，因此这是“补跑竞争/合并”的已知行为，不是正确性缺陷。
- migration 28 中 `builtin.schedule.last30days` 的 INSERT 在正常安装/升级路径上都不会真正写入（migration 15 早已建立该行），只在行被删除或部分恢复的库里生效；该路径由测试显式覆盖。

## 验证

- `pnpm test:default-schedules`：6/6 PASS（全新库恰好 3 条且字段与契约一致、重复应用不产生重复/不改写、缺失规则被重建且其余规则游标不变、用户编辑/暂停/归档保留、同 skill 的用户规则保留、migration SQL 与契约常量漂移守卫）。
- `pnpm typecheck`：PASS。
- `pnpm test:e2e`：定时任务页断言 `.schedule-card` 恰好 3 个、三条 skill 各自的 `已启用`/主题/输出目录，并保留既有的 09:00 / 每日资讯推送 / AI 最新资讯 / 简体中文 / `来源 全部可用` / `近 30 天` 断言。

## 未改动

Zotero / Obsidian / 设置连接 UI、`.codex-tasks`、`zotero.sqlite`、`.obsidian/` 与任何凭据均未触碰。
