import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { noAgentCredentials, providerScopedCredential } from '../src/agent-coordinator.js'
import { parseCredentialResult } from '../src/host.js'

/**
 * A scheduled Agent occurrence is started by the Core process itself, so no
 * renderer and no RPC envelope is involved: it has to ask Electron Main for the
 * credential of the provider its model belongs to. Before this existed every
 * automation run ended `blocked` with `AGENT_CREDENTIAL_MISSING`, which meant
 * the Automation feature could not run at all.
 */
describe('scheduled run credentials', () => {
  it('answers only for the provider the requested credential belongs to', () => {
    const credential = { provider: 'openai-responses', credential: { type: 'api_key', key: 'placeholder-not-a-credential' } }
    const source = providerScopedCredential(credential)
    assert.deepEqual(source.all, [credential])
    assert.equal(source.get('openai-responses'), credential)
    assert.equal(source.get('anthropic'), null)
    assert.equal(source.get(''), null)
    // A run that resolves no provider falls back to `all[0]`, which is the
    // credential that was asked for — not an arbitrary vault entry.
    assert.equal(source.get(null), credential)
  })

  it('keeps the fail-closed source empty when nothing was requested', () => {
    assert.deepEqual(noAgentCredentials.all, [])
    assert.equal(noAgentCredentials.get('openai-responses'), null)
    assert.equal(noAgentCredentials.get(null), null)
  })

  it('accepts a provider-scoped credential returned by Main', () => {
    const parsed = parseCredentialResult({
      type: 'credential-result',
      requestId: 'request-1',
      ok: true,
      provider: 'openai-responses',
      credential: { type: 'api_key', key: 'placeholder-not-a-credential' }
    })
    assert.deepEqual(parsed, {
      requestId: 'request-1',
      ok: true,
      credential: { provider: 'openai-responses', credential: { type: 'api_key', key: 'placeholder-not-a-credential' } }
    })
  })

  it('reads a missing entry as "no credential" instead of an error', () => {
    const parsed = parseCredentialResult({ type: 'credential-result', requestId: 'request-2', ok: true })
    assert.deepEqual(parsed, { requestId: 'request-2', ok: true, credential: null })
    // An explicit null means the same thing as an absent field.
    assert.deepEqual(
      parseCredentialResult({ type: 'credential-result', requestId: 'request-2', ok: true, credential: null }),
      { requestId: 'request-2', ok: true, credential: null }
    )
  })

  it('drops a malformed credential so the run fails closed', () => {
    for (const credential of [
      { provider: '', credential: { type: 'api_key' } },
      { provider: 'openai-responses', credential: ['not', 'an', 'object'] },
      { provider: 'openai-responses', credential: 'not-an-object' },
      { credential: { type: 'api_key' } }
    ]) {
      assert.equal(parseCredentialResult({ type: 'credential-result', requestId: 'request-3', ok: true, ...credential }), null)
    }
  })

  it('ignores messages that are not credential results', () => {
    for (const message of [null, 'credential-result', { type: 'credential-ack', requestId: 'x', ok: true }, { type: 'credential-result', ok: true }]) {
      assert.equal(parseCredentialResult(message), null)
    }
  })

  it('reports a refused read as an error with its reason', () => {
    assert.deepEqual(
      parseCredentialResult({ type: 'credential-result', requestId: 'request-4', ok: false, error: '凭据读取通道尚未就绪' }),
      { requestId: 'request-4', ok: false, error: '凭据读取通道尚未就绪' }
    )
  })
})
