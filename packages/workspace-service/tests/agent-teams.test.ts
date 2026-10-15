import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  AgentAssistantSaveInputSchema, AgentRunStartInputSchema, AgentTeamSaveInputSchema,
  AgentTeamRunStartInputSchema, AgentSettingsSaveInputSchema, type AgentAssistant, type AgentRunRecord
} from '@prw/contracts'
import { WorkbenchRepository } from '@prw/database'
import { assistantRuntimePaths, EventQueue, selectWorkspaceTools,
  type AgentRuntimeAdapter, type AgentRuntimeEvent, type AgentRuntimeRequest } from '@prw/agent-runtime'
import { AgentCoordinator, type AgentTeamChildIdentity } from '../src/agent-coordinator.js'
import { AgentTeamCoordinator, parseTeamDirectorDecision } from '../src/agent-teams.js'
import { resolveAgentSkill } from '../src/skill-registry.js'

const disposals: Array<() => void> = []
afterEach(() => { while (disposals.length) disposals.pop()?.() })
const open = () => {
  const repository = new WorkbenchRepository({ filePath: ':memory:' })
  disposals.push(() => repository.close())
  return repository
}
function createAssistant(repository: WorkbenchRepository, id: string, extra: Record<string, unknown> = {}) {
  return repository.agentProfiles.saveAssistant(AgentAssistantSaveInputSchema.parse({
    id, name: id, provider: 'anthropic', model: 'test-model', expectedRevision: null, ...extra
  }))
}
function createTeam(repository: WorkbenchRepository, maxSteps = 6) {
  createAssistant(repository, 'assistant.director')
  createAssistant(repository, 'assistant.worker', { systemPrompt: 'Frozen worker instructions', toolAllowlist: ['tasks.search'] })
  return repository.agentProfiles.saveTeam(AgentTeamSaveInputSchema.parse({
    id: 'team.test', name: 'Test', maxSteps, expectedRevision: null,
    members: [{ assistantId: 'assistant.director', role: 'director' }, { assistantId: 'assistant.worker', role: 'researcher' }]
  }))
}
function startInput(team: ReturnType<typeof createTeam>, key = 'team-test') {
  return AgentTeamRunStartInputSchema.parse({ teamId: team.id, expectedRevision: team.revision,
    instructions: 'Research the fixture only', idempotencyKey: key })
}
async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 250; i++) {
    if (condition()) return
    await delay(5)
  }
  assert.fail('Fixture did not settle within its bounded wait.')
}
function fakeAgent(repository: WorkbenchRepository, outputs: string[], options: { late?: Promise<void>; neverFinish?: boolean } = {}) {
  const calls: Array<{ assistant: AgentAssistant; input: ReturnType<typeof AgentRunStartInputSchema.parse> }> = []
  const cancellations: string[] = []
  const agent = {
    async startWithAssistantSnapshot(input: ReturnType<typeof AgentRunStartInputSchema.parse>, assistant: AgentAssistant,
      identity: AgentTeamChildIdentity) {
      calls.push({ assistant, input })
      await options.late
      const child = repository.startManagedAgentRun({ ...input, runtime: 'pi', transport: 'inprocess',
        assistantId: assistant.id, teamId: identity.teamId, teamRunId: identity.teamRunId })
      return repository.updateManagedAgentRun({ id: child.id, status: options.neverFinish ? 'running' : 'completed',
        output: outputs.shift() ?? 'Fixture member result' })
    },
    getRun: (id: string) => repository.getManagedAgentRun(id),
    async cancel(id: string) {
      cancellations.push(id)
      const run = repository.getManagedAgentRun(id)
      if (!['completed', 'failed', 'blocked', 'canceled'].includes(run.status)) repository.updateManagedAgentRun({ id, status: 'canceled' })
    }
  }
  return { agent, calls, cancellations }
}
function coordinator(repository: WorkbenchRepository, fixture: ReturnType<typeof fakeAgent>, options = {}) {
  const teams = new AgentTeamCoordinator(repository, fixture.agent, { pollMs: 1, childTimeoutMs: 100, ...options })
  disposals.push(() => teams.dispose())
  return teams
}

