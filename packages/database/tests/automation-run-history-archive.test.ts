/*
 * Focused contract for the Automation page's RUN HISTORY record removal.
 *
 * RUN HISTORY is the audit ledger of what a schedule already did, so "删除" may
 * only soft-archive a run *record* in one CAS-locked transaction with per-record
 * receipts. These checks pin the promises the UI renders from: per-record
 * outcomes (succeeded/skipped/conflict), a revision lock on every write, the
 * record still readable in the local database afterwards, and no cascade into
 * the schedule rule, the occurrence ledger/cursor, the delivered Artifact,
 * Obsidian output, credentials or external data — and never a dropped
 * `agent_runs` row.
 *
 * Usage: pnpm test:automation-run-history-delete
 */
import { afterEach, describe, it } from 'node:test'
import { deepStrictEqual, equal, throws } from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { WorkbenchRepository } from '../src/repository.ts'

/** A shipped rule, so the schedule/occurrence side of the ledger is real. */
const SCHEDULE_ID = 'builtin.schedule.last30days'

const roots: string[] = []
const open: WorkbenchRepository[] = []

function openRepository(): { filePath: string; repository: WorkbenchRepository } {
  const root = mkdtempSync(join(tmpdir(), 'prw-run-history-archive-'))
  roots.push(root)
  const filePath = join(root, 'workspace.sqlite3')
  const repository = new WorkbenchRepository({ filePath, now: () => new Date('2026-09-13T00:00:00.000Z') })
  open.push(repository)
  return { filePath, repository }
}

