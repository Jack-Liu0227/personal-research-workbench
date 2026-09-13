# Windows 数据迁移、应用内更新与界面刷新

状态：已实现并发布 0.0.3；源码门禁、类打包 Electron E2E、真实 Windows x64 未打包 EXE 启动 smoke 与 NSIS 产物验包已完成。当前机器的 NSIS 安装器窗口在静默安装阶段持续等待、未生成安装目录，因此安装器安装/升级/卸载 round-trip 仍标记为阻塞；真实 Zotero 授权仍需外部环境。

## 数据与启动

打包版把 `workspace.sqlite3`、连接配置和服务状态放入 Electron 每用户 `userData`（Windows AppData），避免安装到 `Program Files` 后无写权限导致闪退。首次启动会从旧 exe 目录旁的 `data/`、`config/` 复制到新目录；目标已有文件不会覆盖，源目录保留以便恢复。显式 `--prw-user-data-dir=<绝对非根路径>` 仍优先，用于隔离测试和高级用户 profile。Renderer 继续只使用类型化 preload API。

## 应用内更新

Main 使用 `electron-updater`，关闭自动下载和自动退出安装。设置 → 关于与更新提供检查、下载、进度和重启安装；启动后延迟执行一次检查。更新状态由 `UpdateStateSchema` 约束，只向 Renderer 暴露版本、阶段、进度和脱敏消息。更新器读取 GitHub Release 的 `latest.yml` 与安装包资产。下载或安装失败保留当前版本和用户数据，用户可从设置页重试。

## Zotero 授权

Zotero 页面的本机写入授权入口在 profile 存在时始终驻留。探测中、失败、只读和已授权状态均保留按钮或诊断入口；点击授权会先重新探测，再进入 Main safeStorage/Core 的既有授权流程，避免 capability 状态卡住。

## 视觉系统

共享 CSS 使用 Geist 优先的无衬线字体、中性背景和单一 teal 主色，统一 ResearchPanel、Settings、按钮、hover/active/focus/loading 状态，并保留响应式、深色主题和 reduced-motion 约束。未引入新的 UI 框架或滚动依赖。

## 验收记录

已运行并通过：

- `pnpm typecheck`
- `pnpm build`
- `pnpm test`（仓库约定的显式 no-op）
- `pnpm test:e2e`（真实 Electron + preload/Core；响应式溢出、抽屉、帮助入口、Inspector/Agent 长内容滚动）
- Zotero focused checks：`test:zotero-connector` 19/19、`test:zotero-write` 20/20、`test:zotero-delete` 7/7
- `node .agents/skills/windows-release/scripts/verify-packaging-filter.mjs`
- `pnpm package:win` attempted; the default `release/` output hit the known
  machine local `EBUSY` lock on `resources/default_app.asar`. Re-running the
  same electron-builder NSIS x64 build into isolated `release-0.0.3/build`
  succeeded.
- NSIS x64 构建与 `release.mjs verify`：0.0.3、125,123,593 bytes、SHA-256 `8513742EF29E7BA98B14095C4E7F209E33675F16832296C40ED9B63B11C1F274`、NotSigned、blockmap 133,178 bytes；资源中不再包含 windows-release 文件
- 直接启动 `release-0.0.3/build/win-unpacked/research-workbench.exe`：窗口标题“个人科研工作台”、进程响应，隔离 profile 在约 2 秒内创建 `data/workspace.sqlite3`

已发布：

- `v0.0.1`：由远程 `v0.1.0` 改标，原资产保留，Release 正式版
- `v0.0.3`：https://github.com/Jack-Liu0227/personal-research-workbench/releases/tag/v0.0.3
  - `Personal-Research-Workbench-0.0.3-Setup.exe`（125,123,593 bytes，SHA-256 如上）
  - 对应 `.blockmap`

未完成或受环境限制：

- 当前机器 NSIS 静默安装阶段未完成，未能取得安装/升级/卸载 round-trip 证据；应在另一台干净 Windows x64 机器复验
- 安装包未签名；SmartScreen 可能显示未知发布者
- 应用内更新需要远程 Release 实际提供新版本后再做下载/重启验证
- 真实 Zotero 9/10 写入授权和远程 round-trip 仍需配置本机 Zotero
