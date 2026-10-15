import { createHash, randomUUID } from 'node:crypto'
import {
  AgentMcpCallDecideInputSchema, AgentMcpToolSchema, AgentResourcePayloadSchemas, isBoundedAgentResourceJson,
  type AgentMcpCall, type AgentMcpCallDecideInput, type AgentMcpServer, type AgentMcpTool,
  type AgentAssistant, type AgentRunRecord, type AgentRunRecordDraft
} from '@prw/contracts'
import { WorkbenchDatabaseError, type WorkbenchRepository } from '@prw/database'
import { openControlledMcpClient, validateMcpEndpoint, type AgentExternalRequestTool } from '@prw/agent-runtime'

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const invalid = (message: string): never => { throw new WorkbenchDatabaseError('VALIDATION_FAILED', message) }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function containsSecret(root: unknown, secret: string): boolean {
  const pending: unknown[] = [root]
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value === 'string' && value.includes(secret)) return true
    if (value !== null && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        if (key.includes(secret)) return true
        pending.push(entry)
      }
    }
  }
  return false
}

// No references, regex, custom formats or executable schema compilation. This
// bounded subset is interpreted below before any untrusted argument is queued.
const schemaKeywords = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', '$schema',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems',
  'minProperties', 'maxProperties', 'anyOf', 'oneOf', 'allOf'])
function validateSchema(schema: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (depth === 0 && !isBoundedAgentResourceJson(schema)) invalid('MCP schema exceeds JSON complexity limits.')
  if (++budget.nodes > 1024 || depth > 12 || !object(schema)) invalid('Unsupported or excessive MCP input schema.')
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (!schemaKeywords.has(key)) invalid('MCP schema uses an unsupported keyword; references and patterns are disabled.')
    if (key === 'properties') {
      if (!object(value) || Object.keys(value).length > 100) invalid('Invalid MCP schema properties.')
      for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
        if (name.length > 100 || ['__proto__', 'constructor', 'prototype'].includes(name)) invalid('Unsafe MCP property name.')
        validateSchema(child, depth + 1, budget)
      }
    } else if (key === 'items' || (key === 'additionalProperties' && typeof value !== 'boolean')) {
      validateSchema(value, depth + 1, budget)
    } else if (['anyOf', 'oneOf', 'allOf'].includes(key)) {
      if (!Array.isArray(value) || value.length < 1 || value.length > 8) invalid('Invalid MCP schema union.')
      for (const child of value as unknown[]) validateSchema(child, depth + 1, budget)
    } else if (key === 'type') {
      const types = Array.isArray(value) ? value : [value]
      if (types.length > 7 || types.some((type) => !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(type))))
        invalid('Unsupported MCP schema type.')
    } else if (key === 'required') {
      if (!Array.isArray(value) || value.length > 100 || value.some((entry) => typeof entry !== 'string')) invalid('Invalid required fields.')
    } else if (key === 'enum') {
      if (!Array.isArray(value) || value.length < 1 || value.length > 100) invalid('Invalid MCP enum.')
    } else if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'].includes(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) invalid('Invalid MCP schema constraint.')
    }
  }
}
function matches(schema: Record<string, unknown>, value: unknown, depth = 0): boolean {
  if (depth > 20) return false
  if (Array.isArray(schema['enum']) && !schema['enum'].some((entry) => canonical(entry) === canonical(value))) return false
  if (Object.hasOwn(schema, 'const') && canonical(schema['const']) !== canonical(value)) return false
  for (const kind of ['allOf', 'anyOf', 'oneOf']) {
    const children = schema[kind]
    if (Array.isArray(children)) {
      const count = children.filter((child) => matches(child as Record<string, unknown>, value, depth + 1)).length
      if ((kind === 'allOf' && count !== children.length) || (kind === 'anyOf' && count === 0) || (kind === 'oneOf' && count !== 1)) return false
    }
  }
  const types = schema['type'] === undefined ? [] : Array.isArray(schema['type']) ? schema['type'] : [schema['type']]
  if (types.length > 0 && !types.some((type) => type === 'null' ? value === null : type === 'object' ? object(value)
    : type === 'array' ? Array.isArray(value) : type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
    : typeof value === type)) return false
  if (typeof value === 'string') {
    const length = [...value].length
    if ((typeof schema['minLength'] === 'number' && length < schema['minLength']) ||
        (typeof schema['maxLength'] === 'number' && length > schema['maxLength'])) return false
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (typeof schema['minimum'] === 'number' && value < schema['minimum']) ||
      (typeof schema['maximum'] === 'number' && value > schema['maximum']) ||
      (typeof schema['exclusiveMinimum'] === 'number' && value <= schema['exclusiveMinimum']) ||
      (typeof schema['exclusiveMaximum'] === 'number' && value >= schema['exclusiveMaximum'])) return false
  }
  if (Array.isArray(value)) {
    if ((typeof schema['minItems'] === 'number' && value.length < schema['minItems']) ||
        (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems'])) return false
    if (object(schema['items']) && value.some((entry) => !matches(schema['items'] as Record<string, unknown>, entry, depth + 1))) return false
  }
  if (object(value)) {
    if ((typeof schema['minProperties'] === 'number' && Object.keys(value).length < schema['minProperties']) ||
        (typeof schema['maxProperties'] === 'number' && Object.keys(value).length > schema['maxProperties'])) return false
    const properties = object(schema['properties']) ? schema['properties'] : {}
    if (Array.isArray(schema['required']) && schema['required'].some((key) => !Object.hasOwn(value, String(key)))) return false
    for (const [key, entry] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) return false
      if (Object.hasOwn(properties, key)) {
        if (!matches(properties[key] as Record<string, unknown>, entry, depth + 1)) return false
      } else if (schema['additionalProperties'] === false ||
        (object(schema['additionalProperties']) && !matches(schema['additionalProperties'], entry, depth + 1))) return false
    }
  }
  return true
}

