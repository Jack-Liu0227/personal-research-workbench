import {
  AgentApprovalDecisionInputSchema,
  AgentBindingSaveInputSchema,
  AgentConversationCreateInputSchema,
  AgentConversationArchiveBulkInputSchema,
  AgentConversationListInputSchema,
  AgentConversationMessagesInputSchema,
  AgentConversationRecordsInputSchema,
  AgentConnectorSaveInputSchema,
  AgentRpcRequestSchema,
  AgentRunEventsInputSchema,
  AgentRunListInputSchema,
  AgentRunRecordsPageInputSchema,
  AgentRunStartInputSchema,
  AutomationRuleSaveInputSchema,
  type AgentRpcRequest,
  type RpcResponse
} from '@prw/contracts'
import { z } from 'zod'
import { AgentCoordinator } from './agent-coordinator.js'
import { normalizeAppError } from './errors.js'

export interface AgentDispatchServices {
  readonly agent: AgentCoordinator
}

export interface AgentDispatchMetadata {
  readonly version: string
}

export async function dispatchAgentRpc(
  services: AgentDispatchServices,
  _metadata: AgentDispatchMetadata,
  input: unknown
): Promise<RpcResponse> {
  let requestId = 'invalid-agent-request'
  try {
    const request = AgentRpcRequestSchema.parse(input)
    requestId = request.id
    const data = await execute(services.agent, request)
    return { id: request.id, ok: true, data: toJsonValue(data) }
  } catch (error) {
    return { id: requestId, ok: false, error: normalizeAppError(error) }
  }
}

async function execute(agent: AgentCoordinator, request: AgentRpcRequest): Promise<unknown> {
  switch (request.method) {
    case 'agent.conversations.list': return agent.listConversations(AgentConversationListInputSchema.parse(request.payload))
    case 'agent.conversations.create': return agent.createConversation(AgentConversationCreateInputSchema.parse(request.payload))
    case 'agent.conversations.get': return agent.getConversation(z.object({ conversationId: z.string() }).parse(request.payload).conversationId)
    case 'agent.conversations.messages': return agent.listConversationMessages(AgentConversationMessagesInputSchema.parse(request.payload))
    case 'agent.conversations.records': return agent.listConversationRecords(AgentConversationRecordsInputSchema.parse(request.payload))
    case 'agent.conversations.archive': { const input = z.object({ conversationId: z.string(), expectedRevision: z.number() }).parse(request.payload); agent.archiveConversation(input.conversationId, input.expectedRevision); return null }
    case 'agent.conversations.archiveBulk': {
      agent.archiveConversations(AgentConversationArchiveBulkInputSchema.parse(request.payload).items)
      // Void RPCs have an explicit null response. Returning the implicit
      // `undefined` here used to serialize to the string "undefined", which
      // made the preload's `z.null()` parser fail after a successful archive.
      return null
    }
    case 'agent.connectors.list': z.null().parse(request.payload); return agent.listConnectors()
    case 'agent.connectors.test': return agent.testConnector(z.object({ runtime: z.enum(['codex', 'pi']) }).parse(request.payload).runtime)
    case 'agent.connectors.save': return agent.saveConnector(AgentConnectorSaveInputSchema.parse(request.payload))
    case 'agent.bindings.list': z.null().parse(request.payload); return agent.listBindings()
    case 'agent.bindings.save': return agent.saveBinding(AgentBindingSaveInputSchema.parse(request.payload))
    case 'agent.proxyProfiles.list': z.null().parse(request.payload); return agent.listProxyProfiles()
    case 'agent.proxyProfiles.save': return agent.saveProxyProfile(request.payload as any)
    case 'agent.proxyBindings.list': z.null().parse(request.payload); return agent.listProxyBindings()
    case 'agent.proxyBindings.save': return agent.saveProxyBinding(request.payload as any)
    case 'agent.runs.start': return agent.start(AgentRunStartInputSchema.parse(request.payload))
    case 'agent.runs.list': {
      const input = AgentRunListInputSchema.parse(request.payload)
      return agent.listRuns(input.page?.limit ?? 100, {
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.projectId === undefined ? {} : { projectId: input.projectId })
      })
    }
    case 'agent.runs.get': return agent.getRun(z.object({ runId: z.string() }).parse(request.payload).runId)
    case 'agent.runs.eventsPage': {
      const input = AgentRunEventsInputSchema.parse(request.payload)
      return agent.listEvents(input.runId, input.afterSeq, input.limit)
    }
    case 'agent.runs.recordsPage': return agent.listRunRecords(AgentRunRecordsPageInputSchema.parse(request.payload))
    case 'agent.runs.cancel': await agent.cancel(z.object({ runId: z.string() }).parse(request.payload).runId); return null
    case 'agent.runs.retry': return agent.retry(z.object({ runId: z.string() }).parse(request.payload).runId)
    case 'agent.approvals.list': return agent.listApprovals(z.object({ runId: z.string().optional() }).parse(request.payload).runId)
    case 'agent.approvals.decide': return agent.decideApproval(AgentApprovalDecisionInputSchema.parse(request.payload))
    case 'automation.rules.list': z.null().parse(request.payload); return agent.listAutomationRules()
    case 'automation.rules.save': return agent.saveAutomationRule(AutomationRuleSaveInputSchema.parse(request.payload))
    case 'automation.rules.archive': { const input = z.object({ id: z.string(), expectedRevision: z.number() }).parse(request.payload); agent.archiveAutomationRule(input.id, input.expectedRevision); return null }
    case 'automation.rules.runNow': return agent.runAutomationNow(z.object({ id: z.string() }).parse(request.payload).id)
    case 'automation.runs.list': return agent.listAutomationRuns(z.object({ limit: z.number() }).parse(request.payload).limit)
    case 'inbox.ai.list': return agent.listInbox(z.object({ unreadOnly: z.boolean() }).parse(request.payload).unreadOnly)
    case 'inbox.ai.markRead': agent.markInboxRead(z.object({ id: z.string() }).parse(request.payload).id); return null
    case 'inbox.ai.archive': agent.archiveInbox(z.object({ id: z.string() }).parse(request.payload).id); return null
  }
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(toJsonValue)
  if (typeof value === 'object') {
    const result: { [key: string]: JsonValue } = {}
    for (const [key, entry] of Object.entries(value)) result[key] = toJsonValue(entry)
    return result
  }
  // `undefined` is the implementation-level result of a void command. The
  // wire contract represents void as JSON null so strict preload schemas stay
  // aligned with the RPC response.
  return value === undefined ? null : String(value)
}
