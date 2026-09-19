import { z } from 'zod'
import {
  BulkSelectionSchema,
  IntegrationErrorSchema,
  ExternalWriteErrorSchema,
  OBSIDIAN_LAYOUT_CATEGORIES,
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
  ResourceKindSchema,
  isSafeVaultRelativePath,
  normalizeVaultRelativePath
} from './v2.js'

const IsoDateSchema = IsoInstantSchema
const NullableIsoDateSchema = IsoDateSchema.nullable()

/** Requested last30days sources (engine `--search` values such as `reddit` or
 * `hackernews`). An empty list means "every source the engine reports as
 * available", which stays the safe default for an unattended schedule. */
export const AgentSourceListSchema = z.array(z.string().trim().min(1).max(60)).max(24)
export type AgentSourceList = z.infer<typeof AgentSourceListSchema>

/** Rolling window in days for a retrieval run (engine `--days`). */
export const AgentLookbackDaysSchema = z.int().min(1).max(365)

/**
 * Output language of a schedule/skill run.
 *
 * `zh-CN` is the frozen product default: a scheduled push writes its narrative
 * in Simplified Chinese while source names, proper nouns, original titles,
 * community quotes and URLs stay verbatim so the evidence remains checkable.
 * The value travels with the run (a skill briefing receives it), so it is a
 * contract field rather than a renderer-only hint.
 */
export const AgentResponseLanguageSchema = z.enum(['zh-CN', 'en'])
export type AgentResponseLanguage = z.infer<typeof AgentResponseLanguageSchema>

/** Skill keys the frozen schedule contract knows about, in display order.
 *
 * Being listed here only means a rule may *select* the key. Whether a build can
 * actually run it is a separate, registry-owned fact (installed vs reserved),
 * so a key reserved for a later task stays selectable and is still blocked at
 * run time with a structured diagnostic — it is never reported as installed.
 */
export const AgentScheduleSkillKeySchema = z.enum(['last30days', 'literature-matrix', 'literature-review-push'])
export type AgentScheduleSkillKey = z.infer<typeof AgentScheduleSkillKeySchema>
export const AGENT_SCHEDULE_SKILL_KEYS: readonly AgentScheduleSkillKey[] = AgentScheduleSkillKeySchema.options

/** Shared schedule inputs a skill may require before a rule can be enabled. */
export const AgentScheduleSkillRequiredInputSchema = z.enum(['topic', 'sources', 'lookbackDays', 'outputFolder'])
export type AgentScheduleSkillRequiredInput = z.infer<typeof AgentScheduleSkillRequiredInputSchema>

/**
 * One selectable skill key of the frozen schedule contract.
 *
 * `availability` is a build fact, not a user preference: `shipped` means this
 * build registers an execution contract for the key (how the skill is
 * discovered and injected); `reserved` means the key is part of the frozen
 * contract so a rule may select it, but the skill is not installed in this
 * build — the registry reports it as not installed and blocks the run with a
 * structured diagnostic instead of degrading to the generic workflow.
 *
 * The catalog lives in the shared contract (not in the main-side registry) so
 * the renderer can render the exact same selection contract the run path
 * enforces: labels, required inputs and the honest installed/not-installed
 * state never drift between UI and runtime.
 */
export const AgentScheduleSkillOptionSchema = z.strictObject({
  key: AgentScheduleSkillKeySchema,
  label: z.string().trim().min(1).max(200),
  availability: z.enum(['shipped', 'reserved']),
  /** `SKILL.md` location relative to `.agents/skills/<key>/`, i.e. the mirror
   * location relative to `resources/skills/<key>/`. */
  skillFileRelativePath: z.string().trim().min(1).max(300),
  requiredInputs: z.array(AgentScheduleSkillRequiredInputSchema),
  summary: z.string().trim().min(1).max(500)
})
export type AgentScheduleSkillOption = z.infer<typeof AgentScheduleSkillOptionSchema>

