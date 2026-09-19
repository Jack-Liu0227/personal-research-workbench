import { randomUUID } from 'node:crypto'
import type { AgentAuthEvent, AgentCredentialEnvelope, AgentLedgerPush, AgentRpcMethod, AgentRpcRequest, AppError, RpcRequest, RpcResponse } from '@prw/contracts'
import { AgentAuthEventSchema, AgentCredentialEnvelopeSchema, AgentLedgerPushSchema, AgentRpcRequestSchema, ExternalOpenUrlSchema, RpcRequestSchema, RpcResponseSchema } from '@prw/contracts'
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
  /** Repository checkout that owns `.agents/skills`, forwarded to Core so skill
   * discovery never falls back to Core's own working directory (the user-data
   * directory). Omitted for an installed app. */
  readonly projectRoot?: string | undefined
  /** True for an installed app: Core must discover skills from the packaged
   * `resources/skills` mirror only. */
  readonly packagedApp?: boolean | undefined
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

/**
 * Main-only envelope for Agent RPCs that need a runtime credential.
 *
 * Electron Main owns the `safeStorage` vault, so it resolves the credential for
 * each runtime and attaches it here for exactly one Core dispatch. The
 * renderer never sees this envelope, the credential never enters a payload, and
 * Core drops the secret as soon as the child process has started.
 */
export const AGENT_CREDENTIAL_ENVELOPE_TYPE = 'prw.agent-rpc-with-credential' as const

