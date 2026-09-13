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
  ArchiveBulkInputSchema,
  AutomationRuleSaveInputSchema,
  AutomationRunHistoryInputSchema,
  type AgentRpcRequest,
  type RpcResponse
} from '@prw/contracts'
import { z } from 'zod'
import { AgentCoordinator } from './agent-coordinator.js'
import { normalizeAppError } from './errors.js'

export interface AgentDispatchServices {
  readonly agent: AgentCoordinator
}

/**
 * Resolve the app-owned credential for the runtime a request selected.
 *
 * Core never reaches into a vault or a CLI login: Main resolves the credential
 * before dispatch and passes it as a lookup function. `null` is a legitimate
 * answer and makes the run fail closed.
 */
export type AgentCredentialResolver = (runtime: import('@prw/contracts').AgentRuntimeKind) => { readonly provider: string; readonly secret: string } | null

export interface AgentDispatchMetadata {
  readonly version: string
}

export async function dispatchAgentRpc(
  services: AgentDispatchServices,
  _metadata: AgentDispatchMetadata,
  input: unknown,
  credential: AgentCredentialResolver = () => null
): Promise<RpcResponse> {
  let requestId = 'invalid-agent-request'
  try {
    const request = AgentRpcRequestSchema.parse(input)
    requestId = request.id
    const data = await execute(services.agent, request, credential)
    return { id: request.id, ok: true, data: toJsonValue(data) }
  } catch (error) {
    return { id: requestId, ok: false, error: normalizeAppError(error) }
  }
}

async function execute(agent: AgentCoordinator, request: AgentRpcRequest, credential: AgentCredentialResolver): Promise<unknown> {
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
    // Conversation delete stays a record-level write: it needs no runtime
    // credential and no CLI process, so it is deliberately absent from Main's
    // credential-bearing method set.
    case 'agent.conversations.remove': {
      const input = z.object({ conversationId: z.string(), expectedRevision: z.number().int().nonnegative() }).parse(request.payload)
      return agent.removeConversation(input.conversationId, input.expectedRevision)
    }
    case 'agent.conversations.removeBulk': return agent.removeConversations(ArchiveBulkInputSchema.parse(request.payload))
    case 'agent.connectors.list': {
      z.null().parse(request.payload)
      // A probe reports the *effective* credential source: the app-owned one
      // when present, otherwise the CLI's own login inside the app profile.
      return agent.listConnectors(credential)
    }
    case 'agent.connectors.test': {
      const runtime = z.object({ runtime: z.enum(['codex', 'pi']) }).parse(request.payload).runtime
      return agent.testConnector(runtime, credential(runtime))
    }
    case 'agent.connectors.save': return agent.saveConnector(AgentConnectorSaveInputSchema.parse(request.payload))
    // Runtime credentials live in Main's safeStorage vault. Core must never
    // receive a secret for storage, so these methods are refused here rather
    // than silently accepted.
    case 'agent.credentials.status':
    case 'agent.credentials.save': {
      const error = new Error('Runtime credentials are handled by the desktop main process, not by the workspace service.')
      error.name = 'FEATURE_DISABLED'
      throw error
    }
    case 'agent.bindings.list': z.null().parse(request.payload); return agent.listBindings()
    case 'agent.bindings.save': return agent.saveBinding(AgentBindingSaveInputSchema.parse(request.payload))
    case 'agent.proxyProfiles.list': z.null().parse(request.payload); return agent.listProxyProfiles()
    case 'agent.proxyProfiles.save': return agent.saveProxyProfile(request.payload as any)
    case 'agent.proxyBindings.list': z.null().parse(request.payload); return agent.listProxyBindings()
    case 'agent.proxyBindings.save': return agent.saveProxyBinding(request.payload as any)
    case 'agent.runs.start': return agent.start(AgentRunStartInputSchema.parse(request.payload), credential)
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
    case 'agent.runs.retry': {
      // `retry` replays the original run on its own runtime, so its credential
      // is resolved for that runtime rather than for the current selection.
      const runId = z.object({ runId: z.string() }).parse(request.payload).runId
      return agent.retry(runId, credential)
    }
    case 'agent.approvals.list': return agent.listApprovals(z.object({ runId: z.string().optional() }).parse(request.payload).runId)
    case 'agent.approvals.decide': return agent.decideApproval(AgentApprovalDecisionInputSchema.parse(request.payload))
    case 'automation.rules.list': z.null().parse(request.payload); return agent.listAutomationRules()
    case 'automation.skills.list': z.null().parse(request.payload); return agent.listAutomationSkills()
    case 'automation.rules.save': return agent.saveAutomationRule(AutomationRuleSaveInputSchema.parse(request.payload))
    case 'automation.rules.archive': { const input = z.object({ id: z.string(), expectedRevision: z.number() }).parse(request.payload); agent.archiveAutomationRule(input.id, input.expectedRevision); return null }
    // Archive selected rules in one transaction with per-rule receipts. Run and
    // occurrence history keeps pointing at the archived rule; nothing in the
    // history is deleted by this command.
    case 'automation.rules.bulkArchive': return agent.bulkArchiveAutomationRules(ArchiveBulkInputSchema.parse(request.payload))
    case 'automation.rules.runNow': return agent.runAutomationNow(z.object({ id: z.string() }).parse(request.payload).id)
    case 'automation.runs.list': return agent.listAutomationRuns(z.object({ limit: z.number() }).parse(request.payload).limit)
    case 'automation.runs.history': return agent.listAutomationRunHistory(AutomationRunHistoryInputSchema.parse(request.payload))
    // RUN HISTORY removal with a CAS revision lock. Only the run record's
    // archive flag moves; the rule, its occurrence cursor and every delivered
    // artifact/note stay exactly as they were.
    case 'automation.runs.archive': {
      const input = z.object({ runId: z.string(), expectedRevision: z.number() }).parse(request.payload)
      agent.archiveAutomationRun(input.runId, input.expectedRevision)
      return null
    }
    case 'automation.runs.archiveBulk': return agent.bulkArchiveAutomationRuns(ArchiveBulkInputSchema.parse(request.payload))
    case 'automation.runs.retry': return agent.retryAutomationRun(z.object({ runId: z.string() }).parse(request.payload).runId)
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
