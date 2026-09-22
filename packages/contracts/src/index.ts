import { z } from 'zod'
import { ExternalOpenUrlSchema } from './external-url.js'
import { AgentExternalActionRequestResultSchema } from './agent.js'
import {
  FeishuBeginBindInputSchema,
  FeishuBeginBindResultSchema,
  FeishuBindingStatusSchema,
  FeishuSaveAppInputSchema,
  FeishuSendTestResultSchema
} from './feishu.js'
import type {
  FeishuBeginBindInput,
  FeishuBeginBindResult,
  FeishuBindingStatus,
  FeishuSaveAppInput,
  FeishuSendTestResult
} from './feishu.js'
import {
  RssSaveSourceInputSchema,
  RssSourceDeleteInputSchema,
  RssSourceListSchema,
  RssSourceSchema,
  RssSourcePreviewInputSchema,
  RssSourcePreviewSchema,
  RssSourceSetEnabledInputSchema,
  RssSourceSetDisplayEnabledInputSchema,
  RssCategoryDeleteInputSchema,
  RssCategoryListSchema,
  RssCategorySaveInputSchema,
  RssCategorySchema,
  RssItemsQueryInputSchema,
  RssItemsPageSchema
  , RssItemsRefreshInputSchema
  , RssItemsRefreshResultSchema
} from './rss.js'
import type {
  RssSaveSourceInput,
  RssSource,
  RssSourceDeleteInput,
  RssSourceList,
  RssSourceSetEnabledInput
  , RssSourceSetDisplayEnabledInput
  , RssSourcePreviewInput
  , RssSourcePreview
  , RssCategoryDeleteInput
  , RssCategoryList
  , RssCategorySaveInput
  , RssCategory
  , RssItemsQueryInput
  , RssItemsPage
  , RssItemsRefreshInput
  , RssItemsRefreshResult
} from './rss.js'

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number(), z.boolean(), z.null(),
  z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)
]))
import type {
  AgentRun,
  AiApi,
  AiProviderId,
  AiProviderProfile,
  CreatePaperInput,
  CreateResearchArtifactInput,
  ExternalLink,
  IntegrationProfile,
  LiteratureMatrixEntry,
  Paper,
  PaperListFilter,
  PromptTemplate,
  ResearchArtifact,
  SaveAiProviderProfileInput,
  SaveIntegrationProfileInput,
  SavePromptTemplateInput,
  SaveScheduleInput,
  Schedule,
  StartAgentRunInput,
  SyncRun,
  UpdatePaperInput,
  UpdateResearchArtifactInput,
  UpsertLiteratureMatrixInput,
  RemoveLiteratureMatrixInput,
  LiteratureMatrixBulkDeleteInput,
  LiteratureMatrixBulkDeleteResult,
  LiteratureBatchPreviewInput,
  LiteratureBatchPreview,
  LiteratureBatchExecuteInput,
  LiteratureBatchResult,
  LiteratureBatchCancelInput,
  LiteratureBatchCancelReceipt,
  LiteratureBatchRetryInput,
  LiteratureBatchImportResultInput,
  PaperImportReceipt,
  PaperImportFromZoteroInput,
  ArchiveBulkInput,
  ArchiveBulkResult
} from './research.js'
import {
  ArtifactKindSchema,
  CreatePaperInputSchema,
  CreateResearchArtifactInputSchema,
  PaperListFilterSchema,
  SaveIntegrationProfileInputSchema,
  UpdatePaperInputSchema,
  UpdateResearchArtifactInputSchema,
  UpsertLiteratureMatrixInputSchema,
  RemoveLiteratureMatrixInputSchema,
  LiteratureMatrixBulkDeleteInputSchema,
  LiteratureMatrixBulkDeleteResultSchema,
  ResearchArtifactSchema,
  LiteratureBatchPreviewInputSchema,
  LiteratureBatchExecuteInputSchema,
  LiteratureBatchCancelInputSchema,
  LiteratureBatchRetryInputSchema,
  LiteratureBatchImportResultInputSchema,
  PaperImportReceiptSchema,
  LiteratureBatchPreviewSchema,
  LiteratureBatchResultSchema,
  LiteratureBatchCancelReceiptSchema,
  PaperImportFromZoteroInputSchema,
  ArchiveBulkInputSchema,
  ArchiveBulkResultSchema,
  PaperSchema
} from './research.js'
import {
  BulkHardDeleteTaskInputSchema,
  BulkTaskCommandInputSchema,
  CreateResourceLinkInputSchema,
  CalendarRangeInputSchema,
  CalendarEventSchema,
  CreateCalendarEventInputSchema,
  CalendarMarkerSchema,
  CreateCalendarMarkerInputSchema,
  UpdateCalendarMarkerInputSchema,
  CalendarMarkerRangeInputSchema,
  DeleteNoteInputSchema,
  DeleteNoteFolderInputSchema,
  CreateNoteFolderInputSchema,
  MoveNoteInputSchema,
  NoteMetadataPreviewInputSchema,
  ApplyNoteMetadataInputSchema,
  NoteDuplicateInputSchema,
  DateRangeSchema,
  ExternalWriteErrorSchema,
  IntegrationErrorSchema,
  HardDeleteTaskInputSchema,
  IdSchema,
  IsoInstantSchema,
  NoteListInputSchema,
  NoteDeleteReceiptSchema,
  NoteFolderDeleteReceiptSchema,
  NoteSchema,
  NoteFolderCreateReceiptSchema,
  NoteMoveReceiptSchema,
  NoteMetadataPreviewSchema,
  NoteDuplicateReportSchema,
  ReadNoteInputSchema,
  RemoveResourceLinkInputSchema,
  ResourceLinkListInputSchema,
  SearchInputSchema,
  SearchSessionSchema,
  SearchResultSchema,
  LiteratureStagingPageInputSchema,
  LiteratureStagingSaveInputSchema,
  LiteratureStagingDeleteInputSchema,
  LiteratureStagingBulkDeleteInputSchema,
  LiteratureStagingToZoteroPreviewInputSchema,
  LiteratureStagingToZoteroExecuteInputSchema,
  LiteratureStagingPageSchema,
  LiteratureStagingRecordSchema,
  LiteratureStagingDeleteReceiptSchema,
  LiteratureStagingBulkDeleteResultSchema,
  LiteratureStagingToZoteroPreviewSchema,
  LiteratureStagingToZoteroResultSchema,
  LiteratureClearSessionInputSchema,
  LiteratureClearSessionReceiptSchema,
  PageInputSchema,
  WriteNoteInputSchema,
  UpdateCalendarEventInputSchema,
  ZoteroItemKeySchema,
  ProjectIdSchema,
  TaskIdSchema,
  PaperIdSchema,
  ZoteroCollectionSchema,
  ZoteroItemSchema,
  ZoteroBibtexExportInputSchema,
  ZoteroBibtexExportSchema,
  ZoteroCapabilityStatusSchema,
  ZoteroWriteBlockedReasonSchema,
  ZoteroCollectionWriteSchema,
  ZoteroAuthorizeInputSchema,
  ZoteroAuthorizeResultSchema,
  ZoteroCollectionPageInputSchema,
  ZoteroItemPageInputSchema,
  ZoteroImportPreviewInputSchema,
  ZoteroImportExecuteInputSchema,
  PaperToZoteroPreviewInputSchema,
  PaperToZoteroExecuteInputSchema,
  ScholarStatusInputSchema,
  ZoteroCollectionPageSchema,
  ZoteroItemPageSchema,
  ZoteroRemoteDeletePreviewInputSchema,
  ZoteroRemoteDeletePreviewSchema,
  ZoteroRemoteDeleteExecuteInputSchema,
  ZoteroRemoteDeleteReceiptSchema,
  ZoteroDeleteTargetSchema,
  ZoteroImportPreviewSchema,
  ZoteroImportResultSchema,
  PaperToZoteroPreviewSchema,
  ScholarWorkspaceStatusSchema,
  SearchResultPageSchema,
  ObsidianIndexStatusInputSchema,
  ObsidianIndexStatusSchema,
  ObsidianLayoutErrorSchema,
  ObsidianLayoutInitializeInputSchema,
  ObsidianLayoutPlanSchema,
  ObsidianLayoutPreviewInputSchema,
  ObsidianLayoutReceiptSchema,
  ObsidianVaultLayoutPlanSchema,
  ObsidianVaultLayoutPreviewInputSchema,
  ObsidianVaultLayoutInitializeInputSchema,
  ObsidianVaultLayoutReceiptSchema,
  SystemSelectFolderInputSchema,
  SystemRevealPathInputSchema,
  SystemSaveTextFileInputSchema,
  SystemSaveTextFileResultSchema,
  KnowledgeEngineKindSchema,
  KnowledgeEngineConfigSchema,
  KnowledgeEngineSaveInputSchema,
  KnowledgeEngineTestInputSchema,
  KnowledgeEngineTestResultSchema,
  IntelDailyConfigSchema,
  IntelDailyOverviewSchema,
  IntelDailySetConfigInputSchema,
  UpdateStateSchema,
  type BulkOperationResult,
  type CalendarEvent,
  type CalendarRangeInput,
  type CalendarMarker,
  type CreateCalendarMarkerInput,
  type UpdateCalendarMarkerInput,
  type ContextMenuTarget,
  type DateRange,
  type ExternalWriteError,
  type HardDeleteTaskInput,
  type SearchResultPage,
  type LiteratureClearSessionInput,
  type LiteratureClearSessionReceipt,
  type ScholarWorkspaceStatus,
  type ZoteroCapabilityStatus,
  type ZoteroWriteBlockedReason,
  type ZoteroCollectionWrite,
  type ZoteroBibtexExport,
  type ZoteroBibtexExportInput,
  type ZoteroCollectionPage,
  type ZoteroItemPage,
  type ZoteroRemoteDeletePreviewInput,
  type ZoteroRemoteDeletePreview,
  type ZoteroRemoteDeleteExecuteInput,
  type ZoteroRemoteDeleteReceipt,
  type ZoteroDeleteTarget,
  type ZoteroImportPreview,
  type ZoteroImportResult,
  type PaperToZoteroPreview,
  type ResourceLink,
  type WorkspaceServiceStatus,
  type UpdateState,
  type ObsidianIndexStatusInput,
  type WorkspaceTab,
  type ObsidianIndexStatus,
  type ObsidianLayoutInitializeInput,
  type ObsidianLayoutPlan,
  type ObsidianLayoutPreviewInput,
  type ObsidianLayoutReceipt,
  type ObsidianVaultLayoutPlan,
  type ObsidianVaultLayoutPreviewInput,
  type ObsidianVaultLayoutInitializeInput,
  type ObsidianVaultLayoutReceipt,
  type LiteratureStagingSaveInput,
  type LiteratureStagingPageInput,
  type LiteratureStagingDeleteInput,
  type LiteratureStagingBulkDeleteInput,
  type LiteratureStagingToZoteroPreviewInput,
  type LiteratureStagingToZoteroExecuteInput,
  type LiteratureStagingRecord,
  type LiteratureStagingPage,
  type LiteratureStagingDeleteReceipt,
  type LiteratureStagingBulkDeleteResult,
  type LiteratureStagingToZoteroPreview,
  type LiteratureStagingToZoteroResult,
  type DeleteNoteFolderInput,
  type NoteFolderDeleteReceipt,
  type KnowledgeEngineConfig,
  type KnowledgeEngineSaveInput,
  type KnowledgeEngineTestInput,
  type KnowledgeEngineTestResult,
  type IntelDailyConfig,
  type IntelDailyOverview,
  type IntelDailySetConfigInput
} from './v2.js'

