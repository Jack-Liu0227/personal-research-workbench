import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  IntelDailyConfigSchema,
  IntelDailyOverviewSchema,
  IntelDailySetConfigInputSchema,
  type IntelDailyConfig,
  type IntelDailyItem,
  type IntelDailyOverview,
  type IntelDailySection,
  type IntelDailySectionId,
  type IntelDailySetConfigInput,
  type IntelDailySource,
  type IntelDailySourceStatus
} from '@prw/contracts'
import type { WorkbenchRepository } from '@prw/database'

/**
 * 情报日报（Intel Daily）read-only consumer of the TrendRadar engine.
 *
 * Layout the reader understands (upstream TrendRadar v6 storage, verified
 * against `trendradar/storage/{schema,rss_schema}.sql`):
 *   <root>/output/news/<YYYY-MM-DD>.db   hot-list platform snapshots
 *   <root>/output/rss/<YYYY-MM-DD>.db    RSS item snapshots
 *   <root>/config/frequency_words.txt    default hot keyword groups
 *   <root>/config/custom/keyword/frontier.txt / paper.txt
 *
 * The engine stores everything in per-day databases and applies keyword groups
 * only at report time, so the workbench re-applies the same groups here. A
 * missing keyword file means "no filter" (upstream semantics), never an empty
 * section. Every open is read-only; this module never writes to the engine.
 *
 * Section mapping (matches the deployed timeline):
 *   frontier 前沿瞭望 — RSS + hot-list sources, frontier.txt, 24h window
 *   hot      热点日报 — hot-list platforms only, frequency_words.txt, 24h
 *   tech     科技周报 — RSS (papers/science) only, paper.txt, 168h window
 */

const INTEL_DAILY_ROOT_KEY = 'intelDaily.rootDir'
const MAX_ITEMS_PER_SECTION = 100
/** Widest window any section uses (tech = 7 days). */
const MAX_WINDOW_HOURS = 168

interface SectionSpec {
  readonly id: IntelDailySectionId
  readonly name: string
  readonly windowHours: number
  readonly kinds: ReadonlyArray<'rss' | 'hot'>
  readonly keywordFile: 'frontier' | 'frequency' | 'paper'
}

const SECTION_SPECS: readonly SectionSpec[] = [
  { id: 'frontier', name: '前沿瞭望', windowHours: 24, kinds: ['rss', 'hot'], keywordFile: 'frontier' },
  { id: 'hot', name: '热点日报', windowHours: 24, kinds: ['hot'], keywordFile: 'frequency' },
  { id: 'tech', name: '科技周报', windowHours: 168, kinds: ['rss'], keywordFile: 'paper' }
]

const KEYWORD_FILE_PATHS: Record<SectionSpec['keywordFile'], (rootDir: string) => string> = {
  frontier: (root) => join(root, 'config', 'custom', 'keyword', 'frontier.txt'),
  frequency: (root) => join(root, 'config', 'frequency_words.txt'),
  paper: (root) => join(root, 'config', 'custom', 'keyword', 'paper.txt')
}

interface WordRule {
  readonly word: string
  readonly isRegex: boolean
  readonly regex?: RegExp
}

interface WordGroup {
  required: WordRule[]
  normal: WordRule[]
  displayName: string | null
  maxCount: number
}

interface KeywordSet {
  readonly groups: WordGroup[]
  readonly filters: WordRule[]
  readonly globalFilters: WordRule[]
}

const EMPTY_KEYWORDS: KeywordSet = { groups: [], filters: [], globalFilters: [] }

/** Port of TrendRadar `core/frequency.py` word-rule parsing (verbatim
 * semantics: chunks split on blank lines, `[GLOBAL_FILTER]`/`[WORD_GROUPS]`
 * sections, `+` required / `!` top-level filter / `@` max-count / `/regex/`
 * words, `[alias]` display names). Display names are preserved but never used
 * to change the result. */
