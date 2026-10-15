import { afterEach, test } from 'node:test'
import { deepEqual, strictEqual, ok } from 'node:assert/strict'
import { AgentAssistantSaveInputSchema, type AgentBindingCatalog } from '@prw/contracts'
import { WorkbenchRepository } from '@prw/database'
import { dispatchRpc, type CoreServices } from '../src/dispatcher.ts'
import { resolveAgentSkill } from '../src/skill-registry.ts'

const repositories: WorkbenchRepository[] = []
function service(): CoreServices {
  const repository = new WorkbenchRepository({ filePath: ':memory:' })
  repositories.push(repository)
  return { repository } as CoreServices
}
async function request(services: CoreServices, method: string, payload: unknown) {
  return dispatchRpc(services, { version: 'test' }, { id: 'profile-test', method, payload })
}
afterEach(() => { while (repositories.length) repositories.pop()?.close() })

test('V2 profile dispatch validates catalog-bound tools, forbids shell and preserves saved state', async () => {
  const services = service()
  const catalog = await request(services, 'agentBindings.catalog', null)
  ok(catalog.ok)
  strictEqual((catalog.data as { remoteMcpSupported: boolean }).remoteMcpSupported, true)
  const input = { id: 'assistant.dispatch', name: 'Dispatcher assistant', toolAllowlist: ['tasks.search'], expectedRevision: null }
  const saved = await request(services, 'assistants.save', input)
  ok(saved.ok)
  const denied = await request(services, 'assistants.save', { ...input, expectedRevision: 0, toolAllowlist: ['bash'] })
  ok(!denied.ok)
  strictEqual(services.repository.agentProfiles.getAssistant(input.id).toolAllowlist[0], 'tasks.search')
  const stale = await request(services, 'assistants.save', input)
  ok(!stale.ok)
  strictEqual(stale.error.code, 'REVISION_CONFLICT')
})

test('V2 request ingress rejects secret and arbitrary MCP fields, fail closed without runtime', async () => {
  const services = service()
  const secret = await request(services, 'assistants.save', { id: 'assistant.dispatch', name: 'Test', expectedRevision: null, credential: 'fixture-not-a-real-key' })
  ok(!secret.ok)
  const mcp = await request(services, 'assistants.save', { id: 'assistant.dispatch', name: 'Test', expectedRevision: null, mcpServers: [{ command: 'bash' }] })
  ok(!mcp.ok)
  const blocked = await request(services, 'agentTeams.runs.start', { teamId: 'team.test', expectedRevision: 0, instructions: 'Test', idempotencyKey: 'test' })
  ok(!blocked.ok)
})

test('strict archive ingress requires confirmation; invalid skill is not persisted', async () => {
  const services = service()
  const input = { id: 'assistant.archive', name: 'Test', expectedRevision: null }
  ok((await request(services, 'assistants.save', input)).ok)
  ok(!(await request(services, 'assistants.archive', { id: input.id, expectedRevision: 0 })).ok)
  ok(!(await request(services, 'assistants.save', { ...input, expectedRevision: 0, skillKeys: ['arbitrary-user-code'] })).ok)
  strictEqual(services.repository.agentProfiles.getAssistant(input.id).revision, 0)
  ok((await request(services, 'assistants.archive', { id: input.id, expectedRevision: 0, confirmed: true })).ok)
  ok(!services.repository.agentProfiles.listAssistants().some((assistant) => assistant.id === input.id))
})

