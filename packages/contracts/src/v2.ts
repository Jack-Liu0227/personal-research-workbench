import { z } from 'zod'

/**
 * V2 uses opaque entity identifiers. The brands are compile-time only; the
 * wire representation remains a non-empty UTF-8 string for compatibility with
 * existing UUIDv7 rows.
 */
export const IdSchema = z.string().min(1).max(4_000)
export const ProjectIdSchema = IdSchema.brand<'ProjectId'>()
export const PaperIdSchema = IdSchema.brand<'PaperId'>()
export const TaskIdSchema = IdSchema.brand<'TaskId'>()
export type ProjectId = z.infer<typeof ProjectIdSchema>
export type PaperId = z.infer<typeof PaperIdSchema>
export type TaskId = z.infer<typeof TaskIdSchema>

export const IsoInstantSchema = z.iso.datetime({ offset: true })
export type IsoInstant = z.infer<typeof IsoInstantSchema>

const isIanaTimezone = (value: string): boolean => {
  try {
    // Validation only: the caller's browser timezone is never a fallback.
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

export const IanaTimezoneSchema = z.string().trim().min(1).max(100).refine(isIanaTimezone, {
  message: 'Expected a valid IANA timezone.'
})
export type IanaTimezone = z.infer<typeof IanaTimezoneSchema>
export const TimezoneSchema = IanaTimezoneSchema

export const DateRangeSchema = z.object({
  from: IsoInstantSchema,
  to: IsoInstantSchema,
  timezone: IanaTimezoneSchema,
  /** Include tasks without a due date in the filtered result. */
  includeNoDate: z.boolean().default(false),
  /** Restrict the result to tasks without a due date. */
  onlyNoDate: z.boolean().default(false)
}).superRefine((value, context) => {
  if (Date.parse(value.from) >= Date.parse(value.to)) {
    context.addIssue({ code: 'custom', path: ['to'], message: 'Date range must be half-open with from < to.' })
  }
})
export type DateRange = z.infer<typeof DateRangeSchema>

export const ObsidianRelativePathSchema = z.string().min(1).max(8_000).refine((value) => [...value].length <= 4_000, {
  message: 'Vault-relative paths must be at most 4,000 Unicode code points.'
}).refine((value) => {
  if (value.startsWith('/') || value.startsWith('\\') || value.includes('\\')) return false
  if (/^[A-Za-z]:/.test(value) || value.startsWith('\\\\')) return false
  const segments = value.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false
  if (segments.some((segment) => segment.toLowerCase() === '.obsidian')) return false
  return segments.at(-1)?.toLowerCase().endsWith('.md') ?? false
}, {
  message: 'Expected a vault-relative Markdown path without traversal.'
})
export type ObsidianRelativePath = z.infer<typeof ObsidianRelativePathSchema>
export const RelativePathSchema = ObsidianRelativePathSchema

/**
 * Indexed Vault entries include both Markdown files and directories. Keep
 * this projection path-safe while allowing a directory name as the final
 * segment; note read/write/delete inputs above remain Markdown-only.
 */
export const ObsidianIndexedRelativePathSchema = z.string().min(1).max(8_000).refine((value) => [...value].length <= 4_000, {
  message: 'Vault-relative paths must be at most 4,000 Unicode code points.'
}).refine((value) => {
  if (value.startsWith('/') || value.startsWith('\\') || value.includes('\\')) return false
  if (/^[A-Za-z]:/u.test(value) || value.startsWith('\\\\')) return false
  const segments = value.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false
  if (segments.some((segment) => ['.obsidian', '.git', '.trash', 'node_modules'].includes(segment.toLocaleLowerCase('en-US')))) return false
  return true
}, {
  message: 'Expected a safe vault-relative file or directory path without traversal.'
})
export type ObsidianIndexedRelativePath = z.infer<typeof ObsidianIndexedRelativePathSchema>

export const ZoteroItemKeySchema = z.string().trim().min(1).max(128)
export type ZoteroItemKey = z.infer<typeof ZoteroItemKeySchema>

export const CalendarEventTypeSchema = z.enum([
  'event', 'milestone', 'reading', 'experiment', 'meeting', 'submission', 'deadline',
  /** Read-only projection of a scheduled daily push (the rule's stored plan or
   * one stored occurrence of that rule). Never authorable by a user: see
   * `CalendarUserEventTypeSchema`. */
  'daily_push'
])
export type CalendarEventType = z.infer<typeof CalendarEventTypeSchema>

/** Types a user may author through `calendar.create` / `calendar.update`. The
 * daily-push type is reserved for the read-only Service projection, so a user
 * cannot fabricate a push event that looks like a scheduled run. */
export const CalendarUserEventTypeSchema = CalendarEventTypeSchema.exclude(['daily_push'])
export type CalendarUserEventType = z.infer<typeof CalendarUserEventTypeSchema>

/** A day/time marker that is independent from a calendar event. Markers are
 * user-authored records (unlike task/project virtual projections) and are
 * therefore editable and removable through the shared workspace service. */
export const CalendarMarkerTypeSchema = z.enum([
  'note', 'reminder', 'milestone', 'daily_push', 'reading', 'deadline'
])
export type CalendarMarkerType = z.infer<typeof CalendarMarkerTypeSchema>

export const CalendarMarkerSchema = z.object({
  id: IdSchema,
  projectId: ProjectIdSchema.nullable(),
  title: z.string().min(1),
  note: z.string(),
  type: CalendarMarkerTypeSchema,
  startsAt: IsoInstantSchema,
  endsAt: IsoInstantSchema,
  timezone: IanaTimezoneSchema,
  allDay: z.boolean(),
  taskId: TaskIdSchema.nullable(),
  paperId: PaperIdSchema.nullable(),
  color: z.string().regex(/^#[0-9a-f]{6}$/iu),
  revision: z.int().nonnegative(),
  createdAt: IsoInstantSchema,
  updatedAt: IsoInstantSchema
}).superRefine((value, context) => {
  if (Date.parse(value.endsAt) < Date.parse(value.startsAt)) {
    context.addIssue({ code: 'custom', path: ['endsAt'], message: 'Calendar marker endsAt must be >= startsAt.' })
  }
})
export type CalendarMarker = z.infer<typeof CalendarMarkerSchema>

const CalendarMarkerInputFieldsSchema = z.object({
  projectId: ProjectIdSchema.nullable().default(null),
  title: z.string().trim().min(1).max(240),
  note: z.string().max(20_000).default(''),
  type: CalendarMarkerTypeSchema.default('note'),
  startsAt: IsoInstantSchema,
  endsAt: IsoInstantSchema,
  timezone: IanaTimezoneSchema,
  allDay: z.boolean().default(true),
  taskId: TaskIdSchema.nullable().default(null),
  paperId: PaperIdSchema.nullable().default(null),
  color: z.string().regex(/^#[0-9a-f]{6}$/iu).default('#3b82f6')
})
const validateCalendarMarkerBounds = (value: { startsAt?: string | undefined; endsAt?: string | undefined }, context: z.RefinementCtx): void => {
  if (value.startsAt !== undefined && value.endsAt !== undefined && Date.parse(value.endsAt) < Date.parse(value.startsAt)) {
    context.addIssue({ code: 'custom', path: ['endsAt'], message: 'Calendar marker endsAt must be >= startsAt.' })
  }
}
export const CreateCalendarMarkerInputSchema = CalendarMarkerInputFieldsSchema.superRefine(validateCalendarMarkerBounds)
export type CreateCalendarMarkerInput = z.infer<typeof CreateCalendarMarkerInputSchema>
export const UpdateCalendarMarkerInputSchema = CalendarMarkerInputFieldsSchema.partial().extend({
  id: IdSchema,
  expectedRevision: z.int().nonnegative()
}).superRefine((value, context) => validateCalendarMarkerBounds(value, context))
export type UpdateCalendarMarkerInput = z.infer<typeof UpdateCalendarMarkerInputSchema>

/**
 * Mirrors of the Agent/automation enums that stay declared in this lower layer
 * to avoid an import cycle (the agent contract imports this module). The
 * workspace-service tests assert that these lists stay identical to
 * `ScheduleOccurrenceStatusSchema` / `AgentRunStatusSchema` /
 * `AgentResponseLanguageSchema`.
 */
export const CalendarDailyPushOccurrenceStatusSchema = z.enum(['claimed', 'running', 'completed', 'failed', 'blocked', 'canceled', 'missed', 'skipped'])
export const CalendarDailyPushRunStatusSchema = z.enum(['planned', 'queued', 'running', 'waiting_confirmation', 'completed', 'partial', 'failed', 'canceled', 'blocked', 'missed'])
export const CalendarDailyPushLanguageSchema = z.enum(['zh-CN', 'en'])
export const CalendarDailyPushStateSchema = z.enum(['planned', 'occurred'])

/**
 * Stored detail of one projected daily-push event. Every field comes from the
 * schedule row, the occurrence row or the run ledger — never from a demo
 * fixture, and never a copy of the pushed body (SQLite and the Vault note stay
 * authoritative for that).
 */
export const CalendarDailyPushDetailSchema = z.strictObject({
  scheduleId: IdSchema,
  scheduleName: z.string().min(1).max(200),
  /** `planned:<nextRunAt>` for a plan, the occurrence row id for a slot. */
  occurrenceKey: z.string().min(1).max(512),
  state: CalendarDailyPushStateSchema,
  /** Null while the slot is only planned: a plan has no status of its own. */
  occurrenceStatus: CalendarDailyPushOccurrenceStatusSchema.nullable(),
  occurrenceSource: z.enum(['scheduler', 'catchup', 'manual']).nullable(),
  runId: IdSchema.nullable(),
  runStatus: CalendarDailyPushRunStatusSchema.nullable(),
  /** Local day of the slot in the rule's own timezone (stored on the row). */
  localDateKey: z.string().max(20).nullable(),
  topic: z.string().max(500),
  language: CalendarDailyPushLanguageSchema,
  sources: z.array(z.string().max(200)).max(50),
  lookbackDays: z.int().nonnegative(),
  outputFolder: z.string().max(180),
  cron: z.string().min(1).max(200),
  timezone: IanaTimezoneSchema,
  artifact: z.strictObject({ id: IdSchema, title: z.string().max(500) }).nullable(),
  /** Vault-relative Markdown path recorded by the delivery ledger. */
  obsidianRelativePath: z.string().max(500).nullable(),
  delivery: z.strictObject({
    status: z.enum(['written', 'skipped']),
    reason: z.string().max(120).nullable(),
    message: z.string().max(500).nullable()
  }).nullable()
})
export type CalendarDailyPushDetail = z.infer<typeof CalendarDailyPushDetailSchema>

const CalendarEventBaseSchema = z.object({
  id: IdSchema,
  projectId: ProjectIdSchema.nullable(),
  title: z.string().min(1),
  description: z.string(),
  type: CalendarEventTypeSchema,
  startsAt: IsoInstantSchema,
  endsAt: IsoInstantSchema,
  timezone: IanaTimezoneSchema,
  allDay: z.boolean(),
  taskId: TaskIdSchema.nullable(),
  paperId: PaperIdSchema.nullable(),
  /** Present only on the read-only daily-push projection. */
  dailyPush: CalendarDailyPushDetailSchema.nullable().optional()
}).superRefine((value, context) => {
  if (Date.parse(value.endsAt) < Date.parse(value.startsAt)) {
    context.addIssue({ code: 'custom', path: ['endsAt'], message: 'Calendar event endsAt must be >= startsAt.' })
  }
})

export const CalendarEventSchema = z.union([
  CalendarEventBaseSchema.extend({ readOnly: z.literal(false), revision: z.int().nonnegative() }),
  CalendarEventBaseSchema.extend({ readOnly: z.literal(true), revision: z.int().nonnegative().nullable() })
]).superRefine((event, context) => {
  const dailyPush = event.dailyPush ?? null
  if (!event.readOnly) {
    // A user-authored event must never carry push metadata: that would be a
    // fabricated delivery/artifact claim outside the run ledger.
    if (dailyPush !== null) {
      context.addIssue({ code: 'custom', path: ['dailyPush'], message: 'Only read-only daily-push projections carry daily-push detail.' })
    }
    return
  }
  const isTaskProjection = event.id.startsWith('task:')
  const isProjectProjection = event.id.startsWith('project:')
  const isDailyPushProjection = event.id.startsWith('daily-push:')
  if (!isTaskProjection && !isProjectProjection && !isDailyPushProjection) {
    context.addIssue({ code: 'custom', path: ['id'], message: 'Read-only calendar events must be task/project/daily-push projections.' })
    return
  }
  if (isTaskProjection && (event.type !== 'deadline' || event.taskId === null)) {
    context.addIssue({ code: 'custom', message: 'Task projections must be deadline events with a taskId.' })
  }
  if (isProjectProjection && (event.type !== 'milestone' || event.projectId === null)) {
    context.addIssue({ code: 'custom', message: 'Project projections must be milestone events with a projectId.' })
  }
  if (!isDailyPushProjection) return
  if (event.type !== 'daily_push') {
    context.addIssue({ code: 'custom', path: ['type'], message: 'Daily-push projections must use the daily_push type.' })
  }
  if (event.taskId !== null) {
    context.addIssue({ code: 'custom', path: ['taskId'], message: 'Daily-push projections never belong to a task.' })
  }
  if (dailyPush === null) {
    context.addIssue({ code: 'custom', path: ['dailyPush'], message: 'Daily-push projections must carry their stored schedule/occurrence detail.' })
    return
  }
  if (event.id !== `daily-push:${dailyPush.scheduleId}:${dailyPush.occurrenceKey}`) {
    context.addIssue({ code: 'custom', path: ['id'], message: 'Daily-push projection id must be `daily-push:<scheduleId>:<occurrenceKey>`.' })
  }
  if (dailyPush.state === 'planned') {
    // A plan has no run, no artifact and no delivery yet. Contractually it also
    // cannot report a status: the UI must render it as 计划, never as 已完成.
    if (dailyPush.occurrenceStatus !== null || dailyPush.occurrenceSource !== null || dailyPush.runId !== null
      || dailyPush.runStatus !== null || dailyPush.localDateKey !== null || dailyPush.artifact !== null
      || dailyPush.obsidianRelativePath !== null || dailyPush.delivery !== null) {
      context.addIssue({ code: 'custom', path: ['dailyPush'], message: 'A planned daily-push slot must not report a run, artifact or delivery outcome.' })
    }
  } else if (dailyPush.occurrenceStatus === null) {
    context.addIssue({ code: 'custom', path: ['dailyPush'], message: 'A stored daily-push occurrence must carry its occurrence status.' })
  }
})
export type CalendarEvent = z.infer<typeof CalendarEventSchema>

export const CalendarRangeInputSchema = z.object({
  startsAt: IsoInstantSchema,
  endsAt: IsoInstantSchema,
  timezone: IanaTimezoneSchema,
  projectId: ProjectIdSchema.nullable().optional(),
  /** Filtering by `daily_push` is how the UI asks for the read-only push
   * projection only; omitting `types` returns every projection. */
  types: z.array(CalendarEventTypeSchema).optional(),
  /** Shared task filter applied only to read-only task projections. */
  taskDateRange: DateRangeSchema.optional()
}).superRefine((value, context) => {
  if (Date.parse(value.startsAt) >= Date.parse(value.endsAt)) {
    context.addIssue({ code: 'custom', path: ['endsAt'], message: 'Calendar range must be half-open with startsAt < endsAt.' })
  }
})
export type CalendarRangeInput = z.infer<typeof CalendarRangeInputSchema>

export const CalendarMarkerRangeInputSchema = z.object({
  startsAt: IsoInstantSchema,
  endsAt: IsoInstantSchema,
  timezone: IanaTimezoneSchema,
  projectId: ProjectIdSchema.nullable().optional(),
  types: z.array(CalendarMarkerTypeSchema).optional()
}).superRefine((value, context) => {
  if (Date.parse(value.startsAt) >= Date.parse(value.endsAt)) {
    context.addIssue({ code: 'custom', path: ['endsAt'], message: 'Calendar marker range must be half-open with startsAt < endsAt.' })
  }
})
export type CalendarMarkerRangeInput = z.infer<typeof CalendarMarkerRangeInputSchema>

const CalendarEventInputFieldsSchema = z.object({
  projectId: ProjectIdSchema.nullable().default(null),
  title: z.string().trim().min(1).max(240),
  description: z.string().max(20_000).default(''),
  type: CalendarUserEventTypeSchema.default('event'),
  startsAt: IsoInstantSchema,
  endsAt: IsoInstantSchema,
  timezone: IanaTimezoneSchema,
  allDay: z.boolean().default(false),
  taskId: TaskIdSchema.nullable().default(null),
  paperId: PaperIdSchema.nullable().default(null)
})
const validateCalendarEventBounds = (value: { startsAt?: string | undefined; endsAt?: string | undefined }, context: z.RefinementCtx): void => {
  if (value.startsAt !== undefined && value.endsAt !== undefined && Date.parse(value.endsAt) < Date.parse(value.startsAt)) {
    context.addIssue({ code: 'custom', path: ['endsAt'], message: 'Calendar event endsAt must be >= startsAt.' })
  }
}
export const CreateCalendarEventInputSchema = CalendarEventInputFieldsSchema.superRefine(validateCalendarEventBounds)
export type CreateCalendarEventInput = z.infer<typeof CreateCalendarEventInputSchema>

export const UpdateCalendarEventInputSchema = CalendarEventInputFieldsSchema.partial().extend({
  id: IdSchema,
  expectedRevision: z.int().nonnegative()
}).superRefine((value, context) => {
  if (value.startsAt !== undefined && value.endsAt !== undefined) validateCalendarEventBounds(value, context)
})
export type UpdateCalendarEventInput = z.infer<typeof UpdateCalendarEventInputSchema>

export const SearchSourceIdSchema = z.enum(['all', 'local', 'crossref', 'openalex', 'pubmed', 'arxiv', 'semantic_scholar', 'google_scholar'])
export type SearchSourceId = z.infer<typeof SearchSourceIdSchema>

const PrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
export const SearchSessionSchema = z.object({
  id: IdSchema,
  query: z.string(),
  source: SearchSourceIdSchema,
  filters: z.record(z.string(), PrimitiveSchema),
  createdAt: IsoInstantSchema,
  resultCount: z.int().nonnegative()
})
export type SearchSession = z.infer<typeof SearchSessionSchema>

export const SearchResultSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  source: SearchSourceIdSchema,
  sourceId: z.string().min(1),
  title: z.string().min(1),
  authors: z.array(z.string()),
  year: z.int().min(0).nullable(),
  venue: z.string(),
  abstract: z.string(),
  doi: z.string().nullable(),
  url: z.string().nullable(),
  isOpenAccess: z.boolean().nullable(),
  /** Public citation/attention proxy (for example OpenAlex cited-by count).
   * This is never presented as a JCR Journal Impact Factor. */
  openMetric: z.number().nonnegative().nullable().optional(),
  /** Journal impact factor, or a clearly labelled IF-style public metric,
   * when the source explicitly provides one. This is never silently treated
   * as Clarivate JCR data. */
  impactFactor: z.number().nonnegative().nullable().optional(),
  /** Identifier of the provider that supplied the impact factor.  A null
   * value means no authoritative provider supplied the metric. */
  impactFactorSource: z.string().trim().min(1).max(120).nullable().optional(),
  /** UTC instant at which the provider value was retrieved. */
  impactFactorFetchedAt: IsoInstantSchema.nullable().optional(),
  fingerprint: z.string().min(1),
  dedupeReason: z.string(),
  dedupeConfidence: z.number().min(0).max(1)
})
export type SearchResult = z.infer<typeof SearchResultSchema>

/** Opaque continuation tokens are issued by a connector/service and are
 * never interpreted as local row IDs or numeric offsets. */
export const CursorSchema = z.string().trim().min(1).max(512)
export type Cursor = z.infer<typeof CursorSchema>
export const PageInputSchema = z.object({
  limit: z.int().min(1).max(100).default(50),
  cursor: CursorSchema.nullable().optional()
})
export type PageInput = z.infer<typeof PageInputSchema>
export const SearchResultPageSchema = z.object({
  items: z.array(SearchResultSchema),
  total: z.int().nonnegative(),
  nextCursor: CursorSchema.nullable(),
  status: z.enum(['complete', 'partial']).default('complete')
})
export type SearchResultPage = z.infer<typeof SearchResultPageSchema>

export const SearchInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  source: SearchSourceIdSchema,
  page: z.int().min(1).default(1),
  pageSize: z.int().min(1).max(100).default(50),
  filters: z.record(z.string(), PrimitiveSchema).default({}),
  sort: z.enum(['relevance', 'year-asc', 'year-desc', 'impact-asc', 'impact-desc', 'metric-asc', 'metric-desc']).default('relevance')
})
export type SearchInput = z.infer<typeof SearchInputSchema>

