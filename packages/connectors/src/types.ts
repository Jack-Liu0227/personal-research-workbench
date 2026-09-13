import type { IntegrationProvider } from '@prw/contracts'

export interface AdapterProfile {
  readonly provider: IntegrationProvider
  readonly location: string
  readonly settings: Readonly<Record<string, string | number | boolean | null>>
  readonly credential?: string | undefined
}

export interface AdapterCapabilities {
  readonly read: boolean
  readonly write: boolean
  readonly attachments: 'link_only' | 'none'
  readonly incremental: boolean
}

export interface AdapterProbe {
  readonly ok: boolean
  readonly message: string
  readonly capabilities: AdapterCapabilities
  /** Set when the adapter can read but cannot write, so callers can explain a
   * read-only connection instead of presenting a write that always fails. */
  readonly writeBlockedReason?: AdapterWriteBlockedReason | null | undefined
}

/**
 * - `server-id-missing`: a loopback Zotero Local API did not return
 *   `Zotero-Server-ID` (for example Zotero 9), so the local write
 *   authorization handshake is impossible.
 * - `credential-missing`: no API key / local write key is configured.
 * - `probe-failed`: the connection could not be probed at all.
 * - `key-single-use`: the local key was granted with Zotero's one-time
 *   "Allow" button.  Zotero consumes such a key on the first write that
 *   validates it, so a multi-item import can never complete; the user must
 *   authorize again and pick "Always Allow".
 * - `key-unverified`: a local key exists but its persistence mode was never
 *   recorded (credential stored by an older build), so a zero-effect write
 *   check cannot be run without risking consumption of a one-time key.
 * - `key-invalid`: the stored local key is no longer accepted by Zotero
 *   (consumed, revoked, or cleared).
 * - `authorization-denied`: the user declined the Zotero authorization
 *   dialog, or Zotero refused to show it.
 */
export type AdapterWriteBlockedReason =
  | 'server-id-missing'
  | 'credential-missing'
  | 'probe-failed'
  | 'key-single-use'
  | 'key-unverified'
  | 'key-invalid'
  | 'authorization-denied'
  | 'rate-limited'

export interface NormalizedExternalPaper {
  readonly externalId: string
  readonly locator: string
  readonly remoteRevision: string | null
  readonly managedBlockId: string | null
  readonly title: string
  readonly authors: string[]
  readonly year: number | null
  readonly venue: string
  readonly abstract: string
  readonly doi: string | null
  readonly url: string | null
  readonly citationKey: string | null
  readonly tags: string[]
  readonly collections: string[]
  readonly localPdfPath: string | null
}

export interface AdapterPullResult {
  readonly cursor: string | null
  readonly papers: NormalizedExternalPaper[]
  /** Optional transport paging metadata. Zotero uses this to continue past
   * locally filtered records (attachments, collection filters, or search
   * terms) without skipping remote offsets. */
  readonly pageStart?: number
  readonly fetchedCount?: number
  readonly total?: number | null
  readonly hasMore?: boolean
}

export interface ManagedProjection {
  readonly blockId: string
  readonly revision: number
  readonly title: string
  readonly markdown: string
  readonly workbenchId: string
  readonly tags: string[]
  readonly collections: string[]
  readonly authors?: string[] | undefined
  readonly year?: number | null | undefined
  readonly venue?: string | undefined
  readonly abstract?: string | undefined
  readonly doi?: string | null | undefined
  readonly url?: string | null | undefined
  readonly citationKey?: string | null | undefined
}

export interface ProjectionTarget {
  readonly externalId: string
  readonly locator: string
  readonly remoteRevision?: string | null | undefined
  /**
   * Explicit Zotero collection intent for this write.  `undefined`/`null`
   * leaves the remote item's membership untouched: an update must not write a
   * stale locally cached collection list back over the user's own choice, and
   * a create must not silently join a collection nobody selected.  A non-empty
   * key replaces the membership with exactly that collection.
   */
  readonly collectionKey?: string | null | undefined
}

export interface ProjectionReceipt {
  readonly externalId: string
  readonly locator: string
  readonly remoteRevision: string | null
}

export class IntegrationRuntimeError extends Error {
  readonly code:
    | 'NOT_CONNECTED'
    | 'AUTH_REQUIRED'
    | 'PERMISSION_DENIED'
    | 'NOT_FOUND'
    | 'REVISION_CONFLICT'
    | 'RATE_LIMITED'
    | 'TEMPORARILY_UNAVAILABLE'
    | 'INVALID_MAPPING'
    | 'UNSUPPORTED_CAPABILITY'

  constructor(code: IntegrationRuntimeError['code'], message: string) {
    super(message)
    this.name = 'IntegrationRuntimeError'
    this.code = code
  }
}
