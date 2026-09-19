# 25 · 前端：对话分组修复、Agent 页面瘦身与设置页模型认证

状态：已实现并通过源码门禁与类打包 Electron E2E（Agent 工作区不再渲染运行配置控件、设置页「模型与 Agent」渲染出 40 个 provider、导航分组与响应式溢出扫描；见文末证据）。

本任务处理三件用户可感知的事：

1. **对话记录布局 bug**：用户说「所有我的提问堆在上面，所有回复堆在下面，长对话要来回翻」。根因不是样式，而是**分组单位选错了**。
2. **Agent 页面过于复杂**：模型/思考深度/权限/凭据表单占据了主工作区，普通用户不需要在这里配置。
3. **导航过于平铺**：10 个平级入口让「每天要用的东西」和「偶尔访问的地方」争夺同样的注意力。

## 1. 分组模型：run → turn → record

### 根因

`groupRecordsByTurn()` 只按 `record.turn` 分组，而**每个 run 的 turn 都从 0 开始**：用户 prompt 记为 `turn: 0`，助手回复是 `turn: 1..N`。于是一次对话里第 1 个 prompt 与第 100 个 prompt 落进同一个 `turn 0` 组，所有回复落进后面的组，分隔线又插在两组之间——渲染结果必然是「你的问题全部在上、回答全部在下」。

### 修复

`features/agent/ledger.ts` 的 `groupRecordsByRun(records): LedgerRun[]`：

- 按 `record.runId` 分组；
- run 顺序取**组内最小记录顺序**（不按 `runId` 排序：重试产生的 run 其 id 可能排在它所替代的 run 之前，而记录时间严格更新）；
- 组内按 `seq` 升序，再按 `turn` 切成 `LedgerTurn`（turn 数字序，每个 turn 携带 `usage` 与 `durationMs`）。

```ts
export interface LedgerRun {
  readonly runId: string
  readonly turns: LedgerTurn[]
  readonly records: AgentRunRecordEntry[]
  readonly startedAt: string
  readonly usage: AgentUsage | null
  readonly durationMs: number | null
}
```

排序稳定性由后端保证：`listAgentConversationRecords` 按 `agent_runs.created_at, agent_run_records.seq` 返回，前端**不再做启发式重排**。

## 2. ConversationView 渲染规范与状态矩阵

组件结构（`features/agent/conversation-view.tsx`）：

```
ConversationView            records 为空 → 空态文案
└── agent-ledger-stream     单一滚动容器的唯一子节点
    └── RunBlock            一个 run = 用户消息 + 该 run 的所有 turn
        ├── agent-run-heading（仅多 run 对话显示「运行 n」/时长/用量）
        └── TurnBlock       turn > 0 且该 turn 不只有空的 turn_end 时才画分隔线
            └── RecordList  parentId 命中的子记录嵌套渲染，不重复出现
                └── RecordRow / ToolCard / LifecycleNote / RecordBlock
```

- **问与答相邻**：每个 run 内的 turn 紧接在它自己的 prompt 之后，`.agent-run + .agent-run` 才用分隔线与更大间距，所以「一问一答」读起来是一块，而不是与下一个问题混在一起。
- **11 种 record kind 全部显式渲染**：`user`、`assistant`、`reasoning`、`tool`、`subtool`、`system`、`context`、`diagnostic`、`compacted`、`error`、`turn_end`。其中 `system`/`context`/`compacted` 以前被折进通用 fallback 便签，导致「上下文压缩」和一条普通日志看起来没区别，尽管前者改变了模型还能看到什么。
- `parentId` 指向父记录的 `recordKey`（**不是行 id**），因此子记录即使与父记录不在同一批推送里也能正确嵌套；命中不到父记录的子记录退化为顶层渲染，不会丢失。
- 助手文本继续使用仓库既有的 `MarkdownPreview`：本次约束是**不新增渲染依赖**，不是丢掉已有渲染器。
- 状态渲染：`running` 显示流式光标，`failed`/`canceled` 用 `statusTone` 与 `recordStatusLabel` 给出可读文案；`safeDisplayContent` 把「缺凭据/超时」这类后端诊断翻译成用户能执行的一句话（指向「设置 → 模型与 Agent」）。

