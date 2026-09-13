# 22 — 发布自动化 skill（`.agents/skills/windows-release`）

状态：`IN_REVIEW`（脚本可执行且只读命令已在真实仓库验证；`build`/`smoke`/`publish`
在本轮未对同一个版本重复执行——0.0.2 的构建、安装、卸载 smoke 已在
[21](21-windows-nsis-0.0.2-release.md) 中留证）。

## 目标

把 0.0.2 那一轮手动做过的发布流程（版本自洽 → 门禁 → NSIS 打包 → 产物核对 →
安装/启动/卸载 smoke → tag + GitHub release）固化成项目内的 skill，使下一次发版
不必重新发现 `.asar` 环境锁、NSIS 命令行引号、`docs/releases` 被忽略等坑。

## 交付物

| 路径 | 作用 |
| --- | --- |
| `.agents/skills/windows-release/SKILL.md` | 触发词、硬规则、命令表、证据清单、交接要求 |
| `.agents/skills/windows-release/scripts/release.mjs` | 发行引擎（`status` / `version` / `build` / `verify` / `smoke` / `publish`） |
| `.agents/skills/windows-release/scripts/verify-packaging-filter.mjs` | 用 electron-builder 自身的 matcher 校验“本 skill 不进安装包、要发的 skill 仍在” |
| `.agents/skills/windows-release/references/evidence-and-pitfalls.md` | 本机实测的失败模式与规避方式（含 `.asar` 锁证据表） |

`SKILL.md` 只使用仓库既有约定：YAML frontmatter（`name` + `description` 触发词）
+ 正文；脚本为 Node 24 内置模块，无新增依赖（因此不涉及许可证或 ASAR 原生模块评审）。

## 脚本要点

- **版本自洽**：动态扫描根 `package.json`、`apps/*/package.json`、`packages/*/package.json`
  以及 `packages/*/src` 中携带当前版本号的身份声明（实测命中
  `packages/workspace-mcp/src/server.ts`），写入后再重新读取并对不一致直接失败；
  用定点正则替换而不是重新序列化 JSON，保留键序与结尾换行。
- **打包路径自动降级**：先走默认 electron-builder 路径；只有输出命中
  `EBUSY` / `EPERM` / `default_app.asar` 才解压官方缓存 zip 作为 `electronDist`
  重试，并把“使用了降级路径”和“包内保留 `resources/default_app.asar`”写进证据块。
- **不做未验证声明**：每个子命令都输出 evidence 块（大小、SHA-256、签名状态、
  `ProductVersion`、包内 `skills`/`sidecars`、迁移数与默认规则、卸载残留），
  并把“未运行/未验证”的项目一并打印。
- **不越界**：不删除用户数据，不关闭杀软或改系统设置，不 force-push、不 reset，
  `publish` 必须显式 `--yes`、要求工作树干净、tag/远端 tag/release 三者都不存在，
  并在发布前打印完整命令计划（`--dry-run` 只打印不执行）。
- **pnpm 调用方式**：本机 `pnpm` 只有 `.cmd` 垫片，`spawn` 直接调用会
  `ENOENT`/`EINVAL`，因此经 `cmd.exe /d /s /c` 执行，并且传给它的路径一律相对
  `apps/desktop`（避免空格破坏 cmd 引号往返）。

## 本轮验证证据（真实执行）

```text
node --check .agents/skills/windows-release/scripts/release.mjs   -> SYNTAX_OK

node .agents/skills/windows-release/scripts/release.mjs status
  versions : 11 个 package.json + packages/workspace-mcp/src/server.ts 全为 0.0.2
  git      : master @ 5eac092, tags=v0.0.2, working tree dirty(12)
  releases : "Personal Research Workbench 0.0.2   Latest  v0.0.2  2026-09-13T18:30:03Z"
             "v0.1.0 — 首个公开预览        Pre-release  v0.1.0  2026-09-11T15:13:45Z"
  artifacts: Personal-Research-Workbench-0.0.2-Setup.exe 124,854,159 bytes
             Personal-Research-Workbench-0.0.2-Setup.exe.blockmap 132,896 bytes
             electron-dist ready at release-0.0.2/electron-dist

node .agents/skills/windows-release/scripts/release.mjs version --check
  identity packages\workspace-mcp\src\server.ts -> 0.0.2
  version is consistent

node .agents/skills/windows-release/scripts/release.mjs verify
  installer Personal-Research-Workbench-0.0.2-Setup.exe / 124854159 bytes
  sha256    8C3D07F509850C6D2E5142C4A193591C4AFCA3218580C1E5089456930730208F
  signature NotSigned / (none)     productVer 0.0.2
  payload   research-workbench.exe, app.asar 127169997 bytes,
            skills: THIRD_PARTY_SKILLS.md, grill-me, grilling, last30days, literature-matrix,
                    literature-review-push, ponytail, ui-ux-pro-max
            sidecars: requirements.txt, scholar.py

node .agents/skills/windows-release/scripts/release.mjs smoke --dry-run
  install C:\Users\HK\AppData\Local\Temp\prw-smoke-0.0.2   (无空格)
  profile C:\Users\HK\AppData\Local\Temp\prw-profile-0.0.2 (无空格)
  -> 仅打印计划，未安装

node .agents/skills/windows-release/scripts/release.mjs publish --dry-run --version 0.0.2
  -> [fail] working tree is dirty（另一位写入者的未提交改动）
node .agents/skills/windows-release/scripts/release.mjs publish --dry-run --version 0.0.2 --allow-dirty
  -> [warn] --allow-dirty: publishing with 13 uncommitted path(s)
     [fail] tag v0.0.2 already exists locally
```

