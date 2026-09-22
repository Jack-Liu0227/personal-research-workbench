import {
  ArtifactKindSchema,
  CalendarRangeInputSchema,
  CalendarMarkerRangeInputSchema,
  CreateCalendarMarkerInputSchema,
  UpdateCalendarMarkerInputSchema,
  CreateCalendarEventInputSchema,
  CreatePaperInputSchema,
  CreateProjectInputSchema,
  CreateResearchArtifactInputSchema,
  CreateTaskInputSchema,
  NoteListInputSchema,
  DeleteNoteInputSchema,
  DeleteNoteFolderInputSchema,
  CreateNoteFolderInputSchema,
  MoveNoteInputSchema,
  NoteMetadataPreviewInputSchema,
  ApplyNoteMetadataInputSchema,
  NoteDuplicateInputSchema,
  ReadNoteInputSchema,
  SearchInputSchema,
  WriteNoteInputSchema,
  MoveTaskInputSchema,
  PaperListFilterSchema,
  RpcRequestSchema,
  SaveIntegrationProfileInputSchema,
  UpdateCalendarEventInputSchema,
  TaskListFilterSchema,
  UpdatePaperInputSchema,
  UpdateProjectInputSchema,
  UpdateResearchArtifactInputSchema,
  UpdateTaskInputSchema,
  UpsertLiteratureMatrixInputSchema,
  RemoveLiteratureMatrixInputSchema,
  LiteratureMatrixBulkDeleteInputSchema,
  ArchiveBulkInputSchema,
  ArchiveTaskInputSchema,
  RestoreTaskInputSchema,
  HardDeleteTaskInputSchema,
  BulkTaskCommandInputSchema,
  BulkHardDeleteTaskInputSchema,
  CreateResourceLinkInputSchema,
  ResourceLinkListInputSchema,
  RemoveResourceLinkInputSchema,
  IdSchema,
  ProjectIdSchema,
  PaperIdSchema,
  RpcResponseSchema,
  RpcMethodResultSchemas,
  LiteratureBatchPreviewInputSchema,
  LiteratureBatchExecuteInputSchema,
  LiteratureBatchCancelInputSchema,
  LiteratureBatchRetryInputSchema,
  LiteratureBatchImportResultInputSchema,
  ZoteroCapabilityInputSchema,
  ZoteroAuthorizeInputSchema,
  ZoteroCollectionPageInputSchema,
  ZoteroItemPageInputSchema,
  ZoteroBibtexExportInputSchema,
  ZoteroImportInputSchema,
  ZoteroImportPreviewInputSchema,
  ZoteroImportExecuteInputSchema,
  PaperToZoteroPreviewInputSchema,
  PaperToZoteroExecuteInputSchema,
  ZoteroRemoteDeletePreviewInputSchema,
  ZoteroRemoteDeleteExecuteInputSchema,
  PaperImportFromZoteroInputSchema,
  ObsidianIndexStatusInputSchema,
  ObsidianLayoutPreviewInputSchema,
  ObsidianLayoutInitializeInputSchema,
  ObsidianVaultLayoutPreviewInputSchema,
  ObsidianVaultLayoutInitializeInputSchema,
  ObsidianLayoutErrorSchema,
  ScholarStatusInputSchema,
  LiteratureClearSessionInputSchema,
  LiteratureResultsInputSchema,
  LiteratureStagingPageInputSchema,
  LiteratureStagingSaveInputSchema,
  LiteratureStagingDeleteInputSchema,
  LiteratureStagingBulkDeleteInputSchema,
  LiteratureStagingToZoteroPreviewInputSchema,
  LiteratureStagingToZoteroExecuteInputSchema,
  KnowledgeEngineSaveInputSchema,
  KnowledgeEngineTestInputSchema,
  IntelDailySetConfigInputSchema,
  RssSourcePreviewInputSchema,
  RssCategorySaveInputSchema,
  RssCategoryDeleteInputSchema,
  RssSaveSourceInputSchema,
  RssSourceDeleteInputSchema,
  RssSourceSetEnabledInputSchema,
  RssSourceSetDisplayEnabledInputSchema,
  RssItemsQueryInputSchema,
  RssItemsRefreshInputSchema,
  RssItemsRefreshResultSchema,
  type RpcRequest,
  type RpcResponse,
  type BulkOperationResult,
  type BulkTaskCommandInput
} from '@prw/contracts'
import type { WorkbenchRepository } from '@prw/database'
import { z } from 'zod'
import { fetchRssSources, previewRssFeed } from './rss-feed.js'
import {
  buildDailyPushCalendarEvents,
  dailyPushRunOutcome,
  isCalendarVirtualId,
  mergeCalendarEvents,
  type DailyPushRunOutcome
} from './calendar-daily-push.js'
import { normalizeAppError } from './errors.js'
import { IntegrationRuntimeError } from '@prw/connectors'
import type { IntegrationCoordinator } from './integration-runtime.js'
import type { LiteratureCoordinator } from './literature-runtime.js'
import type { AgentExternalActionContext, AgentExternalActionCoordinator } from './agent-external-actions.js'
import type { KnowledgeEngineCoordinator } from './knowledge-engines.js'
import type { IntelDailyCoordinator } from './intel-daily.js'
import { ObsidianLayoutError } from './obsidian-layout.js'

