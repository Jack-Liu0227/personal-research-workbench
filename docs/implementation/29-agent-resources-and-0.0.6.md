# 29 - MCP、指令技能与 0.0.6 发布验收

日期：2026-10-15。本文是实现 27/28 的后续增量，不覆盖其历史失败记录。
Supervisor 负责契约、Main、数据层和发布协调；Frontend/Agent Runtime 分别负责界面与运行时，独立 Review/Security 不参与产品代码编写。

## 实际范围

- 科研工作 1.0 设计参考式重构保留 11 个页面、双主题、主色推导、三栏 Agent、Provider 卡；全部 16 个设置分区为左侧导航，不改为顶部 tabs。
- 多助手配置、有界只读 director-loop 团队、工具/技能跨助手矩阵，沿用 migration 38；不是纯前端开关，下一次 Pi run 按冻结配置加载，CAS 冲突不部分保存。
- migration 39 新增第三方 MCP HTTP 服务、SQLite 指令技能、待批准调用/结果收据。现有数据库迁移编号已到 39，不使用最初方案里的过期编号 33。
- 第三方 MCP 只支持 Streamable HTTP：公网 HTTPS 或显式 loopback HTTP；拒绝重定向、私网/metadata、DNS 重绑定、URL 凭据/query/fragment。不支持 stdio、任意 command/args/env/headers。
- 保存/列出/开始 run 不自动探测网络；用户显式探测后才能在矩阵授权。配置/凭据/工具 schema 改变会失效旧探测与授权身份。
- 远端工具一律视为不可信外部请求，不相信 readOnlyHint。只提供给 approved-write 的普通手动助手；团队、计划任务和只读助手均不可用。
- 模型调用只创建待确认请求；用户单独批准后按冻结 endpoint/revision/schema/args hash/assistant/run/expiry 执行一次。拒绝、失败、取消、重启失效，CAS 防重复；不重试、不追加模型轮次。已完成普通 run 可批准其有效请求。外部副作用不可撤销，取消不等于回滚。
- 用户安装/编辑的 SKILL.md 仅为经显式审阅的纯文本指令，存 SQLite；不运行代码、不安装 Git/npm、不读任意文件。内容修改原子撤销助手绑定并增加 revision，重新启用不自动重新授权；团队快照发生技能 revision 漂移时 fail closed。
- Main safeStorage 保管 Bearer token，Renderer/Core 普通 RPC 不可读取。凭据采用 staged/active envelope 和逐服务锁，配置 CAS 成功后才激活；崩溃孤儿、同 revision 后续配置、过期保存不得继承或删除其他有效凭据。
- Python sidecar 明确退役：兼容端点固定 error，无启动按钮/进程；不恢复用户原有删除文件，不把 sidecar 打进安装包。Python Scholar 来源明确不可用，其余检索来源保留。

非目标：任意代码技能、MCP stdio、无人值守外部写入、并行团队、pi-web、多用户权限系统、Python 运行时恢复。两来源仅作设计/语义参考，未把许可不明确的源文件直接复制进产品。

## 源码门禁（实际执行）

| 命令/范围 | 结果 |
| --- | --- |
| `pnpm typecheck` | 10 个 workspace 工程 PASS |
| `pnpm build` | 0.0.6 production Main/Core/Preload/Renderer PASS |
| `pnpm test:agent-resources` | 27/27 PASS；包含真实 Pi/HTTP SDK loopback、凭据反射 8 个组合 |
| `pnpm test:agent-profiles` | 42/42 PASS |
| `pnpm test:agent-runtime-pi` | 57/57 PASS |
| 凭据、Workspace MCP、外部动作、计划凭据组合 | 48/48 PASS |
| `node .agents/skills/windows-release/scripts/verify-packaging-filter.mjs` | 7 项 PASS，含排除用户未跟踪 PRW-PIN.md |
| `node scripts/e2e-agent-profiles.cjs` | 33 工作流、136 原生截图 PASS；隔离 profile `prw-agent-profiles-e2e-iijqvu` |
| `node scripts/e2e-agent-resources.cjs` | 6 工作流、18 原生截图、132 控件焦点/命中/边界 PASS；`prw-agent-resources-e2e-WC9Zpg` |
| `node scripts/e2e-electron.cjs` | PASS exit 0；`prw-workbench-e2e-oHoZPG`，含 11 页面/320–1440px/侧栏/真实 IPC 持久化 |

