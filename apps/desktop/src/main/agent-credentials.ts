import type {
  AgentCredentialProvider,
  AgentCredentialSaveInput,
  AgentCredentialStatus,
  AgentRuntimeKind
} from '@prw/contracts'
import { AgentCredentialProviderSchema, AgentRuntimeKindSchema, agentCredentialEnvVar } from '@prw/contracts'
import { z } from 'zod'

/**
 * Minimal persistence surface for the app-owned runtime credential.
 *
 * `CredentialVault` in `credentials.ts` satisfies this structurally. Keeping
 * the dependency structural is what lets this module stay Electron-free and be
 * exercised by a plain node test with an in-memory store.
 */
export interface AgentCredentialStore {
  get(key: string): Promise<string | null>
  set(key: string, secret: string): Promise<void>
  remove(key: string): Promise<void>
}

/** The two supported CLI transports. Both run against an app-owned profile. */
export const AGENT_RUNTIMES: readonly AgentRuntimeKind[] = ['codex', 'pi']

/**
 * One encrypted vault entry holds the provider id and the secret together, so
 * a status read can report `provider` without a second, plaintext side table.
 * The key namespace deliberately mirrors `credentialKey('provider', runtime)`.
 */
export function agentCredentialStorageKey(runtime: AgentRuntimeKind): string {
  return `v2:provider:${AgentRuntimeKindSchema.parse(runtime)}`
}

const StoredAgentCredentialSchema = z.strictObject({
  provider: AgentCredentialProviderSchema,
  secret: z.string().min(1).max(20_000),
  updatedAt: z.iso.datetime({ offset: true })
})

interface StoredAgentCredential {
  readonly provider: AgentCredentialProvider
  readonly secret: string
  readonly updatedAt: string
}

/** A user-facing refusal: the runtime has no documented variable for that
 * provider, so the app must not guess one. */
export class AgentCredentialUnsupportedError extends Error {
  readonly code = 'VALIDATION_FAILED' as const

  constructor(message: string) {
    super(message)
    this.name = 'AgentCredentialUnsupportedError'
  }
}

/**
 * Read one runtime's credential.
 *
 * A corrupt or foreign entry is treated as *absent* rather than thrown: the
 * status list must stay renderable, and an unreadable secret must never be
 * reported as a usable capability.
 */
async function readStoredCredential(
  store: AgentCredentialStore,
  runtime: AgentRuntimeKind
): Promise<StoredAgentCredential | null> {
  const raw = await store.get(agentCredentialStorageKey(runtime))
  if (raw === null) return null
  try {
    const parsed = StoredAgentCredentialSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function toStatus(runtime: AgentRuntimeKind, stored: StoredAgentCredential | null): AgentCredentialStatus {
  return {
    runtime,
    provider: stored?.provider ?? null,
    credentialPresent: stored !== null,
    // `null` when the runtime documents no variable for the stored provider.
    envVar: stored === null ? null : agentCredentialEnvVar(runtime, stored.provider),
    updatedAt: stored?.updatedAt ?? null
  }
}

/** Non-secret status for every supported runtime. */
export async function listAgentCredentialStatuses(store: AgentCredentialStore): Promise<AgentCredentialStatus[]> {
  return Promise.all(AGENT_RUNTIMES.map(async (runtime) => toStatus(runtime, await readStoredCredential(store, runtime))))
}

/**
 * Store or clear one runtime credential and return the resulting status list.
 *
 * `apiKey: null` (or an empty string) clears the entry. A provider the runtime
 * does not document is refused before anything is written.
 */
export async function saveAgentCredential(
  store: AgentCredentialStore,
  input: AgentCredentialSaveInput
): Promise<AgentCredentialStatus[]> {
  const runtime = AgentRuntimeKindSchema.parse(input.runtime)
  const provider = AgentCredentialProviderSchema.parse(input.provider)
  const secret = input.apiKey?.trim() ?? ''
  if (secret.length === 0) {
    await store.remove(agentCredentialStorageKey(runtime))
    return listAgentCredentialStatuses(store)
  }
  if (agentCredentialEnvVar(runtime, provider) === null) {
    throw new AgentCredentialUnsupportedError(
      `${runtime} 没有为 provider "${provider}" 定义凭据环境变量，已拒绝保存。`
    )
  }
  const payload: StoredAgentCredential = { provider, secret, updatedAt: new Date().toISOString() }
  await store.set(agentCredentialStorageKey(runtime), JSON.stringify(payload))
  return listAgentCredentialStatuses(store)
}

/**
 * Every configured credential, shaped for Main's private Agent envelope.
 *
 * Core picks the entry matching the runtime a request resolves to, so Main does
 * not need to know which runtime a retry replays. An incomplete entry is
 * dropped instead of being sent with a guessed variable name.
 */
export interface ResolvedAgentCredential {
  readonly runtime: AgentRuntimeKind
  readonly provider: string
  readonly secret: string
}

export async function resolveAgentCredentials(
  store: AgentCredentialStore
): Promise<readonly ResolvedAgentCredential[]> {
  const candidates = await Promise.all(AGENT_RUNTIMES.map(async (runtime) => {
    const stored = await readStoredCredential(store, runtime)
    if (stored === null || stored.secret.trim().length === 0) return null
    if (agentCredentialEnvVar(runtime, stored.provider) === null) return null
    return { runtime, provider: stored.provider as string, secret: stored.secret }
  }))
  const resolved: ResolvedAgentCredential[] = []
  for (const candidate of candidates) {
    if (candidate !== null) resolved.push(candidate)
  }
  return resolved
}
