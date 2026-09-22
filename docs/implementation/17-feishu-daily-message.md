# Task 17：每日文献推送（消息侧）工作流（增量 2）

> **本路线已被增量 3（纯 RSS 订阅推送）取代**：用户明确推翻四源检索 + AI 中文决策卡方案（「我的方案搞错了…完全是一个文献推送。即 rss 订阅。然后再设置里可以配置」）。本文档保留为增量 2 的实现历史，仅供追溯；当前生效路线见 18-rss-daily-push.md（契约/迁移/协调器最终以 18 为准）。
状态：IN_REVIEW（实现完成；typecheck / build / 单测 38/38 / e2e 全绿；真实端到端投递取决于用户在飞书开放平台的自建应用配置与模型凭据，见文末「待用户」）

## 目标

在增量 1（飞书本机扫码绑定）之上实现独立的「每日文献推送（消息侧）」工作流 `literature_daily_msg`：内置规则每天 09:00 用 literature-matrix 四源引擎全网检索 + 文献矩阵增强，产出**中文决策卡列表（含"读不读"判断、理由、关联研究问题、原文链接）**，经已绑定飞书 bot 发给用户——**全部列出不精选（上限 20 篇防刷屏）**，用户自挑。

与现有 `daily_digest`→Obsidian 本地知识库管线**完全隔离**：两条独立规则、两条独立投递通道、互不写对方数据。消息侧不写 Vault、不产生第二份权威正文（正文权威在飞书聊天记录，SQLite 只存索引 + 摘录 + 投递事件）。

## 架构要点

- 契约（`packages/contracts/src/research.ts`）：`AgentWorkflowKeySchema` 增加 `literature_daily_msg`；新常量 `LITERATURE_DAILY_MSG_WORKFLOW_KEY / SCHEDULE_ID / PROMPT_TEMPLATE_ID`、`FEISHU_DAILY_MSG_CHUNK_CHARS=3500`、`FEISHU_DAILY_MSG_MAX_ITEMS=20`；`DEFAULT_AGENT_SCHEDULE_RULES` 增加第 4 条内置规则（skill literature-matrix、topic 每日文献精选推送、lookback 1 天、09:00 Asia/Shanghai、`outputFolder: '每日文献推送'`——仅为展示字段，消息侧从不写盘）。`prompt_templates` 种子 `builtin.prompt.daily-feishu-msg`（决策卡格式 + "全部列出不精选、最多 20 篇、不编造"）。
- 迁移 33 `feishu_daily_msg_workflow`（`disableForeignKeys: true`）：SQLite 不能原地改 CHECK → agent_runs / schedules 两表按 12 步流程重建放宽 workflow_key 枚举（列序与既有表一致，数据一字不差搬移，索引重建）；随后 `INSERT OR IGNORE` 模板 + 规则。已验证：升级路径保留用户数据行 + 子表 FK 零违规 + 幂等重播种 + 用户编辑/暂停/归档不被覆盖（default-schedules 6 用例全过，含针对两个迁移块的漂移守卫）。
- 边界模块（`packages/workspace-service/src/feishu-message.ts`）：`chunkFeishuMessage`（≤3500 字/条，优先换行/句号边界，绝不超长）；`buildFeishuMatrixBriefing`（把项目矩阵行压成模型可读中文简报，字段与整块有界）；`buildFeishuMessageProjection`（SQLite 索引/摘录，含投递结果）；`deliverFeishuMessage`（只认 literature_daily_msg，无 sink→NO_SINK、发送失败→SEND_FAILED，计划任务以 skipped 收尾绝不伪装 failed）。
- 协调器（`agent-coordinator.ts`）：
  - Options 新增 `deliverFeishuMessage` sink + `requestFeishuStatus` 钩子。
  - runAutomationNow：①feishu 规则启动前先探绑定态，未绑定→创建 blocked run + 结算 occurrence（`FEISHU_NOT_BOUND` 中文文案），**不调用模型不消耗额度**，随后触发按 retryable 语义产生新槽位重试；②矩阵增强注入指令：`buildScheduleInstructions(schedule) + buildFeishuMatrixBriefing(listLiteratureMatrix(projectId))`。
  - consume：feishu 完成路径投递 → 投影 → artifact/inbox（kind 沿用 `daily_digest`，不新增 Artifact 类别，避免 research_artifacts.kind CHECK 第三次重建）→ `FEISHU_MESSAGE_SENT / FEISHU_MESSAGE_SKIPPED` 事件。
  - `promptTemplateForWorkflow`（coordinator + repository 两处 Record）补 `literature_daily_msg`；`ai-runtime/workflow.ts` 与 renderer `shared.tsx` 的 workflowKey Record 同步补齐。
