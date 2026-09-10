import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CalendarEvent,
  IntegrationProfile,
  Note,
  ObsidianIndexStatus,
  Paper,
  Project,
  ResourceLink,
  Task
} from '@prw/contracts'
import { Archive, CalendarDays, ExternalLink, Link2, NotebookPen, RefreshCw, Trash2 } from 'lucide-react'
import { EmptyState, ErrorState, LoadingState, PageHeader, UnavailableState } from '../components/states'
import { Button } from '../components/ui'
import { formatDate } from '../lib/utils'
import { getWorkbenchApi } from '../lib/workbench'
import {
  useCalendarQuery,
  useIntegrationsQuery,
  useMatrixQuery,
  useNotesQuery,
  usePapersQuery,
  useResourceLinksQuery,
  useTasksQuery
} from './queries'
import { TaskBoard } from './board'
import { LiteratureMatrixPage } from './research/matrix'

type ProjectTab = 'overview' | 'tasks' | 'literature' | 'matrix' | 'notes' | 'calendar' | 'resources' | 'knowledge'

const tabLabels: Record<ProjectTab, string> = {
  overview: '总览',
  tasks: '任务',
  literature: '文献',
  matrix: '文献矩阵',
  notes: 'Obsidian 笔记',
  calendar: '日历',
  resources: '资源关系',
  knowledge: '知识映射'
}

function statusLabel(status: Task['status']): string {
  return ({ inbox: '收件箱', planned: '计划中', in_progress: '进行中', blocked: '已阻塞', done: '已完成', canceled: '已取消', archived: '已归档' } as Record<Task['status'], string>)[status]
}

function calendarRange(projectId: Project['id'] | null): { startsAt: string; endsAt: string; timezone: string; projectId: Project['id'] | null } {
  const now = new Date()
  const startsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
  const endsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
  return { startsAt, endsAt, timezone: 'Asia/Shanghai', projectId }
}

function taskSummary(tasks: Task[]): { active: number; done: number; archived: number } {
  const active = tasks.filter((task) => task.status !== 'canceled' && task.status !== 'archived')
  return { active: active.length, done: active.filter((task) => task.status === 'done').length, archived: tasks.filter((task) => task.status === 'archived').length }
}

