# Zotero Local

## Agent wave boundary

为 Agent 提供只读 Zotero item/collection 上下文时只能走 Local/Web API。禁止读取或写入 zotero.sqlite；写回仍需现有 preview/execute 和用户确认，runtime 不得持有 Zotero 凭据。

## Mission and ownership

负责 `docs/development/06-zotero-local.md` 与 `docs/plan/06-Zotero.md`：本机 Zotero Local/Web API 的真实 capability probe、Collection/item 分页搜索、Inspector、Paper 导入、Better BibTeX citation key 和附件 locator。

## Editable paths

- 主写集：`apps/desktop/src/renderer/src/features/zotero.tsx`。
- `packages/connectors/src/zotero.ts` 只能在 Supervisor 分配的 delegated slice 内修改，并接受 Integrations Platform Review；Literature role 通过 service 合同调用。
- contracts、repository、integration-runtime、safeStorage 和 Web API credential 由平台 owner 管理。

## Required inputs

- 目标 Zotero 版本、Local API 地址（推荐 `http://localhost:23119/api/`）和真实探测结果；`1ocalhost` 拼写错误必须报错，不得静默修正。
- `read/write/unsupported` capability、library/collection/item 稳定 key、Paper/ExternalLink 映射和冲突策略。

## Outputs

- 未启动/离线/未授权/限流/超时/部分页的中文状态；真实 Collection 树、分页搜索和 Inspector。
- Zotero→Paper 的非破坏性导入、重复 DOI/标题提示、sync run 记录和资源 locator；Paper→Zotero 的显式预览/写入或 RIS/BibTeX fallback。

## Gates and stop conditions

- 绝不打开、读取或写入 `zotero.sqlite`，不复制附件 PDF，不在后台同步或覆盖用户元数据。
- Local API 只允许 loopback；Web credential 只由 Main safeStorage 注入，不能进入 Renderer/SQLite 明文。
- capability 未探测、权限改变或 revision 冲突时不显示已连接/已导入，暂停并交 Integrations/Desktop。
- 保存配置、重启应用后必须重新 probe `/collections` 与 `/items`；`.env` 只作为开发默认值，打包配置走设置页，禁止 mock HTTP 服务。

## Verification

记录 Zotero 版本、端口、脱敏 capability/status、Collection/item 分页和导入明细，以及实际命令结果。

## Handoff

接收角色为 Literature、Integrations、Desktop Backend、Workspace Service、QA。
