# Task 21：Windows x64 NSIS 构建与 0.0.2 release

状态：IN_REVIEW（真实构建、安装、首次启动、隔离 profile 启动与卸载 smoke 已在本机 Windows x64 执行并留证；安装包未签名，真实 Zotero/Vault/cron/模型验收仍 BLOCKED）

## 交付物

| 项 | 值 |
| --- | --- |
| 安装包 | `Personal-Research-Workbench-0.0.2-Setup.exe` |
| 大小 | 124 854 159 bytes（约 119 MiB） |
| SHA-256 | `8C3D07F509850C6D2E5142C4A193591C4AFCA3218580C1E5089456930730208F` |
| 版本（`VersionInfo.ProductVersion`） | `0.0.2` |
| 附带资产 | `Personal-Research-Workbench-0.0.2-Setup.exe.blockmap` |
| Authenticode | `NotSigned`（仓库未配置代码签名证书，安装包与可执行文件均未签名） |
| 目标 | `nsis`、x64、`oneClick: false`、`allowToChangeInstallationDirectory: true` |
| Electron | 43.4.1（官方 win32-x64 发行包，`app.asar` 127 169 997 bytes） |

版本关系说明：仓库在本轮之前没有任何 tag 或 release，所有 `package.json` 均为 `0.1.0`。按用户明确要求发布 **0.0.2**，因此根 `package.json`、`apps/desktop/package.json`、9 个 `packages/*/package.json` 与 `packages/workspace-mcp/src/server.ts` 的 MCP server identity 一并改为 `0.0.2`，保证安装包名、`app.getVersion()`、tag 与 release 标题一致；这是一次相对 `0.1.0` 的**版本号回退**，不是递增。

## 构建命令与环境的必要偏离

```powershell
pnpm typecheck      # PASS
pnpm build          # PASS
pnpm package:win    # 默认解包路径在本机失败，见下
```

本机 `pnpm package:win` 两次失败，均为 electron-builder 解包 Electron 发行包之后的立即删除/重命名：

```text
EBUSY: resource busy or locked, unlink '...\release\win-unpacked.tmp\resources\default_app.asar'
EPERM: operation not permitted, rename '...\release-0.0.2\win-unpacked.tmp' -> '...\release-0.0.2\win-unpacked'
```

复现与定位（本机实测，非推断）：

1. 任意一刻新建的**真实 Electron `default_app.asar` 内容**文件，只要扩展名为 `.asar` 且位于本仓库目录树内，立即删除都会得到 `Device or resource busy`；同样内容改名为 `.foo`、或 1 字节的 `.asar`、或把真实 `.asar` 放到仓库树之外，都能正常删除。
2. 该锁定是**临时**的：数分钟后同一个 `.asar` 文件可以正常删除。
3. `Get-MpComputerStatus` 显示 Windows Defender 实时保护为 `False`；机器上运行着 `Everything`、`OneDrive.Sync.Service`、`SearchIndexer` 等第三方索引/同步进程，但本机没有 `handle.exe`/Process Explorer，**未能确认具体持锁进程**。

因此构建改用了 electron-builder 自带的 `electronDist` 能力，指向由官方缓存 zip 现场解压出的 Electron 43.4.1 目录，跳过“解压后立即删除 `default_app.asar` 并重命名 staging 目录”的路径：

```powershell
# 一次性准备（.gitignore 的 release*/ 内，不进入仓库）
7za x -o"<repo>\release-0.0.2\electron-dist" "<LOCALAPPDATA>\electron\Cache\<hash>\electron-v43.4.1-win32-x64.zip"

pnpm exec electron-builder --win nsis --x64 `
  -c.electronDist="<repo>\release-0.0.2\electron-dist" `
  -c.directories.output=../../release-0.0.2/build
```

已知偏离：`electronDist` 路径不会执行 `cleanupAfterUnpack`，因此安装包内保留了 `resources/default_app.asar`（111 073 bytes，Electron 在缺少 `app.asar` 时的兜底应用）。该文件是 Electron 官方发行包的原生内容，`resources/app.asar` 始终存在，fuses（`onlyLoadAppFromAsar`、`enableEmbeddedAsarIntegrityValidation`）未受影响，但它**不是标准 electron-builder 输出**。在没有该环境锁定的机器上，应直接使用 `pnpm package:win` 得到规范产物。

## smoke 证据

