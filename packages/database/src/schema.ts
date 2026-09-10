import type {
  AgentRun,
  AgentEventKind,
  AgentConversation,
  AgentMessage,
  AgentRuntimeKind,
  AiProviderProfile,
  BoardColumn,
  CalendarEventType,
  CalendarMarkerType,
  LiteratureStagingRecord,
  SearchResult,
  SearchSession,
  SearchSourceId,
  ExternalLink,
  IntegrationProfile,
  KnowledgeEngineKind,
  Paper,
  PromptTemplate,
  ProjectStatus,
  ResourceKind,
  ResourceLink,
  ResourceRelationship,
  ResearchArtifact,
  Schedule,
  SyncRun,
  TaskPriority,
  TaskStatus,
  WorkspaceActor
} from '@prw/contracts'
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn
} from 'drizzle-orm/sqlite-core'

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    status: text('status').$type<ProjectStatus>().notNull().default('active'),
    startAt: text('start_at'),
    dueAt: text('due_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    revision: integer('revision').notNull().default(0)
  },
  (table) => [
    index('projects_status_idx').on(table.status),
    index('projects_updated_at_idx').on(table.updatedAt)
  ]
)

export const boardColumns = sqliteTable(
  'board_columns',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: text('status').$type<BoardColumn['status']>().notNull(),
    position: real('position').notNull()
  },
  (table) => [
    uniqueIndex('board_columns_project_status_idx').on(table.projectId, table.status),
    uniqueIndex('board_columns_project_position_idx').on(table.projectId, table.position)
  ]
)

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    columnId: text('column_id').references(() => boardColumns.id, { onDelete: 'set null' }),
    parentTaskId: text('parent_task_id').references((): AnySQLiteColumn => tasks.id, {
      onDelete: 'set null'
    }),
    title: text('title').notNull(),
    notes: text('notes').notNull().default(''),
    status: text('status').$type<TaskStatus>().notNull().default('inbox'),
    priority: text('priority').$type<TaskPriority>().notNull().default('normal'),
    estimateMinutes: integer('estimate_minutes'),
    startAt: text('start_at'),
    dueAt: text('due_at'),
    completedAt: text('completed_at'),
    sortKey: real('sort_key').notNull(),
    archivedAt: text('archived_at'),
    tagsJson: text('tags_json').notNull().default('[]'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    revision: integer('revision').notNull().default(0)
  },
  (table) => [
    index('tasks_project_column_sort_idx').on(table.projectId, table.columnId, table.sortKey),
    index('tasks_status_due_at_idx').on(table.status, table.dueAt),
    index('tasks_archived_at_idx').on(table.archivedAt),
    index('tasks_completed_at_idx').on(table.completedAt),
    index('tasks_project_archive_due_idx').on(
      table.projectId,
      table.archivedAt,
      table.dueAt,
      table.status
    )
  ]
)

export const papers = sqliteTable(
  'papers',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    authorsJson: text('authors_json').notNull().default('[]'),
    year: integer('year'),
    venue: text('venue').notNull().default(''),
    abstract: text('abstract').notNull().default(''),
    doi: text('doi'),
    url: text('url'),
    citationKey: text('citation_key'),
    tagsJson: text('tags_json').notNull().default('[]'),
    collectionsJson: text('collections_json').notNull().default('[]'),
    status: text('status').$type<Paper['status']>().notNull().default('inbox'),
    rating: integer('rating').notNull().default(0),
    localPdfPath: text('local_pdf_path'),
    source: text('source').$type<Paper['source']>().notNull().default('manual'),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    revision: integer('revision').notNull().default(0)
  },
  (table) => [
    index('papers_project_status_updated_idx').on(table.projectId, table.status, table.updatedAt),
    index('papers_archived_at_idx').on(table.archivedAt),
    index('papers_doi_idx').on(table.doi),
    index('papers_citation_key_idx').on(table.citationKey)
  ]
)

