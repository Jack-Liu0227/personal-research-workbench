import { ArrowUp, Bot, Boxes, Clock3, Cpu, ExternalLink, FolderOpen, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Settings2, Sparkles, Square, Terminal, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { AgentConversation, AgentEventRecord, AgentModelOption, AgentPermissionMode, AgentRunRecord, AgentRunRecordEntry, AgentRuntimeKind, ArchiveBulkLock, ArchiveBulkResult, Project } from '@prw/contracts'
import { ProjectIdSchema, agentModelSelector } from '@prw/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Input, Textarea } from '../../components/ui'
import { ArchiveReceiptList, SelectionBar, receiptResultFrom } from '../../components/selection'
import { InlineLoadingState, PanelSkeleton } from '../../components/states'
import { cn } from '../../lib/utils'
import { useDefaultProjectId } from '../../lib/recent-project'
import { getWorkbenchAgentApi } from '../../lib/workbench'
import { ResearchTabs } from '../research/shared'
import { openSettingsSection } from '../research/settings'
import { ConversationView } from './conversation-view'
import { ExternalActionCards } from './external-actions'
import { StatsRow, StepStrip, type RealtimeState } from './progress'
import { TrajectoryView } from './trajectory-view'
import { mergeRecords, runStats, safeDisplayTitle } from './ledger'
import { AGENT_MAGIC_HELP, filterAgentMagicSuggestions, parseAgentMagicCommand } from './magic-commands'

/**
 * One local command outcome, rendered inside the message stream.
 *
 * Commands are answered by the renderer, not the model, so their results must
 * not look like an assistant reply: each card names the command that produced it
 * and is labelled as local. They are deliberately session-scoped — a command
 * result is UI feedback, not part of the persisted conversation ledger.
 */
interface AgentCommandResult {
  readonly id: string
  readonly command: string
  readonly text: string
  readonly tone: 'info' | 'error'
}

/** The embedded runtime is the only one, so the label is a constant rather than
 * a lookup table with a single entry. */
const runtimeLabels: Record<AgentRuntimeKind, string> = { pi: 'Pi' }
const promptExamples = [
  '帮我整理今天最重要的科研安排，并按优先级排序',
  '检索这个项目的最新文献，输出可核验的研究摘要',
  '把当前项目拆成下一步可执行的任务清单'
]
const trajectoryPageSize = 300

/**
 * Group one provider's models by the wire API they are called through.
 *
 * The app supports both OpenAI wire formats at once, so a provider's list can
 * mix them and the same model name can legitimately appear twice. Grouping keeps
 * the choice explicit instead of presenting two identical-looking rows.
 */
function groupModelsByApi(models: readonly AgentModelOption[]): readonly { readonly api: string; readonly models: readonly AgentModelOption[] }[] {
  const groups = new Map<string, AgentModelOption[]>()
  for (const model of models) {
    const api = model.api ?? '未声明协议'
    const bucket = groups.get(api)
    if (bucket) bucket.push(model)
    else groups.set(api, [model])
  }
  return [...groups].map(([api, entries]) => ({ api, models: entries }))
}

/** Delivery outcome of a scheduled run, read from the coarse run events. */
type DeliveryStatus =
  | { readonly state: 'written'; readonly relativePath: string | null; readonly artifactId: string | null }
  | { readonly state: 'skipped'; readonly reason: string | null; readonly message: string; readonly artifactId: string | null }

/**
 * The daily push reports its Obsidian projection as a coarse run event
 * (`OBSIDIAN_DAILY_NOTE_WRITTEN` / `OBSIDIAN_DAILY_NOTE_SKIPPED`). Reading the
 * newest one keeps the "did today's article actually land, and where" answer on
 * the run page instead of only inside the ledger detail text.
 */
function readDeliveryStatus(events: readonly AgentEventRecord[]): DeliveryStatus | null {
  for (const event of [...events].reverse()) {
    if (event.kind !== 'progress') continue
    const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : null
    const code = typeof payload?.['code'] === 'string' ? payload['code'] : null
    const artifactId = typeof payload?.['artifactId'] === 'string' ? payload['artifactId'] : null
    if (code === 'OBSIDIAN_DAILY_NOTE_WRITTEN') {
      return { state: 'written', relativePath: typeof payload?.['relativePath'] === 'string' ? payload['relativePath'] : null, artifactId }
    }
    if (code === 'OBSIDIAN_DAILY_NOTE_SKIPPED') {
      return {
        state: 'skipped',
        reason: typeof payload?.['reason'] === 'string' ? payload['reason'] : null,
        message: typeof payload?.['message'] === 'string' ? payload['message'] : 'Obsidian 每日推送未写入。',
        artifactId
      }
    }
  }
  return null
}

type AgentView = 'conversation' | 'trajectory'
/**
 * History filter. The runtime filter is gone with the second runtime: with one
 * embedded runtime, filtering by it can only ever show everything or nothing,
 * so "all" versus "bound to a project" is the only distinction worth a tab.
 */
type HistoryFilter = 'all' | 'project'

const historyFilterLabels: Record<HistoryFilter, string> = { all: '全部', project: '项目' }

function readStoredBoolean(key: string): boolean {
  try { return localStorage.getItem(key) === 'true' } catch { return false }
}

function readStoredView(): AgentView {
  try { return localStorage.getItem('workbench-agent-view') === 'trajectory' ? 'trajectory' : 'conversation' } catch { return 'conversation' }
}

export function AgentPage({ projects, onNavigate }: { projects: Project[]; onNavigate?: (view: 'dashboard' | 'tasks' | 'agent' | 'automation' | 'settings', openInNewTab?: boolean) => void }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [view, setView] = useState<AgentView>(readStoredView)
  const [runtime, setRuntime] = useState<AgentRuntimeKind>('pi')
  const [assistantKey, setAssistantKey] = useState('researcher')
  // A new conversation starts in the most recently used project, while
  // 未分类 stays an explicit, remembered choice.
  const { chooseProjectId, projectId, setProjectId } = useDefaultProjectId(projects)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [instructions, setInstructions] = useState('')
  const [feedback, setFeedback] = useState('')
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all')
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<string>>(new Set())
  // Per-record receipt of the last delete command, plus the labels it renders.
  // A deleted conversation leaves the list on the next refetch, so its name has
  // to be snapshotted when the command is submitted or the receipt would only
  // show an opaque id for the row it just removed.
  const [historyReceipt, setHistoryReceipt] = useState<ArchiveBulkResult | null>(null)
  const historyReceiptLabels = useRef<Map<string, string>>(new Map())
  const [historyCollapsed, setHistoryCollapsed] = useState(() => readStoredBoolean('workbench-agent-history-collapsed'))
  const [activeRun, setActiveRun] = useState<AgentRunRecord | null>(null)
  // Streaming overlay. The ledger queries stay the durable projection; pushed
  // records only exist to make the last throttle window of a run visible now.
  const [pushedRecords, setPushedRecords] = useState<AgentRunRecordEntry[]>([])
  const [realtime, setRealtime] = useState<RealtimeState>('unsupported')
  const [earlierRecords, setEarlierRecords] = useState<AgentRunRecordEntry[]>([])
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  // Local command results (see AgentCommandResult) and the `/` palette state.
  const [commandResults, setCommandResults] = useState<AgentCommandResult[]>([])
  const [paletteIndex, setPaletteIndex] = useState(0)
  const [paletteDismissed, setPaletteDismissed] = useState(false)

  useEffect(() => {
    try { localStorage.setItem('workbench-agent-history-collapsed', String(historyCollapsed)) } catch { /* optional renderer storage */ }
  }, [historyCollapsed])

  useEffect(() => {
    try { localStorage.setItem('workbench-agent-view', view) } catch { /* optional renderer storage */ }
  }, [view])

  // Keep all active conversations available to the embedded history rail. The
  // project selector filters visually, but never hides an intentionally opened
  // conversation when its project differs from the current draft context.
  const conversations = useQuery({
    queryKey: ['agent-conversations'],
    queryFn: () => getWorkbenchAgentApi().conversations.list({ includeArchived: false, limit: 100 }),
    staleTime: 30_000,
    placeholderData: (previous) => previous
  })
  const selectedConversation = useMemo<AgentConversation | null>(() => conversations.data?.find((item) => item.id === conversationId) ?? null, [conversationId, conversations.data])
  const visibleConversations = useMemo(() => {
    const all = conversations.data ?? []
    const filtered = historyFilter === 'all'
      ? all
      : historyFilter === 'project'
        ? all.filter((item) => item.projectId !== null)
        : all.filter((item) => item.runtime === historyFilter)
    if (!projectId) return filtered
    return filtered.filter((item) => item.projectId === projectId || item.id === conversationId)
  }, [conversationId, conversations.data, historyFilter, projectId])
  // Switching the history filter (or the project scope) changes what 全选 can
  // reach, so the selection follows the visible set instead of keeping hidden
  // ids that the count and 删除选中 would no longer act on.
  useEffect(() => {
    setSelectedHistoryIds((current) => {
      if (current.size === 0) return current
      const visible = new Set(visibleConversations.map((conversation) => conversation.id))
      const next = new Set([...current].filter((id) => visible.has(id)))
      return next.size === current.size ? current : next
    })
  }, [visibleConversations])
  const groupedConversations = useMemo(() => groupConversations(visibleConversations), [visibleConversations])
  const runs = useQuery({
    queryKey: ['agent-runs', conversationId],
    queryFn: () => getWorkbenchAgentApi().runs.list({ page: { limit: 100 } }),
    enabled: Boolean(conversationId),
    refetchInterval: conversationId ? 1_000 : false
  })
  const listedRun = useMemo(() => {
    return (runs.data ?? [])
      .filter((run) => run.conversationId === conversationId)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null
  }, [conversationId, runs.data])
  const latestRun = useMemo(() => {
    // The start response is refreshed by the short-lived run poll below and
    // therefore carries the authoritative terminal state during this view.
    return activeRun?.conversationId === conversationId ? activeRun : listedRun
  }, [activeRun, conversationId, listedRun])
  const isRunActive = Boolean(latestRun && !isTerminalRun(latestRun.status))
  const latestRunId = latestRun?.id ?? null
  // Chat is a tail window projection of the ledger. "Load earlier" widens the
  // window instead of using a cursor, so an insert while streaming can never
  // shift a page boundary.
  const ledger = useQuery({
    queryKey: ['agent-records', conversationId],
    queryFn: () => getWorkbenchAgentApi().conversations.records({ conversationId: conversationId!, limit: 1_000 }),
    enabled: Boolean(conversationId),
    refetchInterval: conversationId && isRunActive ? 1_500 : false,
    placeholderData: (previous) => previous
  })
  const trajectory = useQuery({
    queryKey: ['agent-run-records', latestRunId],
    queryFn: () => getWorkbenchAgentApi().runs.recordsPage({ runId: latestRunId!, beforeSeq: null, afterSeq: null, limit: trajectoryPageSize }),
    enabled: Boolean(latestRunId) && view === 'trajectory',
    refetchInterval: view === 'trajectory' && isRunActive ? 1_500 : false,
    placeholderData: (previous) => previous
  })
  // Run configuration lives in Settings, not in this page: the composer reads
  // the saved profile so a run always uses the model the user configured in one
  // place, and the status line links there instead of duplicating the controls.
  const settings = useQuery({
    queryKey: ['agent-settings'],
    queryFn: () => getWorkbenchAgentApi().settings.get(),
    staleTime: 30_000,
    placeholderData: (previous) => previous
  })
  const runProfile = settings.data ?? null
  const permissionMode: AgentPermissionMode = runProfile?.permissionMode ?? 'auto'
  // Composer selectors. The provider list is gated to providers that actually
  // hold a credential, because offering a provider whose runs can only fail is
  // worse than offering fewer options; the model list is that provider's own
  // catalog, so a model id is always shown together with the wire API it will
  // be called through.
  const catalog = useQuery({
    queryKey: ['agent-model-catalog'],
    queryFn: () => getWorkbenchAgentApi().models.catalog(),
    staleTime: 60_000,
    placeholderData: (previous) => previous
  })
  const credentialStatuses = useQuery({
    queryKey: ['agent-credential-status'],
    queryFn: () => getWorkbenchAgentApi().credentials.status(),
    staleTime: 60_000,
    placeholderData: (previous) => previous
  })
  const configuredProviderIds = useMemo(() => {
    const stored = new Set((credentialStatuses.data ?? []).filter((entry) => entry.credentialPresent).map((entry) => entry.provider))
    return new Set((catalog.data ?? []).filter((entry) => stored.has(entry.provider)).map((entry) => entry.provider))
  }, [catalog.data, credentialStatuses.data])
  const composerProvider = runProfile?.provider ?? null
  const composerModels = useMemo(
    () => (catalog.data ?? []).find((entry) => entry.provider === composerProvider)?.models ?? [],
    [catalog.data, composerProvider]
  )

  // Delivery status of the latest run. The run page has to answer "was today's
  // push written to the Vault, and under which relative path" without opening
  // the trajectory or the database, so the coarse events are projected here.
  const runEvents = useQuery({
    queryKey: ['agent-run-events', latestRunId],
    queryFn: () => getWorkbenchAgentApi().runs.eventsPage({ runId: latestRunId!, afterSeq: 0, limit: 500 }),
    enabled: Boolean(latestRunId),
    refetchInterval: latestRunId && isRunActive ? 2_000 : false,
    placeholderData: (previous) => previous
  })
  const delivery = useMemo(() => readDeliveryStatus(runEvents.data ?? []), [runEvents.data])
  // Incremental ledger subscription. It is scoped to the running run only and
  // degrades to the polling queries above when the channel or the preload
  // subscription API is unavailable.
  useEffect(() => {
    setPushedRecords([])
    setRealtime('unsupported')
    if (!latestRunId || !isRunActive) return
    const api = getWorkbenchAgentApi()
    const subscribe = api.runs.subscribe
    if (typeof subscribe !== 'function') return
    let disposed = false
    setRealtime('subscribed')
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = subscribe.call(api.runs, latestRunId, (push) => {
        if (disposed) return
        setRealtime('live')
        setPushedRecords((current) => mergeRecords(current, push.records))
        setActiveRun((current) => current && current.id === push.run.id && current.status === push.run.status ? current : push.run)
      })
    } catch {
      setRealtime('unsupported')
      return
    }
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [isRunActive, latestRunId])

  useEffect(() => {
    setEarlierRecords([])
  }, [latestRunId])

  const conversationRecords = useMemo(() => mergeRecords(ledger.data ?? [], pushedRecords), [ledger.data, pushedRecords])
  const latestRunRecords = useMemo(
    () => conversationRecords.filter((record) => record.runId === latestRunId),
    [conversationRecords, latestRunId]
  )
  const stats = useMemo(() => runStats(latestRunRecords), [latestRunRecords])
  const trajectoryRecords = useMemo(
    () => mergeRecords([...earlierRecords, ...(trajectory.data ?? [])], pushedRecords.filter((record) => record.runId === latestRunId)),
    [earlierRecords, latestRunId, pushedRecords, trajectory.data]
  )
  const oldestTrajectorySeq = trajectoryRecords[0]?.seq
  const hasEarlier = oldestTrajectorySeq !== undefined && oldestTrajectorySeq > 0

  const messagesRef = useRef<HTMLDivElement | null>(null)
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null)
  // Keep the empty composer compact like pi-web and grow only with content.
  const resizeComposerInput = (): void => {
    const element = composerInputRef.current
    if (!element) return
    element.style.height = '24px'
    element.style.height = `${Math.min(Math.max(element.scrollHeight, 24), 200)}px`
    element.style.overflowY = element.scrollHeight > 200 ? 'auto' : 'hidden'
  }
  useEffect(() => { resizeComposerInput() }, [instructions])
  // Sticky-bottom scrolling. An unconditional scroll on every appended record
  // would drag the reader back down while they are reading an earlier turn, so
  // the stream is only followed while the viewport is already near the bottom.
  const stickToBottomRef = useRef(true)
  const handleMessagesScroll = (): void => {
    const element = messagesRef.current
    if (!element) return
    stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
  }

  useEffect(() => {
    stickToBottomRef.current = true
  }, [conversationId])

  useEffect(() => {
    const element = messagesRef.current
    if (!element || !stickToBottomRef.current) return
    element.scrollTo({ top: element.scrollHeight })
  }, [commandResults.length, conversationId, conversationRecords.length, view])

  useEffect(() => {
    const runId = activeRun?.conversationId === conversationId ? activeRun.id : null
    if (!runId) return
    let disposed = false
    let timer: ReturnType<typeof setInterval> | undefined
    const poll = async (): Promise<void> => {
      try {
        const fresh = await getWorkbenchAgentApi().runs.get(runId)
        if (disposed) return
        setActiveRun(fresh)
        if (isTerminalRun(fresh.status) && timer) clearInterval(timer)
      } catch {
        // The ledger queries still provide the persisted view if a transient
        // IPC request is interrupted during shutdown or reload.
      }
    }
    timer = setInterval(() => { void poll() }, 500)
    void poll()
    return () => {
      disposed = true
      if (timer) clearInterval(timer)
    }
  }, [activeRun?.conversationId, activeRun?.id, conversationId])

  /** Append one local command outcome to the stream, keeping the newest 20. */
  const pushCommandResult = (command: string, text: string, tone: 'info' | 'error' = 'info'): void => {
    setCommandResults((current) => [...current.slice(-19), { id: `${Date.now().toString(36)}-${current.length.toString(36)}`, command, text, tone }])
  }

  /**
   * Persist the default `provider/modelId` pair for the next run.
   *
   * The composer selectors and `/model use` write the same value: there is one
   * default, it is stored in the Agent settings revision, and the runtime fails
   * closed when the pair is not in the catalog. Nothing here is a per-page
   * override, so the header line and the next run can never disagree.
   */
  const selectDefaultModel = async (provider: string | null, model: string | null): Promise<string> => {
    if (!runProfile) throw new Error('Agent 设置尚未加载，请稍后重试。')
    const saved = await getWorkbenchAgentApi().settings.save({ provider, model, thinking: runProfile.thinking, permissionMode: runProfile.permissionMode, toolProfile: runProfile.toolProfile, approvalPolicy: runProfile.approvalPolicy, responseLanguage: runProfile.responseLanguage, expectedRevision: runProfile.revision })
    queryClient.setQueryData(['agent-settings'], saved)
    return agentModelSelector(provider, model) ?? '未设置默认模型'
  }

  const selectModelMutation = useMutation({
    mutationFn: (input: { readonly provider: string | null; readonly model: string | null }) => selectDefaultModel(input.provider, input.model),
    onSuccess: (summary) => setFeedback(`默认模型已切换为 ${summary}；下一条消息使用该选择。`),
    onError: (error) => setFeedback(error instanceof Error ? error.message : '切换默认模型失败。')
  })

  const executeMagicCommand = async (command: Exclude<ReturnType<typeof parseAgentMagicCommand>, null | { readonly error: string }>, raw: string): Promise<void> => {
    const api = getWorkbenchAgentApi()
    if (command.kind === 'help') {
      pushCommandResult(raw, AGENT_MAGIC_HELP)
      setInstructions('')
      return
    }
    if (command.kind === 'settings' || command.kind === 'key' || command.kind === 'login') {
      try {
        if ('provider' in command) {
          localStorage.setItem('workbench-agent-command-provider', command.provider)
          localStorage.setItem('workbench-agent-command-intent', command.kind)
        } else {
          localStorage.removeItem('workbench-agent-command-provider')
          localStorage.removeItem('workbench-agent-command-intent')
        }
      } catch { /* optional renderer storage */ }
      openSettingsSection('agent')
      onNavigate?.('settings', false)
      pushCommandResult(raw, command.kind === 'key' ? `已打开设置，请在 Provider「${command.provider}」的安全输入框保存 Key。密钥不会进入聊天记录、模型请求或账本。` : command.kind === 'login' ? `已打开设置，请在 Provider「${command.provider}」启动 OAuth；授权页会自动由系统浏览器打开。` : '已打开模型与 Agent 设置。')
      setInstructions('')
      return
    }
    if (command.kind === 'logout') {
      const statuses = await api.models.logout({ provider: command.provider })
      queryClient.setQueryData(['agent-credential-status'], statuses)
      queryClient.setQueryData(['agent-model-catalog'], await api.models.catalog())
      pushCommandResult(raw, `已清除 Provider「${command.provider}」的本机凭据。`)
      setInstructions('')
      return
    }
    if (command.kind === 'provider-list') {
      const providers = await api.models.catalog()
      pushCommandResult(raw, providers.map((provider) => `${provider.provider} · ${provider.name} · ${provider.source}${configuredProviderIds.has(provider.provider) ? ' · 已配置凭据' : ' · 缺少凭据'}`).join('\n') || '暂无 Provider。')
      setInstructions('')
      return
    }
    if (command.kind === 'model-list') {
      const providers = await api.models.catalog()
      const filtered = command.provider === null ? providers : providers.filter((provider) => provider.provider === command.provider)
      const lines = filtered.flatMap((provider) => provider.models.map((model) => `${provider.provider}/${model.id} · ${model.api ?? '未声明协议'} · ${provider.source}`))
      pushCommandResult(raw, lines.join('\n') || '没有找到模型；可在设置中重新发现，或为自定义 Provider 手动填写模型 id。')
      setInstructions('')
      return
    }
    if (command.kind === 'model-use') {
      const slash = command.selector.indexOf('/')
      if (slash <= 0 || slash === command.selector.length - 1) throw new Error('/model use 必须使用 provider/modelId。')
      const provider = command.selector.slice(0, slash)
      const model = command.selector.slice(slash + 1)
      try {
        const summary = await selectDefaultModel(provider, model)
        pushCommandResult(raw, `默认模型已切换为 ${summary}；下一条消息使用该选择。`)
      } catch (error) {
        pushCommandResult(raw, error instanceof Error ? error.message : '切换默认模型失败。', 'error')
      }
      setInstructions('')
      return
    }
    const snapshot = await api.models.customProviders.get()
    if (command.kind === 'provider-add') {
      if (snapshot.providers.some((provider) => provider.id === command.id)) throw new Error(`Provider「${command.id}」已存在。`)
      await api.models.customProviders.save({ providers: [...snapshot.providers, { id: command.id, name: command.id, baseUrl: command.baseUrl, api: command.api, models: [] }] })
      await queryClient.invalidateQueries({ queryKey: ['agent-model-catalog'] })
      pushCommandResult(raw, `已添加 Provider「${command.id}」（${command.api}）。下一步：/key ${command.id} 保存 Key，再 /provider discover ${command.id} 发现模型。`)
      setInstructions('')
      return
    }
    if (command.kind === 'provider-remove') {
      await api.models.customProviders.save({ providers: snapshot.providers.filter((provider) => provider.id !== command.id) })
      await queryClient.invalidateQueries({ queryKey: ['agent-model-catalog'] })
      pushCommandResult(raw, `已从 models.json 移除 Provider「${command.id}」；safeStorage 中的 Key 未被删除。`)
      setInstructions('')
      return
    }
    if (command.kind === 'provider-discover') {
      const target = snapshot.providers.find((provider) => provider.id === command.id)
      if (!target) throw new Error(`Provider「${command.id}」不在 models.json 中；先用 /provider add 添加。`)
      try {
        const result = await api.models.customProviders.discover({ provider: target.id, baseUrl: target.baseUrl, api: target.api })
        const pending = result.models.length
        pushCommandResult(raw, pending === 0
          ? `「${command.id}」没有返回可用模型：该协议/网关不提供标准模型列表，请在设置中手动填写模型 id。`
          : `「${command.id}」发现 ${pending} 个候选模型（${result.api}）${result.notice ? `；${result.notice}` : ''}。候选模型需要你在设置中“采用”后才会写入 models.json。`)
        openSettingsSection('agent')
        onNavigate?.('settings', false)
      } catch (error) {
        pushCommandResult(raw, error instanceof Error ? error.message : '发现模型失败。', 'error')
      }
      setInstructions('')
    }
  }

  const startMutation = useMutation({
    mutationFn: async () => {
      const text = instructions.trim()
      const magic = parseAgentMagicCommand(text)
      if (magic && 'error' in magic) {
        // A malformed command stays local: it is answered here instead of being
        // sent to the model as prose, because the user addressed the composer.
        pushCommandResult(text, magic.error, 'error')
        setInstructions('')
        return null
      }
      if (magic) {
        await executeMagicCommand(magic, text)
        return null
      }
      if (!text) throw new Error('请先输入消息。')
      const selectedModel = runProfile?.model?.trim() || null
      let activeConversation = selectedConversation
      if (!activeConversation || activeConversation.projectId !== (projectId || null) || activeConversation.runtime !== runtime || (activeConversation.permissionMode ?? 'read-only') !== permissionMode) {
        activeConversation = await getWorkbenchAgentApi().conversations.create({ projectId: projectId ? ProjectIdSchema.parse(projectId) : null, title: text.slice(0, 60), runtime, model: selectedModel, assistantKey: assistantKey.trim() || 'researcher', toolProfile: runProfile?.toolProfile ?? 'approved-write', permissionMode, approvalPolicy: runProfile?.approvalPolicy ?? 'never' })
      }
      setConversationId(activeConversation.id)
      const run = await getWorkbenchAgentApi().runs.start({ jobId: null, conversationId: activeConversation.id, runtime, model: selectedModel, thinking: runProfile?.thinking ?? null, workflowKey: 'research_plan', skillKey: null, projectId: activeConversation.projectId, paperIds: [], instructions: text, toolProfile: runProfile?.toolProfile ?? 'approved-write', permissionMode, approvalPolicy: runProfile?.approvalPolicy ?? 'never', idempotencyKey: null, resumeFromRunId: null })
      setActiveRun(run)
      return run
    },
    onSuccess: (run) => {
      if (!run) return
      setInstructions('')
      setFeedback('已发送给 Agent；运行状态会持续保存到本地工作区。')
      void queryClient.invalidateQueries({ queryKey: ['agent-conversations'] })
      void queryClient.invalidateQueries({ queryKey: ['agent-records'] })
      void queryClient.invalidateQueries({ queryKey: ['agent-run-records'] })
      void queryClient.invalidateQueries({ queryKey: ['agent-runs'] })
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : 'Agent 启动失败。')
  })
  // --- Conversation history record removal --------------------------------
  // “删除” is a revision-checked soft archive of the conversation *record*: the
  // conversation leaves the history rail while its messages and every
  // associated `agent_runs` / `agent_events` row stay readable in the local
  // database, and no credential or external data is touched. Both the row action
  // and the bulk action report their own per-record outcome, so a stale
  // selection is never shown as deleted.
  /** Apply one delete command's per-record truth to the list: only the records
   * the command actually archived leave the cache. A conflict / failed / skipped
   * row stays visible until the refetch shows its real state. */
  const applyConversationRemoval = async (result: ArchiveBulkResult, label: string): Promise<void> => {
    const removedIds = new Set(result.items.filter((item) => item.outcome === 'succeeded').map((item) => item.id))
    if (conversationId && removedIds.has(conversationId)) createConversation()
    setSelectedHistoryIds((current) => {
      const next = new Set(current)
      removedIds.forEach((id) => next.delete(id))
      return next
    })
    queryClient.setQueryData<AgentConversation[]>(['agent-conversations'], (current) =>
      (current ?? []).filter((item) => !removedIds.has(item.id)))
    setFeedback(result.conflict > 0 || result.failed > 0
      ? `${label}：已删除 ${result.succeeded} 个，跳过 ${result.skipped} 个，修订冲突 ${result.conflict} 个，失败 ${result.failed} 个；冲突或失败的对话未改动，请刷新后重试。`
      : `${label}：已删除 ${result.succeeded} 个${result.skipped > 0 ? `，跳过 ${result.skipped} 个（已不在历史中）` : ''}；记录已从历史列表移除，本机数据库中的 runs、事件与消息仍然保留。`)
    await queryClient.invalidateQueries({ queryKey: ['agent-conversations'] })
  }
  const removeConversationMutation = useMutation({
    mutationFn: (conversation: AgentConversation) => removeConversationRecords([{ id: conversation.id, expectedRevision: conversation.revision }]),
    onSuccess: async (result, conversation) => {
      setHistoryReceipt(result)
      await applyConversationRemoval(result, `删除对话“${safeDisplayTitle(conversation.title)}”`)
    },
    onError: (error) => { setHistoryReceipt(null); setFeedback(error instanceof Error ? error.message : '删除对话失败。') }
  })
  const removeConversationsMutation = useMutation({
    mutationFn: (locks: ArchiveBulkLock[]) => removeConversationRecords(locks),
    onSuccess: async (result) => {
      setHistoryReceipt(result)
      await applyConversationRemoval(result, `删除选中的 ${result.items.length} 个对话`)
    },
    onError: (error) => { setHistoryReceipt(null); setFeedback(error instanceof Error ? error.message : '批量删除对话失败，未应用任何更改。') }
  })

  const selectConversation = (conversation: AgentConversation) => {
    setConversationId(conversation.id)
    setRuntime(conversation.runtime)
    setAssistantKey(conversation.assistantKey || 'researcher')
    setProjectId(conversation.projectId || '')
    // A draft selected from the new-chat quick prompts belongs to that draft
    // only. Clear it when opening an existing thread so a later send cannot
    // accidentally post stale text into the selected conversation.
    setInstructions('')
    setFeedback('')
    setActiveRun(null)
  }
  const createConversation = () => {
    setConversationId(null)
    setSelectedHistoryIds(new Set())
    setInstructions('')
    setFeedback('')
    setActiveRun(null)
  }
  const cancelMutation = useMutation({
    mutationFn: (runId: string) => getWorkbenchAgentApi().runs.cancel(runId),
    onSuccess: async () => {
      setFeedback('已请求停止 Agent 运行。')
      await queryClient.invalidateQueries({ queryKey: ['agent-runs'] })
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : '停止 Agent 失败。')
  })
  const send = () => { if (!startMutation.isPending && !isRunActive) startMutation.mutate() }
  // `/` palette. It only offers completions while the composer holds a command
  // prefix, and Escape dismisses it for the current edit without clearing text.
  const paletteSuggestions = useMemo(() => (paletteDismissed ? [] : filterAgentMagicSuggestions(instructions)), [instructions, paletteDismissed])
  const paletteVisible = paletteSuggestions.length > 0
  const highlightedCommand = paletteSuggestions[Math.min(paletteIndex, paletteSuggestions.length - 1)]?.command ?? null
  /** Accept a completion. A command that still needs arguments keeps the caret
   * in the composer; the trailing space in the suggestion makes that visible. */
  const acceptSuggestion = (command: string): void => {
    setInstructions(command)
    setPaletteIndex(0)
    setPaletteDismissed(false)
  }
  /**
   * Enter sends, except while a completion is highlighted and the typed text is
   * not yet a complete command — there Enter takes the completion instead of
   * firing an error. A complete command (`/help`, `/model list`) submits, which
   * is what the user who typed it in full asked for.
   */
  const handleComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (paletteVisible && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setPaletteIndex((current) => (current + step + paletteSuggestions.length) % paletteSuggestions.length)
      return
    }
    if (event.key === 'Escape' && paletteVisible) {
      event.preventDefault()
      setPaletteDismissed(true)
      return
    }
    if (event.key === 'Tab' && paletteVisible && highlightedCommand !== null) {
      event.preventDefault()
      acceptSuggestion(highlightedCommand)
      return
    }
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
      const parsed = parseAgentMagicCommand(instructions.trim())
      if (paletteVisible && highlightedCommand !== null && (parsed === null || 'error' in parsed) && highlightedCommand !== instructions.trim()) {
        event.preventDefault()
        acceptSuggestion(highlightedCommand)
        return
      }
      event.preventDefault()
      send()
    }
  }
  const changeComposerProvider = (provider: string): void => {
    const first = (catalog.data ?? []).find((entry) => entry.provider === provider)?.models[0]?.id ?? null
    selectModelMutation.mutate({ provider, model: first })
  }
  const changeComposerModel = (model: string): void => {
    if (composerProvider === null) return
    selectModelMutation.mutate({ provider: composerProvider, model })
  }
  const stop = () => { if (latestRun && isRunActive && !cancelMutation.isPending) cancelMutation.mutate(latestRun.id) }
  const loadEarlier = async (): Promise<void> => {
    if (!latestRunId || oldestTrajectorySeq === undefined || loadingEarlier) return
    setLoadingEarlier(true)
    try {
      const older = await getWorkbenchAgentApi().runs.recordsPage({ runId: latestRunId, beforeSeq: oldestTrajectorySeq, afterSeq: null, limit: trajectoryPageSize })
      setEarlierRecords((current) => mergeRecords(older, current))
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '读取更早的运行记录失败。')
    } finally {
      setLoadingEarlier(false)
    }
  }
  const toggleHistorySelection = (idToToggle: string) => {
    setSelectedHistoryIds((current) => {
      const next = new Set(current)
      if (next.has(idToToggle)) next.delete(idToToggle)
      else next.add(idToToggle)
      return next
    })
  }
  const selectAllVisibleHistory = () => {
    setSelectedHistoryIds((current) => {
      const visibleIds = visibleConversations.map((conversation) => conversation.id)
      if (visibleIds.length > 0 && visibleIds.every((id) => current.has(id))) return new Set()
      return new Set(visibleIds)
    })
  }
  /** One receipt row as the user names it, surviving the refetch that removes
   * the row from the list. */
  const describeHistoryReceipt = (id: string): string => {
    const conversation = visibleConversations.find((candidate) => candidate.id === id)
    return conversation ? safeDisplayTitle(conversation.title) : historyReceiptLabels.current.get(id) ?? '该对话（已不在当前列表）'
  }
  const deleteSelectedConversations = () => {
    if (removeConversationsMutation.isPending || removeConversationMutation.isPending) return
    const selected = visibleConversations.filter((conversation) => selectedHistoryIds.has(conversation.id))
    if (selected.length === 0) return
    const names = selected.map((conversation) => safeDisplayTitle(conversation.title)).join('、')
    const confirmed = window.confirm([
      `将删除选中的 ${selected.length} 个对话（当前筛选下共 ${visibleConversations.length} 个）：${names}。`,
      '删除范围仅限对话历史列表；本机数据库保留对话记录、runs、事件与消息（软归档，不做级联删除），凭据与外部数据不会被改动。',
      '其中已被其他操作更新过、或仍有运行中 Agent 运行的对话会以“修订冲突/失败”逐条回报且不会被删除。确认继续？'
    ].join('\n'))
    if (!confirmed) return
    historyReceiptLabels.current = new Map(selected.map((conversation) => [conversation.id, safeDisplayTitle(conversation.title)]))
    setHistoryReceipt(null)
    removeConversationsMutation.mutate(selected.map((conversation) => ({ id: conversation.id, expectedRevision: conversation.revision })))
  }
  const deleteConversation = (conversation: AgentConversation) => {
    if (removeConversationMutation.isPending || removeConversationsMutation.isPending) return
    const confirmed = window.confirm(`确认删除对话“${safeDisplayTitle(conversation.title)}”？删除只是从历史列表移除（软归档）：本机数据库保留该对话及其 runs、事件与消息，凭据与外部数据不受影响。`)
    if (!confirmed) return
    historyReceiptLabels.current = new Map([[conversation.id, safeDisplayTitle(conversation.title)]])
    setHistoryReceipt(null)
    removeConversationMutation.mutate(conversation)
  }

  return <div className={cn('agent-thread-shell', historyCollapsed && 'agent-thread-shell-history-collapsed')}>
    {feedback ? <p aria-live="polite" className="agent-feedback" role="status">{feedback}</p> : null}
    <aside aria-label="对话历史" className={cn('agent-history-panel', historyCollapsed && 'agent-history-panel-collapsed')}>
      {historyCollapsed ? <div className="agent-history-collapsed-content"><button aria-expanded={false} aria-label="展开对话历史" className="agent-history-collapse-button" onClick={() => setHistoryCollapsed(false)} title="展开对话历史" type="button"><PanelLeftOpen aria-hidden="true" className="size-4" /></button><span className="agent-history-collapsed-count">{visibleConversations.length}</span><button aria-label="新建对话" className="agent-history-collapse-button" onClick={createConversation} title="新建对话" type="button"><Plus aria-hidden="true" className="size-4" /></button></div> : <>
      <div className="agent-history-header">
        <div><p className="agent-eyebrow">WORKSPACE</p><h2>对话</h2></div>
        <div className="agent-history-header-actions"><button aria-expanded={true} aria-label="折叠对话历史" className="agent-history-collapse-button" onClick={() => setHistoryCollapsed(true)} title="折叠对话历史" type="button"><PanelLeftClose aria-hidden="true" className="size-4" /></button><button aria-label="新建对话" className="agent-history-new" onClick={createConversation} title="新建对话" type="button"><Plus aria-hidden="true" className="size-4" /></button></div>
      </div>
      <div className="agent-history-filters" role="tablist" aria-label="对话分类">
        {(['all', 'project'] as const).map((value) => <button aria-selected={historyFilter === value} className={cn('agent-history-filter', historyFilter === value && 'agent-history-filter-active')} key={value} onClick={() => setHistoryFilter(value)} role="tab" type="button">{historyFilterLabels[value]}</button>)}
      </div>
      <div className="agent-history-list">
        {visibleConversations.length > 0 ? <div className="agent-history-selection-bar">
          <SelectionBar
            allSelected={visibleConversations.length > 0 && visibleConversations.every((conversation) => selectedHistoryIds.has(conversation.id))}
            className="selection-bar-compact"
            indeterminate={visibleConversations.some((conversation) => selectedHistoryIds.has(conversation.id))}
            label="对话历史选择"
            onClear={() => setSelectedHistoryIds(new Set())}
            onToggleAll={selectAllVisibleHistory}
            scope={`范围：${historyFilterLabels[historyFilter]}筛选下的 ${visibleConversations.length} 个对话；切换筛选会清除已隐藏的已选对话`}
            selectAllLabel="全选当前对话"
            selectedCount={selectedHistoryIds.size}
            totalCount={visibleConversations.length}
          >
            <button aria-label={`删除选中的 ${selectedHistoryIds.size} 个对话`} className="agent-history-bulk-delete" disabled={selectedHistoryIds.size === 0 || removeConversationsMutation.isPending} onClick={deleteSelectedConversations} type="button"><Trash2 aria-hidden="true" className="size-3.5" /><span>{removeConversationsMutation.isPending ? '删除中…' : '删除选中'}</span></button>
          </SelectionBar>
        </div> : null}
        {historyReceipt ? <ArchiveReceiptList className="agent-history-receipt m-3" describe={describeHistoryReceipt} result={historyReceipt} succeededVerb="已删除" /> : null}
        {conversations.isLoading ? <PanelSkeleton lines={6} /> : null}
        {!conversations.isLoading && visibleConversations.length === 0 ? <p className="agent-history-empty">{(conversations.data ?? []).length > 0 ? <>当前筛选或项目范围内没有对话。<br />切换筛选或项目后可看到其他历史。</> : <>还没有对话。<br />从右侧输入框开始一次新的 Agent 任务。</>}</p> : null}
        {Object.entries(groupedConversations).map(([group, items]) => <div className="agent-history-group" key={group}>
          <p className="agent-history-group-label">{group}</p>
          {items.map((conversation) => <div className={cn('agent-history-item-wrap', conversation.id === conversationId && 'agent-history-item-wrap-active')} key={conversation.id}>
            <label className="agent-history-checkbox"><input aria-label={`选择对话：${safeDisplayTitle(conversation.title)}`} checked={selectedHistoryIds.has(conversation.id)} onChange={() => toggleHistorySelection(conversation.id)} type="checkbox" /><span className="sr-only">选择对话</span></label>
            <button aria-current={conversation.id === conversationId ? 'page' : undefined} className={cn('agent-history-item', conversation.id === conversationId && 'agent-history-item-active')} onClick={() => selectConversation(conversation)} type="button">
              <span className="agent-history-item-icon"><MessageSquare aria-hidden="true" className="size-3.5" /></span>
              <span className="agent-history-item-copy"><strong>{safeDisplayTitle(conversation.title)}</strong><span>{runtimeLabels[conversation.runtime]} · {formatConversationDate(conversation.updatedAt)}</span></span>
              <span className={cn('agent-history-status', `agent-history-status-${conversation.status}`)} title={conversationStatusLabel(conversation.status)} />
            </button>
            <button aria-label={`删除对话：${safeDisplayTitle(conversation.title)}`} className="agent-history-delete" onClick={() => deleteConversation(conversation)} title="删除对话（软归档，本机记录保留）" type="button"><Trash2 aria-hidden="true" className="size-3" /></button>
          </div>)}
        </div>)}
      </div>
      <div className="agent-history-footnote"><Clock3 aria-hidden="true" className="size-3" /><span>历史记录保存在本地工作区 · 每个对话一个 session 文件</span></div>
      </>}
    </aside>

    <section aria-labelledby="agent-thread-title" className="agent-thread">
      <header className="agent-thread-header">
        <div className="agent-thread-heading">
          <Sparkles aria-hidden="true" className="size-4 text-primary" />
          <div><h1 id="agent-thread-title">{selectedConversation ? safeDisplayTitle(selectedConversation.title) : 'Hi，今天有什么安排？'}</h1><p>{selectedConversation ? `${runtimeLabels[runtime]} · ${assistantKey || 'researcher'}` : '告诉我你做了什么、接下来打算做什么'}</p></div>
        </div>
        {/* Read-only run configuration. It is shown here because the composer
            needs it to be answerable at a glance ("which model am I actually
            talking to"), and it is a link because editing it belongs in
            Settings, not in the conversation header. */}
        <button className="agent-run-profile-link" onClick={() => { openSettingsSection('agent'); onNavigate?.('settings', false) }} title="在设置中修改模型、思考深度与权限模式" type="button">
          <Settings2 aria-hidden="true" className="size-3.5" />
          <span className="agent-run-profile-value">{runtimeLabels[runtime]} · {runProfile?.model || '未选择模型'} · {runProfile?.thinking || '默认思考'}</span>
          <span className="agent-run-profile-hint">{permissionLabel(permissionMode)}</span>
        </button>
      </header>

      {/* One tab strip per thread, deliberately below the header so the runtime
          bar keeps exactly one copy of each select control. */}
      <div className="agent-thread-tabs">
        <ResearchTabs
          items={[{ value: 'conversation' as AgentView, label: '对话' }, { value: 'trajectory' as AgentView, label: '轨迹', count: latestRunRecords.length }]}
          label="Agent 视图"
          onChange={setView}
          value={view}
        />
      </div>

      <div aria-label="当前会话消息" className={cn('agent-thread-messages', view === 'trajectory' && 'agent-thread-messages-records')} onScroll={handleMessagesScroll} ref={messagesRef} role="log">
        {view === 'conversation' ? <>
          {!conversationId ? <div className="agent-thread-empty"><div className="agent-thread-empty-icon"><Bot aria-hidden="true" className="size-5" /></div><h2>准备好开始了吗？</h2><p>输入问题、上传上下文，或从下方指令开始。</p></div> : null}
          {conversationId && ledger.isLoading ? <PanelSkeleton lines={5} /> : null}
          {conversationId && !ledger.isLoading ? <ConversationView isRunning={isRunActive} records={conversationRecords} runtime={selectedConversation?.runtime ?? runtime} /> : null}
          {/* Agent-requested external writes. They sit below the transcript
              because they are the next action the user has to take: everything
              above them already happened, and nothing here has. */}
          {conversationId ? <ExternalActionCards conversationId={conversationId} /> : null}
          {/* Local command answers. They are rendered after the persisted records
              because they happened after them, and they are labelled as local so
              they cannot be mistaken for a model reply. */}
          {commandResults.length > 0 ? <div aria-label="本机命令结果" aria-live="polite" className="agent-command-results">
            {commandResults.map((entry) => <article className={cn('agent-command-result', entry.tone === 'error' && 'agent-command-result-error')} key={entry.id}>
              <p className="agent-command-result-head"><Terminal aria-hidden="true" className="size-3" /><code>{entry.command}</code><span>本机命令 · 未发送给模型</span></p>
              <p className="agent-command-result-text">{entry.text}</p>
            </article>)}
          </div> : null}
        </> : <>
          {!latestRunId ? <div className="agent-thread-empty"><div className="agent-thread-empty-icon"><Bot aria-hidden="true" className="size-5" /></div><h2>还没有运行轨迹</h2><p>这段对话还没有发起过 Agent 运行。</p></div> : null}
          {latestRunId ? <TrajectoryView hasEarlier={hasEarlier} isFetching={trajectory.isFetching && trajectoryRecords.length === 0} isRunning={isRunActive} loadingEarlier={loadingEarlier} onLoadEarlier={() => void loadEarlier()} records={trajectoryRecords} /> : null}
        </>}
      </div>

      <div className="agent-composer-dock">
        {delivery ? <DeliveryStrip delivery={delivery} onNavigate={onNavigate} /> : null}
        <StatsRow isRunning={isRunActive} realtime={realtime} stats={stats} />
        <StepStrip isRunning={isRunActive} records={latestRunRecords} />
        {!conversationId && <div className="agent-prompts agent-prompts-above-composer"><p>试试这些指令</p>{promptExamples.map((prompt) => <button key={prompt} onClick={() => setInstructions(prompt)} type="button">{prompt}</button>)}</div>}
        <div className="agent-composer-zone">
          {paletteVisible ? <div aria-label="命令补全" className="agent-command-palette" role="listbox">
            {paletteSuggestions.map((suggestion, index) => <button aria-selected={index === Math.min(paletteIndex, paletteSuggestions.length - 1)} className={cn('agent-command-palette-item', index === Math.min(paletteIndex, paletteSuggestions.length - 1) && 'agent-command-palette-item-active')} key={suggestion.command} onClick={() => acceptSuggestion(suggestion.command)} onMouseEnter={() => setPaletteIndex(index)} role="option" type="button">
              <code>{suggestion.command.trim()}</code>
              <span>{suggestion.summary}</span>
            </button>)}
            <p className="agent-command-palette-hint">↑/↓ 选择 · Tab 或 Enter 补全 · Esc 关闭</p>
          </div> : null}
          <div className={cn('agent-composer', startMutation.isPending && 'agent-composer-busy')}>
          <Textarea ref={composerInputRef} aria-label="发送给 Agent 的消息" className="agent-composer-input" onChange={(event) => { setInstructions(event.target.value); resizeComposerInput(); setPaletteIndex(0); setPaletteDismissed(false) }} onKeyDown={handleComposerKeyDown} placeholder="发送消息到工作台 Agent… 输入 / 唤起命令，@ 引用文件，@@ 引用会话，↑/↓ 选择命令" style={{ minHeight: '24px', maxHeight: '200px' }} value={instructions} />
          <div className="agent-composer-toolbar">
            <div className="agent-composer-tools"><button aria-label="添加上下文" className="agent-icon-button" title="添加上下文" type="button"><Plus aria-hidden="true" className="size-4" /></button><label className="agent-toolbar-select"><FolderOpen aria-hidden="true" className="size-3.5" /><span className="sr-only">项目</span><select aria-label="在项目中工作" onChange={(event) => chooseProjectId(event.target.value)} value={projectId}><option value="">未分类（不绑定项目）</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
              {/* Provider/model for the next run. Only providers holding a
                  credential are listed: a provider without a key can only
                  produce a failed run, so offering it would be a trap. */}
              <label className="agent-toolbar-select" title="下一条消息使用的 Provider（仅列出已保存凭据的 Provider）"><Cpu aria-hidden="true" className="size-3.5" /><span className="sr-only">Provider</span><select aria-label="Agent Provider" disabled={selectModelMutation.isPending || configuredProviderIds.size === 0} onChange={(event) => changeComposerProvider(event.target.value)} value={composerProvider ?? ''}><option value="">{configuredProviderIds.size === 0 ? '未配置凭据' : '未选择 Provider'}</option>{[...configuredProviderIds].sort().map((provider) => <option key={provider} value={provider}>{provider}</option>)}</select></label>
              <label className="agent-toolbar-select" title="下一条消息使用的模型（按 Provider 与 wire API 区分）"><Boxes aria-hidden="true" className="size-3.5" /><span className="sr-only">模型</span><select aria-label="Agent 模型" disabled={selectModelMutation.isPending || composerProvider === null || composerModels.length === 0} onChange={(event) => changeComposerModel(event.target.value)} value={runProfile?.model ?? ''}><option value="">{composerProvider === null ? '先选 Provider' : composerModels.length === 0 ? '该 Provider 没有模型' : '未选择模型'}</option>{groupModelsByApi(composerModels).map((group) => <optgroup key={group.api} label={group.api}>{group.models.map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}</optgroup>)}</select></label>
            </div>
            <div className="agent-composer-config"><label className="agent-toolbar-input"><Bot aria-hidden="true" className="size-3.5" /><span className="sr-only">助手</span><Input aria-label="助手" className="agent-inline-input" onChange={(event) => setAssistantKey(event.target.value)} placeholder="researcher" value={assistantKey} /></label>{isRunActive ? <Button aria-label="停止 Agent 运行" className="agent-send-button" disabled={cancelMutation.isPending} loading={cancelMutation.isPending} onClick={stop} size="icon" variant="danger"><Square aria-hidden="true" className="size-4" /></Button> : <Button aria-label="发送" className="agent-send-button" disabled={!instructions.trim()} loading={startMutation.isPending} onClick={send} size="icon" variant="primary"><ArrowUp aria-hidden="true" className="size-4" /></Button>}</div>
          </div>
          </div>
        </div>
        <p className="agent-composer-hint">Enter 发送 · Shift + Enter 换行 · 输入 <code>/</code> 唤起本机命令 · {permissionLabel(permissionMode)}模式（本地任务/日历/提醒写入直接生效）· 上方选择器即默认模型，也可在 <button className="agent-hint-link" onClick={() => { openSettingsSection('agent'); onNavigate?.('settings', false) }} type="button">设置 → 模型与 Agent</button> 中配置</p>
      </div>
    </section>
  </div>
}

