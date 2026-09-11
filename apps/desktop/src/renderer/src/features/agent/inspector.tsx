import { X } from 'lucide-react'
import type { AgentRunRecordEntry } from '@prw/contracts'
import { Button } from '../../components/ui'
import { ResearchPanel } from '../research/shared'
import { formatClock, formatDuration, recordKindLabels, recordStatusLabels, usageSummary } from './ledger'

/**
 * Read-only record inspector for the trajectory tab.
 *
 * The eyebrow is deliberately `INSPECTOR / RECORD`: the packaged smoke test
 * asserts that the retired `INSPECTOR / CONTEXT` copy no longer appears
 * anywhere in the Agent page.
 */
export function TrajectoryRecordInspector({ record, onClose }: {
  readonly record: AgentRunRecordEntry
  readonly onClose: () => void
}): React.JSX.Element {
  const isRaw = record.kind === 'diagnostic' || record.kind === 'context'
  return <ResearchPanel
    action={<Button aria-label="关闭记录详情" onClick={onClose} size="icon" variant="ghost"><X aria-hidden="true" className="size-4" /></Button>}
    className="agent-inspector-panel"
    eyebrow="INSPECTOR / RECORD"
    title={record.title || recordKindLabels[record.kind]}
  >
    <div className="agent-inspector-body">
      <dl className="agent-inspector-grid">
        <Detail label="序号" value={`#${record.seq}`} />
        <Detail label="类型" value={`${recordKindLabels[record.kind]} · ${recordStatusLabels[record.status]}`} />
        <Detail label="Turn / Step" value={`${record.turn || '—'} / ${record.step || '—'}`} />
        <Detail label="记录键" value={record.recordKey} />
        <Detail label="开始" value={formatClock(record.startedAt ?? record.createdAt)} />
        <Detail label="结束" value={record.finishedAt ? formatClock(record.finishedAt) : '—'} />
        <Detail label="耗时" value={formatDuration(record.durationMs)} />
        <Detail label="工具" value={record.toolName ?? '—'} />
        <Detail label="调用 ID" value={record.callId ?? '—'} />
        <Detail label="父记录" value={record.parentId ?? '—'} />
        <Detail label="用量" value={usageSummary(record.usage)} />
      </dl>
      {record.detail ? <Section label="Detail" text={record.detail} /> : null}
      {record.inputText ? <Section label="Input" text={record.inputText} /> : null}
      {record.outputText ? <Section label="Output" text={record.outputText} /> : null}
      {isRaw && record.outputText ? <Section label="原始摘要" text={record.outputText} /> : null}
      {!record.detail && !record.inputText && !record.outputText ? <p className="agent-ledger-note">这条记录没有可展示的正文。</p> : null}
      {record.truncated ? <p className="agent-ledger-note">内容超出单条 64KB 上限，已截断保存。</p> : null}
    </div>
  </ResearchPanel>
}

function Detail({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return <div className="agent-inspector-field">
    <dt>{label}</dt>
    <dd title={value}>{value}</dd>
  </div>
}

function Section({ label, text }: { readonly label: string; readonly text: string }): React.JSX.Element {
  return <section className="agent-inspector-section">
    <p className="instrument-label">{label}</p>
    <pre className="agent-record-block-text">{text}</pre>
  </section>
}
