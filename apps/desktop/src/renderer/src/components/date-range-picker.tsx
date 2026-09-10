import { CalendarDays, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Clock3, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../lib/utils'

export type DateRangePickerValue = {
  from: string
  to: string
  fromTime: string
  toTime: string
}

export type DateRangeQuickPreset = 'today' | 'next7' | 'thisWeek' | 'next30' | 'thisMonth'

type DateRangePickerProps = DateRangePickerValue & {
  onChange: (value: DateRangePickerValue) => void
  onQuickPreset?: (preset: DateRangeQuickPreset, value: DateRangePickerValue) => void
  onClear?: () => void
  initialOpen?: boolean
  /** Render calendar dates in the same timezone used by the task query. */
  timezone?: string
}

const weekdayLabels = ['日', '一', '二', '三', '四', '五', '六']
const quickPresetLabels: Record<DateRangeQuickPreset, string> = {
  today: '今天',
  next7: '近 7 天',
  thisWeek: '本周',
  next30: '近 30 天',
  thisMonth: '本月'
}

function pad(value: number): string { return String(value).padStart(2, '0') }

function todayKey(timezone?: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    ...(timezone ? { timeZone: timezone } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date())
  const get = (name: string) => parts.find((part) => part.type === name)?.value ?? ''
  const value = `${get('year')}-${get('month')}-${get('day')}`
  return isDateKey(value) ? value : new Date().toISOString().slice(0, 10)
}

function isDateKey(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/u.test(value) }

function dateFromKey(value: string): Date {
  const safe = isDateKey(value) ? value : new Date().toISOString().slice(0, 10)
  return new Date(`${safe}T00:00:00.000Z`)
}

function keyFromDate(value: Date): string {
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
}

function monthKey(value: Date): string { return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-01` }

function addDays(value: string, amount: number): string {
  const next = dateFromKey(value)
  next.setUTCDate(next.getUTCDate() + amount)
  return keyFromDate(next)
}

function addMonths(value: string, amount: number): string {
  const next = dateFromKey(value)
  next.setUTCDate(1)
  next.setUTCMonth(next.getUTCMonth() + amount)
  return monthKey(next)
}

function startOfWeek(value: string): string {
  const next = dateFromKey(value)
  next.setUTCDate(next.getUTCDate() - next.getUTCDay())
  return keyFromDate(next)
}

function endOfMonth(value: string): string {
  const next = dateFromKey(value)
  next.setUTCMonth(next.getUTCMonth() + 1, 0)
  return keyFromDate(next)
}

function monthDays(value: string): string[] {
  const first = dateFromKey(value)
  const firstKey = monthKey(first)
  const gridStart = startOfWeek(firstKey)
  return Array.from({ length: 42 }, (_, index) => addDays(gridStart, index))
}

function monthLabel(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(dateFromKey(value))
}

function dateLabel(value: string): string {
  if (!isDateKey(value)) return '选择日期'
  return value
}

function defaultValue(timezone?: string): DateRangePickerValue {
  const today = todayKey(timezone)
  return { from: today, to: today, fromTime: '00:00:00', toTime: '23:59:59' }
}

function quickValue(preset: DateRangeQuickPreset, timezone?: string): DateRangePickerValue {
  const today = todayKey(timezone)
  if (preset === 'today') return { ...defaultValue(timezone), from: today, to: today }
  if (preset === 'next7') return { ...defaultValue(timezone), from: today, to: addDays(today, 6) }
  if (preset === 'next30') return { ...defaultValue(timezone), from: today, to: addDays(today, 29) }
  if (preset === 'thisMonth') {
    const first = monthKey(dateFromKey(today))
    return { ...defaultValue(timezone), from: first, to: endOfMonth(first) }
  }
  const weekStart = startOfWeek(today)
  return { ...defaultValue(timezone), from: weekStart, to: addDays(weekStart, 6) }
}

function normalizedTime(value: string, fallback: string): string {
  return /^\d{2}:\d{2}(?::\d{2})?$/u.test(value) ? (value.length === 5 ? `${value}:00` : value) : fallback
}

export function DateRangePicker({ from, to, fromTime, toTime, onChange, onQuickPreset, onClear, initialOpen = false, timezone }: DateRangePickerProps): React.JSX.Element {
  const [open, setOpen] = useState(initialOpen)
  const [leftMonth, setLeftMonth] = useState(() => monthKey(dateFromKey(from || todayKey(timezone))))
  const rootRef = useRef<HTMLDivElement | null>(null)
  const rightMonth = addMonths(leftMonth, 1)
  const value: DateRangePickerValue = {
    from,
    to,
    fromTime: normalizedTime(fromTime, '00:00:00'),
    toTime: normalizedTime(toTime, '23:59:59')
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const selectedSummary = useMemo(() => {
    if (!from && !to) return '选择日期范围'
    if (from && !to) return `${dateLabel(from)} · 请选择结束日期`
    return `${dateLabel(from)} 至 ${dateLabel(to)}`
  }, [from, to])

  const change = (next: Partial<DateRangePickerValue>) => onChange({ ...value, ...next })
  const chooseDate = (dateKey: string) => {
    if (!value.from || value.to) {
      change({ from: dateKey, to: '' })
      return
    }
    if (dateKey < value.from) change({ from: dateKey, to: value.from })
    else change({ to: dateKey })
    // Keep the popover open while choosing the start date; close only after
    // the end date has been selected so a two-click calendar range works like
    // the native productivity-app pattern.
    setOpen(false)
  }
  const chooseQuickPreset = (preset: DateRangeQuickPreset) => {
    const next = quickValue(preset, timezone)
    onQuickPreset?.(preset, next)
    if (!onQuickPreset) onChange(next)
  }
  const renderMonth = (month: string, side: 'left' | 'right') => {
    const days = monthDays(month)
    return <section aria-label={monthLabel(month)} className="date-range-month">
      <header className="date-range-month-header">
        {side === 'left' ? <div className="date-range-month-nav"><button aria-label="上上月" className="date-range-nav-button" onClick={() => setLeftMonth((current) => addMonths(current, -2))} type="button"><ChevronsLeft aria-hidden="true" /></button><button aria-label="上月" className="date-range-nav-button" onClick={() => setLeftMonth((current) => addMonths(current, -1))} type="button"><ChevronLeft aria-hidden="true" /></button></div> : null}
        <strong>{monthLabel(month)}</strong>
        {side === 'right' ? <div className="date-range-month-nav"><button aria-label="下月" className="date-range-nav-button" onClick={() => setLeftMonth((current) => addMonths(current, 1))} type="button"><ChevronRight aria-hidden="true" /></button><button aria-label="下下月" className="date-range-nav-button" onClick={() => setLeftMonth((current) => addMonths(current, 2))} type="button"><ChevronsRight aria-hidden="true" /></button></div> : null}
      </header>
      <div className="date-range-weekdays">{weekdayLabels.map((label) => <span key={label}>{label}</span>)}</div>
      <div className="date-range-days">
        {days.map((dayKey) => {
          const inMonth = dayKey.slice(0, 7) === month.slice(0, 7)
          const isStart = dayKey === value.from
          const isEnd = Boolean(value.to) && dayKey === value.to
          const inRange = Boolean(value.from && value.to && dayKey > value.from && dayKey < value.to)
          return <button aria-label={`${dayKey}${isStart ? '（起始）' : ''}${isEnd ? '（结束）' : ''}`} aria-pressed={isStart || isEnd} className={cn('date-range-day', !inMonth && 'date-range-day-outside', inRange && 'date-range-day-in-range', (isStart || isEnd) && 'date-range-day-selected', isStart && 'date-range-day-start', isEnd && 'date-range-day-end')} key={dayKey} onClick={() => chooseDate(dayKey)} type="button">{Number(dayKey.slice(-2))}</button>
        })}
      </div>
    </section>
  }

  return <div className="date-range-picker" ref={rootRef}>
    <button aria-expanded={open} aria-haspopup="dialog" aria-label="打开日期范围选择器" className={cn('date-range-trigger', open && 'date-range-trigger-open')} onClick={() => setOpen((current) => !current)} type="button"><CalendarDays aria-hidden="true" /><span className="date-range-trigger-copy"><strong>{selectedSummary}</strong><small>{from ? `${value.fromTime} – ${value.to ? value.toTime : '请选择结束时间'}` : '日期、时间和快捷范围'}</small></span><ChevronRight aria-hidden="true" className={cn('date-range-trigger-chevron', open && 'rotate-90')} /></button>
    {open ? <div aria-label="日期范围选择器" className="date-range-popover" role="dialog">
      <div className="date-range-popover-heading"><div><p className="instrument-label">DATE RANGE</p><h3>选择日期和时间</h3></div><button aria-label="关闭日期范围选择器" className="date-range-close" onClick={() => setOpen(false)} type="button"><X aria-hidden="true" /></button></div>
      <div className="date-range-calendars">{renderMonth(leftMonth, 'left')}{renderMonth(rightMonth, 'right')}</div>
      <div className="date-range-fields">
        <label><CalendarDays aria-hidden="true" /><span>开始</span><input aria-label="开始日期" onChange={(event) => change({ from: event.target.value })} type="date" value={from} /></label>
        <label><Clock3 aria-hidden="true" /><span className="sr-only">开始时间</span><input aria-label="开始时间" onChange={(event) => change({ fromTime: normalizedTime(event.target.value, '00:00:00') })} step="1" type="time" value={value.fromTime} /></label>
        <span className="date-range-separator">至</span>
        <label><CalendarDays aria-hidden="true" /><span>结束</span><input aria-label="结束日期" onChange={(event) => { change({ to: event.target.value }); if (event.target.value) setOpen(false) }} type="date" value={to} /></label>
        <label><Clock3 aria-hidden="true" /><span className="sr-only">结束时间</span><input aria-label="结束时间" onChange={(event) => change({ toTime: normalizedTime(event.target.value, '23:59:59') })} step="1" type="time" value={value.toTime} /></label>
      </div>
      <div className="date-range-quick" aria-label="快捷日期范围">{(Object.keys(quickPresetLabels) as DateRangeQuickPreset[]).map((preset) => <button key={preset} onClick={() => { chooseQuickPreset(preset); setOpen(false) }} type="button">{quickPresetLabels[preset]}</button>)}</div>
      <div className="date-range-popover-footer"><span>{from && to ? '按截止时间筛选，结束边界包含所选日期的最后一秒。' : '先选择开始日期，再选择结束日期。'}</span><div><button className="date-range-clear" onClick={() => { onClear?.(); if (!onClear) onChange({ from: '', to: '', fromTime: '00:00:00', toTime: '23:59:59' }) }} type="button">清除</button><button className="date-range-apply" disabled={!from || !to} onClick={() => setOpen(false)} type="button">应用范围</button></div></div>
    </div> : null}
  </div>
}
