import { createHash } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import {
  AgentMcpServerSchema, AgentMcpServerSaveInputSchema, AgentMcpServerRemoveInputSchema,
  AgentMcpToolSchema, AgentInstructionSkillSchema, AgentInstructionSkillSaveInputSchema,
  AgentInstructionSkillRemoveInputSchema, AgentMcpCallSchema, isBoundedAgentResourceJson,
  type AgentMcpServer, type AgentMcpServerSaveInput, type AgentMcpTool,
  type AgentInstructionSkill, type AgentInstructionSkillSaveInput, type AgentMcpCall
} from '@prw/contracts'
import { WorkbenchDatabaseError } from './errors.js'

type Table = 'agent_mcp_servers' | 'agent_instruction_skills' | 'agent_mcp_calls'
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

export class AgentResourceRepository {
  constructor(private readonly sqlite: BetterSqlite3.Database, private readonly now: () => Date,
    private readonly sanitize: (text: string) => string) {}
  private read(table: Table, id: string): unknown {
    const row = this.sqlite.prepare(`SELECT data_json FROM ${table} WHERE id=?`).get(id) as { data_json: string } | undefined
    if (!row) throw new WorkbenchDatabaseError('NOT_FOUND', 'Agent resource not found.')
    return JSON.parse(row.data_json)
  }
  private write<T extends { id: string }>(table: Table, value: T): void {
    this.sqlite.prepare(`INSERT INTO ${table}(id,data_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json`)
      .run(value.id, JSON.stringify(value))
  }
  private exists(table: Table, id: string): boolean { return !!this.sqlite.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id) }
  private ids(table: Table, active = true, limit = 32): string[] {
    return (this.sqlite.prepare(`SELECT id FROM ${table} ${active ? "WHERE json_extract(data_json,'$.archivedAt') IS NULL" : ''} ORDER BY id LIMIT ?`).all(limit) as { id: string }[]).map((row) => row.id)
  }
  private revision(current: { revision: number } | null, expected: number | null): void {
    if (current ? current.revision !== expected : expected !== null)
      throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'Agent resource changed; reload before saving.', { retryable: true })
  }
  getMcpServer(id: string): AgentMcpServer { return AgentMcpServerSchema.parse(this.read('agent_mcp_servers', id)) }
  listMcpServers(): AgentMcpServer[] { return this.ids('agent_mcp_servers').map((id) => this.getMcpServer(id)) }
  saveMcpServer(value: AgentMcpServerSaveInput): AgentMcpServer {
    const input = AgentMcpServerSaveInputSchema.parse(value)
    return this.sqlite.transaction(() => {
      const current = this.exists('agent_mcp_servers', input.id) ? this.getMcpServer(input.id) : null
      this.revision(current, input.expectedRevision)
      if (current?.archivedAt || (!current && this.listMcpServers().length >= 32))
        throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'Resource is archived or limit reached.')
      const { expectedRevision: _, ...fields } = input
      const timestamp = this.now().toISOString()
      const server = AgentMcpServerSchema.parse({ ...fields, tools: [], lastProbe: null,
        credentialPresent: false, archivedAt: null, createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp, revision: current ? current.revision + 1 : 0 })
      this.write('agent_mcp_servers', server)
      this.invalidateMcpCalls({ serverId: input.id, now: timestamp, reason: 'Server configuration changed.' })
      return server
    }).immediate()
  }
  setMcpServerProbe(input: { id: string; expectedRevision: number; tools: AgentMcpTool[]; probedAt: string; diagnosticCode?: string | null }): AgentMcpServer {
    return this.sqlite.transaction(() => {
      const current = this.getMcpServer(input.id)
      this.revision(current, input.expectedRevision)
      if (current.archivedAt) throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'Server is archived.')
      const tools = input.tools.map((tool) => AgentMcpToolSchema.parse(tool))
      if (new Set(tools.map((tool) => tool.key)).size !== tools.length || new Set(tools.map((tool) => tool.name)).size !== tools.length)
        throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'Duplicate MCP tool identity.')
      // Probe is metadata, not a config revision or fresh authorization.
      const server = AgentMcpServerSchema.parse({ ...current, tools,
        lastProbe: { status: input.diagnosticCode ? 'failed' : 'ok', checkedAt: input.probedAt, diagnosticCode: input.diagnosticCode ?? null }, updatedAt: input.probedAt })
      this.write('agent_mcp_servers', server)
      this.invalidateMcpCalls({ serverId: current.id, now: input.probedAt, reason: 'MCP tool discovery changed.' })
      return server
    }).immediate()
  }
  removeMcpServer(value: unknown): void {
    const input = AgentMcpServerRemoveInputSchema.parse(value)
    this.sqlite.transaction(() => {
      const current = this.getMcpServer(input.id)
      this.revision(current, input.expectedRevision)
      const timestamp = this.now().toISOString()
      this.write('agent_mcp_servers', AgentMcpServerSchema.parse({ ...current, archivedAt: timestamp, enabled: false, tools: [], lastProbe: null, updatedAt: timestamp, revision: current.revision + 1 }))
      this.invalidateMcpCalls({ serverId: input.id, now: timestamp, reason: 'Server removed.' })
    }).immediate()
  }
  getInstructionSkill(id: string): AgentInstructionSkill { return AgentInstructionSkillSchema.parse(this.read('agent_instruction_skills', id)) }
  listInstructionSkills(): AgentInstructionSkill[] { return this.ids('agent_instruction_skills').map((id) => this.getInstructionSkill(id)) }
  saveInstructionSkill(value: AgentInstructionSkillSaveInput): AgentInstructionSkill {
    const input = AgentInstructionSkillSaveInputSchema.parse(value)
    return this.sqlite.transaction(() => {
      const current = this.exists('agent_instruction_skills', input.id) ? this.getInstructionSkill(input.id) : null
      this.revision(current, input.expectedRevision)
      if (current?.archivedAt || (!current && this.listInstructionSkills().length >= 32))
        throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'Skill is archived or limit reached.')
      if (!/^---\r?\n[\s\S]{1,4000}?\r?\n---\r?\n[\s\S]+$/u.test(input.markdown)
        || !/^name:\s*\S.+$/mu.test(input.markdown.split(/\r?\n---\r?\n/u)[0] ?? ''))
        throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'SKILL.md must have bounded frontmatter with name and a body.')
      if (this.sanitize(input.markdown) !== input.markdown)
        throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'Skill instructions must not contain credentials.')
      const { expectedRevision: _, confirmed: _confirmed, ...fields } = input
      const timestamp = this.now().toISOString()
      const skill = AgentInstructionSkillSchema.parse({ ...fields, contentHash: hash(input.markdown),
        archivedAt: null, createdAt: current?.createdAt ?? timestamp, updatedAt: timestamp, revision: current ? current.revision + 1 : 0 })
      this.write('agent_instruction_skills', skill)
      if (current && current.contentHash !== skill.contentHash) {
        // Updated instructions require an explicit new binding, not silent trust inheritance.
        const rows = this.sqlite.prepare("SELECT assistant_id FROM agent_assistant_bindings WHERE kind='skill' AND binding_key=?").all(skill.id) as { assistant_id: string }[]
        this.sqlite.prepare("DELETE FROM agent_assistant_bindings WHERE kind='skill' AND binding_key=?").run(skill.id)
        for (const row of rows) this.sqlite.prepare("UPDATE agent_assistants SET data_json=json_set(data_json,'$.revision',json_extract(data_json,'$.revision')+1,'$.updatedAt',?) WHERE id=?").run(timestamp, row.assistant_id)
      }
      return skill
    }).immediate()
  }
  removeInstructionSkill(value: unknown): void {
    const input = AgentInstructionSkillRemoveInputSchema.parse(value)
    this.sqlite.transaction(() => {
      const current = this.getInstructionSkill(input.id)
      this.revision(current, input.expectedRevision)
      const timestamp = this.now().toISOString()
      this.write('agent_instruction_skills', AgentInstructionSkillSchema.parse({ ...current, enabled: false, archivedAt: timestamp, updatedAt: timestamp, revision: current.revision + 1 }))
    }).immediate()
  }
  getMcpCall(id: string): AgentMcpCall { return AgentMcpCallSchema.parse(this.read('agent_mcp_calls', id)) }
  listMcpCalls(input: { runId?: string; limit: number }): AgentMcpCall[] {
    const rows = this.sqlite.prepare(`SELECT data_json FROM agent_mcp_calls ${input.runId ? "WHERE json_extract(data_json,'$.runId')=?" : ''} ORDER BY json_extract(data_json,'$.createdAt') DESC LIMIT ?`)
      .all(...(input.runId ? [input.runId, input.limit] : [input.limit])) as { data_json: string }[]
    return rows.map((row) => AgentMcpCallSchema.parse(JSON.parse(row.data_json)))
  }
  createMcpCall(value: Omit<AgentMcpCall, 'revision'>): AgentMcpCall {
    const call = AgentMcpCallSchema.parse({ ...value, revision: 0 })
    if (call.status !== 'pending' || this.sanitize(call.argumentsJson) !== call.argumentsJson || hash(call.argumentsJson) !== call.argsHash)
      throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'Invalid or secret-bearing MCP request.')
    return this.sqlite.transaction(() => {
      this.validateMcpCallContext(call, this.now().toISOString(), false)
      this.sqlite.prepare('INSERT INTO agent_mcp_calls(id,data_json) VALUES(?,?)').run(call.id, JSON.stringify(call))
      return call
    }).immediate()
  }
  private validateMcpCallContext(call: AgentMcpCall, now: string, completedAllowed: boolean): void {
    let args: unknown
    try { args = JSON.parse(call.argumentsJson) } catch { args = null }
    const server = this.getMcpServer(call.serverId)
    const run = this.sqlite.prepare('SELECT agent_status AS status,team_run_id,team_id,job_id,assistant_id,tool_profile,permission_mode FROM agent_runs WHERE id=?')
      .get(call.runId) as { status: string; team_run_id: string | null; team_id: string | null; job_id: string | null; assistant_id: string | null; tool_profile: string; permission_mode: string } | undefined
    const assistant = this.sqlite.prepare('SELECT data_json FROM agent_assistants WHERE id=?').get(call.assistantId) as { data_json: string } | undefined
    const profile = assistant ? JSON.parse(assistant.data_json) as { enabled: boolean; archivedAt: string | null } : null
    const bound = this.sqlite.prepare("SELECT 1 FROM agent_assistant_bindings WHERE assistant_id=? AND kind='tool' AND binding_key=?").get(call.assistantId, call.toolKey)
    const tool = server.tools.find((entry) => entry.key === call.toolKey && entry.name === call.toolName)
    const statuses = completedAllowed ? ['running', 'waiting_confirmation', 'completed'] : ['running', 'waiting_confirmation']
    if (!args || Array.isArray(args) || typeof args !== 'object' || !isBoundedAgentResourceJson(args)
      || !run || !statuses.includes(run.status) || run.assistant_id !== call.assistantId || run.team_id || run.team_run_id || run.job_id
      || run.tool_profile !== 'approved-write' || run.permission_mode === 'read-only' || !profile?.enabled || profile.archivedAt || !bound
      || call.expiresAt <= now || !server.enabled || server.archivedAt || server.revision !== call.serverRevision
      || server.endpoint !== call.endpoint || tool?.schemaHash !== call.schemaHash || hash(call.argumentsJson) !== call.argsHash)
      throw new WorkbenchDatabaseError('CONFIRMATION_INVALID', 'MCP request expired or configuration/run changed.')
  }
  claimMcpCall(input: { id: string; expectedRevision: number; decision: 'approve' | 'reject'; now: string }): AgentMcpCall {
    return this.sqlite.transaction(() => {
      const current = this.getMcpCall(input.id)
      this.revision(current, input.expectedRevision)
      if (current.status !== 'pending') throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'MCP call has already been decided.')
      this.validateMcpCallContext(current, input.now, true)
      const call = AgentMcpCallSchema.parse({ ...current, status: input.decision === 'approve' ? 'executing' : 'rejected', updatedAt: input.now, revision: current.revision + 1 })
      this.write('agent_mcp_calls', call)
      return call
    }).immediate()
  }
  completeMcpCall(input: { id: string; expectedRevision: number; status: 'completed' | 'failed' | 'invalidated'; result: string; error: string | null; now: string }): AgentMcpCall {
    return this.sqlite.transaction(() => {
      const current = this.getMcpCall(input.id)
      this.revision(current, input.expectedRevision)
      if (current.status !== 'executing') throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'MCP call is not executing.')
      const call = AgentMcpCallSchema.parse({ ...current, status: input.status, result: this.sanitize(input.result).slice(0,32768),
        error: input.error === null ? null : this.sanitize(input.error).slice(0,500), updatedAt: input.now, revision: current.revision + 1 })
      this.write('agent_mcp_calls', call)
      return call
    }).immediate()
  }
  invalidateMcpCalls(input: { now: string; runId?: string; serverId?: string; reason: string }): number {
    const rows = this.sqlite.prepare("SELECT data_json FROM agent_mcp_calls WHERE json_extract(data_json,'$.status') IN ('pending','executing')").all() as { data_json: string }[]
    let count = 0
    for (const row of rows) {
      const current = AgentMcpCallSchema.parse(JSON.parse(row.data_json))
      if ((input.runId && current.runId !== input.runId) || (input.serverId && current.serverId !== input.serverId)) continue
      this.write('agent_mcp_calls', { ...current, status: 'invalidated', error: this.sanitize(input.reason).slice(0,500), updatedAt: input.now, revision: current.revision + 1 })
      count += 1
    }
    return count
  }
}
