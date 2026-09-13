import type {
  AgentRun,
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
  ScheduleOccurrence,
  StartAgentRunInput,
  SyncRun,
  UpdatePaperInput,
  UpdateResearchArtifactInput,
  UpsertLiteratureMatrixInput,
  RemoveLiteratureMatrixInput,
  LiteratureMatrixBulkDeleteInput,
  LiteratureMatrixBulkDeleteResult,
  ArchiveBulkInput,
  ArchiveBulkReceipt,
  ArchiveBulkResult
} from '@prw/contracts'
import {
  AgentRunSchema,
  AiProviderProfileSchema,
  CreatePaperInputSchema,
  CreateResearchArtifactInputSchema,
  ExternalLinkSchema,
  IntegrationProfileSchema,
  LiteratureMatrixEntrySchema,
  PaperListFilterSchema,
  PaperSchema,
  PromptTemplateSchema,
  ResearchArtifactSchema,
  SaveAiProviderProfileInputSchema,
  SaveIntegrationProfileInputSchema,
  SavePromptTemplateInputSchema,
  SaveScheduleInputSchema,
  ScheduleSchema,
  ScheduleOccurrenceSchema,
  StartAgentRunInputSchema,
  SyncRunSchema,
  UpdatePaperInputSchema,
  UpdateResearchArtifactInputSchema,
  UpsertLiteratureMatrixInputSchema,
  RemoveLiteratureMatrixInputSchema,
  LiteratureMatrixBulkDeleteInputSchema,
  LiteratureMatrixBulkDeleteResultSchema,
  ArchiveBulkInputSchema,
  ArchiveBulkResultSchema
} from '@prw/contracts'
import { and, asc, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { uuidv7 } from 'uuidv7'
import { z } from 'zod'
import { WorkbenchDatabaseError } from './errors.js'
import {
  agentRuns,
  aiProviderProfiles,
  externalLinks,
  integrationProfiles,
  literatureMatrixEntries,
  papers,
  promptTemplates,
  researchArtifacts,
  scheduleOccurrences,
  schedules,
  syncRuns,
  type AgentRunRow,
  type AiProviderProfileRow,
  type ExternalLinkRow,
  type IntegrationProfileRow,
  type LiteratureMatrixEntryRow,
  type PaperRow,
  type PromptTemplateRow,
  type ResearchArtifactRow,
  type ScheduleOccurrenceRow,
  type ScheduleRow,
  type SyncRunRow
} from './schema.js'
import type * as schema from './schema.js'

const StringArraySchema = z.array(z.string())
const StringRecordSchema = z.record(z.string(), z.string())
const SettingsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
)
const CitationArraySchema = z.array(z.object({ label: z.string(), url: z.string().nullable() }))

export const DEFAULT_AI_API_BY_PROVIDER = {
  mock: 'mock',
  openai: 'openai-responses',
  anthropic: 'anthropic-messages',
  deepseek: 'openai-completions',
  xai: 'openai-responses',
  gemini: 'google-generative-ai',
  ollama: 'openai-completions'
} as const satisfies Partial<Record<AiProviderProfile['provider'], AiProviderProfile['api']>>

export interface ResearchArtifactListFilter {
  readonly projectId?: string | null
  readonly kind?: ResearchArtifact['kind']
}

export type DatabaseSaveIntegrationProfileInput = Omit<SaveIntegrationProfileInput, 'credential'>
export type DatabaseSaveAiProviderProfileInput = Omit<SaveAiProviderProfileInput, 'credential'>

export interface SaveExternalLinkInput {
  readonly id?: string
  readonly profileId: string
  readonly entityKind: ExternalLink['entityKind']
  readonly entityId: string
  readonly externalId: string
  readonly locator: string
  readonly managedBlockId: string | null
  readonly remoteRevision: string | null
  readonly syncState: ExternalLink['syncState']
  readonly lastSyncedAt: string | null
}

export interface UpdateIntegrationStatusInput {
  readonly id: string
  readonly status: IntegrationProfile['status']
  readonly lastSyncAt?: string | null
  readonly lastError?: string | null
  readonly expectedRevision: number
}

export interface UpdateSyncRunInput {
  readonly id: string
  readonly status: SyncRun['status']
  readonly pulled?: number
  readonly pushed?: number
  readonly conflicts?: number
  readonly message?: string
}

export interface CompleteSyncRunInput {
  readonly status?: 'completed' | 'failed' | 'canceled'
  readonly pulled?: number
  readonly pushed?: number
  readonly conflicts?: number
  readonly message?: string
}

export interface UpdateAgentRunInput {
  readonly id: string
  readonly status: AgentRun['status']
  readonly output?: string
  readonly citations?: AgentRun['citations']
  readonly error?: string | null
}

export interface CompleteAgentRunInput {
  readonly status?: 'completed' | 'failed'
  readonly output: string
  readonly citations?: AgentRun['citations']
  readonly error?: string | null
}

export interface UpdateScheduleTimingInput {
  readonly id: string
  readonly nextRunAt?: string | null
  readonly lastRunAt?: string | null
  readonly expectedRevision: number
}

const SaveExternalLinkInputSchema = ExternalLinkSchema.omit({ id: true }).extend({
  id: z.string().min(1).optional()
})

const DatabaseSaveIntegrationProfileInputSchema = SaveIntegrationProfileInputSchema.omit({
  credential: true
})

const DatabaseSaveAiProviderProfileInputSchema = SaveAiProviderProfileInputSchema.omit({
  credential: true
})

const UpsertExternalPaperInputSchema = z.object({
  externalId: z.string().min(1),
  locator: z.string().max(4_000).default(''),
  remoteRevision: z.string().nullable().default(null),
  managedBlockId: z.string().nullable().default(null),
  paperId: z.string().min(1).optional(),
  expectedRevision: z.int().nonnegative().nullable().default(null),
  paper: CreatePaperInputSchema.omit({ source: true })
})

export type UpsertExternalPaperInput = z.input<typeof UpsertExternalPaperInputSchema>

const UpdateIntegrationStatusInputSchema = z.object({
  id: z.string().min(1),
  status: IntegrationProfileSchema.shape.status,
  lastSyncAt: z.iso.datetime().nullable().optional(),
  lastError: z.string().nullable().optional(),
  expectedRevision: z.int().nonnegative()
})

const UpdateSyncRunInputSchema = z.object({
  id: z.string().min(1),
  status: SyncRunSchema.shape.status,
  pulled: z.int().nonnegative().optional(),
  pushed: z.int().nonnegative().optional(),
  conflicts: z.int().nonnegative().optional(),
  message: z.string().optional()
})

const UpdateAgentRunInputSchema = z.object({
  id: z.string().min(1),
  status: AgentRunSchema.shape.status,
  output: z.string().optional(),
  citations: CitationArraySchema.optional(),
  error: z.string().nullable().optional()
})

const UpdateScheduleTimingInputSchema = z.object({
  id: z.string().min(1),
  nextRunAt: z.iso.datetime().nullable().optional(),
  lastRunAt: z.iso.datetime().nullable().optional(),
  expectedRevision: z.int().nonnegative()
})

function databaseNotFound(entity: string, id: string): never {
  throw new WorkbenchDatabaseError('NOT_FOUND', `${entity} not found`, {
    details: { entity, id }
  })
}

function assertRevision(entity: string, id: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new WorkbenchDatabaseError(
      'REVISION_CONFLICT',
      `${entity} was changed by another operation`,
      {
        retryable: true,
        details: { entity, id, expectedRevision: expected, actualRevision: actual }
      }
    )
  }
}

function revisionConflict(entity: string, id: string): never {
  throw new WorkbenchDatabaseError(
    'REVISION_CONFLICT',
    `${entity} update lost its revision lock`,
    { retryable: true, details: { entity, id } }
  )
}

/**
 * Aggregate per-record receipts into the counts a bulk archive command reports.
 *
 * The counts are derived from the receipts (never counted separately) so a
 * caller can render "成功 3 · 跳过 1 · 冲突 1 · 失败 0" directly from the same
 * array it lists per record, and the two can never disagree.
 *
 * Shared with the Agent run-ledger delete commands (`repository.ts`) so every
 * list reports the same outcome vocabulary.
 */
export function archiveBulkResult(items: ArchiveBulkResult['items']): ArchiveBulkResult {
  return {
    items,
    succeeded: items.filter((item) => item.outcome === 'succeeded').length,
    skipped: items.filter((item) => item.outcome === 'skipped').length,
    conflict: items.filter((item) => item.outcome === 'conflict').length,
    failed: items.filter((item) => item.outcome === 'failed').length,
    canceled: false
  }
}

/** One stale revision lock inside a bulk archive command. Nothing was written
 * for this record, and the user has to re-read the list before retrying. */
export function archiveLockConflict(id: string, message: string): ArchiveBulkReceipt {
  return { id, outcome: 'conflict', error: { code: 'REVISION_CONFLICT', message, retryable: true } }
}

function storedDataError(entity: string, id: string, field: string): WorkbenchDatabaseError {
  return new WorkbenchDatabaseError('DATABASE_ERROR', 'stored data failed validation', {
    details: { entity, id, field }
  })
}

function parseJson<T>(
  raw: string,
  valueSchema: z.ZodType<T>,
  entity: string,
  id: string,
  field: string
): T {
  try {
    return valueSchema.parse(JSON.parse(raw))
  } catch {
    throw storedDataError(entity, id, field)
  }
}

function parseStored<T>(
  valueSchema: z.ZodType<T>,
  value: unknown,
  entity: string,
  id: string
): T {
  try {
    return valueSchema.parse(value)
  } catch {
    throw storedDataError(entity, id, 'row')
  }
}