function ResourceRows({ links }: { links: ResourceLink[] }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [feedback, setFeedback] = useState<string | null>(null)
  const removeMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await getWorkbenchApi().resourceLinks.remove({ id })
    },
    onSuccess: async () => {
      setSelectedIds([])
      setFeedback(null)
      await queryClient.invalidateQueries({ queryKey: ['resource-links'] })
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : '资源关系删除失败，请刷新后重试。')
  })
  const visibleIds = links.map((link) => link.id)
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id))
  const toggleAll = () => setSelectedIds((current) => allSelected ? current.filter((id) => !visibleIds.includes(id)) : [...new Set([...current, ...visibleIds])])
  const remove = (ids: string[]) => {
    if (ids.length === 0 || removeMutation.isPending) return
    if (!window.confirm(`确认删除 ${ids.length} 条资源关系？此操作不可撤销。`)) return
    removeMutation.mutate(ids)
  }
  if (links.length === 0) return <EmptyState title="暂无资源关系" description="项目与任务、论文、笔记或日历事件的关系会显示在这里。" />
  return <div>
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs">
      <label className="inline-flex items-center gap-2 text-muted-foreground"><input aria-label="全选资源关系" checked={allSelected} className="research-checkbox" onChange={toggleAll} type="checkbox" />全选当前结果</label>
      <div className="flex items-center gap-2"><span className="text-muted-foreground">{selectedIds.length ? `已选 ${selectedIds.length}` : `${links.length} 条`}</span>{selectedIds.length ? <Button disabled={removeMutation.isPending} loading={removeMutation.isPending} onClick={() => remove(selectedIds)} size="sm" variant="danger"><Trash2 aria-hidden="true" className="size-3.5" />删除选中</Button> : null}</div>
    </div>
    {feedback ? <p className="form-feedback form-feedback-error px-4 py-2" role="alert">{feedback}</p> : null}
    <div className="divide-y divide-border">{links.map((link) => <div className="flex items-center gap-3 px-4 py-3" key={link.id}><input aria-label={`选择资源关系：${link.relationship}`} checked={selectedIds.includes(link.id)} className="research-checkbox" onChange={() => setSelectedIds((current) => current.includes(link.id) ? current.filter((id) => id !== link.id) : [...current, link.id])} type="checkbox" /><Link2 aria-hidden="true" className="size-4 shrink-0 text-primary" /><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-foreground">{link.relationship}</p><p className="mt-1 text-xs text-muted-foreground">{link.from.kind}:{link.from.id} → {link.to.kind}:{link.to.id}</p></div><span className="text-[11px] text-muted-foreground">{link.createdBy}</span><Button aria-label={`删除资源关系：${link.relationship}`} disabled={removeMutation.isPending} onClick={() => remove([link.id])} size="icon" variant="ghost"><Trash2 aria-hidden="true" className="size-3.5 text-danger" /></Button></div>)}</div>
  </div>
}

function NoteRows({ notes, onOpen, selectedPaths = [], onToggle = () => undefined, allSelected = false, onToggleAll = () => undefined, onDelete = () => undefined, deleting = false }: { notes: Note[]; onOpen: (note: Note) => void; selectedPaths?: readonly string[]; onToggle?: (path: string) => void; allSelected?: boolean; onToggleAll?: () => void; onDelete?: (paths: string[]) => void; deleting?: boolean }): React.JSX.Element {
  if (notes.length === 0) return <EmptyState title="索引中暂无笔记" description="请先在 Obsidian Vault 中创建 Markdown 笔记，或检查连接配置。" />
  const visible = notes.slice(0, 20)
  return <div>
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs">
      <label className="inline-flex items-center gap-2 text-muted-foreground"><input aria-label="全选项目笔记" checked={allSelected} className="research-checkbox" onChange={onToggleAll} type="checkbox" />全选当前结果</label>
      <div className="flex items-center gap-2"><span className="text-muted-foreground">{selectedPaths.length ? `已选 ${selectedPaths.length}` : `${visible.length} 条`}</span>{selectedPaths.length ? <Button disabled={deleting} loading={deleting} onClick={() => onDelete(selectedPaths as string[])} size="sm" variant="danger"><Trash2 aria-hidden="true" className="size-3.5" />删除选中</Button> : null}</div>
    </div>
    <div className="divide-y divide-border">{visible.map((note) => <div className="flex items-center gap-3 px-4 py-3" key={`${note.vaultId}:${note.relativePath}`}><input aria-label={`选择笔记：${note.title}`} checked={selectedPaths.includes(note.relativePath)} className="research-checkbox" onChange={() => onToggle(note.relativePath)} type="checkbox" /><button className="flex min-w-0 flex-1 items-center gap-3 text-left hover:text-primary" onClick={() => onOpen(note)} type="button"><NotebookPen aria-hidden="true" className="size-4 shrink-0 text-primary" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-foreground">{note.title}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{note.relativePath} · {formatDate(note.updatedAt)}</span></span><ExternalLink aria-hidden="true" className="size-3.5 text-muted-foreground" /></button><Button aria-label={`删除笔记：${note.title}`} disabled={deleting} onClick={() => onDelete([note.relativePath])} size="icon" variant="ghost"><Trash2 aria-hidden="true" className="size-3.5 text-danger" /></Button></div>)}</div>
  </div>
}

export function ProjectSpacePage({ projects }: { projects: Project[] }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [projectId, setProjectId] = useState<Project['id'] | null>(projects[0]?.id ?? null)
  const [tab, setTab] = useState<ProjectTab>('overview')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [selectedNote, setSelectedNote] = useState<Note | null>(null)
  const project = projects.find((item) => item.id === projectId) ?? null
  useEffect(() => {
    if (projectId && projects.some((item) => item.id === projectId)) return
    setProjectId(projects[0]?.id ?? null)
    setTab('overview')
    setSelectedNote(null)
  }, [projectId, projects])
  const archiveMutation = useMutation({
    mutationFn: () => {
      if (!project) throw new Error('请先选择项目。')
      return getWorkbenchApi().projects.archive(project.id, project.revision)
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      ])
      setProjectId(null)
      setTab('overview')
      setSelectedNote(null)
    }
  })
  const tasksQuery = useTasksQuery({ projectId, view: 'all', includeArchived })
  const papersQuery = usePapersQuery({ projectId: projectId ?? undefined, includeArchived: false })
  const matrixQuery = useMatrixQuery(projectId)
  const integrationsQuery = useIntegrationsQuery()
  const obsidianProfile = integrationsQuery.data?.find((profile) => profile.provider === 'obsidian' && profile.enabled) ?? null
  const notesQuery = useNotesQuery(obsidianProfile?.id ?? null, '', obsidianProfile?.revision)
  const resourcesQuery = useResourceLinksQuery(projectId ? { kind: 'project', id: projectId } : null)
  const range = useMemo(() => calendarRange(projectId), [projectId])
  const calendarQuery = useCalendarQuery(range)
  const progressQuery = useQuery({ queryKey: ['project-space-progress', projectId], queryFn: () => getWorkbenchApi().progress.project(projectId!), enabled: Boolean(projectId) })
  const indexQuery = useQuery<ObsidianIndexStatus, Error>({ queryKey: ['project-space-obsidian-index', obsidianProfile?.id], queryFn: () => getWorkbenchApi().obsidian.indexStatus({ profileId: obsidianProfile!.id }), enabled: Boolean(obsidianProfile) })
  const noteReadQuery = useQuery<Note, Error>({ queryKey: ['project-space-note', selectedNote?.vaultId, selectedNote?.relativePath], queryFn: () => getWorkbenchApi().notes.read({ vaultId: selectedNote!.vaultId, relativePath: selectedNote!.relativePath }), enabled: Boolean(selectedNote) })
  const papers = papersQuery.data ?? []
  const matrix = matrixQuery.data ?? []
  const events = calendarQuery.data ?? []
  const links = resourcesQuery.data ?? []

  if (projects.length === 0) return <div className="page-scroll"><PageHeader description="在一个项目上下文中查看任务、文献、笔记、日历和资源关系。" eyebrow="WORKSPACE / PROJECT" title="项目空间" /><div className="mt-4"><EmptyState kind="projects" title="尚无项目" description="先创建一个项目，再开始组织研究资源。" /></div></div>
 return <div className="page-scroll"><PageHeader actions={<div className="flex flex-wrap items-center gap-2"><label><span className="sr-only">选择项目空间</span><select aria-label="选择项目空间" className="select-control min-w-48" onChange={(event) => { const next = projects.find((item) => item.id === event.target.value)?.id ?? null; setProjectId(next); setTab('overview'); setSelectedNote(null) }} value={projectId ?? ''}>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{project ? <Button aria-label={`归档项目：${project.name}`} disabled={archiveMutation.isPending} loading={archiveMutation.isPending} onClick={() => { if (window.confirm(`归档项目“${project.name}”？项目任务会一并归档，但不会删除 Obsidian、Zotero 等外部内容。`)) archiveMutation.mutate() }} size="sm" variant="danger"><Archive aria-hidden="true" className="size-3.5" />归档项目</Button> : null}</div>} description="项目级聚合只读取已关联的本地数据；写操作回到各领域的 Command 和安全通道。归档可恢复，外部文件不会被删除。" eyebrow="WORKSPACE / PROJECT" title={project?.name ?? '项目空间'} />{archiveMutation.error ? <p className="form-feedback form-feedback-error mt-3" role="alert">项目归档失败：{archiveMutation.error instanceof Error ? archiveMutation.error.message : '请刷新后重试。'}</p> : null}{project ? <><div className="mt-4 flex min-w-0 gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="项目空间页面">{(Object.keys(tabLabels) as ProjectTab[]).map((item) => <button aria-selected={tab === item} className={`research-tab ${tab === item ? 'research-tab-active' : ''}`} key={item} onClick={() => setTab(item)} role="tab" type="button">{tabLabels[item]}</button>)}</div><div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted-foreground"><span>项目 ID：{project.id}</span><label className="ml-auto flex items-center gap-2"><input checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} type="checkbox" />任务包含已归档</label></div>{tab === 'overview' ? <Overview project={project} tasks={tasksQuery.data ?? []} tasksLoading={tasksQuery.isLoading} tasksError={tasksQuery.error} progress={progressQuery.data} progressLoading={progressQuery.isLoading} papers={papers} matrix={matrix} events={events} links={links} /> : null}{tab === 'tasks' ? <div className="mt-4"><TaskBoard onSelectProject={(next) => { const selected = projects.find((item) => item.id === next)?.id ?? null; setProjectId(selected) }} projects={projects} selectedProjectId={project.id} showArchived={includeArchived} showInbox={false} /></div> : null}{tab === 'literature' ? <Literature project={project} papers={papers} loading={papersQuery.isLoading} error={papersQuery.error} /> : null}{tab === 'matrix' ? <div className="mt-4"><LiteratureMatrixPage projects={[project]} /></div> : null}{tab === 'notes' ? <NotesPanelWithDelete profile={obsidianProfile} index={indexQuery.data} indexLoading={indexQuery.isLoading} indexError={indexQuery.error} notes={notesQuery.data ?? []} notesLoading={notesQuery.isLoading} notesError={notesQuery.error} selectedNote={selectedNote} noteRead={noteReadQuery.data} noteReadLoading={noteReadQuery.isLoading} onOpenNote={setSelectedNote} onRetryIndex={() => void indexQuery.refetch()} /> : null}{tab === 'calendar' ? <CalendarPanelWithDelete events={events} loading={calendarQuery.isLoading} error={calendarQuery.error} onRetry={() => void calendarQuery.refetch()} /> : null}{tab === 'resources' ? <section className="research-panel mt-4"><div className="research-panel-header"><h2 className="text-sm font-bold text-foreground">项目资源关系</h2></div>{resourcesQuery.isLoading ? <div className="p-4"><LoadingState label="正在读取资源关系…" /></div> : resourcesQuery.error ? <div className="p-4"><ErrorState error={resourcesQuery.error} onRetry={() => void resourcesQuery.refetch()} /></div> : <ResourceRows links={links} />}</section> : null}{tab === 'knowledge' ? <Knowledge notes={notesQuery.data ?? []} profile={obsidianProfile} /> : null}</> : null}</div>
}

