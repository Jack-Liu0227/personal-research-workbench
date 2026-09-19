import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  discoverProviderModels,
  discoveryEndpoint,
  discoveryHeaders,
  ProviderDiscoveryError
} from '../src/pi/discovery.js'

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

describe('provider model discovery', () => {
  it('uses the protocol-specific auth headers and endpoint', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    for (const [api, payload] of [
      ['openai-completions', { data: [{ id: 'chat-a' }] }],
      ['openai-responses', { data: [{ id: 'resp-a', name: 'Responses A' }] }],
      ['anthropic-messages', { data: [{ id: 'claude-a', display_name: 'Claude A' }] }],
      ['google-generative-ai', { models: [{ name: 'models/gemini-a', displayName: 'Gemini A', inputTokenLimit: 1000, outputTokenLimit: 200 }] }]
    ] as const) {
      const result = await discoverProviderModels({
        provider: api,
        baseUrl: api === 'google-generative-ai' ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://gateway.example.com/v1',
        api,
        apiKey: 'secret-key',
        fetcher: async (url, init) => {
          calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()) })
          return response(payload)
        }
      })
      assert.equal(result.models.length, 1)
    }
    assert.equal(calls[0]?.url, 'https://gateway.example.com/v1/models')
    assert.equal(calls[0]?.headers.authorization, 'Bearer secret-key')
    assert.equal(calls[1]?.headers.authorization, 'Bearer secret-key')
    assert.equal(calls[2]?.headers['x-api-key'], 'secret-key')
    assert.equal(calls[2]?.headers['anthropic-version'], '2023-06-01')
    assert.equal(calls[3]?.headers['x-goog-api-key'], 'secret-key')
    assert.equal(calls[3]?.url.includes('secret-key'), false)
  })

  it('allows a loopback endpoint without a key but blocks a remote endpoint', async () => {
    await assert.rejects(
      discoverProviderModels({ provider: 'remote', baseUrl: 'https://gateway.example.com/v1', api: 'openai-responses' }),
      (error: unknown) => error instanceof ProviderDiscoveryError && error.code === 'MISSING_CREDENTIAL'
    )
    const result = await discoverProviderModels({
      provider: 'local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      api: 'openai-completions',
      fetcher: async () => response({ data: [{ id: 'local-model' }] })
    })
    assert.deepEqual(result.models.map((model) => model.id), ['local-model'])
  })

  it('maps unauthorized, missing endpoint, invalid JSON and cancellation without leaking response data', async () => {
    await assert.rejects(
      discoverProviderModels({ provider: 'gateway', baseUrl: 'https://gateway.example.com/v1', api: 'openai-responses', apiKey: 'secret-key', fetcher: async () => response({ token: 'secret-key', detail: 'private' }, 401) }),
      (error: unknown) => error instanceof ProviderDiscoveryError && error.code === 'UNAUTHORIZED' && !error.message.includes('secret-key') && !error.message.includes('private')
    )
    await assert.rejects(
      discoverProviderModels({ provider: 'gateway', baseUrl: 'https://gateway.example.com/v1', api: 'openai-responses', apiKey: 'secret-key', fetcher: async () => new Response('not-json', { status: 200 }) }),
      (error: unknown) => error instanceof ProviderDiscoveryError && error.code === 'INVALID_RESPONSE'
    )
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      discoverProviderModels({ provider: 'gateway', baseUrl: 'https://gateway.example.com/v1', api: 'openai-responses', apiKey: 'secret-key', signal: controller.signal, fetcher: async () => response({ data: [] }) }),
      (error: unknown) => error instanceof Error && error.name === 'AbortError'
    )
  })

  it('keeps URL construction free of query strings and credentials', () => {
    assert.equal(discoveryEndpoint('https://gateway.example.com/v1/'), 'https://gateway.example.com/v1/models')
    assert.deepEqual(discoveryHeaders('google-generative-ai', 'key'), { accept: 'application/json', 'x-goog-api-key': 'key' })
  })
})
