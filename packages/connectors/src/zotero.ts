import type { IntegrationError } from '@prw/contracts'
import type {
  AdapterProbe,
  AdapterProfile,
  AdapterPullResult,
  AdapterWriteBlockedReason,
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
/** Zotero Local API and Web API both reject more than 50 objects per write. */
const MAX_WRITE_OBJECTS = 50

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

/**
 * Zotero item deletion.
 *
 * The contract is taken from Zotero's own Local API server implementation
 * (`server_localAPI.js`), not guessed: the item erase route is
 * `DELETE <library>/items/<itemKey>`, it requires the `Zotero-Server-ID`
 * handshake on loopback exactly like every other local call, and it refuses to
 * run without `If-Unmodified-Since-Version` (missing header → `428`, stale
 * version → `412`, unknown key → `404`, success → `204`).  The local server
 * performs `obj.eraseTx()`, i.e. a permanent delete rather than the client's
 * "move to trash", and a successful response is therefore the only thing a
 * Workbench receipt may report as a remote deletion.
 */
export interface ZoteroDeleteTarget {
  readonly itemKey: string
  /** The version the deletion was previewed against.  It is sent as the
   * precondition so Zotero itself rejects a stale delete with `412` instead of
   * erasing an item the user changed in the meantime. */
  readonly remoteRevision: string
}

/** Per-item outcome of a real `DELETE`.  `deleted` and `absent` are the only
 * states in which the remote library is known not to hold the item any more;
 * every other state means the item is still there and local data must stay. */
export type ZoteroDeleteOutcomeStatus =
  | 'deleted'
  | 'absent'
  | 'conflict'
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limited'
  | 'unavailable'

export interface ZoteroDeleteOutcome {
  readonly itemKey: string
  readonly status: ZoteroDeleteOutcomeStatus
  /** `Last-Modified-Version` of the library after the delete, when returned. */
  readonly remoteVersion: string | null
  readonly message: string
  readonly retryable: boolean
}

export const ZOTERO_DELETE_BLOCKED_MESSAGE = 'Zotero 未获得写入权限，因此没有发送任何删除请求：远端条目仍然存在，本地记录也保留。'
export const ZOTERO_DELETE_ABSENT_MESSAGE = 'Zotero 远端已不存在该条目（404）：本地投影可以安全删除。'
export const ZOTERO_DELETE_CONFLICT_MESSAGE = 'Zotero 条目在预览之后已被修改，本次没有删除它：请重新预览并确认后再试。'
export const ZOTERO_DELETE_UNAVAILABLE_MESSAGE = 'Zotero 删除请求未得到可用响应：无法确认远端是否已删除，因此保留本地记录。'

/** DELETE needs the same local write authorization as POST/PATCH: a one-time or
 * unverified local key is refused before any request is sent, so a batch delete
 * can never report a partial success caused by a key Zotero already spent. */
function assertDeletableLocalKey(profile: AdapterProfile): void {
  assertWritableLocalKey(profile)
}

/**
 * Delete Zotero items, one request per item, in request order.
 *
 * The calls are deliberately sequential: deletion is destructive, the local
 * API is rate limited, and a per-item receipt is only meaningful if one failed
 * request cannot silently race the next one.  A transport failure is reported
 * as `unavailable` for that key instead of aborting the batch, so every
 * requested key always gets an honest outcome.
 */
export async function deleteZoteroRemoteItems(
  profile: AdapterProfile,
  targets: readonly ZoteroDeleteTarget[],
  fetcher: FetchLike = fetch
): Promise<{ outcomes: ZoteroDeleteOutcome[]; serverId: string | null }> {
  if (targets.length === 0) throw new IntegrationRuntimeError('INVALID_MAPPING', '至少选择一个 Zotero 条目后再请求删除。')
  if (targets.length > 100) throw new IntegrationRuntimeError('INVALID_MAPPING', '单次最多删除 100 个 Zotero 条目。')
  for (const target of targets) {
    if (!target.itemKey.trim()) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Zotero 条目 key 无效。')
    if (!target.remoteRevision.trim()) throw new IntegrationRuntimeError('REVISION_CONFLICT', 'Zotero 删除需要对象版本；请重新预览。')
  }
  if (!hasCredential(profile)) throw new IntegrationRuntimeError('AUTH_REQUIRED', ZOTERO_DELETE_BLOCKED_MESSAGE)
  assertDeletableLocalKey(profile)
  let serverId: string | null = null
  try {
    serverId = await serverIdForRequest(profile, fetcher)
    if (isLoopbackLocation(profile) && !serverId && !configuredServerId(profile)) {
      throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', 'Zotero Local API 未提供 server id，暂不支持删除。')
    }
  } catch (error) {
    mapCollectionTransportError(error)
  }
  const outcomes: ZoteroDeleteOutcome[] = []
  for (const target of targets) {
    outcomes.push(await deleteOneZoteroItem(profile, target, serverId, fetcher))
  }
  return { outcomes, serverId }
}

async function deleteOneZoteroItem(
  profile: AdapterProfile,
  target: ZoteroDeleteTarget,
  serverId: string | null,
  fetcher: FetchLike
): Promise<ZoteroDeleteOutcome> {
  const itemKey = target.itemKey.trim()
  try {
    const requestHeaders = headers(profile, serverId)
    requestHeaders.set('If-Unmodified-Since-Version', target.remoteRevision.trim())
    const response = await fetcher(endpoint(profile, `items/${encodeURIComponent(itemKey)}`), {
      method: 'DELETE',
      headers: requestHeaders,
      signal: AbortSignal.timeout(20_000)
    })
    const remoteVersion = response.headers.get('Last-Modified-Version')?.trim() || null
    if (response.status === 204 || response.status === 200) {
      return { itemKey, status: 'deleted', remoteVersion, message: 'Zotero 已永久删除该条目。', retryable: false }
    }
    if (response.status === 404) {
      return { itemKey, status: 'absent', remoteVersion, message: ZOTERO_DELETE_ABSENT_MESSAGE, retryable: false }
    }
    const detail = await errorBody(response)
    if (response.status === 412 || response.status === 428) {
      return { itemKey, status: 'conflict', remoteVersion, message: preconditionMessage(detail) || ZOTERO_DELETE_CONFLICT_MESSAGE, retryable: true }
    }
    if (response.status === 401) {
      return { itemKey, status: 'unauthorized', remoteVersion, message: authErrorMessage(detail), retryable: true }
    }
    if (response.status === 403) {
      return { itemKey, status: 'forbidden', remoteVersion, message: permissionDeniedMessage(detail), retryable: false }
    }
    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get('Retry-After') ?? '', 10)
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? `请在 ${retryAfter} 秒后重试。` : '请稍后重试。'
      return { itemKey, status: 'rate-limited', remoteVersion, message: `Zotero 请求过于频繁。${wait}`, retryable: true }
    }
    return {
      itemKey,
      status: 'unavailable',
      remoteVersion,
      message: detail ? `${ZOTERO_DELETE_UNAVAILABLE_MESSAGE}（Zotero 返回 ${response.status}：${detail}）` : `${ZOTERO_DELETE_UNAVAILABLE_MESSAGE}（Zotero 返回 ${response.status}）`,
      retryable: true
    }
  } catch (error) {
    const message = getZoteroIntegrationError(error)?.message ?? (error instanceof Error ? error.message : '未知错误')
    return { itemKey, status: 'unavailable', remoteVersion: null, message: `${ZOTERO_DELETE_UNAVAILABLE_MESSAGE}（${message}）`, retryable: true }
  }
}

