import { afterEach, describe, it } from 'node:test'
import { deepStrictEqual, equal, throws } from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { WorkbenchRepository } from '../src/repository.ts'

/**
 * Focused contract for the Settings → 工具连接 bulk delete (Task 04,
 * docs/implementation/11-connection-bulk-delete.md).
 *
 * The service-side command may only soft-archive connection *records* in one
 * CAS-locked transaction. These checks pin the four promises the UI renders
 * from: per-record receipts (succeeded/skipped/conflict), revision/CAS on every
 * write, no cascade into sync runs / external links, and no renderer-visible
 * credential handling (credential removal is Main-owned and only happens on the
 * single-record path).
 */

const roots: string[] = []
const open: WorkbenchRepository[] = []

function openRepository(): { repository: WorkbenchRepository; filePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'prw-connection-bulk-'))
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
    // Credential presence is owned by Main's safeStorage vault, never by the
    // renderer payload or the service-side transaction.
  }, true)
}

function row(filePath: string, id: string) {
  const database = new BetterSqlite3(filePath, { readonly: true })
  try {
    return database.prepare('select enabled, status, archived_at, revision, credential_present from integration_profiles where id = ?').get(id) as {
      enabled: number
      status: string
      archived_at: string | null
      revision: number
      credential_present: number
    } | undefined
  } finally {
    database.close()
  }
}

describe('connection record bulk delete', () => {
  it('archives each locked record with a per-record CAS receipt', () => {
    const { repository, filePath } = openRepository()
    const alpha = saveProfile(repository, 'Alpha')
    const beta = saveProfile(repository, 'Beta')
    const gamma = saveProfile(repository, 'Gamma')
    // Beta changes after the user selected it: its lock is now stale.
    const touchedBeta = repository.saveIntegrationProfile({
      id: beta.id,
      provider: beta.provider,
      name: beta.name,
      enabled: beta.enabled,
      location: beta.location,
      settings: beta.settings,
      expectedRevision: beta.revision
    }, true)

    const result = repository.bulkRemoveIntegrationProfiles({
      items: [
        { id: alpha.id, expectedRevision: alpha.revision },
        { id: beta.id, expectedRevision: beta.revision },
        { id: 'missing-connection', expectedRevision: 0 }
      ]
    })

    deepStrictEqual(result.items.map((item) => [item.id, item.outcome]), [
      [alpha.id, 'succeeded'],
      [beta.id, 'conflict'],
      ['missing-connection', 'skipped']
    ])
    deepStrictEqual(result.items[1]?.error, { code: 'REVISION_CONFLICT', message: '连接记录已被修改，请刷新设置后重试。', retryable: true })
    equal(result.items[0]?.error, null)
    equal(result.items[2]?.error, null)
    equal(result.succeeded, 1)
    equal(result.skipped, 1)
    equal(result.conflict, 1)
    equal(result.failed, 0)
    equal(result.canceled, false)

    deepStrictEqual(repository.listIntegrationProfiles().map((profile) => profile.name), ['Beta', 'Gamma'])
    const archived = row(filePath, alpha.id)
    equal(archived?.archived_at !== null, true)
    equal(archived?.enabled, 0)
    equal(archived?.status, 'disabled')
    equal(archived?.revision, alpha.revision + 1)
    const untouched = row(filePath, beta.id)
    equal(untouched?.archived_at, null)
    equal(untouched?.enabled, 1)
    equal(untouched?.revision, touchedBeta.revision)
  })

  it('reports an already archived record as skipped without writing again', () => {
    const { repository, filePath } = openRepository()
    const alpha = saveProfile(repository, 'Alpha')
    const lock = [{ id: alpha.id, expectedRevision: alpha.revision }]
    equal(repository.bulkRemoveIntegrationProfiles({ items: lock }).succeeded, 1)

    const repeat = repository.bulkRemoveIntegrationProfiles({ items: lock })
    deepStrictEqual(repeat.items, [{ id: alpha.id, outcome: 'skipped', error: null }])
    equal(repeat.succeeded, 0)
    equal(repeat.skipped, 1)
    equal(row(filePath, alpha.id)?.revision, alpha.revision + 1)
  })

  it('keeps sync runs, external links and credential presence while archiving', () => {
    const { repository, filePath } = openRepository()
    const alpha = saveProfile(repository, 'Alpha')
    const syncRun = repository.createSyncRun(alpha.id, 'pull')
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

    const result = repository.bulkRemoveIntegrationProfiles({ items: [{ id: alpha.id, expectedRevision: alpha.revision }] })
    equal(result.succeeded, 1)
    equal(repository.listSyncRuns(alpha.id).map((run) => run.id).includes(syncRun.id), true)
    equal(repository.listExternalLinks(alpha.id).map((item) => item.id).includes(link.id), true)
    equal(row(filePath, alpha.id)?.credential_present, 1)
    // An archived record is read-only: nothing may silently resurrect it.
    throws(() => repository.saveIntegrationProfile({
      id: alpha.id,
      provider: alpha.provider,
      name: alpha.name,
      enabled: true,
      location: alpha.location,
      settings: alpha.settings,
      expectedRevision: null
    }), /integration profile/u)
  })

  it('rejects duplicate locks before writing anything', () => {
    const { repository } = openRepository()
    const alpha = saveProfile(repository, 'Alpha')
    throws(() => repository.bulkRemoveIntegrationProfiles({
      items: [
        { id: alpha.id, expectedRevision: alpha.revision },
        { id: alpha.id, expectedRevision: alpha.revision }
      ]
    }), /unique/u)
    deepStrictEqual(repository.listIntegrationProfiles().map((profile) => profile.name), ['Alpha'])
  })

  it('still enforces CAS on the single-record delete path', () => {
    const { repository } = openRepository()
    const alpha = saveProfile(repository, 'Alpha')
    throws(() => repository.removeIntegrationProfile(alpha.id, alpha.revision + 1), /changed by another operation/u)
    equal(repository.listIntegrationProfiles().length, 1)
    repository.removeIntegrationProfile(alpha.id, alpha.revision)
    deepStrictEqual(repository.listIntegrationProfiles(), [])
  })
})
