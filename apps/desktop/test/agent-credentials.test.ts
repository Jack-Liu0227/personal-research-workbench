import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AGENT_CREDENTIAL_ENVELOPE_MAX_ENTRIES, AgentCredentialEnvelopeSchema } from '@prw/contracts'
import {
  AGENT_CREDENTIAL_INDEX_KEY,
  AGENT_CREDENTIAL_KEY_PREFIX,
  AgentCredentialInvalidError,
  agentCredentialStorageKey,
  listAgentCredentialStatuses,
  removeAgentCredential,
  resolveAgentCredentials,
  saveAgentCredential,
  writeAgentCredential,
  type AgentCredentialStore
} from '../src/main/agent-credentials.js'
import { CredentialVault, CredentialVaultError, isCredentialStoreKey, type SecretCryptography } from '../src/main/credentials.js'

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

/** The catalog is owned by the embedded Pi SDK; tests only need provider ids and
 * display names, which is exactly what Main consumes. */
const CATALOG = [
  { provider: 'anthropic', name: 'Anthropic' },
  { provider: 'openai', name: 'OpenAI' }
]

test('an untouched vault reports every catalog provider as unconfigured', async () => {
  const statuses = await listAgentCredentialStatuses(memoryStore(), CATALOG)
  assert.deepEqual(statuses.map((status) => status.provider), ['anthropic', 'openai'])
  for (const status of statuses) {
    assert.equal(status.credentialPresent, false)
    assert.equal(status.authType, null)
    assert.equal(status.updatedAt, null)
  }
  assert.equal(JSON.stringify(statuses).includes('secret'), false)
})

test('a saved API key exposes only status, never the secret', async () => {
  const store = memoryStore()
  await saveAgentCredential(store, { provider: 'anthropic', apiKey: 'sk-ant-test' }, CATALOG)
  const statuses = await listAgentCredentialStatuses(store, CATALOG)
  const anthropic = statuses.find((status) => status.provider === 'anthropic')
  assert.equal(anthropic?.credentialPresent, true)
  assert.equal(anthropic?.authType, 'api_key')
  assert.equal(anthropic?.label, 'Anthropic')
  assert.match(anthropic?.updatedAt ?? '', /^\d{4}-\d{2}-\d{2}T/u)
  assert.equal(JSON.stringify(statuses).includes('sk-ant-test'), false)
  assert.equal(statuses.find((status) => status.provider === 'openai')?.credentialPresent, false)
})

test('saving with a null key clears the credential and the index entry', async () => {
  const store = memoryStore()
  await saveAgentCredential(store, { provider: 'openai', apiKey: 'sk-openai-test' }, CATALOG)
  const cleared = await saveAgentCredential(store, { provider: 'openai', apiKey: null }, CATALOG)
  assert.equal(cleared.find((status) => status.provider === 'openai')?.credentialPresent, false)
  assert.equal(await store.get(agentCredentialStorageKey('openai')), null)
  // An empty index is written rather than the key being removed; both mean "no
  // provider is configured", which is what the readers key off.
  assert.deepEqual(JSON.parse((await store.get(AGENT_CREDENTIAL_INDEX_KEY)) ?? '[]'), [])
  assert.deepEqual(await resolveAgentCredentials(store), [])
})

test('an empty string is treated as a clear, not as a stored empty key', async () => {
  const store = memoryStore()
  await saveAgentCredential(store, { provider: 'openai', apiKey: 'sk-openai-test' }, CATALOG)
  await saveAgentCredential(store, { provider: 'openai', apiKey: '' }, CATALOG)
  assert.equal(await store.get(agentCredentialStorageKey('openai')), null)
})

test('an unclassifiable credential is refused before anything is written', async () => {
  const store = memoryStore()
  await assert.rejects(() => writeAgentCredential(store, 'openai', { unexpected: true }), AgentCredentialInvalidError)
  assert.equal(await store.get(AGENT_CREDENTIAL_INDEX_KEY), null)
})

