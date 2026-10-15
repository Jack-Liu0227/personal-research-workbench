# Quick Start

> 0.0.6 当前增量：第三方 Streamable HTTP MCP、SQLite 指令技能已接入。下文早期“远程服务尚不支持”仅为历史边界，现以本节及[实现 29](implementation/29-agent-resources-and-0.0.6.md)为准。
>
> 在「工具与 MCP 绑定」添加 HTTPS（或 loopback HTTP）服务，保存后单独设置 Bearer token、显式探测，再在矩阵授权给 approved-write 手动助手。模型只提出待审批请求，用户在 Agent 中确认后才执行一次。团队、定时任务和只读助手不可用；禁止 stdio、命令与自定义 headers。
>
> 在「技能绑定」新建/编辑纯文本 SKILL.md，先预览并明确审阅保存，再在矩阵启用。文本存 SQLite，不安装或运行脚本；内容修改会撤销绑定，必须重新授权。全部设置保持左侧导航。旧 Python sidecar 已退役，不随包运行。

Personal Research Workbench 是 Windows 本地优先的 Electron 工作台。SQLite 保存任务、项目、文献索引、运行记录与定时任务；模型凭据只由 Electron Main 的 `safeStorage` 保存。

## 1. 开发运行

环境：Windows 10/11 x64、Node.js 24+、pnpm 11.5.2。

```powershell
pnpm install
pnpm dev
```

验收构建：

```powershell
pnpm -r typecheck
pnpm build
pnpm test:e2e
```

`pnpm test` 是项目约定的空入口，不代表完整验收；以类型检查、构建、E2E 和命名脚本为准。

## 2. 第一次配置

设置分区统一在页面左侧导航中选择；窄窗口可展开紧凑侧栏查看完整名称，不使用顶部标签栏。

1. 打开「设置 → 模型与 Agent」。
2. 在目标 Provider 行点击「设置 API Key」，或点击「OAuth 登录」。
3. OAuth 授权页由系统浏览器自动打开；页面仍保留可点击链接、设备码和 Pi callback/manual-code 输入作为回退。
4. 在同一 Provider 行完成认证，不需要滚动到列表底部寻找第二个确认区。
5. 选择默认 Provider、模型、Thinking 深度和本地工具范围，保存默认配置。
6. 需要自建网关时，在自定义 Provider 中填写 API、HTTPS/loopback 地址和模型 id。Key 不写入 `models.json`。

应用不会读取、复用或迁移个人 `~/.pi`、`~/.codex` 的 auth、models 或 session 文件。

### 创建助手与团队

1. 打开「设置 → AI 助手」，新建助手并保存系统指令、模型和工具策略。Provider/model 同时留空时继承全局默认值；Thinking 留空也继承默认值。
2. 在「工具与 MCP」「技能绑定」的启停矩阵中查看各助手授权，勾选单项或批量选择并保存；修改有冲突时先重新载入。也可切换单助手编辑。空工具列表表示零工具；MCP 列表只覆盖本机受控 Workspace 工具，远程服务尚不支持。
3. 打开「协作团队」，添加 2–8 个不同助手，其中恰好一个为 director，设置总调用上限并保存。所有团队调用强制只读。
4. 在 Agent 页选择助手发送新对话，或选择团队并提交任务。会话固定到首次使用的助手；切换助手需要新会话。
5. 团队运行卡显示父状态、子运行和账本入口；可停止运行。缺少凭据/模型、非法 director 输出或耗尽预算会失败，不会显示伪成功。重启后未完成团队标记中断，不自动重放。

配置归档需确认且不删除历史运行；修改发生冲突时重新读取后再编辑。真实模型调用需要先在「模型与 Agent」完成认证。

矩阵保存成功后影响下一次新运行，不会改变已经启动的团队快照。技能仅绑定已安装且能作为受控指令加载的条目，不会安装代码或授予 shell/Python；取消勾选不会删除历史对话。来源对照及完整验证状态见 [实现 28](implementation/28-source-design-and-binding-matrix.md)。

## 3. 第一次 Agent 对话

打开「Agent」：

- 选择项目、Provider 和模型；
- 输入普通问题后按 Enter 发送；Shift+Enter 换行；
- 输入 `/` 使用本机命令；命令补全浮在输入框上方，不会把对话区顶开；
- 「对话」看回答，「轨迹」看工具调用、耗时、token 和失败原因。

可直接试：

```text
请读取当前项目的任务和未来日历，给出今天的三项优先级，不要创建新记录。
检索 retrieval augmented generation evaluation，并返回 sessionId 和可引用结果。
列出当前 Obsidian Vault 的笔记，并告诉我哪一篇最近修改。
读取当前 Agent 定时任务和最近运行状态，不要修改配置。
```

## 4. 外部写入原则

Zotero/Obsidian 不会被模型直接写入。Agent 只能生成待确认请求：

1. 读取目标并生成 preview 或冻结 Obsidian fingerprint；
2. 对话中出现确认卡片；
3. 用户点击确认后，Workspace Service 复用现有 connector 执行；
4. 返回 created/updated/skipped/conflict/failed 或 Obsidian 冲突结果。

拒绝、过期或 fingerprint/revision 冲突都不会覆盖外部内容。删除不是 Agent 工具，仍需原页面的独立二次确认。

## 5. 个人数据位置

默认数据根位于 Windows AppData，包含 `data/workspace.sqlite3`、`config/` 和应用自有 Agent profile。隔离运行：

```powershell
research-workbench.exe --prw-user-data-dir="D:\profiles\research-workbench-test"
```

不要把真实 Key 写进命令行、聊天、Issue、日志或测试文件。

## 6. 下一步

完整操作流见 [Agent User Guide](AGENT_USER_GUIDE.md)。实现边界见 [后端实现文档](implementation/24-pi-inprocess-agent-backend.md) 与 [前端实现文档](implementation/25-agent-conversation-ui-and-settings.md)。
本轮多助手与团队的迁移、验证和发布限制见 [实现 27](implementation/27-agent-assistants-teams.md)。开发验收可运行 `pnpm test:agent-profiles` 与 `pnpm test:e2e:agent-profiles`；后者使用隔离 Electron profile，不是已安装 NSIS 冒烟。