export * from './research.js'
export * from './v2.js'
export * from './agent.js'
export * from './external-url.js'
export * from './feishu.js'
export * from './rss.js'


export const TaskStatusSchema = z.enum([
  'inbox',
  'planned',
  'in_progress',
  'blocked',
  'done',
  'canceled',
  'archived'
])
export type TaskStatus = z.infer<typeof TaskStatusSchema>

export const TaskPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent'])
export type TaskPriority = z.infer<typeof TaskPrioritySchema>

export const ProjectStatusSchema = z.enum(['active', 'paused', 'completed', 'archived'])
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>

const NullableIsoDateSchema = IsoInstantSchema.nullable()

export const ProjectSchema = z.object({
  id: ProjectIdSchema,
  name: z.string().min(1),
  description: z.string(),
  status: ProjectStatusSchema,
  startAt: NullableIsoDateSchema,
  dueAt: NullableIsoDateSchema,
  createdAt: IsoInstantSchema,
  updatedAt: IsoInstantSchema,
  revision: z.int().nonnegative()
})
export type Project = z.infer<typeof ProjectSchema>

export const BoardColumnSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  status: TaskStatusSchema.exclude(['inbox', 'canceled', 'archived']),
  position: z.number().finite()
})
export type BoardColumn = z.infer<typeof BoardColumnSchema>

export const TaskSchema = z.object({
  id: TaskIdSchema,
  projectId: ProjectIdSchema.nullable(),
  columnId: IdSchema.nullable(),
  parentTaskId: TaskIdSchema.nullable(),
  title: z.string().min(1),
  notes: z.string(),
  status: TaskStatusSchema,
  priority: TaskPrioritySchema,
  estimateMinutes: z.int().positive().nullable(),
  startAt: NullableIsoDateSchema,
  dueAt: NullableIsoDateSchema,
  completedAt: NullableIsoDateSchema,
  archivedAt: NullableIsoDateSchema,
  tags: z.array(z.string().trim().min(1).max(100)),
  sortKey: z.number().finite(),
  createdAt: IsoInstantSchema,
  updatedAt: IsoInstantSchema,
  revision: z.int().nonnegative()
}).superRefine((task, context) => {
  const isArchived = task.status === 'archived'
  if (isArchived !== (task.archivedAt !== null)) {
    context.addIssue({ code: 'custom', path: ['archivedAt'], message: 'Task status and archivedAt must agree.' })
  }
  if (isArchived && task.columnId !== null) {
    context.addIssue({ code: 'custom', path: ['columnId'], message: 'Archived tasks cannot have board placement.' })
  }
})
export type Task = z.infer<typeof TaskSchema>

export const ProjectProgressSchema = z.object({
  projectId: ProjectIdSchema,
  totalTasks: z.int().nonnegative(),
  completedTasks: z.int().nonnegative(),
  blockedTasks: z.int().nonnegative(),
  overdueTasks: z.int().nonnegative(),
  completedWeight: z.number().nonnegative(),
  totalWeight: z.number().nonnegative(),
  percent: z.number().min(0).max(100)
})
export type ProjectProgress = z.infer<typeof ProjectProgressSchema>

export const DashboardSummarySchema = z.object({
  inboxCount: z.int().nonnegative(),
  dueTodayCount: z.int().nonnegative(),
  overdueCount: z.int().nonnegative(),
  completedThisWeekCount: z.int().nonnegative(),
  projects: z.array(ProjectProgressSchema)
})
export type DashboardSummary = z.infer<typeof DashboardSummarySchema>

export const CreateProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).default(''),
  startAt: NullableIsoDateSchema.optional(),
  dueAt: NullableIsoDateSchema.optional()
})
export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>

export const UpdateProjectInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2_000).optional(),
  status: ProjectStatusSchema.optional(),
  startAt: NullableIsoDateSchema.optional(),
  dueAt: NullableIsoDateSchema.optional(),
  expectedRevision: z.int().nonnegative()
})
export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>

export const CreateTaskInputSchema = z.object({
  title: z.string().trim().min(1).max(240),
  notes: z.string().max(20_000).default(''),
  projectId: ProjectIdSchema.nullable().default(null),
  /** A real board column id or a synthetic status target used by the all-project board. */
  columnId: z.union([
    IdSchema,
    z.string().regex(/^status:(planned|in_progress|blocked|done)$/u)
  ]).nullable().optional(),
  priority: TaskPrioritySchema.default('normal'),
  estimateMinutes: z.int().positive().max(100_000).nullable().default(null),
  dueAt: NullableIsoDateSchema.default(null),
  tags: z.array(z.string().trim().min(1).max(100)).default([])
})
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>

export const UpdateTaskInputSchema = z.object({
  id: TaskIdSchema,
  title: z.string().trim().min(1).max(240).optional(),
  notes: z.string().max(20_000).optional(),
  projectId: ProjectIdSchema.nullable().optional(),
  priority: TaskPrioritySchema.optional(),
  estimateMinutes: z.int().positive().max(100_000).nullable().optional(),
  dueAt: NullableIsoDateSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(100)).optional(),
  expectedRevision: z.int().nonnegative()
})
export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>

export const MoveTaskInputSchema = z.object({
  taskId: TaskIdSchema,
  /** A real board column id or a synthetic status target used by the all-project board. */
  columnId: z.union([
    IdSchema,
    z.string().regex(/^status:(planned|in_progress|blocked|done)$/u)
  ]),
  targetIndex: z.int().nonnegative(),
  expectedRevision: z.int().nonnegative()
})
export type MoveTaskInput = z.infer<typeof MoveTaskInputSchema>

export const TaskListFilterSchema = z.object({
  projectId: ProjectIdSchema.nullable().optional(),
  view: z.enum(['all', 'inbox', 'today', 'upcoming', 'overdue', 'completed']).default('all'),
  includeArchived: z.boolean().default(false),
  dateRange: DateRangeSchema.optional(),
  /** Field used by date presets/ranges. Defaults to creation time for task planning. */
  /** Date field used by ranges; creation time is the default planning axis. */
  dateField: z.enum(['createdAt', 'dueAt']).optional()
})
export type TaskListFilter = z.infer<typeof TaskListFilterSchema>