export const calendarEvents = sqliteTable(
  'calendar_events',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    type: text('type').$type<CalendarEventType>().notNull(),
    startsAt: text('starts_at').notNull(),
    endsAt: text('ends_at').notNull(),
    timezone: text('timezone').notNull(),
    allDay: integer('all_day', { mode: 'boolean' }).notNull().default(false),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    paperId: text('paper_id').references(() => papers.id, { onDelete: 'set null' }),
    revision: integer('revision').notNull().default(0)
  },
  (table) => [
    index('calendar_events_range_idx').on(table.startsAt, table.endsAt),
    index('calendar_events_project_idx').on(table.projectId)
  ]
)

export const calendarMarkers = sqliteTable(
  'calendar_markers',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    note: text('note').notNull().default(''),
    type: text('type').$type<CalendarMarkerType>().notNull(),
    startsAt: text('starts_at').notNull(),
    endsAt: text('ends_at').notNull(),
    timezone: text('timezone').notNull(),
    allDay: integer('all_day', { mode: 'boolean' }).notNull().default(true),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    paperId: text('paper_id').references(() => papers.id, { onDelete: 'set null' }),
    color: text('color').notNull().default('#3b82f6'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    revision: integer('revision').notNull().default(0)
  },
  (table) => [
    index('calendar_markers_range_idx').on(table.startsAt, table.endsAt),
    index('calendar_markers_project_idx').on(table.projectId)
  ]
)

export const searchSessions = sqliteTable(
  'search_sessions',
  {
    id: text('id').primaryKey(),
    query: text('query').notNull(),
    source: text('source').$type<SearchSourceId>().notNull(),
    filtersJson: text('filters_json').notNull().default('{}'),
    createdAt: text('created_at').notNull(),
    resultCount: integer('result_count').notNull().default(0)
  },
  (table) => [index('search_sessions_created_idx').on(table.createdAt)]
)

export const searchResults = sqliteTable(
  'search_results',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull().references(() => searchSessions.id, { onDelete: 'cascade' }),
    source: text('source').$type<SearchSourceId>().notNull(),
    sourceId: text('source_id').notNull(),
    title: text('title').notNull(),
    authorsJson: text('authors_json').notNull().default('[]'),
    year: integer('year'),
    venue: text('venue').notNull().default(''),
    abstract: text('abstract').notNull().default(''),
    doi: text('doi'),
    url: text('url'),
    isOpenAccess: integer('is_open_access', { mode: 'boolean' }),
    openMetric: real('open_metric'),
    impactFactor: real('impact_factor'),
    impactFactorSource: text('impact_factor_source'),
    impactFactorFetchedAt: text('impact_factor_fetched_at'),
    fingerprint: text('fingerprint').notNull(),
    dedupeReason: text('dedupe_reason').notNull().default(''),
    dedupeConfidence: real('dedupe_confidence').notNull().default(0)
  },
  (table) => [
    uniqueIndex('search_results_session_source_idx').on(table.sessionId, table.source, table.sourceId),
    index('search_results_session_idx').on(table.sessionId),
    index('search_results_fingerprint_idx').on(table.fingerprint)
  ]
)

/**
 * Durable literature results selected for later classification/import.  Unlike
 * searchResults this table is intentionally independent of a search session:
 * deleting a session only nulls the provenance link and never removes the
 * staged snapshot.  Source/sourceId is the stable cross-provider identity.
 */
