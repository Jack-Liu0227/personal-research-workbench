import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AgentAssistantSaveInputSchema, AgentTeamSaveInputSchema, type AgentAssistant, type AgentAssistantSaveInput, type AgentBindingCatalog, type AgentBindingMatrix, type AgentTeam, type AgentTeamSaveInput } from '@prw/contracts'
import { Archive, Bot, Plus, RefreshCw, Save, Users } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { EmptyState, ErrorState, PanelSkeleton } from '../../components/states'
import { Button, Field, Input, Textarea } from '../../components/ui'
import { cn, getErrorMessage } from '../../lib/utils'
import { getWorkbenchAgentApi, getWorkbenchApi } from '../../lib/workbench'
import { MutationFeedback, ResearchPanel, StatusBadge } from './shared'
import { InstructionSkillManager, McpServerManager } from './agent-resources'

export const agentProfileQueryKeys = {
  assistants: ['agent-assistants'] as const,
  teams: ['agent-teams'] as const,
  bindings: ['agent-bindings'] as const,
  matrix: ['agent-binding-matrix'] as const,
  teamRuns: ['agent-team-runs'] as const
}

export function useAgentAssistantsQuery() {
  return useQuery({ queryKey: agentProfileQueryKeys.assistants, queryFn: () => getWorkbenchApi().assistants.list() })
}

export function useAgentTeamsQuery() {
  return useQuery({ queryKey: agentProfileQueryKeys.teams, queryFn: () => getWorkbenchApi().agentTeams.list() })
}

function useBindingsQuery() {
  return useQuery({ queryKey: agentProfileQueryKeys.bindings, queryFn: () => getWorkbenchApi().agentBindings.catalog(), staleTime: 30_000 })
}

function assistantDraft(assistant: AgentAssistant): AgentAssistantSaveInput {
  const { archivedAt: _archivedAt, createdAt: _createdAt, updatedAt: _updatedAt, revision, ...fields } = assistant
  return { ...fields, expectedRevision: revision }
}

function teamDraft(team: AgentTeam): AgentTeamSaveInput {
  const { archivedAt: _archivedAt, createdAt: _createdAt, updatedAt: _updatedAt, revision, ...fields } = team
  return { ...fields, members: fields.members.map((member) => ({ ...member })), expectedRevision: revision }
}

function confirmDiscard(dirty: boolean): boolean {
  return !dirty || window.confirm('当前修改尚未保存。放弃修改并切换？')
}

function useDirtyNotice(dirty: boolean, onDirtyChange: ((dirty: boolean) => void) | undefined) {
  useEffect(() => {
    onDirtyChange?.(dirty)
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => { window.removeEventListener('beforeunload', beforeUnload); onDirtyChange?.(false) }
  }, [dirty, onDirtyChange])
}

function SaveFeedback({ error, success }: { error: unknown; success: string }) {
  if (error) return <div className="form-feedback form-feedback-error" role="alert"><p>{getErrorMessage(error)}</p><p>若记录已被更新，请重新载入后再编辑；未保存内容不会覆盖数据库中的新版本。</p></div>
  return <MutationFeedback success={success || undefined} />
}

type DirtyProps = { onDirtyChange?: (dirty: boolean) => void }

