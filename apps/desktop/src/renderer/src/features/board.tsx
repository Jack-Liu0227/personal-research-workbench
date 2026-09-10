import {
  draggable,
  dropTargetForElements,
  monitorForElements
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  BoardColumn,
  ContextMenuTarget,
  CreateTaskInput,
  DateRange,
  Project,
  Task,
  TaskPriority,
  TaskStatus
} from '@prw/contracts'
import {
  Archive,
  CalendarClock,
  Check,
  CircleDot,
  Clock3,
  GripVertical,
  MoreHorizontal,
  MoveDown,
  MoveRight,
  MoveUp,
  Plus,
  RotateCcw,
  Trash2
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/states'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../components/ui'
import { cn, formatDateTime, getErrorMessage } from '../lib/utils'
import { getWorkbenchApi } from '../lib/workbench'
import { CreateProjectDialog, CreateTaskDialog } from './forms'
import { queryKeys, useColumnsQuery, useTasksQuery } from './queries'
import type { ContextActionHandlers } from '../shell/context-menu'

const priorityLabel: Record<TaskPriority, string> = {
  low: '低',
  normal: '普通',
  high: '高',
  urgent: '紧急'
}

// Task cards always show minute precision so the same dueAt value can be
// checked against the calendar projection without losing time-of-day.
const formatDate = formatDateTime

export const taskStatusLabel: Record<TaskStatus, string> = {
  inbox: '待整理',
  planned: '待开始',
  in_progress: '进行中',
  blocked: '受阻',
  done: '已完成',
  canceled: '已取消',
  archived: '已归档'
}

export const taskStatuses: TaskStatus[] = ['inbox', 'planned', 'in_progress', 'blocked', 'done', 'archived']

type TaskDragData = { kind: 'task'; taskId: string; columnId: string; index: number }
type TaskDropData = { kind: 'task-target' | 'column-target'; columnId: string; index: number }
type RenderColumn = Omit<BoardColumn, 'status'> & { status: TaskStatus }

/** Actions supplied by a task feature to the shell context-menu dispatcher.
 *
 * The callbacks close over the authoritative task DTO (including its current
 * revision), so callers cannot accidentally issue a mutation without a CAS
 * revision or confirmation context.
 */
export type TaskContextMenuActions = Pick<ContextActionHandlers, 'archive' | 'restore' | 'hard-delete' | 'delete'> & Partial<Pick<ContextActionHandlers, 'edit' | 'move'>>
export type TaskContextMenuHandler = (target: ContextMenuTarget, event: MouseEvent | KeyboardEvent, actions?: TaskContextMenuActions) => void

function parseDragData(value: Record<string | symbol, unknown>): TaskDragData | null {
  if (value.kind !== 'task' || typeof value.taskId !== 'string' || typeof value.columnId !== 'string' || typeof value.index !== 'number') return null
  return value as TaskDragData
}

function parseDropData(value: Record<string | symbol, unknown> | undefined): TaskDropData | null {
  if (!value || (value.kind !== 'task-target' && value.kind !== 'column-target') || typeof value.columnId !== 'string' || typeof value.index !== 'number') return null
  return value as TaskDropData
}

function makeConfirmation(operation: 'task.hardDelete' | 'tasks.bulkHardDelete') {
  const issuedAt = new Date()
  const expiresAt = new Date(issuedAt.getTime() + 2 * 60 * 1000)
  const id = globalThis.crypto?.randomUUID?.() ?? `confirm-${issuedAt.getTime()}-${Math.random().toString(36).slice(2)}`
  return { confirmationId: id, operation, issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString() }
}

function confirmHardDelete(task: Task): boolean {
  return window.confirm(`确认永久删除“${task.title}”？此操作不可撤销。`)
}

/** The only renderer lifecycle/movement path shared by list, board and Inspector. */
export function useTaskCommands(onFeedback?: (message: string) => void) {
  const queryClient = useQueryClient()
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
      queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
      queryClient.invalidateQueries({ queryKey: ['columns'] }),
      queryClient.invalidateQueries({ queryKey: ['calendar'] }),
      queryClient.invalidateQueries({ queryKey: ['calendar-markers'] })
    ])
  }
  const execute = async <T,>(operation: () => Promise<T>, success?: string): Promise<T> => {
    const result = await operation()
    await refresh()
    if (success) onFeedback?.(success)
    return result
  }
  return {
    create: (input: CreateTaskInput) => execute(() => getWorkbenchApi().tasks.create(input)),
    capture: (input: CreateTaskInput) => execute(() => getWorkbenchApi().todos.capture(input)),
    update: (input: Parameters<ReturnType<typeof getWorkbenchApi>['tasks']['update']>[0]) => execute(() => getWorkbenchApi().tasks.update(input)),
    move: (input: Parameters<ReturnType<typeof getWorkbenchApi>['tasks']['move']>[0]) => execute(() => getWorkbenchApi().tasks.move(input)),
    archive: (task: Task) => execute(() => getWorkbenchApi().tasks.archive(task.id, task.revision), `已归档“${task.title}”`),
    restore: (task: Task) => execute(() => getWorkbenchApi().tasks.restore(task.id, task.revision), `已恢复“${task.title}”`),
    hardDelete: (task: Task) => execute(() => getWorkbenchApi().tasks.hardDelete({ id: task.id, expectedRevision: task.revision, confirmed: true, confirmationContext: makeConfirmation('task.hardDelete') }), `已永久删除“${task.title}”`),
    bulkArchive: (input: Parameters<ReturnType<typeof getWorkbenchApi>['tasks']['bulkArchive']>[0]) => execute(() => getWorkbenchApi().tasks.bulkArchive(input)),
    bulkRestore: (input: Parameters<ReturnType<typeof getWorkbenchApi>['tasks']['bulkRestore']>[0]) => execute(() => getWorkbenchApi().tasks.bulkRestore(input)),
    bulkHardDelete: (input: Parameters<ReturnType<typeof getWorkbenchApi>['tasks']['bulkHardDelete']>[0]) => execute(() => getWorkbenchApi().tasks.bulkHardDelete(input))
  }
}

