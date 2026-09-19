import { randomUUID } from 'node:crypto'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { PiInProcessAdapter, parseRuntimeCredentials, type AgentCredentialBridge, type AgentWorkspaceToolClient } from '@prw/agent-runtime'
import { WorkbenchRepository } from '@prw/database'
import { openInProcessWorkspaceSession } from '@prw/workspace-mcp'
import { AgentCredentialEnvelopeSchema, type AgentAuthEvent, type AgentRunRecord } from '@prw/contracts'
import { AgentModelCoordinator } from './agent-models.js'
import { dispatchAgentRpc } from './agent-dispatcher.js'
import { noAgentCredentials, type AgentCredentialSource, type AgentRunCredentialInput } from './agent-coordinator.js'
import { dispatchRpc, type AgentCallContext } from './dispatcher.js'
import { AgentExternalActionCoordinator } from './agent-external-actions.js'
import { AgentCoordinator } from './agent-coordinator.js'
import { deliverDailyLiterature, type DailyLiteratureDelivery } from './daily-literature.js'
import { IntegrationCoordinator } from './integration-runtime.js'
import { LiteratureCoordinator } from './literature-runtime.js'
import { KnowledgeEngineCoordinator } from './knowledge-engines.js'

export interface ServiceParentPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}

/** The page a login flow needs the user to visit, if it needs one at all. */
function authEventUrl(event: AgentAuthEvent): string | null {
  if (event.kind === 'auth_url') return event.url
  if (event.kind === 'device_code') return event.verificationUri
  return null
}

/**
 * Parent-port and authenticated pipe messages are intentionally forwarded as
 * unknown values. `dispatchRpc` accepts the public RpcRequest or Main's
 * private `prw.rpc-with-credential` envelope, performs all strict validation,
 * and strips credentials before producing a response. Keeping this host
 * transport opaque avoids a second DTO or any credential logging here.
 */

export interface WorkspaceServiceHostOptions {
  readonly parentPort: ServiceParentPort
  readonly databasePath: string
  readonly version: string
  readonly pipePath?: string
  readonly handshakeToken?: string
  readonly serviceInfoPath?: string
  readonly exit?: () => void
}

/** Everything an RPC can reach. Named once so the pipe server, the parent port
 * and the Agent's in-process MCP backend all pass the same object around. */
type WorkspaceServices = Parameters<typeof dispatchRpc>[0] & {
  agent: AgentCoordinator
  models: AgentModelCoordinator
  /** The host always builds one; `CoreServices` keeps it optional only so a
   * service set assembled for a unit test can omit it. */
  externalActions: AgentExternalActionCoordinator
}

/**
 * Process-independent business host. Electron's UtilityProcess is only the
 * current transport; MCP can connect to the same service contract later.
 */
