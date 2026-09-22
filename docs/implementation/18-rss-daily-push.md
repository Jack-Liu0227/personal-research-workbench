# Task 18：每日文献推送与 RSS 来源管理

状态：IN_REVIEW

设置页的一级“RSS 来源”分区提供完整生命周期管理：输入 URL 后先预览 feed 元数据，再保存名称、网站、描述和分类；每个来源可独立暂停抓取或隐藏日报展示。内置分类为技术新闻、学术论文、行业动态、AI / 科技，并支持自定义分类的新增、重命名和删除约束。

来源删除是配置层硬删除，停止后续抓取；已入库文章保留来源名称、URL、分类和删除标记快照，历史查询与 item_url 去重继续有效。重新添加同一 URL 会生成新的来源 ID。

每日 `literature_daily_msg` 仍走纯 RSS 快路径：读取启用来源，支持 RSS 1.0、RSS 2.0 和 Atom，按 item URL 去重，按动态分类和来源分组，最多 20 条并分块发送到已绑定的飞书机器人；不调用 Agent 或模型。

情报日报交互筛选使用“全部来源”及每个 RSS 来源的 source ID；来源分类只用于归档和日报分组。

主要实现：`packages/contracts/src/rss.ts`、数据库迁移 37、`research-repository.ts`、`workspace-service/src/rss-feed.ts`、`rss-daily.ts`、Dispatcher/Preload RPC 和设置页 RSS 卡片。

验证：

```powershell
pnpm typecheck
pnpm test:rss-daily-msg
```

两项检查均已通过（专项测试 52/52）。真实 RSS 网络抓取和真实飞书投递未执行。