安装、启动、重启、卸载均在本机执行，落在隔离目录 `release-0.0.2/`（`.gitignore` 内，不进入仓库）。

1. **静默安装到隔离目录**：`Setup.exe /S /D=D:\...\release-0.0.2\smoke-install`，退出后目录内有 40 个条目，包含 `research-workbench.exe`、`Uninstall research-workbench.exe`、`resources/app.asar`、`resources/skills/`（`grilling`、`last30days`、`literature-matrix`、`literature-review-push`、`ponytail`、`ui-ux-pro-max`、`THIRD_PARTY_SKILLS.md`）与 `resources/sidecars/`（`requirements.txt`、`scholar.py`）；安装器执行后自动启动了应用。
2. **首次启动落库**：打包应用按 `main/index.ts` 的既定行为把 `app.getPath('userData')` 指向自身 exe 目录，因此数据落在 `smoke-install/data`、`config`、`workbench`。以 `better-sqlite3` 只读打开 `smoke-install/data/workspace.sqlite3`：文件头为 `SQLite format 3`；`_prw_migrations` 共 **29** 行，最大 `id=29`（`automation_run_history_archive_and_revision`，`applied_at=2026-09-13T18:12:32.509Z`）；`schedules` 只有 migration 28 播种的三条启用规则（`builtin.schedule.last30days` / `builtin.schedule.literature-matrix` / `builtin.schedule.literature-review-push`，`enabled=1`、`cron='0 9 * * *'`、`timezone='Asia/Shanghai'`）；`tasks`/`papers`/`projects` 均为 0 行（干净首次运行）。
3. **隔离 profile 启动**：`research-workbench.exe --prw-user-data-dir="D:\...\release-0.0.2\smoke-profile"` 正常启动，并在该目录生成独立的 `data/workspace.sqlite3`、`data/agent-runs`、`data/agent-sessions`、`config/workspace-service.json`，证明打包态的 profile 隔离参数生效、没有写入安装目录。
4. **卸载**：`Uninstall research-workbench.exe /S`（经 `Start-Process -Wait`）退出码 `0`；安装目录从 40 个条目降到只剩 `resources/`，桌面快捷方式、开始菜单快捷方式与 `HKCU\...\Uninstall` 注册表项均被移除。
5. **卸载残留（环境相关，非安装器缺陷）**：`resources/app.asar` 与 `resources/default_app.asar` 在卸载时仍处于上述 `.asar` 环境锁窗口中，NSIS 无法删除，因此 `resources/` 目录被保留。该残留与构建时失败的是同一外部持锁行为；在无此锁定的机器上卸载应清空安装目录。清理方式：等待锁释放后 `rm -rf resources`。本轮多次重试（安装后约 10 分钟）仍被占用，故按实测记录为残留。

## 未验证（保持 IN_REVIEW / BLOCKED）

1. **安装包未签名**：`Get-AuthenticodeSignature` 为 `NotSigned`，Windows SmartScreen 会对未知发布者告警；本轮不引入证书，release 说明需注明。
2. **自动更新未验证**：只生成了 NSIS 安装包与 blockmap，没有 `latest.yml`/publish provider，未做 electron-updater 流程。
3. **真实外部能力仍未验收**：真实 Zotero 9/10 授权写入与远程删除、真实用户 Obsidian Vault、cron 到点投递与启动补跑、带 app-owned 凭据的 Pi/Codex 模型输出，全部沿用各任务文件的 BLOCKED 结论。
4. **`pnpm test` 仍是 intentional no-op**：只按代码内注释如实记录，不宣称测试通过。
5. **打包态 UI 未做人工逐页回归**：只验证了进程启动、迁移、默认规则与 profile 隔离；没有对打包应用执行 `scripts/e2e-electron.cjs`（该脚本针对开发树）。

## 复现命令

```powershell
pnpm typecheck
pnpm build
pnpm package:win                                   # 无 .asar 环境锁定时
pnpm exec electron-builder --win nsis --x64 -c.electronDist=<dir> -c.directories.output=../../release-0.0.2/build   # 本机替代路径
```

```powershell
# 安装 / 启动 / 卸载 smoke
& ".\Personal-Research-Workbench-0.0.2-Setup.exe" /S /D=D:\...\smoke-install
& ".\smoke-install\research-workbench.exe" --prw-user-data-dir=D:\...\smoke-profile
Start-Process -FilePath ".\smoke-install\Uninstall research-workbench.exe" -ArgumentList /S -Wait
```
