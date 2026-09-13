# Task 5：Obsidian 文献管理与项目分类

状态：IN_REVIEW（实现完成并通过 `pnpm typecheck` / `pnpm build` / `pnpm test:e2e` / 2 个聚焦测试文件；真实用户 Vault 场景未验收，见文末「未验证」）
依赖 Task 3、Task 4

## 目标

以 Obsidian Vault 文件为正文权威，以 SQLite 为索引/关联权威，打通文献笔记、综述、矩阵、项目标签和每日推送。

## 实施步骤

1. 修复文件树批量模式、空目录、根级分类、折叠和独立滚动。
2. 用受控 frontmatter 维护 `projectId`、`workbench_project_id`、`labels/tags`，未知字段原样保留。
3. 文献导入/导出生成的 Markdown 使用安全相对路径和来源 fingerprint；重复写入必须预览/更新而不是覆盖。
4. 文献矩阵支持从 Paper/项目选择、批量导入、CSV/Markdown 导出和显式冲突预览；嵌入 Project Space 时拆出 content 组件，避免嵌套 page-scroll。
5. 文献综述使用 Paper/证据卡片和可追溯 citation anchor；删除 Paper 只断开关系，不删除正文。
6. 每日推送使用同一根级目录和 frontmatter 约定。

## 本次恢复背景

上一轮 Task 05 的执行进程被 SIGTERM 中断，工作树只留下半成品，`pnpm typecheck` 在 `apps/desktop` 报 3 个错误，且有两个前端入口不可达：

1. `apps/desktop/src/renderer/src/features/obsidian.tsx:542` TS2353：`metadataPreview` 状态声明为 `NoteMetadataPreview | null`，却用 `{ preview, patch }` 赋值。
2. 同文件 TS2322：`patch: { projectId }` 传入普通 `string | null`，但契约要求 branded `ProjectId`。
3. 同文件 TS2304：右键菜单调用已被改名的 `bindProject`（现为 `requestProjectBinding`），渲染器根本无法构建。
4. `notes.metadata.preview` / `notes.metadata.apply` 已有完整后端链路，但 `metadataPreview` 状态从未被任何组件渲染 → 「预览 → 确认写入」整条流程不可达，`applyMetadata` 是死代码。
5. `beginChildNote` 已定义但从未被调用 → 子笔记功能不可达。

本次工作：先只改渲染器把编译与不可达入口修完（步骤 2/3 的用户可见部分），再补 service 层形状一致性与测试，最后补 e2e 断言与文档。未删除 Task 02/03/04 的任何已完成改动。

## 实现记录

### 1. 后端链路（核查确认已存在，本次仅修一处形状缺口）

- `packages/contracts/src/v2.ts`：`NoteSchema` 可选 `projectId`/`kind`/`parentRelativePath`；`NoteMetadataPatchSchema`、`NoteMetadataPreviewSchema`（`before`/`after`/`changedFields`/`preservedUnknownFields`/`warnings`/`canApply`/`fingerprint`）、`ApplyNoteMetadataInputSchema`（强制 `expectedFingerprint` + `confirmed: true`）、`NoteDuplicateReportSchema`、`CreateNoteFolderInputSchema`/`NoteFolderDeleteReceiptSchema`/`NoteMoveReceiptSchema`。
- `apps/desktop/src/preload/index.ts` + `packages/workspace-service/src/dispatcher.ts`：`notes.metadata.preview`、`notes.metadata.apply`、`notes.duplicates`、`notes.createFolder`、`notes.deleteFolder`、`notes.move` 全部已接线并在 allowlist 中。
- `packages/workspace-service/src/integration-runtime.ts`：`readNote`/`writeNote`/`deleteNote`/`deleteNoteFolder`/`createNoteFolder`/`moveNote`/`previewNoteMetadata`/`applyNoteMetadata`/`noteDuplicates`；`packages/workspace-service/src/obsidian-layout.ts`：`parseObsidianFrontmatter`、`updateManagedFrontmatter`（managed keys 白名单 + 未知字段原样保留 + 重复 managed key fail-closed）。
- 本次改动：新增 `projectObsidianNote(profileId, note)` 并在 `readNote`/`writeNote`/`applyNoteMetadata` 三处复用它。此前只有 `readNote` 做受控投影，`applyNoteMetadata` 返回的 `Note` 里 `projectId`/`kind`/`parentRelativePath` 是 `undefined`，与「绑定成功后直接读返回值」的调用方契约不一致（新测试 `links and unlinks a child note…` 复现并锁定）。