test('matrix projects authoritative catalog and single-cell updates preserve the other kind and configuration', async () => {
  const services = service()
  const saved = await request(services, 'assistants.save', { id: 'assistant.matrix', name: 'Matrix', description: 'Keep description',
    provider: 'anthropic', model: 'fixture', thinking: 'low', systemPrompt: 'Keep prompt', expectedRevision: null })
  ok(saved.ok)
  const matrix = await request(services, 'agentBindings.matrix', null)
  ok(matrix.ok)
  const catalog = (matrix.data as { catalog: AgentBindingCatalog }).catalog
  strictEqual(catalog.remoteMcpSupported, true)
  ok(!catalog.skills.some((skill) => skill.key === 'last30days'))
  ok(catalog.skills.length > 0)
  ok(catalog.skills.every((skill) => resolveAgentSkill(skill.key).kind === 'instruction'))
  const skillKey = catalog.skills[0]!.key
  ok((await request(services, 'agentBindings.set', { assistantId: 'assistant.matrix', expectedRevision: 0,
    kind: 'skill', key: skillKey, enabled: true })).ok)
  ok((await request(services, 'agentBindings.set', { assistantId: 'assistant.matrix', expectedRevision: 1,
    kind: 'tool', key: 'tasks.search', enabled: true })).ok)
  const changed = services.repository.agentProfiles.getAssistant('assistant.matrix')
  deepEqual(changed.toolAllowlist, ['tasks.search'])
  deepEqual(changed.skillKeys, [skillKey])
  strictEqual(changed.description, 'Keep description')
  strictEqual(changed.systemPrompt, 'Keep prompt')
  strictEqual(changed.model, 'fixture')
  strictEqual(changed.thinking, 'low')
  ok((await request(services, 'agentBindings.set', { assistantId: changed.id, expectedRevision: changed.revision,
    kind: 'tool', key: 'tasks.search', enabled: false })).ok)
  const disabled = services.repository.agentProfiles.getAssistant(changed.id)
  deepEqual(disabled.toolAllowlist, [])
  deepEqual(disabled.skillKeys, [skillKey])
  const stale = await request(services, 'agentBindings.set', { assistantId: changed.id, expectedRevision: changed.revision,
    kind: 'tool', key: 'calendar.list', enabled: true })
  ok(!stale.ok)
  strictEqual(stale.error.code, 'REVISION_CONFLICT')
  strictEqual(services.repository.agentProfiles.getAssistant(changed.id).revision, disabled.revision)
})

test('matrix batch validates every assistant before committing and stale CAS has no partial updates', async () => {
  const services = service()
  for (const id of ['assistant.matrix-a', 'assistant.matrix-b']) {
    ok((await request(services, 'assistants.save', { id, name: id, toolAllowlist: ['tasks.search'], expectedRevision: null })).ok)
  }
  const updates = [
    { assistantId: 'assistant.matrix-a', expectedRevision: 0, toolAllowlist: [] },
    { assistantId: 'assistant.matrix-b', expectedRevision: 0, toolAllowlist: ['calendar.list'] }
  ]
  const invalid = await request(services, 'agentBindings.saveMatrix', { updates: [updates[0], { ...updates[1], toolAllowlist: ['bash'] }] })
  ok(!invalid.ok)
  for (const update of updates) strictEqual(services.repository.agentProfiles.getAssistant(update.assistantId).revision, 0)
  const stale = await request(services, 'agentBindings.saveMatrix', { updates: [updates[0], { ...updates[1], expectedRevision: 1 }] })
  ok(!stale.ok)
  strictEqual(stale.error.code, 'REVISION_CONFLICT')
  deepEqual(services.repository.agentProfiles.getAssistant('assistant.matrix-a').toolAllowlist, ['tasks.search'])
  const saved = await request(services, 'agentBindings.saveMatrix', { updates })
  ok(saved.ok)
  deepEqual(services.repository.agentProfiles.getAssistant('assistant.matrix-a').toolAllowlist, [])
  deepEqual(services.repository.agentProfiles.getAssistant('assistant.matrix-b').toolAllowlist, ['calendar.list'])
})

