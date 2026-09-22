import { afterEach, beforeEach, describe, it } from 'node:test'
import { deepEqual, equal, ok } from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { WorkbenchRepository } from '@prw/database'
import { IntelDailyCoordinator } from '../src/intel-daily.ts'

/**
 * Fixture mirrors the TrendRadar storage layout the reader consumes:
 *   output/news/<date>.db, output/rss/<date>.db (upstream schema.sql /
 *   rss_schema.sql), config/frequency_words.txt, config/custom/keyword/{frontier,paper}.txt.
 *
 * NOW = 2026-09-20 12:00 (+08:00). 24h cutoff = 09-19 12:00(+08:00);
 * 168h cutoff = 09-13 12:00(+08:00).
 */

const NOW = new Date('2026-09-20T12:00:00.000+08:00')

const NEWS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS platforms (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS news_items (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    platform_id TEXT NOT NULL,
    rank INTEGER NOT NULL,
    url TEXT NOT NULL,
    mobile_url TEXT,
    first_crawl_time TEXT,
    last_crawl_time TEXT,
    crawl_count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
`

const RSS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS rss_feeds (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS rss_items (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    feed_id TEXT NOT NULL,
    url TEXT NOT NULL,
    guid TEXT,
    published_at TEXT,
    summary TEXT,
    author TEXT,
    first_crawl_time TEXT,
    last_crawl_time TEXT,
    crawl_count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
`

const FREQUENCY_WORDS = `# 热点词库（与 TrendRadar 上游格式一致，词组以空行分隔）
[GLOBAL_FILTER]
抽奖

[WORD_GROUPS]

[AI大模型]
+AI
+大模型
=> AI 大模型
芯片

[发布]
发布
`

const FRONTIER_WORDS = `[GLOBAL_FILTER]
广告

[WORD_GROUPS]

[前沿科技]
量子
脑机
`

const PAPER_WORDS = `[WORD_GROUPS]

[论文研究]
研究
论文
arXiv
`

function makeNewsDb(dir: string, dateKey: string, rows: Array<{ title: string; rank: number; firstCrawl: string }>): void {
  mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, `${dateKey}.db`))
  db.exec(NEWS_SCHEMA)
  db.prepare('INSERT INTO platforms (id, name, is_active, updated_at) VALUES (?, ?, 1, ?)').run('weibo', '微博', NOW.toISOString())
  const insertItem = db.prepare(`
    INSERT INTO news_items (id, title, platform_id, rank, url, mobile_url, first_crawl_time, last_crawl_time, crawl_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `)
  for (const row of rows) {
    insertItem.run(
      `${dateKey}-${row.title}`,
      row.title,
      'weibo',
      row.rank,
      `https://example.com/${encodeURIComponent(row.title)}`,
      null,
      row.firstCrawl,
      row.firstCrawl,
      NOW.toISOString(),
      NOW.toISOString()
    )
  }
  db.close()
}

function makeRssDb(dir: string, dateKey: string, rows: Array<{ title: string; publishedAt: string | null; firstCrawl: string }>): void {
  mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, `${dateKey}.db`))
  db.exec(RSS_SCHEMA)
  db.prepare('INSERT INTO rss_feeds (id, name, url, is_active, updated_at) VALUES (?, ?, ?, 1, ?)').run('arxiv_cs_ai', 'arXiv cs.AI', 'https://export.arxiv.org/rss/cs.AI', NOW.toISOString())
  const insertItem = db.prepare(`
    INSERT INTO rss_items (id, title, feed_id, url, guid, published_at, summary, author, first_crawl_time, last_crawl_time, crawl_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `)
  for (const row of rows) {
    insertItem.run(
      `${dateKey}-${row.title}`,
      row.title,
      'arxiv_cs_ai',
      `https://example.com/rss/${encodeURIComponent(row.title)}`,
      null,
      row.publishedAt,
      '摘要占位',
      '测试作者',
      row.firstCrawl,
      row.firstCrawl,
      NOW.toISOString(),
      NOW.toISOString()
    )
  }
  db.close()
}

