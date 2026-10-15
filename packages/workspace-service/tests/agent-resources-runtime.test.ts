import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { AgentAssistantSaveInputSchema, AgentRunStartInputSchema, type AgentRunRecord } from '@prw/contracts'
import { WorkbenchRepository } from '@prw/database'
import { PiInProcessAdapter, writePiModelsFile, type AgentWorkspaceToolClient } from '@prw/agent-runtime'
import { mcpFixture } from '../../agent-runtime/tests/helpers/mcp-fixture.js'
import { AgentCoordinator } from '../src/agent-coordinator.js'
import { AgentResourceCoordinator } from '../src/agent-resources.js'

test('real Pi SDK function call queues MCP for human approval; SQLite skill text and receipt affect next resumed turn only', { timeout: 45_000 }, async () => {
  const fixture = await mcpFixture()
  type Payload = { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] }
  const captured: Payload[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Payload
      captured.push(payload)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const base = { id: 'resource-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model' }
      const send = (delta: unknown, finish_reason: string | null): void => {
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      }
      if (captured.length === 1) {
        const name = payload.tools?.find((tool) => tool.function.name.startsWith('mcp_'))?.function.name
        assert.ok(name)
        send({ role: 'assistant', tool_calls: [{ index: 0, id: 'remote-request', type: 'function',
          function: { name, arguments: '{"text":"model fixture payload"}' } }] }, null)
        send({}, 'tool_calls')
      } else { send({ role: 'assistant', content: 'Pending request prepared' }, null); send({}, 'stop') }
      response.end('data: [DONE]\n\n')
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const root = mkdtempSync(join(tmpdir(), 'prw-resources-sdk-'))
  const profileRoot = join(root, 'runtime')
  const profileDir = join(profileRoot, 'pi')
  mkdirSync(profileDir, { recursive: true })
  const repository = new WorkbenchRepository({ filePath: ':memory:' })
  const resources = new AgentResourceCoordinator({ repository, readSecret: async () => null })
  const client = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), close: async () => undefined } as AgentWorkspaceToolClient
  writePiModelsFile(profileDir, [{ id: 'resource-fixture', name: 'Resource fixture',
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, api: 'openai-completions',
    models: [{ id: 'fixture-model', name: 'Fixture model', reasoning: false, contextWindow: 64000, maxTokens: 128 }] }])
  const adapter = new PiInProcessAdapter({ openWorkspaceClient: async () => client, persistCredential: async () => undefined, timeoutMs: 10_000 })
  const agent = new AgentCoordinator(repository, { runRoot: join(root, 'runs'), runtimeProfileRoot: profileRoot, agentRuntime: adapter,
    agentResources: resources, requestCredential: async () => ({ provider: 'resource-fixture', credential: { type: 'api_key', key: 'fixture-not-a-real-key' } }) })
  async function settle(run: AgentRunRecord) {
    for (let i = 0; i < 1000; i++) {
      const current = agent.getRun(run.id)
      if (['completed', 'failed', 'blocked', 'canceled'].includes(current.status)) {
        assert.equal(current.status, 'completed', current.error ?? 'Fixture run must complete')
        return current
      }
      await delay(10)
    }
    assert.fail('Fixture run timed out')
  }
  try {
    const saved = repository.agentResources.saveMcpServer({ id: 'mcp.fixture', name: 'Fixture MCP', transport: 'streamable-http', endpoint: fixture.endpoint,
      enabled: true, expectedRevision: null })
    const probed = await resources.probe({ id: saved.id, expectedRevision: saved.revision })
    assert.equal(probed.lastProbe?.status, 'ok')
    const markdown = '---\nname: user-fixture\n---\nUse USER_INSTRUCTION_FIXTURE evidence only. Never run local code.'
    const skill = repository.agentResources.saveInstructionSkill({ id: 'skill.user.fixture', name: 'Fixture instructions', description: 'Text only', enabled: true,
      markdown, expectedRevision: null, confirmed: true })
    const assistant = repository.agentProfiles.saveAssistant(AgentAssistantSaveInputSchema.parse({ id: 'assistant.resource', name: 'Resource SDK fixture',
      provider: 'resource-fixture', model: 'fixture-model', toolProfile: 'approved-write', toolAllowlist: [probed.tools[0]!.key],
      skillKeys: [skill.id], expectedRevision: null }))
    const conversation = agent.createConversation({ title: 'Resource fixture', toolProfile: 'approved-write', permissionMode: 'auto', approvalPolicy: 'never' })
    const input = AgentRunStartInputSchema.parse({ assistantId: assistant.id, conversationId: conversation.id, workflowKey: 'research_plan',
      instructions: 'Prepare the fixture remote request', idempotencyKey: 'resource-first' })
    const first = await settle(await agent.start(input))
    assert.equal(first.output, 'Pending request prepared')
    assert.equal(captured.length, 2, 'Actual SDK executes tool response then returns to model')
    assert.ok(String(captured[0]!.messages.find((message) => message.role === 'system')?.content).includes(markdown))
    assert.ok(captured[1]!.messages.some((message) => message.role === 'tool' && JSON.stringify(message.content).includes('No remote call has executed')))
    assert.equal(fixture.calls.length, 0)
    const call = repository.agentResources.listMcpCalls({ runId: first.id, limit: 10 })[0]!
    assert.equal(call.status, 'pending', 'Successful completion does not automatically approve or invalidate')
    const approved = await resources.decide({ id: call.id, expectedRevision: 0, decision: 'approve', confirmed: true })
    assert.equal(approved.status, 'completed')
    assert.equal(fixture.calls.length, 1)
    repository.agentProfiles.saveBindingMatrix({ updates: [{ assistantId: assistant.id, expectedRevision: assistant.revision, toolAllowlist: [], skillKeys: [] }] })
    await settle(await agent.start({ ...input, instructions: 'Read the human-decided fixture receipt', idempotencyKey: 'resource-second' }))
    assert.equal(captured.length, 3)
    assert.deepEqual(captured[2]!.tools ?? [], [])
    const nextSystem = String(captured[2]!.messages.find((message) => message.role === 'system')?.content)
    assert.ok(!nextSystem.includes(markdown), 'Unbound instruction text is not injected into next system prompt')
    assert.ok(nextSystem.includes(call.id) && nextSystem.includes('model fixture payload'), 'Next turn receives exact persisted human-decided receipt')
    assert.ok(captured[2]!.messages.some((message) => message.role === 'user' && JSON.stringify(message.content).includes('Prepare the fixture')))
    const ledger = repository.listAgentRunRecords({ runId: first.id, beforeSeq: null, afterSeq: null, limit: 100 })
    assert.ok(ledger.some((row) => row.recordKey === `skill:${skill.id}` && row.detail?.includes(skill.contentHash)))
    assert.equal(repository.getManagedAgentRun(first.id).output, first.output)
  } finally {
    resources.dispose(); agent.dispose(); repository.close()
    server.closeAllConnections(); server.close(); await once(server, 'close')
    await fixture.close()
    const relativeRoot = relative(tmpdir(), root)
    assert.ok(!isAbsolute(relativeRoot) && !relativeRoot.startsWith('..') && relativeRoot.startsWith('prw-resources-sdk-'))
    rmSync(root, { recursive: true, force: true })
  }
})
