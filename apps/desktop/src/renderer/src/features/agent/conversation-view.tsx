import { AlertTriangle, Bot, ChevronDown, CircleDot, Info, Layers, Package, UserRound, Wrench } from 'lucide-react'
import { useMemo } from 'react'
import type { AgentRunRecordEntry, AgentRuntimeKind } from '@prw/contracts'
import { MarkdownPreview } from '../../components/markdown-editor'
import { cn } from '../../lib/utils'
import {
  collapse,
  firstLine,
  formatClock,
  formatDuration,
  groupRecordsByRun,
  recordKindLabels,
  safeDisplayContent,
  statusTone,
  usageSummary,
  type LedgerRun,
  type LedgerTurn
} from './ledger'

const runtimeLabels: Record<AgentRuntimeKind, string> = { pi: 'Pi' }

/**
 * Chat tab: a run-grouped projection of the ledger.
 *
 * A conversation is a sequence of runs — one per user message — and every run
 * restarts turn numbering at 0. Rendering the flat ledger grouped by `turn`
 * therefore collapsed the whole conversation into "all of your messages, then
 * all of the replies", which is exactly the layout the user reported as broken.
 * The ledger is instead rendered as run → turn → record, so each question stays
 * adjacent to its own answer no matter how long the conversation grows.
 *
 * Assistant text keeps using the existing MarkdownPreview component — the "no
 * new dependency" rule for this change means no new renderer, not dropping the
 * renderer the app already ships.
 */
export function ConversationView({ records, runtime, isRunning }: {
  readonly records: readonly AgentRunRecordEntry[]
  readonly runtime: AgentRuntimeKind
  readonly isRunning: boolean
}): React.JSX.Element {
  const runs = useMemo(() => groupRecordsByRun(records), [records])
  if (records.length === 0) {
    return <p className="agent-thread-empty-copy">这是一段新对话，发送第一条消息即可开始。</p>
  }
  return <div className="agent-ledger-stream">
    {runs.map((run, index) => <RunBlock
      isRunning={isRunning}
      key={run.runId}
      run={run}
      runtime={runtime}
      showHeading={runs.length > 1}
      turnOffset={runs.slice(0, index).reduce((total, previous) => total + previous.turns.length, 0)}
    />)}
  </div>
}

/**
 * One run: its user message, then every turn it produced.
 *
 * The heading is only rendered for a multi-run conversation; a single run needs
 * no "运行 1" label, and adding one would push the first reply down for no
 * information.
 */
function RunBlock({ run, runtime, isRunning, showHeading, turnOffset }: {
  readonly run: LedgerRun
  readonly runtime: AgentRuntimeKind
  readonly isRunning: boolean
  readonly showHeading: boolean
  readonly turnOffset: number
}): React.JSX.Element {
  return <section className="agent-run" data-run-id={run.runId}>
    {showHeading ? <div className="agent-run-heading">
      <span className="agent-run-label">运行 {turnOffset + 1}</span>
      <span className="agent-run-metric">{formatClock(run.startedAt)}</span>
      <span className="agent-run-metric">{formatDuration(run.durationMs)}</span>
      {run.usage ? <span className="agent-run-metric">{usageSummary(run.usage)}</span> : null}
    </div> : null}
    {run.turns.map((turn) => <TurnBlock
      isRunning={isRunning}
      key={turn.turn}
      runtime={runtime}
      showDivider={turn.turn > 0}
      turn={turn}
    />)}
  </section>
}

/**
 * One turn.
 *
 * Turn 0 carries the user message that started the run, so it gets no divider:
 * the message itself is the visual boundary. Later turns are reported as "the
 * agent continued without a new prompt" and do need one.
 */
function TurnBlock({ turn, runtime, isRunning, showDivider }: {
  readonly turn: LedgerTurn
  readonly runtime: AgentRuntimeKind
  readonly isRunning: boolean
  readonly showDivider: boolean
}): React.JSX.Element {
  const endsOnly = turn.records.every((record) => record.kind === 'turn_end' && !record.detail)
  return <div className="agent-turn">
    {showDivider && !endsOnly ? <div className="agent-turn-divider">
      <span className="agent-turn-label">Turn {turn.turn}</span>
      <span className="agent-turn-metric">{formatDuration(turn.durationMs)}</span>
      <span className="agent-turn-metric">{usageSummary(turn.usage)}</span>
    </div> : null}
    <RecordList isRunning={isRunning} records={turn.records} runtime={runtime} />
  </div>
}

