import {
  CalendarEventSchema,
  type CalendarEvent,
  type CalendarEventType,
  type Schedule,
  type ScheduleOccurrence
} from '@prw/contracts'

/**
 * Daily-push calendar projection.
 *
 * `calendar.list` returns three read-only projections today: task deadlines,
 * project milestones and the scheduled daily push. This module owns the third
 * one. It is deliberately pure: the caller (the RPC dispatcher) only performs
 * the repository reads it already has (`listSchedules`,
 * `listScheduleOccurrences`, `listScheduledManagedAgentRuns`,
 * `getScheduleOccurrenceByRunId`, artifact titles and the run ledger), and this
 * module turns those stored rows into calendar events.
 *
 * Hard rules encoded here:
 * - a rule's *plan* is its stored `nextRunAt` only; it can never report a
 *   status, artifact or delivery of its own (there is no run yet),
 * - an *occurrence* row is authoritative for the slot status and reason, and
 *   the run ledger is authoritative for the Artifact and the Obsidian delivery,
 * - nothing is invented: no demo title, no synthetic path, and never a copy of
 *   the pushed body — only bounded metadata,
 * - `[startsAt, endsAt)` stays half-open and instant comparisons happen on the
 *   stored ISO instants, so a DST shift in the rule's IANA timezone can never
 *   move an event into the wrong range.
 */

export const DAILY_PUSH_VIRTUAL_ID_PREFIX = 'daily-push:'

/** The only workflow that owns a daily Markdown projection (see
 * `daily-literature.ts`, which owns the delivery boundary). */
export const DAILY_PUSH_WORKFLOW_KEY = 'daily_digest'

const DESCRIPTION_LIMIT = 500
const REASON_LIMIT = 120

/** Status labels are product copy, not ledger data: the ledger keeps the codes. */
const occurrenceStatusLabels: Record<string, string> = {
  claimed: '已认领',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  blocked: '已阻塞',
  canceled: '已取消',
  missed: '错过',
  skipped: '已跳过'
}

export function isDailyPushVirtualId(id: string): boolean {
  return id.startsWith(DAILY_PUSH_VIRTUAL_ID_PREFIX)
}

/** Every read-only projection id family `calendar.update`/`calendar.remove`
 * must refuse. Kept here so the Service and the contracts cannot drift. */
export function isCalendarVirtualId(id: string): boolean {
  return id.startsWith('task:') || id.startsWith('project:') || isDailyPushVirtualId(id)
}

/**
 * Stable identity of one projected daily-push slot:
 * `daily-push:<scheduleId>:<occurrence key/id>`.
 *
 * A stored occurrence uses its own row id (durable, one row per slot, never
 * reused). A plan uses `planned:<nextRunAt>` because the cursor is what defines
 * that plan: when the rule fires, the occurrence row replaces it.
 */
export function dailyPushVirtualEventId(scheduleId: string, occurrenceKey: string): string {
  return `${DAILY_PUSH_VIRTUAL_ID_PREFIX}${scheduleId}:${occurrenceKey}`
}

/** Artifact and Obsidian outcome of one scheduled run, read from the ledger. */
export interface DailyPushRunOutcome {
  readonly runId: string
  readonly status: string
  readonly artifact: { readonly id: string; readonly title: string } | null
  readonly delivery: {
    readonly status: 'written' | 'skipped'
    readonly relativePath: string | null
    readonly reason: string | null
    readonly message: string | null
  } | null
}

/**
 * Delivery outcome recorded on the run ledger (`OBSIDIAN_DAILY_NOTE_*`
 * progress records — the very same records the Automation run history reads).
 * The payload carries the Vault-relative path and the skip reason, never an
 * absolute path and never the pushed body.
 */
export function dailyPushDeliveryFromEvents(
  events: readonly { readonly kind: string; readonly payload: unknown }[]
): DailyPushRunOutcome['delivery'] {
  const progress = events.filter((event) => event.kind === 'progress').slice().reverse()
  for (const event of progress) {
    const payload = typeof event.payload === 'object' && event.payload !== null
      ? event.payload as Record<string, unknown>
      : null
    const code = typeof payload?.['code'] === 'string' ? payload['code'] : null
    if (code === 'OBSIDIAN_DAILY_NOTE_WRITTEN') {
      return {
        status: 'written',
        relativePath: typeof payload?.['relativePath'] === 'string' ? payload['relativePath'] : null,
        reason: null,
        message: typeof payload?.['message'] === 'string' ? payload['message'].slice(0, 500) : null
      }
    }
    if (code === 'OBSIDIAN_DAILY_NOTE_SKIPPED') {
      return {
        status: 'skipped',
        relativePath: null,
        reason: typeof payload?.['reason'] === 'string' ? payload['reason'].slice(0, REASON_LIMIT) : null,
        message: typeof payload?.['message'] === 'string' ? payload['message'].slice(0, 500) : null
      }
    }
  }
  return null
}