资源 E2E 经真实 Renderer/Preload/Core、SQLite、safeStorage 和 Pi/MCP SDK；Provider 与 MCP 为随机 loopback fixtures。覆盖增删改、失败/成功探测、凭据写入/清除、CAS 草稿、原子撤权/重新绑定、完成后批准/拒绝/关闭确认、单次执行、实时取消、重启/删除不丢历史。此前两次因主题/历史定位错误失败，修正测试定位后从 fresh profile 完整重跑，没有跳过布局或重启断言。

独立 reviewer 亲自执行旧组合 42/42，并亲自以真实 Coordinator + MCP SDK + loopback HTTP 执行修复后的 8/8 凭据反射探针（不加载 native addon）；本地后端限定 APPROVE。独立亲读新 E2E JSON、18 PNG 实际尺寸/132 控件记录并查看六图，新增 UI 限定 APPROVE；并非冒称 reviewer 运行 E2E。

| 冻结构建资产 | SHA-256 |
| --- | --- |
| `apps/desktop/out/main/core-worker.cjs` | `4A51BDF847DB8B07E514B2B7E53662BECD85F9197BD43F6E95C000B2F90E718B` |
| `apps/desktop/out/renderer/assets/index-8mz7StkS.js` | `D77237821CF8D8AA0049D94EFA6489CC1D5D8DECB9B422F3CB1FA4C0E975356E` |
| `apps/desktop/out/renderer/assets/index-CIwq4ef1.css` | `5937751E35F225CAEAE54F62BFB4EE210EF87543EF3AFCBA5E320A404AE09A4C` |

## 发布门禁与剩余边界

0.0.6 实际安装 smoke 已通过，远程提交/tag/release 在执行后另记，不能以本文存在推断已发布。发布使用原始生产熔丝，不为测试启用 Main inspector；安装 smoke 使用精确子进程与 loopback Renderer CDP，Main isPackaged 不可通过 app.evaluate 直接观测，分别报告静态包配置与真实 Renderer/落盘证据。

安装预检发现本机既有 `@prwdesktop-updater/installer.exe`，未覆盖/移动/删除。正式生产配置新增 `extraMetadata.name: personal-research-workbench`，修正 workspace scoped npm 名称污染 updater cache 的问题；源 workspace 名称仍为 `@prw/desktop`。独立 reviewer 亲读 builder metadata merge/AppInfo/NSIS/PublishManager，批准此候选配置后重建，要求实际 ASAR package name、app-update.yml 与 NSIS cache define 三处核对一致，旧缓存只读指纹不变；这不是安装/发布批准。AppId、productName、EXE、默认 profile 不变，旧版缓存不自动迁移，内部包归档名称随新 metadata 名改变。

- 真实在线 Provider/OAuth、真实外部 MCP/Zotero/Obsidian 写入未执行；本地 SDK fixture 不替代这些证据。
- 真实 Windows OS 显示缩放矩阵未验收；Electron 200% 是应用缩放。已知 200% Agent 顶部长模型 pill 可截断，新增保存/审批控件可达，不宣称全壳层零裁切。
- 安装器无 Authenticode 签名；自动更新端到端、旧版安装器升级单独报告。相同版本重装不叫跨版本升级，SQLite 38→39 迁移测试不叫安装器升级。
- 发布时保持无新增生产依赖；完整生产许可证盘点/notice 见 `docs/legal/0.0.6/`，不能仅凭顶层 package 的 license 推断全部合规。
- 未执行重置/广泛清理；用户批准后只提交已审查的旧 sidecars、artifacts 与根目录过期产物删除，见[清理记录](30-repository-cleanup.md)。无关 `pnpm-workspace.yaml` 占位编辑与 last30days 未跟踪 `PRW-PIN.md` 保留本地，不提交、不打包。

## 实际 NSIS 包与安装验收

生产输入提交：`8e7450cc08be615149cd43ec0ea6aa76d30a046a`。其后仅更新不进入载荷的验收文档；tag 可包含这些文档，但不能改动已验收产品输入。