| 状态 | 表现 |
| --- | --- |
| `records` 为空 | 「这是一段新对话，发送第一条消息即可开始。」 |
| 单 run | 不显示「运行 1」标题，避免把首条回复推下去 |
| 多 run | 每个 run 一个标题，run 之间一条分隔线 |
| 流式中 | 仅当视口已在底部附近时跟随滚动（`stickToBottomRef`），否则不打断阅读 |
| 切换对话 | 重置为「跟随底部」 |
| turn 只有空 `turn_end` | 不画 Turn 分隔线 |

## 3. Agent 页面瘦身

`features/agent/index.tsx` 只保留「发消息 + 看记录」两类动作：

- **删除**：运行时选择器、模型/思考深度/权限模式选择器、凭据表单、连接器探测 UI，以及与之配套的 `agent-runtime-bar` / `agent-runtime-pill` 区块。
- **顶部只读状态行**：改为一个 `<button className="agent-run-profile-link">`，显示「`Pi` · `<model>` · `<thinking>`」与权限模式简述，点击跳转到设置页「模型与 Agent」。用按钮而不是纯文本，是为了让这个值在键盘上可聚焦、可激活；同时它是**只读投影**，不会变成第二个控制面板。
- **输入框提示**（`.agent-hint-link`）只保留一行实话：运行配置在设置里维护；点击同样深链到设置页。
- **保留**：轨迹视图、统计、归档回执、选择栏等只读能力（用户仍能查历史），只去掉 codex 相关枚举项。

## 4. 设置页「模型与 Agent」

`AgentModelSettingsPanel`（`features/research/settings.tsx`）承载全部运行配置，数据来自三条互相独立的查询，因此三种状态可分辨：

| 数据源 | 方法 | 备注 |
| --- | --- | --- |
| 模型目录 | `agent.models.catalog` | 来自 Core 的 pi `ModelRuntime`，**不需要凭据** |
| 凭据状态 | `agent.credentials.status` | 来自 Main 的 safeStorage，只回状态不回 secret |
| 默认配置 | `agent.settings.get` | SQLite 单行 `agent_settings` |

`mergeProviderEntries(catalog, statuses)` 取**目录与 vault 索引的并集**：某个 provider 即使 SDK 已不再提供，只要 vault 里还有它的凭据就仍然列出，于是它是**可删除的**，而不会变成 safeStorage 里一个看不见的孤儿。

界面包含：provider 列表（每行显示认证类型、是否已配置、更新时间，当前选中行有 `settings-row-active`）；**每一行自带自己的凭据操作**（`设置 API Key`/`更换 API Key` → 该行内联的 password 输入 + `保存`/`取消`；`OAuth 登录`/`重新授权`；已配置时出现 `清除凭据`/`登出并清除`）。OAuth 的 `auth_url`、设备码、Pi 的 manual-code/callback prompt、取消、进度与成功/失败状态均渲染在发起它的 Provider 行内，不再在 Provider 列表底部出现共享二次确认区；默认 Provider / 模型 / Thinking 深度 / 权限模式 / 本地工具范围选择器与「保存默认配置」；自定义 Provider 编辑器（见下）。

两个被删除的冗余块及其原因：

- **独立的「Provider（未选择）+ API Key」行。** 它与 provider 行重复，而且把一份凭据拆成两半：provider 选 A、密钥属于 B 也能提交，错误要等下一次 run 才暴露。现在密钥的归属由它在哪一行决定，没有可选 provider 就没有可存密钥。
- **「运行时隔离」说明块。** 它描述的是唯一运行时的属性（还带一个版本号），读起来像一个可选控件，而实际没有第二个选项。边界仍然声明，但只在需要它的地方声明一次：设置页正文保留「不启动外部 CLI 进程、profile 固定为应用隔离目录」，不再单列一个块。

