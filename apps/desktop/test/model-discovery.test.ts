import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AgentSettingsSaveInputSchema, type AgentCustomProvider, type AgentModelCatalogEntry, type AgentModelDiscoveryResult } from '@prw/contracts'
import {
  adoptDiscoveredModels,
  defaultSelectionIssue,
  defaultSelectionSummary,
  discoveryRequestIssue,
  isDiscoveryStale,
  isLoopbackEndpoint,
  pendingDiscoveredModels
} from '../src/renderer/src/lib/model-discovery.js'

/**
 * The renderer's half of model discovery.
 *
 * Two promises are made to the user in this feature and both are asserted here:
 * a discovery probe changes nothing until the user adopts its result, and a
 * default model is only saved when the exact `provider/modelId` pair it names
 * exists — so a run can never quietly execute a model the user did not choose.
 */

function provider(overrides: Partial<AgentCustomProvider> = {}): AgentCustomProvider {
  return {
    id: 'my-gateway',
    name: 'My Gateway',
    baseUrl: 'http://127.0.0.1:11434/v1',
    api: 'openai-completions',
    models: [{ id: 'qwen3:8b', name: '', reasoning: false, contextWindow: null, maxTokens: null }],
    ...overrides
  }
}

function result(overrides: Partial<AgentModelDiscoveryResult> = {}): AgentModelDiscoveryResult {
  return {
    provider: 'my-gateway',
    baseUrl: 'http://127.0.0.1:11434/v1',
    api: 'openai-completions',
    models: [
      { id: 'qwen3:8b', name: '', reasoning: false, contextWindow: null, maxTokens: null },
      { id: 'qwen3:14b', name: 'Qwen3 14B', reasoning: true, contextWindow: 131_072, maxTokens: 8192 }
    ],
    notice: null,
    discoveredAt: '2026-09-13T00:00:00.000Z',
    ...overrides
  }
}

describe('discoveryRequestIssue', () => {
  it('allows a local endpoint without a stored key', () => {
    assert.equal(discoveryRequestIssue(provider(), false), null)
  })

  it('requires a stored key before a remote endpoint is probed', () => {
    const remote = provider({ baseUrl: 'https://gateway.example.com/v1' })
    assert.ok(discoveryRequestIssue(remote, false)?.includes('API Key'))
    assert.equal(discoveryRequestIssue(remote, true), null)
  })

  it('reports an unusable id or URL instead of starting a request', () => {
    assert.ok(discoveryRequestIssue(provider({ id: 'Bad Id' }), true)?.includes('Provider id'))
    assert.notEqual(discoveryRequestIssue(provider({ baseUrl: 'http://gateway.example.com/v1' }), true), null)
  })
})

describe('isLoopbackEndpoint', () => {
  it('recognizes the local forms a provider preset uses', () => {
    for (const baseUrl of ['http://127.0.0.1:11434/v1', 'http://localhost:1234/v1', 'http://[::1]:8080/v1', 'http://ollama.localhost/v1']) {
      assert.equal(isLoopbackEndpoint(baseUrl), true, baseUrl)
    }
    for (const baseUrl of ['https://api.openai.com/v1', 'https://127.0.0.1.evil.example/v1', 'nonsense']) {
      assert.equal(isLoopbackEndpoint(baseUrl), false, baseUrl)
    }
  })
})

describe('isDiscoveryStale', () => {
  it('is false only while the form still matches the endpoint that answered', () => {
    assert.equal(isDiscoveryStale(result(), provider()), false)
    assert.equal(isDiscoveryStale(result(), provider({ id: 'other-gateway' })), true)
    assert.equal(isDiscoveryStale(result(), provider({ baseUrl: 'http://127.0.0.1:11435/v1' })), true)
    assert.equal(isDiscoveryStale(result(), provider({ api: 'openai-responses' })), true)
  })
})

describe('pendingDiscoveredModels', () => {
  it('lists only what the provider does not already have, in endpoint order', () => {
    assert.deepEqual(pendingDiscoveredModels(provider(), result()).map((model) => model.id), ['qwen3:14b'])
    assert.deepEqual(pendingDiscoveredModels(provider({ models: [] }), result()).map((model) => model.id), ['qwen3:8b', 'qwen3:14b'])
  })
})