/**
 * Search sessions/results are a disposable connector cache.  A selected
 * result that the user wants to keep is represented by this independent
 * persisted staging record; clearing a SearchSession must never remove one.
 * `sessionId` is provenance only and is nullable so a staged record survives
 * disposal of its originating search session.
 */
export const LiteratureStagingSourceSchema = SearchSourceIdSchema.exclude(['all'])
export type LiteratureStagingSource = z.infer<typeof LiteratureStagingSourceSchema>
export const LiteratureStagingRecordSchema = z.strictObject({
  id: IdSchema,
  sessionId: IdSchema.nullable(),
  projectId: ProjectIdSchema.nullable(),
  source: LiteratureStagingSourceSchema,
  sourceId: z.string().trim().min(1).max(4_000),
  title: z.string().trim().min(1).max(2_000),
  authors: z.array(z.string().trim().min(1).max(500)),
  year: z.int().min(0).nullable(),
  venue: z.string().max(2_000),
  abstract: z.string().max(200_000),
  doi: z.string().trim().max(500).nullable(),
  url: z.string().trim().max(4_000).nullable(),
  isOpenAccess: z.boolean().nullable(),
  openMetric: z.number().nonnegative().nullable(),
  fingerprint: z.string().trim().min(1).max(4_000),
  dedupeReason: z.string().max(2_000),
  dedupeConfidence: z.number().min(0).max(1),
  paperId: PaperIdSchema.nullable(),
  createdAt: IsoInstantSchema,
  updatedAt: IsoInstantSchema,
  revision: z.int().nonnegative()
})
export type LiteratureStagingRecord = z.infer<typeof LiteratureStagingRecordSchema>

const LiteratureStagingRecordFieldsSchema = LiteratureStagingRecordSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  revision: true
}).extend({
  sessionId: IdSchema.nullable().default(null),
  projectId: ProjectIdSchema.nullable().default(null),
  authors: z.array(z.string().trim().min(1).max(500)).default([]),
  year: z.int().min(0).nullable().default(null),
  venue: z.string().max(2_000).default(''),
  abstract: z.string().max(200_000).default(''),
  doi: z.string().trim().max(500).nullable().default(null),
  url: z.string().trim().max(4_000).nullable().default(null),
  isOpenAccess: z.boolean().nullable().default(null),
  openMetric: z.number().nonnegative().nullable().default(null),
  dedupeReason: z.string().max(2_000).default(''),
  dedupeConfidence: z.number().min(0).max(1).default(0),
  paperId: PaperIdSchema.nullable().default(null)
})
export const LiteratureStagingSaveInputSchema = z.strictObject({
  ...LiteratureStagingRecordFieldsSchema.shape,
  id: IdSchema.optional(),
  expectedRevision: z.int().nonnegative().nullable().default(null)
}).superRefine((value, context) => {
  if (value.id === undefined && value.expectedRevision !== null) {
    context.addIssue({ code: 'custom', path: ['expectedRevision'], message: 'New staging records cannot carry an expected revision.' })
  }
  if (value.id !== undefined && value.expectedRevision === null) {
    context.addIssue({ code: 'custom', path: ['expectedRevision'], message: 'Updating a staging record requires an expected revision.' })
  }
})
export type LiteratureStagingSaveInput = z.infer<typeof LiteratureStagingSaveInputSchema>

export const LiteratureStagingPageInputSchema = z.strictObject({
  page: PageInputSchema.optional(),
  source: LiteratureStagingSourceSchema.optional(),
  projectId: ProjectIdSchema.nullable().optional(),
  query: z.string().trim().max(500).default('')
})
export type LiteratureStagingPageInput = z.infer<typeof LiteratureStagingPageInputSchema>
export const LiteratureStagingPageSchema = z.strictObject({
  items: z.array(LiteratureStagingRecordSchema),
  total: z.int().nonnegative(),
  nextCursor: CursorSchema.nullable(),
  status: z.enum(['complete', 'partial']).default('complete')
})
export type LiteratureStagingPage = z.infer<typeof LiteratureStagingPageSchema>

export const LiteratureStagingDeleteInputSchema = z.strictObject({
  id: IdSchema,
  expectedRevision: z.int().nonnegative()
})
export type LiteratureStagingDeleteInput = z.infer<typeof LiteratureStagingDeleteInputSchema>
export const LiteratureStagingDeleteReceiptSchema = z.strictObject({
  id: IdSchema,
  status: z.enum(['deleted', 'not-found', 'conflict']),
  deleted: z.boolean()
}).superRefine((value, context) => {
  if (value.deleted !== (value.status === 'deleted')) {
    context.addIssue({ code: 'custom', path: ['deleted'], message: 'deleted must agree with status.' })
  }
})
export type LiteratureStagingDeleteReceipt = z.infer<typeof LiteratureStagingDeleteReceiptSchema>

export const LiteratureStagingSelectionSchema = z.strictObject({
  mode: z.enum(['none', 'page', 'all-results', 'explicit']),
  selectedIds: z.array(IdSchema),
  excludedIds: z.array(IdSchema),
  queryFingerprint: z.string().trim().min(1).max(512).nullable()
}).superRefine((value, context) => {
  if (new Set(value.selectedIds).size !== value.selectedIds.length) {
    context.addIssue({ code: 'custom', path: ['selectedIds'], message: 'Staging selection IDs must be unique.' })
  }
  if (new Set(value.excludedIds).size !== value.excludedIds.length) {
    context.addIssue({ code: 'custom', path: ['excludedIds'], message: 'Excluded staging IDs must be unique.' })
  }
  if (value.mode === 'none' && (value.selectedIds.length > 0 || value.excludedIds.length > 0)) {
    context.addIssue({ code: 'custom', message: 'none selection cannot contain selected or excluded IDs.' })
  }
  if (value.mode === 'all-results' && value.queryFingerprint === null) {
    context.addIssue({ code: 'custom', path: ['queryFingerprint'], message: 'all-results staging selection requires a query fingerprint.' })
  }
})
export type LiteratureStagingSelection = z.infer<typeof LiteratureStagingSelectionSchema>
export const LiteratureStagingRevisionLockSchema = z.strictObject({
  id: IdSchema,
  expectedRevision: z.int().nonnegative()
})
export type LiteratureStagingRevisionLock = z.infer<typeof LiteratureStagingRevisionLockSchema>
export const LiteratureStagingBulkDeleteInputSchema = z.strictObject({
  selection: LiteratureStagingSelectionSchema,
  expectedRevisions: z.array(LiteratureStagingRevisionLockSchema).min(1)
}).superRefine((value, context) => {
  const ids = value.expectedRevisions.map((lock) => lock.id)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['expectedRevisions'], message: 'Staging revision locks must be unique.' })
  }
})
export type LiteratureStagingBulkDeleteInput = z.infer<typeof LiteratureStagingBulkDeleteInputSchema>
export const LiteratureStagingBulkDeleteItemSchema = z.strictObject({
  id: IdSchema,
  outcome: z.enum(['succeeded', 'skipped', 'failed']),
  error: z.lazy(() => IntegrationErrorSchema).nullable()
})
export type LiteratureStagingBulkDeleteItem = z.infer<typeof LiteratureStagingBulkDeleteItemSchema>
export const LiteratureStagingBulkDeleteResultSchema = z.strictObject({
  items: z.array(LiteratureStagingBulkDeleteItemSchema),
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
export type LiteratureStagingBulkDeleteResult = z.infer<typeof LiteratureStagingBulkDeleteResultSchema>

/** Remove one persisted search session and its local result projection. The
 * operation deliberately addresses only search-session tables; imported
 * Papers are independent records and are never touched by this command. */
export const LiteratureClearSessionInputSchema = z.strictObject({
  sessionId: IdSchema
})
export type LiteratureClearSessionInput = z.infer<typeof LiteratureClearSessionInputSchema>

export const LiteratureClearSessionReceiptSchema = z.strictObject({
  sessionId: IdSchema,
  status: z.enum(['deleted', 'not-found']),
  deletedResults: z.int().nonnegative(),
  deletedSession: z.boolean()
})
export type LiteratureClearSessionReceipt = z.infer<typeof LiteratureClearSessionReceiptSchema>

export const NoteSchema = z.object({
  id: IdSchema,
  vaultId: IdSchema,
  relativePath: ObsidianIndexedRelativePathSchema,
  title: z.string().min(1),
  tags: z.array(z.string()),
  updatedAt: IsoInstantSchema,
  fingerprint: z.string().min(1),
  content: z.string().optional(),
  isFolder: z.boolean().optional(),
  /** Controlled frontmatter projection; the Obsidian file remains authoritative. */
  projectId: ProjectIdSchema.nullable().optional(),
  kind: z.string().trim().min(1).nullable().optional(),
  parentRelativePath: ObsidianIndexedRelativePathSchema.nullable().optional()
})
export type Note = z.infer<typeof NoteSchema>

export const NoteListInputSchema = z.object({
  vaultId: IdSchema,
  query: z.string().max(500).default('')
})
export type NoteListInput = z.infer<typeof NoteListInputSchema>

export const ReadNoteInputSchema = z.object({ vaultId: IdSchema, relativePath: ObsidianRelativePathSchema })
export type ReadNoteInput = z.infer<typeof ReadNoteInputSchema>

export const WriteNoteInputSchema = z.object({
  vaultId: IdSchema,
  relativePath: ObsidianRelativePathSchema,
  content: z.string().max(2_000_000),
  expectedFingerprint: z.string().min(1).nullable()
})
export type WriteNoteInput = z.infer<typeof WriteNoteInputSchema>

/** Explicit, user-confirmed removal of a Markdown note from an authorized
 * Vault. The fingerprint prevents deleting a file that changed externally. */
export const DeleteNoteInputSchema = z.object({
  vaultId: IdSchema,
  relativePath: ObsidianRelativePathSchema,
  expectedFingerprint: z.string().min(1).nullable().default(null)
})
export type DeleteNoteInput = z.infer<typeof DeleteNoteInputSchema>
export const NoteDeleteReceiptSchema = z.strictObject({
  vaultId: IdSchema,
  relativePath: ObsidianRelativePathSchema,
  status: z.enum(['deleted', 'not-found'])
})
export type NoteDeleteReceipt = z.infer<typeof NoteDeleteReceiptSchema>

/**
 * Obsidian project-layout contracts are deliberately transport-safe.  A
 * renderer receives profile/project identifiers and vault-relative POSIX
 * paths only; absolute roots and resolved filesystem paths stay in Main,
 * Connector and Workspace Service.
 */
export const ObsidianLayoutKindSchema = z.enum([
  'daily_literature', 'literature_matrix', 'literature_review',
  'writing_templates', 'prompt_library', 'tasks', 'calendar', 'resources',
  'knowledge_index', 'anything_llm', 'llm_wiki'
])
export type ObsidianLayoutKind = z.infer<typeof ObsidianLayoutKindSchema>

const hasWindowsUnsafeComponent = (value: string): boolean => {
  if (/[\u0000-\u001f<>:"/\\|?*]/u.test(value)) return true
  if (/[. ]$/u.test(value)) return true
  const baseName = value.split('.')[0]?.toLocaleUpperCase('en-US') ?? value
  return new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
    ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)
  ]).has(baseName)
}

/**
 * Structural safety of one Vault-relative POSIX path.
 *
 * This is the single predicate behind `ObsidianLayoutRelativePathSchema` and
 * the schedule output-folder contract: an absolute path, a Windows drive/UNC
 * prefix, a backslash, an empty segment, `.`/`..` traversal, the `.obsidian`
 * internal directory and a Windows-unsafe segment (reserved device name,
 * control character, `<>:"|?*`, trailing dot/space) are all rejected here.
 */
export function isSafeVaultRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/u.test(value)) return false
  const segments = value.split('/')
  return !segments.some((segment) => !segment || segment === '.' || segment === '..' || isObsidianSegmentName(segment) || hasWindowsUnsafeComponent(segment))
}

