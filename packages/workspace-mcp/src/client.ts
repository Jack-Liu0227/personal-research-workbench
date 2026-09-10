import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import type { AgentRpcRequest, AgentRpcMethod, RpcRequest, RpcResponse } from '@prw/contracts'
import { AgentRpcRequestSchema, RpcResponseSchema } from '@prw/contracts'

interface ServiceInfo { endpoint: string; token: string }
type RpcMethod = RpcRequest['method']
type RpcRequestFor<M extends RpcMethod> = Extract<RpcRequest, { method: M }>

export class WorkspaceServiceClient {
  private socket: Socket | null = null
  private buffer = ''
  private ready: Promise<void> | null = null
  private pending = new Map<string, { resolve: (value: RpcResponse) => void; reject: (reason: Error) => void }>()

  constructor(private readonly info: ServiceInfo) {}

  async request<M extends RpcMethod>(method: M, payload: RpcRequestFor<M>['payload']): Promise<RpcResponse> {
    await this.connect()
    const id = randomUUID()
    const request = { id, method, payload } as RpcRequestFor<M>
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket!.write(`${JSON.stringify(request)}\n`)
    })
  }

  async requestAgent<M extends AgentRpcMethod>(method: M, payload: unknown): Promise<RpcResponse> {
    await this.connect()
    const id = randomUUID()
    const request = AgentRpcRequestSchema.parse({ id, method, payload }) as AgentRpcRequest
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket!.write(JSON.stringify(request) + '\n')
    })
  }

  private async connect(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.info.endpoint)
      this.socket = socket
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => this.onData(chunk, resolve))
      socket.once('error', (error) => {
        reject(error)
        for (const pending of this.pending.values()) pending.reject(error)
        this.pending.clear()
      })
      socket.once('close', () => {
        this.socket = null
        this.ready = null
      })
      socket.write(`${JSON.stringify({ type: 'handshake', token: this.info.token })}\n`)
    })
    return this.ready
  }

  private onData(chunk: string, resolveReady: () => void): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
      let message: unknown
      try { message = JSON.parse(line) as unknown } catch { continue }
      if (isReadyMessage(message)) { resolveReady(); continue }
      const response = RpcResponseSchema.safeParse(message)
      if (!response.success) continue
      const pending = this.pending.get(response.data.id)
      if (!pending) continue
      this.pending.delete(response.data.id)
      pending.resolve(response.data)
    }
  }
}

export async function loadServiceClient(path: string): Promise<WorkspaceServiceClient> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as Record<string, unknown>)['endpoint'] !== 'string' || typeof (parsed as Record<string, unknown>)['token'] !== 'string') {
    throw new Error('Workspace service info is invalid.')
  }
  const value = parsed as { endpoint: string; token: string }
  return new WorkspaceServiceClient({ endpoint: value.endpoint, token: value.token })
}

function isReadyMessage(value: unknown): value is { type: 'ready' } {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'ready'
}
