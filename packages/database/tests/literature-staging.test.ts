import { afterEach, describe, it } from 'node:test'
import { deepStrictEqual, equal, throws } from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { WorkbenchRepository } from '../src/repository.ts'
import { migrateDatabase } from '../src/migrations.ts'

const roots: string[] = []

function openRepository(): WorkbenchRepository {
  const root = mkdtempSync(join(tmpdir(), 'prw-literature-staging-'))
  roots.push(root)
  return new WorkbenchRepository({ filePath: join(root, 'workspace.sqlite3'), now: () => new Date('2026-08-31T00:00:00.000Z') })
}

function saveInput(sourceId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'crossref',
    sourceId,
    title: `Staging ${sourceId}`,
    authors: ['Ada Lovelace'],
    year: 2026,
    venue: 'Test Journal',
    abstract: 'A metadata-only fixture.',
    doi: `10.1000/${sourceId}`,
    url: `https://example.test/${sourceId}`,
    isOpenAccess: true,
    openMetric: 12,
    fingerprint: `fingerprint-${sourceId}`,
    dedupeReason: '',
    dedupeConfidence: 1,
    sessionId: null,
    paperId: null,
    ...overrides
  }
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('literature staging persistence', () => {
  it('appends a constrained staging migration and is idempotent', () => {
    const sqlite = new BetterSqlite3(':memory:')
    sqlite.pragma('foreign_keys = ON')
    migrateDatabase(sqlite)
    migrateDatabase(sqlite)

    const migration = sqlite.prepare("SELECT id, name FROM _prw_migrations WHERE id = 14").get() as { id: number; name: string }
    deepStrictEqual(migration, { id: 14, name: 'literature_staging_records' })
    const columns = sqlite.prepare('PRAGMA table_info(literature_staging)').all() as Array<{ name: string; notnull: number }>
    equal(columns.some((column) => column.name === 'project_id' && column.notnull === 0), true)
    equal(columns.some((column) => column.name === 'updated_at' && column.notnull === 1), true)
    sqlite.prepare(`
      INSERT INTO literature_staging (
        id, source, source_id, title, fingerprint, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('staging-1', 'crossref', 'doi-1', 'A staged paper', 'fingerprint-1', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z')
    throws(() => sqlite.prepare(`
      INSERT INTO literature_staging (
        id, source, source_id, title, fingerprint, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('staging-2', 'crossref', 'doi-1', 'Duplicate', 'fingerprint-2', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z'), /UNIQUE constraint failed/)
    sqlite.close()
  })

  it('persists metadata, enforces source identity, and detaches cleared sessions', () => {
    const repository = openRepository()
    const project = repository.createProject({ name: 'Staging project', description: '' })
    repository.createSearchSession({
      id: 'session-staging-1',
      query: 'staging',
      source: 'crossref',
      filters: {},
      createdAt: '2026-08-31T00:00:00.000Z',
      resultCount: 0
    }, [])

    const record = repository.saveLiteratureStaging(saveInput('source-1', {
      sessionId: 'session-staging-1',
      projectId: project.id
    }) as never)
    equal(record.source, 'crossref')
    equal(record.sourceId, 'source-1')
    equal(record.projectId, project.id)
    equal(record.revision, 0)
    equal(repository.listLiteratureStaging({ query: '' }).total, 1)

    throws(() => repository.saveLiteratureStaging(saveInput('source-1') as never), { code: 'VALIDATION_FAILED' })

    const detached = repository.clearSearchSession('session-staging-1')
    equal(detached.deletedSession, true)
    equal(repository.getLiteratureStaging(record.id).sessionId, null)
    equal(repository.getLiteratureStaging(record.id).projectId, project.id)
    repository.close()
  })

  it('uses revision-checked transactional single and bulk deletes', () => {
    const repository = openRepository()
    const first = repository.saveLiteratureStaging(saveInput('source-1') as never)
    const second = repository.saveLiteratureStaging(saveInput('source-2') as never)

    deepStrictEqual(repository.deleteLiteratureStaging({ id: first.id, expectedRevision: 1 }), {
      id: first.id,
      status: 'conflict',
      deleted: false
    })
    equal(repository.getLiteratureStaging(first.id).id, first.id)

    const bulk = repository.bulkDeleteLiteratureStaging({
      selection: {
        mode: 'explicit',
        selectedIds: [first.id, second.id],
        excludedIds: [],
        queryFingerprint: null
      },
      expectedRevisions: [
        { id: first.id, expectedRevision: 0 },
        { id: second.id, expectedRevision: 9 }
      ]
    })
    equal(bulk.succeeded, 1)
    equal(bulk.failed, 1)
    equal(bulk.skipped, 0)
    equal(bulk.items[0]?.outcome, 'succeeded')
    equal(bulk.items[1]?.outcome, 'failed')
    equal(bulk.items[1]?.error?.operation, 'literature.staging.bulkDelete')
    equal(repository.getLiteratureStaging(second.id).id, second.id)
    throws(() => repository.getLiteratureStaging(first.id), { code: 'NOT_FOUND' })
    repository.close()
  })

  it('keeps page totals stable while advancing an opaque cursor', () => {
    const repository = openRepository()
    repository.saveLiteratureStaging(saveInput('source-1') as never)
    repository.saveLiteratureStaging(saveInput('source-2') as never)
    repository.saveLiteratureStaging(saveInput('source-3') as never)

    const firstPage = repository.listLiteratureStaging({ query: '', page: { limit: 2 } })
    equal(firstPage.items.length, 2)
    equal(firstPage.total, 3)
    equal(firstPage.nextCursor !== null, true)
    const secondPage = repository.listLiteratureStaging({ query: '', page: { limit: 2, cursor: firstPage.nextCursor } })
    equal(secondPage.items.length, 1)
    equal(secondPage.total, 3)
    equal(secondPage.nextCursor, null)
    repository.close()
  })
})
