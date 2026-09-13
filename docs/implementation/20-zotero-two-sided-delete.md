# Zotero 两侧删除（2026-09-13）

账本：`.codex-tasks/20260913-workbench-followups-3/`

## 已实现范围

- 远程合同来自 Zotero 官方 Local API 源码（`server_localAPI.js`），不是猜测：
  - `DELETE <library>/items/<itemKey>`，必须带 `Zotero-Server-ID` 握手与 `If-Unmodified-Since-Version` 前置条件。
  - 缺失或非法前置条件 → `428`；冻结版本已过期 → `412`；条目不存在 → `404`；成功 → `204`（并返回 `Last-Modified-Version`）。
  - 本地服务执行的是 `obj.eraseTx()`，即**永久删除**（不是回收站）。只有 `deleted`/`absent` 才允许回执声称远端已消失。
- `packages/connectors/src/zotero.ts`
  - `deleteZoteroRemoteItems(profile, targets, fetcher)`：1..100 条、key/revision 非空校验、`assertWritableLocalKey` 前置、逐条**串行**删除，单项传输异常记为该 key 的 `unavailable` 而不中断整批。
  - `deleteOneZoteroItem(...)`：`204/200 → deleted`、`404 → absent`、`412/428 → conflict`、`401 → unauthorized`、`403 → forbidden`、`429 → rate-limited`（解析 `Retry-After`）、其余 → `unavailable`。
  - `readZoteroRemoteItems(profile, itemKeys, fetcher)`：preview 阶段逐条读取真实 `version` 与 `title`；读不到的 key 进入 `unavailable`（含原因），不会被静默丢弃。
  - `zoteroDeleteRemovedRemotely(status)`：只有 `deleted`/`absent` 视为远端已消失。
- `packages/contracts/src/v2.ts`
  - `zotero.deleteRemote.preview` / `zotero.deleteRemote.execute` 两个 typed RPC，替换旧的 `zotero.requestRemoteDelete` 阻断回执。
  - preview 返回 `profileRevision`、冻结 `targets`、`unavailable`、`writeBlockedReason`；execute 要求 `expectedProfileRevision`、`targets` 与 `confirmed: z.literal(true)`。
  - `ZoteroRemoteDeleteReceiptSchema.superRefine`：计数必须等于逐条行；`local: 'removed'` 必须有 `deleted`/`absent` 支撑；`completed` 不能残留远端条目；`blocked` 不得报告任何删除。
- `packages/database/src/research-repository.ts`
  - `findExternalPaperLink(profileId, externalId)`、`removeExternalPaperProjection({ profileId, externalId })`：单事务内归档 `Paper`（`status: 'archived'`、`archivedAt`、`revision + 1`）并删除匹配的 `external_links` 行；不删除项目、矩阵条目、产物或历史，返回 `{ paperId, archivedPaperId, linksRemoved }`。
- `packages/workspace-service/src/integration-runtime.ts`
  - `previewZoteroRemoteDelete(input, secret)`：校验 provider/enabled → capability probe → 读取真实远端 revision → 解析本地投影（`paperId`/`title`/`localRevision`）；写权限不足时仍返回 `targets` 与 `writeBlockedReason`（入口保持可见），并在 message 中明确“本次不会向 Zotero 发送删除请求”。
  - `executeZoteroRemoteDelete(input, secret)`：profile revision 不匹配 → `REVISION_CONFLICT`（不发送任何请求）；写能力不足 → `status: 'blocked'` 回执（全部 `local: 'kept'`）；否则先删远端，`deleted`/`absent` 才调用 `removeExternalPaperProjection`，其余保留本地并在 message 追加“本地记录未删除。”；汇总 `completed`/`partial`/`blocked`。
  - 密钥由 dispatcher 以第二个参数注入（`credential?.secret ?? null`），仍只存在于 Main/Core。
- `apps/desktop/src/preload/index.ts`、`apps/desktop/src/main/ipc.ts`：`zotero.deleteRemote.preview/execute` 的 schema 校验与凭据注入；Renderer 不接触密钥。
- `apps/desktop/src/renderer/src/lib/zotero-write.ts`
  - `remoteDeleteLabels`（`entry`/`entryHint`/`preview`/`confirm`）如实描述永久删除、本地归档（不是删除）与失败保留。
  - `REMOTE_DELETE_STATUS_LABELS`、`remoteDeleteReceiptSummary`、`remoteDeleteReceiptRows`（逐条返回 `{ key, outcome, detail }`）。
- `apps/desktop/src/renderer/src/features/zotero.tsx`：选择条目 → `deleteRemote.preview` → 用真实冻结信息二次确认 → `deleteRemote.execute`；逐条展示 Zotero 与本地两侧结果。

## 安全边界

- 远端优先：只有 Zotero 确认 `deleted` 或明确 `404 absent` 才删除本地投影；冲突、无权限、无持久 key、网络失败一律保留本地并标记可重试。
- 本机（loopback）删除复用写路径闸口：只有 Zotero 授权弹窗「始终允许」得到的 `remember === true` key 才允许发起删除；一次性或模式未知的 key 在任何 DELETE 之前就被阻断。
- 不直接读写 `zotero.sqlite`、不暴露凭据、不伪造远端成功；preview 与 execute 都不会在无人确认的情况下运行。

## 自动化验证

- `pnpm typecheck`：PASS（含 `@prw/connectors`、`@prw/workspace-service`、`@prw/desktop`）。
- `pnpm build`：PASS。
- `pnpm test:e2e`：PASS（含 Zotero 删除入口文案断言：不得再出现“没有实现 Zotero Local/Web API 的条目删除”）。
- `pnpm test:zotero-connector`：19/19 PASS（含每条 DELETE 的 URL/方法与 `If-Unmodified-Since-Version`/`Zotero-Server-ID` 头、`204/404/412/401/403/429/500` 映射、一次性 key 阻断零请求、传输异常、`readZoteroRemoteItems` 的 items/unavailable 拆分）。
- `pnpm test:zotero-write`：20/20 PASS（含新文案、completed/partial 回执计数、schema 反例）。
- `pnpm test:zotero-delete`：7/7 PASS（真实 SQLite + 假 Zotero Local API：preview 冻结版本与本地投影、`key-single-use` 仍可见、空选择拒绝、`REVISION_CONFLICT` 零请求、`204` 后归档 Paper 并删链接、`412` 保留本地、`404` 视为已消失）。
- `pnpm test:dashboard-push` 8/8、`pnpm test:calendar-daily-push` 4/4、`pnpm test:literature-zotero` 6/6、`pnpm test:agent-history-delete` 6/6：PASS。

## 未验收（保持 IN_REVIEW / BLOCKED）

- 真实 Zotero 10 上的授权 round-trip（「始终允许」）与真实远程删除 round-trip；本机 `localAPIKeys.json` 当前为 `{"keys": []}`，持久 key 需要用户重新授权后才能做真实 DELETE 验收。
- Zotero 9 的只读/no-write 行为在本机无法回归（本机为 10.0.2）。
- 删除后 Zotero 客户端界面与同步状态的人工确认。
