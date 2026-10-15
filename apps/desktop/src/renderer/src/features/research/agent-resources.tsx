import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AgentInstructionSkillSaveInputSchema, AgentMcpServerSaveInputSchema, type AgentInstructionSkill, type AgentInstructionSkillSaveInput, type AgentMcpServer, type AgentMcpServerSaveInput } from '@prw/contracts'
import { useEffect, useId, useState } from 'react'
import { EmptyState, ErrorState, PanelSkeleton } from '../../components/states'
import { Button, Field, Input, Textarea } from '../../components/ui'
import { getErrorMessage } from '../../lib/utils'
import { getWorkbenchApi } from '../../lib/workbench'
import { ResearchPanel } from './shared'

type DirtyProps = { onDirtyChange?: (dirty: boolean) => void }
const resourceKeys = { servers: ['agent-mcp-servers'], skills: ['agent-instruction-skills'] } as const
const discard = (dirty: boolean): boolean => !dirty || window.confirm('当前资源修改尚未保存。放弃修改并切换？')

function useResourceDirty(dirty: boolean, onDirtyChange: DirtyProps['onDirtyChange']): void {
  useEffect(() => {
    onDirtyChange?.(dirty)
    const beforeUnload = (event: BeforeUnloadEvent): void => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', beforeUnload)
    return () => { window.removeEventListener('beforeunload', beforeUnload); onDirtyChange?.(false) }
  }, [dirty, onDirtyChange])
}

function serverDraft(server: AgentMcpServer): AgentMcpServerSaveInput {
  return { id: server.id, name: server.name, transport: server.transport, endpoint: server.endpoint, enabled: server.enabled, expectedRevision: server.revision }
}
function skillDraft(skill: AgentInstructionSkill): AgentInstructionSkillSaveInput {
  return { id: skill.id, name: skill.name, description: skill.description, markdown: skill.markdown, enabled: skill.enabled, expectedRevision: skill.revision, confirmed: true }
}

function ResourceFeedback({ error, success }: { error: unknown; success: string }): React.JSX.Element | null {
  if (error) return <p className="form-feedback form-feedback-error" role="alert">{getErrorMessage(error)} 未保存草稿仍保留；发生修订冲突时请重新载入。</p>
  return success ? <p className="form-feedback form-feedback-success" role="status">{success}</p> : null
}