function tasksForColumn(tasks: Task[], column: RenderColumn): Task[] {
  return tasks.filter((task) => task.status === column.status || task.columnId === column.id).sort((left, right) => left.sortKey - right.sortKey)
}

function capabilitiesForTask(task: Task): ContextMenuTarget['capabilities'] {
  return task.status === 'archived'
    ? ['open', 'open-new-tab', 'copy-id', 'restore', 'hard-delete', 'refresh']
    : ['open', 'open-new-tab', 'copy-id', 'edit', 'move', 'archive', 'delete', 'refresh']
}

export function taskContextTarget(task: Task): ContextMenuTarget {
  return { type: 'task', id: task.id, capabilities: capabilitiesForTask(task) }
}

function TaskCard({ task, columnId, index, columns, columnTasks, moving, onMove, onArchive, onRestore, onHardDelete, onSelect, onContextMenu }: { task: Task; columnId: string; index: number; columns: RenderColumn[]; columnTasks: Map<string, Task[]>; moving: boolean; onMove: (task: Task, columnId: string, targetIndex: number) => void; onArchive: (task: Task) => void; onRestore: (task: Task) => void; onHardDelete: (task: Task) => void; onSelect: ((task: Task) => void) | undefined; onContextMenu: TaskContextMenuHandler | undefined }): React.JSX.Element {
  const cardRef = useRef<HTMLElement | null>(null)
  const handleRef = useRef<HTMLButtonElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const [targeted, setTargeted] = useState(false)
  useEffect(() => {
    const element = cardRef.current
    const dragHandle = handleRef.current
    if (!element || !dragHandle) return
    const cleanupDrag = draggable({ element, dragHandle, getInitialData: (): TaskDragData => ({ kind: 'task', taskId: task.id, columnId, index }), onDragStart: () => setDragging(true), onDrop: () => setDragging(false) })
    const cleanupDrop = dropTargetForElements({ element, getData: (): TaskDropData => ({ kind: 'task-target', columnId, index }), canDrop: ({ source }) => source.data.kind === 'task' && source.data.taskId !== task.id, onDragEnter: () => setTargeted(true), onDragLeave: () => setTargeted(false), onDrop: () => setTargeted(false) })
    return () => { cleanupDrag(); cleanupDrop() }
  }, [columnId, index, task.id])
  const overdue = Boolean(task.dueAt && task.status !== 'done' && task.status !== 'archived' && new Date(task.dueAt).getTime() < Date.now())
  const openContextMenu = (event: MouseEvent | KeyboardEvent) => {
    event.stopPropagation()
    if (onContextMenu) { onContextMenu(taskContextTarget(task), event); return }
    if ('preventDefault' in event) event.preventDefault()
    cardRef.current?.querySelector<HTMLButtonElement>('button[aria-label^="打开任务"]')?.click()
  }
  return <article ref={cardRef} aria-label={`任务：${task.title}`} className={cn('group relative rounded-md border bg-surface p-3 transition-colors duration-150', targeted ? 'border-primary bg-primary-subtle' : 'border-border hover:border-border-strong', dragging && 'opacity-50', moving && 'pointer-events-none opacity-60')} data-task-id={task.id} onContextMenu={openContextMenu} onKeyDown={(event) => { if ((event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) && onContextMenu) { event.preventDefault(); openContextMenu(event); return } if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.(task) } }} onClick={() => onSelect?.(task)} role="button" tabIndex={0}>
    <div className="flex items-start gap-2"><button ref={handleRef} aria-label={`拖动任务：${task.title}；键盘用户可使用任务菜单移动`} className="-ml-1 mt-0.5 grid size-7 shrink-0 cursor-grab place-items-center rounded text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing" title="拖动调整位置" type="button"><GripVertical aria-hidden="true" className="size-4" /></button><div className="min-w-0 flex-1"><h3 className="overflow-wrap-anywhere text-sm font-semibold leading-5 text-foreground">{task.title}</h3>{task.notes ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{task.notes}</p> : null}</div><DropdownMenu><DropdownMenuTrigger asChild><Button aria-label={`打开任务“${task.title}”的菜单`} className="-mr-1 -mt-1" size="icon" variant="ghost"><MoreHorizontal aria-hidden="true" className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" aria-label="任务操作">{task.status === 'archived' ? <><DropdownMenuItem onSelect={() => onSelect?.(task)}><span className="size-3.5" />打开任务</DropdownMenuItem><DropdownMenuItem onSelect={() => onRestore(task)}><RotateCcw aria-hidden="true" className="size-3.5" />恢复任务</DropdownMenuItem><DropdownMenuItem className="text-danger" onSelect={() => onHardDelete(task)}><Trash2 aria-hidden="true" className="size-3.5" />永久删除</DropdownMenuItem></> : <><DropdownMenuItem onSelect={() => onSelect?.(task)}><span className="size-3.5" />编辑任务</DropdownMenuItem><p className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">移动到</p>{columns.map((column) => <DropdownMenuItem disabled={column.id === columnId} key={column.id} onSelect={() => onMove(task, column.id, columnTasks.get(column.id)?.length ?? 0)}><MoveRight aria-hidden="true" className="size-3.5" />{column.title}{column.id === columnId ? <Check aria-hidden="true" className="ml-auto size-3.5" /> : null}</DropdownMenuItem>)}<p className="mt-1 border-t border-border px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">本列排序</p><DropdownMenuItem disabled={index === 0} onSelect={() => onMove(task, columnId, 0)}><MoveUp aria-hidden="true" className="size-3.5" />移到列首</DropdownMenuItem><DropdownMenuItem disabled={index === (columnTasks.get(columnId)?.length ?? 0) - 1} onSelect={() => onMove(task, columnId, columnTasks.get(columnId)?.length ?? 0)}><MoveDown aria-hidden="true" className="size-3.5" />移到列尾</DropdownMenuItem><DropdownMenuItem onSelect={() => onArchive(task)}><Archive aria-hidden="true" className="size-3.5" />归档任务</DropdownMenuItem><DropdownMenuItem className="text-danger" onSelect={() => onHardDelete(task)}><Trash2 aria-hidden="true" className="size-3.5" />直接删除</DropdownMenuItem></>}</DropdownMenuContent></DropdownMenu></div>
    <div className="mt-3 flex flex-wrap items-center gap-1.5 pl-8 text-[11px]"><span className={cn('priority-badge', `priority-${task.priority}`)}><CircleDot aria-hidden="true" className="size-3" />{priorityLabel[task.priority]}</span><span className="task-meta"><CalendarClock aria-hidden="true" className="size-3" />创建 {formatDate(task.createdAt)}</span>{task.estimateMinutes ? <span className="task-meta"><Clock3 aria-hidden="true" className="size-3" />{task.estimateMinutes} 分钟</span> : null}{task.dueAt ? <span className={cn('task-meta', overdue && 'border-danger/30 bg-danger-subtle text-danger')}><CalendarClock aria-hidden="true" className="size-3" />{overdue ? '已逾期 · ' : ''}{formatDate(task.dueAt)}</span> : null}{task.tags.length > 0 ? task.tags.slice(0, 2).map((tag) => <span className="task-meta" key={tag}>#{tag}</span>) : null}</div>
  </article>
}

function BoardLane({ column, tasks, allColumns, columnTasks, movingTaskId, onMove, onArchive, onRestore, onHardDelete, onSelect, onContextMenu, onQuickCreate }: { column: RenderColumn; tasks: Task[]; allColumns: RenderColumn[]; columnTasks: Map<string, Task[]>; movingTaskId: string | undefined; onMove: (task: Task, columnId: string, targetIndex: number) => void; onArchive: (task: Task) => void; onRestore: (task: Task) => void; onHardDelete: (task: Task) => void; onSelect: ((task: Task) => void) | undefined; onContextMenu: TaskContextMenuHandler | undefined; onQuickCreate: (column: RenderColumn) => void }): React.JSX.Element {
  const laneRef = useRef<HTMLDivElement | null>(null)
  const [over, setOver] = useState(false)
  // Synthetic columns are still rendered while the Service columns query is
  // loading. Keep their context menu available so the user always has an
  // obvious create affordance; openQuickCreate will surface a typed Service
  // limitation if placement cannot yet be resolved.
  const canCreate = column.status !== 'archived'
  const openQuickCreate = (event: MouseEvent | KeyboardEvent) => {
    if (!canCreate) return
    event.preventDefault()
    event.stopPropagation()
    onQuickCreate(column)
  }
  useEffect(() => {
    const element = laneRef.current
    if (!element || column.status === 'archived' || column.status === 'inbox') return
    return dropTargetForElements({ element, getData: (): TaskDropData => ({ kind: 'column-target', columnId: column.id, index: tasks.length }), canDrop: ({ source }) => source.data.kind === 'task', onDragEnter: () => setOver(true), onDragLeave: () => setOver(false), onDrop: () => setOver(false) })
  }, [column.id, column.status, tasks.length])
  return <section aria-labelledby={`column-${column.id}`} className="board-lane" onContextMenu={openQuickCreate} onKeyDown={(event) => { if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) openQuickCreate(event) }} role="region" tabIndex={0}><header className="flex h-11 items-center justify-between border-b border-border px-3"><div className="flex min-w-0 items-center gap-2"><span aria-hidden="true" className={cn('column-mark', `column-${column.status}`)} /><h2 className="truncate text-xs font-bold text-foreground" id={`column-${column.id}`}>{column.title}</h2></div><div className="flex items-center gap-1"><Button aria-label={`在${column.title}中创建任务`} disabled={!canCreate} onClick={(event) => { event.stopPropagation(); if (canCreate) onQuickCreate(column) }} size="icon" title={canCreate ? '在此列创建任务' : '归档列不支持直接创建'} variant="ghost"><Plus aria-hidden="true" className="size-4" /></Button><span aria-label={`${tasks.length} 个任务`} className="tabular-nums rounded bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">{tasks.length}</span></div></header><div className={cn('min-h-40 flex-1 space-y-2 overflow-y-auto p-2.5', over && 'bg-primary-subtle/65')} ref={laneRef}>{tasks.map((task, index) => <TaskCard columnId={column.id} columnTasks={columnTasks} columns={allColumns} index={index} key={task.id} moving={movingTaskId === task.id} onArchive={onArchive} onContextMenu={onContextMenu} onHardDelete={onHardDelete} onMove={onMove} onRestore={onRestore} onSelect={onSelect} task={task} />)}{tasks.length === 0 ? <div className="grid min-h-28 place-items-center rounded-md border border-dashed border-border px-3 text-center"><p className="text-xs leading-5 text-muted-foreground">{column.status === 'archived' ? '已归档任务会显示在这里' : column.status === 'inbox' ? '快速 Todo 会显示在这里' : '拖到这里，或使用任务菜单移动'}</p></div> : <p className="py-2 text-center text-[11px] text-muted-foreground">拖到列底移至末尾</p>}</div></section>
}

