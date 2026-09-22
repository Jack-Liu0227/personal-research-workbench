import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentRunRecord } from '@prw/contracts'
import {
  FEISHU_DAILY_MSG_WORKFLOW_KEY,
  buildFeishuMatrixBriefing,
  buildFeishuMessageProjection,
  chunkFeishuMessage,
  deliverFeishuMessage,
  type FeishuMessageWriter
} from '../src/feishu-message.js'
import { parseFeishuSendResult, parseFeishuStatusResult } from '../src/host.js'

/**
 * 每日文献推送（消息侧）边界模块：与 daily_digest→Obsidian 管线完全隔离的
 * 决策卡分块、矩阵增强简报、SQLite 投影与投递判定。核心验收点：
 * - 分块消息永不超长、优先换行/句号边界；
 * - 矩阵简报把条目压成模型可读中文文本、空矩阵不产生占位块；
 * - 投递只认 literature_daily_msg，其余工作流 NOT_LITERATURE_DAILY_MSG 跳过；
 * - 无宿主 sink → NO_SINK；发送失败 → SEND_FAILED；绝不把投递问题伪装成运行失败。
 */

function run(workflowKey: AgentRunRecord['workflowKey'], overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: 'run-1',
    jobId: 'builtin.schedule.feishu-daily-msg',
    conversationId: null,
    idempotencyKey: 'occ-1',
    runtime: 'pi',
    transport: 'inprocess',
    workflowKey,
    projectId: null,
    paperIds: [],
    toolProfile: 'read-only',
    permissionMode: 'read-only',
    approvalPolicy: 'on-request',
    skillKey: 'literature-matrix',
    skillSnapshot: null,
    credentialSource: 'app-safeStorage',
    status: 'completed',
    input: { instructions: 'x' },
    output: '',
    artifactId: null,
    error: null,
    createdAt: '2026-09-20T01:00:00.000Z',
    startedAt: '2026-09-20T01:00:01.000Z',
    finishedAt: '2026-09-20T01:02:00.000Z',
    ...overrides
  }
}

function recordingWriter(failures: string[] = []): { writer: FeishuMessageWriter; texts: string[] } {
  const texts: string[] = []
  const writer: FeishuMessageWriter = {
    async sendText(text: string): Promise<void> {
      if (failures.includes(text)) throw new Error('飞书 API 返回 99991663: 发送频率受限')
      texts.push(text)
    }
  }
  return { writer, texts }
}

describe('chunkFeishuMessage', () => {
  it('returns a single chunk for short text', () => {
    assert.deepEqual(chunkFeishuMessage('【第 1 篇】\n- 中文标题：A'), ['【第 1 篇】\n- 中文标题：A'])
  })

  it('returns no chunks for empty or blank text', () => {
    assert.deepEqual(chunkFeishuMessage(''), [])
    assert.deepEqual(chunkFeishuMessage('   \n  '), [])
  })

  it('splits at a newline boundary before the limit', () => {
    const text = `${'a'.repeat(100)}\n${'b'.repeat(100)}\n${'c'.repeat(100)}`
    const chunks = chunkFeishuMessage(text, 150)
    // Every chunk ends exactly at a newline: a, b, c land in their own chunk.
    assert.deepEqual(chunks, ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100)])
    for (const chunk of chunks) assert.ok(chunk.length <= 150)
  })

  it('falls back to a sentence boundary then a hard cut, never exceeding the limit', () => {
    // No newline within the window: the sentence boundary is used.
    const sentences = `${'甲'.repeat(80)}。${'乙'.repeat(80)}。${'丙'.repeat(80)}。`
    const bySentence = chunkFeishuMessage(sentences, 100)
    for (const chunk of bySentence) assert.ok(chunk.length <= 100)
    assert.ok(bySentence.length >= 3)
    // No newline and no sentence boundary: a hard cut still keeps every chunk
    // within the limit and concatenation preserves the text.
    const solid = 'x'.repeat(500)
    const byHardCut = chunkFeishuMessage(solid, 120)
    for (const chunk of byHardCut) assert.ok(chunk.length <= 120)
    assert.equal(byHardCut.join(''), solid)
  })
})