/** Trim and convert backslashes so a Windows-style entry can be validated by
 * the POSIX-relative predicate instead of being rejected for its separator. */
export function normalizeVaultRelativePath(value: string): string {
  return value.trim().replace(/\\/gu, '/')
}

const ObsidianDirectoryNameSchema = z.string().trim().min(1).max(180).refine((value) => !hasWindowsUnsafeComponent(value), {
  message: 'Expected a Windows-safe single directory component.'
})
export const ObsidianLayoutDirectoryNameSchema = ObsidianDirectoryNameSchema
export type ObsidianLayoutDirectoryName = z.infer<typeof ObsidianDirectoryNameSchema>

/** Deprecated compatibility metadata for the legacy project-directory route.
 * The canonical root-level Vault flow is defined by
 * `ObsidianVaultLayoutPlanSchema` below; these names intentionally carry no
 * numeric prefixes so an old caller cannot create the former numbered tree. */
export const ObsidianLayoutCategorySchema = z.strictObject({
  kind: ObsidianLayoutKindSchema,
  enumName: z.string().regex(/^[A-Z][A-Za-z0-9]*$/u),
  directoryName: ObsidianDirectoryNameSchema,
  description: z.string().trim().min(1).max(500)
})
export type ObsidianLayoutCategory = z.infer<typeof ObsidianLayoutCategorySchema>

export const OBSIDIAN_LAYOUT_CATEGORIES = [
  { kind: 'daily_literature', enumName: 'DailyLiterature', directoryName: '每日文献推送', description: '按日期保存每日文献推送 Markdown。' },
  { kind: 'literature_matrix', enumName: 'LiteratureMatrix', directoryName: '文献矩阵', description: '保存文献矩阵 Markdown 与字段说明。' },
  { kind: 'literature_review', enumName: 'LiteratureReview', directoryName: '文献综述', description: '保存综述草稿和引用说明。' },
  { kind: 'writing_templates', enumName: 'WritingTemplates', directoryName: '写作模板', description: '保存写作模板 Markdown，不执行模板。' },
  { kind: 'prompt_library', enumName: 'PromptLibrary', directoryName: '提示词库', description: '保存提示词 Markdown，不执行 Prompt。' },
  { kind: 'tasks', enumName: 'Tasks', directoryName: '任务', description: '保存项目任务相关 Markdown。' },
  { kind: 'calendar', enumName: 'Calendar', directoryName: '日历', description: '保存日历 Markdown；日历投影默认只读。' },
  { kind: 'resources', enumName: 'Resources', directoryName: '资源', description: '保存项目资源和附件链接说明。' },
  { kind: 'knowledge_index', enumName: 'KnowledgeIndex', directoryName: '知识库索引', description: '保存知识库索引摘要与映射，不执行 RAG/Agent。' },
  { kind: 'anything_llm', enumName: 'AnythingLLM', directoryName: 'AnythingLLM', description: 'AnythingLLM workspace documents, index summaries and source mappings.' },
  { kind: 'llm_wiki', enumName: 'LLMWiki', directoryName: 'LLMWiki', description: 'LLMWiki pages, relationship maps and MCP knowledge indexes.' }
] as const
export const ObsidianLayoutCategories = OBSIDIAN_LAYOUT_CATEGORIES
export const ObsidianLayoutCategoriesSchema = z.tuple([
  ObsidianLayoutCategorySchema, ObsidianLayoutCategorySchema,
  ObsidianLayoutCategorySchema, ObsidianLayoutCategorySchema,
  ObsidianLayoutCategorySchema, ObsidianLayoutCategorySchema,
  ObsidianLayoutCategorySchema, ObsidianLayoutCategorySchema,
  ObsidianLayoutCategorySchema, ObsidianLayoutCategorySchema,
  ObsidianLayoutCategorySchema
]).superRefine((values, context) => {
  const kinds = values.map((value) => value.kind)
  const identityMismatch = values.some((value, index) => {
    const expected = OBSIDIAN_LAYOUT_CATEGORIES[index]
    return value.kind !== expected?.kind || value.enumName !== expected?.enumName
  })
  if (new Set(kinds).size !== kinds.length || identityMismatch) {
    context.addIssue({ code: 'custom', path: ['kind'], message: 'Layout categories must match the frozen eleven-kind order.' })
  }
})
export type ObsidianLayoutCategories = z.infer<typeof ObsidianLayoutCategoriesSchema>

/** Windows-safe single directory component produced by slug sanitization. */
export const ObsidianProjectSlugSchema = z.string().trim().min(1).max(360)
  .refine((value) => [...value].length <= 180, { message: 'Project slugs must be at most 180 Unicode code points.' })
  .refine((value) => !hasWindowsUnsafeComponent(value), { message: 'Expected a Windows-safe project directory slug.' })
export type ObsidianProjectSlug = z.infer<typeof ObsidianProjectSlugSchema>
export const WindowsSafeSlugSchema = ObsidianProjectSlugSchema
export type WindowsSafeSlug = ObsidianProjectSlug

/** Vault-relative POSIX path used for layout directories and Markdown files. */
export const ObsidianLayoutRelativePathSchema = z.string().min(1).max(8_000).refine((value) => [...value].length <= 4_000, {
  message: 'Vault-relative paths must be at most 4,000 Unicode code points.'
}).refine((value) => isSafeVaultRelativePath(value), { message: 'Expected a vault-relative POSIX path without traversal.' })
export type ObsidianLayoutRelativePath = z.infer<typeof ObsidianLayoutRelativePathSchema>
export const ObsidianRelativeDirectorySchema = ObsidianLayoutRelativePathSchema
export const LayoutRelativePathSchema = ObsidianLayoutRelativePathSchema
export const ObsidianProjectRelativePathSchema = ObsidianLayoutRelativePathSchema.refine((value) => !value.includes('/'), {
  message: 'A project directory must be a direct child of the Vault root.'
})
export type ObsidianProjectRelativePath = z.infer<typeof ObsidianProjectRelativePathSchema>

/** Explicit root-category removal. Categories are external Vault folders,
 * so the command is intentionally limited to one safe root-level directory;
 * the connector refuses non-empty folders instead of recursively deleting
 * user files. Callers can remove Markdown files first through notes.delete. */
export const DeleteNoteFolderInputSchema = z.strictObject({
  vaultId: IdSchema,
  relativePath: ObsidianProjectRelativePathSchema
})
export type DeleteNoteFolderInput = z.infer<typeof DeleteNoteFolderInputSchema>
export const NoteFolderDeleteReceiptSchema = z.strictObject({
  vaultId: IdSchema,
  relativePath: ObsidianProjectRelativePathSchema,
  status: z.enum(['deleted', 'not-found', 'not-empty']),
  remainingEntries: z.int().nonnegative()
})
export type NoteFolderDeleteReceipt = z.infer<typeof NoteFolderDeleteReceiptSchema>
export const ObsidianLayoutMarkdownPathSchema = ObsidianLayoutRelativePathSchema.refine((value) => value.toLocaleLowerCase('en-US').endsWith('.md'), {
  message: 'Expected a vault-relative Markdown path.'
})

/**
 * Note authoring commands.  Creating a folder is idempotent and refuses
 * `.md` names, traversal and `.obsidian`; moving never overwrites an existing
 * target and uses the last-seen fingerprint as a compare-and-swap guard for
 * notes.  Nothing here can reach outside the authorized Vault.
 */
export const CreateNoteFolderInputSchema = z.strictObject({
  vaultId: IdSchema,
  relativePath: ObsidianLayoutRelativePathSchema
})
export type CreateNoteFolderInput = z.infer<typeof CreateNoteFolderInputSchema>
export const NoteFolderCreateReceiptSchema = z.strictObject({
  vaultId: IdSchema,
  relativePath: ObsidianLayoutRelativePathSchema,
  status: z.enum(['created', 'exists'])
})
export type NoteFolderCreateReceipt = z.infer<typeof NoteFolderCreateReceiptSchema>

export const NoteMoveKindSchema = z.enum(['file', 'directory'])
export type NoteMoveKind = z.infer<typeof NoteMoveKindSchema>
export const MoveNoteInputSchema = z.strictObject({
  vaultId: IdSchema,
  kind: NoteMoveKindSchema,
  fromRelativePath: ObsidianLayoutRelativePathSchema,
  toRelativePath: ObsidianLayoutRelativePathSchema,
  expectedFingerprint: z.string().min(1).nullable().default(null)
}).refine(
  (value) => value.kind !== 'directory' || (!value.fromRelativePath.includes('/') && !value.toRelativePath.includes('/')),
  { message: 'A Vault category move must stay at the root level.', path: ['fromRelativePath'] }
).refine(
  (value) => value.kind !== 'file' || (value.fromRelativePath.toLocaleLowerCase('en-US').endsWith('.md') && value.toRelativePath.toLocaleLowerCase('en-US').endsWith('.md')),
  { message: 'A note move only accepts Markdown paths.', path: ['toRelativePath'] }
)
export type MoveNoteInput = z.infer<typeof MoveNoteInputSchema>
export const NoteMoveReceiptSchema = z.strictObject({
  vaultId: IdSchema,
  kind: NoteMoveKindSchema,
  fromRelativePath: ObsidianLayoutRelativePathSchema,
  toRelativePath: ObsidianLayoutRelativePathSchema,
  fingerprint: z.string().min(1).nullable()
})
export type NoteMoveReceipt = z.infer<typeof NoteMoveReceiptSchema>

/**
 * Controlled frontmatter metadata.  The patch only names managed keys; every
 * unknown field in the user's frontmatter is reported and preserved verbatim.
 * `parentRelativePath` expresses a child-note relation.
 */
export const NoteMetadataPatchSchema = z.strictObject({
  projectId: ProjectIdSchema.nullable().optional(),
  kind: ObsidianLayoutKindSchema.nullable().optional(),
  title: z.string().trim().min(1).max(500).optional(),
  date: z.string().trim().min(1).max(64).optional(),
  paperIds: z.array(PaperIdSchema).max(500).optional(),
  taskIds: z.array(TaskIdSchema).max(500).optional(),
  parentRelativePath: z.string().min(1).max(8_000).nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(200)).max(100).optional()
})
export type NoteMetadataPatch = z.infer<typeof NoteMetadataPatchSchema>

export const NoteMetadataSummarySchema = z.strictObject({
  projectId: z.string().nullable(),
  kind: ObsidianLayoutKindSchema.nullable(),
  title: z.string().nullable(),
  date: z.string().nullable(),
  parentRelativePath: z.string().nullable(),
  paperIds: z.array(z.string()),
  taskIds: z.array(z.string()),
  labels: z.array(z.string())
})
export type NoteMetadataSummary = z.infer<typeof NoteMetadataSummarySchema>

export const NoteMetadataPreviewInputSchema = z.strictObject({
  vaultId: IdSchema,
  relativePath: ObsidianRelativePathSchema,
  patch: NoteMetadataPatchSchema
})
export type NoteMetadataPreviewInput = z.infer<typeof NoteMetadataPreviewInputSchema>
export const NoteMetadataPreviewSchema = z.strictObject({
  vaultId: IdSchema,
  relativePath: ObsidianRelativePathSchema,
  fingerprint: z.string().min(1),
  before: NoteMetadataSummarySchema,
  after: NoteMetadataSummarySchema,
  changedFields: z.array(z.string()),
  preservedUnknownFields: z.array(z.string()),
  warnings: z.array(z.string()),
  canApply: z.boolean()
})
export type NoteMetadataPreview = z.infer<typeof NoteMetadataPreviewSchema>

/** Applying metadata is a preview-confirmed write: it requires the exact
 * fingerprint the preview was computed from, so a file edited in Obsidian in
 * the meantime fails the CAS instead of being overwritten. */
