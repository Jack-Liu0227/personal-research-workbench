import {
  customProviderUrlIssue,
  type AgentCustomProviderApi,
  type AgentCustomProviderModel
} from '@prw/contracts'

/**
 * Model discovery for a user-added provider.
 *
 * The workbench used to ask a user to type model ids by hand into a
 * `models.json` editor, which is guesswork: nothing in the app knew whether an
 * endpoint served `gpt-5.1` or `claude-sonnet-5`. This module asks the endpoint
 * itself, over the same wire protocol the provider is configured with, and
 * returns the answer as candidates. It is a *read*: nothing here writes to
 * `models.json`, SQLite, the ledger or a log, and the caller decides what the
 * user keeps.
 *
 * Three properties are load-bearing:
 *
 *  - the API key arrives as an argument, is only ever placed into a request
 *    header, and is never echoed. Failures carry a status code, the provider id
 *    and an actionable hint — never a response body, never a request URL with a
 *    query, never the key;
 *  - the request is bounded in every direction: a strict URL policy (shared
 *    with the form so both agree), `redirect: 'error'` so a redirect cannot
 *    forward a key to a host the user never configured, a wall-clock timeout, a
 *    body size ceiling and a model-count ceiling;
 *  - cancellation is the caller's business. The probe takes an `AbortSignal`
 *    and treats it as cancellation, which is what makes closing the dialog stop
 *    the request instead of leaving it running.
 *
 * This file must stay dependency-light: it is part of `@prw/agent-runtime`,
 * which never imports `zod` (contracts are validated at the boundaries, and
 * this module is not one). Nothing here is written to disk, so `models.json`
 * keeps its existing location and format.
 */

/** Wall-clock budget for one probe, including reading the body. */
export const PROVIDER_DISCOVERY_TIMEOUT_MS = 15_000

/** Hard ceiling on adopted model rows, matching `AgentCustomProviderModelSchema`
 * array bound in `models.json`. A listing that reports more is truncated and
 * says so instead of producing a file the schema would reject. */
export const PROVIDER_DISCOVERY_MAX_MODELS = 200

/** Anthropic rejects a messages/models request that carries no wire version. */
const ANTHROPIC_VERSION = '2023-06-01'

/** Largest response this probe is willing to read. A model listing is small;
 * anything larger is not one, and buffering it would only waste memory. */
const MAX_RESPONSE_CHARS = 512 * 1024

/** Longest model id that can be stored in `models.json`. */
const MAX_MODEL_ID_LENGTH = 200

/**
 * Why one probe failed.
 *
 * These are deliberately coarse and code-based rather than free text: the
 * renderer shows a Chinese sentence built from the code, and the code is what a
 * test asserts on.
 */
export type ProviderDiscoveryCode =
  | 'INVALID_ENDPOINT'
  | 'MISSING_CREDENTIAL'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'UNREACHABLE'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'

/**
 * A refusal or a transport failure that is safe to show.
 *
 * `name` is `VALIDATION_FAILED` because `normalizeAppError` in
 * `@prw/workspace-service` keeps the real message for that name and replaces an
 * unnamed error with a generic internal failure. The message therefore has to be
 * written as if the user will read it — because they will — and must contain no
 * credential, no response body and no query string.
 */
export class ProviderDiscoveryError extends Error {
  readonly code: ProviderDiscoveryCode

  constructor(code: ProviderDiscoveryCode, message: string) {
    super(message)
    this.name = 'VALIDATION_FAILED'
    this.code = code
  }
}

export interface ProviderDiscoveryRequest {
  /** Provider id the key belongs to. Used for lookup and for the message. */
  readonly provider: string
  readonly baseUrl: string
  readonly api: AgentCustomProviderApi
  /** Key resolved by Electron Main from `safeStorage` for exactly this provider,
   * or `null` when the user has not saved one. */
  readonly apiKey: string | null
  /** Caller cancellation (a closed dialog, a navigation). */
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
  /** Injection seam for tests; the global `fetch` in production. */
  readonly fetcher?: typeof fetch | undefined
}

export interface ProviderDiscoveryOutcome {
  readonly models: readonly AgentCustomProviderModel[]
  /** Non-fatal, redaction-safe note such as a truncated listing. */
  readonly notice: string | null
  readonly discoveredAt: string
}

/**
 * Ask one endpoint which models it advertises.
 *
 * Rejects with `ProviderDiscoveryError` (or an `AbortError` when the caller
 * canceled) instead of returning a partial result: an empty list is a real
 * answer, so a failure must not be indistinguishable from one.
 */
