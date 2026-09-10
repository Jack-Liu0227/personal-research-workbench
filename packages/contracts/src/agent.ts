import { z } from 'zod'
import { AgentWorkflowKeySchema, ArtifactKindSchema } from './research.js'
import { IdSchema, IsoInstantSchema, PageInputSchema, ProjectIdSchema } from './v2.js'

const IsoDateSchema = IsoInstantSchema

export const AgentRuntimeKindSchema = z.enum(['codex', 'pi'])
export type AgentRuntimeKind = z.infer<typeof AgentRuntimeKindSchema>

export const AgentRuntimeTransportSchema = z.enum(['cli', 'inprocess'])
export type AgentRuntimeTransport = z.infer<typeof AgentRuntimeTransportSchema>

export const AgentToolProfileSchema = z.enum(['read-only', 'approved-write'])
export type AgentToolProfile = z.infer<typeof AgentToolProfileSchema>

/** User-facing permission modes aligned with Codex/Pi CLI semantics. The
 * legacy toolProfile remains on the wire for backwards compatibility. */
export const AgentPermissionModeSchema = z.enum(['read-only', 'auto', 'full-access'])
export type AgentPermissionMode = z.infer<typeof AgentPermissionModeSchema>
export const AgentApprovalPolicySchema = z.enum(['on-request', 'never'])
export type AgentApprovalPolicy = z.infer<typeof AgentApprovalPolicySchema>

/** Proxy endpoints are optional, non-secret runtime metadata. Credentials in
 * proxy URLs are rejected so this configuration can safely live in SQLite. */
export const AgentProxyUrlSchema = z.string().trim().max(2_048).nullable().superRefine((value, context) => {
  if (!value) return
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      context.addIssue({ code: 'custom', message: 'Agent proxy must use HTTP or HTTPS.' })
    }
    if (parsed.username || parsed.password) {
      context.addIssue({ code: 'custom', message: 'Agent proxy URLs must not contain credentials.' })
    }
    if (!parsed.hostname) context.addIssue({ code: 'custom', message: 'Agent proxy must include a host.' })
  } catch {
    context.addIssue({ code: 'custom', message: 'Agent proxy must be a valid HTTP(S) URL.' })
  }
})
export const AgentProxyProfileSchema = z.strictObject({
  id: IdSchema, name: z.string().trim().min(1).max(200), enabled: z.boolean(),
  httpProxy: AgentProxyUrlSchema, httpsProxy: AgentProxyUrlSchema,
  noProxy: z.string().trim().max(2_048).nullable(), createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema, revision: z.int().nonnegative()
})
export type AgentProxyProfile = z.infer<typeof AgentProxyProfileSchema>
export const AgentProxyProfileSaveInputSchema = z.strictObject({
  id: IdSchema.optional(), name: z.string().trim().min(1).max(200), enabled: z.boolean().default(false),
  httpProxy: AgentProxyUrlSchema.default(null), httpsProxy: AgentProxyUrlSchema.default(null),
  noProxy: z.string().trim().max(2_048).nullable().default(null), expectedRevision: z.int().nonnegative().nullable().default(null)
})
export type AgentProxyProfileSaveInput = z.infer<typeof AgentProxyProfileSaveInputSchema>
export const AgentProxyBindingSchema = z.strictObject({ id: IdSchema, profileId: IdSchema, runtime: AgentRuntimeKindSchema, createdAt: IsoDateSchema, updatedAt: IsoDateSchema, revision: z.int().nonnegative() })
export type AgentProxyBinding = z.infer<typeof AgentProxyBindingSchema>
export const AgentProxyBindingSaveInputSchema = z.strictObject({ id: IdSchema.optional(), profileId: IdSchema, runtime: AgentRuntimeKindSchema, expectedRevision: z.int().nonnegative().nullable().default(null) })
export type AgentProxyBindingSaveInput = z.infer<typeof AgentProxyBindingSaveInputSchema>

