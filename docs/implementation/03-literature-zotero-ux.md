# Task 3：文献检索与 Zotero UX/Collection 修复

状态：IN_REVIEW（实现完成并通过 `pnpm typecheck` / `pnpm build` / `pnpm test:e2e`；真实 Zotero 9/10 端到端验收 BLOCKED，见文末）
依赖 Task 1-2

## 目标

让文献检索、待分类和 Zotero 写入的 preview/confirm/receipt 语义、滚动、帮助和 Collection 行为一致。

## 实施步骤

1. 用明确的 `CircleHelp` 图标替换 `?`；实现可见 popover/dialog、键盘关闭、焦点管理和可访问名称。
2. 将 Inspector 内容区设为唯一滚动容器；导入预览和操作按钮采用 sticky footer；生成预览后自动聚焦预览标题/确认按钮并播报状态。
3. 根据 capability 显示：Zotero 9/只读为“仅支持读取”，按钮为“生成 RIS/BibTeX 导入包”；只有 write capability 才显示“确认写入 Zotero”。
4. 修复已有 item 更新：明确 `targetCollectionKey` 的语义；若用户选择 Collection，PATCH 必须写入该 key；空值行为必须在 preview 中说明，不得悄悄恢复旧值。
5. Preview 冻结 profile revision、targetCollectionKey、transport、format、tags 和 item matching；执行再次 probe/revision check，回执显示实际 outcome。
6. DOI/URL/稳定 external ID 匹配与 metadata PATCH 补齐；不覆盖用户非托管字段；后续 child note 单独建立合同和验收。
7. 无效 tabs（笔记/相关文献）实现真实内容，或明确禁用并说明未实现，不保留假交互。

## 实现记录

1. 帮助入口：`literature.tsx` 新增 `LiteratureHelpDialog`，复用已有 Radix `Dialog`（`components/ui.tsx`，未新增依赖，仓库内无 popover 包）。触发器是 `aria-label="文献检索帮助"` 的 `CircleHelp` 图标按钮，`DialogContent` 的 `title` 提供对话框可访问名；内容覆盖检索、结果操作、待分类、Zotero 导入（“探测能力 → 生成预览 → 明确确认 → 逐条回执”）、只读连接和键盘说明；Esc 关闭后焦点回到触发器（e2e 断言）。
2. Inspector 滚动：面板改为 `display:flex; flex-direction:column; overflow:hidden`，内容区 `.literature-inspector-scroll`（`min-height:0; flex:1 1 auto; overflow-y:auto`）是唯一滚动容器，`.literature-inspector-footer` 固定承载预览摘要与「取消 / 确认」按钮。生成预览后 `useEffect` 聚焦确认按钮，`role="status"` 的 sr-only live region 播报状态。
3. capability 驱动命名：新增共享模块 `apps/desktop/src/renderer/src/lib/zotero-write.ts`，`zoteroWritePlan(probing, canWrite)` 返回 `checking | write | read-only`，并集中 `prepareLabels`（准备导入预览 / 准备 Zotero 导入 / 准备 RIS/BibTeX 导入包）、`confirmLabels`（确认并生成导入预览 / 确认并写入 Zotero / 确认并生成 RIS/BibTeX 导入包）、`writeBlockedExplanation`、`collectionWriteLabel`，文献页与 Zotero 页共用避免文案分叉。未探测出 write capability 时不渲染任何“确认并写入 Zotero”按钮（e2e 断言其 count 为 0）；只读原因由 contracts 的 `ZoteroWriteBlockedReasonSchema`（`server-id-missing` / `credential-missing` / `probe-failed`）承载，经 `AdapterProbe.writeBlockedReason` → `ZoteroCapabilityStatus.writeBlockedReason` 传到 UI 的 `.write-blocked-note` 说明（未配置 profile 时提示“设置 → 工具连接”）。
4. Collection 写入：`ProjectionTarget.collectionKey` 贯穿预览（preview 项与冻结目标）→ 执行（`writeZoteroProjection`）→ 回执。PATCH body 仅在 `collectionKey` 非空时携带 `collections: [key]`；空/未选择时**不发送** `collections`，保留远端既有成员关系，不再用本地缓存的旧 `collections` 回写。回执新增 `targetCollectionKey` 与 `collectionWrite ∈ {set, unchanged, not-written}`，UI 逐条显示实际结果。preview 面板显式说明目标 Collection 与“不会改动现有成员关系”。
5. 冻结与 CAS：预览冻结 `profileRevision`、`transport`、`targetCollectionKey`、`format`、`tags`、每条 `remoteRevision` 与匹配决策；执行前先比对 profile revision，再逐条比对 item revision，缺失或变化即 `REVISION_CONFLICT`，不做半途写入。回执携带实际 `remoteRevision`。
6. 匹配与 metadata 补齐：`ZoteroDuplicateMatchSchema.kind` 增加 `'url'`；仅 `to-zotero` 且 `transport === 'api'` 时做有界远端扫描（5 页 × 100 条），DOI/URL 精确命中 → `update-candidate`，仅标题命中 → 新建并附 `note`（提示无法确认是否重复），扫描不完整 → `review`，执行阶段按 `outcome:'skipped'`（`UNSUPPORTED_CAPABILITY`）如实回执而不是猜写。PATCH 只补齐远端为空的托管字段（`title/url/publicationTitle/date/DOI/abstractNote`），非空用户字段一律不覆盖；tags 采用并集（`mergeZoteroTags`，幂等），`extra` 仍走 `upsertManagedExtra` 托管区块。
7. tabs：笔记 / 相关文献改为 `disabled` 且文案标注「尚未实现」，移除假 `role="tablist"`，并加 `.literature-inspector-tab:disabled` 样式。

