import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { AgentRpcRequestSchema, type AgentRpcMethod, type RpcRequest, type RpcResponse } from '@prw/contracts'
import type { WorkspaceToolBackend } from './backend.js'
import { createWorkspaceMcpServer } from './server.js'

type RpcMethod = RpcRequest['method']
type RpcRequestFor<M extends RpcMethod> = Extract<RpcRequest, { method: M }>

/**
 * Call the workspace service without a socket.
 *
 * `electron-builder.yml` sets `runAsNode: false` and the installer ships no
 * node executable, so `fork()` and `spawn(process.execPath)` cannot be used by
 * the packaged app. Rather than give the embedded Agent its own tool
 * implementation — which would drift from the ones external clients see — the
 * agent connects to the very same `McpServer` through an in-memory linked
 * transport, and this backend forwards each tool call into the service
 * dispatcher that a pipe request would have reached anyway.
 */
export function createInProcessWorkspaceBackend(dispatch: (input: unknown) => Promise<RpcResponse>): WorkspaceToolBackend {
  return {
    async request<M extends RpcMethod>(method: M, payload: RpcRequestFor<M>['payload']): Promise<RpcResponse> {
      return dispatch({ id: randomUUID(), method, payload } as RpcRequestFor<M>)
    },
    async requestAgent<M extends AgentRpcMethod>(method: M, payload: unknown): Promise<RpcResponse> {
      return dispatch(AgentRpcRequestSchema.parse({ id: randomUUID(), method, payload }))
    }
  }
}

export interface InProcessWorkspaceSession {
  /** A connected MCP client. The embedded Agent only needs `listTools`,
   * `callTool` and `close`, which is why the adapter takes a structural type. */
  readonly client: Client
  close(): Promise<void>
}

/**
 * Open one connected client/server pair over `InMemoryTransport`.
 *
 * The session is per run: the server object closes with the client, so a run
 * cannot leak a transport into the next one.
 */
export async function openInProcessWorkspaceSession(dispatch: (input: unknown) => Promise<RpcResponse>): Promise<InProcessWorkspaceSession> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createWorkspaceMcpServer(createInProcessWorkspaceBackend(dispatch))
  await server.connect(serverTransport)
  const client = new Client({ name: 'personal-research-workbench-agent', version: '0.0.4' })
  await client.connect(clientTransport)
  return {
    client,
    close: async (): Promise<void> => {
      await client.close()
      await server.close()
    }
  }
}