describe('buildFeishuMatrixBriefing', () => {
  it('compresses matrix rows into a readable Chinese briefing', () => {
    const briefing = buildFeishuMatrixBriefing([
      {
        paperId: 'p1',
        researchQuestion: 'RAG 检索增强在长文档问答中的失效模式',
        method: '系统综述',
        data: '42 篇实证研究',
        keyFindings: '上下文窗口增大后检索噪声反而降低准确率',
        limitations: '样本偏英文',
        evidence: '中等',
        relevance: '高',
        qualityScore: 85,
        customFields: {},
        createdAt: 'x',
        updatedAt: 'x'
      }
    ])
    assert.ok(briefing.includes('<literature_matrix>'))
    assert.ok(briefing.includes('研究问题：RAG 检索增强在长文档问答中的失效模式'))
    assert.ok(briefing.includes('关键发现：上下文窗口增大后检索噪声反而降低准确率'))
    assert.ok(briefing.includes('相关度：高'))
    assert.ok(briefing.includes('共 1 条'))
  })

  it('returns an empty string for an empty matrix (no placeholder block)', () => {
    assert.equal(buildFeishuMatrixBriefing([]), '')
  })

  it('bounds long fields and the whole briefing', () => {
    const long = '长'.repeat(10_000)
    const briefing = buildFeishuMatrixBriefing([{ paperId: 'p1', researchQuestion: long, method: '', data: '', keyFindings: long, limitations: '', evidence: '', relevance: null, qualityScore: null, customFields: {}, createdAt: 'x', updatedAt: 'x' }], 500)
    assert.ok(briefing.length <= 500 + '\n…（矩阵简报已截断）'.length)
    assert.ok(briefing.includes('…'))
  })
})

describe('buildFeishuMessageProjection', () => {
  it('records a sent delivery with the message count', () => {
    const projection = buildFeishuMessageProjection({
      delivery: { status: 'sent', messageCount: 3 },
      content: '【第 1 篇】…',
      dateKey: '2026-09-20',
      scheduleId: 'builtin.schedule.feishu-daily-msg',
      run: run('literature_daily_msg')
    })
    assert.ok(projection.title.includes('2026-09-20'))
    assert.ok(projection.body.includes('已发送 3 条飞书消息'))
    assert.ok(projection.body.includes('权威在飞书聊天记录'))
  })

  it('records a skip with its reason instead of claiming a send', () => {
    const projection = buildFeishuMessageProjection({
      delivery: { status: 'skipped', reason: 'SEND_FAILED', message: '飞书 API 超时' },
      content: '…',
      dateKey: '2026-09-20',
      scheduleId: 'sched-1',
      run: run('literature_daily_msg')
    })
    assert.ok(projection.body.includes('飞书消息未发送（SEND_FAILED）：飞书 API 超时'))
  })
})

