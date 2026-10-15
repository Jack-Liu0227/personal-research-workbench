import { afterEach, test } from 'node:test'
import { strictEqual, deepStrictEqual, throws, ok } from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import { AgentAssistantSaveInputSchema, AgentBindingMatrixSaveInputSchema, AgentBindingSetInputSchema, AgentTeamSaveInputSchema, AgentTeamRunStartInputSchema, RpcRequestSchema } from '@prw/contracts'
import { WorkbenchRepository } from '../src/repository.ts'

const repositories: WorkbenchRepository[] = []
function open(filePath = ':memory:'): WorkbenchRepository {
  const repository = new WorkbenchRepository({ filePath })
  repositories.push(repository)
  return repository
}
function sql(repository: WorkbenchRepository): BetterSqlite3.Database {
  return (repository as unknown as { sqlite: BetterSqlite3.Database }).sqlite
}
function assistant(repository: WorkbenchRepository, id: string, tools: string[] = []) {
  return repository.agentProfiles.saveAssistant(AgentAssistantSaveInputSchema.parse({ id, name: id, toolAllowlist: tools, expectedRevision: null }))
}
function team(repository: WorkbenchRepository) {
  assistant(repository, 'assistant.director')
  assistant(repository, 'assistant.worker')
  return repository.agentProfiles.saveTeam(AgentTeamSaveInputSchema.parse({ id: 'team.test', name: 'Test team', expectedRevision: null,
    members: [{ assistantId: 'assistant.director', role: 'director' }, { assistantId: 'assistant.worker', role: 'researcher' }] }))
}
afterEach(() => { while (repositories.length) repositories.pop()?.close() })

test('migration 38 seeds a safe default without modifying legacy settings, with FK/integrity checks', () => {
  const repository = open()
  strictEqual((sql(repository).prepare('SELECT MAX(id) AS n FROM _prw_migrations').get() as { n: number }).n, 39)
  const seeded = repository.agentProfiles.getAssistant('assistant.default')
  strictEqual(seeded.toolProfile, 'read-only')
  deepStrictEqual(seeded.toolAllowlist, ['projects.search', 'tasks.search'])
  strictEqual(sql(repository).pragma('foreign_keys', { simple: true }), 1)
  deepStrictEqual(sql(repository).pragma('foreign_key_check'), [])
  strictEqual(sql(repository).pragma('integrity_check', { simple: true }), 'ok')
})

test('real v37 upgrade preserves old conversation/settings and restarts binding state', () => {
  const filePath = join(mkdtempSync(join(tmpdir(), 'prw-profile-upgrade-')), 'workspace.sqlite3')
  const repository = open(filePath)
  const conversation = repository.createAgentConversation({ title: 'Existing conversation' })
  const settings = repository.getAgentSettings()
  const handle = sql(repository)
  handle.exec(`DROP INDEX agent_runs_assistant_idx; DROP INDEX agent_runs_team_run_idx;
    ALTER TABLE agent_runs DROP COLUMN assistant_id; ALTER TABLE agent_runs DROP COLUMN team_id;
    ALTER TABLE agent_runs DROP COLUMN team_run_id;
    DROP TABLE agent_run_requests;
    DROP TABLE agent_team_runs; DROP TABLE agent_team_members; DROP TABLE agent_teams;
    DROP TABLE agent_assistant_bindings; DROP TABLE agent_assistants;
    DELETE FROM _prw_migrations WHERE id=38;`)
  repository.close()
  const upgraded = open(filePath)
  strictEqual(upgraded.getAgentConversation(conversation.id).title, conversation.title)
  deepStrictEqual(upgraded.getAgentSettings(), settings)
  assistant(upgraded, 'assistant.persisted', ['tasks.search'])
  upgraded.close()
  const reopened = open(filePath)
  deepStrictEqual(reopened.agentProfiles.getAssistant('assistant.persisted').toolAllowlist, ['tasks.search'])
  deepStrictEqual(sql(reopened).pragma('foreign_key_check'), [])
})

test('CAS protects assistant and atomic binding update, including duplicate and stale create', () => {
  const repository = open()
  const first = assistant(repository, 'assistant.test', ['tasks.search'])
  const { archivedAt: _, createdAt: __, updatedAt: ___, revision: ____, ...fields } = first
  const input = AgentAssistantSaveInputSchema.parse({ ...fields, expectedRevision: first.revision })
  const updated = repository.agentProfiles.saveAssistant({ ...input, toolAllowlist: [] })
  strictEqual(updated.revision, 1)
  throws(() => repository.agentProfiles.saveAssistant(input), /changed/u)
  deepStrictEqual(repository.agentProfiles.getAssistant(first.id).toolAllowlist, [])
  throws(() => assistant(repository, first.id))
  throws(() => AgentAssistantSaveInputSchema.parse({ ...input, toolAllowlist: ['tasks.search', 'tasks.search'] }))
})

