# 多助手与协作团队接入

日期：2026-10-15。状态：`IN_REVIEW`。本次采用用户接受的 v2 目标，增加 PRW 原生多助手与有界只读团队，不引入 Python 双运行时、第二套 HTTP 后端、OpenMAIC 依赖或 pi-web。

## 基线与实施差异

- 交接时 SQLite 已有 migrations 1–37，因此使用 additive **migration 38**，不能覆盖方案预估的 33。原 Pi 设置、会话、运行和账本保留。
- 第一阶段仅有用户提供的功能规格及 Git 历史基线；随后用户补充真实来源，两者均已只读访问：远程 `3276166289-code/research-workbench/web` 与局域网 `qitu-zhixue/apps/admin-console/app/(console)/settings`。本次采用原生 PRW 实现，不宣称逐 TSX 复制或字段完全等价；详细对照与矩阵增量见 [实现 28](28-source-design-and-binding-matrix.md)。
- 远程 `main` 固定到 `420225bb9e98726675c74a0f9fb7141e78d5abb8`，其 `web/index.html` SHA-256 为 `2459c44bf9112ab73b4621327a72f058f0069dd052f382cc2a07a3b0a69a7de6`。文件与下载参考一致；未恢复用户已删除的 sidecars。局域网来源基线为 `587dbabcb2b5a1598b156f6affd97787e23d9a33`，未修改源项目。
- [P0 设计令牌与功能合同映射](../design/AI_ASSISTANT_TEAM_MAPPING.md) 已记录上述边界。既有 Shell、双主题、主色派生和字号偏好继续作为权威，不新建平行主题系统。
- 用户后续要求设置全部改为侧边栏导航，按本轮前端增量一并实施；验收结果记录在下节。

## 已实现链路

| 层 | 路径 | 当前行为 |
| --- | --- | --- |
| 合同 | `packages/contracts/src/agent-profiles.ts`、`agent.ts`、`index.ts` | 严格 DTO、revision/确认归档、绑定 catalog、团队状态及 run 身份；新字段兼容旧历史 |
| 数据 | `packages/database/src/migrations.ts`、`schema.ts`、`agent-profile-repository.ts`、`repository.ts`、`research-repository.ts` | migration 38、配置/绑定/成员原子保存、CAS、有效配置快照、请求指纹、重启中断投影 |
| 服务 | `packages/workspace-service/src/dispatcher.ts`、`agent-coordinator.ts`、`agent-teams.ts`、`agent-models.ts`、`host.ts` | V2 命令面、助手固定会话、总预算/超时/取消、独立 child ledger、凭据 fresh read、关闭清理 |
| Pi | `packages/agent-runtime/src/index.ts`、`pi/adapter.ts`、`pi/tools.ts`、`pi/credential-store.ts`、`pi/models.ts` | 每助手 settings/session、共享 models registry、工具收窄、取消信号、跨实例 Provider 刷新锁 |
| IPC | `apps/desktop/src/preload/index.ts` | `v2.assistants`、`v2.agentTeams`、`v2.agentBindings`，入参和返回值校验；不开放通用 IPC |
| Renderer | `features/research/agent-profiles.tsx`、`features/research/settings.tsx`、`features/agent/index.tsx`、`styles.css` | 四设置面板、选择器、团队状态/停止/子运行、宽屏历史/主线/轨迹三栏、原生 Provider 卡 |
| 验证 | `packages/database/tests/agent-profiles.test.ts`、`packages/workspace-service/tests/agent-profiles-dispatcher.test.ts`、`agent-teams.test.ts`、`packages/agent-runtime/tests/assistant-credentials.test.ts`、`scripts/e2e-agent-profiles.cjs` | 本地行为测试和隔离 Renderer/Preload/Core smoke |

Renderer 路径相对于 `apps/desktop/src/renderer/src/`。没有新直接依赖或 lockfile delta；Pi 两包仍使用项目锁定版本，未复制 GPL/AGPL 源代码。完整既有传递依赖许可门禁不被本次 diff 审查替代。

