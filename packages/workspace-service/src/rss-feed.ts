import { XMLParser } from 'fast-xml-parser'
import { EnvHttpProxyAgent } from 'undici'
import { RssSourcePreviewSchema, type RssFeedItem, type RssSource, type RssSourcePreview } from '@prw/contracts'

/**
 * RSS 订阅拉取与解析（每日文献推送 · 消息侧增量 3）。
 *
 * 只认三种主流 feed 格式，全部走 fast-xml-parser（MIT）的
 * `removeNSPrefix` 归一化键名：
 * - RSS 1.0（RDF）：根 `RDF`，item 在根级（与 channel 平级）——Nature 系全部如此；
 * - RSS 2.0：根 `rss` → `channel.item`；
 * - Atom：根 `feed` → `entry`。
 *
 * 安全边界：只解析文本节点与属性，不展开任何外部实体/DTD（fast-xml-parser
 * 默认不处理外部实体）；摘要剥掉 HTML 标签，防止注入式内容进飞书消息。
 */

/** 单源拉取失败的结构化错误：携带源 id/名称，协调器按源记录而不拖垮整体。 */
export class RssFeedError extends Error {
  readonly sourceId: string
  readonly url: string
  constructor(sourceId: string, url: string, message: string) {
    super(message)
    this.name = 'RssFeedError'
    this.sourceId = sourceId
    this.url = url
  }
}

export interface RssFetchImpl {
  (url: string, init?: RequestInit): Promise<Response>
}

const ambientProxyAgent = new EnvHttpProxyAgent()
const defaultRssFetch: RssFetchImpl = (url, init) => fetch(url, { ...init, dispatcher: ambientProxyAgent } as RequestInit & { dispatcher: EnvHttpProxyAgent })

interface ParsedItem {
  readonly title: unknown
  readonly link: unknown
  readonly date: unknown
  readonly summary: unknown
}

function collectText(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const child of value) collectText(child, out)
    return
  }
  const record = value as Record<string, unknown>
  // Atom 的 <link href="…"/> 没有文本节点，链接在属性里。
  if (typeof record['@_href'] === 'string') out.push(record['@_href'])
  // 混合内容（<title>text <b>markup</b> text</title>）里 fast-xml-parser
  // 把连续文本合并进 '#text'、行内标签拆成子键：先收文本段，行内标签文本
  // 追加在末尾（无法保序，但 Nature 系论文标题几乎不含行内标签，可接受）。
  const textNode = record['#text']
  if (typeof textNode === 'string') out.push(textNode)
  else if (Array.isArray(textNode)) for (const part of textNode) collectText(part, out)
  for (const [key, child] of Object.entries(record)) {
    if (key === '#text' || key.startsWith('@_')) continue
    // 行内标签（<b>markup</b>）的文本也是标题的一部分；只收叶子文本。
    if (typeof child === 'string' || Array.isArray(child) || (child !== null && typeof child === 'object')) {
      collectText(child, out)
    }
  }
}

function textOf(value: unknown): string {
  const parts: string[] = []
  collectText(value, parts)
  return parts.join('').trim()
}

function validateRssUrl(url: string): URL {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('RSS 地址必须是无凭据的 HTTP 或 HTTPS URL。')
  return parsed
}

function linkOf(value: unknown): string | null {
  const link = textOf(value)
  if (/^https?:\/\//u.test(link)) return link.slice(0, 2048)
  return null
}

function parseDocument(xml: string, sourceId: string, sourceUrl: string): { document: Record<string, unknown>; format: 'rss1' | 'rss2' | 'atom'; channel: Record<string, unknown> } {
  let document: Record<string, unknown>
  try {
    document = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, processEntities: true, trimValues: false }).parse(xml) as Record<string, unknown>
  } catch (error) {
    throw new RssFeedError(sourceId, sourceUrl, `RSS 解析失败：${error instanceof Error ? error.message : 'XML 解析失败'}`)
  }
  if (document.RDF !== undefined) {
    const root = document.RDF as Record<string, unknown>
    return { document, format: 'rss1', channel: (root.channel as Record<string, unknown> | undefined) ?? root }
  }
  if (document.rss !== undefined) {
    const channel = (document.rss as Record<string, unknown>).channel as Record<string, unknown> | undefined
    if (channel) return { document, format: 'rss2', channel }
  }
  if (document.feed !== undefined) return { document, format: 'atom', channel: document.feed as Record<string, unknown> }
  throw new RssFeedError(sourceId, sourceUrl, '无法识别的 feed 格式（仅支持 RSS 1.0 / RSS 2.0 / Atom）。')
}

export function parseFeedMetadata(xml: string, sourceUrl: string): RssSourcePreview {
  const url = validateRssUrl(sourceUrl)
  const { format, channel } = parseDocument(xml, 'preview', sourceUrl)
  const title = stripHtml(textOf(channel.title)) || url.hostname
  const siteUrl = linkOf(channel.link) ?? url.origin
  const description = stripHtml(textOf(channel.description) || textOf(channel.subtitle) || textOf(channel.tagline)).slice(0, 20_000)
  return RssSourcePreviewSchema.parse({ url: sourceUrl, title: title.slice(0, 120), siteUrl, description, format })
}