test('director boundary rejects invalid JSON, unknown members, extra privileges and oversized output', () => {
  const allowed = new Set(['assistant.worker'])
  assert.deepEqual(parseTeamDirectorDecision('{"action":"finish","output":"Report"}', allowed), { action: 'finish', output: 'Report' })
  for (const text of ['```json\n{}\n```', '{"action":"delegate","assistantId":"assistant.outside","instructions":"Do work"}',
    '{"action":"finish","output":"Report","permissionMode":"full-access"}', 'a'.repeat(65001)]) {
    assert.throws(() => parseTeamDirectorDecision(text, allowed))
  }
})

test('team loop freezes assistant config, records director/member runs, narrows tools and is idempotent', async () => {
  const repository = open()
  const team = createTeam(repository)
  const fixture = fakeAgent(repository, [
    '{"action":"delegate","assistantId":"assistant.worker","instructions":"Gather evidence"}',
    'Evidence fixture', '{"action":"finish","output":"Final fixture report"}'
  ])
  const teams = coordinator(repository, fixture)
  const run = teams.start(startInput(team))
  const worker = repository.agentProfiles.getAssistant('assistant.worker')
  const { archivedAt: _, createdAt: __, updatedAt: ___, revision: ____, ...fields } = worker
  repository.agentProfiles.saveAssistant(AgentAssistantSaveInputSchema.parse({ ...fields, enabled: false,
    model: 'changed-model', systemPrompt: 'Changed live prompt', expectedRevision: worker.revision,
  }))
  await waitFor(() => teams.get(run.id).status === 'completed')
  const completed = teams.get(run.id)
  assert.equal(completed.output, 'Final fixture report')
  assert.equal(completed.childRunIds.length, 3)
  assert.equal(fixture.calls[1]?.assistant.model, 'test-model')
  assert.equal(fixture.calls[1]?.assistant.enabled, true)
  assert.equal(fixture.calls[1]?.assistant.systemPrompt, 'Frozen worker instructions')
  assert.deepEqual(fixture.calls[0]?.assistant.toolAllowlist, [])
  assert.ok(fixture.calls.every((call) => call.input.permissionMode === 'read-only'))
  for (const id of completed.childRunIds) assert.equal(repository.getManagedAgentRun(id).teamRunId, run.id)
  assert.equal(teams.start(startInput(team)).id, run.id)
  assert.equal(fixture.calls.length, 3)
})

test('step budget stops at the configured number of total model calls', async () => {
  const repository = open()
  const team = createTeam(repository, 2)
  const fixture = fakeAgent(repository, ['{"action":"delegate","assistantId":"assistant.worker","instructions":"Continue"}', 'Evidence'])
  const teams = coordinator(repository, fixture)
  const run = teams.start(startInput(team))
  await waitFor(() => teams.get(run.id).status === 'failed')
  assert.equal(fixture.calls.length, 2)
  assert.equal(teams.get(run.id).childRunIds.length, 2)
  assert.match(teams.get(run.id).error ?? '', /step budget/u)
})

test('invalid director responses fail without launching an unauthorized member', async () => {
  const repository = open()
  const team = createTeam(repository)
  const fixture = fakeAgent(repository, ['{"action":"delegate","assistantId":"assistant.outside","instructions":"Escape"}'])
  const teams = coordinator(repository, fixture)
  const run = teams.start(startInput(team))
  await waitFor(() => teams.get(run.id).status === 'failed')
  assert.equal(fixture.calls.length, 1)
})