export const AgentRunStatusSchema = z.enum([
  'planned', 'queued', 'running', 'waiting_confirmation', 'completed',
  'partial', 'failed', 'canceled', 'blocked', 'missed'
])
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>

export const AgentEventKindSchema = z.enum([
  'started', 'heartbeat', 'progress', 'assistant_message', 'tool_call',
  'approval_required', 'artifact_ready', 'completed', 'failed', 'canceled'
])
export type AgentEventKind = z.infer<typeof AgentEventKindSchema>

export const AgentConnectorSchema = z.strictObject({
  id: IdSchema,
  runtime: AgentRuntimeKindSchema,
  executablePath: z.string().max(4_000).nullable(),
  version: z.string().max(200).nullable(),
  enabled: z.boolean(),
  available: z.boolean(),
  mcp: z.boolean(),
  structuredOutput: z.boolean(),
  workspaceWrite: z.boolean(),
  message: z.string().max(500),
  /** Volatile status from the installed CLI's own auth check. */
  authReady: z.boolean().optional(),
  proxyEnabled: z.boolean(),
  httpProxy: AgentProxyUrlSchema,
  httpsProxy: AgentProxyUrlSchema,
  noProxy: z.string().trim().max(2_048).nullable(),
  /** Ephemeral non-secret defaults detected from the local CLI profile. */
  localDefaultModel: z.string().max(300).nullable().optional(),
  localThinkingLevel: z.string().max(50).nullable().optional(),
  localPermission: z.string().max(100).nullable().optional(),
  modelOptions: z.array(z.string().max(300)).max(200).default([]),
  thinkingOptions: z.array(z.string().max(50)).max(20).default([]),
  // Populated only by a live CLI capability probe.  An empty list means the
  // executable is unavailable or did not advertise permission switches.
  permissionOptions: z.array(AgentPermissionModeSchema).default([]),
  updatedAt: IsoDateSchema,
  revision: z.int().nonnegative()
})
export type AgentConnector = z.infer<typeof AgentConnectorSchema>

export const AgentConnectorSaveInputSchema = z.strictObject({
  id: IdSchema.optional(),
  runtime: AgentRuntimeKindSchema,
  executablePath: z.string().trim().max(4_000).nullable().default(null),
  enabled: z.boolean().default(true),
  proxyEnabled: z.boolean().default(false),
  httpProxy: AgentProxyUrlSchema.default(null),
  httpsProxy: AgentProxyUrlSchema.default(null),
  noProxy: z.string().trim().max(2_048).nullable().default(null),
  expectedRevision: z.int().nonnegative().nullable().default(null)
})
export type AgentConnectorSaveInput = z.infer<typeof AgentConnectorSaveInputSchema>

