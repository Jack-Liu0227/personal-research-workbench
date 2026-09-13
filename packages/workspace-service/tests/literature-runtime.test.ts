import { afterEach, describe, it } from 'node:test'
import { deepEqual, equal, rejects } from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchRepository } from '@prw/database'
import type { IntegrationCoordinator } from '../src/integration-runtime.ts'
import { LiteratureCoordinator } from '../src/literature-runtime.ts'

const roots: string[] = []
const repositories: WorkbenchRepository[] = []
const originalFetch = globalThis.fetch

/**
 * The Google Scholar source is a Python sidecar child process, not `fetch`, so
 * the mocked `fetch` above cannot neutralise it: the real `python sidecars/
 * scholar.py` run blocks the file for the full 30s child-process timeout (and a
 * killed child can keep the runner alive).  Point the sidecar at a missing
 * script so it fails fast and the test stays a hermetic partial-source case.
 */
const originalScholarSidecar = process.env['PRW_SCHOLAR_SIDECAR']

function openRepository(): WorkbenchRepository {
  const root = mkdtempSync(join(tmpdir(), 'prw-workspace-literature-'))
  roots.push(root)
  const repository = new WorkbenchRepository({ filePath: join(root, 'workspace.sqlite3') })
  repositories.push(repository)
  return repository
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
  if (originalScholarSidecar === undefined) delete process.env['PRW_SCHOLAR_SIDECAR']
  else process.env['PRW_SCHOLAR_SIDECAR'] = originalScholarSidecar
  // Windows keeps the SQLite handle locked until the repository is closed, and
  // a failed assertion aborts the test body before its own `close()`.  Release
  // every handle here (before the temp root is removed) so a red test can never
  // leave the runner holding an open database.
  while (repositories.length > 0) repositories.pop()!.close()
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
  })

  it('reports partial status when one free source fails while others complete', async () => {
    process.env['PRW_SCHOLAR_SIDECAR'] = join(tmpdir(), 'prw-missing-scholar-sidecar.py')
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
          profileRevision: 4,
          items: input.paperIds.map((paperId) => ({ itemKey: 'ABC12345', paperId, decision: 'review' as const, duplicate: null, locator: null, note: '无法确认 Zotero 中是否已存在该文献。' })),
          total: input.paperIds.length, requiresConfirmation: true as const
        }
      },
      executePaperToZotero: async () => {
        calls.push('execute')
        return {
          items: [{ profileId: 'zotero-profile', itemKey: 'ABC12345', paperId: null, outcome: 'generated' as const, transport: 'save-file' as const, format: 'ris' as const, locator: null, remoteRevision: null, duplicateDecision: 'create' as const, targetCollectionKey: 'COLL0001', collectionWrite: 'not-written' as const, error: null }],
          succeeded: 1, skipped: 0, failed: 0, canceled: false
        }
      }
    } as unknown as IntegrationCoordinator
    const literature = new LiteratureCoordinator(repository, bridge)
    const staged = literature.saveStaging(stagingInput('zotero') as never)
    const preview = await literature.previewStagingToZotero({ profileId: 'zotero-profile', stagingIds: [staged.id], targetCollectionKey: 'COLL0001', format: 'ris' })
    equal(preview.capability, 'unsupported')
    // The frozen profile revision and the per-item explanation must survive the
    // staging → preview bridge, otherwise execution could apply a stale plan.
    equal(preview.profileRevision, 4)
    equal(preview.items[0]?.note, '无法确认 Zotero 中是否已存在该文献。')
    equal(preview.targetCollectionKey, 'COLL0001')
    const result = await literature.executeStagingToZotero({ previewId: preview.previewId, confirmed: true, confirmationToken: 'confirm' })
    equal(result.succeeded, 1)
    // Receipts carry the collection intent and what actually happened to it.
    equal(result.items[0]?.targetCollectionKey, 'COLL0001')
    equal(result.items[0]?.collectionWrite, 'not-written')
    deepEqual(calls, ['preview:1', 'execute'])
  })

  it('freezes one top-level project classification across preview, confirm and receipts', async () => {
    const repository = openRepository()
    const project = repository.createProject({ name: '合成生物学', description: '' })
    const previewInputs: Array<Record<string, unknown>> = []
    const bridge = {
      previewPaperToZotero: async (input: Record<string, unknown>) => {
        previewInputs.push(input)
        return {
          previewId: `paper-preview-${previewInputs.length}`, profileId: input['profileId'] as string,
          targetCollectionKey: input['targetCollectionKey'] as string | null, format: 'ris' as const,
          transport: 'api' as const, capability: 'write' as const, profileRevision: 2,
          items: (input['paperIds'] as string[]).map((paperId) => ({ itemKey: 'ABC12345', paperId, decision: 'create' as const, duplicate: null, locator: null, remoteRevision: null, note: null })),
          total: (input['paperIds'] as string[]).length, requiresConfirmation: true as const
        }
      },
      executePaperToZotero: async () => ({
        items: [{ profileId: 'zotero-profile', itemKey: 'ABC12345', paperId: null, outcome: 'written' as const, transport: 'api' as const, format: 'ris' as const, locator: null, remoteRevision: '7', duplicateDecision: 'create' as const, targetCollectionKey: 'COLL0001', collectionWrite: 'set' as const, error: null }],
        succeeded: 1, skipped: 0, failed: 0, canceled: false
      })
    } as unknown as IntegrationCoordinator
    const literature = new LiteratureCoordinator(repository, bridge)
    const bound = literature.saveStaging({ ...stagingInput('classified'), projectId: project.id } as never)

    // No explicit classification: the record's own project binding is used, so
    // the automatic tag keeps working for a homogeneous selection.
    // The renderer sends the three-state classification explicitly (undefined
    // for "follow each record"), so an explicit undefined must behave like the
    // omitted key rather than being read as 未分类.
    const preview = await literature.previewStagingToZotero({ profileId: 'zotero-profile', stagingIds: [bound.id], targetCollectionKey: 'COLL0001', format: 'ris', projectId: undefined })
    equal(preview.projectId, project.id)
    // The preview must name the project that will actually be tagged, and the
    // exact tag is `<项目名>` (the `#` is presentation only).
    equal(preview.projectTag, '合成生物学')
    equal(previewInputs[0]?.['projectId'], project.id)

    const result = await literature.executeStagingToZotero({ previewId: preview.previewId, confirmed: true, confirmationToken: 'confirm' })
    equal(result.succeeded, 1)
    // The receipt repeats the frozen classification so a confirmed write can be
    // audited without re-deriving the tag from the current project list.
    equal(result.items[0]?.projectId, project.id)
    equal(result.items[0]?.projectTag, '合成生物学')

    // An explicit 未分类 (null) is a real choice and must override the binding.
    const unclassified = await literature.previewStagingToZotero({ profileId: 'zotero-profile', stagingIds: [bound.id], targetCollectionKey: null, format: 'ris', projectId: null })
    equal(unclassified.projectId, null)
    equal(unclassified.projectTag, '未分类')
    equal(previewInputs[1]?.['projectId'], null)

    // Mixed selections are classified as 未分类 instead of writing per-record
    // tags the confirmation step never showed.
    const other = literature.saveStaging({ ...stagingInput('mixed'), projectId: null } as never)
    const mixed = await literature.previewStagingToZotero({ profileId: 'zotero-profile', stagingIds: [bound.id, other.id], targetCollectionKey: null, format: 'ris' })
    equal(mixed.projectId, null)
    equal(mixed.projectTag, '未分类')
    await repository.close()
  })

  it('leaves the transport to the capability probe when the caller froze none', async () => {
    const repository = openRepository()
    const previewInputs: Array<Record<string, unknown>> = []
    const bridge = {
      previewPaperToZotero: async (input: Record<string, unknown>) => {
        previewInputs.push(input)
        // A read-only connection (Zotero 9 without Zotero-Server-ID): the
        // IntegrationCoordinator derives 'save-file' from the frozen probe.
        return {
          previewId: `paper-preview-${previewInputs.length}`, profileId: input['profileId'] as string,
          targetCollectionKey: input['targetCollectionKey'] as string | null, format: 'bibtex' as const,
          transport: 'save-file' as const, capability: 'read' as const, profileRevision: 1,
          items: (input['paperIds'] as string[]).map((paperId) => ({ itemKey: paperId, paperId, decision: 'create' as const, duplicate: null, locator: null, remoteRevision: null, note: null })),
          total: (input['paperIds'] as string[]).length, requiresConfirmation: true as const
        }
      },
      executePaperToZotero: async () => {
        throw new Error('execute must not be called by this test')
      }
    } as unknown as IntegrationCoordinator
    const literature = new LiteratureCoordinator(repository, bridge)
    const staged = literature.saveStaging(stagingInput('transport') as never)

    const probed = await literature.previewStagingToZotero({ profileId: 'zotero-profile', stagingIds: [staged.id], targetCollectionKey: null, format: 'bibtex' })
    // The staging layer must not force an API write: the capability probe owns
    // that decision, otherwise a read-only connection gets a write request that
    // can only fail instead of the RIS/BibTeX fallback package.
    equal('transport' in previewInputs[0]!, false)
    equal(probed.transport, 'save-file')
    equal(probed.capability, 'read')

    // An explicitly frozen transport still wins (the confirmed write path).
    await literature.previewStagingToZotero({ profileId: 'zotero-profile', stagingIds: [staged.id], targetCollectionKey: null, format: 'bibtex', transport: 'api' })
    equal(previewInputs[1]?.['transport'], 'api')
  })

  it('requires an explicit confirmation and the matching profile before writing', async () => {
    const repository = openRepository()
    let executeCalls = 0
    const bridge = {
      previewPaperToZotero: async (input: { profileId: string; paperIds: string[] }) => ({
        previewId: 'paper-preview', profileId: input.profileId, targetCollectionKey: 'COLL0001',
        format: 'bibtex' as const, transport: 'api' as const, capability: 'write' as const, profileRevision: 7,
        items: input.paperIds.map((paperId) => ({ itemKey: paperId, paperId, decision: 'update-candidate' as const, duplicate: null, locator: null, remoteRevision: '4', note: null })),
        total: input.paperIds.length, requiresConfirmation: true as const
      }),
      executePaperToZotero: async () => {
        executeCalls += 1
        return {
          items: [{ profileId: 'zotero-profile', itemKey: 'ABC12345', paperId: null, outcome: 'written' as const, transport: 'api' as const, format: 'bibtex' as const, locator: null, remoteRevision: '5', duplicateDecision: 'update-candidate' as const, targetCollectionKey: 'COLL0001', collectionWrite: 'set' as const, error: null }],
          succeeded: 1, skipped: 0, failed: 0, canceled: false
        }
      }
    } as unknown as IntegrationCoordinator
    const literature = new LiteratureCoordinator(repository, bridge)
    const staged = literature.saveStaging(stagingInput('confirm') as never)
    const preview = await literature.previewStagingToZotero({ profileId: 'zotero-profile', stagingIds: [staged.id], targetCollectionKey: 'COLL0001', format: 'bibtex', transport: 'api' })

    // No confirmation token, an unconfirmed call, and a foreign credential
    // profile are rejected before any external call.
    await rejects(() => literature.executeStagingToZotero({ previewId: preview.previewId, confirmed: true, confirmationToken: '' } as never), /./u)
    await rejects(() => literature.executeStagingToZotero({ previewId: preview.previewId, confirmed: false, confirmationToken: 'token' } as never), /./u)
    await rejects(() => literature.executeStagingToZotero({ previewId: preview.previewId, confirmed: true, confirmationToken: 'token' }, undefined, null, 'other-profile'), /Credential profile does not match/u)
    await rejects(() => literature.executeStagingToZotero({ previewId: 'missing-preview', confirmed: true, confirmationToken: 'token' }), /preview is missing/u)
    equal(executeCalls, 0)

    // The same preview is still usable after the rejected attempts and the
    // receipt reports the Collection that was actually written per item.
    const result = await literature.executeStagingToZotero({ previewId: preview.previewId, confirmed: true, confirmationToken: 'token' }, undefined, null, 'zotero-profile')
    equal(executeCalls, 1)
    equal(result.items[0]?.targetCollectionKey, 'COLL0001')
    equal(result.items[0]?.collectionWrite, 'set')
    equal(result.items[0]?.remoteRevision, '5')
    // A one-use preview cannot be replayed after a confirmed write.
    await rejects(() => literature.executeStagingToZotero({ previewId: preview.previewId, confirmed: true, confirmationToken: 'token' }), /preview is missing/u)
  })
})
