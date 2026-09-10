# Obsidian

## 2026-09-08 最新需求与验收（以本节为准）

- Vault 文件树、中央编辑器和 Inspector 使用全高布局；编辑与预览共享完全一致的容器尺寸并占满可用宽度。
- 目录索引必须显示空文件夹；顶部分类只显示文件夹名称，不显示具体 Markdown 文件。
- 文件复选框默认隐藏，仅在批量操作模式显示；父/子文件夹支持上下展开/收起，侧栏支持左右折叠。
- 右键和“+”支持新建文件夹、Markdown、重命名、移动和删除确认；路径必须限制在已授权 Vault 内。

状态：PARTIAL。空目录索引和完整 CRUD 仍需跨层验收。

> 文档状态（2026-08-30）：本文件是 Obsidian 连接、Vault 初始化、Markdown 编辑和标签关联的唯一计划源。根级分类与项目标签规则以本文为准。

## 统一 Vault 规则

- 默认 Vault 路径由 Main 解析：开发和打包环境都优先读取应用目录旁 `.env` 中的 `OBSIDIAN_DIR`；未配置时使用软件安装目录本身。设置页可通过系统文件夹选择器覆盖，且路径必须由用户选取的已存在目录开始。
- Vault 只在根目录创建默认分类，不创建项目子目录、不添加数字前缀、不写入 `.obsidian/`。项目隔离使用 Markdown frontmatter 标签：`projectId`、`workbench_project_id`、`labels: [project:<id>]` 或 `tags: [project:<id>]`，同一文件可以有多个项目标签。
- 首次初始化采用 `preview → confirm → initialize`。只创建缺失的根级目录和 `README.md`，保留用户已有文件和自定义文件夹；Knowledge 入口只展示真实存在的一级目录。

默认初始化结构：

```text
<安装目录或 OBSIDIAN_DIR>/
├─ 每日文献推送/
├─ 文献矩阵/
├─ 文献综述/
├─ 写作模板/
├─ 提示词库/
├─ AnythingLLM/
├─ LLMWiki/
└─ README.md
```

用户可在根目录任意新增、重命名或删除分类；自定义目录的 `kind` 为 `custom`，不会被初始化流程强制恢复。

## 编辑、保存与安全边界

- Renderer 只接收 Vault-relative `.md` 路径、正文和 fingerprint；写入统一经过 `notes.write(expectedFingerprint)`，保存后刷新 note index。
- 打开文件默认是编辑模式，停止输入后自动保存，并支持 Ctrl/Cmd+S、撤回草稿和重新读取最新版本。外部修改造成 fingerprint 冲突时禁止静默覆盖，必须重新读取或放弃草稿。
- 新建笔记、提示词模板、写作模板、文献综述、文献矩阵和每日推送均走同一安全写入通道。删除必须显式确认并携带 fingerprint；禁止访问 `.obsidian`、符号链接、Vault 外路径或写入用户未授权目录。
- 每个有文件落地的分类、文件和 README 均支持右键“在资源管理器中查看”，由 Main 做 root containment 校验后调用 Explorer。

## 分类与项目筛选

- 左栏树、分类标签和 Inspector 根据真实 Vault 扫描结果生成，不硬编码缺失分类。
- 筛选支持路径、标题、frontmatter `labels/tags`、最近修改和项目标签；右键可绑定/解除项目，多选可批量绑定或删除，删除前显示明确确认和冲突错误。
- 未带项目标签的文件归入“未分类/Inbox”，绝不根据目录名推断项目。

## 当前实现与待验收

已接入：真实 Vault 探测、系统文件夹选择、根级布局预览/初始化、动态分类、标签解析、编辑/实时预览、自动保存、指纹冲突、删除、项目绑定、折叠和 Explorer 操作。

仍需真实环境验收：首次初始化后的人工检查、外部 Obsidian 同步 watcher、大批量索引性能、综述/矩阵自动投影，以及 AnythingLLM/LLMWiki 本地服务联通。它们未通过真实探测前不得显示为已连接。

## 约束来源

- 外部 Markdown 永远由 Vault 文件作为正文权威；SQLite 仅保存索引、结构化关联、指纹和同步状态。
- 不复制或覆盖 `.obsidian/`，不把正文、凭据和绝对路径写入普通日志。
# 2026-09-08 空目录索引

Obsidian 索引现在会在安全 Vault 根目录内递归发现目录（跳过 `.obsidian`、`.git`、`.trash`、符号链接和 `node_modules`），并以 `Note.isFolder=true` 的只读索引条目提供给文件树；空目录因此可显示。该扫描不写入 `.obsidian`，目录条目不可作为 Markdown 内容读取或编辑。

# 2026-09-09 文件树校验与编辑区布局

索引 DTO 的 `relativePath` 允许安全的文件或目录相对路径，以便目录条目通过共享合同返回；读取、写入和删除命令仍只接受 `.md` 路径。设置中切换 Vault 后，索引和已打开笔记按 profile revision 重新取数，旧 Vault 内容不会继续显示。启动时显式配置的 `OBSIDIAN_DIR` 会按应用目录解析；解析为应用自带的 `workbench` 时可创建并初始化默认布局，其他外部 Vault 只探测不写入；已经保存的设置路径优先于默认值。

中央编辑区的工具栏保持在面板顶部，编辑器或预览内容独立占满剩余高度；文件树和属性栏各自滚动。