export const AgentBindingSchema = z.strictObject({
  id: IdSchema,
  projectId: ProjectIdSchema.nullable(),
  runtime: AgentRuntimeKindSchema,
  fallbackRuntime: AgentRuntimeKindSchema.nullable(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  revision: z.int().nonnegative()
})
export type AgentBinding = z.infer<typeof AgentBindingSchema>

export const AgentBindingSaveInputSchema = z.strictObject({
  id: IdSchema.optional(),
  projectId: ProjectIdSchema.nullable().default(null),
  runtime: AgentRuntimeKindSchema,
  fallbackRuntime: AgentRuntimeKindSchema.nullable().default(null),
  expectedRevision: z.int().nonnegative().nullable().default(null)
})
export type AgentBindingSaveInput = z.infer<typeof AgentBindingSaveInputSchema>

export const AgentRunRecordSchema = z.strictObject({
  id: IdSchema,
  jobId: IdSchema.nullable(),
  conversationId: IdSchema.nullable(),
  idempotencyKey: z.string().max(512).nullable(),
  runtime: AgentRuntimeKindSchema,
  transport: AgentRuntimeTransportSchema,
  workflowKey: AgentWorkflowKeySchema,
  projectId: ProjectIdSchema.nullable(),
  paperIds: z.array(IdSchema),
  toolProfile: AgentToolProfileSchema,
  permissionMode: AgentPermissionModeSchema.default('read-only'),
  approvalPolicy: AgentApprovalPolicySchema.default('on-request'),
  status: AgentRunStatusSchema,
  input: z.record(z.string(), z.string()),
  output: z.string(),
  artifactId: IdSchema.nullable(),
  error: z.string().nullable(),
  createdAt: IsoDateSchema,
  startedAt: IsoDateSchema.nullable(),
  finishedAt: IsoDateSchema.nullable()
})
export type AgentRunRecord = z.infer<typeof AgentRunRecordSchema>

export const AgentRunStartInputSchema = z.strictObject({
  jobId: IdSchema.nullable().default(null),
  conversationId: IdSchema.nullable().default(null),
  runtime: AgentRuntimeKindSchema.nullable().default(null),
  model: z.string().trim().max(300).nullable().default(null),
  /** Per-run reasoning/thinking override. Null follows the runtime profile. */
  thinking: z.string().trim().max(50).nullable().default(null),
  workflowKey: AgentWorkflowKeySchema,
  projectId: ProjectIdSchema.nullable().default(null),
  paperIds: z.array(IdSchema).max(500).default([]),
  instructions: z.string().trim().min(1).max(100_000),
  toolProfile: AgentToolProfileSchema.default('read-only'),
  permissionMode: AgentPermissionModeSchema.default('read-only'),
  approvalPolicy: AgentApprovalPolicySchema.default('on-request'),
  idempotencyKey: z.string().trim().max(512).nullable().default(null)
})
export type AgentRunStartInput = z.infer<typeof AgentRunStartInputSchema>

/** A persisted chat session. The shape intentionally mirrors AionUI's
 * conversation selectors while keeping project IDs authoritative in PRW. */
export const AgentConversationStatusSchema = z.enum(['pending', 'running', 'finished', 'archived'])
export type AgentConversationStatus = z.infer<typeof AgentConversationStatusSchema>

export const AgentConversationSchema = z.strictObject({
  id: IdSchema,
  projectId: ProjectIdSchema.nullable(),
  title: z.string().min(1).max(500),
  runtime: AgentRuntimeKindSchema,
  model: z.string().max(300).nullable(),
  assistantKey: z.string().max(300).nullable(),
  toolProfile: AgentToolProfileSchema,
  permissionMode: AgentPermissionModeSchema.default('read-only'),
  approvalPolicy: AgentApprovalPolicySchema.default('on-request'),
  status: AgentConversationStatusSchema,
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  archivedAt: IsoDateSchema.nullable(),
  revision: z.int().nonnegative()
})
export type AgentConversation = z.infer<typeof AgentConversationSchema>

export const AgentConversationCreateInputSchema = z.strictObject({
  projectId: ProjectIdSchema.nullable().default(null),
  title: z.string().trim().min(1).max(500).default('New Chat'),
  runtime: AgentRuntimeKindSchema.default('pi'),
  model: z.string().trim().max(300).nullable().default(null),
  assistantKey: z.string().trim().max(300).nullable().default('researcher'),
  toolProfile: AgentToolProfileSchema.default('read-only'),
  permissionMode: AgentPermissionModeSchema.default('read-only'),
  approvalPolicy: AgentApprovalPolicySchema.default('on-request')
})
export type AgentConversationCreateInput = z.infer<typeof AgentConversationCreateInputSchema>

export const AgentConversationListInputSchema = z.strictObject({
  projectId: ProjectIdSchema.nullable().optional(),
  includeArchived: z.boolean().default(false),
  limit: z.int().min(1).max(100).default(50)
})
export type AgentConversationListInput = z.infer<typeof AgentConversationListInputSchema>

export const AgentMessageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool'])
export type AgentMessageRole = z.infer<typeof AgentMessageRoleSchema>

export const AgentMessageSchema = z.strictObject({
  id: IdSchema,
  conversationId: IdSchema,
  runId: IdSchema.nullable(),
  role: AgentMessageRoleSchema,
  content: z.string().max(100_000),
  createdAt: IsoDateSchema,
  seq: z.int().nonnegative()
})
export type AgentMessage = z.infer<typeof AgentMessageSchema>

export const AgentConversationMessagesInputSchema = z.strictObject({
  conversationId: IdSchema,
  limit: z.int().min(1).max(500).default(200)
})
export type AgentConversationMessagesInput = z.infer<typeof AgentConversationMessagesInputSchema>

/** A revision-checked conversation archive request.  Archive is the public
 * delete affordance for Agent history; keeping it revision aware prevents a
 * bulk action from silently removing a conversation that changed meanwhile. */
export const AgentConversationArchiveItemSchema = z.strictObject({
  conversationId: IdSchema,
  expectedRevision: z.int().nonnegative()
})
export type AgentConversationArchiveItem = z.infer<typeof AgentConversationArchiveItemSchema>

export const AgentConversationArchiveBulkInputSchema = z.strictObject({
  items: z.array(AgentConversationArchiveItemSchema).min(1).max(100)
}).superRefine((value, context) => {
  const seen = new Set<string>()
  value.items.forEach((item, index) => {
    if (seen.has(item.conversationId)) {
      context.addIssue({ code: 'custom', path: ['items', index, 'conversationId'], message: 'conversationId must be unique' })
    }
    seen.add(item.conversationId)
  })
})
export type AgentConversationArchiveBulkInput = z.infer<typeof AgentConversationArchiveBulkInputSchema>

export const AgentRunListInputSchema = z.strictObject({
  status: AgentRunStatusSchema.optional(),
  projectId: ProjectIdSchema.nullable().optional(),
  page: PageInputSchema.optional()
})
export type AgentRunListInput = z.infer<typeof AgentRunListInputSchema>

export const AgentEventSchema = z.strictObject({
  id: IdSchema,
  runId: IdSchema,
  seq: z.int().nonnegative(),
  kind: AgentEventKindSchema,
  payload: z.unknown(),
  createdAt: IsoDateSchema
})
export type AgentEventRecord = z.infer<typeof AgentEventSchema>

export const AgentRunEventsInputSchema = z.strictObject({
  runId: IdSchema,
  afterSeq: z.int().nonnegative().default(0),
  limit: z.int().min(1).max(500).default(100)
})
export type AgentRunEventsInput = z.infer<typeof AgentRunEventsInputSchema>

export const AgentApprovalSchema = z.strictObject({
  id: IdSchema,
  runId: IdSchema,
  operation: z.string().min(1).max(200),
  summary: z.string().max(2_000),
  status: z.enum(['pending', 'approved', 'rejected', 'expired']),
  createdAt: IsoDateSchema,
  decidedAt: IsoDateSchema.nullable()
})
export type AgentApproval = z.infer<typeof AgentApprovalSchema>

export const AgentApprovalDecisionInputSchema = z.strictObject({
  id: IdSchema,
  decision: z.enum(['approve', 'reject'])
})
export type AgentApprovalDecisionInput = z.infer<typeof AgentApprovalDecisionInputSchema>

export const AutomationRuleSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1).max(200),
  workflowKey: AgentWorkflowKeySchema,
  runtime: AgentRuntimeKindSchema.nullable(),
  model: z.string().max(300).nullable(),
  assistantKey: z.string().max(300).nullable(),
  workspacePath: z.string().max(4_000).nullable(),
  frequency: z.enum(['manual', 'hourly', 'daily', 'weekdays', 'weekly', 'custom']),
  executionMode: z.enum(['new_conversation', 'existing']),
  conversationId: IdSchema.nullable(),
  prompt: z.string().max(100_000),
  skillKey: z.string().trim().max(100).nullable().default(null),
  topic: z.string().trim().max(500).default(''),
  outputFolder: z.string().trim().max(180).default('每日文献推送'),
  permissionMode: AgentPermissionModeSchema.default('read-only'),
  approvalPolicy: AgentApprovalPolicySchema.default('on-request'),
  projectId: ProjectIdSchema.nullable(),
  cron: z.string().min(1).max(200),
  timezone: z.string().min(1).max(100),
  enabled: z.boolean(),
  nextRunAt: IsoDateSchema.nullable(),
  lastRunAt: IsoDateSchema.nullable(),
  revision: z.int().nonnegative()
})
export type AutomationRule = z.infer<typeof AutomationRuleSchema>