（`verify` 复算出的 SHA-256 与 [21](21-windows-nsis-0.0.2-release.md) 中记录的一致，说明该子命令读的是真实产物而非日志文本。）

打包过滤器用 electron-builder 自身的 `FileMatcher.createFilter()`
（`app-builder-lib@26.15.3`）实测：加入 `!**/windows-release/**` 后
`windows-release/SKILL.md` 与 `windows-release/scripts/release.mjs` 均被排除（`false`），
`literature-matrix/SKILL.md`、`literature-review-push/SKILL.md`、
`last30days/skills/last30days/SKILL.md` 仍保留（`true`），既有
`!**/last30days/assets/**` 行为不变。该检查已固化为
`scripts/verify-packaging-filter.mjs`（它直接读配置文件里的真实 filter 列表）；
**当前仓库状态下该脚本以 exit code 1 结束并打印待添加的那一行**：

```text
node .agents/skills/windows-release/scripts/verify-packaging-filter.mjs
exit=1
[FAIL] excluded windows-release/SKILL.md               allowed=true
[FAIL] excluded windows-release/scripts/release.mjs    allowed=true
[PASS] included literature-matrix/SKILL.md             allowed=true
[PASS] included literature-review-push/SKILL.md        allowed=true
[PASS] included last30days/skills/last30days/SKILL.md  allowed=true
[PASS] excluded last30days/assets/demo.mp4             allowed=false
[FAIL] apps\desktop\electron-builder.yml does not exclude this dev-only skill. Add !**/windows-release/** ...
```

即：检查脚本本身工作正常，它报的“未排除”是仓库当前真实状态（见下方未完成项）。

## 未完成项

- `apps/desktop/electron-builder.yml` 的 `extraResources[0].filter` **本轮未改动**：
  该文件当前存在另一位写入者未提交的 `publish: github` 改动，按“一个文件一个写入者”
  纪律不与其交错。需要的行与验证方式写在
  `references/evidence-and-pitfalls.md` §4；`scripts/verify-packaging-filter.mjs`
  因此当前以 exit code 1 结束（这是真实状态，不是脚本缺陷），`release.mjs verify`
  也会在 `win-unpacked/resources/skills` 出现 `windows-release` 时告警。
  修掉只需在 filter 列表追加一行：

  ```yaml
      - "!**/windows-release/**"
  ```
- `build`、`smoke`、`publish` 三个子命令本轮只验证了参数解析、前置条件与计划输出
  （见上方真实输出），未对 0.0.2 重复执行实际的打包/安装/发布：重复执行会重新
  打包 1 GB 产物、重复安装卸载，并为已存在的 tag 再次发布。0.0.2 的手工等价流程
  证据见 [21](21-windows-nsis-0.0.2-release.md)；首次真正使用该 skill 发版时应
  记录 `build`/`smoke`/`publish` 三段的真实输出（尤其是自动降级分支与 `gh release create`）。
- skill 不覆盖：签名、自动更新、打包态逐页 UI 回归、外部服务（Zotero/Vault/cron/模型）
  验收，这些继续保持各自的 `BLOCKED`/未验证状态。

## 复现命令

```powershell
node .agents/skills/windows-release/scripts/release.mjs status
node .agents/skills/windows-release/scripts/release.mjs version --check
node .agents/skills/windows-release/scripts/release.mjs verify
node .agents/skills/windows-release/scripts/release.mjs publish --dry-run --version 0.0.2
```
