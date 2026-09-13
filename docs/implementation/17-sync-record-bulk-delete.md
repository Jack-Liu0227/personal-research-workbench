# Task 17 — 设置 → 最近同步（SYNC / RECENT）记录删除

状态：IN_REVIEW（实现完成，聚焦测试 5/5、`pnpm typecheck` 中本任务涉及的 4 个工程全绿、`pnpm build` 等价命令 `electron-vite build` 通过；UI 交互（全选/半选/清除/逐条与批量确认/逐条回执）尚无运行时断言，见文末「未验证」）

## 范围

设置页「最近同步」面板（`eyebrow="SYNC / RECENT"`）的连接同步记录：

- 当前加载范围的全选、半选（`indeterminate`）、清除选择；
- 逐条删除与批量删除，两者都有显示范围/数量的二次确认；
- 逐条回执（成功 / 跳过 / 修订冲突 / 失败）。

不在范围：定时任务 RUN HISTORY（Task 01 另一部分）、其他 UI、`zotero.sqlite`、`.obsidian/`。

## 验收

- 删除前显示范围和数量并二次确认（逐条与批量均如此）。
- 每条删除遵守 revision/CAS；成功、跳过、冲突、失败逐条回执。
- 只软归档同步记录本身：不删除 `sync_runs` 行、不删除 safeStorage 凭据、不删除 `external_links`、不触碰外部系统数据。
- 全选范围文案与列表实际渲染范围一致：不会出现「已选 N」里包含用户看不到、也无法取消勾选的记录。

## 实现记录

1. `packages/contracts/src/research.ts`：`SyncRunSchema` 增加 `revision`（CAS 锁令牌）并补充记录级说明。
2. `packages/contracts/src/index.ts` / `v2.ts`：新增 RPC 及其 payload/result 与 V2 方法白名单
   - `integrations.removeRun`（payload `{ id, expectedRevision }`，返回 `null`）
   - `integrations.bulkRemoveRuns`（payload `ArchiveBulkInput`，返回复用的 `ArchiveBulkResult`）
   - 直接复用已冻结的 `ArchiveBulkLockSchema` / `ArchiveBulkInputSchema` / `ArchiveBulkReceiptSchema` / `ArchiveBulkResultSchema`，不新造第二套回执词汇。
3. `packages/database/src/migrations.ts`（27 `sync_run_archive_and_revision`）：`sync_runs` 增加 `archived_at TEXT` 与 `revision INTEGER NOT NULL DEFAULT 0`（存量行按 0 处理，历史记录继续可见）。
4. `packages/database/src/schema.ts`：同步更新 drizzle 表定义。
5. `packages/database/src/research-repository.ts`
   - `createSyncRun` 写入 `revision: 0`；`updateSyncRun`（含 `completeSyncRun`）每次写入 `revision + 1`，因此「同步进行中完成」会让选择时取的锁失效，批量命令回报修订冲突而不是覆盖。
   - `listSyncRuns` 只返回 `archived_at IS NULL` 的行（归档记录不再出现在列表）。
   - `removeSyncRun(id, expectedRevision)`：单条软归档，`assertRevision` + `WHERE revision = ?` 双保险，冲突抛既有 `REVISION_CONFLICT`。
   - `bulkRemoveSyncRuns(ArchiveBulkInput)`：单个 SQLite 事务内逐条 CAS，`succeeded / skipped / conflict / failed` 与计数由 `archiveBulkResult` 从回执派生，回执文案固定为「同步记录已被更新，请刷新列表后重试。」。
6. `packages/database/src/repository.ts`：暴露 `removeSyncRun` / `bulkRemoveSyncRuns`。
7. `packages/workspace-service/src/dispatcher.ts`：两个新 case，**不接收凭据上下文**（与 `integrations.bulkRemove` 相同的记录级规则）。
8. `apps/desktop/src/preload/index.ts`：`removeRun` / `bulkRemoveRuns` 复解，返回结果用 `ArchiveBulkResultSchema` 校验。Main 走既有 default 直通分支，因此不存在「删记录顺带清掉密钥」的路径（凭据只有 `integrations.remove` 单条路径会由 Main 移除）。
9. `apps/desktop/src/renderer/src/features/research/shared.tsx`：`SyncRunList` 支持可选 `selection`（每行一个复选框）与 `rowAction`，并导出 `describeSyncRun`（同步记录没有名称，用「方向 · 开始时间」作为唯一标签）。原先的 `runs.slice(0, 8)` 移除：列表渲染的正是「当前加载范围」，与全选范围文案完全一致，避免批量删除触及看不到的行。
10. `apps/desktop/src/renderer/src/features/research/settings.tsx`（`ConnectorsPanel` 的 SYNC / RECENT 面板）
    - `SelectionBar`（`aria-label="同步记录批量操作"`，`selection-bar-compact` 适配窄栏）含半选、`清除选择`、`已选 N / M` 计数，范围文案：`全选仅覆盖“设置 → 最近同步”当前加载的 N 条同步记录（无分页、无筛选；不含定时任务 RUN HISTORY）`；空列表时全选禁用。
    - 行级复选框 `aria-label="选择同步记录：<方向 · 时间>"`；行级删除 `aria-label="删除同步记录：<方向 · 时间>"`。
    - 批量删除按钮可访问名 `删除选中的 N 条同步记录`；确认文案给出数量、当前加载总数、逐条标签，并写明只移除本列表记录、不动连接配置/密钥/`external_links`/外部数据。
    - 回执用共享 `ArchiveReceiptList` 渲染；删除后记录已不在列表，故提交时快照标签保证回执可读。
    - 查询返回后对选择集合做 prune，`已选 N` 始终等于命令实际发送的集合。
