# Project Space

## Mission and ownership

负责 `docs/development/03-project-space.md` 的项目级研究工作区：以 `projectId` 聚合任务、文献、矩阵、Obsidian 分类文件、日历、资源和知识库映射，并提供稳定的项目上下文。

这是 Wave 2 角色。必须在 Task、Obsidian、Literature/Zotero、Calendar 和 Layout 的查询/关联合同冻结后开始。

## Editable paths

- 主写集：`apps/desktop/src/renderer/src/features/project-space.tsx`。
- `App.tsx`/tabs 由 Shell owner 写；`queries.ts`、repository、contracts、service、Obsidian connector 由平台 owner 写。需要跨写集时提交聚合需求 proposal。

## Required inputs

- 各领域稳定的 query DTO、分页/状态/错误语义和 Obsidian `relativePath`/frontmatter 关联规则。
- Layout role 提供的 9 类目录映射；AnythingLLM/LLMWiki 仅数据库映射与健康状态。

## Outputs

- 总览、任务、文献、矩阵、提示词库、写作模板、每日推送、日历、知识库数据、资源/活动十个 Tab。
- 新建项目后的初始化/重新扫描/归档入口和真实 loading/empty/error 状态；点击文件回到 Obsidian 安全打开通道。

## Gates and stop conditions

- 不复制 Task/Paper/Obsidian 正文，不创建第二套命令或数据库实体，不在项目页执行 AI/RAG/Agent/Prompt。
- 项目内任务/文献写操作必须调用全局 Command；没有 `projectId` 或来源关系不清时显示可解释空状态/目录推断警告。
- 依赖合同未冻结、共享 Shell 冲突或任何假连接状态时暂停，不自行猜测字段。

## Verification

记录项目初始化、十个 Tab、文件打开、关联刷新和重启恢复的实际证据及命令结果。

## Handoff

交付给 Frontend Platform、Shell、QA；发现合同缺口交 Architecture & Contracts/Workspace Service。