test('cancellation during asynchronous startup records the late child and cancels it without another call', async () => {
  const repository = open()
  const team = createTeam(repository)
  let release!: () => void
  const fixture = fakeAgent(repository, [], { late: new Promise<void>((resolve) => { release = resolve }), neverFinish: true })
  const teams = coordinator(repository, fixture)
  const run = teams.start(startInput(team))
  const canceled = await teams.cancel({ id: run.id, expectedRevision: teams.get(run.id).revision })
  assert.equal(canceled.status, 'canceled')
  release()
  await waitFor(() => fixture.cancellations.length > 0)
  assert.equal(teams.get(run.id).status, 'canceled')
  assert.equal(teams.get(run.id).childRunIds.length, 1)
  assert.equal(repository.getManagedAgentRun(teams.get(run.id).childRunIds[0]!).status, 'canceled')
  assert.equal(fixture.calls.length, 1)
})

test('child timeout cancels the child and restart reconciliation never replays interrupted teams', async () => {
  const repository = open()
  const team = createTeam(repository)
  const fixture = fakeAgent(repository, [], { neverFinish: true })
  const teams = coordinator(repository, fixture, { childTimeoutMs: 5 })
  const run = teams.start(startInput(team))
  await waitFor(() => fixture.cancellations.length > 0)
  assert.equal(teams.get(run.id).status, 'failed')
  const interrupted = repository.agentProfiles.startTeamRun(startInput(team, 'restart'))
  assert.equal(teams.reconcileInterruptedRuns(), 1)
  assert.equal(teams.start(startInput(team, 'restart')).status, 'interrupted')
  assert.equal(teams.get(interrupted.id).childRunIds.length, 0)
  assert.equal(fixture.calls.length, 1)
})

function runtimeFixture(repository: WorkbenchRepository, output = 'Fixture output', options: { keepRunning?: boolean; cancelFails?: boolean } = {}) {
  const requests: AgentRuntimeRequest[] = []
  const adapter: AgentRuntimeAdapter = {
    kind: 'pi', transport: 'inprocess',
    capabilities: async () => ({ kind: 'pi', transport: 'inprocess', available: true, version: 'fixture',
      mcp: true, structuredOutput: true, workspaceWrite: true, message: 'Fixture adapter', modelOptions: ['anthropic/test-model'] }),
    async start(request) {
      requests.push(request)
      assert.ok(repository.getManagedAgentRun(request.runId).assistantId)
      const events = new EventQueue<AgentRuntimeEvent>()
      if (!options.keepRunning) {
        events.push({ externalRunId: request.runId, kind: 'completed', createdAt: new Date().toISOString(), payload: {},
          records: [{ recordKey: 'assistant', kind: 'assistant', status: 'completed', detail: output }] })
        events.end()
      }
      return { externalRunId: request.runId, runtimeSessionId: null, events: events.iterate(), cancel: async () => {
        events.end()
        if (options.cancelFails) throw new Error('Fixture cancellation failed')
      } }
    }
  }
  const root = mkdtempSync(join(tmpdir(), 'prw-assistant-test-'))
  const agent = new AgentCoordinator(repository, { runRoot: join(root, 'runs'), runtimeProfileRoot: join(root, 'runtime'), agentRuntime: adapter,
    requestCredential: async (provider) => ({ provider: provider ?? 'anthropic', credential: { type: 'api_key', key: 'fixture-not-a-real-credential' } }) })
  disposals.push(() => agent.dispose())
  return { agent, requests, root, adapter }
}