export function McpServerManager({ onDirtyChange }: DirtyProps): React.JSX.Element {
  const client = useQueryClient()
  const query = useQuery({ queryKey: resourceKeys.servers, queryFn: () => getWorkbenchApi().agentMcpServers.list() })
  const [saved, setSaved] = useState<AgentMcpServer | null>(null)
  const [draft, setDraft] = useState<AgentMcpServerSaveInput | null>(null)
  const [baseline, setBaseline] = useState('')
  const [token, setToken] = useState('')
  const [success, setSuccess] = useState('')
  const id = useId()
  const configDirty = draft !== null && JSON.stringify(draft) !== baseline
  const dirty = configDirty || token.length > 0
  useResourceDirty(dirty, onDirtyChange)
  const load = (server: AgentMcpServer): void => {
    const next = serverDraft(server)
    setSaved(server); setDraft(next); setBaseline(JSON.stringify(next)); setToken(''); setSuccess('')
  }
  const invalidate = async (): Promise<void> => {
    await Promise.all([resourceKeys.servers, ['agent-bindings'], ['agent-binding-matrix'], ['agent-mcp-calls']].map((queryKey) => client.invalidateQueries({ queryKey })))
  }
  const mutation = useMutation({
    mutationFn: async (action: 'save' | 'probe' | 'credential' | 'clearCredential' | 'remove') => {
      if (!draft) throw new Error('请选择 MCP 服务器。')
      const api = getWorkbenchApi().agentMcpServers
      if (action === 'save') return api.save(AgentMcpServerSaveInputSchema.parse(draft))
      if (!saved || configDirty) throw new Error('请先保存服务器配置。')
      const revision = { id: saved.id, expectedRevision: saved.revision }
      if (action === 'remove') { await api.remove({ ...revision, confirmed: true }); return null }
      if (action === 'probe') return api.probe(revision)
      // Tokens only travel through the dedicated write-only credential IPC.
      const secret = action === 'credential' ? token : null
      setToken('')
      try { return await api.setCredential({ ...revision, token: secret }) }
      catch { throw new Error('凭据操作未完成，请重新载入服务器状态后重试；凭据不会回显。') }
    },
    onSuccess: async (server, action) => {
      if (server) load(server)
      else { setSaved(null); setDraft(null); setBaseline(''); setToken('') }
      setSuccess(action === 'save' ? '服务器配置已保存；旧凭据与探测已失效，请按需重新保存 Bearer 凭据并探测。'
        : action === 'probe' ? server?.lastProbe?.status === 'ok' ? 'MCP 探测通过；工具目录已更新，调用仍需逐次确认。' : 'MCP 探测失败，未标记为已连接。请检查下方诊断。'
          : action === 'remove' ? '服务器已删除；历史记录保留，失效绑定只允许移除。' : '凭据状态已更新；请重新探测，输入已清空且不会回显。')
      await invalidate()
    }
  })
  const busy = mutation.isPending
  const change = (fields: Partial<AgentMcpServerSaveInput>): void => { if (draft) { setDraft({ ...draft, ...fields }); setSuccess('') } }
  const refresh = async (): Promise<void> => {
    if (!discard(dirty)) return
    const result = await query.refetch()
    if (result.data) { const latest = result.data.find((entry) => entry.id === draft?.id); if (latest) load(latest); else { setSaved(null); setDraft(null); setBaseline(''); setToken('') }; mutation.reset() }
  }
  return <ResearchPanel eyebrow="MCP / THIRD-PARTY HTTP" title="第三方 MCP 服务器">
    <div className="agent-resource-manager">
      <p className="agent-profile-note">支持 Streamable HTTP（HTTPS 或字面量回环 HTTP）；第三方 stdio MCP 暂不支持。不接受 command、args、env 或自定义 headers，仅可单独保存 Bearer 凭据。保存配置不等于连接。</p>
      <p className="agent-profile-note">第三方工具一律视为外部请求；仅允许写入请求的普通手动助手可绑定。只读助手、团队及定时任务不可使用；每次调用需在 Agent 页显式批准。</p>
      <div className="agent-profile-actions"><Button disabled={busy} onClick={() => { if (!discard(dirty)) return; const next: AgentMcpServerSaveInput = { id: `mcp.${crypto.randomUUID()}`, name: '', transport: 'streamable-http', endpoint: '', enabled: true, expectedRevision: null }; setSaved(null); setDraft(next); setBaseline(''); setToken(''); setSuccess(''); mutation.reset() }}>添加 MCP 服务器</Button><Button disabled={busy || query.isFetching} onClick={() => void refresh()}>重新载入服务器</Button></div>
      {query.isLoading ? <PanelSkeleton /> : null}{query.error ? <ErrorState compact error={query.error} onRetry={() => void refresh()} /> : null}
      <label className="agent-profile-picker">选择服务器<select aria-label="选择 MCP 服务器" className="select-control" disabled={busy} onChange={(event) => { if (!discard(dirty)) return; const server = query.data?.find((entry) => entry.id === event.target.value); if (server) { load(server); mutation.reset() } }} value={saved?.id ?? ''}><option value="">请选择服务器</option>{(query.data ?? []).map((server) => <option key={server.id} value={server.id}>{server.name}{server.enabled ? '' : '（已停用）'}</option>)}</select></label>
      {!query.isLoading && !query.error && query.data?.length === 0 && !draft ? <EmptyState title="尚未添加第三方 MCP" description="添加 HTTP 端点、保存并显式探测。不会自动启动外部程序。" /> : null}
      {draft ? <>
        <fieldset className="agent-resource-fields" disabled={busy}><legend>服务器配置 · {draft.expectedRevision === null ? '新建' : `r${draft.expectedRevision}`}</legend>
          <Field htmlFor={`${id}-server-id`} label="MCP 服务器 ID"><Input id={`${id}-server-id`} readOnly value={draft.id} /></Field>
          <Field htmlFor={`${id}-server-name`} label="MCP 服务器名称"><Input id={`${id}-server-name`} maxLength={100} onChange={(event) => change({ name: event.target.value })} value={draft.name} /></Field>
          <Field htmlFor={`${id}-endpoint`} label="MCP HTTP 端点" hint="禁止 URL 用户名、密码、query 和 fragment；不要在地址中填写凭据。"><Input autoComplete="off" id={`${id}-endpoint`} maxLength={2000} onChange={(event) => change({ endpoint: event.target.value })} placeholder="https://example.org/mcp" value={draft.endpoint} /></Field>
          <label className="agent-resource-checkbox"><input checked={draft.enabled} onChange={(event) => change({ enabled: event.target.checked })} type="checkbox" />启用 MCP 服务器</label>
        </fieldset>
        <p className="agent-profile-note">每次保存配置（包括启停）都会清空旧探测并失效旧凭据。请保存后重新设置凭据、探测，再在矩阵中授权。</p>
        <div className="agent-profile-actions"><Button disabled={busy || !configDirty} loading={busy && mutation.variables === 'save'} onClick={() => mutation.mutate('save')} variant="primary">保存 MCP 服务器</Button><Button disabled={busy || !saved || configDirty || token.length > 0 || !saved.enabled} loading={busy && mutation.variables === 'probe'} onClick={() => mutation.mutate('probe')}>探测 MCP 服务器</Button><Button disabled={busy || !saved || dirty} onClick={() => { if (window.confirm('删除此 MCP 服务器？历史调用仍保留，旧绑定不会自动转移至其他端点。')) mutation.mutate('remove') }} variant="danger">删除 MCP 服务器</Button></div>
        {saved ? <section aria-label="MCP 已保存状态" className="agent-resource-status"><p>已保存：{saved.enabled ? '启用' : '停用'} · 凭据：{saved.credentialPresent ? '已保存（不回显）' : '未保存'}</p><p>探测：{saved.lastProbe ? saved.lastProbe.status === 'ok' ? '通过' : '失败' : '未探测'} · 工具 {saved.tools.length} 项</p>{saved.lastProbe ? <p>探测时间：{saved.lastProbe.checkedAt}{saved.lastProbe.diagnosticCode ? ` · ${saved.lastProbe.diagnosticCode}` : ''}</p> : null}
          <details><summary>已探测工具（不自动授权）</summary>{saved.tools.length ? <ul>{saved.tools.map((tool) => <li key={tool.key}><strong>{tool.name}</strong><code>{tool.key}</code><p>{tool.description}</p></li>)}</ul> : <p>没有已确认工具。</p>}</details>
          <fieldset className="agent-resource-fields" disabled={busy || configDirty}><legend>Bearer 凭据 · 仅写入本机 safeStorage</legend><Field htmlFor={`${id}-token`} label="MCP Bearer Token" hint="不支持自定义 headers。留空不会修改；保存或清除凭据会使探测失效。"><Input autoComplete="new-password" id={`${id}-token`} maxLength={8192} onChange={(event) => setToken(event.target.value)} spellCheck={false} type="password" value={token} /></Field><div className="agent-profile-actions"><Button disabled={!token.trim() || busy} onClick={() => mutation.mutate('credential')}>保存 MCP 凭据</Button><Button disabled={busy || !saved.credentialPresent || token.length > 0} onClick={() => { if (window.confirm('清除此服务器的 Bearer 凭据并使探测失效？')) mutation.mutate('clearCredential') }}>清除 MCP 凭据</Button></div></fieldset>
        </section> : null}
      </> : null}
      <ResourceFeedback error={mutation.error} success={success} />
    </div>
  </ResearchPanel>
}

