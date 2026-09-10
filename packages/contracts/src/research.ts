import { z } from 'zod'
import {
  BulkSelectionSchema,
  IntegrationErrorSchema,
  ExternalWriteErrorSchema,
  IdSchema,
  IsoInstantSchema,
  PaperIdSchema,
  ProjectIdSchema,
  SearchResultSchema,
  SelectionKeySchema,
  ZoteroDuplicateDecisionSchema,
  ZoteroImportFormatSchema,
  ZoteroItemKeySchema,
  IanaTimezoneSchema,
  ResourceKindSchema
} from './v2.js'

const IsoDateSchema = IsoInstantSchema
const NullableIsoDateSchema = IsoDateSchema.nullable()

export const PaperReadStatusSchema = z.enum(['inbox', 'queued', 'reading', 'read', 'archived'])
export type PaperReadStatus = z.infer<typeof PaperReadStatusSchema>

export const PaperSchema = z.object({
  id: PaperIdSchema,
  projectId: ProjectIdSchema.nullable(),
  title: z.string().min(1),
  authors: z.array(z.string()),
  year: z.int().min(0).nullable(),
  venue: z.string(),
  abstract: z.string(),
  doi: z.string().nullable(),
  url: z.string().nullable(),
  citationKey: z.string().nullable(),
  tags: z.array(z.string()),
  collections: z.array(z.string()),
  status: PaperReadStatusSchema,
  rating: z.int().min(0).max(5),
  localPdfPath: z.string().nullable(),
  source: z.enum(['manual', 'zotero', 'notion', 'obsidian', 'import']),
  archivedAt: IsoDateSchema.nullable(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  revision: z.int().nonnegative()
})
export type Paper = z.infer<typeof PaperSchema>

export const CreatePaperInputSchema = z.object({
  projectId: ProjectIdSchema.nullable().default(null),
  title: z.string().trim().min(1).max(500),
  authors: z.array(z.string().trim().min(1)).default([]),
  year: z.int().min(0).max(9999).nullable().default(null),
  venue: z.string().trim().max(500).default(''),
  abstract: z.string().max(100_000).default(''),
  doi: z.string().trim().max(500).nullable().default(null),
  url: z.string().trim().max(4_000).nullable().default(null),
  citationKey: z.string().trim().max(200).nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(100)).default([]),
  collections: z.array(z.string().trim().min(1).max(240)).default([]),
  status: PaperReadStatusSchema.default('inbox'),
  rating: z.int().min(0).max(5).default(0),
  localPdfPath: z.string().max(4_000).nullable().default(null),
  source: z.enum(['manual', 'zotero', 'notion', 'obsidian', 'import']).default('manual')
})
export type CreatePaperInput = z.infer<typeof CreatePaperInputSchema>

export const UpdatePaperInputSchema = CreatePaperInputSchema.partial().extend({
  id: PaperIdSchema,
  expectedRevision: z.int().nonnegative()
})
export type UpdatePaperInput = z.infer<typeof UpdatePaperInputSchema>

export const PaperListFilterSchema = z.object({
  projectId: ProjectIdSchema.nullable().optional(),
  status: PaperReadStatusSchema.optional(),
  tag: z.string().min(1).optional(),
  query: z.string().trim().max(500).default(''),
  includeArchived: z.boolean().default(false)
})
export type PaperListFilter = z.infer<typeof PaperListFilterSchema>

export const PaperImportConflictPolicySchema = z.enum(['skip', 'review'])
export type PaperImportConflictPolicy = z.infer<typeof PaperImportConflictPolicySchema>
export const PaperImportDecisionSchema = z.enum(['created', 'existing', 'updated-candidate', 'skipped', 'conflict'])
export type PaperImportDecision = z.infer<typeof PaperImportDecisionSchema>
export const PaperImportFromZoteroInputSchema = z.strictObject({
  profileId: IdSchema,
  itemKey: ZoteroItemKeySchema,
  projectId: ProjectIdSchema.nullable(),
  conflictPolicy: PaperImportConflictPolicySchema.default('review')
})
export type PaperImportFromZoteroInput = z.infer<typeof PaperImportFromZoteroInputSchema>
/** Receipt for Zotero/search-result -> local Paper import. `paper` is null
 * when an item was skipped or could not be imported. */