test('assistant launch enforces config and conversation pin; cross-assistant idempotency and resume reject', async () => {
  const repository = open()
  createAssistant(repository, 'assistant.a', { thinking: 'low', systemPrompt: 'Assistant A system prompt', toolAllowlist: ['tasks.search'] })
  createAssistant(repository, 'assistant.b')
  const { agent, requests } = runtimeFixture(repository)
  const conversation = agent.createConversation({ title: 'Fixture', toolProfile: 'read-only', permissionMode: 'read-only', approvalPolicy: 'never' })
  const input = AgentRunStartInputSchema.parse({ assistantId: 'assistant.a', conversationId: conversation.id,
    workflowKey: 'research_plan', instructions: 'Fixture request', idempotencyKey: 'shared', model: 'wrong/model', thinking: 'high' })
  const run = await agent.start(input)
  await waitFor(() => agent.getRun(run.id).status === 'completed')
  assert.equal(agent.getRun(run.id).assistantId, 'assistant.a')
  assert.equal(requests[0]?.model, 'anthropic/test-model')
  assert.equal(requests[0]?.thinking, 'low')
  assert.equal(requests[0]?.permissionMode, 'read-only')
  assert.deepEqual(requests[0]?.toolAllowlist, ['tasks.search'])
  assert.match(requests[0]?.systemPromptAppend ?? '', /Assistant A system prompt/u)
  assert.equal(requests[0]?.credentials?.length, 1)
  assert.equal(repository.getAgentConversation(conversation.id).assistantKey, 'assistant.a')
  assert.equal((await agent.start(input)).id, run.id)
  await assert.rejects(agent.start({ ...input, instructions: 'Changed request' }), /Idempotency/u)
  await assert.rejects(agent.start({ ...input, assistantId: 'assistant.b' }))
  await assert.rejects(agent.start({ ...input, conversationId: null, assistantId: 'assistant.b' }), /Idempotency/u)
  await assert.rejects(agent.start({ ...input, conversationId: null, assistantId: 'assistant.b', resumeFromRunId: run.id, idempotencyKey: null }), /resume/u)
  await agent.start({ ...input, assistantId: undefined, idempotencyKey: null })
  assert.equal(requests[1]?.assistantId, 'assistant.a')
})

test('single assistant inherits global thinking while a null team snapshot never reads changed defaults', async () => {
  const repository = open()
  repository.saveAgentSettings(AgentSettingsSaveInputSchema.parse({ provider: 'anthropic', model: 'test-model', thinking: 'low', expectedRevision: 0 }))
  createTeam(repository)
  const { agent, requests } = runtimeFixture(repository)
  const single = await agent.start(AgentRunStartInputSchema.parse({ assistantId: 'assistant.worker', workflowKey: 'research_plan', instructions: 'Fixture' }))
  await waitFor(() => agent.getRun(single.id).status === 'completed')
  assert.equal(requests[0]?.thinking, 'low')
  repository.saveAgentSettings(AgentSettingsSaveInputSchema.parse({ provider: 'anthropic', model: 'test-model', thinking: null,
    expectedRevision: repository.getAgentSettings().revision }))
  const parent = repository.agentProfiles.startTeamRun(startInput(repository.agentProfiles.getTeam('team.test'), 'null-thinking'))
  const snapshot = parent.snapshot.assistants.find((a) => a.id === 'assistant.worker')!
  repository.agentProfiles.updateTeamRun(parent.id, { status: 'running' })
  repository.saveAgentSettings(AgentSettingsSaveInputSchema.parse({ provider: 'anthropic', model: 'test-model', thinking: 'high',
    expectedRevision: repository.getAgentSettings().revision }))
  const child = await agent.startWithAssistantSnapshot(AgentRunStartInputSchema.parse({ workflowKey: 'research_plan', instructions: 'Fixture' }),
    snapshot, { teamId: parent.teamId, teamRunId: parent.id })
  await waitFor(() => agent.getRun(child.id).status === 'completed')
  assert.equal(requests[1]?.thinking, null)
})

test('shutdown records cancellation without an unhandled adapter rejection after database close', async () => {
  const repository = open()
  createAssistant(repository, 'assistant.shutdown')
  const { agent } = runtimeFixture(repository, '', { keepRunning: true, cancelFails: true })
  const run = await agent.start(AgentRunStartInputSchema.parse({ assistantId: 'assistant.shutdown', workflowKey: 'research_plan', instructions: 'Fixture' }))
  agent.dispose()
  assert.equal(repository.getManagedAgentRun(run.id).status, 'canceled')
  repository.close()
  await delay(5)
})

