import { mcpFixture } from './helpers/mcp-fixture.js'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { isPublicMcpAddress, openControlledMcpClient, validateMcpEndpoint } from '../src/mcp/http.js'

test('MCP endpoint rejects private, metadata, credentials and non-HTTP transports', () => {
  for (const endpoint of ['file:///tmp/a', 'stdio://command', 'http://localhost:3000', 'https://169.254.169.254/mcp',
    'https://10.1.2.3/mcp', 'https://[::ffff:127.0.0.1]/', 'https://[fe80::1]/', 'https://[fc00::1]/',
    'https://[2002:7f00:1::]/', 'https://user:secret@example.com/mcp', 'https://example.com/?key=x', 'https://example.com/#x']) {
    assert.throws(() => validateMcpEndpoint(endpoint), undefined, endpoint)
  }
  assert.equal(validateMcpEndpoint('http://[::1]:8000/mcp').protocol, 'http:')
  assert.equal(isPublicMcpAddress('8.8.8.8'), true)
  assert.equal(isPublicMcpAddress('2606:4700:4700::1111'), true)
  for (const address of ['0.0.0.0', '100.64.0.1', '198.18.0.1', '192.0.0.1', '203.0.113.1', '224.0.0.1',
    '2001:db8::1', '2001::1', '64:ff9b::7f00:1', '::ffff:8.8.8.8']) assert.equal(isPublicMcpAddress(address), false)
})

test('real pinned SDK initializes/lists/calls over loopback SSE and holds bearer only in HTTP header', async () => {
  const fixture = await mcpFixture()
  try {
    const connection = await openControlledMcpClient({ endpoint: fixture.endpoint, bearer: 'fixture-secret' })
    try {
      assert.equal((await connection.client.listTools()).tools[0]?.name, 'echo')
      const result = await connection.client.callTool({ name: 'echo', arguments: { text: 'hello' } })
      assert.deepEqual(result.content, [{ type: 'text', text: 'hello' }])
      assert.equal(fixture.calls.length, 1)
      assert.ok(fixture.headers.every((header) => header === 'Bearer fixture-secret'))
      assert.ok(!JSON.stringify(result).includes('fixture-secret'))
    } finally { await connection.close() }
  } finally { await fixture.close() }
})

test('DNS answer is validated before socket creation, including mixed-public rebinding answers', async () => {
  for (const answers of [[{ address: '127.0.0.1', family: 4 }],
    [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }],
    [{ address: '::ffff:127.0.0.1', family: 6 }]]) {
    await assert.rejects(openControlledMcpClient({ endpoint: 'https://public.invalid/mcp', bearer: null,
      lookup: async () => answers, timeoutMs: 200 }), /MCP connection failed/u)
  }
})

test('redirects and oversized HTTP responses are rejected without following Location', async () => {
  let requests = 0
  for (const oversized of [false, true]) {
    const server = createServer((_request, response) => {
      requests += 1
      if (oversized) response.writeHead(200, { 'content-type': 'application/json', 'content-length': '9999999' }).end('{}')
      else response.writeHead(307, { location: 'http://169.254.169.254/' }).end()
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    try {
      await assert.rejects(openControlledMcpClient({ endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
        bearer: 'private-token', timeoutMs: 200 }), (error: Error) => !error.message.includes('private-token'))
    } finally { server.closeAllConnections(); server.close(); await once(server, 'close') }
  }
  assert.equal(requests, 2)
})

test('cancel closes client SSE/socket and does not replay a tool call', async () => {
  const fixture = await mcpFixture()
  const controller = new AbortController()
  try {
    const connection = await openControlledMcpClient({ endpoint: fixture.endpoint, bearer: null, signal: controller.signal, timeoutMs: 2000 })
    try {
      const pending = connection.client.callTool({ name: 'echo', arguments: { text: 'wait' } })
      setTimeout(() => controller.abort(), 30)
      await assert.rejects(pending)
      assert.equal(fixture.calls.length, 1)
    } finally { await connection.close() }
  } finally { await fixture.close() }
})

test('all SSE BOM/line-ending variants reject deep metadata before SDK parsing', async () => {
  for (const prefix of ['', '\uFEFF', '\u00ef\u00bb\u00bf', '\uFEFF\u00ef\u00bb\u00bf']) {
    for (const ending of ['\n', '\r', '\r\n']) {
      const nested = '{"x":'.repeat(1000) + 'null' + '}'.repeat(1000)
      const server = createServer((request, response) => {
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method?: string }
          if (input.id === undefined) { response.writeHead(202).end(); return }
          const result = `{"jsonrpc":"2.0","id":${input.id},"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"fixture","version":"1"},"metadata":${nested}}}`
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.end(`${prefix}data: ${result}${ending}${ending}`)
        })
      })
      server.listen(0, '127.0.0.1'); await once(server, 'listening')
      try {
        await assert.rejects(openControlledMcpClient({ endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, bearer: null, timeoutMs: 100 }))
      } finally { server.closeAllConnections(); server.close(); await once(server, 'close') }
    }
  }
})
