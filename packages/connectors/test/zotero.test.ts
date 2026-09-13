import assert from 'node:assert/strict'
import test from 'node:test'
import { IntegrationErrorSchema } from '@prw/contracts'
import { createZoteroProjection, deleteZoteroRemoteItems, exportZoteroBibtex, readZoteroRemoteItems, zoteroDeleteRemovedRemotely, getZoteroIntegrationError, listZoteroCollections, probeZotero, pullZotero, verifyZoteroWriteAuthorization, writeZoteroProjection, zoteroWriteBlockedMessage } from '../src/zotero.ts'
import type { AdapterProfile, ManagedProjection } from '../src/types.ts'

const profile: AdapterProfile = {
  provider: 'zotero',
  location: 'http://localhost:23119',
  // A loopback write key is only usable when Zotero's authorization dialog was
  // answered with “Always Allow”; the mode is part of the profile settings
  // because a one-time key is destroyed by the first write it authorizes.
  settings: { libraryType: 'user', libraryId: 0, limit: 20, zoteroLocalKeyPersistent: true },
  credential: 'fixture-secret'
}

function response(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } })
}

function projection(): ManagedProjection {
  return {
    blockId: 'paper-1',
    revision: 1,
    title: 'Fixture paper',
    markdown: 'Fixture abstract',
    workbenchId: 'paper-1',
    tags: ['fixture'],
    collections: [],
    authors: ['Ada Lovelace'],
    year: 1843,
    venue: 'Journal',
    abstract: 'Fixture abstract',
    doi: null,
    url: null
  }
}

test('normalizes a local profile and sends fetched server id to collection/item calls', async () => {
  const calls: Array<{ url: string; headers: Headers }> = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, headers: new Headers(init?.headers) })
    if (url.endsWith('/api/')) return response({}, { 'Zotero-Server-ID': 'fixture-server' })
    if (url.includes('/collections')) return response([{ key: 'C1', data: { name: 'Papers', parentCollection: false }, meta: { numItems: 1 } }], { 'Total-Results': '1' })
    return response([{ key: 'I1', version: 7, data: { itemType: 'journalArticle', title: 'Fixture paper', creators: [{ firstName: 'Ada', lastName: 'Lovelace' }], collections: ['C1'] } }], { 'Last-Modified-Version': '7' })
  }

  const collections = await listZoteroCollections(profile, fetcher)
  const items = await pullZotero(profile, fetcher)
  assert.equal(collections.collections[0]?.parentKey, null)
  assert.equal(items.papers[0]?.externalId, 'I1')
  assert.equal(calls[1]?.url, 'http://localhost:23119/api/users/0/collections?format=json&limit=20')
  assert.equal(calls[1]?.headers.get('Zotero-Server-ID'), 'fixture-server')
  assert.equal(calls[3]?.url, 'http://localhost:23119/api/users/0/items?format=json&limit=20')
  assert.equal(calls.at(-1)?.headers.get('Zotero-Server-ID'), 'fixture-server')
})

test('malformed remote item payload is a redacted structured IntegrationError', async () => {
  let call = 0
  const fetcher: typeof fetch = async (_input, _init) => {
    call += 1
    if (call === 1) return response({}, { 'Zotero-Server-ID': 'fixture-server' })
    return response([{ key: 'I1', data: { itemType: 'journalArticle', title: 'Fixture', creators: 'not-an-array', extra: 'fixture-secret' } }])
  }
  await assert.rejects(() => pullZotero(profile, fetcher), (error: unknown) => {
    const envelope = getZoteroIntegrationError(error)
    assert.equal(envelope?.code, 'INTEGRATION_REMOTE_RESPONSE_INVALID')
    assert.equal(envelope?.kind, 'remote-response')
    assert.equal(envelope?.provider, 'zotero')
    assert.match(envelope?.message ?? '', /Zotero/)
    assert.doesNotMatch(JSON.stringify(envelope), /fixture-secret/)
    assert.equal(IntegrationErrorSchema.safeParse(envelope).success, true)
    return true
  })
})