export const AGENT_SCHEDULE_SKILL_CATALOG: Readonly<Record<AgentScheduleSkillKey, AgentScheduleSkillOption>> = {
  last30days: {
    key: 'last30days',
    label: 'last30days（项目锁定版）',
    availability: 'shipped',
    skillFileRelativePath: 'skills/last30days/SKILL.md',
    requiredInputs: ['topic'],
    summary: '近 30 天 AI 最新资讯的中文简报（引擎 + 本地 preflight）。'
  },
  'literature-matrix': {
    key: 'literature-matrix',
    label: 'literature-matrix',
    availability: 'shipped',
    skillFileRelativePath: 'SKILL.md',
    requiredInputs: ['topic'],
    summary: '指定主题的文献矩阵推送（指令型 skill：Agent runtime 按 SKILL.md 执行，正文交 Artifact/Obsidian 投影）。'
  },
  'literature-review-push': {
    key: 'literature-review-push',
    label: 'literature-review-push',
    availability: 'shipped',
    skillFileRelativePath: 'SKILL.md',
    requiredInputs: ['topic'],
    summary: '指定主题的文献综述推送（指令型 skill：Agent runtime 按 SKILL.md 执行，正文交 Artifact/Obsidian 投影）。'
  }
}

/** `null` for an unknown key so a caller blocks an unknown selection instead of
 * guessing a default skill. */
export function agentScheduleSkillOption(key: string | null | undefined): AgentScheduleSkillOption | null {
  const normalized = key?.trim() ?? ''
  return normalized.length > 0 && normalized in AGENT_SCHEDULE_SKILL_CATALOG
    ? AGENT_SCHEDULE_SKILL_CATALOG[normalized as AgentScheduleSkillKey]
    : null
}

/**
 * Runtime-visible skill catalog entry: the frozen selection contract plus the
 * discovery result of the canonical skill file.
 *
 * `runnable` is deliberately conservative — it says the build has an execution
 * contract *and* the skill sources are present. The per-run capability probe
 * (interpreter, sources, network) still gates an actual execution, so a
 * `runnable` skill never implies the next run is guaranteed to produce output.
 */
export const AgentScheduleSkillCatalogEntrySchema = AgentScheduleSkillOptionSchema.extend({
  /** Canonical `.agents/skills/<key>/<skillFileRelativePath>` exists on disk. */
  skillFileFound: z.boolean(),
  /** Build-mirrored `resources/skills/<key>/...` file exists (packaged app). */
  packagedSkillFileFound: z.boolean(),
  runnable: z.boolean(),
  /** Operator-facing reason a run would be blocked; `''` when runnable. */
  blockedReason: z.string().max(500)
})
export type AgentScheduleSkillCatalogEntry = z.infer<typeof AgentScheduleSkillCatalogEntrySchema>

/**
 * The shipped daily-push template: skill, topic, language, window and output
 * folder. Everything that seeds a default (the built-in rule, the migration
 * that normalizes the previous default, the automation editor) reads this one
 * object so the frozen values cannot drift apart.
 *
 * `sources: []` stays "every source the capability probe reports as
 * available", which is the safe default for an unattended push.
 */
export const DEFAULT_DAILY_PUSH_SCHEDULE_INPUT: {
  readonly skillKey: AgentScheduleSkillKey
  readonly topic: string
  readonly responseLanguage: AgentResponseLanguage
  readonly sources: readonly string[]
  readonly lookbackDays: number
  readonly outputFolder: string
} = {
  skillKey: 'last30days',
  topic: 'AI 最新资讯',
  responseLanguage: 'zh-CN',
  sources: [],
  lookbackDays: 30,
  outputFolder: '每日资讯推送'
}

/**
 * One rule of the shipped built-in schedule set.
 *
 * A new install — and an upgrade of an existing database — must end up with
 * exactly these rules, all enabled. `id` is the durable identity the seeding
 * migration writes with `INSERT OR IGNORE`, so a rule that already exists is
 * never inserted twice and never updated: a user's own name, topic, folder or
 * pause state survives every upgrade. A rule the user archived is an existing
 * row too and is deliberately not resurrected.
 *
 * This object is the only place a frozen built-in default may be changed. The
 * migration carries the same literals (SQL cannot import it) and the focused
 * `default-schedules` test fails if the two ever disagree.
 */
export interface DefaultAgentScheduleRule {
  readonly id: string
  readonly name: string
  readonly skillKey: AgentScheduleSkillKey
  readonly workflowKey: AgentWorkflowKey
  readonly promptTemplateId: string
  readonly topic: string
  readonly responseLanguage: AgentResponseLanguage
  /** `[]` = every source the capability probe reports as available. */
  readonly sources: readonly string[]
  readonly lookbackDays: number
  readonly outputFolder: string
  readonly frequency: 'daily'
  readonly cron: string
  readonly timezone: string
  readonly runtime: 'pi'
  readonly assistantKey: string
  readonly enabled: true
}