export function dailyPushRunOutcome(input: {
  readonly run: { readonly id: string; readonly status: string }
  readonly artifact: { readonly id: string; readonly title: string } | null
  readonly events: readonly { readonly kind: string; readonly payload: unknown }[]
}): DailyPushRunOutcome {
  return {
    runId: input.run.id,
    status: input.run.status,
    artifact: input.artifact,
    delivery: dailyPushDeliveryFromEvents(input.events)
  }
}

export interface DailyPushCalendarInput {
  /** Half-open window `[startsAt, endsAt)` on the stored ISO instants. */
  readonly range: { readonly startsAt: string; readonly endsAt: string }
  readonly projectId?: string | null | undefined
  readonly types?: readonly CalendarEventType[] | undefined
  readonly schedules: readonly Schedule[]
  readonly occurrences: readonly ScheduleOccurrence[]
  /** Run outcomes of `listScheduledManagedAgentRuns`, keyed by run id. */
  readonly runs: ReadonlyMap<string, DailyPushRunOutcome>
}

/**
 * Project the stored daily-push plan and history into read-only calendar
 * events.
 *
 * - plans come from enabled `daily_digest` rules whose stored `nextRunAt` is
 *   inside the half-open range,
 * - occurrences come from the stored slot rows inside the range, including
 *   slots of a rule that was disabled or edited afterwards (history must not
 *   disappear when a rule is paused),
 * - an occurrence whose run is missing from the ledger (for example a run
 *   record the user removed from RUN HISTORY, or history older than the page
 *   limit) keeps its stored slot status and reason and reports no artifact and
 *   no Obsidian path instead of guessing one.
 */
export function buildDailyPushCalendarEvents(input: DailyPushCalendarInput): CalendarEvent[] {
  if (input.types !== undefined && !input.types.includes('daily_push')) return []
  const inRange = (value: string | null): value is string =>
    value !== null && value >= input.range.startsAt && value < input.range.endsAt
  const projectMatches = (projectId: string | null): boolean =>
    input.projectId === undefined ? true : input.projectId === projectId
  const bySchedule = new Map(input.schedules.map((schedule) => [schedule.id, schedule]))
  const events: CalendarEvent[] = []

  for (const schedule of input.schedules) {
    if (schedule.workflowKey !== DAILY_PUSH_WORKFLOW_KEY || !schedule.enabled) continue
    if (!inRange(schedule.nextRunAt) || !projectMatches(schedule.projectId)) continue
    events.push(plannedDailyPushEvent(schedule, schedule.nextRunAt))
  }

  for (const occurrence of input.occurrences) {
    const schedule = bySchedule.get(occurrence.scheduleId)
    if (!schedule || schedule.workflowKey !== DAILY_PUSH_WORKFLOW_KEY) continue
    if (!inRange(occurrence.occurrenceAt) || !projectMatches(schedule.projectId)) continue
    const outcome = occurrence.runId === null ? null : input.runs.get(occurrence.runId) ?? null
    events.push(occurrenceDailyPushEvent(schedule, occurrence, outcome))
  }

  return events.sort(compareCalendarEvents)
}

/** The shared ordering of every `calendar.list` result (Service side). */
export function compareCalendarEvents(left: CalendarEvent, right: CalendarEvent): number {
  return left.startsAt.localeCompare(right.startsAt) || left.title.localeCompare(right.title)
}

/** Merge stored events with the virtual projections into one ordered list. */
export function mergeCalendarEvents(
  stored: readonly CalendarEvent[],
  virtual: readonly CalendarEvent[]
): CalendarEvent[] {
  return [...stored, ...virtual].sort(compareCalendarEvents)
}

function dailyPushMetadata(schedule: Schedule): {
  readonly topic: string
  readonly language: string
  readonly sources: string[]
  readonly outputFolder: string
} {
  return {
    topic: schedule.topic.slice(0, 500),
    language: schedule.responseLanguage,
    sources: schedule.sources.map((source) => source.slice(0, 200)).slice(0, 50),
    outputFolder: schedule.outputFolder.slice(0, 180)
  }
}

