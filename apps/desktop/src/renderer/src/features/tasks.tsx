import type { BoardColumn, ContextMenuTarget, Project, Task, TaskPriority, TaskStatus } from '@prw/contracts'
import {
  Archive,
  Check,
  CheckCircle2,
  Circle,
  KanbanSquare,
  List,
  MoreHorizontal,
  RotateCcw,
  Save,
  Trash2
} from 'lucide-react'
import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/states'
import { DateRangePicker, type DateRangePickerValue } from '../components/date-range-picker'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Textarea
} from '../components/ui'
import { cn, formatDateTime, getErrorMessage } from '../lib/utils'
import { getWorkbenchApi } from '../lib/workbench'
import { TaskBoard, taskContextTarget, taskStatusLabel, useTaskCommands, type TaskContextMenuActions, type TaskContextMenuHandler } from './board'
import { queryKeys, useColumnsQuery, useTasksQuery } from './queries'
import { writeSharedTaskDateRange } from './task-date-filter'

const priorityLabels: Record<TaskPriority, string> = { low: '低', normal: '普通', high: '高', urgent: '紧急' }
const statusLabels: Record<TaskStatus, string> = taskStatusLabel
type TaskView = 'board' | 'list' | 'todo'
type DatePreset = 'all' | 'today' | 'tomorrow' | 'next7' | 'overdue' | 'none' | 'custom'
type SelectionMode = 'none' | 'page' | 'all-results' | 'explicit'

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function localDateParts(value: Date, timezone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value)
  const get = (name: string) => Number(parts.find((part) => part.type === name)?.value)
  return { year: get('year'), month: get('month'), day: get('day') }
}

function todayDateKey(timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const get = (name: string) => parts.find((part) => part.type === name)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** Convert calendar date parts in the Service timezone to a UTC instant. */
function zonedDateTimeParts(year: number, month: number, day: number, hour: number, minute: number, second: number, timezone: string): string | null {
  if (![year, month, day, hour, minute, second].every(Number.isFinite) || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  if (!Number.isFinite(utcGuess.getTime())) return null
  const renderedParts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(utcGuess)
  const getRendered = (name: string) => Number(renderedParts.find((part) => part.type === name)?.value)
  const offset = Date.UTC(getRendered('year'), getRendered('month') - 1, getRendered('day'), getRendered('hour'), getRendered('minute'), getRendered('second')) - utcGuess.getTime()
  const converted = new Date(utcGuess.getTime() - offset)
  if (!Number.isFinite(converted.getTime())) return null
  const verified = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(converted)
  const getVerified = (name: string) => Number(verified.find((part) => part.type === name)?.value)
  if (getVerified('year') !== year || getVerified('month') !== month || getVerified('day') !== day || getVerified('hour') !== hour || getVerified('minute') !== minute || getVerified('second') !== second) return null
  return converted.toISOString()
}

function zonedMidnightParts(year: number, month: number, day: number, timezone: string): string {
  return zonedDateTimeParts(year, month, day, 0, 0, 0, timezone) ?? new Date(Date.UTC(year, month - 1, day)).toISOString()
}

/** Convert a local calendar date in the Service timezone to a UTC instant. */
function zonedMidnight(date: Date, timezone: string, dayOffset = 0): string {
  const parts = localDateParts(date, timezone)
  return zonedMidnightParts(parts.year, parts.month, parts.day + dayOffset, timezone)
}

function zonedMidnightForDateInput(value: string, timezone: string, dayOffset = 0): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (!match) return null
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3])
  if (!Number.isInteger(year) || year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null
  // Date.UTC normalises invalid dates (for example 2026-02-31) instead of
  // rejecting them. Validate the calendar tuple before converting it to a
  // timezone-aware instant so a custom filter can never silently move to a
  // different day.
  const calendar = new Date(Date.UTC(year, month - 1, day))
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null
  return zonedMidnightParts(year, month, day + dayOffset, timezone)
}