export function startWorkspaceService(options: WorkspaceServiceHostOptions): void {
  const repository = new WorkbenchRepository({ filePath: options.databasePath })
  const integrations = new IntegrationCoordinator(repository)
  const runtimeProfileDir = join(dirname(options.databasePath), 'agent-runtime', 'pi')
  // Credentials are written by Electron Main, so the Core side only needs a
  // request/ack channel. The map holds the in-flight writes for the lifetime of
  // one login or one credential refresh; nothing is cached past the ack.
  const pendingCredentialWrites = new Map<string, PendingCredentialWrite>()
  // A run this process starts on its own — a scheduled occurrence or a startup
  // catch-up — has no credential envelope, so it reads the one provider it is
  // about to call from Main. Nothing is cached here: the entry serves a single
  // run and the vault stays in Main.
  const pendingCredentialReads = new Map<string, PendingCredentialRead>()
  // The same idea for integration secrets. An Agent tool call arrives over the
  // in-process MCP transport, which carries no credential envelope, so a Zotero
  // write the Agent asks for reads its one profile's secret here instead.
  const pendingIntegrationReads = new Map<string, PendingIntegrationSecretRead>()
  options.parentPort.on('message', (event) => {
    const ack = parseCredentialAck(event.data)
    if (ack) {
      const pending = pendingCredentialWrites.get(ack.requestId)
      if (!pending) return
      pendingCredentialWrites.delete(ack.requestId)
      clearTimeout(pending.timer)
      if (ack.ok) pending.resolve()
      else pending.reject(new Error(ack.error ?? '凭据写入被拒绝'))
      return
    }
    const result = parseCredentialResult(event.data)
    if (result) {
      const pending = pendingCredentialReads.get(result.requestId)
      if (!pending) return
      pendingCredentialReads.delete(result.requestId)
      clearTimeout(pending.timer)
      if (result.ok) pending.resolve(result.credential)
      else pending.reject(new Error(result.error ?? '凭据读取被拒绝'))
      return
    }
    const secret = parseIntegrationCredentialResult(event.data)
    if (!secret) return
    const waiting = pendingIntegrationReads.get(secret.requestId)
    if (!waiting) return
    pendingIntegrationReads.delete(secret.requestId)
    clearTimeout(waiting.timer)
    if (secret.ok) waiting.resolve(secret.secret)
    else waiting.reject(new Error(secret.error ?? '集成凭据读取被拒绝'))
  })
  const credentialSink: AgentCredentialBridge['persist'] = (providerId, credential) =>
    writeCredential(options.parentPort, pendingCredentialWrites, providerId, credential)
  const runtimeAdapter = new PiInProcessAdapter({
    persistCredential: credentialSink,
    // The workspace is reached through the same MCP server external clients use,
    // but over an in-memory transport: the packaged app ships no node binary, so
    // `fork`/`spawn` cannot carry a stdio MCP server.
    openWorkspaceClient: async ({ runId }): Promise<AgentWorkspaceToolClient> => {
      // The run id is bound here, by Core, and travels with every tool call the
      // session makes. The model cannot name it: an external write needs the run
      // it belongs to, and a model-chosen owner would be forgeable.
      const context: AgentCallContext = {
        runId,
        readIntegrationSecret: (profileId) => readIntegrationSecret(options.parentPort, pendingIntegrationReads, profileId)
      }
      const session = await openInProcessWorkspaceSession((input) => dispatchMessage(services, { version: options.version }, input, context))
      return {
        listTools: (params, options2) => session.client.listTools(params, options2),
        callTool: (params, resultSchema, options2) => session.client.callTool(params, resultSchema, options2),
        close: () => session.close()
      }
    }
  })
  const literature = new LiteratureCoordinator(repository)
  const services = {
    repository,
    integrations,
    literature,
    knowledgeEngines: new KnowledgeEngineCoordinator(repository),
    externalActions: new AgentExternalActionCoordinator({
      repository,
      // Every port is one of the connector entry points the UI already calls,
      // and each takes the secret as an argument so the coordinator never needs
      // to know where a credential comes from beyond asking this host for one.
      ports: {
        previewPaperToZotero: (input, secret) => integrations.previewPaperToZotero({ ...input, secret }),
        executePaperToZotero: (input, secret, profileId) => integrations.executeZoteroImport(input, secret, profileId),
        previewStagingToZotero: (input, secret) => literature.previewStagingToZotero(input, integrations, secret),
        executeStagingToZotero: (input, secret, profileId) => literature.executeStagingToZotero(input, integrations, secret, profileId),
        readNote: (input) => integrations.readNote(input),
        writeNote: (input) => integrations.writeNote(input),
        previewNoteMetadata: (input) => integrations.previewNoteMetadata(input),
        applyNoteMetadata: (input) => integrations.applyNoteMetadata(input)
      },
      requestIntegrationSecret: (profileId) => readIntegrationSecret(options.parentPort, pendingIntegrationReads, profileId)
    }),
    agent: new AgentCoordinator(repository, {
      runRoot: join(dirname(options.databasePath), 'agent-runs'),
      // App-owned runtime profiles live beside the database, never in the user's
      // `~/.codex`/`~/.pi`. A probe or run therefore cannot inherit a personal
      // login by accident.
      runtimeProfileRoot: join(dirname(options.databasePath), 'agent-runtime'),
      serviceInfoPath: options.serviceInfoPath,
      agentRuntime: runtimeAdapter,
      requestCredential: (provider) => readCredential(options.parentPort, pendingCredentialReads, provider),
      persistScheduledOutput: (input) => persistScheduledOutput(integrations, input),
      // Normalized ledger records leave the Core process over the same parent
      // port as RPC responses. The desktop Main process decides which renderer
      // window subscribed to which run before forwarding anything.
      publishLedger: (push) => options.parentPort.postMessage({ type: 'agent-ledger', push })
    }),
    models: new AgentModelCoordinator(repository, {
      profileDir: runtimeProfileDir,
      publishAuthEvent: (event: AgentAuthEvent) => {
        options.parentPort.postMessage({ type: 'agent-auth', event })
        // A browser can only be opened by the Electron Main process, so the one
        // place that knows the user has to visit a page announces it here. Both
        // interactive flows need this: an OAuth redirect flow would otherwise
        // sit on a link the user has to notice, and a device-code flow is stuck
        // until the verification page is open. Main re-validates the URL against
        // the shared allowlist before handing it to the OS.
        const url = authEventUrl(event)
        if (url !== null) options.parentPort.postMessage({ type: 'open-external', url })
      },
      persistCredential: credentialSink
    })
  }
  const scheduleTimer = setInterval(() => { void services.agent.tickSchedules() }, 30_000)
  scheduleTimer.unref?.()
  services.agent.reconcileInterruptedRuns()
  void services.agent.tickSchedules()
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    clearInterval(scheduleTimer)
    services.agent.dispose()
    repository.close()
    pipeServer?.close()
    if (options.serviceInfoPath) {
      try { unlinkSync(options.serviceInfoPath) } catch { /* already removed */ }
    }
  }

  const pipeServer = options.pipePath && options.handshakeToken
    ? createPipeServer(options, services)
    : undefined

  options.parentPort.on('message', (event) => {
    if (isShutdownMessage(event.data)) {
      close()
      options.parentPort.postMessage({ type: 'shutdown-complete' })
      setImmediate(() => options.exit?.())
      return
    }
    void dispatchMessage(services, { version: options.version }, event.data).then((response) => {
      options.parentPort.postMessage(response)
    })
  })
  options.parentPort.postMessage({ type: 'ready' })
  // The embedded Pi SDK is loaded on first use, which costs seconds of module
  // compilation inside this process. Start it now so the cost lands during boot
  // instead of on the first Settings visit or the first Agent run.
  void services.models.warmup()

  process.once('exit', close)
  process.once('SIGTERM', () => {
    close()
    options.exit?.()
  })
}