export const literatureStaging = sqliteTable(
  'literature_staging',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').references(() => searchSessions.id, { onDelete: 'set null' }),
    source: text('source').$type<LiteratureStagingRecord['source']>().notNull(),
    sourceId: text('source_id').notNull(),
    title: text('title').notNull(),
    authorsJson: text('authors_json').notNull().default('[]'),
    year: integer('year'),
    venue: text('venue').notNull().default(''),
    abstract: text('abstract').notNull().default(''),
    doi: text('doi'),
    url: text('url'),
    isOpenAccess: integer('is_open_access', { mode: 'boolean' }),
    openMetric: real('open_metric'),
    fingerprint: text('fingerprint').notNull(),
    dedupeReason: text('dedupe_reason').notNull().default(''),
    dedupeConfidence: real('dedupe_confidence').notNull().default(0),
    paperId: text('paper_id').references(() => papers.id, { onDelete: 'set null' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    revision: integer('revision').notNull().default(0)
  },
  (table) => [
    uniqueIndex('literature_staging_source_idx').on(table.source, table.sourceId),
    index('literature_staging_session_idx').on(table.sessionId),
    index('literature_staging_project_idx').on(table.projectId),
    index('literature_staging_updated_idx').on(table.updatedAt)
  ]
)

/** Compatibility alias for callers that use the DTO's pluralized entity name. */
export const literatureStagingRecords = literatureStaging

export const literatureMatrixEntries = sqliteTable(
  'literature_matrix_entries',
  {
    id: text('id').primaryKey(),
    paperId: text('paper_id')
      .notNull()
      .references(() => papers.id, { onDelete: 'cascade' }),
    researchQuestion: text('research_question').notNull().default(''),
    method: text('method').notNull().default(''),
    data: text('data').notNull().default(''),
    keyFindings: text('key_findings').notNull().default(''),
    limitations: text('limitations').notNull().default(''),
    evidence: text('evidence').notNull().default(''),
    relevance: text('relevance').notNull().default(''),
    qualityScore: integer('quality_score').notNull().default(0),
    customFieldsJson: text('custom_fields_json').notNull().default('{}'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    revision: integer('revision').notNull().default(0)
  },
  (table) => [
    uniqueIndex('literature_matrix_entries_paper_idx').on(table.paperId),
    index('literature_matrix_entries_updated_idx').on(table.updatedAt)
  ]
)

export const researchArtifacts = sqliteTable(
  'research_artifacts',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    kind: text('kind').$type<ResearchArtifact['kind']>().notNull(),
    title: text('title').notNull(),
    content: text('content').notNull().default(''),
    sourcePaperIdsJson: text('source_paper_ids_json').notNull().default('[]'),
    citationsJson: text('citations_json').notNull().default('[]'),
    status: text('status').$type<ResearchArtifact['status']>().notNull().default('draft'),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    revision: integer('revision').notNull().default(0)
  },
  (table) => [
    index('research_artifacts_project_kind_updated_idx').on(
      table.projectId,
      table.kind,
      table.updatedAt
    ),
    index('research_artifacts_archived_at_idx').on(table.archivedAt)
  ]
)

export const integrationProfiles = sqliteTable(
  'integration_profiles',
  {
    id: text('id').primaryKey(),
    provider: text('provider').$type<IntegrationProfile['provider']>().notNull(),
    name: text('name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    location: text('location').notNull().default(''),
    settingsJson: text('settings_json').notNull().default('{}'),
    credentialPresent: integer('credential_present', { mode: 'boolean' })
      .notNull()
      .default(false),
    status: text('status').$type<IntegrationProfile['status']>().notNull(),
    lastSyncAt: text('last_sync_at'),
    lastError: text('last_error'),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    revision: integer('revision').notNull().default(0)
  },
  (table) => [
    index('integration_profiles_provider_idx').on(table.provider),
    index('integration_profiles_archived_at_idx').on(table.archivedAt)
  ]
)

/** Public knowledge-engine settings. Secrets are deliberately excluded and
 * are held by Electron Main's safeStorage vault under an engine-specific key. */
export const workspaceKnowledgeEngines = sqliteTable(
  'workspace_knowledge_engines',
  {
    kind: text('kind').$type<KnowledgeEngineKind>().primaryKey(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    baseUrl: text('base_url').notNull().default(''),
    workspace: text('workspace').notNull().default(''),
    collection: text('collection').notNull().default(''),
    credentialPresent: integer('credential_present', { mode: 'boolean' }).notNull().default(false),
    status: text('status').notNull().default('not_configured'),
    lastCheckedAt: text('last_checked_at'),
    lastError: text('last_error'),
    updatedAt: text('updated_at').notNull(),
    revision: integer('revision').notNull().default(0)
  }
)

export const externalLinks = sqliteTable(
  'external_links',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => integrationProfiles.id, { onDelete: 'restrict' }),
    entityKind: text('entity_kind').$type<ExternalLink['entityKind']>().notNull(),
    entityId: text('entity_id').notNull(),
    externalId: text('external_id').notNull(),
    locator: text('locator').notNull().default(''),
    managedBlockId: text('managed_block_id'),
    remoteRevision: text('remote_revision'),
    syncState: text('sync_state').$type<ExternalLink['syncState']>().notNull(),
    lastSyncedAt: text('last_synced_at')
  },
  (table) => [
    uniqueIndex('external_links_identity_idx').on(
      table.profileId,
      table.entityKind,
      table.externalId
    ),
    index('external_links_profile_state_idx').on(table.profileId, table.syncState),
    index('external_links_entity_idx').on(table.entityKind, table.entityId)
  ]
)

/** Polymorphic local relations. Endpoint existence and relationship allow-list
 * checks are enforced by WorkbenchRepository because SQLite cannot express a
 * foreign key over multiple resource tables. */
export const resourceLinks = sqliteTable(
  'resource_links',
  {
    id: text('id').primaryKey(),
    fromKind: text('from_kind').$type<ResourceKind>().notNull(),
    fromId: text('from_id').notNull(),
    toKind: text('to_kind').$type<ResourceKind>().notNull(),
    toId: text('to_id').notNull(),
    relationship: text('relationship').$type<ResourceRelationship>().notNull(),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').$type<WorkspaceActor>().notNull()
  },
  (table) => [
    uniqueIndex('resource_links_identity_idx').on(
      table.fromKind,
      table.fromId,
      table.toKind,
      table.toId,
      table.relationship
    ),
    index('resource_links_from_idx').on(table.fromKind, table.fromId),
    index('resource_links_to_idx').on(table.toKind, table.toId)
  ]
)

export const noteIndex = sqliteTable(
  'note_index',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => integrationProfiles.id, { onDelete: 'cascade' }),
    relativePath: text('relative_path').notNull(),
    title: text('title').notNull(),
    tagsJson: text('tags_json').notNull().default('[]'),
    updatedAt: text('updated_at').notNull(),
    fingerprint: text('fingerprint').notNull()
  },
  (table) => [
    uniqueIndex('note_index_profile_path_idx').on(table.profileId, table.relativePath),
    index('note_index_profile_updated_idx').on(table.profileId, table.updatedAt)
  ]
)