export const PaperImportReceiptSchema = z.strictObject({
  status: PaperImportDecisionSchema,
  decision: PaperImportDecisionSchema.optional(),
  paper: PaperSchema.nullable().default(null),
  source: z.string().trim().min(1).optional(),
  sourceId: z.string().trim().min(1).optional(),
  profileId: IdSchema.optional(),
  itemKey: ZoteroItemKeySchema.optional(),
  locator: z.string().trim().min(1).max(4_000).nullable().optional(),
  remoteRevision: z.string().trim().min(1).max(512).nullable().optional(),
  duplicate: z.object({
    kind: z.enum(['doi', 'title', 'external-id']),
    existingPaperId: PaperIdSchema,
    decision: PaperImportDecisionSchema
  }).nullable().optional()
})
export type PaperImportReceipt = z.infer<typeof PaperImportReceiptSchema>
export const PaperImportResultSchema = PaperImportReceiptSchema
export type PaperImportResult = PaperImportReceipt

export const LiteratureBatchActionSchema = z.enum([
  'add_project', 'add_matrix', 'mark_reading', 'create_tasks', 'export', 'import_zotero'
])
export type LiteratureBatchAction = z.infer<typeof LiteratureBatchActionSchema>
/** Literature selection is the shared, query-fingerprint guarded selection;
 * it survives pagination and is independent of rendered rows. */