export const ApplyNoteMetadataInputSchema = z.strictObject({
  vaultId: IdSchema,
  relativePath: ObsidianRelativePathSchema,
  patch: NoteMetadataPatchSchema,
  expectedFingerprint: z.string().min(1),
  confirmed: z.literal(true)
})
export type ApplyNoteMetadataInput = z.infer<typeof ApplyNoteMetadataInputSchema>

/**
 * Duplicate probe used before a note-import write.  Matching is intentionally
 * conservative (exact path or normalized title) and never guesses a DOI or
 * content identity that the Vault cannot prove.
 */
export const NoteDuplicateInputSchema = z.strictObject({
  vaultId: IdSchema,
  relativePath: ObsidianRelativePathSchema,
  title: z.string().trim().min(1).max(500).optional()
})
export type NoteDuplicateInput = z.infer<typeof NoteDuplicateInputSchema>
export const NoteDuplicateCandidateSchema = z.strictObject({
  relativePath: ObsidianRelativePathSchema,
  title: z.string().min(1),
  fingerprint: z.string().min(1),
  updatedAt: IsoInstantSchema,
  match: z.enum(['path', 'title'])
})
export type NoteDuplicateCandidate = z.infer<typeof NoteDuplicateCandidateSchema>
export const NoteDuplicateReportSchema = z.strictObject({
  vaultId: IdSchema,
  relativePath: ObsidianRelativePathSchema,
  status: z.enum(['new', 'exists', 'duplicate']),
  /** Fingerprint of the existing target so the caller can update instead of overwrite. */
  targetFingerprint: z.string().min(1).nullable(),
  candidates: z.array(NoteDuplicateCandidateSchema)
})
export type NoteDuplicateReport = z.infer<typeof NoteDuplicateReportSchema>

function isObsidianSegmentName(value: string): boolean {
  return value.normalize('NFC').replace(/[. ]+$/gu, '').toLocaleLowerCase('en-US') === '.obsidian'
}

export const ObsidianLayoutPathKindSchema = z.enum(['directory', 'file', 'symlink', 'missing', 'unknown'])
export type ObsidianLayoutPathKind = z.infer<typeof ObsidianLayoutPathKindSchema>
export type LayoutPathKind = ObsidianLayoutPathKind
export const LayoutPathKindSchema = ObsidianLayoutPathKindSchema
export const LayoutChoiceSchema = z.enum(['bind', 'create', 'cancel'])
export type LayoutChoice = z.infer<typeof LayoutChoiceSchema>

export const ObsidianLayoutCategoryPlanSchema = z.strictObject({
  kind: ObsidianLayoutKindSchema,
  enumName: z.string().regex(/^[A-Z][A-Za-z0-9]*$/u),
  directoryName: ObsidianDirectoryNameSchema,
  relativePath: ObsidianLayoutRelativePathSchema
})
export type ObsidianLayoutCategoryPlan = z.infer<typeof ObsidianLayoutCategoryPlanSchema>
export const LayoutCategoryPlanSchema = ObsidianLayoutCategoryPlanSchema
export type LayoutCategoryPlan = ObsidianLayoutCategoryPlan

export const ObsidianLayoutCollisionSchema = z.strictObject({
  requestedSlug: ObsidianProjectSlugSchema,
  existingName: z.string().trim().min(1).max(255).refine((value) => !/[\u0000-\u001f/\\]/u.test(value), {
    message: 'Collision names must be a single filesystem component.'
  }),
  existingKind: ObsidianLayoutPathKindSchema,
  choices: z.array(LayoutChoiceSchema).length(3)
}).superRefine((value, context) => {
  if (new Set(value.choices).size !== value.choices.length || LayoutChoiceSchema.options.some((choice) => !value.choices.includes(choice))) {
    context.addIssue({ code: 'custom', path: ['choices'], message: 'Collision choices must include bind, create and cancel exactly once.' })
  }
})
export type ObsidianLayoutCollision = z.infer<typeof ObsidianLayoutCollisionSchema>
export const LayoutCollisionSchema = ObsidianLayoutCollisionSchema
export type LayoutCollision = ObsidianLayoutCollision

export const ObsidianLayoutPlanSchema = z.strictObject({
  planId: IdSchema,
  profileId: IdSchema,
  projectId: ProjectIdSchema,
  displayName: z.string().trim().min(1).max(240),
  requestedSlug: ObsidianProjectSlugSchema,
  slug: ObsidianProjectSlugSchema,
  projectRelativePath: ObsidianProjectRelativePathSchema,
  categories: ObsidianLayoutCategoryPlanSchema.array().length(11),
  readmeRelativePath: ObsidianLayoutMarkdownPathSchema,
  // project directory + eleven category directories + README
  relativePaths: ObsidianLayoutRelativePathSchema.array().min(1).max(13),
  collision: ObsidianLayoutCollisionSchema.nullable(),
  requiresConfirmation: z.literal(true)
}).superRefine((value, context) => {
  const kinds = value.categories.map((category) => category.kind)
  const identityMismatch = value.categories.some((category, index) => {
    const expected = OBSIDIAN_LAYOUT_CATEGORIES[index]
    return category.kind !== expected?.kind || category.enumName !== expected?.enumName
  })
  if (value.categories.length !== 11 || new Set(kinds).size !== kinds.length || identityMismatch) {
    context.addIssue({ code: 'custom', path: ['categories'], message: 'A project layout must contain the frozen eleven categories.' })
  }
  const paths = [value.projectRelativePath, ...value.categories.map((category) => category.relativePath), value.readmeRelativePath]
  if (new Set(paths).size !== paths.length) context.addIssue({ code: 'custom', path: ['relativePaths'], message: 'Layout paths must be unique.' })
  const categoryPathMismatch = value.categories.some((category) => category.relativePath !== `${value.projectRelativePath}/${category.directoryName}`)
  const readmePathMismatch = value.readmeRelativePath !== `${value.projectRelativePath}/README.md`
  if (categoryPathMismatch || readmePathMismatch || value.relativePaths.length !== paths.length || value.relativePaths.some((path, index) => path !== paths[index])) {
    context.addIssue({ code: 'custom', path: ['relativePaths'], message: 'Layout relativePaths must enumerate project, categories and README.' })
  }
})
export type ObsidianLayoutPlan = z.infer<typeof ObsidianLayoutPlanSchema>
export const LayoutPlanSchema = ObsidianLayoutPlanSchema
export type LayoutPlan = ObsidianLayoutPlan

const LayoutDisplayNameSchema = z.string().trim().min(1).max(240)
export const ObsidianLayoutPreviewInputSchema = z.strictObject({
  profileId: IdSchema,
  projectId: ProjectIdSchema,
  displayName: LayoutDisplayNameSchema
})
export type ObsidianLayoutPreviewInput = z.infer<typeof ObsidianLayoutPreviewInputSchema>
export const LayoutPreviewInputSchema = ObsidianLayoutPreviewInputSchema
export const ObsidianLayoutInitializeInputSchema = z.strictObject({
  profileId: IdSchema,
  projectId: ProjectIdSchema,
  displayName: LayoutDisplayNameSchema,
  planId: IdSchema,
  expectedRevision: z.int().nonnegative(),
  confirmed: z.literal(true),
  choice: LayoutChoiceSchema.optional()
})
export type ObsidianLayoutInitializeInput = z.infer<typeof ObsidianLayoutInitializeInputSchema>
export const LayoutInitializeInputSchema = ObsidianLayoutInitializeInputSchema

const redactedLayoutMessage = (value: string): boolean => !/([A-Za-z]:[\\/]|\\\\|(?:^|[\s(])\/(?:[^/\s]+\/)+[^\s)]*|Bearer\s|token=|api[_-]?key)/i.test(value)
export const ObsidianLayoutErrorCodeSchema = z.enum([
  'INVALID_ROOT', 'INVALID_SLUG', 'OUTSIDE_ROOT', 'SYMLINK_REJECTED',
  'NON_MARKDOWN', 'COLLISION_CHOICE_REQUIRED', 'COLLISION_CHANGED',
  'CONFIRMATION_REQUIRED', 'CANCELED', 'WRITE_FAILED', 'FRONTMATTER_INVALID'
])
export type ObsidianLayoutErrorCode = z.infer<typeof ObsidianLayoutErrorCodeSchema>
export const ObsidianLayoutErrorSchema = z.strictObject({
  code: ObsidianLayoutErrorCodeSchema,
  message: z.string().trim().min(1).max(500).refine(redactedLayoutMessage, { message: 'Layout errors must be redacted.' }),
  retryable: z.boolean(),
  requiresConfirmation: z.boolean(),
  partial: z.boolean()
})
export type ObsidianLayoutError = z.infer<typeof ObsidianLayoutErrorSchema>
export const LayoutErrorSchema = ObsidianLayoutErrorSchema
export type LayoutError = ObsidianLayoutError

export const ObsidianLayoutReceiptSchema = z.strictObject({
  status: z.enum(['created', 'bound', 'canceled', 'partial']),
  profileId: IdSchema,
  projectId: ProjectIdSchema,
  slug: ObsidianProjectSlugSchema.nullable(),
  projectRelativePath: ObsidianProjectRelativePathSchema.nullable(),
  createdPaths: ObsidianLayoutRelativePathSchema.array(),
  preservedPaths: ObsidianLayoutRelativePathSchema.array(),
  message: z.string().trim().min(1).max(500).refine(redactedLayoutMessage, { message: 'Layout receipts must be redacted.' }),
  error: ObsidianLayoutErrorSchema.nullable().optional()
})
export type ObsidianLayoutReceipt = z.infer<typeof ObsidianLayoutReceiptSchema>
export const LayoutReceiptSchema = ObsidianLayoutReceiptSchema
export type LayoutReceipt = ObsidianLayoutReceipt

/**
 * Root-level Vault taxonomy. Unlike the legacy project-layout contract above,
 * this layout intentionally has no project directory and accepts custom
 * folders. Project isolation is carried by Markdown labels/frontmatter.
 */
export const ObsidianVaultCategoryKindSchema = ObsidianLayoutKindSchema.or(z.literal('custom'))
export type ObsidianVaultCategoryKind = z.infer<typeof ObsidianVaultCategoryKindSchema>
export const ObsidianVaultCategorySchema = z.strictObject({
  name: ObsidianDirectoryNameSchema,
  kind: ObsidianVaultCategoryKindSchema,
  relativePath: ObsidianLayoutRelativePathSchema
}).superRefine((value, context) => {
  if (value.relativePath !== value.name) context.addIssue({ code: 'custom', path: ['relativePath'], message: 'Vault categories must be direct children of the Vault root.' })
})
export type ObsidianVaultCategory = z.infer<typeof ObsidianVaultCategorySchema>
export const ObsidianVaultLayoutPlanSchema = z.strictObject({
  planId: IdSchema,
  profileId: IdSchema,
  categories: ObsidianVaultCategorySchema.array().min(1).max(64),
  readmeRelativePath: ObsidianLayoutMarkdownPathSchema,
  relativePaths: ObsidianLayoutRelativePathSchema.array().min(2).max(65),
  existingPaths: ObsidianLayoutRelativePathSchema.array(),
  requiresConfirmation: z.literal(true)
}).superRefine((value, context) => {
  const paths = [...value.categories.map((category) => category.relativePath), value.readmeRelativePath]
  if (new Set(paths).size !== paths.length || value.relativePaths.length !== paths.length || value.relativePaths.some((path, index) => path !== paths[index])) {
    context.addIssue({ code: 'custom', path: ['relativePaths'], message: 'Vault layout paths must enumerate categories and README exactly once.' })
  }
  if (new Set(value.categories.map((category) => category.name.toLocaleLowerCase('en-US'))).size !== value.categories.length) {
    context.addIssue({ code: 'custom', path: ['categories'], message: 'Vault category names must be unique.' })
  }
})
export type ObsidianVaultLayoutPlan = z.infer<typeof ObsidianVaultLayoutPlanSchema>
export const ObsidianVaultLayoutPreviewInputSchema = z.strictObject({
  profileId: IdSchema,
  categories: ObsidianDirectoryNameSchema.array().min(1).max(64).optional()
})
export type ObsidianVaultLayoutPreviewInput = z.infer<typeof ObsidianVaultLayoutPreviewInputSchema>
export const ObsidianVaultLayoutInitializeInputSchema = z.strictObject({
  profileId: IdSchema,
  planId: IdSchema,
  expectedRevision: z.int().nonnegative(),
  confirmed: z.literal(true)
})
export type ObsidianVaultLayoutInitializeInput = z.infer<typeof ObsidianVaultLayoutInitializeInputSchema>
export const ObsidianVaultLayoutReceiptSchema = z.strictObject({
  status: z.enum(['created', 'partial']),
  profileId: IdSchema,
  createdPaths: ObsidianLayoutRelativePathSchema.array(),
  preservedPaths: ObsidianLayoutRelativePathSchema.array(),
  message: z.string().trim().min(1).max(500).refine(redactedLayoutMessage, { message: 'Layout receipts must be redacted.' })
})
export type ObsidianVaultLayoutReceipt = z.infer<typeof ObsidianVaultLayoutReceiptSchema>

export const ObsidianFrontmatterUnknownFieldSchema = z.strictObject({
  key: z.string().trim().min(1).max(200),
  raw: z.string().max(10_000)
})
export type ObsidianFrontmatterUnknownField = z.infer<typeof ObsidianFrontmatterUnknownFieldSchema>

const FrontmatterWarningSchema = z.string().trim().min(1).max(500).refine(redactedLayoutMessage, { message: 'Frontmatter warnings must be redacted.' })
const uniqueIdList = (values: readonly string[]): boolean => new Set(values).size === values.length
export const ObsidianParsedFrontmatterSchema = z.strictObject({
  present: z.boolean(),
  projectId: ProjectIdSchema.nullable(),
  kind: ObsidianLayoutKindSchema.nullable(),
  kindValid: z.boolean(),
  title: z.string().trim().max(240).nullable(),
  date: z.string().trim().max(100).nullable(),
  paperIds: PaperIdSchema.array(),
  taskIds: TaskIdSchema.array(),
  unknownFields: ObsidianFrontmatterUnknownFieldSchema.array(),
  warnings: FrontmatterWarningSchema.array()
}).superRefine((value, context) => {
  if (!uniqueIdList(value.paperIds)) context.addIssue({ code: 'custom', path: ['paperIds'], message: 'Paper IDs must be unique.' })
  if (!uniqueIdList(value.taskIds)) context.addIssue({ code: 'custom', path: ['taskIds'], message: 'Task IDs must be unique.' })
})
export type ObsidianParsedFrontmatter = z.infer<typeof ObsidianParsedFrontmatterSchema>
export const ParsedFrontmatterSchema = ObsidianParsedFrontmatterSchema
export const ObsidianFrontmatterSchema = ObsidianParsedFrontmatterSchema