export const workspaceAuditEvents = sqliteTable(
  'workspace_audit_events',
  {
    id: text('id').primaryKey(),
    actor: text('actor').$type<WorkspaceActor>().notNull(),
    action: text('action').notNull(),
    resourceKind: text('resource_kind').notNull(),
    resourceId: text('resource_id'),
    risk: text('risk').$type<'read' | 'write' | 'sensitive'>().notNull(),
    outcome: text('outcome').$type<'allowed' | 'denied' | 'failed'>().notNull(),
    summary: text('summary').notNull().default(''),
    createdAt: text('created_at').notNull()
  },
  (table) => [index('workspace_audit_created_idx').on(table.createdAt)]
)

export const workspaceConfirmationContexts = sqliteTable(
  'workspace_confirmation_contexts',
  {
    confirmationId: text('confirmation_id').primaryKey(),
    operation: text('operation').$type<'task.hardDelete' | 'tasks.bulkHardDelete'>().notNull(),
    issuedAt: text('issued_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    consumedAt: text('consumed_at'),
    createdAt: text('created_at').notNull()
  },
  (table) => [index('workspace_confirmation_expires_idx').on(table.expiresAt)]
)

export const syncRuns = sqliteTable(
  'sync_runs',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => integrationProfiles.id, { onDelete: 'restrict' }),
    direction: text('direction').$type<SyncRun['direction']>().notNull(),
    status: text('status').$type<SyncRun['status']>().notNull(),
    pulled: integer('pulled').notNull().default(0),
    pushed: integer('pushed').notNull().default(0),
    conflicts: integer('conflicts').notNull().default(0),
    message: text('message').notNull().default(''),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at')
  },
  (table) => [index('sync_runs_profile_started_idx').on(table.profileId, table.startedAt)]
)