/** True only when the remote library is known not to hold the item any more, so
 * the Workbench projection may be removed. */
export function zoteroDeleteRemovedRemotely(status: ZoteroDeleteOutcomeStatus): boolean {
  return status === 'deleted' || status === 'absent'
}

export interface ZoteroRemoteItemSnapshot {
  readonly itemKey: string
  /** The remote revision the caller must freeze and send back as the delete
   * precondition.  Never invented: it is Zotero's own `version` field. */
  readonly version: string
  readonly title: string | null
}

/**
 * Read the current revision of explicit Zotero items, one request per key.
 *
 * This is the read half of the two-sided delete preview: it is what makes the
 * confirmation step bind to a real version instead of to whatever the Renderer
 * had cached.  A key that cannot be read is reported with its real reason rather
 * than dropped, so a preview can never silently shrink the user's selection.
 */
export async function readZoteroRemoteItems(
  profile: AdapterProfile,
  itemKeys: readonly string[],
  fetcher: FetchLike = fetch
): Promise<{ items: ZoteroRemoteItemSnapshot[]; unavailable: Array<{ itemKey: string; message: string }> }> {
  const items: ZoteroRemoteItemSnapshot[] = []
  const unavailable: Array<{ itemKey: string; message: string }> = []
  let serverId: string | null = null
  try {
    serverId = await serverIdForRequest(profile, fetcher)
  } catch (error) {
    mapCollectionTransportError(error)
  }
  for (const value of itemKeys) {
    const itemKey = value.trim()
    if (!itemKey) continue
    try {
      const response = await fetcher(endpoint(profile, `items/${encodeURIComponent(itemKey)}`), {
        headers: headers(profile, serverId),
        signal: AbortSignal.timeout(20_000)
      })
      if (!response.ok) {
        const detail = await errorBody(response)
        unavailable.push({
          itemKey,
          message: response.status === 404
            ? 'Zotero 远端已不存在该条目。'
            : `无法读取 Zotero 条目（Zotero 返回 ${response.status}${detail ? `：${detail}` : ''}）。`
        })
        continue
      }
      const payload = await readJson(response, 'zotero.item.read')
      const record = asRecord(payload)
      const rawVersion = record?.['version']
      const version = optionalInteger(rawVersion)
      if (record === null || version === null) {
        unavailable.push({ itemKey, message: 'Zotero item 响应缺少 revision，无法冻结删除版本。' })
        continue
      }
      const data = asRecord(record['data'])
      const title = typeof data?.['title'] === 'string' && data['title'].trim() ? data['title'].trim() : null
      items.push({ itemKey, version: String(version), title })
    } catch (error) {
      const message = getZoteroIntegrationError(error)?.message ?? (error instanceof Error ? error.message : '未知错误')
      unavailable.push({ itemKey, message: `无法读取 Zotero 条目：${message}` })
    }
  }
  return { items, unavailable }
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

function mapHttpError(response: Response, detail = ''): never {
  if (response.status === 401) throw new IntegrationRuntimeError('AUTH_REQUIRED', authErrorMessage(detail))
  if (response.status === 403) throw new IntegrationRuntimeError('PERMISSION_DENIED', permissionDeniedMessage(detail))
  if (response.status === 404) throw new IntegrationRuntimeError('NOT_FOUND', 'Zotero 对象不存在')
  if (response.status === 413) throw new IntegrationRuntimeError('INVALID_MAPPING', detail || `Zotero 单次写入最多 ${MAX_WRITE_OBJECTS} 个条目，请分批导入。`)
  if (response.status === 409 || response.status === 412 || response.status === 428) {
    throw new IntegrationRuntimeError('REVISION_CONFLICT', preconditionMessage(detail))
  }
  if (response.status === 429) throw new IntegrationRuntimeError('RATE_LIMITED', detail ? `Zotero 请求过于频繁：${detail}` : 'Zotero 请求过于频繁')
  throw new IntegrationRuntimeError('TEMPORARILY_UNAVAILABLE', detail ? `Zotero 请求失败（${response.status}）：${detail}` : `Zotero 请求失败（${response.status}）`)
}

/**
 * Zotero's Local API explains failed writes with a short plain-text reason and
 * the Web API answers with JSON.  Reading it lets the caller report the real
 * cause (a consumed one-time local key, a missing `Zotero-Server-ID`, a replayed
 * write token) instead of a generic "version conflict".
 */
async function errorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim()
    return text.replace(/\s+/gu, ' ').slice(0, 300)
  } catch {
    return ''
  }
}

