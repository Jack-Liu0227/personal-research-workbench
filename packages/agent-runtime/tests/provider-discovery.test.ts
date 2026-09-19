import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { after, describe, it } from 'node:test'
import type { AgentCustomProviderApi } from '@prw/contracts'
import {
  PROVIDER_DISCOVERY_MAX_MODELS,
  ProviderDiscoveryError,
  discoverProviderModels,
  discoveryEndpoint,
  discoveryHeaders,
  type ProviderDiscoveryCode
} from '../src/index.js'

/**
 * Model discovery against a real HTTP endpoint.
 *
 * The probe is the only place in the app where a stored API key is attached to
 * an outbound request the user did not type, so these cases are mostly about
 * what must *not* happen: the key must reach exactly one configured endpoint and
 * nowhere else, and nothing about the response may travel back to the renderer
 * unredacted. A local `node:http` server is used instead of a mocked `fetch` so
 * the wire behaviour (path, headers, redirect refusal, timeouts) is real.
 */

const KEY = 'sk-test-do-not-log-0123456789'

interface StubRequest {
  readonly url: string
  readonly headers: IncomingMessage['headers']
}

interface Stub {
  readonly baseUrl: string
  readonly requests: StubRequest[]
  readonly close: () => Promise<void>
}

async function startStub(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<Stub> {
  const requests: StubRequest[] = []
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? '', headers: request.headers })
    handler(request, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    // A hanging request keeps a socket open, so connections are dropped before
    // the listener is closed.
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const stubs: Stub[] = []

async function stub(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<Stub> {
  const created = await startStub(handler)
  stubs.push(created)
  return created
}

after(async () => {
  for (const entry of stubs.splice(0)) await entry.close()
})

/** Every failure must be structured, and no failure may carry the key. */
async function expectFailure(run: () => Promise<unknown>, code: ProviderDiscoveryCode): Promise<ProviderDiscoveryError> {
  const error = await run().then(
    () => null,
    (thrown: unknown) => thrown
  )
  assert.ok(error instanceof ProviderDiscoveryError, `expected a ProviderDiscoveryError, received ${String(error)}`)
  assert.equal(error.code, code)
  assert.ok(!error.message.includes(KEY), 'the failure message echoed the API key')
  assert.equal(error.name, 'VALIDATION_FAILED')
  return error
}

describe('discovery endpoint and headers', () => {
  it('appends the listing path to the configured base URL', () => {
    assert.equal(discoveryEndpoint('https://api.openai.com/v1'), 'https://api.openai.com/v1/models')
    // A trailing slash is what a copy-paste adds; it must not become `//models`.
    assert.equal(discoveryEndpoint('https://api.openai.com/v1///'), 'https://api.openai.com/v1/models')
  })

  it('uses each protocol’s own auth scheme and sends nothing when there is no key', () => {
    assert.deepEqual(discoveryHeaders('openai-responses', KEY), { accept: 'application/json', authorization: `Bearer ${KEY}` })
    assert.deepEqual(discoveryHeaders('openai-completions', KEY), { accept: 'application/json', authorization: `Bearer ${KEY}` })
    assert.deepEqual(discoveryHeaders('anthropic-messages', KEY), { accept: 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' })
    assert.deepEqual(discoveryHeaders('google-generative-ai', KEY), { accept: 'application/json', 'x-goog-api-key': KEY })
    for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'] as AgentCustomProviderApi[]) {
      assert.deepEqual(discoveryHeaders(api, null), { accept: 'application/json' }, api)
    }
  })
})

describe('listing shapes', () => {
  it('reads the OpenAI-compatible `data[]` shape with a bearer key', async () => {
    const server = await stub((_request, response) => json(response, 200, {
      data: [
        { id: 'gpt-5.1', name: 'GPT 5.1' },
        { id: 'gpt-5-mini' },
        // Not storable ids: an empty value, a control character, and a duplicate.
        { id: '' },
        { id: 'bad\nid' },
        { id: 'gpt-5.1' },
        { id: 42 },
        'not-an-object'
      ]
    }))
    const outcome = await discoverProviderModels({ provider: 'openai', baseUrl: server.baseUrl, api: 'openai-completions', apiKey: KEY })
    assert.equal(server.requests.length, 1)
    assert.equal(server.requests[0]?.url, '/v1/models')
    assert.equal(server.requests[0]?.headers.authorization, `Bearer ${KEY}`)
    assert.deepEqual(outcome.models.map((model) => model.id), ['gpt-5.1', 'gpt-5-mini'])
    assert.equal(outcome.models[0]?.name, 'GPT 5.1')
    // A label equal to the id is not a label.
    assert.equal(outcome.models[1]?.name, '')
    assert.equal(outcome.notice, null)
    assert.equal(outcome.models[0]?.contextWindow, null)
    // The whole result travels to the renderer, so the key must not be in it.
    assert.ok(!JSON.stringify(outcome).includes(KEY))
    assert.ok(!server.requests[0]!.url.includes(KEY), 'the key was placed in the request URL')
  })

  it('reads Anthropic’s `data[]` shape with x-api-key and the wire version', async () => {
    const server = await stub((_request, response) => json(response, 200, {
      data: [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }]
    }))
    const outcome = await discoverProviderModels({ provider: 'anthropic', baseUrl: server.baseUrl, api: 'anthropic-messages', apiKey: KEY })
    assert.equal(server.requests[0]?.headers['x-api-key'], KEY)
    assert.equal(server.requests[0]?.headers['anthropic-version'], '2023-06-01')
    assert.equal(server.requests[0]?.headers.authorization, undefined)
    assert.deepEqual(outcome.models.map((model) => model.id), ['claude-sonnet-5'])
    assert.equal(outcome.models[0]?.name, 'Claude Sonnet 5')
  })

  it('reads Google’s `models[]` shape, strips the resource prefix and keeps token limits', async () => {
    const server = await stub((_request, response) => json(response, 200, {
      models: [
        { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 },
        { name: 'models/gemini-2.5-flash', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 },
        // A bare id is accepted too, and unusable limits become null instead of 0.
        { name: 'gemini-embedding-001', inputTokenLimit: 0, outputTokenLimit: 'many' }
      ]
    }))
    const outcome = await discoverProviderModels({ provider: 'google', baseUrl: server.baseUrl, api: 'google-generative-ai', apiKey: KEY })
    assert.equal(server.requests[0]?.headers['x-goog-api-key'], KEY)
    assert.deepEqual(outcome.models.map((model) => model.id), ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-embedding-001'])
    assert.equal(outcome.models[0]?.contextWindow, 1_048_576)
    assert.equal(outcome.models[0]?.maxTokens, 65_536)
    assert.equal(outcome.models[2]?.contextWindow, null)
    assert.equal(outcome.models[2]?.maxTokens, null)
  })

  it('treats a listing without a model array as an empty answer, not a failure', async () => {
    const server = await stub((_request, response) => json(response, 200, { object: 'list' }))
    const outcome = await discoverProviderModels({ provider: 'gateway', baseUrl: server.baseUrl, api: 'openai-completions', apiKey: KEY })
    assert.deepEqual(outcome.models, [])
  })

  it(`truncates a listing longer than the ${PROVIDER_DISCOVERY_MAX_MODELS}-model ceiling and says so`, async () => {
    const server = await stub((_request, response) => json(response, 200, {
      data: Array.from({ length: PROVIDER_DISCOVERY_MAX_MODELS + 5 }, (_entry, index) => ({ id: `model-${index}` }))
    }))
    const outcome = await discoverProviderModels({ provider: 'gateway', baseUrl: server.baseUrl, api: 'openai-completions', apiKey: KEY })
    assert.equal(outcome.models.length, PROVIDER_DISCOVERY_MAX_MODELS)
    assert.ok(outcome.notice?.includes(String(PROVIDER_DISCOVERY_MAX_MODELS)), 'the truncation notice is missing')
  })
})

describe('refusals are redacted and actionable', () => {
  it('maps an auth refusal to UNAUTHORIZED without echoing the body', async () => {
    const server = await stub((_request, response) => json(response, 401, { error: { message: `invalid key ${KEY}` } }))
    const error = await expectFailure(
      () => discoverProviderModels({ provider: 'gateway', baseUrl: server.baseUrl, api: 'openai-completions', apiKey: KEY }),
      'UNAUTHORIZED'
    )
    assert.ok(error.message.includes('gateway'))
    assert.ok(!error.message.includes('invalid key'), 'the provider body was echoed back')
  })

  it('maps a missing listing route and a rate limit to their own codes', async () => {
    const notFound = await stub((_request, response) => json(response, 404, {}))
    await expectFailure(() => discoverProviderModels({ provider: 'gateway', baseUrl: notFound.baseUrl, api: 'openai-completions', apiKey: KEY }), 'NOT_FOUND')
    const limited = await stub((_request, response) => json(response, 429, {}))
    await expectFailure(() => discoverProviderModels({ provider: 'gateway', baseUrl: limited.baseUrl, api: 'openai-completions', apiKey: KEY }), 'RATE_LIMITED')
  })

  it('refuses a body that is not JSON or is implausibly large', async () => {
    const notJson = await stub((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<html>login</html>') })
    await expectFailure(() => discoverProviderModels({ provider: 'gateway', baseUrl: notJson.baseUrl, api: 'openai-completions', apiKey: KEY }), 'INVALID_RESPONSE')
    const huge = await stub((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(`{"data":[${'"x",'.repeat(300_000)}]}`) })
    await expectFailure(() => discoverProviderModels({ provider: 'gateway', baseUrl: huge.baseUrl, api: 'openai-completions', apiKey: KEY }), 'INVALID_RESPONSE')
  })

  it('does not follow a redirect, so the key cannot be forwarded to another host', async () => {
    const server = await stub((_request, response) => {
      response.writeHead(302, { location: 'https://evil.example.com/v1/models' })
      response.end()
    })
    await expectFailure(() => discoverProviderModels({ provider: 'gateway', baseUrl: server.baseUrl, api: 'openai-completions', apiKey: KEY }), 'UNREACHABLE')
    assert.equal(server.requests.length, 1, 'the redirect was followed')
  })

  it('reports an unreachable endpoint with a whitelisted errno-style code only', async () => {
    // Port 1 on loopback accepts nothing, so this is a real connect refusal.
    await expectFailure(
      () => discoverProviderModels({ provider: 'gateway', baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: KEY, timeoutMs: 5_000 }),
      'UNREACHABLE'
    )
  })

  it('times out with a message that names the budget instead of a raw abort', async () => {
    // Never answers: the probe has to give up on its own wall clock.
    const server = await stub(() => undefined)
    const error = await expectFailure(
      () => discoverProviderModels({ provider: 'gateway', baseUrl: server.baseUrl, api: 'openai-completions', apiKey: KEY, timeoutMs: 150 }),
      'TIMEOUT'
    )
    assert.ok(error.message.includes('gateway'))
  })

  it('reports caller cancellation as an AbortError so it maps to OPERATION_CANCELED', async () => {
    const server = await stub(() => undefined)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    const error = await discoverProviderModels({
      provider: 'gateway',
      baseUrl: server.baseUrl,
      api: 'openai-completions',
      apiKey: KEY,
      timeoutMs: 5_000,
      signal: controller.signal
    }).then(() => null, (thrown: unknown) => thrown)
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'AbortError')
    assert.ok(!(error instanceof ProviderDiscoveryError), 'a cancellation must not be reported as a probe failure')
    assert.ok(!error.message.includes(KEY))
  })
})

describe('endpoint policy', () => {
  it('refuses a remote endpoint it has no key for, before opening a connection', async () => {
    const server = await stub((_request, response) => json(response, 200, { data: [] }))
    await expectFailure(
      () => discoverProviderModels({ provider: 'gateway', baseUrl: 'https://api.example.com/v1', api: 'openai-completions', apiKey: null }),
      'MISSING_CREDENTIAL'
    )
    // The local stub is what a keyless probe would have reached; it was never hit.
    assert.equal(server.requests.length, 0)
  })

  it('allows a keyless probe of a local server, because that is how Ollama runs', async () => {
    const server = await stub((_request, response) => json(response, 200, { data: [{ id: 'qwen3:8b' }] }))
    const outcome = await discoverProviderModels({ provider: 'local', baseUrl: server.baseUrl, api: 'openai-completions', apiKey: null })
    assert.deepEqual(outcome.models.map((model) => model.id), ['qwen3:8b'])
    assert.equal(server.requests[0]?.headers.authorization, undefined)
  })

  it('applies the shared URL policy, including no credentials, query or plain HTTP', async () => {
    for (const baseUrl of [
      'http://gateway.example.com/v1',
      'https://user:password@gateway.example.com/v1',
      'https://gateway.example.com/v1?api_key=leaked',
      'not a url'
    ]) {
      await expectFailure(
        () => discoverProviderModels({ provider: 'gateway', baseUrl, api: 'openai-completions', apiKey: KEY }),
        'INVALID_ENDPOINT'
      )
    }
  })

  it('refuses a local override of the listing path that would drop the protocol’s own route', async () => {
    // `baseUrl` is the input to `<baseUrl>/models`; anything it cannot join is
    // rejected before a request is built.
    await expectFailure(
      () => discoverProviderModels({ provider: 'gateway', baseUrl: 'https://gateway.example.com/v1#fragment', api: 'openai-completions', apiKey: KEY }),
      'INVALID_ENDPOINT'
    )
  })
})