async function persistScheduledOutput(
  integrations: IntegrationCoordinator,
  input: {
    readonly scheduleId: string
    readonly run: AgentRunRecord
    readonly content: string
    readonly outputFolder?: string | undefined
    readonly skillKey?: string | null | undefined
    readonly scheduleName?: string | undefined
    readonly timezone?: string | undefined
    readonly topic?: string | undefined
    readonly sources?: readonly string[] | undefined
    readonly lookbackDays?: number | undefined
  }
): Promise<DailyLiteratureDelivery> {
  // One shared delivery path for the safe write: it decides the folder, the
  // `YYYY-MM-DD-daily_digest-<schedule8>-<run8>.md` name and the frontmatter, so
  // the host cannot drift away from the coordinator's expectations. A skipped
  // (not-written) result is returned instead of thrown so the run can report the
  // concrete degrade reason; a real write failure still throws and is reported
  // as OBSIDIAN_DAILY_NOTE_SKIPPED with WRITE_FAILED.
  return deliverDailyLiterature(integrations, input)
}

function createPipeServer(
  options: WorkspaceServiceHostOptions,
  services: WorkspaceServices
) {
  const pipePath = options.pipePath!
  const handshakeToken = options.handshakeToken!
  const server = createServer((socket) => handleSocket(socket, options.version, handshakeToken, services))
  try { unlinkSync(pipePath) } catch { /* stale Unix socket or Windows pipe */ }
  server.listen(pipePath)
  if (options.serviceInfoPath) {
    mkdirSync(dirname(options.serviceInfoPath), { recursive: true })
    writeFileSync(options.serviceInfoPath, `${JSON.stringify({ endpoint: pipePath, token: handshakeToken })}\n`, { encoding: 'utf8', mode: 0o600 })
  }
  return server
}

function handleSocket(
  socket: Socket,
  version: string,
  handshakeToken: string,
  services: WorkspaceServices
): void {
  let authenticated = false
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      let message: unknown
      try { message = JSON.parse(line) } catch { socket.end(); return }
      if (!authenticated) {
        if (!isHandshake(message) || message.token !== handshakeToken) { socket.end(); return }
        authenticated = true
        socket.write(`${JSON.stringify({ type: 'ready', version })}\n`)
        continue
      }
      void dispatchMessage(services, { version }, message).then((response) => socket.write(JSON.stringify(response) + '\n'))
    }
  })
}

