# Task 04 — 工具连接记录批量删除

状态：IN_REVIEW（最小收尾完成，`pnpm typecheck` / `pnpm build` 通过，聚焦测试 5/5 通过；e2e 在本任务新增的「连接记录批量删除栏」断言处通过、但整体仍停在既有的定时任务目录旧期望上；带真实连接记录的行级全选/半选/批量提交未在 e2e 覆盖，见文末「未验证」）

## 范围

设置页工具连接记录增加当前筛选范围的全选、半选、清除、逐条删除和批量删除。

## 验收

- 删除前显示范围和数量并二次确认。
- 每条删除遵守 revision/CAS，成功、跳过、冲突、失败逐条回执。
- 不删除 safeStorage 中的 secret，只删除连接记录。

## 实现记录（本轮最小收尾）

本轮以「接管半成品、只接线不重新设计」为原则。收尾前的实际状态：

- 合同/服务端链路已经存在且完整：`ArchiveBulkLockSchema` / `ArchiveBulkInputSchema` / `ArchiveBulkReceiptSchema` / `ArchiveBulkResultSchema`（`packages/contracts/src/research.ts`）、RPC `integrations.bulkRemove` 与 `integrations.remove`（`contracts/src/index.ts`、`contracts/src/v2.ts` 的 legacy 路由表）、preload 复解（`apps/desktop/src/preload/index.ts`）、dispatcher（`workspace-service/src/dispatcher.ts`）、仓库实现 `bulkRemoveIntegrationProfiles` / `removeIntegrationProfile`（`packages/database/src/research-repository.ts`）。
- 断开的接线：`components/selection.tsx` 里的 `ArchiveReceiptList`（逐条回执渲染器）**没有任何调用方**，`features/research/settings.tsx` 的 `ConnectorsPanel`（设置 → 工具连接）**完全没有选择控件、没有逐条删除、也没有批量删除入口**，因此合同里已经冻结的批量删除在产品里不可达。
- 父 agent 已恢复的 `research-repository.ts` `removeSchedule` / `bulkArchiveSchedules` 事务收尾本轮复核无损坏：文件以 `}` 正常结束、`ScheduleOccurrenceSchema` 投影修复仍在、`pnpm typecheck` 全绿。

本轮改动（最小修复，未扩展范围）：

1. `apps/desktop/src/renderer/src/features/research/settings.tsx`（`ConnectorsPanel`）接入共享选择控件与合同：
   - 行首 `SelectionCheckbox`（`aria-label="选择连接：<名称>"`），`SelectionBar`（`aria-label="连接记录批量操作"`）强制范围文案 `全选仅覆盖“设置 → 工具连接”当前列表的 N 条连接记录（不含已归档；本列表无分页、无筛选）`，含半选、`清除选择`、`已选 N / M` 计数与空列表 `disabled`。
   - `批量删除`（按钮可访问名 `删除选中的 N 条连接记录`）：`window.confirm` 先显示本条命令的范围与数量（`将删除选中的 N 条连接记录（当前列表共 M 条）：名称…`），并写明只删除连接记录本身、不动 secret / 同步记录 / 外部系统；随后提交 `{ items: [{ id, expectedRevision }] }`（`expectedRevision` 取自当前列表最新 revision），成功后用 `ArchiveReceiptList` 渲染逐条回执（成功/跳过/修订冲突/失败）并失效查询。
   - `逐条删除`（`aria-label="删除连接：<名称>"`）：确认后走既有 Main 归属路径 `integrations.remove(id, revision)`；该路径在 Core 归档成功后由主进程删除属于该连接的 safeStorage 凭据，确认文案如实写明（与批量路径的差别见下）。
   - 查询返回后对选择集合做 prune：`integrations.list` 只返回未归档记录，消失的记录不会继续计入计数，`已选 N` 永远等于批量命令实际发送的集合（无变化时返回同一 Set 引用，避免 effect 自激）。
   - 回执里的名称在删除后无法再从列表取到，故提交时快照名称，保证回执可读。