export function AssistantSettingsPanel({ onDirtyChange }: DirtyProps): React.JSX.Element {
  const queryClient = useQueryClient()
  const assistants = useAgentAssistantsQuery()
  const bindings = useBindingsQuery()
  const catalog = useQuery({ queryKey: ['agent-model-catalog'], queryFn: () => getWorkbenchAgentApi().models.catalog(), staleTime: 60_000 })
  const [draft, setDraft] = useState<AgentAssistantSaveInput | null>(null)
  const [baseline, setBaseline] = useState('')
  const [success, setSuccess] = useState('')
  const idPrefix = useId()
  const dirty = draft !== null && JSON.stringify(draft) !== baseline
  useDirtyNotice(dirty, onDirtyChange)
  const activeAssistants = (assistants.data ?? []).filter((assistant) => !assistant.archivedAt)
  const load = (assistant: AgentAssistant) => {
    const next = assistantDraft(assistant)
    setDraft(next); setBaseline(JSON.stringify(next)); setSuccess(''); save.reset()
  }
  const save = useMutation({
    mutationFn: () => getWorkbenchApi().assistants.save(AgentAssistantSaveInputSchema.parse(draft)),
    onSuccess: async (saved) => { load(saved); setSuccess('助手已保存；下一次启动使用此版本。'); await queryClient.invalidateQueries({ queryKey: agentProfileQueryKeys.assistants }); await queryClient.invalidateQueries({ queryKey: agentProfileQueryKeys.matrix }) }
  })
  const archive = useMutation({
    mutationFn: (assistant: AgentAssistant) => getWorkbenchApi().assistants.archive({ id: assistant.id, expectedRevision: assistant.revision, confirmed: true }),
    onSuccess: async () => { setDraft(null); setBaseline(''); setSuccess('助手已归档；既有运行记录仍保留。'); await queryClient.invalidateQueries({ queryKey: agentProfileQueryKeys.assistants }); await queryClient.invalidateQueries({ queryKey: agentProfileQueryKeys.matrix }); await queryClient.invalidateQueries({ queryKey: agentProfileQueryKeys.teams }) }
  })
  const busy = save.isPending || archive.isPending
  const selected = activeAssistants.find((assistant) => assistant.id === draft?.id)
  const newAssistant = () => {
    if (!confirmDiscard(dirty)) return
    const next = AgentAssistantSaveInputSchema.parse({ id: `assistant.${crypto.randomUUID()}`, name: '新助手', expectedRevision: null })
    setDraft(next); setBaseline(''); setSuccess(''); save.reset(); archive.reset()
  }
  const update = (change: Partial<AgentAssistantSaveInput>) => { setDraft((current) => current ? { ...current, ...change } : null); setSuccess('') }
  const provider = catalog.data?.find((entry) => entry.provider === draft?.provider)
  const model = provider?.models.find((entry) => entry.id === draft?.model)
  const partialModel = draft !== null && (draft.provider === null) !== (draft.model === null)
  return <ResearchPanel action={<Button disabled={busy} onClick={newAssistant} size="sm"><Plus aria-hidden="true" className="size-3.5" />新建助手</Button>} eyebrow="ASSISTANTS / LOCAL PROFILES" title="AI 助手">
    <p className="agent-profile-note">助手定义模型、指令和能力范围；只引用已有 Provider，不保存或显示密钥。Provider 与模型同时留空继承应用默认值，选择 Provider 后须指定模型。空工具绑定表示不授予工具。</p>
    {assistants.isLoading ? <PanelSkeleton /> : null}
    {assistants.error ? <ErrorState compact error={assistants.error} onRetry={() => void assistants.refetch()} /> : null}
    <div className="agent-profile-layout">
      <nav aria-label="AI 助手列表" className="agent-profile-list">
        {activeAssistants.map((assistant) => <button aria-pressed={draft?.id === assistant.id} className={cn('agent-profile-row', draft?.id === assistant.id && 'agent-profile-row-active')} disabled={busy} key={assistant.id} onClick={() => { if (confirmDiscard(dirty)) { load(assistant); archive.reset() } }} type="button"><Bot aria-hidden="true" className="size-4" /><span><strong>{assistant.name}</strong><small>{assistant.provider && assistant.model ? `${assistant.provider} / ${assistant.model}` : '继承默认模型'} · {assistant.enabled ? '已启用' : '已停用'}</small></span></button>)}
        {!assistants.isLoading && !assistants.error && activeAssistants.length === 0 ? <p className="agent-profile-note">尚无助手。点击「新建助手」定义第一个研究角色。</p> : null}
      </nav>
      {draft ? <form className="agent-profile-editor" onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
        <fieldset disabled={busy}>
          <legend>身份与运行配置</legend>
          <Field htmlFor={`${idPrefix}-name`} label="助手名称"><Input id={`${idPrefix}-name`} maxLength={100} onChange={(event) => update({ name: event.target.value })} required value={draft.name} /></Field>
          <Field htmlFor={`${idPrefix}-description`} label="用途说明"><Textarea id={`${idPrefix}-description`} maxLength={1000} onChange={(event) => update({ description: event.target.value })} value={draft.description} /></Field>
          <label className="agent-profile-checkbox"><input checked={draft.enabled} onChange={(event) => update({ enabled: event.target.checked })} type="checkbox" />启用助手</label>
          <div className="agent-profile-field-grid">
            <Field htmlFor={`${idPrefix}-provider`} label="Provider"><select className="settings-select" id={`${idPrefix}-provider`} onChange={(event) => update({ provider: event.target.value || null, model: null, thinking: null })} value={draft.provider ?? ''}><option value="">继承应用默认 Provider</option>{draft.provider && !provider ? <option value={draft.provider}>{draft.provider}（目录中未找到）</option> : null}{(catalog.data ?? []).map((entry) => <option key={entry.provider} value={entry.provider}>{entry.name} · {entry.provider}</option>)}</select></Field>
            <Field error={partialModel ? '选择 Provider 后必须同时选择模型；或将 Provider 留空以继承默认配置。' : undefined} htmlFor={`${idPrefix}-model`} label="模型"><select className="settings-select" disabled={!draft.provider} id={`${idPrefix}-model`} onChange={(event) => update({ model: event.target.value || null, thinking: null })} value={draft.model ?? ''}><option value="">{draft.provider ? '请选择模型' : '继承应用默认模型'}</option>{draft.model && !model ? <option value={draft.model}>{draft.model}（目录中未找到）</option> : null}{(provider?.models ?? []).map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.api ?? '未声明协议'}</option>)}</select></Field>
            <Field hint="空值使用应用默认思考深度。" htmlFor={`${idPrefix}-thinking`} label="思考深度"><Input id={`${idPrefix}-thinking`} list={`${idPrefix}-thinking-options`} maxLength={50} onChange={(event) => update({ thinking: event.target.value || null })} value={draft.thinking ?? ''} /></Field>
            <datalist id={`${idPrefix}-thinking-options`}>{(model?.thinkingLevels ?? []).map((level) => <option key={level} value={level} />)}</datalist>
            <Field htmlFor={`${idPrefix}-profile`} label="工具范围"><select className="settings-select" id={`${idPrefix}-profile`} onChange={(event) => update({ toolProfile: event.target.value === 'approved-write' ? 'approved-write' : 'read-only' })} value={draft.toolProfile}><option value="read-only">只读</option><option value="approved-write">允许本地写入 / 外部写入待确认</option></select></Field>
          </div>
          {catalog.isLoading ? <p className="agent-profile-note" role="status">正在读取模型目录…</p> : null}
          {catalog.error ? <ErrorState compact error={catalog.error} onRetry={() => void catalog.refetch()} /> : null}
          <Field hint="在模型请求中作为该助手的角色指令；不要写入密钥或个人敏感信息。" htmlFor={`${idPrefix}-prompt`} label="系统指令"><Textarea id={`${idPrefix}-prompt`} maxLength={20000} onChange={(event) => update({ systemPrompt: event.target.value })} rows={6} value={draft.systemPrompt} /></Field>
        </fieldset>
        <fieldset disabled={busy}><legend>工具与技能绑定</legend><BindingChoices catalog={bindings.data ?? null} draft={draft} mode="tools" onChange={update} /><BindingChoices catalog={bindings.data ?? null} draft={draft} mode="skills" onChange={update} /></fieldset>
        {bindings.isLoading ? <p className="agent-profile-note" role="status">正在读取能力目录…</p> : null}
        {bindings.error ? <ErrorState compact error={bindings.error} onRetry={() => void bindings.refetch()} /> : null}
        <SaveFeedback error={save.error ?? archive.error} success={success} />
        <div className="agent-profile-actions"><Button disabled={!draft.name.trim() || !dirty || partialModel || archive.isPending} loading={save.isPending} type="submit" variant="primary"><Save aria-hidden="true" className="size-3.5" />保存助手</Button>{selected ? <><Button disabled={busy} onClick={() => { if (confirmDiscard(dirty)) { void assistants.refetch().then((result) => { const latest = result.data?.find((assistant) => assistant.id === selected.id); if (latest) load(latest) }) } }} type="button"><RefreshCw aria-hidden="true" className="size-3.5" />重新载入</Button><Button disabled={busy} onClick={() => { if (window.confirm(`归档助手「${selected.name}」？团队引用可能导致归档被拒绝。历史运行不会被删除。${dirty ? '\n未保存修改将被放弃。' : ''}`)) archive.mutate({ ...selected, revision: draft.expectedRevision ?? selected.revision }) }} type="button" variant="danger"><Archive aria-hidden="true" className="size-3.5" />归档助手</Button></> : null}<span className="agent-profile-note">{dirty ? '有未保存修改' : '已与本机数据库同步'}</span></div>
      </form> : <EmptyState description="选择左侧助手进行编辑，或新建助手。配置不会启动模型或写入外部系统。" title="为研究任务定义助手" />}
    </div>
    {!draft ? <SaveFeedback error={archive.error} success={success} /> : null}
  </ResearchPanel>
}

