# 情报·日报 — GitHub Actions 部署手册（TrendRadar 引擎）

> 配套配置包：本目录 `config/` 下全部文件（基线：sansan0/TrendRadar master，2026-09-20 拉取）。
> 目标：**前沿瞭望（每小时）+ 每日热点（08:33）+ 每日论文精选与解读（09:33）**，飞书机器人推送，AI 默认开启。

---

## 0. 你还需要提供 3 样东西（见 §7）

| 项 | 用途 | 获取方式 |
|---|---|---|
| GitHub 账号 | fork 仓库、配置 Secrets | 你登录 GitHub 即可 |
| 飞书群机器人 Webhook | 推送通道 | 飞书群 → 设置 → 群机器人 → 自定义机器人 |
| AI API Key（DeepSeek 推荐） | 每日热点 AI 分析 + 论文解读 | DeepSeek 开放平台申请 |

---

## 1. 总体架构（本配置包实现的效果）

```
GitHub Actions（每小时 :33 触发，免费）
  └─ TrendRadar 采集（11 热榜平台 + 5 论文/AI RSS 源）
       ├─ 00:00-23:59 → 前沿瞭望：incremental 增量推送（关键词 frontier.txt）
       ├─ 08:00-08:59 → 每日热点：daily 汇总 + AI 分析（关键词 frequency_words.txt 默认词库）
       └─ 09:00-10:00 → 每日论文：daily 汇总 + AI 解读（关键词 paper.txt）
  └─ 推送 → 飞书群机器人
  └─ 生成 SQLite + HTML 报告（index.html，供 App/网页阅读）
```

**时间排序说明（重要）**：
- RSS 板块（前沿瞭望、每日论文）**天然按时间流展示**（config.yaml 官方注释：RSS「按时间流展示」）。
- 热榜板块（每日热点）按权重排序（排名 60% / 频次 30% / 热度 10%）——热搜榜本身不提供发布时间。
- 如需热榜也强制「24 小时纯时间排序」，需要 P3 代码改造（fork 加 `sort.mode=time`，用首次采集时间兜底），本包暂以权重排序上线。

---

## 2. 三步上线

### 第 1 步：Fork 仓库
- 打开 https://github.com/sansan0/TrendRadar → **Fork** 到你自己的账号（保留默认配置即可）。
- 或者：告诉豆包你的 GitHub 账号，由豆包通过已连接的 GitHub 直接 Fork 并上传配置。

### 第 2 步：上传/替换配置文件
把本目录 `config/` 下的文件放进你 Fork 仓库的对应路径：

| 本地文件 | Fork 仓库路径 | 说明 |
|---|---|---|
| `config/config.yaml` | `config/config.yaml` | 主配置（custom 调度 + 论文 RSS 源） |
| `config/frequency_words.txt` | `config/frequency_words.txt` | 每日热点默认词库 |
| `config/timeline.yaml` | `config/timeline.yaml` | 三板块时段编排 |
| `config/custom/keyword/frontier.txt` | `config/custom/keyword/frontier.txt` | 前沿瞭望词库 |
| `config/custom/keyword/paper.txt` | `config/custom/keyword/paper.txt` | 每日论文词库 |

> `crawler.yml` 无需改动（保持上游每小时 :33 运行的默认 cron）。

### 第 3 步：配置 Secrets（敏感信息，绝不写进配置文件）
Fork 仓库 → **Settings → Secrets and variables → Actions → New repository secret**：

