import type { AgentCredentialSaveInput, AgentCredentialStatus, AgentAuthType } from '@prw/contracts'
import { AgentCredentialProviderSchema } from '@prw/contracts'
import { z } from 'zod'

/**
 * Minimal persistence surface for app-owned model credentials.
 *
 * `CredentialVault` in `credentials.ts` satisfies this structurally. Keeping
 * the dependency structural lets this module stay Electron-free and be
 * exercised by a plain node test with an in-memory store.
 */
export interface AgentCredentialStore {
  get(key: string): Promise<string | null>
  set(key: string, secret: string): Promise<void>
  remove(key: string): Promise<void>
}

/**
 * One encrypted vault entry per Pi provider.
 *
 * Pi identifies a credential by the provider that issued it, so the key is the
 * provider id. The stored value is Pi's own credential object, kept opaque:
 * OAuth tokens carry provider-specific fields (rotating refresh tokens, scopes,
 * account ids) that this app must preserve verbatim or the next refresh fails.
 */
export const AGENT_CREDENTIAL_KEY_PREFIX = 'v2:provider:'

/**
 * The vault has no enumeration primitive, so the set of providers that hold a
 * credential is kept in a plain index. Without it, a run could only find the
 * credential for a provider that happened to be in the current model catalog,
 * which would strand a stored credential as unreachable-but-encrypted.
 *
 * The index holds provider ids only; it is not secret and not authoritative —
 * a missing entry is dropped on read, so a stale index degrades to "not
 * configured" instead of a crash.
 */
export const AGENT_CREDENTIAL_INDEX_KEY = 'v2:provider-index'

const CredentialValueSchema = z.object({ type: z.enum(['api_key', 'oauth']) }).passthrough()

/** A user-facing refusal: the app cannot classify the credential, so storing it
 * would only produce a provider-side rejection on the next run. */
export class AgentCredentialInvalidError extends Error {
  readonly code = 'VALIDATION_FAILED' as const

  constructor(message: string) {
    super(message)
    this.name = 'AgentCredentialInvalidError'
  }
}

const StoredAgentCredentialSchema = z.strictObject({
  provider: AgentCredentialProviderSchema,
  credential: CredentialValueSchema,
  updatedAt: z.iso.datetime({ offset: true })
})

type StoredAgentCredential = z.infer<typeof StoredAgentCredentialSchema>

export function agentCredentialStorageKey(provider: string): string {
  return `${AGENT_CREDENTIAL_KEY_PREFIX}${AgentCredentialProviderSchema.parse(provider)}`
}

/**
 * Read one provider credential.
 *
 * A corrupt or foreign entry is treated as *absent* rather than thrown: the
 * status list must stay renderable, and an unreadable secret must never be
 * reported as a usable capability.
 */