test('pending starts compare the full normalized request before returning an in-flight run', async () => {
  const repository = open()
  createAssistant(repository, 'assistant.a')
  const { agent } = runtimeFixture(repository)
  const input = AgentRunStartInputSchema.parse({ assistantId: 'assistant.a', workflowKey: 'research_plan',
    instructions: 'First request', idempotencyKey: 'pending-key' })
  const first = agent.start(input)
  const identical = agent.start(input)
  await assert.rejects(agent.start({ ...input, instructions: 'Different prompt' }), /Pending idempotency/u)
  assert.equal((await first).id, (await identical).id)
})

test('partial provider/model configuration fails closed and missing-fingerprint legacy runs cannot replay', async () => {
  const repository = open()
  assert.throws(() => createAssistant(repository, 'assistant.partial', { model: null }), /Choose both/u)
  const partial = createAssistant(repository, 'assistant.partial')
  const sqlite = (repository as unknown as { sqlite: { prepare(sql: string): { run(...args: unknown[]): void } } }).sqlite
  sqlite.prepare('UPDATE agent_assistants SET data_json = ? WHERE id = ?').run(JSON.stringify({ ...partial, model: null }), partial.id)
  const { agent, requests } = runtimeFixture(repository)
  const input = AgentRunStartInputSchema.parse({ assistantId: 'assistant.partial', workflowKey: 'research_plan', instructions: 'Fixture' })
  await assert.rejects(agent.start(input), /configured together/u)
  assert.equal(requests.length, 0)
  const legacy = repository.startManagedAgentRun({ workflowKey: 'research_plan', runtime: 'pi', transport: 'inprocess', instructions: 'Legacy', idempotencyKey: 'legacy' })
  assert.equal(repository.getAgentRunRequestFingerprint(legacy.id), null)
  await assert.rejects(agent.start(AgentRunStartInputSchema.parse({ workflowKey: 'research_plan', instructions: 'Legacy', idempotencyKey: 'legacy' })), /legacy unverified/u)
})

test('team children use fresh snapshot-owned conversations even if live assistant is disabled', async () => {
  const repository = open()
  const team = createTeam(repository)
  const parent = repository.agentProfiles.startTeamRun(startInput(team))
  repository.agentProfiles.updateTeamRun(parent.id, { status: 'running' })
  const snapshot = parent.snapshot.assistants.find((a) => a.id === 'assistant.worker')!
  const { archivedAt: _, createdAt: __, updatedAt: ___, revision: ____, ...fields } = snapshot
  repository.agentProfiles.saveAssistant({ ...fields, enabled: false, model: 'changed-model', expectedRevision: snapshot.revision })
  const { agent, requests } = runtimeFixture(repository)
  const input = AgentRunStartInputSchema.parse({ workflowKey: 'research_plan', instructions: 'Child fixture', idempotencyKey: 'child-1' })
  const identity = { teamId: team.id, teamRunId: parent.id }
  const first = await agent.startWithAssistantSnapshot(input, snapshot, identity)
  await waitFor(() => agent.getRun(first.id).status === 'completed')
  const second = await agent.startWithAssistantSnapshot({ ...input, idempotencyKey: 'child-2' }, snapshot, identity)
  assert.notEqual(first.conversationId, second.conversationId)
  assert.equal(first.teamRunId, parent.id)
  assert.equal(requests[0]?.model, 'anthropic/test-model')
  assert.equal(requests[0]?.runtimeSessionId, null)
  assert.equal(requests[1]?.runtimeSessionId, null)
  assert.equal((await agent.startWithAssistantSnapshot(input, snapshot, identity)).id, first.id)
})

