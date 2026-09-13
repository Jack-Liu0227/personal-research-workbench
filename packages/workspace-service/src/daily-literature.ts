import type { AgentRunRecord, IntegrationProfile, Note } from '@prw/contracts'

/**
 * Daily literature push (last30days) delivery boundary.
 *
 * SQLite stays authoritative for *workbench-owned* records (rule, run, ledger,
 * artifact index, inbox), while the Markdown note inside the authorized Vault
 * is the single authority for the pushed article body. Everything that decides
 * a folder, a path, a frontmatter field or an excerpt therefore lives here so
 * the coordinator, the host sink and the tests cannot drift apart:
 *
 * - one folder name (`每日资讯推送`, the frozen default of the shipped push
 *   contract) for every producer,
 * - `<folder>/YYYY-MM-DD-daily_digest-<schedule8>-<run8>.md` path shape,
 * - `workbench_kind: daily_literature` + rule/source/time metadata,
 * - a bounded excerpt for the artifact/inbox projection instead of a second
 *   full copy of the body.
 */

export const DAILY_LITERATURE_FOLDER = '每日资讯推送'

/** The timezone the built-in daily schedule ships with; also the fallback key
 * used for the note filename when a rule has no timezone. */
export const DAILY_LITERATURE_TIMEZONE = 'Asia/Shanghai'

/** The only schedule workflow that owns a daily Markdown projection. */
export const DAILY_LITERATURE_WORKFLOW_KEY = 'daily_digest'

/** Body characters kept in the SQLite/Inbox projection. The full article stays
 * in the Vault note, so this is deliberately a preview, not a second authority. */
export const DAILY_LITERATURE_EXCERPT_LIMIT = 4_000

export type DailyLiteratureSkipReason = 'NOT_DAILY_DIGEST' | 'NO_SINK' | 'NO_VAULT' | 'WRITE_FAILED'

export type DailyLiteratureDelivery =
  | { readonly status: 'written'; readonly vaultId: string; readonly relativePath: string; readonly fingerprint: string }
  | { readonly status: 'skipped'; readonly reason: DailyLiteratureSkipReason; readonly message: string }

/** Minimal surface the delivery needs from `IntegrationCoordinator`. Keeping it
 * structural lets tests drive the real safe-write path with a stub-free
 * coordinator or a recording double. */
export interface ObsidianNoteWriter {
  listObsidianProfiles(): IntegrationProfile[]
  writeNote(input: {
    readonly vaultId: string
    readonly relativePath: string
    readonly content: string
    readonly expectedFingerprint: string | null
  }): Promise<Note>
}

export interface DailyLiteratureDeliveryInput {
  readonly scheduleId: string
  readonly run: AgentRunRecord
  readonly content: string
  readonly outputFolder?: string | undefined
  readonly scheduleName?: string | undefined
  /** The rule's own timezone decides which local day the note belongs to, so a
   * 09:00 Asia/Shanghai rule and its dedupe key never disagree. */
  readonly timezone?: string | undefined
  readonly topic?: string | undefined
  readonly sources?: readonly string[] | undefined
  readonly lookbackDays?: number | undefined
}

/**
 * Normalize a rule-provided folder into a Vault-relative directory. Anything
 * absolute, escaping or reserved falls back to the single default folder: a
 * scheduled run must never be able to write outside its authorized directory,
 * and it must never silently pick a *different* daily folder either.
 */
export function safeDailyLiteratureFolder(value: string | null | undefined): string {
  const raw = (value ?? '').trim().replace(/\\/gu, '/')
  // An absolute path, a home-relative path or a Windows drive prefix is not a
  // Vault-relative directory: falling back keeps the write inside the
  // authorized folder instead of silently re-interpreting the user's path.
  if (raw.length === 0 || raw.startsWith('/') || raw.startsWith('~') || /^[A-Za-z]:/u.test(raw)) return DAILY_LITERATURE_FOLDER
  const normalized = raw.replace(/\/+$/gu, '')
  if (normalized.length === 0) return DAILY_LITERATURE_FOLDER
  const parts = normalized.split('/')
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..' || part.toLocaleLowerCase() === '.obsidian')) {
    return DAILY_LITERATURE_FOLDER
  }
  return normalized.slice(0, 180)
}

/** Local (timezone-aware) date key, `YYYY-MM-DD`. Falls back to the UTC date for
 * an unparsable instant or an unknown timezone instead of throwing: the date key
 * is used for folder names and dedupe, never as a safety boundary. */
export function localDateKey(value: Date, timeZone: string): string {
  if (Number.isNaN(value.getTime())) return new Date().toISOString().slice(0, 10)
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(value)
  } catch {
    return value.toISOString().slice(0, 10)
  }
}

/** Asia/Shanghai date key (the schedule timezone the product ships with). */
export function dailyLiteratureDateKey(value: Date, timeZone: string | null | undefined = DAILY_LITERATURE_TIMEZONE): string {
  const zone = (timeZone ?? '').trim()
  return localDateKey(value, zone.length > 0 ? zone : DAILY_LITERATURE_TIMEZONE)
}

export function dailyLiteratureRelativePath(input: {
  readonly outputFolder?: string | null | undefined
  readonly dateKey: string
  readonly scheduleId: string
  readonly runId: string
}): string {
  const folder = safeDailyLiteratureFolder(input.outputFolder)
  return `${folder}/${input.dateKey}-${DAILY_LITERATURE_WORKFLOW_KEY}-${input.scheduleId.slice(0, 8)}-${input.runId.slice(0, 8)}.md`
}