function parseKeywordFile(content: string): KeywordSet {
  const globalFilters: WordRule[] = []
  const filters: WordRule[] = []
  const groups: WordGroup[] = []
  let section: 'word_groups' | 'global_filter' = 'word_groups'

  const chunks = content.split(/\n\s*\n/u)
  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith('#'))
    if (lines.length === 0) continue

    const firstLine = lines[0]
    if (firstLine?.startsWith('[') && firstLine.endsWith(']')) {
      const marker = firstLine.slice(1, -1).trim().toLocaleUpperCase('en-US')
      if (marker === 'GLOBAL_FILTER' || marker === 'WORD_GROUPS') {
        section = marker === 'GLOBAL_FILTER' ? 'global_filter' : 'word_groups'
        lines.shift()
      }
    }

    if (section === 'global_filter') {
      for (const line of lines) {
        if (line.startsWith('!') || line.startsWith('+') || line.startsWith('@')) continue
        if (line.length === 0) continue
        const rule = parseWordRule(line)
        // A display-name-only line ("=> 别名") carries no matchable word; an
        // empty rule would match every title. Upstream stores such lines raw
        // and they never match; skipping them is the intended behavior.
        if (rule.word.length === 0) continue
        globalFilters.push(rule)
      }
      continue
    }

    const words = [...lines]
    let displayName: string | null = null
    if (words[0]?.startsWith('[') && words[0].endsWith(']')) {
      const alias = words[0].slice(1, -1).trim()
      if (alias.toLocaleUpperCase('en-US') !== 'GLOBAL_FILTER' && alias.toLocaleUpperCase('en-US') !== 'WORD_GROUPS') {
        displayName = alias
        words.shift()
      }
    }

    const group: WordGroup = { required: [], normal: [], displayName, maxCount: 0 }
    for (const word of words) {
      if (word.startsWith('@')) {
        const count = Number.parseInt(word.slice(1), 10)
        if (Number.isFinite(count) && count > 0) group.maxCount = count
      } else if (word.startsWith('!')) {
        filters.push(parseWordRule(word.slice(1)))
      } else if (word.startsWith('+')) {
        group.required.push(parseWordRule(word.slice(1)))
      } else {
        group.normal.push(parseWordRule(word))
      }
    }
    if (group.required.length > 0 || group.normal.length > 0) groups.push(group)
  }
  return { groups, filters, globalFilters }
}

function parseWordRule(raw: string): WordRule {
  let config = raw
  const arrowIndex = config.indexOf('=>')
  if (arrowIndex >= 0) config = config.slice(0, arrowIndex)
  config = config.trim()
  if (config.startsWith('/') && config.endsWith('/') && config.length >= 2) {
    const pattern = config.slice(1, -1)
    return { word: config, isRegex: true, regex: new RegExp(pattern, 'iu') }
  }
  return { word: config.toLocaleLowerCase('en-US'), isRegex: false }
}

function wordMatches(rule: WordRule, text: string): boolean {
  if (rule.isRegex) return rule.regex ? rule.regex.test(text) : false
  return text.includes(rule.word)
}

function matchesWordGroups(title: string, keywords: KeywordSet): boolean {
  const text = title.toLocaleLowerCase('en-US')
  if (text.trim().length === 0) return false
  // 全局过滤（优先级最高）
  if (keywords.globalFilters.some((rule) => wordMatches(rule, text))) return false
  // 未配置词组时匹配所有标题
  if (keywords.groups.length === 0) return true
  // 组级过滤词（顶层列表）
  if (keywords.filters.some((rule) => wordMatches(rule, text))) return false
  return keywords.groups.some((group) => {
    if (group.required.length > 0 && !group.required.every((rule) => wordMatches(rule, text))) return false
    if (group.normal.length > 0 && !group.normal.some((rule) => wordMatches(rule, text))) return false
    return true
  })
}

interface RawItem {
  readonly id: string
  readonly title: string
  readonly kind: 'rss' | 'hot'
  readonly sourceId: string
  readonly sourceName: string
  readonly url: string
  readonly summary: string
  readonly author: string
  readonly rank: number
  /** RSS feed-provided publish instant (ISO); null for hot-list rows. */
  readonly publishedAt: string | null
  readonly time: Date
}

interface NewsRow {
  id: string
  title: string
  platform_id: string
  platform_name: string | null
  rank: number | null
  url: string | null
  mobile_url: string | null
  first_crawl_time: string | null
  last_crawl_time: string | null
}

interface RssRow {
  id: string
  title: string
  feed_id: string
  feed_name: string | null
  url: string | null
  published_at: string | null
  summary: string | null
  author: string | null
  first_crawl_time: string | null
  last_crawl_time: string | null
}