export const ObsidianNoteKindSchema = ObsidianLayoutKindSchema.or(z.literal('unclassified'))
export type ObsidianNoteKind = z.infer<typeof ObsidianNoteKindSchema>
export const ObsidianFrontmatterKindSourceSchema = z.enum(['frontmatter', 'directory', 'unclassified'])
export type ObsidianFrontmatterKindSource = z.infer<typeof ObsidianFrontmatterKindSourceSchema>
export const ObsidianProjectAssociationSchema = z.enum(['frontmatter', 'directory', 'none'])
export type ObsidianProjectAssociation = z.infer<typeof ObsidianProjectAssociationSchema>
export const FrontmatterAssociationSchema = ObsidianProjectAssociationSchema
export const ObsidianNoteIndexEntrySchema = z.strictObject({
  relativePath: ObsidianLayoutMarkdownPathSchema,
  title: z.string().trim().min(1).max(240),
  kind: ObsidianNoteKindSchema,
  kindSource: ObsidianFrontmatterKindSourceSchema,
  projectId: ProjectIdSchema.nullable(),
  projectAssociation: ObsidianProjectAssociationSchema,
  paperIds: PaperIdSchema.array(),
  taskIds: TaskIdSchema.array(),
  fingerprint: z.string().trim().min(1).max(512),
  unknownFields: ObsidianFrontmatterUnknownFieldSchema.array(),
  warnings: FrontmatterWarningSchema.array()
}).superRefine((value, context) => {
  if (!uniqueIdList(value.paperIds)) context.addIssue({ code: 'custom', path: ['paperIds'], message: 'Paper IDs must be unique.' })
  if (!uniqueIdList(value.taskIds)) context.addIssue({ code: 'custom', path: ['taskIds'], message: 'Task IDs must be unique.' })
})
export type ObsidianNoteIndexEntry = z.infer<typeof ObsidianNoteIndexEntrySchema>
export const NoteIndexEntrySchema = ObsidianNoteIndexEntrySchema

export const ObsidianIndexStatusValueSchema = z.enum(['not_configured', 'ready', 'changed', 'error'])
export type ObsidianIndexStatusValue = z.infer<typeof ObsidianIndexStatusValueSchema>
export const ObsidianIndexStatusSchema = z.strictObject({
  profileId: IdSchema,
  status: ObsidianIndexStatusValueSchema,
  indexedAt: IsoInstantSchema.nullable(),
  noteCount: z.int().nonnegative().default(0),
  error: ObsidianLayoutErrorSchema.nullable().optional()
})
export type ObsidianIndexStatus = z.infer<typeof ObsidianIndexStatusSchema>
export const ObsidianIndexStatusInputSchema = z.strictObject({ profileId: IdSchema })
export type ObsidianIndexStatusInput = z.infer<typeof ObsidianIndexStatusInputSchema>

export const ZoteroCollectionSchema = z.object({
  key: ZoteroItemKeySchema,
  name: z.string().min(1),
  parentKey: ZoteroItemKeySchema.nullable(),
  itemCount: z.int().nonnegative()
})
export type ZoteroCollection = z.infer<typeof ZoteroCollectionSchema>

export const ZoteroItemSchema = z.object({
  key: ZoteroItemKeySchema,
  title: z.string().min(1),
  itemType: z.string().trim().min(1).max(100).optional(),
  creators: z.array(z.string()),
  publicationTitle: z.string(),
  year: z.int().min(0).nullable(),
  abstract: z.string(),
  doi: z.string().nullable(),
  url: z.string().nullable(),
  tags: z.array(z.string()),
  collectionKeys: z.array(ZoteroItemKeySchema),
  attachmentCount: z.int().nonnegative(),
  /** Better BibTeX citation key, when the local plugin exposes one. */
  citationKey: z.string().trim().min(1).max(200).nullable().optional(),
  locator: z.string().trim().min(1).max(4_000).nullable().optional(),
  remoteRevision: z.string().trim().min(1).max(512).nullable().optional()
})
export type ZoteroItem = z.infer<typeof ZoteroItemSchema>

/** Request a Better BibTeX pull export for an explicit Zotero selection. The
 * selection is resolved by stable item keys in Core; Renderer never talks to
 * the Better BibTeX HTTP endpoint directly. */
export const ZoteroBibtexExportInputSchema = z.strictObject({
  profileId: IdSchema,
  itemKeys: z.array(ZoteroItemKeySchema).min(1).max(500),
  projectTag: z.string().trim().max(200).nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).default([])
}).superRefine((value, context) => {
  if (new Set(value.itemKeys).size !== value.itemKeys.length) {
    context.addIssue({ code: 'custom', path: ['itemKeys'], message: 'Zotero item keys must be unique.' })
  }
})
export type ZoteroBibtexExportInput = z.infer<typeof ZoteroBibtexExportInputSchema>
export const ZoteroBibtexExportSchema = z.strictObject({
  profileId: IdSchema,
  itemKeys: z.array(ZoteroItemKeySchema).min(1),
  citationKeys: z.array(z.string().trim().min(1).max(200)),
  provider: z.literal('better-bibtex'),
  format: z.literal('bibtex'),
  content: z.string().max(5_000_000),
  generatedAt: IsoInstantSchema
})
export type ZoteroBibtexExport = z.infer<typeof ZoteroBibtexExportSchema>

export const ZoteroProbeStatusSchema = z.enum([
  'connected', 'disconnected', 'offline', 'unauthorized', 'rate_limited',
  'unavailable', 'error', 'not_configured', 'unsupported'
])
export type ZoteroProbeStatus = z.infer<typeof ZoteroProbeStatusSchema>
export const ZoteroCapabilitySchema = z.object({
  read: z.boolean(),
  write: z.boolean()
})
export type ZoteroCapability = z.infer<typeof ZoteroCapabilitySchema>
export const ZoteroCapabilityKindSchema = z.enum(['read', 'write', 'unsupported'])
export type ZoteroCapabilityKind = z.infer<typeof ZoteroCapabilityKindSchema>
/** Why a probed Zotero connection can read but not write.  The Renderer must
 * explain a read-only Local API (for example Zotero 9, which does not return
 * `Zotero-Server-ID`) instead of offering a write that always fails. */
export const ZoteroWriteBlockedReasonSchema = z.enum([
  'server-id-missing', 'credential-missing', 'probe-failed',
  // Zotero 10 local writes need a key from `/api/local/authorize`.  The
  // authorization dialog offers a one-time "Allow" and a persistent "Always
  // Allow"; only the persistent key can carry a multi-item import.
  'key-single-use', 'key-unverified', 'key-invalid', 'authorization-denied',
  'rate-limited'
])
export type ZoteroWriteBlockedReason = z.infer<typeof ZoteroWriteBlockedReasonSchema>
export const ZoteroCapabilityStatusSchema = z.strictObject({
  status: ZoteroProbeStatusSchema,
  capability: ZoteroCapabilitySchema,
  /** `null` when a write is possible; otherwise the explicit read-only cause. */
  writeBlockedReason: ZoteroWriteBlockedReasonSchema.nullable().default(null),
  checkedAt: IsoInstantSchema
})
export type ZoteroCapabilityStatus = z.infer<typeof ZoteroCapabilityStatusSchema>
export const ZoteroCapabilityOutputSchema = ZoteroCapabilityStatusSchema
export type ZoteroCapabilityOutput = ZoteroCapabilityStatus
export const ZoteroAuthorizeInputSchema = z.strictObject({ profileId: IdSchema })
export type ZoteroAuthorizeInput = z.infer<typeof ZoteroAuthorizeInputSchema>
export const ZoteroAuthorizeResultSchema = z.strictObject({ authorized: z.literal(true), remember: z.boolean() })
export type ZoteroAuthorizeResult = z.infer<typeof ZoteroAuthorizeResultSchema>
/** The authorization dialog also exposes a third button (Deny); Zotero answers
 * it with 403 + `{"denied":true}`, which must be reported as a user decision
 * rather than a transport failure. */
export const ZoteroAuthorizeDeniedSchema = z.strictObject({ denied: z.literal(true) })

export const ZoteroPageStatusSchema = z.enum([
  'connected', 'partial', 'offline', 'unauthorized', 'rate_limited', 'error', 'unsupported'
])
export type ZoteroPageStatus = z.infer<typeof ZoteroPageStatusSchema>
export const ZoteroCollectionPageInputSchema = z.strictObject({
  profileId: IdSchema,
  cursor: CursorSchema.nullable().optional()
})
export type ZoteroCollectionPageInput = z.infer<typeof ZoteroCollectionPageInputSchema>
export const ZoteroCollectionPageSchema = z.strictObject({
  items: z.array(ZoteroCollectionSchema),
  nextCursor: CursorSchema.nullable(),
  status: ZoteroPageStatusSchema
})
export type ZoteroCollectionPage = z.infer<typeof ZoteroCollectionPageSchema>
export const ZoteroCollectionTreeSchema = ZoteroCollectionPageSchema
export type ZoteroCollectionTree = ZoteroCollectionPage
export const ZoteroItemPageInputSchema = z.strictObject({
  profileId: IdSchema,
  collectionKey: ZoteroItemKeySchema.optional(),
  query: z.string().trim().max(500).optional(),
  page: PageInputSchema.optional(),
  cursor: CursorSchema.nullable().optional(),
  pageSize: z.int().min(1).max(100).optional()
}).superRefine((value, context) => {
  if (value.page !== undefined && (value.cursor !== undefined || value.pageSize !== undefined)) {
    context.addIssue({ code: 'custom', path: ['page'], message: 'Use either page or cursor/pageSize, not both.' })
  }
})
export type ZoteroItemPageInput = z.infer<typeof ZoteroItemPageInputSchema>
export const ZoteroItemPageSchema = z.strictObject({
  items: z.array(ZoteroItemSchema),
  nextCursor: CursorSchema.nullable(),
  status: ZoteroPageStatusSchema
})
export type ZoteroItemPage = z.infer<typeof ZoteroItemPageSchema>

/**
 * Zotero two-sided deletion.
 *
 * The remote half is the documented item erase route
 * (`DELETE <library>/items/<itemKey>` with `If-Unmodified-Since-Version`), so a
 * receipt may only claim a remote deletion after Zotero answered `204`/`200`.
 * The local half removes the Workbench projection only for items that are
 * confirmed gone remotely; every other outcome keeps the local records and is
 * reported per item.
 */
export const ZoteroDeleteOutcomeStatusSchema = z.enum([
  /** Zotero erased the item (`204`/`200`). */
  'deleted',
  /** Zotero answered `404`: the item is already gone, so the local projection
   * can be removed without claiming we deleted it. */
  'absent',
  /** `412`/`428`: the frozen revision no longer matches, so nothing was erased. */
  'conflict',
  /** `401`: the local key is missing or was consumed. */
  'unauthorized',
  /** `403`: the user denied the authorization prompt. */
  'forbidden',
  /** `429`: the authorization/API rate limit was hit. */
  'rate-limited',
  /** Network, timeout or an unmapped status: the remote state is unknown. */
  'unavailable'
])
export type ZoteroDeleteOutcomeStatus = z.infer<typeof ZoteroDeleteOutcomeStatusSchema>

/** What happened to the Workbench projection of the same item.  `removed` is
 * only produced after the remote library is confirmed not to hold the item. */
export const ZoteroDeleteLocalStatusSchema = z.enum(['removed', 'kept', 'no-local-record'])
export type ZoteroDeleteLocalStatus = z.infer<typeof ZoteroDeleteLocalStatusSchema>

/** One frozen delete target.  `remoteRevision` is what the preview observed and
 * what the execute call both re-checks and sends as the HTTP precondition. */
export const ZoteroDeleteTargetSchema = z.strictObject({
  itemKey: ZoteroItemKeySchema,
  remoteRevision: z.string().trim().min(1).max(512),
  /** The Workbench Paper this Zotero item is projected onto, when a local link
   * exists.  Resolved by the service at preview time, never by the Renderer. */
  paperId: IdSchema.nullable(),
  title: z.string().trim().max(500).nullable(),
  localRevision: z.int().nonnegative().nullable()
})
export type ZoteroDeleteTarget = z.infer<typeof ZoteroDeleteTargetSchema>

export const ZoteroRemoteDeletePreviewInputSchema = z.strictObject({
  profileId: IdSchema,
  itemKeys: z.array(ZoteroItemKeySchema).min(1).max(100)
})
export type ZoteroRemoteDeletePreviewInput = z.infer<typeof ZoteroRemoteDeletePreviewInputSchema>

export const ZoteroRemoteDeletePreviewSchema = z.strictObject({
  profileId: IdSchema,
  /** CAS token for the connection profile, re-checked by execute. */
  profileRevision: z.int().nonnegative(),
  /** Items whose current remote version was read successfully. */
  targets: z.array(ZoteroDeleteTargetSchema).min(1),
  /** Requested keys that could not be previewed at all, with the real reason.
   * They are never sent to execute, so a preview can never hide an item. */
  unavailable: z.array(z.strictObject({
    itemKey: ZoteroItemKeySchema,
    message: z.string().trim().min(1).max(1_000)
  })),
  /** Non-null when the connection cannot delete at all (missing key, Zotero 9,
   * one-time key, rate limit).  The Renderer must show it and keep the entry
   * visible but disabled, exactly like the write entry. */
  writeBlockedReason: ZoteroWriteBlockedReasonSchema.nullable(),
  message: z.string().trim().min(1).max(1_000)
})
export type ZoteroRemoteDeletePreview = z.infer<typeof ZoteroRemoteDeletePreviewSchema>

/** `confirmed: true` is a literal so a delete can never run unattended. */
export const ZoteroRemoteDeleteExecuteInputSchema = z.strictObject({
  profileId: IdSchema,
  expectedProfileRevision: z.int().nonnegative(),
  targets: z.array(ZoteroDeleteTargetSchema).min(1).max(100),
  confirmed: z.literal(true)
})
export type ZoteroRemoteDeleteExecuteInput = z.infer<typeof ZoteroRemoteDeleteExecuteInputSchema>

export const ZoteroRemoteDeleteItemReceiptSchema = z.strictObject({
  itemKey: ZoteroItemKeySchema,
  remote: ZoteroDeleteOutcomeStatusSchema,
  remoteVersion: z.string().trim().max(512).nullable(),
  local: ZoteroDeleteLocalStatusSchema,
  paperId: IdSchema.nullable(),
  title: z.string().trim().max(500).nullable(),
  message: z.string().trim().min(1).max(1_000),
  retryable: z.boolean()
})
export type ZoteroRemoteDeleteItemReceipt = z.infer<typeof ZoteroRemoteDeleteItemReceiptSchema>

/**
 * The receipt is required to be internally consistent: the counts have to match
 * the per-item rows, a `removed` local state has to be backed by a confirmed
 * remote deletion, and a `blocked` receipt cannot report any deletion at all.
 */
