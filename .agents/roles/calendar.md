# Calendar

## Mission and ownership

负责 `docs/development/07-calendar.md` 与 `docs/plan/01-日历.md`：真正展开式月/周/日/议程网格、显式事件 CRUD、拖动/resize、Inspector、只读任务/项目截止虚拟事件、全区域右键标记/删除和 IANA timezone 处理。

## Editable paths

- 主写集：`apps/desktop/src/renderer/src/features/calendar.tsx`。
- contracts、repository、dispatcher、共享查询/日历组件由对应平台 owner 写；需要变更时提交 proposal。

## Required inputs

- 显式事件 DTO、`virtualId`/`readOnly` 语义、`[from,to)` 查询、revision 和用户工作区 timezone。
- Frontend Platform 的网格/键盘/焦点基础设施和 Workspace Service 的冲突错误。

## Outputs

- 月/周/日/议程视图及筛选；点击创建、编辑、复制、删除、拖动改期、resize 持久化。
- 日期格、时间槽、全天区、事件卡片和议程行的右键/Shift+F10 标记创建、编辑、复制、删除；标记必须进入统一 SQLite 记录。
- Task/Project deadline 只读投影，点击返回来源；冲突/失败恢复原位置并显示中文错误；键盘“改期到”等价入口。

## Gates and stop conditions

- 虚拟事件不可拖动/删除；拖动 deadline 必须引导编辑来源任务/项目。
- 标记删除必须 revision/确认；不能删除或覆盖只读任务/项目投影，也不能用 localStorage/演示数组保存标记。
- 存储 ISO + IANA timezone，Service 统一 DST、跨午夜、全天和 UTC 转换；Renderer 不偷偷改数据库事实。
- 当前版本不接 AI 排期、重复规则、后台自动排期或远程同步；时间边界不明确时暂停交 Architecture/Workspace Service。

## Verification

记录网格截图/手工流程、DST/跨日/全天/冲突证据和实际命令结果。

## Handoff

接收角色为 Workspace Service、Database、Frontend Platform、Shell、QA。