test('binding matrix updates both assistants atomically and preserves configuration and the other binding kind', () => {
  const repository = open()
  const first = assistant(repository, 'assistant.matrix-a', ['tasks.search'])
  const second = assistant(repository, 'assistant.matrix-b', ['projects.search'])
  const updated = repository.agentProfiles.saveBindingMatrix({ updates: [
    { assistantId: first.id, expectedRevision: first.revision, skillKeys: ['fixture-skill'] },
    { assistantId: second.id, expectedRevision: second.revision, toolAllowlist: [] }
  ] })
  strictEqual(updated.length, 2)
  strictEqual(updated[0]!.revision, first.revision + 1)
  strictEqual(updated[1]!.revision, second.revision + 1)
  deepStrictEqual(updated[0]!.toolAllowlist, first.toolAllowlist)
  deepStrictEqual(updated[0]!.skillKeys, ['fixture-skill'])
  strictEqual(updated[0]!.systemPrompt, first.systemPrompt)
  strictEqual(updated[0]!.provider, first.provider)
  strictEqual(updated[0]!.createdAt, first.createdAt)
  deepStrictEqual(updated[1]!.toolAllowlist, [])
  deepStrictEqual(updated[1]!.skillKeys, [])
  throws(() => repository.agentProfiles.saveBindingMatrix({ updates: [
    { assistantId: first.id, expectedRevision: updated[0]!.revision, toolAllowlist: [] },
    { assistantId: second.id, expectedRevision: second.revision, toolAllowlist: ['tasks.search'] }
  ] }), /changed/u)
  deepStrictEqual(repository.agentProfiles.getAssistant(first.id), updated[0])
  deepStrictEqual(repository.agentProfiles.getAssistant(second.id), updated[1])
})

test('matrix enabled and disabled bindings survive a real database close/reopen', () => {
  const filePath = join(mkdtempSync(join(tmpdir(), 'prw-matrix-persistence-')), 'workspace.sqlite3')
  const repository = open(filePath)
  const first = assistant(repository, 'assistant.enabled')
  const second = assistant(repository, 'assistant.disabled', ['tasks.search'])
  repository.agentProfiles.saveBindingMatrix({ updates: [
    { assistantId: first.id, expectedRevision: 0, toolAllowlist: ['tasks.search'], skillKeys: ['fixture-skill'] },
    { assistantId: second.id, expectedRevision: 0, toolAllowlist: [], skillKeys: [] }
  ] })
  repository.close()
  const reopened = open(filePath)
  deepStrictEqual(reopened.agentProfiles.getAssistant(first.id).toolAllowlist, ['tasks.search'])
  deepStrictEqual(reopened.agentProfiles.getAssistant(first.id).skillKeys, ['fixture-skill'])
  deepStrictEqual(reopened.agentProfiles.getAssistant(second.id).toolAllowlist, [])
  deepStrictEqual(reopened.agentProfiles.getAssistant(second.id).skillKeys, [])
  deepStrictEqual(sql(reopened).pragma('foreign_key_check'), [])
  strictEqual(sql(reopened).pragma('integrity_check', { simple: true }), 'ok')
})

test('matrix rejects archived or missing assistants without partial writes', () => {
  const repository = open()
  const first = assistant(repository, 'assistant.valid')
  const second = assistant(repository, 'assistant.archived')
  repository.agentProfiles.archiveAssistant({ id: second.id, expectedRevision: 0, confirmed: true })
  for (const id of [second.id, 'assistant.missing']) {
    throws(() => repository.agentProfiles.saveBindingMatrix({ updates: [
      { assistantId: first.id, expectedRevision: 0, toolAllowlist: ['tasks.search'] },
      { assistantId: id, expectedRevision: 1, skillKeys: [] }
    ] }))
    deepStrictEqual(repository.agentProfiles.getAssistant(first.id), first)
  }
})

