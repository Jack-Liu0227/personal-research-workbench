import { CalendarClock, CheckCircle2, CirclePause, Pencil, Play, Plus, Trash2, Workflow } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AgentConversation, AgentPermissionMode, AgentRuntimeKind, AutomationRule, Project } from '@prw/contracts'
import { ProjectIdSchema } from '@prw/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Input, Textarea } from '../components/ui'
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/states'
import { cn } from '../lib/utils'
import { getWorkbenchAgentApi } from '../lib/workbench'

const runtimeLabels: Record<AgentRuntimeKind, string> = { codex: 'Codex', pi: 'Pi' }
const runtimeDefaults: Record<AgentRuntimeKind, string> = { codex: '', pi: '' }
const frequencyLabels = { manual: '手动', hourly: '每小时', daily: '每天', weekdays: '工作日', weekly: '每周', custom: '自定义 Cron' } as const
type Frequency = keyof typeof frequencyLabels
type ScheduleMode = 'new_conversation' | 'existing'

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
  const [skillKey, setSkillKey] = useState<string | null>('last30days')
  // The built-in Last30days rule has a safe, explicit default topic. Keeping
  // this populated also means a newly-created enabled rule cannot fail the
  // scheduler validation on first save.
  const [topic, setTopic] = useState('research updates')
  const [outputFolder, setOutputFolder] = useState('每日资讯推送')
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>('read-only')

  const rules = useQuery({ queryKey: ['automation-rules'], queryFn: () => getWorkbenchAgentApi().automation.rules(), staleTime: 30_000, placeholderData: (previous) => previous })
  const conversations = useQuery({ queryKey: ['agent-conversations', 'automation'], queryFn: () => getWorkbenchAgentApi().conversations.list({ includeArchived: false, limit: 100 }), enabled: showForm, staleTime: 60_000, placeholderData: (previous) => previous })
  const connectors = useQuery({ queryKey: ['agent-connectors'], queryFn: () => getWorkbenchAgentApi().connectors.list(), enabled: showForm, staleTime: 60_000, refetchOnMount: false, placeholderData: (previous) => previous })
  const permissionOptions = connectors.data?.find((connector) => connector.runtime === runtime)?.permissionOptions ?? []
  const permissionSupported = permissionOptions.includes(permissionMode)
  const modelForRuntime = (kind: AgentRuntimeKind): string => connectors.data?.find((connector) => connector.runtime === kind)?.localDefaultModel || ''
  const effectiveModel = (): string | null => {
    const trimmed = model.trim()
    if (trimmed && trimmed !== runtimeDefaults[runtime]) return trimmed
    return connectors.data?.find((connector) => connector.runtime === runtime)?.localDefaultModel || null
  }

  const saveMutation = useMutation({
    mutationFn: () => getWorkbenchAgentApi().automation.save({ id: editing?.id, name: name.trim(), workflowKey: 'daily_digest', runtime, model: effectiveModel(), assistantKey: assistantKey.trim() || 'researcher', workspacePath: workspacePath.trim() || null, frequency, executionMode: mode, conversationId: mode === 'existing' ? conversationId : null, prompt: prompt.trim(), skillKey, topic: topic.trim(), outputFolder: outputFolder.trim() || '每日资讯推送', permissionMode, approvalPolicy: permissionMode === 'full-access' ? 'never' : 'on-request', projectId: projectId ? ProjectIdSchema.parse(projectId) : null, cron: cron.trim(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai', enabled: editing?.enabled ?? true, expectedRevision: editing?.revision ?? null }),
    onSuccess: () => { setFeedback('定时任务已保存；仅在应用运行时执行。'); closeForm(); void queryClient.invalidateQueries({ queryKey: ['automation-rules'] }) },
    onError: (error) => setFeedback(error instanceof Error ? error.message : '定时任务保存失败。')
  })
  const toggleMutation = useMutation({
    mutationFn: (rule: AutomationRule) => getWorkbenchAgentApi().automation.save({ id: rule.id, name: rule.name, workflowKey: rule.workflowKey, runtime: rule.runtime, model: rule.model, assistantKey: rule.assistantKey, workspacePath: rule.workspacePath, frequency: rule.frequency, executionMode: rule.executionMode, conversationId: rule.conversationId, prompt: rule.prompt, skillKey: rule.skillKey, topic: rule.topic || (rule.skillKey === 'last30days' ? 'research updates' : ''), outputFolder: rule.outputFolder, permissionMode: rule.permissionMode, approvalPolicy: rule.approvalPolicy, projectId: rule.projectId, cron: rule.cron, timezone: rule.timezone, enabled: !rule.enabled, expectedRevision: rule.revision }),
    onSuccess: () => { setFeedback('定时任务状态已更新。'); void queryClient.invalidateQueries({ queryKey: ['automation-rules'] }) },
    onError: (error) => setFeedback(error instanceof Error ? error.message : '定时任务状态更新失败。')
  })

  const resetForm = () => {
    setSkillKey('last30days'); setTopic('research updates'); setOutputFolder('每日资讯推送'); setPermissionMode('read-only')
    setEditing(null); setName('每日科研摘要'); setCron('0 9 * * *'); setFrequency('daily'); setRuntime('codex'); setModel(modelForRuntime('codex')); setAssistantKey('researcher'); setPrompt('请根据项目中的最新文献生成一份可核验的研究摘要。'); setWorkspacePath(''); setProjectId(''); setMode('new_conversation'); setConversationId(null); setShowForm(true)
  }
  const closeForm = () => { setShowForm(false); setEditing(null) }
  const editRule = (rule: AutomationRule) => {
    setSkillKey(rule.skillKey ?? null); setTopic(rule.topic ?? ''); setOutputFolder(rule.outputFolder ?? '每日文献推送'); setPermissionMode(rule.permissionMode ?? 'read-only')
    setEditing(rule); setName(rule.name); setCron(rule.cron); setFrequency(rule.frequency); setRuntime(rule.runtime ?? 'codex'); setModel(rule.model ?? runtimeDefaults[rule.runtime ?? 'codex']); setAssistantKey(rule.assistantKey ?? 'researcher'); setPrompt(rule.prompt); setWorkspacePath(rule.workspacePath ?? ''); setProjectId(rule.projectId ?? ''); setMode(rule.executionMode); setConversationId(rule.conversationId); setShowForm(true)
  }
  const updateFrequency = (value: Frequency) => { setFrequency(value); if (value === 'hourly') setCron('0 * * * *'); else if (value === 'daily') setCron('0 9 * * *'); else if (value === 'weekdays') setCron('0 9 * * 1-5'); else if (value === 'weekly') setCron('0 9 * * 1') }
  const archive = (rule: AutomationRule) => {
    if (!window.confirm(`确认归档“${rule.name}”？归档后不会再自动运行。`)) return
    void getWorkbenchAgentApi().automation.archive(rule.id, rule.revision).then(() => { setFeedback('定时任务已归档。'); void queryClient.invalidateQueries({ queryKey: ['automation-rules'] }) }).catch((error: unknown) => setFeedback(error instanceof Error ? error.message : '定时任务归档失败。'))
  }
  const runNow = (rule: AutomationRule) => { void getWorkbenchAgentApi().automation.runNow(rule.id).then(() => setFeedback('定时任务已立即触发。')).catch((error: unknown) => setFeedback(error instanceof Error ? error.message : '定时任务触发失败。')) }

  return <div className="page-scroll">
    <PageHeader actions={<Button onClick={resetForm} size="sm" variant="primary"><Plus aria-hidden="true" className="size-3.5" />新建定时任务</Button>} description="管理由 Codex 或 Pi 执行的定时研究任务。任务仅在应用运行时调度，权限依据所选 CLI 的能力配置。" eyebrow="AUTOMATION / SCHEDULES" title="定时任务" />
    {feedback ? <p aria-live="polite" className="form-feedback form-feedback-success mt-3" role="status">{feedback}</p> : null}
    {showForm ? <section aria-label="Last30days 推送配置" className="research-panel mt-4"><div className="research-panel-header"><div><p className="instrument-label">DAILY RESEARCH PUSH</p><h2 className="text-base font-bold text-foreground">Last 30 days 每日资讯推送</h2></div><span className="research-tag">09:00 · Asia/Shanghai</span></div><div className="settings-form-grid"><label>技能<select className="select-control" onChange={(event) => setSkillKey(event.target.value || null)} value={skillKey ?? ''}><option value="last30days">last30days（项目固定版）</option><option value="">内置工作流</option></select></label><label>研究主题<Input onChange={(event) => setTopic(event.target.value)} placeholder="手动填写每日跟踪主题" value={topic} /></label><label>Obsidian 文件夹<Input onChange={(event) => setOutputFolder(event.target.value)} value={outputFolder} /></label><label>权限模式<select aria-label="定时任务权限模式" disabled={permissionOptions.length === 0} onChange={(event) => setPermissionMode(event.target.value as AgentPermissionMode)} value={permissionSupported ? permissionMode : ''}><option disabled value="">{permissionOptions.length ? '请选择 CLI 支持的权限' : '正在探测 CLI 能力…'}</option>{permissionOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label></div><p className="agent-composer-hint mt-3">每日推送正文使用简体中文；来源名、原文标题、必要引语和 URL 保留原样以便核验。完全访问的定时执行需要主进程安全开关；未完成安全审查时不会静默降级。</p></section> : null}
    {showForm ? <ScheduleEditor assistantKey={assistantKey} conversations={conversations.data ?? []} conversationId={conversationId} cron={cron} editing={editing} frequency={frequency} mode={mode} model={model} name={name} onCancel={closeForm} onChangeAssistant={setAssistantKey} onChangeConversation={setConversationId} onChangeCron={setCron} onChangeFrequency={updateFrequency} onChangeMode={setMode} onChangeModel={setModel} onChangeName={setName} onChangeProject={setProjectId} onChangePrompt={setPrompt} onChangeRuntime={(value) => { setRuntime(value); setModel(modelForRuntime(value)) }} onChangeWorkspace={setWorkspacePath} onSave={() => { if (!permissionSupported) { setFeedback('请先探测 CLI 并选择支持的权限模式。'); return }; saveMutation.mutate() }} projectId={projectId} projects={projects} prompt={prompt} runtime={runtime} saving={saveMutation.isPending} workspacePath={workspacePath} skillKey={skillKey} topic={topic} outputFolder={outputFolder} permissionMode={permissionMode} permissionOptions={connectors.data?.find((connector) => connector.runtime === runtime)?.permissionOptions ?? []} onChangeSkill={setSkillKey} onChangeTopic={setTopic} onChangeOutputFolder={setOutputFolder} onChangePermissionMode={setPermissionMode} /> : null}
    <section className="research-panel mt-4" aria-labelledby="schedule-list-title"><div className="research-panel-header"><div><p className="instrument-label">RUNTIME SCHEDULE</p><h2 id="schedule-list-title" className="text-base font-bold text-foreground">已配置任务</h2></div><span className="research-tag">{(rules.data ?? []).length} 个任务</span></div>{rules.isLoading ? <LoadingState label="正在读取定时任务…" /> : rules.error ? <ErrorState error={rules.error} onRetry={() => void rules.refetch()} /> : (rules.data ?? []).length === 0 ? <EmptyState title="还没有定时任务" description="创建每日摘要、文献检索或项目进度提醒，选择 Codex 或 Pi 作为执行 runtime。" action={<Button onClick={resetForm} size="sm" variant="secondary"><Plus aria-hidden="true" className="size-3.5" />新建任务</Button>} /> : <div className="schedule-list">{(rules.data ?? []).map(rule => <ScheduleCard key={rule.id} onArchive={() => archive(rule)} onEdit={() => editRule(rule)} onRunNow={() => runNow(rule)} onToggle={() => toggleMutation.mutate(rule)} rule={rule} />)}</div>}</section>
    <div className="agent-rail-note mt-3"><CalendarClock aria-hidden="true" className="size-3.5" /><span>调度依赖应用进程；关闭应用期间不会后台执行。重新打开时每日任务最多补跑一次错过的时间点，其余等待下一个 09:00（可随时暂停/启用）。</span></div>
  </div>
}

function ScheduleEditor({ projects, conversations, editing, name, runtime, model, assistantKey, workspacePath, frequency, cron, mode, prompt, projectId, conversationId, saving, skillKey, topic, outputFolder, permissionMode, permissionOptions, onCancel, onSave, onChangeName, onChangeRuntime, onChangeModel, onChangeAssistant, onChangeWorkspace, onChangeFrequency, onChangeCron, onChangeMode, onChangePrompt, onChangeProject, onChangeConversation, onChangeSkill, onChangeTopic, onChangeOutputFolder, onChangePermissionMode }: { projects: Project[]; conversations: AgentConversation[]; editing: AutomationRule | null; name: string; runtime: AgentRuntimeKind; model: string; assistantKey: string; workspacePath: string; frequency: Frequency; cron: string; mode: ScheduleMode; prompt: string; projectId: string; conversationId: string | null; saving: boolean; skillKey: string | null; topic: string; outputFolder: string; permissionMode: AgentPermissionMode; permissionOptions: AgentPermissionMode[]; onCancel: () => void; onSave: () => void; onChangeName: (value: string) => void; onChangeRuntime: (value: AgentRuntimeKind) => void; onChangeModel: (value: string) => void; onChangeAssistant: (value: string) => void; onChangeWorkspace: (value: string) => void; onChangeFrequency: (value: Frequency) => void; onChangeCron: (value: string) => void; onChangeMode: (value: ScheduleMode) => void; onChangePrompt: (value: string) => void; onChangeProject: (value: string) => void; onChangeConversation: (value: string | null) => void; onChangeSkill: (value: string | null) => void; onChangeTopic: (value: string) => void; onChangeOutputFolder: (value: string) => void; onChangePermissionMode: (value: AgentPermissionMode) => void }): React.JSX.Element {
  return <form className="research-panel schedule-editor mt-4" onSubmit={event => { event.preventDefault(); onSave() }}><div className="research-panel-header"><div><p className="instrument-label">{editing ? 'EDIT SCHEDULE' : 'NEW SCHEDULE'}</p><h2 className="text-base font-bold text-foreground">{editing ? '编辑定时任务' : '新建定时任务'}</h2></div><Button onClick={onCancel} size="sm" type="button" variant="ghost">取消</Button></div><div className="settings-form-grid"><label>任务名称<Input onChange={event => onChangeName(event.target.value)} value={name} /></label><label>Agent runtime<select className="select-control" onChange={event => onChangeRuntime(event.target.value as AgentRuntimeKind)} value={runtime}><option value="codex">Codex</option><option value="pi">Pi</option></select></label><label>模型<Input onChange={event => onChangeModel(event.target.value)} placeholder={runtimeDefaults[runtime]} value={model} /></label><label>助手<Input onChange={event => onChangeAssistant(event.target.value)} value={assistantKey} /></label><label>频率<select className="select-control" onChange={event => onChangeFrequency(event.target.value as Frequency)} value={frequency}>{Object.entries(frequencyLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>Cron<Input className="font-mono text-xs" onChange={event => onChangeCron(event.target.value)} value={cron} /></label><label>项目<select className="select-control" onChange={event => onChangeProject(event.target.value)} value={projectId}><option value="">全部项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label>执行模式<select className="select-control" onChange={event => onChangeMode(event.target.value as ScheduleMode)} value={mode}><option value="new_conversation">每次新会话</option><option disabled={conversations.length === 0} value="existing">追加到已有会话</option></select></label></div>{mode === 'existing' ? <label className="mt-3 block">依赖会话<select className="select-control" onChange={event => onChangeConversation(event.target.value || null)} value={conversationId ?? ''}><option value="">选择会话</option>{conversations.map(conversation => <option key={conversation.id} value={conversation.id}>{conversation.title}</option>)}</select></label> : null}<label className="mt-3 block">Prompt<Textarea className="min-h-24" onChange={event => onChangePrompt(event.target.value)} value={prompt} /></label><label className="mt-3 block">工作区路径<Input onChange={event => onChangeWorkspace(event.target.value)} placeholder="可选，仅保存为项目元数据" value={workspacePath} /></label><div className="agent-composer-hint mt-3">执行权限：<strong>{permissionOptions.includes(permissionMode) ? permissionMode : '尚未选择有效权限'}</strong> · 可选项来自所选 CLI 的能力探测。</div><div className="form-actions mt-4"><Button onClick={onCancel} size="sm" type="button" variant="ghost">取消</Button><Button loading={saving} size="sm" type="submit" variant="primary"><Workflow aria-hidden="true" className="size-3.5" />{editing ? '更新任务' : '保存任务'}</Button></div></form>
}

function ScheduleCard({ rule, onEdit, onToggle, onRunNow, onArchive }: { rule: AutomationRule; onEdit: () => void; onToggle: () => void; onRunNow: () => void; onArchive: () => void }): React.JSX.Element {
  const runtime = rule.runtime ?? 'codex'
  const nextRun = rule.nextRunAt ? new Date(rule.nextRunAt).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }) : '未排期'
  const lastRun = rule.lastRunAt ? new Date(rule.lastRunAt).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }) : '尚未运行'
  return <article className={cn('schedule-card', !rule.enabled && 'schedule-card-disabled')}><div className="schedule-card-main"><div className="schedule-card-icon"><CalendarClock aria-hidden="true" className="size-4" /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-sm font-bold text-foreground">{rule.name}</h3><span className={cn('research-status', rule.enabled ? 'research-status-positive' : 'research-status-warning')}>{rule.enabled ? '已启用' : '已暂停'}</span></div><p className="mt-1 truncate text-xs text-muted-foreground">{frequencyLabels[rule.frequency]} · {rule.cron} · {runtimeLabels[runtime]} · {rule.model ?? runtimeDefaults[runtime]}</p><p className="mt-1 truncate text-xs text-muted-foreground">{rule.projectId ? '已绑定项目' : '全部项目'} · {rule.permissionMode} · {rule.timezone}</p><p className="mt-1 truncate text-[11px] text-muted-foreground">下次 {nextRun} · 最近 {lastRun}</p></div></div><div className="schedule-card-actions"><Button aria-label={`立即运行 ${rule.name}`} onClick={onRunNow} size="icon" variant="ghost"><Play aria-hidden="true" className="size-3.5" /></Button><Button aria-label={`${rule.enabled ? '暂停' : '启用'} ${rule.name}`} onClick={onToggle} size="icon" variant="ghost">{rule.enabled ? <CirclePause aria-hidden="true" className="size-3.5" /> : <CheckCircle2 aria-hidden="true" className="size-3.5" />}</Button><Button aria-label={`编辑 ${rule.name}`} onClick={onEdit} size="icon" variant="ghost"><Pencil aria-hidden="true" className="size-3.5" /></Button><Button aria-label={`归档 ${rule.name}`} onClick={onArchive} size="icon" variant="ghost"><Trash2 aria-hidden="true" className="size-3.5" /></Button></div></article>
}
