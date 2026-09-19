import {
  BookOpenText,
  Bot,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  Clock3,
  CircleGauge,
  FlaskConical,
  FolderKanban,
  LibraryBig,
  Moon,
  NotebookPen,
  Search,
  Settings2,
  Sun
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { ProjectIdSchema, ResourceRefSchema, type ContextMenuTarget, type ResourceRef, type WorkspaceRoute, type WorkspaceTab } from '@prw/contracts'
import { useQuery } from '@tanstack/react-query'
import { Button } from './components/ui'
import { ErrorState, InlineLoadingState } from './components/states'
import { cn } from './lib/utils'
import { QuickTodo } from './features/forms'
import { OverviewPage, ViewNotFound } from './features/pages'
import { TaskWorkspacePage } from './features/tasks'
import type { TaskContextMenuActions } from './features/board'
import { ProjectSpacePage } from './features/project-space'
import { CalendarPage } from './features/calendar'
import { LiteraturePage } from './features/research/literature'
import { IntegrationsSettingsPage } from './features/research/settings'
import { ObsidianPage } from './features/obsidian'
import { ZoteroPage } from './features/zotero'
import { AgentPage } from './features/agent'
import { AutomationPage } from './features/automation'
import { useProjectsQuery } from './features/queries'
import { getWorkbenchApi } from './lib/workbench'
import { ContextMenuHost, ContextMenuTrigger, useContextMenu, type ContextActionHandlers } from './shell/context-menu'
import { UnsavedObsidianProvider, useUnsavedCloseConfirmation } from './shell/unsaved'
import { useWorkspaceTabs, type WorkspaceTabAction } from './shell/workspace-tabs'
import { WorkspaceTabsBar } from './shell/workspace-tabs-bar'

type ViewId = 'dashboard' | 'calendar' | 'tasks' | 'project' | 'literature' | 'obsidian' | 'zotero' | 'agent' | 'automation' | 'settings'
type Theme = 'light' | 'dark'

type FontScale = 'compact' | 'comfortable' | 'large'

type ConnectorStatus = 'connected' | 'disconnected' | 'not_configured' | 'error'

function connectorStatusLabel(status: ConnectorStatus | undefined): string {
  if (status === 'connected') return '已连接'
  if (status === 'error') return '异常'
  if (status === 'disconnected') return '已配置，待探测'
  if (status === 'not_configured') return '未配置'
  return '检测中'
}

const fontScaleValues: Record<FontScale, string> = {
  compact: '13px',
  comfortable: '14px',
  large: '16px'
}

function routeForView(view: ViewId): WorkspaceRoute {
  return view
}

interface NavigationItem { id: ViewId; label: string; icon: ReactNode }
/**
 * Third-level navigation is the research workbench itself: five surfaces that
 * are entered deliberately and then worked in for a while.
 */
const researchNavigation: NavigationItem[] = [
  { id: 'dashboard', label: '仪表盘', icon: <CircleGauge aria-hidden="true" /> },
  { id: 'project', label: '项目空间', icon: <FolderKanban aria-hidden="true" /> },
  { id: 'literature', label: '文献检索', icon: <Search aria-hidden="true" /> },
  { id: 'obsidian', label: 'Obsidian', icon: <NotebookPen aria-hidden="true" /> },
  { id: 'zotero', label: 'Zotero', icon: <BookOpenText aria-hidden="true" /> },
  { id: 'automation', label: '定时任务', icon: <Clock3 aria-hidden="true" /> }
]

/**
 * Primary navigation is the daily loop, and deliberately only three items: the
 * Agent that records work, the calendar that places it, and the task list that
 * tracks it. Everything else is a place you visit, not a place you live, so it
 * folds into one collapsed group instead of competing for the same attention.
 * No surface is removed: every `ViewId` stays reachable and routable.
 */
const primaryNavigation: NavigationItem[] = [
  { id: 'agent', label: 'Agent', icon: <Bot aria-hidden="true" /> },
  { id: 'calendar', label: '日历', icon: <CalendarDays aria-hidden="true" /> },
  { id: 'tasks', label: '任务', icon: <CheckCircle2 aria-hidden="true" /> }
]

const settingsNavigation: NavigationItem = { id: 'settings', label: '设置', icon: <Settings2 aria-hidden="true" /> }

/** Every navigable surface, so a tab title is never an untranslated route. */
function viewTitle(view: ViewId): string {
  const items = [...primaryNavigation, ...researchNavigation, settingsNavigation]
  return items.find((item) => item.id === view)?.label ?? '工作区'
}

function readInitialTheme(): Theme {
  const saved = localStorage.getItem('workbench-theme')
  if (saved === 'light' || saved === 'dark') return saved
  return 'dark'
}

function readInitialFontScale(): FontScale {
  try {
    const saved = localStorage.getItem('workbench-font-scale')
    if (saved === 'compact' || saved === 'comfortable' || saved === 'large') return saved
  } catch { /* optional renderer storage */ }
  return 'comfortable'
}

function readInitialSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem('workbench-sidebar-collapsed') === 'true'
  } catch {
    return false
  }
}