export const promptTemplates = sqliteTable(
  'prompt_templates',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    systemPrompt: text('system_prompt').notNull().default(''),
    userTemplate: text('user_template').notNull(),
    version: integer('version').notNull().default(1),
    builtIn: integer('built_in', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    revision: integer('revision').notNull().default(0)
  },
  (table) => [uniqueIndex('prompt_templates_key_idx').on(table.key)]
)

export const aiProviderProfiles = sqliteTable(
  'ai_provider_profiles',
  {
    id: text('id').primaryKey(),
    provider: text('provider').$type<AiProviderProfile['provider']>().notNull(),
    api: text('api').$type<AiProviderProfile['api']>().notNull(),
    name: text('name').notNull(),
    model: text('model').notNull(),
    baseUrl: text('base_url').notNull().default(''),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    credentialPresent: integer('credential_present', { mode: 'boolean' })
      .notNull()
      .default(false),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    revision: integer('revision').notNull().default(0)
  },
  (table) => [
    index('ai_provider_profiles_provider_idx').on(table.provider),
    index('ai_provider_profiles_archived_at_idx').on(table.archivedAt)
  ]
)

export const agentRuns = sqliteTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id'),
    idempotencyKey: text('idempotency_key'),
    runtime: text('runtime').$type<AgentRuntimeKind>().notNull().default('pi'),
    transport: text('transport').$type<'cli' | 'inprocess'>().notNull().default('inprocess'),
    toolProfile: text('tool_profile').$type<'read-only' | 'approved-write'>().notNull().default('read-only'),
    permissionMode: text('permission_mode').$type<'read-only' | 'auto' | 'full-access'>().notNull().default('read-only'),
    approvalPolicy: text('approval_policy').$type<'on-request' | 'never'>().notNull().default('on-request'),
    agentStatus: text('agent_status').notNull().default('queued'),
    artifactId: text('artifact_id'),
    conversationId: text('conversation_id'),
    workflowKey: text('workflow_key').$type<AgentRun['workflowKey']>().notNull(),
    providerProfileId: text('provider_profile_id').references(() => aiProviderProfiles.id, {
      onDelete: 'set null'
    }),
    promptTemplateId: text('prompt_template_id')
      .notNull()
      .references(() => promptTemplates.id, { onDelete: 'restrict' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    paperIdsJson: text('paper_ids_json').notNull().default('[]'),
    status: text('status').$type<AgentRun['status']>().notNull().default('queued'),
    inputJson: text('input_json').notNull().default('{}'),
    output: text('output').notNull().default(''),
    citationsJson: text('citations_json').notNull().default('[]'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at')
  },
  (table) => [
    index('agent_runs_created_idx').on(table.createdAt),
    index('agent_runs_status_created_idx').on(table.status, table.createdAt),
    index('agent_runs_agent_status_created_idx').on(table.agentStatus, table.createdAt)
  ]
)

export const schedules = sqliteTable(
  'schedules',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    workflowKey: text('workflow_key').$type<Schedule['workflowKey']>().notNull(),
    promptTemplateId: text('prompt_template_id')
      .notNull()
      .references(() => promptTemplates.id, { onDelete: 'restrict' }),
    providerProfileId: text('provider_profile_id').references(() => aiProviderProfiles.id, {
      onDelete: 'set null'
    }),
    runtime: text('runtime').$type<AgentRuntimeKind>(),
    model: text('model'),
    assistantKey: text('assistant_key'),
    workspacePath: text('workspace_path'),
    frequency: text('frequency').$type<NonNullable<Schedule['frequency']>>().notNull().default('custom'),
    executionMode: text('execution_mode').$type<NonNullable<Schedule['executionMode']>>().notNull().default('new_conversation'),
    conversationId: text('conversation_id'),
    prompt: text('prompt').notNull().default(''),
    skillKey: text('skill_key'),
    topic: text('topic').notNull().default(''),
    outputFolder: text('output_folder').notNull().default('每日文献推送'),
    permissionMode: text('permission_mode').$type<'read-only' | 'auto' | 'full-access'>().notNull().default('read-only'),
    approvalPolicy: text('approval_policy').$type<'on-request' | 'never'>().notNull().default('on-request'),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    cron: text('cron').notNull(),
    timezone: text('timezone').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    missedPolicy: text('missed_policy').$type<Schedule['missedPolicy']>().notNull(),
    nextRunAt: text('next_run_at'),
    lastRunAt: text('last_run_at'),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    revision: integer('revision').notNull().default(0)
  },
  (table) => [
    index('schedules_enabled_next_run_idx').on(table.enabled, table.nextRunAt),
    index('schedules_archived_at_idx').on(table.archivedAt)
  ]
)