test('read-only bindings reject newly enabled writes and engine skills, but old invalid bindings can be cleaned incrementally', async () => {
  const services = service()
  const current = services.repository.agentProfiles.saveAssistant(AgentAssistantSaveInputSchema.parse({ id: 'assistant.legacy', name: 'Legacy', expectedRevision: null,
    toolAllowlist: ['old-tool', 'tasks.create'], skillKeys: ['old-skill'] }))
  for (const [kind, key] of [['tool', 'tasks.create'], ['tool', 'notes.write.request'], ['tool', 'old-tool'], ['skill', 'old-skill'], ['skill', 'last30days']]) {
    const denied = await request(services, 'agentBindings.set', { assistantId: current.id, expectedRevision: 0, kind, key, enabled: true })
    ok(!denied.ok)
  }
  const retained = await request(services, 'agentBindings.saveMatrix', { updates: [{ assistantId: current.id, expectedRevision: 0,
    toolAllowlist: ['old-tool', 'tasks.create', 'tasks.search'] }] })
  ok(retained.ok)
  ok((await request(services, 'agentBindings.set', { assistantId: current.id, expectedRevision: 1,
    kind: 'tool', key: 'old-tool', enabled: false })).ok)
  deepEqual(services.repository.agentProfiles.getAssistant(current.id).skillKeys, ['old-skill'])
  ok((await request(services, 'agentBindings.set', { assistantId: current.id, expectedRevision: 2,
    kind: 'skill', key: 'old-skill', enabled: false })).ok)
  deepEqual(services.repository.agentProfiles.getAssistant(current.id).toolAllowlist, ['tasks.create', 'tasks.search'])
  strictEqual(services.repository.agentProfiles.getAssistant(current.id).revision, 3)
  const profile = { id: 'assistant.write', name: 'Writer', toolProfile: 'approved-write', toolAllowlist: ['tasks.create'], expectedRevision: null }
  ok((await request(services, 'assistants.save', profile)).ok)
  ok(!(await request(services, 'assistants.save', { ...profile, expectedRevision: 0, toolProfile: 'read-only' })).ok)
  strictEqual(services.repository.agentProfiles.getAssistant(profile.id).toolProfile, 'approved-write')
  ok((await request(services, 'agentBindings.set', { assistantId: profile.id, expectedRevision: 0,
    kind: 'tool', key: 'notes.write.request', enabled: true })).ok)
  const readOnly = { id: 'assistant.readonly', name: 'Read only', expectedRevision: null }
  ok((await request(services, 'assistants.save', readOnly)).ok)
  ok(!(await request(services, 'agentBindings.saveMatrix', { updates: [{ assistantId: readOnly.id, expectedRevision: 0,
    toolAllowlist: ['tasks.create'] }] })).ok)
  strictEqual(services.repository.agentProfiles.getAssistant(readOnly.id).revision, 0)
})

test('matrix includes disabled configurable assistants, excludes archived and rejects archived mutation', async () => {
  const services = service()
  for (const [id, enabled] of [['assistant.disabled', false], ['assistant.removed', true]] as const) {
    ok((await request(services, 'assistants.save', { id, name: id, enabled, expectedRevision: null })).ok)
  }
  ok((await request(services, 'assistants.archive', { id: 'assistant.removed', expectedRevision: 0, confirmed: true })).ok)
  const result = await request(services, 'agentBindings.matrix', null)
  ok(result.ok)
  const assistants = (result.data as { assistants: Array<{ id: string; enabled: boolean }> }).assistants
  ok(assistants.some((assistant) => assistant.id === 'assistant.disabled' && !assistant.enabled))
  ok(!assistants.some((assistant) => assistant.id === 'assistant.removed'))
  ok((await request(services, 'agentBindings.set', { assistantId: 'assistant.disabled', expectedRevision: 0,
    kind: 'tool', key: 'tasks.search', enabled: true })).ok)
  ok(!(await request(services, 'agentBindings.set', { assistantId: 'assistant.removed', expectedRevision: 1,
    kind: 'tool', key: 'tasks.search', enabled: true })).ok)
})

test('matrix strict ingress rejects duplicates, unknown fields, credentials and arbitrary MCP transport', async () => {
  const services = service()
  const cell = { assistantId: 'assistant.default', expectedRevision: 0, kind: 'tool', key: 'tasks.search', enabled: true }
  for (const payload of [{ ...cell, kind: 'mcp' }, { ...cell, command: 'bash' }, { ...cell, env: { token: 'fixture' } },
    { ...cell, credential: 'fixture-not-a-real-key' }, { ...cell, enabled: 'true' }]) {
    ok(!(await request(services, 'agentBindings.set', payload)).ok)
  }
  const update = { assistantId: cell.assistantId, expectedRevision: 0, toolAllowlist: [] }
  for (const payload of [{ updates: [update, update] }, { updates: [{ ...update, mcpServers: [] }] },
    { updates: [{ ...update, toolAllowlist: ['tasks.search', 'tasks.search'] }] }, { updates: [] }]) {
    ok(!(await request(services, 'agentBindings.saveMatrix', payload)).ok)
  }
  ok(!(await request(services, 'agentBindings.matrix', { command: 'bash' })).ok)
})