## 安全与执行语义

- Provider/model 同时选择或同时继承；普通助手 Thinking null 在启动时继承默认值。团队一次事务冻结有效配置，包括 null Thinking，不再从后续默认值补齐。
- 团队 2–8 个唯一成员、恰好一个 director、预算 2–12 次总模型调用。director 无工具，只返回严格 delegate/finish JSON；成员工具与只读安全策略取交集。模型不能改成员、权限或 Provider。
- 每 child 都是新的助手固定会话，身份先于模型调用持久化。跨助手 conversation/resume 拒绝。父运行终态不可重开，晚到 child 只能追加审计链接。
- 空工具绑定是零工具。助手隐式 skill/extension 扫描禁用；只注入受控绑定指令，不获得 shell/Python engine。远程 MCP 明确不支持。
- 单 child 默认超时 5 分钟，包含凭据/SDK 启动；团队默认 30 分钟。取消信号覆盖启动和 prompt。关闭和重启仅标记中断/取消，不自动重放收费调用。
- 启动幂等比较规范化原始请求 SHA-256，不比较脱敏后文本。旧单运行没有指纹时拒绝幂等重放；使用新键重新发起，不修改/猜测旧历史。
- 凭据仅由 Main `safeStorage` 管理。运行与设置登录/退出按 app profile + Provider 共享 Core 内 mutation lock，锁内重读 Main 最新单 Provider 值。这不是跨进程原子 vault CAS 或真实 OAuth 成功证明。
- Packaged `workbench://app` sender、validated profile flag、IntegrationCoordinator 确认写边界未扩大；团队不开放本地/外部写入。

## 可执行证据

以下为 Supervisor 在第一阶段多助手/团队快照实际执行的命令，不计 `pnpm test` 空入口。后续整体设计/矩阵及消息快照修复的最终冻结结果在 [实现 28](28-source-design-and-binding-matrix.md) 单独登记（profiles 42/42、Pi 57/57）；不得把下表较早快照当作后续完整验收：

| 命令 | 结果 |
| --- | --- |
| `pnpm test:agent-profiles` | PASS 30/30：v37→38 升级、FK/integrity、重启持久化、CAS、快照、幂等、预算、非法成员、取消/晚到 child/关闭、工具隔离与跨实例凭据刷新 |
| `pnpm typecheck` | PASS，10 个 workspace 项目（最终前端调整后需重跑结果见下节） |
| `pnpm build` | PASS，Main/Core/Preload/Renderer（最终前端调整后结果见下节） |
| `pnpm test:agent-runtime-pi` | PASS 54/54 |
| `pnpm test:agent-credentials` | PASS 13/13 |
| `pnpm test:agent-custom-providers` | PASS 4/4，真实嵌入 SDK + 本地 fixture registry，不是模型生成 |
| `pnpm test:agent-scheduled-credentials` | PASS 7/7 |
| `pnpm test:agent-settings` | PASS 8/8 |
| `pnpm test:workspace-mcp-agent-surface` | PASS 4/4 |
| `pnpm test:agent-external-actions` | PASS 24/24，模拟 connector 端口，不是真实外部写入 |
| `pnpm test:agent-history-delete` | PASS 6/6 |
| `pnpm test:agent-ledger-grouping` | PASS 4/4 |
| 相关路径 `git diff --check` | PASS，仅 LF/CRLF 提示 |

第一阶段独立 Review/Security 在相同后端冻结树执行 `test:agent-profiles` 30/30、`test:agent-runtime-pi` 54/54；同次审查执行 scheduled credentials 7/7、credentials 13/13、MCP 4/4，全部 PASS。独立结论 **APPROVE，限本地多助手/只读团队门禁，不是发布批准**，作者未自批。后续矩阵最终后端已重新独立执行 profiles 42/42、Pi 57/57、完整 typecheck 并获限定批准，详见实现 28。

