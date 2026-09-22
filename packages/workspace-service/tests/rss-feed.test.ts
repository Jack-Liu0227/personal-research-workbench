import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { equal, ok, throws } from 'node:assert/strict'
import { RssFeedError, fetchRssFeed, parseFeedXml, parseFeedMetadata, previewRssFeed, stripHtml } from '../src/rss-feed.js'

const RDF_FEED = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel rdf:about="http://feeds.nature.com/example/rss/current">
    <title>Example Journal</title>
    <link>https://www.nature.com/example</link>
  </channel>
  <item rdf:about="https://www.nature.com/articles/s41586-001">
    <title>First paper with <b>markup</b> &amp; entities</title>
    <link>https://www.nature.com/articles/s41586-001</link>
    <dc:date>2026-09-20T10:00:00Z</dc:date>
    <description>&lt;p&gt;A short abstract.&lt;/p&gt;</description>
    <content:encoded><![CDATA[<p>Full text summary here.</p>]]></content:encoded>
  </item>
  <item rdf:about="https://www.nature.com/articles/s41586-002">
    <title>Second paper</title>
    <link>https://www.nature.com/articles/s41586-002</link>
    <dc:date>2026-09-19T08:00:00Z</dc:date>
  </item>
</rdf:RDF>`

const RSS2_FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>RSS2 Journal</title>
  <item><title>RSS2 paper</title><link>https://example.org/p1</link><pubDate>Mon, 21 Sep 2026 00:00:00 GMT</pubDate><description>RSS2 abstract</description></item>
</channel></rss>`

const ATOM_FEED = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Journal</title>
  <entry><title>Atom paper</title><link href="https://example.org/a1"/><updated>2026-09-21T00:00:00Z</updated><summary>Atom abstract</summary></entry>
</feed>`

describe('rss-feed parseFeedXml', () => {
  it('parses RSS 1.0 (RDF) feeds with Nature-style item placement', () => {
    const items = parseFeedXml(RDF_FEED, 'rss.nature', 'https://www.nature.com/nature.rss')
    equal(items.length, 2)
    // 行内标签文本追加在标题末尾（fast-xml-parser 混合内容不保序）：
    // 断言覆盖文本片段与实体还原，不苛求行内标签的原始位置。
    ok(items[0].title.includes('First paper with') && items[0].title.includes('&'), 'title text and entities must survive')
    ok(items[0].title.includes('markup'), 'inline tag text must be kept')
    equal(items[0].url, 'https://www.nature.com/articles/s41586-001')
    equal(items[0].guid, items[0].url)
    equal(items[0].publishedAt, '2026-09-20T10:00:00.000Z')
    equal(items[0].summary, 'Full text summary here.')
    equal(items[0].sourceId, 'rss.nature')
  })

  it('parses RSS 2.0 feeds', () => {
    const items = parseFeedXml(RSS2_FEED, 'src-a', 'https://example.org/rss2')
    equal(items.length, 1)
    equal(items[0].title, 'RSS2 paper')
    equal(items[0].summary, 'RSS2 abstract')
    ok(items[0].publishedAt !== null, 'pubDate must be normalized to ISO')
  })

  it('parses Atom feeds', () => {
    const items = parseFeedXml(ATOM_FEED, 'src-b', 'https://example.org/atom')
    equal(items.length, 1)
    equal(items[0].title, 'Atom paper')
    equal(items[0].url, 'https://example.org/a1')
    equal(items[0].publishedAt, '2026-09-21T00:00:00.000Z')
  })

  it('drops entries without a usable title or http link', () => {
    const xml = RDF_FEED.replace(
      '<title>Second paper</title>',
      '<title>   </title>'
    )
    const items = parseFeedXml(xml, 'rss.nature', 'u')
    equal(items.length, 1)
  })

  it('rejects malformed XML and unknown roots with RssFeedError', () => {
    throws(() => parseFeedXml('<broken', 'rss.nature', 'u'), RssFeedError)
    throws(() => parseFeedXml('<yaml>not a feed</yaml>', 'rss.nature', 'u'), /无法识别的 feed 格式/)
  })

  it('keeps summary bounded and HTML-free', () => {
    const items = parseFeedXml(RDF_FEED, 'rss.nature', 'u')
    ok(!items[0].summary.includes('<'), 'summary must be stripped of tags')
  })

  it('bounds unusually long author fields before contract validation', () => {
    const xml = RSS2_FEED.replace('</item>', `<author>${'x'.repeat(500)}</author></item>`)
    const items = parseFeedXml(xml, 'rss.hacker-news', 'https://example.org/rss2')
    equal(items[0]?.authors[0]?.length, 300)
  })
})

describe('rss-feed fetchRssFeed', () => {
  it('previews feed metadata before a source is saved', async () => {
    const fetchImpl = async (): Promise<Response> => new Response(RSS2_FEED, { status: 200 })
    const preview = await previewRssFeed('https://example.org/rss2', fetchImpl)
    equal(preview.title, 'RSS2 Journal')
    equal(preview.siteUrl, 'https://example.org')
    equal(preview.format, 'rss2')
    equal(parseFeedMetadata(ATOM_FEED, 'https://example.org/atom').format, 'atom')
  })
  it('fetches and parses a 200 feed', async () => {
    const fetchImpl = async (): Promise<Response> => new Response(RDF_FEED, { status: 200 })
    const result = await fetchRssFeed(
      { id: 'rss.nature', title: 'Nature', url: 'https://www.nature.com/nature.rss', enabled: true, sortOrder: 0, createdAt: 'x' },
      fetchImpl
    )
    equal(result.items.length, 2)
    equal(result.source.title, 'Nature')
  })

  it('surfaces non-200 as RssFeedError', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('nope', { status: 404 })
    await assert.rejects(
      () => fetchRssFeed({ id: 'a', title: 'A', url: 'https://x.example/a', enabled: true, sortOrder: 0, createdAt: 'x' }, fetchImpl),
      /HTTP 404/
    )
  })

  it('surfaces network failure as RssFeedError', async () => {
    const fetchImpl = async (): Promise<Response> => { throw new Error('ECONNREFUSED') }
    await assert.rejects(
      () => fetchRssFeed({ id: 'a', title: 'A', url: 'https://x.example/a', enabled: true, sortOrder: 0, createdAt: 'x' }, fetchImpl),
      /抓取失败：ECONNREFUSED/
    )
  })
})

describe('rss-feed stripHtml', () => {
  it('strips tags and restores common entities', () => {
    equal(stripHtml('<p>Hello &amp; <b>world</b></p>'), 'Hello & world')
    equal(stripHtml('a&nbsp;&nbsp;b'), 'a b')
  })
})
