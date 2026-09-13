import { afterEach, describe, it } from 'node:test'
import { deepEqual, equal, match, rejects } from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchRepository } from '@prw/database'
import { IntegrationCoordinator } from '../src/integration-runtime.ts'

const roots: string[] = []
const repositories: WorkbenchRepository[] = []
const originalFetch = globalThis.fetch

type FakeServer = {
  readonly calls: Array<{ method: string; url: string; version: string | null }>
  /** Status Zotero answers the next `DELETE <library>/items/<key>` with. */
  deleteStatus: number
  deleteBody: string
}

/**
 * A real SQLite repository plus a fake Zotero Local API.  The fake mirrors the
 * documented handshake of the real service: `/api/` returns a server id, the
 * probe reads collections/items, the zero-effect write check posts `[]`, and an
 * item erase is a preconditioned `DELETE`.
 */
function openCoordinator(): { coordinator: IntegrationCoordinator; repository: WorkbenchRepository; profileId: string; paperId: string; server: FakeServer } {
  const root = mkdtempSync(join(tmpdir(), 'prw-zotero-delete-'))
  roots.push(root)
  const repository = new WorkbenchRepository({ filePath: join(root, 'workspace.sqlite3') })
  repositories.push(repository)
  const coordinator = new IntegrationCoordinator(repository)
  const profile = repository.saveIntegrationProfile({
    provider: 'zotero',
    name: 'Zotero',
    enabled: true,
    location: 'http://localhost:23119',
    settings: { libraryType: 'user', libraryId: 0, limit: 20, zoteroLocalKeyPersistent: true },
    expectedRevision: null
  }, true)
  const paper = repository.createPaper({ title: 'Projection of I1', source: 'zotero' })
  repository.saveExternalLink({
    profileId: profile.id,
    entityKind: 'paper',
    entityId: paper.id,
    externalId: 'I1',
    locator: '',
    managedBlockId: null,
    remoteRevision: '7',
    syncState: 'synced',
    lastSyncedAt: null
  })
  const server: FakeServer = { calls: [], deleteStatus: 204, deleteBody: '' }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    if (url.endsWith('/api/')) return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json', 'Zotero-Server-ID': 'fixture-server' } })
    if (method === 'DELETE') {
      server.calls.push({ method, url, version: headers.get('If-Unmodified-Since-Version') })
      return server.deleteStatus === 204
        ? new Response(null, { status: 204, headers: { 'Last-Modified-Version': '99' } })
        : new Response(server.deleteBody, { status: server.deleteStatus, headers: { 'Content-Type': 'text/plain' } })
    }
    if (method === 'POST') return new Response('No items provided', { status: 400, headers: { 'Content-Type': 'text/plain' } })
    if (url.includes('/collections')) return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json', 'Total-Results': '0' } })
    if (url.includes('/items/I1')) {
      return new Response(JSON.stringify({ key: 'I1', version: 7, data: { title: 'Remote fixture' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json', 'Total-Results': '0' } })
  }) as typeof fetch
  return { coordinator, repository, profileId: profile.id, paperId: paper.id, server }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  while (repositories.length > 0) repositories.pop()!.close()
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('previewZoteroRemoteDelete', () => {
  it('freezes the real remote revision and the local projection it would archive', async () => {
    const { coordinator, profileId, paperId } = openCoordinator()
    const preview = await coordinator.previewZoteroRemoteDelete({ profileId, itemKeys: ['I1'] }, 'fixture-secret')

    equal(preview.writeBlockedReason, null)
    deepEqual(preview.targets, [{
      itemKey: 'I1',
      remoteRevision: '7',
      paperId,
      title: 'Remote fixture',
      localRevision: 0
    }])
    deepEqual(preview.unavailable, [])
    match(preview.message, /已冻结 1 个 Zotero 条目/u)
  })

  it('keeps the entry visible with an honest reason when the local key cannot be trusted', async () => {
    const { coordinator, repository, profileId } = openCoordinator()
    const profile = repository.getIntegrationProfile(profileId)
    repository.saveIntegrationProfile({
      id: profile.id,
      provider: profile.provider,
      name: profile.name,
      enabled: profile.enabled,
      location: profile.location,
      settings: { ...profile.settings, zoteroLocalKeyPersistent: false },
      expectedRevision: profile.revision
    }, true)

    const preview = await coordinator.previewZoteroRemoteDelete({ profileId, itemKeys: ['I1'] }, 'fixture-secret')
    equal(preview.writeBlockedReason, 'key-single-use')
    equal(preview.targets.length, 1)
    match(preview.message, /本次不会向 Zotero 发送删除请求/u)
  })

  it('refuses an empty selection instead of reporting a vacuous success', async () => {
    const { coordinator, profileId } = openCoordinator()
    await rejects(
      () => coordinator.previewZoteroRemoteDelete({ profileId, itemKeys: ['   '] }, 'fixture-secret'),
      (error: unknown) => error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'INVALID_MAPPING'
    )
  })
})

describe('executeZoteroRemoteDelete', () => {
  it('deletes in Zotero first, then archives the local projection and removes the link', async () => {
    const { coordinator, repository, profileId, paperId, server } = openCoordinator()
    const preview = await coordinator.previewZoteroRemoteDelete({ profileId, itemKeys: ['I1'] }, 'fixture-secret')
    const receipt = await coordinator.executeZoteroRemoteDelete({
      profileId,
      expectedProfileRevision: preview.profileRevision,
      targets: preview.targets,
      confirmed: true
    }, 'fixture-secret')

    equal(receipt.status, 'completed')
    equal(receipt.remoteDeletedCount, 1)
    equal(receipt.localRemovedCount, 1)
    equal(receipt.items[0]?.remote, 'deleted')
    equal(receipt.items[0]?.local, 'removed')
    equal(receipt.items[0]?.retryable, false)
    // The frozen revision travels as the erase precondition, not as a hint.
    deepEqual(server.calls, [{ method: 'DELETE', url: 'http://localhost:23119/api/users/0/items/I1', version: '7' }])
    equal(repository.findExternalPaperLink(profileId, 'I1'), null)
    const archived = repository.getPapersByIds([paperId])[0]
    equal(archived?.status, 'archived')
    equal(archived?.archivedAt !== null, true)
  })

  it('refuses a stale profile revision so a changed connection cannot be deleted against', async () => {
    const { coordinator, profileId, server } = openCoordinator()
    await rejects(
      () => coordinator.executeZoteroRemoteDelete({
        profileId,
        expectedProfileRevision: 99,
        targets: [{ itemKey: 'I1', remoteRevision: '7', paperId: null, title: null, localRevision: null }],
        confirmed: true
      }, 'fixture-secret'),
      (error: unknown) => error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'REVISION_CONFLICT'
    )
    equal(server.calls.length, 0)
  })

  it('keeps the local record when Zotero refuses the stale erase with 412', async () => {
    const { coordinator, repository, profileId, paperId, server } = openCoordinator()
    const preview = await coordinator.previewZoteroRemoteDelete({ profileId, itemKeys: ['I1'] }, 'fixture-secret')
    server.deleteStatus = 412
    server.deleteBody = 'item has been modified since specified version (expected 7, found 9)'
    const receipt = await coordinator.executeZoteroRemoteDelete({
      profileId,
      expectedProfileRevision: preview.profileRevision,
      targets: preview.targets,
      confirmed: true
    }, 'fixture-secret')

    equal(receipt.status, 'blocked')
    equal(receipt.remoteDeletedCount, 0)
    equal(receipt.localRemovedCount, 0)
    equal(receipt.items[0]?.remote, 'conflict')
    equal(receipt.items[0]?.local, 'kept')
    equal(receipt.items[0]?.retryable, true)
    match(receipt.items[0]?.message ?? '', /本地记录未删除/u)
    equal(repository.findExternalPaperLink(profileId, 'I1')?.entityId, paperId)
    equal(repository.getPapersByIds([paperId])[0]?.status !== 'archived', true)
  })

  it('treats a 404 as gone, removes the local projection and reports it honestly', async () => {
    const { coordinator, repository, profileId, server } = openCoordinator()
    const preview = await coordinator.previewZoteroRemoteDelete({ profileId, itemKeys: ['I1'] }, 'fixture-secret')
    server.deleteStatus = 404
    server.deleteBody = 'Not found'
    const receipt = await coordinator.executeZoteroRemoteDelete({
      profileId,
      expectedProfileRevision: preview.profileRevision,
      targets: preview.targets,
      confirmed: true
    }, 'fixture-secret')

    equal(receipt.status, 'completed')
    equal(receipt.items[0]?.remote, 'absent')
    equal(receipt.items[0]?.local, 'removed')
    equal(repository.findExternalPaperLink(profileId, 'I1'), null)
  })
})
