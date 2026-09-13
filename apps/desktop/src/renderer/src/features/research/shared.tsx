import type { AgentRun, SyncRun } from '@prw/contracts'
import { AlertCircle, CheckCircle2, Clock3, LoaderCircle, XCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { SelectionCheckbox } from '../../components/selection'
import { cn, formatDateTime, getErrorMessage } from '../../lib/utils'

const positiveStates = new Set(['completed', 'ready', 'enabled', 'final', 'read', 'synced'])
const activeStates = new Set(['running', 'syncing', 'queued', 'reading'])
const warningStates = new Set(['review', 'local_changed', 'remote_changed', 'not_configured'])
const negativeStates = new Set(['failed', 'error', 'conflict', 'canceled', 'deleted'])

const statusLabels: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
  ready: '已就绪',
  enabled: '已启用',
  syncing: '同步中',
  error: '异常',
  disabled: '已停用',
  not_configured: '未配置',
  draft: '草稿',
  review: '待审阅',
  final: '已定稿',
  archived: '已归档',
  inbox: '待整理',
  reading: '精读中',
  read: '已读',
  synced: '已同步',
  local_changed: '本地已变更',
  remote_changed: '外部已变更',
  conflict: '有冲突',
  deleted: '已删除'
}

export function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const Icon = positiveStates.has(status)
    ? CheckCircle2
    : negativeStates.has(status)
      ? XCircle
      : activeStates.has(status)
        ? LoaderCircle
        : warningStates.has(status)
          ? AlertCircle
          : Clock3
  return (
    <span className={cn(
      'research-status',
      positiveStates.has(status) && 'research-status-positive',
      activeStates.has(status) && 'research-status-active',
      warningStates.has(status) && 'research-status-warning',
      negativeStates.has(status) && 'research-status-negative'
    )}>
      <Icon aria-hidden="true" className={cn('size-3', activeStates.has(status) && status !== 'reading' && 'animate-spin motion-reduce:animate-none')} />
      {statusLabels[status] ?? status}
    </span>
  )
}

export function ResearchPanel({ title, eyebrow, action, children, className }: {
  title: string
  eyebrow?: string
  action?: ReactNode
  children: ReactNode
  className?: string | undefined
}): React.JSX.Element {
  return (
    <section className={cn('research-panel', className)}>
      <header className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div>
          {eyebrow ? <p className="instrument-label">{eyebrow}</p> : null}
          <h2 className={cn('font-bold text-foreground', eyebrow ? 'mt-0.5 text-sm' : 'text-sm')}>{title}</h2>
        </div>
        {action ? <div className="flex items-center gap-2">{action}</div> : null}
      </header>
      {children}
    </section>
  )
}