provider 列表只在超过 8 个 provider 时显示搜索框；同时只允许一个行内密钥编辑器打开，避免多个密码框在页面上堆积。

### 自定义 Provider 编辑器（`features/research/custom-providers.tsx`）

内嵌 SDK 未内置的服务（自建网关、Responses 协议供应商、本地推理）在这里录入，写的是 **pi 自己的 `models.json`**，因此界面添加 = 手改文件，文件也能被其它 pi 客户端使用。

- 只显示**绝对路径**并实时回读：用户可确认「到底写在哪里」（`<userData>/data/agent-runtime/pi/models.json`；需求原文的「安装目录」对普通用户只读且升级会清空，故不采用，此偏离在界面上一目了然）。
- 「快速添加」预设只填 `api` + `baseUrl` + 显示名，**不填任何模型 id**：硬编码厂商模型名几周就会过期，而错误 id 会在请求时才以厂商错误暴露。模型 id 必须由用户填写，且**为空即报错、禁止保存**（否则会写出一份 pi 无法用、应用又无法再改的文件）。
- 每个字段的错误都由 `@prw/contracts` 的 `customProviderIdIssue`/`customProviderUrlIssue` 给出，与后端读取器**共用同一函数**，避免「保存成功但重新加载变成 unmanaged」这种自相矛盾。
- `configError` 以 `role="alert"` 展示（文件损坏或 pi 组合失败），`unmanaged` 条目单独列出并声明「按原样保留、不在此处编辑」（如 `headers`/`compat`/`modelOverrides`、非本机 `http://`），而不是静静丢掉。
- 已保存的 provider id **输入框只读**（它同时是 safeStorage 的凭据键；改名会静默孤立密钥），删除 provider **不清除凭据**（重新添加同 id 不必重贴密钥）。
- 保存后主动 invalidate `['agent-model-catalog']` 与 `['agent-credential-status']`，所以新 provider 无需重启就出现在上面的凭据列表与默认模型选择器中。

### OAuth 浏览器打开

自动化不能靠渲染层：渲染层没有 `shell`，而且对话框里的链接需要用户自己发现、设备码流程在验证页打开前无法继续。因此浏览器由 **Core 发 `open-external` → Main `shell.openExternal`** 打开（数据流见文档 24 §5）。渲染层仍然用共享的 `ExternalUrlLink` 渲染同一个地址作为回退（被白名单拒绝、无默认浏览器等情况下仍有可点、可复制入口），并把文案写得与实际一致：`已请求用系统浏览器打开授权页面；若未自动打开，请点击下方链接。`

### 认证时序

```
Settings 打开
  ├─ agent.models.catalog ─────────▶ Core: PiModelCatalog.list()        （无凭据）
  ├─ agent.credentials.status ────▶ Main: safeStorage 索引（不含 secret）
  └─ agent.settings.get ──────────▶ Core → repository.getAgentSettings()

保存 API Key
  Renderer ──agent.credentials.save{provider, apiKey}──▶ Main
      Main: safeStorage 写入 v2:provider:<id> ──▶ 返回刷新后的状态列表（不回传 key）

OAuth 登录
  Renderer ──agent.models.login.start{provider}──▶ Main ──▶ Core
      Core: ModelRuntime.login(provider, authType, channel=AuthInteraction)
        ├─ agent-auth{kind:'started'} ──────────────▶ Renderer（所属 Provider 行展开）
        ├─ agent-auth{kind:'auth_url'} ─────────────▶ Renderer（链接 + 提示）
        ├─ agent-auth{kind:'device_code'} ───────────▶ Renderer（设备码 + 验证页链接）
        ├─ agent-auth{kind:'progress'|'info'} ──────▶ Renderer
        ├─ agent-auth{kind:'prompt', promptId, prompt} ▶ Renderer
        │     Renderer ──agent.models.login.answer{loginId, promptId, value}──▶ Core
        │        （promptId 由应用铸造，迟到答案不会喂给下一次登录）
        │        （`select` 不走这条路：auth-flow 自行选定并用 `info` 告知，
        │         否则「点登录」会被第二个选择面板拦住，关掉它就得到空答案）
        ├─ 同一时刻 Core ──open-external{url}──▶ Main ──shell.openExternal──▶ 系统浏览器
        │     （auth_url.url / device_code.verificationUri；Main 用共享白名单再校验一次）
        └─ 凭据写入：Core ──credential-write──▶ Main（safeStorage）──credential-ack──▶ Core
      Core ──agent-auth{kind:'done', status, error?}──▶ Renderer
  回调：pi-ai 自己的 loopback server 接授权码（与 manual_code prompt 竞争）
  取消：agent.models.login.cancel{loginId}（或关闭认证面板）→ reject 挂起的 prompt，
        让 pi 的登录协程真正展开，而不是永久 parked。
  登出：agent.models.logout{provider} → Main 清 vault → **返回刷新后的状态列表**
        （返回 void 会迫使渲染层再请求一次，并可能显示「已配置」的过期状态）
```

