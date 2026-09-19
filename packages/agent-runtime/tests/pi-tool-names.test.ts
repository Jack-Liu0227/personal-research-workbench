import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  agentToolLabels,
  agentToolName,
  agentToolNamePattern,
  agentToolNames,
  workspaceReadTools,
  workspaceWriteTools,
  type AgentWorkspaceToolClient,
  type WorkspaceToolDescriptor
} from '../src/index.js'
import { createWorkspaceExtension } from '../src/pi/extension.js'

const typebox = { Unsafe: (schema: unknown) => schema } as never

function descriptor(name: string): WorkspaceToolDescriptor {
  return { name, description: `${name} description`, inputSchema: {} }
}

function fakePi(): { registered: Array<Record<string, unknown>>; pi: never } {
  const registered: Array<Record<string, unknown>> = []
  const pi = { registerTool: (tool: Record<string, unknown>) => registered.push(tool) }
  return { registered, pi: pi as never }
}

describe('provider-visible tool names', () => {
  it('produces a name every provider accepts', () => {
    for (const name of [...workspaceReadTools, ...workspaceWriteTools]) {
      const provider = agentToolName(name)
      assert.match(provider, agentToolNamePattern, `${name} must sanitize to a legal tool name`)
      assert.ok(provider.length <= 64)
      assert.equal(provider.includes('.'), false)
    }
  })

  it('keeps already-legal names unchanged', () => {
    assert.equal(agentToolName('tasks_search'), 'tasks_search')
    assert.equal(agentToolName('tasks.search'), 'tasks_search')
    assert.equal(agentToolName('zotero.paperToZotero.preview'), 'zotero_paperToZotero_preview')
  })

  it('never returns an empty name', () => {
    assert.equal(agentToolName('...'), '___')
    assert.equal(agentToolName(''), 'tool')
    assert.match(agentToolName('\u4e2d\u6587'), agentToolNamePattern)
  })

  it('truncates to the provider limit', () => {
    const provider = agentToolName(`${'a'.repeat(80)}.b`)
    assert.equal(provider.length, 64)
    assert.match(provider, agentToolNamePattern)
  })

  it('disambiguates names that sanitize to the same string', () => {
    const names = agentToolNames(['a.b', 'a b', 'a-b', 'a.b'])
    assert.equal(names.size, 3, 'a repeated input name keeps one mapping')
    const values = [...names.values()]
    assert.equal(new Set(values).size, values.length, 'no two tools share a registered name')
    assert.equal(names.get('a.b'), 'a_b')
    assert.equal(names.get('a b'), 'a_b_2')
    assert.equal(names.get('a-b'), 'a-b')
    for (const value of values) assert.match(value, agentToolNamePattern)
  })

  it('maps the provider name back to the workbench name', () => {
    // The ledger is read by people, so a tool call prints the dotted MCP name.
    // Direction is the whole point: the registration map is keyed the other way.
    const labels = agentToolLabels(['tasks.search', 'a.b', 'a b'])
    assert.equal(labels.get('tasks_search'), 'tasks.search')
    assert.equal(labels.get('a_b'), 'a.b')
    assert.equal(labels.get('a_b_2'), 'a b', 'the collision suffix resolves to its own tool')
    assert.equal(labels.size, 3)
  })

  it('keeps the suffix inside the provider limit', () => {
    const long = 'x'.repeat(64)
    const names = agentToolNames([long, `${long}y`])
    for (const value of [...names.values()]) {
      assert.ok(value.length <= 64, `${value} is longer than the provider limit`)
      assert.match(value, agentToolNamePattern)
    }
    assert.equal(new Set(names.values()).size, 2)
  })
})

describe('workbench extension registration', () => {
  it('registers the provider name and calls the workbench with the dotted name', async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = []
    const client: AgentWorkspaceToolClient = {
      listTools: async () => [],
      callTool: async (request) => {
        calls.push(request as { name: string; arguments?: Record<string, unknown> })
        return { content: [{ type: 'text', text: 'found 2' }] }
      }
    } as AgentWorkspaceToolClient
    const { registered, pi } = fakePi()
    const extension = createWorkspaceExtension({ typebox, client, tools: [descriptor('tasks.search')] })
    extension.factory(pi)
    assert.equal(registered.length, 1)
    const tool = registered[0]!
    assert.equal(tool['name'], 'tasks_search')
    assert.equal(tool['label'], 'tasks.search')
    assert.match(String(tool['name']), agentToolNamePattern)
    const execute = tool['execute'] as (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>
    const result = await execute('call-1', { query: 'x' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.name, 'tasks.search', 'the MCP call still uses the real tool name')
    assert.deepEqual(calls[0]!.arguments, { query: 'x' })
    assert.equal(result.content[0]!.text, 'found 2')
  })
})