export const ArchiveTaskInputSchema = z.object({
  id: TaskIdSchema,
  expectedRevision: z.int().nonnegative()
})
export type ArchiveTaskInput = z.infer<typeof ArchiveTaskInputSchema>
export const RestoreTaskInputSchema = ArchiveTaskInputSchema
export type RestoreTaskInput = z.infer<typeof RestoreTaskInputSchema>
export const BulkArchiveTaskInputSchema = BulkTaskCommandInputSchema
export const BulkRestoreTaskInputSchema = BulkTaskCommandInputSchema
export type BulkTaskCommandInput = z.infer<typeof BulkTaskCommandInputSchema>

const AppErrorBaseSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  details: z.record(z.string(), JsonValueSchema).optional()
})
export const AppErrorSchema = z.union([AppErrorBaseSchema, ExternalWriteErrorSchema, ObsidianLayoutErrorSchema, IntegrationErrorSchema])
export type AppError = z.infer<typeof AppErrorSchema>

const ProjectArchiveInputSchema = z.object({ id: ProjectIdSchema, expectedRevision: z.int().nonnegative() })
const PaperArchiveInputSchema = z.object({ id: PaperIdSchema, expectedRevision: z.int().nonnegative() })
const EntityArchiveInputSchema = z.object({ id: IdSchema, expectedRevision: z.int().nonnegative() })
const ProjectIdInputSchema = z.object({ projectId: ProjectIdSchema })
const OptionalProjectInputSchema = z.object({ projectId: ProjectIdSchema.nullable().optional() })
const OptionalProfileInputSchema = z.object({ profileId: IdSchema.optional() })
const IdInputSchema = z.object({ id: IdSchema })
const IntegrationSyncInputSchema = z.object({
  id: IdSchema,
  direction: z.enum(['pull', 'push'])
})
const IntegrationTestResultSchema = z.object({ ok: z.boolean(), message: z.string() })

const strictPayload = <T extends z.ZodTypeAny>(schema: T): T => {
  if (schema instanceof z.ZodObject) return schema.strict() as unknown as T
  return schema
}

export const ZoteroProfileInputSchema = z.strictObject({ profileId: IdSchema })
export const ZoteroCapabilityInputSchema = ZoteroProfileInputSchema
export const ZoteroCollectionsInputSchema = ZoteroCollectionPageInputSchema
export const ZoteroItemsInputSchema = ZoteroItemPageInputSchema
/** @deprecated Compatibility-only inputs for the pre-pagination array routes. */
const ZoteroCollectionsCompatibilityInputSchema = strictPayload(ZoteroCollectionPageInputSchema.pick({ profileId: true }))
/** @deprecated Compatibility-only inputs for the pre-pagination array routes. */
// ZoteroItemPageInputSchema has a cross-field refinement, so Zod cannot pick
// from it at module initialisation time. Keep the compatibility route's
// intentionally smaller strict payload explicit instead of bypassing that
// refinement with a cast or a second relaxed schema.
const ZoteroItemsCompatibilityInputSchema = strictPayload(z.strictObject({
  profileId: IdSchema,
  collectionKey: ZoteroItemKeySchema.optional()
}))
export const ZoteroImportInputSchema = ZoteroProfileInputSchema.extend({
  itemKey: ZoteroItemKeySchema,
  projectId: ProjectIdSchema.nullable()
})
export const LiteratureResultsInputSchema = z.strictObject({ sessionId: IdSchema, page: PageInputSchema.optional() })
export type LiteratureResultsInput = z.infer<typeof LiteratureResultsInputSchema>
/** @deprecated Compatibility-only input for the pre-pagination array route. */
const LiteratureResultsCompatibilityInputSchema = strictPayload(LiteratureResultsInputSchema.pick({ sessionId: true }))
const ArtifactFilterSchema = z.object({ projectId: ProjectIdSchema.nullable().optional(), kind: ArtifactKindSchema.optional() })

const rpc = <M extends string>(method: M, payload: z.ZodTypeAny) =>
  z.strictObject({ id: z.string().min(1), method: z.literal(method), payload })

/** Every V2 RPC method has a closed payload schema. Legacy AI methods are not
 * represented here; migration-only routes must use a separately versioned API. */