/** Map a 401/403 into the reason the user has to act on.  Zotero requires a
 * local key for writes, and a one-time key is consumed by the first write that
 * validates it, which makes "authorize again with Always Allow" the only
 * durable recovery. */
function authErrorMessage(detail: string): string {
  const lowered = detail.toLocaleLowerCase('en-US')
  if (lowered.includes('invalid or expired')) {
    return 'Zotero 本地写入密钥已失效：一次性授权（Allow）的密钥会在第一次成功写入后被 Zotero 消耗，之后的写入都会返回 401。请重新请求 Zotero 写入权限，并在 Zotero 弹窗中选择「始终允许（Always Allow）」。'
  }
  if (lowered.includes('api key required')) {
    return 'Zotero 尚未授权本地写入：Local API 的写请求必须先取得本地密钥。请点击「请求 Zotero 写入权限」，并在 Zotero 弹窗中选择「始终允许（Always Allow）」。'
  }
  return detail ? `Zotero 需要授权：${detail}` : 'Zotero 需要授权'
}

function permissionDeniedMessage(detail: string): string {
  const lowered = detail.toLocaleLowerCase('en-US')
  if (lowered.includes('denied')) {
    return 'Zotero 授权弹窗中选择了「拒绝」：本次没有获得写入权限。请重新请求 Zotero 写入权限，并在弹窗中选择「始终允许（Always Allow）」。'
  }
  return detail ? `Zotero 权限不足：${detail}` : 'Zotero 权限不足'
}

