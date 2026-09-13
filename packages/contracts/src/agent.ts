import { z } from 'zod'
import { AgentLookbackDaysSchema, AgentOutputFolderSchema, AgentResponseLanguageSchema, AgentSourceListSchema, AgentWorkflowKeySchema, ArchiveBulkInputSchema, ArtifactKindSchema, DEFAULT_DAILY_PUSH_SCHEDULE_INPUT } from './research.js'
import type { AgentScheduleSkillCatalogEntry, ArchiveBulkInput, ArchiveBulkReceipt, ArchiveBulkResult } from './research.js'
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

/**
 * Runtime credentials are owned by Electron Main's `safeStorage` vault.
 *
 * The workbench never reads, copies or reuses the login state a user may have
 * created for `~/.codex` or `~/.pi`: every CLI child process runs against an
 * app-owned profile directory and receives exactly one provider credential,
 * injected for the lifetime of that single process. A provider that is not in
 * this catalog is rejected instead of being guessed into an environment
 * variable name.
 */
export const AgentCredentialProviderSchema = z.enum([
  'openai',
  'anthropic',
  'gemini',
  'xai',
  'openrouter',
  'deepseek',
  'groq',
  'mistral',
  'moonshot'
])
export type AgentCredentialProvider = z.infer<typeof AgentCredentialProviderSchema>

/** Provider → documented CLI environment variable. Codex only accepts an
 * OpenAI credential; Pi documents one variable per provider. */