function boardColumns(projectId: string, serverColumns: BoardColumn[] | undefined): RenderColumn[] {
  const byStatus = new Map<TaskStatus, RenderColumn>((serverColumns ?? []).map((column) => [column.status as TaskStatus, column]))
  return taskStatuses.map((status, position) => byStatus.get(status) ?? ({ id: `status:${status}`, projectId, title: taskStatusLabel[status], status, position }))
}

export function TaskBoard({ projects, selectedProjectId, onSelectProject, showInbox = false, showArchived = false, dateRange, onSelectTask, onContextMenu }: { projects: Project[]; selectedProjectId: string | null; showInbox?: boolean; showArchived?: boolean; dateRange?: DateRange; onSelectProject: (projectId: string | null) => void; onSelectTask?: (task: Task) => void; onContextMenu?: TaskContextMenuHandler }): React.JSX.Element {
  const columnsQuery = useColumnsQuery(selectedProjectId)
  const tasksQuery = useTasksQuery({ ...(selectedProjectId ? { projectId: selectedProjectId as never } : {}), view: 'all', includeArchived: showArchived, ...(dateRange ? { dateRange } : {}) })
  const inboxQuery = useTasksQuery({ projectId: null, view: 'inbox', includeArchived: false, ...(dateRange ? { dateRange } : {}) })
  const [announcement, setAnnouncement] = useState('')
  const [quickCreateColumn, setQuickCreateColumn] = useState<RenderColumn | null>(null)
  const commands = useTaskCommands(setAnnouncement)
  const moveMutation = useMutation({ mutationFn: ({ task, columnId, targetIndex }: { task: Task; columnId: string; targetIndex: number }) => commands.move({ taskId: task.id, columnId, targetIndex, expectedRevision: task.revision }), onSuccess: (movedTask) => setAnnouncement(`已更新“${movedTask.title}”的任务状态`) })
  const columns = useMemo(() => boardColumns(selectedProjectId ?? projects[0]?.id ?? 'workspace', columnsQuery.data).filter((column) => showArchived || column.status !== 'archived'), [columnsQuery.data, projects, selectedProjectId, showArchived])
  // The inbox is a workspace-wide lane. Do not append unbound inbox tasks to
  // a project-scoped board; doing so made date/project filters appear to leak
  // records from another scope.
  const tasks = useMemo(() => { const includeInbox = showInbox && selectedProjectId === null; const all = [...(tasksQuery.data ?? []), ...(includeInbox ? (inboxQuery.data ?? []) : [])]; return Array.from(new Map(all.map((task) => [task.id, task])).values()) }, [inboxQuery.data, selectedProjectId, showInbox, tasksQuery.data])
  const columnTasks = useMemo(() => new Map(columns.map((column) => [column.id, tasksForColumn(tasks, column)])), [columns, tasks])
  const moveTask = (task: Task, columnId: string, targetIndex: number) => {
    if (!moveMutation.isPending) moveMutation.mutate({ task, columnId, targetIndex })
  }
  const openQuickCreate = (column: RenderColumn) => {
    if (column.status === 'archived') {
      setAnnouncement('已归档任务不能直接创建，请先恢复或选择其他状态列')
      return
    }
    setQuickCreateColumn(column)
  }
  const taskContextMenu: TaskContextMenuHandler | undefined = onContextMenu
    ? (target, event) => {
        const task = tasks.find((item) => item.id === target.id)
        onContextMenu(target, event, task ? {
          edit: () => onSelectTask?.(task),
          archive: () => commands.archive(task),
          delete: async () => { await commands.hardDelete(task) },
          restore: () => commands.restore(task),
          'hard-delete': async () => { await commands.hardDelete(task) }
        } : undefined)
      }
    : undefined
  useEffect(() => monitorForElements({ onDrop: ({ source, location }) => { const dragData = parseDragData(source.data); const dropData = parseDropData(location.current.dropTargets[0]?.data); if (!dragData || !dropData) return; const task = tasks.find((item) => item.id === dragData.taskId); if (!task) return; let targetIndex = dropData.index; if (dragData.columnId === dropData.columnId && dragData.index < dropData.index) targetIndex -= 1; if (dragData.columnId === dropData.columnId && dragData.index === targetIndex) return; moveTask(task, dropData.columnId, Math.max(0, targetIndex)) } }), [tasks, moveMutation.isPending])
return <div className="flex h-full min-h-0 flex-col overflow-hidden px-4 pb-4 pt-5 lg:px-6"><PageHeader actions={<><label className="sr-only" htmlFor="board-project">选择项目</label><select className="select-control min-w-48" id="board-project" onChange={(event) => onSelectProject(event.target.value || null)} value={selectedProjectId ?? ''}><option value="">全部任务</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><CreateTaskDialog defaultProjectId={selectedProjectId} projects={projects} trigger={<Button variant="primary"><Plus aria-hidden="true" className="size-4" />新建任务</Button>} /></>} description="五个主状态列；归档列按需显示，拖拽、键盘和任务菜单共享同一条 Command。" eyebrow="PROJECT / BOARD" title="任务看板" /><CreateTaskDialog defaultColumnId={quickCreateColumn?.id.startsWith('status:') ? null : quickCreateColumn?.id ?? null} defaultProjectId={quickCreateColumn?.status === 'inbox' ? null : selectedProjectId ?? quickCreateColumn?.projectId ?? projects[0]?.id ?? null} defaultStatus={quickCreateColumn?.status ?? 'planned'} onOpenChange={(next) => { if (!next) setQuickCreateColumn(null) }} open={quickCreateColumn !== null} projects={projects} /><p aria-live="polite" className="sr-only">{announcement}</p><div className="min-h-0 flex-1 pt-4">{columnsQuery.isLoading || tasksQuery.isLoading || (showInbox && inboxQuery.isLoading) ? <LoadingState label="正在排列任务…" /> : null}{columnsQuery.error ? <ErrorState error={columnsQuery.error} onRetry={() => void columnsQuery.refetch()} /> : null}{tasksQuery.error ? <ErrorState error={tasksQuery.error} onRetry={() => void tasksQuery.refetch()} /> : null}{moveMutation.error ? <div className="mb-3"><ErrorState compact error={moveMutation.error} onRetry={() => { const variables = moveMutation.variables; moveMutation.reset(); if (variables) moveMutation.mutate(variables) }} /></div> : null}{!columnsQuery.isLoading && !tasksQuery.isLoading && !columnsQuery.error && !tasksQuery.error ? <div className="board-grid h-full min-h-0 overflow-x-auto pb-2">{columns.map((column) => <BoardLane allColumns={columns.filter((item) => item.status !== 'inbox' && item.status !== 'archived')} column={column} columnTasks={columnTasks} key={column.id} movingTaskId={moveMutation.variables?.task.id} onArchive={(task) => { if (window.confirm(`归档“${task.title}”？`)) void commands.archive(task) }} onContextMenu={taskContextMenu} onHardDelete={(task) => { if (confirmHardDelete(task)) void commands.hardDelete(task) }} onMove={moveTask} onQuickCreate={openQuickCreate} onRestore={(task) => void commands.restore(task)} onSelect={onSelectTask} tasks={columnTasks.get(column.id) ?? []} />)}</div> : null}</div></div>
}

export function BoardErrorSummary({ error }: { error: unknown }): React.JSX.Element { return <p className="text-xs text-danger" role="alert">{getErrorMessage(error)}</p> }
