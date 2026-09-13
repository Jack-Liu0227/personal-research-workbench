# Task 03 — Literature Inspector URL 跳转

## 范围

右侧预览区的 DOI、来源 URL 和 PDF URL 使用可访问链接，通过 Main `system.openExternal` 安全打开系统浏览器。

## 验收

- `http/https` 链接有可见链接文本、键盘可操作和新窗口语义。
- 禁止 `file:`、凭据 URL、危险协议。
- 保留复制 URL 功能，打开失败显示可诊断反馈。

## 实现（本轮工作树，未提交）

- 单一白名单合同（新增 `packages/contracts/src/external-url.ts`，由 `index.ts` 再导出）：
  - `EXTERNAL_OPEN_URL_PROTOCOLS = ['http:', 'https:']`。
  - `externalOpenUrlIssue(value)` 返回 `null` 表示可打开，否则返回中文原因（非绝对 URL / 非 http(s) / 含凭据）。
  - `ExternalOpenUrlSchema` = `z.string().url()` + 上述校验，直接用于 `RpcMethodPayloadSchemas['system.openExternal']`（`packages/contracts/src/index.ts`）。
- Main `apps/desktop/src/main/ipc.ts`：删除本地 `ExternalUrlSchema`（原实现还允许 `zotero:` 与 **`file:`**），改为 import 上述合同；`system.openExternal` 仍在 Main 自身 `ExternalOpenUrlSchema.parse(payload)` 后再调用 `shell.openExternal`（preload 之外的第二次强制）。
- Preload `apps/desktop/src/preload/index.ts`：`openExternal` 由 `z.string().url()`（只校验 URL 形状，`file:`/`javascript:` 都能通过）改为 `ExternalOpenUrlSchema.parse(url)`，危险协议在渲染进程边界即被拒绝，不会产生 IPC。
- Renderer 判定集中在新库 `apps/desktop/src/renderer/src/lib/external-url.ts`（纯函数，无 DOM/Electron 依赖）：
  - `resolveExternalUrl`：空值 → `empty`；裸主机名（`europepmc.org/article/…`）补 `https://`；其余非法方案 → `blocked` 并带原因；`\.pdf($|?|#)` 才标记 `pdf`（`isOpenAccess` 不会被当成 PDF 证据）。
  - `doiExternalUrl`：去掉 `doi:`/`doi.org` 前缀后拼接 `https://doi.org/…`，DOI 本身永远不被当作协议。
  - `externalAnchorAttributes` / `externalLinkAriaLabel`：链接的 `href/rel="noreferrer noopener"/target="_blank"` 与图标态可访问名。
  - `openExternalUrl`：只经 `getWorkbenchApi().system.openExternal`，失败返回可诊断文案（`打开链接失败：…`）而不是未处理的 rejection。
  - `copyTextToClipboard`：优先 `navigator.clipboard.writeText`；因 `hardenSession()` 拒绝一切渲染进程权限，异步剪贴板可能直接 reject，故保留同步 `execCommand` 兜底，并如实报告成功/失败。
- 共享组件 `apps/desktop/src/renderer/src/components/external-link.tsx`：
  - 真实 `<a href>`：可见链接文本、`target="_blank"`、`rel="noreferrer noopener"`、focus ring；Enter 原生激活，另为图标态补 Space 激活（`preventDefault` 后走 IPC）。
  - 点击/中键一律 `preventDefault`：渲染进程既不导航也不 `window.open`（`hardenWindow()` 本就 deny），跳转只走 Main 白名单。
  - `blocked` 值不渲染 `<a>`：显示划线的原始文本 + “仅允许…http/https 链接”等原因，只保留复制按钮。
  - 每次打开/复制的真实结果写入 `role="status" aria-live="polite"`；失败额外通过 `onOutcome` 进入文献页反馈条。
- 接入点：
  - `features/research/literature.tsx`：Inspector 的 DOI 行与来源/PDF 链接字段、检索结果行的图标链接都改用共享组件；字段名由 `externalUrlFieldLabel` 决定（仅 URL 自身指向 `.pdf` 时显示 `PDF URL`，否则 `来源链接`）；页面新增 `reportExternalOutcome` 把失败送回现有 `MutationFeedback` 错误条。
  - `features/zotero.tsx`：条目“打开条目链接”原本也是被 `setWindowOpenHandler(() => deny)` 静默吞掉的死链，一并改为共享组件（同类缺陷，非 Zotero 写入业务）。

## 证据（2026-09-13，Task 03 收尾）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | PASS（10/10 workspace，含 `apps/desktop`） |
| `pnpm build` | PASS（`tsc -b` + `electron-vite build`；产物 `out/main/index.cjs` 只调用 `ExternalOpenUrlSchema.parse`，`out/preload/index.cjs` 只导出 `EXTERNAL_OPEN_URL_PROTOCOLS = ["http:", "https:"]`） |
| `pnpm test:external-url` | PASS 6/6（合同拒绝 `file:`/`javascript:`/`data:`/`vbscript:`/`ms-msdt:`/`zotero:`/凭据 URL；裸主机名补 https；DOI canonical；失败文案；剪贴板兜底；anchor 契约） |
| `pnpm test:e2e` | 新增断言 `literature external URL allowlist: ok (5 rejected vectors)` PASS，且已断言被拒绝的 URL 不会新开窗口；随后**仍 FAIL** 于既有 `scripts/e2e-electron.cjs:514` 定时任务目录断言（见下「未验收/红项」，非本任务改动） |
| `git diff --check` | PASS（无空白错误） |

- 真实系统浏览器打开：**未在本环境验证**（无法确认 OS 默认浏览器/关联程序），故任务状态为 `IN_REVIEW`/`BLOCKED`，不标 DONE。

## 未验收 / 红项

- 真实 `shell.openExternal` 到系统浏览器的观测（浏览器窗口是否真的出现、无关联处理器的报错路径）：**BLOCKED**，本轮只验证到“白名单内 URL 通过 IPC 抵达 Main `shell.openExternal` 调用点”为止；e2e 故意只使用不会启动任何程序的无害向量（不存在的本地路径、`javascript:`、`ms-msdt:`、`zotero:`、带凭据 URL），避免冒烟过程真的拉起外部程序。
- `pnpm test:e2e` 仍红：`scripts/e2e-electron.cjs:514` 要求定时任务卡片出现 `每日文献推送` 且不得出现 `每日资讯推送`，而本轮 Task 01 冻结的默认输出目录是 `每日资讯推送`（`DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.outputFolder`，`packages/contracts/src/research.ts:77`），`features/automation.tsx` 的表单默认值却仍是 `每日文献推送`。属 Task 05/06（schedule 编辑器与目录）需要收敛的旧期望，本轮**不修改该断言**，避免与 Task 01 的冻结冲突且不以错误断言掩盖。
- 带检索结果的 Inspector/结果行视觉与真实点击流未在 e2e 覆盖：e2e 的文献段不发起联网检索，结果列表为空（Inspector 显示“尚未选择结果”），因此链接的 DOM 断言只能由 `pnpm test:external-url` 的契约级断言提供，而不是端到端截图证据。