/**
 * The research group starts collapsed on purpose: collapsing it is the whole
 * point of the reduction, so "no stored preference" must mean "closed" rather
 * than "open until the user closes it".
 */
function readInitialResearchOpen(): boolean {
  try {
    return localStorage.getItem('workbench-nav-research-open') === 'true'
  } catch {
    return false
  }
}

/**
 * Narrow viewports cannot show a permanent 232px rail, so the shell switches to
 * a drawer there. The breakpoint is the same one `styles.css` uses for the
 * icon-only rail; keeping both in one place is what stops the collapse button
 * from becoming a no-op on a viewport where CSS already forced the rail.
 */
function useNarrowViewport(query = '(max-width: 720px)'): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const onChange = () => setNarrow(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [query])
  return narrow
}

function NavigationButton({ item, active, onClick }: { item: NavigationItem; active: boolean; onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void }): React.JSX.Element {
  return <button aria-current={active ? 'page' : undefined} className={cn('nav-item', active && 'nav-item-active')} onClick={onClick} title={item.label} type="button"><span className="nav-icon">{item.icon}</span><span className="sidebar-label min-w-0 flex-1 truncate">{item.label}</span></button>
}

function Sidebar({ view, onNavigate, theme, onToggleTheme, collapsed, narrowOpen, onToggleCollapsed }: { view: ViewId; onNavigate: (view: ViewId, openInNewTab: boolean) => void; theme: Theme; onToggleTheme: () => void; collapsed: boolean; narrowOpen: boolean; onToggleCollapsed: () => void }): React.JSX.Element {
  const navigateFromClick = (item: NavigationItem, event: ReactMouseEvent<HTMLButtonElement>) => onNavigate(item.id, event.ctrlKey || event.metaKey)
  const [researchOpen, setResearchOpen] = useState(readInitialResearchOpen)
  useEffect(() => {
    try { localStorage.setItem('workbench-nav-research-open', String(researchOpen)) } catch { /* optional renderer storage */ }
  }, [researchOpen])
  // A route inside the collapsed group must not hide the current location: the
  // group is force-opened while it contains the active view, without writing
  // that forced state back to the stored preference.
  const researchActive = researchNavigation.some((item) => item.id === view)
  const researchExpanded = researchOpen || researchActive

  return <aside aria-label="主导航" className={cn('sidebar', collapsed && 'sidebar-collapsed', narrowOpen && 'sidebar-narrow-open')}><div className="sidebar-brand"><div aria-hidden="true" className="workbench-mark"><span /><span /><span /></div><div className="sidebar-label min-w-0"><p className="truncate text-sm font-bold text-sidebar-foreground">科研工作台</p><p className="mt-0.5 truncate text-[10px] uppercase tracking-[0.18em] text-sidebar-muted">Research workspace</p></div><button aria-expanded={!collapsed} aria-label={collapsed ? '展开侧栏' : '折叠侧栏'} aria-pressed={collapsed} className="sidebar-collapse-button" onClick={onToggleCollapsed} title={collapsed ? '展开侧栏' : '折叠侧栏'} type="button">{collapsed ? '›' : '‹'}</button></div><nav className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-2 py-3">
    <div className="grid gap-0.5">{primaryNavigation.map((item) => <NavigationButton active={view === item.id} item={item} key={item.id} onClick={(event) => navigateFromClick(item, event)} />)}</div>
    <div className="sidebar-nav-group">
      <button aria-controls="sidebar-research-nav" aria-expanded={researchExpanded} className={cn('nav-item', researchActive && 'nav-item-group-active')} onClick={() => setResearchOpen((current) => !current)} type="button">
        <span className="nav-icon"><FlaskConical aria-hidden="true" /></span>
        <span className="sidebar-label min-w-0 flex-1 truncate text-left">研究</span>
        <span className="sidebar-label"><ChevronDown aria-hidden="true" className={cn('sidebar-nav-chevron', researchExpanded && 'sidebar-nav-chevron-open')} /></span>
      </button>
      <div className="grid gap-0.5" hidden={!researchExpanded} id="sidebar-research-nav">
        {researchNavigation.map((item) => <NavigationButton active={view === item.id} item={item} key={item.id} onClick={(event) => navigateFromClick(item, event)} />)}
      </div>
    </div>
  </nav><div className="border-t border-sidebar-border p-2"><NavigationButton active={view === settingsNavigation.id} item={settingsNavigation} onClick={(event) => navigateFromClick(settingsNavigation, event)} /><button className="nav-item" onClick={onToggleTheme} type="button"><span className="nav-icon">{theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}</span><span className="sidebar-label flex-1 text-left">{theme === 'dark' ? '浅色主题' : '深色主题'}</span></button><div className="sidebar-label sidebar-online"><span aria-hidden="true" className="size-1.5 rounded-full bg-online" />Workspace Service 已连接</div></div></aside>
}

