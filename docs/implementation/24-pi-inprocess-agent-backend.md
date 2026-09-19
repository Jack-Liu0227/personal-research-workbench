# 24 · 后端：进程内嵌入 Pi Agent、契约收窄与 Codex 下线

状态：已实现并通过源码门禁与类打包 Electron E2E；真实模型凭据的一次完整 run（真实 provider 网络往返）未在隔离 profile 中验收，见「未验证」。

本任务把 Agent 运行时从「spawn 外部 CLI（codex/pi）」整体替换为**在 Core utility process 内嵌入 `@earendil-works/pi-coding-agent` 的 `AgentSession`**，删除 Codex 的全部代码、契约、适配器、探测与凭据目录，并通过一次性迁移清理 Codex 历史行。同时把模型认证（API Key + OAuth）与运行默认值上移到应用自己的契约与存储边界内。

## 1. 选型、版本与依赖地质

| 项 | 决策 | 理由 |
| --- | --- | --- |
| Pi 接入方式 | npm 发布的 SDK（`@earendil-works/pi-coding-agent`） | 不 vendor、不做 workspace link，避免与本地 `pi/` checkout 产生隐式耦合 |
| 版本 | `pi-coding-agent@0.85.1`、`pi-ai@0.85.1`、`@earendil-works/pi-agent-core@0.85.1` | 全仓单一实例；`packages/ai-runtime` 从 0.84.1 升级（0.85.1 仍从根导出 `createModels`/`createProvider`/`Provider`/`api/lazy`，`provider.ts` 零改动） |
| MCP SDK | `@modelcontextprotocol/sdk@1.30.0` | 进程内 linked transport + 复用 `workspace-mcp` 的 `McpServer` |
| 参数 schema | `typebox@1.3.7`（`agent-runtime`、`apps/desktop` 直接依赖） | pi 的工具参数走 `Type.Unsafe(jsonSchema)` |
| 许可证 | pi-* MIT、MCP SDK MIT、photon-node、jiti、proper-lockfile | 均为宽松许可；无 GPL/AGPL |

`apps/desktop/package.json` 同步声明这三个包：pnpm 严格解析需要它，electron-builder 收集 prod 依赖也需要它，且 `externalizeDepsPlugin` 的 external 判定读取的正是这个文件。

## 2. ESM/CJS 与打包约束

1. Core worker 产物是 `out/main/core-worker.cjs`（CommonJS），而 pi SDK 是 ESM-only 且 `package.json` 的 `exports` 只声明 `import` 条件。
2. `@earendil-works/*`、`@modelcontextprotocol/sdk` 必须保持 external：pi 通过 `photon-node` 加载 wasm、用 `import.meta.url` 解析资源路径、动态 import 主题 JSON。
3. 因此**全仓只有一处动态 import**：`packages/agent-runtime/src/pi/loader.ts` 的 `loadPiSdk()`（以及同一文件的 `loadTypebox()`）。其余代码一律使用**类型导入**。
4. `electron.vite.config.ts` 的 main build 把上述包写入 `rollupOptions.external`；`output.entryFileNames` 为 `[name].cjs`、`format` 为 `cjs`、`dynamicImportInCjs: true`（保留 `import()`，不要改写成 `require()`）。
5. `electron-builder.yml` 的 `asarUnpack` 增加 `node_modules/@earendil-works/**` 与 `node_modules/@silvia-odwyer/photon-node/**`，保证 asar 外的 wasm 与资源可加载。

> `externalizeDepsPlugin` 的 `exclude` 语义是「**打包**、不要 external」。`@prw/*` 与 `@earendil-works/pi-ai` 在 `exclude` 列表内（打进来），其余在 `apps/desktop` prod 依赖里的包默认 external。

## 3. 进程内 MCP 传输（对「复用 stdio server」的唯一偏离）

打包版 `electron-builder.yml` 关闭了 `runAsNode`，安装包内也不带 node 可执行文件，所以 `fork`/`spawn(process.execPath)` 在打包态不可用。Agent 的工具通路因此改为：

- `packages/workspace-mcp/src/server.ts`：工具定义、参数校验、结果封装（外部客户端走 stdio 时复用同一份定义）。
- `packages/workspace-mcp/src/in-process.ts`：`openInProcessWorkspaceSession(dispatch)`，用 `InMemoryTransport.createLinkedPair()` 把 `McpServer` 与 `Client` 在同进程对接；客户端调用最终落到 host 的 `dispatchMessage`，与 stdio 路径走**同一套严格校验**，只是没有 socket 与 token。
- `packages/agent-runtime/src/pi/extension.ts`：把 `client.listTools()` 的每个工具转成 pi 工具（JSON Schema → pi 参数 schema），工具调用直接 `client.callTool({ name, arguments })`。

`workspace-mcp/src/cli.ts` 的 stdio 入口保留给开发与外部 MCP 客户端；Agent 不再走 stdio。该偏离在实施文档与本文件中显式记录。

### 工具面（只读 + 本地写入）

| 类别 | 工具 |
| --- | --- |
| 读/研究预览 | `projects.search`、`tasks.search`、`calendar.list`、`calendar.markers.list`、`literature.search`、`literature.sessions`、`literature.results`、`papers.list`、`notes.list`、`notes.read`、`notes.metadata.preview`、`zotero.capability`、`zotero.collections`、`zotero.items`、`zotero.paperToZotero.preview`、`literature.stagingToZotero.preview`、`automation.runs.list`、`inbox.ai.list` |
| 本地写 | `tasks.create`、`tasks.update`、`tasks.move`、`todos.capture`、`calendar.create`、`calendar.update`、`calendar.markers.create`、`calendar.markers.update` |
| 外部写请求 | `zotero.paperToZotero.request`、`literature.stagingToZotero.request`、`notes.write.request`、`notes.metadata.request`（只创建待确认动作，不执行写入） |
| 会话读 | `agent.conversations.list`、`agent.conversations.messages`、`agent.runs.list`、`agent.runs.get`、`agent.runs.events` |

