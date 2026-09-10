import { ArrowUp, Bot, Check, ChevronDown, ChevronRight, Clock3, FolderOpen, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Sparkles, Square, Trash2, UserRound, Wrench } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentConversation, AgentConversationArchiveItem, AgentEventRecord, AgentMessage, AgentPermissionMode, AgentRunRecord, AgentRuntimeKind, Project } from '@prw/contracts'
import { ProjectIdSchema } from '@prw/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Input, Textarea } from '../components/ui'
import { InlineLoadingState, PanelSkeleton } from '../components/states'
import { MarkdownPreview } from '../components/markdown-editor'
import { cn } from '../lib/utils'
import { getWorkbenchAgentApi } from '../lib/workbench'

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

type HistoryFilter = 'all' | 'codex' | 'pi' | 'project'

function readStoredBoolean(key: string): boolean {
  try { return localStorage.getItem(key) === 'true' } catch { return false }
}

export function AgentPage({ projects }: { projects: Project[] }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [runtime, setRuntime] = useState<AgentRuntimeKind>('codex')
  const [model, setModel] = useState(runtimeDefaults.codex.model)
  const [thinking, setThinking] = useState('')
  const [assistantKey, setAssistantKey] = useState('researcher')
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>('read-only')
  const [projectId, setProjectId] = useState('')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [instructions, setInstructions] = useState('')
  const [feedback, setFeedback] = useState('')
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all')
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<string>>(new Set())
  const [historyCollapsed, setHistoryCollapsed] = useState(() => readStoredBoolean('workbench-agent-history-collapsed'))
  const [activeRun, setActiveRun] = useState<AgentRunRecord | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    try { localStorage.setItem('workbench-agent-history-collapsed', String(historyCollapsed)) } catch { /* optional renderer storage */ }
  }, [historyCollapsed])

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
  const groupedConversations = useMemo(() => groupConversations(visibleConversations), [visibleConversations])
  const messages = useQuery({
    queryKey: ['agent-messages', conversationId],
    queryFn: () => getWorkbenchAgentApi().conversations.messages({ conversationId: conversationId!, limit: 500 }),
    enabled: Boolean(conversationId),
    // Persisted messages are the durable transcript; a short poll keeps a
    // completed turn from flashing twice while the event stream is arriving.
    refetchInterval: conversationId ? 750 : false
  })
  const runs = useQuery({
    queryKey: ['agent-runs', conversationId],
    queryFn: () => getWorkbenchAgentApi().runs.list({ page: { limit: 100 } }),
    enabled: Boolean(conversationId),
    refetchInterval: conversationId ? 1_000 : false
  })
  const listedRun = useMemo(() => {
    const fromList = (runs.data ?? [])
      .filter((run) => run.conversationId === conversationId)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null
    return fromList
  }, [conversationId, runs.data])
  const latestRun = useMemo(() => {
    // The start response is refreshed by the short-lived run poll below and
    // therefore carries the authoritative terminal state during this view.
    return activeRun?.conversationId === conversationId ? activeRun : listedRun
  }, [activeRun, conversationId, listedRun])
  const events = useQuery({
    queryKey: ['agent-events', latestRun?.id],
    queryFn: () => getWorkbenchAgentApi().runs.eventsPage({ runId: latestRun!.id, afterSeq: 0, limit: 500 }),
    enabled: Boolean(latestRun?.id),
    refetchInterval: latestRun && !isTerminalRun(latestRun.status) ? 250 : false
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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [conversationId, events.data?.length, messages.data?.length])

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
        // The event/message queries still provide the persisted view if a
        // transient IPC request is interrupted during shutdown or reload.
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
      const run = await getWorkbenchAgentApi().runs.start({ jobId: null, conversationId: activeConversation.id, runtime, model: selectedModel, thinking: thinking.trim() || null, workflowKey: 'research_plan', projectId: activeConversation.projectId, paperIds: [], instructions: text, toolProfile: permissionMode === 'read-only' ? 'read-only' : 'approved-write', permissionMode, approvalPolicy: permissionMode === 'full-access' ? 'never' : 'on-request', idempotencyKey: null })
      setActiveRun(run)
      return run
    },
    onSuccess: () => {
      setInstructions('')
      setFeedback('已发送给 Agent；运行状态会持续保存到本地工作区。')
      void queryClient.invalidateQueries({ queryKey: ['agent-conversations'] })
      void queryClient.invalidateQueries({ queryKey: ['agent-messages'] })
      void queryClient.invalidateQueries({ queryKey: ['agent-runs'] })
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : 'Agent 启动失败。')
  })
  const archiveMutation = useMutation({
    mutationFn: (conversation: AgentConversation) => getWorkbenchAgentApi().conversations.archive(conversation.id, conversation.revision),
    onMutate: async (conversation) => {
      await queryClient.cancelQueries({ queryKey: ['agent-conversations'] })
      const previous = queryClient.getQueryData<AgentConversation[]>(['agent-conversations'])
      queryClient.setQueryData<AgentConversation[]>(['agent-conversations'], (current) =>
        (current ?? []).filter((item) => item.id !== conversation.id))
      return { previous }
    },
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ['agent-conversations'] }) },
    onSuccess: (_value, conversation) => {
      if (conversation.id === conversationId) createConversation()
      setSelectedHistoryIds((current) => { const next = new Set(current); next.delete(conversation.id); return next })
      setFeedback('对话已删除。')
      void queryClient.invalidateQueries({ queryKey: ['agent-conversations'] })
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : '删除对话失败。')
  })
  const archiveManyMutation = useMutation({
    mutationFn: archiveConversationItems,
    onMutate: async (items) => {
      await queryClient.cancelQueries({ queryKey: ['agent-conversations'] })
      const previous = queryClient.getQueryData<AgentConversation[]>(['agent-conversations'])
      const ids = new Set(items.map((item) => item.conversationId))
      queryClient.setQueryData<AgentConversation[]>(['agent-conversations'], (current) =>
        (current ?? []).filter((item) => !ids.has(item.id)))
      return { previous }
    },
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ['agent-conversations'] }) },
    onSuccess: (_value, items) => {
      const archivedIds = new Set(items.map((item) => item.conversationId))
      if (conversationId && archivedIds.has(conversationId)) createConversation()
      setSelectedHistoryIds((current) => {
        const next = new Set(current)
        archivedIds.forEach((id) => next.delete(id))
        return next
      })
      setFeedback(`已删除 ${items.length} 个对话。`)
      void queryClient.invalidateQueries({ queryKey: ['agent-conversations'] })
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : '批量删除对话失败，未应用任何更改。')
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
  const isRunActive = Boolean(latestRun && !isTerminalRun(latestRun.status))
  const send = () => { if (!startMutation.isPending && !isRunActive) startMutation.mutate() }
  const stop = () => { if (latestRun && isRunActive && !cancelMutation.isPending) cancelMutation.mutate(latestRun.id) }
  const toggleHistorySelection = (conversationIdToToggle: string) => {
    setSelectedHistoryIds((current) => {
      const next = new Set(current)
      if (next.has(conversationIdToToggle)) next.delete(conversationIdToToggle)
      else next.add(conversationIdToToggle)
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
  const archiveSelectedConversations = () => {
    if (archiveManyMutation.isPending) return
    const items = visibleConversations
      .filter((conversation) => selectedHistoryIds.has(conversation.id))
      .map((conversation) => ({ conversationId: conversation.id, expectedRevision: conversation.revision }))
    if (items.length === 0) return
    if (window.confirm(`确认删除选中的 ${items.length} 个对话吗？此操作会从当前历史中移除。`)) archiveManyMutation.mutate(items)
  }
  const archiveConversation = (conversation: AgentConversation) => {
    if (archiveMutation.isPending || archiveManyMutation.isPending) return
    if (window.confirm(`确认删除对话“${safeDisplayTitle(conversation.title)}”吗？此操作不可撤销。`)) archiveMutation.mutate(conversation)
  }
  const transcript = messages.data ?? []
  const activeRunAssistantMessages = latestRun
    ? transcript.filter((message) => message.runId === latestRun.id && message.role === 'assistant')
    : []
  const transcriptBeforeLiveRun = latestRun
    ? transcript.filter((message) => !(message.runId === latestRun.id && message.role === 'assistant'))
    : transcript

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
        {visibleConversations.length > 0 ? <div className="agent-history-selection-bar"><label className="agent-history-select-all"><input aria-label="全选当前对话" checked={visibleConversations.every((conversation) => selectedHistoryIds.has(conversation.id))} onChange={selectAllVisibleHistory} type="checkbox" />{selectedHistoryIds.size > 0 ? <span>已选 {selectedHistoryIds.size}</span> : <span>全选</span>}</label>{selectedHistoryIds.size > 0 ? <button aria-label={`删除选中的 ${selectedHistoryIds.size} 个对话`} className="agent-history-bulk-delete" disabled={archiveManyMutation.isPending} onClick={archiveSelectedConversations} type="button"><Trash2 aria-hidden="true" className="size-3.5" /><span>{archiveManyMutation.isPending ? '删除中…' : '删除选中'}</span></button> : null}</div> : null}
        {conversations.isLoading ? <PanelSkeleton lines={6} /> : null}
        {!conversations.isLoading && visibleConversations.length === 0 ? <p className="agent-history-empty">还没有对话。<br />从右侧输入框开始一次新的 Agent 任务。</p> : null}
        {Object.entries(groupedConversations).map(([group, items]) => <div className="agent-history-group" key={group}>
          <p className="agent-history-group-label">{group}</p>
          {items.map((conversation) => <div className={cn('agent-history-item-wrap', conversation.id === conversationId && 'agent-history-item-wrap-active')} key={conversation.id}>
            <label className="agent-history-checkbox"><input aria-label={`选择对话：${safeDisplayTitle(conversation.title)}`} checked={selectedHistoryIds.has(conversation.id)} onChange={() => toggleHistorySelection(conversation.id)} type="checkbox" /><span className="sr-only">选择对话</span></label>
            <button aria-current={conversation.id === conversationId ? 'page' : undefined} className={cn('agent-history-item', conversation.id === conversationId && 'agent-history-item-active')} onClick={() => selectConversation(conversation)} type="button">
              <span className="agent-history-item-icon"><MessageSquare aria-hidden="true" className="size-3.5" /></span>
              <span className="agent-history-item-copy"><strong>{safeDisplayTitle(conversation.title)}</strong><span>{runtimeLabels[conversation.runtime]} · {formatConversationDate(conversation.updatedAt)}</span></span>
              <span className={cn('agent-history-status', `agent-history-status-${conversation.status}`)} title={conversationStatusLabel(conversation.status)} />
            </button>
            <button aria-label={`删除对话：${safeDisplayTitle(conversation.title)}`} className="agent-history-delete" onClick={() => archiveConversation(conversation)} title="删除对话" type="button"><Trash2 aria-hidden="true" className="size-3" /></button>
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
        <div className="agent-runtime-bar" aria-label="选择 Agent runtime" role="group">
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

      <div aria-label="当前会话消息" className="agent-thread-messages" role="log">
        {!conversationId ? <div className="agent-thread-empty"><div className="agent-thread-empty-icon"><Bot aria-hidden="true" className="size-5" /></div><h2>准备好开始了吗？</h2><p>输入问题、上传上下文，或从下方指令开始。</p></div> : null}
        {conversationId && messages.isLoading ? <PanelSkeleton lines={5} /> : null}
        {conversationId && !messages.isLoading && (messages.data ?? []).length === 0 ? <p className="agent-thread-empty-copy">这是一段新对话，发送第一条消息即可开始。</p> : null}
        {transcriptBeforeLiveRun.map((message) => <MessageRow key={message.id} message={message} runtime={selectedConversation?.runtime ?? runtime} />)}
        <LiveRunPanel events={events.data ?? []} key={latestRun?.id ?? 'no-run'} messages={transcript} run={latestRun} />
        {!isRunActive ? activeRunAssistantMessages.map((message) => <MessageRow key={message.id} message={message} runtime={selectedConversation?.runtime ?? runtime} />) : null}
        <div ref={messagesEndRef} />
      </div>

      <div className="agent-composer-dock">
        {!conversationId && <div className="agent-prompts agent-prompts-above-composer"><p>试试这些指令</p>{promptExamples.map((prompt) => <button key={prompt} onClick={() => setInstructions(prompt)} type="button">{prompt}<ArrowUp aria-hidden="true" className="size-3 opacity-0 transition-opacity group-hover:opacity-100" /></button>)}</div>}
        <div className={cn('agent-composer', startMutation.isPending && 'agent-composer-busy')}>
          <Textarea aria-label="发送给 Agent 的消息" className="agent-composer-input" onChange={(event) => setInstructions(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send() } }} placeholder="发送消息到工作台 Agent… 输入 / 唤起命令，@ 引用文件，@@ 引用会话，↑/↓ 切换历史消息" value={instructions} />
          <div className="agent-composer-toolbar">
            <div className="agent-composer-tools"><button aria-label="添加上下文" className="agent-icon-button" title="添加上下文" type="button"><Plus aria-hidden="true" className="size-4" /></button><label className="agent-toolbar-select"><FolderOpen aria-hidden="true" className="size-3.5" /><span className="sr-only">项目</span><select aria-label="在项目中工作" onChange={(event) => setProjectId(event.target.value)} value={projectId}><option value="">在项目中工作</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label></div>
            <div className="agent-composer-config"><label className="agent-toolbar-input"><Bot aria-hidden="true" className="size-3.5" /><span className="sr-only">助手</span><Input aria-label="助手" className="agent-inline-input" onChange={(event) => setAssistantKey(event.target.value)} placeholder="researcher" value={assistantKey} /></label>{isRunActive ? <Button aria-label="停止 Agent 运行" className="agent-send-button" disabled={cancelMutation.isPending} loading={cancelMutation.isPending} onClick={stop} size="icon" variant="danger"><Square aria-hidden="true" className="size-4" /></Button> : <Button aria-label="发送" className="agent-send-button" disabled={!instructions.trim()} loading={startMutation.isPending} onClick={send} size="icon" variant="primary"><ArrowUp aria-hidden="true" className="size-4" /></Button>}</div>
          </div>
        </div>
        <p className="agent-composer-hint">⌘/Ctrl + Enter 发送 · 当前策略：<strong>{permissionMode}</strong> · 模型与思考深度由上方唯一控制区选择</p>
      </div>
    </section>
  </div>
}

function MessageRow({ message, runtime }: { message: AgentMessage; runtime: AgentRuntimeKind }): React.JSX.Element {
  const roleLabel = message.role === 'user' ? '你' : message.role === 'assistant' ? runtimeLabels[runtime] : message.role === 'tool' ? '工具' : '系统'
  return <article className={cn('agent-message-row', `agent-message-${message.role}`)}><div className="agent-message-meta"><span className="agent-message-avatar">{message.role === 'user' ? <UserRound aria-hidden="true" className="size-3.5" /> : <Bot aria-hidden="true" className="size-3.5" />}</span><strong>{roleLabel}</strong><time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time></div>{message.role === 'assistant' ? <MarkdownPreview source={safeDisplayContent(message.content)} /> : <p>{safeDisplayContent(message.content)}</p>}</article>
}

function LiveRunPanel({ run, events, messages }: { run: AgentRunRecord | null; events: AgentEventRecord[]; messages: AgentMessage[] }): React.JSX.Element | null {
  const [stepsExpanded, setStepsExpanded] = useState(false)
  const [expandedStep, setExpandedStep] = useState<string | null>(null)
  if (!run) return null
  const hasPersistedAssistant = messages.some((message) => message.runId === run.id && message.role === 'assistant')
  const streamText = streamAssistantText(events)
  const activities = dedupeToolActivities(events.filter((event) => event.kind === 'tool_call' || looksLikeToolEvent(event.payload)))
  const storageEvent = [...events].reverse().find((event) => {
    if (event.kind !== 'progress' || !event.payload || typeof event.payload !== 'object') return false
    const code = (event.payload as Record<string, unknown>).code
    return typeof code === 'string' && /^OBSIDIAN_DAILY_NOTE_(WRITTEN|SKIPPED)$/u.test(code)
  })
  const storageCode = storageEvent && storageEvent.payload && typeof storageEvent.payload === 'object'
    ? (storageEvent.payload as Record<string, unknown>).code
    : null
  const storageMessage = storageEvent && storageEvent.payload && typeof storageEvent.payload === 'object'
    ? (storageEvent.payload as Record<string, unknown>).message
    : null
  const isRunning = !isTerminalRun(run.status)
  if (!isRunning && hasPersistedAssistant && activities.length === 0 && !storageEvent) return null
  return <div className="agent-live-run" aria-live="polite">
    <div className="agent-live-run-header"><span className={cn('agent-live-run-dot', isRunning ? 'agent-live-run-dot-active' : 'agent-live-run-dot-done')} /><strong>{isRunning ? '正在运行' : run.status === 'completed' ? '运行完成' : '运行记录'}</strong><span className="agent-live-run-runtime">{runtimeLabels[run.runtime]}</span>{activities.length > 0 ? <button aria-controls={`agent-steps-${run.id}`} aria-expanded={stepsExpanded} className="agent-live-steps-toggle" onClick={() => setStepsExpanded((current) => !current)} type="button">{stepsExpanded ? <ChevronDown aria-hidden="true" className="size-3.5" /> : <ChevronRight aria-hidden="true" className="size-3.5" />}<span>查看步骤</span><span className="agent-live-steps-count">{activities.length}</span></button> : null}</div>
    {activities.length > 0 && !stepsExpanded ? <p className="agent-live-steps-summary">{isRunning ? '工具正在运行中，' : '工具调用已完成，'}点击“查看步骤”展开运行明细。</p> : null}
    {activities.length > 0 && stepsExpanded ? <div className="agent-live-activities" id={`agent-steps-${run.id}`}>{activities.slice(-24).map((event) => { const key = toolActivityKey(event); const expanded = expandedStep === key; return <div className={cn('agent-live-activity', expanded && 'agent-live-activity-expanded')} key={key}><button aria-expanded={expanded} className="agent-live-activity-toggle" onClick={() => setExpandedStep(expanded ? null : key)} type="button"><Wrench aria-hidden="true" className="size-3.5" /><span>{eventLabel(event)}</span><span className="agent-live-activity-state">{toolActivityState(event)}</span>{expanded ? <ChevronDown aria-hidden="true" className="size-3" /> : <ChevronRight aria-hidden="true" className="size-3" />}</button>{expanded ? <pre className="agent-live-activity-detail">{safeEventDetail(event.payload)}</pre> : null}</div> })}</div> : null}
    {storageEvent && typeof storageMessage === 'string' ? <p className={cn('agent-live-storage-note', storageCode === 'OBSIDIAN_DAILY_NOTE_WRITTEN' ? 'agent-live-storage-note-success' : 'agent-live-storage-note-warning')}>{safeDisplayContent(storageMessage)}</p> : null}
    {streamText && (!hasPersistedAssistant || isRunning) ? <p className="agent-live-text">{safeDisplayContent(streamText)}{isRunning ? <span className="agent-stream-cursor" aria-hidden="true" /> : null}</p> : null}
    {isRunning && !streamText && activities.length === 0 ? <p className="agent-live-placeholder">Agent 正在准备上下文…</p> : null}
  </div>
}

/**
 * Keep bulk archive usable while an already-open packaged renderer is paired
 * with an older preload. New preloads use the transactional bulk endpoint;
 * older ones only expose the revision-checked single-item operation.
 */
async function archiveConversationItems(items: AgentConversationArchiveItem[]): Promise<void> {
  const conversations = getWorkbenchAgentApi().conversations
  const archiveBulk = conversations.archiveBulk as ((items: AgentConversationArchiveItem[]) => Promise<void>) | undefined
  if (typeof archiveBulk === 'function') {
    await archiveBulk(items)
    return
  }
  for (const item of items) await conversations.archive(item.conversationId, item.expectedRevision)
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

function extractEventText(payload: unknown, depth = 0): string {
  if (depth > 4) return ''
  if (typeof payload === 'string') return payload
  if (!payload || typeof payload !== 'object') return ''
  if (Array.isArray(payload)) return payload.map((item) => extractEventText(item, depth + 1)).filter(Boolean).join('')
  const record = payload as Record<string, unknown>
  for (const key of ['delta', 'text_delta', 'text', 'output']) if (typeof record[key] === 'string') return record[key] as string
  if (typeof record.content === 'string') return record.content
  if (Array.isArray(record.content)) return record.content.map((item) => extractEventText(item, depth + 1)).filter(Boolean).join('')
  for (const key of ['assistantMessageEvent', 'event', 'item', 'message', 'data', 'result']) {
    const nested = extractEventText(record[key], depth + 1)
    if (nested) return nested
  }
  return ''
}

/** Normalize the two stream shapes used by Codex/Pi. Some versions emit
 * deltas, while others periodically emit the complete accumulated message;
 * blindly concatenating both is what made assistant text appear twice. */
function streamAssistantText(events: AgentEventRecord[]): string {
  let text = ''
  for (const event of events) {
    if (!(event.kind === 'assistant_message' || (event.kind === 'progress' && looksLikeAssistantEvent(event.payload)))) continue
    const chunk = extractEventText(event.payload)
    if (!chunk) continue
    const record = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : null
    const nested = record?.assistantMessageEvent && typeof record.assistantMessageEvent === 'object'
      ? record.assistantMessageEvent as Record<string, unknown>
      : null
    const isDelta = typeof record?.delta === 'string' || typeof record?.text_delta === 'string' || typeof record?.partial === 'string' || typeof nested?.delta === 'string' || nested?.type === 'text_delta'
    if (isDelta) {
      text += chunk
      continue
    }
    if (!text) {
      text = chunk
    } else if (chunk.startsWith(text)) {
      text = chunk
    } else if (!text.endsWith(chunk)) {
      text += chunk
    }
  }
  return text
}

function looksLikeToolEvent(payload: unknown, depth = 0): boolean {
  if (!payload || typeof payload !== 'object' || depth > 4) return false
  const record = payload as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''
  if (/tool|function|command_execution|mcp_tool|tool_use/iu.test(type)) return true
  return ['assistantMessageEvent', 'event', 'item', 'message', 'data', 'result'].some((key) => looksLikeToolEvent(record[key], depth + 1))
}

function looksLikeAssistantEvent(payload: unknown, depth = 0): boolean {
  if (!payload || typeof payload !== 'object' || depth > 4) return false
  const record = payload as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''
  if (/error|diagnostic|turn\.(started|completed)|thread\.started/iu.test(type)) return false
  if (/agent_message|assistant_message|text_delta|text_end/iu.test(type)) return true
  if (typeof record.delta === 'string' || typeof record.text === 'string') return true
  return ['assistantMessageEvent', 'event', 'item', 'message', 'data', 'result'].some((key) => looksLikeAssistantEvent(record[key], depth + 1))
}

function dedupeToolActivities(events: AgentEventRecord[]): AgentEventRecord[] {
  const latest = new Map<string, AgentEventRecord>()
  for (const event of events) latest.set(toolActivityKey(event), event)
  return [...latest.values()]
}

function toolActivityKey(event: AgentEventRecord): string {
  const item = nestedEventRecord(event.payload, 'item')
  return typeof item?.id === 'string' ? item.id : eventLabel(event)
}

function toolActivityState(event: AgentEventRecord): string {
  const item = nestedEventRecord(event.payload, 'item')
  const status = typeof item?.status === 'string' ? item.status : ''
  if (/failed|error/iu.test(status)) return '失败'
  if (/completed|succeeded|success/iu.test(status)) return '完成'
  if (/progress|running|in_progress/iu.test(status)) return '进行中'
  return event.kind === 'tool_call' ? '调用' : '步骤'
}

function nestedEventRecord(payload: unknown, key: string): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null
  const value = (payload as Record<string, unknown>)[key]
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function eventLabel(event: AgentEventRecord): string {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : null
  const nested = payload?.item && typeof payload.item === 'object' ? payload.item as Record<string, unknown> : null
  const type = typeof nested?.type === 'string' ? nested.type : typeof payload?.type === 'string' ? payload.type : event.kind
  const command = typeof nested?.command === 'string' ? nested.command : typeof payload?.command === 'string' ? payload.command : null
  return command ? `${type}: ${command}`.slice(0, 180) : type.replace(/[_.-]+/gu, ' ').replace(/\b\w/gu, (value) => value.toUpperCase())
}

function safeEventDetail(payload: unknown): string {
  try {
    const text = JSON.stringify(payload, (_key, value) => {
      if (typeof value !== 'string') return value
      return value.replace(/(Bearer\s+)[^\s]+/giu, '$1[redacted]').replace(/([A-Za-z]:[\\/][^\s"']+)/gu, '[path redacted]').slice(0, 4_000)
    }, 2)
    return text?.slice(0, 8_000) ?? ''
  } catch { return '[detail unavailable]' }
}

function safeDisplayContent(content: string): string {
  const normalized = content.trim()
  if (/return exactly acceptance_redaction_restart_ok/i.test(normalized)) return '这条运行记录已被安全过滤。请重新发送任务以继续。'
  if (/no api key found|missing bearer|401 unauthorized|authentication required|not authenticated|login required|logged out/i.test(normalized)) return '运行未完成：本机 Agent CLI 尚未完成登录，请在设置中点击“探测”确认登录状态后重试。'
  if (/reconnecting|request timed out|connection failed|falling back from websockets|waiting for network/i.test(normalized)) return '运行未完成：Agent runtime 连接超时或网络不可用，请检查凭据与网络后重试。'
  if (/not inside a trusted directory|invalidargument|cannot process argument|codex\.ps1/i.test(normalized)) return '运行未完成：当前工作目录尚未被 runtime 信任，请在设置中检查工作目录后重试。'
  return content
}

function safeDisplayTitle(title: string): string {
  if (/return exactly acceptance_redaction_restart_ok|no api key found|missing bearer|401 unauthorized|not authenticated/i.test(title)) return '已过滤的 Agent 运行记录'
  return title
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

function formatMessageTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
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
