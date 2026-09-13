# Task 06 — last30days AI 最新资讯

## 范围

使用仓库锁定的 `last30days` skill 获取 AI 最新资讯，生成中文回复，并将结果写入 `每日资讯推送`。运行必须保存 skill/engine/参数/来源降级/输出路径的 ledger 证据。

## 验收

- 主题不是泛化的 research updates，而是明确的 AI 最新资讯。
- 输出第一行和 skill footer 合同保持完整，正文为中文。
- 无 key、缺少可选来源、网络失败、CLI 权限失败都能区分诊断。

## 冻结参数（真实运行参数，非界面标签）

单一源：`packages/contracts/src/research.ts` 的 `DEFAULT_DAILY_PUSH_SCHEDULE_INPUT`。

| 字段 | 值 | 落库位置 |
| --- | --- | --- |
| skillKey | `last30days` | `schedules.skill_key` |
| topic | `AI 最新资讯` | `schedules.topic`（迁移 26 已把旧的 `research updates` 归一化） |
| responseLanguage | `zh-CN` | `schedules.response_language`（迁移 26） |
| lookbackDays | `30` | `schedules.lookback_days`（迁移 23） |
| outputFolder | `每日资讯推送` | `schedules.output_folder`（迁移 23 + 26） |

内置规则落库复核（隔离 DB 真跑迁移）：

```
Last 30 days 每日资讯推送 · 0 9 * * * Asia/Shanghai · last30days/AI 最新资讯/zh-CN/30/每日资讯推送
```

## 本轮改动（只做 Task 06 缺口）

1. `packages/workspace-service/src/skill-registry.ts`
   - `summarizeLast30DaysDiagnose()`：把引擎 `--diagnose` 的**结构化**能力摘要暴露出来，区分
     `availableSources` / `missingCredentials`（无 key） / `missingOptionalSources`（缺少可选外部命令） /
     `networkSafe`。`parseLast30DaysDiagnose()` 保留旧签名（薄包装）。
   - `classifyLast30DaysProbeFailure()`：探针失败的**归类**——`SKILL_PROBE_NETWORK_UNREACHABLE`（网络/DNS/代理/超时）、
     `SKILL_PROBE_PERMISSION_DENIED`（沙箱、批准策略、文件权限）、`SKILL_PROBE_FAILED`（其它引擎失败）。
     `AgentSkillDiagnosticCode` 相应新增两个码。
   - `classifyLast30DaysRunFailure()`：Agent CLI 自身失败时的同类区分（权限 vs 网络），普通崩溃返回 `null` 不冒充分类。
   - `buildLast30DaysDegradationNotes()`：把「无 key」与「缺少可选来源」输出成两行降级说明，保证降级不被当成完整覆盖。
   - 修正中文语言规则里的错别字（徐章 → 徽章）。
2. `packages/workspace-service/src/agent-coordinator.ts`
   - 能力预检成功后把结构化降级说明写入 `run:skill` ledger 记录（`降级诊断（不阻断，不得当成完整覆盖）`）。
   - 失败收尾新增 `classifySkillRunFailure()`：skill run 因权限/网络失败时写 `run:skill-diagnostic`
     （`skill 运行失败 · <CODE>`）并把带码的中文说明作为 run error，不再只留一句通用失败。
   - `buildScheduleInstructions` 改为导出（纯函数），供聚焦检查直接断言“规则字段进入指令块”。
3. `scripts/last30days-ai-digest-check.ts` + `pnpm test:last30days:digest`：Task 06 聚焦检查（见下）。

## 证据（2026-09-13）

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | PASS（10/10 包，含 apps/desktop） |
| `pnpm build` | PASS（renderer 2,088.39 kB / css 193.73 kB） |
| `pnpm test:e2e` | PASS（含 `schedule default/daily/pause-enable: ok`、响应式扫描、长内容滚动契约） |
| `pnpm test:last30days` | PASS 20/20（2 skip：打包布局 + 真实 keyless 层，见下） |
| `pnpm test:last30days:digest -- --engine-run` | PASS 11/11（含真实 keyless 引擎运行） |
| `pnpm test:daily-literature` | PASS 25/25 |
| `pnpm test:last30days:network` | PASS 22/22（真实 keyless 层：badge/footer/隔离写入） |

### 真实 keyless 引擎运行（无 `--mock`）

`pnpm test:last30days:digest -- --engine-run` 用冻结参数调用锁定引擎：

```
badge: 🌐 last30days v3.22.0 · synced 2026-09-13
footer: present · Sources: Sources: 2 active (GitHub, Hacker News)
save dir: .last30days-library.db, ai-raw-v3.md
duration 10058 ms, exit 0
```

另一次直接 CLI 运行（`python scripts/last30days.py "AI 最新资讯" --emit=compact --auto-resolve
--no-browser-cookies --save-dir=<隔离目录> --save-suffix=v3 --days=30`，exit 0）保留了引擎自己的降级说明，
即降级不会被静默吞掉：

