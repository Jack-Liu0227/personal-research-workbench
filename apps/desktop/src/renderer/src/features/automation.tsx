import { CalendarClock, CheckCircle2, CirclePause, Pencil, Play, Plus, RefreshCw, Trash2, Workflow } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AgentConversation, AgentPermissionMode, AgentResponseLanguage, AgentRunStatus, AgentRuntimeKind, AgentScheduleSkillCatalogEntry, ArchiveBulkResult, AutomationRule, AutomationRunHistoryEntry, Project, ScheduleOccurrenceSource, ScheduleOccurrenceStatus } from '@prw/contracts'
import {
  AGENT_SCHEDULE_OUTPUT_FOLDER_OPTIONS,
  AGENT_SCHEDULE_SKILL_CATALOG,
  AGENT_SCHEDULE_SKILL_KEYS,
  DEFAULT_DAILY_PUSH_SCHEDULE_INPUT,
  ProjectIdSchema,
  inspectAgentOutputFolder
} from '@prw/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Field, Input, Textarea } from '../components/ui'
import { ArchiveReceiptList, SelectionBar, SelectionCheckbox } from '../components/selection'
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/states'
import { cn } from '../lib/utils'
import { getWorkbenchAgentApi } from '../lib/workbench'
import { useAutomationRunHistoryQuery } from './queries'

const runtimeLabels: Record<AgentRuntimeKind, string> = { codex: 'Codex', pi: 'Pi' }
const runtimeDefaults: Record<AgentRuntimeKind, string> = { codex: '', pi: '' }
const frequencyLabels = { manual: '手动', hourly: '每小时', daily: '每天', weekdays: '工作日', weekly: '每周', custom: '自定义 Cron' } as const

/** One scheduled run's terminal status; the schedule card only needs a compact label. */
const runStatusLabels: Record<AgentRunStatus, string> = { planned: '已计划', queued: '排队中', running: '运行中', waiting_confirmation: '等待审批', completed: '完成', partial: '部分完成', failed: '失败', canceled: '已取消', blocked: '已阻断', missed: '错过时间点' }
const occurrenceStatusLabels: Record<ScheduleOccurrenceStatus, string> = { claimed: '时间点已认领', running: '时间点执行中', completed: '时间点完成', failed: '时间点失败', blocked: '时间点阻断', canceled: '时间点取消', missed: '时间点错过', skipped: '时间点跳过' }
const occurrenceSourceLabels: Record<ScheduleOccurrenceSource, string> = { scheduler: '定时触发', catchup: '启动补跑', manual: '手动触发' }
/** Statuses whose slot produced nothing usable and may be retried deliberately. */
const retryableRunStatuses = new Set<AgentRunStatus>(['failed', 'blocked', 'missed', 'canceled', 'partial'])

function runStatusTone(status: AgentRunStatus): string {
  if (status === 'completed') return 'research-status-positive'
  if (status === 'failed' || status === 'blocked') return 'research-status-negative'
  if (status === 'missed' || status === 'canceled' || status === 'partial') return 'research-status-warning'
  return 'research-status-active'
}

/** Obsidian delivery projection of one run: written path, or the concrete skip reason. */
function deliveryPrefix(entry: AutomationRunHistoryEntry): string {
  if (!entry.delivery) return 'Obsidian：未记录投递'
  if (entry.delivery.status === 'written') return `Obsidian：已写入 ${entry.delivery.relativePath ?? '（路径未记录）'}`
  return `Obsidian：已跳过（${entry.delivery.reason ?? entry.delivery.message ?? '未说明原因'}）`
}

/** Normalize the free-text source field into engine tokens (`--search` values).
 * The service lower-cases and de-duplicates again; this only keeps an obvious
 * typo (trailing comma, full-width comma, spaces) from being sent at all. */
function parseSourceList(value: string): string[] {
  return [...new Set(value.split(/[,，;；\s]+/u).map((part) => part.trim().toLocaleLowerCase()).filter((part) => part.length > 0))].slice(0, 24)
}
type Frequency = keyof typeof frequencyLabels
type ScheduleMode = 'new_conversation' | 'existing'
const responseLanguageLabels: Record<AgentResponseLanguage, string> = { 'zh-CN': '简体中文（默认）', en: 'English' }

/**
 * One selectable skill option with its *real* installed state.
 *
 * The frozen catalog owns the selectable keys; the main-side registry owns the
 * discovery result. A key that is reserved or whose canonical `SKILL.md` is
 * missing is labelled as not installed and carries the reason a run would be
 * blocked — the editor never renders it as an apparently usable skill.
 */
function skillSelectOptions(catalog: readonly AgentScheduleSkillCatalogEntry[] | undefined) {
  return AGENT_SCHEDULE_SKILL_KEYS.map((key) => {
    const option = AGENT_SCHEDULE_SKILL_CATALOG[key]
    const discovered = catalog?.find((entry) => entry.key === key)
    // Before the discovery RPC answers, fall back to the frozen contract: a
    // reserved key is not installed by definition, so the conservative label is
    // the honest one.
    const runnable = discovered ? discovered.runnable : option.availability === 'shipped'
    return {
      key,
      runnable,
      summary: option.summary,
      requiredInputs: option.requiredInputs,
      label: runnable ? option.label : `${option.label}（未安装，运行会被阻断）`,
      blockedReason: discovered?.blockedReason ?? (runnable ? '' : '未安装：运行会被阻断并记录 SKILL_NOT_INSTALLED。')
    }
  })
}

/** Requested-output-folder select value for "write somewhere else".
 * Presentation-only: both modes write the single `outputFolder` field. */
const customFolderOption = '__custom__'

