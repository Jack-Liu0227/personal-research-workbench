import type {
  AgentInboxItem,
  AgentRunStatus,
  ArtifactKind,
  AutomationRunHistoryEntry,
  PaperReadStatus,
  ResearchArtifact,
  ScheduleOccurrenceStatus
} from '@prw/contracts'

/**
 * Dashboard projection of real Agent / daily-push records.
 *
 * The overview page never invents a record, a title, a count or a success
 * state. Every row it renders comes from one of three query-backed sources:
 * the local `research_artifacts` table, the local Agent inbox table, and the
 * scheduled-run ledger (`automation.runs.history`) that carries the real
 * run status, the rule that owns it and the Obsidian delivery outcome.
 *
 * This module is the single place where those records are joined and turned
 * into display strings. Two rules follow from the task doc:
 *
 * - a scheduled run that never produced a push is *labelled as such* instead of
 *   being shown with an invented status, path or success badge, and
 * - a record with no matching ledger row says that the ledger has no entry for
 *   it (it may be a manual run or a deleted history row) rather than guessing
 *   which of the two it is.
 *
 * Everything here is pure so the regression tests in
 * `apps/desktop/test/dashboard-push.test.ts` can pin the honest-vs-fabricated
 * distinction without a renderer.
 */

/** Artifact kinds are a closed contract enum; every value needs a label (the
 * `Record<ArtifactKind, string>` type makes a missing key a type error). */
export const ARTIFACT_KIND_LABELS: Record<ArtifactKind, string> = {
  daily_digest: '每日资讯',
  paper_summary: '论文摘要',
  literature_review: '文献综述',
  research_idea: '研究想法',
  research_plan: '研究计划',
  outline: '提纲',
  manuscript: '文稿'
}

export const ARTIFACT_STATUS_LABELS: Record<ResearchArtifact['status'], string> = {
  draft: '草稿',
  review: '待审阅',
  final: '已定稿',
  archived: '已归档'
}

/**
 * Paper read states. Kept separate from the generic status map in
 * `features/research/shared.tsx`, where `queued` means "queued sync/run" and
 * would mislabel a queued paper as 排队中 instead of 待读.
 */
export const PAPER_READ_STATUS_LABELS: Record<PaperReadStatus, string> = {
  inbox: '待整理',
  queued: '待读',
  reading: '精读中',
  read: '已读',
  archived: '已归档'
}

/** Inbox rows reuse the artifact-kind vocabulary and add the two non-artifact
 * records the coordinator can create. */
export const INBOX_KIND_LABELS: Record<AgentInboxItem['kind'], string> = {
  ...ARTIFACT_KIND_LABELS,
  approval: '待审批',
  failure: '失败'
}

/** Run statuses mirror `automation.tsx`; typed against the contract enum so a
 * new status cannot silently render as a raw token. */
export const AGENT_RUN_STATUS_LABELS: Record<AgentRunStatus, string> = {
  planned: '已计划',
  queued: '排队中',
  running: '运行中',
  waiting_confirmation: '等待审批',
  completed: '完成',
  partial: '部分完成',
  failed: '失败',
  canceled: '已取消',
  blocked: '已阻断',
  missed: '错过时间点'
}

export const SCHEDULE_OCCURRENCE_STATUS_LABELS: Record<ScheduleOccurrenceStatus, string> = {
  claimed: '时间点已认领',
  running: '时间点执行中',
  completed: '时间点完成',
  failed: '时间点失败',
  blocked: '时间点阻断',
  canceled: '时间点取消',
  missed: '时间点错过',
  skipped: '时间点跳过'
}

/** The read flag is the authority for read state; the kind only names the
 * record type, so a failure record is never labelled "未读" again. */
export function inboxReadLabel(read: boolean): string {
  return read ? '已读' : '未读'
}