function RecordList({ records, runtime, isRunning }: {
  readonly records: readonly AgentRunRecordEntry[]
  readonly runtime: AgentRuntimeKind
  readonly isRunning: boolean
}): React.JSX.Element {
  const keys = useMemo(() => new Set(records.map((record) => record.recordKey)), [records])
  const children = useMemo(() => {
    const grouped = new Map<string, AgentRunRecordEntry[]>()
    for (const record of records) {
      if (!record.parentId || !keys.has(record.parentId)) continue
      const bucket = grouped.get(record.parentId)
      if (bucket) bucket.push(record)
      else grouped.set(record.parentId, [record])
    }
    return grouped
  }, [keys, records])
  return <>
    {records
      .filter((record) => !record.parentId || !keys.has(record.parentId))
      .map((record) => <RecordRow
        isRunning={isRunning}
        key={record.id}
        nested={children.get(record.recordKey) ?? []}
        record={record}
        runtime={runtime}
      />)}
  </>
}

/**
 * Every record kind the ledger can produce, rendered explicitly.
 *
 * `system`, `context` and `compacted` were previously folded into the generic
 * fallback note, which made a context compaction indistinguishable from an
 * ordinary log line even though it changes what the model can still see.
 */
function RecordRow({ record, runtime, isRunning, nested }: {
  readonly record: AgentRunRecordEntry
  readonly runtime: AgentRuntimeKind
  readonly isRunning: boolean
  readonly nested: readonly AgentRunRecordEntry[]
}): React.JSX.Element | null {
  if (record.kind === 'user') {
    return <article className="agent-message-row agent-message-user">
      <div className="agent-message-meta">
        <span className="agent-message-avatar"><UserRound aria-hidden="true" className="size-3.5" /></span>
        <strong>你</strong>
        <time dateTime={record.createdAt}>{formatClock(record.createdAt)}</time>
      </div>
      <p>{safeDisplayContent(record.detail)}</p>
    </article>
  }
  if (record.kind === 'assistant') {
    const tone = statusTone(record.status)
    return <article className="agent-message-row agent-message-assistant">
      <div className="agent-message-meta">
        <span className="agent-message-avatar"><Bot aria-hidden="true" className="size-3.5" /></span>
        <strong>{runtimeLabels[runtime]}</strong>
        {record.durationMs === null ? null : <span className="agent-meta-chip">{formatDuration(record.durationMs)}</span>}
        <CircleDot aria-hidden="true" className={cn('agent-meta-dot', `agent-tone-${tone}`)} />
        <span className="agent-meta-chip">{recordStatusLabel(record)}</span>
      </div>
      <div className="agent-stream-body">
        {record.detail
          ? <MarkdownPreview className="agent-markdown" source={safeDisplayContent(record.detail)} />
          : <p className="agent-ledger-placeholder">{isRunning ? '正在生成…' : '本次运行没有输出文本。'}</p>}
        {isRunning && record.status === 'running' ? <span aria-hidden="true" className="agent-stream-cursor" /> : null}
      </div>
    </article>
  }
  if (record.kind === 'reasoning') {
    return <details className="agent-think">
      <summary className="agent-think-summary">
        <ChevronDown aria-hidden="true" className="agent-think-chevron" />
        <span className="agent-think-label">{record.title || 'Thinking'}</span>
        <span className="agent-meta-chip">{formatDuration(record.durationMs)}</span>
        <span className="agent-meta-chip">{recordStatusLabel(record)}</span>
      </summary>
      <pre className="agent-think-body">{record.detail || '未提供推理文本。'}</pre>
    </details>
  }
  if (record.kind === 'tool' || record.kind === 'subtool') {
    return <ToolCard isRunning={isRunning} nested={nested} record={record} />
  }
  if (record.kind === 'error') {
    return <div className="agent-ledger-error" role="alert">
      <AlertTriangle aria-hidden="true" className="size-3.5" />
      <div>
        <strong>{record.title || '运行错误'}</strong>
        <pre className="agent-ledger-pre">{record.detail || record.outputText || '未提供错误详情。'}</pre>
      </div>
    </div>
  }
  if (record.kind === 'compacted' || record.kind === 'system' || record.kind === 'context') {
    return <LifecycleNote record={record} />
  }
  if (record.kind === 'diagnostic') {
    const tone = statusTone(record.status)
    return <details className={cn('agent-diagnostic', `agent-diagnostic-${tone}`)}>
      <summary className="agent-diagnostic-summary">
        <ChevronDown aria-hidden="true" className="agent-diagnostic-chevron" />
        <span className="agent-diagnostic-label">{record.title || recordKindLabels[record.kind]}</span>
        <span className="agent-meta-chip">{formatClock(record.createdAt)}</span>
      </summary>
      {record.detail ? <pre className="agent-ledger-pre">{record.detail}</pre> : null}
      {record.outputText ? <pre className="agent-ledger-pre agent-ledger-pre-raw">{record.outputText}</pre> : null}
    </details>
  }
  if (record.kind === 'turn_end') {
    if (!record.detail) return null
    return <p className="agent-ledger-note">运行以 {recordStatusLabel(record)} 结束：{safeDisplayContent(record.detail)}</p>
  }
  const summary = record.detail ? firstLine(record.detail) : record.recordKey
  return <p className="agent-ledger-note">
    <strong>{record.title || recordKindLabels[record.kind]}</strong>
    {' · '}{summary}
  </p>
}