/** 412/428/409 are precondition failures.  The Local API uses them for the
 * Server-ID handshake and the write token as well, so the body decides. */
function preconditionMessage(detail: string): string {
  const lowered = detail.toLocaleLowerCase('en-US')
  if (lowered.includes('zotero-server-id not provided')) return 'Zotero 写入缺少 Zotero-Server-ID：该连接无法完成本机写入握手，请确认 Zotero 版本并重新探测。'
  if (lowered.includes('server-id does not match')) return 'Zotero-Server-ID 与当前 Zotero 实例不一致：请确认 Zotero 未更换数据目录或版本，然后重新探测。'
  if (lowered.includes('write token')) return 'Zotero 写入令牌已被使用：请重新生成预览后再导入。'
  if (lowered.includes('if-unmodified-since-version not provided')) return 'Zotero 写入缺少对象版本：请先刷新该条目再重新导入。'
  if (lowered.includes('has been modified since specified version') || lowered.includes('version mismatch')) return 'Zotero 条目已在外部更新，本地版本已过期：请刷新该条目并重新生成预览。'
  return detail ? `Zotero 写前置条件失败：${detail}` : 'Zotero 写前置条件失败'
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

/** Only a non-empty, explicitly selected collection key may be written. */
function normalizedCollectionKey(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Union of the remote item's current tags and the Workbench tags.  Order is
 * stable (remote first) so a repeated PATCH is idempotent. */
function mergeZoteroTags(remoteTags: unknown, projectionTags: readonly string[]): string[] {
  const merged = new Set<string>()
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) merged.add(value.trim())
  }
  if (Array.isArray(remoteTags)) {
    for (const tag of remoteTags) {
      if (tag && typeof tag === 'object') push((tag as Record<string, unknown>)['tag'])
      else push(tag)
    }
  }
  for (const tag of projectionTags) push(tag)
  return [...merged]
}

/** Persistence mode of the stored local key.  Zotero's authorization dialog
 * offers a one-time "Allow" and a persistent "Always Allow"; only the latter can
 * carry a multi-item import. */
function localKeyMode(profile: AdapterProfile): 'persistent' | 'single-use' | 'unknown' {
  const value = profile.settings['zoteroLocalKeyPersistent']
  return value === true ? 'persistent' : value === false ? 'single-use' : 'unknown'
}

export interface ZoteroWriteAuthorizationCheck {
  readonly authorized: boolean
  readonly reason: AdapterWriteBlockedReason | null
  readonly message: string
  readonly retryAfterSeconds: number | null
}