```
## Partial Coverage
> Web unreachable: Keyless web search unavailable (run doctor for fixes); Jobs unreachable:
  URL Error: [SSL: UNEXPECTED_EOF_WHILE_READING] ... (run doctor for fixes).
> Do not interpret a failed source as no discussion on that source.

## Source Coverage
- GitHub: 12 items
- Web: 0 items (unreachable: Keyless web search unavailable (run doctor for fixes))
- Hacker News: 12 items
```

标准输出第 1 行是版本徽章，`<!-- PASS-THROUGH FOOTER -->` 内的 `✅ All agents reported back!` emoji 树在正文之后，
与 SKILL.md 的 LAW 1/2/5 一致；`ai-raw-v3.md` 落在本次运行的隔离目录（`skill-output`），未写入仓库、桌面或 Vault。

### 主题与语言进入 skill/engine（不是界面标签）

`pnpm test:last30days:digest` 断言：

- briefing 内含 `"AI 最新资讯"`（engine 位置参数）与 `--days=30`、`--no-browser-cookies`，且引擎命令行不含 `--mock`；
- briefing 与指令块都含 `skillResponseLanguageRule('zh-CN')`；把规则改成 `en`/7 天后规则文本与参数随之改变
  （证明语言/主题来自已存规则，而不是只在编辑器里显示）；
- `buildScheduleInstructions(schedule)` 含 `Topic: AI 最新资讯`、`Lookback window: 30 days`、
  `Output folder ...: 每日资讯推送`；
- 协调器内部 `last30DaysRequest()` / `scheduleTopic()` 读的是落库值（内置规则 zh-CN/30 → 编辑为 en/7 → 复原）。

### 四类诊断分离

| 场景 | 归属 | 结果 |
| --- | --- | --- |
| 无 key | `missingCredentials` + `buildLast30DaysDegradationNotes` | 报为「无 key（可选来源，不影响 keyless 来源运行）」；keyless 来源继续运行，不阻断 |
| 缺少可选来源 | `missingOptionalSources` | 报为「缺少可选来源（外部命令未安装，不阻断）」，与无 key 分列（`yt-dlp` 报、已安装的 `gh` 不报） |
| 网络失败 | `SKILL_PROBE_NETWORK_UNREACHABLE` | 能力预检阻断，不产生成功产物/Artifact；详情含「失败类别: network」 |
| CLI 权限失败 | `SKILL_PROBE_PERMISSION_DENIED` | 探针侧与 CLI 运行失败侧都归类为权限；普通崩溃仍是 `SKILL_PROBE_FAILED`/原样错误 |

### 输出与投影

- Obsidian 正文权威：`每日资讯推送/YYYY-MM-DD-daily_digest-<schedule8>-<run8>.md`，frontmatter 带
  `workbench_kind: daily_literature`、`workbench_topic: "AI 最新资讯"`、`workbench_lookback_days`、来源与运行元数据，
  正文逐字写入（含徽章与 footer）。
- SQLite 只保存索引 + 有界摘录（≤ 4,000 字）并明示「Obsidian 投影（正文权威）: <相对路径>」「不保存第二份权威正文」，
  实测投影 4,245 字 vs 正文 6,160 字；Artifact/Inbox 与运行页投递事件（`WROTE`/`SKIPPED` + 路径 + artifactId）指向同一文件。

## 未验证 / 风险

- **未跑真实 Agent CLI 全链路**（Codex/Pi 带凭据跑完整 last30days 简报）：本环境无可用的 app-owned 凭据与模型额度，
  因此「中文正文由模型合成、徽章/footer 逐字保留」只有 briefing/指令块级证据 + 真实 keyless 引擎输出，没有一次真实模型产出的
  最终文章。`pnpm test:last30days:cli`（真实 CLI，消耗 token）本轮未运行 → 该项保持未验收，不标 DONE。
- 引擎本次报告中 `Web` / `Jobs` 来源不可达（keyless web 后端与 SSL 错误），按引擎 Partial Coverage 原样保留；
  不同网络环境下的可用来源会变化，中文正文的覆盖度随之变化。
- 引擎 stderr 提示 `[Planner] No --plan passed ... deterministic fallback`：仓库 briefing 固定一条引擎命令行，
  宿主模型无法在不偏离 briefing 的前提下为**命名实体**主题补 `--plan`（SKILL.md LAW 7）。本轮主题是概念型
  （AI 最新资讯），走确定性回退合法；命名实体主题需要一次 briefing 放宽（未改，避免扩大 Task 06 范围）。
- `pnpm test` 仍是 root no-op（如实记录）。
- 未触碰：凭据/`zotero.sqlite`/`.obsidian/`；未创建 Task 07 的两个新 skill。