认证订阅位于 `IntegrationsSettingsPage` 而不是 `AgentModelSettingsPanel`：切换设置分区不会卸载事件接收器或丢失 prompt。Renderer 保存本窗口发起的 `loginId` 集合，只接受匹配的事件；来自其他窗口、迟到的 `done` 和已取消登录均丢弃。设置页卸载时通过 `loginCancel` 中止 Core 内 Pi coroutine。`prompt` 合同同时携带 Pi 的 `placeholder`，所以 manual-code/secret 输入提示不需要被重新猜测。

鉴权事件通过 `onAuthEvent` 推送到渲染层；Provider 行内认证面板使用 `role="status"` + `aria-live="polite"`，因此 URL、设备码、进度与提示会被读屏播报，而不会静默出现。

## 5. 导航信息架构

一级导航收敛为**每天会用的三项**：`Agent` / `日历` / `任务`；`仪表盘`、`项目空间`、`文献检索`、`Obsidian`、`Zotero`、`定时任务` 收进默认折叠的**研究**分组；`设置` 固定在底部图标位。

- 所有 `ViewId` 与路由保持可达（只做分组，不做功能删除）。
- 折叠状态持久化到 localStorage，沿用既有 `sidebarCollapsedPreference` 模式；分组的 `button[aria-controls="sidebar-research-nav"]` 暴露 `aria-expanded`，键盘与 E2E 都能据此判断并幂等展开。
- `AgentSidebar` 文案去掉「运行时/网关预设」字样。

### 设置页深链

Agent 页面需要把用户送到「模型与 Agent」这一分区。因为 shell 在路由变化时会卸载页面组件，深链用一个一次性模块值而不是路由参数：

```ts
export function openSettingsSection(section: SettingsTab): void { pendingSection = section }
// 消费方：useState(() => { const requested = pendingSection ?? 'general'; pendingSection = null; return requested })
```

调用顺序为 `openSettingsSection('agent')` → `onNavigate?.('settings', false)`；这样避免把参数穿过每一层中间组件。

## 6. 可访问性

- 运行配置入口是 `<button>`（`agent-run-profile-link`），可 Tab 聚焦、Enter 激活；不是伪装成文本的链接。
- Provider 内的认证面板为 `aria-live="polite"` 状态区，进度与设备码无需用户主动查看即可听到；授权链接继续使用 `ExternalUrlLink`，自动打开失败时仍可直接跳转/复制。
- Composer 参照 `pi-web`：空输入框保持单行高度，按内容自动增高至 200px；`/` 命令补全使用绝对定位浮层锚在输入框上方，不再把整个对话区向上顶开。
- 折叠分组的展开状态通过 `aria-expanded` 暴露，E2E 与读屏共用同一真值。
- 流式输出只更新已有记录节点，不重排 run 顺序，避免读屏焦点在长对话中被反复搬移。
- 原有 1440/1080/720/320 响应式溢出扫描与窄屏抽屉语义继续通过。