/** Frontmatter is the rule/run metadata required by the task doc: kind, rule,
 * run, runtime, sources, lookback window, topic and generation time. */
export function buildDailyLiteratureMarkdown(input: DailyLiteratureDeliveryInput & { readonly dateKey: string }): string {
  const finishedAt = input.run.finishedAt ?? input.run.createdAt
  const sources = (input.sources ?? []).filter((source) => source.trim().length > 0)
  const topic = (input.topic ?? '').trim()
  return [
    '---',
    `workbench_kind: daily_literature`,
    `workbench_schedule_id: ${JSON.stringify(input.scheduleId)}`,
    `workbench_run_id: ${JSON.stringify(input.run.id)}`,
    `workbench_runtime: ${JSON.stringify(input.run.runtime)}`,
    `workbench_workflow: ${JSON.stringify(input.run.workflowKey)}`,
    `workbench_output_folder: ${JSON.stringify(safeDailyLiteratureFolder(input.outputFolder))}`,
    `workbench_lookback_days: ${String(input.lookbackDays ?? 30)}`,
    `workbench_sources: ${JSON.stringify(sources)}`,
    `workbench_topic: ${JSON.stringify(topic.slice(0, 200))}`,
    `generated_at: ${JSON.stringify(finishedAt)}`,
    '---',
    '',
    `# 每日资讯推送 · ${input.dateKey}`,
    '',
    input.content.trim(),
    '',
    `> 来源：工作台定时任务 ${input.scheduleId.slice(0, 8)} · 运行 ${input.run.id.slice(0, 8)}${input.scheduleName ? ` · 规则 ${input.scheduleName}` : ''}`,
    ''
  ].join('\n')
}

/** Bounded preview of the article body for SQLite artifacts / the inbox. */
export function dailyLiteratureExcerpt(content: string, limit = DAILY_LITERATURE_EXCERPT_LIMIT): string {
  const trimmed = content.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit)}\n\n…（正文已截断；完整内容以 Obsidian 投影文件为准）`
}

export interface DailyLiteratureProjection {
  /** Title used by both the artifact and the inbox item. */
  readonly title: string
  /** Bounded, non-authoritative preview stored in SQLite. */
  readonly body: string
}

/**
 * Projection stored in SQLite once the article exists. It never claims to be
 * the article body: it names the Vault file that owns the body, or the concrete
 * reason the projection is missing.
 */
export function buildDailyLiteratureProjection(input: {
  readonly delivery: DailyLiteratureDelivery | null
  readonly content: string
  readonly dateKey: string
  readonly scheduleId: string
  readonly run: AgentRunRecord
}): DailyLiteratureProjection {
  const delivery = input.delivery
  const disposition = delivery === null
    ? '本次运行不是 daily_digest，未生成 Obsidian 投影。'
    : delivery.status === 'written'
      ? `Obsidian 投影（正文权威）: ${delivery.relativePath}`
      : `Obsidian 投影未写入（${delivery.reason}）：${delivery.message}`
  return {
    title: `每日资讯推送 · ${input.dateKey} · ${input.scheduleId.slice(0, 8)}`,
    body: [
      `# 每日资讯推送 · ${input.dateKey}`,
      '',
      `- 规则: ${input.scheduleId}`,
      `- 运行: ${input.run.id}（${input.run.runtime} / ${input.run.workflowKey}）`,
      `- ${disposition}`,
      `- SQLite 仅保存索引与摘录（≤ ${String(DAILY_LITERATURE_EXCERPT_LIMIT)} 字），不保存第二份权威正文。`,
      '',
      '---',
      '',
      dailyLiteratureExcerpt(input.content)
    ].join('\n')
  }
}

/**
 * Write the article into the authorized Vault through the existing safe-write
 * channel (relative `.md` path, containment check, atomic write). A concurrent
 * external edit is not overwritten: the path is unique per run, and the write
 * is attempted with a null fingerprint so an already existing file fails the
 * CAS check instead of being replaced silently.
 */
export async function deliverDailyLiterature(
  writer: ObsidianNoteWriter,
  input: DailyLiteratureDeliveryInput
): Promise<DailyLiteratureDelivery> {
  if (input.run.workflowKey !== DAILY_LITERATURE_WORKFLOW_KEY) {
    return { status: 'skipped', reason: 'NOT_DAILY_DIGEST', message: `工作流 ${input.run.workflowKey} 不写入每日资讯推送目录。` }
  }
  const profile = writer.listObsidianProfiles().find((candidate) => candidate.enabled)
  if (!profile) {
    return { status: 'skipped', reason: 'NO_VAULT', message: '未配置可用的 Obsidian Vault；正文仅保存在本地工作区（SQLite）。' }
  }
  const dateKey = dailyLiteratureDateKey(new Date(input.run.finishedAt ?? input.run.createdAt), input.timezone)
  const relativePath = dailyLiteratureRelativePath({
    outputFolder: input.outputFolder,
    dateKey,
    scheduleId: input.scheduleId,
    runId: input.run.id
  })
  const note = await writer.writeNote({
    vaultId: profile.id,
    relativePath,
    content: buildDailyLiteratureMarkdown({ ...input, dateKey }),
    expectedFingerprint: null
  })
  return { status: 'written', vaultId: profile.id, relativePath: note.relativePath, fingerprint: note.fingerprint }
}
