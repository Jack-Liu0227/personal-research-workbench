import type { IntegrationError } from '@prw/contracts'
import type {
  AdapterProbe,
  AdapterProfile,
  AdapterPullResult,
  ManagedProjection,
  NormalizedExternalPaper,
  ProjectionReceipt,
  ProjectionTarget
} from './types.js'
import { randomUUID } from 'node:crypto'
import { IntegrationRuntimeError } from './types.js'

type FetchLike = typeof fetch

const DEFAULT_LOCAL_API_URL = 'http://127.0.0.1:23119/api/'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

type IntegrationErrorPath = Array<string | number>

/**
 * Connector errors retain the existing IntegrationRuntimeError code for the
 * service's backwards-compatible mapping, while carrying the frozen,
 * field-addressable IntegrationError envelope for callers that understand
 * the V2 contract.  The envelope deliberately contains no remote response,
 * URL, credential or filesystem value.
 */
export interface ZoteroIntegrationFailure extends IntegrationRuntimeError {
  readonly integrationError: IntegrationError
}

function integrationFailure(
  operation: string,
  path: IntegrationErrorPath,
  code: string,
  message: string,
  retryable = false,
  kind: IntegrationError['kind'] = 'remote-response'
): ZoteroIntegrationFailure {
  const envelope: IntegrationError = {
    code: kind === 'input'
      ? 'INTEGRATION_INPUT_INVALID'
      : kind === 'zod'
        ? 'INTEGRATION_ZOD_INVALID'
        : 'INTEGRATION_REMOTE_RESPONSE_INVALID',
    provider: 'zotero',
    operation,
    kind,
    fields: [{ path, code, message }],
    retryable,
    message
  }
  const runtime = new IntegrationRuntimeError('INVALID_MAPPING', message) as ZoteroIntegrationFailure
  Object.defineProperty(runtime, 'integrationError', { value: envelope, enumerable: false })
  // `envelope` is a descriptive alias used by a few Core boundary adapters;
  // keep it non-enumerable so serializing the Error cannot expose internals.
  Object.defineProperty(runtime, 'envelope', { value: envelope, enumerable: false })
  return runtime
}

/** Extract a structured connector envelope without exposing Error internals. */
export function getZoteroIntegrationError(error: unknown): IntegrationError | null {
  if (!error || typeof error !== 'object') return null
  const candidate = error as { integrationError?: unknown; envelope?: unknown }
  const value = candidate.integrationError ?? candidate.envelope
  return value && typeof value === 'object' ? value as IntegrationError : null
}

interface ZoteroItem {
  key?: unknown
  version?: unknown
  data?: Record<string, unknown>
}

interface ZoteroCollection {
  key?: unknown
  version?: unknown
  data?: Record<string, unknown>
  meta?: Record<string, unknown>
}

export interface ZoteroCollectionSummary {
  readonly key: string
  readonly name: string
  readonly parentKey: string | null
  readonly itemCount: number
}

export interface ZoteroCollectionPage {
  readonly cursor: string | null
  readonly nextCursor: string | null
  readonly start: number
  readonly nextStart: number | null
  readonly total: number | null
  readonly collections: ZoteroCollectionSummary[]
}

export interface ZoteroBibtexExport {
  readonly content: string
  readonly citationKeys: string[]
}

type CollectionPageInput = {
  readonly cursor?: string | number | null | undefined
  readonly start?: number | string | null | undefined
  readonly limit?: number | string | null | undefined
}