export const RpcMethodPayloadSchemas = {
  'projects.list': z.null(),
  'projects.create': strictPayload(CreateProjectInputSchema),
  'projects.update': strictPayload(UpdateProjectInputSchema),
  'projects.archive': strictPayload(ProjectArchiveInputSchema),
  'boards.columns': strictPayload(ProjectIdInputSchema),
  'tasks.list': strictPayload(TaskListFilterSchema),
  'tasks.create': strictPayload(CreateTaskInputSchema),
  'tasks.update': strictPayload(UpdateTaskInputSchema),
  'tasks.move': strictPayload(MoveTaskInputSchema),
  'tasks.archive': strictPayload(ArchiveTaskInputSchema),
  'tasks.restore': strictPayload(RestoreTaskInputSchema),
  'tasks.hardDelete': strictPayload(HardDeleteTaskInputSchema),
  'tasks.bulkArchive': strictPayload(BulkArchiveTaskInputSchema),
  'tasks.bulkRestore': strictPayload(BulkRestoreTaskInputSchema),
  'tasks.bulkHardDelete': strictPayload(BulkHardDeleteTaskInputSchema),
  'todos.capture': strictPayload(CreateTaskInputSchema),
  'progress.project': strictPayload(ProjectIdInputSchema),
  'progress.dashboard': z.null(),
  'papers.list': strictPayload(PaperListFilterSchema),
  'papers.create': strictPayload(CreatePaperInputSchema),
  'papers.update': strictPayload(UpdatePaperInputSchema),
  'papers.archive': strictPayload(PaperArchiveInputSchema),
  'matrix.list': strictPayload(OptionalProjectInputSchema),
  'matrix.upsert': strictPayload(UpsertLiteratureMatrixInputSchema),
  'matrix.remove': strictPayload(RemoveLiteratureMatrixInputSchema),
  'matrix.bulkDelete': strictPayload(LiteratureMatrixBulkDeleteInputSchema),
  'artifacts.list': strictPayload(ArtifactFilterSchema),
  'artifacts.create': strictPayload(CreateResearchArtifactInputSchema),
  'artifacts.update': strictPayload(UpdateResearchArtifactInputSchema),
  'artifacts.archive': strictPayload(EntityArchiveInputSchema),
  'resourceLinks.list': strictPayload(ResourceLinkListInputSchema),
  'resourceLinks.create': strictPayload(CreateResourceLinkInputSchema),
  'resourceLinks.remove': strictPayload(RemoveResourceLinkInputSchema),
  'integrations.list': z.null(),
  'integrations.save': strictPayload(SaveIntegrationProfileInputSchema),
  'integrations.remove': strictPayload(EntityArchiveInputSchema),
  'integrations.bulkRemove': strictPayload(ArchiveBulkInputSchema),
  'integrations.removeRun': strictPayload(EntityArchiveInputSchema),
  'integrations.bulkRemoveRuns': strictPayload(ArchiveBulkInputSchema),
  'integrations.test': strictPayload(IdInputSchema),
  'integrations.sync': strictPayload(IntegrationSyncInputSchema),
  'integrations.runs': strictPayload(OptionalProfileInputSchema),
  'integrations.links': strictPayload(OptionalProfileInputSchema),
  'calendar.list': strictPayload(CalendarRangeInputSchema),
  'calendar.create': strictPayload(CreateCalendarEventInputSchema),
  'calendar.update': strictPayload(UpdateCalendarEventInputSchema),
  'calendar.remove': strictPayload(EntityArchiveInputSchema),
  'calendar.markers.list': strictPayload(CalendarMarkerRangeInputSchema),
  'calendar.markers.create': strictPayload(CreateCalendarMarkerInputSchema),
  'calendar.markers.update': strictPayload(UpdateCalendarMarkerInputSchema),
  'calendar.markers.remove': strictPayload(EntityArchiveInputSchema),
  'literature.search': strictPayload(SearchInputSchema),
  'literature.sessions': z.null(),
  'literature.clearSession': strictPayload(LiteratureClearSessionInputSchema),
  'literature.resultsPage': strictPayload(LiteratureResultsInputSchema),
  'literature.staging.page': strictPayload(LiteratureStagingPageInputSchema),
  'literature.staging.save': strictPayload(LiteratureStagingSaveInputSchema),
  'literature.staging.delete': strictPayload(LiteratureStagingDeleteInputSchema),
  'literature.staging.bulkDelete': strictPayload(LiteratureStagingBulkDeleteInputSchema),
  'literature.stagingToZotero.preview': strictPayload(LiteratureStagingToZoteroPreviewInputSchema),
  'literature.stagingToZotero.execute': strictPayload(LiteratureStagingToZoteroExecuteInputSchema),
  /** Preview *and* open a user decision.
   *
   * These four are the only external writes an Agent tool may reach. They run the
   * same preview as the read-only pair above and then freeze it in an
   * `agent_external_actions` row: the Agent prepares a write, a person approves
   * it, and `execute` is never reachable from the model. */
  'literature.stagingToZotero.request': strictPayload(LiteratureStagingToZoteroPreviewInputSchema),
  'zotero.paperToZotero.request': strictPayload(PaperToZoteroPreviewInputSchema),
  'notes.write.request': strictPayload(WriteNoteInputSchema),
  'notes.metadata.request': strictPayload(NoteMetadataPreviewInputSchema),
  /** @deprecated Compatibility-only array route; use literature.resultsPage. */
  'literature.results': LiteratureResultsCompatibilityInputSchema,
  'literature.batch.preview': strictPayload(LiteratureBatchPreviewInputSchema),
  'literature.batch.execute': strictPayload(LiteratureBatchExecuteInputSchema),
  'literature.batch.cancel': strictPayload(LiteratureBatchCancelInputSchema),
  'literature.batch.retry': strictPayload(LiteratureBatchRetryInputSchema),
  'literature.importResult': strictPayload(LiteratureBatchImportResultInputSchema),
  'literature.scholar.status': ScholarStatusInputSchema,
  'obsidian.indexStatus': strictPayload(ObsidianIndexStatusInputSchema),
  'obsidian.layout.preview': strictPayload(ObsidianLayoutPreviewInputSchema),
  'obsidian.layout.initialize': strictPayload(ObsidianLayoutInitializeInputSchema),
  'obsidian.vaultLayout.preview': strictPayload(ObsidianVaultLayoutPreviewInputSchema),
  'obsidian.vaultLayout.initialize': strictPayload(ObsidianVaultLayoutInitializeInputSchema),
  'notes.list': strictPayload(NoteListInputSchema),
  'notes.read': strictPayload(ReadNoteInputSchema),
  'notes.write': strictPayload(WriteNoteInputSchema),
  'notes.delete': strictPayload(DeleteNoteInputSchema),
  'notes.deleteFolder': strictPayload(DeleteNoteFolderInputSchema),
  'notes.createFolder': strictPayload(CreateNoteFolderInputSchema),
  'notes.move': strictPayload(MoveNoteInputSchema),
  'notes.metadata.preview': strictPayload(NoteMetadataPreviewInputSchema),
  'notes.metadata.apply': strictPayload(ApplyNoteMetadataInputSchema),
  'notes.duplicates': strictPayload(NoteDuplicateInputSchema),
  'zotero.capability': strictPayload(ZoteroCapabilityInputSchema),
  'zotero.authorize': strictPayload(ZoteroAuthorizeInputSchema),
  'zotero.collectionsPage': strictPayload(ZoteroCollectionPageInputSchema),
  /** @deprecated Compatibility-only array route; use zotero.collectionsPage. */
  'zotero.collections': ZoteroCollectionsCompatibilityInputSchema,
  'zotero.itemsPage': strictPayload(ZoteroItemPageInputSchema),
  'zotero.bibtexExport': strictPayload(ZoteroBibtexExportInputSchema),
  /** @deprecated Compatibility-only array route; use zotero.itemsPage. */
  'zotero.items': ZoteroItemsCompatibilityInputSchema,
  'zotero.import': strictPayload(ZoteroImportInputSchema),
  'zotero.importSelected.preview': strictPayload(ZoteroImportPreviewInputSchema),
  'zotero.importSelected.execute': strictPayload(ZoteroImportExecuteInputSchema),
  'zotero.paperToZotero.preview': strictPayload(PaperToZoteroPreviewInputSchema),
  'zotero.paperToZotero.execute': strictPayload(PaperToZoteroExecuteInputSchema),
  'zotero.deleteRemote.preview': strictPayload(ZoteroRemoteDeletePreviewInputSchema),
  'zotero.deleteRemote.execute': strictPayload(ZoteroRemoteDeleteExecuteInputSchema),
  'papers.importFromZotero': strictPayload(PaperImportFromZoteroInputSchema),
  'knowledge.engines.list': z.null(),
  'knowledge.engines.save': strictPayload(KnowledgeEngineSaveInputSchema),
  'knowledge.engines.test': strictPayload(KnowledgeEngineTestInputSchema),
  'intelDaily.getConfig': z.null(),
  'intelDaily.setConfig': strictPayload(IntelDailySetConfigInputSchema),
  'intelDaily.overview': z.null(),
  'feishu.saveApp': strictPayload(FeishuSaveAppInputSchema),
  'feishu.getStatus': z.null(),
  'feishu.beginBind': strictPayload(FeishuBeginBindInputSchema),
  'feishu.unbind': z.null(),
  'feishu.sendTest': z.null(),
  'rss.sources.list': z.null(),
  'rss.sources.preview': strictPayload(RssSourcePreviewInputSchema),
  'rss.sources.save': strictPayload(RssSaveSourceInputSchema),
  'rss.sources.remove': strictPayload(RssSourceDeleteInputSchema),
  'rss.sources.setEnabled': strictPayload(RssSourceSetEnabledInputSchema),
  'rss.sources.setDisplayEnabled': strictPayload(RssSourceSetDisplayEnabledInputSchema),
  'rss.categories.list': z.null(),
  'rss.categories.save': strictPayload(RssCategorySaveInputSchema),
  'rss.categories.remove': strictPayload(RssCategoryDeleteInputSchema),
  'rss.items.query': strictPayload(RssItemsQueryInputSchema),
  'rss.items.refresh': strictPayload(RssItemsRefreshInputSchema),
  'workspace.status': z.null(),
  'system.openExternal': ExternalOpenUrlSchema,
  'system.health': z.null(),
  'system.selectFolder': SystemSelectFolderInputSchema
  , 'system.revealPath': strictPayload(SystemRevealPathInputSchema)
  , 'system.saveTextFile': strictPayload(SystemSaveTextFileInputSchema)
} as const

/** Closed union of RPC method names represented by the payload map. */
export type RpcMethod = keyof typeof RpcMethodPayloadSchemas

/** Method-specific output schemas for the literature/Zotero additions. The
 * dispatcher/preload may use this map to validate responses without exposing
 * a generic `unknown` payload. */
