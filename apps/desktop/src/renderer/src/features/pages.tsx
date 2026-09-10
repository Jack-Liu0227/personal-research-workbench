import type { Project, TaskListFilter, TaskPriority, TaskStatus } from '@prw/contracts'
import {
  ArrowRight,
  BookOpenText,
  CalendarClock,
  FileStack,
  CheckCircle2,
  CircleDot,
  Clock3,
  FolderKanban,
  Inbox,
  Plus,
  TriangleAlert
} from 'lucide-react'
import type { ReactNode } from 'react'
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/states'
import { Button } from '../components/ui'
import { cn, formatDate } from '../lib/utils'
import { CreateProjectDialog, CreateTaskDialog } from './forms'
import { useAgentInboxQuery, useArtifactsQuery, useDashboardQuery, usePapersQuery, useTasksQuery } from './queries'

const statusLabel: Record<TaskStatus, string> = {
  inbox: '收件箱',
  planned: '已计划',
  in_progress: '进行中',
  blocked: '受阻',
  done: '已完成',
  canceled: '已取消',
  archived: '已归档'
}

const priorityLabel: Record<TaskPriority, string> = {
  low: '低',
  normal: '普通',
  high: '高',
  urgent: '紧急'
}

type LegacyTaskView = Extract<TaskListFilter['view'], 'inbox' | 'today' | 'upcoming' | 'overdue' | 'completed'>
const legacyTaskMeta: Record<LegacyTaskView, { eyebrow: string; title: string; description: string; empty: string }> = {
  inbox: { eyebrow: 'TASKS / INBOX', title: '收件箱', description: '未绑定项目的 Todo 随记。', empty: '收件箱已清空' },
  today: { eyebrow: 'TASKS / TODAY', title: '今日任务', description: '今天到期的任务。', empty: '今天没有到期任务' },
  upcoming: { eyebrow: 'TASKS / UPCOMING', title: '近期计划', description: '接下来需要推进的任务。', empty: '近期无到期任务' },
  overdue: { eyebrow: 'TASKS / OVERDUE', title: '已逾期', description: '超过截止时间的任务。', empty: '没有逾期任务' },
  completed: { eyebrow: 'TASKS / COMPLETED', title: '已完成', description: '已完成的研究行动。', empty: '还没有完成记录' }
}

function MetricButton({
  label,
  value,
  icon,
  tone = 'default',
  onClick
}: {
  label: string
  value: number
  icon: ReactNode
  tone?: 'default' | 'risk' | 'success'
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      className={cn(
        'metric-card group cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        tone === 'risk' && 'metric-risk',
        tone === 'success' && 'metric-success'
      )}
      onClick={onClick}
      type="button"
    >
      <span className="flex items-center justify-between text-muted-foreground">
        <span className="text-xs font-semibold">{label}</span>
        {icon}
      </span>
      <span className="mt-4 flex items-end justify-between">
        <strong className="tabular-nums text-3xl font-bold tracking-tight text-foreground">{value}</strong>
        <ArrowRight aria-hidden="true" className="mb-1 size-4 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none" />
      </span>
    </button>
  )
}