export interface DashboardPushSource {
  readonly runId: string
  readonly scheduleId: string
  /** Real rule name resolved from `automation.rules`; falls back to the short
   * id only because the rule may have been archived after the run. */
  readonly scheduleName: string
  readonly runStatus: AgentRunStatus
  readonly occurrenceStatus: ScheduleOccurrenceStatus | null
  /** The slot the run belongs to (`occurrenceAt`) and when it actually started.
   * Both come from the ledger; the display picks whichever the run recorded. */
  readonly occurrenceAt: string | null
  readonly startedAt: string
  readonly blockedReason: string | null
  readonly delivery: AutomationRunHistoryEntry['delivery']
  readonly artifactId: string | null
}

export interface DashboardPushLedger {
  /** Artifact id → the newest ledger entry that produced it. */
  readonly byArtifactId: ReadonlyMap<string, DashboardPushSource>
  /** Run id → the same entry, so an inbox row can resolve its source by run. */
  readonly byRunId: ReadonlyMap<string, DashboardPushSource>
  readonly entries: readonly DashboardPushSource[]
}

function toPushSource(
  entry: AutomationRunHistoryEntry,
  scheduleName: (scheduleId: string) => string
): DashboardPushSource {
  return {
    runId: entry.runId,
    scheduleId: entry.scheduleId,
    scheduleName: scheduleName(entry.scheduleId),
    runStatus: entry.status,
    occurrenceStatus: entry.occurrenceStatus,
    occurrenceAt: entry.occurrenceAt,
    startedAt: entry.startedAt,
    blockedReason: entry.blockedReason,
    delivery: entry.delivery,
    artifactId: entry.artifact?.id ?? null
  }
}

/**
 * Index the scheduled-run ledger by artifact and by run.
 *
 * Entries arrive newest-first from the service; the first match wins so a
 * re-run of the same rule never makes an older delivery overwrite today's.
 */
export function buildPushLedger(
  entries: readonly AutomationRunHistoryEntry[],
  scheduleName: (scheduleId: string) => string
): DashboardPushLedger {
  const byArtifactId = new Map<string, DashboardPushSource>()
  const byRunId = new Map<string, DashboardPushSource>()
  const sources: DashboardPushSource[] = []
  for (const entry of entries) {
    const source = toPushSource(entry, scheduleName)
    sources.push(source)
    if (!byRunId.has(source.runId)) byRunId.set(source.runId, source)
    if (source.artifactId && !byArtifactId.has(source.artifactId)) byArtifactId.set(source.artifactId, source)
  }
  return { byArtifactId, byRunId, entries: sources }
}

export function pushSourceForArtifact(ledger: DashboardPushLedger, artifactId: string): DashboardPushSource | null {
  return ledger.byArtifactId.get(artifactId) ?? null
}

export function pushSourceForRun(ledger: DashboardPushLedger, runId: string | null): DashboardPushSource | null {
  return runId === null ? null : ledger.byRunId.get(runId) ?? null
}

export interface DashboardSourceSummary {
  /** True only when a real ledger row describes this record. */
  readonly matched: boolean
  readonly headline: string
  readonly details: readonly string[]
}

/**
 * Describe a record's push source without inventing one.
 *
 * `matched: false` means the scheduled-run ledger has no row for this record:
 * it may belong to a manual/chat run, or its history row may have been deleted.
 * Both facts are indistinguishable from the loaded projection, so the summary
 * states exactly that instead of claiming a success, a skip reason or a path.
 */