export const RpcMethodResultSchemas = {
  'calendar.list': z.array(CalendarEventSchema),
  'calendar.create': CalendarEventSchema,
  'calendar.update': CalendarEventSchema,
  'calendar.remove': z.null(),
  'calendar.markers.list': z.array(CalendarMarkerSchema),
  'calendar.markers.create': CalendarMarkerSchema,
  'calendar.markers.update': CalendarMarkerSchema,
  'calendar.markers.remove': z.null(),
  'matrix.remove': z.null(),
  'matrix.bulkDelete': LiteratureMatrixBulkDeleteResultSchema,
  /** Validated in Core as well: the renderer renders these receipts verbatim. */
  'integrations.bulkRemove': ArchiveBulkResultSchema,
  /** Sync-run removal reuses the frozen CAS + per-record receipt vocabulary. */
  'integrations.bulkRemoveRuns': ArchiveBulkResultSchema,
  'literature.search': z.object({
    session: z.lazy(() => SearchSessionSchema),
    results: z.array(z.lazy(() => SearchResultSchema))
  }),
  'literature.sessions': z.array(z.lazy(() => SearchSessionSchema)),
  'literature.clearSession': LiteratureClearSessionReceiptSchema,
  'literature.resultsPage': SearchResultPageSchema,
  'literature.staging.page': LiteratureStagingPageSchema,
  'literature.staging.save': LiteratureStagingRecordSchema,
  'literature.staging.delete': LiteratureStagingDeleteReceiptSchema,
  'literature.staging.bulkDelete': LiteratureStagingBulkDeleteResultSchema,
  'literature.stagingToZotero.preview': LiteratureStagingToZoteroPreviewSchema,
  'literature.stagingToZotero.execute': LiteratureStagingToZoteroResultSchema,
  /** @deprecated Compatibility-only array route; use literature.resultsPage. */
  'literature.results': z.array(z.lazy(() => SearchResultSchema)),
  'literature.batch.preview': LiteratureBatchPreviewSchema,
  'literature.batch.execute': LiteratureBatchResultSchema,
  'literature.batch.cancel': LiteratureBatchCancelReceiptSchema,
  'literature.batch.retry': LiteratureBatchResultSchema,
  'literature.importResult': PaperImportReceiptSchema,
  'literature.scholar.status': ScholarWorkspaceStatusSchema,
  'obsidian.indexStatus': ObsidianIndexStatusSchema,
  'obsidian.layout.preview': ObsidianLayoutPlanSchema,
  'obsidian.layout.initialize': ObsidianLayoutReceiptSchema,
  'obsidian.vaultLayout.preview': ObsidianVaultLayoutPlanSchema,
  'obsidian.vaultLayout.initialize': ObsidianVaultLayoutReceiptSchema,
  'notes.delete': NoteDeleteReceiptSchema,
  'notes.deleteFolder': NoteFolderDeleteReceiptSchema,
  'notes.createFolder': NoteFolderCreateReceiptSchema,
  'notes.move': NoteMoveReceiptSchema,
  'notes.metadata.preview': NoteMetadataPreviewSchema,
  'notes.metadata.apply': NoteSchema,
  'notes.duplicates': NoteDuplicateReportSchema,
  'papers.importFromZotero': PaperImportReceiptSchema,
  'zotero.capability': ZoteroCapabilityStatusSchema,
  'zotero.authorize': ZoteroAuthorizeResultSchema,
  'zotero.collectionsPage': ZoteroCollectionPageSchema,
  /** @deprecated Compatibility-only array route; use zotero.collectionsPage. */
  'zotero.collections': z.array(z.lazy(() => ZoteroCollectionSchema)),
  'zotero.itemsPage': ZoteroItemPageSchema,
  'zotero.bibtexExport': ZoteroBibtexExportSchema,
  /** @deprecated Compatibility-only array route; use zotero.itemsPage. */
  'zotero.items': z.array(z.lazy(() => ZoteroItemSchema)),
  'zotero.importSelected.preview': ZoteroImportPreviewSchema,
  'zotero.importSelected.execute': ZoteroImportResultSchema,
  'zotero.paperToZotero.preview': PaperToZoteroPreviewSchema,
  'zotero.paperToZotero.request': AgentExternalActionRequestResultSchema,
  'literature.stagingToZotero.request': AgentExternalActionRequestResultSchema,
  'notes.write.request': AgentExternalActionRequestResultSchema,
  'notes.metadata.request': AgentExternalActionRequestResultSchema,
  'zotero.paperToZotero.execute': ZoteroImportResultSchema,
  'zotero.deleteRemote.preview': ZoteroRemoteDeletePreviewSchema,
  'zotero.deleteRemote.execute': ZoteroRemoteDeleteReceiptSchema,
  'zotero.import': PaperSchema
  , 'knowledge.engines.list': z.array(KnowledgeEngineConfigSchema)
  , 'knowledge.engines.save': KnowledgeEngineConfigSchema
  , 'knowledge.engines.test': KnowledgeEngineTestResultSchema
  , 'intelDaily.getConfig': IntelDailyConfigSchema
  , 'intelDaily.setConfig': IntelDailyConfigSchema
  , 'intelDaily.overview': IntelDailyOverviewSchema
  , 'feishu.saveApp': FeishuBindingStatusSchema
  , 'feishu.getStatus': FeishuBindingStatusSchema
  , 'feishu.beginBind': FeishuBeginBindResultSchema
  , 'feishu.unbind': FeishuBindingStatusSchema
  , 'feishu.sendTest': FeishuSendTestResultSchema
  , 'rss.sources.list': RssSourceListSchema
  , 'rss.sources.preview': RssSourcePreviewSchema
  , 'rss.sources.save': RssSourceSchema
  , 'rss.sources.remove': z.null()
  , 'rss.sources.setEnabled': RssSourceSchema
  , 'rss.sources.setDisplayEnabled': RssSourceSchema
  , 'rss.categories.list': RssCategoryListSchema
  , 'rss.categories.save': RssCategorySchema
  , 'rss.categories.remove': z.null()
  , 'rss.items.query': RssItemsPageSchema
  , 'rss.items.refresh': RssItemsRefreshResultSchema
  , 'system.revealPath': z.null()
  , 'system.saveTextFile': SystemSaveTextFileResultSchema
} as const

/** Closed union of RPC method names with a method-specific result schema. */
export type RpcResultMethod = keyof typeof RpcMethodResultSchemas

