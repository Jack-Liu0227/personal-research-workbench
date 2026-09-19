import type { AgentRpcMethod, RpcRequest, RpcResponse } from '@prw/contracts'

type RpcMethod = RpcRequest['method']
type RpcRequestFor<M extends RpcMethod> = Extract<RpcRequest, { method: M }>

/**
 * The workspace surface the MCP tools call.
 *
 * It is deliberately structural and transport-free. Two implementations exist:
 * `WorkspaceServiceClient` talks to the service over the authenticated named
 * pipe (the CLI/stdio path used by external MCP clients), and the in-process
 * backend in `in-process.ts` calls the service's own dispatcher directly for
 * the embedded Agent. Both go through the same `dispatchRpc` validation, so the
 * tools cannot tell them apart and neither can skip a schema check.
 */
export interface WorkspaceToolBackend {
  request<M extends RpcMethod>(method: M, payload: RpcRequestFor<M>['payload']): Promise<RpcResponse>
  requestAgent<M extends AgentRpcMethod>(method: M, payload: unknown): Promise<RpcResponse>
}