function zonedDateTimeForDateInput(value: string, time: string, timezone: string): string | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(time)
  if (!dateMatch || !timeMatch) return null
  const year = Number(dateMatch[1]); const month = Number(dateMatch[2]); const day = Number(dateMatch[3])
  const hour = Number(timeMatch[1]); const minute = Number(timeMatch[2]); const second = Number(timeMatch[3] ?? 0)
  const calendar = new Date(Date.UTC(year, month - 1, day))
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null
  return zonedDateTimeParts(year, month, day, hour, minute, second, timezone)
}

function dateRangeForPreset(preset: DatePreset, timezone: string, customFrom: string, customTo: string, customFromTime = '00:00:00', customToTime = '23:59:59') {
  if (preset === 'none') return { from: new Date(0).toISOString(), to: '9999-12-31T00:00:00.000Z', timezone, includeNoDate: false, onlyNoDate: true }
  if (preset === 'today') return { from: zonedMidnight(new Date(), timezone), to: zonedMidnight(new Date(), timezone, 1), timezone, includeNoDate: false, onlyNoDate: false }
  if (preset === 'overdue') return { from: new Date(0).toISOString(), to: zonedMidnight(new Date(), timezone), timezone, includeNoDate: false, onlyNoDate: false }
  if (preset === 'tomorrow') return { from: zonedMidnight(new Date(), timezone, 1), to: zonedMidnight(new Date(), timezone, 2), timezone, includeNoDate: false, onlyNoDate: false }
  if (preset === 'next7') return { from: zonedMidnight(new Date(), timezone), to: zonedMidnight(new Date(), timezone, 7), timezone, includeNoDate: false, onlyNoDate: false }
  if (preset === 'custom' && customFrom && customTo) {
    // Parse date inputs as calendar dates, not UTC instants. Treating
    // `2026-08-30` as midnight UTC shifts the day for non-UTC workspaces and
    // was the reason an 8/30 filter could return the wrong records.
    const from = zonedDateTimeForDateInput(customFrom, customFromTime, timezone)
    const to = zonedDateTimeForDateInput(customTo, customToTime, timezone)
    // The picker exposes an inclusive end second. Convert it to the Service's
    // half-open range by advancing one second. This keeps a same-day 8/30
    // selection precise while still including tasks created at 23:59:59.
    const exclusiveTo = to !== null ? new Date(Date.parse(to) + 1_000).toISOString() : null
    if (from !== null && to !== null && exclusiveTo !== null && Date.parse(from) < Date.parse(exclusiveTo)) return { from, to: exclusiveTo, timezone, includeNoDate: false, onlyNoDate: false }
  }
  return undefined
}

function selectionFor(mode: SelectionMode, tasks: Task[], selectedIds: Set<string>, excludedIds: Set<string>, filterFingerprint: string) {
  const selected = mode === 'page' || mode === 'all-results' ? tasks.filter((task) => !excludedIds.has(task.id)) : tasks.filter((task) => selectedIds.has(task.id))
  return {
    selection: {
      mode,
      scope: 'tasks',
      selectedKeys: selected.map((task) => ({ source: 'tasks', sourceId: task.id })),
      excludedKeys: Array.from(excludedIds).map((id) => ({ source: 'tasks', sourceId: id })),
      sessionId: mode === 'all-results' ? `task-list:${filterFingerprint}` : null,
      queryFingerprint: mode === 'all-results' ? filterFingerprint : null
    },
    expectedRevisions: selected.map((task) => ({ id: task.id, expectedRevision: task.revision }))
  }
}