export const AutomationRuleSaveInputSchema = z.strictObject({
  id: IdSchema.optional(),
  name: z.string().trim().min(1).max(200),
  workflowKey: AgentWorkflowKeySchema,
  runtime: AgentRuntimeKindSchema.nullable().default(null),
  model: z.string().trim().max(300).nullable().default(null),
  assistantKey: z.string().trim().max(300).nullable().default('researcher'),
  workspacePath: z.string().trim().max(4_000).nullable().default(null),
  frequency: z.enum(['manual', 'hourly', 'daily', 'weekdays', 'weekly', 'custom']).default('custom'),
  executionMode: z.enum(['new_conversation', 'existing']).default('new_conversation'),
  conversationId: IdSchema.nullable().default(null),
  prompt: z.string().trim().max(100_000).default(''),
  skillKey: z.string().trim().max(100).nullable().default(null),
  topic: z.string().trim().max(500).default(''),
  outputFolder: z.string().trim().max(180).default('每日文献推送'),
  permissionMode: AgentPermissionModeSchema.default('read-only'),
  approvalPolicy: AgentApprovalPolicySchema.default('on-request'),
  projectId: ProjectIdSchema.nullable().default(null),
  cron: z.string().trim().min(1).max(200),
  timezone: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  expectedRevision: z.int().nonnegative().nullable().default(null)
})
export type AutomationRuleSaveInput = z.infer<typeof AutomationRuleSaveInputSchema>

