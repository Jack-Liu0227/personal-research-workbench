import type { Credential, ProviderEnv } from '@earendil-works/pi-ai'
import type { AgentRuntimeCredential } from '../index.js'

/**
 * Validate the credential envelope Main attached to an RPC.
 *
 * The envelope crosses a process boundary, so its contents arrive as plain
 * records and cannot be trusted just because Main produced them: a version
 * skew, a hand-written pipe request or a corrupted vault entry would otherwise
 * flow straight into Pi's auth path. Rather than casting, this narrows the two
 * shapes Pi actually defines and drops anything else, which keeps a malformed
 * entry from turning into a confusing provider-side auth error later.
 *
 * OAuth provider-specific extras are passed through unchanged: they are part of
 * Pi's contract and re-declaring them here would fork it.
 */
export function parseRuntimeCredentials(input: readonly CredentialEnvelopeEntry[]): AgentRuntimeCredential[] {
  const parsed: AgentRuntimeCredential[] = []
  for (const entry of input) {
    const credential = parseCredential(entry.credential)
    if (credential) parsed.push({ provider: entry.provider, credential })
  }
  return parsed
}

export interface CredentialEnvelopeEntry {
  readonly provider: string
  readonly credential: Record<string, unknown>
}

/** One credential record, or `null` when it is not a shape Pi can use. */
export function parseCredential(value: Record<string, unknown>): Credential | null {
  if (value.type === 'api_key') {
    const key = value.key
    if (key !== undefined && typeof key !== 'string') return null
    const env = parseProviderEnv(value.env)
    if (env === null) return null
    return {
      type: 'api_key',
      ...(typeof key === 'string' ? { key } : {}),
      ...(env === undefined ? {} : { env })
    }
  }
  if (value.type === 'oauth') {
    const { refresh, access, expires, ...rest } = value
    if (typeof refresh !== 'string' || typeof access !== 'string' || typeof expires !== 'number') return null
    return { type: 'oauth', refresh, access, expires, ...rest }
  }
  return null
}

/** `undefined` means the field was absent, `null` means it was present and
 * invalid. Pi's `ProviderEnv` is a flat string map, so a nested object or a
 * numeric value would be rejected by the provider rather than here. */
function parseProviderEnv(value: unknown): ProviderEnv | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const env: ProviderEnv = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return null
    env[key] = entry
  }
  return env
}