export interface AgentResourceCoordinatorOptions {
  readonly repository: WorkbenchRepository
  readonly readSecret: (versionedServerId: string) => Promise<string | null>
  readonly recordLedger?: ((runId: string, draft: AgentRunRecordDraft) => void) | undefined
  readonly now?: (() => Date) | undefined
  readonly timeoutMs?: number | undefined
}

/** Third-party servers are never trusted workspace tools; Pi can only queue a request. */
export class AgentResourceCoordinator {
  private readonly controllers = new Map<string, { serverId: string; runId: string | null; abort: AbortController }>()
  private disposed = false
  constructor(private readonly options: AgentResourceCoordinatorOptions) {}
  private get repository() { return this.options.repository }
  private get resources() { return this.repository.agentResources }
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString() }

  async probe(inputValue: unknown): Promise<AgentMcpServer> {
    const input = AgentResourcePayloadSchemas['agentMcpServers.probe'].parse(inputValue)
    const server = this.resources.getMcpServer(input.id)
    if (server.revision !== input.expectedRevision) throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'MCP server changed.')
    if (!server.enabled || server.archivedAt || this.disposed) invalid('MCP server is disabled or unavailable.')
    this.cancelServer(server.id)
    const id = randomUUID()
    const abort = new AbortController()
    this.controllers.set(id, { serverId: server.id, runId: null, abort })
    let connection: Awaited<ReturnType<typeof openControlledMcpClient>> | undefined
    try {
      const secret = await this.options.readSecret(`${server.id}:r${server.revision}`)
      abort.signal.throwIfAborted()
      connection = await openControlledMcpClient({ endpoint: server.endpoint, bearer: secret, signal: abort.signal, timeoutMs: this.options.timeoutMs })
      const tools: AgentMcpTool[] = []
      const cursors = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await connection.client.listTools(cursor ? { cursor } : undefined, { signal: abort.signal, timeout: 20_000 })
        for (const tool of page.tools) {
          validateSchema(tool.inputSchema)
          if (tool.inputSchema.type !== 'object') invalid('MCP tool input must be an object.')
          const schemaHash = hash(canonical(tool.inputSchema))
          const key = `${server.id}.${hash(`${server.revision}:${server.endpoint}:${tool.name}:${schemaHash}`).slice(0, 24)}`
          const saved = AgentMcpToolSchema.parse({ key, name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema, schemaHash })
          if (secret && containsSecret(saved, secret)) invalid('MCP discovery contains a credential.')
          tools.push(saved)
          if (tools.length > 64 || tools.some((entry, index) => tools.findIndex((other) => entry.name === other.name) !== index)) invalid('MCP tool count or identities exceed limits.')
        }
        cursor = page.nextCursor
        if (cursor && (cursor.length > 1024 || cursors.has(cursor) || cursors.size >= 8)) invalid('Invalid MCP pagination.')
        if (cursor) cursors.add(cursor)
      } while (cursor)
      const otherCount = this.resources.listMcpServers().filter((other) => other.id !== server.id).reduce((count, other) => count + other.tools.length, 0)
      if (otherCount + tools.length > 64) invalid('At most 64 third-party MCP tools may be discovered globally.')
      return this.resources.setMcpServerProbe({ id: server.id, expectedRevision: server.revision, tools, probedAt: this.now() })
    } catch {
      return this.resources.setMcpServerProbe({ id: server.id, expectedRevision: server.revision, tools: [], probedAt: this.now(), diagnosticCode: 'MCP_PROBE_FAILED' })
    } finally { await connection?.close(); this.controllers.delete(id) }
  }

  toolsForRun(assistant: AgentAssistant | null, run: AgentRunRecord): AgentExternalRequestTool[] {
    if (this.disposed || !assistant || run.jobId || run.teamRunId || run.toolProfile !== 'approved-write' ||
        run.permissionMode === 'read-only' || assistant.toolProfile !== 'approved-write') return []
    const tools: AgentExternalRequestTool[] = []
    for (const server of this.resources.listMcpServers()) {
      if (!server.enabled || server.archivedAt || server.lastProbe?.status !== 'ok') continue
      for (const tool of server.tools) {
        if (!assistant.toolAllowlist.includes(tool.key)) continue
        tools.push({ name: tool.key, description: `UNTRUSTED third-party tool; only queues a request for separate human approval. ${tool.description}`,
          inputSchema: tool.inputSchema, request: async (args, signal) => {
            signal?.throwIfAborted()
            const call = this.request(server, tool, run.id, assistant.id, args)
            return `Pending MCP request ${call.id}. No remote call has executed. The user must review and approve this exact call separately.`
          } })
      }
    }
    return tools
  }

  private request(server: AgentMcpServer, tool: AgentMcpTool, runId: string, assistantId: string, args: unknown): AgentMcpCall {
    if (this.disposed) invalid('MCP coordinator is closed.')
    const run = this.repository.getManagedAgentRun(runId)
    const current = this.resources.getMcpServer(server.id)
    if (!['running', 'waiting_confirmation'].includes(run.status) || run.assistantId !== assistantId || run.jobId || run.teamId || run.teamRunId ||
      run.toolProfile !== 'approved-write' || run.permissionMode === 'read-only' || current.revision !== server.revision ||
      current.endpoint !== server.endpoint || !current.enabled || current.archivedAt ||
      !current.tools.some((entry) => entry.key === tool.key && entry.schemaHash === tool.schemaHash)) invalid('MCP run or server authorization changed.')
    if (!object(args) || !isBoundedAgentResourceJson(args)) invalid('MCP arguments must be a bounded JSON object.')
    const argumentsJson = canonical(args)
    if (Buffer.byteLength(argumentsJson, 'utf8') > 32768 || !matches(tool.inputSchema, args)) invalid('MCP arguments do not match the frozen schema or size bound.')
    const now = this.now()
    const call = this.resources.createMcpCall({ id: randomUUID(), runId, assistantId, serverId: server.id,
      serverRevision: server.revision, endpoint: server.endpoint, toolKey: tool.key, toolName: tool.name,
      schemaHash: tool.schemaHash, argumentsJson, argsHash: hash(argumentsJson), status: 'pending', result: '', error: null,
      createdAt: now, updatedAt: now, expiresAt: new Date(Date.parse(now) + 30 * 60_000).toISOString() })
    this.receipt(call)
    return call
  }

  async decide(inputValue: AgentMcpCallDecideInput): Promise<AgentMcpCall> {
    if (this.disposed) invalid('MCP coordinator is closed.')
    const input = AgentMcpCallDecideInputSchema.parse(inputValue)
    const call = this.resources.claimMcpCall({ ...input, now: this.now() })
    if (call.status === 'rejected') { this.receipt(call); return call }
    const abort = new AbortController()
    this.controllers.set(call.id, { serverId: call.serverId, runId: call.runId, abort })
    let connection: Awaited<ReturnType<typeof openControlledMcpClient>> | undefined
    let secret: string | null = null
    try {
      secret = await this.options.readSecret(`${call.serverId}:r${call.serverRevision}`)
      abort.signal.throwIfAborted()
      // Recheck after Main's async credential read and before any remote traffic.
      this.assertExecuting(call)
      validateMcpEndpoint(call.endpoint)
      connection = await openControlledMcpClient({ endpoint: call.endpoint, bearer: secret, signal: abort.signal, timeoutMs: this.options.timeoutMs })
      abort.signal.throwIfAborted()
      this.assertExecuting(call)
      const result = await connection.client.callTool({ name: call.toolName, arguments: JSON.parse(call.argumentsJson) as Record<string, unknown> }, undefined,
        { signal: abort.signal, timeout: 20_000, maxTotalTimeout: 20_000 })
      // Do not store images, resource links, embedded resources or server metadata.
      const text = Array.isArray(result.content) ? result.content.flatMap((block) =>
        block.type === 'text' && typeof block.text === 'string' ? [block.text] : ['[non-text MCP content omitted]']).join('\n') : ''
      const redacted = secret ? text.split(secret).join('[redacted]') : text
      const completed = this.resources.completeMcpCall({ id: call.id, expectedRevision: call.revision,
        status: result.isError === true ? 'failed' : 'completed', result: redacted.slice(0, 32768),
        error: result.isError === true ? 'MCP server returned an error; the remote outcome is not retried.' : null, now: this.now() })
      this.receipt(completed)
      return completed
    } catch {
      const current = this.resources.getMcpCall(call.id)
      if (current.status !== 'executing') { this.receipt(current); return current }
      const failed = this.resources.completeMcpCall({ id: call.id, expectedRevision: current.revision, status: 'failed', result: '',
        error: 'MCP call failed or was canceled. The remote outcome may be unknown; it will not be replayed.', now: this.now() })
      this.receipt(failed)
      return failed
    } finally { await connection?.close(); this.controllers.delete(call.id) }
  }

  cancelServer(serverId: string): void {
    for (const entry of this.controllers.values()) if (entry.serverId === serverId) entry.abort.abort()
    this.resources.invalidateMcpCalls({ serverId, now: this.now(), reason: 'MCP server configuration or discovery changed.' })
  }
  private assertExecuting(call: AgentMcpCall): void {
    const current = this.resources.getMcpCall(call.id)
    const server = this.resources.getMcpServer(call.serverId)
    const run = this.repository.getManagedAgentRun(call.runId)
    const assistant = this.repository.agentProfiles.getAssistant(call.assistantId)
    if (current.status !== 'executing' || server.revision !== call.serverRevision || server.endpoint !== call.endpoint ||
      !server.enabled || server.archivedAt || server.lastProbe?.status !== 'ok' ||
      !server.tools.some((tool) => tool.key === call.toolKey && tool.name === call.toolName && tool.schemaHash === call.schemaHash) ||
      !['running', 'waiting_confirmation', 'completed'].includes(run.status) || run.jobId || run.teamId || run.teamRunId ||
      run.assistantId !== call.assistantId || run.toolProfile !== 'approved-write' || run.permissionMode === 'read-only' ||
      !assistant.enabled || assistant.archivedAt || assistant.toolProfile !== 'approved-write' || !assistant.toolAllowlist.includes(call.toolKey) ||
      call.expiresAt <= this.now()) invalid('MCP request authorization was invalidated.')
  }
  cancelRun(runId: string): void {
    for (const entry of this.controllers.values()) if (entry.runId === runId) entry.abort.abort()
    this.resources.invalidateMcpCalls({ runId, now: this.now(), reason: 'Agent run canceled or failed.' })
  }
  reconcile(): void { this.resources.invalidateMcpCalls({ now: this.now(), reason: 'App restarted; MCP calls are never replayed.' }) }
  dispose(): void {
    this.disposed = true
    for (const entry of this.controllers.values()) entry.abort.abort()
    this.reconcile()
  }
  private receipt(call: AgentMcpCall): void {
    const draft: AgentRunRecordDraft = { recordKey: `mcp:${call.id}`, kind: 'diagnostic',
      status: call.status === 'completed' ? 'completed' : call.status === 'failed' ? 'failed' : 'info',
      title: `MCP ${call.status}: ${call.toolName}`, detail: `Request ${call.id}; ${call.result || call.error || 'Remote call has not executed.'}`,
      startedAt: call.createdAt, ...(call.status !== 'pending' && call.status !== 'executing' ? { finishedAt: call.updatedAt } : {}) }
    if (this.options.recordLedger) this.options.recordLedger(call.runId, draft)
    else this.repository.upsertAgentRunRecord(call.runId, draft)
  }
}
