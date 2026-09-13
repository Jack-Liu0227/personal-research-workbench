import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { cn } from '../lib/utils'

/**
 * Shared horizontal pane resizing for the three knowledge workspaces
 * (文献检索 / Obsidian / Zotero).
 *
 * One pane width is a single number that is *always* clamped to `[min, max]`
 * before it is applied, so a dragged, keyboarded or restored value can never
 * produce an unreachable pane or a horizontally overflowing page. The
 * separator itself is a `role="separator"` window splitter: pointer drag plus
 * ArrowLeft/ArrowRight (Shift for a coarse step), Home for the minimum, End
 * for the maximum and a double click to restore the default width.
 */

export type PaneResizeUnit = 'px' | 'percent'

/** Keyboard step for a single arrow press. */
export const PANE_RESIZE_STEP = 16
/** Keyboard step while Shift is held. */
export const PANE_RESIZE_LARGE_STEP = 64

/** Width of the drag handle, used by callers that center it on a pane edge. */
export const PANE_RESIZE_HANDLE_WIDTH = 12

const STORAGE_PREFIX = 'workbench-pane-width:'

export function paneResizeStorageKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`
}

/** Clamp a pane width. A non-finite value falls back to `min` instead of
 * leaking `NaN` into a grid template where it would silently break the page. */
export function clampPaneWidth(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return Math.round(Math.min(min, max))
  const lower = Math.min(min, max)
  const upper = Math.max(min, max)
  return Math.round(Math.min(upper, Math.max(lower, value)))
}

/** Distance from the split container's edge to the *centre* of a `width`-wide
 * pane when the grid column gap is `gap`. Pages use it to place a separator
 * that lives in the split container instead of in a scrolling pane. */
export function paneBoundaryOffset(width: number, gap = 16): number {
  return Math.round(width + gap / 2 - PANE_RESIZE_HANDLE_WIDTH / 2)
}

/** Convert a clamped pane width into a CSS length for a grid track. */
export function paneTrackSize(value: number, unit: PaneResizeUnit): string {
  return unit === 'percent' ? `${clampPaneWidth(value, 0, 100)}%` : `${Math.round(value)}px`
}

function readStoredPaneWidth(storageKey: string): number | null {
  try {
    const raw = localStorage.getItem(paneResizeStorageKey(storageKey))
    if (raw === null) return null
    const parsed = Number.parseFloat(raw)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    // Renderer storage is optional; a blocked store must not break the page.
    return null
  }
}

function storePaneWidth(storageKey: string, value: number): void {
  try {
    localStorage.setItem(paneResizeStorageKey(storageKey), String(Math.round(value)))
  } catch {
    /* optional renderer storage */
  }
}

/**
 * Pane width state with the repository's safe persistence convention
 * (renderer-only `localStorage` in `try/catch`, never Node/SQLite/credentials).
 */
export function usePaneWidth({ storageKey, defaultWidth, min, max }: {
  storageKey: string
  defaultWidth: number
  min: number
  max: number
}): { width: number; setWidth: (next: number) => void; resetWidth: () => void } {
  const [width, setWidthState] = useState(() => clampPaneWidth(readStoredPaneWidth(storageKey) ?? defaultWidth, min, max))
  useEffect(() => { storePaneWidth(storageKey, width) }, [storageKey, width])
  const setWidth = useCallback((next: number) => setWidthState(clampPaneWidth(next, min, max)), [max, min])
  const resetWidth = useCallback(() => setWidthState(clampPaneWidth(defaultWidth, min, max)), [defaultWidth, max, min])
  return { width, setWidth, resetWidth }
}

/**
 * Whether the split is actually acted on: the pages stack their panes at CSS
 * breakpoints, and a separator must never be offered for a stacked column.
 * `matchMedia` is used so the JS gate cannot drift from the stylesheet.
 */
export function usePaneResizeEnabled(query: string): boolean {
  const [enabled, setEnabled] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(query)
    const update = () => setEnabled(list.matches)
    update()
    list.addEventListener('change', update)
    return () => list.removeEventListener('change', update)
  }, [query])
  return enabled
}

export type PaneResizeSeparatorProps = {
  /** Accessible name, e.g. `调整结果详情宽度`. */
  label: string
  value: number
  min: number
  max: number
  unit?: PaneResizeUnit
  /** `true` when the resized pane sits *after* (right of) the separator. */
  invert?: boolean
  step?: number
  largeStep?: number
  defaultValue?: number
  /** Container whose box a `percent` value is measured against. Only required
   * for `unit="percent"`. */
  containerRef?: RefObject<HTMLElement | null> | undefined
  /** Stacked/narrow layout: the separator is removed from the tab order. */
  disabled?: boolean
  onResize: (value: number) => void
  onReset?: () => void
  /** Optional id of the pane the separator controls, for `aria-controls`. */
  controlsId?: string
  className?: string
  style?: CSSProperties
}

export function PaneResizeSeparator({
  className,
  containerRef,
  controlsId,
  defaultValue,
  disabled = false,
  invert = false,
  label,
  largeStep = PANE_RESIZE_LARGE_STEP,
  max,
  min,
  onReset,
  onResize,
  step = PANE_RESIZE_STEP,
  style,
  unit = 'px',
  value
}: PaneResizeSeparatorProps): React.JSX.Element {
  const dragRef = useRef<{ pointerId: number; startX: number; startValue: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const apply = useCallback((next: number) => {
    const clamped = clampPaneWidth(next, min, max)
    if (clamped !== Math.round(value)) onResize(clamped)
  }, [max, min, onResize, value])

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return
    // Suppressing the default also suppresses the compatibility mouse events,
    // so a drag can neither select page text nor steal focus mid-gesture.
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* pointer capture is best effort */
    }
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startValue: clampPaneWidth(value, min, max) }
    setDragging(true)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (disabled || !drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    if (unit === 'percent') {
      const rect = containerRef?.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0) return
      const ratio = ((invert ? rect.right - event.clientX : event.clientX - rect.left) / rect.width) * 100
      if (Number.isFinite(ratio)) apply(ratio)
      return
    }
    apply(drag.startValue + (invert ? drag.startX - event.clientX : event.clientX - drag.startX))
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const size = event.shiftKey ? largeStep : step
    let next: number
    switch (event.key) {
      case 'ArrowLeft': next = value + (invert ? size : -size); break
      case 'ArrowRight': next = value + (invert ? -size : size); break
      case 'Home': next = min; break
      case 'End': next = max; break
      case 'Enter': if (onReset) next = defaultValue ?? value; else return; break
      default: return
    }
    event.preventDefault()
    if (event.key === 'Enter') onReset?.()
    else apply(next)
  }

  return (
    <div
      aria-controls={controlsId}
      aria-disabled={disabled}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemax={Math.round(Math.max(min, max))}
      aria-valuemin={Math.round(Math.min(min, max))}
      aria-valuenow={Math.round(clampPaneWidth(value, min, max))}
      aria-valuetext={unit === 'percent' ? `${Math.round(value)}% 宽度` : `${Math.round(value)} 像素宽`}
      className={cn('pane-resize-separator', className)}
      data-dragging={dragging}
      data-pane-resize={unit}
      hidden={disabled}
      onDoubleClick={() => { if (!disabled) onReset?.() }}
      onKeyDown={handleKeyDown}
      onPointerCancel={endDrag}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      role="separator"
      style={style}
      tabIndex={disabled ? -1 : 0}
      title={label}
    />
  )
}
