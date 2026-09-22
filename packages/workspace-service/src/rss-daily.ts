import { FEISHU_DAILY_MSG_CHUNK_CHARS, RSS_DAILY_MSG_MAX_ITEMS } from '@prw/contracts'
import type { RssFeedItem } from '@prw/contracts'
import { chunkFeishuMessage } from './feishu-message.js'

/**
 * 每日文献推送（消息侧）的 RSS 消息构建：纯函数、可测试。
 *
 * 增量 3 起消息内容完全由 RSS 订阅驱动（不再有模型决策卡）：每个新增条目
 * 输出「标题 / 摘要 / 链接」三行，摘要剥 HTML 后截断，按源分组、按发布日期
 * 排序；全部列出不精选，最多 RSS_DAILY_MSG_MAX_ITEMS 条防刷屏。最终文本仍
 * 走 feishu-message 的分块（≤3500 字/条）与投递边界，保证与既有消息管线一致。
 */

/** 单条摘要的展示上限：飞书消息里足够判断"要不要读"，又不至于刷屏。 */
export const RSS_ITEM_SUMMARY_LIMIT = 320

export interface RssMessageBuildInput {
  readonly items: readonly RssFeedItem[]
  readonly sourceTitles: ReadonlyMap<string, string>
  readonly sourceCategories?: ReadonlyMap<string, { readonly id: string; readonly name: string; readonly sortOrder: number }>
  /** 稳定日期键（Asia/Shanghai 的当日），用于标题行。 */
  readonly dateKey: string
  readonly maxItems?: number
}

function bound(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

/** 把新增条目组装成推送文本；空输入返回空串（调用方判定为无可推）。 */
export function buildRssPushMessage(input: RssMessageBuildInput): string {
  const maxItems = input.maxItems ?? RSS_DAILY_MSG_MAX_ITEMS
  if (input.items.length === 0) return ''
  const titleOf = (item: RssFeedItem) => input.sourceTitles.get(item.sourceId) ?? item.sourceId
  const ordered = [...input.items].sort((a, b) => {
    const ta = a.publishedAt ?? ''
    const tb = b.publishedAt ?? ''
    if (ta !== tb) return ta < tb ? 1 : -1
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0
  })
  const taken = ordered.slice(0, maxItems)
  const grouped = new Map<string, Array<{ readonly title: string; readonly items: RssFeedItem[] }>>()
  const categoryMeta = new Map<string, { readonly name: string; readonly sortOrder: number }>()
  for (const item of taken) {
    const metadata = input.sourceCategories?.get(item.sourceId)
    const category = metadata?.id ?? 'rsscat.academic-papers'
    categoryMeta.set(category, { name: metadata?.name ?? '学术论文', sortOrder: metadata?.sortOrder ?? 1 })
    const sourceTitle = titleOf(item)
    const categoryGroups = grouped.get(category) ?? []
    const group = categoryGroups.find((candidate) => candidate.title === sourceTitle)
    if (group !== undefined) group.items.push(item)
    else categoryGroups.push({ title: sourceTitle, items: [item] })
    grouped.set(category, categoryGroups)
  }
  const lines: string[] = [
    `每日 RSS 情报 · ${input.dateKey} · 新增 ${String(taken.length)} 条`,
    ''
  ]
  const categories = [...grouped.keys()].sort((a, b) => (categoryMeta.get(a)?.sortOrder ?? 999) - (categoryMeta.get(b)?.sortOrder ?? 999) || (categoryMeta.get(a)?.name ?? a).localeCompare(categoryMeta.get(b)?.name ?? b))
  for (const category of categories) {
    const groups = grouped.get(category)
    if (!groups) continue
    lines.push(`## ${categoryMeta.get(category)?.name ?? category}（${String(groups.reduce((sum, group) => sum + group.items.length, 0))}）`, '')
    for (const group of groups) {
      lines.push(`【${group.title}】`)
      for (const item of group.items) {
        const authors = item.authors ?? []
        if (authors.length > 0) lines.push(`作者：${authors.join('、')}`)
        if (item.publishedAt) lines.push(`日期：${item.publishedAt.slice(0, 10)}`)
        lines.push(
          `${item.title}`,
          item.summary.length > 0 ? bound(item.summary, RSS_ITEM_SUMMARY_LIMIT) : '（无摘要）',
          item.url,
          ''
        )
      }
    }
  }
  return lines.join('\n').trim()
}

/** 分块数（≤3500 字/条）：消息侧防刷屏防截断的同一契约。 */
export function chunkRssPushMessage(text: string, limit = FEISHU_DAILY_MSG_CHUNK_CHARS): string[] {
  return chunkFeishuMessage(text, limit)
}