test('matrix edits affect live next-run prompts and tools without mutating frozen team bindings or prior run', async () => {
  const repository = open()
  const team = createTeam(repository)
  const worker = repository.agentProfiles.getAssistant('assistant.worker')
  repository.agentProfiles.saveBindingMatrix({ updates: [{ assistantId: worker.id, expectedRevision: worker.revision, skillKeys: ['literature-matrix'] }] })
  const skill = resolveAgentSkill('literature-matrix')
  assert.ok(skill.kind === 'instruction')
  const parent = repository.agentProfiles.startTeamRun(startInput(team, 'binding-snapshot'))
  repository.agentProfiles.updateTeamRun(parent.id, { status: 'running' })
  const snapshot = parent.snapshot.assistants.find((assistant) => assistant.id === worker.id)!
  repository.agentProfiles.saveBindingMatrix({ updates: [{ assistantId: worker.id, expectedRevision: snapshot.revision, toolAllowlist: [], skillKeys: [] }] })
  const { agent, requests } = runtimeFixture(repository)
  const input = AgentRunStartInputSchema.parse({ assistantId: worker.id, workflowKey: 'research_plan', instructions: 'Fixture' })
  const frozen = await agent.startWithAssistantSnapshot({ ...input, idempotencyKey: 'snapshot-child' }, snapshot, { teamId: team.id, teamRunId: parent.id })
  await waitFor(() => agent.getRun(frozen.id).status === 'completed')
  assert.deepEqual(requests[0]!.toolAllowlist, ['tasks.search'])
  assert.ok(requests[0]!.systemPromptAppend?.includes(skill.runtime.markdown))
  assert.deepEqual(requests[0]!.skillPaths, [skill.runtime.skillPath])
  const live = await agent.start({ ...input, idempotencyKey: 'live-bindings' })
  await waitFor(() => agent.getRun(live.id).status === 'completed')
  assert.deepEqual(requests[1]!.toolAllowlist, [])
  assert.deepEqual(requests[1]!.skillPaths, [])
  assert.ok(!requests[1]!.systemPromptAppend?.includes(skill.runtime.markdown))
  const preserved = repository.agentProfiles.getTeamRun(parent.id).snapshot.assistants.find((assistant) => assistant.id === worker.id)!
  assert.deepEqual(preserved.skillKeys, ['literature-matrix'])
  assert.deepEqual(preserved.toolAllowlist, ['tasks.search'])
  assert.equal(agent.getRun(frozen.id).teamRunId, parent.id)
  assert.equal(agent.getRun(live.id).teamRunId, null)
  assert.ok(requests[0]!.systemPromptAppend?.includes(skill.runtime.markdown))
})

test('team cancellation during credential read prevents adapter invocation and orphan sessions', async () => {
  const repository = open()
  const team = createTeam(repository)
  let release!: (value: null) => void
  let credentialReads = 0
  const { adapter, requests } = runtimeFixture(repository)
  const root = mkdtempSync(join(tmpdir(), 'prw-team-cancel-auth-'))
  const agent = new AgentCoordinator(repository, { runRoot: join(root, 'runs'), runtimeProfileRoot: join(root, 'runtime'), agentRuntime: adapter,
    requestCredential: async () => {
      credentialReads++
      return new Promise<null>((resolve) => { release = resolve })
    } })
  disposals.push(() => agent.dispose())
  const teams = new AgentTeamCoordinator(repository, agent, { pollMs: 1 })
  disposals.push(() => teams.dispose())
  const run = teams.start(startInput(team))
  await waitFor(() => credentialReads === 1)
  await teams.cancel({ id: run.id, expectedRevision: teams.get(run.id).revision })
  release(null)
  await delay(10)
  assert.equal(teams.get(run.id).status, 'canceled')
  assert.equal(teams.get(run.id).childRunIds.length, 0)
  assert.equal(requests.length, 0)
  assert.equal(repository.listAgentConversations({}).length, 0)
  assert.equal(repository.listManagedAgentRuns().length, 0)
})

