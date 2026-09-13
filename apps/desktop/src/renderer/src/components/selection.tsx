import { useEffect, useRef } from 'react'
import type { ArchiveBulkResult } from '@prw/contracts'
import { cn } from '../lib/utils'

/**
 * Shared selection controls for every multi-select list.
 *
 * Two product rules are encoded here instead of being re-implemented per page:
 *  - A partial selection must never render as a fully checked box, because a
 *    checked box claims that a bulk action covers every visible row.
 *  - A "select all" control must always name the exact boundary it covers
 *    (`scope`), so "当前页" can never be presented as "全库".
 */

/**
 * Native tri-state checkbox.
 *
 * `indeterminate` is an IDL property, not an HTML attribute: React can only
 * write it through a ref after each render. Without this the mixed state is
 * silently rounded to "unchecked" and bulk actions look like they will touch
 * fewer (or more) rows than they really will.
 */
export function SelectionCheckbox({
  ariaLabel,
  checked,
  className,
  disabled = false,
  indeterminate = false,
  onChange,
  title
}: {
  ariaLabel: string
  checked: boolean
  className?: string
  disabled?: boolean
  indeterminate?: boolean
  onChange: (checked: boolean) => void
  title?: string
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    // A checked box may not also report a mixed state: browsers paint the dash
    // for `indeterminate` and would hide that every row is already selected.
    node.indeterminate = indeterminate && !checked
  }, [checked, indeterminate])
  return (
    <input
      aria-label={ariaLabel}
      checked={checked}
      className={cn('research-checkbox', className)}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
      ref={ref}
      title={title}
      type="checkbox"
    />
  )
}

/**
 * One selection toolbar for every list: the select-all toggle (with mixed
 * state), the exact scope it applies to, a visible count, a reset action and
 * the list's own bulk actions as children.
 *
 * `scope` is required on purpose. Lists differ in what "all" means (current
 * page, loaded pages, current filter result, capped API page) and the copy has
 * to state which one is in effect rather than reusing one optimistic label.
 */
export function SelectionBar({
  allSelected,
  children,
  className,
  clearLabel = '清除选择',
  disabled = false,
  indeterminate = false,
  label,
  onClear,
  onToggleAll,
  scope,
  selectAllLabel,
  selectedCount,
  totalCount
}: {
  allSelected: boolean
  children?: React.ReactNode
  className?: string
  clearLabel?: string
  disabled?: boolean
  indeterminate?: boolean
  /** Accessible name of the toolbar itself. */
  label: string
  onClear: () => void
  /** Receives the requested checkbox state so callers can map "check" and "uncheck" to different contracts. */
  onToggleAll: (checked: boolean) => void
  /** Visible boundary text: what "全选" really covers. */
  scope: string
  selectAllLabel: string
  selectedCount: number
  totalCount: number
}): React.JSX.Element {
  return (
    <div aria-label={label} className={cn('selection-bar', className)} role="group">
      <label className="selection-bar-toggle">
        <SelectionCheckbox
          ariaLabel={selectAllLabel}
          checked={allSelected}
          disabled={disabled}
          indeterminate={indeterminate}
          onChange={onToggleAll}
        />
        <span>{selectAllLabel}</span>
      </label>
      <span className="selection-bar-scope">{scope}</span>
      <span aria-live="polite" className="selection-bar-count" role="status">
        {selectedCount > 0 ? `已选 ${selectedCount} / ${totalCount}` : `共 ${totalCount}`}
      </span>
      <div className="selection-bar-actions">
        {selectedCount > 0 ? <button className="selection-bar-clear" onClick={onClear} type="button">{clearLabel}</button> : null}
        {children}
      </div>
    </div>
  )
}

/**
 * Fold per-record receipts into the bulk result shape the shared receipt list
 * renders.
 *
 * A one-row delete and a bulk delete must report through the same component and
 * the same outcome vocabulary, but the single-record command returns one
 * receipt instead of a counted result. Counting the receipts here (never in a
 * separate counter) keeps “已删除 1 条 · 跳过 0 条 …” derived from the exact rows
 * the user sees, so a single delete cannot claim a different outcome than the
 * receipt it prints.
 */
export function receiptResultFrom(items: ArchiveBulkResult['items']): ArchiveBulkResult {
  return {
    items,
    succeeded: items.filter((item) => item.outcome === 'succeeded').length,
    skipped: items.filter((item) => item.outcome === 'skipped').length,
    conflict: items.filter((item) => item.outcome === 'conflict').length,
    failed: items.filter((item) => item.outcome === 'failed').length,
    canceled: false
  }
}

/**
 * Per-record receipt of a bulk archive/delete command.
 *
 * One shared renderer for every list that deletes records, because the meaning
 * of an outcome must not drift between pages:
 *  - `succeeded`  the record reached the requested state in this command.
 *  - `skipped`    the requested state already held (record gone/already
 *                 archived), so nothing was written. Not an error, but the user
 *                 still needs to see that the row was not touched *now*.
 *  - `conflict`   the record changed after it was selected. Nothing was
 *                 written; the user has to re-read the list before retrying.
 *  - `failed`     anything else; the message comes from the service and is
 *                 already redacted there.
 */
export function ArchiveReceiptList({
  className,
  describe,
  result,
  succeededVerb
}: {
  className?: string
  /** Human label for one record id (its name, or a fallback when it is gone). */
  describe: (id: string) => string
  result: ArchiveBulkResult
  /** Scope-specific wording, e.g. “已删除” for records / “已归档” for rules. */
  succeededVerb: string
}): React.JSX.Element {
  const outcomeCopy = (outcome: ArchiveBulkResult['items'][number]): string => {
    if (outcome.outcome === 'succeeded') return succeededVerb
    if (outcome.outcome === 'skipped') return '跳过：记录已不存在或已是目标状态'
    const reason = outcome.error?.message ?? '未说明原因'
    return outcome.outcome === 'conflict' ? `修订冲突：${reason}` : `失败：${reason}`
  }
  return (
    <div aria-live="polite" className={cn('archive-receipt', className)} role="status">
      <p className="archive-receipt-summary">
        {`${succeededVerb} ${result.succeeded} 条 · 跳过 ${result.skipped} 条 · 修订冲突 ${result.conflict} 条 · 失败 ${result.failed} 条`}
        {result.conflict > 0 || result.failed > 0 ? '。冲突或失败的记录未改动，请刷新后重试。' : '。'}
      </p>
      <ul className="archive-receipt-items">
        {result.items.map((item) => (
          <li className={`archive-receipt-item archive-receipt-${item.outcome}`} key={item.id}>
            <span className="archive-receipt-name">{describe(item.id)}</span>
            <span>{outcomeCopy(item)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
