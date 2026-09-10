# Zotero

## 2026-09-08 最新需求与验收（以本节为准）

- 移除重复的 `WORKBENCH / PAPER EXPORT` 入口；统一为检索结果→Collection、选中文献→Better BibTeX、BibTeX→Agent Runtime。
- Collection 区域固定宽度并在内部滚动；父/子 Collection 支持上下展开/收起，Collection 面板和 `INSPECTOR / READ-ONLY` 支持左右折叠。
- 批量选择支持 Collection 绑定、标签、Better BibTeX 导出和 Agent 文献上下文登记。
- 不直接写 `zotero.sqlite`；所有外部写入必须经过 capability probe、预览、确认、revision 检查并逐条返回结果。

状态：PARTIAL。重复入口清理、批量写入和折叠布局仍需真实 Zotero 验收。

> 文档状态（2026-08-29）：本文件是 Zotero 本地/Web 连接、Collection 浏览和 Paper 投影的唯一计划源。V2 capability、分页和 Better BibTeX 约束已合并；旧执行计划不再单独维护。

## V2 本地连接与真实状态

- 配置保存 `Local API 地址`、library 范围和非敏感字段；凭据只由 Main `safeStorage` 管理，Renderer/SQLite 不接触 token。
- 连接状态必须来自真实 capability probe。地址必须是 HTTPS 或 localhost/loopback；拼写错误、离线、未授权、限流和不支持能力显示对应不可用状态，不静默改写 URL、不用 mock 成功。
- Collection 通过支持的 API 读取真实 `key/name/parentKey/itemCount` 并分页；禁止读写 `zotero.sqlite`，附件只保存 locator/链接。

## Zotero 正常连接验收（新增需求）

- 设置页的连接配置以 profile 为单位保存：配置名可为“我的zotero”，Local API 地址推荐填写 `http://localhost:23119/api/`；用户截图中的 `http://1ocalhost:23119/api/`（数字 `1`）必须被指出为无效地址，应用不得静默改正。
- 连接测试必须在 Zotero Desktop 实际运行时执行真实 loopback probe：校验 URL、请求 API 版本、访问配置的 library 范围，再读取 `/collections` 与 `/items`；只有收到符合 schema 的真实响应才显示“已连接”。
- 探测结果至少区分 `connected(read/write)`、`connected(read-only)`、`not_configured`、`offline`、`unauthorized`、`invalid_url`、`temporarily_unavailable` 和 `partial`，并在设置页/状态栏/本页保持一致。
- Better BibTeX 存在时，连接验收还要检查稳定 citation key 或导出字段是否可读取；插件未启用不应阻断基础 Zotero 读取，但必须明确显示能力缺失。
- 保存配置、关闭应用、重启后再次探测是同一验收场景；不能仅凭 `.env` 存在、凭据存在或上次状态显示成功。
- 验收只能使用用户本机真实 Zotero 和测试条目/Collection；不得启动 mock HTTP 服务，不得把生成 RIS/BibTeX 文件写成“已导入”。

## Better BibTeX 与项目联动

- 优先读取 Better BibTeX 提供的稳定 `citationKey`/导出字段，将 `itemKey ↔ citationKey ↔ PaperId ↔ Obsidian relativePath` 写入 ResourceLink/ExternalLink 映射。
- 导入工作台是幂等的 Paper + 外部链接本地事务，提供重复、跳过、冲突和部分失败 receipt；项目关联写入 SQLite，不通过修改 Zotero Collection 代替。
- 写入 Zotero 前必须再次 capability probe、预览和用户确认；Local API 授权后通过 `POST /items` 创建新条目、通过 revision-checked `PATCH` 更新既有条目，并登记 ExternalLink。无法获得写能力时才生成 RIS/BibTeX handoff，并明确“尚未导入 Zotero”。

## V2 验收状态

Zotero 本地/远程基础页面、真实 Collection 分页、本地 Paper 导入、授权 Local API 创建/更新路径和批量预览回执已接入；当前 `.env` 中的 Zotero 主机拼写需要先核对，应用未因此伪造连接成功。2026-08-29 对标准 localhost loopback 的本机探测返回 `WebException`（Zotero 当前不可达），因此没有“已连接”证据。Better BibTeX 全量字段、附件索引和真实用户库重启验收仍需在受控本机完成。