const ProjectIdInputSchema = z.object({ projectId: ProjectIdSchema })
const OptionalProjectInputSchema = z.object({ projectId: ProjectIdSchema.nullable().optional() })
const OptionalProfileInputSchema = z.object({ profileId: IdSchema.optional() })
const EntityRevisionSchema = z.object({ id: IdSchema, expectedRevision: z.int().nonnegative() })
const ProjectRevisionSchema = z.object({ id: ProjectIdSchema, expectedRevision: z.int().nonnegative() })
const PaperRevisionSchema = z.object({ id: PaperIdSchema, expectedRevision: z.int().nonnegative() })
const ArtifactListInputSchema = z.object({ projectId: IdSchema.nullable().optional(), kind: ArtifactKindSchema.optional() })

/**
 * `zotero.authorize` is a Main-only credential hand-off.  The public
 * Renderer contract intentionally exposes only `{ authorized, remember }`,
 * while Core must return the freshly issued key to Main so Main can put it in
 * safeStorage.  Keep this bridge shape private to the trusted Core transport;
 * never add the key to `RpcMethodResultSchemas` or the preload API.
 */
const ZoteroAuthorizationBridgeResultSchema = z.strictObject({
  profileId: IdSchema,
  key: z.string().trim().min(1).max(20_000),
  remember: z.boolean()
})

/**
 * `credential` is Main's private transport input, never part of the public
 * integrations.save payload accepted by Core. Keep this schema strict so a
 * secret cannot be smuggled through the nested public request.
 */
const PublicSaveIntegrationProfileInputSchema = SaveIntegrationProfileInputSchema
  .omit({ credential: true })
  .strict()

/**
 * Main/Core's private credential transport.  This is deliberately not part
 * of RpcRequestSchema: the public V2 request remains a strict, method-specific
 * Renderer contract while Main wraps it only for the approved integration
 * calls that need a safeStorage credential.
 */
export const CredentialEnvelopeSchema = z.strictObject({
  type: z.literal('prw.rpc-with-credential'),
  request: RpcRequestSchema,
  credential: z.strictObject({
    profileId: IdSchema,
    secret: z.string().nullable()
  })
})
export type CredentialEnvelope = z.infer<typeof CredentialEnvelopeSchema>
export type CredentialContext = CredentialEnvelope['credential']

const CredentialBearingMethods = new Set<RpcRequest['method']>([
  'integrations.save',
  'integrations.test',
  'integrations.sync',
  'zotero.capability',
  'zotero.authorize',
  'zotero.collectionsPage',
  'zotero.collections',
  'zotero.itemsPage',
  'zotero.bibtexExport',
  'zotero.items',
  'zotero.import',
  'zotero.importSelected.preview',
  'zotero.importSelected.execute',
  'zotero.paperToZotero.preview',
  'zotero.paperToZotero.execute',
  'papers.importFromZotero',
  'literature.stagingToZotero.preview',
  'literature.stagingToZotero.execute'
  , 'knowledge.engines.save', 'knowledge.engines.test'
])

interface DispatchInput {
  readonly request: RpcRequest
  readonly credential?: CredentialContext
}

/** V2 CRUD services remain isolated from the Agent dispatcher; Agent RPC is
 * routed through a separate validated method family by the host. */
export interface CoreServices {
  readonly repository: WorkbenchRepository
  readonly integrations: IntegrationCoordinator
  readonly literature: LiteratureCoordinator
  readonly knowledgeEngines: KnowledgeEngineCoordinator
  readonly intelDaily: IntelDailyCoordinator
  /** Pending-approval store for Agent-driven external writes. Optional because
   * the Core test harness builds a service set without one; the request methods
   * fail closed when it is missing. */
  readonly externalActions?: AgentExternalActionCoordinator
}
export interface CoreMetadata { readonly version: string }

/**
 * Which Agent run a request belongs to.
 *
 * Core binds this, never the caller: the model can name a profile but must not
 * be able to name the run an approval belongs to. Absent means "no Agent run",
 * which makes every external-write request fail closed.
 */
export interface AgentCallContext {
  readonly runId: string
  /** Read one integration secret for this single in-process MCP call. */
  readonly readIntegrationSecret?: ((profileId: string) => Promise<string | null>) | undefined
}

export async function dispatchRpc(services: CoreServices, metadata: CoreMetadata, input: unknown, context?: AgentCallContext): Promise<RpcResponse> {
  let requestId = 'invalid-request'
  let secret: string | null | undefined
  try {
    const parsed = parseDispatchInput(input)
    requestId = parsed.request.id
    secret = parsed.credential?.secret
    const data = await execute(services, metadata, parsed.request, parsed.credential, context)
    const resultSchema = parsed.request.method === 'zotero.authorize'
      ? ZoteroAuthorizationBridgeResultSchema
      : parsed.request.method in RpcMethodResultSchemas
        ? RpcMethodResultSchemas[parsed.request.method as keyof typeof RpcMethodResultSchemas]
        : undefined
    const validated = resultSchema === undefined ? data : resultSchema.parse(data)
    const safeData = secret ? redactSecretValue(validated, secret) : validated
    return RpcResponseSchema.parse({ id: parsed.request.id, ok: true, data: safeData })
  } catch (error) {
    const appError = error instanceof ObsidianLayoutError ? mapObsidianLayoutError(error) : normalizeAppError(error)
    return { id: requestId, ok: false, error: redactCredential(appError, secret) }
  }
}

