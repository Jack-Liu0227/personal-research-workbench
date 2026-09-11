import { randomUUID } from 'node:crypto'
import type { AgentLedgerPush, AgentRpcMethod, AgentRpcRequest, AppError, RpcRequest, RpcResponse } from '@prw/contracts'
import { AgentLedgerPushSchema, AgentRpcRequestSchema, RpcRequestSchema, RpcResponseSchema } from '@prw/contracts'
import { utilityProcess, type UtilityProcess } from 'electron'
import { appError } from './errors.js'

interface PendingRequest {
  readonly resolve: (response: RpcResponse) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface CoreRpcClientOptions {
  readonly workerPath: string
  readonly databasePath: string
  readonly appVersion: string
  readonly servicePipePath?: string
  readonly serviceHandshakeToken?: string
  readonly serviceInfoPath?: string
  readonly requestTimeoutMs?: number
  readonly startupTimeoutMs?: number
}

/**
 * Main-only transport message for the small set of connector operations that
 * need a credential at execution time.  This is intentionally not part of
 * the public RpcRequest contract: the credential is carried beside an already
 * validated public request and never appears in its payload.
 */
export const CREDENTIAL_RPC_ENVELOPE_TYPE = 'prw.rpc-with-credential' as const

export interface CredentialRpcCredential {
  readonly profileId: string
  readonly secret: string | null
}

export interface CredentialRpcEnvelope {
  readonly type: typeof CREDENTIAL_RPC_ENVELOPE_TYPE
  readonly request: RpcRequest
  readonly credential: CredentialRpcCredential
}

function failedResponse(id: string, error: AppError): RpcResponse {
  return { id, ok: false, error }
}

export class CoreRpcClient {
  private readonly child: UtilityProcess
  private readonly pending = new Map<string, PendingRequest>()
  private readonly requestTimeoutMs: number
  private readonly readyPromise: Promise<void>
  private ready = false
  private disposed = false
  private shutdownTimer: ReturnType<typeof setTimeout> | undefined
  private readonly ledgerListeners = new Set<(push: AgentLedgerPush) => void>()

  constructor(options: CoreRpcClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000

    let resolveReady: (() => void) | undefined
    let rejectReady: ((error: Error) => void) | undefined
    this.readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })

    const startupTimer = setTimeout(() => {
      rejectReady?.(new Error('Core utility process did not become ready in time.'))
    }, options.startupTimeoutMs ?? 15_000)

    this.child = utilityProcess.fork(options.workerPath, [], {
      serviceName: 'Personal Research Workbench Core',
      env: {
        ...process.env,
        PRW_DATABASE_PATH: options.databasePath,
        PRW_APP_VERSION: options.appVersion,
        ...(options.servicePipePath ? { PRW_SERVICE_PIPE: options.servicePipePath } : {}),
        ...(options.serviceHandshakeToken ? { PRW_SERVICE_TOKEN: options.serviceHandshakeToken } : {}),
        ...(options.serviceInfoPath ? { PRW_SERVICE_INFO: options.serviceInfoPath } : {})
      }
    })

    this.child.on('message', (message: unknown) => {
      if (isReadyMessage(message)) {
        clearTimeout(startupTimer)
        this.ready = true
        resolveReady?.()
        return
      }
      if (isShutdownCompleteMessage(message)) {
        if (this.shutdownTimer) clearTimeout(this.shutdownTimer)
        this.shutdownTimer = undefined
        return
      }
      if (isAgentLedgerMessage(message)) {
        // The ledger push is not an RPC response: it has no request id and must
        // never resolve a pending request. Every message is validated before a
        // listener sees it.
        const parsed = AgentLedgerPushSchema.safeParse(message.push)
        if (!parsed.success) return
        for (const listener of this.ledgerListeners) listener(parsed.data)
        return
      }

      const parsed = RpcResponseSchema.safeParse(message)
      if (!parsed.success) return
      const pending = this.pending.get(parsed.data.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(parsed.data.id)
      pending.resolve(parsed.data)
    })

    this.child.on('exit', (code) => {
      clearTimeout(startupTimer)
      if (this.shutdownTimer) clearTimeout(this.shutdownTimer)
      this.shutdownTimer = undefined
      this.ready = false
      const error = new Error(`Core utility process exited with code ${String(code)}.`)
      rejectReady?.(error)
      this.resolveAllWithError(
        appError('CORE_UNAVAILABLE', 'The local data service stopped unexpectedly.', true)
      )
    })
  }

  async waitUntilReady(): Promise<void> {
    await this.readyPromise
  }

  /** Subscribe to normalized ledger pushes from the Core process. Returns an
   * unsubscribe function; Main keeps at most one subscription per renderer
   * window and drops them when the window closes. */
  onLedgerPush(listener: (push: AgentLedgerPush) => void): () => void {
    this.ledgerListeners.add(listener)
    return () => { this.ledgerListeners.delete(listener) }
  }

  request(method: RpcRequest['method'], payload: unknown): Promise<RpcResponse> {
    const id = randomUUID()
    if (!this.ready || this.disposed) {
      return Promise.resolve(this.unavailableResponse(id))
    }

    const parsed = RpcRequestSchema.safeParse({ id, method, payload })
    if (!parsed.success) return Promise.resolve(this.invalidRequestResponse(id, parsed.error.issues))
    return this.send(parsed.data)
  }

