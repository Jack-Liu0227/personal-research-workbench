import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentInboxItem, AutomationRunHistoryEntry } from '@prw/contracts'
import {
  AGENT_RUN_STATUS_LABELS,
  INBOX_KIND_LABELS,
  PAPER_READ_STATUS_LABELS,
  artifactsCardEmptyText,
  buildPushLedger,
  firstMeaningfulLine,
  inboxCardEmptyText,
  inboxReadLabel,
  joinInboxWithPushLedger,
  pushSourceForArtifact,
  pushSourceForRun,
  summarizePushSource
} from '../src/renderer/src/features/dashboard-push.js'

/**
 * The overview page must never invent a record, a status, a count or an
 * Obsidian path. These tests pin the two halves of that promise:
 * a ledger-matched row renders the real rule/status/time/delivery, and a row
 * without a ledger entry says so instead of borrowing one.
 */

function entry(overrides: Partial<AutomationRunHistoryEntry> & { runId: string }): AutomationRunHistoryEntry {
  return {
    revision: 1,
    scheduleId: 'sched-1',
    status: 'completed',
    startedAt: '2026-09-13T01:11:00.000Z',
    finishedAt: '2026-09-13T01:12:00.000Z',
    occurrenceAt: '2026-09-13T01:00:00.000Z',
    occurrenceStatus: 'completed',
    occurrenceSource: 'catch-up',
    blockedReason: null,
    artifact: { id: 'artifact-1', title: '每日资讯 2026-09-13' },
    delivery: { status: 'written', relativePath: '每日资讯推送/2026-09-13.md', reason: null, message: null },
    ...overrides
  }
}

function inboxItem(overrides: Partial<AgentInboxItem> & { id: string }): AgentInboxItem {
  return {
    runId: null,
    artifactId: null,
    title: '每日资讯 2026-09-13',
    body: '# 标题\n\n正文摘要',
    kind: 'daily_digest',
    read: false,
    createdAt: '2026-09-13T01:12:00.000Z',
    ...overrides
  }
}

const ruleName = (scheduleId: string): string => (scheduleId === 'sched-1' ? '每日资讯推送' : `定时任务 ${scheduleId.slice(0, 8)}`)

test('the ledger resolves a rule name, a run status and a delivery path from real rows', () => {
  const ledger = buildPushLedger([entry({ runId: 'run-1' })], ruleName)
  const source = pushSourceForRun(ledger, 'run-1')
  assert.ok(source)
  assert.equal(source.scheduleName, '每日资讯推送')
  const summary = summarizePushSource(source)
  assert.equal(summary.matched, true)
  assert.match(summary.headline, /每日资讯推送/u)
  assert.match(summary.headline, new RegExp(AGENT_RUN_STATUS_LABELS.completed, 'u'))
  assert.match(summary.headline, /时间点完成/u)
  // The time point comes from the ledger, never from "now".
  assert.deepEqual(summary.details[0], '执行时间点：2026-09-13T01:00:00.000Z')
  assert.ok(summary.details.some((detail) => detail.includes('每日资讯推送/2026-09-13.md')))
  // An artifact row resolves through the same ledger entry.
  assert.equal(pushSourceForArtifact(ledger, 'artifact-1')?.runId, 'run-1')
  assert.equal(pushSourceForArtifact(ledger, 'artifact-missing'), null)
})

test('a blocked push keeps the real reason instead of a success badge', () => {
  const ledger = buildPushLedger([
    entry({
      runId: 'run-2',
      status: 'blocked',
      occurrenceStatus: 'blocked',
      blockedReason: 'Zotero 未授权：未写入 Zotero',
      artifact: null,
      delivery: { status: 'skipped', relativePath: null, reason: 'unauthorized', message: '集成未授权' }
    })
  ], ruleName)
  const summary = summarizePushSource(ledger.byRunId.get('run-2') ?? null)
  assert.equal(summary.matched, true)
  assert.match(summary.headline, new RegExp(AGENT_RUN_STATUS_LABELS.blocked, 'u'))
  assert.ok(summary.details.some((detail) => detail.includes('Zotero 未授权')))
  assert.ok(summary.details.some((detail) => detail.includes('Obsidian 未写入') && detail.includes('unauthorized')))
  assert.equal(summary.details.some((detail) => detail.includes('已写入')), false)
})

test('a run without a recorded delivery says so rather than implying a write', () => {
  const ledger = buildPushLedger([entry({ runId: 'run-3', delivery: null })], ruleName)
  const summary = summarizePushSource(ledger.byRunId.get('run-3') ?? null)
  assert.ok(summary.details.some((detail) => detail === '本次运行没有记录 Obsidian 投递结果。'))
})