/**
 * Resolve the pending-approval store, or refuse the write.
 *
 * Both halves matter. Without the store there is nowhere to record the decision
 * the user has not made yet, and without a bound run the approval could not be
 * attributed or shown. Either way the honest answer is "no", not a direct write.
 */
function requireExternalActions(
  services: CoreServices,
  context: AgentCallContext | undefined
): { readonly external: AgentExternalActionCoordinator; readonly context: AgentExternalActionContext } {
  const external = services.externalActions
  if (external === undefined || context === undefined) {
    throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', '外部写入需要用户确认通道，当前请求没有绑定 Agent run。')
  }
  return { external, context }
}

function mapObsidianLayoutError(error: ObsidianLayoutError): import('@prw/contracts').AppError {
  const requiresConfirmation = error.code === 'CONFIRMATION_REQUIRED' || error.code === 'COLLISION_CHOICE_REQUIRED'
  return ObsidianLayoutErrorSchema.parse({
    code: error.code,
    message: redactLayoutErrorMessage(error.message),
    retryable: false,
    requiresConfirmation,
    partial: false
  })
}

function redactLayoutErrorMessage(value: string): string {
  const redacted = value
    .replace(/[A-Za-z]:[\\/][^\s)]+/gu, '[redacted path]')
    .replace(/\\\\[^\s)]+/gu, '[redacted path]')
    .replace(/(?:^|\s)\/(?:[^\s/]+\/)+[^\s)]*/gu, ' [redacted path]')
    .replace(/Bearer\s+[^\s]+/giu, 'Bearer [redacted]')
    .replace(/(?:token|api[_-]?key)=[^\s]+/giu, '$1=[redacted]')
    .trim()
  return (redacted || 'Obsidian operation failed.').slice(0, 500)
}

function parseDispatchInput(input: unknown): DispatchInput {
  if (isRecord(input) && Object.hasOwn(input, 'type')) {
    const envelope = CredentialEnvelopeSchema.parse(input)
    const request = envelope.request
    validateCredentialEnvelope(request, envelope.credential)
    return { request, credential: envelope.credential }
  }
  return { request: RpcRequestSchema.parse(input) }
}

function validateCredentialEnvelope(request: RpcRequest, credential: CredentialContext): void {
  if (!CredentialBearingMethods.has(request.method)) {
    throw namedValidationError('Credentials are not accepted for this RPC method.')
  }

  const payload = request.payload
  const profileId = request.method === 'integrations.save' || request.method === 'integrations.test' || request.method === 'integrations.sync'
    ? isRecord(payload) && typeof payload.id === 'string' ? payload.id : undefined
    : request.method === 'knowledge.engines.save' || request.method === 'knowledge.engines.test'
      ? isRecord(payload) && typeof payload.kind === 'string' ? payload.kind : undefined
    : request.method === 'zotero.importSelected.execute' || request.method === 'zotero.paperToZotero.execute' || request.method === 'literature.stagingToZotero.execute'
      ? undefined
      : isRecord(payload) && 'profileId' in payload
        ? payload.profileId
        : undefined

  if (profileId !== undefined && profileId !== credential.profileId) {
    throw namedValidationError('Credential profile does not match the RPC profile.')
  }
}

function namedValidationError(message: string): Error {
  const error = new Error(message)
  error.name = 'VALIDATION_FAILED'
  return error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function redactCredential<T extends { message: string; details?: unknown }>(error: T, secret: string | null | undefined): T {
  if (!secret) return error
  const redactString = (value: string): string => value.split(secret).join('[redacted]')
  const redactedMessage = redactString(error.message)
  if (!('details' in error) || error.details === undefined) {
    return redactedMessage === error.message ? error : { ...error, message: redactedMessage }
  }
  return { ...error, message: redactedMessage, details: redactSecretValue(error.details, secret) }
}

export function redactSecretValue(value: unknown, secret: string): unknown {
  if (typeof value === 'string') return value.split(secret).join('[redacted]')
  if (Array.isArray(value)) return value.map((entry) => redactSecretValue(entry, secret))
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactSecretValue(entry, secret)]))
  return value
}