## 6.1 Provider 密钥、模型发现与聊天魔法命令

自定义 Provider 编辑器不再只有 `models.json` 字段：每个 Provider 行都有 password API Key 输入、保存/清除状态和“发现模型”按钮。Key 走现有 `window.workbench.agent.credentials.save` → Main safeStorage，不进入 models.json、SQLite、prompt 或 ledger。发现结果按 Provider/API 返回为候选项，只有“添加选中模型”再“保存 models.json”才写入，避免探测接口未经用户选择改变默认配置。

Agent 输入框在发送前解析纯本地魔法命令。当前命令为：

- `/provider list`
- `/provider add <id> <api> <baseUrl>`
- `/provider discover <id>`
- `/provider remove <id>`
- `/model list [provider]`
- `/model use <provider>/<modelId>`
- `/key <provider>`（只打开设置安全输入，不接受 Key 参数）
- `/login <provider>`、`/logout <provider>`、`/agent settings`

命令不经过模型。未知命令仍作为自然语言交给 Agent；`/key` 不会把密钥写进聊天记录。Provider/model 默认值保存的是精确 pair，模型选择不会跨 Provider 合并同名 id。

命令结果以**本机反馈卡**渲染在 `ConversationView` 下方（标题：`本机命令 · 未发送给模型`），旁边是普通 run 记录。它刻意不写 SQLite 也不进 ledger：它不是模型输出，也不是 run 的一部分，重启后不应在半年前的对话里出现一个当初只改了本机设置的气泡。

### Agent 输入框的 Provider / 模型选择与 `/` 面板

- 输入框左侧的 provider 下拉**只列已持有凭据的 provider**（`credentialPresent`），第一项固定为 `未配置凭据`；模型下拉在选到有模型的 provider 前 `disabled`，并用 `<optgroup label={api}>` 按 wire API 分组。未配置凭据的 provider 能选的唯一结果就是一次必败的 run，所以不放它进列表。
- 在这里切换模型就是切换**默认模型**（写 `agent.settings`），不是只影响本条消息的临时覆盖：否则页面头部、`/model use` 和下一次 run 会三处不一致。
- 输入 `/` 弹出补全面板（`role=listbox`，最多 11 项，随输入过滤）。面板打开且高亮项与已输入文本不同、且当前文本自身不是完整命令时 `Enter` **接受补全而不发送**；`Tab` 接受、`ArrowUp/Down` 移动、`Escape` 关闭本次编辑的面板。普通 `Enter` 发送、`Shift+Enter` 换行。

## 6.2 研究上下文 MCP 工具

嵌入式 MCP 继续使用 `InMemoryTransport.createLinkedPair()` 和同一个 Workspace dispatcher。除任务、Todo、日历、提醒外，Agent 现在可读取 `literature.search`、`literature.sessions`、`literature.results`、`papers.list`、`notes.list`、`notes.read`、`zotero.capability`、`zotero.collections`、`zotero.items`、`automation.rules.list`、`automation.runs.list` 和 `agent.settings.get`。后两类只返回定时参数、运行状态和非秘密 Agent 默认值，不返回任何 Key/token，也不允许模型修改设置。

外部写入工具是 `zotero.paperToZotero.request`、`literature.stagingToZotero.request`、`notes.write.request`、`notes.metadata.request`；它们只创建待确认动作。`execute`、裸 `notes.write`、裸 `notes.metadata.apply`、删除和文件系统工具仍不在 allowlist 中。文献检索仍由 `LiteratureCoordinator` 执行，Obsidian/Zotero 仍由 IntegrationCoordinator 执行；Agent runtime 不复制连接器逻辑。

`notes.metadata.preview`、`zotero.paperToZotero.preview` 和 `literature.stagingToZotero.preview` 也作为只读预览工具开放：Agent 可以自动完成差异、重复和 revision 预览，但不会获得裸 `notes.write` 或 Zotero execute 工具。

## 6.3 外部写入确认卡片（Wave C）