/** Agent runtime metadata is local configuration only; credentials remain in
 * Electron Main safeStorage and never enter this table. */
export const agentConnectors = sqliteTable(
  'agent_connectors',
  {
    id: text('id').primaryKey(),
    runtime: text('runtime').$type<AgentRuntimeKind>().notNull(),
    executablePath: text('executable_path'),
    version: text('version'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    available: integer('available', { mode: 'boolean' }).notNull().default(false),
    mcp: integer('mcp', { mode: 'boolean' }).notNull().default(true),
    structuredOutput: integer('structured_output', { mode: 'boolean' }).notNull().default(true),
    workspaceWrite: integer('workspace_write', { mode: 'boolean' }).notNull().default(true),
    message: text('message').notNull().default(''),
    proxyEnabled: integer('proxy_enabled', { mode: 'boolean' }).notNull().default(false),
    httpProxy: text('http_proxy'),
    httpsProxy: text('https_proxy'),
    noProxy: text('no_proxy'),
    updatedAt: text('updated_at').notNull(),
    revision: integer('revision').notNull().default(0)
  },
  (table) => [uniqueIndex('agent_connectors_runtime_idx').on(table.runtime)]
)

/** Named proxy profiles are independent from a runtime connector so one
 * profile can be safely shared by multiple agents. Secrets are deliberately
 * excluded; authenticated proxies belong in Electron safeStorage. */
export const agentProxyProfiles = sqliteTable(
  'agent_proxy_profiles',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    httpProxy: text('http_proxy'),
    httpsProxy: text('https_proxy'),
    noProxy: text('no_proxy'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    revision: integer('revision').notNull().default(0)
  },
  (table) => [uniqueIndex('agent_proxy_profiles_name_idx').on(table.name)]
)

export const agentProxyBindings = sqliteTable(
  'agent_proxy_bindings',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id').notNull().references(() => agentProxyProfiles.id, { onDelete: 'cascade' }),
    runtime: text('runtime').$type<AgentRuntimeKind>().notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    revision: integer('revision').notNull().default(0)
  },
  (table) => [uniqueIndex('agent_proxy_bindings_runtime_idx').on(table.runtime)]
)

export const agentBindings = sqliteTable(
  'agent_bindings',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    runtime: text('runtime').$type<AgentRuntimeKind>().notNull(),
    fallbackRuntime: text('fallback_runtime').$type<AgentRuntimeKind>(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    revision: integer('revision').notNull().default(0)
  },
  (table) => [uniqueIndex('agent_bindings_project_idx').on(table.projectId)]
)

export const agentRunEvents = sqliteTable(
  'agent_run_events',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind').$type<AgentEventKind>().notNull(),
    payloadJson: text('payload_json').notNull().default('{}'),
    createdAt: text('created_at').notNull()
  },
  (table) => [
    uniqueIndex('agent_run_events_run_seq_idx').on(table.runId, table.seq),
    index('agent_run_events_run_idx').on(table.runId, table.seq)
  ]
)

