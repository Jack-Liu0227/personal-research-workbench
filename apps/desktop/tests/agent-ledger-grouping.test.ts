import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { groupRecordsByRun } from '../src/renderer/src/features/agent/ledger.js'

type Entry = Parameters<typeof groupRecordsByRun>[0][number]

function record(overrides: Partial<Entry> & { runId: string; recordKey: string }): Entry {
  return {
    id: `row.${overrides.recordKey}`,
    seq: 0,
    status: 'completed',
    turn: 0,
    step: 0,
    title: '',
    detail: '',
    inputText: null,
    outputText: null,
    toolName: null,
    parentId: null,
    startedAt: null,
    durationMs: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    kind: 'user',
    ...overrides
  } as Entry
}

describe('groupRecordsByRun', () => {
  it('keeps each prompt next to the answer it produced', () => {
    const runs = groupRecordsByRun([
      record({ runId: 'run-a', recordKey: 'a.user', turn: 0, seq: 0, detail: '第一个问题' }),
      record({ runId: 'run-a', recordKey: 'a.assistant', kind: 'assistant', turn: 1, seq: 1, outputText: '第一个回答' }),
      record({ runId: 'run-b', recordKey: 'b.user', turn: 0, seq: 0, detail: '第二个问题' }),
      record({ runId: 'run-b', recordKey: 'b.assistant', kind: 'assistant', turn: 1, seq: 1, outputText: '第二个回答' })
    ])
    assert.equal(runs.length, 2)
    assert.deepEqual(runs.map((run) => run.runId), ['run-a', 'run-b'])
    assert.deepEqual(runs[0]?.records.map((item) => item.recordKey), ['a.user', 'a.assistant'])
    assert.deepEqual(runs[1]?.records.map((item) => item.recordKey), ['b.user', 'b.assistant'])
    for (const run of runs) {
      assert.equal(run.turns.length, 2)
      assert.equal(run.turns[0]?.records[0]?.kind, 'user')
      assert.equal(run.turns[1]?.records[0]?.kind, 'assistant')
    }
  })

  it('orders runs by earliest record time, not by run id', () => {
    const runs = groupRecordsByRun([
      record({ runId: 'run-zzz', recordKey: 'z.user', createdAt: '2026-01-01T10:00:00.000Z' }),
      record({ runId: 'run-aaa', recordKey: 'a.user', createdAt: '2026-01-01T09:00:00.000Z' })
    ])
    assert.deepEqual(runs.map((run) => run.runId), ['run-aaa', 'run-zzz'])
  })

  it('sorts records inside a run by seq regardless of input order', () => {
    const runs = groupRecordsByRun([
      record({ runId: 'run-a', recordKey: 'a.third', seq: 2 }),
      record({ runId: 'run-a', recordKey: 'a.first', seq: 0 }),
      record({ runId: 'run-a', recordKey: 'a.second', seq: 1 })
    ])
    assert.deepEqual(runs[0]?.records.map((item) => item.recordKey), ['a.first', 'a.second', 'a.third'])
  })

  it('returns no runs for an empty ledger', () => {
    assert.deepEqual(groupRecordsByRun([]), [])
  })
})
