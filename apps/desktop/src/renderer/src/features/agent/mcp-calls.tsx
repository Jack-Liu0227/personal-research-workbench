import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentMcpCall, AgentMcpCallDecideInput, AgentRunRecord } from '@prw/contracts'
import { useEffect, useState } from 'react'
import { Button } from '../../components/ui'
import { getErrorMessage } from '../../lib/utils'
import { getWorkbenchApi } from '../../lib/workbench'

const statusLabels: Record<AgentMcpCall['status'], string> = {
  pending: '等待显式确认', executing: '执行中', completed: '已完成', failed: '失败', rejected: '已拒绝', invalidated: '已失效'
}

export function McpCallCards({ runs }: { runs: readonly AgentRunRecord[] }): React.JSX.Element | null {
  const client = useQueryClient()
  const [now, setNow] = useState(Date.now)
  const runIds = [...new Set(runs.map((run) => run.id))].sort()
  const queryKey = ['agent-mcp-calls', runIds] as const
  const query = useQuery({ queryKey, queryFn: async () => (await Promise.all(runIds.map((runId) => getWorkbenchApi().agentMcpCalls.list({ runId, limit: 100 })))).flat(), enabled: runs.length > 0, refetchInterval: runs.length > 0 ? 2_000 : false })
  const visible = (query.data ?? []).filter((call) => runs.some((run) => run.id === call.runId))
  useEffect(() => { if (!visible.some((call) => call.status === 'pending')) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [visible.some((call) => call.status === 'pending')])
  const decide = useMutation({
    mutationFn: (input: AgentMcpCallDecideInput) => getWorkbenchApi().agentMcpCalls.decide(input),
    onSuccess: (call) => client.setQueryData<AgentMcpCall[]>(queryKey, (current) => current?.map((entry) => entry.id === call.id ? call : entry)),
    onSettled: async () => { await Promise.all([['agent-mcp-calls'], ['agent-run-records'], ['agent-records']].map((queryKey) => client.invalidateQueries({ queryKey }))) }
  })
  if (runs.length === 0) return null
  if (query.error) return <div className="form-feedback form-feedback-error" role="alert">MCP 调用记录读取失败。<Button onClick={() => void query.refetch()} size="sm">重读 MCP 调用</Button></div>
  if (visible.length === 0) return null
  return <section aria-label="第三方 MCP 调用确认" className="agent-mcp-calls">
    <p className="agent-profile-note">第三方 MCP 可能读取或修改外部数据。Agent 只提交请求；批准才执行冻结端点、工具与参数，不会自动再次调用模型。已完成的运行仍可确认有效请求，失败或取消后不可执行。</p>
    {visible.map((call) => {
      const run = runs.find((entry) => entry.id === call.runId)
      const expired = Date.parse(call.expiresAt) <= now
      const runInvalid = !run || !['running', 'waiting_confirmation', 'completed'].includes(run.status)
      const open = call.status === 'pending' && !expired && !runInvalid
      const busy = decide.isPending
      return <article aria-label={`MCP 调用 ${call.toolName}`} className="agent-mcp-call" data-call-id={call.id} key={call.id}>
        <header><h3>{call.toolName}</h3><span role="status">{call.status === 'pending' && (expired || runInvalid) ? expired ? '已过期，不能执行' : '运行已失效，不能执行' : statusLabels[call.status]}</span></header>
        <dl><dt>冻结目标</dt><dd>{call.endpoint}</dd><dt>服务器与修订</dt><dd>{call.serverId} · r{call.serverRevision}</dd><dt>工具 key</dt><dd>{call.toolKey}</dd><dt>助手 / 运行</dt><dd>{call.assistantId} / {call.runId}</dd><dt>有效期至</dt><dd>{call.expiresAt}</dd></dl>
        <details open><summary>冻结调用参数</summary><pre aria-label="MCP 冻结参数">{call.argumentsJson}</pre></details>
        <details><summary>审批指纹</summary><p>参数 SHA256：{call.argsHash}</p><p>Schema SHA256：{call.schemaHash}</p></details>
        {call.result ? <details open><summary>实际调用结果</summary><pre aria-label="MCP 调用结果">{call.result}</pre></details> : null}
        {call.error ? <p className="form-feedback form-feedback-error" role="alert">{call.error}</p> : null}
        {decide.error && decide.variables?.id === call.id ? <p className="form-feedback form-feedback-error" role="alert">{getErrorMessage(decide.error)} 请重读状态，不会自动重试外部调用。</p> : null}
        {call.status === 'pending' ? <div className="agent-profile-actions"><Button disabled={busy || !open} loading={busy && decide.variables?.id === call.id && decide.variables.decision === 'approve'} onClick={() => { if (window.confirm(`确认执行第三方 MCP 工具「${call.toolName}」？\n目标：${call.endpoint}\n请先审阅卡片中的冻结参数；此操作可能写入外部数据，已发生的远端副作用不能撤销。`)) decide.mutate({ id: call.id, expectedRevision: call.revision, decision: 'approve', confirmed: true }) }} variant="primary">批准 MCP 调用</Button><Button disabled={busy || !open} onClick={() => { if (window.confirm('拒绝此 MCP 调用？不会发送到第三方服务器。')) decide.mutate({ id: call.id, expectedRevision: call.revision, decision: 'reject', confirmed: true }) }}>拒绝 MCP 调用</Button></div> : null}
      </article>
    })}
  </section>
}
