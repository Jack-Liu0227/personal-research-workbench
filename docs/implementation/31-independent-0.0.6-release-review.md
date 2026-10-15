# 31 - 0.0.6 独立 QA / Security 发布候选复核

日期：2026-10-15。角色：独立 Review Security / QA。版本取自本轮根目录与 Desktop `package.json`，本轮为 `0.0.6`。

## 结论与边界

**限定 APPROVE**：冻结的 Windows x64 候选包身份、安全设置、随包 notices，以及本机隔离目录中的真实 NSIS 安装、启动、重启、同版本重装、合成数据库迁移和卸载证据通过独立复核。未发现本次检查范围内尚未关闭的 Blocker / Critical / Major；已披露的许可证正文缺口仅按本候选的独立例外记录接受，不等于缺口已经补齐。

这不是对干净 Windows VM、Authenticode 签名、旧版安装器升级、自动更新端到端或在线外部服务的批准，也不证明全部 P0-P6 产品与发布目标均已完成。远程 tag、提交及上传资产尚未在本记录中验收；发布授权和实际发布仍由 Supervisor 按用户请求处理。任何生产代码、依赖、打包输入或已绑定许可证证据变化均需重新评估，不能将本结论自动套用到重建产物或其他平台。

Reviewer 没有执行产品构建、Electron、NSIS 安装器或卸载器，也没有加载原生 addon、修改产品代码或运行数据库写入。构建及安装烟测由 Supervisor 串行执行；Reviewer 独立执行纯 Node 安全/许可证检查、读取真实归档与 PE 字节、校验哈希、读取最终烟测证据，并只读重算当前系统快照与受保护目录指纹。生产 Main inspector 和 fuses 没有为验证而放宽。

## 冻结身份

| 对象 | 独立核验结果 |
| --- | --- |
| 构建提交 | `8e7450cc08be615149cd43ec0ea6aa76d30a046a` |
| 安装器 | `release-0.0.6/build/Personal-Research-Workbench-0.0.6-Setup.exe`，141,028,956 bytes |
| Setup SHA-256 | `b1f0d99afaf50d498064ad009f71b0589ef71b8a07e3ba67ea6bd18018bc60e3` |
| Setup ProductVersion / 签名 | `0.0.6` / `NotSigned`；没有签名者 |
| `app.asar` SHA-256 | `b8a3175b989155d99d5196c49764500d3faa07008e97f891e481d14d167e44d5` |
| 实际 ASAR metadata | `name: personal-research-workbench`，`version: 0.0.6`，`main: ./out/main/index.cjs` |
| 源 workspace 名称 | 仍为 `@prw/desktop`；不与安装产物 metadata 混淆 |
| 应用身份 | `com.personalworkshop.researchworkbench` / `Personal Research Workbench` / `research-workbench.exe` |
| Pi / MCP 精确版本 | 实际载荷 `@earendil-works/pi-ai` 与 `@earendil-works/pi-coding-agent` 均为 `0.85.1`；`@modelcontextprotocol/sdk` 为 `1.30.0` |

Reviewer 实际重算 Setup、构建日志、源 `electron-builder.yml`、复制的 `builder-input-config.yaml` 哈希，核对 `build-receipt.json` 和安装 attestation，全部一致；安装器和日志时间处于 receipt 记录的构建时间窗口。`latest.yml` 的版本、文件名、141,028,956 bytes 及两处 SHA-512 均与实际 Setup 相符。实际 blockmap 存在，149,849 bytes。

构建使用真实默认路径，没有 `electronDist` fallback；实际 `resources/default_app.asar` 不存在。复制的配置只是 **hash-bound builder input**，不是声称 electron-builder 生成了 effective config。实际构建日志中的两次 makensis spawn 均具有匹配的 appId、GUID `24b19892-dc4c-52bd-9248-f7db6ea6eafb`、版本与 package name；均有 `-DHIDE_RUN_AFTER_FINISH`，且无 `-DRUN_AFTER_FINISH` / `-DONE_CLICK`。配置为 assisted/current-user 安装，`oneClick: false`、`runAfterFinish: false`。

实际 ASAR name、`app-update.yml` 的 `updaterCacheDirName` 及 makensis `APP_INSTALLER_STORE_FILE` 三处一致：`personal-research-workbench` / `personal-research-workbench-updater` / `personal-research-workbench-updater\installer.exe`。最后一个路径使用一个反斜杠字符。旧 scoped cache 没有迁移、覆盖或清理；appId、EXE 及默认 profile 规则没有改变。

## 独立执行的检查

