import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AGENT_CUSTOM_PROVIDER_APIS,
  customProviderIdIssue,
  customProviderUrlIssue,
  type AgentCustomProvider,
  type AgentCustomProviderApi,
  type AgentCustomProviderModel
} from '@prw/contracts'

/**
 * The app-owned `models.json`.
 *
 * Pi reads user-defined providers from `join(getAgentDir(), "models.json")`, and
 * this app pins `PI_CODING_AGENT_DIR` to its own profile directory, so writing
 * this file *is* how a custom provider becomes visible to the embedded SDK.
 * Keeping Pi's own format means the vocabulary in Settings and in a hand edit
 * are the same thing, and the file stays usable by any other Pi client.
 *
 * Two properties matter more than the format:
 *
 *  - the file is re-read before every write and merged. Keys this app does not
 *    model (`headers`, `compat`, `modelOverrides`, an `apiKey` pasted by hand),
 *    entries whose endpoint fails the app's own URL policy, and unrelated
 *    top-level keys all survive an edit made from the UI;
 *  - an unreadable file is reported and never overwritten. Losing a hand-edited
 *    provider silently would be worse than refusing to save.
 *
 * The dir is the same one `PI_CODING_AGENT_DIR` points at, so the file sits
 * next to Pi's session JSONL rather than inside the SQLite database. That is
 * deliberate: the file is the SDK's configuration input, and the database stays
 * the authority for everything the workbench itself owns.
 */
export interface PiModelsFileSnapshot {
  readonly path: string
  /** Entries the Settings editor can round-trip. */
  readonly providers: readonly AgentCustomProvider[]
  /** Provider ids preserved verbatim because this app cannot represent them. */
  readonly unmanaged: readonly string[]
  /** Read/parse failure of the existing file, or `null` when it is fine. */
  readonly error: string | null
}

/**
 * Signals a file this module refuses to rewrite: invalid JSON, or a provider
 * list that would make Pi reject the *whole* file (one bad entry empties the
 * entire catalog, so a partial write is not an option).
 *
 * `name` is `VALIDATION_FAILED` because `normalizeAppError` in
 * `@prw/workspace-service` maps that name to an `AppError` that keeps the real
 * message, while an unnamed error would reach the user as a generic internal
 * failure with nothing to act on.
 */
export class PiModelsFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VALIDATION_FAILED'
  }
}

/** Absolute path of the file Pi will read for custom providers. */
export function piModelsFilePath(profileDir: string): string {
  return join(profileDir, 'models.json')
}

/** Read the file and classify every provider entry. Never throws for a missing
 * file; a broken file is reported through `error` so the UI can show what is
 * wrong instead of pretending no provider was ever configured. */
export function readPiModelsFile(profileDir: string): PiModelsFileSnapshot {
  const path = piModelsFilePath(profileDir)
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, providers: [], unmanaged: [], error: null }
    }
    return { path, providers: [], unmanaged: [], error: describeReadFailure(error, path) }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonComments(stripBom(content))) as unknown
  } catch (error) {
    return {
      path,
      providers: [],
      unmanaged: [],
      error: `models.json 无法解析：${error instanceof Error ? error.message : String(error)}。请修复或删除该文件后重试。`
    }
  }
  if (!isRecord(parsed)) {
    return { path, providers: [], unmanaged: [], error: 'models.json 顶层必须是 JSON 对象。' }
  }

  const rawProviders = parsed.providers
  if (rawProviders === undefined) return { path, providers: [], unmanaged: [], error: null }
  if (!isRecord(rawProviders)) {
    return { path, providers: [], unmanaged: [], error: 'models.json 的 providers 字段必须是对象。' }
  }

  const providers: AgentCustomProvider[] = []
  const unmanaged: string[] = []
  for (const [id, entry] of Object.entries(rawProviders)) {
    const provider = readManagedProvider(id, entry)
    if (provider) providers.push(provider)
    else unmanaged.push(id)
  }
  return { path, providers, unmanaged, error: null }
}

/**
 * Replace the managed providers and keep everything else exactly as it was.
 *
 * Deleting in the UI means deleting from the file, so a provider that is absent
 * from `providers` is removed — unless it is unmanaged, in which case it is not
 * this app's entry to remove.
 */
