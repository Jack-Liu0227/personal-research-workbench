# Task 02 — 文献检索中的 Zotero 写入请求

## 范围

让 Literature 搜索结果/Inspector 直接出现“准备 Zotero 导入”或“请求写入权限”入口。先探测能力，再预览，只有真实 `capability.write` 才显示“确认并写入”；Zotero 9 必须显示只读和 RIS/BibTeX fallback。

## 实现要点（工作树，未提交）

- 入口在文献检索结果与 Inspector，不要求用户跳到 Zotero 页：
  - `apps/desktop/src/renderer/src/lib/zotero-write.ts`（新增）：共享决策表 `zoteroWritePlan`、`prepareLabels`、`confirmLabels`、`resultActionLabel`、`writeStatusLabel`、`writeBlockedExplanation`、`collectionWriteLabel`。
  - `apps/desktop/src/renderer/src/features/research/literature.tsx`、`features/zotero.tsx`：搜索结果按钮/Inspector 确认按钮/写入状态文案全部由该决策表派生，未知能力（未探测或探测失败）一律按只读处理，只提供 RIS/BibTeX 导入包。
- 能力探测说明只读原因：`packages/connectors/src/zotero.ts` 新增 `AdapterProbe.writeBlockedReason ∈ {server-id-missing, credential-missing, probe-failed} | null`；`packages/connectors/src/types.ts` 增加该字段。Zotero 9 的 loopback Local API 不返回 `Zotero-Server-ID`，因此本地写入握手无法完成，UI 明确显示“Zotero 9 → 只读 + RIS/BibTeX”，不出现可点击的写入按钮。
- transport 由能力驱动：`packages/workspace-service/src/literature-runtime.ts` 在调用方未冻结 transport 时不下发 `transport`，由 `IntegrationCoordinator` 按已探测能力决定 `api` / `save-file`；显式冻结的 transport（已确认写入路径）仍然优先。
- 预览 → 确认 → revision/CAS → 逐条回执：
  - `packages/contracts/src/research.ts`：preview 增加 `profileRevision`、逐条 `note`、冻结的 `targetCollectionKey`；execute 回执增加 `targetCollectionKey` 与 `collectionWrite ∈ {set, unchanged, not-written}`。
  - `packages/workspace-service/src/integration-runtime.ts`：预览冻结 profile revision/target collection；执行前校验同一 preview、显式 `confirmed: true`、非空 `confirmationToken`、凭据 profile 匹配，preview 一次性（写入后不可重放）。
  - `packages/connectors/src/zotero.ts` `writeZoteroProjection`：`PATCH` 只补远端空字段（title/DOI/url/abstractNote/publicationTitle/date 非空值绝不被覆盖）、标签取并集（保留用户在 Zotero 里的标签）、`collections` 只在显式选择非空 key 时发送，未选择则不改动远端成员关系；`If-Unmodified-Since-Version` 仍为硬性 CAS。

## 验收

- 入口位于文献检索页而不是要求用户跳转 Zotero 页。
- 不可写时不出现误导性写入按钮。
- 预览、确认、revision/CAS、逐条回执完整。

## 证据（2026-09-13，Task 02 收尾）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | PASS（全 workspace，含 `apps/desktop`） |
| `pnpm build` | PASS（`@prw/desktop` tsc -b + electron-vite build） |
| `pnpm test:zotero-write` | PASS 6/6（决策表：能力→按钮/状态/回执文案，含“只读不得出现写入字样”） |
| `node --import jiti/register --test packages/workspace-service/tests/literature-runtime.test.ts` | PASS 5/5，**1.8s**（staging→preview→execute 桥接、能力驱动 transport、确认/凭据/一次性 preview、逐条 Collection 回执），进程干净退出；修复前同一命令 31s 且偶发 >120s 无输出（真实 Python sidecar 子进程 + 未关闭 SQLite handle） |
| `git diff --check` | PASS（无空白错误） |
| `pnpm test:e2e` | FAIL，停在 `scripts/e2e-electron.cjs:486`（见下「未验收/红项」）；该点之前与 Task 02 相关的 e2e 断言全绿：`literature help dialog: ok`、`literature Inspector/live preview: ok`、`Zotero bridge surface: ok` |

### 本次收尾的聚焦测试修复（只改测试，不动业务实现）

`packages/workspace-service/tests/literature-runtime.test.ts` 有两处测试卫生问题，都会让这个最窄的 Task 02 聚焦测试偶发卡住（实测同一命令 31s → 超过 120s 无输出）：

1. **未关闭的 SQLite handle**：5 个用例原先各自在用例体末尾 `repository.close()`；一旦断言失败或在 `preview/execute` 抛错前中断，handle 就留在打开状态，Windows 下临时目录被锁（同目录 `obsidian-note-metadata.test.ts` 已记录同一问题）。现改为 `openRepository()` 登记实例到 `repositories[]`，`afterEach` 先 `close()` 全部 handle、再删除临时根目录。
2. **未被 stub 覆盖的真实子进程（真正的挂起原因）**：`LiteratureCoordinator` 的 Google Scholar 来源不是 `fetch`，而是 `runScholarSidecar()` 启动的 `python sidecars/scholar.py` 子进程。测试只 stub 了 `globalThis.fetch`，所以每次都会真起 Python 并等满 30s 子进程超时，被杀死的子进程句柄还可能继续持有 runner。现把该用例的 `PRW_SCHOLAR_SIDECAR` 指向不存在的脚本（用例后在 `afterEach` 恢复环境变量），sidecar 立即失败并走既有的 partial 分支。

结果：同一命令由 30s–>120s+ 降为 **1.8s，5/5 PASS，进程干净退出**（连续 3 次稳定）。业务实现零改动。

## 未验收 / 红项（保持 BLOCKED 或 IN_REVIEW）

- 真实 Zotero 9/10 只读与写入验收：**BLOCKED**。本机没有可用的 Zotero 9.0.6/10 写授权环境（Zotero 9 loopback API 不返回 `Zotero-Server-ID`，本地写握手无法完成）；`pnpm test:e2e:zotero`（真实 Zotero 冒烟）本轮未运行。所有写入结论均来自 stub fetcher，不构成真实写入证据。
- `pnpm test:e2e` 仍红，且失败点不属于 Task 02：`scripts/e2e-electron.cjs:486` 期待定时任务卡片显示 `每日文献推送` 且不得出现 `每日资讯推送`，而 Task 01 已把默认输出目录冻结为 `每日资讯推送`（`DEFAULT_DAILY_PUSH_SCHEDULE_INPUT`）。属 Task 05/06（通用 schedule 编辑器与目录）需要收敛的旧证据期望，本轮不修改以免与 Task 01 冻结冲突。
- `packages/connectors/test/zotero.test.ts` 有 2 个**既有**红项（HEAD 即红，与 Task 02 diff 无关，本轮未改）：
  1. `malformed remote item payload is a redacted structured IntegrationError`：`normalize()` 对 `title: 42` 这类“标题非字符串”的项是跳过而非抛错，测试期待 `pullZotero` 抛结构化 `INTEGRATION_REMOTE_RESPONSE_INVALID`。
  2. `Better BibTeX bridge ...`：实现发出 `params: [['Doe2024'], 'Better BibTeX']`（符合 BBT `item.export(citekeys, translator)` 签名），测试期待 `[['Doe2024', 'Better BibTeX']]`。
  两项都是旧期望与实现不一致，按“不重做业务实现”原则留待对应任务决策（改测试或补实现）。
- 未触碰：`zotero.sqlite`、`.obsidian/`、任何凭据与 secrets 存储；未开始 Task 03 及其后任务。
