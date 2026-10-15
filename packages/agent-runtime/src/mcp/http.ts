import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { Readable, Transform } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export interface McpAddress { readonly address: string; readonly family: number }
export interface ControlledMcpOptions {
  readonly endpoint: string
  readonly bearer: string | null
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
  /** Injection for DNS tests only; the socket still connects to the returned address. */
  readonly lookup?: ((hostname: string) => Promise<readonly McpAddress[]>) | undefined
}

const maxResponseBytes = 256 * 1024
const maxRequestBytes = 64 * 1024
const requestHeaders = new Set(['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'])

/** Runs before SDK/Zod parsing: JSON metadata is untrusted at every depth. */
function checkJsonMessage(text: string): void {
  if (text === '[DONE]' || !text.trim()) return
  const root: unknown = JSON.parse(text)
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!
    if (++nodes > 8192 || depth > 32) throw new ControlledMcpError('MCP JSON complexity exceeds the bounded limit.')
    if (value !== null && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new ControlledMcpError('Unsafe MCP JSON property.')
        pending.push({ value: entry, depth: depth + 1 })
      }
    }
  }
}

function checkedResponseStream(sse: boolean): Transform {
  let received = 0
  let pending = ''
  let first = true
  let eventLines: string[] = []
  const decoder = new StringDecoder('utf8')
  const checkEvent = (event: string): string | null => {
    const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /u, '')).join('\n')
    if (!data) return null
    checkJsonMessage(data)
    return `event: message\n${data.split('\n').map((value) => `data: ${value}`).join('\n')}\n\n`
  }
  const line = (stream: Transform, value: string): void => {
    if (value) eventLines.push(value)
    else if (eventLines.length > 0) {
      const event = eventLines.join('\n')
      const checked = checkEvent(event)
      // Never forward an unrecognized line: downstream parsers have additional
      // BOM compatibility behavior that must not turn unchecked text into data.
      if (checked) stream.push(checked)
      eventLines = []
    }
  }
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        received += chunk.length
        if (received > maxResponseBytes) throw new ControlledMcpError('MCP response exceeds the bounded size.')
        const text = decoder.write(chunk)
        pending += first ? text.replace(/^\uFEFF/u, '') : text
        if (text) first = false
        if (sse) {
          let match: RegExpExecArray | null
          while ((match = /[\r\n]/u.exec(pending)) !== null) {
            const end = match.index
            if (pending[end] === '\r' && end === pending.length - 1) break
            const size = pending[end] === '\r' && pending[end + 1] === '\n' ? 2 : 1
            line(this, pending.slice(0, end))
            pending = pending.slice(end + size)
          }
        }
        callback()
      } catch { callback(new ControlledMcpError('MCP response is invalid or exceeds safe JSON limits.')) }
    },
    flush(callback) {
      try {
        pending += decoder.end()
        if (sse) {
          if (pending) line(this, pending.replace(/\r$/u, ''))
          line(this, '')
        }
        else { checkJsonMessage(pending); this.push(pending) }
        callback()
      } catch { callback(new ControlledMcpError('MCP response is invalid or exceeds safe JSON limits.')) }
    }
  })
}

export class ControlledMcpError extends Error {
  constructor(message: string) { super(message); this.name = 'ControlledMcpError' }
}

function hostOf(url: URL): string { return url.hostname.replace(/^\[|\]$/gu, '') }
function isLoopback(address: string): boolean {
  return address === '::1' || (isIP(address) === 4 && Number(address.split('.')[0]) === 127)
}

/** Fail closed on special-purpose, mapped, translation and documentation ranges. */
export function isPublicMcpAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 ||
        (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113))
  }
  if (isIP(address) !== 6) return false
  // Only global-unicast 2000::/3; reject transition and protocol-assignment space.
  const words = address.toLowerCase().split(':')
  const first = Number.parseInt(words[0] ?? '', 16)
  const second = Number.parseInt(words[1] || '0', 16)
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 &&
    !(first === 0x2001 && (second <= 0x01ff || second === 0x0db8)) && first !== 0x3fff
}

export function validateMcpEndpoint(endpoint: string): URL {
  let url: URL
  try { url = new URL(endpoint) } catch { throw new ControlledMcpError('Invalid MCP endpoint.') }
  if (endpoint.length > 2000 || url.username || url.password || url.search || url.hash ||
      !['http:', 'https:'].includes(url.protocol)) {
    throw new ControlledMcpError('MCP requires HTTP(S) without credentials, query or fragment.')
  }
  const hostname = hostOf(url)
  const loopback = isLoopback(hostname)
  if (url.protocol === 'http:' && !loopback) {
    throw new ControlledMcpError('Plain HTTP is allowed only for a literal loopback address.')
  }
  if (!loopback && isIP(hostname) !== 0 && !isPublicMcpAddress(hostname)) {
    throw new ControlledMcpError('MCP endpoint is not a public address or literal loopback.')
  }
  return url
}

