import type { AgentRecordKind, AgentRecordStatus, AgentRunRecordDraft, AgentUsage } from '@prw/contracts'

/** Individual diagnostic rows kept per run before output folds into one row. */
const maxDiagnosticRecords = 200
/** Characters retained once diagnostic output folds into one row. */
const maxDiagnosticTailChars = 16_000

/**
 * One adapter-owned ledger writer per run.
 *
 * The normalizer is deliberately stateful. A streamed assistant message has to
 * become *one* record that grows in place (the ledger keys it by `recordKey`
 * and only ever upserts), so the adapter must remember the turn/step counters
 * and the text it has already emitted for each open record.
 */
export interface LedgerNormalizer {
  /** Turn one stdout payload into records. An empty result means the payload
   * carried no user-visible information (for example a turn boundary, which the
   * trajectory renders from the turn number it already has). */
  accept(payload: unknown, createdAt: string): AgentRunRecordDraft[]
  /** Runtime diagnostics (stderr, MCP notices, retry loops) become diagnostic
   * records so a failed run can show the CLI's own reason instead of only the
   * generic failure message. */
  diagnostic(text: string, createdAt: string): AgentRunRecordDraft[]
  /** Close any still-open record when the process exits. */
  finish(status: LedgerStatus, createdAt: string): AgentRunRecordDraft[]
}

export type LedgerStatus = Extract<AgentRecordStatus, 'completed' | 'failed' | 'canceled'>

interface OpenRecord {
  readonly startedAt: number
  /** Kind and status of the last draft written for this key, so `finish` can
   * close only the records that are still marked as running. */
  readonly kind: AgentRecordKind
  status: AgentRecordStatus
  text: string
}

/** Shared bookkeeping for both CLI normalizers. */
export abstract class BaseLedgerNormalizer implements LedgerNormalizer {
  /** Current turn, `0` before the first turn boundary and for run-scoped
   * records such as the session banner. */
  protected turn = 0
  /** Step of the current turn: incremented once per tool call. */
  protected step = 0
  protected turnClosed = true
  /** Open records keyed by `recordKey`, which makes them the accumulator for
   * streamed text and the source of a tool's duration. */
  protected readonly open = new Map<string, OpenRecord>()
  private ordinal = 0
  private diagnosticOrdinal = 0
  private diagnosticTail = ''

  abstract accept(payload: unknown, createdAt: string): AgentRunRecordDraft[]

  diagnostic(text: string, createdAt: string): AgentRunRecordDraft[] {
    const trimmed = text.trim()
    if (!trimmed) return []
    // A chatty or hostile CLI can print unbounded stderr, and each line would
    // otherwise become a permanent row. The first lines are kept individually
    // for readability; everything after that accumulates into one record that
    // overwrites itself, bounded by the upstream per-line cap.
    if (this.diagnosticOrdinal >= maxDiagnosticRecords) {
      this.diagnosticTail = `${this.diagnosticTail}\n${trimmed}`.trim().slice(-maxDiagnosticTailChars)
      return [{
        recordKey: 'diagnostic:tail',
        kind: 'diagnostic',
        status: 'info',
        title: '运行时诊断（后续输出）',
        detail: this.diagnosticTail,
        startedAt: createdAt
      }]
    }
    return [{
      recordKey: `diagnostic:${this.diagnosticOrdinal++}`,
      kind: 'diagnostic',
      status: 'info',
      turn: this.turn,
      step: this.step,
      title: '运行时诊断',
      detail: trimmed,
      startedAt: createdAt
    }]
  }

  finish(status: LedgerStatus, createdAt: string): AgentRunRecordDraft[] {
    // A CLI that exits mid-step never sends the record's end event. Leaving
    // those records open would make a finished run render live spinners, so the
    // exit closes every record that is still running under the run's own
    // terminal status.
    const records = this.closeOpen(status, createdAt)
    if (this.turn !== 0 && !this.turnClosed) records.push(this.turnEndDraft(status, createdAt))
    return records
  }

  protected beginTurn(): void {
    this.turn += 1
    this.step = 0
    this.turnClosed = false
  }

  /** A run that never announced a turn boundary (plain-text output or a CLI
   * revision without the boundary event) joins turn 1 on first use. */
  protected currentTurn(): number {
    if (this.turn === 0) this.beginTurn()
    return this.turn
  }

  protected nextStep(): number {
    this.currentTurn()
    this.step += 1
    return this.step
  }

  /** Register a record on first sighting and report whether it is new, so a
   * later lifecycle update keeps the original start time and duration. The kind
   * and status are remembered for `finish`. */
  protected touch(recordKey: string, createdAt: string, kind: AgentRecordKind, status: AgentRecordStatus): boolean {
    const existing = this.open.get(recordKey)
    if (existing) {
      existing.status = status
      return false
    }
    this.open.set(recordKey, { startedAt: timestampOf(createdAt), kind, status, text: '' })
    return true
  }