## 证据

```powershell
pnpm typecheck   # PASS（10/10 workspace projects）
pnpm build       # PASS（renderer index-*.js 1987.36 kB，index-*.css 183.10 kB）
pnpm test:e2e    # PASS（含新增 literature help dialog / literature Inspector live preview 断言）
```

- `node --import jiti/register --test packages/connectors/test/zotero.test.ts`：新增 4 个用例全绿——probe 只读原因（`server-id-missing` / `credential-missing` / 无阻断 / `probe-failed`）、tags 并集 + 只补空 metadata（非空 `title/url/publicationTitle/date` 不出现在 PATCH body）、写入指定 Collection 且忽略空白 key、revision 不匹配时抛 `REVISION_CONFLICT` 且不发 PATCH。
- `node --import jiti/register --test packages/workspace-service/tests/literature-runtime.test.ts`：3/3 PASS，覆盖 `profileRevision` 冻结、`note`、`targetCollectionKey` / `collectionWrite` 回执。
- `node --import jiti/register --test packages/database/tests/literature-staging.test.ts`：4/4 PASS（staging 持久化未受 contract 变更影响）。
- e2e 断言：`未确认前不会触发 Zotero 外部写入` 存在；`准备…` 动作存在而 `确认并写入 Zotero` / `确认并生成 RIS/BibTeX 导入包` 在无预览时为 0；帮助对话框可打开（可访问名）、内容含“探测能力 → 生成预览 → 明确确认 → 逐条回执”、Esc 关闭后焦点回到触发器。

## 已知遗留（未在本次范围修复）

- `packages/connectors/test/zotero.test.ts` 中两个用例为**既有基线失败**（在 HEAD 版本的源码与测试文件下同样失败）：`malformed remote item payload is a redacted structured IntegrationError`（`pullZotero` 未按预期拒绝畸形 payload）与 `Better BibTeX bridge ...`（BBT `item.export` 的 `params` 形状与断言不一致）。本次未改动这两条路径。
- `zotero.tsx` 的 Paper → Zotero 导出面板仍是不可达死代码（renderer 中无任何 `paperToZotero.preview` 调用，`paperPreviewMutation` / `paperIds` 从无触发），本次只同步其文案与回执展示，未扩建入口（记录在 PROGRESS.md 审计结论 7）。

## 未验证（BLOCKED，不得计入 DONE）

- 真实 Zotero 9 只读 fallback：无非 loopback / 缺少 `Zotero-Server-ID` 的真机环境，只读路径仅由 stubbed fetch 单测与无 Zotero profile 的 Electron e2e 覆盖。
- 支持写授权版本的端到端验收：真实新建 / 更新 item、选择不同 Collection 后逐条核对实际 Collection 归属、真实 revision conflict 与逐条回执，均在真实 Zotero 9/10 + API key 环境完成前为 BLOCKED。
- 因此本任务状态保持 IN_REVIEW，不得标记 DONE。
