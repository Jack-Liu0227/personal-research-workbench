import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type {
  AgentRun,
  ArtifactKind,
  AutomationRule,
  AutomationRunHistoryEntry,
  BoardColumn,
  DashboardSummary,
  IntegrationProfile,
  LiteratureMatrixEntry,
  Paper,
  PaperListFilter,
  Project,
  ResearchArtifact,
  SyncRun,
  Task,
  TaskListFilter,
  PromptTemplate,
  AiProviderProfile,
  Schedule,
  ZoteroCollectionPage,
  ZoteroItemPage,
  IntelDailyConfig,
  IntelDailyOverview,
  CalendarEvent,
  CalendarRangeInput,
  CalendarMarker,
  CalendarMarkerRangeInput,
  Note,
  WorkspaceServiceStatus,
  ZoteroCapabilityStatus,
  ResourceRef,
  ResourceLink,
  SearchSession,
  LiteratureStagingPage,
  AgentInboxItem
  , RssItemsPage
  , RssItemsQueryInput
} from '@prw/contracts'
import { ProjectIdSchema } from '@prw/contracts'
import { getWorkbenchAgentApi, getWorkbenchApi } from '../lib/workbench'
import { FeatureUnavailableError } from '../lib/utils'

export const queryKeys = {
  projects: ['projects'] as const,
  dashboard: ['dashboard'] as const,
  columns: (projectId: string) => ['columns', projectId] as const,
  tasks: (filter: Partial<TaskListFilter> = {}) => ['tasks', filter] as const,
  papers: (filter: Partial<PaperListFilter> = {}) => ['papers', filter] as const,
  matrix: (projectId: string | null) => ['matrix', projectId ?? 'all'] as const,
  artifacts: (filter: { projectId?: string | null; kind?: ArtifactKind }) => ['artifacts', filter] as const,
  integrations: ['integrations'] as const,
  syncRuns: (profileId?: string) => ['sync-runs', profileId ?? 'all'] as const,
  calendar: (range: CalendarRangeInput) => ['calendar', range] as const,
  calendarMarkers: (range: CalendarMarkerRangeInput) => ['calendar-markers', range] as const,
  noteIndex: (vaultId: string, query: string, profileRevision?: number) => ['notes', vaultId, query, profileRevision ?? 0] as const,
  zoteroCapability: (profileId: string) => ['zotero-capability', profileId] as const,
  zoteroCollections: (profileId: string, cursor?: string | null) => ['zotero-collections-page', profileId, cursor ?? 'first'] as const,
  zoteroItems: (profileId: string, collectionKey?: string, query = '', cursor?: string | null, limit = 50) => ['zotero-items-page', profileId, collectionKey ?? 'all', query, cursor ?? 'first', limit] as const,
  resourceLinks: (resource?: ResourceRef | null) => ['resource-links', resource ?? 'all'] as const,
  searchSessions: ['search-sessions'] as const,
  // `undefined` means all projects while `null` means explicitly unassigned.
  // Keep those cache keys distinct or switching the filter can show stale rows.
  literatureStaging: (query = '', projectId?: string | null) => [
    'literature-staging',
    query,
    projectId === undefined ? 'all' : projectId === null ? 'unassigned' : projectId
  ] as const,
  agentInbox: (unreadOnly = false) => ['agent-inbox', unreadOnly] as const,
  /** Scheduled-run ledger (automation page + dashboard push projection). The
   * key matches the literal the automation page has always used, so both pages
   * share one cache entry instead of fetching the same runs twice. The limit is
   * part of the shared shape: change it here only. */
  automationRunHistory: ['automation-run-history'] as const,
  automationRules: ['automation-rules'] as const,
  intelDailyConfig: ['intel-daily', 'config'] as const,
  intelDailyOverview: ['intel-daily', 'overview'] as const,
  rssItems: (input: RssItemsQueryInput) => ['rss-items', input] as const,
  workspaceStatus: ['workspace-status'] as const,
  /** Keys for legacy AI hooks. These queries never call a removed V2 route. */
  unavailable: (feature: 'prompt-templates' | 'ai-providers' | 'agent-runs' | 'schedules') => ['unavailable', feature] as const
}

function useUnavailableQuery<T>(feature: Parameters<typeof queryKeys.unavailable>[0]): UseQueryResult<T> {
  return useQuery<T, Error>({
    queryKey: queryKeys.unavailable(feature),
    queryFn: async () => {
      throw new FeatureUnavailableError(feature)
    },
    retry: false
  })
}

export function useProjectsQuery(): UseQueryResult<Project[]> {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => getWorkbenchApi().projects.list(),
    staleTime: 60_000,
    placeholderData: (previous) => previous
  })
}

export function useDashboardQuery(): UseQueryResult<DashboardSummary> {
  return useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: () => getWorkbenchApi().progress.dashboard()
  })
}