test('team snapshots freeze inherited global provider/model/thinking before settings change', async () => {
  const repository = open()
  repository.saveAgentSettings(AgentSettingsSaveInputSchema.parse({ provider: 'anthropic', model: 'original-model', thinking: 'low', expectedRevision: 0 }))
  const team = createTeam(repository)
  const director = repository.agentProfiles.getAssistant('assistant.director')
  const worker = repository.agentProfiles.getAssistant('assistant.worker')
  for (const assistant of [director, worker]) {
    const { archivedAt: _, createdAt: __, updatedAt: ___, revision: ____, ...fields } = assistant
    repository.agentProfiles.saveAssistant({ ...fields, provider: null, model: null, thinking: null, expectedRevision: assistant.revision })
  }
  const fixture = fakeAgent(repository, ['{"action":"delegate","assistantId":"assistant.worker","instructions":"Continue"}', 'Evidence', '{"action":"finish","output":"Report"}'])
  const teams = coordinator(repository, fixture)
  const run = teams.start(startInput(team))
  const current = repository.getAgentSettings()
  repository.saveAgentSettings(AgentSettingsSaveInputSchema.parse({ provider: 'openai', model: 'changed-model', thinking: 'high', expectedRevision: current.revision }))
  await waitFor(() => teams.get(run.id).status === 'completed')
  assert.ok(fixture.calls.every((call) => call.assistant.provider === 'anthropic' && call.assistant.model === 'original-model' && call.assistant.thinking === 'low'))
})

test('missing credentials block the child with persisted assistant/team identity and no model call', async () => {
  const repository = open()
  const team = createTeam(repository)
  const root = mkdtempSync(join(tmpdir(), 'prw-team-no-auth-'))
  let calls = 0
  const { adapter } = runtimeFixture(repository)
  const agent = new AgentCoordinator(repository, { runRoot: join(root, 'runs'), runtimeProfileRoot: join(root, 'runtime'),
    agentRuntime: { ...adapter, start: async () => { calls++; throw new Error('Must not call') } }, requestCredential: async () => null })
  disposals.push(() => agent.dispose())
  const teams = new AgentTeamCoordinator(repository, agent, { pollMs: 1 })
  disposals.push(() => teams.dispose())
  const run = teams.start(startInput(team))
  await waitFor(() => teams.get(run.id).status === 'failed')
  const child = agent.getRun(teams.get(run.id).childRunIds[0]!)
  assert.equal(child.status, 'blocked')
  assert.equal(child.assistantId, 'assistant.director')
  assert.equal(child.teamId, team.id)
  assert.equal(child.teamRunId, run.id)
  assert.equal(calls, 0)
})

test('assistant profile paths are isolated and binding cannot widen the base policy', () => {
  const root = join(tmpdir(), 'prw-profile-path-fixture')
  const a = assistantRuntimePaths(root, 'assistant.a')
  const b = assistantRuntimePaths(root, 'assistant.b')
  assert.notEqual(a.sessionDir, b.sessionDir)
  assert.ok(a.sessionDir.startsWith(root))
  assert.throws(() => assistantRuntimePaths(root, '../escape'))
  assert.throws(() => assistantRuntimePaths(parse(root).root, 'assistant.a'))
  assert.throws(() => assistantRuntimePaths('relative', 'assistant.a'))
  const advertised = ['tasks.search', 'tasks.create', 'bash', 'notes.write.request'].map((name) => ({ name, description: '', inputSchema: {} }))
  assert.deepEqual(selectWorkspaceTools(advertised, { toolProfile: 'read-only', toolAllowlist: ['tasks.search', 'tasks.create', 'bash', 'notes.write.request'] }).map((tool) => tool.name), ['tasks.search'])
  assert.deepEqual(selectWorkspaceTools(advertised, { toolProfile: 'approved-write', toolAllowlist: [] }), [])
})