function Topbar({ projects, selectedProjectId, onSelectProject, onNavigate, onOpenProject }: { projects: Array<{ id: string; name: string }>; selectedProjectId: string | null; onSelectProject: (id: string | null) => void; onNavigate: (view: ViewId, openInNewTab?: boolean) => void; onOpenProject: (projectId: string, openInNewTab: boolean) => void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const date = useMemo(() => new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date()), [])
  const projectHandlers = (projectId: string): ContextActionHandlers => ({ open: () => onOpenProject(projectId, false), 'open-new-tab': () => onOpenProject(projectId, true) })
  const selectedProject = projects.find((project) => project.id === selectedProjectId)
  const projectContext = selectedProject ? <ContextMenuTrigger handlers={projectHandlers(selectedProject.id)} target={{ type: 'project', id: selectedProject.id, capabilities: ['open', 'open-new-tab', 'copy-id'] }}><span className="contents"><select aria-label="当前项目" className="select-control" onChange={(event) => onSelectProject(event.target.value || null)} value={selectedProjectId ?? ''}><option value="">全部项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></span></ContextMenuTrigger> : <select aria-label="当前项目" className="select-control" onChange={(event) => onSelectProject(event.target.value || null)} value={selectedProjectId ?? ''}><option value="">全部项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
  return <header className="topbar"><div className="hidden items-center gap-2 text-xs text-muted-foreground xl:flex"><LibraryBig aria-hidden="true" className="size-4" /><span>{date}</span></div><label className="project-context"><span className="sr-only">当前项目</span>{projectContext}</label><label className="global-search"><Search aria-hidden="true" className="size-4 text-muted-foreground" /><span className="sr-only">全局搜索</span><input onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && query.trim()) onNavigate('literature', false) }} placeholder="搜索任务、文献、笔记、项目…" value={query} /><kbd>Ctrl K</kbd></label><QuickTodo /><Button aria-label="快捷创建项目" onClick={() => onNavigate('project', false)} size="icon" variant="ghost"><FolderKanban aria-hidden="true" className="size-4" /></Button></header>
}

export default function App(): React.JSX.Element {
  return <UnsavedObsidianProvider><ContextMenuHost><AppContent /></ContextMenuHost></UnsavedObsidianProvider>
}

