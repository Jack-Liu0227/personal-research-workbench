import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AppCredentialStore,
  effectivePermissionMode,
  isBlockedWorkspaceTool,
  normalizeToolParametersSchema,
  selectWorkspaceTools,
  toToolParameters,
  workspaceExternalRequestTools,
  workspaceReadTools,
  workspaceWriteTools,
  type AgentCredentialBridge,
  type WorkspaceToolDescriptor
} from '../src/index.js'

type Credential = Awaited<ReturnType<AgentCredentialBridge['read']>>

function apiKey(key: string): Credential {
  return { type: 'api_key', key } as Credential
}

/** Records every write the store performed, in order, so serialization can be
 * asserted by sequence instead of by wall-clock timing. */
function recordingBridge(initial: Array<{ provider: string; credential: unknown }> = []): {
  bridge: AgentCredentialBridge
  writes: Array<{ provider: string; credential: unknown }>
} {
  const writes: Array<{ provider: string; credential: unknown }> = []
  const entries = new Map(initial.map((entry) => [entry.provider, entry.credential]))
  return {
    writes,
    bridge: {
      read: (provider: string) => entries.get(provider) as Credential,
      list: () => [...entries].map(([provider, credential]) => ({ provider, credential })),
      persist: async (provider: string, credential: unknown) => {
        // Await a macrotask so a missing lock would interleave here.
        await new Promise((resolve) => setTimeout(resolve, 1))
        writes.push({ provider, credential })
        if (credential === null) entries.delete(provider)
        else entries.set(provider, credential)
      }
    } as unknown as AgentCredentialBridge
  }
}

describe('AppCredentialStore (Pi CredentialStore contract)', () => {
  it('hydrates from the vault instead of any user-level Pi credential file', async () => {
    const { bridge } = recordingBridge([{ provider: 'openai', credential: apiKey('stored') }])
    const store = new AppCredentialStore(bridge)
    assert.deepEqual(await store.read('openai'), apiKey('stored'))
    assert.deepEqual(await store.list(), [{ providerId: 'openai', type: 'api_key' }])
  })

  it('persists through the bridge before resolving modify', async () => {
    const { bridge, writes } = recordingBridge()
    const store = new AppCredentialStore(bridge)
    await store.modify('anthropic', async () => apiKey('fresh'))
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0], { provider: 'anthropic', credential: apiKey('fresh') })
    assert.deepEqual(await store.read('anthropic'), apiKey('fresh'))
  })

  it('treats an undefined result as "leave unchanged" rather than a delete', async () => {
    const { bridge, writes } = recordingBridge([{ provider: 'openai', credential: apiKey('stored') }])
    const store = new AppCredentialStore(bridge)
    const result = await store.modify('openai', async () => undefined)
    assert.deepEqual(result, apiKey('stored'))
    assert.equal(writes.length, 0, 'no write happens for a no-op modify')
  })

  it('serializes concurrent modifies for one provider so a refresh cannot race', async () => {
    const { bridge, writes } = recordingBridge([{ provider: 'openai', credential: apiKey('v1') }])
    const store = new AppCredentialStore(bridge)
    const order: string[] = []
    await Promise.all([
      store.modify('openai', async (current) => {
        const seen = (current as { key?: string } | undefined)?.key
        order.push(`first:${seen}`)
        return apiKey('v2')
      }),
      store.modify('openai', async (current) => {
        const seen = (current as { key?: string } | undefined)?.key
        order.push(`second:${seen}`)
        return apiKey('v3')
      })
    ])
    assert.deepEqual(order, ['first:v1', 'second:v2'], 'the second writer must observe the first write')
    assert.deepEqual(writes.map((entry) => (entry.credential as { key: string }).key), ['v2', 'v3'])
  })

  it('deletes through the bridge so Main clears the vault, not just memory', async () => {
    const { bridge, writes } = recordingBridge([{ provider: 'openai', credential: apiKey('stored') }])
    const store = new AppCredentialStore(bridge)
    await store.delete('openai')
    assert.equal(await store.read('openai'), undefined)
    assert.deepEqual(writes, [{ provider: 'openai', credential: null }])
  })

  it('aborts before touching the bridge when the run is already cancelled', async () => {
    const { bridge, writes } = recordingBridge()
    const store = new AppCredentialStore(bridge)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(store.modify('openai', async () => apiKey('x'), { signal: controller.signal }))
    assert.equal(writes.length, 0)
  })
})

