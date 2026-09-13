# Task 05 — 通用自动化 runtime 与目录编辑器

## 范围

把定时任务编辑器抽象为通用 skill schedule：runtime、skill、主题、中文输出、来源、回看天数和安全输出目录。目录使用内置目录下拉 + 自定义相对目录校验。

## 默认

- skill：`last30days`
- 主题：`AI 最新资讯`
- 语言：中文
- 回看：30 天
- 目录：`每日资讯推送`

## 后续扩展

同一编辑器必须能配置 `literature-matrix` 和 `literature-review-push`，不复制第三套表单或调度逻辑。

## 安装状态与 skill 路径解析（2026-09-13 恢复修复）

编辑器的 skill 下拉只把“本构建能真正解析到 SKILL.md 的 shipped skill”渲染为可选；
`literature-matrix` / `literature-review-push` 仍然显示为“未安装（运行会被阻断）”且不可选。

安装状态由主进程 registry 的 `describeAgentSkillCatalog()` 计算，其路径解析不再依赖
Core 进程的 `process.cwd()`（Core 的工作目录是用户数据目录，开发运行下必然找不到仓库 skill）：

- 开发/签出运行：Electron Main 从自己的 bundle 位置向上找到含 `.agents/skills` 的仓库根，
  通过 `PRW_PROJECT_ROOT` 传给 Core（`probe.projectRoot` 为最高优先级锚点）；没有显式锚点时
  才从 `cwd` 逐级向上（上限 8 层）查找，因此 `pnpm dev`、e2e 与 `pnpm test:last30days` 都能读到
  `<repo>/.agents/skills/last30days/skills/last30days/SKILL.md`。
- 打包运行：Main 设置 `PRW_PACKAGED_APP=1` 且不传仓库根，解析只允许构建镜像
  `resources/skills/...`（由 `electron-builder.yml` 的 `.agents/skills → skills` 生成），
  不再从任意工作目录向上走出安装目录；`.agents/skills` 始终是唯一手工维护源。
- `PRW_LAST30DAYS_SKILL_PATH` 仍是显式覆盖：它存在但指向不存在的路径时，run 直接以
  `SKILL_MISSING` 阻断并列出探测过的路径（override / 项目路径 / 打包镜像），不会静默改用其它源。

验证：`pnpm typecheck`、`pnpm build`、`pnpm test:e2e`（`schedule default/daily/pause-enable` 断言
`#schedule-skill` 可选值为 `["", "last30days"]`，默认值 last30days/AI 最新资讯/zh-CN/30/每日资讯推送，
内置目录下拉 + 自定义相对目录）、`pnpm test:last30days`（离线契约，含项目根/walk-up/打包镜像/目录状态检查）。