/** An untitled Zotero record is a legitimate attachment/note-like entry rather
 * than a transport failure, so it must be skipped without inventing a title. */
test('records without a usable title are skipped instead of manufactured', async () => {
  let call = 0
  const fetcher: typeof fetch = async (_input, _init) => {
    call += 1
    if (call === 1) return response({}, { 'Zotero-Server-ID': 'fixture-server' })
    return response([{ key: 'I1', version: 7, data: { itemType: 'journalArticle', title: 42 } }])
  }
  const pulled = await pullZotero(profile, fetcher)
  assert.deepEqual(pulled.papers, [])
})

test('Local API probe keeps read-only capability when no credential is injected', async () => {
  const readOnlyProfile: AdapterProfile = { ...profile, credential: undefined }
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/api/')) return response({}, { 'Zotero-Server-ID': 'fixture-server' })
    if (url.includes('/collections')) return response([])
    return response([])
  }
  const result = await probeZotero(readOnlyProfile, fetcher)
  assert.equal(result.ok, true)
  assert.equal(result.capabilities.read, true)
  assert.equal(result.capabilities.write, false)
})

test('probe explains why a connection is read-only instead of offering a write', async () => {
  // Zotero 9 answers on the loopback Local API without `Zotero-Server-ID`, so
  // the local write handshake can never succeed: the probe must say so.
  const zoteroNine: typeof fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/api/')) return response({})
    return response([])
  }
  const nine = await probeZotero({ ...profile, credential: undefined }, zoteroNine)
  assert.equal(nine.capabilities.write, false)
  assert.equal(nine.writeBlockedReason, 'server-id-missing')

  // A remote Web API profile without a credential is blocked by the missing
  // key, not by the (irrelevant) server id.
  const remote = await probeZotero({ ...profile, location: 'https://api.zotero.org/users/0/', credential: undefined }, zoteroNine)
  assert.equal(remote.capabilities.write, false)
  assert.equal(remote.writeBlockedReason, 'credential-missing')

  // Once both halves of the handshake exist, no blocked reason is reported.
  const authorized = await probeZotero(profile, async (input) => String(input).endsWith('/api/') ? response({}, { 'Zotero-Server-ID': 'fixture-server' }) : response([]))
  assert.equal(authorized.capabilities.write, true)
  assert.equal(authorized.writeBlockedReason, null)

  const unreachable = await probeZotero(profile, async () => { throw new TypeError('fetch failed') })
  assert.equal(unreachable.ok, false)
  assert.equal(unreachable.writeBlockedReason, 'probe-failed')
})

/** A confirmed update must not clobber anything the user curated in Zotero. */
test('a confirmed update merges tags and only completes metadata the remote item is missing', async () => {
  const patch = await patchedBody({ title: 'Curated in Zotero', DOI: '', url: 'https://user.test/kept', abstractNote: '', publicationTitle: 'Zotero Journal', date: '2020', extra: 'user note', tags: [{ tag: 'user-tag' }, { tag: 'fixture' }] }, { collectionKey: null })
  // Non-empty remote values are never overwritten.
  assert.equal('title' in patch, false)
  assert.equal('url' in patch, false)
  assert.equal('publicationTitle' in patch, false)
  assert.equal('date' in patch, false)
  // Empty remote values are completed from the confirmed projection.
  assert.equal(patch['DOI'], '10.1000/xyz')
  assert.equal(patch['abstractNote'], 'Workbench abstract')
  // Tags are a union so the user's own tags survive the write.
  assert.deepEqual(patch['tags'], [{ tag: 'user-tag' }, { tag: 'fixture' }])
  assert.match(String(patch['extra']), /Workbench managed begin: paper-1/u)
  // No collection was selected, so membership must stay untouched rather than
  // restoring a stale locally cached list.
  assert.equal('collections' in patch, false)
})