test('an unknown provider stays visible so a stale credential can be deleted', async () => {
  const store = memoryStore()
  await saveAgentCredential(store, { provider: 'openai', apiKey: 'sk-openai-test' }, CATALOG)
  // Simulates a provider the SDK stopped shipping: the vault still has it.
  const statuses = await listAgentCredentialStatuses(store, [{ provider: 'anthropic', name: 'Anthropic' }])
  const orphan = statuses.find((status) => status.provider === 'openai')
  assert.equal(orphan?.credentialPresent, true, 'an orphaned credential must remain listed')
  assert.equal(orphan?.label, 'openai', 'no catalog name is available, so the id is shown')
})

test('a corrupt payload or index entry is reported as absent instead of usable', async () => {
  const store = memoryStore({
    [agentCredentialStorageKey('openai')]: 'not-json',
    [AGENT_CREDENTIAL_INDEX_KEY]: JSON.stringify(['openai', 'anthropic'])
  })
  const statuses = await listAgentCredentialStatuses(store, CATALOG)
  assert.deepEqual(statuses.map((status) => status.credentialPresent), [false, false])
  assert.deepEqual(await resolveAgentCredentials(store), [])
  assert.deepEqual(JSON.parse((await store.get(AGENT_CREDENTIAL_INDEX_KEY)) ?? '[]'), [], 'the dead index entry is dropped')
})

test('resolve returns one provider-keyed envelope entry per configured provider', async () => {
  const store = memoryStore()
  await saveAgentCredential(store, { provider: 'openai', apiKey: 'sk-openai-test' }, CATALOG)
  await saveAgentCredential(store, { provider: 'anthropic', apiKey: 'sk-ant-test' }, CATALOG)
  const resolved = await resolveAgentCredentials(store)
  assert.deepEqual(
    resolved.map((entry) => [entry.provider, (entry.credential as { key?: string }).key]),
    [['anthropic', 'sk-ant-test'], ['openai', 'sk-openai-test']]
  )
})

test('removeAgentCredential clears one provider without touching the others', async () => {
  const store = memoryStore()
  await saveAgentCredential(store, { provider: 'openai', apiKey: 'sk-openai-test' }, CATALOG)
  await saveAgentCredential(store, { provider: 'anthropic', apiKey: 'sk-ant-test' }, CATALOG)
  await removeAgentCredential(store, 'openai')
  const statuses = await listAgentCredentialStatuses(store, CATALOG)
  assert.equal(statuses.find((status) => status.provider === 'openai')?.credentialPresent, false)
  assert.equal(statuses.find((status) => status.provider === 'anthropic')?.credentialPresent, true)
})

/** The real vault, with encryption replaced by a reversible stand-in. The key
 * validation and the file format are the parts under test, not safeStorage. */
function fakeCryptography(): SecretCryptography {
  return {
    isAvailable: () => true,
    encrypt: (value) => Buffer.from(value, 'utf8'),
    decrypt: (value) => value.toString('utf8')
  }
}