async function execute(services: CoreServices, metadata: CoreMetadata, request: RpcRequest, credential?: CredentialContext, context?: AgentCallContext): Promise<unknown> {
  const repository = services.repository
  switch (request.method) {
    case 'projects.list': z.null().parse(request.payload); return repository.listProjects()
    case 'projects.create': return repository.createProject(CreateProjectInputSchema.parse(request.payload))
    case 'projects.update': return repository.updateProject(UpdateProjectInputSchema.parse(request.payload))
    case 'projects.archive': { const p = ProjectRevisionSchema.parse(request.payload); repository.archiveProject(p.id, p.expectedRevision); return null }
    case 'boards.columns': return repository.listBoardColumns(ProjectIdInputSchema.parse(request.payload).projectId)

    case 'tasks.list': return repository.listTasks(normalizeTaskFilter(TaskListFilterSchema.parse(request.payload)))
    case 'tasks.create': return repository.createTask(CreateTaskInputSchema.parse(request.payload))
    case 'todos.capture': return repository.createTask({ ...CreateTaskInputSchema.parse(request.payload), projectId: null, columnId: null })
    case 'tasks.update': return repository.updateTask(UpdateTaskInputSchema.parse(request.payload))
    case 'tasks.move': return repository.moveTask(MoveTaskInputSchema.parse(request.payload))
    case 'tasks.archive': { const p = ArchiveTaskInputSchema.parse(request.payload); repository.archiveTask(p.id, p.expectedRevision); return null }
    case 'tasks.restore': { const p = RestoreTaskInputSchema.parse(request.payload); return repository.restoreTask(p.id, p.expectedRevision) }
    case 'tasks.hardDelete': return repository.hardDeleteTask(HardDeleteTaskInputSchema.parse(request.payload))
    case 'tasks.bulkArchive': { const p = BulkTaskCommandInputSchema.parse(request.payload); validateTaskSelection(p); return bulkTaskCommand(repository, p, 'archive') }
    case 'tasks.bulkRestore': { const p = BulkTaskCommandInputSchema.parse(request.payload); validateTaskSelection(p); return bulkTaskCommand(repository, p, 'restore') }
    case 'tasks.bulkHardDelete': { const p = BulkHardDeleteTaskInputSchema.parse(request.payload); validateTaskSelection(p); return repository.bulkHardDeleteTasks(p) }
    case 'progress.project': return repository.getProjectProgress(ProjectIdInputSchema.parse(request.payload).projectId)
    case 'progress.dashboard': z.null().parse(request.payload); return repository.getDashboardSummary()

    case 'papers.list': return repository.listPapers(PaperListFilterSchema.parse(request.payload))
    case 'papers.create': return repository.createPaper(CreatePaperInputSchema.parse(request.payload))
    case 'papers.update': return repository.updatePaper(UpdatePaperInputSchema.parse(request.payload))
    case 'papers.archive': { const p = PaperRevisionSchema.parse(request.payload); repository.archivePaper(p.id, p.expectedRevision); return null }
    case 'matrix.list': return repository.listLiteratureMatrix(OptionalProjectInputSchema.parse(request.payload).projectId)
    case 'matrix.upsert': return repository.upsertLiteratureMatrix(UpsertLiteratureMatrixInputSchema.parse(request.payload))
    case 'matrix.remove': repository.removeLiteratureMatrix(RemoveLiteratureMatrixInputSchema.parse(request.payload)); return null
    case 'matrix.bulkDelete': return repository.bulkDeleteLiteratureMatrix(LiteratureMatrixBulkDeleteInputSchema.parse(request.payload))
    case 'artifacts.list': { const p = ArtifactListInputSchema.parse(request.payload); return repository.listResearchArtifacts({ ...(p.projectId === undefined ? {} : { projectId: p.projectId }), ...(p.kind === undefined ? {} : { kind: p.kind }) }) }
    case 'artifacts.create': return repository.createResearchArtifact(CreateResearchArtifactInputSchema.parse(request.payload))
    case 'artifacts.update': return repository.updateResearchArtifact(UpdateResearchArtifactInputSchema.parse(request.payload))
    case 'artifacts.archive': { const p = EntityRevisionSchema.parse(request.payload); repository.archiveResearchArtifact(p.id, p.expectedRevision); return null }
    case 'resourceLinks.list': return repository.listResourceLinks(ResourceLinkListInputSchema.parse(request.payload).resource)
    case 'resourceLinks.create': return repository.createResourceLink(CreateResourceLinkInputSchema.parse(request.payload))
    case 'resourceLinks.remove': repository.removeResourceLink(RemoveResourceLinkInputSchema.parse(request.payload).id); return null

    case 'integrations.list': z.null().parse(request.payload); return repository.listIntegrationProfiles()
    case 'integrations.save': {
      const payload = PublicSaveIntegrationProfileInputSchema.parse(request.payload)
      const credentialPresent = credential !== undefined && credential.secret !== null
      return repository.saveIntegrationProfile(payload, credentialPresent)
    }
    case 'integrations.remove': { const p = EntityRevisionSchema.parse(request.payload); repository.removeIntegrationProfile(p.id, p.expectedRevision); return null }
    // Record-only bulk archive. It deliberately takes no credential context: the
    // safeStorage secret belongs to Main and is not part of a Core transaction.
    case 'integrations.bulkRemove': return repository.bulkRemoveIntegrationProfiles(ArchiveBulkInputSchema.parse(request.payload))
    // Settings → 最近同步: sync runs are soft-archived audit rows. Same record-only
    // rule as above — no credential context, no cascade into external data.
    case 'integrations.removeRun': { const p = EntityRevisionSchema.parse(request.payload); repository.removeSyncRun(p.id, p.expectedRevision); return null }
    case 'integrations.bulkRemoveRuns': return repository.bulkRemoveSyncRuns(ArchiveBulkInputSchema.parse(request.payload))
    case 'integrations.test': { const p = z.object({ id: IdSchema }).parse(request.payload); return services.integrations.test({ id: p.id, secret: credential?.secret ?? null }) }
    case 'integrations.sync': { const p = z.object({ id: IdSchema, direction: z.enum(['pull', 'push']) }).parse(request.payload); return services.integrations.sync({ ...p, secret: credential?.secret ?? null }) }
    case 'integrations.runs': return repository.listSyncRuns(OptionalProfileInputSchema.parse(request.payload).profileId)
    case 'integrations.links': return repository.listExternalLinks(OptionalProfileInputSchema.parse(request.payload).profileId)

    case 'calendar.list': {
      const range = normalizeCalendarRange(CalendarRangeInputSchema.parse(request.payload))
      // Stored rows first, then the read-only daily-push projection built from
      // the schedule/occurrence rows and the run ledger. Both halves are sorted
      // with the same comparator, so the merged list keeps one ordering.
      return mergeCalendarEvents(repository.listCalendarEvents(range), dailyPushCalendarEvents(repository, range))
    }
    case 'calendar.create': { const p = CreateCalendarEventInputSchema.parse(request.payload); validateCalendarRelations(repository, p); return repository.createCalendarEvent(normalizeCalendarCreate(p)) }
    case 'calendar.update': { const p = UpdateCalendarEventInputSchema.parse(request.payload); rejectVirtualCalendarId(p.id); validateCalendarRelations(repository, p); return repository.updateCalendarEvent(normalizeCalendarUpdate(p)) }
    case 'calendar.remove': { const p = EntityRevisionSchema.parse(request.payload); rejectVirtualCalendarId(p.id); repository.removeCalendarEvent(p.id, p.expectedRevision); return null }
    case 'calendar.markers.list': return repository.listCalendarMarkers(CalendarMarkerRangeInputSchema.parse(request.payload))
    case 'calendar.markers.create': return repository.createCalendarMarker(CreateCalendarMarkerInputSchema.parse(request.payload))
    case 'calendar.markers.update': return repository.updateCalendarMarker(UpdateCalendarMarkerInputSchema.parse(request.payload))
    case 'calendar.markers.remove': { const p = EntityRevisionSchema.parse(request.payload); repository.removeCalendarMarker(p.id, p.expectedRevision); return null }

    case 'literature.search': return services.literature.search(SearchInputSchema.parse(request.payload))
    case 'literature.sessions': z.null().parse(request.payload); return services.literature.listSessions()
    case 'literature.clearSession': return services.literature.clearSession(LiteratureClearSessionInputSchema.parse(request.payload))
    case 'literature.resultsPage': return services.literature.loadResultsPage(LiteratureResultsInputSchema.parse(request.payload))
    case 'literature.results': {
      const page = services.literature.resultsPage(LiteratureResultsInputSchema.parse(request.payload))
      return page.items
    }
    case 'literature.staging.page': return services.literature.listStaging(LiteratureStagingPageInputSchema.parse(request.payload))
    case 'literature.staging.save': return services.literature.saveStaging(LiteratureStagingSaveInputSchema.parse(request.payload))
    case 'literature.staging.delete': return services.literature.deleteStaging(LiteratureStagingDeleteInputSchema.parse(request.payload))
    case 'literature.staging.bulkDelete': return services.literature.bulkDeleteStaging(LiteratureStagingBulkDeleteInputSchema.parse(request.payload))
    case 'literature.stagingToZotero.preview': {
      const input = LiteratureStagingToZoteroPreviewInputSchema.parse(request.payload)
      return services.literature.previewStagingToZotero(input, services.integrations, credential?.secret ?? await context?.readIntegrationSecret?.(input.profileId) ?? null)
    }
    case 'literature.stagingToZotero.execute': return services.literature.executeStagingToZotero(LiteratureStagingToZoteroExecuteInputSchema.parse(request.payload), services.integrations, credential?.secret ?? null, credential?.profileId)
    case 'literature.batch.preview': return services.literature.previewBatch(LiteratureBatchPreviewInputSchema.parse(request.payload))
    case 'literature.batch.execute': return services.literature.executeBatch(LiteratureBatchExecuteInputSchema.parse(request.payload))
    case 'literature.batch.cancel': return services.literature.cancelBatch(LiteratureBatchCancelInputSchema.parse(request.payload))
    case 'literature.batch.retry': return services.literature.retryBatch(LiteratureBatchRetryInputSchema.parse(request.payload))
    case 'literature.importResult': return services.literature.importResult(LiteratureBatchImportResultInputSchema.parse(request.payload))
    case 'literature.scholar.status': {
      ScholarStatusInputSchema.parse(request.payload)
      return scholarWorkspaceStatus()
    }
    case 'obsidian.indexStatus': return services.integrations.obsidianIndexStatus(ObsidianIndexStatusInputSchema.parse(request.payload).profileId)
    case 'obsidian.layout.preview': return services.integrations.previewObsidianLayout(ObsidianLayoutPreviewInputSchema.parse(request.payload))
    case 'obsidian.layout.initialize': return services.integrations.initializeObsidianLayout(ObsidianLayoutInitializeInputSchema.parse(request.payload))
    case 'obsidian.vaultLayout.preview': {
      const input = ObsidianVaultLayoutPreviewInputSchema.parse(request.payload)
      return services.integrations.previewObsidianVaultLayout(
        input.categories === undefined ? { profileId: input.profileId } : { profileId: input.profileId, categories: input.categories }
      )
    }
    case 'obsidian.vaultLayout.initialize': return services.integrations.initializeObsidianVaultLayout(ObsidianVaultLayoutInitializeInputSchema.parse(request.payload))
    case 'notes.list': return services.integrations.listNotes(NoteListInputSchema.parse(request.payload))
    case 'notes.read': return services.integrations.readNote(ReadNoteInputSchema.parse(request.payload))
    // Agent-requested writes. The preview runs here, then the frozen payload
    // waits in `agent_external_actions` for the user: `execute` is deliberately
    // not reachable from the model, so this is as far as a tool call can go.
    case 'notes.write.request': {
      const bound = requireExternalActions(services, context)
      return bound.external.requestNoteWrite(request.payload, bound.context)
    }
    case 'notes.metadata.request': {
      const bound = requireExternalActions(services, context)
      return bound.external.requestNoteMetadata(request.payload, bound.context)
    }
    case 'notes.write': return services.integrations.writeNote(WriteNoteInputSchema.parse(request.payload))
    case 'notes.delete': return services.integrations.deleteNote(DeleteNoteInputSchema.parse(request.payload))
    case 'notes.deleteFolder': return services.integrations.deleteNoteFolder(DeleteNoteFolderInputSchema.parse(request.payload))
    case 'notes.createFolder': return services.integrations.createNoteFolder(CreateNoteFolderInputSchema.parse(request.payload))
    case 'notes.move': return services.integrations.moveNote(MoveNoteInputSchema.parse(request.payload))
    case 'notes.metadata.preview': return services.integrations.previewNoteMetadata(NoteMetadataPreviewInputSchema.parse(request.payload))
    case 'notes.metadata.apply': return services.integrations.applyNoteMetadata(ApplyNoteMetadataInputSchema.parse(request.payload))
    case 'notes.duplicates': return services.integrations.noteDuplicates(NoteDuplicateInputSchema.parse(request.payload))
    case 'zotero.capability': {
      const input = ZoteroCapabilityInputSchema.parse(request.payload)
      return services.integrations.zoteroCapability(input.profileId, credential?.secret ?? await context?.readIntegrationSecret?.(input.profileId) ?? null)
    }
    case 'zotero.authorize': return services.integrations.authorizeZotero(ZoteroAuthorizeInputSchema.parse(request.payload).profileId, credential?.secret ?? null)
    case 'zotero.collectionsPage': {
      const input = ZoteroCollectionPageInputSchema.parse(request.payload)
      return services.integrations.listZoteroCollectionPage({ ...input, secret: credential?.secret ?? await context?.readIntegrationSecret?.(input.profileId) ?? null })
    }
    case 'zotero.collections': {
      const input = ZoteroCollectionPageInputSchema.parse(request.payload)
      const page = await services.integrations.listZoteroCollectionPage({ ...input, secret: credential?.secret ?? await context?.readIntegrationSecret?.(input.profileId) ?? null })
      return page.items
    }
    case 'zotero.itemsPage': {
      const input = ZoteroItemPageInputSchema.parse(request.payload)
      return services.integrations.listZoteroItemPage({ ...input, secret: credential?.secret ?? await context?.readIntegrationSecret?.(input.profileId) ?? null })
    }
    case 'zotero.bibtexExport': {
      const input = ZoteroBibtexExportInputSchema.parse(request.payload)
      return services.integrations.exportZoteroBibtex({ ...input, secret: credential?.secret ?? await context?.readIntegrationSecret?.(input.profileId) ?? null })
    }
    case 'zotero.items': {
      const input = ZoteroItemPageInputSchema.parse(request.payload)
      const page = await services.integrations.listZoteroItemPage({ ...input, secret: credential?.secret ?? await context?.readIntegrationSecret?.(input.profileId) ?? null })
      return page.items
    }
    case 'zotero.import': { const p = ZoteroImportInputSchema.parse(request.payload); return services.integrations.importZoteroItem({ ...p, secret: credential?.secret ?? null }) }
    case 'zotero.importSelected.preview': return services.integrations.previewZoteroImport({ ...ZoteroImportPreviewInputSchema.parse(request.payload), secret: credential?.secret ?? null })
    case 'zotero.importSelected.execute': return services.integrations.executeZoteroImport(ZoteroImportExecuteInputSchema.parse(request.payload), credential?.secret ?? null, credential?.profileId)
    case 'zotero.paperToZotero.preview': {
      const input = PaperToZoteroPreviewInputSchema.parse(request.payload)
      return services.integrations.previewPaperToZotero({ ...input, secret: credential?.secret ?? await context?.readIntegrationSecret?.(input.profileId) ?? null })
    }
    case 'zotero.paperToZotero.execute': return services.integrations.executePaperToZotero(PaperToZoteroExecuteInputSchema.parse(request.payload), credential?.secret ?? null, credential?.profileId)
    case 'zotero.paperToZotero.request': {
      const bound = requireExternalActions(services, context)
      return bound.external.requestZoteroImport(PaperToZoteroPreviewInputSchema.parse(request.payload), bound.context)
    }
    case 'literature.stagingToZotero.request': {
      const bound = requireExternalActions(services, context)
      return bound.external.requestStagingZoteroImport(LiteratureStagingToZoteroPreviewInputSchema.parse(request.payload), bound.context)
    }
    // 两侧删除：preview 冻结远端 revision（只读），execute 在确认后先删 Zotero
    // 远端条目，只有远端确认删除（或 404）时才删除本地投影；凭据只在此处注入。
    case 'zotero.deleteRemote.preview': return services.integrations.previewZoteroRemoteDelete(ZoteroRemoteDeletePreviewInputSchema.parse(request.payload), credential?.secret ?? null)
    case 'zotero.deleteRemote.execute': return services.integrations.executeZoteroRemoteDelete(ZoteroRemoteDeleteExecuteInputSchema.parse(request.payload), credential?.secret ?? null)
    case 'papers.importFromZotero': return services.integrations.importFromZotero({ ...PaperImportFromZoteroInputSchema.parse(request.payload), secret: credential?.secret ?? null })
    case 'knowledge.engines.list': z.null().parse(request.payload); return services.knowledgeEngines.list()
    case 'knowledge.engines.save': {
      const payload = KnowledgeEngineSaveInputSchema.parse(request.payload)
      const { credential: _credential, ...publicPayload } = payload
      return services.knowledgeEngines.save(publicPayload, credential?.secret ?? null)
    }
    case 'knowledge.engines.test': {
      const payload = KnowledgeEngineTestInputSchema.parse(request.payload)
      return services.knowledgeEngines.test({ kind: payload.kind, secret: credential?.secret ?? null })
    }
    case 'intelDaily.getConfig': z.null().parse(request.payload); return services.intelDaily.getConfig()
    case 'intelDaily.setConfig': return services.intelDaily.setConfig(IntelDailySetConfigInputSchema.parse(request.payload))
    case 'intelDaily.overview': z.null().parse(request.payload); return services.intelDaily.overview()
    case 'rss.sources.list': z.null().parse(request.payload); return repository.listRssSources(false, false)
    case 'rss.sources.preview': return previewRssFeed(RssSourcePreviewInputSchema.parse(request.payload).url)
    case 'rss.sources.save': return repository.saveRssSource(RssSaveSourceInputSchema.parse(request.payload))
    case 'rss.sources.remove': { repository.deleteRssSource(RssSourceDeleteInputSchema.parse(request.payload).id); return null }
    case 'rss.sources.setEnabled': {
      const p = RssSourceSetEnabledInputSchema.parse(request.payload)
      return repository.setRssSourceEnabled(p.id, p.enabled)
    }
    case 'rss.sources.setDisplayEnabled': {
      const p = RssSourceSetDisplayEnabledInputSchema.parse(request.payload)
      return repository.setRssSourceDisplayEnabled(p.id, p.displayEnabled)
    }
    case 'rss.categories.list': z.null().parse(request.payload); return repository.listRssCategories()
    case 'rss.categories.save': return repository.saveRssCategory(RssCategorySaveInputSchema.parse(request.payload))
    case 'rss.categories.remove': { repository.deleteRssCategory(RssCategoryDeleteInputSchema.parse(request.payload).id); return null }
    case 'rss.items.query': return repository.queryRssItems(RssItemsQueryInputSchema.parse(request.payload))
    case 'rss.items.refresh': {
      const input = RssItemsRefreshInputSchema.parse(request.payload)
      const sources = repository.listRssSources(true).filter((source) => input.sourceIds.length === 0 || input.sourceIds.includes(source.id))
      const fetched = await fetchRssSources(sources)
      const added = repository.insertNewRssItems(fetched.results.flatMap((result) => result.items))
      return RssItemsRefreshResultSchema.parse({
        fetchedSources: fetched.results.length,
        addedItems: added.length,
        failures: fetched.failures.map((failure) => ({ sourceId: failure.sourceId, message: failure.message }))
      })
    }
    case 'workspace.status': z.null().parse(request.payload); return workspaceStatus(repository, metadata.version)
    case 'system.openExternal': { const error = new Error('system.openExternal is a Main-process operation'); error.name = 'FEATURE_DISABLED'; throw error }
    case 'system.revealPath': { const error = new Error('system.revealPath is a Main-process operation'); error.name = 'FEATURE_DISABLED'; throw error }
    case 'system.health': z.null().parse(request.payload); return { status: 'ok' as const, version: metadata.version }
  }
}