function BindingChoices({ catalog, draft, mode, onChange }: { catalog: AgentBindingCatalog | null; draft: AgentAssistantSaveInput; mode: 'tools' | 'skills'; onChange: (change: Partial<AgentAssistantSaveInput>) => void }): React.JSX.Element {
  const selected = mode === 'tools' ? draft.toolAllowlist : draft.skillKeys
  const choices = mode === 'tools' ? (catalog?.tools ?? []).map((tool) => ({ key: tool.name, label: tool.name, hint: tool.kind === 'read' ? '只读' : tool.kind === 'local-write' ? '修改本地工作区' : '生成外部写入确认请求', isWrite: tool.kind !== 'read' })) : (catalog?.skills ?? []).map((skill) => ({ key: skill.key, label: skill.name, hint: skill.key, isWrite: false }))
  const unknownKeys = selected.filter((key) => !choices.some((choice) => choice.key === key))
  const toggle = (key: string) => {
    const next = selected.includes(key) ? selected.filter((item) => item !== key) : [...selected, key]
    onChange(mode === 'tools' ? { toolAllowlist: next } : { skillKeys: next })
  }
  return <div className="agent-binding-group"><h3>{mode === 'tools' ? '本地工作台工具' : '已安装技能'} <span>{selected.length} 项已绑定</span></h3>
    <p className="agent-profile-note">{mode === 'tools' ? '本机 Workspace 工具与已探测 HTTP MCP 工具使用稳定 key；空列表不授予任何工具。第三方 stdio MCP 暂不支持。HTTP 工具只能由允许写入请求的手动助手逐次确认，团队与定时任务不可使用。' : '技能使用已安装或受控 SQLite 指令文本的稳定 key；绑定不等于执行，也不会安装新代码。修改自定义技能内容后需重新授权。'}</p>
    <div className="agent-binding-grid">{choices.map((choice) => <label className="agent-binding-option" key={choice.key}><input checked={selected.includes(choice.key)} disabled={choice.isWrite && draft.toolProfile === 'read-only' && !selected.includes(choice.key)} onChange={() => toggle(choice.key)} type="checkbox" /><span><strong>{choice.label}</strong><small>{choice.hint}</small></span></label>)}</div>
    {catalog && choices.length === 0 ? <p className="agent-profile-note">{mode === 'tools' ? '没有可绑定工具。' : '当前没有已安装技能。'}</p> : null}
    {unknownKeys.map((key) => <label className="agent-binding-option" key={key}><input checked onChange={() => toggle(key)} type="checkbox" /><span><strong>{key}</strong><small>不在当前目录中；取消勾选后保存以移除</small></span></label>)}
    {mode === 'tools' && draft.toolProfile === 'read-only' && choices.some((choice) => choice.isWrite && selected.includes(choice.key)) ? <p className="form-feedback form-feedback-error" role="alert">当前只读助手仍绑定了写入工具，请移除这些绑定或修改工具范围后保存。</p> : null}
  </div>
}

export function AssistantBindingsPanel({ mode, onDirtyChange }: DirtyProps & { mode: 'tools' | 'skills' }): React.JSX.Element {
  const [view, setView] = useState<'matrix' | 'assistant' | 'resources'>('matrix')
  const [dirty, setDirty] = useState(false)
  useDirtyNotice(dirty, onDirtyChange)
  return <div className="agent-bindings-workspace"><div aria-label="绑定编辑方式" className="agent-bindings-view-picker"><Button aria-pressed={view === 'matrix'} onClick={() => { if (view !== 'matrix' && confirmDiscard(dirty)) { setDirty(false); setView('matrix') } }} size="sm" variant={view === 'matrix' ? 'primary' : 'secondary'}>跨助手矩阵</Button><Button aria-pressed={view === 'assistant'} onClick={() => { if (view !== 'assistant' && confirmDiscard(dirty)) { setDirty(false); setView('assistant') } }} size="sm" variant={view === 'assistant' ? 'primary' : 'secondary'}>单助手编辑</Button><Button aria-pressed={view === 'resources'} onClick={() => { if (view !== 'resources' && confirmDiscard(dirty)) { setDirty(false); setView('resources') } }} size="sm" variant={view === 'resources' ? 'primary' : 'secondary'}>{mode === 'tools' ? 'MCP 服务器' : '管理指令技能'}</Button><span>能力配置 · 下次运行生效</span></div>{view === 'matrix' ? <AssistantBindingMatrixPanel key={mode} mode={mode} onDirtyChange={setDirty} /> : view === 'assistant' ? <SingleAssistantBindingsPanel key={mode} mode={mode} onDirtyChange={setDirty} /> : mode === 'tools' ? <McpServerManager onDirtyChange={setDirty} /> : <InstructionSkillManager onDirtyChange={setDirty} />}</div>
}

