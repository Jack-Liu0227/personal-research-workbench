# Literature & Zotero Import

## Agent wave boundary

文献 owner 提供 Agent 可引用的 Paper、SearchResult、matrix 和 Zotero projection 建议，不在 Agent runtime 中复制检索或导入逻辑。Zotero 导入必须复用现有能力探测、preview 和显式确认合同；真实服务验收交给 QA。

## Mission and ownership

负责 `docs/development/04-literature-zotero-import.md`：文献检索结果跨页选择、批量项目/矩阵/待读/任务、RIS/BibTeX、显式 Zotero 导入预览，以及受控 Google Scholar 来源工作区。

## Editable paths

- 主写集：`apps/desktop/src/renderer/src/features/research/literature.tsx`。
- 通过 Zotero Local 角色公开的 capability/preview/import service 接口工作；不得直接调用 `zotero.ts` 或外部 SDK。
- Scholar 的 WebContents/浏览器边界由 Desktop Backend 实现；contracts、queries、literature-runtime 由平台 owner 串行修改。

## Required inputs

- `none/page/all-results/explicit` 选择合同、逐条失败格式、批量取消语义。
- Zotero `read/write/unsupported` capability、Collection key/name 和重复 DOI/标题策略。
- Scholar 允许的 host、用户触发 URL 和系统浏览器 fallback 合同。

## Outputs

- 跨分页稳定选择，换查询/来源时显式清空提示，成功/跳过/冲突/失败逐条展示。
- 目标 Collection 选择、导入预览和显式确认；不支持 API 写入时生成 RIS/BibTeX 或 mailto 草稿并明确“未完成导入”。
- Scholar 内部来源工作区；不自动抓取、不绕过验证码、不伪造导入或发信成功。

## Gates and stop conditions

- 不复制选择状态到 DOM，不覆盖用户 Paper/Zotero 元数据，不后台写入、发邮件或同步。
- 附件只保存 locator/link；任何 external write、credential、WebContents 或 contract 需求交对应平台 owner。
- capability 不可用、站点拒绝嵌入或批处理有部分失败时保持可取消和可重试，不显示整体假成功。

## Verification

记录选择矩阵、批处理结果样例、脱敏 Scholar fallback、实际命令结果和人工验收步骤。

## Handoff

接收角色为 Zotero Local、Desktop Backend、Workspace Service、Frontend Platform、QA。