export async function discoverProviderModels(request: ProviderDiscoveryRequest): Promise<ProviderDiscoveryOutcome> {
  const provider = request.provider.trim()
  const baseUrl = request.baseUrl.trim()
  const baseIssue = customProviderUrlIssue(baseUrl)
  if (baseIssue) throw new ProviderDiscoveryError('INVALID_ENDPOINT', baseIssue)

  const endpoint = discoveryEndpoint(baseUrl)
  const endpointIssue = customProviderUrlIssue(endpoint)
  if (endpointIssue) throw new ProviderDiscoveryError('INVALID_ENDPOINT', endpointIssue)

  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    // `customProviderUrlIssue` already parsed the value, so this is defensive
    // only: the message must stay actionable even in the impossible branch.
    throw new ProviderDiscoveryError('INVALID_ENDPOINT', '模型地址必须是有效的绝对 URL。')
  }

  const apiKey = normalizeApiKey(request.apiKey)
  // A remote endpoint is only reachable with a stored key: sending an
  // unauthenticated request would either leak the fact that the endpoint exists
  // or produce a misleading 401 that looks like a bad key. Loopback is the
  // exception because a local server (Ollama, LM Studio, vLLM) legitimately has
  // no key.
  if (apiKey === null && !isLoopback(url.hostname)) {
    throw new ProviderDiscoveryError(
      'MISSING_CREDENTIAL',
      `请先为 "${provider}" 保存 API Key：远程端点只有在 safeStorage 中存有密钥时才会被探测。`
    )
  }

  const timeoutMs = positiveOr(request.timeoutMs, PROVIDER_DISCOVERY_TIMEOUT_MS)
  const fetcher = request.fetcher ?? fetch
  if (request.signal?.aborted === true) {
    const canceled = new Error(`已取消对 "${provider}" 的模型发现请求。`)
    canceled.name = 'AbortError'
    throw canceled
  }
  const controller = new AbortController()
  let timedOut = false
  let canceled = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const cancel = (): void => {
    canceled = true
    controller.abort()
  }
  request.signal?.addEventListener('abort', cancel, { once: true })

  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers: discoveryHeaders(request.api, apiKey),
      // A redirect could hand the key to a host the user never configured.
      redirect: 'error',
      signal: controller.signal
    })
    if (!response.ok) throw httpFailure(response.status, provider)
    const payload = parseJson(await readBoundedText(response), provider)
    const read = readModelList(request.api, payload)
    const models = read.models.slice(0, PROVIDER_DISCOVERY_MAX_MODELS)
    const truncated = read.models.length > models.length
    return {
      models,
      notice: truncated
        ? `端点返回 ${read.models.length} 个模型，只保留前 ${PROVIDER_DISCOVERY_MAX_MODELS} 个；models.json 每个 Provider 最多存放 ${PROVIDER_DISCOVERY_MAX_MODELS} 个模型。`
        : null,
      discoveredAt: new Date().toISOString()
    }
  } catch (error) {
    if (error instanceof ProviderDiscoveryError) throw error
    throw transportFailure(error, { timedOut, canceled, provider, timeoutMs })
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', cancel)
  }
}

/**
 * The model-listing endpoint of a provider.
 *
 * All four supported protocols expose the listing at `<baseUrl>/models`, so the
 * path is not per-protocol; only the auth header and the payload shape differ.
 * The stored `baseUrl` is what a user copied from the provider's own docs, so it
 * already includes any `/v1` or `/v1beta` segment.
 */