明确**不暴露**：`tasks.hardDelete`、`bulkHardDelete`、任何 `archive`、以及 `zotero.*`/`obsidian.*`/`notion.*`/`integrations.*`/`literature.*` 写工具。策略常量集中在 `agent-runtime/src/pi/tools.ts`（`workspaceReadTools`、`workspaceWriteTools`、`workspaceExternalRequestTools`、`workspaceBlockedToolPatterns`），并由 `selectWorkspaceTools(profile)` 决定注册集合。

**外部系统没有「写工具」，只有「请求工具」。** `zotero.*.execute`、`notes.write`、`notes.metadata.apply` 一律不注册；模型能调用的只有 `.request` 变体，它们的描述明确写了「尚未写入，需要用户在对话中确认」。这批名字刻意落在 `workspaceBlockedToolPatterns` 之外（正则只匹配 `write|update|create|delete|remove|execute|sync` 结尾的名字），因此 `workspaceExternalRequestTools` 是必须显式登记的一批，而不是被过滤后剩下的。`read-only` 档位下它们同样不注册。

**MCP 名带点，provider 名不允许点。** MCP 工具名可以写成 `tasks.search`，而 OpenAI 一类 provider 对 `tools[0].name` 只接受 `^[a-zA-Z0-9_-]{1,64}$`，带点的名字会以 `400 invalid_request` 在模型看到工具之前让整个请求失败。因此注册给 pi 的名字经 `agentToolName`（`[^a-zA-Z0-9_-] → _`、截断 64、空名回退 `tool`）与 `agentToolNames`（同名冲突加 `_2` 后缀）改写，而 `workspace-mcp` 侧、`callTool` 参数、`details.tool` 与工具错误文本始终是原来的 MCP 名——调用时不需要反向映射。账本由 `PiLedgerNormalizer` 的可选 `toolLabels` 映射回 MCP 名，所以界面显示的仍是 `tasks.search`。

### 内置工具策略

两种 permission mode 都通过 `excludeTools` 剔除文件系统写工具：`bash`、`powershell`、`edit`、`write`、`read`、`grep`、`find`、`ls`。**不使用 `tools: [...]` 允许列表**：允许列表会连带过滤掉扩展注册的工具（pi-web 的实际踩坑），而 `noTools: 'builtin'` 只关内置、保留扩展。用户「直接写入」只指 workbench 记录（任务/日历/提醒），本地写工具因此不需要 `waiting_confirmation`，也不进入审批通道。

## 4. 适配器与事件 → ledger 映射

`PiInProcessAdapter implements AgentRuntimeAdapter`（`packages/agent-runtime/src/pi/adapter.ts`）在 Core 内完成一次 run：

```
start(request)
  → SessionManager.open(runtimeSessionId) | SessionManager.create(runDir, sessionDir)
  → SettingsManager.create(cwd, agentDir)
  → ModelRuntime.create({ credentials: AppCredentialStore })
  → createAgentSessionServices({ cwd, agentDir, settingsManager, modelRuntime, resourceLoaderOptions })
  → createAgentSessionFromServices({ services, sessionManager, model, thinkingLevel, excludeTools, customTools })
  → AgentSessionEvent → EventQueue → PiLedgerNormalizer → AgentRunRecordDraft
```

- `resourceLoaderOptions`：`noExtensions: true`、`noSkills: true`（技能契约文本仍由 coordinator 注入 prompt，沿用既有路径）、`noContextFiles: true`、`noThemes: true`、`extensionFactories: [workbenchExtension]`。
- 能力探测不再执行二进制 `--version`：`capabilities()` 直接返回 `{ kind: 'pi', transport: 'inprocess', available: true, mcp: true, structuredOutput: true, authSource: 'app-safeStorage', profileSource: 'app-isolated', approvalChannel: 'none', workspaceWrite: profile === 'approved-write' }`。
- run 结束后把 pi session 文件路径写回 `agent_conversations.runtime_session_id`，同一会话的下一次 run 用 `SessionManager.open` 续接。

`PiLedgerNormalizer extends BaseLedgerNormalizer` 的事件映射：

| Pi 事件 | 记录 kind | 说明 |
| --- | --- | --- |
| `session` | `system` | 本次运行的 session banner |
| `agent_start` / `agent_settled` | — | 不产生记录 |
| `turn_start` / `turn_end` / `agent_end` | `turn_end` | 携带 `AgentUsage` 与 `durationMs` |
| `message_start`/`message_update`/`message_end`（`role: assistant`） | `assistant` | 增量按 turn 累积到 `outputText`，`text_end` 用快照收口 |
| thinking 增量 | `reasoning` | 独立 ordinal 序列 |
| `tool_execution_start`/`update`/`end` | `tool`（嵌套 `subtool` 用 `parentId`） | 失败工具落 `failed` |
| `compaction_start`/`compaction_end` | `compacted` | |
| `queue_update`/`session_info_changed`/`thinking_level_changed`/`model_select` | `context` | |
| `auto_retry_*`、`summarization_retry_*` | `diagnostic` | |
| `entry_appended` | — | 会话持久化记账，内容已由 message/tool 事件映射，避免重复 |
| 未知事件 | `diagnostic` | `outputText` 带截断后的原始 JSON |

记录键：assistant 为 `pi:msg:<turn>:<ordinal>`、reasoning 为 `pi:think:<turn>:<ordinal>`；`parentId` 引用父记录的 `recordKey`（不是行 id）。role 非 `assistant` 的 message 事件被忽略，因为 coordinator 已把用户 prompt 写成该 run 的 `user` 记录，忽略可避免恢复会话时的历史回放产生重复。