export function useColumnsQuery(projectId: string | null): UseQueryResult<BoardColumn[]> {
  return useQuery({
    queryKey: queryKeys.columns(projectId ?? 'none'),
    queryFn: () => getWorkbenchApi().boards.columns(projectId!),
    enabled: Boolean(projectId)
  })
}

export function useTasksQuery(filter: Partial<TaskListFilter> = {}): UseQueryResult<Task[]> {
  return useQuery({
    queryKey: queryKeys.tasks(filter),
    queryFn: () => getWorkbenchApi().tasks.list(filter)
  })
}

export function usePapersQuery(filter: Partial<PaperListFilter> = {}): UseQueryResult<Paper[]> {
  return useQuery({
    queryKey: queryKeys.papers(filter),
    queryFn: () => getWorkbenchApi().papers.list(filter)
  })
}

export function useMatrixQuery(projectId: string | null): UseQueryResult<LiteratureMatrixEntry[]> {
  return useQuery({
    queryKey: queryKeys.matrix(projectId),
    queryFn: () => getWorkbenchApi().matrix.list(projectId)
  })
}

export function useArtifactsQuery(filter: {
  projectId?: string | null
  kind?: ArtifactKind
} = {}): UseQueryResult<ResearchArtifact[]> {
  return useQuery({
    queryKey: queryKeys.artifacts(filter),
    queryFn: () => getWorkbenchApi().artifacts.list(filter)
  })
}

/** Real Agent output inbox; unlike the task inbox this contains unread
 * artifacts/failures produced by completed runs. */
export function useAgentInboxQuery(unreadOnly = false): UseQueryResult<AgentInboxItem[]> {
  return useQuery({
    queryKey: queryKeys.agentInbox(unreadOnly),
    queryFn: () => getWorkbenchAgentApi().inbox.list(unreadOnly),
    refetchInterval: unreadOnly ? 5_000 : false
  })
}

/** Ledger window shared by the automation page and the dashboard projection. */
export const automationRunHistoryLimit = 8

/** Real scheduled-run ledger: run status, owning rule, blocked reason, artifact
 * and the Obsidian delivery outcome of each scheduled push. */
export function useAutomationRunHistoryQuery(): UseQueryResult<AutomationRunHistoryEntry[]> {
  return useQuery({
    queryKey: queryKeys.automationRunHistory,
    queryFn: () => getWorkbenchAgentApi().automation.history({ limit: automationRunHistoryLimit }),
    staleTime: 15_000,
    placeholderData: (previous) => previous
  })
}

/** Rule names for the ledger rows; a ledger row only carries the rule id. */
export function useAutomationRulesQuery(): UseQueryResult<AutomationRule[]> {
  return useQuery({
    queryKey: queryKeys.automationRules,
    queryFn: () => getWorkbenchAgentApi().automation.rules(),
    staleTime: 30_000,
    placeholderData: (previous) => previous
  })
}

export function useIntegrationsQuery(): UseQueryResult<IntegrationProfile[]> {
  return useQuery({
    queryKey: queryKeys.integrations,
    queryFn: () => getWorkbenchApi().integrations.list(),
    refetchInterval: (query) => query.state.data?.some((profile) => profile.status === 'syncing') ? 2_000 : false
  })
}

export function useSyncRunsQuery(profileId?: string): UseQueryResult<SyncRun[]> {
  return useQuery({
    queryKey: queryKeys.syncRuns(profileId),
    queryFn: () => getWorkbenchApi().integrations.runs(profileId),
    refetchInterval: (query) => query.state.data?.some((run) => run.status === 'queued' || run.status === 'running')
      ? 2_000
      : false
  })
}

/**
 * @deprecated Prompt routes were removed from WorkbenchApiV2. Kept as an
 * unavailable result until the owner removes the retired writing view.
 */
export function usePromptsQuery(): UseQueryResult<PromptTemplate[]> {
  return useUnavailableQuery<PromptTemplate[]>('prompt-templates')
}

/** @deprecated Provider routes are not part of the frozen V2 surface. */
export function useProvidersQuery(): UseQueryResult<AiProviderProfile[]> {
  return useUnavailableQuery<AiProviderProfile[]>('ai-providers')
}

/** @deprecated Agent execution routes are not part of the frozen V2 surface. */
export function useAgentRunsQuery(limit = 20): UseQueryResult<AgentRun[]> {
  void limit
  return useUnavailableQuery<AgentRun[]>('agent-runs')
}

/** @deprecated Schedule routes are not part of the frozen V2 surface. */
export function useSchedulesQuery(): UseQueryResult<Schedule[]> {
  return useUnavailableQuery<Schedule[]>('schedules')
}

export function useCalendarQuery(input: CalendarRangeInput): UseQueryResult<CalendarEvent[]> {
  return useQuery({
    queryKey: queryKeys.calendar(input),
    queryFn: () => getWorkbenchApi().calendar.list(input)
  })
}