| 命令或只读探针 | 结果与实际范围 |
| --- | --- |
| `node scripts/generate-release-notices.mjs --version 0.0.6 --check` | exit 0；`PASS_WITH_DISCLOSED_EXCEPTIONS`；288 grouped rows、294 exact npm versions、254 文本、4 项已披露缺口 |
| `node --test scripts/release-smoke-safety.test.cjs` | exit 0；15/15 PASS，0 skipped / cancelled；本次证据 `%TEMP%\prw-release-safety-tests-OgR20J` |
| 只读 `node` stdin 断言：receipt / Setup / YAML / ASAR / PE / notices / skills | exit 0；读取文件，不执行产品模块；使用现有 builder 的 ASAR / YAML parser，无新增依赖 |
| `Get-AuthenticodeSignature` 与安装器 VersionInfo | 实际 `NotSigned`、ProductVersion / FileVersion `0.0.6` |
| 只读 Node 最终证据断言、`snapshot` 与 `fingerprintProtected` | exit 0；重新检查卸载后的真实状态和旧目录指纹，与最终记录一致；未调用启动、停止或安装函数 |
| `git diff --exit-code HEAD -- apps packages pnpm-lock.yaml docs/legal .agents/skills ':!.agents/skills/last30days'` | exit 0；已知无关 `pnpm-workspace.yaml` 与 last30days 工作区内容保留，未 reset / clean |

本机没有 PowerShell 7；元数据和只读系统状态检查使用 Windows PowerShell，并已披露这一原因。安全测试只使用其自建合成 TEMP fixture，不运行产品、安装器或原生 addon。

实际 PE machine 为 `0x8664`。生产 fuse wire 为 `010011001`；明确核验 RunAsNode、NodeOptions、Node CLI inspector 和 file-protocol extra privileges 关闭，cookie encryption、embedded ASAR integrity、only-load-app-from-ASAR 开启。安装及同版本重装证据中的前八位同为 `01001100`。额外第九位保留本 Electron 版本实际值，不将其冒称为已单独验收的能力。

归档中全部 7 个 `out` 文件、共 5,844,739 bytes，与当前已冻结的构建输出逐字节一致；1,808 个 Pi unpacked 文件哈希与 ASAR integrity 相符。实际物理 resources 和 ASAR 内部均未发现退休 sidecars、`.git`、`__pycache__`、`.pyc`、`windows-release` 或 `PRW-PIN.md`。242 个实际 skill 文件与源逐字节相同；`THIRD_PARTY_SKILLS.md`、四个引用技能的 `LICENSE.upstream`、last30days 及其 vendor 的 LICENSE 均保留。此检查不是证明所有依赖的源码到二进制可复现。

## 随包许可证与接受的剩余风险

实际 `resources/legal/0.0.6` 的 280 个文件与源 `docs/legal/0.0.6` 一一对应、哈希完全相同，包括内容寻址原文、披露、审批记录和下列五个冻结值：

| 文件 | SHA-256 |
| --- | --- |
| `native-clipboard-evidence.json` | `f294da7254e36c81d323749e063702475a521246f3f7ab172bcc2b6f25804dd4` |
| `license-exceptions.json` | `7f01b59c6e7d611961b6b2ef883c5213371b0e96c53e1088a3713d6e7c0c724d` |
| `license-exception-approval.json` | `56282e575719dacf144f8fca129d97d21724ed1fb4831f66a6004faeed0be2a6` |
| `release-gate.json` | `a73c5d10d72ede31b6d5ae02174fdb2a1922da3bd6e16f44b88d45f28dc34d8a` |
| `THIRD_PARTY_NOTICES.txt` | `473abd7ce568e0ec29f2c54fafbad0de6d91adf19e2b758adb6f86d3e9ee6856` |

Electron 的实际分发文件名为 `LICENSE.electron.txt`，不是必须名为 `LICENSE`。其 1,096 bytes、SHA-256 `5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d`，以及 `LICENSES.chromium.html` 的 20,313,957 bytes、SHA-256 `b911161e6594ec76b872498b423c54406168f2974e0d407a847f7de1e5ff94dd`，均与当前 Electron `43.4.1` 本地上游 dist 原文一致。

独立例外仅限四个精确 MIT 声明版本：`@mariozechner/clipboard@0.3.9`、`@mariozechner/clipboard-win32-x64-msvc@0.3.9`、`lazy-val@1.0.5`、`react-remove-scroll-bar@2.3.8`。完整上游版权/许可正文仍未恢复；SPDX MIT 模板明确不是上游 notice，没有填写推定版权人。该缺口继续构成法律和 attribution 风险，不因机械门禁或本报告而消失。