## 5. 凭据边界：CredentialStore / AuthInteraction / 信封

三条不变量：

1. **Main 独占 `safeStorage`。** vault key 为 `v2:provider:<providerId>`，索引键为 `v2:provider-index`；`listAgentCredentialStatuses` 只回传 `{ provider, label, credentialPresent, authType, updatedAt }`，**永不回传 secret**。

   vault 文件（`<userData>/config/workspace-secrets.json`）的读路径会先校验**整个文件**的 key 词汇表，任何不认识的 key 都会让 vault 整体判为不可读并原样保留（防止覆盖用户凭据）。这个严格性只有在「接受本应用写入的每一个 key」时才安全：索引键由 `agent-credentials.ts` 写入，而 `credentials.ts` 早期的模式 `^v2:(integration|provider|engine):` 拒绝了 `v2:provider-index`，因此**保存 API Key 时自己把自己写成不可读**——保存请求失败，之后的每次状态读取、清除、run 也都失败，错误统一是「The encrypted credential store is not readable. It was left unchanged.」。修复是 `isCredentialStoreKey()` 单点登记保留 key（含 index）并由读路径调用；`agent-credentials.test.ts` 用真实 `CredentialVault` + 假加密直接回归该路径（无修复时必失败）。
2. **Core 只做整轮 run 的内存缓存 + 回写。** `AppCredentialStore implements CredentialStore`：`modify` 是唯一写路径、按 provider 串行（`enqueue` 串行链）、写成功后经 `CredentialSink` 回写 Main 并 await `credential-ack`（10 s 超时；超时记 `diagnostic` 并中止该 run，不静默继续）；`delete()` 先 `bridge.persist(providerId, null)` 再丢弃内存项。
3. **`~/.pi`/`~/.codex` 永不读、写、转发。** `loadPiSdk(profileDir)` 在 import 之前用 `isolatedRuntimeEnvironment('pi', profileDir)` 设置 `PI_CODING_AGENT_DIR`，profile 固定为 `<userData>/data/agent-runtime/pi`。pi 的 session JSONL 只是工作态缓存，SQLite 仍是权威投影。

### 凭据信封

```ts
AgentCredentialEnvelopeSchema = {
  type: 'prw.agent-rpc-with-credential',
  request: AgentRpcRequest,
  credentials: [{ provider, credential }]   // 上限 AGENT_CREDENTIAL_ENVELOPE_MAX_ENTRIES = 64，默认 []
}
```

信封上限是**载荷边界，不是产品限制**。它曾经是 `.max(4)`：配置了 5 个以上 provider 的用户，**所有**携带凭据的 RPC（`agent.runs.start`、`agent.models.login.start`、`agent.models.logout`、`agent.connectors.list/test`）都会在 `Main` 的 Zod 校验处失败——用户看到的现象是「点 OAuth 没反应」「跑不起来」，但真正失败的是信封解析。现在上限提到 64（仍是有界载荷），并且 `apps/desktop/src/core/client.ts` 的 `requestAgentWithCredential` 把 `parse` 改成 `safeParse`：校验失败返回一个 typed `invalid request` 响应，而不是在 Main 的 IPC handler 里抛出裸异常。

`agent.models.custom.discover` 是**按 provider 缩小作用域**的凭据方法：Main 只取该 provider 的一条凭据放进信封，既不把别的 provider 的 key 送到被测端点，也不会让每请求信封随 provider 数量增长。

渲染层永远看不到信封；Core 永不持久化它；空列表是**合法且有意义的**请求，会 fail closed（拒绝复用任何 CLI 登录）。

### 自启运行的凭据回读通道（定时 / 启动补跑）

用户点下的 run 由 Main 在 RPC 里附带信封。**定时任务和启动补跑不是 RPC**：`tickSchedules()` 在 Core 自己的定时器里调 `this.start(...)`，没有任何渲染层参与，因此 `resolveCredential` 为 `null`，run 会以 `AGENT_CREDENTIAL_MISSING` 被阻塞——这正是自动化此前完全无法跑通的原因。

修法是 Core 在运行时**按 provider 向 Main 回读一次**，复用已有的 Core → Main 通道（`credential-write` / `open-external` / `agent-ledger` / `agent-auth` 同一条）：

```text
agent-coordinator.startOnce
  → resolveSelectedModel(input)                 // 先知道要打哪个 provider
  → options.requestCredential(provider)
  → host.readCredential  postMessage { type:'credential-read', requestId, provider }
  → main/core/client.handleCredentialRead → setCredentialReader（Main 侧 safeStorage）
  → postMessage { type:'credential-result', requestId, ok, provider?, credential? }
  → host.parseCredentialResult（信任边界，形状不对就丢弃 → fail closed）
  → providerScopedCredential(credential)  → run
```

约束：

- 只允许**按 provider** 读取（`readAgentCredential`）。没有「随便给我一条凭据」的接口，否则一条定时规则就能用它没被指派的 provider 认证。
- 读取结果只服务**一次 run**，不缓存、不落盘、不写 SQLite；vault 始终只在 Main。
- `providerScopedCredential(...).get(name)` 只对凭据自己的 provider 作答，跨 provider 返回 `null`。
- 没有 reader、超时（10s）、provider 缺失、形状非法，全部走 `noAgentCredentials`，保持既有的 fail closed 语义，错误仍是 `AGENT_CREDENTIAL_MISSING`。
- 交互式 RPC 行为不变：信封存在就直接用，不回读；Main 给 run/login 发的是**全部**已配置凭据，因此「信封为空」与「vault 为空」是同一件事，回读不会把被拒绝的 run 变成成功。
- 回归证据：`pnpm test:agent-scheduled-credentials`（7/7，覆盖 provider 作用域、fail closed 源、正常/缺失/非法凭据与错误分支），真实链路证据见 `test:agent-live` 的 `scheduled-run`。