function workspaceStatus(repository: WorkbenchRepository, version: string) {
  const connectors = Object.fromEntries([
    // A profile that exists but has not been probed yet is configured, not
    // missing.  Keep that distinction for the shell status bar: otherwise a
    // healthy local Zotero bridge was shown as “未配置” until an unrelated
    // settings test happened to run.
    ...repository.listIntegrationProfiles().map((profile) => [profile.provider, profile.status === 'ready' || profile.status === 'syncing' ? 'connected' : profile.status === 'error' ? 'error' : 'disconnected'] as const),
    ...repository.listKnowledgeEngineConfigs().map((engine) => [engine.kind, engine.status] as const)
  ])
  return { status: 'ready' as const, version, database: 'ready' as const, connectors, mcp: 'not_configured' as const }
}

function scholarWorkspaceStatus() {
  return {
    provider: 'google_scholar' as const,
    mode: 'external-browser' as const,
    status: 'ready' as const,
    readOnly: true as const,
    allowedHosts: ['scholar.google.com', 'scholar.googleusercontent.com'] as const,
    fallback: 'system-browser' as const,
    message: 'Google Scholar 仅支持用户触发的只读浏览器工作区。'
  }
}

function rejectVirtualCalendarId(id: string): void {
  if (isCalendarVirtualId(id)) { const error = new Error('Calendar projections are read-only.'); error.name = 'READ_ONLY_PROJECTION'; throw error }
}

