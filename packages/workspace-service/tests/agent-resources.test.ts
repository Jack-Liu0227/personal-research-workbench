import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentAssistantSaveInputSchema, AgentRunStartInputSchema } from '@prw/contracts'
import { WorkbenchRepository } from '@prw/database'
import { mcpFixture } from '../../agent-runtime/tests/helpers/mcp-fixture.js'
import { AgentResourceCoordinator } from '../src/agent-resources.js'
import { dispatchRpc, type CoreServices } from '../src/dispatcher.js'

async function setup() {
  const fixture = await mcpFixture()
  const repository = new WorkbenchRepository({ filePath: ':memory:' })
  const readIds: string[] = []
  const resources = new AgentResourceCoordinator({ repository, readSecret: async (id) => { readIds.push(id); return 'fixture-secret' }, timeoutMs: 500 })
  const services = { repository, agentResources: resources } as CoreServices
  const server = repository.agentResources.saveMcpServer({ id: 'mcp.fixture', name: 'Fixture', endpoint: fixture.endpoint,
    transport: 'streamable-http', enabled: true, expectedRevision: null })
  const probed = await resources.probe({ id: server.id, expectedRevision: server.revision })
  assert.equal(probed.lastProbe?.status, 'ok')
  assert.equal(probed.tools.length, 1)
  const tool = probed.tools[0]!
  const assistant = repository.agentProfiles.saveAssistant(AgentAssistantSaveInputSchema.parse({ id: 'assistant.resources', name: 'Fixture',
    toolProfile: 'approved-write', toolAllowlist: [tool.key], expectedRevision: null }))
  const input = AgentRunStartInputSchema.parse({ assistantId: assistant.id, workflowKey: 'research_plan', instructions: 'Fixture only', permissionMode: 'auto', toolProfile: 'approved-write' })
  const run = repository.startManagedAgentRun({ ...input, runtime: 'pi', transport: 'inprocess' })
  repository.updateManagedAgentRun({ id: run.id, status: 'running' })
  return { fixture, repository, resources, services, server: probed, tool, assistant, run: repository.getManagedAgentRun(run.id), readIds,
    close: async () => { resources.dispose(); repository.close(); await fixture.close() } }
}
async function request(services: CoreServices, method: string, payload: unknown) {
  return dispatchRpc(services, { version: 'test' }, { id: 'resources-test', method, payload })
}

test('real SDK MCP probe is explicit; model wrapper only queues; completed run approval calls once and stores redacted receipt', async () => {
  const env = await setup()
  try {
    const tools = env.resources.toolsForRun(env.assistant, env.run)
    assert.equal(tools.length, 1)
    assert.equal(env.readIds.length, 1)
    await request(env.services, 'agentMcpServers.list', null)
    const catalog = await request(env.services, 'agentBindings.catalog', null)
    assert.ok(catalog.ok)
    assert.ok((catalog.data as { tools: { name: string; kind: string }[] }).tools.some((tool) => tool.name === env.tool.key && tool.kind === 'external-request'))
    assert.equal(env.readIds.length, 1, 'List/catalog/run tool discovery never connects')
    const response = await tools[0]!.request({ text: 'redact' })
    assert.match(response, /No remote call has executed/u)
    assert.equal(env.fixture.calls.length, 0)
    const call = env.repository.agentResources.listMcpCalls({ limit: 30 })[0]!
    assert.equal(call.status, 'pending')
    env.repository.updateManagedAgentRun({ id: env.run.id, status: 'completed' })
    const result = await env.resources.decide({ id: call.id, expectedRevision: 0, decision: 'approve', confirmed: true })
    assert.equal(result.status, 'completed')
    assert.equal(env.fixture.calls.length, 1)
    assert.equal(result.result, 'Bearer [redacted]')
    await assert.rejects(env.resources.decide({ id: call.id, expectedRevision: 0, decision: 'approve', confirmed: true }))
    assert.equal(env.fixture.calls.length, 1)
    const ledger = env.repository.listAgentRunRecords({ runId: env.run.id, beforeSeq: null, afterSeq: null, limit: 100 })
    assert.equal(ledger.filter((row) => row.recordKey === `mcp:${call.id}`).length, 1)
    assert.ok(!JSON.stringify(ledger).includes('fixture-secret'))
  } finally { await env.close() }
})

test('remote tools cannot be visible to read-only/team/scheduled/legacy runs and invalid args never queue', async () => {
  const env = await setup()
  try {
    for (const run of [{ ...env.run, permissionMode: 'read-only' as const }, { ...env.run, toolProfile: 'read-only' as const },
      { ...env.run, jobId: 'fixture-job' }, { ...env.run, teamRunId: 'fixture-team-run' }]) assert.deepEqual(env.resources.toolsForRun(env.assistant, run), [])
    assert.deepEqual(env.resources.toolsForRun(null, env.run), [])
    assert.deepEqual(env.resources.toolsForRun({ ...env.assistant, toolProfile: 'read-only' }, env.run), [])
    const tool = env.resources.toolsForRun(env.assistant, env.run)[0]!
    for (const args of [{}, { text: 123 }, { text: 'ok', other: true }, null]) await assert.rejects(tool.request(args))
    assert.equal(env.repository.agentResources.listMcpCalls({ limit: 30 }).length, 0)
    assert.equal(env.fixture.calls.length, 0)
  } finally { await env.close() }
})

