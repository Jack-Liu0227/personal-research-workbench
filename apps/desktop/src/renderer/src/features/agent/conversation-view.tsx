import { AlertTriangle, Bot, ChevronDown, CircleDot, UserRound, Wrench } from 'lucide-react'
import { useMemo } from 'react'
import type { AgentRunRecordEntry, AgentRuntimeKind } from '@prw/contracts'
import { MarkdownPreview } from '../../components/markdown-editor'
import { cn } from '../../lib/utils'
import {
  collapse,
  firstLine,
  formatClock,
  formatDuration,
  groupRecordsByTurn,
  recordKindLabels,
  safeDisplayContent,
  statusTone,
  usageSummary
} from './ledger'

const runtimeLabels: Record<AgentRuntimeKind, string> = { codex: 'Codex', pi: 'Pi' }

/**
 * Chat tab: a Turn-grouped projection of the ledger.
 *
 * Assistant text keeps using the existing MarkdownPreview component — the
 * "no new dependency" rule for this change means no new renderer, not dropping
 * the renderer the app already ships.
 */
export function ConversationView({ records, runtime, isRunning }: {
  readonly records: readonly AgentRunRecordEntry[]
  readonly runtime: AgentRuntimeKind
  readonly isRunning: boolean
}): React.JSX.Element {
  const turns = useMemo(() => groupRecordsByTurn(records), [records])
  if (records.length === 0) {
    return <p className="agent-thread-empty-copy">这是一段新对话，发送第一条消息即可开始。</p>
  }
  return <div className="agent-ledger-stream">
    {turns.map((turn) => <section className="agent-turn" key={turn.turn}>
      {turn.turn > 0 ? <div className="agent-turn-divider">
        <span className="agent-turn-label">Turn {turn.turn}</span>
        <span className="agent-turn-metric">{formatDuration(turn.durationMs)}</span>
        <span className="agent-turn-metric">{usageSummary(turn.usage)}</span>
      </div> : null}
      <RecordList records={turn.records} runtime={runtime} isRunning={isRunning} />
    </section>)}
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
      {record.detail
        ? <MarkdownPreview source={safeDisplayContent(record.detail)} />
        : <p className="agent-ledger-placeholder">{isRunning ? '正在生成…' : '本次运行没有输出文本。'}</p>}
      {isRunning && record.status === 'running' ? <span aria-hidden="true" className="agent-stream-cursor" /> : null}
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