/**
 * Daily-push delivery strip. It is deliberately a status line, not a second
 * artifact view: the relative path is the actionable fact, and the two links
 * open the existing Artifact / inbox surfaces instead of duplicating them here.
 */
function DeliveryStrip({ delivery, onNavigate }: { delivery: DeliveryStatus; onNavigate?: ((view: 'dashboard' | 'tasks' | 'agent' | 'automation', openInNewTab?: boolean) => void) | undefined }): React.JSX.Element {
  const written = delivery.state === 'written'
  return <div aria-label="每日文献推送投递状态" className={cn('agent-delivery-strip', written ? 'agent-delivery-strip-written' : 'agent-delivery-strip-skipped')} role="status">
    <span className="agent-delivery-state">{written ? 'OBSIDIAN_DAILY_NOTE_WRITTEN' : 'OBSIDIAN_DAILY_NOTE_SKIPPED'}</span>
    <span className="agent-delivery-detail">
      {written
        ? <><span>已写入 Obsidian</span><code title={delivery.relativePath ?? ''}>{delivery.relativePath ?? '（未返回相对路径）'}</code></>
        : <><span>未写入 Obsidian{delivery.reason ? `（${delivery.reason}）` : ''}</span><span>{delivery.message}</span></>}
    </span>
    {delivery.artifactId && onNavigate
      ? <span className="agent-delivery-actions">
        <button onClick={() => onNavigate('dashboard', true)} title={delivery.artifactId} type="button"><ExternalLink aria-hidden="true" className="size-3" />查看科研产物</button>
        <button onClick={() => onNavigate('dashboard', true)} type="button"><ExternalLink aria-hidden="true" className="size-3" />查看 Agent 收件箱</button>
      </span>
      : null}
  </div>
}