test('an unmatched record is named as unmatched and gets no push status or path', () => {
  const summary = summarizePushSource(null)
  assert.equal(summary.matched, false)
  assert.match(summary.headline, /手动运行，或运行历史已删除/u)
  assert.deepEqual(summary.details, ['未显示投递状态与相对路径：本地没有对应记录。'])
  // A run that is not in the loaded ledger window is unmatched, not "completed".
  const ledger = buildPushLedger([entry({ runId: 'run-1' })], ruleName)
  assert.equal(summarizePushSource(pushSourceForRun(ledger, 'run-unknown')).matched, false)
  assert.equal(pushSourceForRun(ledger, null), null)
})

test('the newest ledger row wins so a re-run never rewrites an older delivery', () => {
  const ledger = buildPushLedger([
    entry({ runId: 'run-new', delivery: { status: 'written', relativePath: 'new.md', reason: null, message: null } }),
    entry({ runId: 'run-old', delivery: { status: 'written', relativePath: 'old.md', reason: null, message: null } })
  ], ruleName)
  assert.equal(ledger.entries.length, 2)
  assert.equal(ledger.byArtifactId.get('artifact-1')?.runId, 'run-new')
  assert.match(summarizePushSource(pushSourceForArtifact(ledger, 'artifact-1')).details.join(' '), /new\.md/u)
})

test('the inbox join keeps unmatched rows visible and explains them', () => {
  const ledger = buildPushLedger([entry({ runId: 'run-1' })], ruleName)
  const joined = joinInboxWithPushLedger(ledger, [
    inboxItem({ id: 'inbox-1', runId: 'run-1' }),
    inboxItem({ id: 'inbox-2', runId: 'run-manual' }),
    inboxItem({ id: 'inbox-3', runId: null })
  ])
  assert.deepEqual(joined.matched.map((row) => row.item.id), ['inbox-1'])
  assert.deepEqual(joined.unmatched.map((row) => row.item.id), ['inbox-2', 'inbox-3'])
  assert.match(joined.unmatchedNote ?? '', /另有 2 条收件箱记录/u)
  assert.match(joined.unmatchedNote ?? '', /手动运行，或运行历史已删除/u)
  // The unmatched rows are real records with no ledger entry, not placeholders.
  assert.equal(joined.unmatched[0]?.source, null)
  assert.equal(summarizePushSource(joined.unmatched[0]?.source ?? null).matched, false)

  const allMatched = joinInboxWithPushLedger(ledger, [inboxItem({ id: 'inbox-1', runId: 'run-1' })])
  assert.equal(allMatched.unmatched.length, 0)
  assert.equal(allMatched.unmatchedNote, null)

  const empty = joinInboxWithPushLedger({ byArtifactId: new Map(), byRunId: new Map(), entries: [] }, [])
  assert.deepEqual(empty.matched, [])
  assert.deepEqual(empty.unmatched, [])
  assert.equal(empty.unmatchedNote, null)
})

test('bounded row text comes from the record itself', () => {
  assert.equal(firstMeaningfulLine('## 标题\n\n正文'), '标题')
  assert.equal(firstMeaningfulLine('   \n\n- 第一行'), '第一行')
  assert.equal(firstMeaningfulLine(''), '')
  const long = firstMeaningfulLine('x'.repeat(200))
  assert.equal(long.length, 141)
  assert.match(long, /…$/u)
  // No body means no summary line, rather than placeholder prose.
  assert.equal(firstMeaningfulLine('\n \n'), '')
})

test('empty states and labels change with real data instead of fixed success copy', () => {
  assert.notEqual(inboxCardEmptyText(0), inboxCardEmptyText(3))
  assert.match(inboxCardEmptyText(0), /定时推送记录也是空的/u)
  assert.match(inboxCardEmptyText(3), /已加载 3 条定时推送记录/u)
  assert.notEqual(artifactsCardEmptyText(0), artifactsCardEmptyText(2))
  assert.equal(inboxReadLabel(false), '未读')
  assert.equal(inboxReadLabel(true), '已读')
  // Every inbox kind and paper state has a real label instead of a raw token.
  for (const kind of ['daily_digest', 'approval', 'failure', 'literature_review'] as const) {
    assert.ok(INBOX_KIND_LABELS[kind].length > 0, kind)
  }
  for (const status of ['inbox', 'queued', 'reading', 'read', 'archived'] as const) {
    assert.ok(PAPER_READ_STATUS_LABELS[status].length > 0, status)
  }
})
