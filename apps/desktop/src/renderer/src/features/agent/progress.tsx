import { cn } from '../../lib/utils'
import { formatDuration, runStats, stepSummary, usageSummary, type LedgerStats } from './ledger'
import type { AgentRunRecordEntry } from '@prw/contracts'

export type RealtimeState = 'unsupported' | 'subscribed' | 'live'

const realtimeLabels: Record<RealtimeState, string> = {
  unsupported: '实时通道不可用（轮询）',
  subscribed: '实时通道已订阅',
  live: '实时通道已连接'
}

/**
 * Read-only step strip.
 *
 * It is derived from tool records that actually happened, never from a claimed
 * plan, and it disappears completely when the run produced no tool activity.
 */
export function StepStrip({ records, isRunning }: {
  readonly records: readonly AgentRunRecordEntry[]
  readonly isRunning: boolean
}): React.JSX.Element | null {
  const summary = stepSummary(records)
  if (!summary) return null
  const stats = runStats(records)
  return <div aria-live="polite" className="agent-step-strip">
    <span className={cn('agent-status-dot', isRunning ? 'agent-status-dot-running' : 'agent-status-dot-done')} />
    <span className="agent-step-strip-current">
      本次运行步骤 {summary.index} · {summary.current.toolName ?? summary.current.title}
    </span>
    <span className="agent-step-strip-meta">已完成 {summary.completed} 步</span>
    <span className="agent-step-strip-meta">{formatDuration(stats.durationMs)}</span>
  </div>
}

export function StatsRow({ stats, realtime, isRunning }: {
  readonly stats: LedgerStats
  readonly realtime: RealtimeState
  readonly isRunning: boolean
}): React.JSX.Element {
  return <div className="agent-stats-row">
    <span className="agent-stats-item">{stats.turns} 个回合</span>
    <span className="agent-stats-item">{stats.tools} 次工具调用</span>
    <span className="agent-stats-item">耗时 {formatDuration(stats.durationMs)}</span>
    <span className="agent-stats-item">{usageSummary(stats.usage)}</span>
    <span className="agent-stats-spacer" />
    <span className={cn('agent-stats-realtime', `agent-stats-realtime-${realtime}`)}>
      <span className={cn('agent-status-dot', isRunning && realtime === 'live' ? 'agent-status-dot-running' : 'agent-status-dot-idle')} />
      {realtimeLabels[realtime]}
    </span>
  </div>
}