独立 pinned Pi SDK + localhost **MOCK Provider** 探针（隔离目录，无个人凭据）：prompt 前取消 AbortError、请求 0、client close 1；运行中取消请求 1、累计 close 2、终态 canceled、unhandledRejections 空数组，exit 0。机器本地临时证据 `prw-pi-final-review-UopIPn/review-evidence.json`；不提交个人绝对目录，不表示真实 Provider/OAuth 验收。

### 第一阶段界面、打包与发布历史

第一阶段最终 `pnpm typecheck`、`pnpm build` 已通过。`pnpm test:e2e:agent-profiles` 通过 11 个真实 Renderer/Preload/Core 工作流、28 张截图，console/page errors 为空：全部 16 个设置分区均为左侧导航，包含键盘、脏草稿保护、助手/团队/绑定 CAS、重启持久化、确认归档及无凭据团队的真实失败与 child ledger。浅/深主题覆盖 1440/1024/720/320 外窗宽度及大字号，无横向文档溢出。证据为临时目录 `prw-agent-profiles-e2e-v3jt6f/agent-profiles-evidence.json`。前端作者与独立 reviewer 分别进行了截图/源码审查，独立 reviewer 未宣称亲自执行此 E2E。

第一阶段旧 `test:e2e` 两次失败分别是轨迹按钮旧唯一性断言和 `.agent-hint-link.first()` 错点新“收起”按钮。脚本已改为精确模型设置 deep-link 和设置侧栏断言，未绕过真实导航或删除凭据/模型发现检查；这些失败不能算通过。后续整体样式/矩阵与命令浮层修复已重新构建并执行完整双 E2E；同一最终构建专项 PASS 33 个工作流/136 张原生截图、Supervisor 全应用 `pnpm test:e2e` PASS exit 0，详见 [实现 28 最终冻结门禁](28-source-design-and-binding-matrix.md)。最终 profiles 42/42、Pi 57/57、10 项目 typecheck 和 build 均 PASS；独立 reviewer 已批准限定本地功能与 Renderer/UI，无未关闭本地阻断项。第一阶段 30/54/28 图仅保留为历史，不替代最终证据。

第一阶段尝试隔离输出 Windows NSIS 构建：`pnpm --filter @prw/desktop exec electron-builder --win nsis --x64 --publish never '-c.directories.output=../../release-0.0.5/assistant-team-20261015'`。在 Electron 解压后重命名 `win-unpacked.tmp` 时发生 `EPERM`，未产生新的 Setup.exe；真实 install/start/restart/profile/uninstall **NOT RUN**。保留已有发布产物及源工作区，不执行全局进程终止或目录清理。此结果不代表当前新增整体设计/矩阵快照已经打包。

## 未完成门禁与下一接收方

- 真实 Provider 完整团队协作、真实 OAuth 轮换刷新与现场团队取消：NOT RUN。所有模型/凭据 fixture 都明确为测试值。
- admin-console 原 TSX/契约已可只读检查；采用 reference-only 的原生重写，不是逐文件复制或完整平台 parity。其浏览器技能文件编辑与任意 MCP command/env/header 配置不是 PRW 已实现能力，详见实现 28。
- Windows x64 NSIS install/start/restart/profile/uninstall、已安装页面回归、代码签名及发布：未验收；不能用 Electron 开发构建替代。打包资源仍引用基线已删除的 `sidecars/`，未擅自恢复或删改打包策略。
- 全 11 页面整体视觉调整与绑定矩阵属于用户追加要求，验证以实现 28 最终快照为准。远程 MCP、并行团队、durable outbox/三方冲突、后台常驻调度仍未实现。

Next receiving role：QA `.agents/roles/qa.md`、Review/Security `.agents/roles/review-security.md`，发布由 Desktop Backend `.agents/roles/desktop-backend.md` 接收。

Suggested next step：最终本地前端/后端与双 E2E 证据已在实现 28 合并；由 QA 使用专用凭据和隔离 profile 完成真实 Provider 的只读团队/取消，再由 Desktop Backend 完成安装器闭环，保留 `IN_REVIEW` 到完整门禁成立。