## 页面目标

连接 Zotero 文献库，浏览 Collections、条目、附件和笔记，并将文献关联到项目、任务、文献矩阵、知识引擎与 Obsidian。

## 页面结构

### 顶部连接区

- 连接状态、本地文献库、同步时间和索引状态。
- 打开 Zotero、同步索引、导入条目、新建工作台笔记。

### 左栏：文献集合

- Collections、Saved Searches、未分类、最近添加、带 PDF、待读。

### 中栏：文献列表

- 标题、作者、期刊、年份、标签。
- PDF 状态、阅读状态、Collection 和关联项目。
- 搜索、筛选、排序、多选和批量加入项目。

### 右侧检查器

- Metadata、Abstract、Attachments、Notes、Tags、Collections。
- DOI、PMID、arXiv ID 和来源链接。
- 关联项目、任务、矩阵行、Obsidian 笔记和知识库状态。

## 数据边界

- Zotero 条目、Collections、附件和 Zotero 内部笔记以 Zotero 为权威来源。
- 项目、任务、阅读工作流、AI Job 和跨资源关联由 SQLite 管理。
- 通过 ZoteroReference、item key、citation key 和外部标识符建立连接。

## 后续设计：AI SDK 与知识引擎（未启用）

- AI SDK 后续可读取用户选中的摘要、笔记和授权 PDF 文本。
- AnythingLLM 可以将 PDF 加入项目 RAG Workspace。
- LLMWiki 可以将条目及其笔记加入项目 Wiki 来源。
- 所有结果均回到统一 AI Job 与 Artifact。

## 后续设计：Zotero 自动化（未启用）

- 可按 Collection、标签、项目映射和新增时间创建“新增文献简报”规则。
- 现成 Agent 通过 MCP 读取条目元数据、摘要和授权文本，生成每日/每周摘要并投递到项目收件箱。
- PDF 摄取、AnythingLLM 索引和 LLMWiki ingest 使用内容指纹去重；同一附件只保留一个源路径。
- 自动化只保存工作台阅读状态、项目关系和 Artifact；对 Zotero 元数据、标签或 Collection 的修改仍通过 Zotero Command 和权限确认。

## 后续设计：MCP 范围（受控读写）

- Resources：Collections、条目元数据、附件状态和授权笔记。
- Tools：搜索、导入、加入项目、建立 Obsidian 关联、派发 RAG/Wiki 摄取。
- 修改 Zotero 元数据、标签或 Collection 前按工具权限确认。

## 可参考 GitHub 项目