export interface AgentCredentialEnvelopeCredentials {
  /** Pi's provider id, for example `anthropic`. Pi looks a credential up by the
   * provider that issued it, not by a runtime name. */
  readonly provider: string
  /** Pi's credential object, kept opaque so provider-specific OAuth fields
   * survive the round trip. It never enters a payload, a log or SQLite. */
  readonly credential: Record<string, unknown>
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
  private readonly authListeners = new Set<(event: AgentAuthEvent) => void>()
  private credentialWriter: CredentialWriter | null = null
  private credentialReader: ((provider: string) => Promise<Record<string, unknown> | null>) | null = null
  private integrationSecretReader: ((profileId: string) => Promise<string | null>) | null = null
  private externalOpener: ((url: string) => void) | null = null

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
        ...(options.serviceInfoPath ? { PRW_SERVICE_INFO: options.serviceInfoPath } : {}),
        ...(options.projectRoot ? { PRW_PROJECT_ROOT: options.projectRoot } : {}),
        ...(options.packagedApp ? { PRW_PACKAGED_APP: '1' } : {})
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
      if (isAgentAuthMessage(message)) {
        // Login progress is likewise not an RPC response. It is validated here
        // so a malformed event cannot reach the renderer through Main.
        const parsed = AgentAuthEventSchema.safeParse(message.event)
        if (!parsed.success) return
        for (const listener of this.authListeners) listener(parsed.data)
        return
      }
      if (isCredentialWriteMessage(message)) {
        void this.handleCredentialWrite(message)
        return
      }
      if (isCredentialReadMessage(message)) {
        void this.handleCredentialRead(message)
        return
      }
      if (isIntegrationCredentialReadMessage(message)) {
        void this.handleIntegrationCredentialRead(message)
        return
      }
      if (isOpenExternalMessage(message)) {
        // The one allowlist shared by preload, Main and renderer: only absolute
        // http/https URLs without credentials may reach the OS browser.
        const parsed = ExternalOpenUrlSchema.safeParse(message.url)
        if (parsed.success) this.externalOpener?.(parsed.data)
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

  /** Subscribe to login progress from Core. Unlike a request/response RPC, a
   * login is long-lived and can outlast the dialog, so it is pushed. */
  onAuthEvent(listener: (event: AgentAuthEvent) => void): () => void {
    this.authListeners.add(listener)
    return () => { this.authListeners.delete(listener) }
  }

  /**
   * Install the single writer for credentials produced inside Core.
   *
   * Main owns `safeStorage`, so Core can only ask. While no writer is
   * installed, a write is refused with an explicit ack: failing closed keeps a
   * login from appearing to succeed while the token was never persisted.
   */
  setCredentialWriter(writer: CredentialWriter): void {
    this.credentialWriter = writer
  }

  /** Install the handler for URLs Core cannot open itself. `shell.openExternal`
   * stays in Main, next to the URL validation. */
  setExternalOpener(opener: (url: string) => void): void {
    this.externalOpener = opener
  }

  /**
   * Install the reader Core uses for a run it starts on its own.
   *
   * The user's own runs carry Main's per-RPC credential envelope. A scheduled
   * occurrence has no renderer behind it, so it asks for exactly one provider —
   * the one its selected model belongs to. While no reader is installed the
   * answer is `null`, which keeps the run fail-closed instead of letting it
   * borrow a credential nobody authorized for it.
   */
  setCredentialReader(reader: (provider: string) => Promise<Record<string, unknown> | null>): void {
    this.credentialReader = reader
  }

  /**
   * The mirror of `setCredentialReader` for connection secrets.
   *
   * An Agent tool call reaches Core over the in-process MCP transport, which
   * carries no credential envelope, so a Zotero write the Agent asks for reads
   * its one profile's secret here. Scoped to a profile id for the same reason the
   * provider read is scoped to a provider: no request may authenticate as a
   * connection the user never pointed it at.
   */
  setIntegrationSecretReader(reader: (profileId: string) => Promise<string | null>): void {
    this.integrationSecretReader = reader
  }

  private async handleCredentialRead(message: CredentialReadMessage): Promise<void> {
    const reader = this.credentialReader
    if (!reader) {
      this.answerCredentialRead(message.requestId, { ok: false, error: '凭据读取通道尚未就绪' })
      return
    }
    try {
      const credential = await reader(message.provider)
      // The provider id travels back with the value so Core can verify it
      // received the credential it asked for and nothing else.
      this.answerCredentialRead(message.requestId, credential === null
        ? { ok: true }
        : { ok: true, provider: message.provider, credential })
    } catch (error) {
      this.answerCredentialRead(message.requestId, { ok: false, error: error instanceof Error ? error.message : '凭据读取失败' })
    }
  }

  private answerCredentialRead(
    requestId: string,
    result: { ok: true; provider?: string; credential?: Record<string, unknown> } | { ok: false; error?: string }
  ): void {
    if (this.disposed) return
    try {
      this.child.postMessage({ type: 'credential-result', requestId, ...result })
    } catch {
      // Core is gone; the requester is already failing closed on its own timer.
    }
  }

  private async handleIntegrationCredentialRead(message: IntegrationCredentialReadMessage): Promise<void> {
    const reader = this.integrationSecretReader
    if (!reader) {
      this.answerIntegrationCredentialRead(message.requestId, { ok: false, error: '集成凭据读取通道尚未就绪' })
      return
    }
    try {
      this.answerIntegrationCredentialRead(message.requestId, { ok: true, secret: await reader(message.profileId) })
    } catch (error) {
      this.answerIntegrationCredentialRead(message.requestId, {
        ok: false,
        error: error instanceof Error ? error.message : '集成凭据读取失败'
      })
    }
  }

  private answerIntegrationCredentialRead(
    requestId: string,
    result: { ok: true; secret: string | null } | { ok: false; error?: string }
  ): void {
    if (this.disposed) return
    try {
      this.child.postMessage({ type: 'integration-credential-result', requestId, ...result })
    } catch {
      // Core is gone; the requester is already failing closed on its own timer.
    }
  }

  private async handleCredentialWrite(message: CredentialWriteMessage): Promise<void> {
    const writer = this.credentialWriter
    if (!writer) {
      this.ackCredential(message.requestId, false, '凭据写入通道尚未就绪')
      return
    }
    try {
      await writer(message.provider, message.credential)
      this.ackCredential(message.requestId, true)
    } catch (error) {
      this.ackCredential(message.requestId, false, error instanceof Error ? error.message : '凭据写入失败')
    }
  }

  private ackCredential(requestId: string, ok: boolean, error?: string): void {
    if (this.disposed) return
    try {
      this.child.postMessage(error === undefined
        ? { type: 'credential-ack', requestId, ok }
        : { type: 'credential-ack', requestId, ok, error })
    } catch {
      // Core is gone; the writer already knows the outcome it reported.
    }
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
   * Send an Agent request with Main-resolved safeStorage credentials.
   *
   * Only Main can call this. An empty credential list is meaningful: Core then
   * fails closed with a blocked run instead of reaching for a personal CLI
   * login, so the caller must never fabricate a credential to "make it work".
   */
  requestAgentWithCredential(
    method: AgentRpcMethod,
    payload: unknown,
    credentials: readonly AgentCredentialEnvelopeCredentials[]
  ): Promise<RpcResponse> {
    const id = randomUUID()
    if (!this.ready || this.disposed) return Promise.resolve(this.unavailableResponse(id))
    const parsed = AgentRpcRequestSchema.safeParse({ id, method, payload })
    if (!parsed.success) return Promise.resolve(this.invalidRequestResponse(id, parsed.error.issues))
    const envelope = AgentCredentialEnvelopeSchema.safeParse({
      type: AGENT_CREDENTIAL_ENVELOPE_TYPE,
      request: parsed.data,
      credentials: credentials.map((entry) => ({ provider: entry.provider, credential: entry.credential }))
    })
    // A rejected envelope is returned as a failed response rather than thrown:
    // this method runs inside the Main IPC handler, where an exception would
    // surface as an opaque error string instead of the typed failure the
    // renderer already knows how to display.
    if (!envelope.success) return Promise.resolve(this.invalidRequestResponse(id, envelope.error.issues))
    return this.send(parsed.data, envelope.data)
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
    this.authListeners.clear()
    this.credentialWriter = null
    this.externalOpener = null
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

  private send(
    request: RpcRequest | AgentRpcRequest,
    message: RpcRequest | AgentRpcRequest | CredentialRpcEnvelope | AgentCredentialEnvelope = request
  ): Promise<RpcResponse> {
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

function isAgentAuthMessage(message: unknown): message is { type: 'agent-auth'; event: unknown } {
  return typeof message === 'object'
    && message !== null
    && 'type' in message
    && message.type === 'agent-auth'
    && 'event' in message
}

function isCredentialWriteMessage(message: unknown): message is CredentialWriteMessage {
  if (typeof message !== 'object' || message === null) return false
  if (!('type' in message) || message.type !== 'credential-write') return false
  if (!('requestId' in message) || typeof message.requestId !== 'string') return false
  if (!('provider' in message) || typeof message.provider !== 'string' || message.provider.length === 0) return false
  if (!('credential' in message)) return false
  const credential = message.credential
  // `null` is the logout signal; anything else must be a type-tagged record.
  return credential === null
    || (typeof credential === 'object' && !Array.isArray(credential) && typeof (credential as { type?: unknown }).type === 'string')
}

function isCredentialReadMessage(message: unknown): message is CredentialReadMessage {
  if (typeof message !== 'object' || message === null) return false
  if (!('type' in message) || message.type !== 'credential-read') return false
  if (!('requestId' in message) || typeof message.requestId !== 'string') return false
  // Provider ids are `[a-z0-9._-]` by contract; the bound exists so a malformed
  // message cannot turn into an unbounded vault lookup key.
  return 'provider' in message
    && typeof message.provider === 'string'
    && message.provider.length > 0
    && message.provider.length <= 200
}

function isOpenExternalMessage(message: unknown): message is { type: 'open-external'; url: unknown } {
  return typeof message === 'object'
    && message !== null
    && 'type' in message
    && message.type === 'open-external'
    && 'url' in message
}

/** Core's credential write request. `null` means logout. */
interface CredentialWriteMessage {
  readonly type: 'credential-write'
  readonly requestId: string
  readonly provider: string
  readonly credential: Record<string, unknown> | null
}

/** Persist one credential produced inside Core, or delete it when `null`. */
export type CredentialWriter = (provider: string, credential: Record<string, unknown> | null) => Promise<void>

function isIntegrationCredentialReadMessage(message: unknown): message is IntegrationCredentialReadMessage {
  if (typeof message !== 'object' || message === null) return false
  if (!('type' in message) || message.type !== 'integration-credential-read') return false
  if (!('requestId' in message) || typeof message.requestId !== 'string') return false
  // Bounded for the same reason as a provider id: a malformed message must not
  // become an unbounded vault lookup key.
  return 'profileId' in message
    && typeof message.profileId === 'string'
    && message.profileId.length > 0
    && message.profileId.length <= 200
}

/** Core's integration-secret read request, used by an Agent tool call. */
interface IntegrationCredentialReadMessage {
  readonly type: 'integration-credential-read'
  readonly requestId: string
  readonly profileId: string
}

/** Core's credential read request, used by a run that has no RPC envelope. */
interface CredentialReadMessage {
  readonly type: 'credential-read'
  readonly requestId: string
  readonly provider: string
}
