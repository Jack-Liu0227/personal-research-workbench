import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import type {
  AgentRunRecordDraft,
  AgentRunRecordEntry,
  AgentRunRecordsPageInput,
  AgentConversationRecordsInput,
  AgentUsage,
  AgentApproval,
  AgentBinding,
  AgentBindingSaveInput,
  AgentConnector,
  AgentConnectorSaveInput,
  AgentProxyProfile, AgentProxyProfileSaveInput, AgentProxyBinding, AgentProxyBindingSaveInput,
  AgentConversationArchiveItem,
  AgentConversation,
  AgentConversationCreateInput,
  AgentEventRecord,
  AgentInboxItem,
  AgentMessage,
  AgentRunRecord,
  AgentRuntimeKind,
  AgentRunStatus,
  AgentRun,
  AiProviderProfile,
  BoardColumn,
  CalendarEvent,
  CalendarMarker,
  CalendarMarkerRangeInput,
  CreateCalendarMarkerInput,
  CalendarRangeInput,
  BulkHardDeleteTaskInput,
  BulkOperationResult,
  ConfirmationContext,
  CreateResourceLinkInput,
  CreateCalendarEventInput,
  CreatePaperInput,
  CreateProjectInput,
  CreateResearchArtifactInput,
  CreateTaskInput,
  DashboardSummary,
  ExternalLink,
  IntegrationProfile,
  LiteratureMatrixEntry,
  LiteratureMatrixBulkDeleteInput,
  LiteratureMatrixBulkDeleteResult,
  LiteratureStagingBulkDeleteInput,
  LiteratureStagingBulkDeleteResult,
  LiteratureStagingDeleteInput,
  LiteratureStagingDeleteReceipt,
  LiteratureStagingPage,
  LiteratureStagingPageInput,
  LiteratureStagingRecord,
  LiteratureStagingSaveInput,
  MoveTaskInput,
  Paper,
  PaperListFilter,
  PromptTemplate,
  Project,
  ProjectProgress,
  ResourceLink,
  ResourceRef,
  ResearchArtifact,
  SearchResult,
  SearchSession,
  SavePromptTemplateInput,
  SaveScheduleInput,
  Schedule,
  StartAgentRunInput,
  SyncRun,
  Task,
  HardDeleteTaskInput,
  HardDeleteTaskResult,
  TaskListFilter,
  UpdateCalendarEventInput,
  UpdateCalendarMarkerInput,
  UpdatePaperInput,
  UpdateProjectInput,
  UpdateResearchArtifactInput,
  UpdateTaskInput,
  UpsertLiteratureMatrixInput,
  RemoveLiteratureMatrixInput,
  LiteratureClearSessionReceipt,
  KnowledgeEngineConfig,
  KnowledgeEngineKind,
  KnowledgeEngineSaveInput,
  KnowledgeEngineStatus
} from '@prw/contracts'
import {
  AgentBindingSaveInputSchema,
  AgentConversationArchiveBulkInputSchema,
  AgentConversationCreateInputSchema,
  AgentConversationSchema,
  AgentConnectorSchema,
  AgentConnectorSaveInputSchema,
  AgentEventSchema,
  AgentInboxItemSchema,
  AgentRunRecordEntrySchema,
  AgentRunRecordsPageInputSchema,
  AgentConversationRecordsInputSchema,
  AgentUsageSchema,
  AgentMessageSchema,
  AgentRunRecordSchema as ManagedAgentRunSchema,
  ConfirmationContextSchema,
  CreateResourceLinkInputSchema,
  LiteratureClearSessionReceiptSchema,
  LiteratureStagingBulkDeleteInputSchema,
  LiteratureStagingDeleteInputSchema,
  LiteratureStagingPageInputSchema,
  LiteratureStagingPageSchema,
  LiteratureStagingRecordSchema,
  LiteratureStagingDeleteReceiptSchema,
  LiteratureStagingBulkDeleteResultSchema,
  LiteratureStagingSaveInputSchema,
  KnowledgeEngineConfigSchema,
  KnowledgeEngineSaveInputSchema,
  KnowledgeEngineKindSchema,
  KnowledgeEngineStatusSchema,
  ResourceLinkSchema,
  SearchResultSchema
} from '@prw/contracts'
import { calculateProjectProgress, isDueToday, isUpcoming } from '@prw/domain'
import BetterSqlite3 from 'better-sqlite3'
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { uuidv7 } from 'uuidv7'
import { z } from 'zod'
import { assertExpectedRevision, notFound, WorkbenchDatabaseError } from './errors.js'
import { migrateDatabase } from './migrations.js'
import {
  ResearchRepository,
  type CompleteAgentRunInput,
  type CompleteSyncRunInput,
  type DatabaseSaveAiProviderProfileInput,
  type DatabaseSaveIntegrationProfileInput,
  type ResearchArtifactListFilter,
  type SaveExternalLinkInput,
  type UpdateAgentRunInput,
  type UpdateIntegrationStatusInput,
  type UpdateScheduleTimingInput,
  type UpdateSyncRunInput,
  type UpsertExternalPaperInput
} from './research-repository.js'
import {
  boardColumns,
  calendarEvents,
  calendarMarkers,
  externalLinks,
  noteIndex,
  projects,
  researchArtifacts,
  resourceLinks,
  literatureStaging,
  searchResults,
  searchSessions,
  tasks,
  workspaceAuditEvents,
  workspaceConfirmationContexts,
  agentConnectors,
  agentProxyProfiles, agentProxyBindings,
  agentBindings,
  agentRunEvents,
  agentRunRecords,
  agentInboxItems,
  agentConversations,
  agentMessages,
  agentRuns,
  workspaceKnowledgeEngines,
  type BoardColumnRow,
  type AgentRunRecordRow,
  type CalendarEventRow,
  type CalendarMarkerRow,
  type LiteratureStagingRow,
  type SearchResultRow,
  type SearchSessionRow,
  type ProjectRow,
  type TaskRow,
  type ResourceLinkRow,
  type WorkspaceKnowledgeEngineRow
} from './schema.js'
import * as schema from './schema.js'

const sortStep = 1_024
const minimumSortGap = 0.000_001
/** One ledger field may not exceed this many characters; the record carries a
 * `truncated` flag instead of silently shortening the value. */
const agentRecordTextLimit = 65_536

export interface WorkbenchDatabaseOptions {
  readonly filePath: string
  readonly now?: () => Date
}

interface Placement {
  readonly projectId: string | null
  readonly columnId: string | null
  readonly status: Task['status']
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id as Project['id'],
    name: row.name,
    description: row.description,
    status: row.status,
    startAt: row.startAt,
    dueAt: row.dueAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision
  }
}

function toKnowledgeEngine(row: WorkspaceKnowledgeEngineRow): KnowledgeEngineConfig {
  return KnowledgeEngineConfigSchema.parse({
    kind: KnowledgeEngineKindSchema.parse(row.kind),
    enabled: row.enabled,
    baseUrl: row.baseUrl,
    workspace: row.workspace,
    collection: row.collection,
    credentialPresent: row.credentialPresent,
    status: KnowledgeEngineStatusSchema.parse(row.status),
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
    revision: row.revision
  })
}

function toBoardColumn(row: BoardColumnRow): BoardColumn {
  return {
    id: row.id,
    projectId: row.projectId as BoardColumn['projectId'],
    title: row.title,
    status: row.status,
    position: row.position
  }
}

function toCalendarEvent(row: CalendarEventRow): CalendarEvent {
  return {
    id: row.id,
    projectId: row.projectId as CalendarEvent['projectId'],
    title: row.title,
    description: row.description,
    type: row.type,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    timezone: row.timezone,
    allDay: row.allDay,
    readOnly: false,
    taskId: row.taskId as CalendarEvent['taskId'],
    paperId: row.paperId as CalendarEvent['paperId'],
    revision: row.revision
  }
}

function toCalendarMarker(row: CalendarMarkerRow): CalendarMarker {
  return {
    id: row.id,
    projectId: row.projectId as CalendarMarker['projectId'],
    title: row.title,
    note: row.note,
    type: row.type,
    startsAt: row.startsAt as CalendarMarker['startsAt'],
    endsAt: row.endsAt as CalendarMarker['endsAt'],
    timezone: row.timezone as CalendarMarker['timezone'],
    allDay: row.allDay,
    taskId: row.taskId as CalendarMarker['taskId'],
    paperId: row.paperId as CalendarMarker['paperId'],
    color: row.color,
    revision: row.revision,
    createdAt: row.createdAt as CalendarMarker['createdAt'],
    updatedAt: row.updatedAt as CalendarMarker['updatedAt']
  }
}

function toSearchSession(row: SearchSessionRow): SearchSession {
  let filters: SearchSession['filters']
  try {
    filters = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).parse(JSON.parse(row.filtersJson))
  } catch {
    throw new WorkbenchDatabaseError('DATABASE_ERROR', 'stored search session filters are invalid')
  }
  return { id: row.id, query: row.query, source: row.source, filters, createdAt: row.createdAt, resultCount: row.resultCount }
}

function toSearchResult(row: SearchResultRow): SearchResult {
  let authors: string[]
  try { authors = z.array(z.string()).parse(JSON.parse(row.authorsJson)) } catch { throw new WorkbenchDatabaseError('DATABASE_ERROR', 'stored search result authors are invalid') }
  return SearchResultSchema.parse({
    id: row.id,
    sessionId: row.sessionId,
    source: row.source,
    sourceId: row.sourceId,
    title: row.title,
    authors,
    year: row.year,
    venue: row.venue,
    abstract: row.abstract,
    doi: row.doi,
    url: row.url,
    isOpenAccess: row.isOpenAccess,
    openMetric: row.openMetric,
    impactFactor: row.impactFactor,
    impactFactorSource: row.impactFactorSource,
    impactFactorFetchedAt: row.impactFactorFetchedAt,
    fingerprint: row.fingerprint,
    dedupeReason: row.dedupeReason,
    dedupeConfidence: row.dedupeConfidence
  })
}

function stagingConflictError(
  id: string,
  operation: 'literature.staging.delete' | 'literature.staging.bulkDelete' = 'literature.staging.delete'
): import('@prw/contracts').IntegrationError {
  return {
    code: 'INTEGRATION_VALIDATION_FAILED',
    provider: 'literature',
    operation,
    kind: 'input',
    fields: [{ path: ['expectedRevision'], code: 'REVISION_CONFLICT', message: '待分类文献已被其他操作修改。' }],
    retryable: true,
    message: `待分类文献 ${id.slice(0, 8)} 的版本已变化，请刷新后重试。`
  }
}

function toLiteratureStaging(row: LiteratureStagingRow): LiteratureStagingRecord {
  let authors: string[]
  try {
    authors = z.array(z.string()).parse(JSON.parse(row.authorsJson))
  } catch {
    throw new WorkbenchDatabaseError('DATABASE_ERROR', 'stored literature staging authors are invalid', {
      details: { entity: 'literature-staging', id: row.id }
    })
  }

  return LiteratureStagingRecordSchema.parse({
    id: row.id,
    sessionId: row.sessionId,
    source: row.source,
    sourceId: row.sourceId,
    title: row.title,
    authors,
    year: row.year,
    venue: row.venue,
    abstract: row.abstract,
    doi: row.doi,
    url: row.url,
    isOpenAccess: row.isOpenAccess,
    openMetric: row.openMetric,
    fingerprint: row.fingerprint,
    dedupeReason: row.dedupeReason,
    dedupeConfidence: row.dedupeConfidence,
    paperId: row.paperId,
    projectId: row.projectId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision
  })
}

function assertLiteratureStagingReferences(
  database: BetterSQLite3Database<typeof schema>,
  input: Pick<LiteratureStagingSaveInput, 'sessionId' | 'paperId' | 'projectId'>
): void {
  if (input.sessionId !== null && !database.select({ id: searchSessions.id }).from(searchSessions).where(eq(searchSessions.id, input.sessionId)).get()) {
    throw new WorkbenchDatabaseError('NOT_FOUND', 'search session not found', { details: { id: input.sessionId } })
  }
  if (input.paperId !== null && !database.select({ id: schema.papers.id }).from(schema.papers).where(eq(schema.papers.id, input.paperId)).get()) {
    throw new WorkbenchDatabaseError('NOT_FOUND', 'paper not found', { details: { id: input.paperId } })
  }
  if (input.projectId !== null && input.projectId !== undefined && !database.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).get()) {
    throw new WorkbenchDatabaseError('NOT_FOUND', 'project not found', { details: { id: input.projectId } })
  }
}

function encodeLiteratureStagingCursor(row: Pick<LiteratureStagingRow, 'updatedAt' | 'id'>): string {
  return Buffer.from(JSON.stringify({ updatedAt: row.updatedAt, id: row.id }), 'utf8').toString('base64url')
}

function decodeLiteratureStagingCursor(cursor: string): { readonly updatedAt: string; readonly id: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    return z.object({ updatedAt: z.string().min(1), id: z.string().min(1) }).parse(value)
  } catch {
    throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'literature staging cursor is invalid')
  }
}

function parseLiteratureStagingPage(value: {
  readonly items: readonly LiteratureStagingRecord[]
  readonly total: number
  readonly nextCursor: string | null
  readonly status: 'complete' | 'partial'
}): LiteratureStagingPage {
  return LiteratureStagingPageSchema.parse(value)
}

function toTask(row: TaskRow): Task {
  let tags: string[]
  try {
    tags = z.array(z.string().trim().min(1).max(100)).parse(JSON.parse(row.tagsJson))
  } catch {
    throw new WorkbenchDatabaseError('DATABASE_ERROR', 'stored task tags are invalid', {
      details: { entity: 'task', id: row.id }
    })
  }
  return {
    id: row.id as Task['id'],
    projectId: row.projectId as Task['projectId'],
    columnId: row.columnId,
    parentTaskId: row.parentTaskId as Task['parentTaskId'],
    title: row.title,
    notes: row.notes,
    status: row.status,
    priority: row.priority,
    estimateMinutes: row.estimateMinutes,
    startAt: row.startAt,
    dueAt: row.dueAt,
    completedAt: row.completedAt,
    archivedAt: row.archivedAt,
    tags,
    sortKey: row.sortKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision
  }
}

function toResourceLink(row: ResourceLinkRow): ResourceLink {
  try {
    return ResourceLinkSchema.parse({
      id: row.id,
      from: { kind: row.fromKind, id: row.fromId },
      to: { kind: row.toKind, id: row.toId },
      relationship: row.relationship,
      createdBy: row.createdBy,
      createdAt: row.createdAt
    })
  } catch {
    throw new WorkbenchDatabaseError('DATABASE_ERROR', 'stored resource link is invalid', {
      details: { entity: 'resource-link', id: row.id }
    })
  }
}

function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function startOfLocalWeek(now: Date): Date {
  const result = startOfLocalDay(now)
  const day = result.getDay()
  result.setDate(result.getDate() - (day === 0 ? 6 : day - 1))
  return result
}