const RpcRequestVariants = [
  rpc('projects.list', RpcMethodPayloadSchemas['projects.list']),
  rpc('projects.create', RpcMethodPayloadSchemas['projects.create']),
  rpc('projects.update', RpcMethodPayloadSchemas['projects.update']),
  rpc('projects.archive', RpcMethodPayloadSchemas['projects.archive']),
  rpc('boards.columns', RpcMethodPayloadSchemas['boards.columns']),
  rpc('tasks.list', RpcMethodPayloadSchemas['tasks.list']),
  rpc('tasks.create', RpcMethodPayloadSchemas['tasks.create']),
  rpc('tasks.update', RpcMethodPayloadSchemas['tasks.update']),
  rpc('tasks.move', RpcMethodPayloadSchemas['tasks.move']),
  rpc('tasks.archive', RpcMethodPayloadSchemas['tasks.archive']),
  rpc('tasks.restore', RpcMethodPayloadSchemas['tasks.restore']),
  rpc('tasks.hardDelete', RpcMethodPayloadSchemas['tasks.hardDelete']),
  rpc('tasks.bulkArchive', RpcMethodPayloadSchemas['tasks.bulkArchive']),
  rpc('tasks.bulkRestore', RpcMethodPayloadSchemas['tasks.bulkRestore']),
  rpc('tasks.bulkHardDelete', RpcMethodPayloadSchemas['tasks.bulkHardDelete']),
  rpc('todos.capture', RpcMethodPayloadSchemas['todos.capture']),
  rpc('progress.project', RpcMethodPayloadSchemas['progress.project']),
  rpc('progress.dashboard', RpcMethodPayloadSchemas['progress.dashboard']),
  rpc('papers.list', RpcMethodPayloadSchemas['papers.list']),
  rpc('papers.create', RpcMethodPayloadSchemas['papers.create']),
  rpc('papers.update', RpcMethodPayloadSchemas['papers.update']),
  rpc('papers.archive', RpcMethodPayloadSchemas['papers.archive']),
  rpc('matrix.list', RpcMethodPayloadSchemas['matrix.list']),
  rpc('matrix.upsert', RpcMethodPayloadSchemas['matrix.upsert']),
  rpc('matrix.remove', RpcMethodPayloadSchemas['matrix.remove']),
  rpc('matrix.bulkDelete', RpcMethodPayloadSchemas['matrix.bulkDelete']),
  rpc('artifacts.list', RpcMethodPayloadSchemas['artifacts.list']),
  rpc('artifacts.create', RpcMethodPayloadSchemas['artifacts.create']),
  rpc('artifacts.update', RpcMethodPayloadSchemas['artifacts.update']),
  rpc('artifacts.archive', RpcMethodPayloadSchemas['artifacts.archive']),
  rpc('resourceLinks.list', RpcMethodPayloadSchemas['resourceLinks.list']),
  rpc('resourceLinks.create', RpcMethodPayloadSchemas['resourceLinks.create']),
  rpc('resourceLinks.remove', RpcMethodPayloadSchemas['resourceLinks.remove']),
  rpc('integrations.list', RpcMethodPayloadSchemas['integrations.list']),
  rpc('integrations.save', RpcMethodPayloadSchemas['integrations.save']),
  rpc('integrations.remove', RpcMethodPayloadSchemas['integrations.remove']),
  rpc('integrations.bulkRemove', RpcMethodPayloadSchemas['integrations.bulkRemove']),
  rpc('integrations.removeRun', RpcMethodPayloadSchemas['integrations.removeRun']),
  rpc('integrations.bulkRemoveRuns', RpcMethodPayloadSchemas['integrations.bulkRemoveRuns']),
  rpc('integrations.test', RpcMethodPayloadSchemas['integrations.test']),
  rpc('integrations.sync', RpcMethodPayloadSchemas['integrations.sync']),
  rpc('integrations.runs', RpcMethodPayloadSchemas['integrations.runs']),
  rpc('integrations.links', RpcMethodPayloadSchemas['integrations.links']),
  rpc('calendar.list', RpcMethodPayloadSchemas['calendar.list']),
  rpc('calendar.create', RpcMethodPayloadSchemas['calendar.create']),
  rpc('calendar.update', RpcMethodPayloadSchemas['calendar.update']),
  rpc('calendar.remove', RpcMethodPayloadSchemas['calendar.remove']),
  rpc('calendar.markers.list', RpcMethodPayloadSchemas['calendar.markers.list']),
  rpc('calendar.markers.create', RpcMethodPayloadSchemas['calendar.markers.create']),
  rpc('calendar.markers.update', RpcMethodPayloadSchemas['calendar.markers.update']),
  rpc('calendar.markers.remove', RpcMethodPayloadSchemas['calendar.markers.remove']),
  rpc('literature.search', RpcMethodPayloadSchemas['literature.search']),
  rpc('literature.sessions', RpcMethodPayloadSchemas['literature.sessions']),
  rpc('literature.clearSession', RpcMethodPayloadSchemas['literature.clearSession']),
  rpc('literature.resultsPage', RpcMethodPayloadSchemas['literature.resultsPage']),
  rpc('literature.staging.page', RpcMethodPayloadSchemas['literature.staging.page']),
  rpc('literature.staging.save', RpcMethodPayloadSchemas['literature.staging.save']),
  rpc('literature.staging.delete', RpcMethodPayloadSchemas['literature.staging.delete']),
  rpc('literature.staging.bulkDelete', RpcMethodPayloadSchemas['literature.staging.bulkDelete']),
  rpc('literature.stagingToZotero.preview', RpcMethodPayloadSchemas['literature.stagingToZotero.preview']),
  rpc('literature.stagingToZotero.execute', RpcMethodPayloadSchemas['literature.stagingToZotero.execute']),
  /** @deprecated Compatibility-only array route; use literature.resultsPage. */
  rpc('literature.results', RpcMethodPayloadSchemas['literature.results']),
  rpc('literature.batch.preview', RpcMethodPayloadSchemas['literature.batch.preview']),
  rpc('literature.batch.execute', RpcMethodPayloadSchemas['literature.batch.execute']),
  rpc('literature.batch.cancel', RpcMethodPayloadSchemas['literature.batch.cancel']),
  rpc('literature.batch.retry', RpcMethodPayloadSchemas['literature.batch.retry']),
  rpc('literature.importResult', RpcMethodPayloadSchemas['literature.importResult']),
  rpc('literature.scholar.status', RpcMethodPayloadSchemas['literature.scholar.status']),
  rpc('obsidian.indexStatus', RpcMethodPayloadSchemas['obsidian.indexStatus']),
  rpc('obsidian.layout.preview', RpcMethodPayloadSchemas['obsidian.layout.preview']),
  rpc('obsidian.layout.initialize', RpcMethodPayloadSchemas['obsidian.layout.initialize']),
  rpc('obsidian.vaultLayout.preview', RpcMethodPayloadSchemas['obsidian.vaultLayout.preview']),
  rpc('obsidian.vaultLayout.initialize', RpcMethodPayloadSchemas['obsidian.vaultLayout.initialize']),
  rpc('notes.list', RpcMethodPayloadSchemas['notes.list']),
  rpc('notes.read', RpcMethodPayloadSchemas['notes.read']),
  rpc('notes.write', RpcMethodPayloadSchemas['notes.write']),
  rpc('notes.delete', RpcMethodPayloadSchemas['notes.delete']),
  rpc('notes.deleteFolder', RpcMethodPayloadSchemas['notes.deleteFolder']),
  rpc('notes.createFolder', RpcMethodPayloadSchemas['notes.createFolder']),
  rpc('notes.move', RpcMethodPayloadSchemas['notes.move']),
  rpc('notes.metadata.preview', RpcMethodPayloadSchemas['notes.metadata.preview']),
  rpc('notes.metadata.apply', RpcMethodPayloadSchemas['notes.metadata.apply']),
  rpc('notes.write.request', RpcMethodPayloadSchemas['notes.write.request']),
  rpc('notes.metadata.request', RpcMethodPayloadSchemas['notes.metadata.request']),
  rpc('notes.duplicates', RpcMethodPayloadSchemas['notes.duplicates']),
  rpc('zotero.capability', RpcMethodPayloadSchemas['zotero.capability']),
  rpc('zotero.authorize', RpcMethodPayloadSchemas['zotero.authorize']),
  rpc('zotero.collectionsPage', RpcMethodPayloadSchemas['zotero.collectionsPage']),
  /** @deprecated Compatibility-only array route; use zotero.collectionsPage. */
  rpc('zotero.collections', RpcMethodPayloadSchemas['zotero.collections']),
  rpc('zotero.itemsPage', RpcMethodPayloadSchemas['zotero.itemsPage']),
  rpc('zotero.bibtexExport', RpcMethodPayloadSchemas['zotero.bibtexExport']),
  /** @deprecated Compatibility-only array route; use zotero.itemsPage. */
  rpc('zotero.items', RpcMethodPayloadSchemas['zotero.items']),
  rpc('zotero.import', RpcMethodPayloadSchemas['zotero.import']),
  rpc('zotero.importSelected.preview', RpcMethodPayloadSchemas['zotero.importSelected.preview']),
  rpc('zotero.importSelected.execute', RpcMethodPayloadSchemas['zotero.importSelected.execute']),
  rpc('zotero.paperToZotero.preview', RpcMethodPayloadSchemas['zotero.paperToZotero.preview']),
  rpc('zotero.paperToZotero.execute', RpcMethodPayloadSchemas['zotero.paperToZotero.execute']),
  rpc('zotero.paperToZotero.request', RpcMethodPayloadSchemas['zotero.paperToZotero.request']),
  rpc('literature.stagingToZotero.request', RpcMethodPayloadSchemas['literature.stagingToZotero.request']),
  rpc('zotero.deleteRemote.preview', RpcMethodPayloadSchemas['zotero.deleteRemote.preview']),
  rpc('zotero.deleteRemote.execute', RpcMethodPayloadSchemas['zotero.deleteRemote.execute']),
  rpc('papers.importFromZotero', RpcMethodPayloadSchemas['papers.importFromZotero']),
  rpc('knowledge.engines.list', RpcMethodPayloadSchemas['knowledge.engines.list']),
  rpc('knowledge.engines.save', RpcMethodPayloadSchemas['knowledge.engines.save']),
  rpc('knowledge.engines.test', RpcMethodPayloadSchemas['knowledge.engines.test']),
  rpc('intelDaily.getConfig', RpcMethodPayloadSchemas['intelDaily.getConfig']),
  rpc('intelDaily.setConfig', RpcMethodPayloadSchemas['intelDaily.setConfig']),
  rpc('intelDaily.overview', RpcMethodPayloadSchemas['intelDaily.overview']),
  rpc('feishu.saveApp', RpcMethodPayloadSchemas['feishu.saveApp']),
  rpc('feishu.getStatus', RpcMethodPayloadSchemas['feishu.getStatus']),
  rpc('feishu.beginBind', RpcMethodPayloadSchemas['feishu.beginBind']),
  rpc('feishu.unbind', RpcMethodPayloadSchemas['feishu.unbind']),
  rpc('feishu.sendTest', RpcMethodPayloadSchemas['feishu.sendTest']),
  rpc('rss.sources.list', RpcMethodPayloadSchemas['rss.sources.list']),
  rpc('rss.sources.preview', RpcMethodPayloadSchemas['rss.sources.preview']),
  rpc('rss.sources.save', RpcMethodPayloadSchemas['rss.sources.save']),
  rpc('rss.sources.remove', RpcMethodPayloadSchemas['rss.sources.remove']),
  rpc('rss.sources.setEnabled', RpcMethodPayloadSchemas['rss.sources.setEnabled']),
  rpc('rss.sources.setDisplayEnabled', RpcMethodPayloadSchemas['rss.sources.setDisplayEnabled']),
  rpc('rss.categories.list', RpcMethodPayloadSchemas['rss.categories.list']),
  rpc('rss.categories.save', RpcMethodPayloadSchemas['rss.categories.save']),
  rpc('rss.categories.remove', RpcMethodPayloadSchemas['rss.categories.remove']),
  rpc('rss.items.query', RpcMethodPayloadSchemas['rss.items.query']),
  rpc('rss.items.refresh', RpcMethodPayloadSchemas['rss.items.refresh']),
  rpc('workspace.status', RpcMethodPayloadSchemas['workspace.status']),
  rpc('system.openExternal', RpcMethodPayloadSchemas['system.openExternal']),
  rpc('system.health', RpcMethodPayloadSchemas['system.health']),
  rpc('system.selectFolder', RpcMethodPayloadSchemas['system.selectFolder'])
  , rpc('system.revealPath', RpcMethodPayloadSchemas['system.revealPath'])
  , rpc('system.saveTextFile', RpcMethodPayloadSchemas['system.saveTextFile'])
] as const

export const RpcRequestSchema = z.discriminatedUnion('method', RpcRequestVariants)
export type RpcRequest = z.infer<typeof RpcRequestSchema>
export type RpcRequestMethod = RpcRequest['method']

export const RpcResponseSchema = z.discriminatedUnion('ok', [
  z.object({ id: z.string(), ok: z.literal(true), data: JsonValueSchema }),
  z.object({ id: z.string(), ok: z.literal(false), error: AppErrorSchema })
])
export type RpcResponse = z.infer<typeof RpcResponseSchema>