/**
 * The frozen built-in schedule rules, in display order.
 *
 * The first entry *is* the shipped daily push (`DEFAULT_DAILY_PUSH_SCHEDULE_INPUT`
 * is spread into it), so the news rule and the shared push template can never
 * drift apart. The two instruction-skill pushes use legal Chinese topics and the
 * existing Obsidian projection directories (`文献矩阵` / `文献综述`) rather than
 * inventing new folders.
 */
export const DEFAULT_AGENT_SCHEDULE_RULES: readonly DefaultAgentScheduleRule[] = [
  {
    id: 'builtin.schedule.last30days',
    name: 'Last 30 days 每日资讯推送',
    workflowKey: 'daily_digest',
    promptTemplateId: 'builtin.prompt.daily-reading',
    frequency: 'daily',
    cron: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    runtime: 'pi',
    assistantKey: 'researcher',
    enabled: true,
    ...DEFAULT_DAILY_PUSH_SCHEDULE_INPUT
  },
  {
    id: 'builtin.schedule.literature-matrix',
    name: '文献矩阵推送',
    skillKey: 'literature-matrix',
    workflowKey: 'literature_matrix',
    promptTemplateId: 'builtin.prompt.matrix-extraction',
    topic: '长上下文检索',
    responseLanguage: 'zh-CN',
    sources: [],
    lookbackDays: 30,
    outputFolder: '文献矩阵',
    frequency: 'daily',
    cron: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    runtime: 'pi',
    assistantKey: 'researcher',
    enabled: true
  },
  {
    id: 'builtin.schedule.literature-review-push',
    name: '文献综述推送',
    skillKey: 'literature-review-push',
    workflowKey: 'literature_review',
    promptTemplateId: 'builtin.prompt.review-outline',
    topic: '长上下文检索',
    responseLanguage: 'zh-CN',
    sources: [],
    lookbackDays: 30,
    outputFolder: '文献综述',
    frequency: 'daily',
    cron: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    runtime: 'pi',
    assistantKey: 'researcher',
    enabled: true
  }
]

/** Longest accepted output folder, matching the stored column and the
 * `AutomationRule*` schemas. */
export const AGENT_OUTPUT_FOLDER_MAX_LENGTH = 180

export type AgentOutputFolderRejection =
  | 'EMPTY'
  | 'TOO_LONG'
  | 'ABSOLUTE_OR_DRIVE'
  | 'BACKSLASH_SEPARATOR'
  | 'EMPTY_SEGMENT'
  | 'PARENT_TRAVERSAL'
  | 'CURRENT_DIRECTORY'
  | 'OBSIDIAN_INTERNAL'
  | 'WINDOWS_UNSAFE_SEGMENT'

/**
 * Validate one user-entered schedule output folder as a safe Vault-relative
 * directory. Backslashes are normalized first (a Windows-style entry is a
 * separator habit, not an escape attempt), then the shared Vault-relative
 * predicate decides: no absolute/drive/UNC path, no traversal, no empty
 * segment, no `.obsidian`, no reserved device name or control character.
 */
export function inspectAgentOutputFolder(value: string):
  | { readonly ok: true; readonly folder: string }
  | { readonly ok: false; readonly reason: AgentOutputFolderRejection; readonly message: string } {
  const normalized = normalizeVaultRelativePath(value).replace(/\/+$/gu, '')
  if (normalized.length === 0) return { ok: false, reason: 'EMPTY', message: '输出目录不能为空；请选择内置目录或填写 Vault 内的相对目录。' }
  if ([...normalized].length > AGENT_OUTPUT_FOLDER_MAX_LENGTH) {
    return { ok: false, reason: 'TOO_LONG', message: `输出目录最长 ${String(AGENT_OUTPUT_FOLDER_MAX_LENGTH)} 个字符。` }
  }
  if (value.includes('\\')) {
    return { ok: false, reason: 'BACKSLASH_SEPARATOR', message: '请使用正斜杠 "/" 分隔输出目录层级。' }
  }
  if (normalized.startsWith('/') || normalized.startsWith('~') || /^[A-Za-z]:/u.test(normalized)) {
    return { ok: false, reason: 'ABSOLUTE_OR_DRIVE', message: '输出目录必须是 Vault 内的相对目录，不能是绝对路径、盘符或 home 路径。' }
  }
  const segments = normalized.split('/')
  for (const segment of segments) {
    if (segment === '') return { ok: false, reason: 'EMPTY_SEGMENT', message: '输出目录不能包含空目录层级（连续的 "/"）。' }
    if (segment === '.') return { ok: false, reason: 'CURRENT_DIRECTORY', message: '输出目录不能包含 "." 目录层级。' }
    if (segment === '..') return { ok: false, reason: 'PARENT_TRAVERSAL', message: '输出目录不能包含 ".." 上级穿越。' }
  }
  if (!isSafeVaultRelativePath(normalized)) {
    const hidden = segments.some((segment) => segment.toLocaleLowerCase() === '.obsidian')
    return {
      ok: false,
      reason: hidden ? 'OBSIDIAN_INTERNAL' : 'WINDOWS_UNSAFE_SEGMENT',
      message: hidden
        ? '输出目录不能写入 Obsidian 内部目录 .obsidian。'
        : '输出目录包含 Windows 保留名/控制字符或结尾点号等不安全片段。'
    }
  }
  return { ok: true, folder: normalized }
}

