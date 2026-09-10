import type {
  AgentApprovalDecisionInput,
  AgentConnectorSaveInput,
  AgentBindingSaveInput,
  AgentProxyProfileSaveInput, AgentProxyBindingSaveInput,
  AgentConversationCreateInput,
  AgentConversationArchiveItem,
  AgentConversationListInput,
  AgentConversationMessagesInput,
  AgentRunEventsInput,
  AgentRunListInput,
  AgentRunStartInput,
  AgentRuntimeKind,
  AgentRpcMethod,
  AppError,
  IntegrationError,
  RpcRequest,
  WorkbenchAgentApiV1,
  WorkbenchApiV2,
  KnowledgeEngineSaveInput
} from '@prw/contracts'
import {
  AgentApprovalSchema,
  AgentApprovalDecisionInputSchema,
  AgentBindingSaveInputSchema,
  AgentBindingSchema,
  AgentProxyProfileSchema, AgentProxyProfileSaveInputSchema, AgentProxyBindingSchema, AgentProxyBindingSaveInputSchema,
  AgentConversationCreateInputSchema,
  AgentConversationArchiveBulkInputSchema,
  AgentConversationListInputSchema,
  AgentConversationMessagesInputSchema,
  AgentConversationSchema,
  AgentConnectorSaveInputSchema,
  AgentConnectorSchema,
  AgentEventSchema,
  AgentInboxItemSchema,
  AgentMessageSchema,
  AgentRunEventsInputSchema,
  AgentRunListInputSchema,
  AgentRunRecordSchema,
  AgentRunStartInputSchema,
  AgentRuntimeKindSchema,
  AutomationRuleSaveInputSchema,
  AutomationRuleSchema,
  ArtifactKindSchema,
  BoardColumnSchema,
  BulkHardDeleteTaskInputSchema,
  BulkOperationResultSchema,
  BulkTaskCommandInputSchema,
  CreatePaperInputSchema,
  CreateProjectInputSchema,
  CreateResearchArtifactInputSchema,
  CreateTaskInputSchema,
  DashboardSummarySchema,
  ExternalLinkSchema,
  HardDeleteTaskInputSchema,
  HardDeleteTaskResultSchema,
  IntegrationErrorSchema,
  IntegrationProfileSchema,
  LiteratureMatrixEntrySchema,
  MoveTaskInputSchema,
  PaperListFilterSchema,
  PaperImportFromZoteroInputSchema,
  PaperImportReceiptSchema,
  PaperSchema,
  ProjectProgressSchema,
  ProjectSchema,
  ResourceLinkListInputSchema,
  ResourceLinkSchema,
  CreateResourceLinkInputSchema,
  RemoveResourceLinkInputSchema,
  ResearchArtifactSchema,
  RpcResponseSchema,
  SaveIntegrationProfileInputSchema,
  SyncRunSchema,
  TaskListFilterSchema,
  TaskSchema,
  UpdatePaperInputSchema,
  UpdateProjectInputSchema,
  UpdateResearchArtifactInputSchema,
  UpdateTaskInputSchema,
  UpsertLiteratureMatrixInputSchema,
  RemoveLiteratureMatrixInputSchema,
  LiteratureMatrixBulkDeleteInputSchema,
  LiteratureMatrixBulkDeleteResultSchema,
  CalendarEventSchema,
  CalendarRangeInputSchema,
  CreateCalendarEventInputSchema,
  UpdateCalendarEventInputSchema,
  CalendarMarkerSchema,
  CalendarMarkerRangeInputSchema,
  CreateCalendarMarkerInputSchema,
  UpdateCalendarMarkerInputSchema,
  SearchInputSchema,
  SearchResultPageSchema,
  SearchSessionSchema,
  SearchResultSchema,
  LiteratureClearSessionInputSchema,
  LiteratureClearSessionReceiptSchema,
  LiteratureResultsInputSchema,
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
  LiteratureBatchPreviewInputSchema,
  LiteratureBatchPreviewSchema,
  LiteratureBatchExecuteInputSchema,
  LiteratureBatchResultSchema,
  LiteratureBatchCancelInputSchema,
  LiteratureBatchCancelReceiptSchema,
  LiteratureBatchRetryInputSchema,
  LiteratureBatchImportResultInputSchema,
  NoteListInputSchema,
  DeleteNoteInputSchema,
  DeleteNoteFolderInputSchema,
  ReadNoteInputSchema,
  WriteNoteInputSchema,
  NoteSchema,
  NoteDeleteReceiptSchema,
  NoteFolderDeleteReceiptSchema,
  ZoteroCollectionSchema,
  ZoteroCapabilityStatusSchema,
  ZoteroAuthorizeInputSchema,
  ZoteroAuthorizeResultSchema,
  ZoteroCollectionPageInputSchema,
  ZoteroCollectionPageSchema,
  ZoteroItemSchema,
  ZoteroBibtexExportInputSchema,
  ZoteroBibtexExportSchema,
  ZoteroItemPageInputSchema,
  ZoteroItemPageSchema,
  ZoteroImportInputSchema,
  ZoteroImportPreviewInputSchema,
  ZoteroImportPreviewSchema,
  ZoteroImportExecuteInputSchema,
  ZoteroImportResultSchema,
  PaperToZoteroPreviewInputSchema,
  PaperToZoteroPreviewSchema,
  PaperToZoteroExecuteInputSchema,
  ScholarWorkspaceStatusSchema,
  WorkspaceServiceStatusSchema,
  ObsidianIndexStatusInputSchema,
  ObsidianIndexStatusSchema,
  ObsidianLayoutPreviewInputSchema,
  ObsidianLayoutPlanSchema,
  ObsidianLayoutInitializeInputSchema,
  ObsidianLayoutReceiptSchema,
  ObsidianVaultLayoutPreviewInputSchema,
  ObsidianVaultLayoutPlanSchema,
  ObsidianVaultLayoutInitializeInputSchema,
  ObsidianVaultLayoutReceiptSchema,
  SystemSelectFolderInputSchema,
  SystemSelectFolderResultSchema,
  SystemRevealPathInputSchema,
  SystemSaveTextFileInputSchema,
  SystemSaveTextFileResultSchema,
  KnowledgeEngineConfigSchema,
  KnowledgeEngineSaveInputSchema,
  KnowledgeEngineTestInputSchema,
  KnowledgeEngineTestResultSchema
} from '@prw/contracts'
import { contextBridge, ipcRenderer } from 'electron'
import { z, type ZodType } from 'zod'