test('a confirmed update writes exactly the selected collection and ignores a blank key', async () => {
  const selected = await patchedBody({ title: '', tags: [] }, { collectionKey: 'COLL0001' })
  assert.deepEqual(selected['collections'], ['COLL0001'])
  assert.equal(selected['title'], 'Workbench title')
  assert.deepEqual(selected['tags'], [{ tag: 'fixture' }])

  const blank = await patchedBody({ title: 'T', tags: [] }, { collectionKey: '   ' })
  assert.equal('collections' in blank, false)
})

test('a confirmed update refuses to write when the remote revision moved after the preview', async () => {
  const calls: string[] = []
  let call = 0
  const fetcher: typeof fetch = async (_input, init) => {
    call += 1
    if (call === 1) return response({}, { 'Zotero-Server-ID': 'fixture-server' })
    if (call === 2) return response({ key: 'I1', version: 9, data: { itemType: 'journalArticle', title: 'T', tags: [] } })
    calls.push((init?.method ?? 'GET').toUpperCase())
    return response(null, { 'Last-Modified-Version': '10' })
  }
  await assert.rejects(
    () => writeZoteroProjection(profile, { externalId: 'I1', locator: 'zotero://select/users/0/items/I1', remoteRevision: '7' }, projection(), fetcher),
    (error: unknown) => (error as { code?: string }).code === 'REVISION_CONFLICT'
  )
  assert.deepEqual(calls, [])
})

/** Runs one update against a stubbed Zotero item and returns the PATCH body. */
async function patchedBody(item: Record<string, unknown>, target: { collectionKey: string | null }): Promise<Record<string, unknown>> {
  let call = 0
  let patch: Record<string, unknown> | null = null
  const fetcher: typeof fetch = async (_input, init) => {
    call += 1
    if (call === 1) return response({}, { 'Zotero-Server-ID': 'fixture-server' })
    if (call === 2) return response({ key: 'I1', version: 7, data: { itemType: 'journalArticle', ...item } })
    patch = JSON.parse(String(init?.body)) as Record<string, unknown>
    return response(null, { 'Last-Modified-Version': '8' })
  }
  const metadata: ManagedProjection = { ...projection(), title: 'Workbench title', doi: '10.1000/xyz', url: 'https://workbench.test/paper', abstract: 'Workbench abstract', venue: 'Workbench Journal', year: 2024 }
  await writeZoteroProjection(profile, { externalId: 'I1', locator: 'zotero://select/users/0/items/I1', remoteRevision: '7', collectionKey: target.collectionKey }, metadata, fetcher)
  if (patch === null) throw new Error('expected a PATCH request')
  return patch
}

test('create and update retain Local API server/revision safeguards', async () => {
  const createCalls: Array<{ url: string; init: RequestInit | undefined }> = []
  let createCall = 0
  const createFetcher: typeof fetch = async (input, init) => {
    createCall += 1
    createCalls.push({ url: String(input), init })
    if (createCall === 1) return response({}, { 'Zotero-Server-ID': 'fixture-server' })
    return response({ successful: { 0: { key: 'NEW1', version: 8 } }, failed: {} }, { 'Last-Modified-Version': '8' })
  }
  const created = await createZoteroProjection(profile, 'C1', projection(), createFetcher)
  assert.equal(created.externalId, 'NEW1')
  assert.equal(createCalls[1]?.url, 'http://localhost:23119/api/users/0/items')
  assert.equal(new Headers(createCalls[1]?.init?.headers).get('Zotero-Server-ID'), 'fixture-server')

  const updateCalls: Array<{ url: string; init: RequestInit | undefined }> = []
  let updateCall = 0
  const updateFetcher: typeof fetch = async (input, init) => {
    updateCall += 1
    updateCalls.push({ url: String(input), init })
    if (updateCall === 1) return response({}, { 'Zotero-Server-ID': 'fixture-server' })
    if (updateCall === 2) return response({ key: 'I1', version: 7, data: { itemType: 'journalArticle', extra: '' } })
    return response(null, { 'Last-Modified-Version': '8' })
  }
  const updated = await writeZoteroProjection(profile, { externalId: 'I1', locator: 'zotero://select/users/0/items/I1', remoteRevision: '7' }, projection(), updateFetcher)
  assert.equal(updated.remoteRevision, '8')
  assert.equal(new Headers(updateCalls[2]?.init?.headers).get('If-Unmodified-Since-Version'), '7')
})

