import type { AgentRecordKind, AgentRecordStatus, AgentRunRecordEntry, AgentUsage } from '@prw/contracts'

/**
 * Presentation helpers for the normalized agent ledger.
 *
 * Everything in this file is a pure projection of `AgentRunRecordEntry`: the
 * renderer never parses raw CLI JSON again. The two label maps are typed as
 * `Record<...>` on purpose, so adding a ledger kind or status is a compile
 * error until the UI knows how to name it.
 */
export const recordKindLabels = {
  user: '用户',
  assistant: '助手',
  reasoning: '思考',
  tool: '工具',
  subtool: '子步骤',
  system: '系统',
  context: '上下文',
  diagnostic: '诊断',
  compacted: '压缩',
  error: '错误',
  turn_end: '回合'
} satisfies Record<AgentRecordKind, string>

export const recordStatusLabels = {
  info: '信息',
  running: '进行中',
  completed: '完成',
  failed: '失败',
  canceled: '已取消'
} satisfies Record<AgentRecordStatus, string>

export type LedgerTone = 'running' | 'done' | 'failed' | 'idle'

export function statusTone(status: AgentRecordStatus): LedgerTone {
  if (status === 'running') return 'running'
  if (status === 'failed') return 'failed'
  if (status === 'completed' || status === 'canceled') return 'done'
  return 'idle'
}

export function formatDuration(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (value < 1_000) return `${Math.round(value)}ms`
  const seconds = value / 1_000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${String(Math.round(seconds % 60)).padStart(2, '0')}s`
}

export function formatClock(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

const usageKeys = ['input', 'output', 'think', 'cacheRead', 'cacheWrite', 'total'] as const

/** Token accounting is shown as `—` unless the CLI actually reported numbers;
 * a missing value is never rendered as `0`. */
export function usageSummary(usage: AgentUsage | null): string {
  if (!usage) return '—'
  const parts: string[] = []
  if (usage.input !== null) parts.push(`in ${formatCount(usage.input)}`)
  if (usage.output !== null) parts.push(`out ${formatCount(usage.output)}`)
  if (usage.think !== null) parts.push(`think ${formatCount(usage.think)}`)
  if (usage.cacheRead !== null || usage.cacheWrite !== null) {
    parts.push(`cache ${formatCount((usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0))}`)
  }
  if (usage.total !== null) parts.push(`total ${formatCount(usage.total)}`)
  return parts.length > 0 ? parts.join(' · ') : '—'
}

export function sumUsage(usages: Iterable<AgentUsage | null>): AgentUsage | null {
  const total: AgentUsage = { input: null, output: null, think: null, cacheRead: null, cacheWrite: null, total: null }
  let reported = false
  for (const usage of usages) {
    if (!usage) continue
    for (const key of usageKeys) {
      const value = usage[key]
      if (value === null) continue
      total[key] = (total[key] ?? 0) + value
      reported = true
    }
  }
  return reported ? total : null
}

/**
 * Merge the persisted page with the streaming overlay. Records are keyed by
 * their database id, so a pushed update replaces the row it will eventually be
 * read back as instead of duplicating it.
 */
export function mergeRecords(
  base: readonly AgentRunRecordEntry[],
  overlay: Iterable<AgentRunRecordEntry>
): AgentRunRecordEntry[] {
  const byId = new Map<string, AgentRunRecordEntry>()
  for (const entry of base) byId.set(entry.id, entry)
  for (const entry of overlay) byId.set(entry.id, entry)
  return [...byId.values()].sort((left, right) =>
    Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.seq - right.seq)
}

export interface LedgerTurn {
  readonly turn: number
  readonly records: AgentRunRecordEntry[]
  readonly usage: AgentUsage | null
  readonly durationMs: number | null
}

/**
 * One run of the agent inside one conversation.
 *
 * A conversation is a sequence of runs (one per user prompt), and each run has
 * its own turn numbering starting at 0. Grouping by `turn` alone therefore
 * merged every user prompt in a conversation into a single leading block and
 * every reply into one trailing block, which read as "all your questions, then
 * all the answers". A run is the unit that actually has an order, so it is the
 * unit rendered here.
 */
export interface LedgerRun {
  readonly runId: string
  readonly turns: LedgerTurn[]
  readonly records: AgentRunRecordEntry[]
  readonly startedAt: string
  readonly usage: AgentUsage | null
  readonly durationMs: number | null
}

export function groupRecordsByTurn(records: readonly AgentRunRecordEntry[]): LedgerTurn[] {
  const groups = new Map<number, AgentRunRecordEntry[]>()
  for (const record of records) {
    const bucket = groups.get(record.turn)
    if (bucket) bucket.push(record)
    else groups.set(record.turn, [record])
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([turn, items]) => ({
      turn,
      records: items,
      usage: turnUsage(items),
      durationMs: turnDuration(items)
    }))
}

function turnUsage(items: readonly AgentRunRecordEntry[]): AgentUsage | null {
  return items.find((item) => item.kind === 'turn_end')?.usage ?? sumUsage(items.map((item) => item.usage))
}

function turnDuration(items: readonly AgentRunRecordEntry[]): number | null {
  return items.find((item) => item.kind === 'turn_end')?.durationMs ?? spanDuration(items)
}

/**
 * Group the conversation ledger into runs, preserving ledger order.
 *
 * Runs are ordered by their first record rather than by `runId`, because a
 * retry can produce a run whose id sorts before the run it replaces while its
 * records are strictly newer. Within a run, turns are ordered numerically and
 * records keep their `seq` order, so the renderer never has to re-sort
 * heuristically and a live push lands in the right place.
 */
export function groupRecordsByRun(records: readonly AgentRunRecordEntry[]): LedgerRun[] {
  const groups = new Map<string, AgentRunRecordEntry[]>()
  for (const record of records) {
    const bucket = groups.get(record.runId)
    if (bucket) bucket.push(record)
    else groups.set(record.runId, [record])
  }
  return [...groups.entries()]
    .map(([runId, items]) => {
      const ordered = [...items].sort((left, right) => left.seq - right.seq)
      return {
        runId,
        turns: groupRecordsByTurn(ordered),
        records: ordered,
        startedAt: ordered[0]?.createdAt ?? new Date(0).toISOString(),
        usage: runStats(ordered).usage,
        durationMs: runStats(ordered).durationMs
      }
    })
    .sort((left, right) =>
      Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.runId.localeCompare(right.runId))
}

export interface LedgerStats {
  readonly turns: number
  readonly tools: number
  readonly messages: number
  readonly usage: AgentUsage | null
  readonly durationMs: number | null
}

export function runStats(records: readonly AgentRunRecordEntry[]): LedgerStats {
  return {
    turns: records.filter((record) => record.kind === 'turn_end').length,
    tools: records.filter((record) => record.kind === 'tool').length,
    messages: records.filter((record) => record.kind === 'assistant').length,
    usage: sumUsage(records.map((record) => record.usage)),
    durationMs: spanDuration(records)
  }
}

export interface StepSummary {
  readonly current: AgentRunRecordEntry
  readonly index: number
  readonly completed: number
}

/** The read-only step strip is derived from tool records only. It deliberately
 * does not claim to be the agent's plan: it reports what already happened. */
export function stepSummary(records: readonly AgentRunRecordEntry[]): StepSummary | null {
  const tools = records.filter((record) => record.kind === 'tool' || record.kind === 'subtool')
  if (tools.length === 0) return null
  const current = [...tools].reverse().find((record) => record.status === 'running') ?? tools[tools.length - 1]
  if (!current) return null
  return {
    current,
    index: tools.length,
    completed: tools.filter((record) => record.status !== 'running').length
  }
}

/** One-line description used by trajectory rows and tool card headers. */
export function recordSummary(record: AgentRunRecordEntry): string {
  const detail = collapse(record.detail)
  const title = collapse(record.title)
  if (!title) return detail || record.recordKey
  if (!detail || detail === title || title.startsWith(detail)) return title
  return `${title} · ${detail}`
}

export function collapse(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

export function firstLine(value: string, limit = 400): string {
  const collapsed = collapse(value)
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`
}