### 2. 渲染器补完（`apps/desktop/src/renderer/src/features/obsidian.tsx`）

- 受控 frontmatter 预览/确认对话框（新增）：Radix `Dialog`，展示服务端计算的逐字段 diff（`metadataDiffRows`，字段名与 service 的 `changedFields` 文案一致：项目绑定/文献分类/标题/日期/父笔记/关联文献/关联任务/标签）、`changedFields`、`preservedUnknownFields`、`warnings`、CAS 冲突内联错误，以及 `取消` / `确认写入`（`changedFields.length === 0` 时禁用）。`确认写入` 用预览里冻结的 `fingerprint` 作为 `expectedFingerprint`。
- 单一入口 `requestMetadataPatch(path, patch)`：所有受控写入（项目绑定、解除父笔记关联）都走「有未保存草稿则先要求保存」守卫 → `notes.metadata.preview` → 对话框。`requestProjectBinding` 在其上做 `ProjectIdSchema.parse` 品牌化（普通 option value → branded `ProjectId`）。
- Inspector 项目绑定：`value` 改为受控投影 `selected.data.projectId`（并在项目列表里校验存在性），不再用 `data.tags.find(tag => tag.startsWith('project:'))` 这类 legacy tag 判定；`<dl>` 增加「受控类型」「父笔记」行。
- 文件树右键菜单按 `noteMenu.kind` 分流：
  - 目录：`重命名分类`（`notes.move`）、`在资源管理器中查看`、`删除空分类`（`notes.deleteFolder`，只处理空目录）。
  - 文件：`加入选择/取消选择`、`新建子笔记`（补上 `beginChildNote` 的入口，写入 `parentRelativePath` + 分类 kind）、`在资源管理器中查看`、`取消项目绑定` + 逐项目 `绑定：X`（已绑定项显示 `已绑定：X`）、`直接删除`（`window.confirm` + 逐条回执）。
- 菜单不再溢出视口：`contextMenuPosition(event, estimatedHeight)` 按项目数量估算高度并夹取坐标，菜单容器加 `max-h-[70vh] overflow-y-auto`。（e2e 实测修复前 `y=801`、菜单高 201、视口高 883，底部项目项点不到。）
- 清理上一轮残留的未使用图标 import（`FilePlus`/`PencilLine`）。

### 3. 测试（新增 `packages/workspace-service/tests/obsidian-note-metadata.test.ts`）

真实 `WorkbenchRepository`（临时 SQLite）+ 真实临时 Vault 的 `IntegrationCoordinator` 用例：

- `previewNoteMetadata`：读取磁盘文件计算 diff、`changedFields`/`preservedUnknownFields`/`canApply` 正确，且**预览不写盘**（断言行级字节不变）。
- `applyNoteMetadata`：只写 managed keys（`workbench_project_id`/`workbench_kind`），未知字段（`custom_key`）与正文保留；返回值与 `readNote` 形状一致（同 bug 回归锁）。
- CAS：预览后外部修改文件 → `EXTERNAL_CONFLICT` 且文件内容保持不变。
- 子笔记：`parentRelativePath` 绑定 → `workbench_parent` 写入且 `readNote` 投影出父路径；解除 → 写成显式 YAML `null`，投影回 `null`。
- 清除项目绑定：`before.projectId` 有值 → `after.projectId` 为 `null`，正文保留。
- `noteDuplicates`：全新路径 `new`、同路径 `exists`（带 `targetFingerprint`，且并报出跨目录同名候选）、仅标题重复 `duplicate`。

### 4. e2e（`scripts/e2e-electron.cjs`，沿用既有隔离 profile 与 app 自建默认 Vault）

- 目录右键菜单：包含 `重命名分类`/`删除空分类`，且**不含**文件专属的 `直接删除`；点击外部后菜单关闭。
- 文件右键菜单（README.md）：包含 `新建子笔记`/`加入选择`/`绑定项目（预览后写入）`/`取消项目绑定`，且不含目录专属动作。
- 点 `绑定：<项目>` → 打开 `受控 frontmatter 预览` 对话框 → 断言 diff、`changedFields`、`保留的未知字段` → 点 `确认写入` → 断言成功反馈 `已更新 README.md 的受控 frontmatter`、对话框关闭、Inspector `select[aria-label="项目绑定"]` 的值等于该项目 option（即受控绑定真的回读到 UI）。