test('Better BibTeX bridge resolves stable item keys and tolerates legacy nested export responses', async () => {
  const calls: Array<{ url: string; body: unknown }> = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    const body = init?.body === undefined ? null : JSON.parse(String(init.body)) as unknown
    calls.push({ url, body })
    const method = body && typeof body === 'object' && 'method' in body ? (body as { method?: unknown }).method : null
    if (method === 'item.citationkey') return response({ result: { I1: 'Doe2024' } })
    if (method === 'item.export') return response({ result: { result: '@article{Doe2024,\n  title = {Fixture}\n}' } })
    return response({ result: null })
  }
  const exported = await exportZoteroBibtex(profile, ['I1'], ['重点'], 'Project A', fetcher)
  assert.deepEqual(exported.citationKeys, ['Doe2024'])
  assert.match(exported.content, /@article\{Doe2024/)
  assert.match(exported.content, /#Project A #重点/)
  assert.equal(calls.length, 2)
  assert.equal((calls[0]?.body as { method?: string }).method, 'item.citationkey')
  assert.deepEqual((calls[0]?.body as { params?: unknown[] }).params, [['I1']])
  // Personal-library exports use BBT's implicit "My Library" scope; Zotero's
  // Local user id 0 is not a valid BBT library id.
  assert.deepEqual((calls[1]?.body as { params?: unknown[] }).params, [['Doe2024'], 'Better BibTeX'])
})

/** Zotero's item erase route is `DELETE <library>/items/<key>` with an
 * `If-Unmodified-Since-Version` precondition.  These tests pin the real request
 * shape and the honest mapping of every documented answer. */
test('remote delete sends one preconditioned DELETE per key and maps a real success', async () => {
  const calls: Array<{ method: string; url: string; version: string | null; serverId: string | null }> = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/api/')) return response({}, { 'Zotero-Server-ID': 'fixture-server' })
    const requestHeaders = new Headers(init?.headers)
    calls.push({
      method: init?.method ?? 'GET',
      url,
      version: requestHeaders.get('If-Unmodified-Since-Version'),
      serverId: requestHeaders.get('Zotero-Server-ID')
    })
    return new Response(null, { status: 204, headers: { 'Last-Modified-Version': '99' } })
  }

  const result = await deleteZoteroRemoteItems(profile, [
    { itemKey: ' I1 ', remoteRevision: '7' },
    { itemKey: 'I2', remoteRevision: '8' }
  ], fetcher)

  assert.deepEqual(calls.map((call) => call.method), ['DELETE', 'DELETE'])
  assert.equal(calls[0]?.url, 'http://localhost:23119/api/users/0/items/I1')
  assert.equal(calls[0]?.version, '7')
  assert.equal(calls[0]?.serverId, 'fixture-server')
  assert.equal(calls[1]?.url, 'http://localhost:23119/api/users/0/items/I2')
  assert.deepEqual(result.outcomes.map((outcome) => outcome.status), ['deleted', 'deleted'])
  assert.deepEqual(result.outcomes.map((outcome) => outcome.remoteVersion), ['99', '99'])
  assert.equal(result.outcomes.every((outcome) => outcome.retryable), false)
  assert.equal(zoteroDeleteRemovedRemotely('deleted'), true)
  assert.equal(zoteroDeleteRemovedRemotely('absent'), true)
  for (const status of ['conflict', 'unauthorized', 'forbidden', 'rate-limited', 'unavailable'] as const) {
    assert.equal(zoteroDeleteRemovedRemotely(status), false)
  }
})