export function isSafeAgentOutputFolder(value: string): boolean {
  return inspectAgentOutputFolder(value).ok
}

/** Write-path schema for a schedule output folder. The read path stays
 * permissive on purpose so one legacy row can never make the whole task list
 * unreadable; every write goes through this contract instead. */
export const AgentOutputFolderSchema = z.string().trim().min(1).max(AGENT_OUTPUT_FOLDER_MAX_LENGTH)
  .refine(isSafeAgentOutputFolder, { message: 'Expected a safe Vault-relative output folder.' })

/**
 * Built-in output folders the schedule editor offers.
 *
 * The frozen daily-push default comes first; the remaining entries are the
 * Obsidian layout directories of the shared Vault layout contract, minus the
 * legacy daily-digest folder it superseded. A folder outside this list is
 * still allowed through the editor's custom mode as long as it passes
 * `inspectAgentOutputFolder`.
 */
const LEGACY_DAILY_LITERATURE_FOLDER = OBSIDIAN_LAYOUT_CATEGORIES.find((category) => category.kind === 'daily_literature')?.directoryName ?? ''

export const AGENT_SCHEDULE_OUTPUT_FOLDER_OPTIONS: readonly string[] = [
  DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.outputFolder,
  ...OBSIDIAN_LAYOUT_CATEGORIES
    .map((category) => category.directoryName)
    // The legacy `每日文献推送` directory stays a valid Vault layout category
    // (the Obsidian page keeps it), but the daily *digest* owns one folder now:
    // offering it here would recreate the two-competing-daily-folders drift the
    // frozen default exists to prevent. It is still reachable through custom
    // mode, where the same safety predicate applies.
    .filter((name) => name !== LEGACY_DAILY_LITERATURE_FOLDER)
].filter((value, index, values) => values.indexOf(value) === index && isSafeAgentOutputFolder(value))

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

/**
 * One CAS-locked record inside a bulk archive/delete command.
 *
 * Every session-level "delete selected rows" action in this workspace is
 * expressed as `{ id, expectedRevision }` locks, so a row that changed between
 * the moment it was selected and the moment the command runs is never silently
 * overwritten. The lock is shared by connection records and schedule records so
 * both lists keep one receipt/confirmation vocabulary.
 */
export const ArchiveBulkLockSchema = z.strictObject({
  id: IdSchema,
  expectedRevision: z.int().nonnegative()
})
export type ArchiveBulkLock = z.infer<typeof ArchiveBulkLockSchema>

export const ArchiveBulkInputSchema = z.strictObject({
  items: z.array(ArchiveBulkLockSchema).min(1).max(500)
}).superRefine((value, context) => {
  const ids = value.items.map((item) => item.id)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['items'], message: 'Archive locks must be unique.' })
  }
})
export type ArchiveBulkInput = z.infer<typeof ArchiveBulkInputSchema>

/**
 * Per-record receipt of a bulk archive/delete command.
 *
 * `conflict` is a first-class outcome next to `failed`: a stale revision lock
 * means the record changed after the user selected it, so nothing was written
 * and the user has to re-read the list before retrying. `skipped` means the
 * requested end state already held (the record was missing or already
 * archived), which is not an error but must still be reported per record.
 */
