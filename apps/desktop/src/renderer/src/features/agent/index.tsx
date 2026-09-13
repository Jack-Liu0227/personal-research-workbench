import { ArrowUp, Bot, Check, ChevronDown, Clock3, ExternalLink, FolderOpen, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Sparkles, Square, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentConversation, AgentConnector, AgentCredentialProvider, AgentCredentialSaveInput, AgentEventRecord, AgentPermissionMode, AgentRunRecord, AgentRunRecordEntry, AgentRuntimeKind, ArchiveBulkLock, ArchiveBulkResult, Project } from '@prw/contracts'
import { agentCredentialProviders, ProjectIdSchema } from '@prw/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Input, Textarea } from '../../components/ui'
import { ArchiveReceiptList, SelectionBar, receiptResultFrom } from '../../components/selection'
import { InlineLoadingState, PanelSkeleton } from '../../components/states'
import { cn } from '../../lib/utils'
import { useDefaultProjectId } from '../../lib/recent-project'
import { getWorkbenchAgentApi } from '../../lib/workbench'
import { ResearchTabs } from '../research/shared'
import { ConversationView } from './conversation-view'
import { StatsRow, StepStrip, type RealtimeState } from './progress'
import { TrajectoryView } from './trajectory-view'
import { mergeRecords, runStats, safeDisplayTitle } from './ledger'

const runtimeLabels: Record<AgentRuntimeKind, string> = { codex: 'Codex', pi: 'Pi' }
const runtimeDefaults: Record<AgentRuntimeKind, { model: string; permission: string; thinking: string }> = {
  codex: { model: '', permission: '跟随 Codex 配置', thinking: '跟随 Codex 配置' },
  pi: { model: '', permission: '跟随 Pi 配置', thinking: '跟随 Pi 配置' }
}
const promptExamples = [
  '帮我整理今天最重要的科研安排，并按优先级排序',
  '检索这个项目的最新文献，输出可核验的研究摘要',
  '把当前项目拆成下一步可执行的任务清单'
]
const trajectoryPageSize = 300

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
type HistoryFilter = 'all' | 'codex' | 'pi' | 'project'

function readStoredBoolean(key: string): boolean {
  try { return localStorage.getItem(key) === 'true' } catch { return false }
}

function readStoredView(): AgentView {
  try { return localStorage.getItem('workbench-agent-view') === 'trajectory' ? 'trajectory' : 'conversation' } catch { return 'conversation' }
}