test('remote delete maps 404/412/401/403/429/500 to honest per-item outcomes without aborting the batch', async () => {
  const statuses: Array<[string, number, Record<string, string>, string]> = [
    ['I404', 404, {}, 'absent'],
    ['I412', 412, {}, 'conflict'],
    ['I401', 401, { 'WWW-Authenticate': 'Zotero-API-Key' }, 'unauthorized'],
    ['I403', 403, {}, 'forbidden'],
    ['I429', 429, { 'Retry-After': '30' }, 'rate-limited'],
    ['I500', 500, {}, 'unavailable']
  ]
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/api/')) return response({}, { 'Zotero-Server-ID': 'fixture-server' })
    const key = url.split('/').pop() ?? ''
    const match = statuses.find(([name]) => name === key)
    const status = match?.[1] ?? 500
    const extra = match?.[2] ?? {}
    if (status === 401) return new Response('API key required -- POST /api/local/authorize to obtain one', { status, headers: { 'Content-Type': 'text/plain', ...extra } })
    if (status === 412) return new Response('item has been modified since specified version (expected 7, found 9)', { status, headers: { 'Content-Type': 'text/plain', ...extra } })
    if (status === 403) return new Response('{"denied":true}', { status, headers: { 'Content-Type': 'application/json', ...extra } })
    if (status === 429) return new Response('Too many requests', { status, headers: { 'Content-Type': 'text/plain', ...extra } })
    return new Response('boom', { status, headers: { 'Content-Type': 'text/plain', ...extra } })
  }

  const result = await deleteZoteroRemoteItems(
    profile,
    statuses.map(([itemKey]) => ({ itemKey, remoteRevision: '7' })),
    fetcher
  )

  assert.deepEqual(result.outcomes.map((outcome) => outcome.status), statuses.map(([, , , expected]) => expected))
  assert.deepEqual(result.outcomes.map((outcome) => outcome.itemKey), statuses.map(([itemKey]) => itemKey))
  assert.match(result.outcomes[0]?.message ?? '', /404|不存在/u)
  assert.match(result.outcomes[1]?.message ?? '', /修改|版本|modified/u)
  assert.match(result.outcomes[2]?.message ?? '', /授权|API key/u)
  assert.match(result.outcomes[3]?.message ?? '', /拒绝|denied/u)
  assert.match(result.outcomes[4]?.message ?? '', /30/u)
  assert.equal(result.outcomes[5]?.retryable, true)
})

test('remote delete refuses an unusable or missing local key before any DELETE is sent', async () => {
  let deletes = 0
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/api/')) return response({}, { 'Zotero-Server-ID': 'fixture-server' })
    deletes += 1
    return new Response(null, { status: 204 })
  }

  for (const settings of [
    { libraryType: 'user', libraryId: 0, limit: 20 },
    { libraryType: 'user', libraryId: 0, limit: 20, zoteroLocalKeyPersistent: false }
  ]) {
    const blocked: AdapterProfile = { ...profile, settings }
    await assert.rejects(
      () => deleteZoteroRemoteItems(blocked, [{ itemKey: 'I1', remoteRevision: '7' }], fetcher),
      (error: unknown) => error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'AUTH_REQUIRED'
    )
  }
  const noCredential: AdapterProfile = { ...profile, credential: null }
  await assert.rejects(
    () => deleteZoteroRemoteItems(noCredential, [{ itemKey: 'I1', remoteRevision: '7' }], fetcher),
    (error: unknown) => error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'AUTH_REQUIRED'
  )
  await assert.rejects(
    () => deleteZoteroRemoteItems(profile, [], fetcher),
    (error: unknown) => error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'INVALID_MAPPING'
  )
  await assert.rejects(
    () => deleteZoteroRemoteItems(profile, [{ itemKey: 'I1', remoteRevision: '  ' }], fetcher),
    (error: unknown) => error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'REVISION_CONFLICT'
  )
  assert.equal(deletes, 0)
})

test('remote delete reports an uncallable transport as an unavailable outcome instead of throwing', async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/api/')) return response({}, { 'Zotero-Server-ID': 'fixture-server' })
    throw new Error('network down')
  }
  const result = await deleteZoteroRemoteItems(profile, [{ itemKey: 'I1', remoteRevision: '7' }], fetcher)
  assert.equal(result.outcomes[0]?.status, 'unavailable')
  assert.equal(result.outcomes[0]?.retryable, true)
  assert.match(result.outcomes[0]?.message ?? '', /network down/u)
})

