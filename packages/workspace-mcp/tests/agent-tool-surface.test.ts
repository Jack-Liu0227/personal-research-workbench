import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { openInProcessWorkspaceSession } from '../src/in-process.js'

const ok = (data: unknown) => Promise.resolve({ id: 'test', ok: true as const, data })

describe('embedded workspace MCP surface', () => {
  it('advertises research and connector read tools while keeping destructive/external writes absent', async () => {
    const session = await openInProcessWorkspaceSession(async () => ok(null))
    try {
      const listed = await session.client.listTools()
      const names = new Set(listed.tools.map((tool) => tool.name))
      for (const name of ['literature.search', 'literature.results', 'papers.list', 'notes.list', 'notes.read', 'notes.metadata.preview', 'zotero.capability', 'zotero.collections', 'zotero.items', 'zotero.paperToZotero.preview', 'literature.stagingToZotero.preview', 'automation.rules.list', 'automation.runs.list', 'agent.settings.get', 'intel.rss.sources', 'intel.rss.search', 'intel.rss.refresh', 'tasks.create', 'calendar.create', 'calendar.markers.create']) {
        assert.equal(names.has(name), true, `${name} should be advertised`)
      }
      for (const name of ['tasks.hardDelete', 'notes.write', 'zotero.paperToZotero.execute', 'zotero.deleteRemote.execute', 'bash']) {
        assert.equal(names.has(name), false, `${name} must not be advertised`)
      }
    } finally {
      await session.close()
    }
  })

  /** The Agent may prepare an external write but never perform or approve one.
   * `.request` is the only Zotero/Obsidian verb on this surface, and the
   * decision RPC must not appear as a tool under any name. */
  it('offers external writes as requests and never as execution or approval', async () => {
    const session = await openInProcessWorkspaceSession(async () => ok(null))
    try {
      const listed = await session.client.listTools()
      const names = new Set(listed.tools.map((tool) => tool.name))
      for (const name of ['zotero.paperToZotero.request', 'literature.stagingToZotero.request', 'notes.write.request', 'notes.metadata.request']) {
        assert.equal(names.has(name), true, `${name} should be advertised`)
      }
      for (const name of ['agent.externalActions.decide', 'agent.externalActions.list', 'externalActions.decide']) {
        assert.equal(names.has(name), false, `${name} must not be reachable from the model`)
      }
      for (const tool of listed.tools) {
        assert.equal(/\.(?:execute|apply|delete|remove|sync)$/u.test(tool.name), false, `${tool.name} must not be advertised`)
      }
    } finally {
      await session.close()
    }
  })
})

describe('embedded workspace MCP argument hygiene', () => {
  /** A model that has nothing to filter by sends `''`, not an absent field.
   * The service contracts type ids and keys as `min(1)`, so an empty string
   * used to fail the whole call with an opaque shape error. */
  it('treats blank optional identifiers as absent instead of forwarding empty strings', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const session = await openInProcessWorkspaceSession(async (input) => {
      calls.push(input as { method: string; payload: unknown })
      return ok(null)
    })
    try {
      await session.client.callTool({
        name: 'zotero.items',
        arguments: { profileId: 'profile-1', collectionKey: '', query: '', cursor: null, pageSize: 3 }
      })
    } finally {
      await session.close()
    }
    const request = calls.find((call) => call.method === 'zotero.itemsPage')
    assert.ok(request, 'zotero.itemsPage should have been called')
    assert.deepEqual(request.payload, { profileId: 'profile-1', cursor: null, pageSize: 3 })
  })

  /** Without the issue paths the model only sees "the request did not match the
   * expected shape" and cannot tell which argument to change. */
  it('names the rejected fields when the service refuses a payload', async () => {
    const session = await openInProcessWorkspaceSession(async () => Promise.resolve({
      id: 'test',
      ok: false as const,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'The request did not match the expected shape.',
        retryable: false,
        details: { issues: [{ path: ['collectionKey'], message: 'Too small: expected string to have >=1 characters' }] }
      }
    }))
    try {
      const result = await session.client.callTool({ name: 'zotero.items', arguments: { profileId: 'profile-1' } })
      assert.equal(result.isError, true)
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? ''
      assert.match(text, /collectionKey/)
      assert.match(text, /The request did not match the expected shape\./)
    } finally {
      await session.close()
    }
  })
})
