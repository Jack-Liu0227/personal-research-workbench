import type { Project, TaskListFilter, TaskPriority, TaskStatus } from '@prw/contracts'
import {
  ArrowRight,
  BookOpenText,
  CalendarClock,
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
import {
  INBOX_KIND_LABELS,
  PAPER_READ_STATUS_LABELS,
  buildPushLedger,
  firstMeaningfulLine,
  inboxCardEmptyText,
  inboxReadLabel,
  joinInboxWithPushLedger,
  summarizePushSource,
  type DashboardSourceSummary
} from './dashboard-push'
import { useAgentInboxQuery, useAutomationRulesQuery, useAutomationRunHistoryQuery, useDashboardQuery, usePapersQuery, useTasksQuery } from './queries'

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
  const agentInbox = useAgentInboxQuery(true)
  // Scheduled-run ledger (real status + rule + Obsidian delivery path). It is the
  // only source for the "来源/状态/相对路径" line of the inbox card below; a record
  // with no ledger row is labelled as such instead of being given a fake one.
  const runHistory = useAutomationRunHistoryQuery()
  const automationRules = useAutomationRulesQuery()
  const pushLedger = buildPushLedger(runHistory.data ?? [], (scheduleId) => {
    const rule = automationRules.data?.find((candidate) => candidate.id === scheduleId)
    return rule ? rule.name : `定时任务 ${scheduleId.slice(0, 8)}`
  })
  // The inbox card is the join of the real inbox table with the real push
  // ledger: rows without a ledger entry stay visible but never receive a push
  // status, a rule name or an Obsidian path.
  const inboxJoin = joinInboxWithPushLedger(pushLedger, agentInbox.data ?? [])
  const inboxRows = [...inboxJoin.matched, ...inboxJoin.unmatched]
  const inboxCountLabel = agentInbox.data ? `${agentInbox.data.length} 条未读` : '读取中'

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
          <p className="mt-2 text-xs leading-5 text-muted-foreground">收件箱是尚未绑定项目的快速 Todo；“待读文献”的状态来自 Paper 的读阅状态；“Agent 收件箱”只展示本地收件箱记录与最近 {runHistory.data?.length ?? 0} 条定时推送记录的真实关联结果（来源规则、运行状态、执行时间点、Obsidian 投递相对路径与失败原因）。没有记录、没有关联记录或读取失败时都显示真实原因；全部为真实数据，不是演示数据。</p>

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
              {todayTasks.isLoading ? <p className="research-empty-inline">正在读取今日任务…</p> : todayTasks.error ? <div className="m-3"><ErrorState compact error={todayTasks.error} onRetry={() => void todayTasks.refetch()} retryLabel="重试读取今日任务" /><p className="mt-2 text-xs text-muted-foreground">今日任务读取失败；可在此原地重试，或打开任务页查看完整列表。</p></div> : todayTasks.data?.length ? todayTasks.data.slice(0, 5).map((task) => <button className="dashboard-list-row w-full text-left" key={task.id} onClick={() => onNavigate('tasks')} title={`打开任务：${task.title}`} type="button"><span className="status-led" /><span className="min-w-0 flex-1 truncate">{task.title}</span><span className="text-[11px] text-muted-foreground">{priorityLabel[task.priority]}</span></button>) : <p className="research-empty-inline">今天没有到期任务。</p>}
            </DashboardResourceCard>
            <DashboardResourceCard title="未来七天截止" eyebrow="UPCOMING / DEADLINES">
              {upcomingTasks.isLoading ? <p className="research-empty-inline">正在读取近期任务…</p> : upcomingTasks.error ? <div className="m-3"><ErrorState compact error={upcomingTasks.error} onRetry={() => void upcomingTasks.refetch()} retryLabel="重试读取近期任务" /><p className="mt-2 text-xs text-muted-foreground">近期任务读取失败；可在此原地重试，或打开任务页查看完整列表。</p></div> : upcomingTasks.data?.length ? upcomingTasks.data.slice(0, 5).map((task) => <button className="dashboard-list-row w-full text-left" key={task.id} onClick={() => onNavigate('tasks')} title={`打开任务：${task.title}`} type="button"><span className="status-led" /><span className="min-w-0 flex-1 truncate">{task.title}</span><span className="text-[11px] text-muted-foreground">{formatDate(task.dueAt)}</span></button>) : <p className="research-empty-inline">未来七天没有截止任务。</p>}
            </DashboardResourceCard>
            <DashboardResourceCard title="待读文献" eyebrow="LITERATURE / QUEUED">
              {queuedPapers.isLoading ? <p className="research-empty-inline">正在读取待读文献…</p> : queuedPapers.error ? <div className="m-3"><ErrorState compact error={queuedPapers.error} onRetry={() => void queuedPapers.refetch()} retryLabel="重试读取待读文献" /><p className="mt-2 text-xs text-muted-foreground">待读文献读取失败；可在此原地重试，或打开文献检索页继续。</p></div> : queuedPapers.data?.length ? queuedPapers.data.slice(0, 5).map((paper) => <button className="dashboard-list-row w-full text-left" key={paper.id} onClick={() => onNavigate('literature')} title={`打开文献：${paper.title}`} type="button"><BookOpenText aria-hidden="true" className="size-3.5 text-primary" /><span className="min-w-0 flex-1 truncate">{paper.title}</span><span className="research-tag">{PAPER_READ_STATUS_LABELS[paper.status]}</span></button>) : <p className="research-empty-inline">暂无待读文献。可在文献检索结果中点击“加入待读”，系统会创建本地 Paper 并在这里显示。</p>}
            </DashboardResourceCard>
            <DashboardResourceCard meta={inboxCountLabel} title="Agent 收件箱" eyebrow="AGENT / INBOX">
              {agentInbox.isLoading ? <p className="research-empty-inline">正在读取 Agent 收件箱…</p> : agentInbox.error ? <div className="m-3"><ErrorState compact error={agentInbox.error} onRetry={() => void agentInbox.refetch()} retryLabel="重试读取 Agent 收件箱" /><p className="mt-2 text-xs text-muted-foreground">Agent 收件箱读取失败；可在此原地重试，或打开 Agent 页查看。</p></div> : inboxRows.length ? <>
                {inboxRows.slice(0, 5).map(({ item, source }) => <DashboardRecordRow
                  icon={<Inbox aria-hidden="true" className="size-3.5 text-primary" />}
                  key={item.id}
                  meta={`${INBOX_KIND_LABELS[item.kind]} · ${inboxReadLabel(item.read)} · ${formatDate(item.createdAt)}`}
                  onClick={() => onNavigate('agent')}
                  openTitle={`打开 Agent 收件箱：${item.title}`}
                  source={summarizePushSource(source, formatDate)}
                  summary={firstMeaningfulLine(item.body)}
                  title={item.title}
                />)}
                {inboxJoin.unmatchedNote ? <p className="research-empty-inline" data-inbox-unmatched-note="true">{inboxJoin.unmatchedNote}</p> : null}
              </> : <p className="research-empty-inline">{inboxCardEmptyText(pushLedger.entries.length)}</p>}
            </DashboardResourceCard>
          </section>
        </>
      ) : null}
    </div>
  )
}