export function useCalendarMarkersQuery(input: CalendarMarkerRangeInput): UseQueryResult<CalendarMarker[]> {
  return useQuery({
    queryKey: queryKeys.calendarMarkers(input),
    queryFn: () => getWorkbenchApi().calendar.markers.list(input)
  })
}

export function useNotesQuery(vaultId: string | null, query = '', profileRevision?: number): UseQueryResult<Note[]> {
  return useQuery({
    queryKey: queryKeys.noteIndex(vaultId ?? 'none', query, profileRevision),
    queryFn: () => getWorkbenchApi().notes.list({ vaultId: vaultId!, query }),
    enabled: Boolean(vaultId),
    staleTime: 10_000,
    // External edits are still picked up, but only while the app is visible.
    // The old 1.5s interval duplicated ObsidianPage's own polling timer.
    refetchInterval: vaultId ? 15_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    placeholderData: (previous) => previous
  })
}

export function useZoteroCollectionsQuery(profileId: string | null, cursor: string | null = null): UseQueryResult<ZoteroCollectionPage> {
  return useQuery({
    queryKey: queryKeys.zoteroCollections(profileId ?? 'none', cursor),
    queryFn: () => getWorkbenchApi().zotero.collectionsPage({ profileId: profileId!, ...(cursor ? { cursor } : {}) }),
    enabled: Boolean(profileId),
    staleTime: 30_000,
    placeholderData: (previous) => previous
  })
}

export function useZoteroItemsQuery(profileId: string | null, collectionKey?: string, options: { query?: string; cursor?: string | null; limit?: number } = {}): UseQueryResult<ZoteroItemPage> {
  const search = options.query?.trim() ?? ''
  const cursor = options.cursor ?? null
  const limit = options.limit ?? 50
  return useQuery({
    queryKey: queryKeys.zoteroItems(profileId ?? 'none', collectionKey, search, cursor, limit),
    queryFn: () => getWorkbenchApi().zotero.itemsPage({
      profileId: profileId!,
      ...(collectionKey ? { collectionKey } : {}),
      ...(search ? { query: search } : {}),
      page: { limit, ...(cursor ? { cursor } : {}) }
    }),
    enabled: Boolean(profileId),
    staleTime: 30_000,
    placeholderData: (previous) => previous
  })
}

export function useZoteroCapabilityQuery(profileId: string | null): UseQueryResult<ZoteroCapabilityStatus> {
  return useQuery({
    queryKey: queryKeys.zoteroCapability(profileId ?? 'none'),
    queryFn: () => getWorkbenchApi().zotero.capability(profileId!),
    enabled: Boolean(profileId),
    staleTime: 60_000,
    placeholderData: (previous) => previous
  })
}

export function useSearchSessionsQuery(): UseQueryResult<SearchSession[]> {
  return useQuery({ queryKey: queryKeys.searchSessions, queryFn: () => getWorkbenchApi().literature.sessions() })
}

export function useLiteratureStagingQuery(query = '', projectId?: string | null): UseQueryResult<LiteratureStagingPage> {
  return useQuery({
    queryKey: queryKeys.literatureStaging(query, projectId),
    queryFn: () => getWorkbenchApi().literature.staging.page({ query, ...(projectId === undefined ? {} : { projectId: projectId === null ? null : ProjectIdSchema.parse(projectId) }), page: { limit: 100 } })
  })
}

export function useWorkspaceStatusQuery(): UseQueryResult<WorkspaceServiceStatus> {
  return useQuery({ queryKey: queryKeys.workspaceStatus, queryFn: () => getWorkbenchApi().workspace.status() })
}

export function useIntelDailyConfigQuery(): UseQueryResult<IntelDailyConfig> {
  return useQuery({ queryKey: queryKeys.intelDailyConfig, queryFn: () => getWorkbenchApi().intelDaily.getConfig(), staleTime: 30_000 })
}

export function useIntelDailyOverviewQuery(): UseQueryResult<IntelDailyOverview> {
  return useQuery({ queryKey: queryKeys.intelDailyOverview, queryFn: () => getWorkbenchApi().intelDaily.overview(), staleTime: 15_000 })
}

export function useRssItemsQuery(input: RssItemsQueryInput): UseQueryResult<RssItemsPage> {
  return useQuery({
    queryKey: queryKeys.rssItems(input),
    queryFn: () => getWorkbenchApi().rss.sources.query(input),
    staleTime: 15_000,
    placeholderData: (previous) => previous
  })
}

export function useResourceLinksQuery(resource?: ResourceRef | null): UseQueryResult<ResourceLink[]> {
  return useQuery({
    queryKey: queryKeys.resourceLinks(resource),
    queryFn: () => getWorkbenchApi().resourceLinks.list(resource ?? undefined)
  })
}
