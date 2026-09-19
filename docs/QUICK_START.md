# Quick Start

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

1. 打开「设置 → 模型与 Agent」。
2. 在目标 Provider 行点击「设置 API Key」，或点击「OAuth 登录」。
3. OAuth 授权页由系统浏览器自动打开；页面仍保留可点击链接、设备码和 Pi callback/manual-code 输入作为回退。
4. 在同一 Provider 行完成认证，不需要滚动到列表底部寻找第二个确认区。
5. 选择默认 Provider、模型、Thinking 深度和本地工具范围，保存默认配置。
6. 需要自建网关时，在自定义 Provider 中填写 API、HTTPS/loopback 地址和模型 id。Key 不写入 `models.json`。

应用不会读取、复用或迁移个人 `~/.pi`、`~/.codex` 的 auth、models 或 session 文件。

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