/**
 * Read-only daily-push projection for one calendar range.
 *
 * The dispatcher performs the storage reads (schedules, occurrence slots, the
 * scheduled-run ledger, artifact titles) and the pure projector decides what a
 * calendar event may claim; nothing here invents a title, a path or a status.
 */
function dailyPushCalendarEvents(
  repository: WorkbenchRepository,
  range: z.infer<typeof CalendarRangeInputSchema>
): ReturnType<typeof buildDailyPushCalendarEvents> {
  const runs = new Map<string, DailyPushRunOutcome>()
  // One ledger page: the same `listScheduledManagedAgentRuns` projection the
  // Automation run history lists. A run record the user removed is absent here,
  // and its slot then keeps the stored occurrence status without artifact or
  // Obsidian path instead of a guessed one.
  for (const { run } of repository.listScheduledManagedAgentRuns(200)) {
    runs.set(run.id, dailyPushRunOutcome({
      run,
      artifact: run.artifactId === null ? null : repository.getResearchArtifactTitle(run.artifactId),
      events: repository.listAgentEvents(run.id, 0, 200)
    }))
  }
  return buildDailyPushCalendarEvents({
    range: { startsAt: range.startsAt, endsAt: range.endsAt },
    ...(range.projectId === undefined ? {} : { projectId: range.projectId }),
    ...(range.types === undefined ? {} : { types: range.types }),
    schedules: repository.listSchedules(),
    occurrences: repository.listScheduleOccurrences({ limit: 200 }),
    runs
  })
}
function normalizeIso(value: string): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : value }
function normalizeCalendarRange(input: z.infer<typeof CalendarRangeInputSchema>) { return { ...input, startsAt: normalizeIso(input.startsAt), endsAt: normalizeIso(input.endsAt) } }
function normalizeCalendarCreate(input: z.infer<typeof CreateCalendarEventInputSchema>) { return { ...input, startsAt: normalizeIso(input.startsAt), endsAt: normalizeIso(input.endsAt) } }
function normalizeCalendarUpdate(input: z.infer<typeof UpdateCalendarEventInputSchema>) { return { ...input, ...(input.startsAt === undefined ? {} : { startsAt: normalizeIso(input.startsAt) }), ...(input.endsAt === undefined ? {} : { endsAt: normalizeIso(input.endsAt) }) } }
function normalizeTaskFilter(input: z.infer<typeof TaskListFilterSchema>) {
  if (input.dateRange === undefined) return input
  return { ...input, dateRange: { ...input.dateRange, from: normalizeIso(input.dateRange.from), to: normalizeIso(input.dateRange.to) } }
}
function validateCalendarRelations(repository: WorkbenchRepository, input: { projectId?: string | null | undefined; taskId?: string | null | undefined; paperId?: string | null | undefined }): void {
  if (input.projectId !== undefined && input.projectId !== null && !repository.listProjects().some((project) => project.id === input.projectId)) throw new Error('project not found')
  const task = input.taskId !== undefined && input.taskId !== null ? repository.listTasks({ view: 'all', includeArchived: true }).find((value) => value.id === input.taskId) : undefined
  if (input.taskId !== undefined && input.taskId !== null && !task) throw new Error('task not found')
  if (input.paperId !== undefined && input.paperId !== null && !repository.listPapers({ includeArchived: true }).some((paper) => paper.id === input.paperId)) throw new Error('paper not found')
  if (task && input.projectId !== undefined && input.projectId !== null && task.projectId !== null && task.projectId !== input.projectId) throw new Error('calendar task and project must match')
}