/** One operation owns its sockets. No shared pool, proxy, redirects or automatic replay. */
export async function openControlledMcpClient(options: ControlledMcpOptions): Promise<{
  readonly client: Client
  close(): Promise<void>
}> {
  const endpoint = validateMcpEndpoint(options.endpoint)
  const hostname = hostOf(endpoint)
  if (options.bearer !== null && (options.bearer.length > 20_000 || /[\r\n\0]/u.test(options.bearer))) {
    throw new ControlledMcpError('Invalid MCP bearer credential.')
  }
  const controller = new AbortController()
  const timeoutMs = Math.min(60_000, Math.max(50, options.timeoutMs ?? 20_000))
  const requests = new Set<ClientRequest>()
  const responses = new Set<IncomingMessage>()
  let activeClient: Client | undefined
  const abort = (): void => {
    controller.abort()
    for (const response of responses) response.destroy()
    for (const request of requests) request.destroy(new ControlledMcpError('MCP operation canceled or timed out.'))
    void activeClient?.close().catch(() => undefined)
  }
  const timer = setTimeout(abort, timeoutMs)
  timer.unref()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()

  const fetchImpl: typeof fetch = async (input, init) => {
    controller.signal.throwIfAborted()
    init?.signal?.throwIfAborted()
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = init?.method ?? 'GET'
    if (target.href !== endpoint.href || !['GET', 'POST', 'DELETE'].includes(method)) {
      throw new ControlledMcpError('MCP attempted an unapproved endpoint or method.')
    }
    const body = init?.body
    if (body !== undefined && body !== null && typeof body !== 'string') {
      throw new ControlledMcpError('Unsupported MCP request body.')
    }
    if (typeof body === 'string' && Buffer.byteLength(body, 'utf8') > maxRequestBytes) {
      throw new ControlledMcpError('MCP request exceeds the bounded size.')
    }
    let pinned: McpAddress
    if (isIP(hostname) !== 0) pinned = { address: hostname, family: isIP(hostname) }
    else {
      const addresses = await (options.lookup ?? ((host: string) => dnsLookup(host, { all: true, verbatim: true })))(hostname)
      controller.signal.throwIfAborted()
      if (addresses.length === 0 || addresses.length > 32 || addresses.some((address) =>
        !isPublicMcpAddress(address.address) || address.family !== isIP(address.address))) {
        throw new ControlledMcpError('MCP DNS resolved to a disallowed address.')
      }
      pinned = addresses[0]!
    }
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      if (!requestHeaders.has(key.toLowerCase()) || value.length > 4096) {
        throw new ControlledMcpError('MCP attempted an unapproved request header.')
      }
      headers[key] = value
    })
    if (options.bearer !== null) headers['authorization'] = `Bearer ${options.bearer}`

    return new Promise<Response>((resolve, reject) => {
      let settled = false
      const rejectSafe = (): void => {
        if (!settled) { settled = true; reject(new ControlledMcpError('MCP HTTP request failed.')) }
      }
      const request = (endpoint.protocol === 'https:' ? httpsRequest : httpRequest)(endpoint, {
        method, headers, agent: false, family: pinned.family,
        // DNS is checked for every socket and this exact address is used for the connection.
        lookup: (_hostname, _lookupOptions, callback) => callback(null, pinned.address, pinned.family)
      }, (response) => {
        responses.add(response)
        response.once('close', () => responses.delete(response))
        const status = response.statusCode ?? 502
        if (status >= 300 && status < 400) {
          response.destroy()
          settled = true
          reject(new ControlledMcpError('MCP redirects are forbidden.'))
          return
        }
        if (Number(response.headers['content-length'] ?? '0') > maxResponseBytes) {
          response.destroy()
          settled = true
          reject(new ControlledMcpError('MCP response exceeds the bounded size.'))
          return
        }
        const responseHeaders = new Headers()
        for (const key of ['content-type', 'mcp-session-id', 'mcp-protocol-version']) {
          const value = response.headers[key]
          if (typeof value === 'string' && value.length <= 4096) responseHeaders.set(key, value)
        }
        const bounded = checkedResponseStream(responseHeaders.get('content-type')?.includes('text/event-stream') === true)
        bounded.once('error', () => response.destroy())
        response.once('error', () => bounded.destroy(new ControlledMcpError('MCP response stream failed.')))
        response.pipe(bounded)
        settled = true
        if (status === 204 || status === 205 || status === 304) {
          response.resume()
          resolve(new Response(null, { status, headers: responseHeaders }))
        } else {
          resolve(new Response(Readable.toWeb(bounded) as ReadableStream<Uint8Array>, { status, headers: responseHeaders }))
        }
      })
      requests.add(request)
      request.once('close', () => requests.delete(request))
      request.once('error', rejectSafe)
      const abortRequest = (): void => {
        request.destroy(new ControlledMcpError('MCP operation canceled or timed out.'))
        rejectSafe()
      }
      controller.signal.addEventListener('abort', abortRequest, { once: true })
      init?.signal?.addEventListener('abort', abortRequest, { once: true })
      request.once('close', () => {
        controller.signal.removeEventListener('abort', abortRequest)
        init?.signal?.removeEventListener('abort', abortRequest)
      })
      if (controller.signal.aborted || init?.signal?.aborted) abortRequest()
      else request.end(body ?? undefined)
    })
  }
  const client = new Client({ name: 'prw-controlled-mcp', version: '1' }, { capabilities: {} })
  activeClient = client
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: fetchImpl,
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 }
  })
  const close = async (): Promise<void> => {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    abort()
    await client.close().catch(() => undefined)
  }
  try {
    // SDK's optional sessionId getter predates exactOptionalPropertyTypes.
    await client.connect(transport as Parameters<Client['connect']>[0], { timeout: timeoutMs, signal: controller.signal })
    return { client, close }
  } catch {
    await close()
    throw new ControlledMcpError('MCP connection failed or was canceled.')
  }
}