function toPaper(row: PaperRow): Paper {
  return parseStored(PaperSchema, {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    authors: parseJson(row.authorsJson, StringArraySchema, 'paper', row.id, 'authors'),
    year: row.year,
    venue: row.venue,
    abstract: row.abstract,
    doi: row.doi,
    url: row.url,
    citationKey: row.citationKey,
    tags: parseJson(row.tagsJson, StringArraySchema, 'paper', row.id, 'tags'),
    collections: parseJson(row.collectionsJson, StringArraySchema, 'paper', row.id, 'collections'),
    status: row.status,
    rating: row.rating,
    localPdfPath: row.localPdfPath,
    source: row.source,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision
  }, 'paper', row.id)
}

function toMatrixEntry(row: LiteratureMatrixEntryRow): LiteratureMatrixEntry {
  return parseStored(LiteratureMatrixEntrySchema, {
    id: row.id,
    paperId: row.paperId,
    researchQuestion: row.researchQuestion,
    method: row.method,
    data: row.data,
    keyFindings: row.keyFindings,
    limitations: row.limitations,
    evidence: row.evidence,
    relevance: row.relevance,
    qualityScore: row.qualityScore,
    customFields: parseJson(
      row.customFieldsJson,
      StringRecordSchema,
      'literature matrix entry',
      row.id,
      'customFields'
    ),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision
  }, 'literature matrix entry', row.id)
}

function toArtifact(row: ResearchArtifactRow): ResearchArtifact {
  return parseStored(ResearchArtifactSchema, {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    title: row.title,
    content: row.content,
    sourcePaperIds: parseJson(
      row.sourcePaperIdsJson,
      StringArraySchema,
      'research artifact',
      row.id,
      'sourcePaperIds'
    ),
    citations: parseJson(
      row.citationsJson,
      CitationArraySchema,
      'research artifact',
      row.id,
      'citations'
    ),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision
  }, 'research artifact', row.id)
}

function toIntegrationProfile(row: IntegrationProfileRow): IntegrationProfile {
  return parseStored(IntegrationProfileSchema, {
    id: row.id,
    provider: row.provider,
    name: row.name,
    enabled: row.enabled,
    location: row.location,
    settings: parseJson(
      row.settingsJson,
      SettingsSchema,
      'integration profile',
      row.id,
      'settings'
    ),
    credentialPresent: row.credentialPresent,
    status: row.status,
    lastSyncAt: row.lastSyncAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision
  }, 'integration profile', row.id)
}

function toExternalLink(row: ExternalLinkRow): ExternalLink {
  return parseStored(ExternalLinkSchema, row, 'external link', row.id)
}

function toSyncRun(row: SyncRunRow): SyncRun {
  return parseStored(SyncRunSchema, row, 'sync run', row.id)
}

function toPromptTemplate(row: PromptTemplateRow): PromptTemplate {
  return parseStored(PromptTemplateSchema, row, 'prompt template', row.id)
}

function toProviderProfile(row: AiProviderProfileRow): AiProviderProfile {
  return parseStored(AiProviderProfileSchema, {
    id: row.id,
    provider: row.provider,
    api: row.api,
    name: row.name,
    model: row.model,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    credentialPresent: row.credentialPresent,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision
  }, 'AI provider profile', row.id)
}

function toAgentRun(row: AgentRunRow): AgentRun {
  return parseStored(AgentRunSchema, {
    id: row.id,
    workflowKey: row.workflowKey,
    providerProfileId: row.providerProfileId,
    promptTemplateId: row.promptTemplateId,
    projectId: row.projectId,
    paperIds: parseJson(row.paperIdsJson, StringArraySchema, 'agent run', row.id, 'paperIds'),
    status: row.status,
    input: parseJson(row.inputJson, StringRecordSchema, 'agent run', row.id, 'input'),
    output: row.output,
    citations: parseJson(row.citationsJson, CitationArraySchema, 'agent run', row.id, 'citations'),
    error: row.error,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt
  }, 'agent run', row.id)
}

function toSchedule(row: ScheduleRow): Schedule {
  return parseStored(ScheduleSchema, {
    ...row,
    // The requested source list is stored as a JSON array; a corrupted value
    // degrades to the empty (= all available) list instead of making the whole
    // schedule unreadable.
    sources: safeParseSourcesJson(row.sourcesJson),
    lookbackDays: row.lookbackDays
  }, 'schedule', row.id)
}

function toScheduleOccurrence(row: ScheduleOccurrenceRow): ScheduleOccurrence {
  // `updated_at` is internal bookkeeping: the contract projects one claimed
  // time slot, and it is a `strictObject`, so the raw row must be narrowed
  // here instead of leaking the column into the projection.
  return parseStored(ScheduleOccurrenceSchema, {
    id: row.id,
    scheduleId: row.scheduleId,
    occurrenceAt: row.occurrenceAt,
    localDateKey: row.localDateKey,
    idempotencyKey: row.idempotencyKey,
    source: row.source,
    status: row.status,
    runId: row.runId,
    reason: row.reason,
    claimedAt: row.claimedAt,
    settledAt: row.settledAt,
    revision: row.revision
  }, 'schedule occurrence', row.id)
}

/** Requested sources are user input, so a corrupted row must degrade to the
 * empty (= all available sources) list rather than failing the schedule list. */
function safeParseSourcesJson(raw: string): string[] {
  try {
    return StringArraySchema.parse(JSON.parse(raw))
  } catch {
    return []
  }
}

/** Normalize a requested source list: trim, lower-case and de-duplicate. The
 * engine's source names are lower-case CLI tokens. */
export function normalizeAutomationSources(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLocaleLowerCase()).filter((value) => value.length > 0))]
}

export class ResearchRepository {
  constructor(
    private readonly database: BetterSQLite3Database<typeof schema>,
    private readonly now: () => Date
  ) {}