const channel = 'workbench:v2:rpc'
const agentChannel = 'workbench:agent:v1'

class WorkbenchApiError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly details?: Record<string, unknown>
  /** The validated redacted error returned by Core.  Keeping this object
   * available lets renderer callers inspect structured IntegrationError
   * fields without widening the bridge into a generic error channel. */
  readonly appError: AppError
  readonly integration?: IntegrationError
  readonly provider?: IntegrationError['provider']
  readonly operation?: IntegrationError['operation']
  readonly kind?: IntegrationError['kind']
  readonly fields?: IntegrationError['fields']

  constructor(error: AppError) {
    super(error.message)
    this.name = 'WorkbenchApiError'
    this.appError = error
    this.code = error.code
    this.retryable = error.retryable
    // ExternalWriteError intentionally has no details field.  Preserve
    // structured details only for the generic local AppError branch while
    // keeping external failures redacted at the renderer boundary.
    if ('details' in error && error.details !== undefined) this.details = error.details
    const integration = IntegrationErrorSchema.safeParse(error)
    if (integration.success) {
      this.integration = integration.data
      this.provider = integration.data.provider
      this.operation = integration.data.operation
      this.kind = integration.data.kind
      this.fields = integration.data.fields
    }
  }
}

async function invoke<T>(
  method: RpcRequest['method'],
  payload: unknown,
  output: ZodType<T>
): Promise<T> {
  const response = RpcResponseSchema.parse(await ipcRenderer.invoke(channel, method, payload))
  if (!response.ok) throw new WorkbenchApiError(response.error)
  return output.parse(response.data)
}

