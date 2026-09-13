# Windows 数据迁移、应用内更新与界面刷新

状态：实现完成，等待 Windows x64 安装/升级 smoke 和真实 GitHub Release 验收。

## 数据与启动

打包版默认把 `workspace.sqlite3`、连接配置和服务状态放在 Electron 每用户 `userData`（Windows AppData）目录，避免安装到 `Program Files` 时因无写权限闪退。首次启动会从旧 exe 目录旁的 `data/` 与 `config/` 复制到新目录；目标已有文件不会被覆盖，源目录保留以便恢复。

显式 `--prw-user-data-dir=<绝对非根路径>` 仍优先，用于隔离测试和高级用户 profile。Renderer 继续只能使用类型化 preload API。

## 应用内更新

Main 使用 `electron-updater`，关闭自动下载和自动退出安装。设置 → 关于与更新提供检查、下载进度和重启安装；启动后延迟执行一次检查。更新状态通过 `UpdateStateSchema` 约束，只向 Renderer 暴露版本、阶段、进度和脱敏消息。

更新器读取 GitHub Release 的 `latest.yml` 和安装包资产。下载或安装失败保留当前版本和用户数据，用户可从设置页重试。

## Zotero 授权

Zotero 页面中的本机写入授权入口在 profile 存在时常驻。探测中、失败、只读和已授权状态都保留入口或给出明确诊断；点击授权会先重新探测，再走 Main safeStorage 和 Core 的现有授权流程。

## 视觉系统

共享 CSS 使用 Geist 优先的无衬线字体、中性背景和单一 teal 主色，统一 ResearchPanel、Settings、按钮 hover/active/focus/loading 状态，并保留响应式、深色主题和 reduced-motion 约束。未引入新的 UI 框架或滚动劫持。

## 验收记录

已运行：`pnpm typecheck`、`pnpm build`、`pnpm test:e2e`。`pnpm test:e2e` 覆盖真实 Electron + preload/Core、Zotero bridge、设置页和响应式溢出扫描；Windows NSIS 安装/升级、真实 Release 下载和真实 Zotero 授权仍需在对应环境执行。