function writeKeywordFiles(root: string): void {
  mkdirSync(join(root, 'config', 'custom', 'keyword'), { recursive: true })
  writeFileSync(join(root, 'config', 'frequency_words.txt'), FREQUENCY_WORDS, 'utf8')
  writeFileSync(join(root, 'config', 'custom', 'keyword', 'frontier.txt'), FRONTIER_WORDS, 'utf8')
  writeFileSync(join(root, 'config', 'custom', 'keyword', 'paper.txt'), PAPER_WORDS, 'utf8')
}

/** Fixture layout（时间均为 +08:00）：
 * - 热榜今天：AI 大模型发布新版本(09:10, hot 命中)、芯片产业动态速览(09:20, required 缺失)、量子计算取得突破(10:00, frontier)
 * - 热榜昨天：昨日热点：AI 大模型引发关注(23:00, 24h 内命中)
 * - RSS 今天：AI 大模型研究综述(16:00, hot+论文组)、今日抽奖活动开始(10:00, 全局过滤)、脑机接口技术新进展(14:00, frontier)
 * - RSS 昨天：量子计算新论文登 arXiv(08:00，24h 外但 168h 内)
 * - RSS 7 天前：上周量子研究综述(14:00，168h 内)
 */
function buildFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'prw-intel-daily-'))
  writeKeywordFiles(root)
  const newsDir = join(root, 'output', 'news')
  const rssDir = join(root, 'output', 'rss')
  makeNewsDb(newsDir, '2026-09-20', [
    { title: 'AI 大模型发布新版本', rank: 1, firstCrawl: '09:10' },
    { title: '芯片产业动态速览', rank: 2, firstCrawl: '09:20' },
    { title: '量子计算取得突破', rank: 3, firstCrawl: '10:00' }
  ])
  makeNewsDb(newsDir, '2026-09-19', [
    { title: '昨日热点：AI 大模型引发关注', rank: 1, firstCrawl: '23:00' }
  ])
  makeRssDb(rssDir, '2026-09-20', [
    { title: 'AI 大模型研究综述', publishedAt: '2026-09-20T03:00:00.000Z', firstCrawl: '11:05' },
    { title: '今日抽奖活动开始', publishedAt: '2026-09-20T02:00:00.000Z', firstCrawl: '10:00' },
    { title: '脑机接口技术新进展', publishedAt: '2026-09-20T03:30:00.000Z', firstCrawl: '11:30' }
  ])
  makeRssDb(rssDir, '2026-09-19', [
    { title: '量子计算新论文登 arXiv', publishedAt: '2026-09-19T00:00:00.000Z', firstCrawl: '08:05' }
  ])
  makeRssDb(rssDir, '2026-09-13', [
    { title: '上周量子研究综述', publishedAt: '2026-09-13T06:00:00.000Z', firstCrawl: '14:00' }
  ])
  return root
}

