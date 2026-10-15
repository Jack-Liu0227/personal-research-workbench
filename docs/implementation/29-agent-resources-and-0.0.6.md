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

0.0.6 安装包、实际安装 smoke、远程提交/tag/release 的结果在执行后追加，不能以本文存在推断通过。发布使用原始生产熔丝，不为测试启用 Main inspector；安装 smoke 使用精确子进程与 loopback Renderer CDP，Main isPackaged 不可通过 app.evaluate 直接观测，必须分别报告静态包配置与真实 Renderer/落盘证据。

安装预检发现本机既有 `@prwdesktop-updater/installer.exe`，未覆盖/移动/删除。正式生产配置新增 `extraMetadata.name: personal-research-workbench`，修正 workspace scoped npm 名称污染 updater cache 的问题；源 workspace 名称仍为 `@prw/desktop`。独立 reviewer 亲读 builder metadata merge/AppInfo/NSIS/PublishManager，批准此候选配置后重建，要求实际 ASAR package name、app-update.yml 与 NSIS cache define 三处核对一致，旧缓存只读指纹不变；这不是安装/发布批准。AppId、productName、EXE、默认 profile 不变，旧版缓存不自动迁移，内部包归档名称随新 metadata 名改变。

- 真实在线 Provider/OAuth、真实外部 MCP/Zotero/Obsidian 写入未执行；本地 SDK fixture 不替代这些证据。
- 真实 Windows OS 显示缩放矩阵未验收；Electron 200% 是应用缩放。已知 200% Agent 顶部长模型 pill 可截断，新增保存/审批控件可达，不宣称全壳层零裁切。
- 安装器无 Authenticode 签名；自动更新端到端、旧版安装器升级单独报告。相同版本重装不叫跨版本升级，SQLite 38→39 迁移测试不叫安装器升级。
- 发布时保持无新增生产依赖；完整生产许可证盘点/notice 见 `docs/legal/0.0.6/`，不能仅凭顶层 package 的 license 推断全部合规。
- 未授权重置/清理工作区；原有 sidecars、artifacts 删除和其他用户变更保留且不混入提交。

Next receiving role：QA、Review/Security、Desktop Backend。下一步为原始 x64 NSIS 安装、启动、重启、重装与卸载，并核验远程资产身份。