/** @deprecated V1 is retained only for migrations and non-renderer adapters. */
export interface WorkbenchApiLegacy {
  projects: {
    list(): Promise<Project[]>
    create(input: CreateProjectInput): Promise<Project>
    update(input: UpdateProjectInput): Promise<Project>
    archive(id: string, expectedRevision: number): Promise<void>
  }
  boards: {
    columns(projectId: string): Promise<BoardColumn[]>
  }
  tasks: {
    list(filter?: Partial<TaskListFilter>): Promise<Task[]>
    create(input: CreateTaskInput): Promise<Task>
    update(input: UpdateTaskInput): Promise<Task>
    move(input: MoveTaskInput): Promise<Task>
    archive(id: string, expectedRevision: number): Promise<void>
  }
  progress: {
    project(projectId: string): Promise<ProjectProgress>
    dashboard(): Promise<DashboardSummary>
  }
  papers: {
    list(filter?: Partial<PaperListFilter>): Promise<Paper[]>
    create(input: CreatePaperInput): Promise<Paper>
    update(input: UpdatePaperInput): Promise<Paper>
    archive(id: string, expectedRevision: number): Promise<void>
  }
  matrix: {
    list(projectId?: string | null): Promise<LiteratureMatrixEntry[]>
    upsert(input: UpsertLiteratureMatrixInput): Promise<LiteratureMatrixEntry>
    remove(input: RemoveLiteratureMatrixInput): Promise<void>
    bulkDelete(input: LiteratureMatrixBulkDeleteInput): Promise<LiteratureMatrixBulkDeleteResult>
  }
  artifacts: {
    list(filter?: { projectId?: string | null; kind?: ResearchArtifact['kind'] }): Promise<ResearchArtifact[]>
    create(input: CreateResearchArtifactInput): Promise<ResearchArtifact>
    update(input: UpdateResearchArtifactInput): Promise<ResearchArtifact>
    archive(id: string, expectedRevision: number): Promise<void>
  }
  integrations: {
    list(): Promise<IntegrationProfile[]>
    save(input: SaveIntegrationProfileInput): Promise<IntegrationProfile>
    remove(id: string, expectedRevision: number): Promise<void>
    /** Archive connection *records* only in one CAS-locked transaction with
     * per-record receipts. It never touches the safeStorage credential, the
     * Obsidian Vault or Zotero's own database. */
    bulkRemove(input: ArchiveBulkInput): Promise<ArchiveBulkResult>
    /** Soft-archive one sync run (Settings → 最近同步) with a revision lock. The
     * audit row and every external system keep their state. */
    removeRun(id: string, expectedRevision: number): Promise<void>
    /** Soft-archive the selected sync runs in one CAS-locked transaction with
     * per-record receipts; connection secrets, links and external data are not
     * part of the command. */
    bulkRemoveRuns(input: ArchiveBulkInput): Promise<ArchiveBulkResult>
    test(id: string): Promise<{ ok: boolean; message: string }>
    sync(id: string, direction?: 'pull' | 'push' | 'both'): Promise<SyncRun>
    runs(profileId?: string): Promise<SyncRun[]>
    links(profileId?: string): Promise<ExternalLink[]>
  }
  prompts: {
    list(): Promise<PromptTemplate[]>
    save(input: SavePromptTemplateInput): Promise<PromptTemplate>
  }
  providers: {
    list(): Promise<AiProviderProfile[]>
    save(input: SaveAiProviderProfileInput): Promise<AiProviderProfile>
    remove(id: string, expectedRevision: number): Promise<void>
  }
  agents: {
    list(limit?: number): Promise<AgentRun[]>
    start(input: StartAgentRunInput): Promise<AgentRun>
    cancel(id: string): Promise<void>
  }
  schedules: {
    list(): Promise<Schedule[]>
    save(input: SaveScheduleInput): Promise<Schedule>
    remove(id: string, expectedRevision: number): Promise<void>
    run(id: string): Promise<AgentRun>
  }
  system: {
    health(): Promise<{ status: 'ok'; version: string }>
    openExternal(url: string): Promise<void>
  }
}
/** Explicit legacy name for callers that still migrate old AI data/routes. */
export type WorkbenchApiV1 = WorkbenchApiLegacy

/** Renderer-facing V2 API. No AI Provider/Prompt/Agent/Schedule/Job routes are
 * present; those routes are intentionally isolated in WorkbenchApiLegacy. */