export const LiteratureBatchSelectionSchema = BulkSelectionSchema
export type LiteratureBatchSelection = z.infer<typeof LiteratureBatchSelectionSchema>
export const LiteratureBatchTargetSchema = z.strictObject({
  projectId: ProjectIdSchema.nullable().optional(),
  collectionKey: ZoteroItemKeySchema.nullable().optional(),
  format: ZoteroImportFormatSchema.optional(),
  handoff: z.enum(['save-file', 'mailto-draft', 'external-bridge']).optional()
})
export type LiteratureBatchTarget = z.infer<typeof LiteratureBatchTargetSchema>
export const LiteratureBatchPreviewInputSchema = z.strictObject({
  selection: LiteratureBatchSelectionSchema,
  action: LiteratureBatchActionSchema,
  target: LiteratureBatchTargetSchema.optional()
})
export type LiteratureBatchPreviewInput = z.infer<typeof LiteratureBatchPreviewInputSchema>
export const LiteratureDuplicateDecisionSchema = z.strictObject({
  key: SelectionKeySchema,
  decision: z.enum(['create', 'skip', 'review', 'update-candidate', 'conflict']),
  existingPaperId: PaperIdSchema.nullable()
})
export type LiteratureDuplicateDecision = z.infer<typeof LiteratureDuplicateDecisionSchema>
export const LiteratureBatchPreviewSchema = z.strictObject({
  previewId: IdSchema,
  total: z.int().nonnegative(),
  unknownPages: z.int().nonnegative().default(0),
  selected: z.array(SearchResultSchema),
  action: LiteratureBatchActionSchema,
  selection: LiteratureBatchSelectionSchema.optional(),
  target: LiteratureBatchTargetSchema.nullable().optional(),
  duplicateDecisions: z.array(LiteratureDuplicateDecisionSchema).default([]),
  requiresConfirmation: z.literal(true)
})
export type LiteratureBatchPreview = z.infer<typeof LiteratureBatchPreviewSchema>
export const BatchPreviewSchema = LiteratureBatchPreviewSchema
export type BatchPreview = LiteratureBatchPreview
export const LiteratureBatchReceiptSchema = z.strictObject({
  key: SelectionKeySchema,
  outcome: z.enum(['succeeded', 'skipped', 'failed']),
  status: z.enum(['created', 'existing', 'updated', 'skipped', 'failed']).optional(),
  paperId: PaperIdSchema.nullable().optional(),
  taskId: IdSchema.nullable().optional(),
  matrixEntryId: IdSchema.nullable().optional(),
  locator: z.string().trim().min(1).max(4_000).nullable().optional(),
  error: z.union([
    IntegrationErrorSchema,
    z.object({
      code: z.string().min(1),
      message: z.string().trim().min(1).max(500).refine((value) => !/([A-Za-z]:[\\/]|\\\\|Bearer\s|token=|api[_-]?key)/i.test(value), {
        message: 'Operation error messages must be redacted.'
      }),
      retryable: z.boolean()
    }),
    ExternalWriteErrorSchema
  ]).nullable(),
  retryable: z.boolean().default(false)
})
export type LiteratureBatchReceipt = z.infer<typeof LiteratureBatchReceiptSchema>
export const LiteratureBatchResultSchema = z.strictObject({
  operationId: IdSchema.nullable().optional(),
  items: z.array(LiteratureBatchReceiptSchema),
  succeeded: z.int().nonnegative(),
  skipped: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  canceled: z.boolean()
}).superRefine((value, context) => {
  const counts = value.items.reduce((result, item) => {
    result[item.outcome] += 1
    return result
  }, { succeeded: 0, skipped: 0, failed: 0 })
  if (counts.succeeded !== value.succeeded) context.addIssue({ code: 'custom', path: ['succeeded'], message: 'Succeeded count must match item outcomes.' })
  if (counts.skipped !== value.skipped) context.addIssue({ code: 'custom', path: ['skipped'], message: 'Skipped count must match item outcomes.' })
  if (counts.failed !== value.failed) context.addIssue({ code: 'custom', path: ['failed'], message: 'Failed count must match item outcomes.' })
})
export type LiteratureBatchResult = z.infer<typeof LiteratureBatchResultSchema>
export const BatchResultSchema = LiteratureBatchResultSchema
export type BatchResult = LiteratureBatchResult
export const LiteratureBatchExecuteInputSchema = z.strictObject({
  previewId: IdSchema,
  confirmed: z.literal(true),
  confirmationToken: z.string().trim().min(1).max(512),
  cancelRequested: z.boolean().default(false)
})
export type LiteratureBatchExecuteInput = z.infer<typeof LiteratureBatchExecuteInputSchema>
export const LiteratureBatchCancelInputSchema = z.strictObject({
  operationId: IdSchema.optional(),
  previewId: IdSchema.optional()
}).superRefine((value, context) => {
  if (value.operationId === undefined && value.previewId === undefined) {
    context.addIssue({ code: 'custom', message: 'Cancellation requires an operationId or previewId.' })
  }
})
export type LiteratureBatchCancelInput = z.infer<typeof LiteratureBatchCancelInputSchema>
export const LiteratureBatchCancelReceiptSchema = z.strictObject({
  operationId: IdSchema,
  canceled: z.literal(true),
  canceledAt: IsoDateSchema
})
export type LiteratureBatchCancelReceipt = z.infer<typeof LiteratureBatchCancelReceiptSchema>
export const LiteratureBatchRetryInputSchema = z.strictObject({
  operationId: IdSchema.optional(),
  previewId: IdSchema.optional(),
  failedKeys: z.array(SelectionKeySchema).default([]),
  confirmed: z.literal(true),
  confirmationToken: z.string().trim().min(1).max(512)
}).superRefine((value, context) => {
  if (value.operationId === undefined && value.previewId === undefined) {
    context.addIssue({ code: 'custom', message: 'Retry requires an operationId or previewId.' })
  }
})
export type LiteratureBatchRetryInput = z.infer<typeof LiteratureBatchRetryInputSchema>
export const LiteratureBatchImportResultInputSchema = z.strictObject({
  sessionId: IdSchema,
  resultKey: IdSchema,
  projectId: ProjectIdSchema.nullable()
})
export type LiteratureBatchImportResultInput = z.infer<typeof LiteratureBatchImportResultInputSchema>

export const LiteratureMatrixEntrySchema = z.object({
  id: IdSchema,
  paperId: PaperIdSchema,
  researchQuestion: z.string(),
  method: z.string(),
  data: z.string(),
  keyFindings: z.string(),
  limitations: z.string(),
  evidence: z.string(),
  relevance: z.string(),
  qualityScore: z.int().min(0).max(100),
  customFields: z.record(z.string(), z.string()),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  revision: z.int().nonnegative()
})
export type LiteratureMatrixEntry = z.infer<typeof LiteratureMatrixEntrySchema>

export const UpsertLiteratureMatrixInputSchema = z.object({
  paperId: PaperIdSchema,
  researchQuestion: z.string().max(20_000).default(''),
  method: z.string().max(20_000).default(''),
  data: z.string().max(20_000).default(''),
  keyFindings: z.string().max(40_000).default(''),
  limitations: z.string().max(20_000).default(''),
  evidence: z.string().max(40_000).default(''),
  relevance: z.string().max(20_000).default(''),
  qualityScore: z.int().min(0).max(100).default(0),
  customFields: z.record(z.string(), z.string()).default({}),
  expectedRevision: z.int().nonnegative().nullable().default(null)
})
export type UpsertLiteratureMatrixInput = z.infer<typeof UpsertLiteratureMatrixInputSchema>

