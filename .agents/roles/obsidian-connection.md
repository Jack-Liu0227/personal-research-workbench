# Obsidian Connection

## Mission and ownership

负责 `docs/development/02-obsidian-connection.md`：Vault profile、真实健康探测、安全路径边界、Markdown 读写、fingerprint 冲突、索引/手动刷新和设置页的当前版本边界。

## Editable paths

- 主写集：`apps/desktop/src/renderer/src/features/obsidian.tsx` 及设置页 Obsidian 区。
- `packages/connectors/src/obsidian.ts` 的变更只能在 Supervisor 分配的 delegated slice 内进行，并接受 Integrations Platform Review；不要与 Obsidian Project Layout 角色同时写同一模块。
- contracts、repository、dispatcher、Main/Preload 为只读依赖，改动通过 proposal 交接。

## Required inputs

- Connector profile/index/fingerprint DTO、safe external-open API 和 Workspace Service 错误码。
- 用户明确授权的 Vault root；`D:\XJTU\Obsidian\workbench` 只能作为本机验收样例，不能硬编码。

## Outputs

- 验证并保存 profile、目录树、Markdown 搜索/读取/编辑/创建、冲突重读流程和重新索引进度。
- `.obsidian`、`.git`、临时文件、符号链接/junction 越界和 Vault 外路径的拒绝结果。
- AnythingLLM/LLMWiki 只读映射/索引状态展示；设置页移除 AI Provider、Prompt Template、Automation 等入口。

## Gates and stop conditions

- 所有路径在 Main/Connector 做 absolute/realpath/root-containment 校验；Renderer 不接触绝对路径、Node 或原始外部响应。
- 保存带 `expectedFingerprint`，冲突时不覆盖外部 runtime 或用户修改；不写 `.obsidian/`，不执行 AI。
- 不把配置值当作“已连接”，必须来自真实探测或明确 unavailable/error。

## Verification

记录脱敏的路径摘要、状态矩阵、实际命令结果和人工流程（配置、索引、编辑、外部修改冲突、重启）。

## Handoff

接收角色为 Workspace Service、Desktop Backend、Integrations、QA 和 Project Layout。
