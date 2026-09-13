# Task 1：last30days skill 接入与真实运行

状态：IN_REVIEW（实现与验证证据见下；最终 DONE 由 Supervisor 判定）

## 目标

使用仓库锁定的 `.agents/skills/last30days/skills/last30days` 版本作为 Agent 的唯一 last30days skill：按 `skillKey` 严格选择、无 key 可用降级、可选来源缺失非阻塞、失败可结构化诊断、简体中文正文、原始证据与 footer 逐字保留，且普通工作流不得误注入。

## 实现

### 1. skill 选择只由 `skillKey` 决定（`packages/workspace-service/src/skill-registry.ts` 新增）

- `resolveAgentSkill(skillKey, probe?)` 是唯一解析入口，返回判别式结果：
  - `null`/空 → `{ kind: 'none' }`，普通 run 绝不加载 last30days；
  - `'last30days'` → 完整解析 SKILL.md + 引擎 + 解释器，成功后返回 `{ kind: 'last30days', runtime }`；
  - 其他非空值 → `{ kind: 'unsupported' }` + `SKILL_UNSUPPORTED` 诊断。
- `agent-coordinator.ts` 的 `start()` 用该结果分支：`unsupported` 直接建 blocked run（`status: 'blocked'` + `error: "<message> (SKILL_MISSING)"`），不启动 runtime、不产生 tool 记录，并写入 ledger。
- 诊断代码：`SKILL_UNSUPPORTED | SKILL_MISSING | SKILL_ENGINE_MISSING | SKILL_PYTHON_MISSING | SKILL_PYTHON_TOO_OLD`（Python 下限 3.12）。
- `saveAutomationRule` 在写入期拒绝未知 `skillKey`（`VALIDATION_FAILED`），因此“无 skill”和“仓库锁定 skill”是 schedule 的仅有两个状态。

### 2. 路径解析与打包路径

SKILL.md 候选顺序：`PRW_LAST30DAYS_SKILL_PATH`（文件或目录，设置但不存在时直接以 `SKILL_MISSING` 阻断，不静默改源）→ `%REPO%/.agents/skills/last30days/skills/last30days/SKILL.md`（`%REPO%` = 含 `.agents/skills` 的仓库根：`probe.projectRoot`/`PRW_PROJECT_ROOT` 显式锚点，或从 cwd 逐级向上最多 8 层；打包进程 `PRW_PACKAGED_APP=1` 时不做向上查找）→ `<resourcesPath>/skills/last30days/skills/last30days/SKILL.md`（仅构建镜像）。
解释器候选：`PRW_LAST30DAYS_PYTHON` → `python3.13/python3.12/python3/python`（`where.exe`/`which`）→ Windows 安装根（`%LOCALAPPDATA%\Programs\Python\Python3*`、`%PROGRAMFILES%\Python\Python3*`、`C:\Python3*`），探测结果缓存 5 分钟。
绝对路径只注入子进程（prompt/`env`），写入 ledger 的文本一律经 `labelDiagnosticPath` 变成 `%REPO%`/`%RESOURCES%`/`%TEMP%`/`%LOCALAPPDATA%` 等 token（`redactAgentText` 会遮蔽 `C:\...`，因此不能直接写原始路径）。

### 3. 执行 profile（`packages/agent-runtime/src/index.ts`）

- skill run 的有效权限固定为 `auto`，但**持久化的 `permissionMode`/`toolProfile` 保持 schedule 原值**，避免破坏会话 `toolProfile` 校验（Codex：`--approve-for-me`，与 `--sandbox` 互斥，实测同时传会 exit 2；额外 `-c sandbox_workspace_write.network_access=true` 提供网络。Pi：`--approve --tools read,grep,find,ls,bash,write`，不含 `edit`）。
- 不打开 `danger-full-access`，不打开外部写回；有效 profile 写入 `run:skill` ledger 记录（含“执行 profile: workspace-write 沙盒 + 网络开启 … 不使用 full-access”）。

### 4. 隔离输出目录与 prompt