/** A matrix row is a local, structured projection rather than an archiveable
 * document.  Removing one therefore requires the same optimistic-concurrency
 * lock used by every other destructive local command. */
export const RemoveLiteratureMatrixInputSchema = z.strictObject({
  id: IdSchema,
  expectedRevision: z.int().nonnegative()
})
export type RemoveLiteratureMatrixInput = z.infer<typeof RemoveLiteratureMatrixInputSchema>

export const LiteratureMatrixBulkDeleteInputSchema = z.strictObject({
  items: z.array(RemoveLiteratureMatrixInputSchema).min(1)
}).superRefine((value, context) => {
  const ids = value.items.map((item) => item.id)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['items'], message: 'Matrix revision locks must be unique.' })
  }
})
export type LiteratureMatrixBulkDeleteInput = z.infer<typeof LiteratureMatrixBulkDeleteInputSchema>

export const LiteratureMatrixBulkDeleteItemSchema = z.strictObject({
  id: IdSchema,
  outcome: z.enum(['succeeded', 'skipped', 'failed']),
  error: z.object({
    code: z.string().min(1),
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean()
  }).nullable()
})
export type LiteratureMatrixBulkDeleteItem = z.infer<typeof LiteratureMatrixBulkDeleteItemSchema>

export const LiteratureMatrixBulkDeleteResultSchema = z.strictObject({
  items: z.array(LiteratureMatrixBulkDeleteItemSchema),
  succeeded: z.int().nonnegative(),
  skipped: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  canceled: z.boolean()
}).superRefine((value, context) => {
  const counts = value.items.reduce((result, item) => {
    result[item.outcome] += 1
    return result
  }, { succeeded: 0, skipped: 0, failed: 0 })
  if (counts.succeeded !== value.succeeded) context.addIssue({ code: 'custom', path: ['succeeded'], message: 'Succeeded count must match item outcomes.' })
  if (counts.skipped !== value.skipped) context.addIssue({ code: 'custom', path: ['skipped'], message: 'Skipped count must match item outcomes.' })
  if (counts.failed !== value.failed) context.addIssue({ code: 'custom', path: ['failed'], message: 'Failed count must match item outcomes.' })
})
export type LiteratureMatrixBulkDeleteResult = z.infer<typeof LiteratureMatrixBulkDeleteResultSchema>

export const ArtifactKindSchema = z.enum([
  'daily_digest',
  'paper_summary',
  'literature_review',
  'research_idea',
  'research_plan',
  'outline',
  'manuscript'
])
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>

export const ResearchArtifactSchema = z.object({
  id: IdSchema,
  projectId: ProjectIdSchema.nullable(),
  kind: ArtifactKindSchema,
  title: z.string().min(1),
  content: z.string(),
  sourcePaperIds: z.array(z.string()),
  citations: z.array(z.object({ label: z.string(), url: z.string().nullable() })),
  status: z.enum(['draft', 'review', 'final', 'archived']),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  revision: z.int().nonnegative()
})
export type ResearchArtifact = z.infer<typeof ResearchArtifactSchema>

export const CreateResearchArtifactInputSchema = z.object({
  projectId: ProjectIdSchema.nullable().default(null),
  kind: ArtifactKindSchema,
  title: z.string().trim().min(1).max(500),
  content: z.string().max(1_000_000).default(''),
  sourcePaperIds: z.array(z.string().min(1)).default([]),
  citations: z.array(z.object({ label: z.string(), url: z.string().nullable() })).default([]),
  status: z.enum(['draft', 'review', 'final', 'archived']).default('draft')
})
export type CreateResearchArtifactInput = z.infer<typeof CreateResearchArtifactInputSchema>

export const UpdateResearchArtifactInputSchema = CreateResearchArtifactInputSchema.partial().extend({
  id: z.string().min(1),
  expectedRevision: z.int().nonnegative()
})
export type UpdateResearchArtifactInput = z.infer<typeof UpdateResearchArtifactInputSchema>

export const IntegrationProviderSchema = z.enum(['obsidian', 'zotero', 'notion'])
export type IntegrationProvider = z.infer<typeof IntegrationProviderSchema>