Agent 想写 Zotero/Obsidian 时调用的是 `.request` 工具（`zotero.paperToZotero.request`、`literature.stagingToZotero.request`、`notes.write.request`、`notes.metadata.request`）。工具只做两件事：**只读地**取一次目标当前状态（Zotero 预览 / Obsidian fingerprint），把结果冻进 `agent_external_actions` 的一行，然后回给模型一段必须转述的话——「尚未写入，需要用户在对话中确认」。模型于是没有「我已经写好了」这种说法可用。

`apps/desktop/src/renderer/src/features/agent/external-actions.tsx` 渲染这些行：

| 元素 | 行为 |
| --- | --- |
| 卡片组 `ExternalActionCards` | 查询 `['agent-external-actions', conversationId]`，`staleTime: 0` + `refetchInterval: 15s`；仅当存在 `pending` 行时启动 15s 计时器刷新剩余时间文案，无 pending 时不起定时器 |
| 状态标签 | `pending` 待确认 / `approved` 执行中 / `rejected` 已拒绝 / `executed` 已写入 / `failed` 写入失败 / `conflict` 外部已变更 / `expired` 已过期 |
| kind 标签 | `zotero-import` → 「写入 Zotero」（路线差异由摘要文案给出：`写入 Zotero（检索暂存）` 或 `写入 Zotero`）、`obsidian-note` → 「写入 Obsidian 笔记」、`obsidian-metadata` → 「更新笔记元数据」 |
| 摘要 | 行内 `summary`：条数、目标连接/集合、格式与传输，或笔记相对路径、字符数与 Vault。只展示脱敏摘要，绝不展示载荷正文 |
| 待确认操作 | `确认写入`（`variant="primary"`）与 `拒绝`（`variant="ghost"`），提交时 `loading`；`approve` 带当前 `revision`，服务端用 CAS 拒绝过期卡片 |
| 终态提示 | `approved` 显示「正在执行…」，`expired` 显示需要让 Agent 重新生成预览；receipt 以 `<details>` 折叠展示 |
| 刷新 | 决策成功后 invalidate `agent-external-actions` / `agent-run-records` / `agent-records`，账本回执立刻出现 |

设计取舍：**run 不会停在 `waiting_confirmation`**。待确认动作的生命周期比 run 长（run 结束于模型的最后一句回复），卡片按会话查询，因此用户可以在任一轮对话之后回来处理；为此没有新增 run 状态，也没有阻塞的审批通道。删除依旧不是 Agent 工具，需要用户在原页面完成独立二次确认。

## 7. 验收证据

已运行并通过：

- `pnpm build`（含 Tailwind/Vite 生产构建；`styles.css` 中删除运行时栏后残留的无选择器声明块已清理，否则 Tailwind 步骤会以 `Missing opening {` 失败）
- `pnpm -r typecheck`
- `pnpm test:e2e`：
  - `agent workspace: ok (no run-config controls, no runtime bar)` —— `select[aria-label="模型"|"思考深度"|"权限模式"]` 计数为 0；`.agent-runtime-bar, .agent-runtime-pill` 计数为 0；正文不含 `Codex`；`.agent-run-profile-link` ≥ 1 且文本含 `Pi`；`.agent-hint-link` 可见
  - `agent composer: ok (gated provider/model select, `/` palette, local command result)` —— `select[aria-label="Agent Provider"]` 与 `select[aria-label="Agent 模型"]` 均存在，无凭据时模型下拉 `disabled`、provider 第一项含 `未配置凭据`；输入 `/` 后面板项 ≥ 5，点 `/help` 把补全写入输入框，`Enter` 渲染出含 `/model use` 的命令结果卡，且 `conversationItems` 为 0（命令确实没发给模型）
  - `settings model section: ok (40 providers, per-provider key round-trip)` —— 每行 `设置 API Key` → 行内 `input[aria-label$="的 API Key"]` 为 `type=password` → 填入探针密钥 → 保存 → 行变为 `清除凭据`、编辑器关闭、页面正文**不含**探针密钥 → `清除凭据` 后回到 `设置 API Key`；正文不含已删除的 `运行时隔离` 说明块
  - `settings custom provider: ok (models.json persisted, 40 → 41 providers)` —— 点预设 → 填模型 id → 保存 → 断言提示文案出现，然后从隔离 profile 读回 `<userData>/data/agent-runtime/pi/models.json`，断言 `api: 'openai-responses'` 与模型 id 已落盘、**条目中不含 `apiKey`**，并以 `waitForFunction` 断言 `.settings-row` 由 40 变 41（目录确实刷新，而不是只改了本地 state）
  - 后续全部既有断言（文献、Zotero、Obsidian、任务、代理设置、定时任务、响应式、长内容滚动）继续通过
