import { afterEach, describe, it } from 'node:test'
import { deepEqual, equal } from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchRepository } from '@prw/database'
import type { IntegrationCoordinator } from '../src/integration-runtime.ts'
import { LiteratureCoordinator } from '../src/literature-runtime.ts'

const roots: string[] = []
const originalFetch = globalThis.fetch

function openRepository(): WorkbenchRepository {
  const root = mkdtempSync(join(tmpdir(), 'prw-workspace-literature-'))
  roots.push(root)
  return new WorkbenchRepository({ filePath: join(root, 'workspace.sqlite3') })
}

function stagingInput(sourceId: string): Record<string, unknown> {
  return {
    source: 'crossref',
    sourceId,
    title: `Staged ${sourceId}`,
    authors: ['Ada Lovelace'],
    year: 2026,
    venue: 'Test Journal',
    abstract: 'Metadata only.',
    doi: `10.1000/${sourceId}`,
    url: `https://example.test/${sourceId}`,
    isOpenAccess: true,
    openMetric: null,
    fingerprint: `fingerprint-${sourceId}`,
    dedupeReason: '',
    dedupeConfidence: 1,
    sessionId: null,
    projectId: null,
    paperId: null,
    expectedRevision: null
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('LiteratureCoordinator staging/search runtime', () => {
  it('persists and revision-checks staging snapshots through repository methods', () => {
    const repository = openRepository()
    const literature = new LiteratureCoordinator(repository)
    const first = literature.saveStaging(stagingInput('one') as never)
    const second = literature.saveStaging(stagingInput('two') as never)
    equal(literature.listStaging().total, 2)
    deepEqual(literature.deleteStaging({ id: first.id, expectedRevision: 1 }), {
      id: first.id,
      status: 'conflict',
      deleted: false
    })
    const deleted = literature.bulkDeleteStaging({
      selection: { mode: 'explicit', selectedIds: [first.id, second.id], excludedIds: [], queryFingerprint: null },
      expectedRevisions: [{ id: first.id, expectedRevision: 0 }, { id: second.id, expectedRevision: 0 }]
    })
    equal(deleted.succeeded, 2)
    equal(literature.listStaging().total, 0)
    repository.close()
  })

  it('reports partial status when one free source fails while others complete', async () => {
    globalThis.fetch = (async (request: RequestInfo | URL) => {
      const url = String(request)
      if (url.includes('api.crossref.org')) throw new Error('network unavailable')
      if (url.includes('eutils.ncbi.nlm.nih.gov')) return new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 })
      if (url.includes('export.arxiv.org')) return new Response('<feed></feed>', { status: 200 })
      return new Response(JSON.stringify(url.includes('openalex.org') ? { results: [] } : { data: [] }), { status: 200 })
    }) as typeof fetch
    const repository = openRepository()
    const literature = new LiteratureCoordinator(repository)
    const found = await literature.search({ query: 'keyword', source: 'all', page: 1, pageSize: 20, filters: {} })
    equal(found.results.length, 0)
    equal(literature.resultsPage({ sessionId: found.session.id }).status, 'partial')
    repository.close()
  })

  it('delegates staging Zotero preview and execute through the integration coordinator', async () => {
    const repository = openRepository()
    const calls: string[] = []
    const bridge = {
      previewPaperToZotero: async (input: { profileId: string; paperIds: string[] }) => {
        calls.push(`preview:${input.paperIds.length}`)
        return {
          previewId: 'paper-preview', profileId: input.profileId, targetCollectionKey: null,
          format: 'ris' as const, transport: 'save-file' as const, capability: 'unsupported' as const,
          items: input.paperIds.map((paperId) => ({ itemKey: 'ABC12345', paperId, decision: 'create' as const, duplicate: null, locator: null })),
          total: input.paperIds.length, requiresConfirmation: true as const
        }
      },
      executePaperToZotero: async () => {
        calls.push('execute')
        return {
          items: [{ profileId: 'zotero-profile', itemKey: 'ABC12345', paperId: null, outcome: 'generated' as const, transport: 'save-file' as const, format: 'ris' as const, locator: null, remoteRevision: null, duplicateDecision: 'create' as const, error: null }],
          succeeded: 1, skipped: 0, failed: 0, canceled: false
        }
      }
    } as unknown as IntegrationCoordinator
    const literature = new LiteratureCoordinator(repository, bridge)
    const staged = literature.saveStaging(stagingInput('zotero') as never)
    const preview = await literature.previewStagingToZotero({ profileId: 'zotero-profile', stagingIds: [staged.id], targetCollectionKey: null, format: 'ris' })
    equal(preview.capability, 'unsupported')
    const result = await literature.executeStagingToZotero({ previewId: preview.previewId, confirmed: true, confirmationToken: 'confirm' })
    equal(result.succeeded, 1)
    deepEqual(calls, ['preview:1', 'execute'])
    repository.close()
  })
})