function AppContent(): React.JSX.Element {
  const [theme, setTheme] = useState<Theme>(readInitialTheme)
  const [fontScale, setFontScale] = useState<FontScale>(readInitialFontScale)
  /** Persisted desktop preference: a permanently collapsed icon rail. */
  const [sidebarCollapsedPreference, setSidebarCollapsedPreference] = useState(readInitialSidebarCollapsed)
  const narrowViewport = useNarrowViewport()
  /** Narrow-viewport drawer: opened on demand instead of a permanent rail. */
  const [narrowNavOpen, setNarrowNavOpen] = useState(false)
  // One derived value drives both the rendered class and the toggle's
  // aria-pressed/aria-label, so the control can never claim "expanded" while
  // the shell shows a 68px rail.
  const sidebarCollapsed = narrowViewport ? !narrowNavOpen : sidebarCollapsedPreference
  const mainRef = useRef<HTMLElement | null>(null)
  const projectsQuery = useProjectsQuery()
  const serviceQuery = useQuery({ queryKey: ['workspace-status'], queryFn: () => getWorkbenchApi().workspace.status(), refetchInterval: 10_000 })
  const projects = projectsQuery.data ?? []
  const validationIndex = useMemo(() => projectsQuery.isSuccess ? { projectIds: new Set(projects.map((project) => project.id)) } : {}, [projects, projectsQuery.isSuccess])
  const tabsApi = useWorkspaceTabs(validationIndex)
  const activeTab = tabsApi.activeTab
  const selectedProjectId = activeTab?.context.projectId ?? null
  const view: ViewId = activeTab?.route ?? 'dashboard'
  const confirmClose = useUnsavedCloseConfirmation()
  const contextMenu = useContextMenu()
  useEffect(() => { document.documentElement.classList.toggle('dark', theme === 'dark'); document.documentElement.style.colorScheme = theme; localStorage.setItem('workbench-theme', theme) }, [theme])
  useEffect(() => {
    document.documentElement.style.setProperty('--app-font-size', fontScaleValues[fontScale])
    try { localStorage.setItem('workbench-font-scale', fontScale) } catch { /* optional renderer storage */ }
  }, [fontScale])
  useEffect(() => {
    const applyExternalPreferences = () => {
      try {
        const nextTheme = localStorage.getItem('workbench-theme')
        if (nextTheme === 'light' || nextTheme === 'dark') setTheme(nextTheme)
        const nextScale = localStorage.getItem('workbench-font-scale')
        if (nextScale === 'compact' || nextScale === 'comfortable' || nextScale === 'large') setFontScale(nextScale)
      } catch { /* optional renderer storage */ }
    }
    window.addEventListener('workbench-preferences-change', applyExternalPreferences)
    return () => window.removeEventListener('workbench-preferences-change', applyExternalPreferences)
  }, [])
  useEffect(() => {
    try { localStorage.setItem('workbench-sidebar-collapsed', String(sidebarCollapsedPreference)) } catch { /* optional renderer storage */ }
  }, [sidebarCollapsedPreference])
  useEffect(() => {
    // Leaving the narrow breakpoint must not leave a drawer covering content.
    if (!narrowViewport) setNarrowNavOpen(false)
  }, [narrowViewport])
  useEffect(() => {
    if (!narrowNavOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNarrowNavOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [narrowNavOpen])
  const toggleSidebar = () => {
    if (narrowViewport) setNarrowNavOpen((current) => !current)
    else setSidebarCollapsedPreference((current) => !current)
  }
  useEffect(() => { mainRef.current?.focus({ preventScroll: true }) }, [view])
  const updateProjectContext = (projectId: string | null) => {
    const validatedProjectId = projectId ? ProjectIdSchema.parse(projectId) : null
    if (activeTab) {
      const currentResource = activeTab.context.resource?.kind === 'project' ? (validatedProjectId ? { kind: 'project' as const, id: validatedProjectId } : null) : activeTab.context.resource
      tabsApi.updateCurrent({ context: { projectId: validatedProjectId, resource: currentResource } })
      return
    }
    const tabId = tabsApi.openTab({ route: 'dashboard', title: '仪表盘', context: { projectId: validatedProjectId, resource: null } }, true)
    if (tabId) tabsApi.selectTab(tabId)
  }
  const navigate = (next: ViewId, openInNewTab = false, projectId: string | null = selectedProjectId) => {
    const route = routeForView(next)
    if (narrowViewport) setNarrowNavOpen(false)
    const validatedProjectId = projectId ? ProjectIdSchema.parse(projectId) : null
    const context = { projectId: validatedProjectId, resource: route === 'project' && validatedProjectId ? { kind: 'project' as const, id: validatedProjectId } : null }
    const title = route === 'project' && validatedProjectId ? projects.find((project) => project.id === validatedProjectId)?.name ?? viewTitle(next) : viewTitle(next)
    if (openInNewTab || !activeTab) {
      const tabId = tabsApi.openTab({ route, title, context }, true)
    } else {
      tabsApi.updateCurrent({ route, title, context })
    }
  }
  const openProject = (projectId: string, openInNewTab: boolean) => navigate('project', openInNewTab, projectId)
  const openContextTarget = (target: ContextMenuTarget, openInNewTab: boolean) => {
    const route = target.type === 'project' || target.type === 'resource' ? 'project' : target.type === 'task' ? 'tasks' : target.type === 'paper' ? 'literature' : target.type === 'note' ? 'obsidian' : target.type === 'calendar-event' ? 'calendar' : target.type === 'zotero-collection' || target.type === 'zotero-item' ? 'zotero' : 'dashboard'
    const resourceKind = target.type === 'project' || target.type === 'task' || target.type === 'paper' || target.type === 'note' || target.type === 'calendar-event' ? target.type : null
    const parsedResource = resourceKind ? ResourceRefSchema.safeParse({ kind: resourceKind, id: target.id }) : null
    const resource = parsedResource?.success ? parsedResource.data : null
    const projectId = target.type === 'project' ? ProjectIdSchema.safeParse(target.id).data ?? null : selectedProjectId
    const context = { projectId, resource }
    const title = target.type === 'project' ? projects.find((project) => project.id === projectId)?.name ?? '项目空间' : viewTitle(route)
    if (openInNewTab || !activeTab) tabsApi.openTab({ route, title, context }, true)
    else tabsApi.updateCurrent({ route, title, context })
  }
  useEffect(() => {
    const handleOpenSource = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail
      const parsed = ResourceRefSchema.safeParse(detail)
      if (!parsed.success || (parsed.data.kind !== 'task' && parsed.data.kind !== 'project')) return
      const resource: ResourceRef = parsed.data
      if (resource.kind === 'project') {
        openProject(resource.id, false)
        return
      }
      // Calendar task projections are read-only; open the authoritative task
      // page and pass the resource so its Inspector can focus the task.
      const context = { projectId: null, resource }
      if (activeTab) tabsApi.updateCurrent({ route: 'tasks', title: '任务', context })
      else tabsApi.openTab({ route: 'tasks', title: '任务', context }, true)
    }
    window.addEventListener('workbench:open-source', handleOpenSource)
    return () => window.removeEventListener('workbench:open-source', handleOpenSource)
  }, [activeTab, openProject, tabsApi])
  const handleContextMenu = (target: ContextMenuTarget, event: ReactMouseEvent | ReactKeyboardEvent, taskActions?: TaskContextMenuActions) => {
    event.preventDefault()
    const point = 'clientX' in event ? { x: event.clientX, y: event.clientY } : (() => {
      const element = event.target instanceof HTMLElement ? event.target : null
      const rect = element?.getBoundingClientRect()
      return { x: rect?.left ?? window.innerWidth / 2, y: rect?.bottom ?? window.innerHeight / 2 }
    })()
    const handlers: ContextActionHandlers = target.type === 'resource' ? {} : {
      open: () => openContextTarget(target, false),
      'open-new-tab': () => openContextTarget(target, true),
      edit: () => openContextTarget(target, false),
      ...(target.type === 'task' ? taskActions : {})
    }
    contextMenu.open(target, handlers, {}, point)
  }
  const selectTab = (tabId: string, openInNewTab: boolean) => {
    if (openInNewTab) {
      const duplicateId = tabsApi.duplicateTab(tabId)
      if (duplicateId) tabsApi.selectTab(duplicateId)
      return
    }
    tabsApi.selectTab(tabId)
  }
  const closeRequest = async (closeTabs: WorkspaceTab[], action: WorkspaceTabAction | 'close'): Promise<void> => {
    if (closeTabs.length === 0) return
    if (!(await confirmClose(closeTabs))) return
    if (action === 'close') tabsApi.close(closeTabs[0]?.tabId ?? '')
    else if (action === 'close-all') tabsApi.closeAll()
    else if (action === 'close-others') {
      const remaining = tabsApi.tabs.filter((tab) => !closeTabs.some((candidate) => candidate.tabId === tab.tabId))
      const keeper = remaining.find((tab) => !tab.pinned) ?? remaining[0]
      if (keeper) tabsApi.closeOthers(keeper.tabId)
    } else if (action === 'close-right') {
      const firstClosed = closeTabs[0]
      const rightIndex = firstClosed ? tabsApi.tabs.findIndex((tab) => tab.tabId === firstClosed.tabId) : -1
      const anchor = rightIndex > 0 ? tabsApi.tabs[rightIndex - 1] : undefined
      if (anchor) tabsApi.closeRight(anchor.tabId)
    }
  }
  let page: ReactNode
  if (view === 'dashboard') page = <OverviewPage onNavigate={(next) => navigate(next)} onOpenBoard={(projectId) => navigate('tasks', false, projectId)} projects={projects} />
  else if (view === 'calendar') page = <CalendarPage projects={projects} />
  else if (view === 'tasks') page = <TaskWorkspacePage focusTaskId={activeTab?.context.resource?.kind === 'task' ? activeTab.context.resource.id : null} onContextMenu={handleContextMenu} onSelectProject={updateProjectContext} projects={projects} selectedProjectId={selectedProjectId} />
  else if (view === 'project') page = <ProjectSpacePage projects={projects} />
  else if (view === 'literature') page = <LiteraturePage projects={projects} />
  else if (view === 'obsidian') page = <ObsidianPage projects={projects} />
  else if (view === 'zotero') page = <ZoteroPage projects={projects} />
  else if (view === 'agent') page = <AgentPage onNavigate={navigate} projects={projects} />
  else if (view === 'automation') page = <AutomationPage projects={projects} />
  else if (view === 'settings') page = <IntegrationsSettingsPage projects={projects} />
  else page = <ViewNotFound />
  const connectorStatuses = serviceQuery.data?.connectors
  const literatureFocus = view === 'literature'
  return <div className={cn('app-shell', literatureFocus && 'literature-focus-shell')}><a className="skip-link" href="#main-content">跳到主要内容</a><Sidebar collapsed={sidebarCollapsed} narrowOpen={!sidebarCollapsed && narrowViewport} onNavigate={navigate} onToggleCollapsed={toggleSidebar} onToggleTheme={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} theme={theme} view={view} />{narrowViewport && !sidebarCollapsed ? <button aria-label="关闭导航抽屉" className="sidebar-scrim" onClick={() => setNarrowNavOpen(false)} type="button" /> : null}<div className="app-shell-content min-w-0 flex-1 overflow-hidden">{literatureFocus ? null : <Topbar onNavigate={navigate} onOpenProject={openProject} onSelectProject={updateProjectContext} projects={projects} selectedProjectId={selectedProjectId} />}{literatureFocus ? null : <WorkspaceTabsBar activeTabId={activeTab?.tabId ?? null} onCloseRequest={closeRequest} onDuplicate={(tabId) => { tabsApi.duplicateTab(tabId) }} onOpenNew={() => navigate('tasks', true)} onPin={tabsApi.togglePin} onSelect={selectTab} tabs={tabsApi.tabs} />}<div className="workspace-body"><main ref={mainRef} className="main-content focus:outline-none" id="main-content" tabIndex={-1}>{projectsQuery.isLoading ? <div className="workspace-warmup"><InlineLoadingState label="项目列表后台加载中；页面内容仍可继续查看。" /></div> : null}{projectsQuery.error ? <div className="workspace-warmup"><ErrorState compact error={projectsQuery.error} onRetry={() => void projectsQuery.refetch()} /></div> : null}{page}</main></div><footer className="status-bar"><span><span className="status-led" />Workspace Service {serviceQuery.data?.status === 'ready' ? '正常' : serviceQuery.data?.status ?? '启动中'}</span><span><span className="status-led" />SQLite {serviceQuery.data?.database === 'ready' ? '正常' : '异常'}</span><span>Obsidian {connectorStatusLabel(connectorStatuses?.['obsidian'])}</span><span>Zotero {connectorStatusLabel(connectorStatuses?.['zotero'])}</span></footer></div></div>
}