async function dispatchMessage(
  services: WorkspaceServices,
  metadata: { version: string },
  input: unknown,
  context?: AgentCallContext
) {
  if (isAgentMessage(input)) {
    // Main may wrap an Agent RPC in its private credential envelope. The
    // credentials are used for this single dispatch and never persisted; without
    // the envelope the coordinator fails closed instead of reusing a CLI login.
    const envelope = AgentCredentialEnvelopeSchema.safeParse(input)
    if (envelope.success) {
      return dispatchAgentRpc(services, metadata, envelope.data.request, providerKeyedCredentials(parsedCredentials(envelope.data.credentials)))
    }
    return dispatchAgentRpc(services, metadata, input, noAgentCredentials)
  }
  return dispatchRpc(services, metadata, input, context)
}

/**
 * Keep the credential for the provider the run is actually aimed at.
 *
 * Pi identifies a credential by the provider that issued it, not by the runtime
 * name, so the lookup is keyed by provider id. `all` stays available for the two
 * cases that must answer before a model is chosen: a readiness probe, and a
 * fallback model that needs its own credential.
 */
function providerKeyedCredentials(credentials: readonly AgentRunCredentialInput[]): AgentCredentialSource {
  return {
    all: credentials,
    get: (provider) => credentials.find((entry) => entry.provider === provider) ?? null
  }
}

/** Validate what Main attached before it can reach Pi's auth path. A dropped
 * entry degrades to "not configured" instead of producing a provider-side
 * error, and the credential is still never persisted or logged here. */
function parsedCredentials(entries: readonly { readonly provider: string; readonly credential: Record<string, unknown> }[]): AgentRunCredentialInput[] {
  return parseRuntimeCredentials(entries)
}

function isAgentMessage(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  // Main's private envelope carries the RPC under `request`.
  const candidate = 'request' in value && typeof value.request === 'object' && value.request !== null && 'method' in value.request
    ? value.request
    : value
  if (!('method' in candidate)) return false
  const method = (candidate as { method?: unknown }).method
  return typeof method === 'string' && (method.startsWith('agent.') || method.startsWith('automation.') || method.startsWith('inbox.ai.'))
}

function isHandshake(message: unknown): message is { type: 'handshake'; token: string } {
  return typeof message === 'object' && message !== null && 'type' in message && message.type === 'handshake' && 'token' in message && typeof message.token === 'string'
}

/** One credential write waiting on Electron Main. */
interface PendingCredentialWrite {
  readonly resolve: () => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * Persist one provider credential through Electron Main.
 *
 * Core never touches `safeStorage`, so a login or an OAuth refresh only becomes
 * real once Main acknowledges the disk write. The promise intentionally stays
 * unresolved until then: continuing on an unacknowledged credential would make
 * the run work and the next launch fail. The timeout is the release valve for a
 * Main process that is already gone.
 */
function writeCredential(
  parentPort: ServiceParentPort,
  pending: Map<string, PendingCredentialWrite>,
  providerId: string,
  credential: Parameters<AgentCredentialBridge['persist']>[1]
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const requestId = randomUUID()
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error('凭据写入超时：Main 未确认 safeStorage 写入'))
    }, credentialWriteTimeoutMs)
    timer.unref?.()
    pending.set(requestId, { resolve, reject, timer })
    parentPort.postMessage({ type: 'credential-write', requestId, provider: providerId, credential })
  })
}

function parseCredentialAck(value: unknown): { requestId: string; ok: boolean; error?: string } | null {
  if (typeof value !== 'object' || value === null) return null
  if (!('type' in value) || value.type !== 'credential-ack') return null
  if (!('requestId' in value) || typeof value.requestId !== 'string') return null
  if (!('ok' in value) || typeof value.ok !== 'boolean') return null
  const error = 'error' in value && typeof value.error === 'string' ? value.error : undefined
  return error === undefined ? { requestId: value.requestId, ok: value.ok } : { requestId: value.requestId, ok: value.ok, error }
}

/**
 * Read one integration profile's secret from Electron Main.
 *
 * Scoped to a single profile id for the same reason the provider read is scoped
 * to a provider: a request must not be able to authenticate as a connection the
 * user never pointed it at. `null` is a normal answer — a Local-API Zotero
 * profile stores no key — and is never cached here.
 */
function readIntegrationSecret(
  parentPort: ServiceParentPort,
  pending: Map<string, PendingIntegrationSecretRead>,
  profileId: string
): Promise<string | null> {
  if (profileId === '') return Promise.resolve(null)
  return new Promise<string | null>((resolve, reject) => {
    const requestId = randomUUID()
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error('集成凭据读取超时：Main 未返回 safeStorage 中的连接凭据'))
    }, credentialWriteTimeoutMs)
    timer.unref?.()
    pending.set(requestId, { resolve, reject, timer })
    parentPort.postMessage({ type: 'integration-credential-read', requestId, profileId })
  })
}