原生报告记录 121/121 crate 归档 checksum 验证；Reviewer 独立核对保留的 Cargo.lock 对应关系、文本哈希及选择记录，没有重下载全部归档、重编译 native 或证明 binary SBOM。保守 Windows/build closure 的正文/选择缺口为 0；其他 target 的 15 项缺口与 Apple SDK caveat 保持披露，不批准 macOS。OR 必须有明确保留的选择正文，AND 必须保留全部所需正文，WITH 不拆分忽略；不能将模板或选择说明误当上游正文。详见冻结的审批文件。

## Supervisor 执行、Reviewer 复核的实际安装证据

Supervisor 实际串行命令：

```powershell
node .agents/skills/windows-release/scripts/release.mjs verify --out release-0.0.6/build
node .agents/skills/windows-release/scripts/release.mjs smoke --out release-0.0.6/build
```

两命令均由 Supervisor 报告 exit 0。Reviewer 未重复启动产品或安装器，而是亲读真实文件、执行独立断言、检查四个原生 PNG 的 2,139 x 1,325 尺寸，并实际查看 first-start 与 v38-fixture-migration 两图。

最终证据：`%TEMP%\prw-installed-smoke-BtbQJ5\logs\installed-release-evidence.json`，SHA-256 `7f69e58aa96a37fabc9cc02ce70fdaf6cd2f809d767eb31ebcedebe269a87bda`。实际记录 `PASS`，UTC 开始 `2026-10-15T02:16:48.639Z`、结束 `2026-10-15T02:22:37.936Z`。

| 门禁 | 独立复核结果 |
| --- | --- |
| 原始 NSIS 安装 / 同版本重装 / 卸载 | 三个真实 EXE 退出码均为 0、signal 均为 null；非旧版安装器升级 |
| 四次真实启动 | first-start、restart、after-reinstall、v38-fixture-migration；均来自同一唯一 TEMP 下的安装 EXE，使用显式 `--prw-user-data-dir` |
| Renderer / IPC 隔离 | 四次均为 `workbench://app`；`process` / `require` / generic IPC / `window.electron` 均为 undefined；Main currentVersion、Core health、workspace status 均为 `0.0.6`，database ready |
| 验证连接 | Renderer CDP 仅 loopback `127.0.0.1`，证据记录精确进程归属核验；没有启用生产 Main inspector |
| 重启与重装数据 | 项目、任务 ID 与内容保留；任务 `in_progress`、revision 1；五个数据库检查均 migration id/count 39/39、integrity / foreign keys `ok` |
| 合成数据库迁移 | 仅在隔离 fixture 中撤去空的新资源表及 migration 39 记录以重建 v38，再由实际应用迁移到 39；备份实际哈希匹配；不是旧版安装器或任意历史用户库升级 |
| 旧 cache / 旧开发 profile | 12 阶段 aggregate 指纹全部与安装前相同；Reviewer 卸载后再次实际只读重算，两棵树仍相同；未移动、删除或恢复旧文件 |
| 卸载后当前状态 | Reviewer 实际重采快照与最终证据相同：产品进程、注册表、快捷方式为空；默认产品安装/profile 未出现在最终检查中 |

打包身份的证明是实际 EXE/fuses/ASAR、trusted Renderer origin、typed Main version、Core health 与隔离 SQLite 的组合；没有直接观察 Main `app.isPackaged`，不以 Renderer CDP 冒称可以读取该值。

卸载没有清空所有文件：唯一新生产 updater cache 保留 `installer.exe`，141,028,956 bytes，SHA-256 与本轮 Setup 相同；隔离安装目录保留 `Uninstall research-workbench.exe`。隔离 profile、日志、原生截图和数据库备份刻意保留。未对这些目录作递归删除，也未把这些残留描述为零残留卸载。该缓存不是原有 scoped cache。

## 未验收与交接

- 真实在线 Provider / OAuth、外部 MCP、Zotero / Obsidian 外部写入未执行；本地 Coordinator / SDK loopback 探针和 UI fixtures 不替代线上验收。截图中的 connector 状态也不是外部服务测试证明。
- unsigned 安装器、干净 Windows VM、真实 Windows 显示缩放矩阵、自动更新端到端、旧版安装器跨版本升级仍为独立门禁。应用 200% 缩放不等于 Windows OS 显示缩放；不宣称全壳层零裁切。
- 此记录只接受精确冻结候选及上述本机安装范围；远程 branch / tag / release assets 的身份、尺寸和哈希由 Supervisor 在实际推送/发布后另行核对。
- Reviewer 仅新增本报告；persistent roadmap、changelog、README、发布动作与最终状态由 Supervisor 负责。无关 dirty 内容不删除、不纳入产品完成声明。

Next receiving role：Supervisor / Desktop Backend / QA。下一步：在保留全部披露的前提下处理最终文档与用户授权的发布动作，并独立复核远程提交、tag 及精确安装资产；没有远程证据前不得声称发布已完成。
