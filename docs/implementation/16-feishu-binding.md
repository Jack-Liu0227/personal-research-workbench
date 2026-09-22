# Task 16：飞书本机扫码绑定（增量 1）

状态：IN_REVIEW（实现完成；typecheck / build / 单测 9/9 / e2e 全绿含新卡片断言；真实扫码+发消息验收取决于用户在开放平台的自建应用配置）

## 目标

把「每日文献推送」的消息通道落地：工作台绑定一个飞书**企业自建应用**（本机 OAuth 扫码绑定，弃用 webhook/GHA 路线），绑定后由应用机器人向绑定账号发消息。凭据（app_secret、user_access_token）只进 Main 的 safeStorage 保险库；渲染层与 Core 只看到状态。本增量只做「绑定 + 测试消息」链路；每日文献推送工作流（增量 2：引擎全网检索 + 矩阵增强 + 中文决策卡 + 定时发送，与写本地知识库的 daily_digest 完全隔离）未开工。

## 架构要点

- 契约：`packages/contracts/src/feishu.ts`（BindingStatus / BeginBindInput+Result / SendTestResult / SaveAppInput，全部 strictObject；`app_secret` 只进保险库，状态对象永不回显）。`WorkspaceApiV2Methods` 追加 `feishu.saveApp/getStatus/beginBind/unbind/sendTest`；`index.ts` 六处接线 + `export * from './feishu.js'`（首个不随 research.js 覆盖的独立契约文件，需显式 re-export）。
- Main：`apps/desktop/src/main/feishu-binding.ts` `FeishuBindingController`——Electron-free 控制器（electron 惰性动态导入，默认 opener 才用），构造器注入 vault / keyOf / port=35231 / openExternal / fetchImpl / now 以便纯 node 单测驱动整个 OAuth 状态机。状态机：saveApp（写 `v2:integration:feishu.app_id|app_secret`）→ beginBind（起 `127.0.0.1:35231/feishu/callback` 本地 HTTP 服务 + 一次性 state（5 分钟过期）+ 系统浏览器打开 authorize 页）→ handleCallback（code→oidc exchange→user_info→双写 user_tokens/profile）→ sendTest/sendText（tenant_access_token bot 身份发 `im/v1/messages`，失败给结构化可修文案）。
- ipc：`RegisterRpcOptions.feishu?`；registerRpcHandler 在 system.* 之后拦截 5 个 feishu.* 方法（trusted-sender 校验 + normalizeMainError 包裹）；`main/index.ts` 构造控制器并以 `keyOf: (id) => credentialKey('integration', id)` 接入。
- preload：`workbenchApi.feishu` 五方法（schema parse + invoke + RpcResponseSchema 校验）。
- Renderer：`features/research/settings.tsx` ConnectorsPanel 顶部新增 FeishuBindingCard（App ID/Secret 表单、保存、扫码绑定、等待轮询 2s、发送测试消息、解绑、一次性 5 步开放平台指引卡）。
- 安全：state 防 CSRF；回调服务器仅监听 127.0.0.1；secret 永不回渲染层；发送失败文案提示需在开放平台补 `im:message` 权限并发布。

## 验收

```powershell
pnpm typecheck
pnpm build
pnpm test:feishu-binding
pnpm test:e2e
```

已执行并全部通过（node v24.19.0 + pnpm 11.5.2）。e2e 新增断言：工具连接面板存在「飞书（每日文献推送）」卡片、状态文案三态之一、含「扫码绑定」「重定向 URL」「35231」——该断言证明 feishu.getStatus RPC 在真实 Electron 里经 preload→Main→safeStorage 完整往返。

## 实现记录

- 契约：`packages/contracts/src/feishu.ts`（新建）、`v2.ts`（5 方法）、`index.ts`（6 处接线 + re-export）。
- Main：`apps/desktop/src/main/feishu-binding.ts`（新建，含 FeishuBindingError）、`ipc.ts`（options.feishu + 拦截 + withFeishu 封装）、`index.ts`（import + 实例注入）。
- Preload：`apps/desktop/src/preload/index.ts`（类型/值导入 + feishu 块）。
- Renderer：`features/research/settings.tsx`（FeishuBindingCard + ConnectorsPanel return 包裹）。
- 测试：`apps/desktop/test/feishu-binding.test.ts` 9 用例（未配置态 / saveApp 不回显 secret / 无凭据 beginBind 拒绝 / authorize URL 与并发拒绝 / 完整回调绑定+保险库双写 / 伪造 state 拒绝 / sendTest 消息体 / sendTest 结构化错误 / unbind 清库停服）；根脚本 `test:feishu-binding`；e2e 卡片断言。
- 补丁工具（交付前清理）：仓库根 `apply-edits.mjs`、`edits-feishu-*.json`（均已应用成功）。
- 坑：Edit 工具对已读大文件仍报 `File has not been read yet` → 全部走 apply-edits.mjs；`z.iso.datetime` 需 zod 4.x（仓库已用）；RpcResponse 是判别联合，取 data 类型用 `Extract<RpcResponse, { ok: true }>['data']`。

## 待用户配置（不可代办，约 5 分钟）

开放平台 → 创建企业自建应用 → 添加机器人能力 → 权限 `im:message` + `contact:user.base:readonly` → 安全设置重定向 URL 填 `http://127.0.0.1:35231/feishu/callback` → 创建版本并发布 → 可用范围含自己。之后在设置 → 工具连接 → 飞书卡片填 App ID/App Secret → 扫码绑定 → 发送测试消息。

## 下一步（增量 2）

`daily_feishu_msg` 工作流：literature-matrix 四源检索 + LiteratureMatrixEntrySchema 注入 + AI 中文摘要/「读不读」决策卡（上限 20 条防刷屏、不做 AI 精选）+ 定时经 FeishuBindingController.sendText 发送，与现有 daily_digest→Obsidian 本地投影管线完全隔离（两条独立规则、两条独立投递通道）。材料：`packages/contracts/src/research.ts`、`packages/database/src/migrations.ts`（builtin schedule seed + workflow CHECK 模式）、`packages/workspace-service/src/daily-literature.ts`（本地投递边界，消息侧新增独立模块）、`.agents/skills/literature-matrix/`。

## 交付后动作

清理仓库根补丁文件：`apply-edits.mjs` 与 `edits-*.json` 在增量 2 收尾时一并删除。
