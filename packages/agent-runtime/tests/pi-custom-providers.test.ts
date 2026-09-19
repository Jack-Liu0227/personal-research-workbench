import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { PiModelCatalog, piModelsFilePath, writePiModelsFile, type AgentCredentialBridge, type AgentCustomProvider } from '../src/index.js'

/**
 * Integration coverage for the custom-provider path.
 *
 * These cases load the real `@earendil-works/pi-ai` runtime rather than a stub,
 * because the whole question they answer is "does Pi actually compose what the
 * editor wrote?". That makes the file slow (the SDK's cold ESM load dominates),
 * which is why it is a named script instead of part of the fast suites.
 */

const roots: string[] = []

function temporaryProfile(): string {
  const root = mkdtempSync(join(tmpdir(), 'prw-custom-provider-'))
  roots.push(root)
  const profileDir = join(root, 'pi')
  mkdirSync(profileDir, { recursive: true })
  return profileDir
}

/** A bridge holding one app-owned api key, standing in for Main's safeStorage. */
function bridgeWithKey(provider: string, key: string): AgentCredentialBridge {
  const entries = new Map<string, unknown>([[provider, { type: 'api_key', key }]])
  return {
    read: (id: string) => entries.get(id) as ReturnType<AgentCredentialBridge['read']>,
    list: () => [...entries].map(([id, credential]) => ({ provider: id, credential })),
    persist: async (id: string, credential: unknown) => {
      if (credential === null) entries.delete(id)
      else entries.set(id, credential)
    }
  }
}

const emptyBridge: AgentCredentialBridge = {
  read: () => null as ReturnType<AgentCredentialBridge['read']>,
  list: () => [],
  persist: async () => undefined
}

function provider(overrides: Partial<AgentCustomProvider> = {}): AgentCustomProvider {
  return {
    id: 'lab-gateway',
    name: 'Lab Gateway',
    baseUrl: 'https://gateway.example.com/v1',
    api: 'openai-responses',
    models: [{ id: 'gpt-5.1', name: '', reasoning: true, contextWindow: 400_000, maxTokens: null }],
    ...overrides
  }
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('custom providers through the embedded SDK', () => {
  it('composes a models.json provider, its models and its api-key auth', async () => {
    const profileDir = temporaryProfile()
    writePiModelsFile(profileDir, [provider()])
    const catalog = new PiModelCatalog(profileDir, bridgeWithKey('lab-gateway', 'sk-test'))

    const entries = await catalog.list()
    const custom = entries.find((entry) => entry.provider === 'lab-gateway')
    assert.ok(custom, 'the models.json provider is missing from the catalog')
    assert.equal(custom.source, 'custom')
    // Pi fabricates an api-key login for a provider the file defines, which is
    // what makes the Settings form show an API-key box and hide OAuth.
    assert.deepEqual(custom.authTypes, ['api_key'])
    assert.deepEqual(custom.models.map((model) => model.id), ['gpt-5.1'])
    assert.equal(custom.models[0]?.name, 'gpt-5.1')

    const stored = await catalog.customProviders()
    assert.equal(stored.path, piModelsFilePath(profileDir))
    assert.equal(stored.configError, null)
    assert.deepEqual(stored.providers.map((entry) => entry.id), ['lab-gateway'])
    assert.deepEqual(stored.unmanaged, [])
  })

  it('reports the provider without a credential as unconfigured rather than broken', async () => {
    const profileDir = temporaryProfile()
    writePiModelsFile(profileDir, [provider()])
    const catalog = new PiModelCatalog(profileDir, emptyBridge)

    const custom = (await catalog.list()).find((entry) => entry.provider === 'lab-gateway')
    assert.ok(custom, 'a credential-less provider must still be listed')
    assert.equal(custom.source, 'custom')
    assert.equal((await catalog.customProviders()).configError, null)
  })

  it('surfaces Pi composition errors next to the file they came from', async () => {
    const profileDir = temporaryProfile()
    // A model with no `api` at provider or model level is rejected by Pi's own
    // composition, and one bad entry empties the whole file there.
    writeFileSync(piModelsFilePath(profileDir), `${JSON.stringify({
      providers: {
        broken: { baseUrl: 'https://broken.example.com/v1', models: [{ id: 'x' }] }
      }
    }, null, 2)}\n`, 'utf8')

    const catalog = new PiModelCatalog(profileDir, emptyBridge)
    const stored = await catalog.customProviders()
    assert.match(stored.configError ?? '', /no "api" specified/u)
    // The editor must not offer to rewrite a file it cannot represent, so the
    // entry shows up as unmanaged and the form refuses to silently drop it.
    assert.deepEqual(stored.providers, [])
    assert.deepEqual(stored.unmanaged, ['broken'])
    const entries = await catalog.list()
    assert.equal(entries.some((entry) => entry.provider === 'broken'), false)
    // The built-in catalog survives the bad file: Pi loads models.json as an
    // override layer, so a broken file degrades to "no overrides".
    assert.ok(entries.length > 0, 'a broken models.json must not empty the catalog')
  })

  it('round-trips a save through the same reader the catalog uses', async () => {
    const profileDir = temporaryProfile()
    const catalog = new PiModelCatalog(profileDir, emptyBridge)
    const saved = await catalog.saveCustomProviders([provider()])
    assert.equal(saved.configError, null)
    assert.deepEqual(saved.providers.map((entry) => entry.id), ['lab-gateway'])

    // Saving the empty set is the delete path and must leave a loadable file.
    const cleared = await catalog.saveCustomProviders([])
    assert.deepEqual(cleared.providers, [])
    assert.equal(cleared.configError, null)
    assert.equal((await catalog.list()).some((entry) => entry.provider === 'lab-gateway'), false)
  })
})