function baseUrl(profile: AdapterProfile): URL {
  const candidate = typeof profile.location === 'string' ? profile.location.trim() : ''
  let url: URL
  try {
    url = new URL(candidate || DEFAULT_LOCAL_API_URL)
  } catch {
    throw new IntegrationRuntimeError('INVALID_MAPPING', 'Zotero 地址不是有效 URL')
  }
  if (url.username || url.password) {
    throw new IntegrationRuntimeError('INVALID_MAPPING', 'Zotero 地址不能包含用户名或密码；请使用凭据字段')
  }
  const local = LOOPBACK_HOSTS.has(url.hostname.toLocaleLowerCase('en-US'))
  if ((!local && url.protocol !== 'https:') || (local && !['http:', 'https:'].includes(url.protocol))) {
    throw new IntegrationRuntimeError('INVALID_MAPPING', 'Zotero 地址必须是 HTTPS 或 localhost')
  }
  url.search = ''
  url.hash = ''
  // Zotero Desktop's Local API is rooted at /api/.  Settings often contain
  // either the documented /api/ URL or only the loopback origin; normalize
  // only that unambiguous root case and leave remote Web API paths intact.
  const pathname = url.pathname.replace(/\/+$/u, '')
  if (local && (pathname === '' || pathname === '/')) url.pathname = '/api/'
  else if (local && pathname.toLocaleLowerCase('en-US') === '/api') url.pathname = '/api/'
  else if (local) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Zotero Local API 地址路径必须是 /api/')
  else if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

function isLoopbackLocation(profile: AdapterProfile): boolean {
  return LOOPBACK_HOSTS.has(baseUrl(profile).hostname.toLocaleLowerCase('en-US'))
}

function headers(profile: AdapterProfile, serverId?: string | null): Headers {
  const value = new Headers({ 'Zotero-API-Version': '3' })
  // Zotero 10+ rejects requests that look like browser traffic unless the
  // caller explicitly opts in.  The service is the trusted local bridge, so
  // mark the request while still restricting configured locations to HTTPS or
  // loopback above.
  if (isLoopbackLocation(profile)) value.set('Zotero-Allowed-Request', 'true')
  const credential = typeof profile.credential === 'string' ? profile.credential.trim() : ''
  if (credential) value.set('Zotero-API-Key', credential)
  const configuredServerId = typeof profile.settings['serverId'] === 'string' ? profile.settings['serverId'].trim() : ''
  if (serverId?.trim() || configuredServerId) value.set('Zotero-Server-ID', serverId?.trim() || configuredServerId)
  return value
}

function hasCredential(profile: AdapterProfile): boolean {
  return typeof profile.credential === 'string' && profile.credential.trim().length > 0
}

function configuredServerId(profile: AdapterProfile): string | null {
  const value = profile.settings['serverId']
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

interface LibrarySettings {
  readonly apiType: 'users' | 'groups'
  readonly id: string
}

function librarySettings(profile: AdapterProfile): LibrarySettings {
  const rawType = profile.settings['libraryType']
  const libraryType = rawType === undefined || rawType === null || rawType === ''
    ? 'users'
    : String(rawType).trim().toLocaleLowerCase('en-US')
  const apiType = libraryType === 'user' || libraryType === 'users'
    ? 'users'
    : libraryType === 'group' || libraryType === 'groups'
      ? 'groups'
      : null
  if (apiType === null) {
    throw new IntegrationRuntimeError('INVALID_MAPPING', 'Zotero libraryType 仅支持 user/users 或 group/groups')
  }

  const rawId = profile.settings['libraryId']
  const libraryId = rawId === undefined || rawId === null || rawId === '' ? '0' : String(rawId).trim()
  if (!/^\d+$/u.test(libraryId)) {
    throw new IntegrationRuntimeError('INVALID_MAPPING', 'Zotero libraryId 必须是数字 ID')
  }
  return { apiType, id: libraryId }
}

async function fetchServerId(profile: AdapterProfile, fetcher: FetchLike): Promise<string | null> {
  try {
    const response = await fetcher(baseUrl(profile), {
      headers: new Headers({
        'Zotero-API-Version': '3',
        // Zotero 10+ requires this opt-in on the initial probe too.  Without
        // it we can discover a running Local API only to fail the subsequent
        // collection/item request with a misleading shape error.
        'Zotero-Allowed-Request': 'true'
      }),
      signal: AbortSignal.timeout(8_000)
    })
    if (!response.ok) mapHttpError(response)
    const serverId = response.headers.get('Zotero-Server-ID')?.trim() ?? ''
    return serverId || null
  } catch (error) {
    mapCollectionTransportError(error)
  }
}

function endpoint(profile: AdapterProfile, suffix = 'items'): URL {
  const url = baseUrl(profile)
  const library = librarySettings(profile)
  const cleanSuffix = suffix.replace(/^\/+|\/+$/gu, '')
  if (!cleanSuffix) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Zotero API 路径无效')
  url.pathname += `${library.apiType}/${encodeURIComponent(library.id)}/${cleanSuffix}`
  return url
}

async function serverIdForRequest(profile: AdapterProfile, fetcher: FetchLike): Promise<string | null> {
  // Web API requests use the caller's API key and do not have the Local API's
  // per-server identity.  Local collection/item calls must probe first so the
  // server id is attached to every subsequent request (including read-only
  // calls, where it is harmless but useful for server routing).
  return isLoopbackLocation(profile) ? fetchServerId(profile, fetcher) : null
}

function creators(data: Record<string, unknown>): string[] {
  if (!Array.isArray(data['creators'])) return []
  return data['creators'].flatMap((creator) => {
    if (!creator || typeof creator !== 'object') return []
    const item = creator as Record<string, unknown>
    const name = typeof item['name'] === 'string'
      ? item['name']
      : [item['firstName'], item['lastName']].filter((part): part is string => typeof part === 'string').join(' ')
    return name ? [name] : []
  })
}

function tags(data: Record<string, unknown>): string[] {
  if (!Array.isArray(data['tags'])) return []
  return data['tags'].flatMap((tag) => {
    if (typeof tag === 'string') return [tag]
    if (tag && typeof tag === 'object' && typeof (tag as Record<string, unknown>)['tag'] === 'string') {
      return [(tag as Record<string, string>)['tag']!]
    }
    return []
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function optionalInteger(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function strictNonNegativeInteger(value: unknown, field: string): number {
  const parsed = optionalInteger(value)
  if (parsed === null) throw new IntegrationRuntimeError('INVALID_MAPPING', `Zotero ${field} 无效`)
  return parsed
}

function strictPositiveInteger(value: unknown, field: string): number {
  const parsed = strictNonNegativeInteger(value, field)
  if (parsed <= 0) throw new IntegrationRuntimeError('INVALID_MAPPING', `Zotero ${field} 必须大于 0`)
  return parsed
}

function encodeCollectionCursor(start: number): string {
  return `offset:${start}`
}

function decodeCollectionCursor(cursor: string): number {
  const raw = cursor.startsWith('offset:') ? cursor.slice('offset:'.length) : cursor
  return strictNonNegativeInteger(raw, 'collections cursor')
}

function resolveCollectionStart(profile: AdapterProfile, page?: CollectionPageInput): number {
  const explicitCursor = page?.cursor
  if (explicitCursor !== undefined && explicitCursor !== null && explicitCursor !== '') {
    return typeof explicitCursor === 'number'
      ? strictNonNegativeInteger(explicitCursor, 'collections cursor')
      : decodeCollectionCursor(explicitCursor)
  }
  const explicitStart = page?.start
  if (explicitStart !== undefined && explicitStart !== null && explicitStart !== '') {
    return strictNonNegativeInteger(explicitStart, 'collections start')
  }
  const settingCursor = profile.settings['cursor']
  if (settingCursor !== undefined && settingCursor !== null && settingCursor !== '') {
    return typeof settingCursor === 'number'
      ? strictNonNegativeInteger(settingCursor, 'collections cursor')
      : decodeCollectionCursor(String(settingCursor))
  }
  const settingStart = profile.settings['start']
  if (settingStart !== undefined && settingStart !== null && settingStart !== '') {
    return strictNonNegativeInteger(settingStart, 'collections start')
  }
  return 0
}

function resolveCollectionLimit(profile: AdapterProfile, page?: CollectionPageInput): number {
  const explicitLimit = page?.limit
  if (explicitLimit !== undefined && explicitLimit !== null && explicitLimit !== '') {
    return Math.min(strictPositiveInteger(explicitLimit, 'collections limit'), 100)
  }
  const settingLimit = profile.settings['limit']
  if (settingLimit !== undefined && settingLimit !== null && settingLimit !== '') {
    return Math.min(strictPositiveInteger(settingLimit, 'collections limit'), 100)
  }
  return 100
}

function resolveItemLimit(profile: AdapterProfile): number {
  const configured = profile.settings['limit']
  if (configured === undefined || configured === null || configured === '') return 100
  return Math.min(strictPositiveInteger(configured, 'items limit'), 100)
}

function normalizeCollection(item: unknown, index: number): ZoteroCollectionSummary {
  const record = asRecord(item)
  if (record === null) throw integrationFailure('zotero.collections.read', ['collections', index], 'invalid_type', 'Zotero collection 项格式无效。')
  const data = asRecord(record['data']) ?? record
  const meta = asRecord(record['meta'])
  const keyValue = record['key'] ?? data['key']
  const key = typeof keyValue === 'string' ? keyValue.trim() : ''
  if (!key) throw integrationFailure('zotero.collections.read', ['collections', index, 'key'], 'invalid_type', 'Zotero collection 缺少有效 key。')
  const name = typeof data['name'] === 'string' ? data['name'].trim() : ''
  if (!name) throw integrationFailure('zotero.collections.read', ['collections', index, 'data', 'name'], 'invalid_type', 'Zotero collection 缺少有效名称。')
  const parentCollection = data['parentCollection']
  // Zotero represents a root collection parent as boolean false in the
  // Local API; the public DTO intentionally normalizes that to null.
  if (parentCollection !== undefined && parentCollection !== null && parentCollection !== false && typeof parentCollection !== 'string') {
    throw integrationFailure('zotero.collections.read', ['collections', index, 'data', 'parentCollection'], 'invalid_type', 'Zotero collection parentKey 格式无效。')
  }
  const parentKey = typeof parentCollection === 'string' && parentCollection.trim() ? parentCollection.trim() : null
  const countValue = meta?.['numItems'] ?? data['itemCount'] ?? data['numItems']
  const itemCount = countValue === undefined || countValue === null || countValue === '' ? 0 : optionalInteger(countValue)
  if (itemCount === null) {
    throw integrationFailure('zotero.collections.read', ['collections', index, 'meta', 'numItems'], 'invalid_type', 'Zotero collection itemCount 格式无效。')
  }
  return { key, name, parentKey, itemCount }
}

function extractCollectionItems(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload
  const record = asRecord(payload)
  if (record === null) return null
  if (Array.isArray(record['collections'])) return record['collections']
  if (Array.isArray(record['items'])) return record['items']
  if (Array.isArray(record['data'])) return record['data']
  return null
}

function mapCollectionTransportError(error: unknown): never {
  if (error instanceof IntegrationRuntimeError) throw error
  if (error instanceof Error) {
    const cause = error as Error & { cause?: unknown }
    const code = typeof cause.cause === 'object' && cause.cause !== null && 'code' in cause.cause
      ? String((cause.cause as { code?: unknown }).code ?? '')
      : ''
    if (
      error.name === 'AbortError' ||
      /fetch failed/i.test(error.message) ||
      ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'EPIPE'].includes(code)
    ) {
      throw new IntegrationRuntimeError('NOT_CONNECTED', 'Zotero 无法连接')
    }
  }
  throw new IntegrationRuntimeError('TEMPORARILY_UNAVAILABLE', 'Zotero 请求失败，请稍后重试')
}

async function readJson(response: Response, operation: string): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw integrationFailure(operation, [], 'invalid_json', 'Zotero 远端响应不是有效 JSON。')
  }
}

function normalize(item: unknown, profile: AdapterProfile, index: number): NormalizedExternalPaper | null {
  const record = asRecord(item)
  if (record === null) throw integrationFailure('zotero.items.read', ['items', index], 'invalid_type', 'Zotero item 项格式无效。')
  const key = typeof record['key'] === 'string' ? record['key'].trim() : ''
  if (!key) throw integrationFailure('zotero.items.read', ['items', index, 'key'], 'invalid_type', 'Zotero item 缺少有效 key。')
  const data = asRecord(record['data'])
  if (data === null) throw integrationFailure('zotero.items.read', ['items', index, 'data'], 'invalid_type', 'Zotero item data 格式无效。')
  const itemType = data['itemType']
  if (typeof itemType !== 'string' || !itemType.trim()) {
    throw integrationFailure('zotero.items.read', ['items', index, 'data', 'itemType'], 'invalid_type', 'Zotero item 类型无效。')
  }
  // Attachments and notes are valid Zotero records but are not Papers.
  if (itemType === 'attachment' || itemType === 'note') return null
  const title = typeof data['title'] === 'string' ? data['title'].trim() : ''
  // Untitled metadata records are not valid Paper projections. Skip only the
  // affected record and never manufacture a title from its key or DOI.
  if (!title) return null
  for (const field of ['creators', 'tags', 'collections'] as const) {
    const value = data[field]
    if (value !== undefined && !Array.isArray(value)) {
      throw integrationFailure('zotero.items.read', ['items', index, 'data', field], 'invalid_type', `Zotero item ${field} 格式无效。`)
    }
  }
  const remoteCreators = data['creators']
  if (Array.isArray(remoteCreators)) {
    remoteCreators.forEach((creator, creatorIndex) => {
      const value = asRecord(creator)
      if (value === null || (typeof value['name'] !== 'string' && typeof value['firstName'] !== 'string' && typeof value['lastName'] !== 'string')) {
        throw integrationFailure('zotero.items.read', ['items', index, 'data', 'creators', creatorIndex], 'invalid_type', 'Zotero item creator 格式无效。')
      }
    })
  }
  const remoteTags = data['tags']
  if (Array.isArray(remoteTags)) {
    remoteTags.forEach((tag, tagIndex) => {
      const value = typeof tag === 'string' ? tag : asRecord(tag)
      if (value === null || (typeof value !== 'string' && typeof value['tag'] !== 'string')) {
        throw integrationFailure('zotero.items.read', ['items', index, 'data', 'tags', tagIndex], 'invalid_type', 'Zotero item tag 格式无效。')
      }
    })
  }
  const remoteCollections = data['collections']
  if (Array.isArray(remoteCollections)) {
    remoteCollections.forEach((collection, collectionIndex) => {
      if (typeof collection !== 'string' || !collection.trim()) {
        throw integrationFailure('zotero.items.read', ['items', index, 'data', 'collections', collectionIndex], 'invalid_type', 'Zotero item collection key 格式无效。')
      }
    })
  }
  for (const field of ['abstractNote', 'publicationTitle', 'date', 'DOI', 'url', 'citationKey'] as const) {
    const value = data[field]
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw integrationFailure('zotero.items.read', ['items', index, 'data', field], 'invalid_type', `Zotero item ${field} 格式无效。`)
    }
  }
  const version = record['version']
  if (version !== undefined && optionalInteger(version) === null) {
    throw integrationFailure('zotero.items.read', ['items', index, 'version'], 'invalid_type', 'Zotero item revision 格式无效。')
  }
  const library = librarySettings(profile)
  const date = typeof data['date'] === 'string' ? data['date'] : ''
  const yearText = date.match(/\b(?:1[5-9]|20|21)\d{2}\b/)?.[0]
  return {
    externalId: key,
    locator: `zotero://select/${library.apiType}/${library.id}/items/${key}`,
    remoteRevision: version === undefined || version === null ? null : String(version),
    managedBlockId: null,
    title,
    authors: creators(data),
    year: yearText ? Number(yearText) : null,
    venue: typeof data['publicationTitle'] === 'string' ? data['publicationTitle'] : '',
    abstract: typeof data['abstractNote'] === 'string' ? data['abstractNote'] : '',
    doi: typeof data['DOI'] === 'string' && data['DOI'] ? data['DOI'] : null,
    url: typeof data['url'] === 'string' && data['url'] ? data['url'] : null,
    citationKey: typeof data['citationKey'] === 'string' && data['citationKey'] ? data['citationKey'] : null,
    tags: tags(data),
    collections: Array.isArray(data['collections']) ? data['collections'].filter((value): value is string => typeof value === 'string') : [],
    localPdfPath: null
  }
}

function normalizeCollectionsResponse(payload: unknown): ZoteroCollectionSummary[] {
  const items = extractCollectionItems(payload)
  if (items === null) throw integrationFailure('zotero.collections.read', ['collections'], 'invalid_type', 'Zotero collections 返回格式无效。')
  return items.map((item, index) => normalizeCollection(item, index))
}

function mapHttpError(response: Response): never {
  if (response.status === 401) throw new IntegrationRuntimeError('AUTH_REQUIRED', 'Zotero 需要授权')
  if (response.status === 403) throw new IntegrationRuntimeError('PERMISSION_DENIED', 'Zotero 权限不足')
  if (response.status === 404) throw new IntegrationRuntimeError('NOT_FOUND', 'Zotero 对象不存在')
  if (response.status === 409 || response.status === 412 || response.status === 428) {
    throw new IntegrationRuntimeError('REVISION_CONFLICT', 'Zotero 对象版本冲突')
  }
  if (response.status === 429) throw new IntegrationRuntimeError('RATE_LIMITED', 'Zotero 请求过于频繁')
  throw new IntegrationRuntimeError('TEMPORARILY_UNAVAILABLE', `Zotero 请求失败（${response.status}）`)
}

function upsertManagedExtra(existing: string, projection: ManagedProjection): string {
  const begin = `Workbench managed begin: ${projection.blockId}`
  const end = `Workbench managed end: ${projection.blockId}`
  const escaped = projection.blockId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`Workbench managed begin: ${escaped}[\\s\\S]*?Workbench managed end: ${escaped}`, 'g')
  const matches = existing.match(pattern) ?? []
  if (matches.length > 1) throw new IntegrationRuntimeError('REVISION_CONFLICT', 'Zotero extra 中存在重复托管区块')
  const block = `${begin}\nWorkbench ID: ${projection.workbenchId}\n${projection.markdown.slice(0, 45_000)}\n${end}`
  return matches.length === 1 ? existing.replace(pattern, block) : `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${block}`
}

export async function probeZotero(profile: AdapterProfile, fetcher: FetchLike = fetch): Promise<AdapterProbe> {
  try {
    const local = isLoopbackLocation(profile)
    const serverId = await serverIdForRequest(profile, fetcher)
    const collectionUrl = endpoint(profile, 'collections')
    collectionUrl.searchParams.set('format', 'json')
    collectionUrl.searchParams.set('limit', '1')
    const collectionResponse = await fetcher(collectionUrl, { headers: headers(profile, serverId), signal: AbortSignal.timeout(8_000) })
    if (!collectionResponse.ok) mapHttpError(collectionResponse)
    normalizeCollectionsResponse(await readJson(collectionResponse, 'zotero.collections.probe'))

    const itemUrl = endpoint(profile)
    itemUrl.searchParams.set('format', 'json')
    itemUrl.searchParams.set('limit', '1')
    const itemResponse = await fetcher(itemUrl, { headers: headers(profile, serverId), signal: AbortSignal.timeout(8_000) })
    if (!itemResponse.ok) mapHttpError(itemResponse)
    const itemPayload = await readJson(itemResponse, 'zotero.items.probe')
    if (!Array.isArray(itemPayload)) throw integrationFailure('zotero.items.probe', ['items'], 'invalid_type', 'Zotero items 返回格式无效。')
    itemPayload.forEach((item, index) => { normalize(item, profile, index) })
    const write = local ? Boolean(hasCredential(profile) && serverId) : hasCredential(profile)
    return {
      ok: true,
      message: write
        ? 'Zotero API 已连接，可执行受 revision 保护的写入。'
        : local
          ? hasCredential(profile) ? 'Zotero 已连接，但本地写入仍需授权。' : 'Zotero Local API 只读连接正常。'
          : 'Zotero API 已连接，但写入需要 API key。',
      capabilities: { read: true, write, attachments: 'link_only', incremental: true }
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '无法连接 Zotero',
      capabilities: { read: false, write: false, attachments: 'link_only', incremental: true }
    }
  }
}

/** Request Zotero 10+ local write authorization. The returned key is secret
 * material and must be stored by Main safeStorage, never exposed to Renderer. */
export async function authorizeZotero(profile: AdapterProfile, fetcher: FetchLike = fetch): Promise<{ key: string; remember: boolean; serverId: string }> {
  if (!isLoopbackLocation(profile)) {
    throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', '只有 localhost 回环 Zotero Local API 支持运行时写入授权。')
  }
  try {
    const serverId = await fetchServerId(profile, fetcher)
    if (!serverId) throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', 'Zotero 未返回 Zotero-Server-ID，无法申请本地写入授权。')
    const url = new URL('local/authorize', baseUrl(profile))
    const response = await fetcher(url, {
      method: 'POST',
      headers: new Headers({
        'Content-Type': 'application/json',
        'Zotero-API-Version': '3',
        'Zotero-Server-ID': serverId,
        // Zotero 10+ requires an explicit opt-in for browser-like local
        // requests.  Authorization is still initiated only by the user and
        // remains inside the Main/Core bridge.
        'Zotero-Allowed-Request': 'true'
      }),
      body: JSON.stringify({ appName: 'Personal Research Workbench' }),
      signal: AbortSignal.timeout(60_000)
    })
    if (!response.ok) mapHttpError(response)
    const payload: unknown = await readJson(response, 'zotero.authorize')
    if (!payload || typeof payload !== 'object') throw integrationFailure('zotero.authorize', [], 'invalid_type', 'Zotero 授权响应格式无效。')
    const record = payload as Record<string, unknown>
    if (typeof record['key'] !== 'string' || !record['key'].trim()) throw integrationFailure('zotero.authorize', ['key'], 'invalid_type', 'Zotero 未返回本地写入 key。')
    return { key: record['key'].trim(), remember: record['remember'] === true, serverId }
  } catch (error) {
    mapCollectionTransportError(error)
  }
}

export async function pullZotero(profile: AdapterProfile, fetcher: FetchLike = fetch): Promise<AdapterPullResult> {
  try {
    const serverId = await serverIdForRequest(profile, fetcher)
    const url = endpoint(profile)
    url.searchParams.set('format', 'json')
    const limit = resolveItemLimit(profile)
    url.searchParams.set('limit', String(limit))
    const startValue = profile.settings['start']
    if (startValue !== undefined && startValue !== null && startValue !== '') {
      const start = strictNonNegativeInteger(startValue, 'items start')
      url.searchParams.set('start', String(start))
    }
    const since = profile.settings['since']
    if (typeof since === 'string' && since.trim()) url.searchParams.set('since', since.trim())
    const response = await fetcher(url, { headers: headers(profile, serverId), signal: AbortSignal.timeout(20_000) })
    if (!response.ok) mapHttpError(response)
    const payload = await readJson(response, 'zotero.items.read')
    if (!Array.isArray(payload)) throw integrationFailure('zotero.items.read', ['items'], 'invalid_type', 'Zotero items 返回格式无效。')
    const start = optionalInteger(startValue) ?? 0
    const total = optionalInteger(response.headers.get('Total-Results'))
    return {
      cursor: response.headers.get('Last-Modified-Version')?.trim() || null,
      pageStart: start,
      fetchedCount: payload.length,
      total,
      hasMore: total !== null ? start + payload.length < total : payload.length >= limit,
      papers: payload.flatMap((item, index) => {
        const paper = normalize(item, profile, index)
        return paper ? [paper] : []
      })
    }
  } catch (error) {
    mapCollectionTransportError(error)
  }
}

/**
 * Export an explicit Zotero selection through Better BibTeX's documented local
 * JSON-RPC bridge. This deliberately does not read zotero.sqlite or invoke a
 * command shell. The bridge first resolves stable Zotero item keys to BBT
 * citation keys, then asks the plugin to render the BibTeX so the user's BBT
 * key/escaping/postscript settings remain authoritative.
 */
export async function exportZoteroBibtex(
  profile: AdapterProfile,
  itemKeys: readonly string[],
  tags: readonly string[] = [],
  projectTag: string | null = null,
  fetcher: FetchLike = fetch
): Promise<ZoteroBibtexExport> {
  if (!isLoopbackLocation(profile)) {
    throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', 'Better BibTeX 本地桥接只支持 localhost Zotero。')
  }
  const normalizedKeys = [...new Set(itemKeys.map((value) => value.trim()).filter(Boolean))]
  if (normalizedKeys.length === 0) throw new IntegrationRuntimeError('INVALID_MAPPING', '至少选择一篇 Zotero 文献后再导出。')
  if (normalizedKeys.length > 500) throw new IntegrationRuntimeError('INVALID_MAPPING', '单次最多导出 500 篇 Zotero 文献。')

  try {
    const library = librarySettings(profile)
    // Better BibTeX resolves personal-library keys without a prefix (its
    // internal library id is usually 1, while Zotero's Local API deliberately
    // uses the special user id 0).  Group libraries do require the numeric
    // library prefix.  Sending `0:key` is accepted by Zotero Local API but is
    // *not* a valid BBT reference and was the reason exports silently returned
    // null citation keys.
    const refs = library.apiType === 'users'
      ? normalizedKeys
      : normalizedKeys.map((key) => `${library.id}:${key}`)
    const citationResult = await betterBibtexRpc(profile, 'item.citationkey', [refs], fetcher)
    const citationMap = asRecord(citationResult)
    const citationKeys = normalizedKeys.map((key) => {
      const ref = library.apiType === 'users' ? key : `${library.id}:${key}`
      const value = citationMap?.[ref]
        ?? citationMap?.[key]
        ?? citationMap?.[`${library.id}:${key}`]
        // Some BBT versions return the personal-library numeric prefix even
        // when it was omitted from the request.  Resolve that representation
        // by stable item-key suffix without accepting an unrelated key.
        ?? Object.entries(citationMap ?? {}).find(([candidate]) => candidate.endsWith(`:${key}`))?.[1]
      return typeof value === 'string' ? value.trim() : ''
    })
    if (citationKeys.some((value) => !value)) {
      throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', 'Better BibTeX 未返回所选条目的 citation key；请在 Zotero 中启用/刷新 Better BibTeX。')
    }
    let content: string
    try {
      // BBT accepts an optional library id as its third argument.  It treats
      // the personal library as the implicit "My Library" scope;
      // Zotero Local's user id `0` is not a valid BBT library id.  Passing 0
      // makes otherwise valid personal-library exports fail with
      // `could not find library 0` and need the slower pull-export fallback.
      // Group libraries do have a numeric BBT library id, so keep it there.
      const exportParams = library.apiType === 'users'
        ? [citationKeys, 'Better BibTeX']
        : [citationKeys, 'Better BibTeX', library.id]
      const exported = await betterBibtexRpc(profile, 'item.export', exportParams, fetcher)
      content = typeof exported === 'string' ? exported : ''
    } catch {
      // Older BBT releases expose the pull-export endpoint but not the
      // JSON-RPC item.export method. Keep a documented, read-only fallback.
      const url = new URL('/better-bibtex/export/item', baseUrl(profile))
      url.searchParams.set('citationKeys', citationKeys.join(','))
      url.searchParams.set('translator', 'bib')
      const response = await fetcher(url, {
        // The pull-export endpoint is served by the same Zotero process. Keep
        // the local-request opt-in and any cached Server-ID on the fallback
        // path as well; this matters with Zotero 10's browser-request guard.
        headers: headers(profile, configuredServerId(profile)),
        signal: AbortSignal.timeout(30_000)
      })
      if (!response.ok) mapHttpError(response)
      content = await response.text()
    }
    if (!content.trim() || !content.includes('@')) {
      throw integrationFailure('zotero.better-bibtex.export', ['content'], 'invalid_type', 'Better BibTeX 未返回有效 BibTeX。', true, 'remote-response')
    }
    const normalizedTags = [...new Set([
      projectTag,
      ...tags
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => `#${value.replace(/^#+/u, '').trim()}`))]
    if (normalizedTags.length > 0) {
      content = `% Workbench tags: ${normalizedTags.join(' ')}\n${content.trimEnd()}\n`
    }
    return { content: content.slice(0, 5_000_000), citationKeys }
  } catch (error) {
    mapCollectionTransportError(error)
  }
}

async function betterBibtexRpc(
  profile: AdapterProfile,
  method: string,
  params: unknown[],
  fetcher: FetchLike
): Promise<unknown> {
  const url = new URL('/better-bibtex/json-rpc', baseUrl(profile))
  const requestHeaders = headers(profile, configuredServerId(profile))
  requestHeaders.set('Content-Type', 'application/json')
  requestHeaders.set('Accept', 'application/json')
  const response = await fetcher(url, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) mapHttpError(response)
  const payload = await readJson(response, `zotero.better-bibtex.${method}`)
  const record = asRecord(payload)
  if (record === null) throw integrationFailure(`zotero.better-bibtex.${method}`, [], 'invalid_type', 'Better BibTeX JSON-RPC 响应格式无效。')
  if (record['error'] !== undefined) throw integrationFailure(`zotero.better-bibtex.${method}`, ['error'], 'remote_error', 'Better BibTeX 未能完成导出。', true)
  if (!Object.prototype.hasOwnProperty.call(record, 'result')) {
    throw integrationFailure(`zotero.better-bibtex.${method}`, ['result'], 'required', 'Better BibTeX JSON-RPC 响应缺少 result。')
  }
  // BBT releases before 6.7.143 accidentally wrapped `item.export` one
  // extra time. Accept that historical response while keeping the public
  // connector result a plain string/map.
  const result = record['result']
  const nested = asRecord(result)
  return nested !== null && Object.keys(nested).length === 1 && Object.prototype.hasOwnProperty.call(nested, 'result')
    ? nested['result']
    : result
}

export async function listZoteroCollections(
  profile: AdapterProfile,
  pageOrFetcher?: FetchLike | CollectionPageInput,
  maybeFetcher: FetchLike = fetch
): Promise<ZoteroCollectionPage> {
  const page = typeof pageOrFetcher === 'function' ? undefined : pageOrFetcher
  const fetcher = typeof pageOrFetcher === 'function' ? pageOrFetcher : maybeFetcher
  try {
    const serverId = await serverIdForRequest(profile, fetcher)
    const url = endpoint(profile, 'collections')
    const start = resolveCollectionStart(profile, page)
    const limit = resolveCollectionLimit(profile, page)
    url.searchParams.set('format', 'json')
    url.searchParams.set('limit', String(limit))
    if (start > 0) url.searchParams.set('start', String(start))
    const response = await fetcher(url, { headers: headers(profile, serverId), signal: AbortSignal.timeout(20_000) })
    if (!response.ok) mapHttpError(response)
    const payload = await readJson(response, 'zotero.collections.read')
    const collections = normalizeCollectionsResponse(payload)
    const total = optionalInteger(response.headers.get('Total-Results'))
    const nextStart = start + collections.length
    const nextCursor = collections.length === 0
      ? null
      : (total !== null && nextStart >= total) || collections.length < limit
        ? null
        : encodeCollectionCursor(nextStart)
    return {
      cursor: nextCursor,
      nextCursor,
      start,
      nextStart: nextCursor === null ? null : nextStart,
      total,
      collections
    }
  } catch (error) {
    mapCollectionTransportError(error)
  }
}

export async function writeZoteroProjection(
  profile: AdapterProfile,
  target: ProjectionTarget,
  projection: ManagedProjection,
  fetcher: FetchLike = fetch
): Promise<ProjectionReceipt> {
  if (!hasCredential(profile)) throw new IntegrationRuntimeError('AUTH_REQUIRED', 'Zotero 写入需要 API key')
  if (!target.remoteRevision) throw new IntegrationRuntimeError('REVISION_CONFLICT', 'Zotero 写入需要对象版本')
  try {
    const serverId = await serverIdForRequest(profile, fetcher)
    if (isLoopbackLocation(profile) && !serverId && !configuredServerId(profile)) {
      throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', 'Zotero Local API 未提供 server id，暂不支持写入。')
    }
    const url = endpoint(profile, `items/${encodeURIComponent(target.externalId)}`)
    const currentResponse = await fetcher(url, {
      headers: headers(profile, serverId),
      signal: AbortSignal.timeout(20_000)
    })
    if (!currentResponse.ok) mapHttpError(currentResponse)
    const currentPayload = await readJson(currentResponse, 'zotero.item.read')
    const current = asRecord(currentPayload)
    if (current === null) throw integrationFailure('zotero.item.read', [], 'invalid_type', 'Zotero item 响应格式无效。')
    if (typeof current['key'] !== 'string' || !current['key'].trim()) {
      throw integrationFailure('zotero.item.read', ['key'], 'invalid_type', 'Zotero item 响应缺少 key。')
    }
    if (current['version'] === undefined || current['version'] === null) {
      throw integrationFailure('zotero.item.read', ['version'], 'invalid_type', 'Zotero item 响应缺少 revision。')
    }
    const version = optionalInteger(current['version'])
    if (version === null || String(version) !== target.remoteRevision) {
      throw new IntegrationRuntimeError('REVISION_CONFLICT', 'Zotero 对象已在外部更新')
    }
    const currentData = asRecord(current['data'])
    if (currentData === null) throw integrationFailure('zotero.item.read', ['data'], 'invalid_type', 'Zotero item data 响应格式无效。')
    const currentExtra = typeof currentData['extra'] === 'string' ? currentData['extra'] : ''
    const response = await fetcher(url, {
      method: 'PATCH',
      headers: new Headers({
        ...Object.fromEntries(headers(profile, serverId).entries()),
        'Content-Type': 'application/json',
        'If-Unmodified-Since-Version': target.remoteRevision
      }),
      body: JSON.stringify({
        extra: upsertManagedExtra(currentExtra, projection),
        tags: projection.tags.map((tag) => ({ tag })),
        collections: projection.collections
      }),
      signal: AbortSignal.timeout(20_000)
    })
    if (!response.ok) mapHttpError(response)
    return {
      externalId: target.externalId,
      locator: target.locator,
      remoteRevision: response.headers.get('Last-Modified-Version')?.trim() || target.remoteRevision
    }
  } catch (error) {
    mapCollectionTransportError(error)
  }
}

/** Create a new Zotero item from a local Paper projection.  This is kept
 * separate from `writeZoteroProjection` because a new item has no remote
 * revision and Zotero assigns its stable item key on the POST response. */
export async function createZoteroProjection(
  profile: AdapterProfile,
  targetCollectionKey: string | null,
  projection: ManagedProjection,
  fetcher: FetchLike = fetch
): Promise<ProjectionReceipt> {
  if (!hasCredential(profile)) throw new IntegrationRuntimeError('AUTH_REQUIRED', 'Zotero create requires a local/API key')
  try {
    const serverId = await serverIdForRequest(profile, fetcher)
    if (isLoopbackLocation(profile) && !serverId && !configuredServerId(profile)) {
      throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', 'Zotero Local API 未提供 server id，暂不支持写入。')
    }
    const library = librarySettings(profile)
    const url = endpoint(profile, 'items')
    const authors = (projection.authors ?? []).map((author) => author.trim()).filter(Boolean).map((author) => {
      const parts = author.split(/\s+/u)
      if (parts.length <= 1) return { creatorType: 'author', name: author }
      return { creatorType: 'author', firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1) }
    })
    const collections = targetCollectionKey && targetCollectionKey.trim()
      ? [targetCollectionKey.trim()]
      : []
    const item = {
      itemType: 'journalArticle',
      title: projection.title,
      creators: authors,
      date: projection.year === null || projection.year === undefined ? '' : String(projection.year),
      publicationTitle: projection.venue ?? '',
      abstractNote: projection.abstract ?? '',
      DOI: projection.doi ?? '',
      url: projection.url ?? '',
      extra: upsertManagedExtra('', projection),
      tags: projection.tags.map((tag) => ({ tag })),
      collections
    }
    const requestHeaders = headers(profile, serverId)
    requestHeaders.set('Content-Type', 'application/json')
    requestHeaders.set('Zotero-Write-Token', randomUUID().replaceAll('-', ''))
    const response = await fetcher(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify([item]),
      signal: AbortSignal.timeout(20_000)
    })
    if (!response.ok) mapHttpError(response)
    const payload: unknown = await readJson(response, 'zotero.item.create')
    const record = asRecord(payload)
    if (record === null) throw integrationFailure('zotero.item.create', [], 'invalid_type', 'Zotero create 响应格式无效。')
    const failed = asRecord(record['failed'])?.['0']
    if (failed !== undefined) {
      throw integrationFailure('zotero.item.create', ['failed', 0], 'remote_rejected', 'Zotero 拒绝创建 item。')
    }
    const successful = asRecord(record['successful'])?.['0']
    const successfulRecord = asRecord(successful)
    const externalId = typeof successful === 'string'
      ? successful.trim()
      : typeof successfulRecord?.['key'] === 'string'
        ? successfulRecord['key'].trim()
        : ''
    if (!externalId) throw integrationFailure('zotero.item.create', ['successful', 0], 'invalid_type', 'Zotero create 响应缺少 item key。')
    const responseVersion = response.headers.get('Last-Modified-Version')?.trim() || null
    const successfulVersion = successfulRecord?.['version']
    const remoteRevision = successfulVersion === undefined || successfulVersion === null
      ? responseVersion
      : optionalInteger(successfulVersion) === null
        ? (() => { throw integrationFailure('zotero.item.create', ['successful', 0, 'version'], 'invalid_type', 'Zotero create 响应 revision 格式无效。') })()
        : String(successfulVersion)
    return {
      externalId,
      locator: `zotero://select/${library.apiType}/${library.id}/items/${externalId}`,
      remoteRevision
    }
  } catch (error) {
    mapCollectionTransportError(error)
  }
}
