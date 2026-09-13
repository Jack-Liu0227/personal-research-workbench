# Task 6：Agent 使用、技能和文献上下文

状态：IN_REVIEW（实现链路经代码复核确认，`pnpm typecheck` / `pnpm build` / `pnpm test:e2e` 与聚焦单测 PASS；真实 Codex/Pi 凭据运行未验收，见文末「未验证」）
依赖 Task 1-2

## 目标

让 Agent 首页、运行时设置、技能、文献上下文、账本、Artifact、Inbox 和 MCP 展示同一真实状态。

## 实施步骤

1. Runtime profile 显示真实 version、executable、权限来源、可用性和失败原因；保存时校验权限必须来自 probe。
2. skill 选择与 workflow 解耦；last30days 使用锁定路径，其他 skill 不误注入；skill 缺失必须阻断并提示。
3. Agent 文献上下文只接收选中的 Paper/citation key/abstract/URL/导出文件元数据，不把 Zotero 凭据或全文秘密带入 Renderer。
4. 运行账本展示工具、诊断、Artifact、Inbox 和 Obsidian 推送事件；长 Input/Output 可滚动、复制、脱敏。
5. 清理死的旧 AgentCoordinator/ai-runtime 路径或明确其职责，修正文档中 pi-ai 与 CLI auth 的矛盾描述。
6. 完善 Agent history/Inspector 的窄屏抽屉、reduced-motion 和键盘操作。

## 本次收尾范围（只做收尾，未新增功能）

上一轮 Task 06 的进程在留下改动后被中断。本次没有重新设计，只做三件事：

1. 复核上一轮在 `apps/desktop/src/main/agent-credentials.ts`、`ipc.ts`/`preload`、`packages/contracts/src/agent.ts`、`packages/agent-runtime`、`packages/workspace-service` 留下的改动是否成立（结论：成立，见「安全复核结论」）。
2. 把一处未接线的 hermetic test 接上最窄的运行入口（不改测试内容、不加用例）。
3. 用真实命令与真实状态回写文档。

## 收尾改动

1. `package.json`：新增 `test:agent-credentials`（`node --import jiti/register --test apps/desktop/test/agent-credentials.test.ts`）。
   `apps/desktop/test/agent-credentials.test.ts` 是一个**完整且 hermetic 的测试**（内存 store 替代 safeStorage，不启动 Electron、不读真实 vault、不写凭据文件），但此前没有任何脚本引用它，用 `node --test <file>` 直接跑会因 Node ESM 不把 `../src/main/agent-credentials.js` 回落到 `.ts` 而 `ERR_MODULE_NOT_FOUND`（已复现）。按仓库既有约定（`docs/implementation/05`、`scripts/last30days-*`）用 `jiti/register` 接线即通过。**未删测试、未加用例、未加断言。**
2. 上一轮留下的其余改动经复核**全部保留**，本次未回滚、未重写。

## 安全复核结论（逐条对应验收关注点）

### A. Main safeStorage → Core credential envelope 不把 secret 暴露给 Renderer

