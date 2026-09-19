import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PiLedgerNormalizer } from '../src/index.js'
import type { AgentRunRecordDraft } from '@prw/contracts'

const AT = '2026-01-01T00:00:00.000Z'

/** Feed a scripted event sequence and return every draft, tagged with the event
 * index that produced it so a mapping failure names the offending event. */
function feed(events: unknown[]): Array<{ at: number; draft: AgentRunRecordDraft }> {
  const normalizer = new PiLedgerNormalizer()
  return events.flatMap((event, at) => normalizer.accept(event, AT).map((draft) => ({ at, draft })))
}

function only(drafts: Array<{ at: number; draft: AgentRunRecordDraft }>, recordKey: string): AgentRunRecordDraft[] {
  return drafts.filter((entry) => entry.draft.recordKey === recordKey).map((entry) => entry.draft)
}

function last(drafts: Array<{ at: number; draft: AgentRunRecordDraft }>, recordKey: string): AgentRunRecordDraft | undefined {
  return only(drafts, recordKey).at(-1)
}

/** Select every revision of the records of one kind, independent of the key
 * scheme, so the mapping is asserted rather than the key format. */
function byKind(drafts: Array<{ at: number; draft: AgentRunRecordDraft }>, kind: string): AgentRunRecordDraft[] {
  return drafts.filter((entry) => entry.draft.kind === kind).map((entry) => entry.draft)
}

describe('PiLedgerNormalizer', () => {
  it('accumulates streamed assistant text instead of replacing it per delta', () => {
    const drafts = feed([
      { type: 'turn_start' },
      { type: 'message_start', message: { role: 'assistant', content: '' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你好' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '，世界' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '你好，世界' }] } }
    ])
    const assistant = byKind(drafts, 'assistant')
    assert.ok(assistant.length >= 3, 'each delta produces a revision of the same record')
    assert.equal(assistant[0]?.status, 'running')
    assert.equal(assistant.at(-1)?.status, 'completed')
    assert.equal(assistant.at(-1)?.detail, '你好，世界')
    assert.ok(assistant.at(-1)?.finishedAt, 'the final revision closes the record')
  })

  it('treats a text_end snapshot as authoritative rather than additive', () => {
    const drafts = feed([
      { type: 'turn_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '部分' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_end', content: '完整回答' } }
    ])
    assert.equal(byKind(drafts, 'assistant').at(-1)?.detail, '完整回答')
  })

  it('maps thinking deltas to a reasoning record and closes it with the message', () => {
    const drafts = feed([
      { type: 'turn_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '先想' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '一下' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '结论' }] } }
    ])
    const reasoning = byKind(drafts, 'reasoning')
    assert.equal(reasoning[0]?.detail, '先想')
    assert.equal(reasoning.at(-2)?.detail, '先想一下', 'the second delta appends to the first')
    assert.equal(reasoning.at(-1)?.status, 'completed', 'a message_end must not leave Thinking spinning')
  })

  it('ignores the user message echoed by the session because the coordinator already stored it', () => {
    const drafts = feed([
      { type: 'turn_start' },
      { type: 'message_start', message: { role: 'user', content: '写一个待办' } },
      { type: 'message_end', message: { role: 'user', content: '写一个待办' } }
    ])
    assert.deepEqual(drafts, [])
  })

  it('maps a tool lifecycle to one record that gains its output and duration', () => {
    const drafts = feed([
      { type: 'turn_start' },
      { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'tasks.create', args: { title: '读论文' } },
      { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'tasks.create', result: { content: [{ type: 'text', text: 'created task.task.1' }] } }
    ])
    const tool = only(drafts, 'pi:tool:call-1')
    assert.equal(tool.length, 2)
    assert.equal(tool[0]?.status, 'running')
    assert.equal(tool[0]?.toolName, 'tasks.create')
    assert.match(tool[0]?.inputText ?? '', /读论文/u)
    assert.equal(tool.at(-1)?.status, 'completed')
    assert.match(tool.at(-1)?.outputText ?? '', /created task\.task\.1/u)
    assert.equal(tool[0]?.step, 1, 'the first tool call opens step 1')
  })

  it('marks a failed tool call and keeps the failure visible', () => {
    const drafts = feed([
      { type: 'tool_execution_start', toolCallId: 'call-2', toolName: 'calendar.create', args: {} },
      { type: 'tool_execution_end', toolCallId: 'call-2', toolName: 'calendar.create', isError: true, result: { content: [{ type: 'text', text: 'permission denied' }] } }
    ])
    const tool = last(drafts, 'pi:tool:call-2')
    assert.equal(tool?.status, 'failed')
    assert.match(tool?.outputText ?? '', /permission denied/u)
  })

  it('reports the turn usage and duration on the turn boundary', () => {
    const drafts = feed([
      { type: 'turn_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '好' } },
      { type: 'turn_end', message: { role: 'assistant', usage: { input: 10, output: 5, totalTokens: 15 } } }
    ])
    const turnEnd = drafts.find((entry) => entry.draft.kind === 'turn_end')?.draft
    assert.ok(turnEnd, 'turn_end must produce a record')
    assert.equal(turnEnd.status, 'completed')
    assert.equal(turnEnd.usage?.input, 10)
    assert.equal(turnEnd.usage?.output, 5)
  })

  it('maps compaction to a single lifecycle record that closes on its end event', () => {
    const drafts = feed([
      { type: 'turn_start' },
      { type: 'compaction_start', reason: 'threshold' },
      { type: 'compaction_end', reason: 'threshold', result: { summary: 'ok' } }
    ])
    const compaction = only(drafts, 'pi:compaction')
    assert.equal(compaction[0]?.kind, 'compacted')
    assert.equal(compaction[0]?.status, 'running')
    assert.equal(compaction.at(-1)?.status, 'completed')
  })

  it('keeps an unrecognized event as an inspectable diagnostic rather than dropping it', () => {
    const drafts = feed([{ type: 'brand_new_event', payload: 1 }])
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0]?.draft.kind, 'diagnostic')
    assert.match(drafts[0]?.draft.title ?? '', /brand_new_event/u)
  })

  it('prints the workbench name of a tool the provider saw under a sanitized name', () => {
    const normalizer = new PiLedgerNormalizer({ toolLabels: new Map([['tasks_search', 'tasks.search']]) })
    const drafts = [
      { type: 'tool_execution_start', toolCallId: 'call-9', toolName: 'tasks_search', args: { query: 'x' } },
      { type: 'tool_execution_end', toolCallId: 'call-9', toolName: 'tasks_search', result: { content: [{ type: 'text', text: 'ok' }] } }
    ].flatMap((event) => normalizer.accept(event, AT))
    assert.equal(drafts.length, 2)
    assert.equal(drafts[0]?.toolName, 'tasks.search')
    assert.equal(drafts[0]?.title, 'tasks.search')
    assert.equal(drafts[1]?.toolName, 'tasks.search')
  })

  it('leaves an unmapped tool name alone', () => {
    const normalizer = new PiLedgerNormalizer({ toolLabels: new Map([['tasks_search', 'tasks.search']]) })
    const drafts = normalizer.accept({ type: 'tool_execution_start', toolCallId: 'call-10', toolName: 'notes_list', args: {} }, AT)
    assert.equal(drafts[0]?.toolName, 'notes_list')
  })

  it('ignores the session replay that would duplicate already-persisted records', () => {
    assert.deepEqual(feed([{ type: 'entry_appended', entry: { type: 'message' } }]), [])
    const normalizer = new PiLedgerNormalizer()
    assert.deepEqual(normalizer.accept('', AT), [], 'empty stdout lines produce nothing')
  })
})