test('a SQL failure during the second matrix write rolls back the first assistant and its bindings', () => {
  const repository = open()
  const first = assistant(repository, 'assistant.transaction-a', ['tasks.search'])
  const second = assistant(repository, 'assistant.transaction-b', ['projects.search'])
  sql(repository).exec(`CREATE TRIGGER reject_matrix_fixture BEFORE UPDATE ON agent_assistants
    WHEN NEW.id = 'assistant.transaction-b' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`)
  throws(() => repository.agentProfiles.saveBindingMatrix({ updates: [
    { assistantId: first.id, expectedRevision: first.revision, toolAllowlist: [], skillKeys: ['fixture-skill'] },
    { assistantId: second.id, expectedRevision: second.revision, toolAllowlist: [] }
  ] }), /fixture failure/u)
  deepStrictEqual(repository.agentProfiles.getAssistant(first.id), first)
  deepStrictEqual(repository.agentProfiles.getAssistant(second.id), second)
  deepStrictEqual(sql(repository).pragma('foreign_key_check'), [])
})

test('strict matrix RPC rejects empty, duplicate, oversized and forged updates', () => {
  const cell = { assistantId: 'assistant.test', expectedRevision: 0, toolAllowlist: [] }
  throws(() => AgentBindingMatrixSaveInputSchema.parse({ updates: [] }))
  throws(() => AgentBindingMatrixSaveInputSchema.parse({ updates: [cell, cell] }))
  throws(() => AgentBindingMatrixSaveInputSchema.parse({ updates: [{ assistantId: cell.assistantId, expectedRevision: 0 }] }))
  throws(() => AgentBindingMatrixSaveInputSchema.parse({ updates: [{ ...cell, expectedRevision: -1 }] }))
  throws(() => AgentBindingMatrixSaveInputSchema.parse({ updates: [{ ...cell, systemPrompt: 'forged' }] }))
  throws(() => AgentBindingMatrixSaveInputSchema.parse({ updates: [{ ...cell, toolAllowlist: ['tasks.search', 'tasks.search'] }] }))
  throws(() => AgentBindingMatrixSaveInputSchema.parse({ updates: Array.from({ length: 101 }, (_, index) => ({ ...cell, assistantId: `assistant.${index}` })) }))
  throws(() => AgentBindingSetInputSchema.parse({ assistantId: '../escape', expectedRevision: 0, kind: 'tool', key: 'tasks.search', enabled: true }))
  throws(() => AgentBindingSetInputSchema.parse({ assistantId: cell.assistantId, expectedRevision: 0, kind: 'mcp', key: 'arbitrary', enabled: true }))
  throws(() => AgentBindingSetInputSchema.parse({ assistantId: cell.assistantId, expectedRevision: 0, kind: 'tool', key: 'tasks.search', enabled: 'true' }))
  strictEqual(RpcRequestSchema.parse({ id: 'matrix-test', method: 'agentBindings.saveMatrix', payload: { updates: [cell] } }).method, 'agentBindings.saveMatrix')
  strictEqual(RpcRequestSchema.parse({ id: 'matrix-test', method: 'agentBindings.matrix', payload: null }).method, 'agentBindings.matrix')
  strictEqual(RpcRequestSchema.parse({ id: 'matrix-test', method: 'agentBindings.set', payload: { assistantId: cell.assistantId, expectedRevision: 0, kind: 'tool', key: 'tasks.search', enabled: false } }).method, 'agentBindings.set')
})

test('team membership must exist, is unique and has exactly one director; stale saves roll back', () => {
  const repository = open()
  const record = team(repository)
  const { createdAt: _, updatedAt: __, archivedAt: ___, revision: ____, ...fields } = record
  const input = { ...fields, expectedRevision: 0 }
  throws(() => repository.agentProfiles.saveTeam({ ...input, members: [{ assistantId: 'assistant.missing', role: 'director', instructions: '' }, record.members[1]!] }))
  deepStrictEqual(repository.agentProfiles.getTeam(record.id), record)
  repository.agentProfiles.saveTeam(input)
  throws(() => repository.agentProfiles.saveTeam(input), /changed/u)
  throws(() => AgentTeamSaveInputSchema.parse({ ...input, members: [record.members[0], record.members[0]] }))
  throws(() => AgentTeamSaveInputSchema.parse({ ...input, members: record.members.map((member) => ({ ...member, role: 'researcher' })) }))
  throws(() => repository.agentProfiles.archiveAssistant({ id: 'assistant.worker', expectedRevision: 0, confirmed: true }))
})