- 契约：`AgentCredentialStatusSchema`（`packages/contracts/src/agent.ts:74`）是 `strictObject`，字段只有 `runtime`/`provider`/`credentialPresent`/`envVar`/`updatedAt`——**没有任何 secret 字段**；`preload` 收到后仍用同一 schema 解析（`strictObject` 会拒绝多余键），所以状态投影里混入 secret 会在渲染器入口直接失败。
- 路由：`apps/desktop/src/main/ipc.ts:524-536` 在 Main 内拦截 `agent.credentials.status` / `agent.credentials.save`，直接 `listAgentCredentialStatuses` / `saveAgentCredential`（`agent-credentials.ts`）并把 `AgentCredentialStatus[]` 回给渲染器；Core 侧 `agent-dispatcher.ts` 对这两个方法显式抛 `FEATURE_DISABLED`（「Runtime credentials are handled by the desktop main process」），因此 secret 既不进 Core 也不进任何 `payload`。
- secret 唯一出口：Main→Core 的私有信封 `AgentCredentialEnvelopeSchema`（`packages/contracts/src/agent.ts:662`，`type: 'prw.agent-rpc-with-credential'`）。`ipc.ts:543-556` 用 `resolveAgentCredentials(options.credentialVault)` 取信封内容；`packages/workspace-service/src/host.ts:182` 只在这一条 dispatch 上用 `credentialResolver(envelope.data.credentials)` 解析，`packages/workspace-service/src/agent-coordinator.ts:1013` 的 `runtimeScope` 把它变成 `{ provider, envVar, secret }`，最终只在 `packages/agent-runtime/src/index.ts:241-244` 作为**子进程环境变量**注入本次调用。落库的只有 `credentialSource: 'app-safeStorage' | 'none'` 与非 secret 的 `AgentCredentialStatus`。
- 存储：`agentCredentialStorageKey(runtime)` = `v2:provider:<runtime>`，值以 `{ provider, secret, updatedAt }` 整体写入 Main 的 safeStorage vault（`StoredAgentCredentialSchema` 为 `strictObject`）；损坏/异形/未知 provider 条目按**不存在**处理（`listAgentCredentialStatuses` 返回 `credentialPresent: false`，`resolveAgentCredentials` 丢弃），不会把不可读的密钥报成可用能力。`saveAgentCredential` 对 runtime 未定义 env var 的 provider 抛 `AgentCredentialUnsupportedError` 且**先拒绝后写入**。
- Renderer: `features/agent/index.tsx:559-566` 只渲染状态，密钥输入是 `type="password"` 且从不回显已存值；`清除凭据` 走 `apiKey: null`。

### B. 普通 runtime 不复用 ~/.pi / ~/.codex

- `isolatedRuntimeEnvironment`（`packages/agent-runtime/src/index.ts:546-550`）把 `CODEX_HOME` / `PI_CODING_AGENT_DIR` 指向应用自有 profile 目录；`runtimeScope`（`agent-coordinator.ts:1019-1022`）的 profileDir 恒为 `<runtimeProfileRoot>/<runtime>`，**没有** user home 回落分支（root 为空时返回空 profileDir），且 `CliRuntimeAdapter.start` 在缺少应用自有 profileDir 时直接抛错（`index.ts:252`「no app-owned profile directory」）。
- `safeChildEnvironment`（`index.ts:717-734`）用白名单转发环境变量（Path/SystemRoot/TEMP/APPDATA 等），**不转发** API key、bearer token、cookie 等 Electron 环境凭据。
- 凭据闸门（`agent-coordinator.ts:351-379`）：既没有应用内凭据、`connector.authSource` 也不是应用自有 profile 内的 `cli-login` 时，run 在 CLI 启动**之前**就被建成 `blocked`，错误串带 `AGENT_CREDENTIAL_MISSING`——空 approval 列表不会被当成「成功但未认证的运行」。
- 探针（`index.ts:496-543`）只在应用自有 profile 内调用 CLI 的 `auth check`；应用内凭据存在时报告 `app-safeStorage` 提示语，不声称已验证模型调用。

### C. 未知 skill / 未知 approval 状态不会静默成功

- skill：`resolveAgentSkill`（`packages/workspace-service/src/skill-registry.ts:108-119`）只按 `skillKey` 严格选择；`SUPPORTED_AGENT_SKILL_KEYS` 之外返回 `kind: 'unsupported'`。`agent-coordinator.ts:389-419` 对 `unsupported` 一律建 `blocked` run + `run:skill-diagnostic` ledger + `error: "<message> (<code>)"`，不回落到通用 workflow；普通 run 传 `skillKey: null` 时不会加载 last30days。
- approval：`decideApproval`（`agent-coordinator.ts:699-710`）对未知 id 抛 `NOT_FOUND`而不是返回「已处理」；`AgentApprovalDecisionInputSchema` 是 `strictObject` + `decision: z.enum(['approve','reject'])`，未知决策或多余字段在解析阶段就失败；已被 runtime policy 决定的 id 由 repository 报冲突。写入型 run 的审批审计由 `recordRunApproval` 显式记录（`workspace-write`/`full-access` 记 `auto-approved` 理由），`read-only` 不产生空审批行冒充成功。

