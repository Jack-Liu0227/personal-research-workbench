# Personal Research Workbench

Windows 本地优先的个人科研工作台。当前代码已切换到 V2：以统一 Workspace Service 连接 Electron Renderer、SQLite、文献来源、Obsidian、Zotero、AI Runtime 和本机 MCP。

## V2 基础功能

- 八个一级页面：仪表盘、日历、任务、项目空间、文献检索、Obsidian、Zotero、设置。
- V2 Shell：项目上下文、Quick Todo、工作区 Tabs、右侧 Inspector、底部服务状态栏、深色蓝黑主题。
- 任务：项目、收件箱、看板/列表、移动排序、优先级、截止时间、Inspector 和 revision 冲突保护。
- 日历：手动事件 CRUD、日/周/月/议程范围、任务/项目截止日期只读投影、时区处理。
- 文献：本地 Paper 库、Crossref/OpenAlex 检索、持久 Search Session/Result、Scholar 用户外链和结果导入。
- Obsidian：授权 Vault 文件索引、Markdown 读取/编辑/创建、根路径检查和外部修改冲突。
- Zotero：Local/Web API v3 Collections/Items 浏览、元数据查看、本地 Paper 导入；不修改 Zotero 原始库。
- AI：沿用已验证的 `@earendil-works/pi-ai` 0.84.1，Provider/API 分离、Prompt 版本、应用存活期 Cron 和 Artifact 来源关联。
- MCP：本机 stdio Server，通过 token 握手的 named pipe 连接同一个 Workspace Service；首期提供项目/任务 Resources 和受控工具。

## 数据与安全边界

- 新版本只使用 `workspace.sqlite3`；旧 `workbench.sqlite3` 不读取、不删除。
- 新版本只使用 `workspace-secrets.json` 的 V2 credential namespace；旧密钥文件不读取、不物理删除。
- Renderer 没有 Node、SQLite、credential 或泛化 IPC 权限；Preload 暴露 `window.workbench.v2`。
- 外部写回经过 Connector Coordinator、稳定 external ID 和 revision；不写 `zotero.sqlite` 或 `.obsidian/`，附件只保留链接。

## 后续完善

AnythingLLM/AgentScope/LLMWiki/MOSAIC、Headless 常驻调度、远程 MCP、完整 AI Job/Event/Approval/checkpoint、PDF/向量检索、富文本、三方冲突 UI、自动外部写回、备份恢复、签名和自动更新仍未实现。

## 开发

前置：Node.js 24+、pnpm 11.5.2、Windows 10/11 x64。

```powershell
pnpm install
pnpm dev
pnpm typecheck
pnpm build
pnpm package:win
```

测试源码已按用户要求删除；`pnpm test` 不再是验收门禁。安装包仍需在真实 Windows x64 环境进行独立安装/启动/重启/卸载 smoke。

## 文档

- [V2 架构](docs/architecture/ARCHITECTURE.md)
- [V2 数据模型](docs/architecture/DATA_MODEL.md)
- [V2 模块计划（00–07）](docs/README.md)
- [开发文档索引](docs/README.md)
