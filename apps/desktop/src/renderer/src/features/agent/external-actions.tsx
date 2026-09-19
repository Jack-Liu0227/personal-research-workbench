import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, FileWarning, ShieldCheck, ShieldX } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AgentExternalAction, AgentExternalActionKind } from '@prw/contracts'
import { Button } from '../../components/ui'
import { cn } from '../../lib/utils'
import { getWorkbenchAgentApi } from '../../lib/workbench'

/**
 * The confirmation card for Agent-requested external writes.
 *
 * The Agent can read Zotero and the Vault and it can prepare a change, but the
 * write itself is this card. Nothing is sent to Zotero or the filesystem until
 * a person clicks 确认写入 here, which is why the card states the target, the
 * frozen summary and the remaining decision time instead of a generic "apply?".
 *
 * It is also the waiting state of the run. Pi cannot suspend a streaming turn,
 * so the run is not parked in `waiting_confirmation`; the pending row plus this
 * card is where the conversation actually waits, and approving appends a
 * receipt record to the ledger instead of resuming the model.
 */

const kindLabels: Record<AgentExternalActionKind, string> = {
  'zotero-import': '写入 Zotero',
  'obsidian-note': '写入 Obsidian 笔记',
  'obsidian-metadata': '更新 Obsidian 元数据'
}

const statusLabels: Record<AgentExternalAction['status'], string> = {
  pending: '等待确认',
  approved: '已批准，结果未知',
  rejected: '已拒绝',
  executed: '已执行',
  failed: '失败',
  conflict: '冲突，未覆盖',
  expired: '已过期'
}

export function ExternalActionCards({ conversationId }: {
  readonly conversationId: string
}): React.JSX.Element | null {
  const queryClient = useQueryClient()
  const [now, setNow] = useState(() => Date.now())
  const query = useQuery({
    queryKey: ['agent-external-actions', conversationId],
    queryFn: () => getWorkbenchAgentApi().externalActions.list({ conversationId }),
    // An expiring confirmation is time-based state, so a cached list would keep
    // offering a write whose window already closed.
    staleTime: 0,
    refetchInterval: 15_000
  })

  const actions = query.data ?? []
  const pending = actions.some((action) => action.status === 'pending')
  // Only tick while a decision window is open: a settled card has nothing left
  // to count down, and a timer per card would be pure noise.
  useEffect(() => {
    if (!pending) return
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [pending])

  const decide = useMutation({
    mutationFn: (input: { readonly id: string; readonly decision: 'approve' | 'reject'; readonly expectedRevision: number }) =>
      getWorkbenchAgentApi().externalActions.decide(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['agent-external-actions', conversationId] })
      // The decision appends a receipt record to its run, so the ledger the chat
      // renders from must be refetched as well.
      await queryClient.invalidateQueries({ queryKey: ['agent-run-records'] })
      await queryClient.invalidateQueries({ queryKey: ['agent-records'] })
    }
  })

  if (actions.length === 0) return null
  return <div aria-label="待确认的外部写入" aria-live="polite" className="agent-external-actions">
    {actions.map((action) => <ExternalActionCard
      action={action}
      busy={decide.isPending && decide.variables?.id === action.id}
      error={decide.isError && decide.variables?.id === action.id
        ? (decide.error instanceof Error ? decide.error.message : '确认失败。')
        : ''}
      key={action.id}
      now={now}
      onDecide={(decision) => decide.mutate({ id: action.id, decision, expectedRevision: action.revision })}
    />)}
  </div>
}

function ExternalActionCard({ action, busy, error, now, onDecide }: {
  readonly action: AgentExternalAction
  readonly busy: boolean
  readonly error: string
  readonly now: number
  readonly onDecide: (decision: 'approve' | 'reject') => void
}): React.JSX.Element {
  const remainingMs = Date.parse(action.expiresAt) - now
  const open = action.status === 'pending' && remainingMs > 0
  const tone = action.status === 'executed'
    ? 'ok'
    : action.status === 'rejected' || action.status === 'expired'
      ? 'muted'
      : action.status === 'pending' || action.status === 'approved'
        ? 'wait'
        : 'warn'
  return <article className={cn('agent-external-action', `agent-external-action-${tone}`)}>
    <header className="agent-external-action-head">
      <span className="agent-external-action-icon" aria-hidden="true">
        {tone === 'ok' ? <ShieldCheck className="size-4" />
          : tone === 'warn' ? <FileWarning className="size-4" />
            : tone === 'wait' ? <AlertTriangle className="size-4" />
              : <ShieldX className="size-4" />}
      </span>
      <div>
        <p className="agent-external-action-title">{kindLabels[action.kind]}</p>
        <p className="agent-external-action-meta">
          <span className={cn('agent-external-action-status', `agent-external-action-status-${tone}`)}>{statusLabels[action.status]}</span>
          <span>· 需要你在本机确认后才会写入</span>
        </p>
      </div>
    </header>
    <p className="agent-external-action-summary">{action.summary}</p>
    <dl className="agent-external-action-fields">
      <div><dt>目标</dt><dd>{action.profileId}</dd></div>
      <div><dt>请求时间</dt><dd>{formatMoment(action.createdAt)}</dd></div>
      <div><dt>确认窗口</dt><dd>{open ? `剩余 ${formatRemaining(remainingMs)}` : action.status === 'pending' ? '已过期' : formatMoment(action.expiresAt)}</dd></div>
    </dl>
    {action.receipt !== null ? <details className="agent-external-action-receipt">
      <summary>逐条回执</summary>
      <pre>{safeJson(action.receipt)}</pre>
    </details> : null}
    {action.error ? <p className="agent-external-action-error">{action.error}</p> : null}
    {error ? <p className="agent-external-action-error">{error}</p> : null}
    {action.status === 'approved' ? <p className="agent-external-action-hint">
      已批准但未取回结果（可能是执行中断）。请检查外部结果，必要时让 Agent 重新生成预览；重复执行会被冲突检查拦下。
    </p> : null}
    {action.status === 'expired' ? <p className="agent-external-action-hint">
      确认窗口已过，预览可能已失效。请重新让 Agent 生成一次预览。
    </p> : null}
    {open ? <div className="agent-external-action-actions">
      <Button loading={busy} onClick={() => onDecide('approve')} size="sm" type="button" variant="primary">
        {busy ? null : <Check aria-hidden="true" className="size-3" />}
        确认写入
      </Button>
      <Button disabled={busy} onClick={() => onDecide('reject')} size="sm" type="button" variant="ghost">拒绝</Button>
      <span className="agent-external-action-note">确认后不会再调用模型，直接执行上面这一份冻结的预览。</span>
    </div> : null}
  </article>
}

function formatMoment(value: string): string {
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return value
  return new Date(parsed).toLocaleString('zh-CN', { hour12: false })
}

function formatRemaining(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes} 分钟`
}

/** The receipt is written by the connector, so it is rendered as text: a card
 * must never turn a stored payload into markup. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2).slice(0, 4_000)
  } catch {
    return '回执无法显示'
  }
}
