import { Copy, ExternalLink as ExternalLinkIcon, TriangleAlert } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { cn } from '../lib/utils'
import { copyTextToClipboard, externalAnchorAttributes, externalLinkAriaLabel, openExternalUrl, resolveExternalUrl, type ExternalOpenOutcome, type ExternalUrlTarget } from '../lib/external-url'
import { getWorkbenchApi } from '../lib/workbench'

/**
 * One accessible external-link control shared by the Literature Inspector, the
 * search-result rows and the Zotero item detail.
 *
 * It is a real `<a href>` (so Enter activation, focus ring and "opens in a new
 * window" semantics come from the platform) whose default navigation is
 * intercepted: Main `system.openExternal` is the only way a link reaches the OS
 * browser. An unsafe URL is never rendered as a link - it becomes plain text
 * with the reason stated - and every open/copy attempt reports its own outcome
 * through a polite live region, so a rejected protocol or a missing browser
 * handler is diagnosable instead of silently doing nothing.
 */

export interface ExternalUrlLinkProps {
  /** Raw stored value (URL or bare host). Resolved through the shared allowlist. */
  href?: string | null
  /** Pre-resolved value, used for DOI resolver links. */
  target?: ExternalUrlTarget
  /** Visible text. In icon mode it is only used for the accessible name. */
  label: string
  ariaLabel?: string
  /** Field name used in status text (e.g. “DOI”, “来源链接”). */
  fieldLabel: string
  /** Icon-only trigger for dense rows; the visible text is dropped. */
  iconMode?: boolean
  showCopy?: boolean
  showIcon?: boolean
  className?: string
  linkClassName?: string
  copyClassName?: string
  /** Reports the outcome to the page so a failure can also surface in its own
   * feedback area; the local live region stays authoritative. */
  onOutcome?: (outcome: ExternalOpenOutcome) => void
}

interface Status { tone: 'ok' | 'error'; text: string }

export function ExternalUrlLink(props: ExternalUrlLinkProps): React.JSX.Element | null {
  const target = useMemo<ExternalUrlTarget>(
    () => props.target ?? resolveExternalUrl(props.href),
    [props.target, props.href]
  )
  const [status, setStatus] = useState<Status | null>(null)
  const statusId = useId()
  const statusClass = cn('external-url-status', status?.tone === 'error' ? 'external-url-status-error' : 'external-url-status-ok')

  // Nothing to show: an empty field must not render a dead affordance.
  if (target.kind === 'empty') return null

  if (target.kind === 'blocked') {
    return (
      <span className="external-url-blocked" data-external-url="blocked">
        <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="external-url-text" title={target.raw}>{target.raw}</span>
        <span className="external-url-blocked-reason">{`${props.fieldLabel}：${target.reason}`}</span>
        {props.showCopy === false ? null : (
          <button
            aria-label={`复制${props.fieldLabel}`}
            className={cn('external-url-copy', props.copyClassName)}
            onClick={() => { void copyTextToClipboard(target.raw).then((outcome) => setStatus({ tone: outcome.ok ? 'ok' : 'error', text: outcome.message })) }}
            type="button"
          >
            <Copy aria-hidden="true" className="size-3" />
          </button>
        )}
        <span aria-live="polite" className={statusClass} id={statusId} role="status">{status?.text ?? ''}</span>
      </span>
    )
  }

  const openLink = async () => {
    const outcome = await openExternalUrl(target.href, (url) => getWorkbenchApi().system.openExternal(url))
    setStatus({ tone: outcome.ok ? 'ok' : 'error', text: outcome.message })
    props.onOutcome?.(outcome)
  }
  const copyLink = async () => {
    const outcome = await copyTextToClipboard(target.href)
    setStatus({ tone: outcome.ok ? 'ok' : 'error', text: outcome.message })
  }
  // The anchor contract (href/rel/target/title) is resolved by the shared lib;
  // a non-openable target can never reach this branch.
  const attributes = externalAnchorAttributes(target)
  if (attributes === null) return null
  const anchor = { attributes, iconMode: props.iconMode === true }

  return (
    <span className={cn('external-url-link', props.className)}>
      <a
        aria-describedby={status === null ? undefined : statusId}
        aria-label={anchor.iconMode ? props.ariaLabel ?? externalLinkAriaLabel(props.fieldLabel, props.label) : undefined}
        className={cn('external-url-anchor', target.pdf ? 'external-url-anchor-pdf' : '', props.linkClassName)}
        href={anchor.attributes.href}
        onClick={(event) => {
          // Never let the renderer navigate or spawn a window: hardenWindow()
          // denies window.open anyway, so the browser hand-off has to go
          // through the Main allowlist.
          event.preventDefault()
          event.stopPropagation()
          void openLink()
        }}
        onAuxClick={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          // Space is not a native link activation key; keyboard users must
          // still be able to activate the control without a mouse.
          if (event.key !== ' ') return
          event.preventDefault()
          event.stopPropagation()
          void openLink()
        }}
        rel={anchor.attributes.rel}
        target={anchor.attributes.target}
        title={anchor.iconMode ? props.href ?? undefined : anchor.attributes.title}
      >
        {props.showIcon === false ? null : <ExternalLinkIcon aria-hidden="true" className="size-3.5 shrink-0" />}
        {props.iconMode ? null : <span className="external-url-text">{props.label}</span>}
      </a>
      {props.showCopy === false || props.iconMode ? null : (
        <button
          aria-label={`复制${props.fieldLabel}`}
          className={cn('external-url-copy', props.copyClassName)}
          onClick={() => { void copyLink() }}
          type="button"
        >
          <Copy aria-hidden="true" className="size-3" />
        </button>
      )}
      <span aria-live="polite" className={statusClass} id={statusId} role="status">{status?.text ?? ''}</span>
    </span>
  )
}