const DB_NAME_PATTERN = /^(\d{4}-\d{2}-\d{2})\.db$/u

function toDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** TrendRadar stores crawl times as HH:MM; the day comes from the DB filename.
 * RSS `published_at` is an ISO string when the feed provides one. */
function parseCrawlTime(dateKey: string, crawlTime: string | null): Date | null {
  if (!crawlTime) return null
  const match = /^(\d{2}):(\d{2})$/u.exec(crawlTime.trim())
  if (match) return new Date(`${dateKey}T${match[1]}:${match[2]}:00`)
  const parsed = new Date(crawlTime)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function readNewsDb(dbPath: string, dateKey: string): RawItem[] {
  const database = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const rows = database.prepare(`
      SELECT n.id, n.title, n.platform_id, p.name AS platform_name, n.rank, n.url, n.mobile_url,
             n.first_crawl_time, n.last_crawl_time
      FROM news_items n
      LEFT JOIN platforms p ON p.id = n.platform_id
    `).all() as unknown as NewsRow[]
    const items: RawItem[] = []
    for (const row of rows) {
      const time = parseCrawlTime(dateKey, row.first_crawl_time ?? row.last_crawl_time)
      if (!time) continue
      items.push({
        id: row.id,
        title: row.title,
        kind: 'hot',
        sourceId: row.platform_id,
        sourceName: row.platform_name ?? '',
        url: row.url ?? row.mobile_url ?? '',
        summary: '',
        author: '',
        rank: row.rank ?? 0,
        publishedAt: null,
        time
      })
    }
    return items
  } finally {
    database.close()
  }
}

function readRssDb(dbPath: string, dateKey: string): RawItem[] {
  const database = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const rows = database.prepare(`
      SELECT r.id, r.title, r.feed_id, f.name AS feed_name, r.url, r.published_at, r.summary, r.author,
             r.first_crawl_time, r.last_crawl_time
      FROM rss_items r
      LEFT JOIN rss_feeds f ON f.id = r.feed_id
    `).all() as unknown as RssRow[]
    const items: RawItem[] = []
    for (const row of rows) {
      let time: Date | null = null
      if (row.published_at) {
        const parsed = new Date(row.published_at)
        if (!Number.isNaN(parsed.getTime())) time = parsed
      }
      time ??= parseCrawlTime(dateKey, row.first_crawl_time ?? row.last_crawl_time)
      if (!time) continue
      const publishedAt = row.published_at && !Number.isNaN(new Date(row.published_at).getTime())
        ? new Date(row.published_at).toISOString()
        : null
      items.push({
        id: row.id,
        title: row.title,
        kind: 'rss',
        sourceId: row.feed_id,
        sourceName: row.feed_name ?? '',
        url: row.url ?? '',
        summary: row.summary ?? '',
        author: row.author ?? '',
        rank: 0,
        publishedAt,
        time
      })
    }
    return items
  } finally {
    database.close()
  }
}

function listDayDbFiles(dir: string): Array<{ dateKey: string; path: string }> {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = DB_NAME_PATTERN.exec(entry.name)
      return match ? { dateKey: match[1], path: join(dir, entry.name) } : null
    })
    .filter((item): item is { dateKey: string; path: string } => item !== null)
}

interface TrendRadarData {
  readonly newsDbDates: string[]
  readonly rssDbDates: string[]
  readonly items: RawItem[]
}

function readTrendRadar(rootDir: string, now: Date): TrendRadarData {
  const outputDir = join(rootDir, 'output')
  const windowStart = new Date(now.getTime() - MAX_WINDOW_HOURS * 3_600_000)
  const minDateKey = toDateKey(windowStart)
  const maxDateKey = toDateKey(now)
  const items: RawItem[] = []
  const newsDbDates: string[] = []
  const rssDbDates: string[] = []
  const seen = new Set<string>()

  const addDayFiles = (files: Array<{ dateKey: string; path: string }>, kind: 'news' | 'rss'): void => {
    const inWindow = files.filter((file) => file.dateKey >= minDateKey && file.dateKey <= maxDateKey).sort((a, b) => b.dateKey.localeCompare(a.dateKey))
    for (const file of inWindow) {
      try {
        const dayItems = kind === 'news' ? readNewsDb(file.path, file.dateKey) : readRssDb(file.path, file.dateKey)
        for (const item of dayItems) {
          const dedupeKey = `${item.kind}:${item.url || item.title}`
          if (seen.has(dedupeKey)) continue
          seen.add(dedupeKey)
          items.push(item)
        }
        if (kind === 'news') newsDbDates.push(file.dateKey)
        else rssDbDates.push(file.dateKey)
      } catch {
        // A corrupt or foreign-format daily DB is skipped; other days still load.
      }
    }
  }

  addDayFiles(listDayDbFiles(join(outputDir, 'news')), 'news')
  addDayFiles(listDayDbFiles(join(outputDir, 'rss')), 'rss')
  return { newsDbDates, rssDbDates, items }
}

