# Agent 使用教程

本文档描述当前内嵌 Pi Agent 的真实能力边界。Agent 在 Core utility process 内运行，Workbench MCP 通过 `InMemoryTransport` 连接同一个 Workspace Service；不是外部 CLI，不读取个人 Pi 配置。

## 1. Agent 能看到什么

每个 run 会得到：

- 当前项目、选定的 Paper、文献矩阵和有限的本地任务上下文；
- 已启用的 Obsidian Vault/Zotero profile id、名称和状态；
- 本次 run 的 Provider/model、权限模式和工具 profile；
- 受 allowlist 控制的 MCP 工具。

凭据、OAuth token、API Key、完整 Vault 正文和无界数据库内容不会注入 prompt。

## 2. 本地工作台操作

在允许本地写入的手动 run 中，Agent 可以使用：

- `tasks.create/update/move`
- `todos.capture`
- `calendar.create/update`
- `calendar.markers.create/update`

例如：

```text
我完成了“整理实验数据”，请更新对应任务为已完成，并告诉我任务 id。
明天上海时间 15:00 安排一个 30 分钟的论文讨论会。
把“检查 Zotero 导入冲突”记为 Todo，不要创建日历事件。
```

Agent 必须返回实际 id、时间和失败原因；不能把“准备写入”说成“已写入”。

## 3. 文献检索

Agent 可复用现有 `LiteratureCoordinator`，不会在 runtime 内重新实现 Crossref/PubMed 请求：

```text
搜索“retrieval augmented generation evaluation”，只返回 sessionId、前 5 条结果标题、DOI 和来源。
读取刚才的 literature session 第 2 页，并指出哪些结果没有 DOI。
把这篇 Paper 与当前项目文献矩阵中的方法差异列成表格，不要虚构实验结果。
```

相关工具：`literature.search`、`literature.sessions`、`literature.results`、`papers.list`。联网搜索失败会显示 unavailable/error，不会伪造空成功。

## 4. Obsidian

Agent 可以读取授权 Vault：

```text
列出 Vault 中最近修改的 Markdown 笔记。
读取 `研究/实验记录.md`，只总结其中已有内容。
为 `研究/实验记录.md` 准备一个 managed metadata 更新请求，但先不要写入。
```

写入工具是 `notes.write.request` / `notes.metadata.request`：

- 请求阶段只读取当前 fingerprint 和生成摘要；
- UI 显示相对路径、变更范围和状态；
- 用户确认后才调用 connector；
- 外部文件变化会进入 `conflict`，不会覆盖正文；
- `.obsidian/`、越界路径、符号链接和未授权 Vault 会被拒绝。

## 5. Zotero

读取与准备导入：

```text
列出 Zotero collections 和前 20 条 items，找出与当前项目 Paper 重复的候选。
预览当前选中的 Paper 导入 Zotero 的结果，列出 created/updated/skipped/conflict 风险。
把检索暂存区中 DOI 为 ... 的结果准备成 Zotero 写入请求，等待我确认。
```

相关工具：`zotero.capability`、`zotero.collections`、`zotero.items`、`zotero.paperToZotero.preview`、`zotero.paperToZotero.request`、`literature.stagingToZotero.preview`、`literature.stagingToZotero.request`。

Agent 没有 `zotero.*.execute`，也没有删除工具。确认后仍由 IntegrationCoordinator 检查 capability、profile revision、remote revision 和集成凭据。

## 6. 定时任务与参数

Agent 可以读取而不能偷偷修改调度安全边界：

```text
列出所有已启用的定时任务，包含 cron、时区、skill、主题、来源、回看天数、输出目录和权限模式。
读取最近 10 次定时运行，按 failed/blocked/conflict 分组。
读取当前 Agent 默认 Provider、model、Thinking、permissionMode、toolProfile 和 approvalPolicy；不要显示任何密钥。
```

只读工具：`automation.rules.list`、`automation.runs.list`、`agent.settings.get`。创建/编辑/归档定时任务仍在「定时任务」页面完成，因为它可能改变后续无人值守运行和外部投递范围。

定时任务规则包含：

- skill 与 skill 输入（topic、sources、lookbackDays、responseLanguage）；
- cron、frequency、timezone；
- outputFolder 与项目绑定；
- permissionMode 与 approvalPolicy；
- executionMode、assistantKey、model。

调度只在应用存活期间运行；启动补跑每日最多一次。定时任务不会获得外部写入确认卡片，因此不要把它配置为无人值守 Zotero/Obsidian 写入。

## 7. Skill 与 extension

### Skill

Workbench 的 canonical skill 源是仓库 `.agents/skills/<key>/`；安装包读取构建时镜像 `resources/skills/<key>/`。只有 coordinator 明确选择并通过 registry 校验的 skill 才会把对应目录传给 Pi ResourceLoader；普通聊天不会把整个 skill 目录灌进上下文。不读取 `~/.pi/agent/skills`。

当前调度器还会对 `last30days`、`literature-matrix`、`literature-review-push` 做独立 registry/输入校验。缺文件、版本、Python、网络或执行引擎不可用时，run 会以结构化 blocked/diagnostic 结束，不会降级成一篇看似成功的普通回答。

验证：

```powershell
pnpm test:agent-runtime-pi
pnpm test:literature-skills
```

### Extension

内置 Workbench extension 负责注册 MCP 工具。Pi 的受控 extension loader 只接受开发态仓库 `.pi/extensions` 或打包态 app-owned `resources/extensions`，不扫描用户 `~/.pi`。内置 shell、PowerShell、read/write/edit/grep/find/ls 仍然关闭。

当前仓库的核心 Workbench MCP 通过 inline extension 注册，已随每个 Agent run 接入；仓库没有额外的 `.pi/extensions` 文件。未来增加 app-owned extension 时，必须放在受控路径并纳入打包资源清单。Extension 如果要注册工具，必须遵守：

- 不注册文件系统、shell、凭据或绕过 IntegrationCoordinator 的工具；
- 不把 secret 写入 prompt、tool result、ledger 或日志；
- 通过 typed Workbench service 做业务操作；
- 增加工具 allowlist/阻断测试后再纳入发布包。

## 8. 故障排查

| 现象 | 先检查 |
| --- | --- |
| Agent 没有模型 | 设置中 Provider credential status、默认 `provider/model` 是否存在 |
| 文献工具失败 | literature service 状态、网络源是否可用、sessionId 是否来自真实结果 |
| Obsidian 找不到笔记 | Vault 是否 enabled、使用 prompt 注入的 `vaultId`、相对路径是否在 Vault 内 |
| Zotero 无法预览 | `zotero.capability`、profile id、Local/Web API 状态和权限；不要直接操作 `zotero.sqlite` |
| 确认卡片显示 conflict | 外部文件/远端 revision 已变化，重新读取并生成 preview |
| 定时任务 blocked | 查看规则的 skill 状态、outputFolder、permissionMode 和运行历史诊断 |
| skill 未加载 | 检查 `.agents/skills/<key>/SKILL.md`、打包资源镜像和 `pnpm test:literature-skills` |
| 页面文字看不清 | 切换深色/浅色主题、确认系统缩放，升级到包含主题对比度修复的构建 |

真实 OAuth、真实 Zotero/Obsidian 写入和 Windows NSIS 安装 smoke 必须在对应的 disposable/Windows 环境中验证；本地单元测试或模拟 connector 不能冒充真实外部写入证据。