function spanDuration(records: readonly AgentRunRecordEntry[]): number | null {
  let start: number | null = null
  let end: number | null = null
  for (const record of records) {
    const started = timestamp(record.startedAt) ?? timestamp(record.createdAt)
    if (started !== null) start = start === null ? started : Math.min(start, started)
    const finished = timestamp(record.finishedAt) ?? timestamp(record.createdAt)
    if (finished !== null) end = end === null ? finished : Math.max(end, finished)
  }
  return start === null || end === null ? null : Math.max(0, end - start)
}

function timestamp(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Defence in depth for the renderer: the ledger is already redacted and clipped
 * in Core, and these filters keep a known-bad payload from being rendered as if
 * it were a real agent answer.
 */
export function safeDisplayContent(content: string): string {
  const normalized = content.trim()
  if (/return exactly acceptance_redaction_restart_ok/i.test(normalized)) return '这条运行记录已被安全过滤。请重新发送任务以继续。'
  if (/no api key found|missing bearer|401 unauthorized|authentication required|not authenticated|login required|logged out/i.test(normalized)) return '运行未完成：模型凭据缺失或已失效，请在「设置 → 模型与 Agent」保存 API Key 或重新登录后重试。'
  if (/reconnecting|request timed out|connection failed|falling back from websockets|waiting for network/i.test(normalized)) return '运行未完成：模型连接超时或网络不可用，请检查凭据与网络后重试。'
  if (/not inside a trusted directory|invalidargument|cannot process argument/i.test(normalized)) return '运行未完成：当前工作目录未被运行时信任，请检查工作区设置后重试。'
  return content
}

export function safeDisplayTitle(title: string): string {
  if (/return exactly acceptance_redaction_restart_ok|no api key found|missing bearer|401 unauthorized|not authenticated/i.test(title)) return '已过滤的 Agent 运行记录'
  return title
}