/**
 * Validate what Main returned for one integration secret.
 *
 * Same trust boundary as the provider read: the value crosses a process boundary
 * and is handed to a connector as an authorization header. A malformed answer is
 * dropped, which leaves the write failing on its own connection check instead of
 * being signed with a value nobody can name.
 */
export function parseIntegrationCredentialResult(
  value: unknown
): { requestId: string; ok: true; secret: string | null } | { requestId: string; ok: false; error?: string } | null {
  if (typeof value !== 'object' || value === null) return null
  if (!('type' in value) || value.type !== 'integration-credential-result') return null
  if (!('requestId' in value) || typeof value.requestId !== 'string') return null
  if (!('ok' in value) || typeof value.ok !== 'boolean') return null
  if (!value.ok) {
    const error = 'error' in value && typeof value.error === 'string' ? value.error : undefined
    return error === undefined ? { requestId: value.requestId, ok: false } : { requestId: value.requestId, ok: false, error }
  }
  const secret = 'secret' in value ? value.secret : null
  if (secret === null || secret === undefined || secret === '') return { requestId: value.requestId, ok: true, secret: null }
  if (typeof secret !== 'string') return null
  return { requestId: value.requestId, ok: true, secret }
}

/** One integration-secret read waiting on Electron Main. */
interface PendingIntegrationSecretRead {
  readonly resolve: (secret: string | null) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** One credential read waiting on Electron Main. */
interface PendingCredentialRead {
  readonly resolve: (credential: AgentRunCredentialInput | null) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * Read one provider credential from Electron Main.
 *
 * `read` deliberately stays provider-scoped: a scheduled run knows the provider
 * of the model it selected, and asking for "any credential" would let a rule
 * authenticate as a provider the user never pointed it at. A missing provider
 * fails closed without a round trip.
 */
function readCredential(
  parentPort: ServiceParentPort,
  pending: Map<string, PendingCredentialRead>,
  provider: string | null
): Promise<AgentRunCredentialInput | null> {
  if (provider === null || provider === '') return Promise.resolve(null)
  return new Promise<AgentRunCredentialInput | null>((resolve, reject) => {
    const requestId = randomUUID()
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error('凭据读取超时：Main 未返回 safeStorage 中的凭据'))
    }, credentialWriteTimeoutMs)
    timer.unref?.()
    pending.set(requestId, { resolve, reject, timer })
    parentPort.postMessage({ type: 'credential-read', requestId, provider })
  })
}

/**
 * Validate what Main returned for one credential read.
 *
 * This is a trust boundary: the answer crosses a process boundary and is fed to
 * Pi as an authentication token. Anything malformed is dropped, which leaves the
 * requesting run fail-closed (`AGENT_CREDENTIAL_MISSING`) rather than
 * authenticating with a value nobody can name.
 */
export function parseCredentialResult(value: unknown): { requestId: string; ok: true; credential: AgentRunCredentialInput | null } | { requestId: string; ok: false; error?: string } | null {
  if (typeof value !== 'object' || value === null) return null
  if (!('type' in value) || value.type !== 'credential-result') return null
  if (!('requestId' in value) || typeof value.requestId !== 'string') return null
  if (!('ok' in value) || typeof value.ok !== 'boolean') return null
  if (!value.ok) {
    const error = 'error' in value && typeof value.error === 'string' ? value.error : undefined
    return error === undefined ? { requestId: value.requestId, ok: false } : { requestId: value.requestId, ok: false, error }
  }
  const provider = 'provider' in value ? value.provider : null
  const credential = 'credential' in value ? value.credential : null
  if (credential === null || credential === undefined) return { requestId: value.requestId, ok: true, credential: null }
  if (typeof provider !== 'string' || provider === '') return null
  if (typeof credential !== 'object' || Array.isArray(credential)) return null
  return {
    requestId: value.requestId,
    ok: true,
    credential: { provider, credential: credential as AgentRunCredentialInput['credential'] }
  }
}

const credentialWriteTimeoutMs = 10_000

function isShutdownMessage(message: unknown): message is { type: 'shutdown' } {
  return typeof message === 'object'
    && message !== null
    && 'type' in message
    && message.type === 'shutdown'
}