function TaskActions({ task, onArchive, onRestore, onHardDelete, onSelect, onContextMenu }: { task: Task; onArchive: (task: Task) => void; onRestore: (task: Task) => void; onHardDelete: (task: Task) => void; onSelect: (task: Task) => void; onContextMenu: TaskContextMenuHandler | undefined }): React.JSX.Element {
  const emitContext = (event: MouseEvent | KeyboardEvent) => {
    if ('key' in event && event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    if (onContextMenu) { onContextMenu(taskContextTarget(task), event); return }
    event.preventDefault()
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.click()
  }
  return <DropdownMenu><DropdownMenuTrigger asChild><Button aria-label="任务菜单" onContextMenu={emitContext} onKeyDown={emitContext} size="icon" variant="ghost"><MoreHorizontal aria-hidden="true" className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" aria-label="任务操作">{task.status === 'archived' ? <><DropdownMenuItem onSelect={() => onSelect(task)}>打开任务</DropdownMenuItem><DropdownMenuItem onSelect={() => onRestore(task)}><RotateCcw aria-hidden="true" className="size-3.5" />恢复任务</DropdownMenuItem><DropdownMenuItem className="text-danger" onSelect={() => onHardDelete(task)}><Trash2 aria-hidden="true" className="size-3.5" />永久删除</DropdownMenuItem></> : <><DropdownMenuItem onSelect={() => onArchive(task)}><Archive aria-hidden="true" className="size-3.5" />归档任务</DropdownMenuItem><DropdownMenuItem className="text-danger" onSelect={() => onHardDelete(task)}><Trash2 aria-hidden="true" className="size-3.5" />直接删除</DropdownMenuItem></>}</DropdownMenuContent></DropdownMenu>
}

function TaskInspector({ task, projects, onSaved, onContextMenu }: { task: Task; projects: Project[]; onSaved: (task?: Task) => void; onContextMenu?: TaskContextMenuHandler | undefined }): React.JSX.Element {
  const [title, setTitle] = useState(task.title)
  const [notes, setNotes] = useState(task.notes)
  const [priority, setPriority] = useState<TaskPriority>(task.priority)
  const [dueAt, setDueAt] = useState(task.dueAt?.slice(0, 16) ?? '')
  const [tags, setTags] = useState(task.tags.join(', '))
  const [feedback, setFeedback] = useState('')
  const commands = useTaskCommands(setFeedback)
  const targetProjectId = task.projectId ?? projects[0]?.id ?? null
  const columnsQuery = useColumnsQuery(targetProjectId)
  useEffect(() => { setTitle(task.title); setNotes(task.notes); setPriority(task.priority); setDueAt(task.dueAt?.slice(0, 16) ?? ''); setTags(task.tags.join(', ')); setFeedback('') }, [task])
  const save = async () => {
    try {
      const updated = await commands.update({ id: task.id, title: title.trim(), notes, priority, dueAt: dueAt ? new Date(dueAt).toISOString() : null, tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), expectedRevision: task.revision })
      onSaved(updated)
    } catch (error) { setFeedback(errorCode(error) === 'REVISION_CONFLICT' ? '修订冲突：任务已被其他操作更新，请重新载入后再试。' : getErrorMessage(error)) }
  }
  const archive = async () => { if (!window.confirm(`归档“${task.title}”？`)) return; try { await commands.archive(task); onSaved() } catch (error) { setFeedback(errorCode(error) === 'REVISION_CONFLICT' ? '修订冲突：请刷新任务后重试。' : getErrorMessage(error)) } }
  const restore = async () => { try { await commands.restore(task); onSaved() } catch (error) { setFeedback(getErrorMessage(error)) } }
  const hardDelete = async () => { if (!window.confirm(`确认永久删除“${task.title}”？此操作不可撤销。`)) return; try { await commands.hardDelete(task); onSaved() } catch (error) { setFeedback(getErrorMessage(error)) } }
  const complete = async () => {
    const doneColumn = columnsQuery.data?.find((column) => column.status === 'done')
    if (!doneColumn) { setFeedback('完成任务需要一个项目的“已完成”列；请先归属项目。'); return }
    try { const updated = await commands.move({ taskId: task.id, columnId: doneColumn.id, targetIndex: 0, expectedRevision: task.revision }); onSaved(updated) } catch (error) { setFeedback(errorCode(error) === 'REVISION_CONFLICT' ? '修订冲突：请刷新任务后重试。' : getErrorMessage(error)) }
  }
  const reopen = async () => {
    const plannedColumn = columnsQuery.data?.find((column) => column.status === 'planned')
    if (!plannedColumn) { setFeedback('重新打开需要一个项目的“待开始”列；请先归属项目。'); return }
    try { const updated = await commands.move({ taskId: task.id, columnId: plannedColumn.id, targetIndex: 0, expectedRevision: task.revision }); onSaved(updated) } catch (error) { setFeedback(errorCode(error) === 'REVISION_CONFLICT' ? '修订冲突：请刷新任务后重试。' : getErrorMessage(error)) }
  }
  const contextTarget = taskContextTarget(task)
  const contextActions: TaskContextMenuActions = {
    archive: async () => { try { await commands.archive(task); onSaved() } catch (error) { setFeedback(getErrorMessage(error)) } },
    delete: async () => { try { await commands.hardDelete(task); onSaved() } catch (error) { setFeedback(getErrorMessage(error)) } },
    restore: async () => { try { await commands.restore(task); onSaved() } catch (error) { setFeedback(getErrorMessage(error)) } },
    'hard-delete': async () => { try { await commands.hardDelete(task); onSaved() } catch (error) { setFeedback(getErrorMessage(error)) } }
  }
  return <aside className="research-panel" onContextMenu={(event) => { event.preventDefault(); onContextMenu?.(contextTarget, event, contextActions) }}><header className="research-panel-header"><p className="instrument-label">INSPECTOR / TASK</p><h2 className="mt-0.5 text-sm font-bold text-foreground">任务详情</h2></header><div className="grid gap-3 p-4"><label className="grid gap-1.5"><span className="text-xs font-semibold">标题</span><Input onChange={(event) => setTitle(event.target.value)} value={title} /></label><label className="grid gap-1.5"><span className="text-xs font-semibold">描述</span><Textarea onChange={(event) => setNotes(event.target.value)} value={notes} /></label><label className="grid gap-1.5"><span className="text-xs font-semibold">优先级</span><select aria-label="任务优先级" className="select-control" onChange={(event) => setPriority(event.target.value as TaskPriority)} value={priority}>{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="grid gap-1.5"><span className="text-xs font-semibold">标签</span><Input onChange={(event) => setTags(event.target.value)} placeholder="用逗号分隔" value={tags} /></label><label className="grid gap-1.5"><span className="text-xs font-semibold">截止时间</span><Input onChange={(event) => setDueAt(event.target.value)} type="datetime-local" value={dueAt} /></label><p className="text-xs text-muted-foreground">状态：{statusLabels[task.status]} · 修订：{task.revision}{task.archivedAt ? ' · 已归档' : ''}</p>{feedback ? <p className="form-feedback form-feedback-error" role="alert">{feedback}</p> : null}<div className="flex flex-wrap gap-2"><Button disabled={!title.trim() || task.status === 'archived'} loading={false} onClick={() => void save()} variant="primary"><Save aria-hidden="true" className="size-4" />保存任务</Button>{task.status === 'done' ? <Button onClick={() => void reopen()} size="sm" variant="secondary">重新打开</Button> : <Button disabled={task.status === 'archived'} onClick={() => void complete()} size="sm" variant="secondary"><CheckCircle2 aria-hidden="true" className="size-4" />完成</Button>}{task.status === 'archived' ? <><Button onClick={() => void restore()} size="sm" variant="secondary"><RotateCcw aria-hidden="true" className="size-4" />恢复</Button><Button onClick={() => void hardDelete()} size="sm" variant="danger"><Trash2 aria-hidden="true" className="size-4" />永久删除</Button></> : <Button onClick={() => void archive()} size="sm" variant="danger"><Archive aria-hidden="true" className="size-4" />归档</Button>}</div></div></aside>
}

export function TaskWorkspacePage({ projects, selectedProjectId, onSelectProject, workspaceTimezone = 'Asia/Shanghai', onContextMenu: shellOnContextMenu, focusTaskId = null }: { projects: Project[]; selectedProjectId: string | null; onSelectProject: (id: string | null) => void; workspaceTimezone?: string; onContextMenu?: TaskContextMenuHandler; focusTaskId?: string | null }): React.JSX.Element {
  const [view, setView] = useState<TaskView>('board')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [preset, setPreset] = useState<DatePreset>('all')
  const [dateField, setDateField] = useState<'createdAt' | 'dueAt'>('createdAt')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [customFromTime, setCustomFromTime] = useState('00:00:00')
  const [customToTime, setCustomToTime] = useState('23:59:59')
  const [todoTitle, setTodoTitle] = useState('')
  const [todoFeedback, setTodoFeedback] = useState('')
  const [selectionMode, setSelectionMode] = useState<SelectionMode>('none')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set())
  const [bulkFeedback, setBulkFeedback] = useState('')
  useEffect(() => {
    if (!focusTaskId) return
    setSelectedId(focusTaskId)
    setShowArchived(true)
  }, [focusTaskId])
  const dateRange = useMemo(() => dateRangeForPreset(preset, workspaceTimezone, customFrom, customTo, customFromTime, customToTime), [customFrom, customFromTime, customTo, customToTime, preset, workspaceTimezone])
  useEffect(() => { writeSharedTaskDateRange(dateRange ?? null) }, [dateRange])
  const listFilter = useMemo(() => ({ ...(selectedProjectId ? { projectId: selectedProjectId as never } : {}), view: (preset === 'today' || preset === 'overdue' ? preset : 'all') as 'all' | 'today' | 'overdue', includeArchived: showArchived, dateField, ...(dateRange ? { dateRange } : {}) }), [dateField, dateRange, preset, selectedProjectId, showArchived])
  const tasksQuery = useTasksQuery(listFilter)
  const inboxView: 'inbox' | 'today' | 'overdue' = preset === 'today' || preset === 'overdue' ? preset : 'inbox'
  const inboxQuery = useTasksQuery({ projectId: null, view: inboxView, includeArchived: false, dateField, ...(dateRange ? { dateRange } : {}) })
  const commands = useTaskCommands(setBulkFeedback)
  const tasks = useMemo(() => {
    // Inbox tasks are global, but must not leak into a selected project. The
    // previous merge appended inbox results for every project and made board
    // and list counts disagree with the active project/date filter.
    const includeInbox = selectedProjectId === null
    const all = view === 'todo'
      ? (includeInbox ? (inboxQuery.data ?? []) : [])
      : [...(tasksQuery.data ?? []), ...(includeInbox ? (inboxQuery.data ?? []) : [])]
    return Array.from(new Map(all.map((task) => [task.id, task])).values())
  }, [inboxQuery.data, selectedProjectId, tasksQuery.data, view])
  const contextActionsForTask = (task: Task): TaskContextMenuActions => ({
    edit: async () => { setSelectedId(task.id) },
    archive: async () => { try { await commands.archive(task); setSelectedId(null) } catch (error) { setBulkFeedback(getErrorMessage(error)) } },
    delete: async () => { try { await commands.hardDelete(task); setSelectedId(null) } catch (error) { setBulkFeedback(getErrorMessage(error)) } },
    restore: async () => { try { await commands.restore(task); setSelectedId(null) } catch (error) { setBulkFeedback(getErrorMessage(error)) } },
    'hard-delete': async () => { try { await commands.hardDelete(task); setSelectedId(null) } catch (error) { setBulkFeedback(getErrorMessage(error)) } }
  })
  const onContextMenu: TaskContextMenuHandler | undefined = shellOnContextMenu
    ? (target, event, actions) => {
        const task = tasks.find((item) => item.id === target.id)
        const normalizedTarget = task && task.status !== 'archived' && target.type === 'task' && !target.capabilities.includes('delete')
          ? { ...target, capabilities: [...target.capabilities, 'delete' as const] }
          : target
        shellOnContextMenu(normalizedTarget, event, actions ?? (task ? contextActionsForTask(task) : undefined))
      }
    : undefined
  // Keep the nullable runtime value while allowing the JSX branch below to
  // pass the narrowed task through a spread prop without a false-positive
  // TypeScript error.
  const selected = (tasks.find((task) => task.id === selectedId) ?? null) as Task
  const filterFingerprint = JSON.stringify({ projectId: selectedProjectId, preset, dateField, dateRange, includeArchived: showArchived })
  const selectedCount = selectionMode === 'all-results' ? tasks.length - excludedIds.size : selectionMode === 'page' ? tasks.length : selectedIds.size
  const toggleSelection = (taskId: string) => {
    if (selectionMode === 'page' || selectionMode === 'all-results') {
      const current = new Set<string>(tasks.filter((task) => !excludedIds.has(task.id)).map((task) => task.id))
      if (current.has(taskId)) current.delete(taskId); else current.add(taskId)
      setSelectionMode('explicit'); setSelectedIds(current); setExcludedIds(new Set()); return
    }
    setSelectionMode('explicit'); setSelectedIds((current) => { const next = new Set(current); if (next.has(taskId)) next.delete(taskId); else next.add(taskId); return next })
  }
  const selectPage = () => { setSelectionMode('page'); setSelectedIds(new Set(tasks.map((task) => task.id))); setExcludedIds(new Set()) }
  const selectAllResults = () => { setSelectionMode('all-results'); setExcludedIds(new Set()); setSelectedIds(new Set()) }
  const clearSelection = () => { setSelectionMode('none'); setSelectedIds(new Set()); setExcludedIds(new Set()); setBulkFeedback('') }
  const runBulk = async (operation: 'archive' | 'restore' | 'hardDelete') => {
    const payload = selectionFor(selectionMode, tasks, selectedIds, excludedIds, filterFingerprint)
    if (payload.expectedRevisions.length === 0) return
    if (operation === 'hardDelete' && !window.confirm('仅已归档任务会被永久删除，确认继续？此操作不可撤销。')) return
    try {
      const result = operation === 'archive' ? await commands.bulkArchive(payload as never) : operation === 'restore' ? await commands.bulkRestore(payload as never) : await commands.bulkHardDelete({ ...payload, confirmed: true, confirmationContext: { confirmationId: globalThis.crypto?.randomUUID?.() ?? `confirm-${Date.now()}`, operation: 'tasks.bulkHardDelete', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120000).toISOString() } } as never)
      setBulkFeedback(`批量操作完成：成功 ${result.succeeded}，跳过 ${result.skipped}，失败 ${result.failed}${result.canceled ? '，已取消' : ''}`)
      clearSelection()
    } catch (error) { setBulkFeedback(errorCode(error) === 'REVISION_CONFLICT' ? '批量操作包含修订冲突，请刷新后重试。' : getErrorMessage(error)) }
  }
  const captureTodo = async () => {
    const title = todoTitle.trim()
    if (!title) return
    try { await commands.capture({ title, notes: '', projectId: null, columnId: null, priority: 'normal', estimateMinutes: null, dueAt: null, tags: [] } as never); setTodoTitle(''); setTodoFeedback('Todo 已进入待整理。') } catch (error) { setTodoFeedback(getErrorMessage(error)) }
  }
  const archive = async (task: Task) => { if (window.confirm(`归档“${task.title}”？`)) { try { await commands.archive(task); setSelectedId(null) } catch (error) { setBulkFeedback(getErrorMessage(error)) } } }
  const restore = async (task: Task) => { try { await commands.restore(task); setSelectedId(null) } catch (error) { setBulkFeedback(getErrorMessage(error)) } }
  const hardDelete = async (task: Task) => { if (!window.confirm(`确认永久删除“${task.title}”？此操作不可撤销。`)) return; try { await commands.hardDelete(task); setSelectedId(null) } catch (error) { setBulkFeedback(getErrorMessage(error)) } }
  const applyCustomRange = (value: DateRangePickerValue) => {
    setPreset('custom')
    setCustomFrom(value.from)
    setCustomTo(value.to)
    setCustomFromTime(value.fromTime)
    setCustomToTime(value.toTime)
  }
  const selectDatePreset = (value: DatePreset) => {
    setPreset(value)
    if (value === 'custom' && (!customFrom || !customTo)) {
      const today = todayDateKey(workspaceTimezone)
      setCustomFrom(today)
      setCustomTo(today)
      setCustomFromTime('00:00:00')
      setCustomToTime('23:59:59')
    }
  }
  const board = view === 'board' ? <div className="mt-1"><TaskBoard {...(onContextMenu ? { onContextMenu } : {})} {...(dateRange ? { dateRange } : {})} onSelectProject={(id) => onSelectProject(id)} onSelectTask={(task) => setSelectedId(task.id)} projects={projects} selectedProjectId={selectedProjectId} showArchived={showArchived} showInbox /></div> : null
  return <div className="page-scroll">
    <PageHeader actions={<><label><span className="sr-only">任务项目</span><select aria-label="任务项目" className="select-control min-w-44" onChange={(event) => onSelectProject(event.target.value || null)} value={selectedProjectId ?? ''}><option value="">全部任务</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><Button onClick={() => void captureTodo()} size="sm" variant="secondary"><Circle aria-hidden="true" className="size-4" />快速 Todo</Button></>} description={`看板、列表和任务 Inspector 共用同一套 Task Command · 服务时区 ${workspaceTimezone}`} eyebrow="WORKSPACE / TASKS" title="任务" />
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface p-2"><Input aria-label="快速 Todo 标题" className="max-w-xs" onChange={(event) => setTodoTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void captureTodo() }} placeholder="输入 Todo，回车捕获…" value={todoTitle} />{todoFeedback ? <span className="text-xs text-muted-foreground" role="status">{todoFeedback}</span> : null}<label className="ml-auto flex items-center gap-2 text-xs"><input checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} type="checkbox" />显示已归档</label></div>
     <div className="mt-4 flex flex-wrap items-end gap-2 border-b border-border pb-3"><div className="flex gap-1"><Button aria-pressed={view === 'board'} onClick={() => setView('board')} size="sm" variant={view === 'board' ? 'primary' : 'ghost'}><KanbanSquare aria-hidden="true" className="size-4" />看板</Button><Button aria-pressed={view === 'list'} onClick={() => setView('list')} size="sm" variant={view === 'list' ? 'primary' : 'ghost'}><List aria-hidden="true" className="size-4" />列表</Button><Button aria-pressed={view === 'todo'} onClick={() => setView('todo')} size="sm" variant={view === 'todo' ? 'primary' : 'ghost'}><Circle aria-hidden="true" className="size-4" />Todo</Button></div><label className="grid gap-1 text-xs"><span>{dateField === "createdAt" ? "创建日期筛选" : "截止日期筛选"}</span><select aria-label="日期筛选" className="select-control" onChange={(event) => selectDatePreset(event.target.value as DatePreset)} value={preset}><option value="all">全部日期</option><option value="today">今天</option><option value="tomorrow">明天</option><option value="next7">未来 7 天</option><option value="overdue">已逾期</option><option value="none">无日期</option><option value="custom">自定义范围</option></select></label>{preset === 'custom' ? <DateRangePicker key="task-date-range" from={customFrom} fromTime={customFromTime} onChange={applyCustomRange} onClear={() => { setPreset('all'); setCustomFrom(''); setCustomTo(''); setCustomFromTime('00:00:00'); setCustomToTime('23:59:59') }} onQuickPreset={(_, value) => applyCustomRange(value)} timezone={workspaceTimezone} to={customTo} toTime={customToTime} initialOpen /> : null}<Button aria-label={`切换日期字段：当前按${dateField === "createdAt" ? "创建时间" : "截止时间"}`} title="切换创建时间和截止时间" onClick={() => setDateField((current) => current === "createdAt" ? "dueAt" : "createdAt")} size="sm" variant="secondary">按{dateField === "createdAt" ? "创建时间" : "截止时间"}</Button></div>
    {bulkFeedback ? <p className="mt-2 text-xs text-muted-foreground" role="status">{bulkFeedback}</p> : null}
    {view === 'board' ? board : <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]"><section className="research-panel"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5"><div className="flex items-center gap-2 text-xs text-muted-foreground"><input aria-label="选择当前页任务" checked={selectionMode === 'page' && tasks.length > 0 && selectedCount === tasks.length} onChange={(event) => event.target.checked ? selectPage() : clearSelection()} type="checkbox" /><span>{selectedCount > 0 ? `已选择 ${selectedCount} 项` : '未选择任务'}</span></div><div className="flex flex-wrap gap-1">{selectionMode !== 'all-results' ? <Button onClick={selectAllResults} size="sm" variant="ghost">选择全部结果</Button> : null}{selectedCount > 0 ? <><Button onClick={() => void runBulk('archive')} size="sm" variant="ghost"><Archive aria-hidden="true" className="size-3.5" />批量归档</Button><Button onClick={() => void runBulk('restore')} size="sm" variant="ghost"><RotateCcw aria-hidden="true" className="size-3.5" />批量恢复</Button><Button onClick={() => void runBulk('hardDelete')} size="sm" variant="danger"><Trash2 aria-hidden="true" className="size-3.5" />永久删除</Button><Button onClick={clearSelection} size="sm" variant="ghost">清除选择</Button></> : null}</div></div>{tasksQuery.isLoading || inboxQuery.isLoading ? <div className="p-4"><LoadingState label="正在读取任务…" /></div> : null}{tasksQuery.error ? <div className="p-4"><ErrorState error={tasksQuery.error} onRetry={() => void tasksQuery.refetch()} /></div> : null}{inboxQuery.error ? <div className="p-4"><ErrorState error={inboxQuery.error} onRetry={() => void inboxQuery.refetch()} /></div> : null}{tasks.length === 0 && !tasksQuery.isLoading && !inboxQuery.isLoading ? <EmptyState description="创建一个任务或快速 Todo，开始记录下一步研究行动。" title="当前没有任务" /> : null}<div className="divide-y divide-border">{tasks.map((task) => <div className={cn('task-row flex items-center gap-2', task.id === selectedId && 'bg-primary-subtle')} key={task.id}><input aria-label={`选择任务：${task.title}`} checked={selectionMode === 'page' || selectionMode === 'all-results' ? !excludedIds.has(task.id) : selectedIds.has(task.id)} onChange={() => toggleSelection(task.id)} type="checkbox" /><button aria-current={task.id === selectedId ? 'true' : undefined} className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setSelectedId(task.id)} type="button"><span className={cn('status-dot', `status-${task.status}`)} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-foreground">{task.title}</span><span className="mt-1 block text-xs text-muted-foreground">{statusLabels[task.status]} · {priorityLabels[task.priority]} · 创建 {formatDateTime(task.createdAt)}{task.dueAt ? ` · 截止 ${formatDateTime(task.dueAt)}` : ' · 无截止'}{task.tags.length ? ` · ${task.tags.slice(0, 3).map((tag) => `#${tag}`).join(' ')}` : ''}</span></span></button><TaskActions onArchive={archive} onContextMenu={onContextMenu} onHardDelete={hardDelete} onRestore={restore} onSelect={(item) => setSelectedId(item.id)} task={task} /></div>)}</div></section><aside className="research-panel"><header className="research-panel-header"><p className="instrument-label">INSPECTOR / TASK</p><h2 className="mt-0.5 text-sm font-bold text-foreground">任务详情</h2></header>{selected ? <TaskInspector {...(onContextMenu ? { onContextMenu } : {})} onSaved={(task) => { if (task) setSelectedId(task.id); else setSelectedId(null) }} projects={projects} task={selected} /> : <EmptyState description="选择任务查看标题、描述、优先级、标签和截止时间。" title="任务 Inspector" />}</aside></div>}
  </div>
}
