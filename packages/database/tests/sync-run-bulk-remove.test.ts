import { afterEach, describe, it } from 'node:test'
import { deepStrictEqual, equal, throws } from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { WorkbenchRepository } from '../src/repository.ts'

/**
 * Focused contract for Settings → 最近同步 (SYNC / RECENT) record removal.
 *
 * The list is an audit ledger, so "delete" may only soft-archive a sync run in
 * one CAS-locked transaction with per-record receipts. These checks pin the
 * promises the UI renders from: per-record outcomes
 * (succeeded/skipped/conflict), a revision/CAS on every write, and no cascade
 * into the connection record, its safeStorage credential, external links or
 * any external system — and never a dropped `sync_runs` row.
 */

const roots: string[] = []
const open: WorkbenchRepository[] = []

function openRepository(): { filePath: string; repository: WorkbenchRepository } {
  const root = mkdtempSync(join(tmpdir(), 'prw-sync-run-bulk-'))
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

function saveProfile(repository: WorkbenchRepository, name: string) {
  return repository.saveIntegrationProfile({
    provider: 'notion',
    name,
    enabled: true,
    location: `datasource-${name.toLocaleLowerCase()}`,
    settings: {},
    expectedRevision: null
    // Credential presence stays Main-owned; the delete commands must never
    // change it.
  }, true)
}

function runRow(filePath: string, id: string) {
  const database = new BetterSqlite3(filePath, { readonly: true })
  try {
    return database.prepare('select status, archived_at, revision, message, pulled from sync_runs where id = ?').get(id) as {
      status: string
      archived_at: string | null
      revision: number
      message: string
      pulled: number
    } | undefined
  } finally {
    database.close()
  }
}

function runCount(filePath: string): number {
  const database = new BetterSqlite3(filePath, { readonly: true })
  try {
    return (database.prepare('select count(*) as total from sync_runs').get() as { total: number }).total
  } finally {
    database.close()
  }
}

describe('sync run record removal (Settings → 最近同步)', () => {
  it('soft-archives each locked run with a per-record CAS receipt', () => {
    const { repository, filePath } = openRepository()
    const alpha = saveProfile(repository, 'Alpha')
    const keep = repository.createSyncRun(alpha.id, 'pull')
    const stale = repository.completeSyncRun(repository.createSyncRun(alpha.id, 'push').id, { pushed: 2 })
    const fresh = repository.createSyncRun(alpha.id, 'both')

    const result = repository.bulkRemoveSyncRuns({
      items: [
        { id: keep.id, expectedRevision: keep.revision },
        // The run progressed after it was selected: the lock is stale.
        { id: stale.id, expectedRevision: stale.revision - 1 },
        { id: fresh.id, expectedRevision: fresh.revision },
        { id: 'missing-sync-run', expectedRevision: 0 }
      ]
    })

    deepStrictEqual(result.items.map((item) => [item.id, item.outcome]), [
      [keep.id, 'succeeded'],
      [stale.id, 'conflict'],
      [fresh.id, 'succeeded'],
      ['missing-sync-run', 'skipped']
    ])
    deepStrictEqual(result.items[1]?.error, { code: 'REVISION_CONFLICT', message: '同步记录已被更新，请刷新列表后重试。', retryable: true })
    equal(result.items[0]?.error, null)
    equal(result.succeeded, 2)
    equal(result.skipped, 1)
    equal(result.conflict, 1)
    equal(result.failed, 0)
    equal(result.canceled, false)

    // Only the conflicted run stays visible; the archived ones leave the list.
    deepStrictEqual(repository.listSyncRuns(alpha.id).map((run) => run.id), [stale.id])
    equal(runRow(filePath, keep.id)?.archived_at !== null, true)
    equal(runRow(filePath, keep.id)?.revision, keep.revision + 1)
    equal(runRow(filePath, fresh.id)?.archived_at !== null, true)
    equal(runRow(filePath, stale.id)?.archived_at, null)
    equal(runRow(filePath, stale.id)?.revision, stale.revision)
    // Audit rows are archived, never dropped: the ledger keeps its content.
    equal(runCount(filePath), 3)
    equal(runRow(filePath, stale.id)?.status, 'completed')
  })

  it('keeps the connection record, its credential, external links and other runs intact', () => {
    const { repository, filePath } = openRepository()
    const alpha = saveProfile(repository, 'Alpha')
    const removed = repository.createSyncRun(alpha.id, 'pull')
    const kept = repository.createSyncRun(alpha.id, 'push')
    const link = repository.saveExternalLink({
      profileId: alpha.id,
      entityKind: 'paper',
      entityId: 'paper-1',
      externalId: 'notion-page-1',
      locator: '',
      managedBlockId: null,
      remoteRevision: null,
      syncState: 'synced',
      lastSyncedAt: null
    })

    equal(repository.bulkRemoveSyncRuns({ items: [{ id: removed.id, expectedRevision: removed.revision }] }).succeeded, 1)

    deepStrictEqual(repository.listIntegrationProfiles().map((profile) => profile.id), [alpha.id])
    deepStrictEqual(repository.listSyncRuns(alpha.id).map((run) => run.id), [kept.id])
    equal(repository.listExternalLinks(alpha.id).map((item) => item.id).includes(link.id), true)
    const database = new BetterSqlite3(filePath, { readonly: true })
    try {
      const profile = database.prepare('select enabled, status, archived_at, revision, credential_present from integration_profiles where id = ?').get(alpha.id) as {
        enabled: number
        status: string
        archived_at: string | null
        revision: number
        credential_present: number
      }
      equal(profile.enabled, 1)
      equal(profile.status, alpha.status)
      equal(profile.archived_at, null)
      equal(profile.revision, alpha.revision)
      equal(profile.credential_present, 1)
    } finally {
      database.close()
    }
  })

  it('reports an already archived run as skipped without writing again', () => {
    const { repository, filePath } = openRepository()
    const alpha = saveProfile(repository, 'Alpha')
    const run = repository.createSyncRun(alpha.id, 'pull')
    const lock = [{ id: run.id, expectedRevision: run.revision }]
    equal(repository.bulkRemoveSyncRuns({ items: lock }).succeeded, 1)

    const repeat = repository.bulkRemoveSyncRuns({ items: lock })
    deepStrictEqual(repeat.items, [{ id: run.id, outcome: 'skipped', error: null }])
    equal(repeat.succeeded, 0)
    equal(repeat.skipped, 1)
    equal(runRow(filePath, run.id)?.revision, run.revision + 1)
    equal(runCount(filePath), 1)
  })

  it('rejects duplicate locks before writing anything', () => {
    const { repository, filePath } = openRepository()
    const alpha = saveProfile(repository, 'Alpha')
    const run = repository.createSyncRun(alpha.id, 'pull')
    throws(() => repository.bulkRemoveSyncRuns({
      items: [
        { id: run.id, expectedRevision: run.revision },
        { id: run.id, expectedRevision: run.revision }
      ]
    }), /unique/u)
    equal(runRow(filePath, run.id)?.archived_at, null)
    equal(repository.listSyncRuns(alpha.id).length, 1)
  })

  it('still enforces CAS on the single-record delete path', () => {
    const { repository, filePath } = openRepository()
    const alpha = saveProfile(repository, 'Alpha')
    const run = repository.createSyncRun(alpha.id, 'pull')
    // A run that finishes while it is selected invalidates the old lock.
    const completed = repository.completeSyncRun(run.id, { pulled: 1 })
    equal(completed.revision, run.revision + 1)
    throws(() => repository.removeSyncRun(run.id, run.revision), /changed by another operation/u)
    equal(repository.listSyncRuns(alpha.id).length, 1)

    repository.removeSyncRun(run.id, completed.revision)
    deepStrictEqual(repository.listSyncRuns(alpha.id), [])
    equal(runRow(filePath, run.id)?.archived_at !== null, true)
    equal(runCount(filePath), 1)
    // Archiving a ledger row does not block the completed record from being
    // read back through a raw query (the audit trail survives).
    equal(runRow(filePath, run.id)?.pulled, 1)
  })
})
