import { AlertTriangle, FolderKanban, Inbox, RefreshCw, ShieldOff } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from './ui'
import { getErrorMessage, uiCopy } from '../lib/utils'

export function LoadingState({ label = uiCopy.state.loading }: { label?: string }): React.JSX.Element {
  return (
    <div aria-busy="true" aria-live="polite" className="grid min-h-52 place-items-center rounded-lg border border-border bg-surface" role="status">
      <div className="w-full max-w-sm space-y-3 px-8">
        <p className="text-center text-sm font-medium text-muted-foreground">{label}</p>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div className="loading-bar h-full w-1/3 rounded-full bg-primary motion-reduce:w-full" />
        </div>
      </div>
    </div>
  )
}

/** Use when the surrounding page is already useful. It deliberately has no
 * minimum height so a slow connector or index cannot move the rest of the UI. */
export function InlineLoadingState({ label = uiCopy.state.loading }: { label?: string }): React.JSX.Element {
  return <span aria-busy="true" aria-live="polite" className="inline-loading-state" role="status"><span aria-hidden="true" className="inline-loading-spinner" />{label}</span>
}

export function PanelSkeleton({ lines = 4 }: { lines?: number }): React.JSX.Element {
  return <div aria-busy="true" aria-label="正在加载面板" className="panel-skeleton" role="status">{Array.from({ length: lines }, (_, index) => <span className="panel-skeleton-line" key={index} />)}</div>
}

export function ErrorState({ error, onRetry, compact = false, retryLabel }: {
  error: unknown
  onRetry: () => void
  compact?: boolean
  /** Unique accessible name when several retry actions render on the same page. */
  retryLabel?: string
}): React.JSX.Element {
  return (
    <div
      aria-live="assertive"
      className={compact
        ? 'flex items-start justify-between gap-4 rounded-md border border-danger/30 bg-danger-subtle p-3'
        : 'grid min-h-52 place-items-center rounded-lg border border-danger/30 bg-danger-subtle p-8 text-center'}
      role="alert"
    >
      <div className={compact ? 'flex min-w-0 items-start gap-2' : 'max-w-md'}>
        <AlertTriangle aria-hidden="true" className={compact ? 'mt-0.5 size-4 shrink-0 text-danger' : 'mx-auto mb-3 size-6 text-danger'} />
        <div>
          <p className="text-sm font-semibold text-foreground">{uiCopy.state.readError}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{getErrorMessage(error)}</p>
        </div>
      </div>
      <Button aria-label={retryLabel ?? uiCopy.action.retry} className={compact ? 'shrink-0' : 'mt-4'} onClick={onRetry} size="sm">
        <RefreshCw aria-hidden="true" className="size-3.5" />
        {uiCopy.action.retry}
      </Button>
    </div>
  )
}

/** Shared state for contract capabilities that are intentionally absent from
 * this V2 release. It is distinct from EmptyState so a disabled capability is
 * never presented as a successful empty result. */
export function UnavailableState({ feature = '该功能', description, compact = false }: {
  feature?: string
  description?: string
  compact?: boolean
}): React.JSX.Element {
  return (
    <div
      aria-live="polite"
      className={compact
        ? 'flex items-start gap-2 rounded-md border border-border bg-muted/50 p-3'
        : 'grid min-h-40 place-items-center rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center'}
      role="status"
    >
      <ShieldOff aria-hidden="true" className={compact ? 'mt-0.5 size-4 shrink-0 text-muted-foreground' : 'mx-auto mb-2 size-6 text-muted-foreground'} />
      <div className={compact ? 'min-w-0' : 'max-w-md'}>
        <p className="text-sm font-semibold text-foreground">{feature}暂不可用</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{description ?? uiCopy.state.unavailable}</p>
      </div>
    </div>
  )
}

export function EmptyState({
  kind = 'tasks',
  title,
  description,
  action
}: {
  kind?: 'tasks' | 'projects'
  title: string
  description: string
  action?: ReactNode
}): React.JSX.Element {
  const Icon = kind === 'projects' ? FolderKanban : Inbox
  return (
    <div aria-live="polite" className="grid min-h-52 place-items-center rounded-lg border border-dashed border-border bg-surface/60 px-8 py-10 text-center" role="status">
      <div className="max-w-sm">
        <div className="mx-auto mb-4 grid size-10 place-items-center rounded-md border border-border bg-muted text-muted-foreground">
          <Icon aria-hidden="true" className="size-5" />
        </div>
        <h2 className="text-sm font-bold text-foreground">{title}</h2>
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{description}</p>
        {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
      </div>
    </div>
  )
}

export function PageHeader({ eyebrow, title, description, actions }: {
  eyebrow: string
  title: string
  description: string
  actions?: ReactNode
}): React.JSX.Element {
  return (
    <header className="flex min-w-0 flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
      <div className="min-w-0 max-w-3xl">
        <p className="instrument-label">{eyebrow}</p>
        <h1 className="mt-1 text-balance text-xl font-bold tracking-tight text-foreground">{title}</h1>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}
