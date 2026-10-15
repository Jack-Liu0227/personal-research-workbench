# 双来源设计与能力矩阵接入

日期：2026-10-15。状态：`IN_REVIEW`。最终冻结快照已通过本地后端与 Renderer/UI 独立限定门禁，无未关闭本地阻断项；专项 E2E 33 个工作流/136 张原生截图与同构建全应用 E2E 均 PASS。真实服务与完整发布门禁仍未完成，详见末节；历史失败不作为当前门禁结论。

## 本轮范围与来源

用户要求以远程科研工作界面为主要视觉来源，对 PRW 整体样式大幅调整；以局域网 admin-console 的助手、团队、技能与 MCP 管理为行为来源，完整实现技能/工具与助手的启用和停用矩阵。全部设置分区继续采用左侧纵向导航，不恢复顶部设置标签栏。原有业务、SQLite 权威、凭据隔离和 V2 安全 IPC 不变。

| 来源 | 已检查的文件/版本 | 采用方式 |
| --- | --- | --- |
| [科研工作 web](https://github.com/3276166289-code/research-workbench/tree/main/web) | `main` commit `420225bb9e98726675c74a0f9fb7141e78d5abb8`；`web/index.html` 350632 bytes，SHA-256 `2459c44bf9112ab73b4621327a72f058f0069dd052f382cc2a07a3b0a69a7de6` | 参考双主题、232px 中性侧栏、紧凑顶栏/全局工作区标签/状态栏、细线卡片、主色推导、Agent 历史/主线双栏与主线内对话/轨迹切换、Provider 卡；以 PRW React/CSS 重写，不执行远程 HTML/JS |
| 局域网 qitu-zhixue | `\\192.168.137.2\科研资产\Study\qitu-zhixue` commit `587dbabcb2b5a1598b156f6affd97787e23d9a33`；`apps/admin-console/app/(console)/settings/{assistants,teams,tools,skills}/page.tsx`、`lib/api/assistantBindings.ts`、`packages/contracts/src/{admin,team-runtime}.ts`、`services/api/src/modules/platform-registry/platform-registry.{controller,service}.ts` | 参考管理和矩阵交互，改用 PRW Zod/typed IPC/SQLite/嵌入式 Pi；不修改共享来源 |

远程根目录的 LICENSE/MD/TXT、COPYING、NOTICE 及 web/LICENSE 未发现；局域网根目录和审查文件祖先目录无明确许可，manifest `private: true` 且未声明 license。因此只参考设计/行为并重写，不复制来源实现、JS/vendor、示例技能/凭据或增加来源依赖；取得许可前不能宣称可直接搬运源码。GitHub API 限流不当作“文件不存在”证据，commit 和 raw 文件另行固定验证。

独立 reviewer 重新下载 pinned raw 文件，字节/hash 与本地参考完全一致。局域网审查三文件在来源 Git 中无修改，其 SHA-256：`tools/page.tsx` 为 `e84b186d1e5bc97feef28ee76ff23eb2083e2ea3e50361e66ae8a910275cc3e0`；`skills/page.tsx` 为 `5213b14bbf48965bdf5cdfab49474269eaee81e6f712fd7b07172d42b4df23d4`；`lib/api/assistantBindings.ts` 为 `2cf73f4879039307484c37df6c24b46242fbb845a2a0586781dd77c37a206479`。

远程 Agent 当前是历史+主线双栏，PRW 大屏同时展示历史/对话/轨迹三栏是用户接受的本地扩展，不是远程已经具备的三栏布局。局域网来源数据库使用 `pgTable` / PostgreSQL，PRW 使用 SQLite；React/TypeScript 的跨语言移植问题不存在，但不能描述为三方同一数据库或直接复用 SQL。

## 来源行为差异

- 来源工具页提供“矩阵/JSON 编辑/预览”，同时更新 localStorage MCP 列表和助手 PATCH；保存失败存在仍提示已生效的分支，JSON 配置会填入未探测的 connected/20ms。PRW 不迁入这些假状态或双真值。
- 来源技能文件编辑和新增技能内容保存在 localStorage；绑定 PATCH 使用 `enabledSkills`，并不能证明服务端安装或实际运行时注入。PRW 只绑定已安装、受控且实际可解析的指令技能，不开放任意路径或浏览器代码安装入口。
- 来源 assistant PATCH 保存 `enabledSkills/toolIds/mcpServerIds` 数组；另一个 runtime agent 配置路径才逐项验证技能、工具、MCP 及子工具范围。PRW 所有配置入口共用受控目录和权限验证，不把名称/显示文本当稳定身份。
- 来源 `getAgentRuntime` 读取 `agentConfigs` 及其三类绑定，而设置页 PATCH 更新 `adminAssistants`；本次检查未发现这两个路径同步的证据，不能凭来源“立即生效”提示推断完整运行时链路。PRW 用同一 SQLite 助手绑定、同一 coordinator 实际读取闭环验证，不宣称源端 runtime parity。
- 来源任意 MCP stdio/http command、args、env、headers 配置不是本轮可信运行面。PRW 矩阵完整覆盖已有本机 Workspace MCP 工具；不虚构第三方 MCP 连接，也不把勾选当健康探测或绕过集成写入确认。

## 合同与数据闭环

`packages/contracts/src/agent-profiles.ts` 为唯一合同源，Renderer 不直接写 SQLite 或读取来源 HTTP API：

| IPC | 请求/结果 | 语义 |
| --- | --- | --- |
| `v2.agentBindings.matrix()` | `{ catalog, assistants }` | Core 一次读取受控能力目录和助手版本，矩阵使用此快照 |
| `v2.agentBindings.set(input)` | `{ assistantId, expectedRevision, kind, key, enabled }` → 助手 | 单格启停，稳定 ID/key，严格 CAS，不提交其他助手字段 |
| `v2.agentBindings.saveMatrix(input)` | `{ updates: [{ assistantId, expectedRevision, toolAllowlist?, skillKeys? }] }` → 助手数组 | 1–100 个唯一助手，至少指定一种绑定；整批一个事务、逐助手 CAS，任何错误整批回滚 |

Preload 校验入参和返回值；Core 校验真实目录与权限；`AgentProfileRepository.saveBindingMatrix` 在 immediate transaction 内先检查所有版本，再仅替换指定种类的绑定。保留助手名称、指令、模型、启用状态、创建时间及另一种绑定；更新修订号。复用 migration **38** 的绑定表，不覆盖历史迁移、不新增 39。

空工具绑定明确是零工具。未知能力不能新增/启用；已存在的过时绑定允许保留或移除，避免逐格清理被其他旧键阻断，并不因此注册未知工具或执行失效技能。只读策略不允许新增写入/外部请求工具，转为只读必须清除残留写绑定。团队强制只读，不因矩阵获得更多权限。运行中配置快照不热变；保存影响下一次新运行，终止当前运行使用既有取消入口。历史消息不会因停用绑定而删除，不能承诺模型遗忘旧内容。

## 责任与验证

- Supervisor / Architecture / Database：共享合同、Preload、原子数据库命令、文档和持久状态。
- Frontend Platform / Shell：真实来源视觉重写、矩阵、左侧设置导航、可访问性、隔离 Electron UI 验证。
- Workspace Service / Agent Runtime：目录统一校验、单格/批量命令、实际工具注册与技能指令注入的启停验证。
- 独立 Review/Security：来源/许可、CAS/能力边界、真实运行请求检查及最终门禁；作者不得自批。

已运行初始增量门禁：`pnpm --filter @prw/contracts typecheck`、`pnpm --filter @prw/database typecheck` PASS；数据库增量最终 14/14 PASS，包括 SQL 第二次写入失败整批回滚、CAS 失败无部分更新、真实关闭/重开数据库的启停持久化。最终冻结后端与前端分别记录如下。

### 最终快照证据

Supervisor 在后端冻结快照实际执行：

| 命令 | 结果与边界 |
| --- | --- |
| `pnpm test:agent-profiles` | PASS 42/42：数据库 14、dispatcher 8、团队 17、实际 SDK 1、跨助手凭据 2 |
| `pnpm test:agent-runtime-pi` | PASS 57/57，包含最终消息快照、空回答、indexed content block 及合法相同文字的不同消息回归 |
| `pnpm test:agent-credentials` | PASS 13/13，测试 vault，不是真实 OAuth |
| `pnpm test:agent-custom-providers` | PASS 4/4，实际固定 SDK + 本地 registry fixture |
| `pnpm test:agent-scheduled-credentials` | PASS 7/7 |
| `pnpm test:agent-settings` | PASS 8/8 |
| `pnpm test:workspace-mcp-agent-surface` | PASS 4/4 |
| `pnpm test:agent-external-actions` | PASS 24/24，模拟 connector，不是真实外部写入 |
| `pnpm test:agent-history-delete` | PASS 6/6 |
| `pnpm test:agent-ledger-grouping` | PASS 4/4 |
| `pnpm test:agent-model-discovery-ui` | PASS 17/17 |
| `pnpm test:agent-magic-commands` | PASS 3/3 |
| `pnpm test:agent-discovery` | PASS 4/4 |
| `pnpm typecheck` | PASS，全部 10 个 workspace 项目；最终界面冻结后再次执行仍 PASS |
| `node .agents/skills/agent-llm-integration/scripts/audit-agent-boundaries.mjs .` | PASS，无保守边界发现；此静态审计不替代独立安全门禁 |

实际固定 Pi SDK 的回环 SSE 测试使用 **localhost MOCK Provider**，不是外部模型服务：三次同会话请求中的注册工具依次为 `tasks_search → [] → []`；启用技能时完整 Markdown 进入系统提示词，停用后不再注入；历史对话保留，服务未公开的工具不能被助手重新授权。首轮回答严格等于 `Local fixture answer`，SQLite 聊天和 ledger 各准确一份；第四次模型请求返回严格 director JSON，团队完成，输出准确为 `Fixture team output`，仅有一个 child。

上述 fixture 暴露并关闭一个真实归一化缺陷：SDK 初始可变消息快照可能已包含后续文本，原逻辑拒绝较短最终快照，造成重复回答和 director JSON 解析失败。修复以最终快照为权威（包括空字符串），按 `contentIndex` 分离文本/思考块，最终回答不混入思考或工具；不采用全局文字去重，保留不同消息的合法相同内容。

独立 Review/Security 在最终后端冻结树亲自执行 profiles 42/42、Pi 57/57、完整 typecheck，均 PASS，并完成来源/许可和补丁审查。后端限定结论为 **APPROVE：本地多助手、只读团队、已有 Workspace 工具及已安装 instruction 技能矩阵**，无未关闭后端阻断项；不代表真实外部服务、最终 UI 或发布批准。作者未自批。

### 界面回归历史与最终门禁

Frontend 在后端冻结及自定义主色/窄窗微修之后实际执行 `pnpm build`，PASS；该历史 Renderer 产物为 `index-Cjluz5hq.js` / `index-C_AYWD3O.css`。没有用旧 Core 构建充当后端冻结证据。独立视觉审查随后发现三栏 Agent 输入区控件重叠，因此本快照不是最终 UI 批准。

该历史 `pnpm test:e2e:agent-profiles` PASS：24 个真实 Renderer/Preload/Core 工作流、116 张截图、console/page errors 为空。Supervisor 直接读取 JSON 核验 status/count/errors/overflow，并查看代表性桌面矩阵、仪表盘、Agent、320px 单元格与保存区截图。证据目录为本机临时 `prw-agent-profiles-e2e-SHd3LX/agent-profiles-evidence.json`，SHA-256 `8653D3DA38A1396A84E574730EFD603080ECB56D55C9450951A9E67700EB3E23`。这些截图没有覆盖三栏同时展开时的输入区控制布局，不能据此关闭后续发现。

- 16 个设置分区全部为左侧纵向导航；窄窗是左侧图标轨道/抽屉，不是顶部设置标签。原 Shell 工作区标签保留。
- 工具与技能均覆盖两个助手、行/列启停、草稿不落库、保存/重新载入、冲突保留草稿、未知单格/非法批量拒绝及整批不部分写入；启用和停用两种结果真实重启持久化。
- 同名不同 ID 的密集矩阵不合并身份；原生键盘焦点覆盖 180 个工具单元格和 18 个技能单元格，Space 启停可逆；只读助手写工具单元格不可新增。
- 两种主题下助手/团队/Agent/矩阵覆盖外窗 1440/1024/720/320px；11 个真实页面在浅/深主题、自定义主色及 1440/720px 渲染。真实 Electron `setZoomFactor(2)` 验证矩阵键盘操作，不以字号替代缩放。
- 四个预设与自定义主色的实际按钮对比度测量全部 ≥4.5，最低为 4.548691482970604；自定义选择重启仍存在。116 张截图全部无横向文档溢出或未约束控件越界。
- 无凭据团队真实失败并保留 child 身份/ledger；不伪造外部模型成功或现场取消证据。

中间回归曾暴露键盘 modality、CSS transition `oklab` 的测试解析错误和相同自定义色再次应用问题；最终保持可见 focus 与 ≥4.5 原断言，通过浏览器 canvas 真实解析颜色，并新增显式自定义主色应用。320px 矩阵 intro 以纵向布局修复逐字竖排。此前失败/108 张截图中间快照不算最终通过。

历史补充 `agent-profiles-zoom-evidence.json` PASS：4 个工作流、12 张 Electron 原生截图、errors 为空，SHA-256 `1F9FD644E4E4780D310D22259CA32B94E762CA170B579BC791228077047547C5`。原生 `capturePage`、单元格视口边界/中心 hit-test/键盘焦点与启用保存按钮证明矩阵在真实 200% 缩放下可操作；旧 fullPage 在缩放下的裁切不能作为视觉缺陷依据。独立 reviewer 当时认可矩阵补图，但 Agent 三栏的项目/Provider/model/运行方式/助手控件实际重叠，浅色 Provider 截图仍为 loading，故当时 UI gate 为 REQUEST CHANGES。后续已修复并重新构建、完整回归和独立审查；最终结论见末节。

布局修复首轮新 focused（`prw-agent-profiles-e2e-lgB4Tx`）在 13 张正式截图后 FAIL（另有 failure.png）：720px Agent 选择器不可见。窄窗历史面板变为 absolute overlay 后，主线程隐式放入 48px 轨道列；原先控件溢出掩盖了布局缺陷。次轮 `sCR6pC` 在 20 张截图后 FAIL：320px 换行工具栏超过视口高度，控件被线程裁切。三轮 `MteoOt` 在 125 张截图后 FAIL：真实 Provider 卡已加载，但测试脚本使用了不匹配的 implicit label 等待；改用所属表单真实 select，不移除 loaded-card/loading-hidden 断言。这些失败及旧补图均不算最终通过。

### 历史第三构建布局回归（随后命令浮层回归失败）

Frontend 实际执行该历史构建 `pnpm build` PASS：Main/Core/Preload/Renderer 完整构建，无依赖或业务层 delta。修复限定为可换行工具栏、容器比例留白、线程显式 `grid-column: 2`、输入区 `max-height: 60%` 与可滚动高度边界，不隐藏配置入口或强制点击。

| 历史第三构建 | SHA-256 |
| --- | --- |
| `apps/desktop/out/main/core-worker.cjs` | `7129AAFC28CC55717DC9DE06766182349BAC2FA32C079C7FF94198493CE23934` |
| `apps/desktop/out/renderer/assets/index-Bd_sc9Z7.js` | `16C3B77EAA919BBF97C679E1C1B8F6296CB647A620FE039CB6D2D97AE154E50A` |
| `apps/desktop/out/renderer/assets/index-Hh2I7TxR.css` | `FBFA6363C5D4CAF187616F3178F1A23F6CB52E7B9C9F400E7281D5F8F1768674` |

第三构建 fresh-profile `pnpm test:e2e:agent-profiles` **PASS：29 个工作流、132 张 Electron 原生截图、console/page errors `[]`**。证据为本机临时 `prw-agent-profiles-e2e-Vaubwe/agent-profiles-evidence.json`，SHA-256 `9FF3B313147A532D7F71EB4EFFA79CE3435F3619A6E4D78F9EA3110E0E5B17A8`。Supervisor 直接读取 JSON，并查看三栏 Agent、已加载 Provider 卡、窄窗输入区等截图；不以作者口述代替证据。该完整布局回归没有覆盖后来发现的命令浮层鼠标回归，因此不是最终整体 UI 批准。

- 上述双矩阵原子保存、冲突、权限、脏草稿与重启持久化工作流完整重跑，16 个设置仍全部为左侧导航。
- 11 个真实页面、浅/深主题、桌面/窄窗、四预设/自定义主色、真实 200% Electron 缩放均重跑；132 张截图的文档溢出与未约束控件越界数组均为空。
- 12 组输入区布局：双主题 720/320px 默认助手，以及桌面 14/16px 字号的默认/指定助手；全部控件无 pair-overlap。每组 textarea、select、上下文/发送按钮逐项真实 scroll/focus，位于 viewport/main/thread/dock clip 交集内，启用控件中心 hit-test 与 focus 均通过。没有 `force` 或跳过默认五个选择器。
- 4 组窄窗历史面板真实展开/收起，主线程定位和宽度不变；720px 内容宽 590px、320px 内容宽 190px。短高输入区内部可滚动，保留主消息区。
- 浅/深主题均实际等待 40 张 Provider 卡和所属表单 select 可见、loading 消失后截图，`providerCards.loading` 均为 false。
- 真实 200% 缩放下 412 项矩阵单元格/按钮视口与键盘证据全部通过；180 个工具格、18 个技能格原生键盘与 Space 启停保留。18 项主色按钮对比度全部 ≥4.5，最低 `4.548691482970604`。
- Supervisor 在该历史第三构建后重跑 `pnpm typecheck`，全部 10 个 workspace 项目 PASS；两 E2E 脚本 `node --check`、相关 `git diff --check` 和严格 UTF-8 检查 PASS。

独立 reviewer 亲自读取同一 JSON/源码及 10 张原生截图，认可上述布局/矩阵证据并关闭三栏重叠、720px 网格定位和 320px 输入区可达性 finding；未亲自执行 focused Electron。空 prompt 下发送按钮禁用，此证据只证明其完整尺寸/可见，不表示现场发送或真实 Provider 调用。

Supervisor 随后串行执行第三构建 `pnpm test:e2e`，**FAIL**：`scripts/e2e-electron.cjs:343` 的 `/help` 补全鼠标点击被消息空态截获，输入区滚动边界裁切了绝对定位命令浮层。fresh profile 为 `prw-workbench-e2e-yB7vH0`，本机日志 `prw-general-e2e-final-20261015-013611.log`，exit 1；`finally` 已关闭 Electron 与 HTTP fixture。独立 UI gate 当时立即重开为 REQUEST CHANGES，要求浮层脱离滚动 clip、保留锚点与鼠标/键盘补全，不允许 `force` 或键盘替代鼠标断言。该 finding 已在下述最终构建、完整双 E2E 与独立复核后关闭；此失败仍作为历史证据保留。

另一次历史全应用 `pnpm test:e2e` 在 Zotero 条目选择栏处失败：旧测试无条件要求仅在 `canRead` 分支出现的选择栏，而本机服务不可读；不是此次 CSS 删除了选择控件。修复限定在测试脚本的只读随机端口 HTTP fixture，经现有真实 Connector/IPC/UI，不跳过选择范围和项目默认值断言。独立 reviewer 亲自执行 HTTP 边界负例：9 个请求覆盖不可读 503、合法 GET、POST/PATCH/DELETE/未知路径与查询拒绝，PASS；这不是全应用 E2E 或真实 Zotero 验证。最终脚本已确保仅使用 fresh Temp profile，任意 `PRW_E2E_USER_DATA` 覆盖在文件操作、服务与 Electron 启动前拒绝；完整重跑与独立最终门禁记录如下。

真实 Provider/OAuth、第三方 MCP、真实外部写入及 Windows NSIS 安装回归未由本轮本地测试替代。此前隔离打包失败见实现 27；任何未执行命令均不得记为 PASS 或 DONE。

### 最终冻结构建与双 E2E 门禁

Frontend 将命令浮层改为 positioned `.agent-thread` 内的绝对定位兄弟节点，脱离输入区滚动裁切；通过 `ResizeObserver`、窗口 resize 与 capture-scroll 更新真实输入区锚点并清理监听。保留 320px 输入区内部滚动、主消息区与五个默认选择器。另修复静止鼠标覆盖键盘选中项和窄窗浮层 intrinsic-width 溢出；原鼠标/键盘补全、焦点与本地命令语义不变。初始浮层 sanity 的键盘与窄窗失败只用于诊断，不算通过。

| 最终冻结资产 | SHA-256 |
| --- | --- |
| `apps/desktop/out/main/core-worker.cjs` | `7129AAFC28CC55717DC9DE06766182349BAC2FA32C079C7FF94198493CE23934` |
| `apps/desktop/out/renderer/assets/index-BupRxgEE.js` | `B28A274133D66D0C5228F4163B0F2AAFAFB099FD833C434CA6DE10BF92F923B8` |
| `apps/desktop/out/renderer/assets/index-9XHUjMbI.css` | `B70C78A50E6AEBC83A89725DE702A687FCA6476C2D4AA2D0609CAFA5B7B2E7E0` |

- Frontend 实际执行最终 `pnpm build` PASS；Supervisor 在该构建后实际执行 `pnpm typecheck`，全部 10 个 workspace 项目 PASS。两 E2E 脚本 `node --check`、相关 `git diff --check` 与 Agent 边界静态审计 PASS。后端、合同、依赖、打包策略未在本次浮层修复中变更。
- 最终浮层专项 sanity PASS：4 个工作流、4 张原生截图、12 条严格选项记录、errors `[]`。本机临时证据 `prw-agent-profiles-e2e-tkrtOM/agent-palette-evidence.json`，SHA-256 `776406DA43304EB03638E9990B7AB1199511BF6BC60A75517A5758DCB615CCFF`。
- Frontend 实际执行完整 `pnpm test:e2e:agent-profiles` **PASS：33 个工作流、136 张 Electron 原生截图、console/page errors `[]`**。本机临时证据 `prw-agent-profiles-e2e-WnnxDm/agent-profiles-evidence.json`，SHA-256 `FE988979EB2A0D5094AEF834A33CC730CCDC2200C29521B5F8169938DDDDFEB2`；Supervisor 直接解析核验，不以摘要代替证据。
- 同一最终构建，Supervisor 串行实际执行 `pnpm test:e2e` **PASS，exit 0**；fresh profile `prw-workbench-e2e-fX6J28`，15 张原生截图，Renderer errors 0、fixture violations 0，Electron/HTTP fixture 均关闭。日志 `prw-general-e2e-final-20261015-015458.log`，SHA-256 `695CF77C9C174168C6142AC0D78A79945D791E102E3CCF6D77F5282E6F1ECB56`。PowerShell 对 pnpm stderr 的 `NativeCommandError` 包装不是此命令失败；以真实退出码与最终断言为依据。

完整 focused 保留全部矩阵草稿/冲突/原子回滚/权限/同名 ID/重启持久化与 11 页、16 个左侧设置分区、双主题、四预设/自定义色、字号和真实 200% Electron 缩放回归。136 张原生 PNG 与 viewport × DPR 物理尺寸一致；溢出/未约束越界数组为空。12 条浮层记录验证 absolute、真实输入区上方锚点、线程/视口边界、非 dock clip 和中心 hit-test；执行真实 `/help` 鼠标选择及本地结果、ArrowDown/Tab、末项 ArrowUp 滚动/命中、Enter/Escape，验证 IPC 会话/运行身份没有新增。未强制点击或用键盘绕过鼠标断言。

12 组输入区布局的 88 项可达控件无 pair-overlap；每项真实滚动/聚焦/启用控件 hit-test 位于有效裁切交集。4 组窄窗历史展开/收起保持主线程定位；412 项矩阵控件真实 200% 视口/焦点/命中、180 个工具格与 18 个技能格 Space 启停通过。两主题 Provider 卡均为实际加载 40 张且 loading=false；18 项按钮对比度最低 `4.548691482970604`，均 ≥4.5。空 prompt 时发送按钮禁用，尺寸/可见证据不等于真实模型发送。

全应用 general 同时保留真实 `/help` 鼠标/本地响应、全 11 页面、16 分区与模型 deep-link、40 Provider 凭据往返、`models.json` 40→41、三栏/窄窗轨迹、文献帮助/URL 负例/预览、任务日期与删除、代理/知识/连接/飞书/RSS/计划、1440/1080/720/320 溢出、窄窗侧栏/帮助、嵌入矩阵单滚动容器与长内容滚动断言。

general Zotero 明确为 **隔离只读 HTTP MOCK fixture，不是真实 Zotero/BBT**。真实 typed IPC/CAS/Connector/adapter/UI 经随机 loopback 端口测试 503 不可读后转为可读、不可写，保留原选择/项目/导入/删除安全检查；只允许 3 条 GET 路径与已验证查询，拒绝所有写方法/未知路径/查询，`finally` 包括启动失败也关闭服务。没有写入空凭据；检测到 credentialPresent 即拒绝覆盖。`prw-workbench-e2e-fX6J28/zotero-fixture-evidence.json` 为 15 次 GET、3 次不可读/12 次可读、violations `[]`，SHA-256 `0BE2CB34E8E0C8A6E65C90AB6BF030638F68296A38768D65955658716344E22B`。

独立 Review/Security 亲自核验最终资产哈希、focused JSON 与全部 136 PNG 头/尺寸、12 条浮层、88 项可达控件、412 项矩阵与对比度记录，并查看 12 张最新代表图；另外亲自读取 Supervisor general PASS 日志、fixture JSON 和 Agent/Zotero 代表图。reviewer 未亲自执行这两次 Electron E2E，作者也未将 Supervisor general 执行冒称本人执行。最终结论：**APPROVE，限定本地多助手、只读团队、已有 Workspace 工具、已安装 instruction 技能矩阵及本轮 Renderer/UI；无未关闭本地阻断 finding**。历史 REQUEST CHANGES 已关闭，不是当前结论；此批准不等于来源平台全部能力或发布批准。

## 保留范围与交接

- 已实现矩阵从 Renderer → Zod/Preload → Core → SQLite → 下一次 Pi 工具注册/技能注入闭环，而非前端假开关；进行中的运行使用冻结快照，历史消息不删除。
- 任意第三方 MCP command/args/env/headers/远程服务注册、技能安装/文件代码编辑、并行团队尚未实现；本轮只管理已有可信 Workspace MCP 工具与已安装指令技能，团队强制只读。
- 真实 Provider/OAuth、在线团队取消、真实 Zotero/BBT 与外部写入、OS 级缩放、全传递依赖许可证发布审查仍未验收。localhost MOCK 与 Electron 200% 缩放不能替代这些门禁。
- 最新界面未产生新的安装包；之前隔离 NSIS 构建在重命名时报 EPERM，安装/启动/重启/升级/profile/卸载 smoke 未执行。未恢复用户已删除 sidecars 或改变打包策略；**P6 未完成**。
- `docs/design/SOURCE_DESIGN_MAPPING.md` 与 `AI_ASSISTANT_TEAM_MAPPING.md` 已同步最终 33/136、当前资产与 general PASS；CSV 新增本轮两项，均保留 `IN_REVIEW`，不更改历史状态。

Next receiving role：QA `.agents/roles/qa.md`、Review/Security `.agents/roles/review-security.md`；安装与发布由 Desktop Backend `.agents/roles/desktop-backend.md` 接收。

Suggested next step：使用专用测试凭据和隔离 profile 验证真实 Provider 的只读团队与取消，再单独完成 Windows x64 NSIS 安装/重启/升级/卸载门禁；没有执行或批准之前维持 `IN_REVIEW`。