export const ZoteroRemoteDeleteReceiptSchema = z.strictObject({
  profileId: IdSchema,
  status: z.enum(['completed', 'partial', 'blocked']),
  remoteDeletedCount: z.int().nonnegative(),
  localRemovedCount: z.int().nonnegative(),
  items: z.array(ZoteroRemoteDeleteItemReceiptSchema).min(1),
  message: z.string().trim().min(1).max(1_000)
}).superRefine((value, context) => {
  const remoteDeleted = value.items.filter((item) => item.remote === 'deleted').length
  const stillRemote = value.items.filter((item) => item.remote !== 'deleted' && item.remote !== 'absent').length
  if (value.remoteDeletedCount !== remoteDeleted) {
    context.addIssue({ code: 'custom', path: ['remoteDeletedCount'], message: 'remoteDeletedCount must equal the number of items Zotero confirmed as deleted.' })
  }
  if (value.localRemovedCount !== value.items.filter((item) => item.local === 'removed').length) {
    context.addIssue({ code: 'custom', path: ['localRemovedCount'], message: 'localRemovedCount must equal the number of removed local projections.' })
  }
  for (const item of value.items) {
    if (item.local === 'removed' && item.remote !== 'deleted' && item.remote !== 'absent') {
      context.addIssue({ code: 'custom', path: ['items'], message: 'A local projection may only be removed after Zotero confirmed the item is gone.' })
    }
  }
  if (value.status === 'completed' && stillRemote > 0) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'A completed delete receipt cannot keep any item in Zotero.' })
  }
  if (value.status === 'blocked' && (value.remoteDeletedCount > 0 || value.localRemovedCount > 0)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'A blocked Zotero delete receipt must not report any deletion.' })
  }
})
export type ZoteroRemoteDeleteReceipt = z.infer<typeof ZoteroRemoteDeleteReceiptSchema>

export const ZoteroImportFormatSchema = z.enum(['ris', 'bibtex'])
export type ZoteroImportFormat = z.infer<typeof ZoteroImportFormatSchema>
export const ZoteroImportTransportSchema = z.enum(['api', 'save-file', 'mailto-draft', 'external-bridge'])
export type ZoteroImportTransport = z.infer<typeof ZoteroImportTransportSchema>
export const ZoteroDuplicateDecisionSchema = z.enum([
  'create', 'skip', 'review', 'update-candidate', 'conflict'
])
export type ZoteroDuplicateDecision = z.infer<typeof ZoteroDuplicateDecisionSchema>
export const ZoteroDuplicateMatchSchema = z.strictObject({
  kind: z.enum(['doi', 'url', 'title', 'external-id']),
  existingPaperId: PaperIdSchema,
  decision: ZoteroDuplicateDecisionSchema
})
/** What a confirmed write actually did with the frozen target collection.
 *  - `set`: the target collection key was applied (create: the new item is
 *    added to it; update: the item's membership is replaced with exactly it).
 *  - `unchanged`: nothing was sent, so an existing item keeps its current
 *    membership and a new item joins no collection.  The frozen
 *    `targetCollectionKey` was `null`; a locally cached value must never be
 *    written back silently.
 *  - `not-written`: no remote write happened (generated handoff, skip or
 *    failure), so the target collection is only recorded, not applied. */
export const ZoteroCollectionWriteSchema = z.enum(['set', 'unchanged', 'not-written'])
export type ZoteroCollectionWrite = z.infer<typeof ZoteroCollectionWriteSchema>
export type ZoteroDuplicateMatch = z.infer<typeof ZoteroDuplicateMatchSchema>
export const ZoteroImportPreviewItemSchema = z.strictObject({
  itemKey: ZoteroItemKeySchema,
  paperId: PaperIdSchema.nullable(),
  decision: ZoteroDuplicateDecisionSchema,
  duplicate: ZoteroDuplicateMatchSchema.nullable(),
  locator: z.string().trim().min(1).max(4_000).nullable(),
  remoteRevision: z.string().trim().min(1).max(512).nullable().optional(),
  /** Human-readable explanation of an ambiguous decision (for example a
   *  title-only match in Zotero or a library too large to check for
   *  duplicates).  Never contains a path, URL or credential. */
  note: z.string().trim().min(1).max(300).nullable().default(null)
})
export type ZoteroImportPreviewItem = z.infer<typeof ZoteroImportPreviewItemSchema>
export const ZoteroImportPreviewInputSchema = z.strictObject({
  profileId: IdSchema,
  // Importing local Papers into Zotero uses `paperIds` and intentionally has
  // no remote item keys. Importing from Zotero uses `itemKeys` instead.
  itemKeys: z.array(ZoteroItemKeySchema).max(500),
  paperIds: z.array(PaperIdSchema).max(500).default([]),
  targetCollectionKey: ZoteroItemKeySchema.nullable().default(null),
  format: ZoteroImportFormatSchema.default('ris'),
  transport: ZoteroImportTransportSchema.optional(),
  /**
   * Optional local project binding for the Zotero -> Workbench direction.
   * Keeping it in the one-use preview makes the confirmed import auditable
   * and ensures the automatic `#project`/`#未分类` tag is deterministic.
   */
  projectId: ProjectIdSchema.nullable().default(null),
  /** Additional user tags carried by the explicit import preview. */
  tags: z.array(z.string().trim().min(1).max(100)).max(20).default([])
}).superRefine((value, context) => {
  if (new Set(value.itemKeys).size !== value.itemKeys.length) {
    context.addIssue({ code: 'custom', path: ['itemKeys'], message: 'Zotero item keys must be unique.' })
  }
  if (value.itemKeys.length === 0 && value.paperIds.length === 0) {
    context.addIssue({ code: 'custom', path: ['itemKeys'], message: 'Select at least one Zotero item or local paper.' })
  }
  if (value.itemKeys.length > 0 && value.paperIds.length > 0) {
    context.addIssue({ code: 'custom', path: ['paperIds'], message: 'Choose either Zotero items or local papers, not both.' })
  }
})
export type ZoteroImportPreviewInput = z.infer<typeof ZoteroImportPreviewInputSchema>
/** Proposal-compatible names for the explicit Zotero selection command. */
export const ZoteroImportSelectedPreviewInputSchema = ZoteroImportPreviewInputSchema
export type ZoteroImportSelectedPreviewInput = ZoteroImportPreviewInput
export const ZoteroImportPreviewSchema = z.strictObject({
  previewId: IdSchema,
  profileId: IdSchema,
  targetCollectionKey: ZoteroItemKeySchema.nullable(),
  format: ZoteroImportFormatSchema,
  transport: ZoteroImportTransportSchema,
  capability: ZoteroCapabilityKindSchema,
  /** Revision of the integration profile the preview was frozen against.  A
   * confirmed execution re-checks it so a connection edit cannot be applied
   * under an old confirmation. */
  profileRevision: z.int().nonnegative(),
  items: z.array(ZoteroImportPreviewItemSchema),
  total: z.int().nonnegative(),
  requiresConfirmation: z.literal(true)
})
export type ZoteroImportPreview = z.infer<typeof ZoteroImportPreviewSchema>
export const ZoteroImportSelectedPreviewSchema = ZoteroImportPreviewSchema
export type ZoteroImportSelectedPreview = ZoteroImportPreview
export const ZoteroImportExecuteInputSchema = z.strictObject({
  previewId: IdSchema,
  confirmed: z.literal(true),
  confirmationToken: z.string().trim().min(1).max(512)
})
export type ZoteroImportExecuteInput = z.infer<typeof ZoteroImportExecuteInputSchema>
export const ZoteroImportSelectedExecuteInputSchema = ZoteroImportExecuteInputSchema
export type ZoteroImportSelectedExecuteInput = ZoteroImportExecuteInput
export const ZoteroImportReceiptSchema = z.strictObject({
  profileId: IdSchema,
  itemKey: ZoteroItemKeySchema,
  paperId: PaperIdSchema.nullable(),
  outcome: z.enum(['written', 'generated', 'skipped', 'failed', 'unsupported']),
  transport: ZoteroImportTransportSchema,
  format: ZoteroImportFormatSchema,
  locator: z.string().trim().min(1).max(4_000).nullable(),
  remoteRevision: z.string().trim().min(1).max(512).nullable(),
  duplicateDecision: ZoteroDuplicateDecisionSchema.nullable(),
  /** The collection frozen by the preview and the actual outcome for it. */
  targetCollectionKey: ZoteroItemKeySchema.nullable().default(null),
  collectionWrite: ZoteroCollectionWriteSchema.default('not-written'),
  error: z.union([
    z.lazy(() => IntegrationErrorSchema),
    z.object({
      code: z.string().min(1),
      message: z.string().trim().min(1).max(500).refine((value) => !/([A-Za-z]:[\\/]|\\\\|Bearer\s|token=|api[_-]?key)/i.test(value), {
        message: 'Operation error messages must be redacted.'
      }),
      retryable: z.boolean()
    }),
    z.lazy(() => ExternalWriteErrorSchema)
  ]).nullable()
})
export type ZoteroImportReceipt = z.infer<typeof ZoteroImportReceiptSchema>

/**
 * A transient, user-downloadable handoff generated when the target Zotero
 * instance is read-only (for example Zotero 9's Local API).  The content is
 * deliberately returned through the explicit preview/execute response rather
 * than persisted in SQLite; it contains bibliographic metadata only and no
 * attachment bytes or local filesystem paths.
 */
export const ZoteroHandoffSchema = z.strictObject({
  format: ZoteroImportFormatSchema,
  fileName: z.string().trim().min(1).max(180).regex(/^[A-Za-z0-9._-]+$/u),
  content: z.string().max(5_000_000),
  targetCollectionKey: ZoteroItemKeySchema.nullable(),
  itemCount: z.int().positive()
})
export type ZoteroHandoff = z.infer<typeof ZoteroHandoffSchema>

export const ZoteroImportResultSchema = z.strictObject({
  items: z.array(ZoteroImportReceiptSchema),
  succeeded: z.int().nonnegative(),
  skipped: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  canceled: z.boolean(),
  /** Present only when one or more local Papers were generated for manual
   * import because the Zotero API could not safely write them. */
  handoff: ZoteroHandoffSchema.nullable().default(null)
}).superRefine((value, context) => {
  const counts = value.items.reduce((result, item) => {
    if (item.outcome === 'written' || item.outcome === 'generated') result.succeeded += 1
    else if (item.outcome === 'skipped' || item.outcome === 'unsupported') result.skipped += 1
    else result.failed += 1
    return result
  }, { succeeded: 0, skipped: 0, failed: 0 })
  if (counts.succeeded !== value.succeeded) context.addIssue({ code: 'custom', path: ['succeeded'], message: 'Succeeded count must match item outcomes.' })
  if (counts.skipped !== value.skipped) context.addIssue({ code: 'custom', path: ['skipped'], message: 'Skipped count must match item outcomes.' })
  if (counts.failed !== value.failed) context.addIssue({ code: 'custom', path: ['failed'], message: 'Failed count must match item outcomes.' })
})
export type ZoteroImportResult = z.infer<typeof ZoteroImportResultSchema>
export const ZoteroImportSelectedResultSchema = ZoteroImportResultSchema
export type ZoteroImportSelectedResult = ZoteroImportResult

/** Explicit Paper -> Zotero write/fallback operation. It is separate from
 * local Paper persistence and always requires a preview/confirmation pair. */
export const PaperToZoteroPreviewInputSchema = z.strictObject({
  profileId: IdSchema,
  paperIds: z.array(PaperIdSchema).min(1).max(500),
  targetCollectionKey: ZoteroItemKeySchema.nullable().default(null),
  format: ZoteroImportFormatSchema.default('ris'),
  /**
   * Top-level project classification for this write.
   *
   * - omitted: every Paper keeps its own project binding (unchanged legacy
   *   behaviour for the Paper -> Zotero route);
   * - `null`: the write is explicitly classified as unclassified (未分类);
   * - a project id: every written item is tagged with exactly `#<项目名>`.
   *
   * The value is frozen by the preview and re-checked by execution, so the
   * project tag is never re-derived from a later UI selection.
   */
  projectId: ProjectIdSchema.nullable().optional(),
  /** Additional Zotero tags applied to every selected Paper after the
   * project binding tag has been resolved in Core. */
  tags: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  transport: ZoteroImportTransportSchema.optional()
})
export type PaperToZoteroPreviewInput = z.infer<typeof PaperToZoteroPreviewInputSchema>
export const PaperToZoteroExecuteInputSchema = ZoteroImportExecuteInputSchema
export type PaperToZoteroExecuteInput = z.infer<typeof PaperToZoteroExecuteInputSchema>
export const PaperToZoteroPreviewSchema = ZoteroImportPreviewSchema.extend({
  paperIds: z.array(PaperIdSchema),
  itemKeys: z.array(ZoteroItemKeySchema)
})
export type PaperToZoteroPreview = z.infer<typeof PaperToZoteroPreviewSchema>
export const PaperToZoteroReceiptSchema = ZoteroImportReceiptSchema
export type PaperToZoteroReceipt = z.infer<typeof PaperToZoteroReceiptSchema>

/** Explicit Search-staging -> Zotero flow.  It is kept separate from the
 * generic Paper and Zotero selection routes so a staging record can be
 * persisted, reviewed and removed independently of the SearchSession cache. */