11. `packages/database/tests/sync-run-bulk-remove.test.ts`（新增）+ `package.json` 的 `test:sync-run-bulk-delete` 脚本：锁定「逐条 CAS 回执 / 不级联 / 不删行 / 重复锁拒绝 / 单条 CAS」五件事。
12. `docs/implementation/README.md`：补登记本任务。

## 删除语义（重要）

- 「删除」= 软归档：`sync_runs.archived_at` 置时间戳 + `revision + 1`，行与 `status/pulled/pushed/conflicts/message` 全部保留（审计账本不丢数据）。
- 批量与逐条路径都**不接收凭据上下文**，都不触碰 `integration_profiles`、`credential_present`、`external_links` 与任何外部系统。
- 运行中的 run 被删除后，Core 的 `completeSyncRun` 仍可写入该行（只是不再出现在列表），不会让正在进行的同步失败。

## 证据

```powershell
pnpm test:sync-run-bulk-delete
  # PASS 5/5：逐条 CAS 回执（succeeded/conflict/skipped + 计数与 items 一致）、
  #   连接记录/凭据/外链/其他 run 不变、重复归档为 skipped 且 revision 只 +1、
  #   重复 id 锁被拒绝且零写入、单条删除 CAS 生效（运行中完成后的旧锁冲突）
pnpm test:connection-bulk-delete
  # PASS 5/5（回归：SyncRunSchema 增加 revision 未破坏既有连接批量删除合同）
npx tsc -p packages/contracts/tsconfig.json --noEmit        # PASS
npx tsc -p packages/database/tsconfig.json --noEmit         # PASS
npx tsc -p apps/desktop/tsconfig.web.json --noEmit          # PASS（settings.tsx / shared.tsx）
npx tsc -p apps/desktop/tsconfig.node.json --noEmit         # 仅剩他人 literature-runtime.ts 的两处 ProjectId 报错（本任务文件无报错）
npx electron-vite build（apps/desktop）                      # PASS：main / preload / renderer 全部构建成功
pnpm typecheck
  # 9/10 工程 PASS；workspace-service FAIL，唯一报错在他人正在编辑的
  # src/literature-runtime.ts(509,599) branded ProjectId（与本任务无关）
```

## 未验证（不得据此标 DONE）

- 无运行时 UI 断言：全选/半选/清除、逐条与批量的 `window.confirm`、回执渲染只有类型与代码证据；仓库当前没有 renderer 级测试框架（无 jsdom/vitest），新增依赖超出本任务范围。
- `scripts/e2e-electron.cjs` 未新增 SYNC / RECENT 断言：e2e profile 中没有同步记录（面板为空），且脚本整体仍停在既有的定时任务目录旧期望上；未运行 `pnpm test:e2e`。
- 未在真实 Notion/Obsidian/Zotero 往返后验证「删除记录不影响外部数据」——该部分由数据库层聚焦测试（不级联断言）与代码路径证明。
- `pnpm typecheck` 全仓未绿的原因在他人文件（`literature-runtime.ts`），本任务未修改、也未擅自修复。

## 未触碰

- `.codex-tasks/` 任务记录、RUN HISTORY / `automation.tsx`、`zotero.sqlite`、`.obsidian/`、任何凭据文件、其他 agent 的未提交修改。

## 附带修复（与本源任务无关，为解除仓库无法解析的阻塞）

`packages/database/src/migrations.ts` 迁移 28 的注释里含有反引号（`` `DEFAULT_AGENT_SCHEDULE_RULES` ``、`` `default-schedules` ``），位于 SQL 模板字符串内部，导致整个 `packages/database`（以及任何 import 它的工程）出现 `ParseError`，仓库当时无法运行任何测试/类型检查。仅把该注释中的反引号去掉（不改变任何 SQL 语义），以便执行本任务验证。迁移 28 属于其他 agent 的在途改动，语义未被改动。
