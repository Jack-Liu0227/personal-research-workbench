import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { WorkbenchRepository } from '@prw/database'
import { AgentCredentialEnvelopeSchema, type AgentRunRecord, type AgentRuntimeKind } from '@prw/contracts'
import { dispatchAgentRpc } from './agent-dispatcher.js'
import { dispatchRpc } from './dispatcher.js'
import { AgentCoordinator } from './agent-coordinator.js'
import { deliverDailyLiterature, type DailyLiteratureDelivery } from './daily-literature.js'
import { IntegrationCoordinator } from './integration-runtime.js'
import { LiteratureCoordinator } from './literature-runtime.js'
import { KnowledgeEngineCoordinator } from './knowledge-engines.js'

export interface ServiceParentPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
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

/**
 * Process-independent business host. Electron's UtilityProcess is only the
 * current transport; MCP can connect to the same service contract later.
 */
export function startWorkspaceService(options: WorkspaceServiceHostOptions): void {
  const repository = new WorkbenchRepository({ filePath: options.databasePath })
  const integrations = new IntegrationCoordinator(repository)
  const services = {
    repository,
    integrations,
    literature: new LiteratureCoordinator(repository),
    knowledgeEngines: new KnowledgeEngineCoordinator(repository),
    agent: new AgentCoordinator(repository, {
      runRoot: join(dirname(options.databasePath), 'agent-runs'),
      // App-owned CLI profiles live beside the database, never in the user's
      // `~/.codex`/`~/.pi`. A probe or run therefore cannot inherit a personal
      // CLI login by accident.
      runtimeProfileRoot: join(dirname(options.databasePath), 'agent-runtime'),
      serviceInfoPath: options.serviceInfoPath,
      persistScheduledOutput: (input) => persistScheduledOutput(integrations, input),
      // Normalized ledger records leave the Core process over the same parent
      // port as RPC responses. The desktop Main process decides which renderer
      // window subscribed to which run before forwarding anything.
      publishLedger: (push) => options.parentPort.postMessage({ type: 'agent-ledger', push })
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
  services: Parameters<typeof dispatchRpc>[0] & { agent: AgentCoordinator }
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
  services: Parameters<typeof dispatchRpc>[0] & { agent: AgentCoordinator }
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
  services: Parameters<typeof dispatchRpc>[0] & { agent: AgentCoordinator },
  metadata: { version: string },
  input: unknown
) {
  if (isAgentMessage(input)) {
    // Main may wrap an Agent RPC in its private credential envelope. The
    // secret is used for this single dispatch and never persisted; without the
    // envelope the coordinator fails closed instead of reusing a CLI login.
    const envelope = AgentCredentialEnvelopeSchema.safeParse(input)
    if (envelope.success) {
      return dispatchAgentRpc(services, metadata, envelope.data.request, credentialResolver(envelope.data.credentials))
    }
    return dispatchAgentRpc(services, metadata, input, () => null)
  }
  return dispatchRpc(services, metadata, input)
}

/** Resolve the credential Main attached for the runtime this run selected. */
function credentialResolver(
  credentials: ReadonlyArray<{ readonly runtime: AgentRuntimeKind; readonly provider: string; readonly secret: string }>
): (runtime: AgentRuntimeKind) => { readonly provider: string; readonly secret: string } | null {
  return (runtime) => credentials.find((entry) => entry.runtime === runtime) ?? null
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

function isShutdownMessage(message: unknown): message is { type: 'shutdown' } {
  return typeof message === 'object'
    && message !== null
    && 'type' in message
    && message.type === 'shutdown'
}