`agent.models.logout` 返回**刷新后的状态列表**而非 `void`：vault 就在 Main，返回空成功会迫使渲染层再发一次请求，而过期列表会在凭据已被清除后仍显示「已配置」。

### 登录编排（AuthInteraction）

pi 拥有登录协程与凭据形状，把「提示怎么渲染、浏览器谁来开」留给宿主。宿主半边在 `packages/workspace-service/src/agent-models.ts`：

- 每个 prompt 由应用铸造 `promptId`，只有匹配的 `agent.models.login.answer` 才解析它 → 迟到的答案不会喂给下一次登录。
- `agent.models.login.cancel`（或关闭对话框）会 reject 挂起的 prompt，从而展开 pi 的协程，而不是让它永久 parked。
- `auth_url`/`device_code` 推给渲染层；`done` 带 `ok`/`error`。`prompt` 事件保留 Pi 的 `placeholder`，避免宿主猜测 callback/manual-code 输入提示。
- **`select` 由宿主自己回答，不出对话框。** 有的 provider 会在登录前问「用浏览器还是设备码」（`openai-codex` 的选项 id 是 `browser`/`device_code`）。两种答案最终都是让宿主打开一个页面，所以这一步不构成需要用户确认的选择；更重要的是它与用户要求的「点登录 → 开浏览器 → 自动回调」冲突，而用户随手关掉的对话框会回一个空字符串，pi 会以 `Unknown OpenAI Codex login method: ` 之类的错误终止整个登录。`preferredSelectAnswer` 在 `packages/agent-runtime/src/pi/auth-flow.ts` 里按 `浏览器 → default/recommended → 第一项` 的优先序自行决定，并用一条 `info` 事件把「已自动选择 X」告诉渲染层；只有选项列表没有任何可用条目时，prompt 才会走到渲染层（那种 prompt 渲染层仍然能回答）。
- OAuth 回调 http server 由 pi-ai 自己拉起（`pi-ai/dist/auth/oauth/*` 内的 loopback server，`manual_code` prompt 与其竞争同一枚授权码），应用不自己监听端口、也不用 pi CLI 的认证。

**浏览器由 Main 打开，且不是渲染层的事。** 渲染层没有 `shell`，而登录流程是 Core 唯一知道「用户必须去访问某个页面」的地方，所以 `host.ts` 的 `publishAuthEvent` 在推送 `agent-auth` 的同时，对 `auth_url`（`event.url`）与 `device_code`（`event.verificationUri`）额外发送 `{ type: 'open-external', url }`；Main 用**同一份** `ExternalOpenUrlSchema` 白名单校验后交给 `shell.openExternal`（`apps/desktop/src/main/index.ts` 的 `coreClient.setExternalOpener`）。

只推给渲染层是不够的：设置页会显示一个需要用户自己点开的链接，而设备码流程在验证页打开前无法继续——这正是此前「OAuth 无法自动打开浏览器」的原因。渲染层仍用共享的 `ExternalUrlLink` 渲染同一个地址，所以**即使系统拒绝打开（无默认浏览器、URL 被白名单拒绝、非 http/https），用户仍有可点、可复制的入口**，并且不会被静默吞掉。

### 自定义 Provider（`models.json`）

用户需要配置 pi 未内置的模型服务（自建网关、公司代理、本地推理、Responses 协议供应商）。实现选择**写 pi 自己的 `models.json`** 而不是发明一套应用私有格式：一个词汇表、手改与界面改等价、文件在其它 pi 客户端里也能用。

**路径：`<userData>/data/agent-runtime/pi/models.json`。** 需求原文是「装在安装目录下」，但 `Program Files` 对普通用户只读、且升级/卸载会被清掉，写入必然失败；`userData` 才是应用可写、随用户配置保留的位置。偏离是显式的：设置页直接显示绝对路径，文件可被外部编辑器打开。

责任五分：

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 契约 | `contracts/src/agent.ts` | `AgentCustomProviderSchema`/`AgentCustomProvidersSchema`/`AgentCustomProvidersSaveInputSchema`；与依赖无关的共享校验 `customProviderIdIssue`、`customProviderUrlIssue`、`AGENT_CUSTOM_PROVIDER_APIS`、`AGENT_CUSTOM_PROVIDER_ID_PATTERN` |
| 文件 | `agent-runtime/src/pi/models-file.ts` | 纯读写 + 合并，**不 import zod**（该包未声明此依赖） |
| 目录 | `agent-runtime/src/pi/models.ts` | `PiModelCatalog.customProviders()` / `saveCustomProviders()`，并把 pi 自己的组合错误合并进 `configError` |
| 服务 | `workspace-service/src/agent-models.ts` | 薄透传 + RPC 挂载 |
| 界面 | `renderer/.../custom-providers.tsx` | 表单 + 预设 + 校验展示 |

共享 helper 放在 `@prw/contracts` 是刻意的：否则读取器与表单会各自判断「这个条目还算不算可编辑」，出现「刚保存就变成 unmanaged」的自相矛盾。

**合并与不可侵入（read-before-every-write）：**