async function invokeAgent<T>(
  method: AgentRpcMethod,
  payload: unknown,
  output: ZodType<T>
): Promise<T> {
  const response = RpcResponseSchema.parse(await ipcRenderer.invoke(agentChannel, method, payload))
  if (!response.ok) throw new WorkbenchApiError(response.error)
  return output.parse(response.data)
}

const VoidResultSchema = z.null().transform(() => undefined)
const HealthSchema = z.object({
  status: z.literal('ok'),
  version: z.string()
})
const IdSchema = z.string().min(1)
const RevisionSchema = z.int().nonnegative()
const ArtifactFilterSchema = z.object({
  projectId: IdSchema.nullable().optional(),
  kind: ArtifactKindSchema.optional()
})
const IntegrationTestResultSchema = z.object({ ok: z.boolean(), message: z.string() })

const api: WorkbenchApiV2 = {
  projects: {
    list: () => invoke('projects.list', null, z.array(ProjectSchema)),
    create: (input) =>
      invoke('projects.create', CreateProjectInputSchema.parse(input), ProjectSchema),
    update: (input) =>
      invoke('projects.update', UpdateProjectInputSchema.parse(input), ProjectSchema),
    archive: (id, expectedRevision) =>
      invoke(
        'projects.archive',
        { id: z.string().min(1).parse(id), expectedRevision: z.int().nonnegative().parse(expectedRevision) },
        VoidResultSchema
      )
  },
  boards: {
    columns: (projectId) =>
      invoke(
        'boards.columns',
        { projectId: z.string().min(1).parse(projectId) },
        z.array(BoardColumnSchema)
      )
  },
  tasks: {
    list: (filter = {}) => invoke('tasks.list', TaskListFilterSchema.parse(filter), z.array(TaskSchema)),
    create: (input) => invoke('tasks.create', CreateTaskInputSchema.parse(input), TaskSchema),
    update: (input) => invoke('tasks.update', UpdateTaskInputSchema.parse(input), TaskSchema),
    move: (input) => invoke('tasks.move', MoveTaskInputSchema.parse(input), TaskSchema),
    archive: (id, expectedRevision) =>
      invoke(
        'tasks.archive',
        { id: z.string().min(1).parse(id), expectedRevision: z.int().nonnegative().parse(expectedRevision) },
        VoidResultSchema
      ),
    restore: async (id, expectedRevision) => {
      // Core returns the restored Task DTO so callers can refresh immediately;
      // the public V2 contract intentionally exposes this as a void command.
      await invoke(
        'tasks.restore',
        { id: z.string().min(1).parse(id), expectedRevision: z.int().nonnegative().parse(expectedRevision) },
        TaskSchema
      )
    },
    hardDelete: (input) => invoke(
      'tasks.hardDelete',
      HardDeleteTaskInputSchema.parse(input),
      HardDeleteTaskResultSchema
    ),
    bulkArchive: (input) => invoke(
      'tasks.bulkArchive',
      BulkTaskCommandInputSchema.parse(input),
      BulkOperationResultSchema
    ),
    bulkRestore: (input) => invoke(
      'tasks.bulkRestore',
      BulkTaskCommandInputSchema.parse(input),
      BulkOperationResultSchema
    ),
    bulkHardDelete: (input) => invoke(
      'tasks.bulkHardDelete',
      BulkHardDeleteTaskInputSchema.parse(input),
      BulkOperationResultSchema
    )
  },
  todos: {
    capture: (input) => invoke('todos.capture', CreateTaskInputSchema.parse(input), TaskSchema)
  },
  progress: {
    project: (projectId) =>
      invoke(
        'progress.project',
        { projectId: z.string().min(1).parse(projectId) },
        ProjectProgressSchema
      ),
    dashboard: () => invoke('progress.dashboard', null, DashboardSummarySchema)
  },
  papers: {
    list: (filter = {}) =>
      invoke('papers.list', PaperListFilterSchema.parse(filter), z.array(PaperSchema)),
    create: (input) => invoke('papers.create', CreatePaperInputSchema.parse(input), PaperSchema),
    update: (input) => invoke('papers.update', UpdatePaperInputSchema.parse(input), PaperSchema),
    archive: (id, expectedRevision) =>
      invoke(
        'papers.archive',
        { id: IdSchema.parse(id), expectedRevision: RevisionSchema.parse(expectedRevision) },
        VoidResultSchema
      ),
    importFromZotero: (input) => invoke(
      'papers.importFromZotero',
      PaperImportFromZoteroInputSchema.parse(input),
      PaperImportReceiptSchema
    )
  },
  matrix: {
    list: (projectId) => invoke(
      'matrix.list',
      projectId === undefined ? {} : { projectId: IdSchema.nullable().parse(projectId) },
      z.array(LiteratureMatrixEntrySchema)
    ),
    upsert: (input) => invoke(
      'matrix.upsert',
      UpsertLiteratureMatrixInputSchema.parse(input),
      LiteratureMatrixEntrySchema
    ),
    remove: (input) => invoke(
      'matrix.remove',
      RemoveLiteratureMatrixInputSchema.parse(input),
      VoidResultSchema
    ),
    bulkDelete: (input) => invoke(
      'matrix.bulkDelete',
      LiteratureMatrixBulkDeleteInputSchema.parse(input),
      LiteratureMatrixBulkDeleteResultSchema
    )
  },
  artifacts: {
    list: (filter = {}) => invoke(
      'artifacts.list',
      ArtifactFilterSchema.parse(filter),
      z.array(ResearchArtifactSchema)
    ),
    create: (input) => invoke(
      'artifacts.create',
      CreateResearchArtifactInputSchema.parse(input),
      ResearchArtifactSchema
    ),
    update: (input) => invoke(
      'artifacts.update',
      UpdateResearchArtifactInputSchema.parse(input),
      ResearchArtifactSchema
    ),
    archive: (id, expectedRevision) => invoke(
      'artifacts.archive',
      { id: IdSchema.parse(id), expectedRevision: RevisionSchema.parse(expectedRevision) },
      VoidResultSchema
    )
  },
  resourceLinks: {
    list: (resource) => invoke(
      'resourceLinks.list',
      resource === undefined
        ? {}
        : ResourceLinkListInputSchema.parse({ resource }),
      z.array(ResourceLinkSchema)
    ),
    create: (input) => invoke(
      'resourceLinks.create',
      CreateResourceLinkInputSchema.parse(input),
      ResourceLinkSchema
    ),
    remove: (input) => invoke(
      'resourceLinks.remove',
      RemoveResourceLinkInputSchema.parse(input),
      VoidResultSchema
    )
  },
  integrations: {
    list: () => invoke('integrations.list', null, z.array(IntegrationProfileSchema)),
    save: (input) => invoke(
      'integrations.save',
      SaveIntegrationProfileInputSchema.parse(input),
      IntegrationProfileSchema
    ),
    remove: (id, expectedRevision) => invoke(
      'integrations.remove',
      { id: IdSchema.parse(id), expectedRevision: RevisionSchema.parse(expectedRevision) },
      VoidResultSchema
    ),
    test: (id) => invoke(
      'integrations.test',
      { id: IdSchema.parse(id) },
      IntegrationTestResultSchema
    ),
    sync: (id, direction) => invoke(
      'integrations.sync',
      { id: IdSchema.parse(id), direction: z.enum(['pull', 'push']).parse(direction) },
      SyncRunSchema
    ),
    runs: (profileId) => invoke(
      'integrations.runs',
      profileId === undefined ? {} : { profileId: IdSchema.parse(profileId) },
      z.array(SyncRunSchema)
    ),
    links: (profileId) => invoke(
      'integrations.links',
      profileId === undefined ? {} : { profileId: IdSchema.parse(profileId) },
      z.array(ExternalLinkSchema)
    )
  },
  calendar: {
    list: (input) => invoke('calendar.list', CalendarRangeInputSchema.parse(input), z.array(CalendarEventSchema)),
    create: (input) => invoke('calendar.create', CreateCalendarEventInputSchema.parse(input), CalendarEventSchema),
    update: (input) => invoke('calendar.update', UpdateCalendarEventInputSchema.parse(input), CalendarEventSchema),
    remove: (id, expectedRevision) => invoke('calendar.remove', { id: IdSchema.parse(id), expectedRevision: RevisionSchema.parse(expectedRevision) }, VoidResultSchema),
    markers: {
      list: (input) => invoke('calendar.markers.list', CalendarMarkerRangeInputSchema.parse(input), z.array(CalendarMarkerSchema)),
      create: (input) => invoke('calendar.markers.create', CreateCalendarMarkerInputSchema.parse(input), CalendarMarkerSchema),
      update: (input) => invoke('calendar.markers.update', UpdateCalendarMarkerInputSchema.parse(input), CalendarMarkerSchema),
      remove: (id, expectedRevision) => invoke('calendar.markers.remove', { id: IdSchema.parse(id), expectedRevision: RevisionSchema.parse(expectedRevision) }, VoidResultSchema)
    }
  },
  literature: {
    search: (input) => invoke('literature.search', SearchInputSchema.parse(input), z.object({
      session: SearchSessionSchema,
      results: z.array(SearchResultSchema)
    })),
    sessions: () => invoke('literature.sessions', null, z.array(SearchSessionSchema)),
    clearSession: (input) => invoke('literature.clearSession', LiteratureClearSessionInputSchema.parse(input), LiteratureClearSessionReceiptSchema),
    results: (sessionId) => invoke('literature.results', { sessionId: IdSchema.parse(sessionId) }, z.array(SearchResultSchema)),
    resultsPage: (input) => invoke(
      'literature.resultsPage',
      LiteratureResultsInputSchema.parse(input),
      SearchResultPageSchema
    ),
    staging: {
      page: (input) => invoke(
        'literature.staging.page',
        LiteratureStagingPageInputSchema.parse(input),
        LiteratureStagingPageSchema
      ),
      save: (input) => invoke(
        'literature.staging.save',
        LiteratureStagingSaveInputSchema.parse(input),
        LiteratureStagingRecordSchema
      ),
      delete: (input) => invoke(
        'literature.staging.delete',
        LiteratureStagingDeleteInputSchema.parse(input),
        LiteratureStagingDeleteReceiptSchema
      ),
      bulkDelete: (input) => invoke(
        'literature.staging.bulkDelete',
        LiteratureStagingBulkDeleteInputSchema.parse(input),
        LiteratureStagingBulkDeleteResultSchema
      )
    },
    stagingToZotero: {
      preview: (input) => invoke(
        'literature.stagingToZotero.preview',
        LiteratureStagingToZoteroPreviewInputSchema.parse(input),
        LiteratureStagingToZoteroPreviewSchema
      ),
      execute: (input) => invoke(
        'literature.stagingToZotero.execute',
        LiteratureStagingToZoteroExecuteInputSchema.parse(input),
        LiteratureStagingToZoteroResultSchema
      )
    },
    batch: {
      preview: (input) => invoke(
        'literature.batch.preview',
        LiteratureBatchPreviewInputSchema.parse(input),
        LiteratureBatchPreviewSchema
      ),
      execute: (input) => invoke(
        'literature.batch.execute',
        LiteratureBatchExecuteInputSchema.parse(input),
        LiteratureBatchResultSchema
      ),
      cancel: (input) => invoke(
        'literature.batch.cancel',
        LiteratureBatchCancelInputSchema.parse(input),
        LiteratureBatchCancelReceiptSchema
      ),
      retry: (input) => invoke(
        'literature.batch.retry',
        LiteratureBatchRetryInputSchema.parse(input),
        LiteratureBatchResultSchema
      )
    },
    importResult: (input) => invoke(
      'literature.importResult',
      LiteratureBatchImportResultInputSchema.parse(input),
      PaperImportReceiptSchema
    ),
    scholar: {
      status: () => invoke('literature.scholar.status', null, ScholarWorkspaceStatusSchema)
    }
  },
  obsidian: {
    indexStatus: (input) => invoke(
      'obsidian.indexStatus',
      ObsidianIndexStatusInputSchema.parse(input),
      ObsidianIndexStatusSchema
    ),
    layout: {
      preview: (input) => invoke(
        'obsidian.layout.preview',
        ObsidianLayoutPreviewInputSchema.parse(input),
        ObsidianLayoutPlanSchema
      ),
      initialize: (input) => invoke(
        'obsidian.layout.initialize',
        ObsidianLayoutInitializeInputSchema.parse(input),
        ObsidianLayoutReceiptSchema
      )
    },
    vaultLayout: {
      preview: (input) => invoke(
        'obsidian.vaultLayout.preview',
        ObsidianVaultLayoutPreviewInputSchema.parse(input),
        ObsidianVaultLayoutPlanSchema
      ),
      initialize: (input) => invoke(
        'obsidian.vaultLayout.initialize',
        ObsidianVaultLayoutInitializeInputSchema.parse(input),
        ObsidianVaultLayoutReceiptSchema
      )
    }
  },
  notes: {
    list: (input) => invoke('notes.list', NoteListInputSchema.parse(input), z.array(NoteSchema)),
    read: (input) => invoke('notes.read', ReadNoteInputSchema.parse(input), NoteSchema),
    write: (input) => invoke('notes.write', WriteNoteInputSchema.parse(input), NoteSchema),
    delete: (input) => invoke('notes.delete', DeleteNoteInputSchema.parse(input), NoteDeleteReceiptSchema),
    deleteFolder: (input) => invoke('notes.deleteFolder', DeleteNoteFolderInputSchema.parse(input), NoteFolderDeleteReceiptSchema)
  },
  zotero: {
    capability: (profileId) => invoke(
      'zotero.capability',
      { profileId: IdSchema.parse(profileId) },
      ZoteroCapabilityStatusSchema
    ),
    authorize: (input) => invoke('zotero.authorize', ZoteroAuthorizeInputSchema.parse(input), ZoteroAuthorizeResultSchema),
    collections: (profileId) => invoke(
      'zotero.collections',
      { profileId: IdSchema.parse(profileId) },
      z.array(ZoteroCollectionSchema)
    ),
    collectionsPage: (input) => invoke(
      'zotero.collectionsPage',
      ZoteroCollectionPageInputSchema.parse(input),
      ZoteroCollectionPageSchema
    ),
    items: (profileId, collectionKey) => invoke(
      'zotero.items',
      {
        profileId: IdSchema.parse(profileId),
        ...(collectionKey === undefined ? {} : { collectionKey: z.string().parse(collectionKey) })
      },
      z.array(ZoteroItemSchema)
    ),
    itemsPage: (input) => invoke(
      'zotero.itemsPage',
      ZoteroItemPageInputSchema.parse(input),
      ZoteroItemPageSchema
    ),
    bibtexExport: (input) => invoke(
      'zotero.bibtexExport',
      ZoteroBibtexExportInputSchema.parse(input),
      ZoteroBibtexExportSchema
    ),
    import: (input) => invoke(
      'zotero.import',
      ZoteroImportInputSchema.parse(input),
      PaperSchema
    ),
    importSelected: {
      preview: (input) => invoke(
        'zotero.importSelected.preview',
        ZoteroImportPreviewInputSchema.parse(input),
        ZoteroImportPreviewSchema
      ),
      execute: (input) => invoke(
        'zotero.importSelected.execute',
        ZoteroImportExecuteInputSchema.parse(input),
        ZoteroImportResultSchema
      )
    },
    paperToZotero: {
      preview: (input) => invoke(
        'zotero.paperToZotero.preview',
        PaperToZoteroPreviewInputSchema.parse(input),
        PaperToZoteroPreviewSchema
      ),
      execute: (input) => invoke(
        'zotero.paperToZotero.execute',
        PaperToZoteroExecuteInputSchema.parse(input),
        ZoteroImportResultSchema
      )
    }
  },
  knowledge: {
    engines: {
      list: () => invoke('knowledge.engines.list', null, z.array(KnowledgeEngineConfigSchema)),
      save: (input: KnowledgeEngineSaveInput) => invoke(
        'knowledge.engines.save',
        KnowledgeEngineSaveInputSchema.parse(input),
        KnowledgeEngineConfigSchema
      ),
      test: (input) => invoke(
        'knowledge.engines.test',
        KnowledgeEngineTestInputSchema.parse(input),
        KnowledgeEngineTestResultSchema
      )
    }
  },
  workspace: {
    status: () => invoke('workspace.status', null, WorkspaceServiceStatusSchema)
  },
  system: {
    health: () => invoke('system.health', null, HealthSchema),
    openExternal: (url) => invoke('system.openExternal', z.string().url().parse(url), VoidResultSchema),
    selectFolder: () => invoke('system.selectFolder', SystemSelectFolderInputSchema.parse(null), SystemSelectFolderResultSchema)
    , revealPath: (input) => invoke('system.revealPath', SystemRevealPathInputSchema.parse(input), VoidResultSchema)
    , saveTextFile: (input) => invoke('system.saveTextFile', SystemSaveTextFileInputSchema.parse(input), SystemSaveTextFileResultSchema)
  }
}