function itemsOf(channel: Record<string, unknown> | undefined, key: 'item' | 'entry'): unknown[] {
  if (!channel) return []
  const value = channel[key]
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/** 剥掉 HTML 标签并把常见实体还原，返回可读纯文本。 */
export function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&apos;/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * 解析一段 feed XML 为条目列表。对畸形 XML 或未知根结构抛 RssFeedError
 * （调用方按源记录），条目标题/链接缺失的条目被丢弃（不可推送）。
 */
export function parseFeedXml(xml: string, sourceId: string, sourceUrl: string): RssFeedItem[] {
  const { document } = parseDocument(xml, sourceId, sourceUrl)
  let rawItems: unknown[] = []
  if (document.RDF !== undefined) rawItems = itemsOf(document.RDF as Record<string, unknown>, 'item')
  else if (document.rss !== undefined) rawItems = itemsOf((document.rss as Record<string, unknown>).channel as Record<string, unknown> | undefined, 'item')
  else if (document.feed !== undefined) rawItems = itemsOf(document.feed as Record<string, unknown>, 'entry')

  const items: RssFeedItem[] = []
  for (const raw of rawItems) {
    if (raw === null || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const title = stripHtml(textOf(record.title))
    const link = textOf(record.link).trim()
    if (title.length === 0 || !/^https?:\/\//u.test(link)) continue
    // RSS 1.0 用 dc:date → date；RSS 2.0 用 pubDate；Atom 用 updated。
    const date = textOf(record.date) || textOf(record.pubDate) || textOf(record.updated)
    const parsedDate = new Date(date)
    const publishedAt = Number.isNaN(parsedDate.getTime()) ? null : parsedDate.toISOString()
    const summary = stripHtml(textOf(record.encoded) || textOf(record.description) || textOf(record.summary))
    const authorText = textOf(record.creator) || textOf(record.author) || textOf(record['dc:creator'])
    const authors = authorText.split(/[,;|]/u).map((author) => stripHtml(author).slice(0, 300)).filter((author) => author.length > 0).slice(0, 50)
    items.push({
      guid: link,
      title: title.slice(0, 500),
      url: link.slice(0, 2048),
      summary: summary.slice(0, 20_000),
      authors,
      publishedAt,
      sourceId
    })
  }
  return items
}

export interface RssFetchResult {
  readonly source: RssSource
  readonly items: RssFeedItem[]
}

/**
 * 拉取并解析单个订阅源。非 200、超时或解析失败都抛 RssFeedError，
 * 由调用方按源记录（单源故障不阻塞其余源）。
 */
export async function fetchRssFeed(
  source: RssSource,
  fetchImpl: RssFetchImpl = defaultRssFetch,
  timeoutMs = 20_000
): Promise<RssFetchResult> {
  validateRssUrl(source.url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetchImpl(source.url, {
      headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
      signal: controller.signal
    })
  } catch (error) {
    throw new RssFeedError(
      source.id,
      source.url,
      error instanceof Error && error.name === 'AbortError'
        ? `抓取超时（${Math.round(timeoutMs / 1000)}s）`
        : `抓取失败：${error instanceof Error ? error.message : '网络错误'}`
    )
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    throw new RssFeedError(source.id, source.url, `抓取失败：HTTP ${String(response.status)}`)
  }
  const xml = await response.text()
  const items = parseFeedXml(xml, source.id, source.url)
  return { source, items }
}

export async function previewRssFeed(sourceUrl: string, fetchImpl: RssFetchImpl = defaultRssFetch, timeoutMs = 20_000): Promise<RssSourcePreview> {
  validateRssUrl(sourceUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(sourceUrl, { headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' }, signal: controller.signal })
    if (!response.ok) throw new RssFeedError('preview', sourceUrl, `抓取失败：HTTP ${String(response.status)}`)
    return parseFeedMetadata(await response.text(), sourceUrl)
  } catch (error) {
    if (error instanceof RssFeedError) throw error
    throw new RssFeedError('preview', sourceUrl, error instanceof Error && error.name === 'AbortError' ? `抓取超时（${String(Math.round(timeoutMs / 1000))}s）` : `抓取失败：${error instanceof Error ? error.message : '网络错误'}`)
  } finally {
    clearTimeout(timer)
  }
}

/** 并行拉取多个源：返回各源结果与失败明细，调用方据此记录事件。 */
export async function fetchRssSources(
  sources: readonly RssSource[],
  fetchImpl: RssFetchImpl = defaultRssFetch
): Promise<{ readonly results: readonly RssFetchResult[]; readonly failures: readonly RssFeedError[] }> {
  const settled = await Promise.allSettled(sources.map((source) => fetchRssFeed(source, fetchImpl)))
  const results: RssFetchResult[] = []
  const failures: RssFeedError[] = []
  for (const item of settled) {
    if (item.status === 'fulfilled') results.push(item.value)
    else if (item.reason instanceof RssFeedError) failures.push(item.reason)
    else failures.push(new RssFeedError('unknown', '', item.reason instanceof Error ? item.reason.message : '未知抓取错误'))
  }
  return { results, failures }
}