function parseJsonRecord(value: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(value)
    return z.record(z.string(), z.string()).parse(parsed)
  } catch {
    return {}
  }
}

function parseJsonUnknown(value: string): unknown {
  try { return JSON.parse(value) as unknown } catch { return {} }
}

function toAgentConnector(row: typeof agentConnectors.$inferSelect): AgentConnector {
  return AgentConnectorSchema.parse({
    id: row.id,
    runtime: row.runtime,
    executablePath: row.executablePath,
    version: row.version,
    enabled: row.enabled,
    available: row.available,
    mcp: row.mcp,
    structuredOutput: row.structuredOutput,
    workspaceWrite: row.workspaceWrite,
    message: row.message,
    proxyEnabled: row.proxyEnabled,
    httpProxy: row.httpProxy,
    httpsProxy: row.httpsProxy,
    noProxy: row.noProxy,
    modelOptions: [],
    thinkingOptions: [],
    permissionOptions: [],
    updatedAt: row.updatedAt,
    revision: row.revision
  })
}

function toAgentBinding(row: typeof agentBindings.$inferSelect): AgentBinding {
  return {
    id: row.id,
    projectId: row.projectId as AgentRunRecord['projectId'],
    runtime: row.runtime,
    fallbackRuntime: row.fallbackRuntime ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision
  }
}
function toAgentProxyProfile(row: typeof agentProxyProfiles.$inferSelect): AgentProxyProfile { return { ...row } }
function toAgentProxyBinding(row: typeof agentProxyBindings.$inferSelect): AgentProxyBinding { return { ...row, runtime: row.runtime as AgentRuntimeKind } }

function toManagedAgentRun(row: typeof agentRuns.$inferSelect): AgentRunRecord {
  return ManagedAgentRunSchema.parse({
    id: row.id,
    jobId: row.jobId ?? null,
    conversationId: row.conversationId ?? null,
    idempotencyKey: row.idempotencyKey ?? null,
    runtime: row.runtime,
    transport: row.transport,
    workflowKey: row.workflowKey,
    projectId: row.projectId,
    paperIds: JSON.parse(row.paperIdsJson) as string[],
    toolProfile: row.toolProfile,
    permissionMode: row.permissionMode ?? (row.toolProfile === 'approved-write' ? 'auto' : 'read-only'),
    approvalPolicy: row.approvalPolicy ?? 'on-request',
    status: row.agentStatus,
    input: parseJsonRecord(row.inputJson),
    output: redactAgentText(row.output),
    artifactId: row.artifactId ?? null,
    error: redactAgentText(row.error),
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt
  })
}

function toAgentConversation(row: typeof agentConversations.$inferSelect): AgentConversation {
  return AgentConversationSchema.parse({
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    runtime: row.runtime,
    model: row.model ?? null,
    assistantKey: row.assistantKey ?? null,
    toolProfile: row.toolProfile,
    permissionMode: row.permissionMode ?? (row.toolProfile === 'approved-write' ? 'auto' : 'read-only'),
    approvalPolicy: row.approvalPolicy ?? 'on-request',
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt ?? null,
    revision: row.revision
  })
}

function toAgentMessage(row: typeof agentMessages.$inferSelect): AgentMessage {
  return AgentMessageSchema.parse({
    id: row.id,
    conversationId: row.conversationId,
    runId: row.runId ?? null,
    role: row.role,
    content: redactAgentText(row.content) ?? '',
    createdAt: row.createdAt,
    seq: row.seq
  })
}

function toAgentEvent(row: { id: string; runId: string; seq: number; kind: string; payloadJson: string; createdAt: string }): AgentEventRecord {
  return AgentEventSchema.parse({
    id: row.id,
    runId: row.runId,
    seq: row.seq,
    kind: row.kind,
    payload: redactAgentPayload(parseJsonUnknown(row.payloadJson)),
    createdAt: row.createdAt
  })
}

/** Ledger text is redacted and clipped at both write and read time: a legacy
 * row can predate write-time redaction, so presentation must never rely on the
 * stored value already being sanitized. */
function clipAgentRecordText(value: string | null | undefined): { readonly text: string | null; readonly truncated: boolean } {
  if (value === null || value === undefined) return { text: null, truncated: false }
  const redacted = redactAgentText(value) ?? ''
  if (redacted.length <= agentRecordTextLimit) return { text: redacted, truncated: false }
  return { text: redacted.slice(0, agentRecordTextLimit), truncated: true }
}

/** Usage is reported by the CLI in different shapes per runtime. An unexpected
 * shape becomes "not reported" instead of failing the whole record. */
function sanitizeAgentUsage(value: unknown): AgentUsage | null {
  if (!value || typeof value !== 'object') return null
  const parsed = AgentUsageSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function toAgentRunRecordEntry(row: AgentRunRecordRow): AgentRunRecordEntry {
  return AgentRunRecordEntrySchema.parse({
    id: row.id,
    runId: row.runId,
    seq: row.seq,
    recordKey: row.recordKey,
    kind: row.kind,
    status: row.status,
    turn: row.turn,
    step: row.step,
    title: redactAgentText(row.title) ?? '',
    detail: redactAgentText(row.detail) ?? '',
    inputText: row.inputText === null ? null : redactAgentText(row.inputText),
    outputText: row.outputText === null ? null : redactAgentText(row.outputText),
    toolName: row.toolName === null ? null : redactAgentText(row.toolName),
    callId: row.callId === null ? null : redactAgentText(row.callId),
    parentId: row.parentId ?? null,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    durationMs: row.durationMs ?? null,
    usage: row.usageJson === null ? null : sanitizeAgentUsage(parseJsonUnknown(row.usageJson)),
    truncated: row.truncated,
    createdAt: row.createdAt
  })
}

function toAgentInboxItem(row: typeof agentInboxItems.$inferSelect): AgentInboxItem {
  return AgentInboxItemSchema.parse({
    id: row.id,
    runId: row.runId ?? null,
    artifactId: row.artifactId ?? null,
    title: row.title,
    body: redactAgentText(row.body) ?? '',
    kind: row.kind,
    read: row.read,
    createdAt: row.createdAt
  })
}

function redactAgentPayload(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactAgentText(value)?.slice(0, 64_000) ?? ''
  }
  if (Array.isArray(value)) return value.slice(0, 100).map(redactAgentPayload)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, entry]) => [
      key,
      /token|secret|api[_-]?key|authorization|password|credential|cookie/iu.test(key)
        ? '[redacted]'
        : redactAgentPayload(entry)
    ]))
  }
  return value
}

/** A JSON member whose key looks secret, with a quoted string value. Scalars are
 * deliberately left alone: a secret is a string, and masking `"max_tokens": 4096`
 * would hide real tool input. */
const SECRET_JSON_PAIR = /("(?:[^"\\]|\\.)*?(?:token|secret|api[_-]?key|authorization|password|credential|cookie)(?:[^"\\]|\\.)*?"\s*:\s*)"(?:[^"\\]|\\.)*"/giu

/** Hide credentials and local filesystem paths on every read surface too.
 * Older runs can predate write-time redaction, so presentation must not rely
 * on the stored payload having already been sanitized.
 *
 * The second rule exists because tool arguments, tool results and unrecognized
 * CLI events reach the ledger as JSON *strings*, and the assignment rule below
 * cannot see them: in `{"api_key":"..."}` a quote sits between the key and the
 * colon. Without it a credential-shaped JSON field would be stored verbatim and
 * rendered in the tool card and the trajectory inspector.
 */