- 每次保存都重新读取磁盘上的当前文件，把**不认识**的条目按原顺序、原内容保留，再写入本次托管集合（因此「删除」是真的删除）。顶层未知键、`headers`/`compat`/`modelOverrides`、`api` 不在四个受支持值内、`baseUrl` 不满足 URL 策略（例如非本机 `http://`）→ 该条目归为 `unmanaged`，只读保留、界面不改写。
- 手改文件仍然可用：pi 的读取器会剥掉 `//` 与 `/* */` 注释与 BOM，所以应用读取器也实现同样的 `stripJsonComments`，否则用户从别处拷来的文件会被报成「损坏」而 pi 加载正常。
- **一个坏条目会让 pi 丢弃整份文件**（`Invalid models.json schema` → 空 Map）。因此写入前逐条校验，且**拒绝覆盖无法解析的文件**（报错并保留原内容），避免把用户的配置换成界面里的部分状态。
- 写入是先写 `<path>.<pid>.tmp` 再 `rename`，不产生半截文件。

**UI 上的两个刻意行为：**

- 已保存的 provider id **只读**。它同时是 safeStorage 的凭据键，改名会静默孤立已存密钥（重命名 = 删除后重加）。
- 删除 provider **不清除凭据**，因此重新加回同一个 id 不必重贴密钥；只有显式「登出/清除」会删掉 secret。

**密钥永不进入 `models.json`**：文件只存端点与模型 id。预设按钮只填 `api` + `baseUrl` + 显示名，**不填任何厂商模型 id**——硬编码的模型名几周就会过期，而错误的 id 会在请求时才以厂商错误暴露。`input: ['text']` 也不写：视觉模型端点需手工添加。

RPC：`agent.models.custom.get`（payload `null`）与 `agent.models.custom.save`（payload `{ providers }`，整体集合 ⇒ 缺席即删除），两者都**不携带凭据**（不在 `AGENT_CREDENTIAL_METHODS` 白名单内），走普通 `requestAgent` 通道。


### 一次性运行时预热

`AgentModelCoordinator.warmup()` 在 host 发出 `ready` 之后立即调用（结果丢弃）。嵌入的 Pi 包很大：首次 `import()` 加上首次 `ModelRuntime` 构造会阻塞 Core 的事件循环数秒，如果放在 `agent.models.catalog` 里执行，第一次打开设置页会像是「页面挂了」。失败被吞掉——真实调用会走正常错误路径。

## 6. 契约与 RPC

`packages/contracts/src/agent.ts`：

- `AgentRuntimeKindSchema` → `z.enum(['pi'])`；`AgentRuntimeTransportSchema` → `['inprocess']`。
- 新增：`AgentCredentialProviderSchema`、`AgentAuthTypeSchema`（`api_key`/`oauth`）、`AgentCredentialStatusSchema`、`AgentCredentialSaveInputSchema`（`apiKey: null` 表示清除）、`AgentModelCatalogEntrySchema`/`AgentModelOptionSchema`、`AgentAuthPromptKindSchema`（`text`/`secret`/`select`/`manual_code`）、`AgentAuthEventSchema`（discriminated union：`started|info|auth_url|device_code|progress|prompt|done`）、`AgentAuthLoginStart|Answer|Cancel|Logout` 输入与 `AgentAuthLoginStartResultSchema`、`AgentSettingsSchema`（单行 global，含 `revision`）、`AgentSettingsSaveInputSchema`。
- 记录投影：`AgentRecordKindSchema` 覆盖 `user|assistant|reasoning|tool|subtool|system|context|diagnostic|compacted|error|turn_end`；`AgentUsageSchema` 为 `{ input, output, think, cacheRead, cacheWrite, total }`（全部 nullable）。
- `WorkbenchAgentApiV1` 新增 `models = { catalog, loginStart, loginAnswer, loginCancel, logout, onAuthEvent }` 与 `settings = { get, save }`。

新增 RPC（`AgentRpcMethodPayloadSchemas` 与 `agent-dispatcher.ts` 同步）：

| 方法 | 说明 |
| --- | --- |
| `agent.models.catalog` | `z.null()` → provider/model/thinking catalog（不需要凭据） |
| `agent.models.login.start` | → `{ loginId }`；流程 detached，进度走 `agent-auth` 推送 |
| `agent.models.login.answer` / `agent.models.login.cancel` | 交互答案 / 取消 |
| `agent.models.logout` | 清空该 provider 并返回刷新后的状态列表 |
| `agent.settings.get` / `agent.settings.save` | 应用级 Agent 默认值（provider/model/thinking/permissionMode/toolProfile/approvalPolicy/responseLanguage），`save` 带 `expectedRevision` |

`agent.credentials.status|save` 由 **Main** 本地应答（密钥不进入渲染层、不进入任何 payload）；`agent.approvals.{list,decide}` 保留为纯审计记录，不再是阻塞通道。

## 7. 数据库迁移与备份

| id | name | 作用 |
| ---: | --- | --- |
| 30 | `remove_codex_agent_runtime` | 按 FK 顺序删除 `runtime='codex'` 的 `agent_runs`（级联 `agent_run_records`/`agent_run_events`/`agent_approvals`）、`agent_conversations`、`agent_connectors`、`agent_bindings`（含 `fallbackRuntime='codex'`）、`agent_proxy_bindings`；`UPDATE schedules SET runtime='pi' WHERE runtime='codex'`（**重指向，不删除**） |
| 31 | `agent_settings_and_runtime_session` | 新建单行 `agent_settings`（`id='global'` 由 CHECK 约束），并 `ALTER TABLE agent_conversations ADD COLUMN runtime_session_id TEXT` |
| 32 | `agent_external_actions` | 新建 `agent_external_actions`：`kind IN ('zotero-import','obsidian-note','obsidian-metadata')`、`status IN ('pending','approved','rejected','executed','failed','conflict','expired')`、`revision`、`preview_id`、`expires_at`、脱敏 `summary`、`error`、`receipt`，并把冻结载荷放在同表的 `payload` 列（一次性消费） |