describe('adoptDiscoveredModels', () => {
  it('appends only the selected models and leaves the input untouched', () => {
    const before = provider()
    const snapshot = JSON.stringify(before)
    const adopted = adoptDiscoveredModels(before, result(), ['qwen3:14b'])
    assert.equal(adopted.added, 1)
    assert.deepEqual(adopted.provider.models.map((model) => model.id), ['qwen3:8b', 'qwen3:14b'])
    // The probe answered; nothing may change until the user adopts.
    assert.equal(JSON.stringify(before), snapshot)
    assert.deepEqual(adopted.provider.models[1], result().models[1])
  })

  it('is additive, so a name the user typed is never replaced by the endpoint’s', () => {
    const renamed = provider({ models: [{ id: 'qwen3:8b', name: '我的本地模型', reasoning: false, contextWindow: 4096, maxTokens: 2048 }] })
    const adopted = adoptDiscoveredModels(renamed, result(), ['qwen3:8b', 'qwen3:14b'])
    assert.equal(adopted.added, 1)
    assert.deepEqual(adopted.provider.models[0], renamed.models[0])
  })

  it('adds nothing for ids that are already present, or when nothing is selected', () => {
    assert.equal(adoptDiscoveredModels(provider(), result(), ['qwen3:8b']).added, 0)
    assert.equal(adoptDiscoveredModels(provider(), result(), []).added, 0)
  })

  it('never adds the same model twice, even if the endpoint repeated it', () => {
    const duplicated = result({ models: [result().models[1]!, result().models[1]!] })
    const adopted = adoptDiscoveredModels(provider(), duplicated, ['qwen3:14b'])
    assert.equal(adopted.added, 1)
    assert.deepEqual(adopted.provider.models.map((model) => model.id), ['qwen3:8b', 'qwen3:14b'])
  })

  it('ignores ids the endpoint advertised but the user did not select', () => {
    const adopted = adoptDiscoveredModels(provider({ models: [] }), result(), ['qwen3:14b'])
    assert.deepEqual(adopted.provider.models.map((model) => model.id), ['qwen3:14b'])
  })
})

describe('defaultSelectionIssue', () => {
  const catalog: Pick<AgentModelCatalogEntry, 'provider' | 'models'>[] = [{
    provider: 'my-gateway',
    models: [
      { id: 'qwen3:8b', name: 'Qwen3 8B', reasoning: false, thinkingLevels: [] },
      { id: 'qwen3:14b', name: 'Qwen3 14B', reasoning: true, thinkingLevels: [] }
    ]
  }]

  it('accepts “no model chosen”, because nothing was claimed', () => {
    assert.equal(defaultSelectionIssue(null, null, catalog), null)
    assert.equal(defaultSelectionIssue('my-gateway', null, catalog), null)
  })

  it('accepts an exact pair that exists in the catalog', () => {
    assert.equal(defaultSelectionIssue('my-gateway', 'qwen3:14b', catalog), null)
  })

  it('rejects a model whose provider was not chosen, mirroring the contract refine', () => {
    assert.ok(defaultSelectionIssue(null, 'qwen3:14b', catalog)?.includes('同时指定 Provider'))
    const parsed = AgentSettingsSaveInputSchema.safeParse({ provider: null, model: 'qwen3:14b', thinking: null, expectedRevision: 1 })
    assert.equal(parsed.success, false)
    // The two layers must agree, or the form would offer a save the RPC refuses.
    assert.equal(AgentSettingsSaveInputSchema.safeParse({ provider: 'my-gateway', model: 'qwen3:14b', thinking: null, expectedRevision: 1 }).success, true)
  })

  it('rejects a model the chosen provider does not offer, rather than resolving it loosely', () => {
    const issue = defaultSelectionIssue('my-gateway', 'qwen3:30b', catalog)
    assert.ok(issue?.includes('my-gateway/qwen3:30b'))
    assert.ok(issue?.includes('不会回退'))
  })

  it('rejects a provider that is not in the catalog at all', () => {
    assert.ok(defaultSelectionIssue('missing-gateway', 'qwen3:14b', catalog)?.includes('missing-gateway'))
    assert.ok(defaultSelectionIssue('my-gateway', 'qwen3:14b', []) !== null)
  })
})

describe('defaultSelectionSummary', () => {
  it('names the exact selector that a run will use', () => {
    assert.ok(defaultSelectionSummary('my-gateway', 'qwen3:14b').includes('my-gateway/qwen3:14b'))
    assert.ok(defaultSelectionSummary(null, null).includes('未指定'))
    // A half-filled selection composes to nothing rather than to a partial value.
    assert.ok(defaultSelectionSummary('my-gateway', null).includes('未指定'))
  })
})