const SINGLE_USE_KEY_MESSAGE = 'Zotero 本地写入密钥是一次性授权（Allow）：Zotero 会在第一次成功写入后消耗该密钥，多条目导入必然中途失败。请重新请求 Zotero 写入权限，并在 Zotero 弹窗中选择「始终允许（Always Allow）」。'
const UNVERIFIED_KEY_MESSAGE = '无法确认已保存的 Zotero 本地写入密钥是否可重复使用（它由旧版本保存，未记录授权方式）。请重新请求 Zotero 写入权限，并在 Zotero 弹窗中选择「始终允许（Always Allow）」。'
const VERIFIED_KEY_MESSAGE = 'Zotero 本机写入权限有效。'

const WRITE_BLOCKED_MESSAGES: Record<AdapterWriteBlockedReason, string> = {
  'server-id-missing': 'Zotero Local API 未返回 Zotero-Server-ID（Zotero 9 或更早版本不支持本机写入授权），无法完成写入握手。',
  'credential-missing': '尚未请求 Zotero 本机写入权限。',
  'probe-failed': '无法验证 Zotero 写入权限，请检查连接后重试。',
  'key-single-use': SINGLE_USE_KEY_MESSAGE,
  'key-unverified': UNVERIFIED_KEY_MESSAGE,
  'key-invalid': authErrorMessage('Invalid or expired API key'),
  'authorization-denied': permissionDeniedMessage('denied'),
  'rate-limited': 'Zotero 授权请求过于频繁（每 60 秒最多 5 次），请在 60 秒后重试。'
}

/** Single user-facing explanation for a read-only Zotero connection, shared by
 * the capability surface and the write gate so both report the same cause. */
export function zoteroWriteBlockedMessage(reason: AdapterWriteBlockedReason | null | undefined): string {
  return reason === null || reason === undefined ? 'Zotero 未获得写入权限。' : WRITE_BLOCKED_MESSAGES[reason]
}

/**
 * Prove that the stored local write key is still usable *without* changing
 * anything in the user's Zotero library.
 *
 * Zotero's Local API authenticates a write request before it parses the body,
 * so `POST <library>/items` with an empty array is answered with
 * `400 No items provided` only once the key has been accepted.  That makes the
 * empty array a zero-object authorization check: nothing is created, updated
 * or deleted, no remote identifier is returned, and the key itself is never
 * echoed back to the caller.
 *
 * The check must only be run for keys whose persistence mode is known, because
 * Zotero consumes a one-time key as soon as any write validates it.
 */