export function summarizePushSource(source: DashboardPushSource | null, formatTime: (value: string) => string = (value) => value): DashboardSourceSummary {
  if (!source) {
    return {
      matched: false,
      headline: '来源：定时推送记录中没有该条目（手动运行，或运行历史已删除）',
      details: ['未显示投递状态与相对路径：本地没有对应记录。']
    }
  }
  const occurrence = source.occurrenceStatus
    ? ` · ${SCHEDULE_OCCURRENCE_STATUS_LABELS[source.occurrenceStatus]}`
    : ''
  const details: string[] = [`执行时间点：${formatTime(source.occurrenceAt ?? source.startedAt)}`]
  if (source.blockedReason) details.push(`阻断/失败原因：${source.blockedReason}`)
  if (!source.delivery) {
    details.push('本次运行没有记录 Obsidian 投递结果。')
  } else if (source.delivery.status === 'written') {
    details.push(`Obsidian 已写入 · ${source.delivery.relativePath ?? '（未返回相对路径）'}`)
  } else {
    const reason = source.delivery.reason ?? source.delivery.message ?? '未说明原因'
    details.push(`Obsidian 未写入（${reason}）${source.delivery.message && source.delivery.reason ? `：${source.delivery.message}` : ''}`)
  }
  return {
    matched: true,
    headline: `来源：定时推送 · ${source.scheduleName} · ${AGENT_RUN_STATUS_LABELS[source.runStatus]}${occurrence}`,
    details
  }
}

/** First meaningful line of a real artifact/inbox body, used as the row summary.
 * Returns an empty string when the record has no body, so the row omits the
 * summary instead of showing placeholder prose. */
export function firstMeaningfulLine(text: string, limit = 140): string {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/^[#>\-*\s]+/u, '').trim()
    if (line.length > 0) return line.length > limit ? `${line.slice(0, limit)}…` : line
  }
  return ''
}

export interface DashboardInboxRow {
  readonly item: AgentInboxItem
  readonly source: DashboardPushSource | null
}

/**
 * The Agent-inbox card shows the join of the real inbox table with the real
 * daily-push ledger. Rows whose `runId` resolves to a ledger entry carry that
 * entry's rule name, run status, time point, delivery outcome and failure
 * reason; the remaining rows are kept visible but explicitly listed as having
 * no push record, because the loaded projection cannot tell a manual/chat run
 * apart from a deleted history row.
 */
export interface DashboardInboxJoin {
  readonly matched: readonly DashboardInboxRow[]
  readonly unmatched: readonly DashboardInboxRow[]
  /** `null` when every loaded row is explained by the ledger. */
  readonly unmatchedNote: string | null
}

export function joinInboxWithPushLedger(
  ledger: DashboardPushLedger,
  items: readonly AgentInboxItem[]
): DashboardInboxJoin {
  const matched: DashboardInboxRow[] = []
  const unmatched: DashboardInboxRow[] = []
  for (const item of items) {
    const source = pushSourceForRun(ledger, item.runId)
    if (source) matched.push({ item, source })
    else unmatched.push({ item, source: null })
  }
  return {
    matched,
    unmatched,
    unmatchedNote: unmatched.length === 0
      ? null
      : `另有 ${unmatched.length} 条收件箱记录在定时推送运行历史中没有对应条目（手动运行，或运行历史已删除），因此不显示推送状态与 Obsidian 相对路径。`
  }
}

/**
 * Honest empty state for the artifacts card. The count comes from the loaded
 * ledger, so the copy changes with real data instead of being a fixed sentence.
 */
export function artifactsCardEmptyText(pushEntryCount: number): string {
  return pushEntryCount === 0
    ? '本地科研产物表与定时推送记录都是空的：完成一次 Agent 运行或每日推送后，这里会显示产物摘要、真实状态、来源规则与 Obsidian 相对路径。'
    : `已加载 ${pushEntryCount} 条定时推送记录，但还没有可展示的科研产物；请到定时任务页查看这些运行的阻断原因与投递结果。`
}

/** Honest empty state for the inbox card, using the same real ledger count. */
export function inboxCardEmptyText(pushEntryCount: number): string {
  return pushEntryCount === 0
    ? '本地 Agent 收件箱没有未读结果，定时推送记录也是空的：运行一次 Agent 或每日推送后，这里会显示摘要、真实状态、来源规则与 Obsidian 相对路径。'
    : `已加载 ${pushEntryCount} 条定时推送记录，但收件箱没有未读结果；已读条目与历史运行请在 Agent 页查看。`
}
