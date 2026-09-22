import { afterEach, describe, it } from 'node:test'
import { equal, match, ok } from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchRepository } from '@prw/database'
import { AgentCoordinator } from '../src/agent-coordinator.js'
import type { RssFetchImpl } from '../src/rss-feed.js'

/**
 * 姣忔棩鏂囩尞鎺ㄩ€?RSS 蹇矾寰勶紙澧為噺 3锛夊崗璋冨櫒绾ц涓猴細
 * - 宸茬粦瀹?+ 鏈夋柊澧?鈫?completed + 娑堟伅鎶曢€掞紙鍧楁暟/鍐呭缁?writer stub 楠岃瘉锛夛紱
 * - 鍚屼竴鎵规潯鐩啀娆¤繍琛?鈫?NO_NEW_ITEMS skipped锛坕tem_url 鍘婚噸璐︽湰鐢熸晥锛夛紱
 * - 鍗曟簮鎶撳彇澶辫触 鈫?鍏朵綑婧愮収甯告帹閫?+ RSS_SOURCE_FAILED 浜嬩欢璁板綍锛? * - 鏃犲凡鍚敤婧?鈫?NO_SOURCES skipped銆? */

const RDF_FEED = (title: string, link: string): string => `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="http://feeds.nature.com/x">
    <title>${title}</title>
  </channel>
  <item rdf:about="${link}">
    <title>${title} paper</title>
    <link>${link}</link>
    <dc:date>2026-09-20T10:00:00Z</dc:date>
  </item>
</rdf:RDF>`

const EMPTY_FEED = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
  <channel rdf:about="http://feeds.nature.com/x"><title>Empty</title></channel>