export function AutomationPage({ projects }: { projects: Project[] }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [editing, setEditing] = useState<AutomationRule | null>(null)
  const [name, setName] = useState('每日科研摘要')
  const [cron, setCron] = useState('0 9 * * *')
  const [frequency, setFrequency] = useState<Frequency>('daily')
  const [runtime, setRuntime] = useState<AgentRuntimeKind>('codex')
  const [model, setModel] = useState(runtimeDefaults.codex)
  const [assistantKey, setAssistantKey] = useState('researcher')
  const [prompt, setPrompt] = useState('请根据项目中的最新文献生成一份可核验的研究摘要。')
  const [workspacePath, setWorkspacePath] = useState('')
  const [projectId, setProjectId] = useState('')
  const [mode, setMode] = useState<ScheduleMode>('new_conversation')
  const [conversationId, setConversationId] = useState<string | null>(null)
  // Every schedule field below is seeded from the frozen shared default, so a
  // newly-created rule cannot drift from the shipped daily-push contract
  // (skill=last30days, AI 最新资讯, zh-CN, 30 days, 每日资讯推送).
  const [skillKey, setSkillKey] = useState<string | null>(DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.skillKey)
  const [topic, setTopic] = useState<string>(DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.topic)
  // Requested engine sources, kept as free text here and normalized on save:
  // an empty value means "every source the engine reports as available", which
  // stays the safe default for an unattended push.
  const [sourcesText, setSourcesText] = useState(DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.sources.join(', '))
  const [lookbackDays, setLookbackDays] = useState<number>(DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.lookbackDays)
  const [responseLanguage, setResponseLanguage] = useState<AgentResponseLanguage>(DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.responseLanguage)
  const [outputFolder, setOutputFolder] = useState<string>(DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.outputFolder)  // The custom mode is presentation state, not a second field: both modes write
  // the same `outputFolder` value, and the same shared safety predicate checks
  // it before the RPC is sent.
  const [customFolder, setCustomFolder] = useState(false)
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>('read-only')

  const rules = useQuery({ queryKey: ['automation-rules'], queryFn: () => getWorkbenchAgentApi().automation.rules(), staleTime: 30_000, placeholderData: (previous) => previous })
  // Installed/not-installed state comes from the main-side registry, so the
  // editor can only offer a skill this build can actually resolve (or show it
  // as blocked, never as silently generic).
  const skills = useQuery({ queryKey: ['automation-skills'], queryFn: () => getWorkbenchAgentApi().automation.skills(), staleTime: 60_000, placeholderData: (previous) => previous })
  const conversations = useQuery({ queryKey: ['agent-conversations', 'automation'], queryFn: () => getWorkbenchAgentApi().conversations.list({ includeArchived: false, limit: 100 }), enabled: showForm, staleTime: 60_000, placeholderData: (previous) => previous })
  const connectors = useQuery({ queryKey: ['agent-connectors'], queryFn: () => getWorkbenchAgentApi().connectors.list(), enabled: showForm, staleTime: 60_000, refetchOnMount: false, placeholderData: (previous) => previous })
  // Recent scheduled runs of every rule: terminal status, the consumed
  // occurrence (including why a slot produced nothing) and the delivered
  // Artifact / Obsidian outcome. Read-only projection; retry goes through the
  // rule's own recorded permission and approval policy.
  const runHistory = useAutomationRunHistoryQuery()
  // --- RUN HISTORY record removal (selection lives on the loaded range) -----
  // The loaded range is the whole query result (no pagination, no filter) and
  // every rendered record owns a checkbox, so “全选” can never name a row the
  // user cannot see. Removal is a CAS-locked soft archive of the run *record*:
  // the rule, its occurrence cursor, the delivered Artifact, the Obsidian note
  // and every credential keep their state.
  const historyEntries = runHistory.data ?? []
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set())
  const [runReceipt, setRunReceipt] = useState<ArchiveBulkResult | null>(null)
  const [historyFeedback, setHistoryFeedback] = useState<string | null>(null)
  // A receipt's label has to survive the refetch that follows a removal, where
  // the archived record has left the list and its own label would be lost.
  const runReceiptLabels = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    setSelectedRunIds((current) => {
      if (current.size === 0) return current
      const next = new Set([...current].filter((id) => (runHistory.data ?? []).some((entry) => entry.runId === id)))
      return next.size === current.size ? current : next
    })
  }, [runHistory.data])
  const permissionOptions = connectors.data?.find((connector) => connector.runtime === runtime)?.permissionOptions ?? []
  const permissionSupported = permissionOptions.includes(permissionMode)
  const modelForRuntime = (kind: AgentRuntimeKind): string => connectors.data?.find((connector) => connector.runtime === kind)?.localDefaultModel || ''
  const effectiveModel = (): string | null => {
    const trimmed = model.trim()
    if (trimmed && trimmed !== runtimeDefaults[runtime]) return trimmed
    return connectors.data?.find((connector) => connector.runtime === runtime)?.localDefaultModel || null
  }

  // ---------------------------------------------------------------- gating --
  // One validation source feeds both the inline reason the editor renders and
  // the save gate, so the button can never write a rule the run path would
  // reject: a not-installed skill, an unsafe/empty output folder, a missing
  // skill-required input, or an unprobed permission mode.
  const skillOptions = skillSelectOptions(skills.data)
  const selectedSkill = skillOptions.find((option) => option.key === skillKey) ?? null
  const folderInspection = inspectAgentOutputFolder(outputFolder)
  const saveBlockedReasons: string[] = []
  if (selectedSkill && !selectedSkill.runnable) saveBlockedReasons.push(selectedSkill.blockedReason)
  if (!folderInspection.ok) saveBlockedReasons.push(folderInspection.message)
  if (selectedSkill && selectedSkill.requiredInputs.includes('topic') && topic.trim().length === 0) saveBlockedReasons.push(`所选 skill（${selectedSkill.key}）把研究主题列为必填输入；请填写主题后再保存。`)
  if (!permissionSupported) saveBlockedReasons.push('请先探测 CLI 并选择支持的权限模式。')
  const saveBlockedReason = saveBlockedReasons[0] ?? ''

  const saveMutation = useMutation({
    // The folder value written here is the *inspected* one: the same shared
    // predicate the contract and the service apply, so an unsafe directory is
    // rejected in the renderer instead of being silently replaced by a default.
    mutationFn: () => getWorkbenchAgentApi().automation.save({ id: editing?.id, name: name.trim(), workflowKey: 'daily_digest', runtime, model: effectiveModel(), assistantKey: assistantKey.trim() || 'researcher', workspacePath: workspacePath.trim() || null, frequency, executionMode: mode, conversationId: mode === 'existing' ? conversationId : null, prompt: prompt.trim(), skillKey, topic: topic.trim(), sources: parseSourceList(sourcesText), lookbackDays, responseLanguage, outputFolder: folderInspection.ok ? folderInspection.folder : outputFolder.trim(), permissionMode, approvalPolicy: permissionMode === 'full-access' ? 'never' : 'on-request', projectId: projectId ? ProjectIdSchema.parse(projectId) : null, cron: cron.trim(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai', enabled: editing?.enabled ?? true, expectedRevision: editing?.revision ?? null }),
    onSuccess: () => { setFeedback('定时任务已保存；仅在应用运行时执行。'); closeForm(); void queryClient.invalidateQueries({ queryKey: ['automation-rules'] }) },
    onError: (error) => setFeedback(error instanceof Error ? error.message : '定时任务保存失败。')
  })
  const toggleMutation = useMutation({
    // Pausing only flips `enabled`; every stored push field is passed through
    // verbatim so a toggle can never rewrite a user's topic/folder.
    mutationFn: (rule: AutomationRule) => getWorkbenchAgentApi().automation.save({ id: rule.id, name: rule.name, workflowKey: rule.workflowKey, runtime: rule.runtime, model: rule.model, assistantKey: rule.assistantKey, workspacePath: rule.workspacePath, frequency: rule.frequency, executionMode: rule.executionMode, conversationId: rule.conversationId, prompt: rule.prompt, skillKey: rule.skillKey, topic: rule.topic, sources: rule.sources, lookbackDays: rule.lookbackDays, responseLanguage: rule.responseLanguage, outputFolder: rule.outputFolder, permissionMode: rule.permissionMode, approvalPolicy: rule.approvalPolicy, projectId: rule.projectId, cron: rule.cron, timezone: rule.timezone, enabled: !rule.enabled, expectedRevision: rule.revision }),
    onSuccess: () => { setFeedback('定时任务状态已更新。'); void queryClient.invalidateQueries({ queryKey: ['automation-rules'] }) },
    onError: (error) => setFeedback(error instanceof Error ? error.message : '定时任务状态更新失败。')
  })

  /** Re-seed every push field from the frozen shared default. */
  const seedPushDefaults = () => {
    setSkillKey(DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.skillKey)
    setTopic(DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.topic)
    setSourcesText(DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.sources.join(', '))
    setLookbackDays(DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.lookbackDays)
    setResponseLanguage(DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.responseLanguage)
    setOutputFolder(DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.outputFolder)
    setCustomFolder(false)
  }
  const resetForm = () => {
    seedPushDefaults(); setPermissionMode('read-only')
    setEditing(null); setName('每日科研摘要'); setCron('0 9 * * *'); setFrequency('daily'); setRuntime('codex'); setModel(modelForRuntime('codex')); setAssistantKey('researcher'); setPrompt('请根据项目中的最新文献生成一份可核验的研究摘要。'); setWorkspacePath(''); setProjectId(''); setMode('new_conversation'); setConversationId(null); setShowForm(true)
  }
  const closeForm = () => { setShowForm(false); setEditing(null) }
  const editRule = (rule: AutomationRule) => {
    // Read every stored field back verbatim: a rule saved by an older build (or
    // by the seeded default) must reopen with exactly what the card shows.
    const storedFolder = rule.outputFolder || DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.outputFolder
    setSkillKey(rule.skillKey ?? null); setTopic(rule.topic ?? ''); setSourcesText((rule.sources ?? []).join(', ')); setLookbackDays(rule.lookbackDays || DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.lookbackDays); setResponseLanguage(rule.responseLanguage ?? DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.responseLanguage); setOutputFolder(storedFolder)
    // A stored folder outside the built-in list reopens as custom input so the
    // select can never silently rewrite it to a different directory.
    setCustomFolder(!AGENT_SCHEDULE_OUTPUT_FOLDER_OPTIONS.includes(storedFolder))
    setPermissionMode(rule.permissionMode ?? 'read-only')
    setEditing(rule); setName(rule.name); setCron(rule.cron); setFrequency(rule.frequency); setRuntime(rule.runtime ?? 'codex'); setModel(rule.model ?? runtimeDefaults[rule.runtime ?? 'codex']); setAssistantKey(rule.assistantKey ?? 'researcher'); setPrompt(rule.prompt); setWorkspacePath(rule.workspacePath ?? ''); setProjectId(rule.projectId ?? ''); setMode(rule.executionMode); setConversationId(rule.conversationId); setShowForm(true)
  }
  const updateFrequency = (value: Frequency) => { setFrequency(value); if (value === 'hourly') setCron('0 * * * *'); else if (value === 'daily') setCron('0 9 * * *'); else if (value === 'weekdays') setCron('0 9 * * 1-5'); else if (value === 'weekly') setCron('0 9 * * 1') }
  const archive = (rule: AutomationRule) => {
    if (!window.confirm(`确认归档“${rule.name}”？归档后不会再自动运行。`)) return
    void getWorkbenchAgentApi().automation.archive(rule.id, rule.revision).then(() => { setFeedback('定时任务已归档。'); void queryClient.invalidateQueries({ queryKey: ['automation-rules'] }) }).catch((error: unknown) => setFeedback(error instanceof Error ? error.message : '定时任务归档失败。'))
  }
  const runNow = (rule: AutomationRule) => { void getWorkbenchAgentApi().automation.runNow(rule.id).then(() => { setFeedback('定时任务已立即触发。'); void queryClient.invalidateQueries({ queryKey: ['automation-run-history'] }) }).catch((error: unknown) => setFeedback(error instanceof Error ? error.message : '定时任务触发失败。')) }
  const retryMutation = useMutation({
    mutationFn: (runId: string) => getWorkbenchAgentApi().automation.retryRun(runId),
    onSuccess: () => { setFeedback('已按该规则记录的权限与审批策略重新运行。'); void queryClient.invalidateQueries({ queryKey: ['automation-run-history'] }); void queryClient.invalidateQueries({ queryKey: ['automation-rules'] }) },
    onError: (error) => setFeedback(error instanceof Error ? error.message : '定时任务重试失败。')
  })
  const ruleName = (scheduleId: string): string => (rules.data ?? []).find((rule) => rule.id === scheduleId)?.name ?? '已归档任务'
  /** One run record as the list (and the delete confirmations) name it. */
  const describeRun = (entry: AutomationRunHistoryEntry): string => `${ruleName(entry.scheduleId)} · ${new Date(entry.occurrenceAt ?? entry.startedAt).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })} · ${runStatusLabels[entry.status]}`
  const describeRunReceipt = (id: string): string => {
    const entry = historyEntries.find((candidate) => candidate.runId === id)
    return entry ? describeRun(entry) : runReceiptLabels.current.get(id) ?? '该运行记录（已不在当前列表）'
  }
  const selectedRuns = historyEntries.filter((entry) => selectedRunIds.has(entry.runId))
  const toggleRunSelection = (runId: string, checked: boolean): void => {
    setSelectedRunIds((current) => {
      const next = new Set(current)
      if (checked) next.add(runId)
      else next.delete(runId)
      return next
    })
  }
  const archiveRunMutation = useMutation({
    mutationFn: (entry: AutomationRunHistoryEntry) => getWorkbenchAgentApi().automation.archiveRun(entry.runId, entry.revision),
    onSuccess: async (_value, entry) => {
      setRunReceipt(null)
      setHistoryFeedback(`已删除运行记录“${describeRun(entry)}”；该记录已从列表移除（本机审计行保留），定时规则、时间点游标、Artifact 与 Obsidian 投递内容均未改动。`)
      await queryClient.invalidateQueries({ queryKey: ['automation-run-history'] })
    },
    onError: (error) => { setRunReceipt(null); setHistoryFeedback(error instanceof Error ? error.message : '运行记录删除失败。') }
  })
  const archiveRunsMutation = useMutation({
    mutationFn: (locks: { id: string; expectedRevision: number }[]) => getWorkbenchAgentApi().automation.bulkArchiveRuns({ items: locks }),
    onSuccess: async (result) => {
      setRunReceipt(result)
      setHistoryFeedback(result.conflict > 0 || result.failed > 0 ? '部分运行记录未删除：修订冲突或失败的记录保持原状，请刷新列表后重试。' : `已删除 ${result.succeeded} 条运行记录（跳过 ${result.skipped} 条）。`)
      setSelectedRunIds(new Set())
      await queryClient.invalidateQueries({ queryKey: ['automation-run-history'] })
    },
    onError: (error) => { setRunReceipt(null); setHistoryFeedback(error instanceof Error ? error.message : '运行记录批量删除失败。') }
  })
  const archiveRun = (entry: AutomationRunHistoryEntry): void => {
    if (archiveRunMutation.isPending || archiveRunsMutation.isPending) return
    const confirmed = window.confirm(`删除运行记录“${describeRun(entry)}”？该记录会从 RUN HISTORY 列表移除，本机数据库中的审计行保留；定时规则、时间点游标、Artifact 与 Obsidian 笔记都不会被改动。`)
    if (!confirmed) return
    setHistoryFeedback(null)
    archiveRunMutation.mutate(entry)
  }
  const archiveSelectedRuns = (): void => {
    if (archiveRunsMutation.isPending || archiveRunMutation.isPending) return
    if (selectedRuns.length === 0) return
    const labels = selectedRuns.map((entry) => describeRun(entry)).join('、')
    const confirmed = window.confirm([
      `将删除选中的 ${selectedRuns.length} 条运行记录（当前加载 ${historyEntries.length} 条）：${labels}。`,
      '删除范围仅限 RUN HISTORY 当前加载的运行记录；本机数据库保留审计行，定时规则、时间点（occurrence）游标、Artifact 正文、Obsidian 笔记、凭据与外部数据都不会被改动。',
      '其中已被其他操作更新过的记录（例如刚结束的运行）会以“修订冲突”逐条回报且不会被写入。确认继续？'
    ].join('\n'))
    if (!confirmed) return
    runReceiptLabels.current = new Map(selectedRuns.map((entry) => [entry.runId, describeRun(entry)]))
    setHistoryFeedback(null)
    archiveRunsMutation.mutate(selectedRuns.map((entry) => ({ id: entry.runId, expectedRevision: entry.revision })))
  }

  return <div className="page-scroll">
    <PageHeader actions={<Button onClick={resetForm} size="sm" variant="primary"><Plus aria-hidden="true" className="size-3.5" />新建定时任务</Button>} description="管理由 Codex 或 Pi 执行的定时研究任务。任务仅在应用运行时调度，权限依据所选 CLI 的能力配置。" eyebrow="AUTOMATION / SCHEDULES" title="定时任务" />
    {feedback ? <p aria-live="polite" className="form-feedback form-feedback-success mt-3" role="status">{feedback}</p> : null}
    {showForm ? <ScheduleEditor assistantKey={assistantKey} blockedReason={saveBlockedReason} conversations={conversations.data ?? []} conversationId={conversationId} cron={cron} customFolder={customFolder} editing={editing} frequency={frequency} lookbackDays={lookbackDays} mode={mode} model={model} name={name} onCancel={closeForm} onChangeAssistant={setAssistantKey} onChangeConversation={setConversationId} onChangeCron={setCron} onChangeCustomFolder={setCustomFolder} onChangeFrequency={updateFrequency} onChangeLookbackDays={setLookbackDays} onChangeMode={setMode} onChangeModel={setModel} onChangeName={setName} onChangeOutputFolder={setOutputFolder} onChangePermissionMode={setPermissionMode} onChangeProject={setProjectId} onChangePrompt={setPrompt} onChangeResponseLanguage={setResponseLanguage} onChangeRuntime={(value) => { setRuntime(value); setModel(modelForRuntime(value)) }} onChangeSkill={setSkillKey} onChangeSources={setSourcesText} onChangeTopic={setTopic} onChangeWorkspace={setWorkspacePath} onSave={() => { if (saveBlockedReason) { setFeedback(saveBlockedReason); return }; saveMutation.mutate() }} outputFolder={outputFolder} permissionMode={permissionMode} permissionOptions={connectors.data?.find((connector) => connector.runtime === runtime)?.permissionOptions ?? []} projectId={projectId} projects={projects} prompt={prompt} responseLanguage={responseLanguage} runtime={runtime} saving={saveMutation.isPending} skillKey={skillKey} skillOptions={skillOptions} sourcesText={sourcesText} topic={topic} workspacePath={workspacePath} /> : null}
    <section className="research-panel mt-4" aria-labelledby="schedule-list-title"><div className="research-panel-header"><div><p className="instrument-label">RUNTIME SCHEDULE</p><h2 id="schedule-list-title" className="text-base font-bold text-foreground">已配置任务</h2></div><span className="research-tag">{(rules.data ?? []).length} 个任务</span></div>{rules.isLoading ? <LoadingState label="正在读取定时任务…" /> : rules.error ? <ErrorState error={rules.error} onRetry={() => void rules.refetch()} /> : (rules.data ?? []).length === 0 ? <EmptyState title="还没有定时任务" description="创建每日摘要、文献检索或项目进度提醒，选择 Codex 或 Pi 作为执行 runtime。" action={<Button onClick={resetForm} size="sm" variant="secondary"><Plus aria-hidden="true" className="size-3.5" />新建任务</Button>} /> : <div className="schedule-list">{(rules.data ?? []).map(rule => <ScheduleCard key={rule.id} onArchive={() => archive(rule)} onEdit={() => editRule(rule)} onRunNow={() => runNow(rule)} onToggle={() => toggleMutation.mutate(rule)} rule={rule} />)}</div>}</section>
    <div className="agent-rail-note mt-3"><CalendarClock aria-hidden="true" className="size-3.5" /><span>调度依赖应用进程；关闭应用期间不会后台执行。重新打开时每日任务最多补跑一次错过的时间点，其余等待下一个 09:00（可随时暂停/启用）。</span></div>
    <section className="research-panel mt-4" aria-labelledby="schedule-history-title">
      <div className="research-panel-header"><div><p className="instrument-label">RUN HISTORY</p><h2 className="text-base font-bold text-foreground" id="schedule-history-title">最近运行</h2></div><span className="research-tag">{historyEntries.length} 条</span></div>
      {runHistory.isLoading ? <LoadingState label="正在读取运行记录…" /> : runHistory.error ? <ErrorState error={runHistory.error} onRetry={() => void runHistory.refetch()} /> : historyEntries.length === 0 ? <p className="m-4 text-xs leading-5 text-muted-foreground">尚无定时运行记录；每次到点触发、启动补跑或立即运行都会在这里记录状态、阻断原因和 Artifact/Obsidian 投递结果。</p> : <>
        <div className="px-3 pt-3">
          <SelectionBar
            allSelected={selectedRuns.length > 0 && selectedRuns.length === historyEntries.length}
            className="selection-bar-compact"
            disabled={historyEntries.length === 0}
            indeterminate={selectedRuns.length > 0 && selectedRuns.length < historyEntries.length}
            label="运行记录批量操作"
            onClear={() => setSelectedRunIds(new Set())}
            onToggleAll={(checked) => setSelectedRunIds(checked ? new Set(historyEntries.map((entry) => entry.runId)) : new Set())}
            scope={`全选仅覆盖 RUN HISTORY 当前加载的 ${historyEntries.length} 条运行记录（无分页、无筛选；不含定时规则与 Artifact）`}
            selectAllLabel="全选当前加载的运行记录"
            selectedCount={selectedRuns.length}
            totalCount={historyEntries.length}
          >
            <Button
              aria-label={`删除选中的 ${selectedRuns.length} 条运行记录`}
              disabled={selectedRuns.length === 0 || archiveRunMutation.isPending}
              loading={archiveRunsMutation.isPending}
              onClick={archiveSelectedRuns}
              size="sm"
              variant="secondary"
            ><Trash2 aria-hidden="true" className="size-3.5" />删除选中</Button>
          </SelectionBar>
        </div>
        {historyFeedback ? <p aria-live="polite" className={runReceipt && (runReceipt.conflict > 0 || runReceipt.failed > 0) ? 'form-feedback form-feedback-error mx-3 mt-2' : 'form-feedback form-feedback-success mx-3 mt-2'} role="status">{historyFeedback}</p> : null}
        {runReceipt ? <ArchiveReceiptList className="m-3" describe={describeRunReceipt} result={runReceipt} succeededVerb="已删除" /> : null}
        <ul className="grid list-none gap-1 p-2">
          {historyEntries.map((entry) => <li className="rounded-lg border border-border bg-surface px-3 py-2" key={entry.runId}>
            <div className="flex flex-wrap items-center gap-2">
              <SelectionCheckbox ariaLabel={`选择运行记录：${describeRun(entry)}`} checked={selectedRunIds.has(entry.runId)} onChange={(checked) => toggleRunSelection(entry.runId, checked)} title={`选择运行记录：${describeRun(entry)}`} />
              <strong className="text-xs font-bold text-foreground">{ruleName(entry.scheduleId)}</strong>
              <span className={cn('research-status', runStatusTone(entry.status))}>{runStatusLabels[entry.status]}</span>
              {entry.occurrenceStatus ? <span className="research-tag">{occurrenceStatusLabels[entry.occurrenceStatus]}{entry.occurrenceSource ? ` · ${occurrenceSourceLabels[entry.occurrenceSource]}` : ''}</span> : null}
              <span className="text-[11px] text-muted-foreground">{new Date(entry.occurrenceAt ?? entry.startedAt).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })}</span>
              <div className="ml-auto flex items-center gap-2">
                {retryableRunStatuses.has(entry.status) ? <Button aria-label={`重试运行 ${ruleName(entry.scheduleId)}`} loading={retryMutation.isPending && retryMutation.variables === entry.runId} onClick={() => retryMutation.mutate(entry.runId)} size="sm" variant="secondary"><RefreshCw aria-hidden="true" className="size-3" />重试</Button> : null}
                <Button aria-label={`删除运行记录：${describeRun(entry)}`} disabled={archiveRunsMutation.isPending} loading={archiveRunMutation.isPending && archiveRunMutation.variables?.runId === entry.runId} onClick={() => archiveRun(entry)} size="sm" variant="secondary"><Trash2 aria-hidden="true" className="size-3" />删除</Button>
              </div>
            </div>
            {entry.blockedReason ? <p className="mt-1 text-xs text-muted-foreground">阻断/失败原因：{entry.blockedReason}</p> : null}
            <p className="mt-1 text-xs text-muted-foreground">Artifact：{entry.artifact ? entry.artifact.title : '未生成'}</p>
            <p className="mt-1 text-xs text-muted-foreground">{deliveryPrefix(entry)}</p>
          </li>)}
        </ul>
      </>}
    </section>
  </div>
}