function DashboardResourceCard({ eyebrow, title, meta, children }: { eyebrow: string; title: string; meta?: string; children: ReactNode }): React.JSX.Element {
  return <section className="research-panel"><header className="research-panel-header"><div className="flex items-start justify-between gap-3"><div><p className="instrument-label">{eyebrow}</p><h2 className="mt-0.5 text-sm font-bold text-foreground">{title}</h2></div>{meta ? <span className="research-tag">{meta}</span> : null}</div></header><div className="divide-y divide-border">{children}</div></section>
}

/**
 * One artifact / inbox row: real title, contract-derived meta, the record's own
 * bounded summary and the push-ledger source line. `data-source-kind` marks
 * whether the row was matched to a scheduled run, so a test can prove that no
 * row ever renders an invented status or path.
 */
function DashboardRecordRow({ icon, title, meta, summary, source, openTitle, onClick }: {
  icon: ReactNode
  title: string
  meta: string
  summary: string
  source: DashboardSourceSummary
  openTitle: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      className="dashboard-record-row w-full text-left"
      data-source-kind={source.matched ? 'push' : 'none'}
      onClick={onClick}
      title={openTitle}
      type="button"
    >
      <span className="dashboard-record-icon">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="dashboard-record-title">{title}</span>
        <span className="dashboard-record-meta">{meta}</span>
        {summary ? <span className="dashboard-record-summary">{summary}</span> : null}
        <span className={cn('dashboard-record-source', !source.matched && 'dashboard-record-source-unmatched')}>{source.headline}</span>
        {source.details.map((detail) => <span className="dashboard-record-detail" key={detail}>{detail}</span>)}
      </span>
    </button>
  )
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