## 安全与契约约束（未改变）

- 从不写 `.obsidian/`、`zotero.sqlite` 或任何凭据；e2e/单测只使用临时目录里的 Vault。
- 外部写入仍是 preview → 显式确认 → `expectedFingerprint` CAS → 回执；外部修改导致 `EXTERNAL_CONFLICT` 时渲染器显示冲突文案且不覆盖文件。
- `updateManagedFrontmatter` 只重写受控字段与 `labels/tags` 别名，未知 frontmatter 字段与正文原样保留；清除绑定/父笔记不是删除键，而是写成显式 YAML `null`（保持 schema 稳定，解析回 `null`）。

## 证据

```powershell
pnpm typecheck   # PASS（10/10 workspace projects；修复前 apps/desktop 3 个错误）
pnpm build       # PASS（renderer assets/index-*.js 2,030.80 kB、index-*.css 185.83 kB）
pnpm test:e2e    # PASS（含 `Obsidian combined editor/category controls` 内的目录/文件右键菜单与受控 frontmatter 预览→确认写入断言）
node --import jiti/register --test packages/workspace-service/tests/obsidian-note-metadata.test.ts
                 # 6/6 PASS（preview/apply CAS/子笔记/清除绑定/重复检查）
node --import jiti/register --test packages/connectors/test/obsidian.test.ts packages/workspace-service/tests/obsidian-layout.test.ts
                 # 16/16 PASS（frontmatter 解析/重写、move、路径与 slug 安全）
```

## 已修复的既有缺陷

- `metadataPreview` 状态无任何渲染者 → `notes.metadata.preview`/`apply` 链路不可达、`beginChildNote` 无调用者（两个功能此前只有代码没有入口）。
- 右键菜单调用不存在的 `bindProject` → `apps/desktop` 无法通过 typecheck。
- 右键菜单不区分文件/目录 → 目录行出现只对文件有效的 `直接删除`。
- Inspector 用 legacy `project:` tag 判定绑定 → 受控写入 `workbench_project_id` 后仍显示未绑定。
- `applyNoteMetadata`/`writeNote` 返回的 `Note` 不做受控投影，与 `readNote` 形状不一致。
- 项目列表变长后右键菜单超出视口且不可滚动，底部项不可点击。

## 已知遗留（本次未改，未据此标 DONE）

- `IntegrationCoordinator.obsidianIndex`（`listNotes` 与 `noteDuplicates` 共用）走 connector 的列表结果，不做受控投影：树/重复报告不返回 `projectId`/`kind`/`parentRelativePath`（只有 `notes.read` 投影）。当前树 UI 不渲染这三个字段，故未扩大改动面（该列表同时服务 Zotero/每日推送路径）。若后续要在树内显示绑定或分类，需要单独评估。
- 子笔记创建只有 service 层断言；e2e 未点击 `新建子笔记` 走完整创建 → 编辑流程。
- `beginCreate`（普通新建）与 `beginChildNote` 均无「未保存草稿」守卫：创建成功后 `setSelectedPath` 会切换选中文件，理论上可丢失未保存草稿（自动保存 0.8s 已把窗口压到很小）。按最小改动原则未动它。
- 目录菜单的 `在资源管理器中查看` 在 e2e 中未被点击（会真实拉起资源管理器，不适合自动化）。
- 原步骤 4/5/6（矩阵、综述、每日推送的同一套 frontmatter/根级目录约定）由 Task 02/03 交付，本次只复核约定一致性，未改动其代码。

## 未验证（不得据此标 DONE）

- **真实用户 Vault 场景全部未验收**：空目录、已有文件、符号链接、Vault 外路径、外部修改/同步冲突、大批量索引，以及「外部程序改写 frontmatter 后再预览/确认」的真实体验。本环境只覆盖了临时 Vault（单测）与隔离 profile 的默认 Vault（e2e）。
- 真实 Obsidian 客户端手动验证（打开文件、外部保存、YAML 兼容性观感）未做。
- 因此本任务状态为 IN_REVIEW，等待 Supervisor 判定；真实 Vault 人工验收通过后才可考虑 DONE。