/**
 * One plan: the rule is enabled and its cursor points at `nextRunAt`. There is
 * no run, no status and no delivery yet, so the projection says exactly that —
 * a plan must never be rendered as a completed push.
 */
function plannedDailyPushEvent(schedule: Schedule, nextRunAt: string): CalendarEvent {
  const occurrenceKey = `planned:${nextRunAt}`
  const metadata = dailyPushMetadata(schedule)
  return CalendarEventSchema.parse({
    id: dailyPushVirtualEventId(schedule.id, occurrenceKey),
    projectId: schedule.projectId,
    title: `${schedule.name}（计划）`.slice(0, 500),
    description: `每日推送计划 · ${schedule.cron}（${schedule.timezone}）· 主题：${metadata.topic || '未设置'}`.slice(0, DESCRIPTION_LIMIT),
    type: 'daily_push',
    startsAt: nextRunAt,
    endsAt: nextRunAt,
    timezone: schedule.timezone,
    allDay: false,
    taskId: null,
    paperId: null,
    readOnly: true,
    revision: null,
    dailyPush: {
      scheduleId: schedule.id,
      scheduleName: schedule.name.slice(0, 200),
      occurrenceKey,
      state: 'planned',
      occurrenceStatus: null,
      occurrenceSource: null,
      runId: null,
      runStatus: null,
      localDateKey: null,
      topic: metadata.topic,
      language: metadata.language,
      sources: metadata.sources,
      lookbackDays: schedule.lookbackDays,
      outputFolder: metadata.outputFolder,
      cron: schedule.cron.slice(0, 200),
      timezone: schedule.timezone,
      artifact: null,
      obsidianRelativePath: null,
      delivery: null
    }
  })
}

/**
 * One stored slot. Status/reason come from the occurrence row, the Artifact and
 * the Obsidian relative path from the run ledger; the pushed body never enters
 * the calendar payload.
 */
function occurrenceDailyPushEvent(
  schedule: Schedule,
  occurrence: ScheduleOccurrence,
  outcome: DailyPushRunOutcome | null
): CalendarEvent {
  const metadata = dailyPushMetadata(schedule)
  const label = occurrenceStatusLabels[occurrence.status] ?? occurrence.status
  const detail = occurrence.reason.length > 0 ? occurrence.reason.slice(0, REASON_LIMIT) : null
  const delivery = outcome?.delivery ?? null
  const description = `每日推送 ${label} · ${occurrence.localDateKey}`
    + (detail === null ? '' : ` · ${detail}`)
    + (delivery?.status === 'written' && delivery.relativePath !== null ? ` · Obsidian：${delivery.relativePath}` : '')
    + (delivery?.status === 'skipped' && delivery.message !== null ? ` · 未写入：${delivery.message}` : '')
  return CalendarEventSchema.parse({
    id: dailyPushVirtualEventId(schedule.id, occurrence.id),
    projectId: schedule.projectId,
    title: (outcome?.artifact?.title ?? `${schedule.name} · ${occurrence.localDateKey}`).slice(0, 500),
    description: description.slice(0, DESCRIPTION_LIMIT),
    type: 'daily_push',
    startsAt: occurrence.occurrenceAt,
    endsAt: occurrence.occurrenceAt,
    timezone: schedule.timezone,
    allDay: false,
    taskId: null,
    paperId: null,
    readOnly: true,
    revision: null,
    dailyPush: {
      scheduleId: schedule.id,
      scheduleName: schedule.name.slice(0, 200),
      occurrenceKey: occurrence.id,
      state: 'occurred',
      occurrenceStatus: occurrence.status,
      occurrenceSource: occurrence.source,
      runId: occurrence.runId,
      runStatus: outcome?.status ?? null,
      localDateKey: occurrence.localDateKey.slice(0, 20),
      topic: metadata.topic,
      language: metadata.language,
      sources: metadata.sources,
      lookbackDays: schedule.lookbackDays,
      outputFolder: metadata.outputFolder,
      cron: schedule.cron.slice(0, 200),
      timezone: schedule.timezone,
      artifact: outcome?.artifact ?? null,
      obsidianRelativePath: delivery?.status === 'written' ? delivery.relativePath : null,
      delivery: delivery === null ? null : {
        status: delivery.status,
        reason: delivery.reason,
        message: delivery.message
      }
    }
  })
}