- `--save-dir=<runDir>/skill-output`，同时注入 `LAST30DAYS_MEMORY_DIR`/`LAST30DAYS_PYTHON`；引擎的 `.last30days-library.db` 与 raw markdown 只落在这里，不写用户 `~/Documents/Last30Days`，两次 run 互不污染。
- `buildLast30DaysSkillBriefing()` 固定解释器、引擎路径、隔离目录与整套参数：`--emit=compact --auto-resolve --no-browser-cookies --save-dir=… --save-suffix=v3`；约束包括禁止 `--mock`/安装工具/交互、Partial Coverage 原样保留、badge 与 PASS-THROUGH FOOTER 逐字保留、简体中文叙述、不读取/输出凭据、不输出 `EVIDENCE FOR SYNTHESIS` 内部结构。`--no-browser-cookies` 是新增的隐私默认（不提取浏览器 cookie，代价是 X 覆盖下降）。
- PowerShell 下 `"exe" "script"` 形式会被当成表达式解析；约束 1 已加入“用调用运算符 `&` 执行同一命令”的提示。真实 run 的实际流程是：模型先用未加 `&` 的形式调用（PowerShell 解析失败），随后用 `&` 重跑同一命令成功——提示是事后根据这个真实观察追加的，追加后仅用 smoke 的 prompt 断言与 `--dry-run` 复核了 briefing 文本（未再跑一次模型）。

### 5. 打包

`apps/desktop/electron-builder.yml` 的 `.agents/skills → skills` 增加 filter：排除 `**/.git/**`、`**/__pycache__/**`、`**/*.pyc`、`**/last30days/assets/**`（14M 演示媒体，SKILL.md 未引用）；`references/` 保留（SKILL.md 2062/2157 行要求 `references/save-html-brief.md`）。打包后 `resources/skills` 7.1M，引擎、`scripts/lib`、`references` 都在。

## 验证证据

全部在本机真实执行（Node v24.15.0 / Python 3.13.5）。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `pnpm typecheck` | PASS（全部 workspace 包 + `apps/desktop` `tsc -b`） |
| 构建 | `pnpm build` | PASS |
| 应用 e2e | `pnpm test:e2e` | PASS（含 `schedule default/daily/pause-enable: ok`） |
| skill 契约 | `node scripts/last30days-skill-smoke.cjs --network --packaged=<win-unpacked>/resources` | 17 passed / 0 failed / 0 blocked / 0 skipped |
| 应用级 skill 路径 | `node scripts/last30days-skill-run-check.cjs` | 8 passed / 0 failed |
| 真实 CLI run | `node scripts/last30days-skill-cli-run.cjs --runtime=codex`（随后用 `--replay` 复核断言） | 6/6 PASS |
| 打包布局 | `electron-builder --win --dir -c.directories.output=<temp>` | 成功，`resources/skills` 7.1M |