export function AgentPage({ projects, onNavigate }: { projects: Project[]; onNavigate?: (view: 'dashboard' | 'tasks' | 'agent' | 'automation', openInNewTab?: boolean) => void }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [view, setView] = useState<AgentView>(readStoredView)
  const [runtime, setRuntime] = useState<AgentRuntimeKind>('codex')
  const [model, setModel] = useState(runtimeDefaults.codex.model)
  const [thinking, setThinking] = useState('')
  const [assistantKey, setAssistantKey] = useState('researcher')
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>('read-only')
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
  // App-owned runtime credential. Only the non-secret status ever reaches the
  // renderer; the key is written straight through to Main's safeStorage vault.
  const [credentialRuntime, setCredentialRuntime] = useState<AgentRuntimeKind>('codex')
  const [credentialProvider, setCredentialProvider] = useState<AgentCredentialProvider>('openai')
  const [credentialSecret, setCredentialSecret] = useState('')
  const [credentialFeedback, setCredentialFeedback] = useState('')
  const recordsEndRef = useRef<HTMLDivElement | null>(null)

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
  const connectors = useQuery({
    queryKey: ['agent-connectors'],
    queryFn: () => getWorkbenchAgentApi().connectors.list(),
    staleTime: 60_000,
    retry: false,
    refetchInterval: false,
    refetchOnMount: false,
    placeholderData: (previous) => previous
  })
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
  const credentials = useQuery({
    queryKey: ['agent-credentials'],
    queryFn: () => getWorkbenchAgentApi().credentials.status(),
    staleTime: 30_000,
    placeholderData: (previous) => previous
  })
  const activeCredential = credentials.data?.find((entry) => entry.runtime === credentialRuntime) ?? null
  const credentialChoices = agentCredentialProviders(credentialRuntime)
  const saveCredentialMutation = useMutation({
    mutationFn: (input: AgentCredentialSaveInput) => getWorkbenchAgentApi().credentials.save(input),
    onSuccess: (statuses, input) => {
      queryClient.setQueryData(['agent-credentials'], statuses)
      setCredentialSecret('')
      setCredentialFeedback(
        input.apiKey
          ? `已保存 ${runtimeLabels[input.runtime]} 的运行凭据；仅 Main 可解密，注入 ${statuses.find((entry) => entry.runtime === input.runtime)?.envVar ?? 'CLI 环境变量'}。`
          : `已清除 ${runtimeLabels[input.runtime]} 的运行凭据。`
      )
    },
    onError: (error) => setCredentialFeedback(error instanceof Error ? error.message : '凭据保存失败。')
  })
  const activeConnector = connectors.data?.find((connector) => connector.runtime === runtime)
  const localPermission = formatLocalPermission(runtime, activeConnector?.localPermission)
  const permissionOptions = activeConnector?.permissionOptions ?? []

  // The local CLI profile is the source of truth for the initial selector.
  // Do not overwrite an explicit user edit after the connector probe returns.
  useEffect(() => {
    if (connectors.isLoading) return
    const detected = connectors.data?.find((connector) => connector.runtime === runtime)?.localDefaultModel
    if (detected && (model === runtimeDefaults[runtime].model || model.trim().length === 0)) setModel(detected)
    const detectedThinking = connectors.data?.find((connector) => connector.runtime === runtime)?.localThinkingLevel
    if (detectedThinking && thinking.trim().length === 0) setThinking(detectedThinking)
  }, [connectors.data, connectors.isLoading, model, runtime, thinking])

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

  useEffect(() => {
    recordsEndRef.current?.scrollIntoView({ block: 'end' })
  }, [conversationId, conversationRecords.length, view])

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

  const startMutation = useMutation({
    mutationFn: async () => {
      const text = instructions.trim()
      if (!text) throw new Error('请先输入消息。')
      const selectedModel = effectiveModel(runtime, model, activeConnector?.localDefaultModel)
      let activeConversation = selectedConversation
      if (!activeConversation || activeConversation.projectId !== (projectId || null) || activeConversation.runtime !== runtime || (activeConversation.permissionMode ?? 'read-only') !== permissionMode) {
        activeConversation = await getWorkbenchAgentApi().conversations.create({ projectId: projectId ? ProjectIdSchema.parse(projectId) : null, title: text.slice(0, 60), runtime, model: selectedModel, assistantKey: assistantKey.trim() || 'researcher', toolProfile: permissionMode === 'read-only' ? 'read-only' : 'approved-write', permissionMode, approvalPolicy: permissionMode === 'full-access' ? 'never' : 'on-request' })
      }
      setConversationId(activeConversation.id)
      const run = await getWorkbenchAgentApi().runs.start({ jobId: null, conversationId: activeConversation.id, runtime, model: selectedModel, thinking: thinking.trim() || null, workflowKey: 'research_plan', skillKey: null, projectId: activeConversation.projectId, paperIds: [], instructions: text, toolProfile: permissionMode === 'read-only' ? 'read-only' : 'approved-write', permissionMode, approvalPolicy: permissionMode === 'full-access' ? 'never' : 'on-request', idempotencyKey: null, resumeFromRunId: null })
      setActiveRun(run)
      return run
    },
    onSuccess: () => {
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

  const selectRuntime = (next: AgentRuntimeKind) => {
    setRuntime(next)
    const detectedModel = connectors.data?.find((connector) => connector.runtime === next)?.localDefaultModel
    setModel(detectedModel || runtimeDefaults[next].model)
    const detectedThinking = connectors.data?.find((connector) => connector.runtime === next)?.localThinkingLevel
    setThinking(detectedThinking || '')
  }
  const selectConversation = (conversation: AgentConversation) => {
    setConversationId(conversation.id)
    setRuntime(conversation.runtime)
    setModel(conversation.model || connectors.data?.find((item) => item.runtime === conversation.runtime)?.localDefaultModel || runtimeDefaults[conversation.runtime].model)
    setThinking(connectors.data?.find((item) => item.runtime === conversation.runtime)?.localThinkingLevel || '')
    setAssistantKey(conversation.assistantKey || 'researcher')
    setPermissionMode(conversation.permissionMode ?? (conversation.toolProfile === 'approved-write' ? 'auto' : 'read-only'))
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
        {([['all', '全部'], ['codex', 'Codex'], ['pi', 'Pi'], ['project', '项目']] as const).map(([value, label]) => <button aria-selected={historyFilter === value} className={cn('agent-history-filter', historyFilter === value && 'agent-history-filter-active')} key={value} onClick={() => setHistoryFilter(value)} role="tab" type="button">{label}</button>)}
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
            scope={`范围：${{ all: '全部', codex: 'Codex', pi: 'Pi', project: '项目' }[historyFilter]}筛选下的 ${visibleConversations.length} 个对话；切换筛选会清除已隐藏的已选对话`}
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
          <div><h1 id="agent-thread-title">{selectedConversation ? safeDisplayTitle(selectedConversation.title) : 'Hi，今天有什么安排？'}</h1><p>{selectedConversation ? `${runtimeLabels[runtime]} · ${assistantKey || 'researcher'}` : '选择一个 runtime，开始你的科研工作流'}</p></div>
        </div>
        <div aria-label="选择 Agent runtime" className="agent-runtime-bar" role="group">
          {(['codex', 'pi'] as AgentRuntimeKind[]).map((item) => {
            const connector = connectors.data?.find((candidate) => candidate.runtime === item)
            const active = runtime === item
            return <button aria-pressed={active} className={cn('agent-runtime-pill', active && 'agent-runtime-pill-active')} key={item} onClick={() => selectRuntime(item)} type="button"><span className={cn('agent-runtime-dot', connector?.available ? 'agent-runtime-dot-online' : 'agent-runtime-dot-muted')} /><span>{runtimeLabels[item]}</span>{active ? <Check aria-hidden="true" className="size-3" /> : null}</button>
          })}
          <span className="agent-runtime-divider" />
          {connectors.isFetching ? <InlineLoadingState label="正在探测 runtime…" /> : connectors.error ? <span className="agent-runtime-probe-error" role="status">runtime 探测失败，可在设置中重试</span> : null}
          <label className="agent-model-select"><span className="sr-only">模型</span><select aria-label="模型" onChange={(event) => setModel(event.target.value)} value={model}><option value="">跟随 CLI 模型</option>{[...new Set([model, ...(activeConnector?.modelOptions ?? [])].filter(Boolean))].map((option) => <option key={option} value={option}>{option}</option>)}</select><ChevronDown aria-hidden="true" className="agent-select-chevron" /></label>
          <label className="agent-thinking-select"><span className="sr-only">思考深度</span><select aria-label="思考深度" onChange={(event) => setThinking(event.target.value)} value={thinking}><option value="">跟随 CLI 配置</option>{[...new Set([...(activeConnector?.thinkingOptions ?? []), activeConnector?.localThinkingLevel].filter((value): value is string => Boolean(value)))].map((option) => <option key={option} value={option}>{option}</option>)}</select><ChevronDown aria-hidden="true" className="agent-select-chevron" /></label>
          <label className="agent-permission-select"><span className="sr-only">权限模式</span><select aria-label="权限模式" disabled={permissionOptions.length === 0} onChange={(event) => setPermissionMode(event.target.value as AgentPermissionMode)} value={permissionOptions.includes(permissionMode) ? permissionMode : ''}><option value="">跟随 CLI 配置</option>{permissionOptions.map((option) => <option key={option} value={option}>{permissionLabel(option)}</option>)}</select><ChevronDown aria-hidden="true" className="agent-select-chevron" /></label><span className="agent-runtime-permission" title={localPermission}>{localPermission}</span>
        </div>
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

      <div aria-label="当前会话消息" className={cn('agent-thread-messages', view === 'trajectory' && 'agent-thread-messages-records')} role="log">
        {view === 'conversation' ? <>
          {!conversationId ? <div className="agent-thread-empty"><div className="agent-thread-empty-icon"><Bot aria-hidden="true" className="size-5" /></div><h2>准备好开始了吗？</h2><p>输入问题、上传上下文，或从下方指令开始。</p></div> : null}
          {conversationId && ledger.isLoading ? <PanelSkeleton lines={5} /> : null}
          {conversationId && !ledger.isLoading ? <ConversationView isRunning={isRunActive} records={conversationRecords} runtime={selectedConversation?.runtime ?? runtime} /> : null}
          <div ref={recordsEndRef} />
        </> : <>
          {!latestRunId ? <div className="agent-thread-empty"><div className="agent-thread-empty-icon"><Bot aria-hidden="true" className="size-5" /></div><h2>还没有运行轨迹</h2><p>这段对话还没有发起过 Agent 运行。</p></div> : null}
          {latestRunId ? <TrajectoryView hasEarlier={hasEarlier} isFetching={trajectory.isFetching && trajectoryRecords.length === 0} isRunning={isRunActive} loadingEarlier={loadingEarlier} onLoadEarlier={() => void loadEarlier()} records={trajectoryRecords} /> : null}
        </>}
      </div>

      <div className="agent-composer-dock">
        {delivery ? <DeliveryStrip delivery={delivery} onNavigate={onNavigate} /> : null}
        <details className="agent-runtime-profile">
          <summary className="agent-runtime-profile-summary"><span>运行环境与凭据</span><span className="agent-runtime-profile-hint">{activeConnector ? `${activeConnector.available ? '可用' : '不可用'} · ${authSourceLabel(activeConnector)}` : '正在探测…'}</span></summary>
          <dl className="agent-runtime-profile-grid">
            <div><dt>运行时</dt><dd>{runtimeLabels[runtime]}</dd></div>
            <div><dt>版本</dt><dd>{activeConnector?.version ?? '未检测到'}</dd></div>
            <div><dt>可执行文件</dt><dd className="agent-runtime-profile-path" title={activeConnector?.executablePath ?? undefined}>{activeConnector?.executablePath ?? '未检测到'}</dd></div>
            <div><dt>Profile</dt><dd>{activeConnector?.profileSource === 'app-isolated' ? `应用隔离${activeConnector.profileLabel ? `（${activeConnector.profileLabel}）` : ''}` : '未确认；不会复用个人 ~/.codex 或 ~/.pi 登录'}</dd></div>
            <div><dt>审批通道</dt><dd>{activeConnector?.approvalChannel === 'interactive' ? '可交互' : '非交互（批处理，不会伪造确认）'}</dd></div>
            <div><dt>权限来源</dt><dd>{localPermission}</dd></div>
          </dl>
          {activeConnector && !activeConnector.available ? <p className="agent-runtime-profile-warning" role="status">{activeConnector.message || '运行时不可用；请检查安装或在设置中修正路径。'}</p> : null}
          <div className="agent-credential-form">
            <p className="agent-credential-lead">运行凭据存放在 Main 的 safeStorage，只在单次 CLI 进程中注入环境变量；页面只显示状态，不回显密钥。</p>
            <div className="agent-credential-row">
              <label className="agent-credential-field">运行时<select aria-label="凭据运行时" onChange={(event) => { const next = event.target.value as AgentRuntimeKind; setCredentialRuntime(next); setCredentialProvider(agentCredentialProviders(next)[0]?.provider ?? 'openai') }} value={credentialRuntime}><option value="codex">Codex</option><option value="pi">Pi</option></select></label>
              <label className="agent-credential-field">Provider<select aria-label="凭据 provider" onChange={(event) => setCredentialProvider(event.target.value as AgentCredentialProvider)} value={credentialProvider}>{credentialChoices.map((choice) => <option key={choice.provider} value={choice.provider}>{choice.label}（{choice.envVar}）</option>)}</select></label>
              <label className="agent-credential-field">密钥<Input aria-label="凭据密钥" autoComplete="off" onChange={(event) => setCredentialSecret(event.target.value)} placeholder={activeCredential?.credentialPresent ? '已保存；输入新值可替换' : '粘贴 provider API key'} type="password" value={credentialSecret} /></label>
              <Button disabled={saveCredentialMutation.isPending || credentialSecret.trim().length === 0} onClick={() => saveCredentialMutation.mutate({ runtime: credentialRuntime, provider: credentialProvider, apiKey: credentialSecret })} size="sm" type="button">保存凭据</Button>
              <Button disabled={saveCredentialMutation.isPending || activeCredential?.credentialPresent !== true} onClick={() => saveCredentialMutation.mutate({ runtime: credentialRuntime, provider: credentialProvider, apiKey: null })} size="sm" type="button" variant="ghost">清除凭据</Button>
            </div>
            <p className="agent-credential-status" role="status">{credentials.error ? '凭据状态读取失败；运行将按“无应用凭据”处理。' : activeCredential?.credentialPresent ? `当前：已配置 ${activeCredential.provider}${activeCredential.envVar ? `（注入 ${activeCredential.envVar}）` : ''}` : '当前：未配置应用凭据；不会复用个人 CLI 登录态，也不会伪造凭据。'}{credentialFeedback ? ` ${credentialFeedback}` : ''}</p>
          </div>
        </details>
        <StatsRow isRunning={isRunActive} realtime={realtime} stats={stats} />
        <StepStrip isRunning={isRunActive} records={latestRunRecords} />
        {!conversationId && <div className="agent-prompts agent-prompts-above-composer"><p>试试这些指令</p>{promptExamples.map((prompt) => <button key={prompt} onClick={() => setInstructions(prompt)} type="button">{prompt}</button>)}</div>}
        <div className={cn('agent-composer', startMutation.isPending && 'agent-composer-busy')}>
          <Textarea aria-label="发送给 Agent 的消息" className="agent-composer-input" onChange={(event) => setInstructions(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send() } }} placeholder="发送消息到工作台 Agent… 输入 / 唤起命令，@ 引用文件，@@ 引用会话，↑/↓ 切换历史消息" value={instructions} />
          <div className="agent-composer-toolbar">
            <div className="agent-composer-tools"><button aria-label="添加上下文" className="agent-icon-button" title="添加上下文" type="button"><Plus aria-hidden="true" className="size-4" /></button><label className="agent-toolbar-select"><FolderOpen aria-hidden="true" className="size-3.5" /><span className="sr-only">项目</span><select aria-label="在项目中工作" onChange={(event) => chooseProjectId(event.target.value)} value={projectId}><option value="">未分类（不绑定项目）</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label></div>
            <div className="agent-composer-config"><label className="agent-toolbar-input"><Bot aria-hidden="true" className="size-3.5" /><span className="sr-only">助手</span><Input aria-label="助手" className="agent-inline-input" onChange={(event) => setAssistantKey(event.target.value)} placeholder="researcher" value={assistantKey} /></label>{isRunActive ? <Button aria-label="停止 Agent 运行" className="agent-send-button" disabled={cancelMutation.isPending} loading={cancelMutation.isPending} onClick={stop} size="icon" variant="danger"><Square aria-hidden="true" className="size-4" /></Button> : <Button aria-label="发送" className="agent-send-button" disabled={!instructions.trim()} loading={startMutation.isPending} onClick={send} size="icon" variant="primary"><ArrowUp aria-hidden="true" className="size-4" /></Button>}</div>
          </div>
        </div>
        <p className="agent-composer-hint">⌘/Ctrl + Enter 发送 · 当前策略：<strong>{permissionMode}</strong> · 模型与思考深度由上方唯一控制区选择</p>
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

function effectiveModel(_runtime: AgentRuntimeKind, value: string, detected: string | null | undefined): string | null {
  const trimmed = value.trim()
  if (trimmed) return trimmed
  if (detected) return detected
  return null
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

function formatLocalPermission(runtime: AgentRuntimeKind, value: string | null | undefined): string {
  if (!value) return runtimeDefaults[runtime].permission
  if (runtime === 'codex') {
    if (value === 'never') return '全自动'
    if (value === 'user') return '按需确认'
  }
  if (runtime === 'pi' && value === 'ask') return '询问'
  return value
}

function permissionLabel(value: AgentPermissionMode): string {
  if (value === 'read-only') return '只读'
  if (value === 'auto') return '自动批准'
  return '完全访问'
}

/** Truthful one-line summary of where the runtime's authentication comes from. */
function authSourceLabel(connector: AgentConnector | undefined): string {
  switch (connector?.authSource) {
    case 'app-safeStorage': return '应用 safeStorage 凭据'
    case 'cli-login': return 'CLI 自身登录（应用隔离 profile）'
    case 'none': return '无可用凭据'
    default: return '未探测'
  }
}