type BulkTaskRepository = WorkbenchRepository & {
  readonly bulkArchiveTasks?: (input: BulkTaskCommandInput) => BulkOperationResult
  readonly bulkRestoreTasks?: (input: BulkTaskCommandInput) => BulkOperationResult
}

function bulkTaskCommand(repository: BulkTaskRepository, input: z.infer<typeof BulkTaskCommandInputSchema>, operation: 'archive' | 'restore'): BulkOperationResult {
  const bulk = operation === 'archive' ? repository.bulkArchiveTasks : repository.bulkRestoreTasks
  if (bulk !== undefined) return bulk.call(repository, input)
  const items: BulkOperationResult['items'] = []
  for (const lock of input.expectedRevisions) {
    try { if (operation === 'archive') repository.archiveTask(lock.id, lock.expectedRevision); else repository.restoreTask(lock.id, lock.expectedRevision); items.push({ key: { source: 'tasks', sourceId: lock.id }, outcome: 'succeeded', error: null }) }
    catch (error) { const app = normalizeAppError(error); items.push({ key: { source: 'tasks', sourceId: lock.id }, outcome: 'failed', error: { code: app.code, message: app.message, retryable: app.retryable } }) }
  }
  return { items, succeeded: items.filter((item) => item.outcome === 'succeeded').length, skipped: items.filter((item) => item.outcome === 'skipped').length, failed: items.filter((item) => item.outcome === 'failed').length, canceled: false }
}

function validateTaskSelection(input: { selection: { mode: string; selectedKeys: Array<{ source: string; sourceId: string }> }; expectedRevisions: Array<{ id: string }> }): void {
  if (input.selection.mode === 'none') { const error = new Error('bulk task selection cannot be empty'); error.name = 'VALIDATION_FAILED'; throw error }
  if (input.selection.mode === 'explicit' || input.selection.mode === 'page') {
    const selected = new Set(input.selection.selectedKeys.filter((key) => key.source === 'tasks' || key.source === 'task').map((key) => key.sourceId))
    for (const lock of input.expectedRevisions) if (!selected.has(lock.id)) { const error = new Error('bulk task revision lock is outside the selected set'); error.name = 'VALIDATION_FAILED'; throw error }
  }
}
