import { describe, it } from 'node:test'
import { equal, match, ok } from 'node:assert/strict'
import type { RssFeedItem } from '@prw/contracts'
import { buildRssPushMessage, chunkRssPushMessage } from '../src/rss-daily.js'

const item = (title: string, url: string, sourceId = 'rss.nature'): RssFeedItem => ({ guid: url, title, url, summary: 'summary', authors: [], publishedAt: '2026-09-20T00:00:00.000Z', sourceId })
describe('rss-daily', () => {
  it('groups items by category and source', () => {
    const text = buildRssPushMessage({ dateKey: '2026-09-21', sourceTitles: new Map([['rss.nature', 'Nature'], ['rss.hacker-news', 'Hacker News']]), sourceCategories: new Map([['rss.nature', { id: 'rsscat.academic-papers', name: '学术论文', sortOrder: 1 }], ['rss.hacker-news', { id: 'rsscat.technology-news', name: '技术新闻', sortOrder: 0 }]]), items: [item('Paper', 'https://x/p'), item('News', 'https://x/n', 'rss.hacker-news')] })
    match(text, /RSS/); match(text, /Nature/); match(text, /Hacker News/)
  })
  it('caps and chunks output', () => {
    const items = Array.from({ length: 25 }, (_, i) => item('Paper ' + i, 'https://x/' + i))
    const text = buildRssPushMessage({ dateKey: 'd', sourceTitles: new Map(), items })
    match(text, /RSS/); ok(chunkRssPushMessage('x\n'.repeat(3000), 2000).length > 1)
  })
  it('returns empty for no items', () => equal(buildRssPushMessage({ dateKey: 'd', sourceTitles: new Map(), items: [] }), ''))
})