describe('IntelDailyCoordinator', () => {
  let root: string
  let repo: WorkbenchRepository
  let coordinator: IntelDailyCoordinator

  beforeEach(() => {
    root = buildFixtureRoot()
    repo = new WorkbenchRepository({ filePath: join(root, 'workspace.sqlite3'), now: () => NOW })
    coordinator = new IntelDailyCoordinator(repo, () => NOW)
  })

  afterEach(() => {
    repo.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('reports not_configured before a root directory is saved', () => {
    const overview = coordinator.overview()
    equal(overview.source.status, 'not_configured')
    equal(overview.source.rootDir, null)
    equal(overview.sections.length, 3)
    for (const section of overview.sections) equal(section.itemCount, 0)
  })

  it('persists and clears the root directory through workspace settings', () => {
    equal(coordinator.getConfig().rootDir, null)
    const saved = coordinator.setConfig({ rootDir: root })
    equal(saved.rootDir, root)
    equal(coordinator.getConfig().rootDir, root)
    const cleared = coordinator.setConfig({ rootDir: '  ' })
    equal(cleared.rootDir, null)
    equal(coordinator.getConfig().rootDir, null)
  })

  it('marks the source ready and reports which day databases were read', () => {
    coordinator.setConfig({ rootDir: root })
    const overview = coordinator.overview()
    equal(overview.source.status, 'ready')
    deepEqual(overview.source.newsDbDates.sort(), ['2026-09-19', '2026-09-20'])
    deepEqual(overview.source.rssDbDates.sort(), ['2026-09-13', '2026-09-19', '2026-09-20'])
  })

  it('builds 热点日报 from hot-list platforms only, with keyword groups and the 24h window', () => {
    coordinator.setConfig({ rootDir: root })
    const overview = coordinator.overview()
    const hot = overview.sections.find((section) => section.id === 'hot')!
    ok(hot)
    const titles = hot.items.map((item) => item.title)
    // 匹配 AI大模型 组（required AI + 大模型）：今天 09:10 与昨天 23:00 都在 24h 内
    ok(titles.includes('AI 大模型发布新版本'))
    ok(titles.includes('昨日热点：AI 大模型引发关注'))
    // 缺 required 词 → 不匹配
    ok(!titles.includes('芯片产业动态速览'))
    // frontier 词条与 RSS 条目都不进 hot
    ok(!titles.includes('量子计算取得突破'))
    ok(hot.items.every((item) => item.kind === 'hot'))
    // 时间倒序：今天 09:10 最新，其次昨天 23:00
    equal(hot.items[0]?.title, 'AI 大模型发布新版本')
    equal(hot.items[1]?.title, '昨日热点：AI 大模型引发关注')
  })

  it('builds 前沿瞭望 from RSS + hot with the frontier keyword group and the 24h window', () => {
    coordinator.setConfig({ rootDir: root })
    const overview = coordinator.overview()
    const frontier = overview.sections.find((section) => section.id === 'frontier')!
    const titles = frontier.items.map((item) => item.title)
    // 热榜与 RSS 来源都参与：量子计算取得突破（hot）+ 脑机接口技术新进展（rss）
    ok(titles.includes('量子计算取得突破'))
    ok(titles.includes('脑机接口技术新进展'))
    // 昨天的 RSS 量子新闻在 24h 窗口外（08:00 < 09-19 12:00 截止）
    ok(!titles.includes('量子计算新论文登 arXiv'))
    ok(!titles.includes('上周量子研究综述'))
    // AI 大模型不命中 frontier 词（无 量子/脑机）
    ok(!titles.includes('AI 大模型发布新版本'))
    // 排序：脑机接口（14:00）在量子计算（10:00）之前
    equal(frontier.items[0]?.title, '脑机接口技术新进展')
  })

  it('builds 科技周报 from RSS only with the paper keyword group and the 168h window', () => {
    coordinator.setConfig({ rootDir: root })
    const overview = coordinator.overview()
    const tech = overview.sections.find((section) => section.id === 'tech')!
    const titles = tech.items.map((item) => item.title)
    // 今天、昨天、7 天前（09-13 14:00）都在 168h 窗口内
    ok(titles.includes('AI 大模型研究综述'))
    ok(titles.includes('量子计算新论文登 arXiv'))
    ok(titles.includes('上周量子研究综述'))
    // 只有 rss；热榜与无关键词的 RSS 不进 tech
    ok(tech.items.every((item) => item.kind === 'rss'))
    ok(!titles.includes('脑机接口技术新进展'))
    // 抽奖（全局过滤）永不出现
    ok(!titles.some((title) => title.includes('抽奖')))
  })

  it('carries RSS publish times and hot-list crawl fallbacks into the DTO', () => {
    coordinator.setConfig({ rootDir: root })
    const overview = coordinator.overview()
    const tech = overview.sections.find((section) => section.id === 'tech')!
    const research = tech.items.find((item) => item.title === 'AI 大模型研究综述')!
    equal(research.publishedAt, '2026-09-20T03:00:00.000Z')
    const hot = overview.sections.find((section) => section.id === 'hot')!
    ok(hot.items.every((item) => item.publishedAt === null))
    ok(hot.items.every((item) => item.crawledAt.length > 0))
  })

  it('degrades to not_found when the configured root has no databases', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'prw-intel-daily-empty-'))
    try {
      mkdirSync(join(emptyRoot, 'output', 'news'), { recursive: true })
      mkdirSync(join(emptyRoot, 'output', 'rss'), { recursive: true })
      coordinator.setConfig({ rootDir: emptyRoot })
      const overview = coordinator.overview()
      equal(overview.source.status, 'not_found')
      equal(overview.source.newsDbDates.length, 0)
      equal(overview.source.rssDbDates.length, 0)
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true })
    }
  })
})
