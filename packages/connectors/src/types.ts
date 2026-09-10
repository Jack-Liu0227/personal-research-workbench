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
}

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