describe('deliverFeishuMessage', () => {
  it('skips any workflow that is not literature_daily_msg', async () => {
    const { writer } = recordingWriter()
    const result = await deliverFeishuMessage(writer, {
      scheduleId: 'sched-1',
      run: run('daily_digest'),
      content: '正文'
    })
    assert.deepEqual(result, { status: 'skipped', reason: 'NOT_LITERATURE_DAILY_MSG', message: '工作流 daily_digest 不发送飞书消息。' })
  })

  it('skips with NO_SINK when the host has no writer', async () => {
    const result = await deliverFeishuMessage(null, {
      scheduleId: 'sched-1',
      run: run('literature_daily_msg'),
      content: '正文'
    })
    assert.deepEqual(result, { status: 'skipped', reason: 'NO_SINK', message: '宿主未配置飞书消息投递通道，消息未发送。' })
  })

  it('sends every chunk and reports the count', async () => {
    const { writer, texts } = recordingWriter()
    const long = Array.from({ length: 40 }, (_, i) => `【第 ${String(i + 1)} 篇】\n- 中文摘要：${'字'.repeat(120)}`).join('\n\n')
    const result = await deliverFeishuMessage(writer, { scheduleId: 'sched-1', run: run('literature_daily_msg'), content: long })
    assert.equal(result.status, 'sent')
    if (result.status === 'sent') {
      assert.equal(result.messageCount, texts.length)
      assert.ok(result.messageCount >= 2, 'long content must be chunked into several messages')
      assert.equal(texts.join('').replace(/\s/gu, '').length, long.replace(/\s/gu, '').length, 'chunking must not lose content')
    }
  })

  it('records SEND_FAILED when a chunk fails, keeping the run outcome honest', async () => {
    const { writer } = recordingWriter(['第一次块'.repeat(400)])
    const result = await deliverFeishuMessage(writer, {
      scheduleId: 'sched-1',
      run: run('literature_daily_msg'),
      content: `${'第一次块'.repeat(400)}\n\n${'第二次块'.repeat(900)}`
    })
    assert.deepEqual(result.status, 'skipped')
    if (result.status === 'skipped') {
      assert.equal(result.reason, 'SEND_FAILED')
      assert.ok(result.message.includes('飞书'))
    }
  })

  it('skips empty output without attempting a send', async () => {
    const { writer, texts } = recordingWriter()
    const result = await deliverFeishuMessage(writer, { scheduleId: 'sched-1', run: run('literature_daily_msg'), content: '  ' })
    assert.deepEqual(result.status, 'skipped')
    if (result.status === 'skipped') assert.equal(result.reason, 'SEND_FAILED')
    assert.equal(texts.length, 0)
  })
})

describe('host feishu transport parsers', () => {
  it('parses a successful send result', () => {
    assert.deepEqual(parseFeishuSendResult({ type: 'feishu-send-result', requestId: 'r1', ok: true }), { requestId: 'r1', ok: true })
  })

  it('parses a refused send with its reason', () => {
    assert.deepEqual(
      parseFeishuSendResult({ type: 'feishu-send-result', requestId: 'r2', ok: false, error: 'FEISHU_NOT_BOUND：尚未绑定飞书应用，消息未发送。' }),
      { requestId: 'r2', ok: false, error: 'FEISHU_NOT_BOUND：尚未绑定飞书应用，消息未发送。' }
    )
  })

  it('drops malformed send results so Core fails closed', () => {
    for (const message of [null, 'feishu-send-result', { type: 'feishu-send-result', ok: true }, { type: 'feishu-send', requestId: 'x' }]) {
      assert.equal(parseFeishuSendResult(message), null)
    }
  })

  it('parses a bound-state answer', () => {
    assert.deepEqual(parseFeishuStatusResult({ type: 'feishu-status-result', requestId: 'r3', bound: true }), { requestId: 'r3', bound: true })
    assert.deepEqual(parseFeishuStatusResult({ type: 'feishu-status-result', requestId: 'r3', bound: false }), { requestId: 'r3', bound: false })
  })

  it('drops malformed status answers (unreadable and unbound are the same fail-closed answer)', () => {
    for (const message of [null, { type: 'feishu-status-result', requestId: 'r4' }, { type: 'feishu-status-result', bound: true }]) {
      assert.equal(parseFeishuStatusResult(message), null)
    }
  })
})

// 契约层面：消息侧工作流 key 必须与边界模块同源，避免两处字面量漂移。
describe('message workflow constant', () => {
  it('is the literature_daily_msg key the schedule contract ships', () => {
    assert.equal(FEISHU_DAILY_MSG_WORKFLOW_KEY, 'literature_daily_msg')
  })
})