/**
 * Context lifecycle notes: a compaction, an injected system message or a new
 * context item. These are informational only, and the icon differs so a
 * compaction (which permanently drops earlier detail from the model's view) is
 * not mistaken for a routine context injection.
 */
function LifecycleNote({ record }: { readonly record: AgentRunRecordEntry }): React.JSX.Element {
  const Icon = record.kind === 'compacted' ? Package : record.kind === 'context' ? Layers : Info
  return <p className="agent-ledger-lifecycle" data-kind={record.kind}>
    <Icon aria-hidden="true" className="size-3.5" />
    <strong>{record.title || recordKindLabels[record.kind]}</strong>
    <span>{firstLine(record.detail || record.outputText || '（无补充说明）')}</span>
    <time dateTime={record.createdAt}>{formatClock(record.createdAt)}</time>
  </p>
}

function ToolCard({ record, isRunning, nested }: {
  readonly record: AgentRunRecordEntry
  readonly isRunning: boolean
  readonly nested: readonly AgentRunRecordEntry[]
}): React.JSX.Element {
  const tone = statusTone(record.status)
  return <details className={cn('agent-tool-card', `agent-tool-card-${tone}`)}>
    <summary className="agent-tool-summary">
      <Wrench aria-hidden="true" className="size-3.5" />
      <span className="agent-tool-name">{record.toolName ?? record.title ?? '工具'}</span>
      <span className="agent-tool-detail">{collapse(record.detail) || recordStatusLabel(record)}</span>
      <span className={cn('agent-status-dot', `agent-status-dot-${tone}`)} />
      <span className="agent-tool-duration">{formatDuration(record.durationMs)}</span>
      <ChevronDown aria-hidden="true" className="agent-tool-chevron" />
    </summary>
    <div className="agent-tool-body">
      {record.step > 0 ? <p className="agent-tool-meta">第 {record.step} 步 · {recordStatusLabel(record)} · {formatClock(record.startedAt ?? record.createdAt)}</p> : null}
      {record.inputText ? <RecordBlock label="Input" text={record.inputText} /> : null}
      {record.outputText ? <RecordBlock label="Output" text={record.outputText} /> : null}
      {!record.inputText && !record.outputText ? <p className="agent-ledger-note">该步骤没有提供输入或输出摘要。</p> : null}
      {record.truncated ? <p className="agent-ledger-note">内容超出单条 64KB 上限，已截断保存。</p> : null}
    </div>
    {nested.length > 0 ? <div className="agent-subtool-list">
      {nested.map((child) => <ToolCard isRunning={isRunning} key={child.id} nested={[]} record={child} />)}
    </div> : null}
  </details>
}

function RecordBlock({ label, text }: { readonly label: string; readonly text: string }): React.JSX.Element {
  return <div className="agent-record-block">
    <p className="agent-record-block-label">{label}</p>
    <pre className="agent-record-block-text">{text}</pre>
  </div>
}

function recordStatusLabel(record: AgentRunRecordEntry): string {
  if (record.kind === 'turn_end' && record.status === 'completed') return '完成'
  if (record.status === 'info') return record.kind === 'assistant' ? '生成中' : '信息'
  if (record.status === 'running') return '进行中'
  if (record.status === 'failed') return '失败'
  if (record.status === 'canceled') return '已取消'
  return '完成'
}
