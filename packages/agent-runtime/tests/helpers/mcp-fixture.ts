import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
export async function mcpFixture(options: { toolName?: string; description?: string; inputSchema?: Record<string, unknown> } = {}) {
  const calls: unknown[] = []
  const headers: string[] = []
  const sessions = new Map<string, { sdk: Server; transport: StreamableHTTPServerTransport }>()
  const servers: Server[] = []
  async function session() {
  const sdk = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } })
  sdk.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: options.toolName ?? 'echo', description: options.description ?? 'Fixture echo',
    inputSchema: options.inputSchema ?? { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] }))
  sdk.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    calls.push(request.params)
    if (request.params.arguments?.['text'] === 'wait') await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000)
      extra.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
    return { content: [{ type: 'text', text: request.params.arguments?.['text'] === 'redact' ? headers.at(-1) ?? '' : String(request.params.arguments?.['text']) }] }
  })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => { sessions.set(id, { sdk, transport }) } })
  await sdk.connect(transport as Parameters<Server['connect']>[0])
  servers.push(sdk)
  return { sdk, transport }
  }
  const server = createServer((request, response) => {
    if (request.headers.authorization) headers.push(request.headers.authorization)
    void (async () => {
      const id = request.headers['mcp-session-id']
      const existing = typeof id === 'string' ? sessions.get(id) : undefined
      if (!existing && request.method !== 'POST') { response.writeHead(400).end(); return }
      const current = existing ?? await session()
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
      await current.transport.handleRequest(request, response, body)
    })().catch(() => response.destroy())
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  return { endpoint: `http://127.0.0.1:${address.port}/mcp`, calls, headers,
    close: async () => { await Promise.all(servers.map((sdk) => sdk.close())); server.closeAllConnections(); server.close(); await once(server, 'close') } }
}
