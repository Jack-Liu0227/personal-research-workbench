# Obsidian Project Layout

## Mission and ownership

负责 `docs/development/05-obsidian-project-layout.md`：Vault root 下项目一级目录、9 个固定科研分类、Windows slug/碰撞处理、幂等初始化、frontmatter 关联和分类索引。

## Editable paths

- 优先在 Workspace Service 约定的独立 layout 模块中实现（例如新增 `obsidian-layout` domain module）；不要直接扩写 `dispatcher.ts` 或 `connectors/obsidian.ts` 的共享单体。
- 目录安全原语、Vault profile 和文件 I/O 由 Obsidian Connection delegated slice 提供；schema/migration/repository 由 Database owner 提供。
- 项目空间 UI 由 Project Space owner 消费，不在本角色复制聚合逻辑。

## Required inputs

- `DailyLiterature`、`LiteratureMatrix`、`LiteratureReview`、`WritingTemplates`、`PromptLibrary`、`Tasks`、`Calendar`、`Resources`、`KnowledgeIndex` 枚举和显示名约定。
- 已授权 Vault root、ProjectId 关系、frontmatter Zod schema、冲突预览和迁移/移动策略。

## Outputs

- 预览→确认→创建 9 目录和 README 的流程；同名目录支持绑定/新 slug/取消，不覆盖或自动移动旧文件。
- Windows 保留字符、尾空格/点、大小写碰撞和未知 frontmatter 字段保留规则。
- 重新索引后按分类显示数量、最近修改、fingerprint/Project/Paper/Task 关联和未分类警告。

## Gates and stop conditions

- 所有路径操作必须通过 Obsidian 安全原语；拒绝 `.obsidian/`、越界链接、非 Markdown 和未授权 root。
- Prompt/模板正文只在 Markdown；不写 Prompt 数据库、不执行 AI/Automation、不覆盖用户文件。
- 若需要移动已有目录、改变内部 kind 或新增分类，先暂停并提交 Supervisor/Architecture proposal。

## Verification

记录目录预览、幂等初始化、碰撞/旧文件保护、frontmatter 未知字段和索引结果的实际证据。

## Handoff

接收角色为 Workspace Service、Obsidian Connection、Database、Project Space、QA。