function loadKeywords(rootDir: string, file: SectionSpec['keywordFile']): KeywordSet {
  const path = KEYWORD_FILE_PATHS[file](rootDir)
  try {
    return parseKeywordFile(readFileSync(path, 'utf8'))
  } catch {
    return EMPTY_KEYWORDS
  }
}

function toItemDto(item: RawItem): IntelDailyItem {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    sourceId: item.sourceId,
    sourceName: item.sourceName,
    url: item.url,
    publishedAt: item.publishedAt,
    crawledAt: item.time.toISOString(),
    rank: item.rank,
    summary: item.summary,
    author: item.author
  }
}

export class IntelDailyCoordinator {
  constructor(
    private readonly repository: WorkbenchRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  getConfig(): IntelDailyConfig {
    const stored = this.repository.getWorkspaceSettingValue(INTEL_DAILY_ROOT_KEY)
    const storedRoot = stored?.value as { rootDir?: unknown } | null | undefined
    const rootDir = typeof storedRoot?.rootDir === 'string' ? storedRoot.rootDir.trim() : ''
    return IntelDailyConfigSchema.parse({ rootDir: rootDir.length > 0 ? rootDir : null })
  }

  setConfig(inputValue: IntelDailySetConfigInput): IntelDailyConfig {
    const input = IntelDailySetConfigInputSchema.parse(inputValue)
    const rootDir = input.rootDir.trim()
    if (rootDir.length > 0) this.repository.setWorkspaceSettingValue(INTEL_DAILY_ROOT_KEY, { rootDir })
    else this.repository.clearWorkspaceSettingValue(INTEL_DAILY_ROOT_KEY)
    return this.getConfig()
  }

  overview(): IntelDailyOverview {
    const now = this.now()
    const checkedAt = now.toISOString()
    const config = this.getConfig()
    const rootDir = config.rootDir

    if (!rootDir) {
      return IntelDailyOverviewSchema.parse({
        source: { status: 'not_configured', rootDir: null, newsDbDates: [], rssDbDates: [], checkedAt },
        sections: SECTION_SPECS.map((spec) => emptySection(spec))
      })
    }

    const data = readTrendRadar(rootDir, now)
    const status: IntelDailySourceStatus = data.newsDbDates.length + data.rssDbDates.length > 0 ? 'ready' : 'not_found'
    const source: IntelDailySource = { status, rootDir, newsDbDates: data.newsDbDates, rssDbDates: data.rssDbDates, checkedAt }

    const sections: IntelDailySection[] = SECTION_SPECS.map((spec) => {
      const keywords = loadKeywords(rootDir, spec.keywordFile)
      const cutoff = now.getTime() - spec.windowHours * 3_600_000
      const items = data.items
        .filter((item) => spec.kinds.includes(item.kind))
        .filter((item) => item.time.getTime() >= cutoff && item.time.getTime() <= now.getTime() + 3_600_000)
        .filter((item) => matchesWordGroups(item.title, keywords))
        .sort((a, b) => b.time.getTime() - a.time.getTime())
        .slice(0, MAX_ITEMS_PER_SECTION)
        .map(toItemDto)
      return IntelDailyOverviewSchema.shape.sections.element.parse({ id: spec.id, name: spec.name, windowHours: spec.windowHours, itemCount: items.length, items })
    })

    return IntelDailyOverviewSchema.parse({ source, sections })
  }
}

function emptySection(spec: SectionSpec): IntelDailySection {
  return IntelDailyOverviewSchema.shape.sections.element.parse({
    id: spec.id,
    name: spec.name,
    windowHours: spec.windowHours,
    itemCount: 0,
    items: []
  })
}