export function OverviewPage({
  projects,
  onNavigate,
  onOpenBoard
}: {
  projects: Project[]
  onNavigate: (view: 'tasks' | 'literature' | 'agent' | 'project') => void
  onOpenBoard: (projectId: string) => void
}): React.JSX.Element {
  const dashboard = useDashboardQuery()
  const todayTasks = useTasksQuery({ view: 'today' })
  const upcomingTasks = useTasksQuery({ view: 'upcoming' })
  const queuedPapers = usePapersQuery({ status: 'queued' })
  const recentArtifacts = useArtifactsQuery({})
  const agentInbox = useAgentInboxQuery(true)

  return (
    <div className="page-scroll">
      <PageHeader
        actions={(
          <>
            <CreateProjectDialog trigger={<Button aria-label="新建项目"><FolderKanban aria-hidden="true" className="size-4" />新建项目</Button>} />
            <CreateTaskDialog projects={projects} trigger={<Button variant="primary"><Plus aria-hidden="true" className="size-4" />新建任务</Button>} />
          </>
        )}
        description="把今天的注意力放在可推进的研究行动上。所有数字和列表均来自本地 SQLite；没有记录时会明确显示为空。"
        eyebrow="WORKBENCH / OVERVIEW"
        title="今日工作面"
      />
      {dashboard.isLoading ? <div className="mt-5"><LoadingState label="正在计算进度…" /></div> : null}
      {dashboard.error ? <div className="mt-5"><ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} /></div> : null}
      {dashboard.data ? (
        <>
          <section className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="任务概览">
            <MetricButton icon={<Inbox aria-hidden="true" className="size-4" />} label="收件箱" onClick={() => onNavigate('tasks')} value={dashboard.data.inboxCount} />
            <MetricButton icon={<CalendarClock aria-hidden="true" className="size-4" />} label="今日到期" onClick={() => onNavigate('tasks')} value={dashboard.data.dueTodayCount} />
            <MetricButton icon={<TriangleAlert aria-hidden="true" className="size-4" />} label="已逾期" onClick={() => onNavigate('tasks')} tone="risk" value={dashboard.data.overdueCount} />
            <MetricButton icon={<CheckCircle2 aria-hidden="true" className="size-4" />} label="本周完成" onClick={() => onNavigate('tasks')} tone="success" value={dashboard.data.completedThisWeekCount} />
          </section>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">收件箱是尚未绑定项目的快速 Todo；“待读文献”来自 Paper 的 queued 状态；科研产物来自本地 Agent/Artifact 记录，不是演示数据。</p>

          <section className="mt-7" aria-labelledby="project-progress-title">
            <div className="mb-3 flex items-end justify-between gap-4">
              <div>
                <p className="instrument-label">PORTFOLIO / PROGRESS</p>
                <h2 className="mt-1 text-base font-bold text-foreground" id="project-progress-title">项目进度</h2>
              </div>
              <span className="text-xs text-muted-foreground">{projects.length} 个活跃项目</span>
            </div>
            {projects.length === 0 ? (
              <EmptyState
                action={<CreateProjectDialog trigger={<Button variant="primary"><Plus aria-hidden="true" className="size-4" />创建项目</Button>} />}
                description="项目将任务、进度和后续的文献产出组织在同一个上下文里。"
                kind="projects"
                title="建立第一个研究项目"
              />
            ) : (
              <div className="overflow-hidden rounded-lg border border-border bg-surface">
                {projects.map((project) => {
                  const progress = dashboard.data.projects.find((item) => item.projectId === project.id)
                  return (
                    <button
                      className="project-row group w-full cursor-pointer text-left outline-none focus-visible:bg-primary-subtle focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      key={project.id}
                      onClick={() => onOpenBoard(project.id)}
                      type="button"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">{project.name}</p>
                        <p className="mt-1 truncate text-xs text-muted-foreground">{project.description || '暂无项目说明'}</p>
                      </div>
                      <div className="min-w-36">
                        <div className="mb-1.5 flex justify-between text-[11px] text-muted-foreground">
                          <span>{progress?.completedTasks ?? 0}/{progress?.totalTasks ?? 0} 任务</span>
                          <span className="tabular-nums font-semibold text-foreground">{progress?.percent ?? 0}%</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            aria-hidden="true"
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${progress?.percent ?? 0}%` }}
                          />
                        </div>
                      </div>
                      <div className="hidden min-w-24 text-right text-[11px] text-muted-foreground md:block">
                        {progress?.blockedTasks ? <span className="text-danger">{progress.blockedTasks} 项受阻</span> : '进展正常'}
                      </div>
                      <ArrowRight aria-hidden="true" className="size-4 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none" />
                    </button>
                  )
                })}
              </div>
            )}
          </section>
          <section className="mt-7 grid gap-4 xl:grid-cols-2" aria-label="今日研究资源">
            <DashboardResourceCard title="今日任务" eyebrow="TODAY / TASKS">
              {todayTasks.isLoading ? <p className="research-empty-inline">正在读取今日任务…</p> : todayTasks.error ? <p className="form-feedback form-feedback-error m-3" role="alert">今日任务读取失败，请打开任务页重试。</p> : todayTasks.data?.length ? todayTasks.data.slice(0, 5).map((task) => <button className="dashboard-list-row w-full text-left" key={task.id} onClick={() => onNavigate('tasks')} title={`打开任务：${task.title}`} type="button"><span className="status-led" /><span className="min-w-0 flex-1 truncate">{task.title}</span><span className="text-[11px] text-muted-foreground">{priorityLabel[task.priority]}</span></button>) : <p className="research-empty-inline">今天没有到期任务。</p>}
            </DashboardResourceCard>
            <DashboardResourceCard title="未来七天截止" eyebrow="UPCOMING / DEADLINES">
              {upcomingTasks.isLoading ? <p className="research-empty-inline">正在读取近期任务…</p> : upcomingTasks.error ? <p className="form-feedback form-feedback-error m-3" role="alert">近期任务读取失败，请打开任务页重试。</p> : upcomingTasks.data?.length ? upcomingTasks.data.slice(0, 5).map((task) => <button className="dashboard-list-row w-full text-left" key={task.id} onClick={() => onNavigate('tasks')} title={`打开任务：${task.title}`} type="button"><span className="status-led" /><span className="min-w-0 flex-1 truncate">{task.title}</span><span className="text-[11px] text-muted-foreground">{formatDate(task.dueAt)}</span></button>) : <p className="research-empty-inline">未来七天没有截止任务。</p>}
            </DashboardResourceCard>
            <DashboardResourceCard title="待读文献" eyebrow="LITERATURE / QUEUED">
              {queuedPapers.isLoading ? <p className="research-empty-inline">正在读取待读文献…</p> : queuedPapers.error ? <p className="form-feedback form-feedback-error m-3" role="alert">待读文献读取失败，请打开文献检索页重试。</p> : queuedPapers.data?.length ? queuedPapers.data.slice(0, 5).map((paper) => <button className="dashboard-list-row w-full text-left" key={paper.id} onClick={() => onNavigate('literature')} title={`打开文献：${paper.title}`} type="button"><BookOpenText aria-hidden="true" className="size-3.5 text-primary" /><span className="min-w-0 flex-1 truncate">{paper.title}</span><span className="research-tag">待精读</span></button>) : <p className="research-empty-inline">暂无待读文献。可在文献检索结果中点击“加入待读”，系统会创建本地 Paper 并在这里显示。</p>}
            </DashboardResourceCard>
            <DashboardResourceCard title="最近科研产物" eyebrow="ARTIFACTS / RECENT">
              {recentArtifacts.isLoading ? <p className="research-empty-inline">正在读取科研产物…</p> : recentArtifacts.error ? <p className="form-feedback form-feedback-error m-3" role="alert">科研产物读取失败，请稍后重试。</p> : recentArtifacts.data?.length ? recentArtifacts.data.slice(0, 5).map((artifact) => <button className="dashboard-list-row w-full text-left" key={artifact.id} onClick={() => artifact.projectId ? onOpenBoard(artifact.projectId) : onNavigate('project')} title="打开科研产物所属项目" type="button"><FileStack aria-hidden="true" className="size-3.5 text-primary" /><span className="min-w-0 flex-1 truncate">{artifact.title}</span><span className="text-[11px] text-muted-foreground">{formatDate(artifact.updatedAt)}</span></button>) : <p className="research-empty-inline">尚无科研产物。完成一次 Agent 运行或手动创建产物后会出现在这里。</p>}
            </DashboardResourceCard>
            <DashboardResourceCard title="Agent 收件箱" eyebrow="AGENT / INBOX">
              {agentInbox.isLoading ? <p className="research-empty-inline">正在读取 Agent 收件箱…</p> : agentInbox.error ? <p className="form-feedback form-feedback-error m-3" role="alert">Agent 收件箱读取失败，请打开 Agent 页重试。</p> : agentInbox.data?.length ? agentInbox.data.slice(0, 5).map((item) => <button className="dashboard-list-row w-full text-left" key={item.id} onClick={() => onNavigate('agent')} title="打开 Agent 收件箱" type="button"><Inbox aria-hidden="true" className="size-3.5 text-primary" /><span className="min-w-0 flex-1 truncate">{item.title}</span><span className="research-tag">{item.kind === 'failure' ? '失败' : '未读'}</span></button>) : <p className="research-empty-inline">暂无未读 Agent 结果。完成一次 Agent 运行后，摘要、产物或失败通知会出现在这里。</p>}
            </DashboardResourceCard>
          </section>
        </>
      ) : null}
    </div>
  )
}

function DashboardResourceCard({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }): React.JSX.Element {
  return <section className="research-panel"><header className="research-panel-header"><p className="instrument-label">{eyebrow}</p><h2 className="mt-0.5 text-sm font-bold text-foreground">{title}</h2></header><div className="divide-y divide-border">{children}</div></section>
}

/* Legacy list renderer retained only for backwards-compatible imports; App routes to TaskWorkspacePage. */
export function LegacyTaskListPage({ view, projects }: { view: LegacyTaskView; projects: Project[] }): React.JSX.Element {
  const meta = legacyTaskMeta[view]
  const tasksQuery = useTasksQuery({ view })
  const projectMap = new Map(projects.map((project) => [project.id, project.name]))

  return (
    <div className="page-scroll">
      <PageHeader
        actions={view === 'inbox'
          ? <CreateTaskDialog defaultProjectId={null} projects={projects} trigger={<Button variant="primary"><Plus aria-hidden="true" className="size-4" />新建任务</Button>} />
          : <CreateTaskDialog projects={projects} trigger={<Button variant="primary"><Plus aria-hidden="true" className="size-4" />新建任务</Button>} />}
        description={meta.description}
        eyebrow={meta.eyebrow}
        title={meta.title}
      />
      <div className="mt-5">
        {tasksQuery.isLoading ? <LoadingState /> : null}
        {tasksQuery.error ? <ErrorState error={tasksQuery.error} onRetry={() => void tasksQuery.refetch()} /> : null}
        {tasksQuery.data?.length === 0 ? (
          <EmptyState
            description={view === 'inbox'
              ? '新想法可以通过顶部“快速记下 Todo”随时捕获。'
              : '当任务符合当前时间条件时，会自动出现在这里。'}
            title={meta.empty}
          />
        ) : null}
        {tasksQuery.data && tasksQuery.data.length > 0 ? (
          <div className="overflow-hidden rounded-lg border border-border bg-surface" role="list">
            {tasksQuery.data.map((task) => {
              const overdue = Boolean(
                task.dueAt
                && task.status !== 'done'
                && new Date(task.dueAt).getTime() < new Date().setHours(0, 0, 0, 0)
              )
              return (
                <article className="task-row" key={task.id} role="listitem">
                  <span className={cn('status-dot', `status-${task.status}`)} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <h2 className="overflow-wrap-anywhere text-sm font-semibold text-foreground">{task.title}</h2>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                      <span>{task.projectId ? projectMap.get(task.projectId) ?? '未知项目' : '收件箱'}</span>
                      <span className="inline-flex items-center gap-1"><CircleDot aria-hidden="true" className="size-3" />{priorityLabel[task.priority]}</span>
                      {task.estimateMinutes ? <span className="inline-flex items-center gap-1"><Clock3 aria-hidden="true" className="size-3" />{task.estimateMinutes} 分钟</span> : null}
                    </div>
                  </div>
                  <span className={cn('hidden rounded px-2 py-1 text-[11px] font-semibold sm:inline-flex', task.status === 'blocked' ? 'bg-danger-subtle text-danger' : 'bg-muted text-muted-foreground')}>
                    {statusLabel[task.status]}
                  </span>
                  <span className={cn('min-w-20 text-right text-xs text-muted-foreground', overdue && 'font-semibold text-danger')}>
                    {task.dueAt ? `${overdue ? '逾期 · ' : ''}${formatDate(task.dueAt)}` : '无截止日期'}
                  </span>
                </article>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function ViewNotFound(): React.JSX.Element {
  return (
    <div className="page-scroll">
      <EmptyState description="请从左侧导航选择一个工作区。" title="未找到该工作区" />
    </div>
  )
}