export const AgentInboxItemSchema = z.strictObject({
  id: IdSchema,
  runId: IdSchema.nullable(),
  artifactId: IdSchema.nullable(),
  title: z.string().min(1).max(500),
  body: z.string().max(100_000),
  kind: z.union([ArtifactKindSchema, z.literal('approval'), z.literal('failure')]),
  read: z.boolean(),
  createdAt: IsoDateSchema
})
export type AgentInboxItem = z.infer<typeof AgentInboxItemSchema>

export const AgentRpcMethodPayloadSchemas = {
  'agent.conversations.list': AgentConversationListInputSchema,
  'agent.conversations.create': AgentConversationCreateInputSchema,
  'agent.conversations.get': z.strictObject({ conversationId: IdSchema }),
  'agent.conversations.messages': AgentConversationMessagesInputSchema,
  'agent.conversations.archive': z.strictObject({ conversationId: IdSchema, expectedRevision: z.int().nonnegative() }),
  'agent.conversations.archiveBulk': AgentConversationArchiveBulkInputSchema,
  'agent.connectors.list': z.null(),
  'agent.connectors.test': z.strictObject({ runtime: AgentRuntimeKindSchema }),
  'agent.connectors.save': AgentConnectorSaveInputSchema,
  'agent.bindings.list': z.null(),
  'agent.bindings.save': AgentBindingSaveInputSchema,
  'agent.proxyProfiles.list': z.null(),
  'agent.proxyProfiles.save': AgentProxyProfileSaveInputSchema,
  'agent.proxyBindings.list': z.null(),
  'agent.proxyBindings.save': AgentProxyBindingSaveInputSchema,
  'agent.runs.start': AgentRunStartInputSchema,
  'agent.runs.list': AgentRunListInputSchema,
  'agent.runs.get': z.strictObject({ runId: IdSchema }),
  'agent.runs.eventsPage': AgentRunEventsInputSchema,
  'agent.runs.cancel': z.strictObject({ runId: IdSchema }),
  'agent.runs.retry': z.strictObject({ runId: IdSchema }),
  'agent.approvals.list': z.strictObject({ runId: IdSchema.optional() }),
  'agent.approvals.decide': AgentApprovalDecisionInputSchema,
  'automation.rules.list': z.null(),
  'automation.rules.save': AutomationRuleSaveInputSchema,
  'automation.rules.archive': z.strictObject({ id: IdSchema, expectedRevision: z.int().nonnegative() }),
  'automation.rules.runNow': z.strictObject({ id: IdSchema }),
  'automation.runs.list': z.strictObject({ limit: z.int().min(1).max(100).default(50) }),
  'inbox.ai.list': z.strictObject({ unreadOnly: z.boolean().default(false) }),
  'inbox.ai.markRead': z.strictObject({ id: IdSchema }),
  'inbox.ai.archive': z.strictObject({ id: IdSchema })
} as const