async function withVaultFile(run: (filePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'prw-credential-vault-'))
  try {
    await run(join(directory, 'workspace-secrets.json'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * Regression for the reported "the API Key cannot be saved" failure.
 *
 * Saving a provider credential also writes the non-secret provider index into
 * the same encrypted file. The vault's read path validates every key before it
 * returns anything, and its pattern only accepted per-credential keys — so the
 * write that added the index made the user's whole vault unreadable, the save
 * request failed, and every later status read, clear and run failed with "the
 * credential store is not readable".
 */
test('a saved provider credential stays readable while the index shares the vault', async () => {
  await withVaultFile(async (filePath) => {
    const vault = new CredentialVault(filePath, fakeCryptography())
    await saveAgentCredential(vault, { provider: 'anthropic', apiKey: 'sk-ant-test' }, CATALOG)
    const statuses = await listAgentCredentialStatuses(vault, CATALOG)
    assert.equal(statuses.find((status) => status.provider === 'anthropic')?.credentialPresent, true)
    assert.equal((await resolveAgentCredentials(vault)).length, 1)
    const stored = JSON.parse(await readFile(filePath, 'utf8')) as { entries: Record<string, string> }
    assert.deepEqual(Object.keys(stored.entries).sort(), ['v2:provider-index', 'v2:provider:anthropic'])
    // The two modules must agree on the vocabulary: a reserved key that the
    // vault rejects is exactly the bug above, so it is asserted directly.
    assert.equal(isCredentialStoreKey(AGENT_CREDENTIAL_INDEX_KEY), true)
    assert.equal(isCredentialStoreKey('v2:provider:anthropic'), true)
    await removeAgentCredential(vault, 'anthropic')
    assert.equal((await listAgentCredentialStatuses(vault, CATALOG)).find((status) => status.provider === 'anthropic')?.credentialPresent, false)
  })
})

/**
 * The strictness that the fix must not weaken: a file holding a key this build
 * does not recognize is reported as unreadable and left byte-for-byte intact,
 * because overwriting it could destroy credentials the user still needs.
 */
test('an unrecognized key still makes the store unreadable instead of being overwritten', async () => {
  await withVaultFile(async (filePath) => {
    const entries = { 'v2:unknown:thing': 'AAAA' }
    await writeFile(filePath, `${JSON.stringify({ version: 1, entries })}\n`, 'utf8')
    const vault = new CredentialVault(filePath, fakeCryptography())
    await assert.rejects(
      () => saveAgentCredential(vault, { provider: 'anthropic', apiKey: 'sk-ant-test' }, CATALOG),
      (error: unknown) => error instanceof CredentialVaultError && error.code === 'CREDENTIAL_STORAGE_CORRUPT'
    )
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')).entries, entries)
  })
})

test('the vault key namespace stays provider-scoped', async () => {
  assert.equal(agentCredentialStorageKey('anthropic'), 'v2:provider:anthropic')
  assert.equal(AGENT_CREDENTIAL_KEY_PREFIX, 'v2:provider:')
})

/**
 * Regression: the per-request credential envelope must survive a realistic
 * number of configured providers.
 *
 * The envelope used to be capped at four entries. A user with five configured
 * providers then failed *every* credential-bearing Agent RPC — the cap is a
 * bound on payload size, not a product limit, and a provider count is not a
 * reason to make runs, logins and connector tests impossible.
 */
test('a credential envelope carries every configured provider, far beyond the old four-entry cap', () => {
  const credentials = Array.from({ length: 12 }, (_, index) => ({ provider: `provider-${index}`, credential: { type: 'api_key' as const, key: `sk-test-${index}` } }))
  const parsed = AgentCredentialEnvelopeSchema.safeParse({
    type: 'prw.agent-rpc-with-credential',
    request: { id: 'rpc-1', method: 'agent.models.catalog', payload: null },
    credentials
  })
  assert.equal(parsed.success, true, 'a dozen configured providers must still validate')
  assert.equal(parsed.success ? parsed.data.credentials.length : 0, 12)
  // The bound itself still exists: the envelope is a bounded payload, so an
  // unbounded list is still refused rather than forwarded.
  assert.ok(AGENT_CREDENTIAL_ENVELOPE_MAX_ENTRIES > 12, 'the envelope bound must exceed any realistic provider count')
  const oversized = AgentCredentialEnvelopeSchema.safeParse({
    type: 'prw.agent-rpc-with-credential',
    request: { id: 'rpc-2', method: 'agent.models.catalog', payload: null },
    credentials: Array.from({ length: AGENT_CREDENTIAL_ENVELOPE_MAX_ENTRIES + 1 }, (_, index) => ({ provider: `provider-${index}`, credential: { type: 'api_key' as const, key: 'sk-test' } }))
  })
  assert.equal(oversized.success, false, 'the envelope must still refuse an unbounded credential list')
})
