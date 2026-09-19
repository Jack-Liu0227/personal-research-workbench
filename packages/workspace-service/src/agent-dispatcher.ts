import {
  AgentApprovalDecisionInputSchema,
  AgentExternalActionDecideInputSchema,
  AgentExternalActionsInputSchema,
  AgentAuthLoginAnswerInputSchema,
  AgentAuthLoginCancelInputSchema,
  AgentAuthLoginStartInputSchema,
  AgentAuthLogoutInputSchema,
  AgentBindingSaveInputSchema,
  AgentConversationCreateInputSchema,
  AgentConversationArchiveBulkInputSchema,
  AgentConversationListInputSchema,
  AgentConversationMessagesInputSchema,
  AgentConversationRecordsInputSchema,
  AgentConnectorSaveInputSchema,
  AgentCustomProvidersSaveInputSchema,
  AgentModelDiscoveryInputSchema,
  AgentRpcRequestSchema,
  AgentRuntimeKindSchema,
  AgentRunEventsInputSchema,
  AgentRunListInputSchema,
  AgentRunRecordsPageInputSchema,
  AgentRunStartInputSchema,
  AgentSettingsSaveInputSchema,
  ArchiveBulkInputSchema,
  AutomationRuleSaveInputSchema,
  AutomationRunHistoryInputSchema,
  type AgentRpcRequest,
  type RpcResponse
} from '@prw/contracts'
import { z } from 'zod'
import { AgentCoordinator, noAgentCredentials, type AgentCredentialSource } from './agent-coordinator.js'
import { AgentModelCoordinator } from './agent-models.js'
import type { AgentExternalActionCoordinator } from './agent-external-actions.js'
import { normalizeAppError } from './errors.js'

export interface AgentDispatchServices {
  readonly agent: AgentCoordinator
  /** Provider catalog, interactive login and the app-wide Agent defaults. */
  readonly models: AgentModelCoordinator
  /** Pending external writes waiting on a user decision. */
  readonly externalActions: AgentExternalActionCoordinator
}

/**
 * Every credential Electron Main attached for one RPC, keyed by provider.
 *
 * Core never reaches into a vault or a Pi profile: Main resolves credentials
 * before dispatch and passes them as a lookup. An empty source is a legitimate
 * answer and makes the run fail closed.
 */
export type AgentCredentialResolver = AgentCredentialSource

export interface AgentDispatchMetadata {
  readonly version: string
}

export async function dispatchAgentRpc(
  services: AgentDispatchServices,
  _metadata: AgentDispatchMetadata,
  input: unknown,
  credential: AgentCredentialResolver = noAgentCredentials
): Promise<RpcResponse> {
  let requestId = 'invalid-agent-request'
  try {
    const request = AgentRpcRequestSchema.parse(input)
    requestId = request.id
    const data = await execute(services, request, credential)
    return { id: request.id, ok: true, data: toJsonValue(data) }
  } catch (error) {
    return { id: requestId, ok: false, error: normalizeAppError(error) }
  }
}

async function execute(services: AgentDispatchServices, request: AgentRpcRequest, credential: AgentCredentialResolver): Promise<unknown> {
  const agent = services.agent
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
      // The probe reports the *effective* auth state: it sees the same
      // provider-keyed credentials this request carried, so a saved API key in
      // Settings is reflected without Core reading any vault.
      return agent.listConnectors(credential)
    }
    case 'agent.connectors.test': {
      const runtime = z.object({ runtime: AgentRuntimeKindSchema }).parse(request.payload).runtime
      return agent.testConnector(runtime, credential.all)
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
    // Model catalog and login. The catalog needs no credential to enumerate
    // providers, but the login handshake does: the same provider-keyed
    // credentials this RPC carried are handed to the SDK's own credential
    // store, so an existing token is refreshed instead of being re-asked for.
    case 'agent.models.catalog': z.null().parse(request.payload); return services.models.catalog()
    case 'agent.models.login.start': return services.models.loginStart(AgentAuthLoginStartInputSchema.parse(request.payload), credential.all)
    case 'agent.models.login.answer': {
      services.models.loginAnswer(AgentAuthLoginAnswerInputSchema.parse(request.payload))
      return null
    }
    case 'agent.models.login.cancel': {
      services.models.loginCancel(AgentAuthLoginCancelInputSchema.parse(request.payload))
      return null
    }
    case 'agent.models.logout': return services.models.logout(AgentAuthLogoutInputSchema.parse(request.payload), credential.all)
    // User-added providers are read from and written to the app-owned
    // models.json, so no credential travels with these calls: the file holds
    // endpoints and model ids, never keys.
    case 'agent.models.custom.get': z.null().parse(request.payload); return services.models.customProviders()
    case 'agent.models.custom.save':
      return services.models.saveCustomProviders(AgentCustomProvidersSaveInputSchema.parse(request.payload))
    // The one custom-provider method that does carry a credential: the probe has
    // to authenticate against the endpoint it is asking. It is not a write — the
    // answer is candidates for the form, never a change to the stored catalog.
    case 'agent.models.custom.discover':
      return services.models.discoverModels(AgentModelDiscoveryInputSchema.parse(request.payload), credential.all)
    case 'agent.settings.get': z.null().parse(request.payload); return services.models.getSettings()
    case 'agent.settings.save': return services.models.saveSettings(AgentSettingsSaveInputSchema.parse(request.payload))
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
    // Pending external writes. `decide` is the only way a preview ever becomes a
    // write, and it is reachable from the renderer alone: no MCP tool forwards
    // it, so the Agent that requested the write cannot approve it.
    case 'agent.externalActions.list': {
      const input = AgentExternalActionsInputSchema.parse(request.payload)
      services.externalActions.expire()
      return services.externalActions.list({
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        ...(input.status === undefined ? {} : { status: input.status })
      })
    }
    case 'agent.externalActions.decide': {
      const input = AgentExternalActionDecideInputSchema.parse(request.payload)
      services.externalActions.expire()
      return await services.externalActions.decide(input)
    }
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