  listPapers(filterInput: Partial<PaperListFilter> = {}): Paper[] {
    const filter = PaperListFilterSchema.parse(filterInput)
    const conditions: SQL[] = []
    if (!filter.includeArchived) conditions.push(isNull(papers.archivedAt))
    if (filter.projectId === null) conditions.push(isNull(papers.projectId))
    if (typeof filter.projectId === 'string') conditions.push(eq(papers.projectId, filter.projectId))
    if (filter.status !== undefined) conditions.push(eq(papers.status, filter.status))

    const query = filter.query.toLowerCase()
    return this.database
      .select()
      .from(papers)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(papers.updatedAt), asc(papers.title))
      .all()
      .map(toPaper)
      .filter((paper) => filter.tag === undefined || paper.tags.includes(filter.tag))
      .filter((paper) => query.length === 0 || [
        paper.title,
        paper.authors.join(' '),
        paper.venue,
        paper.abstract,
        paper.doi ?? '',
        paper.citationKey ?? '',
        paper.tags.join(' '),
        paper.collections.join(' ')
      ].join('\n').toLowerCase().includes(query))
  }

  getPapersByIds(idsValue: readonly string[]): Paper[] {
    const ids = StringArraySchema.parse(idsValue)
    if (ids.length === 0) return []
    const byId = new Map(
      this.database
        .select()
        .from(papers)
        .where(inArray(papers.id, ids))
        .all()
        .map((row) => [row.id, toPaper(row)] as const)
    )
    return ids.map((id) => byId.get(id)).filter((paper): paper is Paper => paper !== undefined)
  }

  createPaper(inputValue: CreatePaperInput): Paper {
    const input = CreatePaperInputSchema.parse(inputValue)
    const timestamp = this.now().toISOString()
    const row: PaperRow = {
      id: uuidv7(),
      projectId: input.projectId,
      title: input.title,
      authorsJson: JSON.stringify(input.authors),
      year: input.year,
      venue: input.venue,
      abstract: input.abstract,
      doi: input.doi,
      url: input.url,
      citationKey: input.citationKey,
      tagsJson: JSON.stringify(input.tags),
      collectionsJson: JSON.stringify(input.collections),
      status: input.status,
      rating: input.rating,
      localPdfPath: input.localPdfPath,
      source: input.source,
      archivedAt: input.status === 'archived' ? timestamp : null,
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 0
    }
    this.database.insert(papers).values(row).run()
    return toPaper(row)
  }

  updatePaper(inputValue: UpdatePaperInput): Paper {
    const input = UpdatePaperInputSchema.parse(inputValue)
    return this.database.transaction((transaction) => {
      const current = transaction.select().from(papers).where(eq(papers.id, input.id)).get()
      if (!current) databaseNotFound('paper', input.id)
      assertRevision('paper', input.id, current.revision, input.expectedRevision)

      const timestamp = this.now().toISOString()
      const changes: Partial<typeof papers.$inferInsert> = {
        updatedAt: timestamp,
        revision: current.revision + 1
      }
      if (inputValue.projectId !== undefined) changes.projectId = input.projectId
      if (inputValue.title !== undefined) changes.title = input.title!
      if (inputValue.authors !== undefined) changes.authorsJson = JSON.stringify(input.authors)
      if (inputValue.year !== undefined) changes.year = input.year
      if (inputValue.venue !== undefined) changes.venue = input.venue
      if (inputValue.abstract !== undefined) changes.abstract = input.abstract
      if (inputValue.doi !== undefined) changes.doi = input.doi
      if (inputValue.url !== undefined) changes.url = input.url
      if (inputValue.citationKey !== undefined) changes.citationKey = input.citationKey
      if (inputValue.tags !== undefined) changes.tagsJson = JSON.stringify(input.tags)
      if (inputValue.collections !== undefined) {
        changes.collectionsJson = JSON.stringify(input.collections)
      }
      if (inputValue.status !== undefined) {
        changes.status = input.status
        changes.archivedAt = input.status === 'archived' ? current.archivedAt ?? timestamp : null
      }
      if (inputValue.rating !== undefined) changes.rating = input.rating
      if (inputValue.localPdfPath !== undefined) changes.localPdfPath = input.localPdfPath
      if (inputValue.source !== undefined) changes.source = input.source

      const updated = transaction
        .update(papers)
        .set(changes)
        .where(and(eq(papers.id, input.id), eq(papers.revision, input.expectedRevision)))
        .returning()
        .get()
      if (!updated) revisionConflict('paper', input.id)

      const links = transaction
        .select()
        .from(externalLinks)
        .where(and(eq(externalLinks.entityKind, 'paper'), eq(externalLinks.entityId, input.id)))
        .all()
      for (const link of links) {
        const syncState = link.syncState === 'synced'
          ? 'local_changed'
          : link.syncState === 'remote_changed' || link.syncState === 'deleted'
            ? 'conflict'
            : link.syncState
        if (syncState !== link.syncState) {
          transaction.update(externalLinks).set({ syncState }).where(eq(externalLinks.id, link.id)).run()
        }
      }
      return toPaper(updated)
    })
  }

  archivePaper(id: string, expectedRevision: number): void {
    this.database.transaction((transaction) => {
      const current = transaction.select().from(papers).where(eq(papers.id, id)).get()
      if (!current) databaseNotFound('paper', id)
      assertRevision('paper', id, current.revision, expectedRevision)
      const timestamp = this.now().toISOString()
      const result = transaction
        .update(papers)
        .set({
          status: 'archived',
          archivedAt: timestamp,
          updatedAt: timestamp,
          revision: current.revision + 1
        })
        .where(and(eq(papers.id, id), eq(papers.revision, expectedRevision)))
        .run()
      if (result.changes !== 1) revisionConflict('paper', id)
    })
  }

  listLiteratureMatrix(projectId?: string | null): LiteratureMatrixEntry[] {
    const conditions: SQL[] = [isNull(papers.archivedAt)]
    if (projectId === null) conditions.push(isNull(papers.projectId))
    if (typeof projectId === 'string') conditions.push(eq(papers.projectId, projectId))
    return this.database
      .select({ entry: literatureMatrixEntries })
      .from(literatureMatrixEntries)
      .innerJoin(papers, eq(literatureMatrixEntries.paperId, papers.id))
      .where(and(...conditions))
      .orderBy(desc(literatureMatrixEntries.updatedAt))
      .all()
      .map(({ entry }) => toMatrixEntry(entry))
  }

  upsertLiteratureMatrix(inputValue: UpsertLiteratureMatrixInput): LiteratureMatrixEntry {
    const input = UpsertLiteratureMatrixInputSchema.parse(inputValue)
    return this.database.transaction((transaction) => {
      const paper = transaction.select().from(papers).where(eq(papers.id, input.paperId)).get()
      if (!paper || paper.archivedAt !== null) databaseNotFound('active paper', input.paperId)
      const current = transaction
        .select()
        .from(literatureMatrixEntries)
        .where(eq(literatureMatrixEntries.paperId, input.paperId))
        .get()
      const timestamp = this.now().toISOString()

      if (!current) {
        if (input.expectedRevision !== null) revisionConflict('literature matrix entry', input.paperId)
        const row: LiteratureMatrixEntryRow = {
          id: uuidv7(),
          paperId: input.paperId,
          researchQuestion: input.researchQuestion,
          method: input.method,
          data: input.data,
          keyFindings: input.keyFindings,
          limitations: input.limitations,
          evidence: input.evidence,
          relevance: input.relevance,
          qualityScore: input.qualityScore,
          customFieldsJson: JSON.stringify(input.customFields),
          createdAt: timestamp,
          updatedAt: timestamp,
          revision: 0
        }
        transaction.insert(literatureMatrixEntries).values(row).run()
        return toMatrixEntry(row)
      }

      if (input.expectedRevision === null) {
        revisionConflict('literature matrix entry', current.id)
      }
      assertRevision(
        'literature matrix entry',
        current.id,
        current.revision,
        input.expectedRevision
      )
      const updated = transaction
        .update(literatureMatrixEntries)
        .set({
          researchQuestion: input.researchQuestion,
          method: input.method,
          data: input.data,
          keyFindings: input.keyFindings,
          limitations: input.limitations,
          evidence: input.evidence,
          relevance: input.relevance,
          qualityScore: input.qualityScore,
          customFieldsJson: JSON.stringify(input.customFields),
          updatedAt: timestamp,
          revision: current.revision + 1
        })
        .where(and(
          eq(literatureMatrixEntries.id, current.id),
          eq(literatureMatrixEntries.revision, input.expectedRevision)
        ))
        .returning()
        .get()
      if (!updated) revisionConflict('literature matrix entry', current.id)
      return toMatrixEntry(updated)
    })
  }

  removeLiteratureMatrix(inputValue: RemoveLiteratureMatrixInput): void {
    const input = RemoveLiteratureMatrixInputSchema.parse(inputValue)
    this.database.transaction((transaction) => {
      const current = transaction
        .select({ id: literatureMatrixEntries.id, revision: literatureMatrixEntries.revision })
        .from(literatureMatrixEntries)
        .where(eq(literatureMatrixEntries.id, input.id))
        .get()
      if (!current) databaseNotFound('literature matrix entry', input.id)
      assertRevision('literature matrix entry', input.id, current.revision, input.expectedRevision)
      const deleted = transaction
        .delete(literatureMatrixEntries)
        .where(and(
          eq(literatureMatrixEntries.id, input.id),
          eq(literatureMatrixEntries.revision, input.expectedRevision)
        ))
        .run()
      if (deleted.changes !== 1) revisionConflict('literature matrix entry', input.id)
    })
  }

  /** Delete selected matrix rows in one SQLite transaction.  Missing rows are
   * skipped and stale revision locks are returned as retryable failures so a
   * concurrent edit can never silently remove a newer matrix value. */
  bulkDeleteLiteratureMatrix(inputValue: LiteratureMatrixBulkDeleteInput): LiteratureMatrixBulkDeleteResult {
    const input = LiteratureMatrixBulkDeleteInputSchema.parse(inputValue)
    const receipt = this.database.transaction((transaction) => {
      const items: LiteratureMatrixBulkDeleteResult['items'] = []
      for (const lock of input.items) {
        const current = transaction
          .select({ id: literatureMatrixEntries.id, revision: literatureMatrixEntries.revision })
          .from(literatureMatrixEntries)
          .where(eq(literatureMatrixEntries.id, lock.id))
          .get()
        if (!current) {
          items.push({ id: lock.id, outcome: 'skipped', error: null })
          continue
        }
        if (current.revision !== lock.expectedRevision) {
          items.push({
            id: lock.id,
            outcome: 'failed',
            error: {
              code: 'REVISION_CONFLICT',
              message: '文献矩阵条目已发生变化，请刷新后重试。',
              retryable: true
            }
          })
          continue
        }
        const deleted = transaction
          .delete(literatureMatrixEntries)
          .where(and(
            eq(literatureMatrixEntries.id, lock.id),
            eq(literatureMatrixEntries.revision, lock.expectedRevision)
          ))
          .run().changes === 1
        items.push(deleted
          ? { id: lock.id, outcome: 'succeeded', error: null }
          : {
              id: lock.id,
              outcome: 'failed',
              error: {
                code: 'REVISION_CONFLICT',
                message: '文献矩阵条目已发生变化，请刷新后重试。',
                retryable: true
              }
            })
      }
      return {
        items,
        succeeded: items.filter((item) => item.outcome === 'succeeded').length,
        skipped: items.filter((item) => item.outcome === 'skipped').length,
        failed: items.filter((item) => item.outcome === 'failed').length,
        canceled: false
      }
    })
    return LiteratureMatrixBulkDeleteResultSchema.parse(receipt)
  }

  listResearchArtifacts(filter: ResearchArtifactListFilter = {}): ResearchArtifact[] {
    const conditions: SQL[] = [isNull(researchArtifacts.archivedAt)]
    if (filter.projectId === null) conditions.push(isNull(researchArtifacts.projectId))
    if (typeof filter.projectId === 'string') {
      conditions.push(eq(researchArtifacts.projectId, filter.projectId))
    }
    if (filter.kind !== undefined) conditions.push(eq(researchArtifacts.kind, filter.kind))
    return this.database
      .select()
      .from(researchArtifacts)
      .where(and(...conditions))
      .orderBy(desc(researchArtifacts.updatedAt), asc(researchArtifacts.title))
      .all()
      .map(toArtifact)
  }

  createResearchArtifact(inputValue: CreateResearchArtifactInput): ResearchArtifact {
    const input = CreateResearchArtifactInputSchema.parse(inputValue)
    const timestamp = this.now().toISOString()
    const row: ResearchArtifactRow = {
      id: uuidv7(),
      projectId: input.projectId,
      kind: input.kind,
      title: input.title,
      content: input.content,
      sourcePaperIdsJson: JSON.stringify(input.sourcePaperIds),
      citationsJson: JSON.stringify(input.citations),
      status: input.status,
      archivedAt: input.status === 'archived' ? timestamp : null,
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 0
    }
    this.database.insert(researchArtifacts).values(row).run()
    return toArtifact(row)
  }

  updateResearchArtifact(inputValue: UpdateResearchArtifactInput): ResearchArtifact {
    const input = UpdateResearchArtifactInputSchema.parse(inputValue)
    return this.database.transaction((transaction) => {
      const current = transaction
        .select()
        .from(researchArtifacts)
        .where(eq(researchArtifacts.id, input.id))
        .get()
      if (!current) databaseNotFound('research artifact', input.id)
      assertRevision('research artifact', input.id, current.revision, input.expectedRevision)
      const timestamp = this.now().toISOString()
      const changes: Partial<typeof researchArtifacts.$inferInsert> = {
        updatedAt: timestamp,
        revision: current.revision + 1
      }
      if (inputValue.projectId !== undefined) changes.projectId = input.projectId
      if (inputValue.kind !== undefined) changes.kind = input.kind!
      if (inputValue.title !== undefined) changes.title = input.title!
      if (inputValue.content !== undefined) changes.content = input.content
      if (inputValue.sourcePaperIds !== undefined) {
        changes.sourcePaperIdsJson = JSON.stringify(input.sourcePaperIds)
      }
      if (inputValue.citations !== undefined) changes.citationsJson = JSON.stringify(input.citations)
      if (inputValue.status !== undefined) {
        changes.status = input.status
        changes.archivedAt = input.status === 'archived' ? current.archivedAt ?? timestamp : null
      }

      const updated = transaction
        .update(researchArtifacts)
        .set(changes)
        .where(and(
          eq(researchArtifacts.id, input.id),
          eq(researchArtifacts.revision, input.expectedRevision)
        ))
        .returning()
        .get()
      if (!updated) revisionConflict('research artifact', input.id)
      return toArtifact(updated)
    })
  }

  archiveResearchArtifact(id: string, expectedRevision: number): void {
    this.database.transaction((transaction) => {
      const current = transaction
        .select()
        .from(researchArtifacts)
        .where(eq(researchArtifacts.id, id))
        .get()
      if (!current) databaseNotFound('research artifact', id)
      assertRevision('research artifact', id, current.revision, expectedRevision)
      const timestamp = this.now().toISOString()
      const result = transaction
        .update(researchArtifacts)
        .set({
          status: 'archived',
          archivedAt: timestamp,
          updatedAt: timestamp,
          revision: current.revision + 1
        })
        .where(and(eq(researchArtifacts.id, id), eq(researchArtifacts.revision, expectedRevision)))
        .run()
      if (result.changes !== 1) revisionConflict('research artifact', id)
    })
  }

  listIntegrationProfiles(): IntegrationProfile[] {
    return this.database
      .select()
      .from(integrationProfiles)
      .where(isNull(integrationProfiles.archivedAt))
      .orderBy(asc(integrationProfiles.provider), asc(integrationProfiles.name))
      .all()
      .map(toIntegrationProfile)
  }

  getIntegrationProfile(id: string): IntegrationProfile {
    const row = this.database
      .select()
      .from(integrationProfiles)
      .where(eq(integrationProfiles.id, id))
      .get()
    if (!row || row.archivedAt !== null) databaseNotFound('integration profile', id)
    return toIntegrationProfile(row)
  }

  saveIntegrationProfile(
    inputValue: DatabaseSaveIntegrationProfileInput,
    credentialPresent?: boolean
  ): IntegrationProfile {
    const input = DatabaseSaveIntegrationProfileInputSchema.parse(inputValue)
    const nextCredentialPresent = z.boolean().optional().parse(credentialPresent)
    return this.database.transaction((transaction) => {
      const current = input.id === undefined
        ? undefined
        : transaction
            .select()
            .from(integrationProfiles)
            .where(eq(integrationProfiles.id, input.id))
            .get()
      const timestamp = this.now().toISOString()
      if (!current) {
        if (input.expectedRevision !== null) {
          revisionConflict('integration profile', input.id ?? input.provider)
        }
        const row: IntegrationProfileRow = {
          id: input.id ?? uuidv7(),
          provider: input.provider,
          name: input.name,
          enabled: input.enabled,
          location: input.location,
          settingsJson: JSON.stringify(input.settings),
          credentialPresent: nextCredentialPresent ?? false,
          status: input.enabled ? 'not_configured' : 'disabled',
          lastSyncAt: null,
          lastError: null,
          archivedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          revision: 0
        }
        transaction.insert(integrationProfiles).values(row).run()
        return toIntegrationProfile(row)
      }

      if (current.archivedAt !== null) databaseNotFound('active integration profile', current.id)
      if (input.expectedRevision === null) revisionConflict('integration profile', current.id)
      assertRevision('integration profile', current.id, current.revision, input.expectedRevision)
      const status: IntegrationProfile['status'] = input.enabled
        ? current.status === 'disabled' ? 'not_configured' : current.status
        : 'disabled'
      const updated = transaction
        .update(integrationProfiles)
        .set({
          provider: input.provider,
          name: input.name,
          enabled: input.enabled,
          location: input.location,
          settingsJson: JSON.stringify(input.settings),
          credentialPresent: nextCredentialPresent ?? current.credentialPresent,
          status,
          updatedAt: timestamp,
          revision: current.revision + 1
        })
        .where(and(
          eq(integrationProfiles.id, current.id),
          eq(integrationProfiles.revision, input.expectedRevision)
        ))
        .returning()
        .get()
      if (!updated) revisionConflict('integration profile', current.id)
      return toIntegrationProfile(updated)
    })
  }

  updateIntegrationStatus(inputValue: UpdateIntegrationStatusInput): IntegrationProfile {
    const input = UpdateIntegrationStatusInputSchema.parse(inputValue)
    return this.database.transaction((transaction) => {
      const current = transaction
        .select()
        .from(integrationProfiles)
        .where(eq(integrationProfiles.id, input.id))
        .get()
      if (!current || current.archivedAt !== null) databaseNotFound('integration profile', input.id)
      assertRevision('integration profile', input.id, current.revision, input.expectedRevision)
      const changes: Partial<typeof integrationProfiles.$inferInsert> = {
        status: input.status,
        updatedAt: this.now().toISOString(),
        revision: current.revision + 1
      }
      if (input.lastSyncAt !== undefined) changes.lastSyncAt = input.lastSyncAt
      if (input.lastError !== undefined) changes.lastError = input.lastError
      const updated = transaction
        .update(integrationProfiles)
        .set(changes)
        .where(and(
          eq(integrationProfiles.id, input.id),
          eq(integrationProfiles.revision, input.expectedRevision)
        ))
        .returning()
        .get()
      if (!updated) revisionConflict('integration profile', input.id)
      return toIntegrationProfile(updated)
    })
  }

  removeIntegrationProfile(id: string, expectedRevision: number): void {
    this.database.transaction((transaction) => {
      const current = transaction
        .select()
        .from(integrationProfiles)
        .where(eq(integrationProfiles.id, id))
        .get()
      if (!current || current.archivedAt !== null) databaseNotFound('integration profile', id)
      assertRevision('integration profile', id, current.revision, expectedRevision)
      const timestamp = this.now().toISOString()
      const result = transaction
        .update(integrationProfiles)
        .set({
          enabled: false,
          status: 'disabled',
          archivedAt: timestamp,
          updatedAt: timestamp,
          revision: current.revision + 1
        })
        .where(and(eq(integrationProfiles.id, id), eq(integrationProfiles.revision, expectedRevision)))
        .run()
      if (result.changes !== 1) revisionConflict('integration profile', id)
    })
  }

  /**
   * Archive several connection records in one SQLite transaction.
   *
   * Only the connection *record* is touched: the row is soft-archived
   * (disabled + `archived_at`) with a revision/CAS guard, while the safeStorage
   * credential, related sync runs/links and every external system (Obsidian
   * Vault, Zotero database) keep their state. A bulk delete must never be able
   * to destroy a secret or somebody else's data, so the credential removal that
   * the single-record Main-owned path performs is deliberately not part of this
   * service-side transaction.
   */
  bulkRemoveIntegrationProfiles(inputValue: ArchiveBulkInput): ArchiveBulkResult {
    const input = ArchiveBulkInputSchema.parse(inputValue)
    return this.database.transaction((transaction) => {
      const items: ArchiveBulkResult['items'] = []
      for (const lock of input.items) {
        const current = transaction
          .select()
          .from(integrationProfiles)
          .where(eq(integrationProfiles.id, lock.id))
          .get()
        if (!current || current.archivedAt !== null) {
          items.push({ id: lock.id, outcome: 'skipped', error: null })
          continue
        }
        if (current.revision !== lock.expectedRevision) {
          items.push(archiveLockConflict(lock.id, '连接记录已被修改，请刷新设置后重试。'))
          continue
        }
        const timestamp = this.now().toISOString()
        const result = transaction
          .update(integrationProfiles)
          .set({
            enabled: false,
            status: 'disabled',
            archivedAt: timestamp,
            updatedAt: timestamp,
            revision: current.revision + 1
          })
          .where(and(
            eq(integrationProfiles.id, lock.id),
            eq(integrationProfiles.revision, lock.expectedRevision)
          ))
          .run()
        if (result.changes !== 1) {
          items.push(archiveLockConflict(lock.id, '连接记录已被修改，请刷新设置后重试。'))
          continue
        }
        items.push({ id: lock.id, outcome: 'succeeded', error: null })
      }
      return ArchiveBulkResultSchema.parse(archiveBulkResult(items))
    })
  }

  listExternalLinks(profileId?: string): ExternalLink[] {
    return this.database
      .select()
      .from(externalLinks)
      .where(profileId === undefined ? undefined : eq(externalLinks.profileId, profileId))
      .orderBy(asc(externalLinks.profileId), asc(externalLinks.entityKind), asc(externalLinks.entityId))
      .all()
      .map(toExternalLink)
  }

  /** The Workbench projection of one external item, if it exists.  Used by the
   * two-sided delete preview to freeze the local Paper and its revision. */
  findExternalPaperLink(profileIdValue: string, externalIdValue: string): ExternalLink | null {
    const profileId = z.string().min(1).parse(profileIdValue)
    const externalId = z.string().min(1).parse(externalIdValue)
    const row = this.database
      .select()
      .from(externalLinks)
      .where(and(
        eq(externalLinks.profileId, profileId),
        eq(externalLinks.entityKind, 'paper'),
        eq(externalLinks.externalId, externalId)
      ))
      .get()
    return row ? toExternalLink(row) : null
  }

  /**
   * Remove the local projection of an external item after the remote library is
   * known not to hold it any more.
   *
   * Only two things change, both inside one transaction: the Paper is archived
   * (never deleted, so its project, matrix entries, artifacts and history stay
   * readable) and the external-link mapping rows for this profile + external id
   * are removed.  No other Paper, project, artifact or link is touched.
   */
  removeExternalPaperProjection(inputValue: { profileId: string; externalId: string }): {
    paperId: string | null
    archivedPaperId: string | null
    linksRemoved: number
  } {
    const profileId = z.string().min(1).parse(inputValue.profileId)
    const externalId = z.string().min(1).parse(inputValue.externalId)
    return this.database.transaction((transaction) => {
      const links = transaction
        .select()
        .from(externalLinks)
        .where(and(
          eq(externalLinks.profileId, profileId),
          eq(externalLinks.entityKind, 'paper'),
          eq(externalLinks.externalId, externalId)
        ))
        .all()
      const paperId = links[0]?.entityId ?? null
      let archivedPaperId: string | null = null
      if (paperId !== null) {
        const paper = transaction.select().from(papers).where(eq(papers.id, paperId)).get()
        if (paper && paper.archivedAt === null) {
          transaction
            .update(papers)
            .set({
              status: 'archived',
              archivedAt: this.now().toISOString(),
              updatedAt: this.now().toISOString(),
              revision: paper.revision + 1
            })
            .where(eq(papers.id, paperId))
            .run()
          archivedPaperId = paperId
        }
      }
      for (const link of links) {
        transaction.delete(externalLinks).where(eq(externalLinks.id, link.id)).run()
      }
      return { paperId, archivedPaperId, linksRemoved: links.length }
    })
  }

  saveExternalLink(inputValue: SaveExternalLinkInput): ExternalLink {
    const input = SaveExternalLinkInputSchema.parse(inputValue)
    return this.database.transaction((transaction) => {
      const profile = transaction
        .select()
        .from(integrationProfiles)
        .where(eq(integrationProfiles.id, input.profileId))
        .get()
      if (!profile || profile.archivedAt !== null) {
        databaseNotFound('integration profile', input.profileId)
      }
      const byIdentity = transaction
        .select()
        .from(externalLinks)
        .where(and(
          eq(externalLinks.profileId, input.profileId),
          eq(externalLinks.entityKind, input.entityKind),
          eq(externalLinks.externalId, input.externalId)
        ))
        .get()
      const byId = input.id === undefined
        ? undefined
        : transaction.select().from(externalLinks).where(eq(externalLinks.id, input.id)).get()
      if (byIdentity !== undefined && byId !== undefined && byIdentity.id !== byId.id) {
        throw new WorkbenchDatabaseError('DATABASE_ERROR', 'external link identity already exists', {
          details: { entity: 'external link', id: input.id }
        })
      }
      const current = byId ?? byIdentity
      if (!current) {
        const row: ExternalLinkRow = {
          id: input.id ?? uuidv7(),
          profileId: input.profileId,
          entityKind: input.entityKind,
          entityId: input.entityId,
          externalId: input.externalId,
          locator: input.locator,
          managedBlockId: input.managedBlockId,
          remoteRevision: input.remoteRevision,
          syncState: input.syncState,
          lastSyncedAt: input.lastSyncedAt
        }
        transaction.insert(externalLinks).values(row).run()
        return toExternalLink(row)
      }
      const updated = transaction
        .update(externalLinks)
        .set({
          profileId: input.profileId,
          entityKind: input.entityKind,
          entityId: input.entityId,
          externalId: input.externalId,
          locator: input.locator,
          managedBlockId: input.managedBlockId,
          remoteRevision: input.remoteRevision,
          syncState: input.syncState,
          lastSyncedAt: input.lastSyncedAt
        })
        .where(eq(externalLinks.id, current.id))
        .returning()
        .get()
      if (!updated) databaseNotFound('external link', current.id)
      return toExternalLink(updated)
    })
  }

  upsertExternalPaper(
    profileIdValue: string,
    providerValue: IntegrationProfile['provider'],
    inputValue: UpsertExternalPaperInput
  ): { paper: Paper; link: ExternalLink } {
    const profileId = z.string().min(1).parse(profileIdValue)
    const provider = IntegrationProfileSchema.shape.provider.parse(providerValue)
    const input = UpsertExternalPaperInputSchema.parse(inputValue)
    return this.database.transaction((transaction) => {
      const profile = transaction
        .select()
        .from(integrationProfiles)
        .where(eq(integrationProfiles.id, profileId))
        .get()
      if (!profile || profile.archivedAt !== null) databaseNotFound('integration profile', profileId)
      if (profile.provider !== provider) {
        throw new WorkbenchDatabaseError('DATABASE_ERROR', 'integration provider does not match profile', {
          details: { entity: 'integration profile', id: profileId }
        })
      }

      const currentLink = transaction
        .select()
        .from(externalLinks)
        .where(and(
          eq(externalLinks.profileId, profileId),
          eq(externalLinks.entityKind, 'paper'),
          eq(externalLinks.externalId, input.externalId)
        ))
        .get()
      if (
        currentLink !== undefined
        && input.paperId !== undefined
        && currentLink.entityId !== input.paperId
      ) {
        throw new WorkbenchDatabaseError('DATABASE_ERROR', 'external paper mapping is immutable', {
          details: { entity: 'external link', id: currentLink.id }
        })
      }

      const paperId = currentLink?.entityId ?? input.paperId ?? uuidv7()
      const currentPaper = transaction.select().from(papers).where(eq(papers.id, paperId)).get()
      const timestamp = this.now().toISOString()

      if (currentLink && currentPaper && ['local_changed', 'conflict'].includes(currentLink.syncState)) {
        const syncState = currentLink.syncState === 'conflict'
          || currentLink.remoteRevision !== input.remoteRevision
          ? 'conflict'
          : 'local_changed'
        const preservedLink = syncState === currentLink.syncState
          ? currentLink
          : transaction
              .update(externalLinks)
              .set({ syncState })
              .where(eq(externalLinks.id, currentLink.id))
              .returning()
              .get()
        if (!preservedLink) databaseNotFound('external link', currentLink.id)
        return { paper: toPaper(currentPaper), link: toExternalLink(preservedLink) }
      }

      let storedPaper: PaperRow
      if (!currentPaper) {
        if (currentLink !== undefined) {
          throw storedDataError('external link', currentLink.id, 'entityId')
        }
        if (input.expectedRevision !== null) revisionConflict('paper', paperId)
        storedPaper = {
          id: paperId,
          projectId: input.paper.projectId,
          title: input.paper.title,
          authorsJson: JSON.stringify(input.paper.authors),
          year: input.paper.year,
          venue: input.paper.venue,
          abstract: input.paper.abstract,
          doi: input.paper.doi,
          url: input.paper.url,
          citationKey: input.paper.citationKey,
          tagsJson: JSON.stringify(input.paper.tags),
          collectionsJson: JSON.stringify(input.paper.collections),
          status: input.paper.status,
          rating: input.paper.rating,
          localPdfPath: input.paper.localPdfPath,
          source: provider,
          archivedAt: input.paper.status === 'archived' ? timestamp : null,
          createdAt: timestamp,
          updatedAt: timestamp,
          revision: 0
        }
        transaction.insert(papers).values(storedPaper).run()
      } else {
        if (input.expectedRevision === null) revisionConflict('paper', currentPaper.id)
        assertRevision('paper', currentPaper.id, currentPaper.revision, input.expectedRevision)
        const updated = transaction
          .update(papers)
          .set({
            projectId: input.paper.projectId,
            title: input.paper.title,
            authorsJson: JSON.stringify(input.paper.authors),
            year: input.paper.year,
            venue: input.paper.venue,
            abstract: input.paper.abstract,
            doi: input.paper.doi,
            url: input.paper.url,
            citationKey: input.paper.citationKey,
            tagsJson: JSON.stringify(input.paper.tags),
            collectionsJson: JSON.stringify(input.paper.collections),
            status: input.paper.status,
            rating: input.paper.rating,
            localPdfPath: input.paper.localPdfPath,
            source: provider,
            archivedAt: input.paper.status === 'archived'
              ? currentPaper.archivedAt ?? timestamp
              : null,
            updatedAt: timestamp,
            revision: currentPaper.revision + 1
          })
          .where(and(
            eq(papers.id, currentPaper.id),
            eq(papers.revision, input.expectedRevision)
          ))
          .returning()
          .get()
        if (!updated) revisionConflict('paper', currentPaper.id)
        storedPaper = updated
      }

      let storedLink: ExternalLinkRow
      if (!currentLink) {
        storedLink = {
          id: uuidv7(),
          profileId,
          entityKind: 'paper',
          entityId: storedPaper.id,
          externalId: input.externalId,
          locator: input.locator,
          managedBlockId: input.managedBlockId,
          remoteRevision: input.remoteRevision,
          syncState: 'synced',
          lastSyncedAt: timestamp
        }
        transaction.insert(externalLinks).values(storedLink).run()
      } else {
        const updated = transaction
          .update(externalLinks)
          .set({
            entityId: storedPaper.id,
            locator: input.locator,
            managedBlockId: input.managedBlockId,
            remoteRevision: input.remoteRevision,
            syncState: 'synced',
            lastSyncedAt: timestamp
          })
          .where(eq(externalLinks.id, currentLink.id))
          .returning()
          .get()
        if (!updated) databaseNotFound('external link', currentLink.id)
        storedLink = updated
      }
      return { paper: toPaper(storedPaper), link: toExternalLink(storedLink) }
    })
  }

  createSyncRun(
    profileId: string,
    direction: SyncRun['direction'] = 'both'
  ): SyncRun {
    const profile = this.database
      .select()
      .from(integrationProfiles)
      .where(eq(integrationProfiles.id, profileId))
      .get()
    if (!profile || profile.archivedAt !== null) databaseNotFound('integration profile', profileId)
    const row: SyncRunRow = {
      id: uuidv7(),
      profileId,
      direction,
      status: 'queued',
      pulled: 0,
      pushed: 0,
      conflicts: 0,
      message: '',
      startedAt: this.now().toISOString(),
      finishedAt: null,
      archivedAt: null,
      revision: 0
    }
    this.database.insert(syncRuns).values(row).run()
    return toSyncRun(row)
  }

  updateSyncRun(inputValue: UpdateSyncRunInput): SyncRun {
    const input = UpdateSyncRunInputSchema.parse(inputValue)
    const current = this.database.select().from(syncRuns).where(eq(syncRuns.id, input.id)).get()
    if (!current) databaseNotFound('sync run', input.id)
    const terminal = ['completed', 'failed', 'canceled'].includes(input.status)
    const updated = this.database
      .update(syncRuns)
      .set({
        status: input.status,
        pulled: input.pulled ?? current.pulled,
        pushed: input.pushed ?? current.pushed,
        conflicts: input.conflicts ?? current.conflicts,
        message: input.message ?? current.message,
        finishedAt: terminal ? current.finishedAt ?? this.now().toISOString() : null,
        // Every mutation invalidates an outstanding selection lock, so a run
        // that progressed while it was selected cannot be removed silently.
        revision: current.revision + 1
      })
      .where(eq(syncRuns.id, input.id))
      .returning()
      .get()
    if (!updated) databaseNotFound('sync run', input.id)
    return toSyncRun(updated)
  }

  completeSyncRun(id: string, result: CompleteSyncRunInput = {}): SyncRun {
    return this.updateSyncRun({
      id,
      status: result.status ?? 'completed',
      ...(result.pulled === undefined ? {} : { pulled: result.pulled }),
      ...(result.pushed === undefined ? {} : { pushed: result.pushed }),
      ...(result.conflicts === undefined ? {} : { conflicts: result.conflicts }),
      ...(result.message === undefined ? {} : { message: result.message })
    })
  }

  /**
   * Sync runs are an audit ledger, so "delete" is a soft archive.
   *
   * The row keeps its content (status/counters/message) and is only hidden from
   * the Settings list with an `archived_at` timestamp guarded by the caller's
   * revision lock. Nothing else is touched: the connection profile, its
   * safeStorage credential, external links and every external system keep their
   * state, and no `sync_runs` row is ever dropped.
   */
  removeSyncRun(id: string, expectedRevision: number): void {
    this.database.transaction((transaction) => {
      const current = transaction.select().from(syncRuns).where(eq(syncRuns.id, id)).get()
      if (!current || current.archivedAt !== null) databaseNotFound('sync run', id)
      assertRevision('sync run', id, current.revision, expectedRevision)
      const result = transaction
        .update(syncRuns)
        .set({ archivedAt: this.now().toISOString(), revision: current.revision + 1 })
        .where(and(eq(syncRuns.id, id), eq(syncRuns.revision, expectedRevision)))
        .run()
      if (result.changes !== 1) revisionConflict('sync run', id)
    })
  }

  /**
   * Archive several sync runs in one SQLite transaction with per-record
   * receipts. A run that changed since it was selected produces a `conflict`
   * receipt and is left untouched; an already-archived (or missing) run is
   * `skipped`. Connection credentials, external links and external data are out
   * of scope by construction: this command only writes `sync_runs.archived_at`.
   */
  bulkRemoveSyncRuns(inputValue: ArchiveBulkInput): ArchiveBulkResult {
    const input = ArchiveBulkInputSchema.parse(inputValue)
    return this.database.transaction((transaction) => {
      const items: ArchiveBulkResult['items'] = []
      for (const lock of input.items) {
        const current = transaction.select().from(syncRuns).where(eq(syncRuns.id, lock.id)).get()
        if (!current || current.archivedAt !== null) {
          items.push({ id: lock.id, outcome: 'skipped', error: null })
          continue
        }
        if (current.revision !== lock.expectedRevision) {
          items.push(archiveLockConflict(lock.id, '同步记录已被更新，请刷新列表后重试。'))
          continue
        }
        const result = transaction
          .update(syncRuns)
          .set({ archivedAt: this.now().toISOString(), revision: current.revision + 1 })
          .where(and(eq(syncRuns.id, lock.id), eq(syncRuns.revision, lock.expectedRevision)))
          .run()
        if (result.changes !== 1) {
          items.push(archiveLockConflict(lock.id, '同步记录已被更新，请刷新列表后重试。'))
          continue
        }
        items.push({ id: lock.id, outcome: 'succeeded', error: null })
      }
      return ArchiveBulkResultSchema.parse(archiveBulkResult(items))
    })
  }

  listSyncRuns(profileId?: string): SyncRun[] {
    return this.database
      .select()
      .from(syncRuns)
      .where(and(
        isNull(syncRuns.archivedAt),
        ...(profileId === undefined ? [] : [eq(syncRuns.profileId, profileId)])
      ))
      .orderBy(desc(syncRuns.startedAt))
      .all()
      .map(toSyncRun)
  }

  listPromptTemplates(): PromptTemplate[] {
    return this.database
      .select()
      .from(promptTemplates)
      .orderBy(desc(promptTemplates.builtIn), asc(promptTemplates.name))
      .all()
      .map(toPromptTemplate)
  }

  getPromptTemplate(id: string): PromptTemplate {
    const row = this.database
      .select()
      .from(promptTemplates)
      .where(eq(promptTemplates.id, id))
      .get()
    if (!row) databaseNotFound('prompt template', id)
    return toPromptTemplate(row)
  }

  savePromptTemplate(inputValue: SavePromptTemplateInput): PromptTemplate {
    const input = SavePromptTemplateInputSchema.parse(inputValue)
    return this.database.transaction((transaction) => {
      const byId = input.id === undefined
        ? undefined
        : transaction.select().from(promptTemplates).where(eq(promptTemplates.id, input.id)).get()
      const byKey = transaction
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.key, input.key))
        .get()
      if (byId !== undefined && byKey !== undefined && byId.id !== byKey.id) {
        throw new WorkbenchDatabaseError('DATABASE_ERROR', 'prompt template key already exists', {
          details: { entity: 'prompt template', id: input.id, key: input.key }
        })
      }
      const current = byId ?? (input.expectedRevision === null ? undefined : byKey)
      const timestamp = this.now().toISOString()
      if (!current) {
        if (byKey !== undefined || input.expectedRevision !== null) {
          revisionConflict('prompt template', input.id ?? input.key)
        }
        const row: PromptTemplateRow = {
          id: input.id ?? uuidv7(),
          key: input.key,
          name: input.name,
          description: input.description,
          systemPrompt: input.systemPrompt,
          userTemplate: input.userTemplate,
          version: 1,
          builtIn: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          revision: 0
        }
        transaction.insert(promptTemplates).values(row).run()
        return toPromptTemplate(row)
      }
      if (input.expectedRevision === null) revisionConflict('prompt template', current.id)
      assertRevision('prompt template', current.id, current.revision, input.expectedRevision)
      const updated = transaction
        .update(promptTemplates)
        .set({
          key: input.key,
          name: input.name,
          description: input.description,
          systemPrompt: input.systemPrompt,
          userTemplate: input.userTemplate,
          version: current.version + 1,
          updatedAt: timestamp,
          revision: current.revision + 1
        })
        .where(and(
          eq(promptTemplates.id, current.id),
          eq(promptTemplates.revision, input.expectedRevision)
        ))
        .returning()
        .get()
      if (!updated) revisionConflict('prompt template', current.id)
      return toPromptTemplate(updated)
    })
  }

  listAiProviderProfiles(): AiProviderProfile[] {
    return this.database
      .select()
      .from(aiProviderProfiles)
      .where(isNull(aiProviderProfiles.archivedAt))
      .orderBy(asc(aiProviderProfiles.provider), asc(aiProviderProfiles.name))
      .all()
      .map(toProviderProfile)
  }

  getAiProviderProfile(id: string): AiProviderProfile {
    const row = this.database
      .select()
      .from(aiProviderProfiles)
      .where(eq(aiProviderProfiles.id, id))
      .get()
    if (!row || row.archivedAt !== null) databaseNotFound('AI provider profile', id)
    return toProviderProfile(row)
  }

  saveAiProviderProfile(
    inputValue: DatabaseSaveAiProviderProfileInput,
    credentialPresent?: boolean
  ): AiProviderProfile {
    const input = DatabaseSaveAiProviderProfileInputSchema.parse(inputValue)
    const nextCredentialPresent = z.boolean().optional().parse(credentialPresent)
    return this.database.transaction((transaction) => {
      const current = input.id === undefined
        ? undefined
        : transaction
            .select()
            .from(aiProviderProfiles)
            .where(eq(aiProviderProfiles.id, input.id))
            .get()
      const timestamp = this.now().toISOString()
      if (!current) {
        if (input.expectedRevision !== null) {
          revisionConflict('AI provider profile', input.id ?? input.provider)
        }
        const row: AiProviderProfileRow = {
          id: input.id ?? uuidv7(),
          provider: input.provider,
          api: input.api,
          name: input.name,
          model: input.model,
          baseUrl: input.baseUrl,
          enabled: input.enabled,
          credentialPresent: nextCredentialPresent ?? false,
          archivedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          revision: 0
        }
        transaction.insert(aiProviderProfiles).values(row).run()
        return toProviderProfile(row)
      }
      if (current.archivedAt !== null) databaseNotFound('AI provider profile', current.id)
      if (input.expectedRevision === null) revisionConflict('AI provider profile', current.id)
      assertRevision('AI provider profile', current.id, current.revision, input.expectedRevision)
      const updated = transaction
        .update(aiProviderProfiles)
        .set({
          provider: input.provider,
          api: input.api,
          name: input.name,
          model: input.model,
          baseUrl: input.baseUrl,
          enabled: input.enabled,
          credentialPresent: nextCredentialPresent ?? current.credentialPresent,
          updatedAt: timestamp,
          revision: current.revision + 1
        })
        .where(and(
          eq(aiProviderProfiles.id, current.id),
          eq(aiProviderProfiles.revision, input.expectedRevision)
        ))
        .returning()
        .get()
      if (!updated) revisionConflict('AI provider profile', current.id)
      return toProviderProfile(updated)
    })
  }

  removeAiProviderProfile(id: string, expectedRevision: number): void {
    this.database.transaction((transaction) => {
      const current = transaction
        .select()
        .from(aiProviderProfiles)
        .where(eq(aiProviderProfiles.id, id))
        .get()
      if (!current || current.archivedAt !== null) databaseNotFound('AI provider profile', id)
      assertRevision('AI provider profile', id, current.revision, expectedRevision)
      const timestamp = this.now().toISOString()
      const result = transaction
        .update(aiProviderProfiles)
        .set({
          enabled: false,
          archivedAt: timestamp,
          updatedAt: timestamp,
          revision: current.revision + 1
        })
        .where(and(eq(aiProviderProfiles.id, id), eq(aiProviderProfiles.revision, expectedRevision)))
        .run()
      if (result.changes !== 1) revisionConflict('AI provider profile', id)
    })
  }

  listAgentRuns(limit = 100): AgentRun[] {
    const safeLimit = z.int().min(1).max(1_000).parse(limit)
    return this.database
      .select()
      .from(agentRuns)
      .orderBy(desc(agentRuns.createdAt))
      .limit(safeLimit)
      .all()
      .map(toAgentRun)
  }

  reconcileInterruptedAgentRuns(): number {
    const timestamp = this.now().toISOString()
    const result = this.database
      .update(agentRuns)
      .set({
        status: 'failed',
        error: 'The previous application session ended before this run completed.',
        finishedAt: timestamp
      })
      .where(inArray(agentRuns.status, ['queued', 'running']))
      .run()
    return result.changes
  }

  startAgentRun(inputValue: StartAgentRunInput): AgentRun {
    const input = StartAgentRunInputSchema.parse(inputValue)
    const prompt = this.database
      .select()
      .from(promptTemplates)
      .where(eq(promptTemplates.id, input.promptTemplateId))
      .get()
    if (!prompt) databaseNotFound('prompt template', input.promptTemplateId)
    if (input.providerProfileId !== null) {
      const provider = this.database
        .select()
        .from(aiProviderProfiles)
        .where(eq(aiProviderProfiles.id, input.providerProfileId))
        .get()
      if (!provider || provider.archivedAt !== null) {
        databaseNotFound('AI provider profile', input.providerProfileId)
      }
    }
    const timestamp = this.now().toISOString()
    const runInput = {
      ...input.variables,
      ...(input.instructions.length > 0 ? { instructions: input.instructions } : {})
    }
    const row: AgentRunRow = {
      id: uuidv7(),
      jobId: null,
      idempotencyKey: null,
      runtime: 'pi',
      transport: 'inprocess',
      toolProfile: 'read-only',
      permissionMode: 'read-only',
      approvalPolicy: 'on-request',
      agentStatus: 'queued',
      artifactId: null,
      conversationId: null,
      workflowKey: input.workflowKey,
      providerProfileId: input.providerProfileId,
      promptTemplateId: input.promptTemplateId,
      projectId: input.projectId,
      paperIdsJson: JSON.stringify(input.paperIds),
      skillKey: null,
      skillSnapshotJson: null,
      credentialSource: 'none',
      status: 'queued',
      inputJson: JSON.stringify(runInput),
      output: '',
      citationsJson: '[]',
      error: null,
      createdAt: timestamp,
      startedAt: null,
      finishedAt: null,
      // A fresh run record is never archived and starts at revision 0: the
      // Automation RUN HISTORY delete commands lock on this token.
      archivedAt: null,
      revision: 0
    }
    this.database.insert(agentRuns).values(row).run()
    return toAgentRun(row)
  }

  createAgentRun(inputValue: StartAgentRunInput): AgentRun {
    return this.startAgentRun(inputValue)
  }

  updateAgentRun(inputValue: UpdateAgentRunInput): AgentRun {
    const input = UpdateAgentRunInputSchema.parse(inputValue)
    const current = this.database.select().from(agentRuns).where(eq(agentRuns.id, input.id)).get()
    if (!current) databaseNotFound('agent run', input.id)
    if (['completed', 'failed', 'canceled'].includes(current.status) && input.status !== current.status) {
      throw new WorkbenchDatabaseError('DATABASE_ERROR', 'terminal agent run cannot transition', {
        details: { entity: 'agent run', id: input.id, status: current.status }
      })
    }
    const timestamp = this.now().toISOString()
    const terminal = ['completed', 'failed', 'canceled'].includes(input.status)
    const updated = this.database
      .update(agentRuns)
      .set({
        status: input.status,
        output: input.output ?? current.output,
        citationsJson: input.citations === undefined
          ? current.citationsJson
          : JSON.stringify(input.citations),
        error: input.error === undefined ? current.error : input.error,
        startedAt: input.status === 'running' ? current.startedAt ?? timestamp : current.startedAt,
        finishedAt: terminal ? current.finishedAt ?? timestamp : null
      })
      .where(eq(agentRuns.id, input.id))
      .returning()
      .get()
    if (!updated) databaseNotFound('agent run', input.id)
    return toAgentRun(updated)
  }

  completeAgentRun(id: string, result: CompleteAgentRunInput): AgentRun {
    return this.updateAgentRun({
      id,
      status: result.status ?? (result.error ? 'failed' : 'completed'),
      output: result.output,
      ...(result.citations === undefined ? {} : { citations: result.citations }),
      ...(result.error === undefined ? {} : { error: result.error })
    })
  }

  cancelAgentRun(id: string): void {
    const current = this.database.select().from(agentRuns).where(eq(agentRuns.id, id)).get()
    if (!current) databaseNotFound('agent run', id)
    if (['completed', 'failed', 'canceled'].includes(current.status)) return
    this.updateAgentRun({ id, status: 'canceled' })
  }

  listSchedules(): Schedule[] {
    return this.database
      .select()
      .from(schedules)
      .where(isNull(schedules.archivedAt))
      .orderBy(asc(schedules.name))
      .all()
      .map(toSchedule)
  }

  getSchedule(id: string): Schedule {
    const row = this.database.select().from(schedules).where(eq(schedules.id, id)).get()
    if (!row || row.archivedAt !== null) databaseNotFound('schedule', id)
    return toSchedule(row)
  }

  listDueSchedules(at: Date = this.now()): Schedule[] {
    const timestamp = at.getTime()
    return this.listSchedules().filter(
      (schedule) => schedule.enabled
        && schedule.nextRunAt !== null
        && new Date(schedule.nextRunAt).getTime() <= timestamp
    )
  }

  saveSchedule(inputValue: SaveScheduleInput): Schedule {
    const input = SaveScheduleInputSchema.parse(inputValue)
    return this.database.transaction((transaction) => {
      const prompt = transaction
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.id, input.promptTemplateId))
        .get()
      if (!prompt) databaseNotFound('prompt template', input.promptTemplateId)
      if (input.providerProfileId !== null) {
        const provider = transaction
          .select()
          .from(aiProviderProfiles)
          .where(eq(aiProviderProfiles.id, input.providerProfileId))
          .get()
        if (!provider || provider.archivedAt !== null) {
          databaseNotFound('AI provider profile', input.providerProfileId)
        }
      }
      const current = input.id === undefined
        ? undefined
        : transaction.select().from(schedules).where(eq(schedules.id, input.id)).get()
      const timestamp = this.now().toISOString()
      if (!current) {
        if (input.expectedRevision !== null) revisionConflict('schedule', input.id ?? input.name)
        const row: ScheduleRow = {
          id: input.id ?? uuidv7(),
          name: input.name,
          workflowKey: input.workflowKey,
          promptTemplateId: input.promptTemplateId,
          providerProfileId: input.providerProfileId,
          runtime: input.runtime,
          model: input.model,
          assistantKey: input.assistantKey,
          workspacePath: input.workspacePath,
          frequency: input.frequency,
          executionMode: input.executionMode,
          conversationId: input.conversationId,
          prompt: input.prompt,
          skillKey: input.skillKey,
          topic: input.topic,
          sourcesJson: JSON.stringify(normalizeAutomationSources(input.sources)),
          lookbackDays: input.lookbackDays,
          responseLanguage: input.responseLanguage,
          outputFolder: input.outputFolder,
          permissionMode: input.permissionMode,
          approvalPolicy: input.approvalPolicy,
          projectId: input.projectId,
          cron: input.cron,
          timezone: input.timezone,
          enabled: input.enabled,
          missedPolicy: 'coalesce_one',
          nextRunAt: null,
          lastRunAt: null,
          archivedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          revision: 0
        }
        transaction.insert(schedules).values(row).run()
        return toSchedule(row)
      }
      if (current.archivedAt !== null) databaseNotFound('active schedule', current.id)
      if (input.expectedRevision === null) revisionConflict('schedule', current.id)
      assertRevision('schedule', current.id, current.revision, input.expectedRevision)
      const updated = transaction
        .update(schedules)
        .set({
          name: input.name,
          workflowKey: input.workflowKey,
          promptTemplateId: input.promptTemplateId,
          providerProfileId: input.providerProfileId,
          runtime: input.runtime,
          model: input.model,
          assistantKey: input.assistantKey,
          workspacePath: input.workspacePath,
          frequency: input.frequency,
          executionMode: input.executionMode,
          conversationId: input.conversationId,
          prompt: input.prompt,
          skillKey: input.skillKey,
          topic: input.topic,
          sourcesJson: JSON.stringify(normalizeAutomationSources(input.sources)),
          lookbackDays: input.lookbackDays,
          responseLanguage: input.responseLanguage,
          outputFolder: input.outputFolder,
          permissionMode: input.permissionMode,
          approvalPolicy: input.approvalPolicy,
          projectId: input.projectId,
          cron: input.cron,
          timezone: input.timezone,
          enabled: input.enabled,
          updatedAt: timestamp,
          revision: current.revision + 1
        })
        .where(and(eq(schedules.id, current.id), eq(schedules.revision, input.expectedRevision)))
        .returning()
        .get()
      if (!updated) revisionConflict('schedule', current.id)
      return toSchedule(updated)
    })
  }

  updateScheduleTiming(inputValue: UpdateScheduleTimingInput): Schedule {
    const input = UpdateScheduleTimingInputSchema.parse(inputValue)
    return this.database.transaction((transaction) => {
      const current = transaction.select().from(schedules).where(eq(schedules.id, input.id)).get()
      if (!current || current.archivedAt !== null) databaseNotFound('schedule', input.id)
      assertRevision('schedule', input.id, current.revision, input.expectedRevision)
      const changes: Partial<typeof schedules.$inferInsert> = {
        updatedAt: this.now().toISOString(),
        revision: current.revision + 1
      }
      if (input.nextRunAt !== undefined) changes.nextRunAt = input.nextRunAt
      if (input.lastRunAt !== undefined) changes.lastRunAt = input.lastRunAt
      const updated = transaction
        .update(schedules)
        .set(changes)
        .where(and(eq(schedules.id, input.id), eq(schedules.revision, input.expectedRevision)))
        .returning()
        .get()
      if (!updated) revisionConflict('schedule', input.id)
      return toSchedule(updated)
    })
  }

  markScheduleRun(
    id: string,
    expectedRevision: number,
    nextRunAt: string | null,
    lastRunAt: string = this.now().toISOString()
  ): Schedule {
    return this.updateScheduleTiming({ id, expectedRevision, nextRunAt, lastRunAt })
  }

  getScheduleOccurrenceByIdempotencyKey(idempotencyKey: string): ScheduleOccurrence | null {
    const row = this.database.select().from(scheduleOccurrences)
      .where(eq(scheduleOccurrences.idempotencyKey, idempotencyKey))
      .get()
    return row ? toScheduleOccurrence(row) : null
  }

  /** The occurrence one run consumed (used by the schedule run history). */
  getScheduleOccurrenceByRunId(runId: string): ScheduleOccurrence | null {
    const row = this.database.select().from(scheduleOccurrences)
      .where(eq(scheduleOccurrences.runId, runId))
      .orderBy(desc(scheduleOccurrences.claimedAt))
      .get()
    return row ? toScheduleOccurrence(row) : null
  }

  /** Title-only projection of one artifact; the schedule card never loads the
   * artifact body, which is authoritative elsewhere. */
  getResearchArtifactTitle(id: string): { readonly id: string; readonly title: string } | null {
    const row = this.database.select({ id: researchArtifacts.id, title: researchArtifacts.title })
      .from(researchArtifacts)
      .where(and(eq(researchArtifacts.id, id), isNull(researchArtifacts.archivedAt)))
      .get()
    return row ?? null
  }

  /**
   * Claim one cron occurrence: write the occurrence row *and* advance the
   * schedule cursor inside one transaction.
   *
   * Two invariants the scheduler depends on:
   *  1. A crash cannot leave "the cursor advanced but the time slot has no
   *     record": either both writes land or neither does.
   *  2. A duplicate tick / duplicate manual trigger cannot claim the same slot
   *     twice: `idempotency_key` is unique, and an already claimed key returns
   *     the existing row with `claimed: false` instead of inserting a second
   *     one (the caller then reuses the existing run rather than starting a
   *     new one).
   *
   * The cursor update is CAS-guarded on the revision the caller read, so a
   * concurrent user edit is never overwritten; a lost CAS only skips the
   * cursor advance while the claim itself stays durable.
   */
  claimScheduleOccurrence(input: {
    readonly scheduleId: string
    readonly idempotencyKey: string
    readonly occurrenceAt: string
    readonly localDateKey: string
    readonly source: ScheduleOccurrence['source']
    /** Target cursor value when `advanceCursor` is true. */
    readonly nextRunAt: string | null
    /** `false` leaves the cursor untouched (manual/paused rules). */
    readonly advanceCursor: boolean
    readonly lastRunAt?: string | null
    readonly expectedRevision: number
  }): { readonly claimed: boolean; readonly occurrence: ScheduleOccurrence; readonly cursorAdvanced: boolean } {
    return this.database.transaction((transaction) => {
      const existing = transaction.select().from(scheduleOccurrences)
        .where(eq(scheduleOccurrences.idempotencyKey, input.idempotencyKey))
        .get()
      if (existing) {
        return { claimed: false, occurrence: toScheduleOccurrence(existing), cursorAdvanced: false }
      }
      let cursorAdvanced = false
      if (input.advanceCursor) {
        const current = transaction.select().from(schedules).where(eq(schedules.id, input.scheduleId)).get()
        if (current && current.archivedAt === null && current.revision === input.expectedRevision) {
          const timestamp = this.now().toISOString()
          const updated = transaction.update(schedules)
            .set({
              nextRunAt: input.nextRunAt,
              lastRunAt: input.lastRunAt ?? current.lastRunAt ?? timestamp,
              updatedAt: timestamp,
              revision: current.revision + 1
            })
            .where(and(eq(schedules.id, current.id), eq(schedules.revision, input.expectedRevision)))
            .returning()
            .get()
          cursorAdvanced = updated !== undefined
        }
      }
      const timestamp = this.now().toISOString()
      const row: ScheduleOccurrenceRow = {
        id: uuidv7(),
        scheduleId: input.scheduleId,
        occurrenceAt: input.occurrenceAt,
        localDateKey: input.localDateKey,
        idempotencyKey: input.idempotencyKey,
        source: input.source,
        status: 'claimed',
        runId: null,
        reason: '',
        claimedAt: timestamp,
        settledAt: null,
        updatedAt: timestamp,
        revision: 0
      }
      transaction.insert(scheduleOccurrences).values(row).run()
      return { claimed: true, occurrence: toScheduleOccurrence(row), cursorAdvanced }
    })
  }

  /**
   * Settle a claimed occurrence with its final outcome.
   *
   * A policy refusal, a missing credential, a failed runtime start and an
   * interrupted app all settle here, so "nothing was pushed" always has a stored
   * reason instead of only being visible as an absent artifact.
   */
  settleScheduleOccurrence(input: {
    readonly id: string
    readonly status: ScheduleOccurrence['status']
    readonly runId?: string | null
    readonly reason?: string
  }): ScheduleOccurrence {
    const timestamp = this.now().toISOString()
    const row = this.database.update(scheduleOccurrences)
      .set({
        status: input.status,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        reason: (input.reason ?? '').slice(0, 1_000),
        settledAt: input.status === 'running' ? null : timestamp,
        updatedAt: timestamp,
        revision: 1
      })
      .where(eq(scheduleOccurrences.id, input.id))
      .returning()
      .get()
    if (!row) throw storedDataError('schedule occurrence', input.id, 'row')
    return toScheduleOccurrence(row)
  }

  /** Newest-first occurrence page, optionally limited to one rule. */
  listScheduleOccurrences(input: { readonly scheduleId?: string | undefined; readonly limit?: number | undefined } = {}): ScheduleOccurrence[] {
    const limit = z.int().min(1).max(200).parse(input.limit ?? 50)
    const conditions: SQL[] = []
    if (input.scheduleId !== undefined) conditions.push(eq(scheduleOccurrences.scheduleId, input.scheduleId))
    const query = this.database.select().from(scheduleOccurrences)
    return (conditions.length > 0 ? query.where(and(...conditions)) : query)
      .orderBy(desc(scheduleOccurrences.occurrenceAt), desc(scheduleOccurrences.claimedAt))
      .limit(limit)
      .all()
      .map(toScheduleOccurrence)
  }

  /**
   * Startup reconciliation: a claim left behind by a previous process is dead,
   * so it is settled as `missed` with the concrete reason. The day is *not*
   * silently re-run (the cursor already moved past it): the record stays visible
   * in the schedule's run history with a safe retry entry next to it.
   */
  reconcileClaimedScheduleOccurrences(reason: string): number {
    const timestamp = this.now().toISOString()
    const stale = this.database.select().from(scheduleOccurrences)
      .where(inArray(scheduleOccurrences.status, ['claimed', 'running']))
      .all()
    if (stale.length === 0) return 0
    this.database.update(scheduleOccurrences)
      .set({ status: 'missed', reason: reason.slice(0, 1_000), settledAt: timestamp, updatedAt: timestamp, revision: 1 })
      .where(inArray(scheduleOccurrences.id, stale.map((row) => row.id)))
      .run()
    return stale.length
  }

  removeSchedule(id: string, expectedRevision: number): void {
    this.database.transaction((transaction) => {
      const current = transaction.select().from(schedules).where(eq(schedules.id, id)).get()
      if (!current || current.archivedAt !== null) databaseNotFound('schedule', id)
      assertRevision('schedule', id, current.revision, expectedRevision)
      const timestamp = this.now().toISOString()
      const result = transaction
        .update(schedules)
        .set({
          enabled: false,
          archivedAt: timestamp,
          updatedAt: timestamp,
          revision: current.revision + 1
        })
        .where(and(eq(schedules.id, id), eq(schedules.revision, expectedRevision)))
        .run()
      if (result.changes !== 1) revisionConflict('schedule', id)
    })
  }

  /**
   * Archive several schedules in one SQLite transaction.
   *
   * Archiving a rule only stops it from being scheduled: the row keeps its
   * run/occurrence history, delivered artifacts and inbox items, because those
   * are the audit trail of *what already ran*. Bulk archiving therefore reports
   * one receipt per rule and never enumerates history rows.
   */
  bulkArchiveSchedules(inputValue: ArchiveBulkInput): ArchiveBulkResult {
    const input = ArchiveBulkInputSchema.parse(inputValue)
    return this.database.transaction((transaction) => {
      const items: ArchiveBulkResult['items'] = []
      for (const lock of input.items) {
        const current = transaction.select().from(schedules).where(eq(schedules.id, lock.id)).get()
        if (!current || current.archivedAt !== null) {
          items.push({ id: lock.id, outcome: 'skipped', error: null })
          continue
        }
        if (current.revision !== lock.expectedRevision) {
          items.push(archiveLockConflict(lock.id, '定时任务已被修改，请刷新后重试。'))
          continue
        }
        const timestamp = this.now().toISOString()
        const result = transaction
          .update(schedules)
          .set({
            enabled: false,
            archivedAt: timestamp,
            updatedAt: timestamp,
            revision: current.revision + 1
          })
          .where(and(eq(schedules.id, lock.id), eq(schedules.revision, lock.expectedRevision)))
          .run()
        if (result.changes !== 1) {
          items.push(archiveLockConflict(lock.id, '定时任务已被修改，请刷新后重试。'))
          continue
        }
        items.push({ id: lock.id, outcome: 'succeeded', error: null })
      }
      return ArchiveBulkResultSchema.parse(archiveBulkResult(items))
    })
  }
}