const credentialProviders: Record<AgentRuntimeKind, ReadonlyArray<{ readonly provider: AgentCredentialProvider; readonly envVar: string; readonly label: string }>> = {
  codex: [{ provider: 'openai', envVar: 'OPENAI_API_KEY', label: 'OpenAI' }],
  pi: [
    { provider: 'openai', envVar: 'OPENAI_API_KEY', label: 'OpenAI' },
    { provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY', label: 'Anthropic Claude' },
    { provider: 'gemini', envVar: 'GEMINI_API_KEY', label: 'Google Gemini' },
    { provider: 'xai', envVar: 'XAI_API_KEY', label: 'xAI Grok' },
    { provider: 'openrouter', envVar: 'OPENROUTER_API_KEY', label: 'OpenRouter' },
    { provider: 'deepseek', envVar: 'DEEPSEEK_API_KEY', label: 'DeepSeek' },
    { provider: 'groq', envVar: 'GROQ_API_KEY', label: 'Groq' },
    { provider: 'mistral', envVar: 'MISTRAL_API_KEY', label: 'Mistral' },
    { provider: 'moonshot', envVar: 'MOONSHOT_API_KEY', label: 'Moonshot' }
  ]
}

export function agentCredentialProviders(runtime: AgentRuntimeKind): ReadonlyArray<{ readonly provider: AgentCredentialProvider; readonly envVar: string; readonly label: string }> {
  return credentialProviders[runtime]
}

/** `null` means "this runtime/provider has no documented variable", so the
 * caller must fail closed rather than invent one. */
export function agentCredentialEnvVar(runtime: AgentRuntimeKind, provider: string): string | null {
  return credentialProviders[runtime].find((entry) => entry.provider === provider)?.envVar ?? null
}

/** Non-secret status. The secret itself never leaves Main. */
export const AgentCredentialStatusSchema = z.strictObject({
  runtime: AgentRuntimeKindSchema,
  provider: AgentCredentialProviderSchema.nullable(),
  credentialPresent: z.boolean(),
  /** Documented environment variable the credential is injected as. */
  envVar: z.string().max(100).nullable(),
  updatedAt: IsoDateSchema.nullable()
})
export type AgentCredentialStatus = z.infer<typeof AgentCredentialStatusSchema>

/** Main-only write. An empty `apiKey` clears the stored credential. */
export const AgentCredentialSaveInputSchema = z.strictObject({
  runtime: AgentRuntimeKindSchema,
  provider: AgentCredentialProviderSchema,
  apiKey: z.string().max(20_000).nullable().default(null)
})
export type AgentCredentialSaveInput = z.infer<typeof AgentCredentialSaveInputSchema>

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
  /** `app-isolated` means every probe and run used the workbench-owned profile
   * directory. The renderer can therefore never show a user's personal
   * `~/.pi`/`~/.codex` login as an app capability. */
  profileSource: z.enum(['app-isolated', 'unspecified']).optional(),
  /** Redaction-safe profile directory label. */
  profileLabel: z.string().max(500).nullable().optional(),
  /** `app-safeStorage` when an app-owned runtime credential is configured. */
  authSource: z.enum(['app-safeStorage', 'cli-login', 'none']).optional(),
  /** Interactive approval channel of this transport. Both supported CLIs run
   * non-interactively, so a policy of `on-request` cannot prompt. */
  approvalChannel: z.enum(['none', 'interactive']).optional(),
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

/** Immutable, redaction-safe description of the skill a run resolved. It is
 * stored on the run so a retry reproduces the original selection instead of
 * re-resolving whatever happens to be installed later. */
export const AgentSkillSnapshotSchema = z.strictObject({
  key: z.string().max(100),
  source: z.enum(['env', 'project', 'packaged']),
  version: z.string().max(100).nullable().default(null),
  commit: z.string().max(100).nullable().default(null),
  /** Redaction-safe label (`%REPO%/…/SKILL.md`), never an absolute path. */
  skillPath: z.string().max(500),
  enginePath: z.string().max(500).nullable().default(null),
  pythonVersion: z.string().max(50).nullable().default(null)
})
export type AgentSkillSnapshot = z.infer<typeof AgentSkillSnapshotSchema>

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
  /** Skill selected for this run. `null` means the workflow prompt only. */
  skillKey: z.string().max(100).nullable().default(null),
  /** Frozen skill identity resolved when the run started; a retry reuses it. */
  skillSnapshot: AgentSkillSnapshotSchema.nullable().default(null),
  /** Where the run's runtime credential came from. `none` is a real, visible
   * state: the run was started without an app-owned credential. */
  credentialSource: z.enum(['app-safeStorage', 'none']).default('none'),
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
  /** Optional project-pinned skill. Null means use the workflow prompt only. */
  skillKey: z.string().trim().max(100).nullable().default(null),
  projectId: ProjectIdSchema.nullable().default(null),
  paperIds: z.array(IdSchema).max(500).default([]),
  instructions: z.string().trim().min(1).max(100_000),
  toolProfile: AgentToolProfileSchema.default('read-only'),
  permissionMode: AgentPermissionModeSchema.default('read-only'),
  approvalPolicy: AgentApprovalPolicySchema.default('on-request'),
  idempotencyKey: z.string().trim().max(512).nullable().default(null),
  /** Set by `retry`: the run whose *stored* skill selection and snapshot this
   * run resumes from. The pinning data therefore always comes from the
   * persisted ledger, never from a client-supplied snapshot. */
  resumeFromRunId: IdSchema.nullable().default(null)
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

/** One conversation delete lock for the bulk delete command.
 *
 * The history rail exposes “删除” while the write itself stays a soft archive:
 * the conversation row keeps its runs, events and messages, and only leaves the
 * default list projection. Delete reuses the shared archive lock/receipt
 * vocabulary (`ArchiveBulkInput` / `ArchiveBulkResult`) so the conversation
 * list reports the same succeeded/skipped/conflict/failed outcomes as every
 * other list instead of a second, weaker receipt shape. */
export const AgentConversationRemoveInputSchema = z.strictObject({
  conversationId: IdSchema,
  expectedRevision: z.int().nonnegative()
})
export type AgentConversationRemoveInput = z.infer<typeof AgentConversationRemoveInputSchema>

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

/** The normalized run ledger.
 *
 * A run ledger entry is the provider-neutral, auditable projection of one
 * Codex/Pi CLI event (or one of its lifecycle mutations). The renderer's chat
 * view and trajectory view are both pure projections of this ledger, so the
 * mapping from raw CLI JSON to a record happens exactly once, inside
 * `@prw/agent-runtime`, instead of being guessed in the renderer. */
export const AgentRecordKindSchema = z.enum([
  'user', 'assistant', 'reasoning', 'tool', 'subtool', 'system', 'context',
  'diagnostic', 'compacted', 'error', 'turn_end'
])
export type AgentRecordKind = z.infer<typeof AgentRecordKindSchema>

export const AgentRecordStatusSchema = z.enum(['info', 'running', 'completed', 'failed', 'canceled'])
export type AgentRecordStatus = z.infer<typeof AgentRecordStatusSchema>

/** Token accounting as reported by the CLI. Every field stays nullable because
 * Codex and Pi report different subsets, and this value is never synthesized. */
export const AgentUsageSchema = z.strictObject({
  input: z.int().nonnegative().nullable().default(null),
  output: z.int().nonnegative().nullable().default(null),
  think: z.int().nonnegative().nullable().default(null),
  cacheRead: z.int().nonnegative().nullable().default(null),
  cacheWrite: z.int().nonnegative().nullable().default(null),
  total: z.int().nonnegative().nullable().default(null)
})
export type AgentUsage = z.infer<typeof AgentUsageSchema>

/** `parentId` references the parent record's `recordKey` (not its row id), so a
 * chain of subtool records stays stable across the streamed in-place updates. */
export const AgentRunRecordEntrySchema = z.strictObject({
  id: IdSchema,
  runId: IdSchema,
  seq: z.int().nonnegative(),
  recordKey: z.string().min(1).max(512),
  kind: AgentRecordKindSchema,
  status: AgentRecordStatusSchema,
  turn: z.int().nonnegative(),
  step: z.int().nonnegative(),
  title: z.string().max(500),
  detail: z.string().max(65_536),
  inputText: z.string().max(65_536).nullable(),
  outputText: z.string().max(65_536).nullable(),
  toolName: z.string().max(200).nullable(),
  callId: z.string().max(200).nullable(),
  parentId: z.string().max(512).nullable(),
  startedAt: IsoDateSchema.nullable(),
  finishedAt: IsoDateSchema.nullable(),
  durationMs: z.int().nonnegative().nullable(),
  usage: AgentUsageSchema.nullable(),
  truncated: z.boolean(),
  createdAt: IsoDateSchema
})
export type AgentRunRecordEntry = z.infer<typeof AgentRunRecordEntrySchema>

/** Internal (non-wire) shape an adapter hands to Core for one ledger record.
 * Persistence owns `id`/`runId`/`seq`/`createdAt`, and every optional field means
 * "unspecified": an in-place update keeps the previously stored value instead of
 * clearing it, which is what lets a streamed record grow without losing fields. */
export interface AgentRunRecordDraft {
  /** Adapter-owned stable identity: the ledger upserts by this key, so streamed
   * content grows one record in place instead of appending a row per delta. */
  readonly recordKey: string
  readonly kind: AgentRecordKind
  readonly status?: AgentRecordStatus | undefined
  /** Ledger-owned hierarchy. Omitted means "unspecified": an update keeps the
   * stored value and an insert falls back to `0`. */
  readonly turn?: number | undefined
  readonly step?: number | undefined
  readonly title?: string | undefined
  readonly detail?: string | undefined
  readonly inputText?: string | null | undefined
  readonly outputText?: string | null | undefined
  readonly toolName?: string | null | undefined
  readonly callId?: string | null | undefined
  readonly parentId?: string | null | undefined
  readonly startedAt?: string | null | undefined
  readonly finishedAt?: string | null | undefined
  readonly durationMs?: number | null | undefined
  readonly usage?: AgentUsage | null | undefined
}

/** Trajectory paging. `beforeSeq` walks older rows, `afterSeq` tops up a live
 * run, and omitting both returns the newest `limit` rows. Row `seq` is stable
 * after insert, which is what makes it usable as the trajectory anchor. */
export const AgentRunRecordsPageInputSchema = z.strictObject({
  runId: IdSchema,
  beforeSeq: z.int().nonnegative().nullable().default(null),
  afterSeq: z.int().nonnegative().nullable().default(null),
  limit: z.int().min(1).max(500).default(200)
})
export type AgentRunRecordsPageInput = z.infer<typeof AgentRunRecordsPageInputSchema>

/** Chat projection input. The window is taken from the tail; "load earlier"
 * widens `limit` instead of using a cursor so an insert during streaming can
 * never shift a page boundary. */
export const AgentConversationRecordsInputSchema = z.strictObject({
  conversationId: IdSchema,
  limit: z.int().min(1).max(2_000).default(500)
})
export type AgentConversationRecordsInput = z.infer<typeof AgentConversationRecordsInputSchema>

/** Incremental ledger push (Core -> Main -> renderer). This is the only new
 * send direction in the Agent stack; it is validated with this schema at every
 * hop and is scoped to the runs a renderer explicitly subscribed to. */
export const AgentLedgerPushSchema = z.strictObject({
  runId: IdSchema,
  run: AgentRunRecordSchema,
  records: z.array(AgentRunRecordEntrySchema).max(500)
})
export type AgentLedgerPush = z.infer<typeof AgentLedgerPushSchema>

export const AgentLedgerSubscriptionInputSchema = z.strictObject({
  runId: IdSchema,
  action: z.enum(['subscribe', 'unsubscribe']).default('subscribe')
})
export type AgentLedgerSubscriptionInput = z.infer<typeof AgentLedgerSubscriptionInputSchema>

export const AgentApprovalSchema = z.strictObject({
  id: IdSchema,
  runId: IdSchema,
  operation: z.string().min(1).max(200),
  summary: z.string().max(2_000),
  /** `auto-approved`/`denied` are not user decisions: they record what the
   * non-interactive CLI transport actually did with the requested permission
   * mode, so the ledger never shows an empty approval list as "nothing to
   * approve" when a run silently escalated. */
  status: z.enum(['pending', 'auto-approved', 'denied', 'approved', 'rejected', 'expired']),
  /** Policy that produced this row. */
  policy: AgentApprovalPolicySchema.default('on-request'),
  /** Machine-readable reason (`cli-non-interactive`, `security-gate`, ...). */
  reason: z.string().max(200).nullable().default(null),
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
  sources: AgentSourceListSchema.default([]),
  lookbackDays: AgentLookbackDaysSchema.default(30),
  /** Narrative language of the delivered push; see
   *`AgentResponseLanguageSchema`. */
  responseLanguage: AgentResponseLanguageSchema.default('zh-CN'),
  outputFolder: z.string().trim().max(180).default(DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.outputFolder),
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
  sources: AgentSourceListSchema.default([]),
  lookbackDays: AgentLookbackDaysSchema.default(30),
  responseLanguage: AgentResponseLanguageSchema.default('zh-CN'),
  /** Write path is schema-checked: an absolute/traversing/reserved output
   * folder never reaches the coordinator. The read-side `AutomationRuleSchema`
   * stays tolerant so a legacy row cannot make the task list unreadable. */
  outputFolder: AgentOutputFolderSchema.default(DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.outputFolder),
  permissionMode: AgentPermissionModeSchema.default('read-only'),
  approvalPolicy: AgentApprovalPolicySchema.default('on-request'),
  projectId: ProjectIdSchema.nullable().default(null),
  cron: z.string().trim().min(1).max(200),
  timezone: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  expectedRevision: z.int().nonnegative().nullable().default(null)
})
export type AutomationRuleSaveInput = z.infer<typeof AutomationRuleSaveInputSchema>

/**
 * One claimed cron occurrence of a schedule.
 *
 * The row is the durable "run lock" for a time slot: it is written in the same
 * transaction that advances the schedule cursor, so a crash, a shutdown or a
 * policy refusal can never leave "the cursor moved but nothing ever ran"
 * without a visible record. `idempotencyKey` is the same key the run itself is
 * started with, so a duplicate tick, a duplicate “Run now” and the once-per-`
 * start catch-up all collapse onto one row.
 */
export const ScheduleOccurrenceSourceSchema = z.enum(['scheduler', 'catchup', 'manual'])
export type ScheduleOccurrenceSource = z.infer<typeof ScheduleOccurrenceSourceSchema>

export const ScheduleOccurrenceStatusSchema = z.enum([
  'claimed',
  'running',
  'completed',
  'failed',
  'blocked',
  'canceled',
  'missed',
  'skipped'
])
export type ScheduleOccurrenceStatus = z.infer<typeof ScheduleOccurrenceStatusSchema>

export const ScheduleOccurrenceSchema = z.strictObject({
  id: IdSchema,
  scheduleId: IdSchema,
  occurrenceAt: IsoDateSchema,
  /** Local day the occurrence belongs to, in the rule's own timezone. */
  localDateKey: z.string().min(1).max(20),
  idempotencyKey: z.string().min(1).max(512),
  source: ScheduleOccurrenceSourceSchema,
  status: ScheduleOccurrenceStatusSchema,
  runId: IdSchema.nullable(),
  /** Concrete reason for a non-successful occurrence (policy gate, missing
   * credential, interrupted app, capability block). Never a stack trace. */
  reason: z.string().max(1_000).default(''),
  claimedAt: IsoDateSchema,
  settledAt: IsoDateSchema.nullable(),
  revision: z.int().nonnegative()
})
export type ScheduleOccurrence = z.infer<typeof ScheduleOccurrenceSchema>

/**
 * Automation page projection of one scheduled run: the run's terminal status,
 * the occurrence it consumed (including the reason a slot produced nothing) and
 * the delivered artifact / Obsidian outcome.
 *
 * `output` is deliberately not part of this view: the run detail page owns the
 * full body, while the schedule card only needs a bounded reason.
 */
export const AutomationRunHistoryEntrySchema = z.strictObject({
  runId: IdSchema,
  /** CAS token for the RUN HISTORY delete commands, exactly like every other
   * archivable row: a record that changed after it was selected (a run that just
   * finished) reports a revision conflict instead of being removed blindly. */
  revision: z.int().nonnegative(),
  scheduleId: IdSchema,
  status: AgentRunStatusSchema,
  startedAt: IsoDateSchema,
  finishedAt: IsoDateSchema.nullable(),
  occurrenceAt: IsoDateSchema.nullable(),
  occurrenceStatus: ScheduleOccurrenceStatusSchema.nullable(),
  occurrenceSource: ScheduleOccurrenceSourceSchema.nullable(),
  /** Why this slot did not produce a usable push (occurrence reason or run error). */
  blockedReason: z.string().max(1_000).nullable(),
  artifact: z.strictObject({ id: IdSchema, title: z.string().max(500) }).nullable(),
  delivery: z.strictObject({
    status: z.enum(['written', 'skipped']),
    relativePath: z.string().max(500).nullable(),
    reason: z.string().max(100).nullable(),
    message: z.string().max(500).nullable()
  }).nullable()
})
export type AutomationRunHistoryEntry = z.infer<typeof AutomationRunHistoryEntrySchema>

export const AutomationRunHistoryInputSchema = z.strictObject({
  /** `undefined` returns the newest runs of every rule. */
  scheduleId: IdSchema.optional(),
  limit: z.int().min(1).max(20).default(5)
})
export type AutomationRunHistoryInput = z.infer<typeof AutomationRunHistoryInputSchema>

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
  // CONVERSATION delete: the same CAS-locked soft archive as `archive`, but
  // every record reports its own outcome instead of throwing a single error
  // for the whole command.
  'agent.conversations.remove': AgentConversationRemoveInputSchema,
  'agent.conversations.removeBulk': ArchiveBulkInputSchema,
  'agent.connectors.list': z.null(),
  'agent.connectors.test': z.strictObject({ runtime: AgentRuntimeKindSchema }),
  'agent.connectors.save': AgentConnectorSaveInputSchema,
  'agent.bindings.list': z.null(),
  'agent.credentials.status': z.null(),
  'agent.credentials.save': AgentCredentialSaveInputSchema,
  'agent.bindings.save': AgentBindingSaveInputSchema,
  'agent.proxyProfiles.list': z.null(),
  'agent.proxyProfiles.save': AgentProxyProfileSaveInputSchema,
  'agent.proxyBindings.list': z.null(),
  'agent.proxyBindings.save': AgentProxyBindingSaveInputSchema,
  'agent.runs.start': AgentRunStartInputSchema,
  'agent.runs.list': AgentRunListInputSchema,
  'agent.runs.get': z.strictObject({ runId: IdSchema }),
  'agent.runs.eventsPage': AgentRunEventsInputSchema,
  'agent.runs.recordsPage': AgentRunRecordsPageInputSchema,
  'agent.conversations.records': AgentConversationRecordsInputSchema,
  'agent.runs.cancel': z.strictObject({ runId: IdSchema }),
  'agent.runs.retry': z.strictObject({ runId: IdSchema }),
  'agent.approvals.list': z.strictObject({ runId: IdSchema.optional() }),
  'agent.approvals.decide': AgentApprovalDecisionInputSchema,
  'automation.rules.list': z.null(),
  'automation.skills.list': z.null(),
  'automation.rules.save': AutomationRuleSaveInputSchema,
  'automation.rules.archive': z.strictObject({ id: IdSchema, expectedRevision: z.int().nonnegative() }),
  /** Archive several rules in one transaction. Archiving a rule stops it from
   * running but deliberately keeps its run/occurrence history and delivered
   * artifacts: the receipts below describe rules, never history rows. */
  'automation.rules.bulkArchive': ArchiveBulkInputSchema,
  'automation.rules.runNow': z.strictObject({ id: IdSchema }),
  'automation.runs.list': z.strictObject({ limit: z.int().min(1).max(100).default(50) }),
  'automation.runs.history': AutomationRunHistoryInputSchema,
  // RUN HISTORY record removal: a CAS lock per record, soft archive only.
  'automation.runs.archive': z.strictObject({ runId: IdSchema, expectedRevision: z.int().nonnegative() }),
  'automation.runs.archiveBulk': ArchiveBulkInputSchema,
  'automation.runs.retry': z.strictObject({ runId: IdSchema }),
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

/**
 * Private Main→Core envelope for Agent RPCs that need a credential.
 *
 * Electron Main owns the `safeStorage` vault, so it resolves the credential for
 * the runtime the request targets and attaches it for exactly one dispatch.
 * The renderer never sees this envelope, Core never stores it, and the secret
 * is dropped as soon as the child process has started. An empty `credentials`
 * list is a valid, meaningful request: Core then fails closed instead of
 * reaching for the user's personal CLI login.
 */
export const AgentCredentialEnvelopeSchema = z.strictObject({
  type: z.literal('prw.agent-rpc-with-credential'),
  request: AgentRpcRequestSchema,
  credentials: z.array(z.strictObject({
    runtime: AgentRuntimeKindSchema,
    provider: AgentCredentialProviderSchema,
    secret: z.string().min(1).max(20_000)
  })).max(4).default([])
})
export type AgentCredentialEnvelope = z.infer<typeof AgentCredentialEnvelopeSchema>

export interface WorkbenchAgentApiV1 {
  conversations: {
    list(input?: AgentConversationListInput): Promise<AgentConversation[]>
    create(input?: AgentConversationCreateInput): Promise<AgentConversation>
    get(conversationId: string): Promise<AgentConversation>
    messages(input: AgentConversationMessagesInput): Promise<AgentMessage[]>
    /** Tail window of the conversation's run-ledger records (chat projection). */
    records(input: AgentConversationRecordsInput): Promise<AgentRunRecordEntry[]>
    archive(conversationId: string, expectedRevision: number): Promise<void>
    archiveBulk(items: AgentConversationArchiveItem[]): Promise<void>
    /** Delete one conversation record. Delete is a revision-checked soft archive
     * (the row, its runs, events and messages stay readable) that reports its
     * own outcome instead of a shared all-or-nothing error. */
    remove(conversationId: string, expectedRevision: number): Promise<ArchiveBulkReceipt>
    /** Delete a selected conversation set with one per-record receipt each. A
     * stale lock is a `conflict`, an already-removed conversation is `skipped`,
     * so a bulk delete can never report a row it did not actually remove. */
    removeBulk(items: ReadonlyArray<{ id: string; expectedRevision: number }>): Promise<ArchiveBulkResult>
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
  /** Runtime credentials live in Main's safeStorage vault; the renderer only
   * ever sees the non-secret status. */
  credentials: {
    status(): Promise<AgentCredentialStatus[]>
    save(input: AgentCredentialSaveInput): Promise<AgentCredentialStatus[]>
  }
  proxyProfiles: { list(): Promise<AgentProxyProfile[]>; save(input: AgentProxyProfileSaveInput): Promise<AgentProxyProfile> }
  proxyBindings: { list(): Promise<AgentProxyBinding[]>; save(input: AgentProxyBindingSaveInput): Promise<AgentProxyBinding> }
  runs: {
    start(input: AgentRunStartInput): Promise<AgentRunRecord>
    list(input?: AgentRunListInput): Promise<AgentRunRecord[]>
    get(runId: string): Promise<AgentRunRecord>
    eventsPage(input: AgentRunEventsInput): Promise<AgentEventRecord[]>
    /** Normalized run ledger; the trajectory view's only data source. */
    recordsPage(input: AgentRunRecordsPageInput): Promise<AgentRunRecordEntry[]>
    /** Live ledger deltas. Returns an unsubscribe function; the legacy polling
     * path stays available as a fallback when this channel is unavailable. */
    subscribe(runId: string, handler: (push: AgentLedgerPush) => void): () => void
    cancel(runId: string): Promise<void>
    retry(runId: string): Promise<AgentRunRecord>
  }
  approvals: {
    list(runId?: string): Promise<AgentApproval[]>
    decide(input: AgentApprovalDecisionInput): Promise<AgentApproval>
  }
  automation: {
    rules(): Promise<AutomationRule[]>
    /** Selectable skills with their real installed state. A reserved key or a
     * missing `SKILL.md` is reported as not runnable with the blocked reason;
     * the editor shows it as not installed instead of as a usable option. */
    skills(): Promise<AgentScheduleSkillCatalogEntry[]>
    save(input: AutomationRuleSaveInput): Promise<AutomationRule>
    archive(id: string, expectedRevision: number): Promise<void>
    /** Archive the selected rules in one transaction with per-rule receipts;
     * run history, occurrences and delivered artifacts are left intact. */
    bulkArchive(input: ArchiveBulkInput): Promise<ArchiveBulkResult>
    runNow(id: string): Promise<AgentRunRecord>
    runs(limit?: number): Promise<AgentRunRecord[]>
    /** Recent runs of one rule (or of every rule) with the consumed occurrence,
     * the blocked/skipped reason, the artifact and the Obsidian delivery state. */
    history(input?: AutomationRunHistoryInput): Promise<AutomationRunHistoryEntry[]>
    /** Soft-archive one RUN HISTORY record with a CAS revision lock: the audit
     * row stays in the local database, the rule/occurrence cursor, the Artifact,
     * Obsidian output and every credential are untouched. */
    archiveRun(runId: string, expectedRevision: number): Promise<void>
    /** Archive the selected RUN HISTORY records in one transaction with per-run
     * receipts; stale locks report a conflict and are never written. */
    bulkArchiveRuns(input: ArchiveBulkInput): Promise<ArchiveBulkResult>
    /** Safe retry entry: re-runs the owning *schedule*, so the recorded
     * permission/approval policy, the skill selection and the occurrence lock
     * all still apply. It never replays a run with elevated permissions. */
    retryRun(runId: string): Promise<AgentRunRecord>
  }
  inbox: {
    list(unreadOnly?: boolean): Promise<AgentInboxItem[]>
    markRead(id: string): Promise<void>
    archive(id: string): Promise<void>
  }
}
