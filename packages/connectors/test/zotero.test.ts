import assert from 'node:assert/strict'
import test from 'node:test'
import { IntegrationErrorSchema } from '@prw/contracts'
import { createZoteroProjection, exportZoteroBibtex, getZoteroIntegrationError, listZoteroCollections, probeZotero, pullZotero, writeZoteroProjection } from '../src/zotero.ts'
import type { AdapterProfile, ManagedProjection } from '../src/types.ts'

const profile: AdapterProfile = {
  provider: 'zotero',
  location: 'http://localhost:23119',
  settings: { libraryType: 'user', libraryId: 0, limit: 20 },
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
    return response([{ key: 'I1', data: { itemType: 'journalArticle', title: 42, extra: 'fixture-secret' } }])
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
  assert.deepEqual((calls[1]?.body as { params?: unknown[] }).params, [['Doe2024', 'Better BibTeX']])
})