export const ArchiveBulkReceiptSchema = z.strictObject({
  id: IdSchema,
  outcome: z.enum(['succeeded', 'skipped', 'conflict', 'failed']),
  error: z.object({
    code: z.string().min(1),
    message: z.string().trim().min(1).max(500).refine((value) => !/([A-Za-z]:[\\/]|\\\\|Bearer\s|token=|api[_-]?key)/i.test(value), {
      message: 'Archive receipt messages must be redacted.'
    }),
    retryable: z.boolean()
  }).nullable()
})
export type ArchiveBulkReceipt = z.infer<typeof ArchiveBulkReceiptSchema>

export const ArchiveBulkResultSchema = z.strictObject({
  items: z.array(ArchiveBulkReceiptSchema),
  succeeded: z.int().nonnegative(),
  skipped: z.int().nonnegative(),
  conflict: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  canceled: z.boolean()
}).superRefine((value, context) => {
  const counts = value.items.reduce((result, item) => {
    result[item.outcome] += 1
    return result
  }, { succeeded: 0, skipped: 0, conflict: 0, failed: 0 })
  if (counts.succeeded !== value.succeeded) context.addIssue({ code: 'custom', path: ['succeeded'], message: 'Succeeded count must match item outcomes.' })
  if (counts.skipped !== value.skipped) context.addIssue({ code: 'custom', path: ['skipped'], message: 'Skipped count must match item outcomes.' })
  if (counts.conflict !== value.conflict) context.addIssue({ code: 'custom', path: ['conflict'], message: 'Conflict count must match item outcomes.' })
  if (counts.failed !== value.failed) context.addIssue({ code: 'custom', path: ['failed'], message: 'Failed count must match item outcomes.' })
})
export type ArchiveBulkResult = z.infer<typeof ArchiveBulkResultSchema>

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

/**
 * One synchronization run ledger row (Settings → 最近同步).
 *
 * `revision` is the compare-and-swap token the single-record and bulk removal
 * commands lock on, so a run that finished or changed after the user selected
 * it is reported as a revision conflict instead of being touched. Removing a
 * row only soft-archives the audit record; it never deletes the row, the
 * connection profile, its safeStorage credential, external links or any
 * external system data.
 */
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
  finishedAt: NullableIsoDateSchema,
  revision: z.int().nonnegative()
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
  runtime: z.enum(['pi']).nullable().default(null),
  model: z.string().max(300).nullable().default(null),
  assistantKey: z.string().max(300).nullable().default('researcher'),
  workspacePath: z.string().max(4_000).nullable().default(null),
  frequency: z.enum(['manual', 'hourly', 'daily', 'weekdays', 'weekly', 'custom']).default('custom'),
  executionMode: z.enum(['new_conversation', 'existing']).default('new_conversation'),
  conversationId: z.string().nullable().default(null),
  prompt: z.string().max(100_000).default(''),
  skillKey: z.string().trim().max(100).nullable().default(null),
  topic: z.string().trim().max(500).default(''),
  sources: AgentSourceListSchema.default([]),
  lookbackDays: AgentLookbackDaysSchema.default(30),
  responseLanguage: AgentResponseLanguageSchema.default('zh-CN'),
  outputFolder: z.string().trim().max(180).default(DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.outputFolder),
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
  runtime: z.enum(['pi']).nullable().default(null),
  model: z.string().trim().max(300).nullable().default(null),
  assistantKey: z.string().trim().max(300).nullable().default('researcher'),
  workspacePath: z.string().trim().max(4_000).nullable().default(null),
  frequency: z.enum(['manual', 'hourly', 'daily', 'weekdays', 'weekly', 'custom']).default('custom'),
  executionMode: z.enum(['new_conversation', 'existing']).default('new_conversation'),
  conversationId: z.string().min(1).nullable().default(null),
  prompt: z.string().trim().max(100_000).default(''),
  skillKey: z.string().trim().max(100).nullable().default(null),
  topic: z.string().trim().max(500).default(''),
  sources: AgentSourceListSchema.default([]),
  lookbackDays: AgentLookbackDaysSchema.default(30),
  responseLanguage: AgentResponseLanguageSchema.default('zh-CN'),
  outputFolder: z.string().trim().max(180).default(DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.outputFolder),
  permissionMode: z.enum(['read-only', 'auto', 'full-access']).default('read-only'),
  approvalPolicy: z.enum(['on-request', 'never']).default('on-request'),
  projectId: z.string().min(1).nullable().default(null),
  cron: z.string().trim().min(1).max(200),
  timezone: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  expectedRevision: z.int().nonnegative().nullable().default(null)
})
export type SaveScheduleInput = z.infer<typeof SaveScheduleInputSchema>