export function discoveryEndpoint(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/u, '')}/models`
}

/**
 * Auth headers for one protocol.
 *
 * Pi's own provider definitions use these same three schemes, so a key that
 * works for a run also works for discovery. Nothing else is sent: a key must not
 * travel in a URL, and a body is never built.
 */
export function discoveryHeaders(api: AgentCustomProviderApi, apiKey: string | null): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (apiKey === null) return headers
  if (api === 'anthropic-messages') {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = ANTHROPIC_VERSION
    return headers
  }
  if (api === 'google-generative-ai') {
    headers['x-goog-api-key'] = apiKey
    return headers
  }
  headers.authorization = `Bearer ${apiKey}`
  return headers
}

/** A stored key is used verbatim except for surrounding whitespace, which is
 * something a copy-paste adds and a header would reject. */
function normalizeApiKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length === 0 ? null : trimmed
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLocaleLowerCase('en-US').replace(/^\[|\]$/gu, '')
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1'
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function httpFailure(status: number, provider: string): ProviderDiscoveryError {
  if (status === 401 || status === 403) {
    return new ProviderDiscoveryError('UNAUTHORIZED', `"${provider}" 拒绝了这次请求（HTTP ${status}）：请确认 API Key 有效，并且有权列出模型。`)
  }
  if (status === 404 || status === 405) {
    return new ProviderDiscoveryError('NOT_FOUND', `"${provider}" 在该地址没有模型列表接口（HTTP ${status}）：请确认接口协议与 Base URL 的最后一段路径匹配。`)
  }
  if (status === 429) {
    return new ProviderDiscoveryError('RATE_LIMITED', `"${provider}" 返回 HTTP 429：请求过于频繁，请稍后重试。`)
  }
  if (status >= 500) {
    return new ProviderDiscoveryError('UNREACHABLE', `"${provider}" 返回 HTTP ${status}：服务端暂时不可用，请稍后重试。`)
  }
  return new ProviderDiscoveryError('INVALID_RESPONSE', `"${provider}" 返回 HTTP ${status}，无法读取模型列表。`)
}

/**
 * Turn a transport failure into a message the user can act on.
 *
 * Only the provider id, a whitelisted errno-style code and the timeout budget
 * are echoed. The underlying `TypeError: fetch failed` is discarded on purpose:
 * its message and cause chain can carry the request URL, and this value is
 * serialized back to the renderer.
 */
function transportFailure(
  error: unknown,
  context: { readonly timedOut: boolean; readonly canceled: boolean; readonly provider: string; readonly timeoutMs: number }
): Error {
  if (context.canceled || (error instanceof Error && error.name === 'AbortError' && !context.timedOut)) {
    const canceled = new Error(`已取消对 "${context.provider}" 的模型发现请求。`)
    // `normalizeAppError` maps `AbortError` to `OPERATION_CANCELED`, which is
    // the honest code for a user-initiated stop.
    canceled.name = 'AbortError'
    return canceled
  }
  if (context.timedOut) {
    return new ProviderDiscoveryError('TIMEOUT', `请求 "${context.provider}" 超过 ${Math.max(1, Math.round(context.timeoutMs / 1000))} 秒未完成：请检查服务地址与网络后重试。`)
  }
  const code = syscallCode(error)
  return new ProviderDiscoveryError(
    'UNREACHABLE',
    code === null
      ? `无法连接 "${context.provider}"：请确认服务地址可达、证书有效。`
      : `无法连接 "${context.provider}"（${code}）：请确认服务地址可达、证书有效。`
  )
}

/** One `code` field of a Node network error, if it looks like one. */
function syscallCode(error: unknown): string | null {
  const code = (error as { readonly code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,30}$/u.test(code) ? code : null
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_CHARS) {
    throw new ProviderDiscoveryError('INVALID_RESPONSE', '模型列表响应过大，已拒绝解析。')
  }
  const text = await response.text()
  if (text.length > MAX_RESPONSE_CHARS) {
    throw new ProviderDiscoveryError('INVALID_RESPONSE', '模型列表响应过大，已拒绝解析。')
  }
  return text
}

function parseJson(text: string, provider: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    // The body is never included: it is provider output of unknown content.
    throw new ProviderDiscoveryError('INVALID_RESPONSE', `"${provider}" 的响应不是有效 JSON，无法读取模型列表。`)
  }
}

/** Protocol-specific payload reader. `data[]` for the OpenAI and Anthropic
 * listing shapes, `models[]` for Google's. */
function readModelList(api: AgentCustomProviderApi, payload: unknown): { readonly models: AgentCustomProviderModel[] } {
  if (!isRecord(payload)) return { models: [] }
  const entries = api === 'google-generative-ai' ? payload['models'] : payload['data']
  if (!Array.isArray(entries)) return { models: [] }
  const models: AgentCustomProviderModel[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const model = api === 'google-generative-ai' ? googleModel(entry) : listingModel(entry)
    if (model === null || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return { models }
}

function listingModel(entry: Record<string, unknown>): AgentCustomProviderModel | null {
  const id = readId(entry['id'])
  if (id === null) return null
  // Anthropic lists `display_name`; OpenAI-compatible servers usually have no
  // label at all, and an empty label is a valid state the form falls back to
  // the id for.
  const label = readLabel(entry['display_name']) ?? readLabel(entry['name']) ?? ''
  return { id, name: label === id ? '' : label, reasoning: false, contextWindow: null, maxTokens: null }
}

function googleModel(entry: Record<string, unknown>): AgentCustomProviderModel | null {
  // Google's listing returns resource names such as `models/gemini-2.5-pro`,
  // while the wire protocol takes the bare id.
  const raw = readId(entry['name']) ?? readId(entry['id'])
  if (raw === null) return null
  const id = raw.startsWith('models/') ? raw.slice('models/'.length) : raw
  if (id.length === 0) return null
  return {
    id,
    name: readLabel(entry['displayName']) ?? '',
    reasoning: false,
    // Google is the one protocol that reports real token budgets; other
    // listings omit them, and `null` means "let Pi use its default".
    contextWindow: readTokenLimit(entry['inputTokenLimit']),
    maxTokens: readTokenLimit(entry['outputTokenLimit'])
  }
}

/** One stored model id, or `null` when the value cannot be stored safely.
 * Control characters are refused rather than stripped: `"a\nb"` and `"ab"` must
 * not silently become the same provider entry. */
function readId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (/[\u0000-\u001f\u007f]/u.test(value)) return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_MODEL_ID_LENGTH) return null
  return trimmed
}

function readLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, '').trim()
  return cleaned.length === 0 ? null : cleaned.slice(0, 200)
}

function readTokenLimit(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 10_000_000) return null
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