- 解析：仓库检出解析为 `python3.13`（3.13.5，来源 `path`），skill 来源 `project`；把 cwd 指向不存在的目录、只给 `resourcesPath` 时，解析到 `…/win-unpacked/resources/skills/last30days/skills/last30days/SKILL.md`，来源 `packaged`（真实打包树，非 fake）。
- 引擎：`--help` exit 0 且文档化 `--emit`/`--preflight`；`--preflight --save-dir=<temp>` exit 0、`Status: Ready…`、不写任何文件；引擎路径缺失 exit 2（不会静默成功）；真实无 key 运行 15–18s exit 0，`Sources: 2 active (Hacker News, Reddit)`，save dir 得到 `local-first-research-workbench-raw-v3.md` + `.last30days-library.db`，badge 在第 1 行、footer 存在、无 Partial Coverage 时不得伪造成功（`Sources: none` 时脚本强制要求 Partial Coverage）。
- 真实 Codex run（`--runtime=codex`，模型默认，2026-09-13）：exit 0 in 422,709 ms，54 个 JSON 事件、4 次引擎调用；最后一次以固定参数写入本次隔离目录；最终回答首行即 `🌐 last30days v3.22.0 · synced 2026-09-13`，`✅ All agents reported back!` footer 逐字保留，未输出原始证据块/`### n. (score …)` 证据列表/额外 Sources 列表；正文简体中文（Han 615 / latin 789），并如实写出覆盖边界（Reddit timeout、Web unreachable、X/Twitter 与 YouTube 未覆盖、13 条证据中仅 4 条在 7 天内）。usage：input 1,771,921（cache 1,627,648）、output 10,146 —— 一次无人值守 run 的真实成本量级。
- 应用级（隔离 profile 启动构建产物，走真实 preload bridge）：
  - 内置 schedule 的 `skillKey === 'last30days'`（topic `research updates`，permission `read-only`）→ `automation.runNow` 得到 `status: 'blocked'`、`error: "… (SKILL_MISSING)"`，ledger 有 `run:skill-diagnostic`，detail 列出 `PRW_LAST30DAYS_SKILL_PATH` 与“项目路径”，路径渲染为 `%TEMP%…` 等 token，无绝对路径落库，且未产生任何 tool 记录。
  - 未知 `skillKey` 在保存期被拒绝：`Unknown skillKey "not-a-real-skill"; only null or "last30days" can be stored.`
  - 用真实 skill 路径时 run 正常启动，ledger `run:skill` 记录含 interpreter（`…\bin\python3.13.exe（3.13.5，来源 path）`）、隔离 `skill-output`、执行 profile；随后 `runs.cancel` 停止该 run（不消耗模型预算）。

## 结论与未验证项

- 已完成：按 `skillKey` 的严格选择、结构化失败诊断、打包路径、隔离输出、真实无 key 降级、真实 Codex 运行与输出契约、应用级 blocked/ledger 行为。
- BLOCKED / 未验证（不得当作已完成）：
  1. **Pi 真实 run 未执行**：本轮只真实验证了 Codex；Pi 侧仅验证了参数面（`--help`/工具列表）与命令拼装，Pi 端到端 run 待补。
  2. **真实调度器 tick 未观测**：验证走 `runNow`，未等待 cron 到点触发。
  3. **NSIS 安装包 smoke 未做**：`AGENTS.md` 要求发布级改动做真实安装/启动/重启/卸载 smoke；本轮只验证了 `--dir` 打包后的 resources 布局。
  4. `.agents/skills/last30days` 在 git 中是未跟踪状态（`?? .agents/skills/last30days`）：干净 clone 不含该 skill，打包/入库策略需 Supervisor 决定。
  5. 失败路径未覆盖“有 SKILL.md 但引擎/解释器缺失”的应用级 run（这两条在脚本层已覆盖诊断，应用级只覆盖了 SKILL_MISSING）。

## 附带发现（未改代码）

- git-bash 下 `env -i` 启动 python 会 `WinError 10106`（MSYS 路径/环境伪化），**不是 PRW bug**：node 以 app allowlist 环境 spawn 的 python 对同一域名返回 HTTP 200，应用内 allowlist 环境也能真实取到 HN/Reddit 来源。注意：真实 Electron 子进程与 MSYS `env -i` 的环境形态不同，排查网络问题时不要复用 `env -i` 结论。
- `runs.cancel` 后 run 状态落成 `failed`（kill 与子进程 `close` 处理器竞争，`packages/agent-runtime/src/index.ts` 的 `finish` 竞态），与 skill 选择无关，属既有行为，本轮未修。
- 一次无人值守 run 的模型成本较高（见上 usage），若要每日执行建议评估 `--quick`/模型档位。

## 验收命令

```powershell
pnpm typecheck
pnpm build
pnpm test:e2e
node .agents/skills/last30days/skills/last30days/scripts/last30days.py --help
node .agents/skills/last30days/skills/last30days/scripts/last30days.py --preflight --save-dir <隔离目录>
pnpm test:last30days              # 离线契约
pnpm test:last30days:network      # 追加真实无 key 联网
pnpm test:last30days:app          # 应用级 skillKey/ledger（不调用模型）
pnpm test:last30days:cli          # 真实 Codex/Pi run（消耗 token，opt-in）
```
