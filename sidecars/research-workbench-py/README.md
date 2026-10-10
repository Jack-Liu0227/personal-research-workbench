# 科研工作 1.0

面向高校科研人员/课题组的**证据优先**科研工作台：从选题到投稿的全链条，AI 只出草稿，每一步都留证据、都能被人工复核。

## 安装（Windows，一分钟）

在 PowerShell 里跑一行：

```powershell
irm https://raw.githubusercontent.com/3276166289-code/research-workbench/main/install.ps1 | iex
```

它会从 [Releases](https://github.com/3276166289-code/research-workbench/releases/latest) 拉最新版，装到 `%LOCALAPPDATA%\Programs\ResearchWorkbench`，在桌面建好快捷方式并启动。**重装不会动你的数据**（库、PDF、笔记都在 `data\` 里）。

> **给 AI 助手的说明**：把本仓库地址交给任何能在本机执行命令的助手（Hermes / Claude Code / Cursor 等），它读到这里就知道该跑上面那一行。
> 第一次打开需在「模型」页填**自己的** API key（不内置任何人的 key）。

手动装（不想用脚本）：下载 Releases 里的 `ResearchWorkbench.zip` → 解压 → 双击 `ResearchWorkbench.exe`；想要桌面快捷方式就跑 `install.ps1 -Source <解压目录>`。

## 源码运行（开发）

```powershell
python -m PyInstaller ResearchWorkbench.spec --noconfirm --clean   # 或双击 build.bat
.\install.ps1 -Source .\dist\ResearchWorkbench
```

---

独立于 Hermes 源码的科研工作台。Hermes 保持上游可更新；本目录负责**科研工作流 + 材料数据的证据链**。

## 两种用法

**Agent（默认页）**：直接说目标，模型自己去调工具。左中右三栏 = 会话流 + 工具调用卡片 + 检查器（概览/文献/笔记/证据/步骤）。
**工作流页**：同一批能力做成 7 个按钮，手动一步步走，不依赖模型规划。
两者写的是同一套 SQLite，混用不会打架。

## 七步工作流（每个任务一条流水线）

| # | 步骤 | 做什么 | 谁在做 |
|---|---|---|---|
| 1 | 创新点审查 | 模型给新颖性/可行性/证据充分度打分 + 风险 + 待答问题 | 模型 |
| 2 | 论文搜索 | OpenAlex / Crossref / arXiv 三源检索，去重入库 | 开放接口 |
| 3 | 下载精读 | 只对**开放获取(OA)**链接下载 PDF，入库后按页精读（要点带 p.页码） | 网络 + 模型 |
| 4 | 知识库笔记 | 精读 → 结构化笔记 + 证据表（页码/原文走严格闸门）+ 可选写 Obsidian | 本地 + 模型 |
| 5 | 文章撰写 | 用笔记 + 已登记证据起草章节，结论处带（文献 p.页码） | 模型 |
| 6 | 审查 | 审稿人视角：结论/评分/问题清单/证据缺口 | 模型 |
| 7 | 格式转换 | 稿件导出 md / html / docx | python-docx |

外加：**任务体系**（研究任务表）、**日历**（里程碑/截止/会议，可关联任务）、**模型切换**（多档案 OpenAI 兼容，右上角随时切）、**主题色**（7 套，本地记忆）。

## 运行

双击桌面「科研工作 1.0」，或：

```bash
cd C:\Users\24410\Desktop\科研agent\research-workbench
py -3.10 server.py            # 默认 http://127.0.0.1:8765，自动开 Edge 应用窗口
py -3.10 server.py --no-open  # 只起服务
py -3.10 app.py               # 旧的 Tk 界面（仍可用）
```

依赖：Python 3.10（`py -3.10`）+ PyMuPDF、python-docx（均已装）。搜索/模型走系统代理设置。

## 命令行（核心库）

```bash
python research_core.py data/research.sqlite3 create-task "O3 钠电掺杂" "哪种掺杂元素值得验证" "O3-NaNi1/3Fe1/3Mn1/3O2"
python research_core.py data/research.sqlite3 ingest TASK_ID paper.pdf
python research_core.py data/research.sqlite3 extract PAPER_ID
python research_core.py data/research.sqlite3 summary TASK_ID
```

## 测试

```bash
py -3.10 -m unittest -v          # research_core / integrations / workflow 共 9 项
node web/theme.test.mjs          # 前端主题配色自检
```

## 边界（1.0 的诚实标注）

- 证据抽取结果是**候选**，不是自动确认的事实；页码或原文对不上的一律拒绝，仍需人工审查。
- **只下载开放获取全文**，不绕过付费墙；没有 OA 链接就如实返回「无 OA 全文」。
- 模型产出（审查/撰写）是**草稿**，不是结论。
- 打包：`ResearchWorkbench.spec` 目前仍指向旧 Tk 入口；要出独立 exe 需把入口改成 `server.py` 并把 `web/` 加入 `datas`。当前交付形态 = 桌面快捷方式 → `启动科研工作1.0.bat`。

## 与「功能块」的对应

| 功能块索引 | 在 1.0 里的落点 |
|---|---|
| 01 文献检索（多源） | 步骤² 论文搜索：OpenAlex + Crossref + arXiv |
| 02 文献库与 AI 解析 | 步骤³ 入库（哈希去重/逐页文本）+ 步骤⁴ 证据闸门 |
| 03/04 PDF 精读·全文翻译 | 步骤³ 精读（翻译引擎留在 A 侧，未并入） |
| 15 Obsidian 集成 | 步骤⁴ 可选写 Vault（`integrations.py` 预览→令牌确认→写入） |
| 22 任务·项目·日历 | 任务表 + 日历表 + 界面「任务」「日历」页 |
| 10/11 模型配置与发现 | 「模型」页多档案 + 右上角切换（OpenAI 兼容） |
| 25 安全与凭据 | 仅本地 SQLite、只走 OA、Obsidian 写入需令牌确认 |

主题色与日历控件是 1.0 自己加的，功能块里没有对应项。

## 界面

外壳照抄「科研工作台」的骨架：侧栏（**模型** / Agent / 日历 / **项目** + 可折叠「研究」组 + 主题切换 + 连接指示）、顶栏（日期 / 任务选择 / Ctrl+K 全局搜索）、工作区标签页、底部状态栏（本地服务 / SQLite / 模型 / 工具数）。
Agent 页是工具调用式会话：每条消息、每个 tool_call 都有卡片，失败的工具显示红色而不中断整轮。

## 模型与 Agent（侧栏第一项）

对齐科研工作台的「设置 → 模型与 Agent」：**Provider 卡片制**，不再是一张平铺的档案表。

- **内置目录 40 家，每家一张卡片**（`providers_catalog.json`，直接从科研工作台内嵌的 pi-ai SDK 导出，不是手抄）：Amazon Bedrock、Anthropic、Azure OpenAI、Baseten、Cerebras、Cloudflare、DeepSeek、Fireworks、GitHub Copilot、Google / Vertex、Groq、Hugging Face、Kimi、MiniMax / CN、Mistral、Moonshot / CN、NVIDIA、OpenAI、OpenAI Codex、OpenCode、OpenRouter、Qwen Token Plan ×3、Radius、Together、Vercel AI Gateway、xAI、Xiaomi ×4、Z.AI ×2、Ant Ling。每家带真实 base URL、接入协议徽标、模型数和模型 id 清单（点一下即采用）。库里没有行也照样出卡片 —— 用到哪家就填哪家，不必先「添加」。
- 每家的**可选模型列表默认折叠**（原生 `<details>`，点开才铺开按钮；展开状态在采用/刷新后不塌回去），一张卡片默认只占四五行的空间。
- 卡片顶部可**过滤**（按名字/域名）、「只看已配置」「只看本机可调用」；已配置的卡片左边框转绿。
- 加自定义 Provider：名称 / 接口地址（填到 `/v1`）/ 接入方式 / Key
- 凭据：`已保存 | 未配置` 状态徽标，**Key 不回显**（页面只送、服务端只回 `key_present`，原文不进任何响应）；可更换、可清除
- 一键**发现模型**：打 `GET {base_url}/models`，候选列出来后点「采用」才写进列表，× 可撤销
- **测试连接**：真发一条最小消息（`max_tokens=16`），证明 地址 + Key + 模型名 三者能打通
- **设为默认**：点已采用的模型 chip，落成 `model_profiles` 的当前行 —— 下游 Agent / 七步工作流不用改一行

**已知边界（没装样子）**：「OAuth / 订阅登录」只做**打开厂商控制台 + 回贴凭据**，不做自动设备码流——各家 RFC 8628 要各自的 `client_id`，本机无法凭空拿到；真给你 client_id 再把轮询加进来。另外本机调用只实现了 `openai-chat` 这条线，选其它接入方式能从网关列到模型，但真正调用前会提醒。

**主题**：抄 zotero-lit-tool 的做法 —— 选一个「主色」，其余配色全部由它推导（深色底自动提亮主色并配深色文字，浅色底用本色配白字，侧栏底色吃主色色相）。8 个命名预设（研究蓝 / 松柏绿 / 群青蓝 / 珊瑚红 / 琥珀金 / 莓果红 / 理性紫 / 石墨灰）+ 自定义色号（取色器或直接输 `#176B87`）+ 恢复默认。侧栏底部和设置页都能一键切，选择存在 localStorage。

```bash
node web/theme.test.mjs   # 颜色数学自检（HSL 往返 / 明暗推导 / 对比度 ≥ AA）
```

## Agent 工具（11 个）

`library_overview` `knowledge_query` `calendar_add` `idea_review` `paper_search` `paper_download`
`paper_read` `notes_compose` `draft_write` `draft_review` `format_convert`

模型走 OpenAI 兼容的 `/chat/completions` + `tools`；不支持 function calling 的模型会退化成只答不调工具。