describe('workspace tool policy', () => {
  const advertised: WorkspaceToolDescriptor[] = [
    ...workspaceReadTools.map((name) => ({ name, description: name, inputSchema: {} })),
    ...workspaceWriteTools.map((name) => ({ name, description: name, inputSchema: {} })),
    ...workspaceExternalRequestTools.map((name) => ({ name, description: name, inputSchema: {} })),
    { name: 'tasks.hardDelete', description: 'dangerous', inputSchema: {} },
    { name: 'zotero.sync', description: 'external write', inputSchema: {} },
    { name: 'unknown.futureTool', description: 'not allowlisted', inputSchema: {} }
  ]

  it('derives the permission mode from the legacy tool profile', () => {
    assert.equal(effectivePermissionMode({ toolProfile: 'approved-write' }), 'auto')
    assert.equal(effectivePermissionMode({ toolProfile: 'read-only' }), 'read-only')
    assert.equal(effectivePermissionMode({ permissionMode: 'full-access', toolProfile: 'read-only' }), 'full-access')
  })

  it('registers read tools only when the run is read-only', () => {
    const selected = selectWorkspaceTools(advertised, { permissionMode: 'read-only', toolProfile: 'read-only' })
    assert.deepEqual(new Set(selected.map((tool) => tool.name)), new Set(workspaceReadTools))
  })

  it('adds record writes but never destructive or external-effect tools', () => {
    const selected = selectWorkspaceTools(advertised, { permissionMode: 'auto', toolProfile: 'approved-write' })
    assert.deepEqual(
      new Set(selected.map((tool) => tool.name)),
      new Set([...workspaceReadTools, ...workspaceWriteTools, ...workspaceExternalRequestTools])
    )
    for (const name of ['tasks.hardDelete', 'zotero.sync', 'unknown.futureTool']) {
      assert.equal(selected.some((tool) => tool.name === name), false, `${name} must never be registered`)
    }
  })

  it('never exposes an external write that executes, only one that asks', () => {
    // The whole safety argument for Agent-driven Zotero/Obsidian writes rests on
    // this: `.execute` and bare `.write` exist in the service surface, so the
    // allowlist has to be what keeps them out of the model's tool list.
    const selected = selectWorkspaceTools(advertised, { permissionMode: 'full-access', toolProfile: 'approved-write' })
    for (const tool of selected) {
      assert.equal(/\.(?:execute|apply|delete|remove|sync)$/u.test(tool.name), false, tool.name + ' must never be registered')
    }
    assert.equal(selected.some((tool) => tool.name === 'notes.write'), false)
    assert.equal(selected.some((tool) => tool.name === 'zotero.paperToZotero.execute'), false)
  })

  it('does not let a read-only run queue external writes', () => {
    const selected = selectWorkspaceTools(advertised, { permissionMode: 'read-only', toolProfile: 'read-only' })
    for (const name of workspaceExternalRequestTools) {
      assert.equal(selected.some((tool) => tool.name === name), false, name + ' must not reach a read-only run')
    }
  })

  it('drops blocked names even when they appear in the allowlist', () => {
    assert.equal(isBlockedWorkspaceTool('tasks.hardDelete'), true)
    assert.equal(isBlockedWorkspaceTool('calendar.bulkDelete'), true)
    assert.equal(isBlockedWorkspaceTool('projects.archive'), true)
    assert.equal(isBlockedWorkspaceTool('zotero.collections.create'), true)
    assert.equal(isBlockedWorkspaceTool('tasks.create'), false)
  })

  it('skips allowlisted tools an older server does not advertise', () => {
    const selected = selectWorkspaceTools([{ name: 'tasks.search', description: 'x', inputSchema: {} }], { toolProfile: 'approved-write' })
    assert.deepEqual(selected.map((tool) => tool.name), ['tasks.search'])
  })
})

describe('MCP JSON Schema to Pi tool parameters', () => {
  it('strips the keywords Pi re-derives', () => {
    assert.deepEqual(
      normalizeToolParametersSchema({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false, properties: { title: { type: 'string' } } }),
      { type: 'object', properties: { title: { type: 'string' } } }
    )
  })

  it('falls back to an empty object schema for a malformed input', () => {
    assert.deepEqual(normalizeToolParametersSchema(null), { type: 'object', properties: {} })
    assert.deepEqual(normalizeToolParametersSchema(['not', 'a', 'schema']), { type: 'object', properties: {} })
  })

  it('prefers Type.Unsafe and falls back to the raw schema without it', () => {
    const normalized = { type: 'object' }
    const unsafe = { Type: { Unsafe: (input: unknown) => ({ unsafe: input }) } }
    assert.deepEqual(toToolParameters(unsafe, { $schema: 'x', type: 'object' }), { unsafe: normalized })
    assert.deepEqual(toToolParameters({} as never, { $schema: 'x', type: 'object' }), normalized)
  })
})
