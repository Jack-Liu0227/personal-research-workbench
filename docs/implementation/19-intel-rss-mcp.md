# RSS 情报日报与 MCP

状态：IN_REVIEW

情报日报现在只读取工作台 RSS 数据：用户可选择“全部来源”或单个 RSS 来源，再按关键词、作者和年份查询，结果直接展示在“情报日报”。TrendRadar 目录兼容入口已移除；`artifacts/trendradar-reference` 仅保留为开发参考，不参与运行时。

设置页提供 RSS 来源管理表，可先预览 URL 元数据，再新增、编辑、暂停抓取、隐藏日报展示和移除来源。移除硬删除来源配置，历史条目通过来源快照保留且可查询；恢复区和恢复 RPC 不存在。默认五个来源为掘金、Hacker News、Nature、npj Computational Materials、Nature Machine Intelligence。分类支持四个内置分类和自定义分类。

MCP 暴露来源管理、RSS 条件查询和刷新能力。`literature_daily_msg` 定时任务复用现有飞书绑定与安全存储链路，将启用且显示的技术新闻和文献合并为一条日报，按“技术新闻/文献”分组，最多 20 条并按飞书消息长度分块。

验证：`pnpm typecheck` 与 `pnpm test:rss-daily-msg` 已通过。真实 RSS 网络抓取和真实飞书投递未执行。