</rdf:RDF>`

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'prw-rss-push-'))
}

function stubFetch(byUrl: Record<string, string | Error>): RssFetchImpl {
  return async (url: string) => {
    const hit = byUrl[url]
    if (hit === undefined) return new Response(EMPTY_FEED, { status: 200 })
    if (hit instanceof Error) throw hit
    return new Response(hit, { status: 200 })
  }
}

describe('literature_daily_msg RSS fast path', () => {
  let root: string
  let repository: WorkbenchRepository
  let coordinator: AgentCoordinator

  afterEach(() => {
    coordinator?.dispose()
    repository?.close()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('pushes new items as one message chunk when bound and sources yield fresh papers', async () => {
    root = makeRoot()
    repository = new WorkbenchRepository({ filePath: join(root, 'workspace.sqlite3'), now: () => new Date('2026-09-20T04:00:00.000Z') })
    const sent: string[] = []
    coordinator = new AgentCoordinator(repository, {
      runRoot: join(root, 'agent-runs'),
      requestFeishuStatus: async () => true,
      deliverFeishuMessage: async ({ content }) => {
        sent.push(content)
        return { status: 'sent', messageCount: 1 }
      },
      rssFetchImpl: stubFetch({
        'https://www.nature.com/nature.rss': RDF_FEED('Nature', 'https://www.nature.com/articles/nat-001'),
        'https://www.nature.com/natcomputsci.rss': RDF_FEED('Nature Computational Science', 'https://www.nature.com/articles/ncs-001'),
        'https://www.nature.com/npjcompumats.rss': RDF_FEED('npj Computational Materials', 'https://www.nature.com/articles/npj-001'),
        'https://www.nature.com/natmachintell.rss': RDF_FEED('Nature Machine Intelligence', 'https://www.nature.com/articles/nmi-001')
      })
    })

    const run = await coordinator.runAutomationNow('builtin.schedule.feishu-daily-msg')
    equal(run.status, 'completed')
    equal(run.workflowKey, 'literature_daily_msg')
    ok(run.output.includes('每日 RSS 情报'), 'projection must be stored on the run')
    equal(sent.length, 1)
    match(sent[0], /新增 3 条/)
    match(sent[0], /Nature/)
    match(sent[0], /Nature paper/)
    match(sent[0], /https:\/\/www\.nature\.com\/articles\/nat-001/)
  })

  it('skips with NO_NEW_ITEMS when sources yield no fresh entries', async () => {
    root = makeRoot()
    repository = new WorkbenchRepository({ filePath: join(root, 'workspace.sqlite3'), now: () => new Date('2026-09-20T04:00:00.000Z') })
    const sent: string[] = []
    coordinator = new AgentCoordinator(repository, {
      runRoot: join(root, 'agent-runs'),
      requestFeishuStatus: async () => true,
      deliverFeishuMessage: async ({ content }) => {
        sent.push(content)
        return { status: 'sent', messageCount: 1 }
      },
      // Every source returns an empty feed: nothing new, nothing to push.
      rssFetchImpl: async () => new Response(EMPTY_FEED, { status: 200 })
    })
    const run = await coordinator.runAutomationNow('builtin.schedule.feishu-daily-msg')
    equal(run.status, 'completed')
    equal(sent.length, 0, 'no message may be sent when there is nothing new')
    const events = repository.listAgentEvents(run.id)
    ok(events.some((event) => event.payload?.code === 'FEISHU_MESSAGE_SKIPPED' && event.payload?.reason === 'NO_NEW_ITEMS'), 'skip must be recorded as FEISHU_MESSAGE_SKIPPED/NO_NEW_ITEMS')
  })

  it('replays the completed run for a duplicate trigger of the same slot (idempotent)', async () => {
    root = makeRoot()
    repository = new WorkbenchRepository({ filePath: join(root, 'workspace.sqlite3'), now: () => new Date('2026-09-20T04:00:00.000Z') })
    const sent: string[] = []
    coordinator = new AgentCoordinator(repository, {
      runRoot: join(root, 'agent-runs'),
      requestFeishuStatus: async () => true,
      deliverFeishuMessage: async ({ content }) => {
        sent.push(content)
        return { status: 'sent', messageCount: 1 }
      },
      rssFetchImpl: stubFetch({
        'https://www.nature.com/nature.rss': RDF_FEED('Nature', 'https://www.nature.com/articles/nat-001')
      })
    })
    const first = await coordinator.runAutomationNow('builtin.schedule.feishu-daily-msg')
    equal(first.status, 'completed')
    equal(sent.length, 1)
    const second = await coordinator.runAutomationNow('builtin.schedule.feishu-daily-msg')
    equal(second.id, first.id, 'a completed slot replays the same run row')
    equal(second.status, 'completed')
    equal(sent.length, 1, 'the replay must not send again')
  })

  it('keeps pushing other sources when one source fails, recording RSS_SOURCE_FAILED', async () => {
    root = makeRoot()
    repository = new WorkbenchRepository({ filePath: join(root, 'workspace.sqlite3'), now: () => new Date('2026-09-20T04:00:00.000Z') })
    const sent: string[] = []
    coordinator = new AgentCoordinator(repository, {
      runRoot: join(root, 'agent-runs'),
      requestFeishuStatus: async () => true,
      deliverFeishuMessage: async ({ content }) => {
        sent.push(content)
        return { status: 'sent', messageCount: 1 }
      },
      rssFetchImpl: stubFetch({
        'https://www.nature.com/nature.rss': new Error('ECONNREFUSED'),
        'https://www.nature.com/npjcompumats.rss': RDF_FEED('npj Computational Materials', 'https://www.nature.com/articles/npj-002')
      })
    })
    const run = await coordinator.runAutomationNow('builtin.schedule.feishu-daily-msg')
    equal(run.status, 'completed')
    equal(sent.length, 1)
    match(sent[0], /npj Computational Materials/)
    ok(!sent[0].includes('Nature paper'), 'failed source must not contribute items')
    const events = repository.listAgentEvents(run.id)
    ok(events.some((event) => event.payload?.code === 'RSS_SOURCE_FAILED' && event.payload?.sourceId === 'rss.nature'), 'source failure must be recorded')
  })

  it('skips with NO_SOURCES when every source is disabled or deleted', async () => {
    root = makeRoot()
    repository = new WorkbenchRepository({ filePath: join(root, 'workspace.sqlite3'), now: () => new Date('2026-09-20T04:00:00.000Z') })
    for (const source of repository.listRssSources()) repository.deleteRssSource(source.id)
    coordinator = new AgentCoordinator(repository, {
      runRoot: join(root, 'agent-runs'),
      requestFeishuStatus: async () => true
    })
    const run = await coordinator.runAutomationNow('builtin.schedule.feishu-daily-msg')
    equal(run.status, 'completed')
    const events = repository.listAgentEvents(run.id)
    ok(events.some((event) => event.payload?.code === 'FEISHU_MESSAGE_SKIPPED' && event.payload?.reason === 'NO_SOURCES'), 'NO_SOURCES must be recorded')
  })
})