function redactAgentText(value: string | null): string | null {
  if (value === null) return null
  return value
    .replace(/Bearer\s+[^\s]+/giu, 'Bearer [redacted]')
    .replace(SECRET_JSON_PAIR, '$1"[redacted]"')
    .replace(/((?:token|api[_-]?key|secret|password|authorization)[=:]\s*)[^\s]+/giu, '$1[redacted]')
    .replace(/(?<![A-Za-z0-9])(?:[A-Za-z]:\\|\\\\)[^\s"'<>]+/gu, '[path]')
    .replace(/(?<![A-Za-z0-9])\/(?:Users|home|tmp|var|opt|workspace)\/[^\s"'<>]+/gu, '[path]')
}

function serializeAgentPayload(value: unknown): string {
  const serialized = JSON.stringify(redactAgentPayload(value))
  if (serialized.length <= 64_000) return serialized
  return JSON.stringify({
    truncated: true,
    preview: serialized.slice(0, 63_000)
  })
}

function promptTemplateForWorkflow(workflowKey: import('@prw/contracts').AgentWorkflowKey): string {
  const map: Record<import('@prw/contracts').AgentWorkflowKey, string> = {
    daily_digest: 'builtin.prompt.daily-reading',
    paper_summary: 'builtin.prompt.paper-summary',
    literature_matrix: 'builtin.prompt.matrix-extraction',
    literature_review: 'builtin.prompt.review-outline',
    research_ideation: 'builtin.prompt.research-idea',
    research_plan: 'builtin.prompt.research-plan',
    manuscript_draft: 'builtin.prompt.writing-revision'
  }
  return map[workflowKey]
}

export class WorkbenchRepository {
  readonly databasePath: string
  private readonly sqlite: BetterSqlite3.Database
  private readonly database: BetterSQLite3Database<typeof schema>
  private readonly now: () => Date
  private readonly researchRepository: ResearchRepository

  constructor(options: WorkbenchDatabaseOptions) {
    this.databasePath = options.filePath === ':memory:' ? options.filePath : resolve(options.filePath)
    if (this.databasePath !== ':memory:') {
      mkdirSync(dirname(this.databasePath), { recursive: true })
    }

    this.sqlite = new BetterSqlite3(this.databasePath)
    this.sqlite.pragma('foreign_keys = ON')
    this.sqlite.pragma('busy_timeout = 5000')
    if (this.databasePath !== ':memory:') {
      this.sqlite.pragma('journal_mode = WAL')
      this.sqlite.pragma('synchronous = NORMAL')
    }
    migrateDatabase(this.sqlite)
    this.database = drizzle(this.sqlite, { schema })
    this.now = options.now ?? (() => new Date())
    this.researchRepository = new ResearchRepository(this.database, this.now)
  }

  close(): void {
    if (this.sqlite.open) {
      this.sqlite.close()
    }
  }

  listProjects(): Project[] {
    return this.database
      .select()
      .from(projects)
      .where(ne(projects.status, 'archived'))
      .orderBy(desc(projects.updatedAt), asc(projects.name))
      .all()
      .map(toProject)
  }

  createProject(input: CreateProjectInput): Project {
    const timestamp = this.now().toISOString()
    return this.database.transaction((transaction) => {
      const row: ProjectRow = {
        id: uuidv7(),
        name: input.name,
        description: input.description,
        status: 'active',
        startAt: input.startAt ?? null,
        dueAt: input.dueAt ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
        revision: 0
      }
      transaction.insert(projects).values(row).run()

      const defaults: ReadonlyArray<Pick<BoardColumn, 'title' | 'status'>> = [
        { title: 'Planned', status: 'planned' },
        { title: 'In Progress', status: 'in_progress' },
        { title: 'Blocked', status: 'blocked' },
        { title: 'Done', status: 'done' }
      ]
      transaction
        .insert(boardColumns)
        .values(
          defaults.map((column, index) => ({
            id: uuidv7(),
            projectId: row.id,
            title: column.title,
            status: column.status,
            position: (index + 1) * sortStep
          }))
        )
        .run()

      return toProject(row)
    })
  }

  updateProject(input: UpdateProjectInput): Project {
    return this.database.transaction((transaction) => {
      const current = transaction.select().from(projects).where(eq(projects.id, input.id)).get()
      if (!current) notFound('project', input.id)
      assertExpectedRevision('project', input.id, current.revision, input.expectedRevision)

      const changes: Partial<typeof projects.$inferInsert> = {
        updatedAt: this.now().toISOString(),
        revision: current.revision + 1
      }
      if (input.name !== undefined) changes.name = input.name
      if (input.description !== undefined) changes.description = input.description
      if (input.status !== undefined) changes.status = input.status
      if (input.startAt !== undefined) changes.startAt = input.startAt
      if (input.dueAt !== undefined) changes.dueAt = input.dueAt

      const updated = transaction
        .update(projects)
        .set(changes)
        .where(and(eq(projects.id, input.id), eq(projects.revision, input.expectedRevision)))
        .returning()
        .get()
      if (!updated) {
        throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'project update lost its revision lock', {
          retryable: true,
          details: { entity: 'project', id: input.id }
        })
      }
      return toProject(updated)
    })
  }

  archiveProject(id: string, expectedRevision: number): void {
    this.database.transaction((transaction) => {
      const current = transaction.select().from(projects).where(eq(projects.id, id)).get()
      if (!current) notFound('project', id)
      assertExpectedRevision('project', id, current.revision, expectedRevision)
      const timestamp = this.now().toISOString()
      const result = transaction
        .update(projects)
        .set({
          status: 'archived',
          updatedAt: timestamp,
          revision: current.revision + 1
        })
        .where(and(eq(projects.id, id), eq(projects.revision, expectedRevision)))
        .run()
      if (result.changes !== 1) {
        throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'project archive lost its revision lock', {
          retryable: true,
          details: { entity: 'project', id }
        })
      }
      const projectTasks = transaction
        .select({ id: tasks.id, status: tasks.status })
        .from(tasks)
        .where(and(eq(tasks.projectId, id), isNull(tasks.archivedAt)))
        .all()
      projectTasks.forEach((task) => {
        transaction.insert(workspaceAuditEvents).values({
          id: uuidv7(),
          actor: 'user',
          action: 'task.archive',
          resourceKind: 'task',
          resourceId: task.id,
          risk: 'write',
          outcome: 'allowed',
          summary: JSON.stringify({ previousStatus: task.status, reason: 'project.archive' }),
          createdAt: timestamp
        }).run()
      })
      transaction
        .update(tasks)
        .set({
          status: 'archived',
          columnId: null,
          archivedAt: timestamp,
          updatedAt: timestamp,
          revision: sql`${tasks.revision} + 1`
        })
        .where(and(eq(tasks.projectId, id), isNull(tasks.archivedAt)))
        .run()
      transaction.insert(workspaceAuditEvents).values({
        id: uuidv7(),
        actor: 'user',
        action: 'project.archive',
        resourceKind: 'project',
        resourceId: id,
        risk: 'write',
        outcome: 'allowed',
        summary: '',
        createdAt: timestamp
      }).run()
    })
  }

  listBoardColumns(projectId: string): BoardColumn[] {
    this.requireProject(projectId)
    return this.database
      .select()
      .from(boardColumns)
      .where(eq(boardColumns.projectId, projectId))
      .orderBy(asc(boardColumns.position))
      .all()
      .map(toBoardColumn)
  }

  listTasks(filter: TaskListFilter): Task[] {
    const conditions: SQL[] = []
    if (!filter.includeArchived) conditions.push(isNull(tasks.archivedAt))
    if (filter.projectId === null) conditions.push(isNull(tasks.projectId))
    if (typeof filter.projectId === 'string') conditions.push(eq(tasks.projectId, filter.projectId))
    const dateColumn = filter.dateField === 'dueAt' ? tasks.dueAt : tasks.createdAt
    if (filter.dateRange !== undefined) {
      if (filter.dateRange.onlyNoDate) conditions.push(isNull(dateColumn))
      else {
        const range = and(gte(dateColumn, filter.dateRange.from), lt(dateColumn, filter.dateRange.to))
        const dateCondition = filter.dateRange.includeNoDate ? (range ? or(range, isNull(dateColumn)) : isNull(dateColumn)) : range
        if (dateCondition) conditions.push(dateCondition)
      }
    }

    const rows = this.database
      .select()
      .from(tasks)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(tasks.sortKey), asc(filter.dateField === 'dueAt' ? tasks.dueAt : tasks.createdAt), asc(tasks.createdAt))
      .all()
      .map(toTask)

    const now = this.now()
    const todayStart = startOfLocalDay(now).getTime()
    return rows.filter((task) => {
      switch (filter.view) {
        case 'all':
          return true
        case 'inbox':
          return task.projectId === null && task.status === 'inbox'
        case 'today':
          return task.status !== 'done' && task.status !== 'canceled' && task.status !== 'archived' && isDueToday(task, now)
        case 'upcoming':
          return task.status !== 'done' && task.status !== 'canceled' && task.status !== 'archived' && isUpcoming(task, now)
        case 'overdue':
          return task.status !== 'done'
            && task.status !== 'canceled'
            && task.status !== 'archived'
            && task.dueAt !== null
            && new Date(task.dueAt).getTime() < todayStart
        case 'completed':
          return task.status === 'done'
      }
    })
  }

  createTask(input: CreateTaskInput): Task {
    return this.database.transaction((transaction) => {
      const placement = this.resolvePlacement(transaction, input.projectId, input.columnId ?? null)
      const timestamp = this.now().toISOString()
      const last = transaction
        .select({ sortKey: tasks.sortKey })
        .from(tasks)
        .where(
          and(
            placement.columnId === null
              ? isNull(tasks.columnId)
              : eq(tasks.columnId, placement.columnId),
            isNull(tasks.archivedAt)
          )
        )
        .orderBy(desc(tasks.sortKey))
        .limit(1)
        .get()

      const row: TaskRow = {
        id: uuidv7(),
        projectId: placement.projectId,
        columnId: placement.columnId,
        parentTaskId: null,
        title: input.title,
        notes: input.notes,
        status: placement.status,
        priority: input.priority,
        estimateMinutes: input.estimateMinutes,
        startAt: null,
        dueAt: input.dueAt,
        completedAt: placement.status === 'done' ? timestamp : null,
        sortKey: (last?.sortKey ?? 0) + sortStep,
        archivedAt: null,
        tagsJson: JSON.stringify(input.tags ?? []),
        createdAt: timestamp,
        updatedAt: timestamp,
        revision: 0
      }
      transaction.insert(tasks).values(row).run()
      return toTask(row)
    })
  }

  updateTask(input: UpdateTaskInput): Task {
    return this.database.transaction((transaction) => {
      const current = transaction.select().from(tasks).where(eq(tasks.id, input.id)).get()
      if (!current) notFound('task', input.id)
      assertExpectedRevision('task', input.id, current.revision, input.expectedRevision)
      if (current.status === 'archived' || current.archivedAt !== null) {
        throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'archived tasks must be restored before editing', {
          details: { entity: 'task', id: input.id }
        })
      }

      const projectChanged = input.projectId !== undefined && input.projectId !== current.projectId
      const placement = projectChanged
        ? this.resolvePlacement(transaction, input.projectId ?? null, null)
        : {
            projectId: current.projectId,
            columnId: current.columnId,
            status: current.status
          }

      const changes: Partial<typeof tasks.$inferInsert> = {
        updatedAt: this.now().toISOString(),
        revision: current.revision + 1
      }
      if (input.title !== undefined) changes.title = input.title
      if (input.notes !== undefined) changes.notes = input.notes
      if (input.priority !== undefined) changes.priority = input.priority
      if (input.estimateMinutes !== undefined) changes.estimateMinutes = input.estimateMinutes
      if (input.dueAt !== undefined) changes.dueAt = input.dueAt
      if (input.tags !== undefined) changes.tagsJson = JSON.stringify(input.tags)

      if (projectChanged) {
        const last = transaction
          .select({ sortKey: tasks.sortKey })
          .from(tasks)
          .where(
            and(
              placement.columnId === null
                ? isNull(tasks.columnId)
                : eq(tasks.columnId, placement.columnId),
              isNull(tasks.archivedAt)
            )
          )
          .orderBy(desc(tasks.sortKey))
          .limit(1)
          .get()
        changes.projectId = placement.projectId
        changes.columnId = placement.columnId
        changes.status = placement.status
        changes.completedAt = placement.status === 'done' ? this.now().toISOString() : null
        changes.sortKey = (last?.sortKey ?? 0) + sortStep
      }

      const updated = transaction
        .update(tasks)
        .set(changes)
        .where(and(eq(tasks.id, input.id), eq(tasks.revision, input.expectedRevision)))
        .returning()
        .get()
      if (!updated) {
        throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'task update lost its revision lock', {
          retryable: true,
          details: { entity: 'task', id: input.id }
        })
      }
      return toTask(updated)
    })
  }

  moveTask(input: MoveTaskInput): Task {
    return this.database.transaction((transaction) => {
      const current = transaction.select().from(tasks).where(eq(tasks.id, input.taskId)).get()
      if (!current) notFound('task', input.taskId)
      assertExpectedRevision('task', input.taskId, current.revision, input.expectedRevision)
      if (current.status === 'archived' || current.archivedAt !== null) {
        throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'archived tasks cannot be moved', {
          details: { entity: 'task', id: input.taskId }
        })
      }

      const syntheticStatus = input.columnId.startsWith('status:')
        ? input.columnId.slice('status:'.length)
        : null
      const column = syntheticStatus !== null
        ? transaction
            .select()
            .from(boardColumns)
            .where(and(
              eq(boardColumns.projectId, current.projectId ?? ''),
              eq(boardColumns.status, syntheticStatus as BoardColumn['status'])
            ))
            .get()
        : transaction
            .select()
            .from(boardColumns)
            .where(eq(boardColumns.id, input.columnId))
            .get()
      if (!column) notFound('board column', input.columnId)
      this.requireProject(column.projectId, transaction)

      let destination = transaction
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.columnId, column.id),
            isNull(tasks.archivedAt),
            ne(tasks.id, current.id)
          )
        )
        .orderBy(asc(tasks.sortKey), asc(tasks.createdAt))
        .all()

      const targetIndex = Math.min(input.targetIndex, destination.length)
      let previous = destination[targetIndex - 1]
      let next = destination[targetIndex]

      if (
        previous !== undefined
        && next !== undefined
        && next.sortKey - previous.sortKey < minimumSortGap
      ) {
        destination = destination.map((task, index) => {
          const sortKey = (index + 1) * sortStep
          transaction.update(tasks).set({ sortKey }).where(eq(tasks.id, task.id)).run()
          return { ...task, sortKey }
        })
        previous = destination[targetIndex - 1]
        next = destination[targetIndex]
      }

      let sortKey: number
      if (previous === undefined && next === undefined) {
        sortKey = sortStep
      } else if (previous === undefined) {
        sortKey = next!.sortKey - sortStep
      } else if (next === undefined) {
        sortKey = previous.sortKey + sortStep
      } else {
        sortKey = previous.sortKey + (next.sortKey - previous.sortKey) / 2
      }

      const timestamp = this.now().toISOString()
      const updated = transaction
        .update(tasks)
        .set({
          projectId: column.projectId,
          columnId: column.id,
          status: column.status,
          completedAt: column.status === 'done' ? current.completedAt ?? timestamp : null,
          sortKey,
          updatedAt: timestamp,
          revision: current.revision + 1
        })
        .where(and(eq(tasks.id, current.id), eq(tasks.revision, input.expectedRevision)))
        .returning()
        .get()
      if (!updated) {
        throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'task move lost its revision lock', {
          retryable: true,
          details: { entity: 'task', id: input.taskId }
        })
      }
      return toTask(updated)
    })
  }

  archiveTask(id: string, expectedRevision: number): void {
    this.database.transaction((transaction) => {
      const current = transaction.select().from(tasks).where(eq(tasks.id, id)).get()
      if (!current) notFound('task', id)
      assertExpectedRevision('task', id, current.revision, expectedRevision)
      if (current.status === 'archived' || current.archivedAt !== null) {
        throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'task is already archived', {
          details: { entity: 'task', id }
        })
      }
      const timestamp = this.now().toISOString()
      const result = transaction
        .update(tasks)
        .set({
          status: 'archived',
          columnId: null,
          archivedAt: timestamp,
          updatedAt: timestamp,
          revision: current.revision + 1
        })
        .where(and(eq(tasks.id, id), eq(tasks.revision, expectedRevision)))
        .run()
      if (result.changes !== 1) {
        throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'task archive lost its revision lock', {
          retryable: true,
          details: { entity: 'task', id }
        })
      }
      transaction.insert(workspaceAuditEvents).values({
        id: uuidv7(),
        actor: 'user',
        action: 'task.archive',
        resourceKind: 'task',
        resourceId: id,
        risk: 'write',
        outcome: 'allowed',
        summary: JSON.stringify({ previousStatus: current.status }),
        createdAt: timestamp
      }).run()
    })
  }

  restoreTask(id: string, expectedRevision: number): Task {
    return this.database.transaction((transaction) => {
      const current = transaction.select().from(tasks).where(eq(tasks.id, id)).get()
      if (!current) notFound('task', id)
      assertExpectedRevision('task', id, current.revision, expectedRevision)
      if (current.status !== 'archived' || current.archivedAt === null) {
        throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'only archived tasks can be restored', {
          details: { entity: 'task', id }
        })
      }

      let previousStatus: Task['status'] = current.projectId === null ? 'inbox' : 'planned'
      const audit = transaction
        .select({ summary: workspaceAuditEvents.summary })
        .from(workspaceAuditEvents)
        .where(and(
          eq(workspaceAuditEvents.resourceKind, 'task'),
          eq(workspaceAuditEvents.resourceId, id)
        ))
        .orderBy(desc(workspaceAuditEvents.createdAt))
        .limit(1)
        .get()
      if (audit?.summary) {
        try {
          const candidate = JSON.parse(audit.summary) as { previousStatus?: unknown }
          if (candidate.previousStatus === 'inbox' || candidate.previousStatus === 'planned'
            || candidate.previousStatus === 'in_progress' || candidate.previousStatus === 'blocked'
            || candidate.previousStatus === 'done' || candidate.previousStatus === 'canceled') {
            previousStatus = candidate.previousStatus
          }
        } catch {
          // Ignore malformed historical audit summaries and use deterministic placement.
        }
      }

      let columnId: string | null = null
      let status: Task['status'] = previousStatus
      if (current.projectId === null) {
        status = previousStatus === 'canceled' ? 'canceled' : 'inbox'
      } else {
        const column = transaction.select().from(boardColumns).where(and(
          eq(boardColumns.projectId, current.projectId),
          eq(boardColumns.status, previousStatus === 'canceled' || previousStatus === 'inbox' ? 'planned' : previousStatus)
        )).get()
        if (!column) notFound('board column', `${current.projectId}:${previousStatus}`)
        columnId = column.id
        status = column.status
      }
      const timestamp = this.now().toISOString()
      const updated = transaction.update(tasks).set({
        columnId,
        status,
        archivedAt: null,
        updatedAt: timestamp,
        revision: current.revision + 1
      }).where(and(eq(tasks.id, id), eq(tasks.revision, expectedRevision))).returning().get()
      if (!updated) {
        throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'task restore lost its revision lock', {
          retryable: true,
          details: { entity: 'task', id }
        })
      }
      transaction.insert(workspaceAuditEvents).values({
        id: uuidv7(),
        actor: 'user',
        action: 'task.restore',
        resourceKind: 'task',
        resourceId: id,
        risk: 'write',
        outcome: 'allowed',
        summary: JSON.stringify({ restoredStatus: status }),
        createdAt: timestamp
      }).run()
      return toTask(updated)
    })
  }

  hardDeleteTask(input: HardDeleteTaskInput): HardDeleteTaskResult
  hardDeleteTask(
    id: string,
    expectedRevision: number,
    confirmation: Pick<HardDeleteTaskInput, 'confirmed' | 'confirmationContext'>
  ): HardDeleteTaskResult
  hardDeleteTask(
    inputOrId: HardDeleteTaskInput | string,
    expectedRevision?: number,
    confirmation?: Pick<HardDeleteTaskInput, 'confirmed' | 'confirmationContext'>
  ): HardDeleteTaskResult {
    const input: HardDeleteTaskInput = typeof inputOrId === 'string'
      ? {
          id: inputOrId as HardDeleteTaskInput['id'],
          expectedRevision: expectedRevision!,
          confirmed: confirmation?.confirmed as true,
          confirmationContext: confirmation?.confirmationContext as HardDeleteTaskInput['confirmationContext']
        }
      : inputOrId
    return this.database.transaction((transaction) => {
      const current = transaction.select().from(tasks).where(eq(tasks.id, input.id)).get()
      if (!current) notFound('task', input.id)
      assertExpectedRevision('task', input.id, current.revision, input.expectedRevision)
      // A single-item direct delete is allowed from any lifecycle state after
      // explicit confirmation. Bulk deletion remains restricted to archived
      // rows so accidental multi-selects cannot remove active work.
      this.consumeConfirmation(transaction, input.confirmed, input.confirmationContext, 'task.hardDelete')
      return this.deleteTaskInTransaction(transaction, current.id, current.revision)
    })
  }

  bulkHardDeleteTasks(input: BulkHardDeleteTaskInput): BulkOperationResult {
    return this.database.transaction((transaction) => {
      // Validate every lock and lifecycle state before consuming confirmation or
      // mutating any row so stale selections are all-or-nothing.
      const rows = input.expectedRevisions.map((lock) => {
        const row = transaction.select().from(tasks).where(eq(tasks.id, lock.id)).get()
        if (!row) notFound('task', lock.id)
        assertExpectedRevision('task', lock.id, row.revision, lock.expectedRevision)
        this.assertArchivedTask(row.id, row.status, row.archivedAt)
        return row
      })
      this.consumeConfirmation(transaction, input.confirmed, input.confirmationContext, 'tasks.bulkHardDelete')
      const deletedAt = this.now().toISOString()
      const items = rows.map((row) => {
        this.deleteTaskInTransaction(transaction, row.id, row.revision, deletedAt)
        return {
          key: { source: 'tasks', sourceId: row.id },
          outcome: 'succeeded' as const,
          error: null
        }
      })
      return {
        items,
        succeeded: items.length,
        skipped: 0,
        failed: 0,
        canceled: false
      }
    })
  }

  private assertArchivedTask(id: string, status: Task['status'], archivedAt: string | null): void {
    if (status !== 'archived' || archivedAt === null) {
      throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'hard delete requires an archived task', {
        details: { entity: 'task', id }
      })
    }
  }

  private consumeConfirmation(
    database: BetterSQLite3Database<typeof schema>,
    confirmed: boolean,
    context: ConfirmationContext,
    operation: ConfirmationContext['operation']
  ): void {
    if (confirmed !== true) {
      throw new WorkbenchDatabaseError('CONFIRMATION_REQUIRED', 'explicit confirmation is required', {
        details: { operation }
      })
    }
    const parsed = ConfirmationContextSchema.safeParse(context)
    if (!parsed.success || parsed.data.operation !== operation) {
      throw new WorkbenchDatabaseError('CONFIRMATION_INVALID', 'confirmation context is invalid', {
        details: { operation }
      })
    }
    const now = this.now()
    const issuedAt = Date.parse(parsed.data.issuedAt)
    const expiresAt = Date.parse(parsed.data.expiresAt)
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
      || issuedAt > now.getTime() || expiresAt <= now.getTime()) {
      throw new WorkbenchDatabaseError('CONFIRMATION_INVALID', 'confirmation context is expired', {
        details: { operation }
      })
    }
    const timestamp = now.toISOString()
    try {
      database.insert(workspaceConfirmationContexts).values({
        confirmationId: parsed.data.confirmationId,
        operation,
        issuedAt: parsed.data.issuedAt,
        expiresAt: parsed.data.expiresAt,
        consumedAt: timestamp,
        createdAt: timestamp
      }).run()
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : ''
      if (code.startsWith('SQLITE_CONSTRAINT')) {
        throw new WorkbenchDatabaseError('CONFIRMATION_INVALID', 'confirmation context was already consumed', {
          details: { operation }
        })
      }
      throw error
    }
  }

  private deleteTaskInTransaction(
    database: BetterSQLite3Database<typeof schema>,
    id: string,
    expectedRevision: number,
    deletedAt: string = this.now().toISOString()
  ): HardDeleteTaskResult {
    // A linked explicit calendar event has no meaningful source after its task
    // is permanently removed. Delete that local projection in the same
    // transaction so Calendar cannot show a stale record. Virtual task
    // deadlines are derived at read time and disappear with the task.
    database.delete(calendarEvents)
      .where(eq(calendarEvents.taskId, id)).run()
    database.delete(calendarMarkers)
      .where(eq(calendarMarkers.taskId, id)).run()
    database.delete(resourceLinks).where(or(
      and(eq(resourceLinks.fromKind, 'task'), eq(resourceLinks.fromId, id)),
      and(eq(resourceLinks.toKind, 'task'), eq(resourceLinks.toId, id))
    )).run()
    database.delete(externalLinks).where(and(
      eq(externalLinks.entityKind, 'task'),
      eq(externalLinks.entityId, id)
    )).run()
    const deleted = database.delete(tasks).where(and(
      eq(tasks.id, id),
      eq(tasks.revision, expectedRevision)
    )).run()
    if (deleted.changes !== 1) {
      throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'task delete lost its revision lock', {
        retryable: true,
        details: { entity: 'task', id }
      })
    }
    const auditEventId = uuidv7()
    database.insert(workspaceAuditEvents).values({
      id: auditEventId,
      actor: 'user',
      action: 'task.hardDelete',
      resourceKind: 'task',
      resourceId: id,
      risk: 'sensitive',
      outcome: 'allowed',
      summary: JSON.stringify({ externalResourcesUntouched: true }),
      createdAt: deletedAt
    }).run()
    return { id: id as HardDeleteTaskResult['id'], deletedAt, auditEventId, externalResourcesUntouched: true }
  }

  listResourceLinks(resource?: ResourceRef | { resource?: ResourceRef }): ResourceLink[] {
    const selected = resource !== undefined && typeof resource === 'object' && 'resource' in resource
      ? resource.resource
      : resource as ResourceRef | undefined
    const conditions: SQL[] = []
    if (selected !== undefined && selected !== null) {
      conditions.push(or(
        and(eq(resourceLinks.fromKind, selected.kind), eq(resourceLinks.fromId, selected.id)),
        and(eq(resourceLinks.toKind, selected.kind), eq(resourceLinks.toId, selected.id))
      ) as SQL)
    }
    return this.database.select().from(resourceLinks)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(asc(resourceLinks.createdAt), asc(resourceLinks.id))
      .all()
      .map(toResourceLink)
  }

  createResourceLink(input: CreateResourceLinkInput): ResourceLink {
    return this.database.transaction((transaction) => {
      const parsed = CreateResourceLinkInputSchema.safeParse(input)
      if (!parsed.success) {
        throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'resource link input is invalid')
      }
      this.requireResource(parsed.data.from, transaction)
      this.requireResource(parsed.data.to, transaction)
      const row: ResourceLink = {
        id: uuidv7(),
        from: parsed.data.from,
        to: parsed.data.to,
        relationship: parsed.data.relationship,
        createdBy: parsed.data.createdBy,
        createdAt: this.now().toISOString()
      }
      try {
        transaction.insert(resourceLinks).values({
          id: row.id,
          fromKind: row.from.kind,
          fromId: row.from.id,
          toKind: row.to.kind,
          toId: row.to.id,
          relationship: row.relationship,
          createdAt: row.createdAt,
          createdBy: row.createdBy
        }).run()
      } catch {
        throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'resource link already exists or is invalid')
      }
      transaction.insert(workspaceAuditEvents).values({
        id: uuidv7(),
        actor: row.createdBy,
        action: 'resourceLink.create',
        resourceKind: 'resource-link',
        resourceId: row.id,
        risk: 'write',
        outcome: 'allowed',
        summary: '',
        createdAt: row.createdAt
      }).run()
      return row
    })
  }

  removeResourceLink(id: string): void {
    this.database.transaction((transaction) => {
      const deleted = transaction.delete(resourceLinks).where(eq(resourceLinks.id, id)).run()
      if (deleted.changes !== 1) {
        throw new WorkbenchDatabaseError('NOT_FOUND', 'resource link not found', {
          details: { entity: 'resource-link', id }
        })
      }
      transaction.insert(workspaceAuditEvents).values({
        id: uuidv7(),
        actor: 'user',
        action: 'resourceLink.remove',
        resourceKind: 'resource-link',
        resourceId: id,
        risk: 'write',
        outcome: 'allowed',
        summary: '',
        createdAt: this.now().toISOString()
      }).run()
    })
  }

  listWorkspaceAuditEvents(limit = 100): Array<{
    id: string
    actor: string
    action: string
    resourceKind: string
    resourceId: string | null
    risk: string
    outcome: string
    summary: string
    createdAt: string
  }> {
    return this.database.select().from(workspaceAuditEvents)
      .orderBy(desc(workspaceAuditEvents.createdAt), desc(workspaceAuditEvents.id))
      .limit(limit).all()
  }

  private requireResource(
    resource: ResourceRef,
    database: BetterSQLite3Database<typeof schema>
  ): void {
    let exists = false
    switch (resource.kind) {
      case 'project':
        exists = database.select({ id: projects.id }).from(projects).where(eq(projects.id, resource.id)).get() !== undefined
        break
      case 'task':
        exists = database.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, resource.id)).get() !== undefined
        break
      case 'paper':
        exists = database.select({ id: schema.papers.id }).from(schema.papers).where(eq(schema.papers.id, resource.id)).get() !== undefined
        break
      case 'calendar-event':
        exists = database.select({ id: calendarEvents.id }).from(calendarEvents).where(eq(calendarEvents.id, resource.id)).get() !== undefined
        break
      case 'artifact':
        exists = database.select({ id: researchArtifacts.id }).from(researchArtifacts).where(eq(researchArtifacts.id, resource.id)).get() !== undefined
        break
      case 'note':
        exists = database.select({ id: noteIndex.id }).from(noteIndex).where(eq(noteIndex.id, resource.id)).get() !== undefined
        break
    }
    if (!exists) {
      throw new WorkbenchDatabaseError('NOT_FOUND', `${resource.kind} resource not found`, {
        details: { entity: resource.kind, id: resource.id }
      })
    }
  }

  getProjectProgress(projectId: string): ProjectProgress {
    this.requireProject(projectId)
    const projectTasks = this.database
      .select()
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNull(tasks.archivedAt)))
      .all()
      .map(toTask)
    return calculateProjectProgress(projectId, projectTasks, this.now())
  }

  getDashboardSummary(): DashboardSummary {
    const allTasks = this.database
      .select()
      .from(tasks)
      .where(isNull(tasks.archivedAt))
      .all()
      .map(toTask)
    const now = this.now()
    const todayStart = startOfLocalDay(now).getTime()
    const weekStart = startOfLocalWeek(now).getTime()
    const active = allTasks.filter((task) => task.status !== 'canceled')
    const incomplete = active.filter((task) => task.status !== 'done')

    return {
      inboxCount: incomplete.filter((task) => task.projectId === null && task.status === 'inbox').length,
      dueTodayCount: incomplete.filter((task) => isDueToday(task, now)).length,
      overdueCount: incomplete.filter(
        (task) => task.dueAt !== null && new Date(task.dueAt).getTime() < todayStart
      ).length,
      completedThisWeekCount: active.filter(
        (task) => task.status === 'done'
          && task.completedAt !== null
          && new Date(task.completedAt).getTime() >= weekStart
      ).length,
      projects: this.listProjects().map((project) =>
        calculateProjectProgress(project.id, allTasks, now)
      )
    }
  }

  listCalendarEvents(input: CalendarRangeInput): CalendarEvent[] {
    const conditions: SQL[] = [lt(calendarEvents.startsAt, input.endsAt), gt(calendarEvents.endsAt, input.startsAt)]
    if (input.projectId === null) conditions.push(isNull(calendarEvents.projectId))
    if (typeof input.projectId === 'string') conditions.push(eq(calendarEvents.projectId, input.projectId))
    const allowedTypes = input.types === undefined ? null : new Set(input.types)
    const explicit = this.database
      .select()
      .from(calendarEvents)
      .where(and(...conditions))
      .orderBy(asc(calendarEvents.startsAt), asc(calendarEvents.title))
      .all()
      .map(toCalendarEvent)
      .filter((event) => allowedTypes === null || allowedTypes.has(event.type))

    const inRange = (value: string | null): value is string => value !== null
      && value >= input.startsAt
      && value < input.endsAt
    const taskEvents = this.listTasks({
      view: 'all',
      includeArchived: false,
      dateField: 'dueAt',
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.taskDateRange === undefined ? {} : { dateRange: input.taskDateRange })
    }).filter((task) => inRange(task.dueAt ?? task.createdAt)).map((task): CalendarEvent => ({
      id: `task:${task.id}`,
      projectId: task.projectId,
      title: task.title,
      description: task.notes,
      type: 'deadline',
      startsAt: task.dueAt ?? task.createdAt,
      endsAt: task.dueAt ?? task.createdAt,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      allDay: false,
      readOnly: true,
      taskId: task.id,
      paperId: null,
      revision: task.revision
    }))
    const projectEvents = this.listProjects()
      .filter((project) => (input.projectId === undefined || project.id === input.projectId) && inRange(project.dueAt))
      .map((project): CalendarEvent => ({
        id: `project:${project.id}`,
        projectId: project.id,
        title: `${project.name} 截止`,
        description: project.description,
        type: 'milestone',
        startsAt: project.dueAt!,
        endsAt: project.dueAt!,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        allDay: true,
        readOnly: true,
        taskId: null,
        paperId: null,
        revision: project.revision
      }))
    return [...explicit, ...taskEvents, ...projectEvents]
      .filter((event) => allowedTypes === null || allowedTypes.has(event.type))
      .sort((left, right) => left.startsAt.localeCompare(right.startsAt) || left.title.localeCompare(right.title))
  }

  createCalendarEvent(input: CreateCalendarEventInput): CalendarEvent {
    if (input.endsAt < input.startsAt) {
      throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'calendar event must end after it starts')
    }
    if (input.projectId !== null) this.requireProject(input.projectId)
    const row: CalendarEventRow = {
      id: uuidv7(),
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      type: input.type,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timezone: input.timezone,
      allDay: input.allDay,
      taskId: input.taskId,
      paperId: input.paperId,
      revision: 0
    }
    this.database.insert(calendarEvents).values(row).run()
    return toCalendarEvent(row)
  }

  updateCalendarEvent(input: UpdateCalendarEventInput): CalendarEvent {
    return this.database.transaction((transaction) => {
      const current = transaction.select().from(calendarEvents).where(eq(calendarEvents.id, input.id)).get()
      if (!current) notFound('calendar event', input.id)
      assertExpectedRevision('calendar event', input.id, current.revision, input.expectedRevision)
      const startsAt = input.startsAt ?? current.startsAt
      const endsAt = input.endsAt ?? current.endsAt
      if (endsAt < startsAt) {
        throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'calendar event must end after it starts')
      }
      if (input.projectId !== undefined && input.projectId !== null) this.requireProject(input.projectId, transaction)
      const updated = transaction.update(calendarEvents).set({
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.startsAt === undefined ? {} : { startsAt: input.startsAt }),
        ...(input.endsAt === undefined ? {} : { endsAt: input.endsAt }),
        ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
        ...(input.allDay === undefined ? {} : { allDay: input.allDay }),
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        ...(input.paperId === undefined ? {} : { paperId: input.paperId }),
        revision: current.revision + 1
      }).where(and(eq(calendarEvents.id, input.id), eq(calendarEvents.revision, input.expectedRevision))).returning().get()
      if (!updated) throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'calendar update lost its revision lock', { retryable: true })
      return toCalendarEvent(updated)
    })
  }

  removeCalendarEvent(id: string, expectedRevision: number): void {
    const result = this.database.delete(calendarEvents)
      .where(and(eq(calendarEvents.id, id), eq(calendarEvents.revision, expectedRevision)))
      .run()
    if (result.changes !== 1) {
      const current = this.database.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get()
      if (!current) notFound('calendar event', id)
      throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'calendar delete lost its revision lock', { retryable: true })
    }
  }

  listCalendarMarkers(input: CalendarMarkerRangeInput): CalendarMarker[] {
    const conditions: SQL[] = [lt(calendarMarkers.startsAt, input.endsAt), gt(calendarMarkers.endsAt, input.startsAt)]
    if (input.projectId === null) conditions.push(isNull(calendarMarkers.projectId))
    if (typeof input.projectId === 'string') conditions.push(eq(calendarMarkers.projectId, input.projectId))
    if (input.types && input.types.length > 0) conditions.push(inArray(calendarMarkers.type, input.types))
    const rows = this.database.select().from(calendarMarkers)
      .where(and(...conditions))
      .orderBy(asc(calendarMarkers.startsAt), asc(calendarMarkers.title))
      .all()
    return rows.map(toCalendarMarker)
  }

  createCalendarMarker(input: CreateCalendarMarkerInput): CalendarMarker {
    if (input.endsAt < input.startsAt) {
      throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'calendar marker must end after it starts')
    }
    if (input.projectId !== null) this.requireProject(input.projectId)
    const now = this.now().toISOString()
    const row: CalendarMarkerRow = {
      id: uuidv7(),
      projectId: input.projectId,
      title: input.title,
      note: input.note,
      type: input.type,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timezone: input.timezone,
      allDay: input.allDay,
      taskId: input.taskId,
      paperId: input.paperId,
      color: input.color,
      createdAt: now,
      updatedAt: now,
      revision: 0
    }
    this.database.insert(calendarMarkers).values(row).run()
    return toCalendarMarker(row)
  }

  updateCalendarMarker(input: UpdateCalendarMarkerInput): CalendarMarker {
    return this.database.transaction((transaction) => {
      const current = transaction.select().from(calendarMarkers).where(eq(calendarMarkers.id, input.id)).get()
      if (!current) notFound('calendar marker', input.id)
      assertExpectedRevision('calendar marker', input.id, current.revision, input.expectedRevision)
      const startsAt = input.startsAt ?? current.startsAt
      const endsAt = input.endsAt ?? current.endsAt
      if (endsAt < startsAt) throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'calendar marker must end after it starts')
      if (input.projectId !== undefined && input.projectId !== null) this.requireProject(input.projectId, transaction)
      const updated = transaction.update(calendarMarkers).set({
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.startsAt === undefined ? {} : { startsAt: input.startsAt }),
        ...(input.endsAt === undefined ? {} : { endsAt: input.endsAt }),
        ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
        ...(input.allDay === undefined ? {} : { allDay: input.allDay }),
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        ...(input.paperId === undefined ? {} : { paperId: input.paperId }),
        ...(input.color === undefined ? {} : { color: input.color }),
        updatedAt: this.now().toISOString(),
        revision: current.revision + 1
      }).where(and(eq(calendarMarkers.id, input.id), eq(calendarMarkers.revision, input.expectedRevision))).returning().get()
      if (!updated) throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'calendar marker update lost its revision lock', { retryable: true })
      return toCalendarMarker(updated)
    })
  }

  removeCalendarMarker(id: string, expectedRevision: number): void {
    const result = this.database.delete(calendarMarkers)
      .where(and(eq(calendarMarkers.id, id), eq(calendarMarkers.revision, expectedRevision)))
      .run()
    if (result.changes !== 1) {
      const current = this.database.select().from(calendarMarkers).where(eq(calendarMarkers.id, id)).get()
      if (!current) notFound('calendar marker', id)
      throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'calendar marker delete lost its revision lock', { retryable: true })
    }
  }

  createSearchSession(session: SearchSession, results: SearchResult[]): SearchSession {
    this.database.transaction((transaction) => {
      transaction.insert(searchSessions).values({
        id: session.id,
        query: session.query,
        source: session.source,
        filtersJson: JSON.stringify(session.filters),
        createdAt: session.createdAt,
        resultCount: results.length
      }).run()
      if (results.length > 0) {
        transaction.insert(searchResults).values(results.map((result) => ({
          id: result.id,
          sessionId: session.id,
          source: result.source,
          sourceId: result.sourceId,
          title: result.title,
          authorsJson: JSON.stringify(result.authors),
          year: result.year,
          venue: result.venue,
          abstract: result.abstract,
          doi: result.doi,
          url: result.url,
          isOpenAccess: result.isOpenAccess,
          openMetric: result.openMetric ?? null,
          impactFactor: result.impactFactor ?? null,
          impactFactorSource: result.impactFactorSource ?? null,
          impactFactorFetchedAt: result.impactFactorFetchedAt ?? null,
          fingerprint: result.fingerprint,
          dedupeReason: result.dedupeReason,
          dedupeConfidence: result.dedupeConfidence
        }))).run()
      }
    })
    return { ...session, resultCount: results.length }
  }

  /** Append a lazily fetched remote page to an existing search session.  The
   * search cache is disposable, but its row order is the pagination order, so
   * appends and the session count must be committed together. */
  appendSearchResults(sessionId: string, results: SearchResult[]): SearchSession {
    const now = new Date().toISOString()
    return this.database.transaction((transaction) => {
      const sessionRow = transaction.select().from(searchSessions).where(eq(searchSessions.id, sessionId)).get()
      if (!sessionRow) throw new WorkbenchDatabaseError('NOT_FOUND', 'search session not found')
      if (results.length > 0) {
        transaction.insert(searchResults).values(results.map((result) => ({
          id: result.id,
          sessionId,
          source: result.source,
          sourceId: result.sourceId,
          title: result.title,
          authorsJson: JSON.stringify(result.authors),
          year: result.year,
          venue: result.venue,
          abstract: result.abstract,
          doi: result.doi,
          url: result.url,
          isOpenAccess: result.isOpenAccess,
          openMetric: result.openMetric ?? null,
          impactFactor: result.impactFactor ?? null,
          impactFactorSource: result.impactFactorSource ?? null,
          impactFactorFetchedAt: result.impactFactorFetchedAt ?? null,
          fingerprint: result.fingerprint,
          dedupeReason: result.dedupeReason,
          dedupeConfidence: result.dedupeConfidence
        }))).run()
      }
      const resultCount = Number(sessionRow.resultCount) + results.length
      transaction.update(searchSessions).set({ resultCount }).where(eq(searchSessions.id, sessionId)).run()
      return toSearchSession({ ...sessionRow, resultCount, createdAt: sessionRow.createdAt ?? now })
    })
  }

  /**
   * Permanently remove one persisted literature search session and all of its
   * local result rows in a single SQLite transaction. Search results are a
   * disposable projection; imported Papers live in the papers table and are
   * intentionally not touched by this operation.
   */
  clearSearchSession(sessionId: string): LiteratureClearSessionReceipt {
    const receipt = this.database.transaction((transaction) => {
      const existing = transaction
        .select({ id: searchSessions.id })
        .from(searchSessions)
        .where(eq(searchSessions.id, sessionId))
        .get()

      if (!existing) {
        return {
          sessionId,
          status: 'not-found' as const,
          deletedResults: 0,
          deletedSession: false
        }
      }

      const deletedResults = transaction
        .delete(searchResults)
        .where(eq(searchResults.sessionId, sessionId))
        .run()
        .changes
      const deletedSession = transaction
        .delete(searchSessions)
        .where(eq(searchSessions.id, sessionId))
        .run()
        .changes === 1

      return {
        sessionId,
        status: deletedSession ? 'deleted' as const : 'not-found' as const,
        deletedResults,
        deletedSession
      }
    })

    return LiteratureClearSessionReceiptSchema.parse(receipt)
  }

  listSearchSessions(limit = 20): SearchSession[] {
    return this.database.select().from(searchSessions).orderBy(desc(searchSessions.createdAt)).limit(limit).all().map(toSearchSession)
  }

  listSearchResults(sessionId: string): SearchResult[] {
    return this.database.select().from(searchResults).where(eq(searchResults.sessionId, sessionId)).all().map(toSearchResult)
  }

  /** Return the durable, user-selected literature staging snapshots. */
  listLiteratureStaging(inputValue: LiteratureStagingPageInput = { query: '' }): LiteratureStagingPage {
    const input = LiteratureStagingPageInputSchema.parse(inputValue)
    const limit = input.page?.limit ?? 50
    const baseConditions: SQL[] = []
    if (input.source !== undefined) baseConditions.push(eq(literatureStaging.source, input.source))
    if (input.projectId === null) baseConditions.push(isNull(literatureStaging.projectId))
    else if (input.projectId !== undefined) baseConditions.push(eq(literatureStaging.projectId, input.projectId))
    if (input.query.length > 0) {
      const pattern = `%${input.query}%`
      baseConditions.push(or(
        sql`${literatureStaging.title} LIKE ${pattern}`,
        sql`${literatureStaging.abstract} LIKE ${pattern}`,
        sql`${literatureStaging.sourceId} LIKE ${pattern}`,
        sql`${literatureStaging.doi} LIKE ${pattern}`
      )!)
    }
    const conditions = [...baseConditions]
    if (input.page?.cursor !== undefined && input.page.cursor !== null) {
      const cursor = decodeLiteratureStagingCursor(input.page.cursor)
      conditions.push(or(
        lt(literatureStaging.updatedAt, cursor.updatedAt),
        and(eq(literatureStaging.updatedAt, cursor.updatedAt), lt(literatureStaging.id, cursor.id))
      )!)
    }

    const countCondition = baseConditions.length > 0 ? and(...baseConditions) : undefined
    const condition = conditions.length > 0 ? and(...conditions) : undefined
    const countQuery = this.database.select({ value: sql<number>`count(*)` }).from(literatureStaging)
    const totalRow = countCondition === undefined ? countQuery.get() : countQuery.where(countCondition).get()
    const total = Number(totalRow?.value ?? 0)

    const pageQuery = this.database.select().from(literatureStaging)
    const rows = (condition === undefined
      ? pageQuery
      : pageQuery.where(condition))
      .orderBy(desc(literatureStaging.updatedAt), desc(literatureStaging.id))
      .limit(limit + 1)
      .all()
    const hasNext = rows.length > limit
    const visibleRows = hasNext ? rows.slice(0, limit) : rows
    const items = visibleRows.map(toLiteratureStaging)
    const nextCursor = hasNext && visibleRows.length > 0
      ? encodeLiteratureStagingCursor(visibleRows[visibleRows.length - 1]!)
      : null
    return parseLiteratureStagingPage({ items, total, nextCursor, status: 'complete' })
  }

  /** Read one durable staging snapshot by local ID. */
  getLiteratureStaging(id: string): LiteratureStagingRecord {
    const row = this.database.select().from(literatureStaging).where(eq(literatureStaging.id, id)).get()
    if (!row) throw new WorkbenchDatabaseError('NOT_FOUND', 'literature staging record not found', { details: { id } })
    return toLiteratureStaging(row)
  }

  /**
   * Insert or revision-check update one staging snapshot.  Source/sourceId is
   * globally unique, so a duplicate new save never silently replaces a saved
   * selection.
   */
  saveLiteratureStaging(inputValue: LiteratureStagingSaveInput): LiteratureStagingRecord {
    const input = LiteratureStagingSaveInputSchema.parse(inputValue)
    const timestamp = this.now().toISOString()
    return this.database.transaction((transaction) => {
      assertLiteratureStagingReferences(transaction, input)
      const byIdentity = transaction.select().from(literatureStaging).where(and(
        eq(literatureStaging.source, input.source),
        eq(literatureStaging.sourceId, input.sourceId)
      )).get()

      if (input.id === undefined) {
        if (byIdentity) {
          throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'literature staging source identity already exists', {
            details: { entity: 'literature-staging', source: input.source, sourceId: input.sourceId }
          })
        }
        const row = {
          id: uuidv7(),
          sessionId: input.sessionId,
          source: input.source,
          sourceId: input.sourceId,
          title: input.title,
          authorsJson: JSON.stringify(input.authors),
          year: input.year,
          venue: input.venue,
          abstract: input.abstract,
          doi: input.doi,
          url: input.url,
          isOpenAccess: input.isOpenAccess,
          openMetric: input.openMetric,
          fingerprint: input.fingerprint,
          dedupeReason: input.dedupeReason,
          dedupeConfidence: input.dedupeConfidence,
          paperId: input.paperId,
          projectId: input.projectId ?? null,
          createdAt: timestamp,
          updatedAt: timestamp,
          revision: 0
        }
        transaction.insert(literatureStaging).values(row).run()
        return toLiteratureStaging(transaction.select().from(literatureStaging).where(eq(literatureStaging.id, row.id)).get()!)
      }

      const current = transaction.select().from(literatureStaging).where(eq(literatureStaging.id, input.id)).get()
      if (!current) {
        throw new WorkbenchDatabaseError('NOT_FOUND', 'literature staging record not found', { details: { id: input.id } })
      }
      if (current.revision !== input.expectedRevision) {
        throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'literature staging record was changed by another operation', {
          retryable: true,
          details: { entity: 'literature-staging', id: input.id, expectedRevision: input.expectedRevision, actualRevision: current.revision }
        })
      }
      if (byIdentity && byIdentity.id !== current.id) {
        throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'literature staging source identity already exists', {
          details: { entity: 'literature-staging', source: input.source, sourceId: input.sourceId }
        })
      }
      const updated = transaction.update(literatureStaging).set({
        sessionId: input.sessionId,
        source: input.source,
        sourceId: input.sourceId,
        title: input.title,
        authorsJson: JSON.stringify(input.authors),
        year: input.year,
        venue: input.venue,
        abstract: input.abstract,
        doi: input.doi,
        url: input.url,
        isOpenAccess: input.isOpenAccess,
        openMetric: input.openMetric,
        fingerprint: input.fingerprint,
        dedupeReason: input.dedupeReason,
        dedupeConfidence: input.dedupeConfidence,
        paperId: input.paperId,
        projectId: input.projectId ?? null,
        updatedAt: timestamp,
        revision: current.revision + 1
      }).where(and(eq(literatureStaging.id, current.id), eq(literatureStaging.revision, input.expectedRevision))).returning().get()
      if (!updated) {
        throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'literature staging update lost its revision lock', { retryable: true })
      }
      return toLiteratureStaging(updated)
    })
  }

  /** Delete one staging row atomically under its revision lock. */
  deleteLiteratureStaging(inputValue: LiteratureStagingDeleteInput): LiteratureStagingDeleteReceipt {
    const input = LiteratureStagingDeleteInputSchema.parse(inputValue)
    const receipt = this.database.transaction((transaction) => {
      const current = transaction.select({ id: literatureStaging.id, revision: literatureStaging.revision })
        .from(literatureStaging).where(eq(literatureStaging.id, input.id)).get()
      if (!current) return { id: input.id, status: 'not-found' as const, deleted: false }
      if (current.revision !== input.expectedRevision) return { id: input.id, status: 'conflict' as const, deleted: false }
      const deleted = transaction.delete(literatureStaging).where(and(
        eq(literatureStaging.id, input.id),
        eq(literatureStaging.revision, input.expectedRevision)
      )).run().changes === 1
      return deleted
        ? { id: input.id, status: 'deleted' as const, deleted: true }
        : { id: input.id, status: 'conflict' as const, deleted: false }
    })
    return LiteratureStagingDeleteReceiptSchema.parse(receipt)
  }

  /**
   * Delete selected staging rows in one transaction.  Missing IDs are skipped
   * and stale revisions are reported as retryable per-item failures; valid
   * rows still commit together as one atomic SQLite transaction.
   */
  bulkDeleteLiteratureStaging(inputValue: LiteratureStagingBulkDeleteInput): LiteratureStagingBulkDeleteResult {
    const input = LiteratureStagingBulkDeleteInputSchema.parse(inputValue)
    const receipt = this.database.transaction((transaction) => {
      const { selection } = input
      const excluded = new Set(selection.excludedIds)
      const selected = new Set(selection.selectedIds)
      const locks = input.expectedRevisions.filter((lock) => {
        if (selection.mode === 'none') return false
        if (excluded.has(lock.id)) return false
        return selection.mode === 'all-results' || selected.has(lock.id)
      })
      const items: LiteratureStagingBulkDeleteResult['items'] = []
      for (const lock of locks) {
        const current = transaction.select({ id: literatureStaging.id, revision: literatureStaging.revision })
          .from(literatureStaging).where(eq(literatureStaging.id, lock.id)).get()
        if (!current) {
          items.push({ id: lock.id, outcome: 'skipped', error: null })
          continue
        }
        if (current.revision !== lock.expectedRevision) {
          items.push({ id: lock.id, outcome: 'failed', error: stagingConflictError(lock.id, 'literature.staging.bulkDelete') })
          continue
        }
        const deleted = transaction.delete(literatureStaging).where(and(
          eq(literatureStaging.id, lock.id),
          eq(literatureStaging.revision, lock.expectedRevision)
        )).run().changes === 1
        items.push(deleted
          ? { id: lock.id, outcome: 'succeeded', error: null }
          : { id: lock.id, outcome: 'failed', error: stagingConflictError(lock.id, 'literature.staging.bulkDelete') })
      }
      return {
        items,
        succeeded: items.filter((item) => item.outcome === 'succeeded').length,
        skipped: items.filter((item) => item.outcome === 'skipped').length,
        failed: items.filter((item) => item.outcome === 'failed').length,
        canceled: false
      }
    })
    return LiteratureStagingBulkDeleteResultSchema.parse(receipt)
  }

  // Explicit aliases keep repository naming ergonomic for Service adapters
  // while all implementations share the same transaction and invariants.
  listLiteratureStagingRecords(inputValue: LiteratureStagingPageInput = { query: '' }): LiteratureStagingPage {
    return this.listLiteratureStaging(inputValue)
  }

  listLiteratureStagingPage(inputValue: LiteratureStagingPageInput = { query: '' }): LiteratureStagingPage {
    return this.listLiteratureStaging(inputValue)
  }

  getLiteratureStagingRecord(id: string): LiteratureStagingRecord {
    return this.getLiteratureStaging(id)
  }

  saveLiteratureStagingRecord(inputValue: LiteratureStagingSaveInput): LiteratureStagingRecord {
    return this.saveLiteratureStaging(inputValue)
  }

  deleteLiteratureStagingRecord(inputValue: LiteratureStagingDeleteInput): LiteratureStagingDeleteReceipt {
    return this.deleteLiteratureStaging(inputValue)
  }

  bulkDeleteLiteratureStagingRecords(inputValue: LiteratureStagingBulkDeleteInput): LiteratureStagingBulkDeleteResult {
    return this.bulkDeleteLiteratureStaging(inputValue)
  }

  listPapers(filter: Partial<PaperListFilter> = {}): Paper[] {
    return this.researchRepository.listPapers(filter)
  }

  getPapersByIds(ids: readonly string[]): Paper[] {
    return this.researchRepository.getPapersByIds(ids)
  }

  createPaper(input: CreatePaperInput): Paper {
    return this.researchRepository.createPaper(input)
  }

  updatePaper(input: UpdatePaperInput): Paper {
    return this.researchRepository.updatePaper(input)
  }

  archivePaper(id: string, expectedRevision: number): void {
    this.researchRepository.archivePaper(id, expectedRevision)
  }

  listLiteratureMatrix(projectId?: string | null): LiteratureMatrixEntry[] {
    return this.researchRepository.listLiteratureMatrix(projectId)
  }

  upsertLiteratureMatrix(input: UpsertLiteratureMatrixInput): LiteratureMatrixEntry {
    return this.researchRepository.upsertLiteratureMatrix(input)
  }

  removeLiteratureMatrix(input: RemoveLiteratureMatrixInput): void {
    this.researchRepository.removeLiteratureMatrix(input)
  }

  bulkDeleteLiteratureMatrix(input: LiteratureMatrixBulkDeleteInput): LiteratureMatrixBulkDeleteResult {
    return this.researchRepository.bulkDeleteLiteratureMatrix(input)
  }

  listResearchArtifacts(filter: ResearchArtifactListFilter = {}): ResearchArtifact[] {
    return this.researchRepository.listResearchArtifacts(filter)
  }

  createResearchArtifact(input: CreateResearchArtifactInput): ResearchArtifact {
    return this.researchRepository.createResearchArtifact(input)
  }

  updateResearchArtifact(input: UpdateResearchArtifactInput): ResearchArtifact {
    return this.researchRepository.updateResearchArtifact(input)
  }

  archiveResearchArtifact(id: string, expectedRevision: number): void {
    this.researchRepository.archiveResearchArtifact(id, expectedRevision)
  }

  listIntegrationProfiles(): IntegrationProfile[] {
    return this.researchRepository.listIntegrationProfiles()
  }

  getIntegrationProfile(id: string): IntegrationProfile {
    return this.researchRepository.getIntegrationProfile(id)
  }

  saveIntegrationProfile(
    input: DatabaseSaveIntegrationProfileInput,
    credentialPresent?: boolean
  ): IntegrationProfile {
    return this.researchRepository.saveIntegrationProfile(input, credentialPresent)
  }

  updateIntegrationStatus(input: UpdateIntegrationStatusInput): IntegrationProfile {
    return this.researchRepository.updateIntegrationStatus(input)
  }

  removeIntegrationProfile(id: string, expectedRevision: number): void {
    this.researchRepository.removeIntegrationProfile(id, expectedRevision)
  }

  listKnowledgeEngineConfigs(): KnowledgeEngineConfig[] {
    const rows = this.database
      .select()
      .from(workspaceKnowledgeEngines)
      .orderBy(asc(workspaceKnowledgeEngines.kind))
      .all()
    const byKind = new Map(rows.map((row) => [row.kind, row]))
    const timestamp = this.now().toISOString()
    // Always return both supported engines so the Settings page can render a
    // truthful, editable card even before the user has saved configuration.
    return (['anythingllm', 'llmwiki'] as const).map((kind) => {
      const row = byKind.get(kind)
      if (row) return toKnowledgeEngine(row)
      return KnowledgeEngineConfigSchema.parse({
        kind,
        enabled: true,
        baseUrl: '',
        workspace: '',
        collection: '',
        credentialPresent: false,
        status: 'not_configured',
        lastCheckedAt: null,
        lastError: null,
        updatedAt: timestamp,
        revision: 0
      })
    })
  }

  getKnowledgeEngineConfig(kindValue: KnowledgeEngineKind): KnowledgeEngineConfig {
    const kind = KnowledgeEngineKindSchema.parse(kindValue)
    const row = this.database.select().from(workspaceKnowledgeEngines).where(eq(workspaceKnowledgeEngines.kind, kind)).get()
    if (!row) return this.listKnowledgeEngineConfigs().find((item) => item.kind === kind)!
    return toKnowledgeEngine(row)
  }

  saveKnowledgeEngineConfig(inputValue: KnowledgeEngineSaveInput, credentialPresent = false): KnowledgeEngineConfig {
    const input = KnowledgeEngineSaveInputSchema.parse(inputValue)
    const timestamp = this.now().toISOString()
    return this.database.transaction((transaction) => {
      const current = transaction.select().from(workspaceKnowledgeEngines).where(eq(workspaceKnowledgeEngines.kind, input.kind)).get()
      if (!current && input.expectedRevision !== null && input.expectedRevision !== 0) {
        throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'knowledge engine revision does not match', { details: { kind: input.kind } })
      }
      if (current && input.expectedRevision !== null && current.revision !== input.expectedRevision) {
        throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'knowledge engine revision does not match', { details: { kind: input.kind } })
      }
      const nextRevision = current ? current.revision + 1 : 0
      const row = {
        kind: input.kind,
        enabled: input.enabled,
        baseUrl: input.baseUrl,
        workspace: input.workspace,
        collection: input.collection,
        credentialPresent: credentialPresent || current?.credentialPresent === true,
        // Configuration changes invalidate a previous health result; require
        // an explicit Test action before reporting connected again.
        status: input.baseUrl.trim() ? 'disconnected' : 'not_configured',
        lastCheckedAt: null,
        lastError: null,
        updatedAt: timestamp,
        revision: nextRevision
      } as const
      if (current) transaction.update(workspaceKnowledgeEngines).set(row).where(eq(workspaceKnowledgeEngines.kind, input.kind)).run()
      else transaction.insert(workspaceKnowledgeEngines).values(row).run()
      return toKnowledgeEngine(row as WorkspaceKnowledgeEngineRow)
    })
  }

  updateKnowledgeEngineStatus(input: {
    kind: KnowledgeEngineKind
    status: KnowledgeEngineStatus
    message: string | null
    checkedAt: string
  }): KnowledgeEngineConfig {
    const kind = KnowledgeEngineKindSchema.parse(input.kind)
    const status = KnowledgeEngineStatusSchema.parse(input.status)
    const current = this.database.select().from(workspaceKnowledgeEngines).where(eq(workspaceKnowledgeEngines.kind, kind)).get()
    if (!current) {
      // A test can race with a first-time save. Materialize a safe default,
      // then update it in the same process without exposing a secret.
      this.saveKnowledgeEngineConfig({ kind, enabled: true, baseUrl: '', workspace: '', collection: '', expectedRevision: null }, false)
    }
    const latest = this.database.select().from(workspaceKnowledgeEngines).where(eq(workspaceKnowledgeEngines.kind, kind)).get()!
    const row = {
      status,
      lastCheckedAt: input.checkedAt,
      lastError: input.message,
      updatedAt: input.checkedAt,
      revision: latest.revision + 1
    }
    this.database.update(workspaceKnowledgeEngines).set(row).where(eq(workspaceKnowledgeEngines.kind, kind)).run()
    return toKnowledgeEngine({ ...latest, ...row })
  }

  listExternalLinks(profileId?: string): ExternalLink[] {
    return this.researchRepository.listExternalLinks(profileId)
  }

  saveExternalLink(input: SaveExternalLinkInput): ExternalLink {
    return this.researchRepository.saveExternalLink(input)
  }

  upsertExternalPaper(
    profileId: string,
    provider: IntegrationProfile['provider'],
    input: UpsertExternalPaperInput
  ): { paper: Paper; link: ExternalLink } {
    return this.researchRepository.upsertExternalPaper(profileId, provider, input)
  }

  createSyncRun(profileId: string, direction: SyncRun['direction'] = 'both'): SyncRun {
    return this.researchRepository.createSyncRun(profileId, direction)
  }

  updateSyncRun(input: UpdateSyncRunInput): SyncRun {
    return this.researchRepository.updateSyncRun(input)
  }

  completeSyncRun(id: string, result: CompleteSyncRunInput = {}): SyncRun {
    return this.researchRepository.completeSyncRun(id, result)
  }

  listSyncRuns(profileId?: string): SyncRun[] {
    return this.researchRepository.listSyncRuns(profileId)
  }

  listPromptTemplates(): PromptTemplate[] {
    return this.researchRepository.listPromptTemplates()
  }

  getPromptTemplate(id: string): PromptTemplate {
    return this.researchRepository.getPromptTemplate(id)
  }

  savePromptTemplate(input: SavePromptTemplateInput): PromptTemplate {
    return this.researchRepository.savePromptTemplate(input)
  }

  listAiProviderProfiles(): AiProviderProfile[] {
    return this.researchRepository.listAiProviderProfiles()
  }

  getAiProviderProfile(id: string): AiProviderProfile {
    return this.researchRepository.getAiProviderProfile(id)
  }

  saveAiProviderProfile(
    input: DatabaseSaveAiProviderProfileInput,
    credentialPresent?: boolean
  ): AiProviderProfile {
    return this.researchRepository.saveAiProviderProfile(input, credentialPresent)
  }

  removeAiProviderProfile(id: string, expectedRevision: number): void {
    this.researchRepository.removeAiProviderProfile(id, expectedRevision)
  }

  listAgentRuns(limit = 100): AgentRun[] {
    return this.researchRepository.listAgentRuns(limit)
  }

  reconcileInterruptedAgentRuns(): number {
    return this.researchRepository.reconcileInterruptedAgentRuns()
  }

  startAgentRun(input: StartAgentRunInput): AgentRun {
    return this.researchRepository.startAgentRun(input)
  }

  createAgentRun(input: StartAgentRunInput): AgentRun {
    return this.researchRepository.createAgentRun(input)
  }

  updateAgentRun(input: UpdateAgentRunInput): AgentRun {
    return this.researchRepository.updateAgentRun(input)
  }

  completeAgentRun(id: string, result: CompleteAgentRunInput): AgentRun {
    return this.researchRepository.completeAgentRun(id, result)
  }

  cancelAgentRun(id: string): void {
    this.researchRepository.cancelAgentRun(id)
  }

  listSchedules(): Schedule[] {
    return this.researchRepository.listSchedules()
  }

  getSchedule(id: string): Schedule {
    return this.researchRepository.getSchedule(id)
  }

  listDueSchedules(at: Date = this.now()): Schedule[] {
    return this.researchRepository.listDueSchedules(at)
  }

  saveSchedule(input: SaveScheduleInput): Schedule {
    return this.researchRepository.saveSchedule(input)
  }

  updateScheduleTiming(input: UpdateScheduleTimingInput): Schedule {
    return this.researchRepository.updateScheduleTiming(input)
  }

  markScheduleRun(
    id: string,
    expectedRevision: number,
    nextRunAt: string | null,
    lastRunAt: string = this.now().toISOString()
  ): Schedule {
    return this.researchRepository.markScheduleRun(id, expectedRevision, nextRunAt, lastRunAt)
  }

  removeSchedule(id: string, expectedRevision: number): void {
    this.researchRepository.removeSchedule(id, expectedRevision)
  }

  listAgentConnectors(): AgentConnector[] {
    return this.database.select().from(agentConnectors).orderBy(asc(agentConnectors.runtime)).all().map(toAgentConnector)
  }

  getAgentConnector(runtime: AgentRuntimeKind): AgentConnector {
    const row = this.database.select().from(agentConnectors).where(eq(agentConnectors.runtime, runtime)).get()
    if (!row) throw new WorkbenchDatabaseError('NOT_FOUND', 'agent connector not found', { details: { runtime } })
    return toAgentConnector(row)
  }

  saveAgentConnector(inputValue: AgentConnectorSaveInput): AgentConnector {
    const input = AgentConnectorSaveInputSchema.parse(inputValue)
    const id = input.id ?? `builtin.agent.${input.runtime}`
    const timestamp = this.now().toISOString()
    return this.database.transaction((transaction) => {
      const current = transaction.select().from(agentConnectors).where(eq(agentConnectors.id, id)).get()
      if (!current) {
        const row = {
          id,
          runtime: input.runtime,
          executablePath: input.executablePath,
          version: null,
          enabled: input.enabled,
          available: false,
          mcp: true,
          structuredOutput: true,
          workspaceWrite: true,
          message: '',
          proxyEnabled: input.proxyEnabled,
          httpProxy: input.httpProxy,
          httpsProxy: input.httpsProxy,
          noProxy: input.noProxy,
          updatedAt: timestamp,
          revision: 0
        }
        transaction.insert(agentConnectors).values(row).run()
        return toAgentConnector(transaction.select().from(agentConnectors).where(eq(agentConnectors.id, id)).get()!)
      }
      if (input.expectedRevision !== null && input.expectedRevision !== current.revision) {
        throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'agent connector was changed by another operation', { retryable: true })
      }
      transaction.update(agentConnectors).set({
        runtime: input.runtime,
        executablePath: input.executablePath,
        enabled: input.enabled,
        proxyEnabled: input.proxyEnabled,
        httpProxy: input.httpProxy,
        httpsProxy: input.httpsProxy,
        noProxy: input.noProxy,
        updatedAt: timestamp,
        revision: current.revision + 1
      }).where(eq(agentConnectors.id, id)).run()
      return toAgentConnector(transaction.select().from(agentConnectors).where(eq(agentConnectors.id, id)).get()!)
    })
  }

  updateAgentConnectorHealth(runtime: AgentRuntimeKind, health: Pick<AgentConnector, 'available' | 'version' | 'message' | 'mcp' | 'structuredOutput' | 'workspaceWrite'>): AgentConnector {
    const current = this.database.select().from(agentConnectors).where(eq(agentConnectors.runtime, runtime)).get()
    if (!current) throw new WorkbenchDatabaseError('NOT_FOUND', 'agent connector not found', { details: { runtime } })
    const updated = this.database.update(agentConnectors).set({
      available: health.available,
      version: health.version,
      message: health.message,
      mcp: health.mcp,
      structuredOutput: health.structuredOutput,
      workspaceWrite: health.workspaceWrite,
      updatedAt: this.now().toISOString(),
      revision: current.revision + 1
    }).where(eq(agentConnectors.id, current.id)).returning().get()
    return toAgentConnector(updated!)
  }

  listAgentBindings(): AgentBinding[] {
    return this.database.select().from(agentBindings).orderBy(asc(agentBindings.projectId)).all().map(toAgentBinding)
  }

  listAgentProxyProfiles(): AgentProxyProfile[] { return this.database.select().from(agentProxyProfiles).orderBy(asc(agentProxyProfiles.name)).all().map(toAgentProxyProfile) }
  saveAgentProxyProfile(inputValue: AgentProxyProfileSaveInput): AgentProxyProfile {
    const input = inputValue; const timestamp = this.now().toISOString(); const id = input.id ?? `proxy.profile.${randomUUID()}`
    return this.database.transaction((tx) => { const current = tx.select().from(agentProxyProfiles).where(eq(agentProxyProfiles.id, id)).get(); if (current && input.expectedRevision !== null && input.expectedRevision !== current.revision) throw new WorkbenchDatabaseError('REVISION_CONFLICT','proxy profile changed',{retryable:true}); if (!current) tx.insert(agentProxyProfiles).values({ id, name: input.name, enabled: input.enabled, httpProxy: input.httpProxy, httpsProxy: input.httpsProxy, noProxy: input.noProxy, createdAt: timestamp, updatedAt: timestamp, revision: 0 }).run(); else tx.update(agentProxyProfiles).set({name:input.name,enabled:input.enabled,httpProxy:input.httpProxy,httpsProxy:input.httpsProxy,noProxy:input.noProxy,updatedAt:timestamp,revision:current.revision+1}).where(eq(agentProxyProfiles.id,id)).run(); return toAgentProxyProfile(tx.select().from(agentProxyProfiles).where(eq(agentProxyProfiles.id,id)).get()!) })
  }
  listAgentProxyBindings(): AgentProxyBinding[] { return this.database.select().from(agentProxyBindings).all().map(toAgentProxyBinding) }
  saveAgentProxyBinding(inputValue: AgentProxyBindingSaveInput): AgentProxyBinding { const input=inputValue; const timestamp=this.now().toISOString(); const id=input.id ?? `proxy.binding.${input.runtime}`; return this.database.transaction(tx=>{const current=tx.select().from(agentProxyBindings).where(eq(agentProxyBindings.id,id)).get(); if(current && input.expectedRevision!==null && input.expectedRevision!==current.revision) throw new WorkbenchDatabaseError('REVISION_CONFLICT','proxy binding changed',{retryable:true}); if(!current) tx.insert(agentProxyBindings).values({id,profileId:input.profileId,runtime:input.runtime,createdAt:timestamp,updatedAt:timestamp,revision:0}).run(); else tx.update(agentProxyBindings).set({profileId:input.profileId,runtime:input.runtime,updatedAt:timestamp,revision:current.revision+1}).where(eq(agentProxyBindings.id,id)).run(); return toAgentProxyBinding(tx.select().from(agentProxyBindings).where(eq(agentProxyBindings.id,id)).get()!)}) }

  saveAgentBinding(inputValue: AgentBindingSaveInput): AgentBinding {
    const input = AgentBindingSaveInputSchema.parse(inputValue)
    const timestamp = this.now().toISOString()
    return this.database.transaction((transaction) => {
      const current = input.id
        ? transaction.select().from(agentBindings).where(eq(agentBindings.id, input.id)).get()
        : input.projectId === null
          ? transaction.select().from(agentBindings).where(isNull(agentBindings.projectId)).get()
          : transaction.select().from(agentBindings).where(eq(agentBindings.projectId, input.projectId)).get()
      if (!current) {
        const row = {
          id: input.id ?? uuidv7(),
          projectId: input.projectId,
          runtime: input.runtime,
          fallbackRuntime: input.fallbackRuntime,
          createdAt: timestamp,
          updatedAt: timestamp,
          revision: 0
        }
        transaction.insert(agentBindings).values(row).run()
        return toAgentBinding(transaction.select().from(agentBindings).where(eq(agentBindings.id, row.id)).get()!)
      }
      if (input.expectedRevision !== null && input.expectedRevision !== current.revision) {
        throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'agent binding was changed by another operation', { retryable: true })
      }
      transaction.update(agentBindings).set({
        projectId: input.projectId,
        runtime: input.runtime,
        fallbackRuntime: input.fallbackRuntime,
        updatedAt: timestamp,
        revision: current.revision + 1
      }).where(eq(agentBindings.id, current.id)).run()
      return toAgentBinding(transaction.select().from(agentBindings).where(eq(agentBindings.id, current.id)).get()!)
    })
  }

  createAgentConversation(inputValue: AgentConversationCreateInput): AgentConversation {
    const input = AgentConversationCreateInputSchema.parse(inputValue)
    const timestamp = this.now().toISOString()
    const row = {
      id: uuidv7(),
      projectId: input.projectId,
      title: input.title,
      runtime: input.runtime,
      model: input.model,
      assistantKey: input.assistantKey,
      toolProfile: input.toolProfile,
      permissionMode: input.permissionMode,
      approvalPolicy: input.approvalPolicy,
      status: 'pending' as const,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      revision: 0
    }
    this.database.insert(agentConversations).values(row).run()
    return toAgentConversation(row)
  }

  listAgentConversations(inputValue: { readonly projectId?: string | null | undefined; readonly includeArchived?: boolean | undefined; readonly limit?: number | undefined } = {}): AgentConversation[] {
    const projectId = inputValue.projectId
    const limit = z.int().min(1).max(100).parse(inputValue.limit ?? 50)
    const conditions: SQL[] = []
    if (projectId === null) conditions.push(isNull(agentConversations.projectId))
    else if (projectId !== undefined) conditions.push(eq(agentConversations.projectId, projectId))
    if (!inputValue.includeArchived) conditions.push(isNull(agentConversations.archivedAt))
    const query = this.database.select().from(agentConversations)
    return (conditions.length > 0 ? query.where(and(...conditions)) : query)
      .orderBy(desc(agentConversations.updatedAt)).limit(limit).all().map(toAgentConversation)
  }

  getAgentConversation(id: string): AgentConversation {
    const row = this.database.select().from(agentConversations).where(eq(agentConversations.id, id)).get()
    if (!row) throw new WorkbenchDatabaseError('NOT_FOUND', 'agent conversation not found', { details: { id } })
    return toAgentConversation(row)
  }

  listAgentMessages(conversationId: string, limit = 200): AgentMessage[] {
    this.getAgentConversation(conversationId)
    const safeLimit = z.int().min(1).max(500).parse(limit)
    return this.database.select().from(agentMessages)
      .where(eq(agentMessages.conversationId, conversationId))
      .orderBy(asc(agentMessages.seq)).limit(safeLimit).all().map(toAgentMessage)
  }

  appendAgentMessage(input: { readonly conversationId: string; readonly runId?: string | null; readonly role: AgentMessage['role']; readonly content: string }): AgentMessage {
    const content = (redactAgentText(input.content) ?? '').slice(0, 100_000)
    return this.database.transaction((transaction) => {
      const conversation = transaction.select().from(agentConversations).where(eq(agentConversations.id, input.conversationId)).get()
      if (!conversation || conversation.archivedAt !== null) throw new WorkbenchDatabaseError('NOT_FOUND', 'active agent conversation not found', { details: { id: input.conversationId } })
      const latest = transaction.select({ seq: agentMessages.seq }).from(agentMessages)
        .where(eq(agentMessages.conversationId, input.conversationId)).orderBy(desc(agentMessages.seq)).limit(1).get()
      const row = {
        id: uuidv7(),
        conversationId: input.conversationId,
        runId: input.runId ?? null,
        role: input.role,
        content,
        createdAt: this.now().toISOString(),
        seq: (latest?.seq ?? -1) + 1
      }
      transaction.insert(agentMessages).values(row).run()
      transaction.update(agentConversations).set({ updatedAt: row.createdAt, revision: conversation.revision + 1 }).where(eq(agentConversations.id, conversation.id)).run()
      return toAgentMessage(row)
    })
  }

  updateAgentConversationStatus(id: string, status: AgentConversation['status']): AgentConversation {
    const current = this.database.select().from(agentConversations).where(eq(agentConversations.id, id)).get()
    if (!current) throw new WorkbenchDatabaseError('NOT_FOUND', 'agent conversation not found', { details: { id } })
    const updated = this.database.update(agentConversations).set({ status, updatedAt: this.now().toISOString(), revision: current.revision + 1 }).where(eq(agentConversations.id, id)).returning().get()
    return toAgentConversation(updated!)
  }

  archiveAgentConversation(id: string, expectedRevision: number): void {
    const current = this.database.select().from(agentConversations).where(eq(agentConversations.id, id)).get()
    if (!current || current.archivedAt !== null) throw new WorkbenchDatabaseError('NOT_FOUND', 'active agent conversation not found', { details: { id } })
    if (current.revision !== expectedRevision) throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'agent conversation was changed by another operation', { retryable: true })
    this.database.update(agentConversations).set({ status: 'archived', archivedAt: this.now().toISOString(), updatedAt: this.now().toISOString(), revision: current.revision + 1 }).where(eq(agentConversations.id, id)).run()
  }

  /** Archive a selected conversation set in one transaction. Every revision is
   * checked before the first update so a stale bulk selection cannot partially
   * remove history. */
  archiveAgentConversations(items: AgentConversationArchiveItem[]): void {
    const parsed = AgentConversationArchiveBulkInputSchema.parse({ items })
    if (parsed.items.length === 0) return
    this.database.transaction((transaction) => {
      const timestamp = this.now().toISOString()
      const rows = parsed.items.map((item) => {
        const current = transaction.select().from(agentConversations).where(eq(agentConversations.id, item.conversationId)).get()
        if (!current || current.archivedAt !== null) throw new WorkbenchDatabaseError('NOT_FOUND', 'active agent conversation not found', { details: { id: item.conversationId } })
        if (current.revision !== item.expectedRevision) throw new WorkbenchDatabaseError('REVISION_CONFLICT', 'agent conversation was changed by another operation', { retryable: true, details: { id: item.conversationId } })
        return current
      })
      rows.forEach((current) => {
        transaction.update(agentConversations).set({ status: 'archived', archivedAt: timestamp, updatedAt: timestamp, revision: current.revision + 1 }).where(eq(agentConversations.id, current.id)).run()
      })
    })
  }

  startManagedAgentRun(input: {
    readonly jobId?: string | null
    readonly conversationId?: string | null
    readonly runtime: AgentRuntimeKind
    readonly transport: 'cli' | 'inprocess'
    readonly workflowKey: import('@prw/contracts').AgentWorkflowKey
    readonly projectId: string | null
     readonly paperIds: string[]
     readonly instructions: string
     readonly thinking?: string | null
    readonly toolProfile: 'read-only' | 'approved-write'
    readonly permissionMode?: 'read-only' | 'auto' | 'full-access'
    readonly approvalPolicy?: 'on-request' | 'never'
    readonly idempotencyKey?: string | null
  }): AgentRunRecord {
    if (input.idempotencyKey) {
      const existing = this.database.select().from(agentRuns)
        .where(eq(agentRuns.idempotencyKey, input.idempotencyKey))
        .get()
      if (existing) return toManagedAgentRun(existing)
    }
    const promptTemplateId = promptTemplateForWorkflow(input.workflowKey)
    const legacy = this.researchRepository.startAgentRun({
      workflowKey: input.workflowKey,
      providerProfileId: null,
      promptTemplateId,
      projectId: input.projectId,
      paperIds: input.paperIds,
      variables: { instructions: input.instructions, ...(input.thinking ? { thinking: input.thinking } : {}) },
      instructions: input.instructions
    })
    this.database.update(agentRuns).set({
      jobId: input.jobId ?? null,
      conversationId: input.conversationId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      runtime: input.runtime,
      transport: input.transport,
      toolProfile: input.toolProfile,
      permissionMode: input.permissionMode ?? (input.toolProfile === 'approved-write' ? 'auto' : 'read-only'),
      approvalPolicy: input.approvalPolicy ?? 'on-request',
      agentStatus: 'queued'
    }).where(eq(agentRuns.id, legacy.id)).run()
    return this.getManagedAgentRun(legacy.id)
  }

  getManagedAgentRun(id: string): AgentRunRecord {
    const row = this.database.select().from(agentRuns).where(eq(agentRuns.id, id)).get()
    if (!row) throw new WorkbenchDatabaseError('NOT_FOUND', 'agent run not found', { details: { id } })
    return toManagedAgentRun(row)
  }

  getManagedAgentRunByIdempotency(idempotencyKey: string): AgentRunRecord | null {
    const row = this.database.select().from(agentRuns)
      .where(eq(agentRuns.idempotencyKey, idempotencyKey))
      .get()
    return row ? toManagedAgentRun(row) : null
  }

  listManagedAgentRuns(limit = 100, filter: { readonly status?: AgentRunStatus; readonly projectId?: string | null; readonly hasJobId?: boolean } = {}): AgentRunRecord[] {
    const safeLimit = z.int().min(1).max(1_000).parse(limit)
    const conditions: SQL[] = []
    if (filter.status) conditions.push(eq(agentRuns.agentStatus, filter.status))
    if (filter.projectId === null) conditions.push(isNull(agentRuns.projectId))
    else if (filter.projectId !== undefined) conditions.push(eq(agentRuns.projectId, filter.projectId))
    if (filter.hasJobId === true) conditions.push(isNotNull(agentRuns.jobId))
    if (filter.hasJobId === false) conditions.push(isNull(agentRuns.jobId))
    const query = this.database.select().from(agentRuns)
    return (conditions.length > 0 ? query.where(and(...conditions)) : query)
      .orderBy(desc(agentRuns.createdAt)).limit(safeLimit).all().map(toManagedAgentRun)
  }

  reconcileInterruptedManagedAgentRuns(): number {
    const stale = this.database.select({ id: agentRuns.id, conversationId: agentRuns.conversationId })
      .from(agentRuns)
      .where(inArray(agentRuns.agentStatus, ['planned', 'queued', 'running', 'waiting_confirmation']))
      .all()
    for (const row of stale) {
      this.appendAgentEvent(row.id, 'failed', { message: 'The previous workspace service session ended before this run completed.' })
      this.updateManagedAgentRun({
        id: row.id,
        status: 'failed',
        error: 'The previous workspace service session ended before this run completed.'
      })
      // A crashed process cannot leave the conversation permanently marked as
      // “running”.  The run remains failed/auditable and the conversation is
      // returned to pending so the user may inspect it or send another turn.
      if (row.conversationId !== null) {
        const conversation = this.database.select().from(agentConversations)
          .where(eq(agentConversations.id, row.conversationId)).get()
        if (conversation && conversation.archivedAt === null && conversation.status === 'running') {
          this.database.update(agentConversations).set({
            status: 'pending',
            updatedAt: this.now().toISOString(),
            revision: conversation.revision + 1
          }).where(eq(agentConversations.id, conversation.id)).run()
        }
      }
    }
    return stale.length
  }

  updateManagedAgentRun(input: { readonly id: string; readonly status: AgentRunStatus; readonly output?: string; readonly error?: string | null; readonly artifactId?: string | null }): AgentRunRecord {
    const current = this.database.select().from(agentRuns).where(eq(agentRuns.id, input.id)).get()
    if (!current) throw new WorkbenchDatabaseError('NOT_FOUND', 'agent run not found', { details: { id: input.id } })
    const terminal = ['completed', 'partial', 'failed', 'canceled', 'missed'].includes(input.status)
    const legacyStatus = input.status === 'completed' ? 'completed' : input.status === 'canceled' ? 'canceled' : input.status === 'queued' || input.status === 'planned' ? 'queued' : input.status === 'running' || input.status === 'waiting_confirmation' ? 'running' : 'failed'
    const updated = this.database.update(agentRuns).set({
      status: legacyStatus,
      agentStatus: input.status,
      output: input.output ?? current.output,
      error: input.error === undefined ? current.error : input.error,
      artifactId: input.artifactId === undefined ? current.artifactId : input.artifactId,
      startedAt: input.status === 'running' ? current.startedAt ?? this.now().toISOString() : current.startedAt,
      finishedAt: terminal ? current.finishedAt ?? this.now().toISOString() : null
    }).where(eq(agentRuns.id, input.id)).returning().get()
    return toManagedAgentRun(updated!)
  }

  appendAgentEvent(runId: string, kind: import('@prw/contracts').AgentEventKind, payload: unknown): AgentEventRecord {
    const run = this.database.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.id, runId)).get()
    if (!run) throw new WorkbenchDatabaseError('NOT_FOUND', 'agent run not found', { details: { id: runId } })
    const latest = this.database.select({ seq: agentRunEvents.seq }).from(agentRunEvents).where(eq(agentRunEvents.runId, runId)).orderBy(desc(agentRunEvents.seq)).limit(1).get()
    const row = {
      id: uuidv7(),
      runId,
      seq: (latest?.seq ?? -1) + 1,
      kind,
      payloadJson: serializeAgentPayload(payload),
      createdAt: this.now().toISOString()
    }
    this.database.insert(agentRunEvents).values(row).run()
    return toAgentEvent(row)
  }

  listAgentEvents(runId: string, afterSeq = 0, limit = 100): AgentEventRecord[] {
    const parsedAfter = z.int().nonnegative().parse(afterSeq)
    const parsedLimit = z.int().min(1).max(500).parse(limit)
    return this.database.select().from(agentRunEvents)
      .where(and(eq(agentRunEvents.runId, runId), gt(agentRunEvents.seq, parsedAfter)))
      .orderBy(asc(agentRunEvents.seq)).limit(parsedLimit).all().map(toAgentEvent)
  }

  /** Insert or update one normalized ledger record.
   *
   * `recordKey` is the adapter's stable identity, so a streamed record grows in
   * place instead of appending a row per delta; `seq` is assigned on first
   * insert and never moves, which is what makes it usable as the trajectory's
   * `#seq` anchor. Unspecified draft fields keep their stored value so a late
   * lifecycle update cannot erase the start of a record. */
  upsertAgentRunRecord(runId: string, draft: AgentRunRecordDraft): AgentRunRecordEntry {
    const run = this.database.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.id, runId)).get()
    if (!run) throw new WorkbenchDatabaseError('NOT_FOUND', 'agent run not found', { details: { id: runId } })
    const recordKey = draft.recordKey.slice(0, 512)
    if (recordKey.length === 0) throw new WorkbenchDatabaseError('VALIDATION_FAILED', 'agent run record requires a recordKey')
    const title = clipAgentRecordText(draft.title ?? '')
    const detail = clipAgentRecordText(draft.detail ?? '')
    const inputText = clipAgentRecordText(draft.inputText)
    const outputText = clipAgentRecordText(draft.outputText)
    const usage = sanitizeAgentUsage(draft.usage)
    const fields = {
      kind: draft.kind,
      // `turn`/`step` are omitted by the closing drafts the normalizer emits for
      // records a CLI left open, so they follow the same "unspecified keeps the
      // stored value" rule as the fields below instead of defaulting to 0.
      turn: draft.turn === undefined ? null : z.int().nonnegative().parse(draft.turn),
      step: draft.step === undefined ? null : z.int().nonnegative().parse(draft.step),
      title: (title.text ?? '').slice(0, 500),
      detail: (detail.text ?? '').slice(0, agentRecordTextLimit),
      inputText: inputText.text,
      outputText: outputText.text,
      toolName: draft.toolName ? redactAgentText(draft.toolName.slice(0, 200)) : null,
      callId: draft.callId ? redactAgentText(draft.callId.slice(0, 200)) : null,
      // Not redacted, unlike the display fields above: `parentId` is an opaque
      // cross-reference to another row's `recordKey`, which is stored raw because
      // it is the upsert key. Redacting only one side would stop subtool nesting
      // from matching. The parent's own title/detail are still redacted.
      parentId: draft.parentId ? draft.parentId.slice(0, 512) : null,
      startedAt: draft.startedAt ?? null,
      finishedAt: draft.finishedAt ?? null,
      durationMs: draft.durationMs === null || draft.durationMs === undefined ? null : Math.max(0, Math.round(draft.durationMs)),
      usageJson: usage === null ? null : JSON.stringify(usage),
      truncated: title.truncated || detail.truncated || inputText.truncated || outputText.truncated
    }
    return this.database.transaction((transaction) => {
      const existing = transaction.select().from(agentRunRecords)
        .where(and(eq(agentRunRecords.runId, runId), eq(agentRunRecords.recordKey, recordKey))).get()
      if (existing) {
        const updated = transaction.update(agentRunRecords).set({
          ...fields,
          status: draft.status ?? existing.status,
          turn: fields.turn ?? existing.turn,
          step: fields.step ?? existing.step,
          title: fields.title.length > 0 ? fields.title : existing.title,
          detail: fields.detail.length > 0 ? fields.detail : existing.detail,
          inputText: fields.inputText ?? existing.inputText,
          outputText: fields.outputText ?? existing.outputText,
          toolName: fields.toolName ?? existing.toolName,
          callId: fields.callId ?? existing.callId,
          parentId: fields.parentId ?? existing.parentId,
          startedAt: fields.startedAt ?? existing.startedAt,
          finishedAt: fields.finishedAt ?? existing.finishedAt,
          durationMs: fields.durationMs ?? existing.durationMs,
          usageJson: fields.usageJson ?? existing.usageJson,
          truncated: fields.truncated || existing.truncated
        }).where(eq(agentRunRecords.id, existing.id)).returning().get()
        return toAgentRunRecordEntry(updated!)
      }
      const latest = transaction.select({ seq: agentRunRecords.seq }).from(agentRunRecords)
        .where(eq(agentRunRecords.runId, runId)).orderBy(desc(agentRunRecords.seq)).limit(1).get()
      const row = {
        id: uuidv7(),
        runId,
        seq: (latest?.seq ?? -1) + 1,
        recordKey,
        status: draft.status ?? ('info' as const),
        ...fields,
        turn: fields.turn ?? 0,
        step: fields.step ?? 0,
        createdAt: this.now().toISOString()
      }
      transaction.insert(agentRunRecords).values(row).run()
      return toAgentRunRecordEntry(row)
    })
  }

  /** Trajectory window. `afterSeq` tops up a live run, `beforeSeq` walks older
   * rows, and omitting both returns the newest `limit` rows. */
  listAgentRunRecords(input: AgentRunRecordsPageInput): AgentRunRecordEntry[] {
    const parsed = AgentRunRecordsPageInputSchema.parse(input)
    if (parsed.afterSeq !== null) {
      return this.database.select().from(agentRunRecords)
        .where(and(eq(agentRunRecords.runId, parsed.runId), gt(agentRunRecords.seq, parsed.afterSeq)))
        .orderBy(asc(agentRunRecords.seq)).limit(parsed.limit).all().map(toAgentRunRecordEntry)
    }
    const ascending = this.database.select().from(agentRunRecords)
      .where(parsed.beforeSeq === null
        ? eq(agentRunRecords.runId, parsed.runId)
        : and(eq(agentRunRecords.runId, parsed.runId), lt(agentRunRecords.seq, parsed.beforeSeq)))
      .orderBy(desc(agentRunRecords.seq)).limit(parsed.limit).all()
    return ascending.reverse().map(toAgentRunRecordEntry)
  }

  /** Chat projection: the newest `limit` records across every run of one
   * conversation, returned oldest-first. */
  listAgentConversationRecords(input: AgentConversationRecordsInput): AgentRunRecordEntry[] {
    const parsed = AgentConversationRecordsInputSchema.parse(input)
    const rows = this.database.select({ record: agentRunRecords })
      .from(agentRunRecords)
      .innerJoin(agentRuns, eq(agentRunRecords.runId, agentRuns.id))
      .where(eq(agentRuns.conversationId, parsed.conversationId))
      .orderBy(desc(agentRuns.createdAt), desc(agentRunRecords.seq))
      .limit(parsed.limit).all()
    return rows.reverse().map((row) => toAgentRunRecordEntry(row.record))
  }

  createAgentInboxItem(input: { readonly runId: string | null; readonly artifactId: string | null; readonly title: string; readonly body: string; readonly kind: string }): AgentInboxItem {
    const row = {
      id: uuidv7(),
      runId: input.runId,
      artifactId: input.artifactId,
      title: input.title.slice(0, 500),
      body: (redactAgentText(input.body) ?? '').slice(0, 100_000),
      kind: input.kind,
      read: false,
      archivedAt: null,
      createdAt: this.now().toISOString()
    }
    this.database.insert(agentInboxItems).values(row).run()
    return toAgentInboxItem(row)
  }

  listAgentInbox(unreadOnly = false): AgentInboxItem[] {
    const condition = unreadOnly
      ? and(eq(agentInboxItems.read, false), isNull(agentInboxItems.archivedAt))
      : isNull(agentInboxItems.archivedAt)
    return this.database.select().from(agentInboxItems).where(condition).orderBy(desc(agentInboxItems.createdAt)).all().map(toAgentInboxItem)
  }

  markAgentInboxRead(id: string): void {
    this.database.update(agentInboxItems).set({ read: true }).where(eq(agentInboxItems.id, id)).run()
  }

  archiveAgentInbox(id: string): void {
    this.database.update(agentInboxItems).set({ archivedAt: this.now().toISOString() }).where(eq(agentInboxItems.id, id)).run()
  }

  private requireProject(
    projectId: string,
    database: BetterSQLite3Database<typeof schema> = this.database
  ): ProjectRow {
    const project = database.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) notFound('project', projectId)
    if (project.status === 'archived') {
      throw new WorkbenchDatabaseError('INVALID_PLACEMENT', 'archived projects cannot receive tasks', {
        details: { projectId }
      })
    }
    return project
  }

  private resolvePlacement(
    database: BetterSQLite3Database<typeof schema>,
    projectId: string | null,
    columnId: string | null
  ): Placement {
    if (projectId === null) {
      if (columnId !== null) {
        throw new WorkbenchDatabaseError(
          'INVALID_PLACEMENT',
          'inbox tasks cannot reference a project board column',
          { details: { columnId } }
        )
      }
      return { projectId: null, columnId: null, status: 'inbox' }
    }

    this.requireProject(projectId, database)
    const requestedStatus = columnId?.startsWith('status:') ? columnId.slice('status:'.length) : null
    const column = requestedStatus !== null
      ? database
          .select()
          .from(boardColumns)
          .where(and(eq(boardColumns.projectId, projectId), eq(boardColumns.status, requestedStatus as BoardColumn['status'])))
          .get()
      : columnId === null
        ? database
            .select()
            .from(boardColumns)
            .where(and(eq(boardColumns.projectId, projectId), eq(boardColumns.status, 'planned')))
            .get()
        : database.select().from(boardColumns).where(eq(boardColumns.id, columnId)).get()

    if (!column) notFound('board column', columnId ?? `${projectId}:planned`)
    if (column.projectId !== projectId) {
      throw new WorkbenchDatabaseError(
        'INVALID_PLACEMENT',
        'board column does not belong to the selected project',
        { details: { projectId, columnId: column.id } }
      )
    }
    return { projectId, columnId: column.id, status: column.status }
  }
}