- `test:agent-custom-providers` 4/4（自定义 provider 经真实 pi-ai 运行时的组合、认证类型推导、坏文件降级与保存往返，见文档 24 §10）
- `test:agent-ledger-grouping` 4/4（两个 run 各含 turn 0/1 的分组、按 kind 选择记录而非猜测 `recordKey`）
- `test:agent-magic-commands` 3/3（`/provider add` 引号与 URL、`/key` 拒绝第二个参数、未知自然语言不吞、`/` 补全过滤）
- `test:agent-model-discovery-ui` 17/17（四协议发现适配器的请求形状、状态码映射、空模型/无 models 端点/限流/超时、错误正文不含密钥）
- `test:agent-external-actions` 24/24（决策层；见文档 24 §10）
- `test:agent-live` 的 `agent-external-write-guard`：真实模型调用 `notes.write.request` → 卡片所需的 pending 行在数据库中确实出现一条且摘要含目标路径 → 人为 `reject` → 真实 Vault 文件 fingerprint 与正文前后一致

### 注意（E2E 与构建产物）

`scripts/e2e-electron.cjs` 启动的是 `apps/desktop/out/main/index.cjs`，即**构建产物而非源码**。任何 renderer/main/preload 改动都必须先 `pnpm build` 再跑 `pnpm test:e2e`，否则测试跑在旧代码上（本轮曾因此得到两次误导性失败）。

“设置 API Key 点了没反应”类反馈的排查顺序（本轮实际根因在 Main，不在渲染层）：先看行内 `form-feedback` 的原文，再直接读隔离 profile 的 `config/workspace-secrets.json` 验证 key 词汇表（只打印 key 名，不打印值）。根因与修复见文档 24 §5 第 1 条：索引键 `v2:provider-index` 被 vault 自己的读校验拒绝，导致**保存、状态、清除、run 全部失败**，但渲染层的表现只是「无变化」。

## 未验证

- **带真实凭据的两条 prompt 端到端 DOM 断言**（两个 run、每条 prompt 与其回复相邻）：隔离 profile 不持有可用模型凭据，无法产生真实 run。分组逻辑由 `test:agent-ledger-grouping` 单测覆盖，DOM 层需在装有真实 API Key/OAuth 的机器上人工验证。
- **Provider 行内 OAuth 的真实设备码/回调往返**：仅覆盖渲染分支与契约，未做真实 provider 授权；自动开浏览器走的是 Core → Main `open-external`（同一条已被文献外部链接验证过的白名单路径），但没在真实授权流程里观察到浏览器拉起。
- 320px 窄屏下 OAuth 提示文本的视觉换行未逐条截图核对（响应式扫描只断言无水平溢出）。
- **确认卡片没有 DOM 级 E2E**：`pnpm test:e2e` 不持有可用模型凭据，无法产生真实的 pending 行，因此卡片的渲染与点击只由类型检查和人工路径覆盖；`agent-external-write-guard` 验证的是同一批数据（pending 行、摘要、reject 终态），但走的是 preload API 而不是点击。
- **真实外部写入（Zotero `/items` POST、Obsidian 落盘）未被自动执行**：需要 disposable Zotero 库与临时 Vault 的 QA 环境，按计划属 Wave D。当前证据只到「冻结 + 确认 + 拒绝」为止。
