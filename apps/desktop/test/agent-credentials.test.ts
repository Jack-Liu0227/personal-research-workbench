import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AGENT_RUNTIMES,
  AgentCredentialUnsupportedError,
  agentCredentialStorageKey,
  listAgentCredentialStatuses,
  resolveAgentCredentials,
  saveAgentCredential,
  type AgentCredentialStore
} from '../src/main/agent-credentials.js'

/**
 * In-memory stand-in for the Electron safeStorage vault. The module under test
 * only depends on this structural interface, so the credential protocol can be
 * exercised without launching Electron or touching a real vault file.
 */
function memoryStore(initial: Record<string, string> = {}): AgentCredentialStore {
  const entries = new Map(Object.entries(initial))
  return {
    get: (key) => Promise.resolve(entries.get(key) ?? null),
    set: (key, secret) => {
      entries.set(key, secret)
      return Promise.resolve()
    },
    remove: (key) => {
      entries.delete(key)
      return Promise.resolve()
    }
  }
}

test('an untouched vault reports every runtime as unconfigured', async () => {
  const statuses = await listAgentCredentialStatuses(memoryStore())
  assert.deepEqual(statuses.map((status) => status.runtime), [...AGENT_RUNTIMES])
  for (const status of statuses) {
    assert.equal(status.credentialPresent, false)
    assert.equal(status.provider, null)
    assert.equal(status.envVar, null)
    assert.equal(status.updatedAt, null)
  }
})

test('a saved credential exposes only the provider and its documented variable', async () => {
  const store = memoryStore()
  const statuses = await saveAgentCredential(store, { runtime: 'pi', provider: 'anthropic', apiKey: 'sk-ant-test' })
  const pi = statuses.find((status) => status.runtime === 'pi')
  assert.equal(pi?.credentialPresent, true)
  assert.equal(pi?.provider, 'anthropic')
  assert.equal(pi?.envVar, 'ANTHROPIC_API_KEY')
  assert.match(pi?.updatedAt ?? '', /^\d{4}-\d{2}-\d{2}T/u)
  // The secret is never part of the status projection.
  assert.equal(JSON.stringify(statuses).includes('sk-ant-test'), false)
  // The other runtime stays untouched.
  assert.equal(statuses.find((status) => status.runtime === 'codex')?.credentialPresent, false)
})

test('saving with a null key clears the stored credential', async () => {
  const store = memoryStore()
  await saveAgentCredential(store, { runtime: 'codex', provider: 'openai', apiKey: 'sk-openai-test' })
  const cleared = await saveAgentCredential(store, { runtime: 'codex', provider: 'openai', apiKey: null })
  const codex = cleared.find((status) => status.runtime === 'codex')
  assert.equal(codex?.credentialPresent, false)
  assert.equal(codex?.provider, null)
  assert.equal(await resolveAgentCredentials(store).then((entries) => entries.length), 0)
})

test('a provider the runtime does not document is refused before anything is written', async () => {
  const store = memoryStore()
  await assert.rejects(
    () => saveAgentCredential(store, { runtime: 'codex', provider: 'anthropic', apiKey: 'sk-ant-test' }),
    AgentCredentialUnsupportedError
  )
  const codex = await listAgentCredentialStatuses(store)
  assert.equal(codex.find((status) => status.runtime === 'codex')?.credentialPresent, false)
})

test('an unknown or corrupt entry is reported as absent instead of usable', async () => {
  const store = memoryStore({
    [agentCredentialStorageKey('codex')]: 'not-json',
    [agentCredentialStorageKey('pi')]: JSON.stringify({ provider: 'not-a-provider', secret: 'x', updatedAt: 'nope' })
  })
  const statuses = await listAgentCredentialStatuses(store)
  assert.deepEqual(statuses.map((status) => status.credentialPresent), [false, false])
  assert.deepEqual(await resolveAgentCredentials(store), [])
})

test('resolve returns one envelope entry per configured runtime', async () => {
  const store = memoryStore()
  await saveAgentCredential(store, { runtime: 'codex', provider: 'openai', apiKey: 'sk-openai-test' })
  await saveAgentCredential(store, { runtime: 'pi', provider: 'openai', apiKey: 'sk-pi-test' })
  const resolved = await resolveAgentCredentials(store)
  assert.deepEqual(
    resolved.map((entry) => [entry.runtime, entry.provider, entry.secret]),
    [['codex', 'openai', 'sk-openai-test'], ['pi', 'openai', 'sk-pi-test']]
  )
})

test('the vault key matches the credentialKey(provider, runtime) namespace', async () => {
  assert.equal(agentCredentialStorageKey('codex'), 'v2:provider:codex')
  assert.equal(agentCredentialStorageKey('pi'), 'v2:provider:pi')
})