const agentApi: WorkbenchAgentApiV1 = {
  conversations: {
    list: (input) => invokeAgent(
      'agent.conversations.list',
      AgentConversationListInputSchema.parse(input ?? {}),
      z.array(AgentConversationSchema)
    ),
    create: (input) => invokeAgent(
      'agent.conversations.create',
      AgentConversationCreateInputSchema.parse(input ?? {}),
      AgentConversationSchema
    ),
    get: (conversationId) => invokeAgent(
      'agent.conversations.get',
      { conversationId: IdSchema.parse(conversationId) },
      AgentConversationSchema
    ),
    messages: (input: AgentConversationMessagesInput) => invokeAgent(
      'agent.conversations.messages',
      AgentConversationMessagesInputSchema.parse(input),
      z.array(AgentMessageSchema)
    ),
    archive: async (conversationId, expectedRevision) => {
      await invokeAgent(
        'agent.conversations.archive',
        { conversationId: IdSchema.parse(conversationId), expectedRevision: RevisionSchema.parse(expectedRevision) },
        VoidResultSchema
      )
    },
    archiveBulk: async (items: AgentConversationArchiveItem[]) => {
      await invokeAgent(
        'agent.conversations.archiveBulk',
        AgentConversationArchiveBulkInputSchema.parse({ items }),
        VoidResultSchema
      )
    }
  },
  connectors: {
    list: () => invokeAgent('agent.connectors.list', null, z.array(AgentConnectorSchema)),
    test: (runtime: AgentRuntimeKind) => invokeAgent(
      'agent.connectors.test',
      { runtime: AgentRuntimeKindSchema.parse(runtime) },
      AgentConnectorSchema
    ),
    save: (input: AgentConnectorSaveInput) => invokeAgent(
      'agent.connectors.save',
      AgentConnectorSaveInputSchema.parse(input),
      AgentConnectorSchema
    )
  },
  bindings: {
    list: () => invokeAgent('agent.bindings.list', null, z.array(AgentBindingSchema)),
    save: (input: AgentBindingSaveInput) => invokeAgent(
      'agent.bindings.save',
      AgentBindingSaveInputSchema.parse(input),
      AgentBindingSchema
    )
  },
  proxyProfiles: { list: () => invokeAgent('agent.proxyProfiles.list', null, z.array(AgentProxyProfileSchema)), save: (input: AgentProxyProfileSaveInput) => invokeAgent('agent.proxyProfiles.save', AgentProxyProfileSaveInputSchema.parse(input), AgentProxyProfileSchema) },
  proxyBindings: { list: () => invokeAgent('agent.proxyBindings.list', null, z.array(AgentProxyBindingSchema)), save: (input: AgentProxyBindingSaveInput) => invokeAgent('agent.proxyBindings.save', AgentProxyBindingSaveInputSchema.parse(input), AgentProxyBindingSchema) },
  runs: {
    start: (input: AgentRunStartInput) => invokeAgent(
      'agent.runs.start',
      AgentRunStartInputSchema.parse(input),
      AgentRunRecordSchema
    ),
    list: (input: AgentRunListInput = {}) => invokeAgent(
      'agent.runs.list',
      AgentRunListInputSchema.parse(input),
      z.array(AgentRunRecordSchema)
    ),
    get: (runId) => invokeAgent(
      'agent.runs.get',
      { runId: IdSchema.parse(runId) },
      AgentRunRecordSchema
    ),
    eventsPage: (input: AgentRunEventsInput) => invokeAgent(
      'agent.runs.eventsPage',
      AgentRunEventsInputSchema.parse(input),
      z.array(AgentEventSchema)
    ),
    cancel: async (runId) => {
      await invokeAgent('agent.runs.cancel', { runId: IdSchema.parse(runId) }, VoidResultSchema)
    },
    retry: (runId) => invokeAgent(
      'agent.runs.retry',
      { runId: IdSchema.parse(runId) },
      AgentRunRecordSchema
    )
  },
  approvals: {
    list: (runId) => invokeAgent(
      'agent.approvals.list',
      runId === undefined ? {} : { runId: IdSchema.parse(runId) },
      z.array(AgentApprovalSchema)
    ),
    decide: (input: AgentApprovalDecisionInput) => invokeAgent(
      'agent.approvals.decide',
      AgentApprovalDecisionInputSchema.parse(input),
      AgentApprovalSchema
    )
  },
  automation: {
    rules: () => invokeAgent('automation.rules.list', null, z.array(AutomationRuleSchema)),
    save: (input) => invokeAgent(
      'automation.rules.save',
      AutomationRuleSaveInputSchema.parse(input),
      AutomationRuleSchema
    ),
    archive: async (id, expectedRevision) => {
      await invokeAgent(
        'automation.rules.archive',
        { id: IdSchema.parse(id), expectedRevision: RevisionSchema.parse(expectedRevision) },
        VoidResultSchema
      )
    },
    runNow: (id) => invokeAgent(
      'automation.rules.runNow',
      { id: IdSchema.parse(id) },
      AgentRunRecordSchema
    ),
    runs: (limit = 50) => invokeAgent(
      'automation.runs.list',
      { limit: z.int().min(1).max(100).parse(limit) },
      z.array(AgentRunRecordSchema)
    )
  },
  inbox: {
    list: (unreadOnly = false) => invokeAgent(
      'inbox.ai.list',
      { unreadOnly: z.boolean().parse(unreadOnly) },
      z.array(AgentInboxItemSchema)
    ),
    markRead: async (id) => {
      await invokeAgent('inbox.ai.markRead', { id: IdSchema.parse(id) }, VoidResultSchema)
    },
    archive: async (id) => {
      await invokeAgent('inbox.ai.archive', { id: IdSchema.parse(id) }, VoidResultSchema)
    }
  }
}

contextBridge.exposeInMainWorld('workbench', Object.freeze({
  v2: Object.freeze(api),
  agent: Object.freeze(agentApi)
}))