export const LiteratureStagingToZoteroPreviewInputSchema = z.strictObject({
  profileId: IdSchema,
  stagingIds: z.array(IdSchema).min(1).max(500),
  targetCollectionKey: ZoteroItemKeySchema.nullable().default(null),
  format: ZoteroImportFormatSchema.default('ris'),
  /**
   * Top-level project classification for the whole staging write.
   *
   * - omitted: derive it from the selected records (their shared project
   *   binding, or 未分类 when they differ);
   * - `null`: explicitly classify the write as 未分类;
   * - a project id: every written item is tagged with exactly `#<项目名>`.
   *
   * The resolved value is frozen by the preview and repeated in every receipt
   * so the confirm step can never silently apply a different project tag.
   */
  projectId: ProjectIdSchema.nullable().optional(),
  /** User-entered tags are carried through the one-use preview so the
   * confirmed external write is reproducible and auditable. */
  tags: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  transport: ZoteroImportTransportSchema.optional()
}).superRefine((value, context) => {
  if (new Set(value.stagingIds).size !== value.stagingIds.length) {
    context.addIssue({ code: 'custom', path: ['stagingIds'], message: 'Staging IDs must be unique.' })
  }
})
export type LiteratureStagingToZoteroPreviewInput = z.infer<typeof LiteratureStagingToZoteroPreviewInputSchema>
export const LiteratureStagingToZoteroPreviewItemSchema = z.strictObject({
  stagingId: IdSchema,
  paperId: PaperIdSchema.nullable(),
  itemKey: ZoteroItemKeySchema.nullable(),
  decision: ZoteroDuplicateDecisionSchema,
  duplicate: ZoteroDuplicateMatchSchema.nullable(),
  locator: z.string().trim().min(1).max(4_000).nullable(),
  remoteRevision: z.string().trim().min(1).max(512).nullable().optional(),
  note: z.string().trim().min(1).max(300).nullable().default(null)
})
export type LiteratureStagingToZoteroPreviewItem = z.infer<typeof LiteratureStagingToZoteroPreviewItemSchema>
export const LiteratureStagingToZoteroPreviewSchema = z.strictObject({
  previewId: IdSchema,
  profileId: IdSchema,
  stagingIds: z.array(IdSchema).min(1),
  targetCollectionKey: ZoteroItemKeySchema.nullable(),
  format: ZoteroImportFormatSchema,
  transport: ZoteroImportTransportSchema,
  capability: ZoteroCapabilityKindSchema,
  /** Top-level project classification frozen by the preview.  `null` means the
   * whole write is classified as 未分类; the confirm step may change it only by
   * regenerating the preview. */
  projectId: ProjectIdSchema.nullable().default(null),
  /** Exact Zotero tag (stored without the presentation `#`) every item in this
   * frozen write receives, resolved from `projectId` at preview time. */
  projectTag: z.string().trim().min(1).max(100).nullable().default(null),
  /** Profile revision frozen by the preview; re-checked on execution. */
  profileRevision: z.int().nonnegative(),
  items: z.array(LiteratureStagingToZoteroPreviewItemSchema),
  total: z.int().nonnegative(),
  requiresConfirmation: z.literal(true)
})
export type LiteratureStagingToZoteroPreview = z.infer<typeof LiteratureStagingToZoteroPreviewSchema>
export const LiteratureStagingToZoteroExecuteInputSchema = ZoteroImportExecuteInputSchema
export type LiteratureStagingToZoteroExecuteInput = z.infer<typeof LiteratureStagingToZoteroExecuteInputSchema>
export const LiteratureStagingToZoteroReceiptSchema = z.strictObject({
  stagingId: IdSchema,
  profileId: IdSchema,
  paperId: PaperIdSchema.nullable(),
  itemKey: ZoteroItemKeySchema.nullable(),
  outcome: z.enum(['written', 'generated', 'skipped', 'failed', 'unsupported']),
  transport: ZoteroImportTransportSchema,
  format: ZoteroImportFormatSchema,
  locator: z.string().trim().min(1).max(4_000).nullable(),
  remoteRevision: z.string().trim().min(1).max(512).nullable(),
  duplicateDecision: ZoteroDuplicateDecisionSchema.nullable(),
  targetCollectionKey: ZoteroItemKeySchema.nullable().default(null),
  collectionWrite: ZoteroCollectionWriteSchema.default('not-written'),
  /** Top-level project classification frozen by the consumed preview. */
  projectId: ProjectIdSchema.nullable().default(null),
  /** Exact Zotero tag (without the presentation `#`) this receipt applied for
   * the frozen classification, repeated so the receipt is self-describing. */
  projectTag: z.string().trim().min(1).max(100).nullable().default(null),
  error: z.union([
    z.lazy(() => IntegrationErrorSchema),
    z.lazy(() => ExternalWriteErrorSchema)
  ]).nullable()
})
export type LiteratureStagingToZoteroReceipt = z.infer<typeof LiteratureStagingToZoteroReceiptSchema>
export const LiteratureStagingToZoteroResultSchema = z.strictObject({
  items: z.array(LiteratureStagingToZoteroReceiptSchema),
  succeeded: z.int().nonnegative(),
  skipped: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  canceled: z.boolean(),
  handoff: ZoteroHandoffSchema.nullable().default(null)
}).superRefine((value, context) => {
  const counts = value.items.reduce((result, item) => {
    if (item.outcome === 'written' || item.outcome === 'generated') result.succeeded += 1
    else if (item.outcome === 'skipped' || item.outcome === 'unsupported') result.skipped += 1
    else result.failed += 1
    return result
  }, { succeeded: 0, skipped: 0, failed: 0 })
  if (counts.succeeded !== value.succeeded) context.addIssue({ code: 'custom', path: ['succeeded'], message: 'Succeeded count must match item outcomes.' })
  if (counts.skipped !== value.skipped) context.addIssue({ code: 'custom', path: ['skipped'], message: 'Skipped count must match item outcomes.' })
  if (counts.failed !== value.failed) context.addIssue({ code: 'custom', path: ['failed'], message: 'Failed count must match item outcomes.' })
})
export type LiteratureStagingToZoteroResult = z.infer<typeof LiteratureStagingToZoteroResultSchema>

export const ScholarAllowedHostSchema = z.enum(['scholar.google.com', 'scholar.googleusercontent.com'])
export type ScholarAllowedHost = z.infer<typeof ScholarAllowedHostSchema>
export const ScholarWorkspaceModeSchema = z.enum(['embedded', 'external-browser', 'unavailable'])
export type ScholarWorkspaceMode = z.infer<typeof ScholarWorkspaceModeSchema>
export const ScholarWorkspaceStatusSchema = z.strictObject({
  provider: z.literal('google_scholar'),
  mode: ScholarWorkspaceModeSchema,
  status: z.enum(['ready', 'blocked', 'unsupported']),
  readOnly: z.literal(true),
  allowedHosts: z.array(ScholarAllowedHostSchema).min(1),
  fallback: z.enum(['system-browser', 'none']),
  message: z.string().trim().min(1).max(500)
})
export type ScholarWorkspaceStatus = z.infer<typeof ScholarWorkspaceStatusSchema>
export const ScholarStatusInputSchema = z.null()
export type ScholarStatusInput = z.infer<typeof ScholarStatusInputSchema>

export const ResourceKindSchema = z.enum(['project', 'task', 'paper', 'note', 'calendar-event', 'artifact'])
export type ResourceKind = z.infer<typeof ResourceKindSchema>
export const ResourceRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project'), id: ProjectIdSchema }),
  z.object({ kind: z.literal('task'), id: TaskIdSchema }),
  z.object({ kind: z.literal('paper'), id: PaperIdSchema }),
  z.object({ kind: z.literal('note'), id: IdSchema }),
  z.object({ kind: z.literal('calendar-event'), id: IdSchema }),
  z.object({ kind: z.literal('artifact'), id: IdSchema })
])
export type ResourceRef = z.infer<typeof ResourceRefSchema>
export const ResourceRelationshipSchema = z.enum(['contains', 'references', 'derived-from', 'related-to', 'attached-to'])
export type ResourceRelationship = z.infer<typeof ResourceRelationshipSchema>
export const WorkspaceActorSchema = z.enum(['user', 'mcp', 'scheduler', 'agent'])
export type WorkspaceActor = z.infer<typeof WorkspaceActorSchema>

export const ResourceLinkSchema = z.object({
  id: IdSchema,
  from: ResourceRefSchema,
  to: ResourceRefSchema,
  relationship: ResourceRelationshipSchema,
  createdBy: WorkspaceActorSchema,
  createdAt: IsoInstantSchema
})
export type ResourceLink = z.infer<typeof ResourceLinkSchema>
export const CreateResourceLinkInputSchema = ResourceLinkSchema.omit({ id: true, createdAt: true })
export type CreateResourceLinkInput = z.infer<typeof CreateResourceLinkInputSchema>
export const ResourceLinkListInputSchema = z.object({ resource: ResourceRefSchema.optional() })
export type ResourceLinkListInput = z.infer<typeof ResourceLinkListInputSchema>
export const RemoveResourceLinkInputSchema = z.object({ id: IdSchema })
export type RemoveResourceLinkInput = z.infer<typeof RemoveResourceLinkInputSchema>

export const WorkspaceRouteSchema = z.enum(['dashboard', 'calendar', 'tasks', 'project', 'literature', 'obsidian', 'zotero', 'agent', 'automation', 'settings'])
export type WorkspaceRoute = z.infer<typeof WorkspaceRouteSchema>
export const WorkspaceTabContextSchema = z.object({
  projectId: ProjectIdSchema.nullable(),
  resource: ResourceRefSchema.nullable()
})
export const WorkspaceTabSchema = z.object({
  tabId: IdSchema,
  route: WorkspaceRouteSchema,
  context: WorkspaceTabContextSchema,
  title: z.string().trim().min(1).max(240),
  pinned: z.boolean(),
  createdAt: IsoInstantSchema
})
export type WorkspaceTab = z.infer<typeof WorkspaceTabSchema>
export const WorkspaceTabStateSchema = z.object({ version: z.literal(1), tabs: z.array(WorkspaceTabSchema) }).superRefine((value, context) => {
  const ids = value.tabs.map((tab) => tab.tabId)
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['tabs'], message: 'Workspace tab IDs must be unique.' })
})
export type WorkspaceTabState = z.infer<typeof WorkspaceTabStateSchema>

export const ContextCapabilitySchema = z.enum([
  'open', 'open-new-tab', 'copy-id', 'edit', 'move', 'associate', 'archive', 'restore',
  'hard-delete', 'refresh', 'set-filter', 'set-import-target', 'delete'
])
export type ContextCapability = z.infer<typeof ContextCapabilitySchema>
const ContextMenuTargetBaseSchema = z.object({ id: IdSchema, capabilities: z.array(ContextCapabilitySchema).superRefine((values, context) => {
  if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', message: 'Capabilities must be unique.' })
}) })
export const ContextMenuTargetSchema = z.discriminatedUnion('type', [
  ContextMenuTargetBaseSchema.extend({ type: z.literal('tab') }),
  ContextMenuTargetBaseSchema.extend({ type: z.literal('project') }),
  ContextMenuTargetBaseSchema.extend({ type: z.literal('task') }),
  ContextMenuTargetBaseSchema.extend({ type: z.literal('paper') }),
  ContextMenuTargetBaseSchema.extend({ type: z.literal('note') }),
  ContextMenuTargetBaseSchema.extend({ type: z.literal('calendar-event') }),
  ContextMenuTargetBaseSchema.extend({ type: z.literal('zotero-collection') }),
  ContextMenuTargetBaseSchema.extend({ type: z.literal('zotero-item') }),
  ContextMenuTargetBaseSchema.extend({ type: z.literal('resource') })
])
export type ContextMenuTarget = z.infer<typeof ContextMenuTargetSchema>

export const SelectionKeySchema = z.object({ source: z.string().trim().min(1).max(100), sourceId: IdSchema })
export type SelectionKey = z.infer<typeof SelectionKeySchema>
const uniqueKeys = (values: SelectionKey[]): boolean => {
  const keys = values.map((value) => `${value.source}\u0000${value.sourceId}`)
  return new Set(keys).size === keys.length
}
export const BulkSelectionModeSchema = z.enum(['none', 'page', 'all-results', 'explicit'])
export type BulkSelectionMode = z.infer<typeof BulkSelectionModeSchema>
export const BulkSelectionScopeSchema = z.enum(['tasks', 'papers', 'search-results'])
export type BulkSelectionScope = z.infer<typeof BulkSelectionScopeSchema>
export const BulkSelectionSchema = z.object({
  mode: BulkSelectionModeSchema,
  scope: BulkSelectionScopeSchema,
  selectedKeys: z.array(SelectionKeySchema),
  excludedKeys: z.array(SelectionKeySchema),
  sessionId: IdSchema.nullable(),
  queryFingerprint: z.string().trim().min(1).max(512).nullable()
}).superRefine((value, context) => {
  if (!uniqueKeys(value.selectedKeys)) context.addIssue({ code: 'custom', path: ['selectedKeys'], message: 'Selection keys must be unique.' })
  if (!uniqueKeys(value.excludedKeys)) context.addIssue({ code: 'custom', path: ['excludedKeys'], message: 'Excluded keys must be unique.' })
  if (value.mode === 'none' && (value.selectedKeys.length > 0 || value.excludedKeys.length > 0)) {
    context.addIssue({ code: 'custom', message: 'none selection cannot contain selected or excluded keys.' })
  }
  if (value.mode === 'all-results' && (value.sessionId === null || value.queryFingerprint === null)) {
    context.addIssue({ code: 'custom', message: 'all-results selection requires sessionId and queryFingerprint.' })
  }
})
export type BulkSelection = z.infer<typeof BulkSelectionSchema>