afterEach(() => {
  // Windows keeps a file handle alive until the connection is closed, so the
  // temp directory can only be removed afterwards.
  while (open.length > 0) open.pop()!.close()
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

/** One scheduled run in its final state, exactly as RUN HISTORY shows it. */
function scheduledRun(repository: WorkbenchRepository, key: string, status: 'queued' | 'completed' = 'completed') {
  const run = repository.startManagedAgentRun({
    jobId: SCHEDULE_ID,
    runtime: 'pi',
    transport: 'inprocess',
    workflowKey: 'daily_digest',
    projectId: null,
    paperIds: [],
    instructions: 'daily digest',
    toolProfile: 'read-only',
    idempotencyKey: key
  })
  if (status === 'queued') return run
  return repository.updateManagedAgentRun({ id: run.id, status: 'completed', output: '摘要正文', error: null })
}

/** The RUN HISTORY projection the delete commands lock on. */
function history(repository: WorkbenchRepository, limit = 8) {
  return repository.listScheduledManagedAgentRuns(200).slice(0, limit)
}

/** The CAS lock the list renders for one run: its current revision. */
function lock(repository: WorkbenchRepository, runId: string): { id: string; expectedRevision: number } {
  const row = repository.listScheduledManagedAgentRuns(200).find((candidate) => candidate.run.id === runId)
  if (!row) throw new Error(`run ${runId} missing from the RUN HISTORY range`)
  return { id: row.run.id, expectedRevision: row.revision }
}

function runRow(filePath: string, id: string) {
  const database = new BetterSqlite3(filePath, { readonly: true })
  try {
    return database.prepare('select agent_status, output, error, started_at, finished_at, archived_at, revision from agent_runs where id = ?').get(id) as {
      agent_status: string
      output: string
      error: string | null
      started_at: string | null
      finished_at: string | null
      archived_at: string | null
      revision: number
    } | undefined
  } finally {
    database.close()
  }
}

function runCount(filePath: string): number {
  const database = new BetterSqlite3(filePath, { readonly: true })
  try {
    return (database.prepare('select count(*) as total from agent_runs').get() as { total: number }).total
  } finally {
    database.close()
  }
}

describe('RUN HISTORY record removal (Automation → 最近运行)', () => {
  it('soft-archives each locked run with a per-record CAS receipt', () => {
    const { repository, filePath } = openRepository()
    const keep = scheduledRun(repository, 'history-keep')
    // The run finished *after* the list was read: the selection is a stale lock.
    const stale = scheduledRun(repository, 'history-stale', 'queued')
    const staleLock = lock(repository, stale.id)
    repository.updateManagedAgentRun({ id: stale.id, status: 'completed', output: '迟到的正文' })
    const fresh = scheduledRun(repository, 'history-fresh')
    const keepLock = lock(repository, keep.id)
    const freshLock = lock(repository, fresh.id)

    const result = repository.bulkArchiveManagedAgentRuns({
      items: [
        keepLock,
        staleLock,
        freshLock,
        { id: 'missing-run', expectedRevision: 0 }
      ]
    })

    deepStrictEqual(result.items.map((item) => [item.id, item.outcome]), [
      [keep.id, 'succeeded'],
      [stale.id, 'conflict'],
      [fresh.id, 'succeeded'],
      ['missing-run', 'skipped']
    ])
    deepStrictEqual(result.items[1]?.error, { code: 'REVISION_CONFLICT', message: '运行记录已被更新，请刷新列表后重试。', retryable: true })
    equal(result.items[0]?.error, null)
    equal(result.succeeded, 2)
    equal(result.skipped, 1)
    equal(result.conflict, 1)
    equal(result.failed, 0)
    equal(result.canceled, false)

    // Only the conflicted run stays in the loaded range; the archived ones left it.
    deepStrictEqual(history(repository).map((row) => row.run.id), [stale.id])
    equal(runRow(filePath, keep.id)?.archived_at !== null, true)
    equal(runRow(filePath, keep.id)?.revision, keepLock.expectedRevision + 1)
    equal(runRow(filePath, stale.id)?.archived_at, null)
    equal(runRow(filePath, stale.id)?.revision, staleLock.expectedRevision + 1)
    // Audit rows are archived, never dropped: the ledger keeps its content.
    equal(runCount(filePath), 3)
    equal(runRow(filePath, keep.id)?.agent_status, 'completed')
    equal(runRow(filePath, keep.id)?.output, '摘要正文')
    equal(runRow(filePath, keep.id)?.finished_at !== null, true)
  })

  it('keeps the schedule rule, its occurrence cursor and the delivered artifact intact', () => {
    const { repository, filePath } = openRepository()
    const run = scheduledRun(repository, 'history-schedule')
    const before = repository.getSchedule(SCHEDULE_ID)
    const claim = repository.claimScheduleOccurrence({
      scheduleId: SCHEDULE_ID,
      idempotencyKey: 'history-schedule-occurrence',
      occurrenceAt: '2026-09-13T01:00:00.000Z',
      localDateKey: '2026-09-13',
      source: 'scheduler',
      nextRunAt: '2026-09-14T01:00:00.000Z',
      advanceCursor: true,
      expectedRevision: before.revision
    })
    repository.settleScheduleOccurrence({ id: claim.occurrence.id, runId: run.id, status: 'completed' })
    const scheduleAfterRun = repository.getSchedule(SCHEDULE_ID)

    equal(repository.bulkArchiveManagedAgentRuns({ items: [lock(repository, run.id)] }).succeeded, 1)

    // The history list lost the record …
    deepStrictEqual(history(repository), [])
    // … while the rule, its cursor and the occurrence that points at the run
    // are byte-identical to what they were before the delete.
    deepStrictEqual(repository.getSchedule(SCHEDULE_ID), scheduleAfterRun)
    equal(scheduleAfterRun.enabled, before.enabled)
    equal(scheduleAfterRun.archivedAt, before.archivedAt)
    deepStrictEqual(repository.getScheduleOccurrenceByRunId(run.id)?.id, claim.occurrence.id)
    equal(repository.getScheduleOccurrenceByRunId(run.id)?.status, 'completed')
    equal(claim.cursorAdvanced, true)
    // The record itself is still readable (still diagnosable / retryable by id).
    equal(repository.getManagedAgentRun(run.id).id, run.id)
    const database = new BetterSqlite3(filePath, { readonly: true })
    try {
      deepStrictEqual(
        database.prepare('select run_id, status from schedule_occurrences where id = ?').get(claim.occurrence.id),
        { run_id: run.id, status: 'completed' }
      )
      equal(runCount(filePath), 1)
    } finally {
      database.close()
    }
  })

  it('reports an already archived run as skipped without writing again', () => {
    const { repository, filePath } = openRepository()
    const run = scheduledRun(repository, 'history-repeat')
    const selected = [lock(repository, run.id)]
    equal(repository.bulkArchiveManagedAgentRuns({ items: selected }).succeeded, 1)

    const repeat = repository.bulkArchiveManagedAgentRuns({ items: selected })
    deepStrictEqual(repeat.items, [{ id: run.id, outcome: 'skipped', error: null }])
    equal(repeat.succeeded, 0)
    equal(repeat.skipped, 1)
    equal(runRow(filePath, run.id)?.revision, selected[0]!.expectedRevision + 1)
    equal(runCount(filePath), 1)
  })

  it('rejects duplicate locks before writing anything', () => {
    const { repository, filePath } = openRepository()
    const run = scheduledRun(repository, 'history-duplicate')
    const selected = lock(repository, run.id)
    throws(() => repository.bulkArchiveManagedAgentRuns({ items: [selected, selected] }), /unique/u)
    equal(runRow(filePath, run.id)?.archived_at, null)
    equal(history(repository).length, 1)
  })

  it('still enforces CAS on the single-record delete path', () => {
    const { repository, filePath } = openRepository()
    const run = scheduledRun(repository, 'history-single', 'queued')
    const staleLock = lock(repository, run.id)
    // A run that finishes while it is selected invalidates the old lock.
    const completed = repository.updateManagedAgentRun({ id: run.id, status: 'completed', output: 'done' })
    equal(completed.id, run.id)
    throws(() => repository.archiveManagedAgentRun(run.id, staleLock.expectedRevision), /REVISION_CONFLICT|刷新/u)
    equal(history(repository).length, 1)

    const current = history(repository)[0]!
    repository.archiveManagedAgentRun(current.run.id, current.revision)
    deepStrictEqual(history(repository), [])
    equal(runRow(filePath, run.id)?.archived_at !== null, true)
    equal(runCount(filePath), 1)
    // Archiving hides the record from RUN HISTORY only: the audit content stays
    // readable through a raw query.
    equal(runRow(filePath, run.id)?.output, 'done')
    equal(repository.getManagedAgentRun(run.id).status, 'completed')
  })
})