export async function verifyZoteroWriteAuthorization(
  profile: AdapterProfile,
  fetcher: FetchLike = fetch,
  knownServerId: string | null = null
): Promise<ZoteroWriteAuthorizationCheck> {
  if (!isLoopbackLocation(profile)) {
    // The Web API exposes no zero-effect authorization check; its key is
    // validated by the first real write, which reports its own failure.
    return { authorized: true, reason: null, message: 'Zotero Web API 写入权限在首次写入时校验。', retryAfterSeconds: null }
  }
  try {
    const serverId = knownServerId ?? await serverIdForRequest(profile, fetcher)
    if (!serverId && !configuredServerId(profile)) {
      return { authorized: false, reason: 'server-id-missing', message: 'Zotero Local API 未返回 Zotero-Server-ID，无法完成本机写入握手。', retryAfterSeconds: null }
    }
    if (!hasCredential(profile)) {
      return { authorized: false, reason: 'credential-missing', message: '尚未请求 Zotero 本机写入权限。', retryAfterSeconds: null }
    }
    const mode = localKeyMode(profile)
    if (mode === 'single-use') return { authorized: false, reason: 'key-single-use', message: SINGLE_USE_KEY_MESSAGE, retryAfterSeconds: null }
    if (mode === 'unknown') return { authorized: false, reason: 'key-unverified', message: UNVERIFIED_KEY_MESSAGE, retryAfterSeconds: null }
    const requestHeaders = headers(profile, serverId)
    requestHeaders.set('Content-Type', 'application/json')
    const response = await fetcher(endpoint(profile, 'items'), {
      method: 'POST',
      headers: requestHeaders,
      body: '[]',
      signal: AbortSignal.timeout(15_000)
    })
    if (response.ok) return { authorized: true, reason: null, message: VERIFIED_KEY_MESSAGE, retryAfterSeconds: null }
    const detail = await errorBody(response)
    const lowered = detail.toLocaleLowerCase('en-US')
    if (response.status === 400 && lowered.includes('no items provided')) {
      return { authorized: true, reason: null, message: VERIFIED_KEY_MESSAGE, retryAfterSeconds: null }
    }
    if (response.status === 401) {
      return { authorized: false, reason: 'key-invalid', message: authErrorMessage(detail), retryAfterSeconds: null }
    }
    if (response.status === 403) {
      return { authorized: false, reason: 'authorization-denied', message: permissionDeniedMessage(detail), retryAfterSeconds: null }
    }
    if (response.status === 428) {
      return { authorized: false, reason: 'server-id-missing', message: preconditionMessage(detail), retryAfterSeconds: null }
    }
    if (response.status === 412) {
      return { authorized: false, reason: 'server-id-missing', message: preconditionMessage(detail), retryAfterSeconds: null }
    }
    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get('Retry-After') ?? '', 10)
      return {
        authorized: false,
        reason: 'rate-limited',
        message: `Zotero 授权请求过于频繁（每 60 秒最多 5 次）${Number.isFinite(retryAfter) && retryAfter > 0 ? `，请在 ${retryAfter} 秒后重试。` : '，请稍后重试。'}`,
        retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null
      }
    }
    return { authorized: false, reason: 'probe-failed', message: detail ? `无法验证 Zotero 写入权限（${response.status}）：${detail}` : `无法验证 Zotero 写入权限（${response.status}）`, retryAfterSeconds: null }
  } catch (error) {
    if (error instanceof IntegrationRuntimeError) {
      return { authorized: false, reason: error.code === 'NOT_CONNECTED' ? 'probe-failed' : 'probe-failed', message: error.message, retryAfterSeconds: null }
    }
    return { authorized: false, reason: 'probe-failed', message: '无法验证 Zotero 写入权限，请稍后重试。', retryAfterSeconds: null }
  }
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
    // A loopback Local API without `Zotero-Server-ID` (Zotero 9) can never
    // complete the local write handshake, and a one-time local key cannot
    // survive a multi-item import.  Both are reported as explicit read-only
    // causes instead of a write that is advertised and then fails.
    const writeCheck: ZoteroWriteAuthorizationCheck = local
      ? !serverId && !configuredServerId(profile)
        ? { authorized: false, reason: 'server-id-missing', message: 'Zotero Local API 未返回 Zotero-Server-ID（Zotero 9 或更早版本不支持本机写入授权）。', retryAfterSeconds: null }
        : hasCredential(profile)
          ? await verifyZoteroWriteAuthorization(profile, fetcher, serverId)
          : { authorized: false, reason: 'credential-missing', message: 'Zotero Local API 只读连接正常，尚未请求本机写入权限。', retryAfterSeconds: null }
      : hasCredential(profile)
        ? { authorized: true, reason: null, message: 'Zotero Web API 写入权限在首次写入时校验。', retryAfterSeconds: null }
        : { authorized: false, reason: 'credential-missing', message: 'Zotero API 已连接，但写入需要 API key。', retryAfterSeconds: null }
    const write = writeCheck.authorized
    const writeBlockedReason: AdapterWriteBlockedReason | null = write ? null : writeCheck.reason ?? 'probe-failed'
    return {
      ok: true,
      writeBlockedReason,
      message: write
        ? 'Zotero API 已连接，可执行受 revision 保护的写入。'
        : writeCheck.message,
      capabilities: { read: true, write, attachments: 'link_only', incremental: true }
    }
  } catch (error) {
    return {
      ok: false,
      writeBlockedReason: 'probe-failed',
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

/**
 * Refuse a local write that cannot succeed.  Zotero consumes a one-time local
 * key (`remember:false`) on the first write that validates it, so accepting one
 * here would produce exactly the partial import this guard prevents.  The write
 * paths therefore require a *persistent* local key; the persistence mode is
 * recorded when the user answers Zotero's authorization dialog.
 */
function assertWritableLocalKey(profile: AdapterProfile): void {
  if (!isLoopbackLocation(profile)) return
  const mode = localKeyMode(profile)
  if (mode === 'persistent') return
  throw new IntegrationRuntimeError('AUTH_REQUIRED', mode === 'single-use' ? SINGLE_USE_KEY_MESSAGE : UNVERIFIED_KEY_MESSAGE)
}

export async function writeZoteroProjection(
  profile: AdapterProfile,
  target: ProjectionTarget,
  projection: ManagedProjection,
  fetcher: FetchLike = fetch
): Promise<ProjectionReceipt> {
  if (!hasCredential(profile)) throw new IntegrationRuntimeError('AUTH_REQUIRED', 'Zotero 写入需要 API key')
  assertWritableLocalKey(profile)
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
    // Zotero fields are shared with the user.  A confirmed Workbench update
    // may fill metadata the remote item is still missing, but it must never
    // overwrite a non-empty remote value (title, DOI, URL, abstract, venue,
    // date) that the user may have curated inside Zotero.
    const metadataPatch: Record<string, string> = {}
    const metadataCandidates: Array<[string, string]> = [
      ['title', projection.title],
      ['DOI', projection.doi ?? ''],
      ['url', projection.url ?? ''],
      ['abstractNote', projection.abstract ?? ''],
      ['publicationTitle', projection.venue ?? ''],
      ['date', projection.year === null || projection.year === undefined ? '' : String(projection.year)]
    ]
    for (const [field, value] of metadataCandidates) {
      const remote = currentData[field]
      if (typeof remote === 'string' && remote.trim()) continue
      if (!value.trim()) continue
      metadataPatch[field] = value
    }
    // Tags are merged instead of replaced so a Workbench write can add the
    // project/`#未分类` tag without deleting the user's own Zotero tags.
    const mergedTags = mergeZoteroTags(currentData['tags'], projection.tags)
    const collectionKey = normalizedCollectionKey(target.collectionKey)
    const response = await fetcher(url, {
      method: 'PATCH',
      headers: new Headers({
        ...Object.fromEntries(headers(profile, serverId).entries()),
        'Content-Type': 'application/json',
        'If-Unmodified-Since-Version': target.remoteRevision
      }),
      body: JSON.stringify({
        ...metadataPatch,
        extra: upsertManagedExtra(currentExtra, projection),
        tags: mergedTags.map((tag) => ({ tag })),
        // Only an explicitly selected collection key is written.  Omitting
        // `collections` keeps the remote membership untouched instead of
        // restoring a stale locally cached value.
        ...(collectionKey === null ? {} : { collections: [collectionKey] })
      }),
      signal: AbortSignal.timeout(20_000)
    })
    if (!response.ok) mapHttpError(response, await errorBody(response))
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
  assertWritableLocalKey(profile)
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
    if (!response.ok) mapHttpError(response, await errorBody(response))
    const payload: unknown = await readJson(response, 'zotero.item.create')
    const record = asRecord(payload)
    if (record === null) throw integrationFailure('zotero.item.create', [], 'invalid_type', 'Zotero create 响应格式无效。')
    const failed = asRecord(record['failed'])?.['0']
    if (failed !== undefined) {
      // Zotero reports per-object validation failures inside a 200 response.
      // Surface its own message so the user can see which field was rejected
      // instead of a generic "Zotero refused the item".
      const failure = asRecord(failed)
      const remoteMessage = failure === null
        ? ''
        : typeof failure['message'] === 'string'
          ? failure['message'].trim()
          : ''
      throw integrationFailure('zotero.item.create', ['failed', 0], 'remote_rejected', remoteMessage ? `Zotero 拒绝创建条目：${remoteMessage}` : 'Zotero 拒绝创建条目。')
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