function AssistantBindingMatrixPanel({ mode, onDirtyChange }: DirtyProps & { mode: 'tools' | 'skills' }): React.JSX.Element {
  const queryClient = useQueryClient()
  const matrix = useQuery({ queryKey: agentProfileQueryKeys.matrix, queryFn: () => getWorkbenchApi().agentBindings.matrix(), refetchOnMount: 'always' })
  const [snapshot, setSnapshot] = useState<AgentBindingMatrix | null>(null)
  const [draft, setDraft] = useState<Record<string, string[]>>({})
  const [resourceSearch, setResourceSearch] = useState('')
  const [assistantSearch, setAssistantSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [success, setSuccess] = useState('')
  const [reloadError, setReloadError] = useState<unknown>(null)
  const [reloading, setReloading] = useState(false)
  const dirty = Object.keys(draft).length > 0
  useDirtyNotice(dirty, onDirtyChange)
  useEffect(() => { if (matrix.data && matrix.isFetchedAfterMount && !dirty && !reloading) setSnapshot(matrix.data) }, [matrix.data, matrix.isFetchedAfterMount, dirty, reloading])
  const assistants = (snapshot?.assistants ?? []).filter((assistant) => !assistant.archivedAt)
  const visibleAssistants = assistants.filter((assistant) => `${assistant.name} ${assistant.id}`.toLocaleLowerCase().includes(assistantSearch.trim().toLocaleLowerCase()))
  const bindingKeys = (assistant: AgentAssistant): string[] => draft[assistant.id] ?? (mode === 'tools' ? assistant.toolAllowlist : assistant.skillKeys)
  const knownResources = mode === 'tools'
    ? (snapshot?.catalog.tools ?? []).map((tool) => ({ key: tool.name, label: tool.name, kind: tool.kind, known: true }))
    : (snapshot?.catalog.skills ?? []).map((skill) => ({ key: skill.key, label: skill.name, kind: 'skill', known: true }))
  const unknownKeys = [...new Set(assistants.flatMap(bindingKeys))].filter((key) => !knownResources.some((resource) => resource.key === key))
  const resources = [...knownResources, ...unknownKeys.map((key) => ({ key, label: key, kind: 'unknown', known: false }))]
    .filter((resource) => `${resource.label} ${resource.key}`.toLocaleLowerCase().includes(resourceSearch.trim().toLocaleLowerCase()) && (filter === 'all' || resource.kind === filter))
  const canEnable = (assistant: AgentAssistant, resource: typeof resources[number]): boolean => resource.known && (mode === 'skills' || resource.kind === 'read' || assistant.toolProfile === 'approved-write')
  const change = (changes: Array<{ assistant: AgentAssistant; key: string; enabled: boolean }>) => {
    if (busy) return
    setSuccess('')
    setDraft((current) => {
      const next = { ...current }
      for (const { assistant, key, enabled } of changes) {
        const original = mode === 'tools' ? assistant.toolAllowlist : assistant.skillKeys
        const keys = next[assistant.id] ?? original
        const updated = enabled ? [...new Set([...keys, key])] : keys.filter((entry) => entry !== key)
        if (updated.length === original.length && updated.every((entry) => original.includes(entry))) delete next[assistant.id]
        else next[assistant.id] = updated
      }
      return next
    })
  }
  const save = useMutation({
    mutationFn: () => getWorkbenchApi().agentBindings.saveMatrix({ updates: assistants.filter((assistant) => draft[assistant.id] !== undefined).map((assistant) => ({ assistantId: assistant.id, expectedRevision: assistant.revision, ...(mode === 'tools' ? { toolAllowlist: draft[assistant.id]! } : { skillKeys: draft[assistant.id]! }) })) }),
    onSuccess: async (saved) => {
      const updated = snapshot ? { ...snapshot, assistants: snapshot.assistants.map((assistant) => saved.find((entry) => entry.id === assistant.id) ?? assistant) } : null
      if (updated) queryClient.setQueryData(agentProfileQueryKeys.matrix, updated)
      setSnapshot(updated)
      setDraft({})
      setSuccess('矩阵已原子保存；下次运行使用新绑定，已有运行保持冻结快照。')
      await queryClient.invalidateQueries({ queryKey: agentProfileQueryKeys.assistants })
      await queryClient.invalidateQueries({ queryKey: agentProfileQueryKeys.matrix })
    }
  })
  const busy = save.isPending || reloading || matrix.isFetching
  const reload = async () => {
    if (busy || !confirmDiscard(dirty)) return
    setReloadError(null)
    setReloading(true)
    try {
      const result = await matrix.refetch()
      if (result.error) { setReloadError(result.error); return }
      if (result.data) { setSnapshot(result.data); setDraft({}); setSuccess(''); save.reset() }
    } finally { setReloading(false) }
  }
  return <ResearchPanel eyebrow={mode === 'tools' ? 'CAPABILITIES / WORKSPACE MCP' : 'CAPABILITIES / INSTALLED SKILLS'} title={mode === 'tools' ? '工具与 MCP 绑定' : '技能绑定'}>
    <div className="agent-binding-matrix-intro"><div><h3>{mode === 'tools' ? '工具 × 助手' : '技能 × 助手'}</h3><p>勾选只修改草稿；保存会原子检查全部助手修订号。保存后下次运行生效，已有运行保留冻结配置。</p></div><span className="agent-binding-matrix-summary">{assistants.length} 位助手 · {knownResources.length} 项能力</span></div>
    <p className="agent-binding-matrix-policy">{mode === 'tools' ? '本机 Workspace 与已探测 Streamable HTTP MCP 工具；第三方 stdio MCP 暂不支持。只读助手不能新增写入或第三方工具。HTTP 调用必须手动逐次审批，团队和定时任务禁止。空绑定表示零工具。' : '已安装与 SQLite 受控指令技能；绑定不安装或执行任意技能代码。内容变化会清除旧绑定，需重新授权。需要外部引擎的技能不在可绑定目录中。'}</p>
    {matrix.isLoading && !snapshot ? <PanelSkeleton /> : null}{matrix.error && !snapshot ? <ErrorState error={matrix.error} onRetry={() => void reload()} /> : null}
    <div className="agent-binding-matrix-filters"><label>查找能力<Input aria-label="查找绑定能力" disabled={busy} onChange={(event) => setResourceSearch(event.target.value)} placeholder="名称或稳定 key" value={resourceSearch} /></label><label>查找助手<Input aria-label="查找矩阵助手" disabled={busy} onChange={(event) => setAssistantSearch(event.target.value)} placeholder="名称或稳定 ID" value={assistantSearch} /></label><label>能力类型<select aria-label="矩阵能力类型" className="select-control" disabled={busy} onChange={(event) => setFilter(event.target.value)} value={filter}><option value="all">全部类型</option>{mode === 'tools' ? <><option value="read">只读工具</option><option value="local-write">本地写入</option><option value="external-request">外部写入请求</option></> : <option value="skill">已安装技能</option>}<option value="unknown">失效绑定</option></select></label></div>
    {snapshot && assistants.length > 0 ? <div aria-label={mode === 'tools' ? '工具绑定矩阵滚动区域' : '技能绑定矩阵滚动区域'} className="agent-binding-matrix-scroll" role="region" tabIndex={0}><table className="agent-binding-matrix"><caption>{mode === 'tools' ? '本地工具与助手绑定矩阵' : '已安装技能与助手绑定矩阵'}；行是能力，列是助手。未保存草稿不是运行授权。</caption><thead><tr><th scope="col">{mode === 'tools' ? '本地能力' : '已安装技能'}<small>仅对当前筛选结果批量操作</small></th>{visibleAssistants.map((assistant) => <th key={assistant.id} scope="col"><strong>{assistant.name}</strong><small>{assistant.toolProfile === 'read-only' ? '只读' : '允许写入请求'} · r{assistant.revision}{assistant.enabled ? '' : ' · 停用'}</small><code title={assistant.id}>{assistant.id}</code><div><button aria-label={`启用助手全部可用绑定 ${assistant.id}`} disabled={busy || resources.length === 0} onClick={() => change(resources.filter((resource) => canEnable(assistant, resource)).map((resource) => ({ assistant, key: resource.key, enabled: true })))} type="button">启用</button><button aria-label={`关闭助手全部绑定 ${assistant.id}`} disabled={busy || resources.length === 0} onClick={() => change(resources.map((resource) => ({ assistant, key: resource.key, enabled: false })))} type="button">关闭</button></div></th>)}</tr></thead><tbody>{resources.map((resource) => <tr key={resource.key}><th scope="row"><strong>{resource.label}</strong><small>{resource.kind === 'unknown' ? '已失效；只允许移除' : resource.kind === 'read' ? '只读工具' : resource.kind === 'local-write' ? '本地工作区写入' : resource.kind === 'external-request' ? '外部写入需确认' : resource.key}</small><div><button aria-label={`启用能力全部助手 ${resource.key}`} disabled={busy || !resource.known || visibleAssistants.length === 0} onClick={() => change(visibleAssistants.filter((assistant) => canEnable(assistant, resource)).map((assistant) => ({ assistant, key: resource.key, enabled: true })))} type="button">启用</button><button aria-label={`关闭能力全部助手 ${resource.key}`} disabled={busy || visibleAssistants.length === 0} onClick={() => change(visibleAssistants.map((assistant) => ({ assistant, key: resource.key, enabled: false })))} type="button">关闭</button></div></th>{visibleAssistants.map((assistant) => { const checked = bindingKeys(assistant).includes(resource.key); const enabled = canEnable(assistant, resource); return <td key={assistant.id}><label title={!enabled && !checked ? resource.known ? '只读策略不授予写入工具' : '能力不在当前目录中' : undefined}><input aria-label={`绑定 ${assistant.id} ${resource.key}`} checked={checked} disabled={busy || (!enabled && !checked)} onChange={(event) => change([{ assistant, key: resource.key, enabled: event.target.checked }])} type="checkbox" /><span>{checked ? draft[assistant.id] ? '草稿启用' : '已绑定' : enabled ? '未绑定' : '不可启用'}</span></label></td> })}</tr>)}</tbody></table>{resources.length === 0 || visibleAssistants.length === 0 ? <p className="agent-binding-matrix-empty">没有符合筛选条件的能力或助手。未安装技能不会显示为可用。</p> : null}</div> : snapshot ? <EmptyState description="先在 AI 助手中创建配置。没有真实记录时矩阵不会填充演示行。" title="尚无助手可绑定" /> : null}
    <div className="agent-binding-matrix-footer"><SaveFeedback error={save.error ?? reloadError} success={success} /><div className="agent-profile-actions"><Button disabled={!dirty || !snapshot || busy || Boolean(reloadError)} loading={save.isPending} onClick={() => save.mutate()} variant="primary"><Save aria-hidden="true" className="size-3.5" />保存矩阵</Button><Button disabled={busy} onClick={() => void reload()}><RefreshCw aria-hidden="true" className="size-3.5" />重新载入矩阵</Button><span aria-live="polite" className="agent-profile-note">{dirty ? `${Object.keys(draft).length} 位助手有未保存修改` : '无未保存修改'}</span></div></div>
  </ResearchPanel>
}

function SingleAssistantBindingsPanel({ mode, onDirtyChange }: DirtyProps & { mode: 'tools' | 'skills' }): React.JSX.Element {
  const queryClient = useQueryClient()
  const assistants = useAgentAssistantsQuery()
  const catalog = useBindingsQuery()
  const [draft, setDraft] = useState<AgentAssistantSaveInput | null>(null)
  const [baseline, setBaseline] = useState('')
  const [success, setSuccess] = useState('')
  const dirty = draft !== null && JSON.stringify(draft) !== baseline
  useDirtyNotice(dirty, onDirtyChange)
  const entries = (assistants.data ?? []).filter((assistant) => !assistant.archivedAt)
  const load = (assistant: AgentAssistant) => { const next = assistantDraft(assistant); setDraft(next); setBaseline(JSON.stringify(next)); setSuccess(''); save.reset() }
  const save = useMutation({ mutationFn: () => getWorkbenchApi().assistants.save(AgentAssistantSaveInputSchema.parse(draft)), onSuccess: async (saved) => { load(saved); setSuccess('绑定已保存，与助手使用同一修订号。'); await queryClient.invalidateQueries({ queryKey: agentProfileQueryKeys.assistants }); await queryClient.invalidateQueries({ queryKey: agentProfileQueryKeys.matrix }) } })
  return <ResearchPanel eyebrow={mode === 'tools' ? 'TOOLS / WORKSPACE MCP' : 'SKILLS / INSTALLED'} title={mode === 'tools' ? '工具与 MCP 绑定' : '技能绑定'}>
    <div className="agent-profile-editor">
      <p className="agent-profile-note">为单个助手配置能力；保存会检查该助手的修订号，不会覆盖其他设置面板提交的新版本。</p>
      {assistants.isLoading || catalog.isLoading ? <PanelSkeleton /> : null}
      {assistants.error ? <ErrorState compact error={assistants.error} onRetry={() => void assistants.refetch()} /> : null}
      {catalog.error ? <ErrorState compact error={catalog.error} onRetry={() => void catalog.refetch()} /> : null}
      <label className="agent-profile-picker">选择助手<select aria-label="绑定目标助手" className="settings-select" disabled={save.isPending} onChange={(event) => { if (!confirmDiscard(dirty)) return; const selected = entries.find((assistant) => assistant.id === event.target.value); if (selected) load(selected); else { setDraft(null); setBaseline('') } }} value={draft?.id ?? ''}><option value="">请选择助手</option>{entries.map((assistant) => <option key={assistant.id} value={assistant.id}>{assistant.name}{assistant.enabled ? '' : '（已停用）'}</option>)}</select></label>
      {!assistants.isLoading && !assistants.error && entries.length === 0 ? <EmptyState description="先在「AI 助手」分区创建助手，再选择工具或已安装技能。" title="尚无助手可绑定" /> : null}
      {draft ? <><fieldset disabled={save.isPending || !catalog.data}><legend>{draft.name} · {draft.toolProfile === 'read-only' ? '只读' : '允许写入请求'}</legend><BindingChoices catalog={catalog.data ?? null} draft={draft} mode={mode} onChange={(change) => { setDraft({ ...draft, ...change }); setSuccess('') }} /></fieldset><SaveFeedback error={save.error} success={success} /><div className="agent-profile-actions"><Button disabled={!dirty || !catalog.data} loading={save.isPending} onClick={() => save.mutate()} variant="primary"><Save aria-hidden="true" className="size-3.5" />保存绑定</Button><Button disabled={save.isPending} onClick={() => { if (confirmDiscard(dirty)) void assistants.refetch().then((result) => { const latest = result.data?.find((assistant) => assistant.id === draft.id); if (latest) load(latest) }) }}><RefreshCw aria-hidden="true" className="size-3.5" />重新载入助手</Button><span className="agent-profile-note">{dirty ? '有未保存修改' : '已保存'}</span></div></> : null}
    </div>
  </ResearchPanel>
}

const teamRoles = { director: '统筹', researcher: '研究', reviewer: '复核' } as const

export function AgentTeamSettingsPanel({ onDirtyChange }: DirtyProps): React.JSX.Element {
  const queryClient = useQueryClient()
  const teams = useAgentTeamsQuery()
  const assistants = useAgentAssistantsQuery()
  const [draft, setDraft] = useState<AgentTeamSaveInput | null>(null)
  const [baseline, setBaseline] = useState('')
  const [success, setSuccess] = useState('')
  const idPrefix = useId()
  const dirty = draft !== null && JSON.stringify(draft) !== baseline
  useDirtyNotice(dirty, onDirtyChange)
  const entries = (teams.data ?? []).filter((team) => !team.archivedAt)
  const assistantEntries = (assistants.data ?? []).filter((assistant) => !assistant.archivedAt)
  const load = (team: AgentTeam) => { const next = teamDraft(team); setDraft(next); setBaseline(JSON.stringify(next)); setSuccess(''); save.reset() }
  const save = useMutation({ mutationFn: () => getWorkbenchApi().agentTeams.save(AgentTeamSaveInputSchema.parse(draft)), onSuccess: async (saved) => { load(saved); setSuccess('团队已保存；下一次运行冻结此配置快照。'); await queryClient.invalidateQueries({ queryKey: agentProfileQueryKeys.teams }) } })
  const archive = useMutation({ mutationFn: (team: AgentTeam) => getWorkbenchApi().agentTeams.archive({ id: team.id, expectedRevision: team.revision, confirmed: true }), onSuccess: async () => { setDraft(null); setBaseline(''); setSuccess('团队已归档；历史运行保留。'); await queryClient.invalidateQueries({ queryKey: agentProfileQueryKeys.teams }) } })
  const update = (change: Partial<AgentTeamSaveInput>) => { setDraft((current) => current ? { ...current, ...change } : null); setSuccess('') }
  const busy = save.isPending || archive.isPending
  const selected = entries.find((team) => team.id === draft?.id)
  const newTeam = () => {
    if (!confirmDiscard(dirty)) return
    const initial = assistantEntries.filter((assistant) => assistant.enabled).slice(0, 2)
    const next: AgentTeamSaveInput = { id: `team.${crypto.randomUUID()}`, name: '新团队', description: '', enabled: true, maxSteps: 6, members: initial.map((assistant, index) => ({ assistantId: assistant.id, role: index === 0 ? 'director' : 'researcher', instructions: '' })), expectedRevision: null }
    setDraft(next); setBaseline(''); setSuccess(''); save.reset(); archive.reset()
  }
  return <ResearchPanel action={<Button disabled={busy} onClick={newTeam} size="sm"><Plus aria-hidden="true" className="size-3.5" />新建团队</Button>} eyebrow="TEAMS / BOUNDED ORCHESTRATION" title="协作团队">
    <p className="agent-profile-note">2–8 个不同助手，且恰好一位统筹。团队运行按有限步骤调度，仅使用只读工具，不批准本地或外部写入。</p>
    {teams.isLoading || assistants.isLoading ? <PanelSkeleton /> : null}
    {teams.error ? <ErrorState compact error={teams.error} onRetry={() => void teams.refetch()} /> : null}
    {assistants.error ? <ErrorState compact error={assistants.error} onRetry={() => void assistants.refetch()} /> : null}
    <div className="agent-profile-layout"><nav aria-label="协作团队列表" className="agent-profile-list">{entries.map((team) => <button aria-pressed={draft?.id === team.id} className={cn('agent-profile-row', draft?.id === team.id && 'agent-profile-row-active')} disabled={busy} key={team.id} onClick={() => { if (confirmDiscard(dirty)) { load(team); archive.reset() } }} type="button"><Users aria-hidden="true" className="size-4" /><span><strong>{team.name}</strong><small>{team.members.length} 位成员 · 最多 {team.maxSteps} 步 · {team.enabled ? '已启用' : '已停用'}</small></span></button>)}{!teams.isLoading && !teams.error && entries.length === 0 ? <p className="agent-profile-note">尚无团队。新建团队并指定统筹与研究成员。</p> : null}</nav>
      {draft ? <form className="agent-profile-editor" onSubmit={(event) => { event.preventDefault(); save.mutate() }}><fieldset disabled={busy}><legend>团队配置</legend><Field htmlFor={`${idPrefix}-name`} label="团队名称"><Input id={`${idPrefix}-name`} maxLength={100} onChange={(event) => update({ name: event.target.value })} required value={draft.name} /></Field><Field htmlFor={`${idPrefix}-description`} label="团队用途"><Textarea id={`${idPrefix}-description`} maxLength={1000} onChange={(event) => update({ description: event.target.value })} value={draft.description} /></Field><div className="agent-profile-field-grid"><Field htmlFor={`${idPrefix}-steps`} label="最大运行步骤（2–12）"><Input id={`${idPrefix}-steps`} max={12} min={2} onChange={(event) => update({ maxSteps: Number(event.target.value) })} required type="number" value={draft.maxSteps} /></Field><label className="agent-profile-checkbox"><input checked={draft.enabled} onChange={(event) => update({ enabled: event.target.checked })} type="checkbox" />启用团队</label></div></fieldset>
        <fieldset disabled={busy}><legend>成员与角色</legend>{draft.members.map((member, index) => <div className="agent-team-member" key={index}><div className="agent-profile-field-grid"><Field htmlFor={`${idPrefix}-member-${index}`} label={`成员 ${index + 1}`}><select className="settings-select" id={`${idPrefix}-member-${index}`} onChange={(event) => update({ members: draft.members.map((item, position) => position === index ? { ...item, assistantId: event.target.value } : item) })} value={member.assistantId}>{!assistantEntries.some((assistant) => assistant.id === member.assistantId) ? <option value={member.assistantId}>助手不可用 · {member.assistantId}</option> : null}{assistantEntries.map((assistant) => <option disabled={draft.members.some((item, position) => position !== index && item.assistantId === assistant.id)} key={assistant.id} value={assistant.id}>{assistant.name}{assistant.enabled ? '' : '（已停用）'}</option>)}</select></Field><Field htmlFor={`${idPrefix}-role-${index}`} label="角色"><select className="settings-select" id={`${idPrefix}-role-${index}`} onChange={(event) => update({ members: draft.members.map((item, position) => position === index ? { ...item, role: event.target.value as typeof member.role } : item) })} value={member.role}>{Object.entries(teamRoles).map(([role, label]) => <option key={role} value={role}>{label}</option>)}</select></Field></div><Field htmlFor={`${idPrefix}-instructions-${index}`} label="角色补充指令"><Textarea id={`${idPrefix}-instructions-${index}`} maxLength={4000} onChange={(event) => update({ members: draft.members.map((item, position) => position === index ? { ...item, instructions: event.target.value } : item) })} value={member.instructions} /></Field><Button onClick={() => update({ members: draft.members.filter((_, position) => position !== index) })} size="sm" type="button" variant="ghost">移除成员 {index + 1}</Button></div>)}<Button disabled={draft.members.length >= 8 || !assistantEntries.some((assistant) => !draft.members.some((member) => member.assistantId === assistant.id))} onClick={() => { const next = assistantEntries.find((assistant) => !draft.members.some((member) => member.assistantId === assistant.id)); if (next) update({ members: [...draft.members, { assistantId: next.id, role: draft.members.some((member) => member.role === 'director') ? 'researcher' : 'director', instructions: '' }] }) }} type="button"><Plus aria-hidden="true" className="size-3.5" />添加成员</Button><p className="agent-profile-note">{draft.members.length < 2 ? '请先创建至少两位助手，再添加成员。' : `当前 ${draft.members.length} 位成员，${draft.members.filter((member) => member.role === 'director').length} 位统筹。`}</p></fieldset>
        <SaveFeedback error={save.error ?? archive.error} success={success} /><div className="agent-profile-actions"><Button disabled={!dirty || !draft.name.trim() || draft.members.length < 2 || draft.members.filter((member) => member.role === 'director').length !== 1 || archive.isPending} loading={save.isPending} type="submit" variant="primary"><Save aria-hidden="true" className="size-3.5" />保存团队</Button>{selected ? <><Button disabled={busy} onClick={() => { if (confirmDiscard(dirty)) void teams.refetch().then((result) => { const latest = result.data?.find((team) => team.id === selected.id); if (latest) load(latest) }) }} type="button"><RefreshCw aria-hidden="true" className="size-3.5" />重新载入</Button><Button disabled={busy} onClick={() => { if (window.confirm(`归档团队「${selected.name}」？已有运行和记录会保留。${dirty ? '\n未保存修改将被放弃。' : ''}`)) archive.mutate({ ...selected, revision: draft.expectedRevision ?? selected.revision }) }} type="button" variant="danger"><Archive aria-hidden="true" className="size-3.5" />归档团队</Button></> : null}<span className="agent-profile-note">{dirty ? '有未保存修改' : '已保存'}</span></div></form> : <EmptyState description="创建团队并定义成员角色。在 Agent 页面启动团队任务并查看各成员运行。" title="把研究与复核分给不同助手" />}
    </div>{!draft ? <SaveFeedback error={archive.error} success={success} /> : null}
  </ResearchPanel>
}

export function TeamRunPanel({ selectedRunId, onSelectRun, onOpenChild }: { selectedRunId: string | null; onSelectRun: (id: string) => void; onOpenChild: (id: string) => void }): React.JSX.Element {
  const queryClient = useQueryClient()
  const runs = useQuery({ queryKey: agentProfileQueryKeys.teamRuns, queryFn: () => getWorkbenchApi().agentTeams.runs.list({ limit: 30 }), refetchInterval: (query) => (query.state.data ?? []).some((run) => ['queued', 'running'].includes(run.status)) ? 1_000 : false })
  const selected = useQuery({ queryKey: [...agentProfileQueryKeys.teamRuns, selectedRunId], queryFn: () => getWorkbenchApi().agentTeams.runs.get(selectedRunId!), enabled: Boolean(selectedRunId), refetchInterval: (query) => query.state.data && ['queued', 'running'].includes(query.state.data.status) ? 1_000 : false })
  const active = selected.data ?? (runs.data ?? []).find((run) => run.id === selectedRunId)
  const cancel = useMutation({ mutationFn: () => { if (!active) throw new Error('请先选择团队运行。'); return getWorkbenchApi().agentTeams.runs.cancel({ id: active.id, expectedRevision: active.revision }) }, onSuccess: async (result) => { queryClient.setQueryData([...agentProfileQueryKeys.teamRuns, result.id], result); await queryClient.invalidateQueries({ queryKey: agentProfileQueryKeys.teamRuns }) }, onError: () => { void queryClient.invalidateQueries({ queryKey: agentProfileQueryKeys.teamRuns }) } })
  return <section aria-label="团队运行" className="agent-team-runs"><header><h2>团队运行</h2><span>仅只读编排 · 应用存活期间执行</span></header>{runs.isLoading ? <PanelSkeleton lines={3} /> : null}{runs.error ? <ErrorState compact error={runs.error} onRetry={() => void runs.refetch()} /> : null}
    <div className="agent-team-run-list">{(runs.data ?? []).map((run) => <button aria-pressed={run.id === selectedRunId} className={cn('agent-profile-row', run.id === selectedRunId && 'agent-profile-row-active')} key={run.id} onClick={() => { onSelectRun(run.id); cancel.reset() }} type="button"><span><strong>{run.snapshot.team.name}</strong><small>{run.instructions.slice(0, 100)}</small></span><StatusBadge status={run.status} /></button>)}{!runs.isLoading && !runs.error && runs.data?.length === 0 ? <p className="agent-profile-note">还没有团队运行。选择团队并发送任务即可开始。</p> : null}</div>
    {selected.error ? <ErrorState compact error={selected.error} onRetry={() => void selected.refetch()} /> : null}
    {active ? <article className="agent-team-run-detail"><div className="agent-profile-actions"><h3>{active.snapshot.team.name}</h3><StatusBadge status={active.status} />{['queued', 'running'].includes(active.status) ? <Button loading={cancel.isPending} onClick={() => cancel.mutate()} size="sm" variant="danger">停止团队运行</Button> : null}</div><p className="agent-profile-note">{active.childRunIds.length} / {active.snapshot.team.maxSteps} 个成员步骤 · 配置快照修订 {active.snapshot.team.revision}</p><p className="agent-team-run-prompt">{active.instructions}</p><div className="agent-team-child-links">{active.childRunIds.map((id, index) => <Button key={id} onClick={() => onOpenChild(id)} size="sm">查看成员运行 {index + 1}</Button>)}</div>{active.output ? <pre className="agent-team-run-output">{active.output}</pre> : null}{active.error ? <p className="form-feedback form-feedback-error" role="alert">{active.error}</p> : null}<MutationFeedback error={cancel.error} /></article> : null}
  </section>
}