function Overview({ project, tasks, tasksLoading, tasksError, progress, progressLoading, papers, matrix, events, links }: { project: Project; tasks: Task[]; tasksLoading: boolean; tasksError: unknown; progress: { percent: number; completedTasks: number; totalTasks: number; blockedTasks: number; overdueTasks: number } | undefined; progressLoading: boolean; papers: { id: string; title: string; status: string }[]; matrix: { id: string }[]; events: CalendarEvent[]; links: ResourceLink[] }): React.JSX.Element {
  const summary = taskSummary(tasks)
  return <div className="space-y-4"><section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4"><div className="research-panel p-4"><p className="instrument-label">PROJECT / STATUS</p><h2 className="mt-1 text-sm font-bold text-foreground">{project.status === 'active' ? '进行中' : project.status}</h2><p className="mt-2 line-clamp-3 text-xs text-muted-foreground">{project.description || '暂无项目说明'}</p></div><div className="research-panel p-4"><p className="instrument-label">PROGRESS</p>{progressLoading ? <p className="mt-3 text-xs text-muted-foreground">正在计算…</p> : progress ? <><strong className="mt-1 block text-3xl text-foreground">{progress.percent}%</strong><p className="mt-1 text-xs text-muted-foreground">{progress.completedTasks}/{progress.totalTasks} 项任务完成 · 阻塞 {progress.blockedTasks}</p></> : <p className="mt-3 text-xs text-muted-foreground">使用本地任务查询计算进度。</p>}<div className="mt-3 h-1.5 rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${progress?.percent ?? (summary.active ? Math.round(summary.done / summary.active * 100) : 0)}%` }} /></div></div><div className="research-panel p-4"><p className="instrument-label">RESEARCH</p><strong className="mt-1 block text-3xl text-foreground">{papers.length}</strong><p className="mt-1 text-xs text-muted-foreground">项目文献 · 矩阵 {matrix.length} 条</p></div><div className="research-panel p-4"><p className="instrument-label">NEXT WINDOW</p><strong className="mt-1 block text-3xl text-foreground">{events.length}</strong><p className="mt-1 text-xs text-muted-foreground">本月项目日历事件 · 截止 {formatDate(project.dueAt)}</p></div></section>{tasksLoading ? <LoadingState label="正在读取项目任务…" /> : tasksError ? <div><ErrorState error={tasksError} onRetry={() => window.location.reload()} /></div> : <section className="research-panel"><div className="research-panel-header"><div><p className="instrument-label">TASK SNAPSHOT</p><h2 className="mt-1 text-sm font-bold text-foreground">下一步任务</h2></div><span className="text-xs text-muted-foreground">活动 {summary.active} · 归档 {summary.archived}</span></div>{tasks.length === 0 ? <EmptyState title="项目还没有任务" description="在任务页创建任务或快速 Todo。" /> : <div className="divide-y divide-border">{tasks.filter((task) => task.status !== 'archived').slice(0, 8).map((task) => <div className="flex items-center gap-3 px-4 py-3" key={task.id}><span className={`status-dot status-${task.status}`} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-foreground">{task.title}</p><p className="mt-1 text-xs text-muted-foreground">{statusLabel(task.status)} · {task.dueAt ? formatDate(task.dueAt) : '无截止时间'}</p></div></div>)}</div>}</section>}<section className="grid gap-4 md:grid-cols-2"><div className="research-panel p-4"><p className="instrument-label">RELATIONSHIPS</p><p className="mt-2 text-sm text-foreground">{links.length} 条资源关系</p><p className="mt-1 text-xs leading-5 text-muted-foreground">未关联资源不会被推断为属于当前项目。</p></div><div className="research-panel p-4"><p className="instrument-label">ARCHIVE POLICY</p><p className="mt-2 text-sm text-foreground">归档可恢复，硬删除不可逆</p><p className="mt-1 text-xs leading-5 text-muted-foreground">永久删除仅在任务已归档、确认上下文有效时执行，并保持外部资源不变。</p></div></section></div>
}

function Literature({ project, papers, loading, error }: { project: Project; papers: Paper[]; loading: boolean; error: unknown }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [feedback, setFeedback] = useState<string | null>(null)
  const archiveMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const byId = new Map<string, Paper>(papers.map((paper) => [paper.id, paper]))
      for (const id of ids) {
        const paper = byId.get(id)
        if (paper) await getWorkbenchApi().papers.archive(paper.id, paper.revision)
      }
    },
    onSuccess: async () => {
      setSelectedIds([])
      setFeedback(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['papers'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['project-space-progress', project.id] })
      ])
    },
    onError: (err) => setFeedback(err instanceof Error ? err.message : '文献删除失败，请刷新后重试。')
  })
  useEffect(() => {
    const available = new Set<string>(papers.map((paper) => paper.id))
    setSelectedIds((current) => current.filter((id) => available.has(id)))
  }, [papers])
  const allSelected = papers.length > 0 && papers.every((paper) => selectedIds.includes(paper.id))
  const toggleAll = () => setSelectedIds((current) => allSelected ? current.filter((id) => !papers.some((paper) => paper.id === id)) : [...new Set([...current, ...papers.map((paper) => paper.id)])])
  const archive = (ids: string[]) => {
    if (ids.length === 0 || archiveMutation.isPending) return
    if (!window.confirm(`确认删除 ${ids.length} 篇项目文献？文献将被归档，可在文献页恢复或继续处理。`)) return
    archiveMutation.mutate(ids)
  }
  if (loading) return <div className="mt-4"><LoadingState label="正在读取项目文献…" /></div>
  if (error) return <div className="mt-4"><ErrorState error={error} onRetry={() => window.location.reload()} /></div>
  return <section className="research-panel mt-4"><div className="research-panel-header"><div><p className="instrument-label">PAPERS / PROJECT</p><h2 className="mt-1 text-sm font-bold text-foreground">{project.name} 的文献</h2></div><div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">{papers.length} 条</span>{papers.length ? <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><input aria-label="全选项目文献" checked={allSelected} className="research-checkbox" onChange={toggleAll} type="checkbox" />全选</label> : null}{selectedIds.length ? <Button disabled={archiveMutation.isPending} loading={archiveMutation.isPending} onClick={() => archive(selectedIds)} size="sm" variant="danger"><Trash2 aria-hidden="true" className="size-3.5" />删除选中</Button> : null}</div></div>{feedback ? <p className="form-feedback form-feedback-error px-4 py-2" role="alert">{feedback}</p> : null}{papers.length === 0 ? <EmptyState title="项目还没有文献" description="从 Literature 页面导入或创建论文后，这里会显示项目关联结果。" /> : <div className="divide-y divide-border">{papers.map((paper) => <article className="flex items-start gap-3 px-4 py-3" key={paper.id}><input aria-label={`选择文献：${paper.title}`} checked={selectedIds.includes(paper.id)} className="research-checkbox mt-1" onChange={() => setSelectedIds((current) => current.includes(paper.id) ? current.filter((id) => id !== paper.id) : [...current, paper.id])} type="checkbox" /><div className="min-w-0 flex-1"><h3 className="text-sm font-bold text-foreground">{paper.title}</h3><p className="mt-1 text-xs text-muted-foreground">{paper.authors.join('、') || '未记录作者'} · {paper.year ?? '年份未知'} · {paper.status}</p></div>{paper.url ? <Button aria-label={`打开论文：${paper.title}`} onClick={() => void getWorkbenchApi().system.openExternal(paper.url!)} size="icon" variant="ghost"><ExternalLink aria-hidden="true" className="size-4" /></Button> : null}<Button aria-label={`删除文献：${paper.title}`} disabled={archiveMutation.isPending} onClick={() => archive([paper.id])} size="icon" variant="ghost"><Trash2 aria-hidden="true" className="size-3.5 text-danger" /></Button></article>)}</div>}</section>
}

function NotesPanel({ profile, index, indexLoading, indexError, notes, notesLoading, notesError, selectedNote, noteRead, noteReadLoading, onOpenNote, onRetryIndex }: { profile: IntegrationProfile | null; index: ObsidianIndexStatus | undefined; indexLoading: boolean; indexError: unknown; notes: Note[]; notesLoading: boolean; notesError: unknown; selectedNote: Note | null; noteRead: Note | undefined; noteReadLoading: boolean; onOpenNote: (note: Note | null) => void; onRetryIndex: () => void }): React.JSX.Element {
  return <div className="space-y-4"><section className="research-panel"><div className="research-panel-header"><div><p className="instrument-label">OBSIDIAN / INDEX</p><h2 className="mt-1 text-sm font-bold text-foreground">项目笔记索引</h2></div>{profile ? <Button aria-label="刷新 Obsidian 索引状态" onClick={onRetryIndex} size="icon" variant="ghost"><RefreshCw aria-hidden="true" className="size-4" /></Button> : null}</div>{!profile ? <div className="p-4"><UnavailableState feature="Obsidian" description="没有启用 Obsidian 连接；不会把本地路径显示为已连接。" /></div> : indexLoading ? <div className="p-4"><LoadingState label="正在扫描 Vault…" /></div> : indexError ? <div className="p-4"><ErrorState error={indexError} onRetry={onRetryIndex} /></div> : <div className="flex flex-wrap items-center gap-3 p-4 text-xs text-muted-foreground"><span className={index?.status === 'ready' ? 'text-success' : 'text-warning'}>状态：{index?.status === 'ready' ? '就绪' : index?.status === 'changed' ? '有变化' : index?.status === 'error' ? '错误' : '未配置'}</span><span>索引笔记 {index?.noteCount ?? 0} 条</span><span>{index?.indexedAt ? `更新时间 ${formatDate(index.indexedAt)}` : '尚未建立索引'}</span></div>}</section>{profile ? <section className="research-panel"><div className="research-panel-header"><div><p className="instrument-label">NOTES / SAFE OPEN</p><h2 className="mt-1 text-sm font-bold text-foreground">Vault 笔记</h2></div><span className="text-xs text-muted-foreground">仅显示相对路径，项目关联由 frontmatter/目录关系决定</span></div>{notesLoading ? <div className="p-4"><LoadingState label="正在读取笔记索引…" /></div> : notesError ? <div className="p-4"><ErrorState error={notesError} onRetry={() => window.location.reload()} /></div> : <NoteRows notes={notes} onOpen={onOpenNote} />}</section> : null}{selectedNote ? <section className="research-panel"><div className="research-panel-header"><div><p className="instrument-label">NOTE / READ</p><h2 className="mt-1 truncate text-sm font-bold text-foreground">{selectedNote.relativePath}</h2></div><Button onClick={() => onOpenNote(null)} size="sm" variant="ghost">关闭</Button></div>{noteReadLoading ? <div className="p-4"><LoadingState label="正在安全读取笔记…" /></div> : noteRead?.content ? <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap px-4 py-4 text-sm leading-6 text-foreground">{noteRead.content}</pre> : <div className="p-4"><UnavailableState feature="笔记正文" description="服务未返回可读正文；没有复制或猜测外部内容。" /></div>}</section> : null}</div>
}

function NotesPanelWithDelete({ profile, index, indexLoading, indexError, notes, notesLoading, notesError, selectedNote, noteRead, noteReadLoading, onOpenNote, onRetryIndex }: { profile: IntegrationProfile | null; index: ObsidianIndexStatus | undefined; indexLoading: boolean; indexError: unknown; notes: Note[]; notesLoading: boolean; notesError: unknown; selectedNote: Note | null; noteRead: Note | undefined; noteReadLoading: boolean; onOpenNote: (note: Note | null) => void; onRetryIndex: () => void }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [feedback, setFeedback] = useState<string | null>(null)
  const deleteMutation = useMutation({
    mutationFn: async (paths: string[]) => {
      const byPath = new Map(notes.map((note) => [note.relativePath, note]))
      for (const path of paths) {
        const note = byPath.get(path)
        if (note) await getWorkbenchApi().notes.delete({ vaultId: note.vaultId, relativePath: note.relativePath, expectedFingerprint: note.fingerprint })
      }
    },
    onSuccess: async () => {
      setSelectedPaths([])
      setFeedback(null)
      onOpenNote(null)
      await queryClient.invalidateQueries({ queryKey: ['notes'] })
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : '笔记删除失败，请重新索引后重试。')
  })
  useEffect(() => {
    const available = new Set(notes.map((note) => note.relativePath))
    setSelectedPaths((current) => current.filter((path) => available.has(path)))
  }, [notes])
  const visible = notes.slice(0, 20)
  const allSelected = visible.length > 0 && visible.every((note) => selectedPaths.includes(note.relativePath))
  const toggleAll = () => setSelectedPaths((current) => allSelected ? current.filter((path) => !visible.some((note) => note.relativePath === path)) : [...new Set([...current, ...visible.map((note) => note.relativePath)])])
  const remove = (paths: string[]) => {
    if (paths.length === 0 || deleteMutation.isPending) return
    if (!window.confirm(`确认删除 ${paths.length} 个 Markdown 笔记？此操作会删除 Vault 文件且不可撤销。`)) return
    deleteMutation.mutate(paths)
  }
  return <div className="space-y-4"><section className="research-panel"><div className="research-panel-header"><div><p className="instrument-label">OBSIDIAN / INDEX</p><h2 className="mt-1 text-sm font-bold text-foreground">项目笔记索引</h2></div>{profile ? <Button aria-label="刷新 Obsidian 索引状态" onClick={onRetryIndex} size="icon" variant="ghost"><RefreshCw aria-hidden="true" className="size-4" /></Button> : null}</div>{!profile ? <div className="p-4"><UnavailableState feature="Obsidian" description="没有启用 Obsidian 连接；不会把本地路径显示为已连接。" /></div> : indexLoading ? <div className="p-4"><LoadingState label="正在扫描 Vault…" /></div> : indexError ? <div className="p-4"><ErrorState error={indexError} onRetry={onRetryIndex} /></div> : <div className="flex flex-wrap items-center gap-3 p-4 text-xs text-muted-foreground"><span className={index?.status === 'ready' ? 'text-success' : 'text-warning'}>状态：{index?.status === 'ready' ? '就绪' : index?.status === 'changed' ? '有变化' : index?.status === 'error' ? '错误' : '未配置'}</span><span>索引笔记 {index?.noteCount ?? 0} 条</span><span>{index?.indexedAt ? `更新时间 ${formatDate(index.indexedAt)}` : '尚未建立索引'}</span></div>}</section>{profile ? <section className="research-panel"><div className="research-panel-header"><div><p className="instrument-label">NOTES / SAFE OPEN</p><h2 className="mt-1 text-sm font-bold text-foreground">Vault 笔记</h2></div><span className="text-xs text-muted-foreground">仅显示相对路径，项目关联由 frontmatter/目录关系决定</span></div>{feedback ? <p className="form-feedback form-feedback-error px-4 py-2" role="alert">{feedback}</p> : null}{notesLoading ? <div className="p-4"><LoadingState label="正在读取笔记索引…" /></div> : notesError ? <div className="p-4"><ErrorState error={notesError} onRetry={() => window.location.reload()} /></div> : <NoteRows allSelected={allSelected} deleting={deleteMutation.isPending} notes={notes} onDelete={remove} onOpen={onOpenNote} onToggle={(path) => setSelectedPaths((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path])} onToggleAll={toggleAll} selectedPaths={selectedPaths} />}</section> : null}{selectedNote ? <section className="research-panel"><div className="research-panel-header"><div><p className="instrument-label">NOTE / READ</p><h2 className="mt-1 truncate text-sm font-bold text-foreground">{selectedNote.relativePath}</h2></div><Button onClick={() => onOpenNote(null)} size="sm" variant="ghost">关闭</Button></div>{noteReadLoading ? <div className="p-4"><LoadingState label="正在安全读取笔记…" /></div> : noteRead?.content ? <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap px-4 py-4 text-sm leading-6 text-foreground">{noteRead.content}</pre> : <div className="p-4"><UnavailableState feature="笔记正文" description="服务未返回可读正文；没有复制或猜测外部内容。" /></div>}</section> : null}</div>
}

function CalendarPanel({ events, loading, error, onRetry }: { events: CalendarEvent[]; loading: boolean; error: unknown; onRetry: () => void }): React.JSX.Element {
  if (loading) return <div className="mt-4"><LoadingState label="正在读取项目日历…" /></div>
  if (error) return <div className="mt-4"><ErrorState error={error} onRetry={onRetry} /></div>
  return <section className="research-panel mt-4"><div className="research-panel-header"><div><p className="instrument-label">CALENDAR / PROJECT</p><h2 className="mt-1 text-sm font-bold text-foreground">项目日历投影</h2></div><span className="text-xs text-muted-foreground">当前月份 · {events.length} 条事件</span></div>{events.length === 0 ? <EmptyState title="当前月份没有项目事件" description="日历事件需带有当前 projectId 才会显示在项目空间。" /> : <div className="divide-y divide-border">{events.map((event) => <div className="flex items-start gap-3 px-4 py-3" key={event.id}><CalendarDays aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" /><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-foreground">{event.title}</p><p className="mt-1 text-xs text-muted-foreground">{formatDate(event.startsAt)} – {formatDate(event.endsAt)} · {event.type}</p></div></div>)}</div>}</section>
}

function CalendarPanelWithDelete({ events, loading, error, onRetry }: { events: CalendarEvent[]; loading: boolean; error: unknown; onRetry: () => void }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [feedback, setFeedback] = useState<string | null>(null)
  const editable = events.filter((event) => !event.readOnly && event.revision !== null)
  const deleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const byId = new Map(editable.map((event) => [event.id, event]))
      for (const id of ids) {
        const event = byId.get(id)
        if (event && !event.readOnly && event.revision !== null) await getWorkbenchApi().calendar.remove(event.id, event.revision)
      }
    },
    onSuccess: async () => {
      setSelectedIds([])
      setFeedback(null)
      await queryClient.invalidateQueries({ queryKey: ['calendar'] })
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : '日历事件删除失败，请刷新后重试。')
  })
  useEffect(() => {
    const available = new Set(editable.map((event) => event.id))
    setSelectedIds((current) => current.filter((id) => available.has(id)))
  }, [events])
  const allSelected = editable.length > 0 && editable.every((event) => selectedIds.includes(event.id))
  const toggleAll = () => setSelectedIds((current) => allSelected ? current.filter((id) => !editable.some((event) => event.id === id)) : [...new Set([...current, ...editable.map((event) => event.id)])])
  const remove = (ids: string[]) => {
    if (ids.length === 0 || deleteMutation.isPending) return
    if (!window.confirm(`确认删除 ${ids.length} 条项目日历事件？此操作不可撤销。`)) return
    deleteMutation.mutate(ids)
  }
  if (loading) return <div className="mt-4"><LoadingState label="正在读取项目日历…" /></div>
  if (error) return <div className="mt-4"><ErrorState error={error} onRetry={onRetry} /></div>
  return <section className="research-panel mt-4"><div className="research-panel-header"><div><p className="instrument-label">CALENDAR / PROJECT</p><h2 className="mt-1 text-sm font-bold text-foreground">项目日历投影</h2></div><div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">当前月份 · {events.length} 条事件</span>{editable.length ? <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><input aria-label="全选项目日历事件" checked={allSelected} className="research-checkbox" onChange={toggleAll} type="checkbox" />全选</label> : null}{selectedIds.length ? <Button disabled={deleteMutation.isPending} loading={deleteMutation.isPending} onClick={() => remove(selectedIds)} size="sm" variant="danger"><Trash2 aria-hidden="true" className="size-3.5" />删除选中</Button> : null}</div></div>{feedback ? <p className="form-feedback form-feedback-error px-4 py-2" role="alert">{feedback}</p> : null}{events.length === 0 ? <EmptyState title="当前月份没有项目事件" description="日历事件需带有当前 projectId 才会显示在项目空间。" /> : <div className="divide-y divide-border">{events.map((event) => <div className="flex items-start gap-3 px-4 py-3" key={event.id}>{event.readOnly ? <span className="mt-1 w-4 shrink-0" /> : <input aria-label={`选择事件：${event.title}`} checked={selectedIds.includes(event.id)} className="research-checkbox mt-1" onChange={() => setSelectedIds((current) => current.includes(event.id) ? current.filter((id) => id !== event.id) : [...current, event.id])} type="checkbox" />}<CalendarDays aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" /><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-foreground">{event.title}</p><p className="mt-1 text-xs text-muted-foreground">{formatDate(event.startsAt)} – {formatDate(event.endsAt)} · {event.type}{event.readOnly ? ' · 只读投影' : ''}</p></div>{event.readOnly ? <span className="research-tag">只读</span> : <Button aria-label={`删除事件：${event.title}`} disabled={deleteMutation.isPending} onClick={() => remove([event.id])} size="icon" variant="ghost"><Trash2 aria-hidden="true" className="size-3.5 text-danger" /></Button>}</div>)}</div>}</section>
}

function Knowledge({ profile, notes }: { profile: IntegrationProfile | null; notes: Note[] }): React.JSX.Element {
  const folderCounts = new Map<string, number>()
  for (const note of notes) {
    const segments = note.relativePath.split('/')
    // A root-level Markdown file is a note, not a taxonomy category.  Only
    // direct child folders are shown here so deleting a category can never be
    // confused with deleting an individual root note.
    const folder = segments.length > 1 ? segments[0] : null
    if (folder && folder !== '.obsidian') folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1)
  }
  const queryClient = useQueryClient()
  // The note index only contains Markdown files, so it cannot reveal an
  // empty category. A read-only layout preview supplies the authoritative
  // root taxonomy and lets this aggregate tab offer the same delete controls
  // as the dedicated Obsidian page.
  const layoutQuery = useQuery({
    queryKey: ['project-space-vault-layout', profile?.id ?? 'none'],
    queryFn: () => getWorkbenchApi().obsidian.vaultLayout.preview({ profileId: profile!.id }),
    enabled: Boolean(profile)
  })
  for (const category of layoutQuery.data?.categories ?? []) {
    if (category.name !== '.obsidian' && !folderCounts.has(category.name)) folderCounts.set(category.name, 0)
  }
  const folders = [...folderCounts.entries()].sort(([left], [right]) => left.localeCompare(right))
  const [selectedFolders, setSelectedFolders] = useState<string[]>([])
  const [feedback, setFeedback] = useState<string | null>(null)
  const deleteFolders = useMutation({
    mutationFn: async (paths: readonly string[]) => {
      if (!profile) throw new Error('未配置 Obsidian Vault。')
      return Promise.all(paths.map((relativePath) => getWorkbenchApi().notes.deleteFolder({ vaultId: profile.id, relativePath })))
    },
    onSuccess: async (receipts) => {
      setSelectedFolders([])
      const blocked = receipts.filter((receipt) => receipt.status === 'not-empty')
      const deleted = receipts.filter((receipt) => receipt.status === 'deleted').length
      setFeedback(blocked.length > 0
        ? `${blocked.map((receipt) => `${receipt.relativePath} 仍有 ${receipt.remainingEntries} 个条目，请先清空文件夹。`).join('；')}${deleted > 0 ? ` 已删除 ${deleted} 个空分类。` : ''}`
        : `已删除 ${deleted} 个空分类。`)
      // The aggregate tab and the dedicated Obsidian page share this query
      // family; invalidate all note indexes so both views reflect the result.
      await queryClient.invalidateQueries({ queryKey: ['notes'] })
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : '分类删除失败，请刷新后重试。')
  })
  useEffect(() => {
    const available = new Set(folders.map(([folder]) => folder))
    setSelectedFolders((current) => current.filter((folder) => available.has(folder)))
  }, [notes])
  const allSelected = folders.length > 0 && folders.every(([folder]) => selectedFolders.includes(folder))
  const toggleAll = () => setSelectedFolders((current) => allSelected ? [] : folders.map(([folder]) => folder))
  const remove = (paths: readonly string[]) => {
    if (paths.length === 0 || deleteFolders.isPending) return
    if (!window.confirm(`确认删除 ${paths.length} 个知识库分类？仅允许删除空文件夹，不会递归删除文件。`)) return
    deleteFolders.mutate(paths)
  }
  if (!profile) return <div className="mt-4"><UnavailableState feature="Obsidian 知识库" description="未配置 Obsidian Vault；不会伪造 AnythingLLM/LLMWiki 分类或连接状态。" /></div>
  return <section className="research-panel mt-4"><div className="research-panel-header"><div><p className="instrument-label">VAULT / CATEGORIES</p><h2 className="text-sm font-bold text-foreground">知识库分类</h2></div><div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">仅显示扫描到的根级目录</span>{folders.length > 0 ? <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><input aria-label="全选知识库分类" checked={allSelected} className="research-checkbox" onChange={toggleAll} type="checkbox" />全选</label> : null}{selectedFolders.length > 0 ? <Button aria-label="删除选中的知识库分类" disabled={deleteFolders.isPending} loading={deleteFolders.isPending} onClick={() => remove(selectedFolders)} size="sm" variant="danger"><Trash2 aria-hidden="true" className="size-3.5" />删除分类</Button> : null}</div></div>{feedback ? <p className="form-feedback form-feedback-error px-4 py-2" role="alert">{feedback}</p> : null}{folders.length === 0 ? <div className="p-4"><EmptyState title="暂无可用分类" description="初始化或在 Vault 根目录创建分类后，重新索引即可显示。" /></div> : <div className="divide-y divide-border">{folders.map(([folder, count]) => <div className="flex items-center gap-3 px-4 py-3" key={folder}><input aria-label={`选择知识库分类：${folder}`} checked={selectedFolders.includes(folder)} className="research-checkbox" onChange={() => setSelectedFolders((current) => current.includes(folder) ? current.filter((item) => item !== folder) : [...current, folder])} type="checkbox" /><NotebookPen aria-hidden="true" className="size-4 text-primary" /><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-foreground">{folder}</p><p className="mt-1 text-xs text-muted-foreground">来自共享 Vault 根目录，项目通过 Markdown 标签隔离。</p></div><span className="text-xs text-muted-foreground">{count} 个文件</span><Button aria-label={`删除知识库分类：${folder}`} disabled={deleteFolders.isPending} onClick={() => remove([folder])} size="icon" variant="ghost"><Trash2 aria-hidden="true" className="size-3.5 text-danger" /></Button></div>)}</div>}</section>
}