- **迁移是不可变历史**：既有迁移条目不得编辑，新行为只能进新迁移。
- 数据迁移**不**设置 `disableForeignKeys`（保持 FK 打开，让级联真实执行）。`countCodexRows` 只探测 `agent_runs`/`agent_conversations`/`agent_bindings`/`agent_proxy_bindings`（排除被重指向的 `schedules` 与每次安装都会 seed 的 `agent_connectors`），每个探测都先查 `sqlite_master` 存在性。
- 破坏性保护：`requiresBackup` 为真且确实存在 codex 行时，先备份为同目录 `<db>.pre-v30-codex.bak`；备份前执行 `PRAGMA wal_checkpoint(TRUNCATE)`（WAL 在 `migrateDatabase` 之前已开启）。
- 回滚须知：Codex 行删除不可逆；回滚到备份 DB 时必须同时回滚应用版本（枚举已收窄）。

## 8. Main / IPC / preload

- `apps/desktop/src/main/agent-credentials.ts`：provider-keyed vault（见 §5），`mergeCredentialStatuses` 合并 Core catalog 与 vault 索引。
- `apps/desktop/src/main/ipc.ts`：凭据方法白名单更新为 `agent.runs.start|retry`、`agent.models.login.start`、`agent.models.logout`（这三个需要携带整轮凭据信封）。
- `apps/desktop/src/core/client.ts` 新增 Core→Main 消息：`agent-auth`（转发渲染层）、`credential-write`（写 safeStorage 后回 `credential-ack`）、`open-external`（校验后 `shell.openExternal`）。
- `preload/index.ts`：新增 `agent.models.*`、`agent.settings.*`、`onAuthEvent`；`invokeAgent` 对每个方法的返回都做 Zod 解析。
- 认证事件订阅位于 Settings 容器而非 Provider 面板：切换设置分区不会丢 prompt；Renderer 只接受本窗口持有的 `loginId`，设置页卸载时取消活动 login，迟到或其他窗口事件 fail closed。

IPC 图：

```
Renderer ──window.workbench.agent.*──▶ Preload（校验输入/输出，无通用 ipcRenderer）
   │
   ├─ agent.credentials.* ──────────▶ Main 本地应答（safeStorage，不回传 secret）
   │
   └─ 其余方法 ──▶ Main IPC ──▶ Core utility process
                        │              ├─ 普通方法：dispatchRpc
                        │              └─ 需凭据方法：AgentCredentialEnvelope
                        │
        Core ──▶ PiInProcessAdapter ──▶ AgentSession
                        │                     │
                        │                     └─ MCP 工具 ──▶ InMemoryTransport ──▶ workspace-mcp server ──▶ dispatchMessage
                        │
                        └─▶ Main（agent-auth / credential-write / open-external）──▶ Renderer
```

## 8.5 外部写入：待确认动作层（Wave C）

固定规则是「外部写入必须经 `IntegrationCoordinator`，且不能是模型无确认的无人值守写入」。Agent 因此不直接写 Zotero/Obsidian，而是**先产生一个待确认动作**：

```text
模型 ── MCP notes.write.request ──▶ workspace-mcp server ──▶ dispatchRpc(context: { runId })
                                                     └─▶ AgentExternalActionCoordinator.requestNoteWrite
                                                            ├─ readNote（只读，冻结 fingerprint）
                                                            └─ INSERT agent_external_actions (pending)
用户 ── 对话卡片「确认写入」 ──▶ agent.externalActions.decide
                                    ├─ decideAgentExternalAction（单条受保护 UPDATE：pending → approved）
                                    ├─ Core→Main 回读该 profile 的集成密钥（integration-credential-read）
                                    ├─ 复用 UI 的同一 connector 入口执行（executePaperToZotero / executeStagingToZotero / writeNote / applyNoteMetadata）
                                    └─ settle：executed | conflict | failed + receipt + ledger 记录
```

要点：

- **决策不可由模型触达。** `agent.externalActions.decide` 只挂在 Agent RPC 面上，没有任何 MCP 工具转发它，所以模型拿到工具清单也无法批准自己的请求；因此不需要一次性 approval token 走在线上。`ZoteroImportExecuteInputSchema.confirmationToken` 只是非空字符串，真正的闸门是数据库里那行**由人**写下的决定。
- **两条 Zotero 路线各自冻结。** Paper 选中与检索暂存有不同的预览存储（`zoteroPreviews` / `stagingZoteroPreviews`）和不同的 execute 方法，冻结载荷因此带 `route: 'zotero-import' | 'literature-import'`，批准时按 route 分派，不会拿暂存的 previewId 去打 Paper 的通道。
- **Obsidian 没有服务端预览。** `writeNote`/`applyNoteMetadata` 用调用方传入的 `expectedFingerprint` 做乐观并发，所以动作行自己冻结读取时观察到的 `${mtimeMs}:${size}`；`null` 表示「文件必须不存在」。调用方另外传的 fingerprint 只会更严格（不匹配即在**请求阶段**以 `REVISION_CONFLICT` 拒绝），绝不会用模型给的旧值去覆盖新内容。
- **冲突与失败分开。** `REVISION_CONFLICT`/`EXTERNAL_CONFLICT` 落 `conflict`（外部被人改过，需要重新预览），其余落 `failed`；两者都不报成成功，也都不留下 pending。
- **预览是有寿命的。** 决策窗口 30 分钟，`expire` 只把 `pending` 改成 `expired`（已批准的行不会被回收）；预览本身是进程内的一次性对象，所以应用重启后批准一个旧请求会得到「预览已过期」，这是诚实结果而不是静默重放。
- **密钥只借一次。** MCP 进程内调用不带凭据信封，因此执行前通过 Core→Main 的 `integration-credential-read` 按 profile 回读一次；错误文本经过 `redactSecretValue` 清洗后才入库。

### Core → Main 集成密钥回读

与 §5 的 agent 凭据回读同构，但作用域是**集成 profile**：