| 实际命令/产物 | 结果 |
| --- | --- |
| `node .agents/skills/windows-release/scripts/release.mjs build --skip-gate --out release-0.0.6/build` | exit 0；此前本轮完整 typecheck/build 已重跑通过，生产输出哈希不变；不是声称 helper 内重复执行门禁 |
| `node .agents/skills/windows-release/scripts/release.mjs verify --out release-0.0.6/build` | exit 0；实际 ASAR/更新缓存/NSIS define/日志和配置 receipt/许可证/禁自动启动一致 |
| `node .agents/skills/windows-release/scripts/release.mjs smoke --out release-0.0.6/build` | exit 0；2026-10-15 02:16:48–02:22:37 UTC，真实安装、4 次启动、重装、迁移和卸载 PASS |
| Setup | `Personal-Research-Workbench-0.0.6-Setup.exe`，141028956 bytes，ProductVersion `0.0.6`，Authenticode `NotSigned` |
| Setup SHA-256 | `B1F0D99AFAF50D498064AD009F71B0589EF71B8A07E3BA67EA6BD18018BC60E3` |
| blockmap | 149849 bytes；SHA-256 `7861276A1B462584354CBBEFBA5515CFDEBCEB71778426A4C69F6A62AE8F1A02` |
| latest.yml | SHA-256 `558FE7A5B72EFE04D73791B09AA3E249BD7EBA261506F1A55FAF81E48F476C2C`；记录版本/大小与 Setup SHA-512 |
| app.asar | 136883269 bytes；SHA-256 `b8a3175b989155d99d5196c49764500d3faa07008e97f891e481d14d167e44d5` |

默认 electron-builder 路径直接成功，没有 electronDist fallback，没有 `default_app.asar` 偏差。真实 makensis 两次调用均含正确产品缓存与 `HIDE_RUN_AFTER_FINISH`，不含 `RUN_AFTER_FINISH`/`ONE_CLICK`。保留原始生产熔丝；包内没有 sidecars、发布 skill、PRW-PIN、Git 历史或 pyc。独立 reviewer 亲自核验 7 个应用输出、1808 个 Pi unpacked 文件 integrity、280 个 legal 文件及 242 个 skill 文件；Electron/Chromium notice 逐字节与 Electron 43.4.1 本地官方 dist 一致。

安装 smoke 只使用新建 `%TEMP%/prw-installed-smoke-BtbQJ5`，证据为其 `logs/installed-release-evidence.json`（20245 bytes，SHA-256 `7F69E58AA96A37FABC9CC02CE70FDAF6CD2F809D767EB31EBCEDEBE269A87BDA`），保留 4 张原生截图和 stdout/stderr。隔离安装 EXE 的四次实际启动均为 `workbench://app`，Main typed version 与 Core health 都是 `0.0.6`，Renderer 的 process/require/raw IPC/electron 均 undefined；故意注入的无效开发 Renderer URL 未被使用。

- 首次安装、同版本重装、卸载各 exit 0；创建项目和任务并移动到 `in_progress`，revision 1，重启/重装后真实 SQLite 与界面均保持。
- 数据库 39 条 migration、`integrity_check` 和 foreign key 检查全部通过；合成 v38 库经真实安装 EXE 升为 v39，项目/任务仍在。合成数据迁移与同版本重装均不是旧版安装器升级证据。
- 卸载后产品进程、注册、快捷方式均回到空基线，真实默认 profile 未出现；刻意保留隔离 profile 与日志。即时观察安装目录仍有 `Uninstall research-workbench.exe`，新产品 updater cache 也保留：不是宣称所有文件零残留，更未自动删除。旧 scoped cache 与旧开发 profile 的全部内容/元数据指纹在 12 个阶段不变。
- Windows PowerShell 7 不可用，helper 回退到系统 Windows PowerShell，仅用于只读检查与精确 PID 身份核验/关闭，不降低生产熔丝。

许可证机械门禁 `PASS_WITH_DISCLOSED_EXCEPTIONS`：288 组/294 个精确 npm 版本/254 份原文；Windows 与构建闭包 native 缺口 0，15 个其他目标缺口保留且不批准相应平台。4 个 MIT 原文/署名缺失例外由独立 reviewer 限当前 Windows x64 版本接受，见 `docs/legal/0.0.6/`；不是二进制 SBOM、可复现构建或法律保证。

构建日志、receipt、配置副本和 `source-equivalence.json` 保留在忽略的 `release-0.0.6/`：包内全部 7 个应用构建文件（5844739 bytes）与已测试输出逐字节相同；跟踪的生产源码、lockfile、legal 与 skills 未改。无关 workspace 占位编辑并非该安装包的安装输入，也不会发布到远程；现有 submodule 精确提交未变，其 PRW-PIN 被过滤。

独立 Review/Security 已亲自运行只读断言、重算旧两树指纹并核对现状 snapshot；对该精确 SHA-256 的实际包与本机 NSIS smoke 给出限定 APPROVE，详见[独立发布审查](31-independent-0.0.6-release-review.md)。reviewer 没有运行安装器/Electron，不冒称独立重新安装。该批准不涵盖签名、clean-VM、旧版升级、在线服务或自动更新；改变生产/依赖/打包输入必须重新验收。

Next receiving role：Supervisor 核对 branch/tag/GitHub Release 资产；真实在线服务、代码签名、跨版本安装升级与自动更新仍单独验收。