export interface WorkbenchApiV2 {
  projects: {
    list(): Promise<Project[]>
    create(input: CreateProjectInput): Promise<Project>
    update(input: UpdateProjectInput): Promise<Project>
    archive(id: string, expectedRevision: number): Promise<void>
  }
  boards: {
    columns(projectId: string): Promise<BoardColumn[]>
  }
  tasks: {
    list(filter?: Partial<TaskListFilter>): Promise<Task[]>
    create(input: CreateTaskInput): Promise<Task>
    update(input: UpdateTaskInput): Promise<Task>
    move(input: MoveTaskInput): Promise<Task>
    archive(id: string, expectedRevision: number): Promise<void>
    restore(id: string, expectedRevision: number): Promise<void>
    hardDelete(input: HardDeleteTaskInput): Promise<import('./v2.js').HardDeleteTaskResult>
    bulkArchive(input: import('./v2.js').BulkTaskCommandInput): Promise<BulkOperationResult>
    bulkRestore(input: import('./v2.js').BulkTaskCommandInput): Promise<BulkOperationResult>
    bulkHardDelete(input: import('./v2.js').BulkHardDeleteTaskInput): Promise<BulkOperationResult>
  }
  todos: {
    capture(input: CreateTaskInput): Promise<Task>
  }
  progress: {
    project(projectId: string): Promise<ProjectProgress>
    dashboard(): Promise<DashboardSummary>
  }
  papers: {
    list(filter?: Partial<PaperListFilter>): Promise<Paper[]>
    create(input: CreatePaperInput): Promise<Paper>
    update(input: UpdatePaperInput): Promise<Paper>
    archive(id: string, expectedRevision: number): Promise<void>
    importFromZotero(input: PaperImportFromZoteroInput): Promise<PaperImportReceipt>
  }
  matrix: {
    list(projectId?: string | null): Promise<LiteratureMatrixEntry[]>
    upsert(input: UpsertLiteratureMatrixInput): Promise<LiteratureMatrixEntry>
    remove(input: RemoveLiteratureMatrixInput): Promise<void>
    bulkDelete(input: LiteratureMatrixBulkDeleteInput): Promise<LiteratureMatrixBulkDeleteResult>
  }
  artifacts: {
    list(filter?: { projectId?: string | null; kind?: ResearchArtifact['kind'] }): Promise<ResearchArtifact[]>
    create(input: CreateResearchArtifactInput): Promise<ResearchArtifact>
    update(input: UpdateResearchArtifactInput): Promise<ResearchArtifact>
    archive(id: string, expectedRevision: number): Promise<void>
  }
  integrations: {
    list(): Promise<IntegrationProfile[]>
    save(input: SaveIntegrationProfileInput): Promise<IntegrationProfile>
    remove(id: string, expectedRevision: number): Promise<void>
    /** Archive connection records only (see WorkbenchApiV1.integrations). */
    bulkRemove(input: ArchiveBulkInput): Promise<ArchiveBulkResult>
    /** See WorkbenchApiV1.integrations.removeRun. */
    removeRun(id: string, expectedRevision: number): Promise<void>
    /** See WorkbenchApiV1.integrations.bulkRemoveRuns. */
    bulkRemoveRuns(input: ArchiveBulkInput): Promise<ArchiveBulkResult>
    test(id: string): Promise<{ ok: boolean; message: string }>
    sync(id: string, direction: 'pull' | 'push'): Promise<SyncRun>
    runs(profileId?: string): Promise<SyncRun[]>
    links(profileId?: string): Promise<ExternalLink[]>
  }
  resourceLinks: {
    list(resource?: import('./v2.js').ResourceRef): Promise<ResourceLink[]>
    create(input: import('./v2.js').CreateResourceLinkInput): Promise<ResourceLink>
    remove(input: { id: string }): Promise<void>
  }
  calendar: {
    list(input: CalendarRangeInput): Promise<CalendarEvent[]>
    create(input: import('./v2.js').CreateCalendarEventInput): Promise<CalendarEvent>
    update(input: import('./v2.js').UpdateCalendarEventInput): Promise<CalendarEvent>
    remove(id: string, expectedRevision: number): Promise<void>
    markers: {
      list(input: import('./v2.js').CalendarMarkerRangeInput): Promise<import('./v2.js').CalendarMarker[]>
      create(input: import('./v2.js').CreateCalendarMarkerInput): Promise<import('./v2.js').CalendarMarker>
      update(input: import('./v2.js').UpdateCalendarMarkerInput): Promise<import('./v2.js').CalendarMarker>
      remove(id: string, expectedRevision: number): Promise<void>
    }
  }
  literature: {
    search(input: import('./v2.js').SearchInput): Promise<{ session: import('./v2.js').SearchSession; results: import('./v2.js').SearchResult[] }>
    sessions(): Promise<import('./v2.js').SearchSession[]>
    clearSession(input: LiteratureClearSessionInput): Promise<LiteratureClearSessionReceipt>
    /** @deprecated Compatibility-only array helper; use resultsPage. */
    results(sessionId: string): Promise<import('./v2.js').SearchResult[]>
    resultsPage(input: LiteratureResultsInput): Promise<SearchResultPage>
    staging: {
      page(input: LiteratureStagingPageInput): Promise<LiteratureStagingPage>
      save(input: LiteratureStagingSaveInput): Promise<LiteratureStagingRecord>
      delete(input: LiteratureStagingDeleteInput): Promise<LiteratureStagingDeleteReceipt>
      bulkDelete(input: LiteratureStagingBulkDeleteInput): Promise<LiteratureStagingBulkDeleteResult>
    }
    stagingToZotero: {
      preview(input: LiteratureStagingToZoteroPreviewInput): Promise<LiteratureStagingToZoteroPreview>
      execute(input: LiteratureStagingToZoteroExecuteInput): Promise<LiteratureStagingToZoteroResult>
    }
    batch: {
      preview(input: LiteratureBatchPreviewInput): Promise<LiteratureBatchPreview>
      execute(input: LiteratureBatchExecuteInput): Promise<LiteratureBatchResult>
      cancel(input: LiteratureBatchCancelInput): Promise<LiteratureBatchCancelReceipt>
      retry(input: LiteratureBatchRetryInput): Promise<LiteratureBatchResult>
    }
    importResult(input: LiteratureBatchImportResultInput): Promise<PaperImportReceipt>
    scholar: {
      status(): Promise<ScholarWorkspaceStatus>
    }
  }
  obsidian: {
    indexStatus(input: ObsidianIndexStatusInput): Promise<ObsidianIndexStatus>
    layout: {
      preview(input: ObsidianLayoutPreviewInput): Promise<ObsidianLayoutPlan>
      initialize(input: ObsidianLayoutInitializeInput): Promise<ObsidianLayoutReceipt>
    }
    vaultLayout: {
      preview(input: ObsidianVaultLayoutPreviewInput): Promise<ObsidianVaultLayoutPlan>
      initialize(input: ObsidianVaultLayoutInitializeInput): Promise<ObsidianVaultLayoutReceipt>
    }
  }
  notes: {
    list(input: import('./v2.js').NoteListInput): Promise<import('./v2.js').Note[]>
    read(input: import('./v2.js').ReadNoteInput): Promise<import('./v2.js').Note>
    write(input: import('./v2.js').WriteNoteInput): Promise<import('./v2.js').Note>
    delete(input: import('./v2.js').DeleteNoteInput): Promise<import('./v2.js').NoteDeleteReceipt>
    deleteFolder(input: import('./v2.js').DeleteNoteFolderInput): Promise<import('./v2.js').NoteFolderDeleteReceipt>
    createFolder(input: import('./v2.js').CreateNoteFolderInput): Promise<import('./v2.js').NoteFolderCreateReceipt>
    move(input: import('./v2.js').MoveNoteInput): Promise<import('./v2.js').NoteMoveReceipt>
    /** Preview the controlled frontmatter change without writing anything. */
    previewMetadata(input: import('./v2.js').NoteMetadataPreviewInput): Promise<import('./v2.js').NoteMetadataPreview>
    /** Apply a previewed frontmatter change; requires the previewed fingerprint. */
    applyMetadata(input: import('./v2.js').ApplyNoteMetadataInput): Promise<import('./v2.js').Note>
    /** Conservative duplicate probe used before importing a note. */
    duplicates(input: import('./v2.js').NoteDuplicateInput): Promise<import('./v2.js').NoteDuplicateReport>
  }
  zotero: {
    capability(profileId: string): Promise<ZoteroCapabilityStatus>
    authorize(input: import('./v2.js').ZoteroAuthorizeInput): Promise<import('./v2.js').ZoteroAuthorizeResult>
    /** @deprecated Compatibility-only array helper; use collectionsPage. */
    collections(profileId: string): Promise<import('./v2.js').ZoteroCollection[]>
    collectionsPage(input: import('./v2.js').ZoteroCollectionPageInput): Promise<ZoteroCollectionPage>
    /** @deprecated Compatibility-only array helper; use itemsPage. */
    items(profileId: string, collectionKey?: string): Promise<import('./v2.js').ZoteroItem[]>
    itemsPage(input: import('./v2.js').ZoteroItemPageInput): Promise<ZoteroItemPage>
    bibtexExport(input: import('./v2.js').ZoteroBibtexExportInput): Promise<ZoteroBibtexExport>
    import(input: { profileId: string; itemKey: string; projectId: string | null }): Promise<Paper>
    importSelected: {
      preview(input: import('./v2.js').ZoteroImportPreviewInput): Promise<ZoteroImportPreview>
      execute(input: import('./v2.js').ZoteroImportExecuteInput): Promise<ZoteroImportResult>
    }
    paperToZotero: {
      preview(input: import('./v2.js').PaperToZoteroPreviewInput): Promise<PaperToZoteroPreview>
      execute(input: import('./v2.js').PaperToZoteroExecuteInput): Promise<ZoteroImportResult>
    }
    /**
     * Two-sided Zotero deletion: preview freezes the remote revision of every
     * selected item, execute re-checks the frozen values and only removes the
     * local projection for items Zotero confirmed as deleted (or absent).
     */
    deleteRemote: {
      preview(input: import('./v2.js').ZoteroRemoteDeletePreviewInput): Promise<import('./v2.js').ZoteroRemoteDeletePreview>
      execute(input: import('./v2.js').ZoteroRemoteDeleteExecuteInput): Promise<import('./v2.js').ZoteroRemoteDeleteReceipt>
    }
  }
  knowledge: {
    engines: {
      list(): Promise<KnowledgeEngineConfig[]>
      save(input: KnowledgeEngineSaveInput): Promise<KnowledgeEngineConfig>
      test(input: KnowledgeEngineTestInput): Promise<KnowledgeEngineTestResult>
    }
  }
  intelDaily: {
    getConfig(): Promise<IntelDailyConfig>
    setConfig(input: IntelDailySetConfigInput): Promise<IntelDailyConfig>
    overview(): Promise<IntelDailyOverview>
  }
  feishu: {
    saveApp(input: FeishuSaveAppInput): Promise<FeishuBindingStatus>
    getStatus(): Promise<FeishuBindingStatus>
    beginBind(input: FeishuBeginBindInput): Promise<FeishuBeginBindResult>
    unbind(): Promise<FeishuBindingStatus>
    sendTest(): Promise<FeishuSendTestResult>
  }
  rss: {
    sources: {
      list(): Promise<RssSourceList>
      preview(input: RssSourcePreviewInput): Promise<RssSourcePreview>
      save(input: RssSaveSourceInput): Promise<RssSource>
      remove(input: RssSourceDeleteInput): Promise<void>
      setEnabled(input: RssSourceSetEnabledInput): Promise<RssSource>
      setDisplayEnabled(input: RssSourceSetDisplayEnabledInput): Promise<RssSource>
      query(input: RssItemsQueryInput): Promise<RssItemsPage>
      refresh(input: RssItemsRefreshInput): Promise<RssItemsRefreshResult>
    }
    categories: {
      list(): Promise<RssCategoryList>
      save(input: RssCategorySaveInput): Promise<RssCategory>
      remove(input: RssCategoryDeleteInput): Promise<void>
    }
  }
  workspace: {
    status(): Promise<WorkspaceServiceStatus>
  }
  system: {
    health(): Promise<{ status: 'ok'; version: string }>
    openExternal(url: string): Promise<void>
    selectFolder(): Promise<string | null>
    revealPath(input: import('./v2.js').SystemRevealPathInput): Promise<void>
    saveTextFile(input: import('./v2.js').SystemSaveTextFileInput): Promise<import('./v2.js').SystemSaveTextFileResult>
  }
  updates: {
    state(): Promise<UpdateState>
    check(): Promise<UpdateState>
    download(): Promise<UpdateState>
    install(): Promise<void>
    onState(listener: (state: UpdateState) => void): () => void
  }
}

/* Keep these aliases available to code that imports the DTO names directly. */
export type { ContextMenuTarget, DateRange, ExternalWriteError, WorkspaceTab }

export interface ProviderRef {
  provider: 'obsidian' | 'zotero' | 'notion'
  accountId: string
  externalId: string
  locator?: string
}

export interface IntegrationAdapter {
  probe(): Promise<Record<string, boolean>>
  authorize(): Promise<{ connected: boolean; accountId?: string }>
  pull(cursor?: string): Promise<{ cursor: string; changes: unknown[] }>
  get(ref: ProviderRef): Promise<unknown>
  patch(ref: ProviderRef, patch: unknown, expectedRevision?: string): Promise<unknown>
  openTarget(ref: ProviderRef): Promise<void>
}

export interface AiProviderAdapter {
  id: AiProviderId
  api: AiApi
  capabilities(): Promise<Array<'generate' | 'stream' | 'embed' | 'web_search'>>
  generate(input: unknown, signal?: AbortSignal): Promise<unknown>
}

export interface AgentRuntime {
  start(workflowKey: string, input: unknown): Promise<{ runId: string }>
  cancel(runId: string): Promise<void>
  resume(runId: string, input?: unknown): Promise<void>
}
