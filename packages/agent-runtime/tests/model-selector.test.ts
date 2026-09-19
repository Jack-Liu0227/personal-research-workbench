import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ModelSelectionError, planModelSelection } from '../src/index.js'

/**
 * The selector decision that keeps a configured default honest.
 *
 * The adapter used to fall back to `available[0] ?? models[0]` whenever a stored
 * selector did not match, so a run could silently use a different model than the
 * one Settings displayed. These cases pin the boundary: an exact pair for a known
 * provider must resolve exactly or not at all, while shapes that were never a
 * pair stay tolerant.
 */

const providers = ['openai', 'anthropic', 'google', 'my-gateway']

describe('planModelSelection', () => {
  it('treats nothing selected as unset, so the first usable model may be used', () => {
    for (const value of [null, undefined, '', '   ']) {
      assert.deepEqual(planModelSelection(value, providers), { kind: 'unset' }, String(value))
    }
  })

  it('classifies an exact pair only when the slash head is a known provider', () => {
    assert.deepEqual(planModelSelection('openai/gpt-5.1', providers), { kind: 'exact', provider: 'openai', modelId: 'gpt-5.1' })
    assert.deepEqual(planModelSelection('my-gateway/openrouter/auto', providers), { kind: 'exact', provider: 'my-gateway', modelId: 'openrouter/auto' })
    assert.deepEqual(planModelSelection('  anthropic/claude-sonnet-5  ', providers), { kind: 'exact', provider: 'anthropic', modelId: 'claude-sonnet-5' })
  })

  it('keeps slash-bearing model ids that name no known provider as bare ids', () => {
    // A hand-edited OpenRouter-style id, and a local Ollama tag with a colon.
    assert.deepEqual(planModelSelection('meta-llama/llama-3-70b', providers), { kind: 'bare', modelId: 'meta-llama/llama-3-70b' })
    assert.deepEqual(planModelSelection('qwen3:8b', providers), { kind: 'bare', modelId: 'qwen3:8b' })
    // A leading or trailing slash names no provider either.
    assert.deepEqual(planModelSelection('/gpt-5.1', providers), { kind: 'bare', modelId: '/gpt-5.1' })
    assert.deepEqual(planModelSelection('openai/', providers), { kind: 'bare', modelId: 'openai/' })
  })

  it('is case sensitive, because providers and model ids are', () => {
    assert.deepEqual(planModelSelection('OpenAI/gpt-5.1', providers), { kind: 'bare', modelId: 'OpenAI/gpt-5.1' })
  })

  it('accepts any iterable of known providers', () => {
    assert.equal(planModelSelection('openai/gpt-5.1', new Set(['openai'])).kind, 'exact')
    assert.equal(planModelSelection('openai/gpt-5.1', [] as string[]).kind, 'bare')
  })

  it('reports an exact miss as an error that names the pair and carries no secret', () => {
    const error = new ModelSelectionError('openai', 'gpt-6')
    assert.equal(error.name, 'VALIDATION_FAILED')
    assert.equal(error.provider, 'openai')
    assert.equal(error.modelId, 'gpt-6')
    assert.ok(error.message.includes('openai/gpt-6'))
    // The message is shown to the user and stored in a run event, so it must say
    // what to do instead of what failed internally.
    assert.ok(error.message.includes('设置'))
    assert.ok(!/sk-|Bearer/u.test(error.message))
  })
})
