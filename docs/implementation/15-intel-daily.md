# Task 15：情报日报（Intel Daily）只读接入

状态：IN_REVIEW（实现完成；typecheck / build / 单测 / e2e 全绿，真实 TrendRadar 输出库端到端验收取决于用户部署侧配置）

## 目标

把 TrendRadar 引擎（前沿瞭望 / 热点日报 / 科技周报三个推送板块）作为只读数据源接入个人研究工作台：新增 `intelDaily` RPC 家族、workspace-service 只读按日 SQLite 读取器（复刻上游关键词匹配），以及 Renderer 导航页。工作台不调用上游任何脚本、不写引擎目录；服务端复刻同一套关键词规则，使三个板块与飞书推送镜像一致。

## 实施步骤

1. 契约层：`IntelDaily` DTO 块（SourceStatus / SectionId / Item / Section / Source / Overview / Config / SetConfigInput），`WorkspaceApiV2Methods` 追加 `intelDaily.getConfig/setConfig/overview`；`WorkspaceRouteSchema` 增加 `intel-daily`。
2. 数据层：`workspace_settings` KV 三访问器（get/set/clear，带 CAS，value_json 解析失败退化 null），key=`intelDaily.rootDir`。
3. 服务层：`IntelDailyCoordinator`（只读打开 `<root>/output/news|rss/YYYY-MM-DD.db`，LEFT JOIN platforms/rss_feeds；crawl 时间为 `HH:MM`、RSS published_at 为可选 ISO）；关键词文件缺失=不过滤；板块映射 frontier=24h(rss+hot,frontier.txt)、hot=24h(hot,frequency_words.txt)、tech=168h(rss,paper.txt)。
4. 关键词语义逐条复刻上游 `trendradar/core/frequency.py`：空行分块、`[GLOBAL_FILTER]`/`[WORD_GROUPS]` 区域、`!` 词进顶层 filters、`+` 组内 required、普通词组内 normal、`@数字` maxCount、`[组别名]` 显示名；匹配顺序=空标题 false→全局过滤→无词组全过→顶层过滤→组 required 全含 + normal 任一含。全局过滤区按配置意图支持 `/regex/`（上游存原文做字面子串匹配，其正则形同死代码；本实现按注释说明做了兼容增强），`=> 别名` 行解析后为空词的规则跳过。
5. preload + Renderer：`intelDaily.{getConfig,setConfig,overview}`；queries 两 hook；`features/intel-daily.tsx` 页面（根目录输入 + 系统选目录 + 保存/清除、source 状态卡片、三板块卡片、相对时间、外部链接走 ExternalUrlLink）；App.tsx 图标/导航/路由。
6. 测试：7 用例（not_configured / setConfig 持久化与清除 / ready+db 日期清单 / hot / frontier / tech / DTO publishedAt 透传与 hot null fallback），按上游真实 schema 建按天库 + 三个关键词文件；根脚本 `test:intel-daily`；e2e 增加「情报日报」导航与未配置空态断言。

## 验收

```powershell
pnpm typecheck
pnpm build
pnpm test:intel-daily
pnpm test:e2e
```

已执行并全部通过（node v24.19.0 + pnpm 11.5.2）。真实验收（对真实 TrendRadar 输出库展示三个板块）取决于部署侧：GitHub 账号确认、`FEISHU_WEBHOOK_URL`、`AI_API_KEY`。

## Done when

三个板块在应用内只读可见且关键词筛选与上游一致；未配置/空目录给出明确空态；对引擎目录零写入；`pnpm package:win` 之外的构建与测试门全绿。

## 实现记录

- 契约：`packages/contracts/src/v2.ts` 新增 IntelDaily DTO 与三 RPC 方法 + `WorkspaceRouteSchema` 增 `intel-daily`；`index.ts` 六处扩展（值/类型导入、payload/result schemas、request variants、V2 接口）。
- 持久化：`packages/database/src/repository.ts` `getWorkspaceSettingValue/setWorkspaceSettingValue/clearWorkspaceSettingValue`（复用既有 `workspace_settings` 表，key TEXT PK + value_json + revision CAS）。
- 读取器：`packages/workspace-service/src/intel-daily.ts`（better-sqlite3 13.0.3 prod / @types 9.6.0 dev）；`dispatcher.ts` 三条 case + CoreServices；`host.ts` 组装 `new IntelDailyCoordinator(repository)`。每板块上限 100 条，24h/168h 窗口含 `now±1h` 容差。
- Renderer：`preload/index.ts`、`features/queries.ts`（keys + `useIntelDailyConfigQuery`/`useIntelDailyOverviewQuery`）、新页面 `features/intel-daily.tsx`、`App.tsx`（RadioTower 图标、ViewId、researchNavigation、路由分支）。
- 测试：`packages/workspace-service/tests/intel-daily.test.ts`（夹具按上游 `storage/{schema,rss_schema}.sql` 建表；NOW 固定 2026-09-20T12:00+08:00；RSS publishedAt 一律取 NOW 之前，避免 +1h 容差把未来时间当越界剔除）。e2e：`scripts/e2e-electron.cjs` researchNavLabels 增「情报日报」+ 未配置空态/无板块卡片断言。
- 已知差异：上游全局过滤区把 `/regex/` 当字面量（形同死代码），本实现按配置意图做正则匹配并在源码注释标注；其余匹配语义与上游逐条对齐。

## 遗留与风险

- 部署侧三件事（GitHub 账号、Webhook、AI Key）未完成，属另一任务线；真实 TrendRadar 输出库端到端验收待其就绪。
- GHA 每小时 cron 偶发漏跑与 7 天签到机制、长期迁 Docker 建议均见 `artifacts/news-radar-migration/deploy/README-部署.md`。
- 关键词文件解析只读复刻；上游后续变更语义时需同步本读取器（`parseKeywordFile`/`matchesWordGroups` 为唯一对接口）。
