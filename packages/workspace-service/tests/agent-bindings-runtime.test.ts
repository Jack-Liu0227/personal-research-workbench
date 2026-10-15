import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { AgentAssistantSaveInputSchema, AgentRunStartInputSchema, AgentTeamSaveInputSchema, type AgentRunRecord } from '@prw/contracts'
import { WorkbenchRepository } from '@prw/database'
import { PiInProcessAdapter, writePiModelsFile, type AgentWorkspaceToolClient } from '@prw/agent-runtime'
import { AgentCoordinator } from '../src/agent-coordinator.js'
import { dispatchRpc, type CoreServices } from '../src/dispatcher.js'
import { resolveAgentSkill } from '../src/skill-registry.js'
import { AgentTeamCoordinator } from '../src/agent-teams.js'

type CapturedRequest = { model: string; messages: Array<{ role: string; content: unknown }>; tools: Array<{ function: { name: string } }> }

// Real pinned Pi SDK and a loopback SSE fixture: no real provider or credentials.
test('matrix enable/disable changes actual SDK model payload and resumed tools, without erasing historical messages', { timeout: 45_000 }, async () => {
  const captured: CapturedRequest[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CapturedRequest
        // Do not retain headers, credentials or provider-specific request metadata.
        captured.push({ model: payload.model, messages: payload.messages, tools: payload.tools ?? [] })
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const chunk = { id: 'binding-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model' }
        const lastUser = payload.messages.filter((message) => message.role === 'user').at(-1)
        const output = JSON.stringify(lastUser?.content).includes('JSON finish fixture')
          ? JSON.stringify({ action: 'finish', output: 'Fixture team output' }) : 'Local fixture answer'
        response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: output }, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      } catch {
        response.writeHead(400).end('Invalid fixture request')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const root = mkdtempSync(join(tmpdir(), 'prw-binding-sdk-'))
  const profileRoot = join(root, 'runtime')
  const profileDir = join(profileRoot, 'pi')
  mkdirSync(profileDir, { recursive: true })
  const repository = new WorkbenchRepository({ filePath: ':memory:' })
  let advertisedNames = ['tasks.search', 'tasks.create', 'bash']
  const client: AgentWorkspaceToolClient = {
    listTools: async () => ({ tools: advertisedNames.map((name) => ({ name, description: 'Fixture tool',
      inputSchema: { type: 'object', properties: {} } })) }),
    callTool: async () => ({ content: [{ type: 'text', text: 'Fixture tool result' }] }),
    close: async () => undefined
  } as AgentWorkspaceToolClient
  writePiModelsFile(profileDir, [{ id: 'binding-fixture', name: 'Binding fixture',
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions',
    models: [{ id: 'fixture-model', name: 'Fixture model', reasoning: false, contextWindow: 64_000, maxTokens: 128 }] }])
  const adapter = new PiInProcessAdapter({ openWorkspaceClient: async () => client, persistCredential: async () => undefined, timeoutMs: 10_000 })
  const agent = new AgentCoordinator(repository, { runRoot: join(root, 'runs'), runtimeProfileRoot: profileRoot, agentRuntime: adapter,
    requestCredential: async () => ({ provider: 'binding-fixture', credential: { type: 'api_key', key: 'fixture-not-a-real-key' } }) })
  const teams = new AgentTeamCoordinator(repository, agent, { pollMs: 1, childTimeoutMs: 10_000 })
  const services = { repository, agent } as CoreServices
  async function dispatch(method: string, payload: unknown) {
    const result = await dispatchRpc(services, { version: 'fixture' }, { id: 'binding-runtime', method, payload })
    assert.ok(result.ok, result.ok ? undefined : result.error.message)
    return result.data
  }
  async function settled(run: AgentRunRecord) {
    for (let count = 0; count < 1000; count++) {
      const current = agent.getRun(run.id)
      if (['completed', 'failed', 'blocked', 'canceled'].includes(current.status)) {
        assert.equal(current.status, 'completed', 'Loopback SDK fixture must complete')
        return current
      }
      await delay(10)
    }
    assert.fail('Loopback SDK fixture did not settle')
  }
  try {
    const skill = resolveAgentSkill('literature-matrix')
    assert.equal(skill.kind, 'instruction')
    assert.ok(skill.kind === 'instruction')
    // Legacy read-only binding cannot broaden the SDK's hard execution policy.
    const assistant = repository.agentProfiles.saveAssistant(AgentAssistantSaveInputSchema.parse({ id: 'assistant.sdk', name: 'SDK fixture',
      provider: 'binding-fixture', model: 'fixture-model', toolAllowlist: ['tasks.search', 'tasks.create'], expectedRevision: null }))
    await dispatch('agentBindings.set', { assistantId: assistant.id, expectedRevision: 0, kind: 'skill', key: skill.runtime.key, enabled: true })
    const conversation = agent.createConversation({ title: 'Binding fixture', toolProfile: 'read-only', permissionMode: 'read-only', approvalPolicy: 'never' })
    const input = AgentRunStartInputSchema.parse({ assistantId: assistant.id, conversationId: conversation.id,
      workflowKey: 'research_plan', instructions: 'First fixture turn', idempotencyKey: 'binding-first' })
    const first = await settled(await agent.start(input))
    assert.equal(first.assistantId, assistant.id)
    assert.equal(first.output, 'Local fixture answer', 'A final SDK snapshot is not a second streamed answer')
    assert.equal(first.toolProfile, 'read-only')
    assert.equal(captured.length, 1)
    assert.equal(captured[0]!.model, 'fixture-model')
    assert.deepEqual(captured[0]!.tools.map((tool) => tool.function.name), ['tasks_search'])
    const firstSystem = String(captured[0]!.messages.find((message) => message.role === 'system')?.content ?? '')
    assert.ok(firstSystem.includes(skill.runtime.markdown), 'Enabled skill full markdown reaches SDK model payload')
    assert.ok(repository.getAgentConversation(conversation.id).runtimeSessionId)
    const firstMessages = repository.listAgentMessages(conversation.id).filter((message) => message.runId === first.id && message.role === 'assistant')
    assert.equal(firstMessages.length, 1)
    assert.equal(firstMessages[0]!.content, 'Local fixture answer')
    const firstLedger = repository.listAgentRunRecords({ runId: first.id, beforeSeq: null, afterSeq: null, limit: 200 }).filter((record) => record.kind === 'assistant')
    assert.equal(firstLedger.length, 1)
    assert.equal(firstLedger[0]!.detail, 'Local fixture answer')

    await dispatch('agentBindings.saveMatrix', { updates: [{ assistantId: assistant.id, expectedRevision: 1, toolAllowlist: [], skillKeys: [] }] })
    await settled(await agent.start({ ...input, instructions: 'Second fixture turn', idempotencyKey: 'binding-second' }))
    assert.equal(captured.length, 2)
    assert.deepEqual(captured[1]!.tools, [], 'Empty assistant binding never falls back to all global tools')
    const secondSystem = String(captured[1]!.messages.find((message) => message.role === 'system')?.content ?? '')
    assert.ok(!secondSystem.includes(skill.runtime.markdown), 'Disabled skill full markdown is absent from new system prompt')
    assert.ok(captured[1]!.messages.some((message) => message.role === 'user' && JSON.stringify(message.content).includes('First fixture turn')),
      'Resume retains historical messages; disabling a skill is not historical-context erasure')
    assert.ok(firstSystem.includes(skill.runtime.markdown), 'Captured historical payload is unchanged')
    assert.equal(agent.getRun(first.id).output, first.output, 'Binding mutation never rewrites an earlier run output')

    await dispatch('agentBindings.set', { assistantId: assistant.id, expectedRevision: 2, kind: 'tool', key: 'tasks.search', enabled: true })
    advertisedNames = ['tasks.create', 'bash']
    await settled(await agent.start({ ...input, instructions: 'Third fixture turn', idempotencyKey: 'binding-third' }))
    assert.equal(captured.length, 3)
    assert.deepEqual(captured[2]!.tools, [], 'A binding cannot resurrect a globally unadvertised tool')

    const member = repository.agentProfiles.saveAssistant(AgentAssistantSaveInputSchema.parse({ id: 'assistant.sdk-member', name: 'SDK member',
      provider: 'binding-fixture', model: 'fixture-model', expectedRevision: null }))
    const team = repository.agentProfiles.saveTeam(AgentTeamSaveInputSchema.parse({ id: 'team.sdk', name: 'SDK team', expectedRevision: null, maxSteps: 2,
      members: [{ assistantId: assistant.id, role: 'director' }, { assistantId: member.id, role: 'researcher' }] }))
    const parent = teams.start({ teamId: team.id, expectedRevision: team.revision, projectId: null, instructions: 'JSON finish fixture', idempotencyKey: 'sdk-team-finish' })
    for (let count = 0; count < 1000 && teams.get(parent.id).status === 'running'; count++) await delay(10)
    const completedTeam = teams.get(parent.id)
    assert.equal(completedTeam.status, 'completed', 'Actual SDK director JSON must remain parseable by the strict team boundary')
    assert.equal(completedTeam.output, 'Fixture team output')
    assert.equal(completedTeam.childRunIds.length, 1)
    assert.equal(captured.length, 4, 'The finishing director executes exactly one model call')
    assert.equal(repository.getManagedAgentRun(completedTeam.childRunIds[0]!).output, '{"action":"finish","output":"Fixture team output"}')
  } finally {
    teams.dispose()
    agent.dispose()
    repository.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    const withinTemp = relative(tmpdir(), root)
    assert.ok(!isAbsolute(withinTemp) && !withinTemp.startsWith('..') && withinTemp.startsWith('prw-binding-sdk-'))
    rmSync(root, { recursive: true, force: true })
  }
})