test('reading the frozen revision reports each key separately and never invents a version', async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/api/')) return response({}, { 'Zotero-Server-ID': 'fixture-server' })
    if (url.endsWith('/items/I1')) return response({ key: 'I1', version: 7, data: { title: 'Fixture paper' } })
    if (url.endsWith('/items/I2')) return new Response('Not found', { status: 404 })
    return response({ key: 'I3', data: { title: 'no version' } })
  }
  const result = await readZoteroRemoteItems(profile, ['I1', 'I2', 'I3'], fetcher)
  assert.deepEqual(result.items, [{ itemKey: 'I1', version: '7', title: 'Fixture paper' }])
  assert.deepEqual(result.unavailable.map((entry) => entry.itemKey), ['I2', 'I3'])
  assert.match(result.unavailable[0]?.message ?? '', /不存在/u)
  assert.match(result.unavailable[1]?.message ?? '', /revision/u)
})

/** A loopback key answered with “Allow” instead of “Always Allow” is destroyed
 * by the first write it authorizes, which is exactly why a multi-item import
 * only succeeded for part of the selection. */
test('a one-time or unknown local key is reported as unusable and is never spent by the probe', async () => {
  const calls: string[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${url}`)
    if (url.endsWith('/api/')) return response({}, { 'Zotero-Server-ID': 'fixture-server' })
    if (url.includes('/collections')) return response([])
    return response([])
  }

  const singleUse = await probeZotero({ ...profile, settings: { ...profile.settings, zoteroLocalKeyPersistent: false } }, fetcher)
  assert.equal(singleUse.capabilities.write, false)
  assert.equal(singleUse.writeBlockedReason, 'key-single-use')
  assert.match(singleUse.message, /始终允许/u)
  // The capability check must be free of side effects, so it may never POST:
  // that request is what consumes a one-time key.
  assert.equal(calls.some((call) => call.startsWith('POST')), false)

  const unknown = await probeZotero({ ...profile, settings: { libraryType: 'user', libraryId: 0, limit: 20 } }, fetcher)
  assert.equal(unknown.capabilities.write, false)
  assert.equal(unknown.writeBlockedReason, 'key-unverified')
  assert.match(unknown.message, /旧版本/u)
  assert.equal(calls.some((call) => call.startsWith('POST')), false)

  assert.match(zoteroWriteBlockedMessage('key-invalid'), /始终允许/u)
  assert.match(zoteroWriteBlockedMessage('authorization-denied'), /拒绝/u)
})

test('the local write check proves the key with an empty array and keeps every Zotero cause', async () => {
  const captured: Array<{ method: string; body: unknown; serverId: string | null }> = []
  const reply = (status: number, body: string, headers: Record<string, string> = {}): typeof fetch => async (input, init) => {
    if (String(input).endsWith('/api/')) return response({}, { 'Zotero-Server-ID': 'fixture-server' })
    captured.push({
      method: (init?.method ?? 'GET').toUpperCase(),
      body: init?.body === undefined ? null : JSON.parse(String(init.body)) as unknown,
      serverId: new Headers(init?.headers).get('Zotero-Server-ID')
    })
    return new Response(body, { status, headers: { 'Content-Type': 'text/plain', ...headers } })
  }

  // Zotero authenticates the key before it parses the body, so an empty array
  // is a zero-object check: nothing is created, updated or deleted.
  const verified = await verifyZoteroWriteAuthorization(profile, reply(400, 'No items provided'))
  assert.equal(verified.authorized, true)
  assert.equal(captured[0]?.method, 'POST')
  assert.deepEqual(captured[0]?.body, [])
  assert.equal(captured[0]?.serverId, 'fixture-server')

  assert.equal((await verifyZoteroWriteAuthorization(profile, reply(200, '{}'))).authorized, true)

  const expired = await verifyZoteroWriteAuthorization(profile, reply(401, 'Invalid or expired API key'))
  assert.equal(expired.authorized, false)
  assert.equal(expired.reason, 'key-invalid')
  assert.match(expired.message, /始终允许/u)

  const unlicensed = await verifyZoteroWriteAuthorization(profile, reply(401, 'API key required -- POST /api/local/authorize to obtain one'))
  assert.equal(unlicensed.reason, 'key-invalid')
  assert.match(unlicensed.message, /请求 Zotero 写入权限/u)

  const denied = await verifyZoteroWriteAuthorization(profile, reply(403, '{"denied":true}'))
  assert.equal(denied.reason, 'authorization-denied')
  assert.match(denied.message, /拒绝/u)

  // 428 is a missing Server-ID handshake, not a generic version conflict.
  const precondition = await verifyZoteroWriteAuthorization(profile, reply(428, 'Zotero-Server-ID not provided'))
  assert.equal(precondition.reason, 'server-id-missing')
  assert.match(precondition.message, /Server-ID/u)

  const limited = await verifyZoteroWriteAuthorization(profile, reply(429, 'Too many requests', { 'Retry-After': '42' }))
  assert.equal(limited.reason, 'rate-limited')
  assert.equal(limited.retryAfterSeconds, 42)
})

test('the write path itself refuses a local key the probe cannot trust', async () => {
  const network: string[] = []
  const fetcher: typeof fetch = async (input) => {
    network.push(String(input))
    return response([])
  }

  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ ...profile.settings, zoteroLocalKeyPersistent: false }, /一次性/u],
    [{ libraryType: 'user', libraryId: 0, limit: 20 }, /旧版本/u]
  ]
  for (const [settings, expected] of cases) {
    await assert.rejects(
      () => createZoteroProjection({ ...profile, settings }, 'C1', projection(), fetcher),
      (error: unknown) => {
        const typed = error as { code?: string; message?: string }
        assert.equal(typed.code, 'AUTH_REQUIRED')
        assert.match(typed.message ?? '', expected)
        return true
      }
    )
  }
  // The gate runs before the first request, so an unusable key cannot be spent.
  assert.deepEqual(network, [])
})

test('create sends the bare JSON array Zotero requires and surfaces its per-item verdicts', async () => {
  const bodies: unknown[] = []
  const capture: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/api/')) return response({}, { 'Zotero-Server-ID': 'fixture-server' })
    bodies.push(JSON.parse(String(init?.body)) as unknown)
    return response({ successful: { 0: { key: 'NEW1', version: 8 } }, failed: {} })
  }
  assert.equal((await createZoteroProjection(profile, 'C1', projection(), capture)).externalId, 'NEW1')
  // Zotero answers anything that is not a bare array with
  // `Uploaded data must be a JSON array`, so the envelope must not be used.
  assert.equal(Array.isArray(bodies[0]), true)
  assert.equal((bodies[0] as unknown[]).length, 1)

  const oversized: typeof fetch = async (input) => String(input).endsWith('/api/')
    ? response({}, { 'Zotero-Server-ID': 'fixture-server' })
    : new Response('', { status: 413, headers: { 'Content-Type': 'text/plain' } })
  await assert.rejects(
    () => createZoteroProjection(profile, 'C1', projection(), oversized),
    (error: unknown) => {
      const typed = error as { code?: string; message?: string }
      assert.equal(typed.code, 'INVALID_MAPPING')
      assert.match(typed.message ?? '', /最多 50 个条目/u)
      return true
    }
  )

  const rejected: typeof fetch = async (input) => String(input).endsWith('/api/')
    ? response({}, { 'Zotero-Server-ID': 'fixture-server' })
    : response({ successful: {}, failed: { 0: { message: 'Invalid value "x" for field "itemType"' } } })
  await assert.rejects(
    () => createZoteroProjection(profile, 'C1', projection(), rejected),
    (error: unknown) => {
      assert.equal(getZoteroIntegrationError(error)?.code, 'INTEGRATION_REMOTE_RESPONSE_INVALID')
      assert.match((error as { message?: string }).message ?? '', /Invalid value "x" for field "itemType"/u)
      return true
    }
  )
})