## 证据

```powershell
pnpm typecheck   # PASS（10/10 workspace projects，含 packages/contracts、agent-runtime、workspace-service、apps/desktop）
pnpm build       # PASS（out/main/index.cjs 56.12 kB、core-worker.cjs 1,777.24 kB、preload 308.63 kB；renderer assets/index-DaHPBCUz.js 2,043.71 kB、index-O-WeGbs5.css 188.20 kB）
pnpm test:e2e    # PASS（shell/nav 全绿 + agent selectors（Codex options=1, Pi options=1）+ agent conversation/trajectory tabs + literature/Obsidian/project-space/task/proxy/schedule 断言）
pnpm test:agent-credentials
                 # PASS 7/7（agent-credentials.test.ts：未配置 vault、保存后只暴露 provider/envVar、apiKey:null 清除、未定义 env var 的 provider 被拒且未写入、损坏条目按 absent 处理、resolve 每个已配置 runtime 一条、vault key 命名空间）
git diff --check # PASS（无空白错误，仅 CRLF 提示）
```

## 未验证（不得据此标 DONE）

- **真实 Codex/Pi 各跑一次未做**：本环境没有应用内保存的 API key，也没有应用自有 profile 里的 CLI 登录；任务文件要求「真实 Codex/Pi 各运行一次；不读取/复制 auth 文件，不记录 token」，在不能读取 auth 文件的前提下无法在本环境满足，属 BLOCKED。因此 B 项（不复用 `~/.pi`/`~/.codex`）目前只有代码与单测层面的证据，**没有真实进程环境观测**。
- **e2e 没有覆盖 A/B/C 三项**：`scripts/e2e-electron.cjs` 目前只断言 Agent shell、runtime 选择器与 conversation/trajectory tabs，不含「凭据状态不回显 secret」「无凭据 run 被 blocked」「未知 skillKey 被 blocked」「未知 approval id 报 NOT_FOUND」的断言。本次收尾不扩 e2e（超出最小改动），故这些结论目前由代码复核 + 聚焦单测支撑。
- **步骤 3（Agent 文献上下文投影）本轮未复核**：只接收选中 Paper/citation key/abstract/URL/导出文件元数据的边界未在本次逐条确认，也未新增断言。
- **步骤 4、6 本轮未复核**：账本长 Input/Output 的滚动/复制/脱敏属 Task 1/2 交付面；窄屏抽屉、reduced-motion、键盘操作明确归属 Task 8。
- **聚焦单测未被 `pnpm typecheck` 覆盖**：`apps/desktop/tsconfig.node.json` 只 include `electron.vite.config.ts` / `src/main` / `src/preload` / `src/core`，不含 `apps/desktop/test/`，所以 `agent-credentials.test.ts` 的类型正确性只由 `jiti/register` 运行期保证（仓库既有测试目录同样是这个约定）。本次按最小改动未调整 tsconfig。
- **步骤 1、5（runtime profile 真实 version/permission 来源、旧 AgentCoordinator/ai-runtime 死路径清理与 pi-ai/CLI auth 文档矛盾）**：本轮未逐条复核，不计入本次结论。
- 因此本任务状态为 IN_REVIEW，等待 Supervisor 判定；真实 Codex/Pi 凭据运行验收通过后才可考虑 DONE。

## 本次未改动的既有发现

- `apps/desktop/test/` 只有 `agent-credentials.test.ts` 一个文件；`package.json` 的 `test` 脚本仍是「Test suite intentionally removed; use typecheck and build gates.」，只做校验门的仓库约定未变，本次只按既有约定补了一个聚焦入口。
- 未触碰 `zotero.sqlite`、`.obsidian/`、任何凭据文件；e2e 与单测只使用临时目录与内存 store。