```text
host.readIntegrationSecret(parentPort, pendingIntegrationReads, profileId)
  → postMessage { type:'integration-credential-read', requestId, profileId }
  → main/core/client.handleIntegrationCredentialRead → setIntegrationSecretReader（Main 侧 CredentialVault.get(credentialKey('integration', profileId))）
  → postMessage { type:'integration-credential-result', requestId, ok, secret? | error? }
  → host.parseIntegrationCredentialResult（形状不对即丢弃 → 该次执行以失败结算）
```

`profileId` 为空（Obsidian 不需要密钥）时不发消息，直接返回 `null`。Main 侧安装点紧邻 `setExternalOpener`。

### 契约与仓储

- `packages/contracts/src/agent.ts`：`AgentExternalActionSchema`、`AgentExternalActionKindSchema`、`AgentExternalActionStatusSchema`、`AgentExternalActionsInputSchema`、`AgentExternalActionDecideInputSchema`（`expectedRevision` 做 CAS）、`AgentExternalActionRequestResultSchema`；`WorkbenchAgentApiV1.externalActions = { list, decide }`。
- 4 个 RPC（`literature.stagingToZotero.request`、`zotero.paperToZotero.request`、`notes.write.request`、`notes.metadata.request`）同时登记在 `RpcMethodPayloadSchemas`、`RpcMethodResultSchemas` **和** `RpcRequestVariants`——后者的判别联合不会从 schema 表推导出来。
- `packages/database`：`agentExternalActions` 表 + `createAgentExternalAction`、`listAgentExternalActions`、`getAgentExternalActionPayload`、`decideAgentExternalAction`、`settleAgentExternalAction`、`expireAgentExternalActions`。
- `packages/workspace-service/src/agent-external-actions.ts`：协调器依赖一个窄端口 `AgentExternalActionPorts`（8 个方法，由 `host.ts` 绑到 `integrations`/`literature` 上），而不是直接持有两个服务对象——这样「批准时重放的是哪个入口」是可编译检查的，也让这一层可以用桩测试而不必穿过真连接器。

## 8.6 Pi Skill / Extension 资源加载

之前的嵌入适配器把 `noSkills` 与 `noExtensions` 固定为 `true`，导致调度器的 skill registry 虽然能解析 `SKILL.md`，普通 Pi Agent run 却看不到 Pi 的 skill/extension 资源。这已改为受控加载：

- 开发态选中的 skill 只从 `PRW_PROJECT_ROOT/.agents/skills` 下经 registry 校验的目录加载；extension 只从 `PRW_PROJECT_ROOT/.pi/extensions` 加载；
- 打包态选中的 skill 只从 `process.resourcesPath/skills` 下的构建镜像加载；extension 只从 `process.resourcesPath/extensions` 加载；
- 不传入个人 `~/.pi`，不依赖 `agentDir` 的默认资源扫描；
- prompt templates、themes、context files 仍关闭，避免把任意本地上下文无界注入；
- Pi builtin `bash`、`powershell`、`read`、`write`、`edit`、`grep`、`find`、`ls` 仍由 `noTools: 'builtin'` + denylist 关闭；
- Workbench MCP extension 仍是 inline extension，和发现到的受控 extension 一起创建 session。

`controlledPiResourcePaths()` 有开发态/打包态/无锚点回归测试；普通对话不会加载整个 skill 目录，只有 coordinator 明确选择并传入已校验的 `SKILL.md` 才会加载对应目录，避免上下文膨胀和启动变慢。Skill 运行本身仍受 `skill-registry` 的文件、版本、引擎、Python 和输入校验；引擎不可在当前无 shell 的 Agent runtime 内执行时必须 blocked，不得伪造成功。

## 9. 故障模式

| 症状 | 行为 |
| --- | --- |
| 无凭据 / 凭据失效 | run 失败并在 ledger 落可读诊断；不使用任何 CLI 登录回退 |
| `credential-ack` 超时（10 s） | 记 `diagnostic`，中止该 run；不静默继续 |
| 模型连接超时 | `SKILL_ENGINE_UNAVAILABLE_INPROCESS` 诊断，提示在「设置 → 模型与 Agent」配置 |
| pi SDK 加载失败 | `agent.models.catalog` 走正常错误路径，设置页显示可重试错误态 |
| Core 未启动 | `CORE_UNAVAILABLE`（可重试），渲染层不做任何本地降级 |
| 迁移含 codex 行 | 先写 `.pre-v30-codex.bak`，迁移失败则版本号不推进 |
| 外部写请求没有绑定 run | `UNSUPPORTED_CAPABILITY`：请求工具只服务 Agent run，模型无法伪造归属 |
| 待确认动作被批准但预览已消失 | 落 `failed` 并提示重新生成预览；不会「成功」地什么都不做 |
| 批准时外部对象已变更 | 落 `conflict`，保留 pending 之外的终态，不覆盖用户数据 |

### 自定义 Provider 模型发现与密钥路径（本轮补充）

自定义 Provider 现在有独立的 credential-bearing `agent.models.custom.discover` RPC。Renderer 只发送 `{provider, baseUrl, api}`；Main 根据 provider id 从 safeStorage 取单个密钥，再通过私有 envelope 注入 Core，避免把整个凭据 vault（以及第 5 个 Provider 触发 envelope 上限）发送给探测请求。探测器位于 `packages/agent-runtime/src/pi/discovery.ts`，统一使用 `<baseUrl>/models`，按协议使用 Bearer、`x-api-key`/`anthropic-version` 或 `x-goog-api-key`，禁止 query 传 Key，限制超时、响应大小、重定向和错误正文回传。