export type AgentRpcMethod = keyof typeof AgentRpcMethodPayloadSchemas

const agentRpc = <M extends AgentRpcMethod>(method: M) =>
  z.strictObject({ id: IdSchema, method: z.literal(method), payload: AgentRpcMethodPayloadSchemas[method] })

export const AgentRpcRequestSchema = z.discriminatedUnion('method', [
  ...Object.keys(AgentRpcMethodPayloadSchemas).map((method) => agentRpc(method as AgentRpcMethod))
] as [ReturnType<typeof agentRpc>, ...ReturnType<typeof agentRpc>[]])
export type AgentRpcRequest = z.infer<typeof AgentRpcRequestSchema>

export interface WorkbenchAgentApiV1 {
  conversations: {
    list(input?: AgentConversationListInput): Promise<AgentConversation[]>
    create(input?: AgentConversationCreateInput): Promise<AgentConversation>
    get(conversationId: string): Promise<AgentConversation>
    messages(input: AgentConversationMessagesInput): Promise<AgentMessage[]>
    archive(conversationId: string, expectedRevision: number): Promise<void>
    archiveBulk(items: AgentConversationArchiveItem[]): Promise<void>
  }
  connectors: {
    list(): Promise<AgentConnector[]>
    test(runtime: AgentRuntimeKind): Promise<AgentConnector>
    save(input: AgentConnectorSaveInput): Promise<AgentConnector>
  }
  bindings: {
    list(): Promise<AgentBinding[]>
    save(input: AgentBindingSaveInput): Promise<AgentBinding>
  }
  proxyProfiles: { list(): Promise<AgentProxyProfile[]>; save(input: AgentProxyProfileSaveInput): Promise<AgentProxyProfile> }
  proxyBindings: { list(): Promise<AgentProxyBinding[]>; save(input: AgentProxyBindingSaveInput): Promise<AgentProxyBinding> }
  runs: {
    start(input: AgentRunStartInput): Promise<AgentRunRecord>
    list(input?: AgentRunListInput): Promise<AgentRunRecord[]>
    get(runId: string): Promise<AgentRunRecord>
    eventsPage(input: AgentRunEventsInput): Promise<AgentEventRecord[]>
    cancel(runId: string): Promise<void>
    retry(runId: string): Promise<AgentRunRecord>
  }
  approvals: {
    list(runId?: string): Promise<AgentApproval[]>
    decide(input: AgentApprovalDecisionInput): Promise<AgentApproval>
  }
  automation: {
    rules(): Promise<AutomationRule[]>
    save(input: AutomationRuleSaveInput): Promise<AutomationRule>
    archive(id: string, expectedRevision: number): Promise<void>
    runNow(id: string): Promise<AgentRunRecord>
    runs(limit?: number): Promise<AgentRunRecord[]>
  }
  inbox: {
    list(unreadOnly?: boolean): Promise<AgentInboxItem[]>
    markRead(id: string): Promise<void>
    archive(id: string): Promise<void>
  }
}