/** One selectable skill as the editor sees it (see `skillSelectOptions`). */
type SkillSelectOption = ReturnType<typeof skillSelectOptions>[number]

function ScheduleEditor({ projects, conversations, editing, skillOptions, name, runtime, model, assistantKey, workspacePath, frequency, cron, mode, prompt, projectId, conversationId, saving, skillKey, topic, sourcesText, lookbackDays, responseLanguage, outputFolder, customFolder, permissionMode, permissionOptions, blockedReason, onCancel, onSave, onChangeName, onChangeRuntime, onChangeModel, onChangeAssistant, onChangeWorkspace, onChangeFrequency, onChangeCron, onChangeMode, onChangePrompt, onChangeProject, onChangeConversation, onChangeSkill, onChangeTopic, onChangeSources, onChangeLookbackDays, onChangeResponseLanguage, onChangeOutputFolder, onChangeCustomFolder, onChangePermissionMode }: {
  projects: Project[]
  conversations: AgentConversation[]
  editing: AutomationRule | null
  skillOptions: readonly SkillSelectOption[]
  name: string
  runtime: AgentRuntimeKind
  model: string
  assistantKey: string
  workspacePath: string
  frequency: Frequency
  cron: string
  mode: ScheduleMode
  prompt: string
  projectId: string
  conversationId: string | null
  saving: boolean
  skillKey: string | null
  topic: string
  sourcesText: string
  lookbackDays: number
  responseLanguage: AgentResponseLanguage
  outputFolder: string
  customFolder: boolean
  permissionMode: AgentPermissionMode
  permissionOptions: AgentPermissionMode[]
  /** First concrete reason this schedule cannot be saved; `''` when it can. */
  blockedReason: string
  onCancel: () => void
  onSave: () => void
  onChangeName: (value: string) => void
  onChangeRuntime: (value: AgentRuntimeKind) => void
  onChangeModel: (value: string) => void
  onChangeAssistant: (value: string) => void
  onChangeWorkspace: (value: string) => void
  onChangeFrequency: (value: Frequency) => void
  onChangeCron: (value: string) => void
  onChangeMode: (value: ScheduleMode) => void
  onChangePrompt: (value: string) => void
  onChangeProject: (value: string) => void
  onChangeConversation: (value: string | null) => void
  onChangeSkill: (value: string | null) => void
  onChangeTopic: (value: string) => void
  onChangeSources: (value: string) => void
  onChangeLookbackDays: (value: number) => void
  onChangeResponseLanguage: (value: AgentResponseLanguage) => void
  onChangeOutputFolder: (value: string) => void
  onChangeCustomFolder: (value: boolean) => void
  onChangePermissionMode: (value: AgentPermissionMode) => void
}): React.JSX.Element {
  const selectedSkill = skillOptions.find((option) => option.key === skillKey) ?? null
  const folderInspection = inspectAgentOutputFolder(outputFolder)
  const permissionSupported = permissionOptions.includes(permissionMode)
  // The custom mode is presentation state, not a second field: the select and
  // the text input write the same `outputFolder`, and a stored folder outside
  // the built-in list is treated as custom so reopening a rule never rewrites it.
  const customFolderMode = customFolder || !AGENT_SCHEDULE_OUTPUT_FOLDER_OPTIONS.includes(outputFolder)
  return <form className="research-panel schedule-editor mt-4" onSubmit={(event) => { event.preventDefault(); onSave() }}>
    <div className="research-panel-header">
      <div>
        <p className="instrument-label">{editing ? 'EDIT SCHEDULE' : 'NEW SCHEDULE'}</p>
        <h2 className="text-base font-bold text-foreground">{editing ? '编辑定时任务' : '新建定时任务'}</h2>
      </div>
      <span className="research-tag">内置默认 09:00 · Asia/Shanghai</span>
      <Button onClick={onCancel} size="sm" type="button" variant="ghost">取消</Button>
    </div>
    <div className="settings-form-grid">
      <label>任务名称<Input onChange={(event) => onChangeName(event.target.value)} value={name} /></label>
      <label>Agent runtime<select className="select-control" onChange={(event) => onChangeRuntime(event.target.value as AgentRuntimeKind)} value={runtime}><option value="codex">Codex</option><option value="pi">Pi</option></select></label>
      <label>模型<Input onChange={(event) => onChangeModel(event.target.value)} placeholder={runtimeDefaults[runtime]} value={model} /></label>
      <label>助手<Input onChange={(event) => onChangeAssistant(event.target.value)} value={assistantKey} /></label>
      <label>频率<select className="select-control" onChange={(event) => onChangeFrequency(event.target.value as Frequency)} value={frequency}>{Object.entries(frequencyLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>Cron<Input className="font-mono text-xs" onChange={(event) => onChangeCron(event.target.value)} value={cron} /></label>
      <label>项目<select className="select-control" onChange={(event) => onChangeProject(event.target.value)} value={projectId}><option value="">全部项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label>执行模式<select className="select-control" onChange={(event) => onChangeMode(event.target.value as ScheduleMode)} value={mode}><option value="new_conversation">每次新会话</option><option disabled={conversations.length === 0} value="existing">追加到已有会话</option></select></label>
    </div>
    <div className="settings-form-grid mt-3" data-testid="schedule-skill-inputs">
      <Field hint={selectedSkill ? selectedSkill.summary : '未选择 skill 时按内置 daily_digest 工作流运行。'} htmlFor="schedule-skill" label="技能">
        <select className="select-control" disabled={skillOptions.length === 0} id="schedule-skill" onChange={(event) => onChangeSkill(event.target.value || null)} value={skillKey ?? ''}>
          <option value="">内置工作流（不使用 skill）</option>
          {skillOptions.map((option) => <option disabled={!option.runnable} key={option.key} value={option.key}>{option.label}</option>)}
        </select>
      </Field>
      <Field error={selectedSkill && selectedSkill.requiredInputs.includes('topic') && topic.trim().length === 0 ? '所选 skill 把研究主题列为必填输入。' : undefined} hint="默认 AI 最新资讯；主题会随规则持久化并注入最终 prompt。" htmlFor="schedule-topic" label="研究主题">
        <Input id="schedule-topic" onChange={(event) => onChangeTopic(event.target.value)} placeholder="例如：AI 最新资讯" value={topic} />
      </Field>
      <Field hint="仅决定叙述语言；来源名、原文标题、必要引语和 URL 始终保留原样。" htmlFor="schedule-language" label="回复语言">
        <select className="select-control" id="schedule-language" onChange={(event) => onChangeResponseLanguage(event.target.value as AgentResponseLanguage)} value={responseLanguage}>
          {(Object.keys(responseLanguageLabels) as AgentResponseLanguage[]).map((language) => <option key={language} value={language}>{responseLanguageLabels[language]}</option>)}
        </select>
      </Field>
      <Field hint="引擎 --search 值；留空＝引擎报告的全部可用来源。" htmlFor="schedule-sources" label="来源（逗号分隔，留空＝全部可用）">
        <Input id="schedule-sources" onChange={(event) => onChangeSources(event.target.value)} placeholder="reddit, hackernews, github" value={sourcesText} />
      </Field>
      <Field hint="引擎 --days；1–365 天。" htmlFor="schedule-lookback" label="回看天数">
        <Input id="schedule-lookback" max={365} min={1} onChange={(event) => { const next = Number.parseInt(event.target.value, 10); onChangeLookbackDays(Number.isFinite(next) ? Math.min(365, Math.max(1, next)) : DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.lookbackDays) }} type="number" value={lookbackDays} />
      </Field>
      <Field error={folderInspection.ok ? undefined : folderInspection.message} htmlFor="schedule-output-folder" label="输出目录">
        <select className="select-control" id="schedule-output-folder" onChange={(event) => { const value = event.target.value; if (value === customFolderOption) { onChangeCustomFolder(true); return } onChangeCustomFolder(false); onChangeOutputFolder(value) }} value={customFolderMode ? customFolderOption : outputFolder}>
          {AGENT_SCHEDULE_OUTPUT_FOLDER_OPTIONS.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
          <option value={customFolderOption}>自定义相对目录…</option>
        </select>
      </Field>
      {customFolderMode ? <Field htmlFor="schedule-custom-output-folder" label="自定义相对目录"><Input id="schedule-custom-output-folder" onChange={(event) => onChangeOutputFolder(event.target.value)} placeholder="例如：每日资讯推送/AI" value={outputFolder} /></Field> : null}
      <Field htmlFor="schedule-permission-mode" label="权限模式">
        <select className="select-control" disabled={permissionOptions.length === 0} id="schedule-permission-mode" onChange={(event) => onChangePermissionMode(event.target.value as AgentPermissionMode)} value={permissionSupported ? permissionMode : ''}>
          <option disabled value="">{permissionOptions.length ? '请选择 CLI 支持的权限' : '正在探测 CLI 能力…'}</option>
          {permissionOptions.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </Field>
    </div>
    {mode === 'existing' ? <label className="mt-3 block">依赖会话<select className="select-control" onChange={(event) => onChangeConversation(event.target.value || null)} value={conversationId ?? ''}><option value="">选择会话</option>{conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title}</option>)}</select></label> : null}
    <label className="mt-3 block">Prompt<Textarea className="min-h-24" onChange={(event) => onChangePrompt(event.target.value)} value={prompt} /></label>
    <label className="mt-3 block">工作区路径<Input onChange={(event) => onChangeWorkspace(event.target.value)} placeholder="可选，仅保存为项目元数据" value={workspacePath} /></label>
    <div className="agent-composer-hint mt-3">执行权限：<strong>{permissionSupported ? permissionMode : '尚未选择有效权限'}</strong> · 可选项来自所选 CLI 的能力探测。输出目录为 Vault 内相对目录，写入前由同一安全谓词再校验一次；越界/绝对路径或 <span className="font-mono">.obsidian</span> 会被拒绝而不是静默改写。</div>
    <p className="agent-composer-hint mt-3">每日推送正文使用简体中文；来源名、原文标题、必要引语和 URL 保留原样以便核验。运行前会先对 runtime/skill/Python/来源做能力预检；预检不通过时本次推送直接标记为阻断，不会生成成功产物。完全访问的定时执行需要主进程安全开关；未完成安全审查时不会静默降级。</p>
    {blockedReason ? <p className="form-feedback form-feedback-error mx-4 mt-3" role="alert">{blockedReason}</p> : null}
    <div className="form-actions mt-4"><Button onClick={onCancel} size="sm" type="button" variant="ghost">取消</Button><Button loading={saving} size="sm" type="submit" variant="primary"><Workflow aria-hidden="true" className="size-3.5" />{editing ? '更新任务' : '保存任务'}</Button></div>
  </form>
}

function ScheduleCard({ rule, onEdit, onToggle, onRunNow, onArchive }: { rule: AutomationRule; onEdit: () => void; onToggle: () => void; onRunNow: () => void; onArchive: () => void }): React.JSX.Element {
  const runtime = rule.runtime ?? 'codex'
  const nextRun = rule.nextRunAt ? new Date(rule.nextRunAt).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }) : '未排期'
  const lastRun = rule.lastRunAt ? new Date(rule.lastRunAt).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }) : '尚未运行'
  return <article className={cn('schedule-card', !rule.enabled && 'schedule-card-disabled')}><div className="schedule-card-main"><div className="schedule-card-icon"><CalendarClock aria-hidden="true" className="size-4" /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-sm font-bold text-foreground">{rule.name}</h3><span className={cn('research-status', rule.enabled ? 'research-status-positive' : 'research-status-warning')}>{rule.enabled ? '已启用' : '已暂停'}</span></div><p className="mt-1 truncate text-xs text-muted-foreground">技能 {rule.skillKey ?? '内置工作流'} · 主题 {rule.topic || '未设置'} · {responseLanguageLabels[rule.responseLanguage]}</p><p className="mt-1 truncate text-xs text-muted-foreground">{frequencyLabels[rule.frequency]} · {rule.cron} · {runtimeLabels[runtime]} · {rule.model ?? runtimeDefaults[runtime]}</p><p className="mt-1 truncate text-xs text-muted-foreground">{rule.projectId ? '已绑定项目' : '全部项目'} · {rule.permissionMode} · {rule.timezone}</p><p className="mt-1 truncate text-xs text-muted-foreground">{rule.sources.length > 0 ? `来源 ${rule.sources.join('/')}` : '来源 全部可用'} · 近 {rule.lookbackDays} 天 · {rule.outputFolder}</p><p className="mt-1 truncate text-[11px] text-muted-foreground">下次 {nextRun} · 最近 {lastRun}</p></div></div><div className="schedule-card-actions"><Button aria-label={`立即运行 ${rule.name}`} onClick={onRunNow} size="icon" variant="ghost"><Play aria-hidden="true" className="size-3.5" /></Button><Button aria-label={`${rule.enabled ? '暂停' : '启用'} ${rule.name}`} onClick={onToggle} size="icon" variant="ghost">{rule.enabled ? <CirclePause aria-hidden="true" className="size-3.5" /> : <CheckCircle2 aria-hidden="true" className="size-3.5" />}</Button><Button aria-label={`编辑 ${rule.name}`} onClick={onEdit} size="icon" variant="ghost"><Pencil aria-hidden="true" className="size-3.5" /></Button><Button aria-label={`归档 ${rule.name}`} onClick={onArchive} size="icon" variant="ghost"><Trash2 aria-hidden="true" className="size-3.5" /></Button></div></article>
}