Settings 的每个自定义 Provider 行现在都有写入 safeStorage 的 API Key 控件、清除控件和“发现模型”按钮。发现结果只存在 Renderer 草稿状态；用户勾选并添加后仍需保存 `models.json` 才落盘。Provider/model 默认选择继续按精确的 `provider/modelId` 解析，不存在时 fail closed，不回退到另一个 Provider 的第一个模型。

验证：`pnpm test:agent-discovery` 4/4，覆盖四协议 header/解析、远程缺 Key、loopback、401、非法 JSON、取消和密钥脱敏；`pnpm test:agent-custom-providers` 4/4；`pnpm -r typecheck`、`pnpm build`、`pnpm test:e2e` 通过。真实厂商网络模型发现仍需在 Windows disposable endpoint 上验收。

## 10. 验收证据

已运行并通过：

- `pnpm -r typecheck`（10 个包全部通过）
- `pnpm build`（含 Tailwind/Vite renderer 生产构建）
- `pnpm test:e2e`（真实 Electron + preload/Core；含 Agent 工作区不再渲染运行配置控件、设置页「模型与 Agent」加载出 40 个 provider、无 codex 运行时控件、导航分组、响应式溢出扫描）
- `test:agent-settings` 7/7（迁移 30/31、`.pre-v30-codex.bak`、`agent_settings` 读写与 revision）
- `pnpm test:agent-runtime-pi` 32/32（`AppCredentialStore` 契约、工具策略、MCP JSON Schema → pi 参数、`PiLedgerNormalizer` 映射、OAuth auth event 映射、`models.json` 读取/合并/写入与注释容忍）
- `test:agent-custom-providers` 4/4（**加载真实 pi-ai 运行时**：`models.json` 条目组合为 provider、`authTypes=['api_key']`、模型与思考等级；坏文件降级为「无覆盖」且报出 pi 自己的 `no "api" specified`；保存→重新读取往返）
- `pnpm test:e2e` 新增断言：设置页用预设新增自定义 provider、填写模型 id、保存，然后**从隔离 profile 读回 `<userData>/data/agent-runtime/pi/models.json`**，断言协议/模型 id 已落盘、文件内**不含 `apiKey`**，且 provider 行数 40 → 41（目录确实刷新）
- `test:agent-credentials` 13/13（provider-keyed vault；含两条真实 vault 文件回归：索引键与凭据共存时仍可读、未知 key 仍判不可读且不覆盖；以及 12 条凭据的信封可通过校验、超过 64 条被拒）
- `pnpm test:e2e` 新增断言：设置页每个 provider 行自带内联密码输入（`设置 API Key` → 密码框 → 保存 → 行变为 `已配置`/`清除凭据` → 清除后回到未配置），且密钥从不回显到页面；页面不再渲染已删除的 `运行时隔离` 说明块
- `test:agent-login` 2/2（**加载真实 pi-ai OAuth 实现**：每个 OAuth provider 要么给出 https 授权目的地（device code 带非空 userCode），要么报出真实传输失败，绝不静默超时；api-key provider 走 prompt 而不是 URL）
- `test:agent-magic-commands` 3/3（`/provider add` 引号 URL、`/key` 拒绝第二个参数、未知自然语言不吞噬、`/` 补全过滤）
- `test:agent-history-delete` 6/6、`test:automation-run-history-delete` 5/5、`test:default-schedules` 6/6
- `pnpm test:agent-external-actions` 24/24：仓储层（单次决策、revision CAS、过期、随 run 级联删除）+ 服务层（请求阶段不写任何外部数据、两条 Zotero 路线不串、Obsidian fingerprint 冻结与冲突、ENOENT 视为新建、拒绝不触达端口、冲突/失败分流、载荷丢失时诚实失败、密钥脱敏、账本回执、窗口外不提前过期）
- `pnpm test:workspace-mcp-agent-surface` 4/4：`.request` 是外部系统在本工具面上的唯一写动词，`execute`/`notes.write`/审批方法均不在列表里
- `pnpm test:agent-runtime-pi` 51/51：`read-only` 档位不注册请求工具，且注册面里没有任何 `.execute`/`.apply`/`.delete`/`.remove`/`.sync` 结尾的名字
- `test:agent-live` 新增 `agent-external-write-guard`：真实模型调用 `notes.write.request` → 真实 Vault 读取并冻结 fingerprint → 数据库出现 1 条 pending → 人为 `reject` → 复查该文件 fingerprint 与正文完全不变（**批准路径未被自动执行**）

## 未验证

- **真实 provider 的一次完整 run**（真实网络往返 + 真实 API Key/OAuth）：隔离 profile 不持有可用凭据，因此 E2E 只覆盖「不渲染运行配置控件 + 设置页可达」的契约，未覆盖真实流式回复与工具落库。需要在装有真实凭据的机器上手动验证：登录 → 发一条 prompt → 确认 SQLite 出现 `user/assistant/tool/turn_end` 记录、`agent_conversations.runtime_session_id` 被写回、且工具调用产生真实 task/calendar 行。
- **打包态 asar 外的 wasm/资源加载**：`asarUnpack` 已配置，但尚未在真实 Windows x64 NSIS 安装包中做冒烟（按 `windows-release` skill 执行）。
- **OAuth 回调与自动开浏览器在打包态的端到端验证**：`auth_url`/`device_code` → Core 发 `open-external` → Main `shell.openExternal` → 浏览器完成回调 → 凭据回写 safeStorage 的完整链路**仅做了代码路径审查**，没有用真实 provider 跑过（需要真实客户端 id 与授权交互）。已验证的部分：渲染层不再依赖用户手点链接（自动开），且同一地址仍有可点、可复制的 `ExternalUrlLink` 兼顾回退。端口与回调 server 由 pi-ai 在 Core 内自建。
- 预热带来的 Core 启动 CPU/内存占用未做量化基准（本机冷加载约 11–12 s 一次性开销）。