export const IntegrationProfileSchema = z.object({
  id: z.string().min(1),
  provider: IntegrationProviderSchema,
  name: z.string().min(1),
  enabled: z.boolean(),
  location: z.string(),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  credentialPresent: z.boolean(),
  status: z.enum(['not_configured', 'ready', 'syncing', 'error', 'disabled']),
  lastSyncAt: NullableIsoDateSchema,
  lastError: z.string().nullable(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  revision: z.int().nonnegative()
})
export type IntegrationProfile = z.infer<typeof IntegrationProfileSchema>

export const SaveIntegrationProfileInputSchema = z.object({
  id: z.string().min(1).optional(),
  provider: IntegrationProviderSchema,
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  location: z.string().trim().max(4_000).default(''),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  credential: z.string().max(20_000).optional(),
  expectedRevision: z.int().nonnegative().nullable().default(null)
})
export type SaveIntegrationProfileInput = z.infer<typeof SaveIntegrationProfileInputSchema>

export const ExternalLinkSchema = z.object({
  id: IdSchema,
  profileId: IdSchema,
  entityKind: ResourceKindSchema,
  entityId: IdSchema,
  externalId: z.string().trim().min(1).max(4_000),
  locator: z.string(),
  managedBlockId: z.string().nullable(),
  remoteRevision: z.string().nullable(),
  syncState: z.enum(['synced', 'local_changed', 'remote_changed', 'conflict', 'deleted']),
  lastSyncedAt: NullableIsoDateSchema
})
export type ExternalLink = z.infer<typeof ExternalLinkSchema>

export const SyncRunSchema = z.object({
  id: IdSchema,
  profileId: IdSchema,
  direction: z.enum(['pull', 'push', 'both']),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']),
  pulled: z.int().nonnegative(),
  pushed: z.int().nonnegative(),
  conflicts: z.int().nonnegative(),
  message: z.string(),
  startedAt: IsoDateSchema,
  finishedAt: NullableIsoDateSchema
})
export type SyncRun = z.infer<typeof SyncRunSchema>

export const PromptTemplateSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  systemPrompt: z.string(),
  userTemplate: z.string(),
  version: z.int().positive(),
  builtIn: z.boolean(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  revision: z.int().nonnegative()
})
export type PromptTemplate = z.infer<typeof PromptTemplateSchema>

export const SavePromptTemplateInputSchema = z.object({
  id: z.string().min(1).optional(),
  key: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2_000).default(''),
  systemPrompt: z.string().max(100_000).default(''),
  userTemplate: z.string().min(1).max(100_000),
  expectedRevision: z.int().nonnegative().nullable().default(null)
})
export type SavePromptTemplateInput = z.infer<typeof SavePromptTemplateInputSchema>

export const AgentWorkflowKeySchema = z.enum([
  'daily_digest',
  'paper_summary',
  'literature_matrix',
  'literature_review',
  'research_ideation',
  'research_plan',
  'manuscript_draft'
])
export type AgentWorkflowKey = z.infer<typeof AgentWorkflowKeySchema>

/**
 * A human-facing provider identity. The wire protocol is deliberately stored
 * separately in `api`, following Pi's provider/model design: one gateway can
 * expose more than one compatible API and a custom endpoint is not forced to
 * pretend to be OpenAI or Anthropic.
 */
export const AiProviderIdSchema = z.enum([
  'mock',
  'openai',
  'anthropic',
  'deepseek',
  'xai',
  'gemini',
  'ollama',
  'custom'
])
export type AiProviderId = z.infer<typeof AiProviderIdSchema>

export const AiApiSchema = z.enum([
  'mock',
  'openai-responses',
  'openai-completions',
  'anthropic-messages',
  'google-generative-ai'
])
export type AiApi = z.infer<typeof AiApiSchema>