test('reject, server edit, reprobe, cancel and restart fail closed without remote execution', async () => {
  const env = await setup()
  try {
    async function queue() {
      const tool = env.resources.toolsForRun(env.assistant, env.run)[0]!
      await tool.request({ text: 'safe fixture' })
      return env.repository.agentResources.listMcpCalls({ limit: 30 }).find((call) => call.status === 'pending')!
    }
    const rejected = await queue()
    assert.equal((await env.resources.decide({ id: rejected.id, expectedRevision: 0, decision: 'reject', confirmed: true })).status, 'rejected')
    const canceled = await queue()
    env.resources.cancelRun(env.run.id)
    assert.equal(env.repository.agentResources.getMcpCall(canceled.id).status, 'invalidated')
    const restarted = await queue()
    env.resources.reconcile()
    await assert.rejects(env.resources.decide({ id: restarted.id, expectedRevision: 0, decision: 'approve', confirmed: true }))
    const reprobed = await queue()
    await env.resources.probe({ id: env.server.id, expectedRevision: env.server.revision })
    assert.equal(env.repository.agentResources.getMcpCall(reprobed.id).status, 'invalidated')
    const edited = await queue()
    env.repository.agentResources.saveMcpServer({ id: env.server.id, name: 'Changed', endpoint: env.server.endpoint,
      transport: 'streamable-http', enabled: true, expectedRevision: env.server.revision })
    assert.equal(env.repository.agentResources.getMcpCall(edited.id).status, 'invalidated')
    await assert.rejects(env.resources.decide({ id: edited.id, expectedRevision: 0, decision: 'approve', confirmed: true }))
    assert.equal(env.fixture.calls.length, 0)
  } finally { await env.close() }
})

test('cancel during a real remote call closes transport, terminalizes receipt and never replays', async () => {
  const env = await setup()
  try {
    await env.resources.toolsForRun(env.assistant, env.run)[0]!.request({ text: 'wait' })
    const call = env.repository.agentResources.listMcpCalls({ limit: 30 })[0]!
    const pending = env.resources.decide({ id: call.id, expectedRevision: 0, decision: 'approve', confirmed: true })
    const timer = setInterval(() => { if (env.fixture.calls.length) env.resources.cancelRun(env.run.id) }, 5)
    try { assert.equal((await pending).status, 'invalidated') } finally { clearInterval(timer) }
    assert.equal(env.fixture.calls.length, 1)
    await assert.rejects(env.resources.decide({ id: call.id, expectedRevision: 0, decision: 'approve', confirmed: true }))
    assert.equal(env.fixture.calls.length, 1)
  } finally { await env.close() }
})

test('V2 skill CRUD requires reviewed text; binding catalog updates and changed content unbinds without executing code', async () => {
  const env = await setup()
  try {
    const input = { id: 'skill.user.fixture', name: 'Fixture skill', description: 'Instructions only', enabled: true, expectedRevision: null,
      markdown: '---\nname: fixture-skill\n---\nUse the supplied fixture evidence. Do not execute programs.', confirmed: true }
    assert.ok(!(await request(env.services, 'agentInstructionSkills.save', { ...input, confirmed: undefined })).ok)
    assert.ok(!(await request(env.services, 'agentInstructionSkills.save', { ...input, command: 'powershell' })).ok)
    assert.ok((await request(env.services, 'agentInstructionSkills.save', input)).ok)
    const bound = await request(env.services, 'agentBindings.set', { assistantId: env.assistant.id, expectedRevision: 0, kind: 'skill', key: input.id, enabled: true })
    assert.ok(bound.ok)
    const changed = await request(env.services, 'agentInstructionSkills.save', { ...input, expectedRevision: 0, markdown: `${input.markdown}\nUpdated reviewed instructions.` })
    assert.ok(changed.ok)
    assert.deepEqual(env.repository.agentProfiles.getAssistant(env.assistant.id).skillKeys, [])
    assert.ok(!(await request(env.services, 'agentInstructionSkills.save', { ...input, expectedRevision: 0 })).ok)
    assert.ok(!(await request(env.services, 'agentInstructionSkills.save', { ...input, id: 'literature-matrix' })).ok)
    assert.ok(!(await request(env.services, 'agentMcpServers.save', { id: 'mcp.bad', name: 'Bad', transport: 'stdio', command: 'powershell', expectedRevision: null })).ok)
  } finally { await env.close() }
})

test('probe rejects exact bearer reflection in raw names, descriptions, schema values and keys despite JSON escaping', async () => {
  for (const secret of ['fixture"secret', 'fixture\\secret']) {
    for (const field of ['description', 'name', 'schema-value', 'schema-key']) {
      const fixture = await mcpFixture({
        ...(field === 'description' ? { description: `Untrusted ${secret} reflection` } : {}),
        ...(field === 'name' ? { toolName: secret } : {}),
        ...(field === 'schema-value' ? { inputSchema: { type: 'object', properties: { text: { type: 'string', default: secret } } } } : {}),
        ...(field === 'schema-key' ? { inputSchema: { type: 'object', properties: { [secret]: { type: 'string' } } } } : {})
      })
      const repository = new WorkbenchRepository({ filePath: ':memory:' })
      const resources = new AgentResourceCoordinator({ repository, readSecret: async () => secret })
      try {
        const server = repository.agentResources.saveMcpServer({ id: 'mcp.reflection', name: 'Reflection fixture', transport: 'streamable-http',
          endpoint: fixture.endpoint, enabled: true, expectedRevision: null })
        const probed = await resources.probe({ id: server.id, expectedRevision: server.revision })
        assert.equal(probed.lastProbe?.status, 'failed', `${field}: reflected credential must fail closed`)
        assert.deepEqual(probed.tools, [])
        assert.ok(!JSON.stringify(repository.agentResources.listMcpServers()).includes(JSON.stringify(secret).slice(1, -1)))
      } finally { resources.dispose(); repository.close(); await fixture.close() }
    }
  }
})