2. `packages/database/tests/connection-bulk-remove.test.ts`（新增）+ `package.json` 的 `test:connection-bulk-delete` 脚本：聚焦锁定 CAS/回执/不级联三件事。
3. `scripts/e2e-electron.cjs`：在既有「设置 → 知识引擎」断言之后新增「设置 → 工具连接」断言（选择栏存在、范围文案含 `全选仅覆盖` 与 `本列表无分页、无筛选`、计数存在；列表为空时全选与批量按钮必须 disabled；有记录时必须每条都有复选框与逐条删除按钮）。
4. 文档：本文件、`docs/implementation/README.md`（第二批任务状态）、`.codex-tasks/20260913-zotero-daily-push/TODO.csv` 与 `PROGRESS.md`。

### 删除语义（重要，与最初文档措辞的差异）

实现与合同注释一致，按此收尾并如实记录：

- **批量删除**（本任务主题）：只把锁定的连接**记录**软归档（`archived_at` + `enabled=false` + `status='disabled'` + `revision+1`），**不删除** safeStorage 凭据，**不级联**同步记录 `sync_runs`、外链索引 `external_links`，也不触碰 Obsidian Vault 与 Zotero 数据库。RPC `integrations.bulkRemove` 不在 Main 的凭据拦截分支里，因此不存在「批量删除顺带清掉密钥」的路径。
- **逐条删除**：沿用既有 Main 归属路径 `integrations.remove`，Core 归档成功后由主进程删除该连接的 safeStorage 凭据。原文档「不删除 safeStorage 中的 secret」按**批量路径**执行；逐条路径的凭据移除是既有设计（`research-repository.ts` 的实现注释亦明确区分），UI 确认文案已如实说明，避免用户误以为批量与逐条等价。
- 原文档「只删除连接记录和关联索引」一句与合同的记录级归档注释不一致：合同注释、仓库注释与本轮聚焦测试（断言 `sync_runs` / `external_links` 保留）都表明**关联索引不被删除**。本轮不改实现，按已冻结的合同语义执行并在文档更正措辞。

## 证据

```powershell
pnpm typecheck    # PASS（10/10 workspace projects）
pnpm build        # PASS（renderer index-*.js 2,076.75 kB / index-*.css 193.69 kB）
pnpm test:connection-bulk-delete
                  # PASS 5/5：逐条 CAS 回执（succeeded/conflict/skipped + 计数与 items 一致）、
                  #   重复锁为 skipped 且 revision 只 +1、归档不级联 sync_runs/external_links 且
                  #   credential_present 保持、重复 id 锁被拒绝且零写入、单条删除仍强制 CAS
pnpm test:e2e     # 本任务新增断言 `connection bulk delete bar: ok` PASS（范围文案/计数/空列表 disabled）；
                  #   脚本随后仍 FAIL 于既有 `scripts/e2e-electron.cjs` 定时任务目录旧期望
                  #   （`每日文献推送` vs 已冻结的 `每日资讯推送`，Task 05/06 范围，未改断言）
```

## 未验证（不得据此标 DONE）

- e2e profile 中连接记录数为 0，因此 e2e 只覆盖了「空列表」分支（选择栏渲染、范围文案、计数、全选与批量按钮 disabled）。**带真实记录的行级勾选、半选（`indeterminate`）、`清除选择`、批量提交后的逐条回执渲染没有运行断言**，只有共享组件/类型层面与数据库层聚焦测试作为证据。
- 未做真实用户操作路径的端到端验收（在设置页新建连接 → 全选 → 批量删除 → 回执）。新建连接需要填 Notion/Obsidian 配置并触发 Main 的凭据/探测路径，e2e 目前不覆盖该流程。
- 未验证「删除后 safeStorage 凭据仍在/已被移除」的真实观测：本环境不读取凭据存储（`credential_present` 只是数据库投影），批量路径的「不删 secret」是代码路径证据（Main 未拦截 `integrations.bulkRemove`），没有运行时观测。
- 选择集合 prune、回执名称快照、`window.confirm` 文案只有代码与类型证据。
- 因此状态保持 IN_REVIEW，待 Supervisor 判定。

## 未触碰

- 定时任务/自动化规则（Task 05/06 范围）、`zotero.sqlite`、`.obsidian/`、任何凭据文件；未改动既有 e2e 断言的红项归属。