async function readStoredCredential(store: AgentCredentialStore, provider: string): Promise<StoredAgentCredential | null> {
  const raw = await store.get(agentCredentialStorageKey(provider))
  if (raw === null) return null
  try {
    const parsed = StoredAgentCredentialSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function readIndex(store: AgentCredentialStore): Promise<string[]> {
  const raw = await store.get(AGENT_CREDENTIAL_INDEX_KEY)
  if (raw === null) return []
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

async function writeIndex(store: AgentCredentialStore, providers: readonly string[]): Promise<void> {
  await store.set(AGENT_CREDENTIAL_INDEX_KEY, JSON.stringify([...new Set(providers)].sort()))
}

function authTypeOf(credential: Record<string, unknown>): AgentAuthType | null {
  const type = credential['type']
  return type === 'api_key' || type === 'oauth' ? type : null
}

/**
 * Merge vault state with the SDK's provider catalog.
 *
 * The catalog is the source of provider identity and display names; the vault
 * only answers whether one holds a credential. A provider the catalog does not
 * list is still reported, because a credential stored before a provider was
 * renamed would otherwise become invisible and impossible to delete from the
 * UI.
 */
export function mergeCredentialStatuses(
  catalog: ReadonlyArray<{ readonly provider: string; readonly name: string }>,
  stored: ReadonlyArray<StoredAgentCredential>
): AgentCredentialStatus[] {
  const byProvider = new Map(stored.map((entry) => [entry.provider, entry]))
  const statuses: AgentCredentialStatus[] = catalog.map((entry) => {
    const credential = byProvider.get(entry.provider)
    return {
      provider: entry.provider,
      label: entry.name,
      credentialPresent: credential !== undefined,
      authType: credential ? authTypeOf(credential.credential) : null,
      updatedAt: credential?.updatedAt ?? null
    }
  })
  const known = new Set(catalog.map((entry) => entry.provider))
  for (const entry of stored) {
    if (known.has(entry.provider)) continue
    statuses.push({
      provider: entry.provider,
      label: entry.provider,
      credentialPresent: true,
      authType: authTypeOf(entry.credential),
      updatedAt: entry.updatedAt
    })
  }
  return statuses
}

/** Every credential the vault currently holds, newest state per provider. */
export async function readStoredAgentCredentials(store: AgentCredentialStore): Promise<StoredAgentCredential[]> {
  const providers = await readIndex(store)
  const entries: StoredAgentCredential[] = []
  const live: string[] = []
  for (const provider of providers) {
    const stored = await readStoredCredential(store, provider)
    if (stored === null) continue
    entries.push(stored)
    live.push(provider)
  }
  // Drop index entries whose payload is gone or unreadable, so the index cannot
  // grow without bound across reinstalls and manual vault edits.
  if (live.length !== providers.length) await writeIndex(store, live)
  return entries
}

export async function listAgentCredentialStatuses(
  store: AgentCredentialStore,
  catalog: ReadonlyArray<{ readonly provider: string; readonly name: string }>
): Promise<AgentCredentialStatus[]> {
  return mergeCredentialStatuses(catalog, await readStoredAgentCredentials(store))
}

/**
 * Read one provider's credential.
 *
 * Core holds no vault, so an Agent run this process starts on its own timer —
 * a scheduled occurrence or a startup catch-up — asks Main for exactly the
 * provider its model belongs to. The lookup is scoped to that provider: there
 * is deliberately no "give me any credential" variant, because a rule must not
 * be able to authenticate as a provider the user never pointed it at.
 */
export async function readAgentCredential(store: AgentCredentialStore, provider: string): Promise<ResolvedAgentCredential | null> {
  const stored = await readStoredCredential(store, provider)
  return stored === null ? null : { provider: stored.provider, credential: stored.credential }
}

/**
 * Store or clear one provider's API key and return the resulting status list.
 *
 * `apiKey: null` (or an empty string) clears the entry. Only the API-key form is
 * handled here: an OAuth credential is produced by Pi's own login flow in Core
 * and arrives through the credential-write message, because only that flow knows
 * the provider-specific fields a token needs.
 */
export async function saveAgentCredential(
  store: AgentCredentialStore,
  input: AgentCredentialSaveInput,
  catalog: ReadonlyArray<{ readonly provider: string; readonly name: string }>
): Promise<AgentCredentialStatus[]> {
  const provider = AgentCredentialProviderSchema.parse(input.provider)
  const key = input.apiKey?.trim() ?? ''
  const index = await readIndex(store)
  if (key.length === 0) {
    await store.remove(agentCredentialStorageKey(provider))
    await writeIndex(store, index.filter((entry) => entry !== provider))
    return listAgentCredentialStatuses(store, catalog)
  }
  await writeAgentCredential(store, provider, { type: 'api_key', key })
  return listAgentCredentialStatuses(store, catalog)
}

/**
 * Write one credential produced by the embedded SDK.
 *
 * This is the single write path shared by the Settings form and Pi's login
 * flow, so a future field added to a credential travels through the same
 * validation and index maintenance.
 */
export async function writeAgentCredential(
  store: AgentCredentialStore,
  provider: string,
  credential: Record<string, unknown>
): Promise<void> {
  const parsedProvider = AgentCredentialProviderSchema.parse(provider)
  const parsedCredential = CredentialValueSchema.safeParse(credential)
  if (!parsedCredential.success) {
    // A credential the app cannot classify would be sent back to Pi in a shape
    // it rejects, so it is refused at the boundary rather than stored.
    throw new AgentCredentialInvalidError(`凭据类型无效："${parsedProvider}" 的凭据缺少 type 字段。`)
  }
  const payload: StoredAgentCredential = {
    provider: parsedProvider,
    credential: parsedCredential.data,
    updatedAt: new Date().toISOString()
  }
  await store.set(agentCredentialStorageKey(parsedProvider), JSON.stringify(payload))
  const index = await readIndex(store)
  if (!index.includes(parsedProvider)) await writeIndex(store, [...index, parsedProvider])
}

/** Remove one provider credential (logout). */
export async function removeAgentCredential(store: AgentCredentialStore, provider: string): Promise<void> {
  const parsedProvider = AgentCredentialProviderSchema.parse(provider)
  await store.remove(agentCredentialStorageKey(parsedProvider))
  await writeIndex(store, (await readIndex(store)).filter((entry) => entry !== parsedProvider))
}

/**
 * Every configured credential, shaped for Main's private Agent envelope.
 *
 * Pi looks a credential up by provider, so Main sends all of them and lets Core
 * select the one the run is aimed at. A malformed entry is dropped instead of
 * being forwarded, because Core would otherwise reject it mid-run.
 */
export interface ResolvedAgentCredential {
  readonly provider: string
  readonly credential: Record<string, unknown>
}

export async function resolveAgentCredentials(store: AgentCredentialStore): Promise<readonly ResolvedAgentCredential[]> {
  const stored = await readStoredAgentCredentials(store)
  return stored.map((entry) => ({ provider: entry.provider, credential: entry.credential }))
}