/**
 * Delete one row or a whole selection through whichever command the paired
 * preload exposes, and always return per-record receipts.
 *
 * New preloads use the transactional bulk endpoint; an older packaged renderer
 * paired with a newer preload only exposes the revision-checked single-item
 * command, and an even older preload only exposes `archive` — the same soft
 * archive this command performs, so its resolved promise is still a real success
 * even though no per-record outcome came back.
 */
async function removeConversationRecords(items: ArchiveBulkLock[]): Promise<ArchiveBulkResult> {
  const conversations = getWorkbenchAgentApi().conversations
  const removeBulk = conversations.removeBulk as ((input: ArchiveBulkLock[]) => Promise<ArchiveBulkResult>) | undefined
  if (typeof removeBulk === 'function') return await removeBulk(items)
  const receipts: ArchiveBulkResult['items'] = []
  const removeOne = conversations.remove as ((conversationId: string, expectedRevision: number) => Promise<ArchiveBulkResult['items'][number]>) | undefined
  for (const item of items) {
    try {
      if (typeof removeOne === 'function') receipts.push(await removeOne(item.id, item.expectedRevision))
      else {
        await conversations.archive(item.id, item.expectedRevision)
        receipts.push({ id: item.id, outcome: 'succeeded', error: null })
      }
    } catch (error) {
      receipts.push({
        id: item.id,
        outcome: 'failed',
        error: { code: 'CONVERSATION_REMOVE_FAILED', message: error instanceof Error ? error.message : '删除对话失败。', retryable: true }
      })
    }
  }
  return receiptResultFrom(receipts)
}

function groupConversations(conversations: AgentConversation[]): Record<string, AgentConversation[]> {
  const groups: Record<string, AgentConversation[]> = {}
  for (const conversation of conversations) {
    const date = new Date(conversation.updatedAt)
    const now = new Date()
    const dayDistance = Number.isNaN(date.getTime()) ? 3 : Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) / 86_400_000)
    const label = dayDistance <= 0 ? '今天' : dayDistance === 1 ? '昨天' : '更早'
    ;(groups[label] ??= []).push(conversation)
  }
  return groups
}

function isTerminalRun(status: AgentRunRecord['status']): boolean {
  return ['completed', 'partial', 'failed', 'canceled', 'blocked', 'missed'].includes(status)
}

function formatConversationDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '刚刚'
  const now = new Date()
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function conversationStatusLabel(status: AgentConversation['status']): string {
  return status === 'running' ? '运行中' : status === 'finished' ? '已完成' : status === 'archived' ? '已归档' : '待处理'
}

function permissionLabel(value: AgentPermissionMode): string {
  if (value === 'read-only') return '只读'
  if (value === 'auto') return '自动批准'
  return '完全访问'
}
