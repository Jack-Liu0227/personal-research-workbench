import type { AgentMcpServer } from '@prw/contracts'

export interface McpCredentialStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

export const mcpCredentialKey = (id: string, revision: number): string => `v2:mcp:${id}:r${revision}`
const mutations = new Map<string, Promise<void>>()

/** Readers wait for the DB CAS/vault handoff; a staged token is never observable. */
export async function withMcpCredentialLock<T>(id: string, action: () => Promise<T>): Promise<T> {
  const previous = mutations.get(id) ?? Promise.resolve()
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.then(() => pending)
  mutations.set(id, tail)
  await previous
  try { return await action() } finally {
    release()
    if (mutations.get(id) === tail) mutations.delete(id)
  }
}

/** A durable staged envelope is never a usable credential, including after a crash. */
export async function replaceMcpCredential<T>(store: McpCredentialStore, current: AgentMcpServer,
  token: string | null, commit: () => Promise<T>, committedServer: (result: T) => AgentMcpServer | null): Promise<T> {
  const key = mcpCredentialKey(current.id, current.revision + 1)
  const envelope = { version: 1, state: 'staged', id: current.id, revision: current.revision + 1, endpoint: current.endpoint, token }
  // Clear also removes an orphan from a previous interrupted attempt.
  if (token === null) await store.remove(key)
  else await store.set(key, JSON.stringify(envelope))
  try {
    const result = await commit()
    const next = committedServer(result)
    if (next === null) { await store.remove(key); return result }
    if (next.id !== current.id || next.revision !== current.revision + 1 || next.endpoint !== current.endpoint)
      throw new Error('MCP credential commit did not match the frozen configuration.')
    if (token !== null) await store.set(key, JSON.stringify({ ...envelope, state: 'active' }))
    await store.remove(mcpCredentialKey(current.id, current.revision))
    return result
  } catch (error) {
    await store.remove(key).catch(() => undefined)
    throw error
  }
}

export async function readMcpCredential(store: McpCredentialStore, current: AgentMcpServer | null,
  requestedRevision?: number): Promise<string | null> {
  if (!current || current.archivedAt || !current.enabled || (requestedRevision !== undefined && requestedRevision !== current.revision)) return null
  const raw = await store.get(mcpCredentialKey(current.id, current.revision))
  if (raw === null) return null
  try {
    const entry = JSON.parse(raw) as Record<string, unknown>
    return entry['version'] === 1 && entry['state'] === 'active' && entry['id'] === current.id
      && entry['revision'] === current.revision && entry['endpoint'] === current.endpoint
      && typeof entry['token'] === 'string' && entry['token'].length > 0 && entry['token'].length <= 8192
      && !/[\r\n\0]/u.test(entry['token']) ? entry['token'] : null
  } catch { return null }
}