| 项目 | 可复用内容 | 建议 |
|---|---|---|
| [zotero/zotero](https://github.com/zotero/zotero) | 条目模型、Collection、附件、阅读器与本地连接行为 | 作为权威 schema/交互参考；遵守 Zotero 许可证 |
| [retorquere/zotero-better-bibtex](https://github.com/retorquere/zotero-better-bibtex) | Citation Key、自动导出和稳定引用标识 | 适合作为 Zotero/Markdown 关联基础，核对 GPL 义务 |
| [benjypng/logseq-zoterolocal-plugin](https://github.com/benjypng/logseq-zoterolocal-plugin) | Zotero 7+ 本地连接、模板、导入跟踪和批注同步 | 参考本地 API 与增量同步逻辑 |
| [daeh/zotero-markdb-connect](https://github.com/daeh/zotero-markdb-connect) | Zotero 与 Markdown 数据库双向跳转 | 参考外部笔记路径映射 |

## GitHub 详细复用规划

| 项目 | 复用方式 | 代码落点 | 改造内容 | 验收标准 |
|---|---|---|---|---|
| [zotero/zotero](https://github.com/zotero/zotero) | Schema 与交互权威参考 | `connectors/zotero/schema`、`features/zotero` | 建立 Item、Creator、Collection、Attachment、Note 的本地 DTO 和 Fixture；参考三栏布局与选中行为，UI 独立实现 | Zotero 7 常用条目类型、附件和 Collection 映射无损 |
| [zotero/translators](https://github.com/zotero/translators) | 元数据规则参考 | `connectors/zotero/translators` | 复用站点识别、字段规范化和测试样本的思路；每个 Translator 单独记录来源与许可证 | DOI、作者、期刊、日期、附件解析可追溯 |
| [retorquere/zotero-better-bibtex](https://github.com/retorquere/zotero-better-bibtex) | 外部能力/协议参考 | `connectors/zotero/citation-keys` | 优先通过其现有导出或接口获取稳定 Citation Key；不复制 GPL 代码进闭源核心 | Citation Key 变化能被检测并修复 Markdown 关联 |
| [benjypng/logseq-zoterolocal-plugin](https://github.com/benjypng/logseq-zoterolocal-plugin) | 增量同步参考 | `connectors/zotero/sync` | 借鉴 Zotero 7+ 本地连接、模板、导入跟踪与批注同步状态机；重新实现为 Query/Command Adapter | 首次索引、增量更新、删除和重连测试通过 |
| [daeh/zotero-markdb-connect](https://github.com/daeh/zotero-markdb-connect) | 路径映射参考 | `connectors/zotero-note-links` | 设计 Zotero item key ↔ citation key ↔ Markdown file ↔ ResourceLink 映射 | Zotero 与 Obsidian 双向打开、路径变化恢复可用 |
| [Mintplex-Labs/anything-llm](https://github.com/Mintplex-Labs/anything-llm) | RAG/定时 Agent | `connectors/anythingllm/zotero` | Collection ↔ Workspace 映射、附件指纹、定时新增摘要和引用回收 | 同一 PDF 不重复摄取，摘要保留 Zotero item key |

## 界面图片提示词

```text
设计一张高保真中文桌面科研工作台“Zotero”连接界面，16:9 深色 Electron 应用。左侧固定导航选中 Zotero，顶部显示 Zotero 已连接、本地文献库和最后同步时间。主体三栏：左栏是 Collections 树，包含 AI4S、LLM、Agents、材料科学、文献综述、待读；中栏是高密度论文列表，每行显示标题、作者、期刊、年份、标签、PDF 状态、阅读状态、关联项目；右侧检查器展示元数据、摘要、附件、Zotero 笔记、标签、Collections、DOI、关联 Obsidian 笔记、任务、项目和知识库状态。顶部有“创建新增文献简报规则”，右下角显示 AnythingLLM Agent 每天 07:30 检查 AI4S Collection，最近新增 4 条、已投递项目收件箱。操作包含打开 PDF、创建笔记、加入矩阵、添加任务、发送到 AnythingLLM、加入 LLMWiki、复制 MCP Resource。全部中文，深蓝黑、石墨灰、青蓝高亮，严肃学术、密集但优雅。
```
## 2026-08-30 需求增量：连接配置与项目导出

- Local API 地址必须经过 Zod 形状校验与 localhost/HTTPS 主机校验；错误地址返回字段级提示，不再显示笼统的“The request did not match the expected shape”。例如 `1ocalhost`（数字 1）必须提示改为 `localhost`。
- Zotero 页面主职责是选择单篇/多篇条目并导出到项目 Paper 资源、文献矩阵或文献综述；导入/写回 Zotero 只通过右键预览和确认入口。
- Collection、item、citationKey、DOI、附件 locator 和项目 label 统一映射到本地 Paper/ResourceLink；绝不写入 Zotero 原数据库。
- 设置页提供 Local/Web API URL、token/key、libraryType、libraryId、默认 collection 和 Better BibTeX 字段映射；保存后执行真实 capability probe。

## 2026-08-30 执行补充（当前有效约定）

- Paper→Zotero 预览允许批量 `paperIds`，与 Zotero→本地的 `itemKeys` 互斥；至少选择一侧后才接受请求，修复空选择导致的 expected-shape 错误。
- 检索结果批量导入会先写入统一 SQLite `papers` 表，再生成 Zotero 预览；外部 API 写入仍需用户确认，生成 RIS/BibTeX 仅表示 handoff，不表示已导入。
- Zotero Local API 仍需用户机器上 Zotero Desktop 实际运行后探测；当前 `.env` 中的 `http://1ocalhost...` 是无效拼写，必须改为 `localhost` 或 `127.0.0.1`。

### 本机验收记录（2026-08-30）

- 只读请求 `http://localhost:23119/api/users/0/items?limit=1` 与 `http://127.0.0.1:23119/api/users/0/items?limit=1` 均被目标端关闭，尚不能判定 Zotero Local API 已连接；`http://1ocalhost:23119/api/` 中的数字 `1` 主机名无法解析。应用继续显示真实不可用状态，需在 Zotero Desktop 启动并修正地址后重新探测。
## 2026-08-30 检索页边界（当前有效约定）

- 文献检索页不再重复展示 Zotero Collections/Items 浏览器；Zotero 页面负责连接能力、集合和条目管理。
- 检索结果单篇或批量导入 Zotero 均从结果右键菜单发起，先生成本地 Paper 与可审阅预览，确认后才执行 API 写入或生成明确的文件交接。

## 2026-08-30 最终基线：Local API 可写授权

- 默认地址为 `http://localhost:23119/api/`（相邻 `.env` 的 `ZOTERO_API_URL` 仅作为非敏感默认值）；保存配置后必须由 Main/Connector 执行真实 capability probe，不能以“已保存”冒充已连接。
- Zotero Desktop 10+ 的 Local API 读取无需 key，但写入需要运行时授权。应用先读取响应头 `Zotero-Server-ID`，再通过 `POST /api/local/authorize` 请求用户在 Zotero 中确认；返回的 key 仅由 Main 使用 `safeStorage` 保存，Renderer 永不接触。
- 后续读取/写入携带 `Zotero-API-Key` 与 `Zotero-Server-ID`；所有外部写入仍需预览、明确确认、revision 检查和逐条回执。远程 HTTPS API 只接受用户提供的 API key，不走 Local 授权流程。
- Zotero 页面只负责连接能力、collection/item 浏览和导出到本地 Paper/项目；不显示 `PAPER → ZOTERO` 重复面板。网络检索结果的单篇/批量导入由文献检索结果右键菜单和行内 `+` 入口负责。

## 2026-08-31 合同增量：待分类到 Zotero

- 搜索缓存 `SearchSession`/`SearchResult` 不再作为持久化待分类库。检索结果保存后使用独立的 `LiteratureStagingRecord`，清理搜索会话不会影响该记录。
- 待分类数据只通过严格 RPC 管理：`literature.staging.page/save/delete/bulkDelete`；删除命令带 revision 锁，批量回执逐条报告成功、跳过或失败。
- 待分类导入 Zotero 固定为 `literature.stagingToZotero.preview` → `literature.stagingToZotero.execute`。预览绑定 profile、目标 Collection、传输方式和 capability，执行始终需要显式确认；不具备写能力时生成的 RIS/BibTeX 仅是交接文件。
- Zotero、输入和远端响应失败统一返回脱敏的字段级 `IntegrationError` envelope（含来源阶段、字段路径、错误码、重试语义），不得暴露 token、路径、原始响应或附件正文。

## 2026-08-31 执行基线：Zotero 页面职责与导入入口

- Zotero 页面只保留配置选择、真实可读的 Collections/Items 浏览和只读条目详情；能力探测/授权由“设置 → 工具连接”统一管理。`CAPABILITY / LOOPBACK` 不再作为本页独立面板。
- Collections 与 `INSPECTOR / READ-ONLY` 支持折叠，默认条目详情折叠；移除本页 `IMPORT / PREVIEW → EXECUTE` 的 Zotero→Paper 重复导入面板。网络检索结果导入 Zotero 统一回到文献检索页的行内 `+`、批量按钮和右键菜单。
- Local API 的 URL、library 范围和凭据仍由 profile 保存；Main 使用 safeStorage 取得凭据，Workspace Service 预览调用会把凭据传入 Zotero capability/collection/item 读取和写入路径。Renderer 不接触 token。
- 连接器在读取前获取并传播 `Zotero-Server-ID`，对 malformed payload 返回脱敏 `IntegrationError`；写入仍要求真实 capability、预览、明确确认和 revision/逐条回执。

### 本轮验收边界

- `http://localhost:23119/api/` 是默认地址；`http://1ocalhost:23119/api/`（数字 1）明确视为无效，不能被自动修正。
- 本地 fixture 和连接器测试已通过；若你的 Zotero Desktop 未运行、端口被防火墙拦截或尚未完成 Local API 写入授权，应用必须显示真实的离线/未授权状态，而不是显示“已连接”或“已导入”。