  requestAgent(method: AgentRpcMethod, payload: unknown): Promise<RpcResponse> {
    const id = randomUUID()
    if (!this.ready || this.disposed) return Promise.resolve(this.unavailableResponse(id))
    const parsed = AgentRpcRequestSchema.safeParse({ id, method, payload })
    if (!parsed.success) return Promise.resolve(this.invalidRequestResponse(id, parsed.error.issues))
    return this.sendAgent(parsed.data)
  }

  /**
   * Send a connector request with a Main-resolved safeStorage credential.
   * The credential is never merged into the public payload.  This method is
   * deliberately restricted to integration/Zotero operations and emits the
   * typed internal envelope consumed by the Workspace Service transport.
   */
  requestWithCredential(
    method: RpcRequest['method'],
    payload: unknown,
    credential: CredentialRpcCredential
  ): Promise<RpcResponse> {
    const id = randomUUID()
    if (!this.ready || this.disposed) return Promise.resolve(this.unavailableResponse(id))

    if (!CREDENTIAL_METHODS.has(method)) {
      return Promise.resolve(
        failedResponse(id, appError('VALIDATION_FAILED', 'Credentials are not accepted for this RPC method.'))
      )
    }

    const parsed = RpcRequestSchema.safeParse({ id, method, payload })
    if (!parsed.success) return Promise.resolve(this.invalidRequestResponse(id, parsed.error.issues))
    if (!isCredentialRpcCredential(credential)) {
      return Promise.resolve(
        failedResponse(id, appError('VALIDATION_FAILED', 'The credential envelope is invalid.'))
      )
    }

    const envelope: CredentialRpcEnvelope = {
      type: CREDENTIAL_RPC_ENVELOPE_TYPE,
      request: parsed.data,
      credential: {
        profileId: credential.profileId,
        secret: credential.secret
      }
    }
    return this.send(parsed.data, envelope)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.ready = false
    this.ledgerListeners.clear()
    this.resolveAllWithError(
      appError('CORE_UNAVAILABLE', 'The local data service has been stopped.', true)
    )
    try {
      this.child.postMessage({ type: 'shutdown' })
      this.shutdownTimer = setTimeout(() => this.child.kill(), 1_500)
      this.shutdownTimer.unref()
    } catch {
      this.child.kill()
    }
  }

  private resolveAllWithError(error: AppError): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.resolve(failedResponse(id, error))
    }
    this.pending.clear()
  }

  private send(request: RpcRequest, message: RpcRequest | CredentialRpcEnvelope = request): Promise<RpcResponse> {
    return new Promise<RpcResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        resolve(
          failedResponse(
            request.id,
            appError('CORE_TIMEOUT', 'The local data service did not respond in time.', true)
          )
        )
      }, this.requestTimeoutMs)
      this.pending.set(request.id, { resolve, timer })
      this.child.postMessage(message)
    })
  }

  private sendAgent(request: AgentRpcRequest): Promise<RpcResponse> {
    return new Promise<RpcResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        resolve(failedResponse(request.id, appError('CORE_TIMEOUT', 'The local data service did not respond in time.', true)))
      }, this.requestTimeoutMs)
      this.pending.set(request.id, { resolve, timer })
      this.child.postMessage(request)
    })
  }

  private unavailableResponse(id: string): RpcResponse {
    return failedResponse(
      id,
      appError('CORE_UNAVAILABLE', 'The local data service is not available.', true)
    )
  }

  private invalidRequestResponse(id: string, issues: unknown[]): RpcResponse {
    return failedResponse(
      id,
      appError('VALIDATION_FAILED', 'The RPC method is not supported.', false, { issues })
    )
  }
}

/** Main-approved credential-bearing methods.  Keep this list narrower than
 * the public route allow-list so a credential cannot be attached to a local
 * CRUD or status request by mistake. */
const CREDENTIAL_METHODS: ReadonlySet<RpcRequest['method']> = new Set([
  'integrations.save',
  'integrations.test',
  'integrations.sync',
  'zotero.capability',
  'zotero.collections',
  'zotero.collectionsPage',
  'zotero.items',
  'zotero.itemsPage',
  'zotero.bibtexExport',
  'zotero.import',
  'zotero.authorize',
  'zotero.importSelected.preview',
  'zotero.importSelected.execute',
  'zotero.paperToZotero.preview',
  'zotero.paperToZotero.execute',
  'literature.stagingToZotero.preview',
  'literature.stagingToZotero.execute',
  'papers.importFromZotero',
  'knowledge.engines.save',
  'knowledge.engines.test'
])

function isCredentialRpcCredential(value: unknown): value is CredentialRpcCredential {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['profileId'] === 'string'
    && candidate['profileId'].length > 0
    && (candidate['secret'] === null
      || (typeof candidate['secret'] === 'string' && candidate['secret'].length <= 20_000))
}

function isReadyMessage(message: unknown): message is { type: 'ready' } {
  return typeof message === 'object'
    && message !== null
    && 'type' in message
    && message.type === 'ready'
}

function isShutdownCompleteMessage(message: unknown): message is { type: 'shutdown-complete' } {
  return typeof message === 'object'
    && message !== null
    && 'type' in message
    && message.type === 'shutdown-complete'
}

function isAgentLedgerMessage(message: unknown): message is { type: 'agent-ledger'; push: unknown } {
  return typeof message === 'object'
    && message !== null
    && 'type' in message
    && message.type === 'agent-ledger'
    && 'push' in message
}
