import { createHash, randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { AgentAssistantSchema, AgentAssistantSaveInputSchema, AgentAssistantArchiveInputSchema,
  AgentTeamSchema, AgentTeamSaveInputSchema, AgentTeamArchiveInputSchema, AgentTeamRunSchema,
  AgentTeamRunStartInputSchema, type AgentAssistant, type AgentAssistantSaveInput,
  AgentBindingMatrixSaveInputSchema, type AgentBindingMatrixSaveInput,
  type AgentTeam, type AgentTeamSaveInput, type AgentTeamRun, type AgentTeamRunStartInput } from '@prw/contracts'
import { WorkbenchDatabaseError } from './errors.js'

type Table = 'agent_assistants' | 'agent_teams' | 'agent_team_runs'
type RunPatch = Partial<Pick<AgentTeamRun, 'status' | 'childRunIds' | 'output' | 'error'>>

export class AgentProfileRepository {
  constructor(private readonly sqlite: BetterSqlite3.Database, private readonly now: () => Date,
    private readonly sanitize: (text: string) => string = (text) => text,
    private readonly defaults: () => { provider: string | null; model: string | null; thinking: string | null } = () => ({ provider: null, model: null, thinking: null })) {}
  private read(table: Table, id: string): Record<string, unknown> {
    const row = this.sqlite.prepare(`SELECT data_json FROM ${table} WHERE id = ?`).get(id) as { data_json: string } | undefined
    if (!row) throw new WorkbenchDatabaseError('NOT_FOUND', 'Agent configuration or run not found.')
    return JSON.parse(row.data_json) as Record<string, unknown>
  }
  private revision(current: { revision: number } | null, expected: number | null): void {
    if ((current === null && expected !== null) || (current !== null && current.revision !== expected))
      throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'Agent configuration changed; reload before saving.', { retryable: true })
  }
  private ids(table: 'agent_assistants' | 'agent_teams'): string[] {
    return (this.sqlite.prepare(`SELECT id FROM ${table} WHERE json_extract(data_json, '$.archivedAt') IS NULL ORDER BY id LIMIT 100`).all() as { id: string }[]).map((row) => row.id)
  }
  getAssistant(id: string): AgentAssistant {
    const data = this.read('agent_assistants', id)
    const bindings = this.sqlite.prepare('SELECT kind, binding_key FROM agent_assistant_bindings WHERE assistant_id = ? ORDER BY binding_key').all(id) as { kind: string; binding_key: string }[]
    return AgentAssistantSchema.parse({ ...data,
      toolAllowlist: bindings.filter((b) => b.kind === 'tool').map((b) => b.binding_key),
      skillKeys: bindings.filter((b) => b.kind === 'skill').map((b) => b.binding_key) })
  }
  listAssistants(): AgentAssistant[] { return this.ids('agent_assistants').map((id) => this.getAssistant(id)) }
  saveAssistant(value: AgentAssistantSaveInput): AgentAssistant {
    const input = AgentAssistantSaveInputSchema.parse(value)
    return this.sqlite.transaction(() => {
      const current = this.sqlite.prepare('SELECT 1 FROM agent_assistants WHERE id = ?').get(input.id) ? this.getAssistant(input.id) : null
      this.revision(current, input.expectedRevision)
      if (current?.archivedAt || (!current && this.listAssistants().length >= 100)) throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'Assistant is archived or limit reached.')
      const { expectedRevision: _, toolAllowlist, skillKeys, ...fields } = input
      const timestamp = this.now().toISOString()
      const data = { ...fields, archivedAt: null, createdAt: current?.createdAt ?? timestamp, updatedAt: timestamp, revision: current ? current.revision + 1 : 0 }
      this.sqlite.prepare('INSERT INTO agent_assistants (id, data_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json').run(input.id, JSON.stringify(data))
      this.sqlite.prepare('DELETE FROM agent_assistant_bindings WHERE assistant_id = ?').run(input.id)
      const insert = this.sqlite.prepare('INSERT INTO agent_assistant_bindings (assistant_id, kind, binding_key) VALUES (?, ?, ?)')
      for (const key of toolAllowlist) insert.run(input.id, 'tool', key)
      for (const key of skillKeys) insert.run(input.id, 'skill', key)
      return this.getAssistant(input.id)
    }).immediate()
  }
  saveBindingMatrix(value: AgentBindingMatrixSaveInput): AgentAssistant[] {
    const input = AgentBindingMatrixSaveInputSchema.parse(value)
    return this.sqlite.transaction(() => {
      const changes = input.updates.map((update) => {
        const current = this.getAssistant(update.assistantId)
        this.revision(current, update.expectedRevision)
        if (current.archivedAt) throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'Assistant is archived.')
        const { archivedAt: _, createdAt: __, updatedAt: ___, revision: ____, ...fields } = current
        return AgentAssistantSaveInputSchema.parse({ ...fields,
          ...(update.toolAllowlist === undefined ? {} : { toolAllowlist: update.toolAllowlist }),
          ...(update.skillKeys === undefined ? {} : { skillKeys: update.skillKeys }),
          expectedRevision: update.expectedRevision })
      })
      // All revisions are checked before writing; any later failure rolls back every binding.
      return changes.map((change) => this.saveAssistant(change))
    }).immediate()
  }
  private archive(table: 'agent_assistants' | 'agent_teams', id: string, data: object, revision: number): void {
    const timestamp = this.now().toISOString()
    this.sqlite.prepare(`UPDATE ${table} SET data_json=? WHERE id=?`).run(JSON.stringify({ ...data, archivedAt: timestamp, updatedAt: timestamp, revision: revision + 1 }), id)
  }
  archiveAssistant(value: unknown): null {
    const input = AgentAssistantArchiveInputSchema.parse(value)
    return this.sqlite.transaction(() => {
      const current = this.getAssistant(input.id)
      this.revision(current, input.expectedRevision)
      if (this.listTeams().some((t) => t.members.some((m) => m.assistantId === input.id))) throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'Remove the assistant from its teams before archiving.')
      const { toolAllowlist: _, skillKeys: __, ...data } = current
      this.archive('agent_assistants', input.id, data, current.revision)
      return null
    }).immediate()
  }
  getTeam(id: string): AgentTeam {
    const data = this.read('agent_teams', id)
    const rows = this.sqlite.prepare('SELECT assistant_id, role, instructions FROM agent_team_members WHERE team_id=? ORDER BY position').all(id) as { assistant_id: string; role: string; instructions: string }[]
    return AgentTeamSchema.parse({ ...data, members: rows.map((r) => ({ assistantId: r.assistant_id, role: r.role, instructions: r.instructions })) })
  }
  listTeams(): AgentTeam[] { return this.ids('agent_teams').map((id) => this.getTeam(id)) }
  saveTeam(value: AgentTeamSaveInput): AgentTeam {
    const input = AgentTeamSaveInputSchema.parse(value)
    return this.sqlite.transaction(() => {
      const current = this.sqlite.prepare('SELECT 1 FROM agent_teams WHERE id=?').get(input.id) ? this.getTeam(input.id) : null
      this.revision(current, input.expectedRevision)
      if (current?.archivedAt || (!current && this.listTeams().length >= 100)) throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'Team is archived or limit reached.')
      for (const member of input.members) if (this.getAssistant(member.assistantId).archivedAt) throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'Archived team member.')
      const { expectedRevision: _, members, ...fields } = input
      const timestamp = this.now().toISOString()
      const data = { ...fields, archivedAt: null, createdAt: current?.createdAt ?? timestamp, updatedAt: timestamp, revision: current ? current.revision + 1 : 0 }
      this.sqlite.prepare('INSERT INTO agent_teams (id, data_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json').run(input.id, JSON.stringify(data))
      this.sqlite.prepare('DELETE FROM agent_team_members WHERE team_id=?').run(input.id)
      const insert = this.sqlite.prepare('INSERT INTO agent_team_members (team_id, assistant_id, role, instructions, position) VALUES (?, ?, ?, ?, ?)')
      members.forEach((m, index) => insert.run(input.id, m.assistantId, m.role, m.instructions, index))
      return this.getTeam(input.id)
    }).immediate()
  }
  archiveTeam(value: unknown): null {
    const input = AgentTeamArchiveInputSchema.parse(value)
    return this.sqlite.transaction(() => {
      const current = this.getTeam(input.id)
      this.revision(current, input.expectedRevision)
      if (this.sqlite.prepare("SELECT 1 FROM agent_team_runs WHERE team_id=? AND json_extract(data_json, '$.status') IN ('queued','running')").get(input.id)) throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'Cancel active team runs first.')
      const { members: _, ...data } = current
      this.archive('agent_teams', input.id, data, current.revision)
      return null
    }).immediate()
  }
  startTeamRun(value: AgentTeamRunStartInput): AgentTeamRun {
    const input = AgentTeamRunStartInputSchema.parse(value)
    const fingerprint = createHash('sha256').update(JSON.stringify({ teamId: input.teamId,
      expectedRevision: input.expectedRevision, projectId: input.projectId,
      instructions: input.instructions })).digest('hex')
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.prepare('SELECT id, request_fingerprint FROM agent_team_runs WHERE idempotency_key=?').get(input.idempotencyKey) as { id: string; request_fingerprint: string } | undefined
      if (existing) {
        const run = this.getTeamRun(existing.id)
        if (existing.request_fingerprint !== fingerprint) throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'Idempotency key belongs to another request.')
        return run
      }
      const team = this.getTeam(input.teamId)
      this.revision(team, input.expectedRevision)
      if (!team.enabled || team.archivedAt) throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'Team is disabled or archived.')
      const assistants = team.members.map((m) => this.getAssistant(m.assistantId))
      if (assistants.some((a) => !a.enabled || a.archivedAt)) throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'Team member is disabled or archived.')
      const defaults = this.defaults()
      const effectiveAssistants = assistants.map((assistant) => {
        const inherits = assistant.provider === null && assistant.model === null
        return { ...assistant,
          provider: inherits ? defaults.provider : assistant.provider,
          model: inherits ? defaults.model : assistant.model,
          thinking: assistant.thinking ?? defaults.thinking
        }
      })
      const timestamp = this.now().toISOString()
      const run = AgentTeamRunSchema.parse({ id: randomUUID(), teamId: team.id, projectId: input.projectId, instructions: this.sanitize(input.instructions), idempotencyKey: input.idempotencyKey, status: 'queued', snapshot: { team, assistants: effectiveAssistants }, childRunIds: [], output: '', error: null, createdAt: timestamp, updatedAt: timestamp, revision: 0 })
      this.sqlite.prepare('INSERT INTO agent_team_runs (id, team_id, project_id, idempotency_key, request_fingerprint, data_json) VALUES (?, ?, ?, ?, ?, ?)').run(run.id, run.teamId, run.projectId, run.idempotencyKey, fingerprint, JSON.stringify(run))
      return run
    }).immediate()
  }
  getTeamRun(id: string): AgentTeamRun {
    const data = this.read('agent_team_runs', id)
    const row = this.sqlite.prepare('SELECT project_id FROM agent_team_runs WHERE id=?').get(id) as { project_id: string | null }
    return AgentTeamRunSchema.parse({ ...data, projectId: row.project_id })
  }
  listTeamRuns(limit = 30): AgentTeamRun[] {
    const rows = this.sqlite.prepare("SELECT id FROM agent_team_runs ORDER BY json_extract(data_json, '$.createdAt') DESC, id DESC LIMIT ?").all(Math.min(100, Math.max(1, limit))) as { id: string }[]
    return rows.map((row) => this.getTeamRun(row.id))
  }
  updateTeamRun(id: string, patch: RunPatch, expectedRevision?: number): AgentTeamRun {
    return this.sqlite.transaction(() => {
      const current = this.getTeamRun(id)
      if (expectedRevision !== undefined) this.revision(current, expectedRevision)
      // A child may settle its asynchronous startup after the parent was canceled.
      // Preserve the terminal decision but retain that child's audit link.
      if (!['queued', 'running'].includes(current.status)) {
        if (patch.childRunIds === undefined) return current
        const ids = patch.childRunIds
        if (ids.length < current.childRunIds.length || current.childRunIds.some((child, index) => ids[index] !== child))
          throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'Child run history is append-only.')
        patch = { childRunIds: ids }
      }
      const next = AgentTeamRunSchema.parse({ ...current, ...patch, output: patch.output === undefined ? current.output : this.sanitize(patch.output).slice(0, 100000), error: patch.error === undefined ? current.error : patch.error === null ? null : this.sanitize(patch.error).slice(0, 500), updatedAt: this.now().toISOString(), revision: current.revision + 1 })
      this.sqlite.prepare('UPDATE agent_team_runs SET data_json=? WHERE id=?').run(JSON.stringify(next), id)
      return next
    }).immediate()
  }
  reconcileTeamRuns(): number {
    const rows = this.sqlite.prepare("SELECT id FROM agent_team_runs WHERE json_extract(data_json, '$.status') IN ('queued','running')").all() as { id: string }[]
    for (const row of rows) this.updateTeamRun(row.id, { status: 'interrupted', error: 'Application stopped before completion; no automatic replay.' })
    return rows.length
  }
}