test('team run snapshots, idempotency, cancellation and restart never replay', () => {
  const repository = open()
  const record = team(repository)
  const input = AgentTeamRunStartInputSchema.parse({ teamId: record.id, expectedRevision: 0, instructions: 'Research test', idempotencyKey: 'team-test' })
  const run = repository.agentProfiles.startTeamRun(input)
  strictEqual(repository.agentProfiles.startTeamRun(input).id, run.id)
  throws(() => repository.agentProfiles.startTeamRun({ ...input, instructions: 'Different request' }))
  const member = repository.agentProfiles.getAssistant('assistant.worker')
  const { archivedAt: _, createdAt: __, updatedAt: ___, revision: ____, ...fields } = member
  repository.agentProfiles.saveAssistant({ ...fields, name: 'Changed later', expectedRevision: member.revision })
  strictEqual(repository.agentProfiles.getTeamRun(run.id).snapshot.assistants.find((a) => a.id === member.id)?.name, member.name)
  throws(() => repository.agentProfiles.archiveTeam({ id: record.id, expectedRevision: 0, confirmed: true }))
  strictEqual(repository.agentProfiles.reconcileTeamRuns(), 1)
  strictEqual(repository.agentProfiles.reconcileTeamRuns(), 0)
  strictEqual(repository.agentProfiles.getTeamRun(run.id).status, 'interrupted')
  strictEqual(repository.agentProfiles.updateTeamRun(run.id, { status: 'completed' }).status, 'interrupted')
  const late = repository.agentProfiles.updateTeamRun(run.id, { status: 'completed', childRunIds: ['late-child'] })
  strictEqual(late.status, 'interrupted')
  deepStrictEqual(late.childRunIds, ['late-child'])
  throws(() => repository.agentProfiles.updateTeamRun(run.id, { childRunIds: [] }))
})

test('conversation assistant pin cannot be switched across sessions or legacy history', () => {
  const repository = open()
  assistant(repository, 'assistant.a')
  assistant(repository, 'assistant.b')
  const conversation = repository.createAgentConversation({ title: 'Fresh' })
  repository.setAgentConversationAssistant(conversation.id, 'assistant.a')
  repository.setAgentConversationAssistant(conversation.id, 'assistant.a')
  throws(() => repository.setAgentConversationAssistant(conversation.id, 'assistant.b'))
  const legacy = repository.createAgentConversation({ title: 'Legacy' })
  repository.appendAgentMessage({ conversationId: legacy.id, runId: null, role: 'user', content: 'Existing history' })
  throws(() => repository.setAgentConversationAssistant(legacy.id, 'assistant.a'))
})

test('raw request fingerprints distinguish inputs that redact to identical text', () => {
  const repository = open()
  const record = team(repository)
  const input = AgentTeamRunStartInputSchema.parse({ teamId: record.id, expectedRevision: 0, instructions: 'Review C:\\fixture-one\\paper', idempotencyKey: 'redaction-key' })
  repository.agentProfiles.startTeamRun(input)
  throws(() => repository.agentProfiles.startTeamRun({ ...input, instructions: 'Review C:\\fixture-two\\paper' }), /another request/u)
})

test('team snapshot freezes inherited model and thinking before defaults change', () => {
  const repository = open()
  const record = team(repository)
  const settings = repository.getAgentSettings()
  const { updatedAt: _, revision: __, ...settingsFields } = settings
  repository.saveAgentSettings({ ...settingsFields, expectedRevision: settings.revision, provider: 'provider-one', model: 'model-one', thinking: 'low' })
  const run = repository.agentProfiles.startTeamRun(AgentTeamRunStartInputSchema.parse({ teamId: record.id, expectedRevision: 0, instructions: 'Snapshot check', idempotencyKey: 'snapshot' }))
  const updatedSettings = repository.getAgentSettings()
  const { updatedAt: ___, revision: ____, ...updatedFields } = updatedSettings
  repository.saveAgentSettings({ ...updatedFields, expectedRevision: updatedSettings.revision, provider: 'provider-two', model: 'model-two', thinking: 'high' })
  const snapshot = repository.agentProfiles.getTeamRun(run.id).snapshot.assistants
  ok(snapshot.every((assistant) => assistant.provider === 'provider-one' && assistant.model === 'model-one' && assistant.thinking === 'low'))
})

test('strict v2 payloads reject credentials, paths and generic commands', () => {
  for (const extra of [{ credential: 'not-a-real-key' }, { agentDir: '../unsafe' }, { shell: 'exec' }]) {
    ok(!RpcRequestSchema.safeParse({ id: 'test', method: 'assistants.save', payload: { id: 'assistant.a', name: 'A', expectedRevision: null, ...extra } }).success)
  }
  ok(!AgentAssistantSaveInputSchema.safeParse({ id: 'assistant../unsafe', name: 'A', expectedRevision: null }).success)
  ok(!AgentAssistantSaveInputSchema.safeParse({ id: 'assistant.a.', name: 'A', expectedRevision: null }).success)
})
