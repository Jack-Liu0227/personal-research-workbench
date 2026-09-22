import { describe, it } from 'node:test'
import { equal, ok, throws } from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchRepository } from '@prw/database'
import { RSS_DEFAULT_SOURCES } from '@prw/contracts'

function makeRepository(): { repository: WorkbenchRepository; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'prw-rss-repo-'))
  return { repository: new WorkbenchRepository({ filePath: join(root, 'workspace.sqlite3') }), root }
}
const cleanup = ({ repository, root }: ReturnType<typeof makeRepository>) => { repository.close(); rmSync(root, { recursive: true, force: true }) }
const sourceInput = (categoryId: string, title = 'PLOS ONE', url = 'https://journals.plos.org/plosone/feed/atom') => ({ title, url, categoryId, siteUrl: 'https://journals.plos.org', description: '' })

describe('rss sources repository', () => {
  it('seeds configured sources and categories on a fresh database', () => {
    const ctx = makeRepository()
    try {
      const sources = ctx.repository.listRssSources()
      equal(sources.length, RSS_DEFAULT_SOURCES.length)
      for (const seed of RSS_DEFAULT_SOURCES) {
        const source = sources.find((value) => value.id === seed.id)
        ok(source)
        equal(source.categoryId, seed.categoryId)
        equal(source.enabled, true)
        equal(source.displayEnabled, true)
      }
      equal(ctx.repository.listRssCategories().length, 4)
    } finally { cleanup(ctx) }
  })

  it('updates a source without changing its identity or other settings', () => {
    const ctx = makeRepository()
    try {
      ctx.repository.setRssSourceEnabled('rss.nature', false)
      const updated = ctx.repository.saveRssSource({ id: 'rss.nature', ...sourceInput('rsscat.academic-papers', 'Nature updated', 'https://www.nature.com/nature.rss') })
      equal(updated.enabled, false)
      equal(updated.title, 'Nature updated')
    } finally { cleanup(ctx) }
  })

  it('hard-deletes source config while retaining item snapshots and URL dedupe', () => {
    const ctx = makeRepository()
    try {
      const created = ctx.repository.saveRssSource(sourceInput('rsscat.industry'))
      const inserted = ctx.repository.insertNewRssItems([{ guid: 'u1', title: 'A', url: 'https://x/1', summary: '', publishedAt: null, sourceId: created.id }])
      equal(inserted.length, 1)
      ctx.repository.deleteRssSource(created.id)
      equal(ctx.repository.listRssSources().some((source) => source.id === created.id), false)
      const history = ctx.repository.queryRssItems({ sourceIds: [created.id], keywords: [], authors: [], includeHidden: false, cursor: null, limit: 50 }).items
      equal(history.length, 1)
      equal(history[0]?.sourceDeleted, true)
      equal(history[0]?.sourceTitle, 'PLOS ONE')
      equal(ctx.repository.insertNewRssItems([{ guid: 'u1', title: 'A', url: 'https://x/1', summary: '', publishedAt: null, sourceId: 'rss.nature' }]).length, 0)
      const replacement = ctx.repository.saveRssSource(sourceInput('rsscat.industry', 'PLOS replacement'))
      ok(replacement.id !== created.id)
    } finally { cleanup(ctx) }
  })

  it('supports custom category lifecycle and protects built-ins/in-use categories', () => {
    const ctx = makeRepository()
    try {
      const category = ctx.repository.saveRssCategory({ name: '自定义' })
      const renamed = ctx.repository.saveRssCategory({ id: category.id, name: '自定义二' })
      equal(renamed.name, '自定义二')
      throws(() => ctx.repository.deleteRssCategory('rsscat.technology-news'), /不可删除/)
      const source = ctx.repository.saveRssSource(sourceInput(category.id, 'Custom source', 'https://example.com/custom.xml'))
      throws(() => ctx.repository.deleteRssCategory(category.id), /使用/)
      ctx.repository.saveRssSource({ id: source.id, ...sourceInput('rsscat.industry', 'Custom source', 'https://example.com/custom.xml') })
      ctx.repository.deleteRssCategory(category.id)
    } finally { cleanup(ctx) }
  })

  it('dedupes fetched items and filters by category and display visibility', () => {
    const ctx = makeRepository()
    try {
      ctx.repository.insertNewRssItems([
        { guid: 'tech-1', title: 'TypeScript tools', url: 'https://x/tech-1', summary: 'runtime', authors: ['Bob'], publishedAt: '2026-09-20T00:00:00.000Z', sourceId: 'rss.juejin' },
        { guid: 'paper-1', title: 'Materials', url: 'https://x/paper-1', summary: '', authors: ['Alice'], publishedAt: '2025-01-02T00:00:00.000Z', sourceId: 'rss.nature' }
      ])
      const base = { keywords: [], sourceIds: [], authors: [], includeHidden: false, cursor: null, limit: 50 }
      equal(ctx.repository.queryRssItems({ ...base, sourceIds: ['rss.juejin'] }).items.length, 1)
      equal(ctx.repository.queryRssItems({ ...base, sourceIds: ['rss.nature'] }).items.length, 1)
      ctx.repository.setRssSourceDisplayEnabled('rss.juejin', false)
      equal(ctx.repository.queryRssItems({ ...base, sourceIds: ['rss.juejin'] }).items.length, 0)
      equal(ctx.repository.queryRssItems({ ...base, sourceIds: ['rss.juejin'], includeHidden: true }).items.length, 1)
    } finally { cleanup(ctx) }
  })
})