export function InstructionSkillManager({ onDirtyChange }: DirtyProps): React.JSX.Element {
  const client = useQueryClient()
  const query = useQuery({ queryKey: resourceKeys.skills, queryFn: () => getWorkbenchApi().agentInstructionSkills.list() })
  const [saved, setSaved] = useState<AgentInstructionSkill | null>(null)
  const [draft, setDraft] = useState<AgentInstructionSkillSaveInput | null>(null)
  const [baseline, setBaseline] = useState('')
  const [success, setSuccess] = useState('')
  const id = useId()
  const dirty = draft !== null && JSON.stringify(draft) !== baseline
  useResourceDirty(dirty, onDirtyChange)
  const load = (skill: AgentInstructionSkill): void => { const next = skillDraft(skill); setSaved(skill); setDraft(next); setBaseline(JSON.stringify(next)); setSuccess('') }
  const mutation = useMutation({
    mutationFn: async (action: 'save' | 'remove') => {
      if (!draft) throw new Error('请选择指令技能。')
      if (action === 'save') return getWorkbenchApi().agentInstructionSkills.save(AgentInstructionSkillSaveInputSchema.parse(draft))
      if (!saved) throw new Error('请先保存技能。')
      await getWorkbenchApi().agentInstructionSkills.remove({ id: saved.id, expectedRevision: saved.revision, confirmed: true }); return null
    },
    onSuccess: async (skill) => {
      const changedContent = Boolean(skill && saved && skill.contentHash !== saved.contentHash)
      if (skill) load(skill); else { setSaved(null); setDraft(null); setBaseline('') }
      setSuccess(skill ? changedContent ? '技能内容已更新；旧助手绑定已清除并更新修订号，请到矩阵重新授权。' : '指令技能已保存到 SQLite；不会安装代码，绑定后下次运行生效。' : '指令技能已删除；历史运行快照仍保留。')
      await Promise.all([resourceKeys.skills, ['agent-assistants'], ['agent-bindings'], ['agent-binding-matrix']].map((queryKey) => client.invalidateQueries({ queryKey })))
    }
  })
  const busy = mutation.isPending
  const change = (fields: Partial<AgentInstructionSkillSaveInput>): void => { if (draft) { setDraft({ ...draft, ...fields }); setSuccess('') } }
  const refresh = async (): Promise<void> => {
    if (!discard(dirty)) return
    const result = await query.refetch()
    if (result.data) { const latest = result.data.find((entry) => entry.id === draft?.id); if (latest) load(latest); else { setSaved(null); setDraft(null); setBaseline('') }; mutation.reset() }
  }
  return <ResearchPanel eyebrow="SKILLS / MANAGED INSTRUCTIONS" title="指令技能安装与编辑"><div className="agent-resource-manager">
    <p className="agent-profile-note">只安装受限的 SKILL.md 指令文本，保存在工作台 SQLite，作为 prompt 注入；不创建文件镜像，不安装脚本、依赖或外部引擎，不接受任意路径或压缩包。内置技能保留原安装来源，不在此编辑。</p>
    <p className="agent-profile-note">修改内容会原子清除所有旧助手绑定并更新助手修订号，必须重新授权。启用不会自动重新绑定；历史运行快照不变。</p>
    <div className="agent-profile-actions"><Button disabled={busy} onClick={() => { if (!discard(dirty)) return; setSaved(null); setDraft({ id: `skill.user.${crypto.randomUUID()}`, name: '', description: '', markdown: '', enabled: true, expectedRevision: null, confirmed: true }); setBaseline(''); setSuccess(''); mutation.reset() }}>安装指令技能</Button><Button disabled={busy || query.isFetching} onClick={() => void refresh()}>重新载入技能</Button></div>
    {query.isLoading ? <PanelSkeleton /> : null}{query.error ? <ErrorState compact error={query.error} onRetry={() => void refresh()} /> : null}
    <label className="agent-profile-picker">选择技能<select aria-label="选择指令技能" className="select-control" disabled={busy} onChange={(event) => { if (!discard(dirty)) return; const skill = query.data?.find((entry) => entry.id === event.target.value); if (skill) { load(skill); mutation.reset() } }} value={saved?.id ?? ''}><option value="">请选择技能</option>{(query.data ?? []).map((skill) => <option key={skill.id} value={skill.id}>{skill.name}{skill.enabled ? '' : '（已停用）'}</option>)}</select></label>
    {!query.isLoading && !query.error && query.data?.length === 0 && !draft ? <EmptyState title="尚无自定义指令技能" description="粘贴技能指令文本以安装。不会运行安装脚本。" /> : null}
    {draft ? <>
      <fieldset className="agent-resource-fields" disabled={busy}><legend>技能指令 · {draft.expectedRevision === null ? '新建' : `r${draft.expectedRevision}`}</legend>
        <Field htmlFor={`${id}-skill-id`} label="指令技能 ID" hint="稳定标识必须以 skill.user. 开头，仅新建时可修改。"><Input disabled={saved !== null} id={`${id}-skill-id`} maxLength={60} onChange={(event) => change({ id: event.target.value })} value={draft.id} /></Field>
        <Field htmlFor={`${id}-skill-name`} label="指令技能名称"><Input id={`${id}-skill-name`} maxLength={100} onChange={(event) => change({ name: event.target.value })} value={draft.name} /></Field>
        <Field htmlFor={`${id}-skill-description`} label="指令技能说明"><Textarea id={`${id}-skill-description`} maxLength={1000} onChange={(event) => change({ description: event.target.value })} value={draft.description} /></Field>
        <Field htmlFor={`${id}-markdown`} label="SKILL.md 指令文本" hint="20–50000 字符。技能是待审查指令，不授予任何工具或外部写入权限。"><Textarea className="agent-resource-markdown" id={`${id}-markdown`} maxLength={50000} onChange={(event) => change({ markdown: event.target.value })} spellCheck={false} value={draft.markdown} /></Field>
        <label className="agent-resource-checkbox"><input checked={draft.enabled} onChange={(event) => change({ enabled: event.target.checked })} type="checkbox" />启用指令技能</label>
      </fieldset>
      <details className="agent-resource-preview"><summary>预览指令原文（不执行 HTML 或代码）</summary><pre>{draft.markdown || '尚未输入指令。'}</pre></details>
      {saved ? <p className="agent-profile-note">已保存内容 SHA256：<code>{saved.contentHash}</code> · {saved.enabled ? '启用' : '停用'}</p> : null}
      <div className="agent-profile-actions"><Button disabled={busy || !dirty} loading={busy && mutation.variables === 'save'} onClick={() => { if (window.confirm('已审阅此技能的完整指令文本并确认保存？绑定后这些指令会发送给模型；内容修改将清除所有旧助手绑定，需重新授权。不会安装或执行脚本。')) mutation.mutate('save') }} variant="primary">已审阅，保存指令技能</Button><Button disabled={busy || !saved || dirty} onClick={() => { if (window.confirm('删除此指令技能？不能继续用于新运行，历史快照不会删除。')) mutation.mutate('remove') }} variant="danger">删除指令技能</Button></div>
    </> : null}
    <ResourceFeedback error={mutation.error} success={success} />
  </div></ResearchPanel>
}
