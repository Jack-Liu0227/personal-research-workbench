import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { WorkbenchRepository } from '@prw/database'
import type { AgentRunRecord } from '@prw/contracts'
import { dispatchAgentRpc } from './agent-dispatcher.js'
import { dispatchRpc } from './dispatcher.js'
import { AgentCoordinator } from './agent-coordinator.js'
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
  input: { readonly scheduleId: string; readonly run: AgentRunRecord; readonly content: string; readonly outputFolder?: string; readonly skillKey?: string | null }
): Promise<void> {
  if (input.run.workflowKey !== 'daily_digest') return
  const profile = integrations.listObsidianProfiles().find((candidate) => candidate.enabled)
  if (!profile) throw new Error('未配置可用的 Obsidian Vault。请先在设置中连接 Obsidian。')
  const date = new Date(input.run.finishedAt ?? input.run.createdAt)
  const dateKey = Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : formatShanghaiDate(date)
  const slug = `${input.run.workflowKey}-${input.scheduleId.slice(0, 8)}`.replace(/[^A-Za-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'daily-digest'
  const relativePath = `${safeOutputFolder(input.outputFolder || '每日文献推送')}/${dateKey}-${slug}-${input.run.id.slice(0, 8)}.md`
  const markdown = [
    '---',
    'workbench_kind: daily_literature',
    `workbench_schedule_id: ${JSON.stringify(input.scheduleId)}`,
    `workbench_run_id: ${JSON.stringify(input.run.id)}`,
    `workbench_runtime: ${JSON.stringify(input.run.runtime)}`,
    `generated_at: ${JSON.stringify(input.run.finishedAt ?? input.run.createdAt)}`,
    '---',
    '',
    `# 每日 Agent 推送 · ${dateKey}`,
    '',
    input.content.trim(),
    '',
    `> 来源：工作台定时任务 ${input.scheduleId.slice(0, 8)} · 运行 ${input.run.id.slice(0, 8)}`,
    ''
  ].join('\n')
  await integrations.writeNote({ vaultId: profile.id, relativePath, content: markdown, expectedFingerprint: null })
}

function safeOutputFolder(value: string): string {
  const normalized = value.trim().replace(/[\\/]+/gu, '/').replace(/^\/+|\/+$/gu, '')
  if (!normalized || normalized === '.obsidian' || normalized.split('/').some((part) => part === '.obsidian' || part === '..' || part === '.')) {
    return '每日文献推送'
  }
  return normalized.slice(0, 180)
}

function formatShanghaiDate(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value)
  const year = parts.find((part) => part.type === 'year')?.value ?? '1970'
  const month = parts.find((part) => part.type === 'month')?.value ?? '01'
  const day = parts.find((part) => part.type === 'day')?.value ?? '01'
  return `${year}-${month}-${day}`
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
  if (isAgentMessage(input)) return dispatchAgentRpc(services, metadata, input)
  return dispatchRpc(services, metadata, input)
}

function isAgentMessage(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('method' in value)) return false
  const method = (value as { method?: unknown }).method
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