| Secret 名 | 值 | 必填 |
|---|---|---|
| `FEISHU_WEBHOOK_URL` | 你的飞书群机器人 Webhook | ✅ |
| `AI_ANALYSIS_ENABLED` | `true`（AI 增强默认开） | ✅ |
| `AI_API_KEY` | DeepSeek 等 API Key | ✅ |
| `AI_MODEL` | `deepseek/deepseek-v4-flash`（或 `openai/gpt-4o` 等 LiteLLM 格式） | ✅ |
| `AI_API_BASE` | 留空（官方端点） | 可选 |
| `NTFY_TOPIC` 等 | 其他渠道按需 | 可选 |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_PROJECT_NAME` | 想自动发布 HTML 报告到 Cloudflare Pages 时配置（App 读网页报告） | 可选 |

---

## 3. 首次运行与验证

1. 确认工作流已启用：仓库 **Actions** 页 → `Get Hot News` → 若显示禁用则 **Enable workflow**。
2. 手动触发一次：Actions → `Get Hot News` → **Run workflow** → 等待 1-3 分钟。
3. 检查飞书群是否收到推送；同时可看 Actions 运行日志（绿色对勾 = 成功）。
4. 若失败：展开失败步骤看日志，常见原因——Secrets 未配置、关键词过窄（推送为空）、RSS 源超时。

## 4. 运行时序（默认）

| 北京时间 | 动作 |
|---|---|
| 每小时 :33 | 前沿瞭望增量推送（有新 AI 动态才推，无则不推） |
| 08:33 | 每日热点（当日全部热点 + AI 分析） |
| 09:33 | 每日论文精选与解读（论文列表 + AI 解读 + 标题翻译） |

> GHA 官方建议定时间隔 ≥2 小时（存在随机延迟，每小时偶尔漏跑一次属正常；后续可迁 Docker 消除）。

## 5. 7 天签到机制（重要）

上游为珍惜 GitHub Actions 公共资源设计了试用机制：**每 7 天需手动运行一次 `Check In` 签到**，否则工作流自动停用（仓库 Actions 页可见 `Check In` 工作流）。忘记签到就补跑一次即可续期。长期稳定运行建议后续迁 Docker（`docker compose up -d` + `CRON_SCHEDULE=*/30 * * * *`）。

## 6. App 读板块数据（引擎做后端）

当前版本可直接消费：
1. **HTML 报告**：每次运行生成 `index.html`（暗色/搜索/宽屏），配置 Cloudflare Pages Secrets 后自动发布网页版（国内访问快），App 内嵌 WebView 或浏览器直接打开。
2. **SQLite 数据库**：`output/` 下 SQLite 存储全部采集数据（含排名时间线），App 可解析。
3. **MCP Server**：本地部署 TrendRadar MCP（Docker `docker/Dockerfile.mcp`，默认端口 3333），App 通过自然语言查询热点趋势、跨平台关联（进阶项）。

## 7. 待你提供（回复豆包即可）

1. **GitHub 账号**：确认后豆包直接 Fork + 上传配置（一步到位）。
2. **FEISHU_WEBHOOK_URL**：飞书群 → 设置 → 群机器人 → 添加自定义机器人 → 复制 Webhook。
3. **AI_API_KEY**：DeepSeek 开放平台（platform.deepseek.com）创建 Key；模型默认 `deepseek/deepseek-v4-flash`。

## 8. 关闭 AI 增强（“设置里控制”）

- **快速开关**：把 Secret `AI_ANALYSIS_ENABLED` 改为 `false`（不改代码）。
- **精细控制**：官方可视化配置编辑器 https://sansan0.github.io/TrendRadar/ 可在线编辑全部配置并生成文件，改后 push 回仓库即可。
- 关闭后：热点/论文仍正常推送，只是没有 AI 解读与标题翻译，零 token 消耗。

## 9. 已核实的 RSS 源（2026-09-20 实测）

| 源 | URL | 状态 |
|---|---|---|
| arXiv cs.AI | https://rss.arxiv.org/rss/cs.AI | ✅ 200 |
| Nature | https://www.nature.com/nature.rss | ✅ 200 |
| Nature Communications（一区 OA） | https://www.nature.com/ncomms.rss | ✅ 200 |
| Nature Machine Intelligence | https://www.nature.com/natmachintell.rss | ✅ 200 |
| PLOS ONE（OA） | https://journals.plos.org/plosone/feed/atom | ✅ 200 |
| Hacker News | https://hnrss.org/frontpage | 上游默认源，GHA 环境可用 |

未纳入（实测受阻）：eLife（RSS 地址失效）、Cell 系期刊（cell.com 反爬 403）、MDPI（403）、PNAS（无公开 RSS）。后续可换源或自建 RSSHub 扩展。

## 10. 风险与注意

- **关键词命中率**：上线后观察 3 天，按实际推送微调 `custom/keyword/*.txt`（太宽 → 加 `!` 过滤词；太窄 → 加词/正则）。
- **AI 成本**：论文解读 + 翻译消耗 token，`ai_analysis.max_news_for_analysis: 150` 可下调控制成本。
- **GPL-3.0**：个人自用无碍；若 App 要闭源商用，需独立进程调用或换协议评估。
- **Webhook/Key 保密**：只进 GitHub Secrets，绝不提交到仓库文件。