export function ResearchTabs<T extends string>({ items, value, onChange, label }: {
  items: Array<{ value: T; label: string; count?: number }>
  value: T
  onChange: (value: T) => void
  label: string
}): React.JSX.Element {
  return (
    <div aria-label={label} className="research-tabs" role="group">
      {items.map((item) => (
        <button
          aria-pressed={value === item.value}
          className={cn('research-tab', value === item.value && 'research-tab-active')}
          key={item.value}
          onClick={() => onChange(item.value)}
          type="button"
        >
          {item.label}
          {item.count !== undefined ? <span className="tabular-nums text-[10px] text-muted-foreground">{item.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

export function MutationFeedback({ error, success }: { error?: unknown; success?: string | undefined }): React.JSX.Element | null {
  if (error) return <p className="form-feedback form-feedback-error" role="alert">{getErrorMessage(error)}</p>
  if (success) return <p className="form-feedback form-feedback-success" role="status">{success}</p>
  return null
}

const workflowLabels: Record<AgentRun['workflowKey'], string> = {
  daily_digest: '每日精读',
  paper_summary: '单篇总结',
  literature_matrix: '文献矩阵',
  literature_review: '文献综述',
  research_ideation: '研究想法',
  research_plan: '研究方案',
  manuscript_draft: '论文草稿'
}

export function AgentRunList({ runs, emptyText = '尚无 Agent 运行记录', onCancel, cancelingId }: {
  runs: AgentRun[]
  emptyText?: string
  onCancel?: (run: AgentRun) => void
  cancelingId?: string | undefined
}): React.JSX.Element {
  if (runs.length === 0) return <p className="research-empty-inline">{emptyText}</p>
  return (
    <div className="divide-y divide-border">
      {runs.map((run) => (
        <article className="research-run-row" key={run.id}>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xs font-bold text-foreground">{workflowLabels[run.workflowKey]}</h3>
              <StatusBadge status={run.status} />
            </div>
            <p className="mt-1 truncate text-[11px] text-muted-foreground">
              {formatDateTime(run.startedAt ?? run.createdAt)}
              {run.paperIds.length > 0 ? ` · ${run.paperIds.length} 篇文献` : ''}
            </p>
            {run.error ? <p className="mt-1 overflow-wrap-anywhere text-xs text-danger">{run.error}</p> : null}
            {run.output ? <p className="mt-1 line-clamp-2 overflow-wrap-anywhere text-xs leading-5 text-muted-foreground">{run.output}</p> : null}
          </div>
          {onCancel && (run.status === 'queued' || run.status === 'running') ? (
            <button
              className="text-button-danger"
              disabled={cancelingId === run.id}
              onClick={() => onCancel(run)}
              type="button"
            >
              {cancelingId === run.id ? '取消中…' : '取消'}
            </button>
          ) : null}
        </article>
      ))}
    </div>
  )
}

const syncDirectionLabels: Record<SyncRun['direction'], string> = {
  both: '双向同步',
  pull: '拉取',
  push: '写入'
}

/** Human label of one sync run. It is the only identity a run has (no name),
 * so it is used for the row, the selection checkbox and the delete receipts. */
export function describeSyncRun(run: SyncRun): string {
  return `${syncDirectionLabels[run.direction]} · ${formatDateTime(run.startedAt)}`
}

/**
 * Settings → 最近同步 list.
 *
 * Every rendered run owns its checkbox when `selection` is provided, so a
 * "全选" claim can never include a row the user cannot see. The list renders
 * the whole loaded range (the caller states that exact boundary) instead of a
 * silent `slice`, which would let a bulk delete touch an invisible record.
 */
export function SyncRunList({
  emptyText = '尚无同步记录',
  rowAction,
  runs,
  selection
}: {
  emptyText?: string
  /** Optional per-row control, e.g. the single-record delete button. */
  rowAction?: (run: SyncRun) => ReactNode
  runs: SyncRun[]
  selection?: {
    selectedIds: ReadonlySet<string>
    onToggle: (id: string, checked: boolean) => void
  }
}): React.JSX.Element {
  if (runs.length === 0) return <p className="research-empty-inline">{emptyText}</p>
  return (
    <div className="divide-y divide-border">
      {runs.map((run) => (
        <article className="research-run-row" key={run.id}>
          {selection ? (
            <SelectionCheckbox
              ariaLabel={`选择同步记录：${describeSyncRun(run)}`}
              checked={selection.selectedIds.has(run.id)}
              onChange={(checked) => selection.onToggle(run.id, checked)}
              title={`选择同步记录：${describeSyncRun(run)}`}
            />
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold text-foreground">{syncDirectionLabels[run.direction]}</span>
              <StatusBadge status={run.status} />
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {formatDateTime(run.startedAt)} · 拉取 {run.pulled} · 写入 {run.pushed} · 冲突 {run.conflicts}
            </p>
            {run.message ? <p className="mt-1 text-xs text-muted-foreground">{run.message}</p> : null}
          </div>
          {rowAction ? <div className="flex shrink-0 items-center gap-2">{rowAction(run)}</div> : null}
        </article>
      ))}
    </div>
  )
}