- Core↔Main 通道（方案文档选项 a，贴合增量 1 现状）：镜像 `readIntegrationSecret` 的 parentPort 双向消息——Core `feishu-send`/`feishu-status` → Main `FeishuBindingController.sendText/getStatus`（token/openId 全在 Main vault，token 永不过进程边界）→ `feishu-send-result`/`feishu-status-result`。host.ts 新增两对 send/parse + pending 表；`core/client.ts` 新增 `setFeishuSender/setFeishuStatusReader`（消息体 ≤200k 有界校验）；`main/index.ts` 提升控制器实例并接线。
- 渲染层：`shared.tsx` workflowLabels 补「每日文献推送」；e2e 定时任务断言适配第 4 条规则（卡片 4 张、`4 个任务`、按「技能+主题」消歧、legacy 目录守卫收窄到 last30days 卡片）。

## 验收（已执行，全部通过，node v24.19.0 + pnpm 11.5.2）

```powershell
pnpm typecheck   # 10/10 包 Done
pnpm build       # 3 个包 bundle 成功
pnpm test:literature-daily-msg   # feishu-message 20/20
pnpm test:default-schedules      # 6/6（含迁移 33 漂移守卫）
pnpm test:feishu-binding         # 9/9（增量 1 回归）
node --import jiti/register --test packages/workspace-service/tests/feishu-daily-msg-gate.test.ts  # 3/3
pnpm test:e2e   # PASS（含 feishu binding card + 4 条默认规则断言）
```

迁移 33 独立验证（`packages/database/tmp-migration33-check.mts`，已随清理删除）：fresh 安装 4 规则 + 模板；升级路径保留 run/schedule/子表行、`PRAGMA foreign_key_check` 零违规、规则重播种幂等、新 workflow 值两表均可写。

## 实现记录

- 契约：`research.ts`（workflow key + 常量 + 第 4 条默认规则）；`ai-runtime/src/workflow.ts`、`database/src/repository.ts`、renderer `shared.tsx` 的 workflowKey Record 补齐。
- 迁移：`database/src/migrations.ts` id=33（两表重建 + 种子模板/规则）。
- 边界：`workspace-service/src/feishu-message.ts`（新建）。
- 协调器：`agent-coordinator.ts`（Options + 门禁 + 矩阵注入 + 完成投递/投影/事件 + prompt 映射）。
- 通道：`workspace-service/src/host.ts`（feishu-send/status + parser + pending）；`apps/desktop/src/core/client.ts`（sender/statusReader + 消息处理）；`apps/desktop/src/main/index.ts`（控制器提升 + 接线）。
- 测试：`packages/workspace-service/tests/feishu-message.test.ts`（20）、`feishu-daily-msg-gate.test.ts`（3）、`database/tests/default-schedules.test.ts`（更新为 4 规则 + 迁移 33 守卫）、`scripts/e2e-electron.cjs`（4 卡片断言）；根脚本 `test:literature-daily-msg`。
- 清理：`apply-edits.mjs`、全部 `edits-feishu-*.json`、`packages/database/tmp-*.mts` 已删除。

## 决策记录（相对方案文档的偏离）

1. 投递通道选 **a**（Core→Main parentPort 借 Main 控制器 sendText），不选 b（Core 自行换 tenant token）：增量 1 已把 token 逻辑实现在 Main 控制器，token 不跨进程边界更贴合既有安全模型。
2. 规则字段未新增 `feishuMessage/feishuMaxItems` 列：判定只靠 workflow_key（`literature_daily_msg` 即消息侧），条数上限由提示词常量 + 分块发送实现，不引入第二套 schema/迁移复杂度；`AgentWorkflowKeySchema` 是唯一的真源。
3. 矩阵注入走**调度指令拼接**而非模板变量：Pi 运行时是 skill 驱动（prompt template 主要是文档/编辑器预览 + legacy 路径），指令拼接可测试、可审计；`builtin.prompt.daily-feishu-msg` 仍按模板变量 `{{papers}}/{{matrix}}` 书写以兼容 legacy 渲染路径。
4. 未绑定在**运行前阻断**（blocked run + occurrence 结算，零 token），不是完成时跳过：与 full-access 拒绝门禁同模式，槽位始终可解释。

## 待用户（不可代办）

1. 飞书开放平台自建应用后台：App ID/Secret、权限 `im:message` + `contact:user.base:readonly`、重定向 URL `http://127.0.0.1:35231/feishu/callback`、版本发布——然后「设置 → 工具连接 → 飞书」填凭据 + 扫码绑定（增量 1 已交付的界面）。
2. 模型凭据：设置 → 模型与 Agent 保存 API Key（`AGENT_CREDENTIAL_MISSING` 会以 blocked 显示，非静默失败）。
3. 绑定时触发一次「立即运行」即可端到端看到飞书决策卡；真实 09:00 自动推送由内置规则驱动（应用需在运行）。

## 剩余风险

- 真实端到端（飞书 API + 模型 + 四源检索）未在真实凭据下执行，属验证缺口而非实现缺口；真实运行时若 literature-matrix skill 未随应用打包，运行会以结构化诊断 blocked（registry 既有行为）。
- 每小时/每日 cron 仅应用存活时触发（既有产品决策），未启动则错过当天推送；startup catch-up 只合并一个 daily 槽位（既有行为）。