export const BulkItemOutcomeSchema = z.object({
  key: SelectionKeySchema,
  outcome: z.enum(['succeeded', 'skipped', 'failed']),
  error: z.object({ code: z.string().min(1), message: z.string().min(1), retryable: z.boolean() }).nullable()
})
export type BulkItemOutcome = z.infer<typeof BulkItemOutcomeSchema>
export const BulkOperationResultSchema = z.object({
  items: z.array(BulkItemOutcomeSchema),
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
export type BulkOperationResult = z.infer<typeof BulkOperationResultSchema>

export const ConfirmationContextSchema = z.object({
  confirmationId: IdSchema,
  operation: z.enum(['task.hardDelete', 'tasks.bulkHardDelete']),
  issuedAt: IsoInstantSchema,
  expiresAt: IsoInstantSchema
}).superRefine((value, context) => {
  if (Date.parse(value.issuedAt) >= Date.parse(value.expiresAt)) context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Confirmation must expire after it is issued.' })
})
export type ConfirmationContext = z.infer<typeof ConfirmationContextSchema>
export const HardDeleteTaskInputSchema = z.object({
  id: TaskIdSchema,
  expectedRevision: z.int().nonnegative(),
  confirmed: z.literal(true),
  confirmationContext: ConfirmationContextSchema
}).superRefine((value, context) => {
  if (value.confirmationContext.operation !== 'task.hardDelete') context.addIssue({ code: 'custom', path: ['confirmationContext', 'operation'], message: 'Confirmation operation must match task.hardDelete.' })
})
export type HardDeleteTaskInput = z.infer<typeof HardDeleteTaskInputSchema>
export const HardDeleteTaskResultSchema = z.object({
  id: TaskIdSchema,
  deletedAt: IsoInstantSchema,
  auditEventId: IdSchema,
  externalResourcesUntouched: z.literal(true)
})
export type HardDeleteTaskResult = z.infer<typeof HardDeleteTaskResultSchema>
export const BulkTaskExpectedRevisionSchema = z.object({
  id: TaskIdSchema,
  expectedRevision: z.int().nonnegative()
})
const uniqueTaskRevisionLocks = (values: Array<z.infer<typeof BulkTaskExpectedRevisionSchema>>): boolean =>
  new Set(values.map((value) => value.id)).size === values.length
export const BulkTaskCommandInputSchema = z.object({
  selection: BulkSelectionSchema,
  expectedRevisions: z.array(BulkTaskExpectedRevisionSchema).min(1)
}).superRefine((value, context) => {
  if (!uniqueTaskRevisionLocks(value.expectedRevisions)) context.addIssue({ code: 'custom', path: ['expectedRevisions'], message: 'Task revision locks must be unique.' })
})
export const BulkHardDeleteTaskInputSchema = z.object({
  selection: BulkSelectionSchema,
  expectedRevisions: z.array(BulkTaskExpectedRevisionSchema).min(1),
  confirmed: z.literal(true),
  confirmationContext: ConfirmationContextSchema
}).superRefine((value, context) => {
  if (!uniqueTaskRevisionLocks(value.expectedRevisions)) context.addIssue({ code: 'custom', path: ['expectedRevisions'], message: 'Task revision locks must be unique.' })
  if (value.confirmationContext.operation !== 'tasks.bulkHardDelete') context.addIssue({ code: 'custom', path: ['confirmationContext', 'operation'], message: 'Confirmation operation must match tasks.bulkHardDelete.' })
})
export type BulkTaskCommandInput = z.infer<typeof BulkTaskCommandInputSchema>
export type BulkHardDeleteTaskInput = z.infer<typeof BulkHardDeleteTaskInputSchema>

export const ExternalWriteErrorCodeSchema = z.enum([
  'EXTERNAL_NOT_CONFIGURED', 'EXTERNAL_UNAVAILABLE', 'EXTERNAL_UNAUTHORIZED',
  'EXTERNAL_RATE_LIMITED', 'EXTERNAL_CONFLICT', 'EXTERNAL_UNSUPPORTED',
  'EXTERNAL_VALIDATION', 'EXTERNAL_IO'
])
export type ExternalWriteErrorCode = z.infer<typeof ExternalWriteErrorCodeSchema>
export const ExternalWriteErrorSchema = z.strictObject({
  code: ExternalWriteErrorCodeSchema,
  provider: z.enum(['obsidian', 'zotero', 'notion']),
  entityKind: z.enum(['project', 'task', 'paper', 'note', 'calendar-event']),
  entityId: IdSchema,
  externalId: z.string().trim().min(1).max(4_000).nullable(),
  remoteRevision: z.string().trim().min(1).max(512).nullable(),
  retryable: z.boolean(),
  requiresConfirmation: z.boolean(),
  partial: z.boolean(),
  message: z.string().trim().min(1).max(500).refine((value) => !/([A-Za-z]:[\\/]|\\\\|Bearer\s|token=|api[_-]?key)/i.test(value), {
    message: 'External write error messages must be redacted.'
  })
})
export type ExternalWriteError = z.infer<typeof ExternalWriteErrorSchema>

/**
 * Redacted, field-addressable failures at an integration boundary.  The
 * `kind` identifies whether the failure came from caller input/Zod parsing or
 * from validating a remote response; `fields` preserves each Zod-style path
 * without exposing raw credentials, paths, response bodies or tokens.
 */
export const IntegrationErrorKindSchema = z.enum(['zod', 'input', 'remote-response'])
export type IntegrationErrorKind = z.infer<typeof IntegrationErrorKindSchema>
export const IntegrationErrorFieldSchema = z.strictObject({
  path: z.array(z.union([z.string().trim().min(1), z.int().nonnegative()])),
  code: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(500).refine((value) => !/([A-Za-z]:[\\/]|\\\\|Bearer\s|token=|api[_-]?key)/i.test(value), {
    message: 'Integration error messages must be redacted.'
  })
})
export type IntegrationErrorField = z.infer<typeof IntegrationErrorFieldSchema>
export const IntegrationErrorIssueSchema = IntegrationErrorFieldSchema
export type IntegrationErrorIssue = IntegrationErrorField
export const IntegrationErrorProviderSchema = z.enum([
  'obsidian', 'zotero', 'notion',
  'literature', 'local', 'crossref', 'openalex', 'pubmed', 'arxiv', 'semantic_scholar', 'google_scholar'
])
export type IntegrationErrorProvider = z.infer<typeof IntegrationErrorProviderSchema>
export const IntegrationErrorSchema = z.strictObject({
  code: z.enum([
    'INTEGRATION_INPUT_INVALID',
    'INTEGRATION_ZOD_INVALID',
    'INTEGRATION_REMOTE_RESPONSE_INVALID',
    'INTEGRATION_VALIDATION_FAILED'
  ]),
  provider: IntegrationErrorProviderSchema.nullable(),
  operation: z.string().trim().min(1).max(200),
  kind: IntegrationErrorKindSchema,
  fields: z.array(IntegrationErrorFieldSchema).min(1).max(100),
  retryable: z.boolean(),
  message: z.string().trim().min(1).max(500).refine((value) => !/([A-Za-z]:[\\/]|\\\\|Bearer\s|token=|api[_-]?key)/i.test(value), {
    message: 'Integration error messages must be redacted.'
  })
})
export type IntegrationError = z.infer<typeof IntegrationErrorSchema>
/** Descriptive alias for consumers that call this an error envelope. */
export const IntegrationErrorEnvelopeSchema = IntegrationErrorSchema
export type IntegrationErrorEnvelope = IntegrationError
export const ConfirmationErrorSchema = z.object({
  code: z.enum(['CONFIRMATION_REQUIRED', 'CONFIRMATION_INVALID']),
  operation: z.string().min(1),
  message: z.string().min(1),
  retryable: z.literal(false)
})
export const PermissionErrorSchema = z.object({
  code: z.literal('PERMISSION_DENIED'),
  operation: z.string().min(1),
  message: z.string().min(1),
  retryable: z.literal(false)
})

export const WorkspaceServiceStatusSchema = z.object({
  status: z.enum(['ready', 'starting', 'degraded', 'stopped']),
  version: z.string(),
  database: z.enum(['ready', 'error']),
  connectors: z.record(z.string(), z.enum(['connected', 'disconnected', 'not_configured', 'error'])),
  mcp: z.enum(['connected', 'disabled', 'not_configured'])
})
export type WorkspaceServiceStatus = z.infer<typeof WorkspaceServiceStatusSchema>

/**
 * Knowledge engines are optional, user-managed services.  Their public
 * configuration is persisted in the authoritative workspace database while
 * API keys remain in Main's safeStorage credential vault.  HTTP is accepted
 * only for loopback services; remote endpoints must use HTTPS.
 */
export const KnowledgeEngineKindSchema = z.enum(['anythingllm', 'llmwiki'])
export type KnowledgeEngineKind = z.infer<typeof KnowledgeEngineKindSchema>
export const KnowledgeEngineStatusSchema = z.enum(['connected', 'disconnected', 'not_configured', 'error'])
export type KnowledgeEngineStatus = z.infer<typeof KnowledgeEngineStatusSchema>

const KnowledgeEngineUrlSchema = z.string().trim().max(2_000).refine((value) => {
  if (value === '') return true
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) return false
    const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLocaleLowerCase('en-US'))
    return loopback ? ['http:', 'https:'].includes(url.protocol) : url.protocol === 'https:'
  } catch {
    return false
  }
}, { message: '知识引擎地址必须是 HTTPS，或 localhost/127.0.0.1 回环地址。' })

export const KnowledgeEngineConfigSchema = z.strictObject({
  kind: KnowledgeEngineKindSchema,
  enabled: z.boolean(),
  baseUrl: KnowledgeEngineUrlSchema,
  workspace: z.string().trim().max(240),
  collection: z.string().trim().max(240),
  credentialPresent: z.boolean(),
  status: KnowledgeEngineStatusSchema,
  lastCheckedAt: IsoInstantSchema.nullable(),
  lastError: z.string().trim().max(500).nullable(),
  updatedAt: IsoInstantSchema,
  revision: z.int().nonnegative()
})
export type KnowledgeEngineConfig = z.infer<typeof KnowledgeEngineConfigSchema>

export const KnowledgeEngineSaveInputSchema = z.strictObject({
  kind: KnowledgeEngineKindSchema,
  enabled: z.boolean().default(true),
  baseUrl: KnowledgeEngineUrlSchema.default(''),
  workspace: z.string().trim().max(240).default(''),
  collection: z.string().trim().max(240).default(''),
  /** Main strips this field before the request reaches Core. */
  credential: z.string().max(20_000).optional(),
  expectedRevision: z.int().nonnegative().nullable().default(null)
})
export type KnowledgeEngineSaveInput = z.infer<typeof KnowledgeEngineSaveInputSchema>
export const KnowledgeEngineTestInputSchema = z.strictObject({ kind: KnowledgeEngineKindSchema })
export type KnowledgeEngineTestInput = z.infer<typeof KnowledgeEngineTestInputSchema>
export const KnowledgeEngineTestResultSchema = z.strictObject({
  kind: KnowledgeEngineKindSchema,
  ok: z.boolean(),
  status: KnowledgeEngineStatusSchema,
  message: z.string().trim().min(1).max(500),
  checkedAt: IsoInstantSchema
})
export type KnowledgeEngineTestResult = z.infer<typeof KnowledgeEngineTestResultSchema>

export const WorkspaceToolRiskSchema = z.enum(['read', 'write', 'sensitive'])
export type WorkspaceToolRisk = z.infer<typeof WorkspaceToolRiskSchema>

/**
 * Main-process folder picker contract. The renderer can request a native
 * folder selection without receiving unrestricted dialog or filesystem
 * access. A cancelled picker is represented by a nullable result.
 */
export const SystemSelectFolderInputSchema = z.null()
export type SystemSelectFolderInput = z.infer<typeof SystemSelectFolderInputSchema>
export const SystemSelectFolderResultSchema = z.string().nullable()
export type SystemSelectFolderResult = z.infer<typeof SystemSelectFolderResultSchema>
export const SystemRevealPathInputSchema = z.strictObject({
  vaultId: IdSchema,
  relativePath: ObsidianLayoutRelativePathSchema
})
export type SystemRevealPathInput = z.infer<typeof SystemRevealPathInputSchema>

/**
 * Main-process export handoff. Renderer may request a generated text artifact
 * to be saved into the user's Downloads directory, but it never receives
 * unrestricted filesystem or dialog access. The filename is deliberately a
 * single safe component and the content limit matches transient Zotero
 * handoffs.
 */
export const SystemSaveTextFileInputSchema = z.strictObject({
  fileName: z.string().trim().min(1).max(180).regex(/^[A-Za-z0-9._-]+$/u),
  content: z.string().max(5_000_000),
  mimeType: z.string().trim().min(1).max(120).default('text/plain;charset=utf-8')
})
export type SystemSaveTextFileInput = z.infer<typeof SystemSaveTextFileInputSchema>
export const SystemSaveTextFileResultSchema = z.strictObject({
  saved: z.boolean(),
  fileName: z.string().trim().min(1).max(180),
  location: z.literal('downloads')
})
export type SystemSaveTextFileResult = z.infer<typeof SystemSaveTextFileResultSchema>

/** Public V2 method allow-list. AI/provider/prompt/agent/schedule/job routes
 * are intentionally absent; their legacy tables and DTOs remain migratable. */
export const WorkspaceApiV2Methods = [
  'projects.list', 'projects.create', 'projects.update', 'projects.archive',
  'boards.columns',
  'tasks.list', 'tasks.create', 'tasks.update', 'tasks.move', 'tasks.archive', 'tasks.restore', 'tasks.hardDelete',
  'tasks.bulkArchive', 'tasks.bulkRestore', 'tasks.bulkHardDelete', 'todos.capture',
  'progress.project', 'progress.dashboard',
  'papers.list', 'papers.create', 'papers.update', 'papers.archive',
  'matrix.list', 'matrix.upsert', 'matrix.remove', 'matrix.bulkDelete',
  'artifacts.list', 'artifacts.create', 'artifacts.update', 'artifacts.archive',
  'resourceLinks.list', 'resourceLinks.create', 'resourceLinks.remove',
  'integrations.list', 'integrations.save', 'integrations.remove', 'integrations.bulkRemove', 'integrations.removeRun', 'integrations.bulkRemoveRuns', 'integrations.test', 'integrations.sync', 'integrations.runs', 'integrations.links',
  'calendar.list', 'calendar.create', 'calendar.update', 'calendar.remove',
  'calendar.markers.list', 'calendar.markers.create', 'calendar.markers.update', 'calendar.markers.remove',
  'literature.search', 'literature.sessions', 'literature.clearSession', 'literature.resultsPage',
  'literature.staging.page', 'literature.staging.save', 'literature.staging.delete', 'literature.staging.bulkDelete',
  'literature.stagingToZotero.preview', 'literature.stagingToZotero.execute',
  'literature.batch.preview', 'literature.batch.execute', 'literature.batch.cancel',
  'literature.batch.retry', 'literature.importResult', 'literature.scholar.status',
  'obsidian.indexStatus', 'obsidian.layout.preview', 'obsidian.layout.initialize',
  'obsidian.vaultLayout.preview', 'obsidian.vaultLayout.initialize',
  'notes.list', 'notes.read', 'notes.write', 'notes.delete', 'notes.deleteFolder',
  'notes.createFolder', 'notes.move', 'notes.metadata.preview', 'notes.metadata.apply', 'notes.duplicates',
  'zotero.capability', 'zotero.authorize', 'zotero.collectionsPage', 'zotero.itemsPage', 'zotero.bibtexExport', 'zotero.import',
  'zotero.importSelected.preview', 'zotero.importSelected.execute',
  'zotero.paperToZotero.preview', 'zotero.paperToZotero.execute',
  'zotero.deleteRemote.preview', 'zotero.deleteRemote.execute',
  'papers.importFromZotero',
  'knowledge.engines.list', 'knowledge.engines.save', 'knowledge.engines.test',
  'workspace.status', 'system.openExternal', 'system.health', 'system.selectFolder', 'system.revealPath', 'system.saveTextFile'
] as const
export const WorkspaceApiV2MethodSchema = z.enum(WorkspaceApiV2Methods)
export type WorkspaceApiV2Method = z.infer<typeof WorkspaceApiV2MethodSchema>

/**
 * Compatibility-only route names for the pre-pagination array helpers. These
 * routes are intentionally kept outside the primary V2 allow-list so new
 * callers use the explicit `*Page` method names and page DTOs.
 */
export const WorkspaceApiV2CompatibilityMethods = [
  'literature.results',
  'zotero.collections',
  'zotero.items'
] as const
export const WorkspaceApiV2CompatibilityMethodSchema = z.enum(WorkspaceApiV2CompatibilityMethods)
export type WorkspaceApiV2CompatibilityMethod = z.infer<typeof WorkspaceApiV2CompatibilityMethodSchema>

/** The complete route list accepted by compatibility-aware RPC adapters. */
export const WorkspaceApiV2RouteMethods = [
  ...WorkspaceApiV2Methods,
  ...WorkspaceApiV2CompatibilityMethods
] as const
export const WorkspaceApiV2RouteSchema = z.enum(WorkspaceApiV2RouteMethods)
/** The complete route union accepted by compatibility-aware RPC adapters. */
export type WorkspaceApiV2Route = WorkspaceApiV2Method | WorkspaceApiV2CompatibilityMethod