export const AiProviderProfileSchema = z.object({
  id: z.string().min(1),
  provider: AiProviderIdSchema,
  api: AiApiSchema,
  name: z.string().min(1),
  model: z.string().min(1),
  baseUrl: z.string(),
  enabled: z.boolean(),
  credentialPresent: z.boolean(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  revision: z.int().nonnegative()
})
export type AiProviderProfile = z.infer<typeof AiProviderProfileSchema>

export const SaveAiProviderProfileInputSchema = z.object({
  id: z.string().min(1).optional(),
  provider: AiProviderIdSchema,
  api: AiApiSchema,
  name: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(200),
  baseUrl: z.string().trim().max(2_000).default(''),
  enabled: z.boolean().default(true),
  credential: z.string().max(20_000).optional(),
  expectedRevision: z.int().nonnegative().nullable().default(null)
})
export type SaveAiProviderProfileInput = z.infer<typeof SaveAiProviderProfileInputSchema>

export const AgentRunSchema = z.object({
  id: z.string().min(1),
  workflowKey: AgentWorkflowKeySchema,
  providerProfileId: z.string().nullable(),
  promptTemplateId: z.string().min(1),
  projectId: z.string().nullable(),
  paperIds: z.array(z.string()),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']),
  input: z.record(z.string(), z.string()),
  output: z.string(),
  citations: z.array(z.object({ label: z.string(), url: z.string().nullable() })),
  error: z.string().nullable(),
  createdAt: IsoDateSchema,
  startedAt: NullableIsoDateSchema,
  finishedAt: NullableIsoDateSchema
})
export type AgentRun = z.infer<typeof AgentRunSchema>

export const StartAgentRunInputSchema = z.object({
  workflowKey: AgentWorkflowKeySchema,
  providerProfileId: z.string().min(1).nullable().default(null),
  promptTemplateId: z.string().min(1),
  projectId: z.string().min(1).nullable().default(null),
  paperIds: z.array(z.string().min(1)).default([]),
  variables: z.record(z.string(), z.string()).default({}),
  instructions: z.string().max(100_000).default('')
})
export type StartAgentRunInput = z.infer<typeof StartAgentRunInputSchema>

export const ScheduleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  workflowKey: AgentWorkflowKeySchema,
  promptTemplateId: z.string().min(1),
  providerProfileId: z.string().nullable(),
  runtime: z.enum(['codex', 'pi']).nullable().default(null),
  model: z.string().max(300).nullable().default(null),
  assistantKey: z.string().max(300).nullable().default('researcher'),
  workspacePath: z.string().max(4_000).nullable().default(null),
  frequency: z.enum(['manual', 'hourly', 'daily', 'weekdays', 'weekly', 'custom']).default('custom'),
  executionMode: z.enum(['new_conversation', 'existing']).default('new_conversation'),
  conversationId: z.string().nullable().default(null),
  prompt: z.string().max(100_000).default(''),
  skillKey: z.string().trim().max(100).nullable().default(null),
  topic: z.string().trim().max(500).default(''),
  outputFolder: z.string().trim().max(180).default('每日文献推送'),
  permissionMode: z.enum(['read-only', 'auto', 'full-access']).default('read-only'),
  approvalPolicy: z.enum(['on-request', 'never']).default('on-request'),
  projectId: z.string().nullable(),
  cron: z.string().min(1),
  timezone: IanaTimezoneSchema,
  enabled: z.boolean(),
  missedPolicy: z.literal('coalesce_one'),
  nextRunAt: NullableIsoDateSchema,
  lastRunAt: NullableIsoDateSchema,
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  revision: z.int().nonnegative()
})
export type Schedule = z.infer<typeof ScheduleSchema>

export const SaveScheduleInputSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(200),
  workflowKey: AgentWorkflowKeySchema,
  promptTemplateId: z.string().min(1),
  providerProfileId: z.string().min(1).nullable().default(null),
  runtime: z.enum(['codex', 'pi']).nullable().default(null),
  model: z.string().trim().max(300).nullable().default(null),
  assistantKey: z.string().trim().max(300).nullable().default('researcher'),
  workspacePath: z.string().trim().max(4_000).nullable().default(null),
  frequency: z.enum(['manual', 'hourly', 'daily', 'weekdays', 'weekly', 'custom']).default('custom'),
  executionMode: z.enum(['new_conversation', 'existing']).default('new_conversation'),
  conversationId: z.string().min(1).nullable().default(null),
  prompt: z.string().trim().max(100_000).default(''),
  skillKey: z.string().trim().max(100).nullable().default(null),
  topic: z.string().trim().max(500).default(''),
  outputFolder: z.string().trim().max(180).default('每日文献推送'),
  permissionMode: z.enum(['read-only', 'auto', 'full-access']).default('read-only'),
  approvalPolicy: z.enum(['on-request', 'never']).default('on-request'),
  projectId: z.string().min(1).nullable().default(null),
  cron: z.string().trim().min(1).max(200),
  timezone: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  expectedRevision: z.int().nonnegative().nullable().default(null)
})
export type SaveScheduleInput = z.infer<typeof SaveScheduleInputSchema>