  /** Current status of a tracked record, or `null` when it was never opened. */
  protected openStatus(recordKey: string): AgentRecordStatus | null {
    return this.open.get(recordKey)?.status ?? null
  }

  protected accumulate(recordKey: string, chunk: string, isDelta: boolean): string {
    const record = this.open.get(recordKey)
    if (!record) return chunk
    record.text = applyStreamText(record.text, chunk, isDelta)
    return record.text
  }

  protected durationOf(recordKey: string, createdAt: string): number | null {
    const record = this.open.get(recordKey)
    return record ? Math.max(0, timestampOf(createdAt) - record.startedAt) : null
  }

  protected uniqueKey(prefix: string): string {
    return `${prefix}:${this.ordinal++}`
  }

  /** Close every record still marked as running, then report them so the
   * ledger does not keep a spinner alive past the event that ended it. The
   * closing draft carries no turn/step: the repository keeps the values the
   * record was created with. */
  protected closeOpen(status: LedgerStatus, createdAt: string): AgentRunRecordDraft[] {
    const records: AgentRunRecordDraft[] = []
    for (const [recordKey, record] of this.open) {
      if (record.status !== 'running') continue
      const durationMs = this.durationOf(recordKey, createdAt)
      records.push({
        recordKey,
        kind: record.kind,
        status,
        finishedAt: createdAt,
        ...(durationMs === null ? {} : { durationMs })
      })
    }
    this.open.clear()
    return records
  }

  protected turnEnd(status: LedgerStatus, createdAt: string, detail = ''): AgentRunRecordDraft[] {
    this.turnClosed = true
    return [...this.closeOpen(status, createdAt), this.turnEndDraft(status, createdAt, detail)]
  }

  private turnEndDraft(status: LedgerStatus, createdAt: string, detail = ''): AgentRunRecordDraft {
    return {
      recordKey: `turn:${this.turn}`,
      kind: 'turn_end',
      status,
      turn: this.turn,
      step: this.step,
      title: `Turn ${this.turn} 结束`,
      detail,
      finishedAt: createdAt
    }
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

export function asFlag(value: unknown): boolean {
  return value === true
}

function timestampOf(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

/** Collapse a multi-line value into the single-line summary a trajectory row
 * shows, without losing the beginning of the text. */
export function oneLine(value: string, limit = 200): string {
  const collapsed = value.replace(/\s+/gu, ' ').trim()
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`
}

export function safeJson(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/** Read text out of the shapes both CLIs use: a bare string, a `{text}` /
 * `{thinking}` / `{delta}` block, or a nested array of those. */
export function ledgerText(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined || depth > 4) return ''
  if (Array.isArray(value)) {
    return value.map((entry) => ledgerText(entry, depth + 1)).join('')
  }
  const record = asRecord(value)
  if (!record) return ''
  for (const key of ['text', 'delta', 'thinking', 'content', 'output']) {
    const direct = record[key]
    if (typeof direct === 'string') return direct
    if (direct !== undefined) {
      const nested = ledgerText(direct, depth + 1)
      if (nested) return nested
    }
  }
  return ''
}

/**
 * An explicit delta is appended; anything else is an authoritative snapshot.
 * Pi sends `text_end`/`message_end` snapshots after its deltas and Codex sends
 * the full item text, so a snapshot may never be treated as an increment.
 */
export function applyStreamText(current: string, chunk: string, isDelta: boolean): string {
  if (!chunk) return current
  if (isDelta) return current + chunk
  return chunk.length >= current.length ? chunk : current
}

/**
 * Map the usage envelope of either CLI onto the ledger shape. Both runtimes
 * report token counts under different names, and a provider that does not
 * report them must end up as `null` (shown as `—`) instead of `0`.
 */
export function ledgerUsage(value: unknown): AgentUsage | null {
  const record = asRecord(value)
  if (!record) return null
  const pick = (...keys: string[]): number | null => {
    for (const key of keys) {
      const entry = record[key]
      if (typeof entry === 'number' && Number.isFinite(entry) && entry >= 0) return Math.round(entry)
    }
    return null
  }
  const usage: AgentUsage = {
    input: pick('input_tokens', 'input', 'prompt_tokens'),
    output: pick('output_tokens', 'output', 'completion_tokens'),
    think: pick('reasoning_output_tokens', 'reasoning', 'reasoning_tokens', 'think'),
    cacheRead: pick('cached_input_tokens', 'cache_read_input_tokens', 'cacheRead'),
    cacheWrite: pick('cache_write_input_tokens', 'cacheWrite', 'cache_write'),
    total: pick('total_tokens', 'totalTokens', 'total')
  }
  if (usage.total === null && usage.input !== null && usage.output !== null) usage.total = usage.input + usage.output
  return Object.values(usage).some((entry) => entry !== null) ? usage : null
}