export function writePiModelsFile(profileDir: string, providers: readonly AgentCustomProvider[]): PiModelsFileSnapshot {
  for (const provider of providers) {
    const issue = customProviderIdIssue(provider.id) ?? customProviderUrlIssue(provider.baseUrl)
    if (issue) throw new PiModelsFileError(`无法写入 ${provider.id || '未命名 Provider'}：${issue}`)
  }

  const path = piModelsFilePath(profileDir)
  const existing = readExistingDocument(path)
  const existingProviders = isRecord(existing.providers) ? existing.providers : {}

  const next: Record<string, unknown> = {}
  for (const [id, entry] of Object.entries(existingProviders)) {
    // Unmanaged entries keep their original position and value.
    if (readManagedProvider(id, entry) === null) next[id] = entry
  }
  for (const provider of providers) next[provider.id] = toJsonProvider(provider)

  const document = { ...existing, providers: next }
  mkdirSync(profileDir, { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
  return readPiModelsFile(profileDir)
}

/** Raw document of the existing file. A missing file becomes `{}`, and an
 * unreadable one aborts the write instead of clobbering it. */
function readExistingDocument(path: string): Record<string, unknown> {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new PiModelsFileError(describeReadFailure(error, path))
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonComments(stripBom(content))) as unknown
  } catch {
    throw new PiModelsFileError('models.json 当前不是有效的 JSON。请先修复或删除该文件，再保存自定义模型。')
  }
  if (!isRecord(parsed)) throw new PiModelsFileError('models.json 顶层必须是 JSON 对象。')
  return parsed
}

function describeReadFailure(error: unknown, path: string): string {
  return `models.json 无法读取：${error instanceof Error ? error.message : String(error)}（${path}）`
}

/** Provider keys this app owns end to end. Anything else makes the entry
 * unmanaged, so an edit here can never drop a field the UI does not know. */
const MANAGED_PROVIDER_KEYS = new Set(['name', 'baseUrl', 'api', 'models'])
const MANAGED_MODEL_KEYS = new Set(['id', 'name', 'reasoning', 'contextWindow', 'maxTokens'])

/** Parse one entry, or return `null` to mark it unmanaged. Deliberately strict:
 * a field this app would drop on save means the entry is not ours. */
function readManagedProvider(id: string, entry: unknown): AgentCustomProvider | null {
  if (customProviderIdIssue(id) !== null) return null
  if (!isRecord(entry)) return null
  if (Object.keys(entry).some((key) => !MANAGED_PROVIDER_KEYS.has(key))) return null

  const api = entry.api
  if (typeof api !== 'string' || !(AGENT_CUSTOM_PROVIDER_APIS as readonly string[]).includes(api)) return null
  const baseUrl = entry.baseUrl
  if (typeof baseUrl !== 'string' || customProviderUrlIssue(baseUrl) !== null) return null

  const name = entry.name === undefined ? '' : entry.name
  if (typeof name !== 'string' || name.length > 200) return null

  const rawModels = entry.models === undefined ? [] : entry.models
  if (!Array.isArray(rawModels)) return null
  const models: AgentCustomProviderModel[] = []
  for (const model of rawModels) {
    const parsed = readManagedModel(model)
    if (!parsed) return null
    models.push(parsed)
  }
  return { id, name, baseUrl, api: api as AgentCustomProviderApi, models }
}

function readManagedModel(entry: unknown): AgentCustomProviderModel | null {
  if (!isRecord(entry)) return null
  if (Object.keys(entry).some((key) => !MANAGED_MODEL_KEYS.has(key))) return null

  const id = entry.id
  if (typeof id !== 'string' || id.trim().length === 0 || id.length > 200) return null
  const name = entry.name === undefined ? '' : entry.name
  if (typeof name !== 'string' || name.length > 200) return null
  const reasoning = entry.reasoning === undefined ? false : entry.reasoning
  if (typeof reasoning !== 'boolean') return null
  const contextWindow = readPositiveInt(entry.contextWindow)
  const maxTokens = readPositiveInt(entry.maxTokens)
  if (contextWindow === undefined || maxTokens === undefined) return null
  return { id, name, reasoning, contextWindow, maxTokens }
}

/** `null` means "Pi's own default", `undefined` means "not a value this app
 * writes", which is what makes the entry unmanaged. */
function readPositiveInt(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 10_000_000) return undefined
  return value
}

/** Pi's own schema requires at least one character for every string it accepts,
 * so empty optional values are omitted rather than written as `""`. */
function toJsonProvider(provider: AgentCustomProvider): Record<string, unknown> {
  return {
    ...(provider.name ? { name: provider.name } : {}),
    baseUrl: provider.baseUrl,
    api: provider.api,
    models: provider.models.map((model) => ({
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
      ...(model.reasoning ? { reasoning: true } : {}),
      ...(model.contextWindow === null ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === null ? {} : { maxTokens: model.maxTokens })
    }))
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

/** Pi accepts comments in this file, so a user porting a file from another Pi
 * install must not see "invalid JSON" for something Pi itself would load. Only
 * `//` and block comments outside strings are removed. */
function stripJsonComments(value: string): string {
  let out = ''
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string
    const next = value[index + 1]
    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false
        out += char
      }
      continue
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        index += 1
      }
      continue
    }
    if (inString) {
      out += char
      if (char === '\\') {
        out += next ?? ''
        index += 1
        continue
      }
      if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      inLineComment = true
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      inBlockComment = true
      index += 1
      continue
    }
    out += char
  }
  return out
}