export const agentInboxItems = sqliteTable(
  'agent_inbox_items',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    artifactId: text('artifact_id').references(() => researchArtifacts.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    kind: text('kind').notNull(),
    read: integer('read', { mode: 'boolean' }).notNull().default(false),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull()
  },
  (table) => [
    index('agent_inbox_created_idx').on(table.createdAt),
    index('agent_inbox_read_idx').on(table.read, table.archivedAt)
  ]
)

export const agentConversations = sqliteTable(
  'agent_conversations',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    runtime: text('runtime').$type<AgentRuntimeKind>().notNull().default('pi'),
    model: text('model'),
    assistantKey: text('assistant_key'),
    toolProfile: text('tool_profile').$type<'read-only' | 'approved-write'>().notNull().default('read-only'),
    permissionMode: text('permission_mode').$type<'read-only' | 'auto' | 'full-access'>().notNull().default('read-only'),
    approvalPolicy: text('approval_policy').$type<'on-request' | 'never'>().notNull().default('on-request'),
    status: text('status').$type<AgentConversation['status']>().notNull().default('pending'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    archivedAt: text('archived_at'),
    revision: integer('revision').notNull().default(0)
  },
  (table) => [
    index('agent_conversations_project_updated_idx').on(table.projectId, table.updatedAt),
    index('agent_conversations_archived_idx').on(table.archivedAt)
  ]
)

export const agentMessages = sqliteTable(
  'agent_messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull().references(() => agentConversations.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    role: text('role').$type<AgentMessage['role']>().notNull(),
    content: text('content').notNull(),
    createdAt: text('created_at').notNull(),
    seq: integer('seq').notNull()
  },
  (table) => [
    uniqueIndex('agent_messages_conversation_seq_idx').on(table.conversationId, table.seq),
    index('agent_messages_conversation_created_idx').on(table.conversationId, table.createdAt)
  ]
)

export type ProjectRow = typeof projects.$inferSelect
export type BoardColumnRow = typeof boardColumns.$inferSelect
export type TaskRow = typeof tasks.$inferSelect
export type PaperRow = typeof papers.$inferSelect
export type CalendarEventRow = typeof calendarEvents.$inferSelect
export type CalendarMarkerRow = typeof calendarMarkers.$inferSelect
export type SearchSessionRow = typeof searchSessions.$inferSelect
export type SearchResultRow = typeof searchResults.$inferSelect
export type LiteratureStagingRow = typeof literatureStaging.$inferSelect
export type LiteratureMatrixEntryRow = typeof literatureMatrixEntries.$inferSelect
export type ResearchArtifactRow = typeof researchArtifacts.$inferSelect
export type IntegrationProfileRow = typeof integrationProfiles.$inferSelect
export type WorkspaceKnowledgeEngineRow = typeof workspaceKnowledgeEngines.$inferSelect
export type ExternalLinkRow = typeof externalLinks.$inferSelect
export type ResourceLinkRow = typeof resourceLinks.$inferSelect
export type NoteIndexRow = typeof noteIndex.$inferSelect
export type WorkspaceAuditEventRow = typeof workspaceAuditEvents.$inferSelect
export type WorkspaceConfirmationContextRow = typeof workspaceConfirmationContexts.$inferSelect
export type SyncRunRow = typeof syncRuns.$inferSelect
export type PromptTemplateRow = typeof promptTemplates.$inferSelect
export type AiProviderProfileRow = typeof aiProviderProfiles.$inferSelect
export type AgentRunRow = typeof agentRuns.$inferSelect
export type ScheduleRow = typeof schedules.$inferSelect
export type AgentConnectorRow = typeof agentConnectors.$inferSelect
export type AgentProxyProfileRow = typeof agentProxyProfiles.$inferSelect
export type AgentProxyBindingRow = typeof agentProxyBindings.$inferSelect
export type AgentBindingRow = typeof agentBindings.$inferSelect
export type AgentRunEventRow = typeof agentRunEvents.$inferSelect
export type AgentInboxItemRow = typeof agentInboxItems.$inferSelect
export type AgentConversationRow = typeof agentConversations.$inferSelect
export type AgentMessageRow = typeof agentMessages.$inferSelect
