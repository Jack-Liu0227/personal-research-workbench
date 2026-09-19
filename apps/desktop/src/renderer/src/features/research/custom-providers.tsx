import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, ListPlus, Plus, Radar, RefreshCw, Save, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  customProviderIdIssue,
  customProviderUrlIssue,
  type AgentCustomProvider,
  type AgentCustomProviderApi,
  type AgentCustomProviderModel,
  type AgentCustomProviders,
  type AgentModelDiscoveryResult
} from '@prw/contracts'
import { ErrorState, LoadingState } from '../../components/states'
import { Button, Field, Input } from '../../components/ui'
import {
  adoptDiscoveredModels,
  discoveryRequestIssue,
  isDiscoveryStale,
  pendingDiscoveredModels
} from '../../lib/model-discovery'
import { formatDateTime, getErrorMessage } from '../../lib/utils'
import { getWorkbenchAgentApi } from '../../lib/workbench'

const customProvidersQueryKey = ['agent-custom-providers'] as const
const credentialStatusQueryKey = ['agent-credential-status'] as const
const modelCatalogQueryKey = ['agent-model-catalog'] as const

/** One editable provider plus the identity React needs for its DOM nodes.
 *
 * Rows are keyed by a local id rather than by the provider id: the id is typed
 * by the user (and re-minted by the presets), so keying the subtree on it
 * remounted the inputs on every keystroke and dropped focus mid-edit. */
interface DraftRow {
  readonly rowId: string
  readonly provider: AgentCustomProvider
}

/** One endpoint's answer. It lives in component state until the user adopts
 * part of it; `selected` holds the discovered model ids that are ticked. */
interface DiscoveryState {
  readonly result: AgentModelDiscoveryResult
  readonly selected: readonly string[]
}

let rowSequence = 0
function nextRowId(): string {
  rowSequence += 1
  return `provider-row-${rowSequence}`
}

const apiLabels: Record<AgentCustomProviderApi, string> = {
  'openai-completions': 'OpenAI 兼容 · /chat/completions',
  'openai-responses': 'OpenAI · /responses',
  'anthropic-messages': 'Anthropic · /messages',
  'google-generative-ai': 'Google · generateContent'
}

/**
 * Starting points for the protocols a local server or gateway speaks.
 *
 * Only the protocol and endpoint are filled in; model ids are left to the user
 * on purpose. A hardcoded model list would be stale within weeks, and a wrong
 * id fails at request time with a vendor error instead of in the editor.
 */
const providerPresets: readonly { label: string; name: string; api: AgentCustomProviderApi; baseUrl: string; hint: string }[] = [
  { label: 'OpenAI（Responses API）', name: 'OpenAI', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', hint: 'gpt-5 系列走 /responses。' },
  { label: 'OpenAI 兼容服务', name: 'OpenAI 兼容', api: 'openai-completions', baseUrl: 'http://127.0.0.1:11434/v1', hint: 'Ollama / vLLM / LM Studio / DeepSeek 等；本地地址允许 HTTP。' },
  { label: 'Anthropic', name: 'Anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1', hint: 'Claude 官方 /messages。' },
  { label: 'Google Gemini', name: 'Gemini', api: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', hint: 'Gemini generateContent。' }
]

/**
 * Editor for the app-owned `models.json`.
 *
 * The file is the SDK's own configuration input, which is why adding a provider
 * here has the same effect as adding it to Pi's `models.json` by hand: there is
 * one vocabulary, and the file stays usable outside this app.
 *
 * Three behaviours are deliberate:
 *
 *  - the whole set is sent on save. A provider removed in the UI has to be
 *    removed from the file, otherwise "删除" would only hide it;
 *  - the key is never part of this file. It goes to safeStorage under the
 *    provider id, so the id of a saved provider is read-only — renaming it would
 *    silently orphan the stored credential;
 *  - a file the app cannot fully represent is shown, not rewritten. Hand-written
 *    fields survive, and a broken file is reported with its path instead of
 *    being replaced by whatever the UI happens to hold;
 *  - discovery is a read. The probe's answer is rendered as candidates and stays
 *    in component state: a model enters the draft only when the user adopts it,
 *    and the file only when the user then saves.
 *
 * The file's location is not configurable here: it stays
 * `<userData>/data/agent-runtime/pi/models.json`, derived from the database
 * directory by the host.
 */
export function CustomProviderSection(): React.JSX.Element {
  const queryClient = useQueryClient()
  const snapshotQuery = useQuery({ queryKey: customProvidersQueryKey, queryFn: () => getWorkbenchAgentApi().models.customProviders.get() })
  // The same vault-status query the credential list uses, so both surfaces
  // agree on whether a key exists. It carries a boolean, never the key.
  const statusQuery = useQuery({ queryKey: credentialStatusQueryKey, queryFn: () => getWorkbenchAgentApi().credentials.status() })
  const [draft, setDraft] = useState<DraftRow[] | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [rowFeedback, setRowFeedback] = useState<Record<string, string | null>>({})
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [discoveries, setDiscoveries] = useState<Record<string, DiscoveryState>>({})

  const snapshot: AgentCustomProviders | null = snapshotQuery.data ?? null
  useEffect(() => {
    if (!snapshot || draft !== null) return
    setDraft(snapshot.providers.map((provider) => ({ rowId: nextRowId(), provider })))
  }, [snapshot, draft])

  const setRowStatus = (rowId: string, message: string | null): void => {
    setRowFeedback((current) => ({ ...current, [rowId]: message }))
  }

  const forgetDiscovery = (rowId: string): void => {
    setDiscoveries((current) => {
      const next = { ...current }
      delete next[rowId]
      return next
    })
  }

  const save = useMutation({
    mutationFn: (providers: AgentCustomProvider[]) => getWorkbenchAgentApi().models.customProviders.save({ providers }),
    onSuccess: (saved) => {
      queryClient.setQueryData(customProvidersQueryKey, saved)
      setDraft(saved.providers.map((provider) => ({ rowId: nextRowId(), provider })))
      setDiscoveries({})
      setFeedback(saved.configError ? null : '自定义 Provider 已写入 models.json。')
      // The catalog is what the rest of Settings lists, so a new provider has to
      // appear there (and in the credential list) without a reload.
      void queryClient.invalidateQueries({ queryKey: ['agent-model-catalog'] })
      void queryClient.invalidateQueries({ queryKey: ['agent-credential-status'] })
    },
    onError: (error) => setFeedback(getErrorMessage(error))
  })

  // One provider's key, written by Main into safeStorage. The reply is the
  // status list, so the value never travels back to the renderer.
  const saveKey = useMutation({
    mutationFn: (input: { rowId: string; provider: string; apiKey: string | null }) =>
      getWorkbenchAgentApi().credentials.save({ provider: input.provider, apiKey: input.apiKey }),
    onSuccess: (statuses, input) => {
      queryClient.setQueryData(credentialStatusQueryKey, statuses)
      setKeyDrafts((current) => ({ ...current, [input.rowId]: '' }))
      setRowStatus(input.rowId, input.apiKey === null
        ? `已清除 "${input.provider}" 的凭据。`
        : `"${input.provider}" 的 API Key 已存入本机 safeStorage，页面不回显密钥。`)
      void queryClient.invalidateQueries({ queryKey: modelCatalogQueryKey })
    },
    onError: (error, input) => setRowStatus(input.rowId, getErrorMessage(error))
  })

  // Read-only probe of the endpoint the form currently holds — including values
  // that are not saved yet. The reply is a candidate list, not a decision.
  const detect = useMutation({
    mutationFn: (input: { rowId: string; provider: AgentCustomProvider }) => getWorkbenchAgentApi().models.customProviders.discover({
      provider: input.provider.id.trim(),
      baseUrl: input.provider.baseUrl.trim(),
      api: input.provider.api
    }),
    onSuccess: (result, input) => {
      setDiscoveries((current) => ({
        ...current,
        [input.rowId]: { result, selected: pendingDiscoveredModels(input.provider, result).map((model) => model.id) }
      }))
      setRowStatus(input.rowId, result.models.length === 0
        ? '端点没有返回任何模型：请确认协议与 Base URL 指向同一个服务。'
        : `发现 ${result.models.length} 个模型。它们只是候选项，选中后仍需点“保存 models.json”才会写入文件。`)
    },
    onError: (error, input) => {
      forgetDiscovery(input.rowId)
      setRowStatus(input.rowId, getErrorMessage(error))
    }
  })

  if (snapshotQuery.isLoading) return <LoadingState label="正在读取自定义 Provider 配置…" />
  if (snapshotQuery.error) return <ErrorState error={snapshotQuery.error} onRetry={() => void snapshotQuery.refetch()} />
  if (!snapshot || draft === null) return <LoadingState label="正在准备自定义 Provider 表单…" />

  const issues = draft.flatMap((row, index) => providerIssues(row.provider, index))
  const dirty = JSON.stringify(draft.map((row) => row.provider)) !== JSON.stringify(snapshot.providers)
  const statuses = statusQuery.data ?? []

  const reload = async (): Promise<void> => {
    const result = await snapshotQuery.refetch()
    if (result.data) {
      setDraft(result.data.providers.map((provider) => ({ rowId: nextRowId(), provider })))
      setDiscoveries({})
      setFeedback('已从磁盘重新读取 models.json。')
    }
  }

  const update = (index: number, patch: Partial<AgentCustomProvider>): void => {
    setDraft((current) => current?.map((row, position) => position === index ? { ...row, provider: { ...row.provider, ...patch } } : row) ?? current)
  }

  const updateModel = (providerIndex: number, modelIndex: number, patch: Partial<AgentCustomProviderModel>): void => {
    setDraft((current) => current?.map((row, position) => position === providerIndex
      ? { ...row, provider: { ...row.provider, models: row.provider.models.map((model, modelPosition) => modelPosition === modelIndex ? { ...model, ...patch } : model) } }
      : row) ?? current)
  }

  return <div className="mt-4 rounded-lg border border-border p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <p className="text-sm font-semibold text-foreground">自定义 Provider（models.json）</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">在这里添加自己的模型服务，等价于直接编辑 Pi 的 models.json。共 {draft.length} 个，文件路径 <code className="break-all">{snapshot.path}</code>。Base URL 与模型 id 是唯一的必填项，密钥仍然保存在 safeStorage。</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!dirty || issues.length > 0} loading={save.isPending} onClick={() => save.mutate(draft.map((row) => row.provider))} size="sm" variant="primary"><Save aria-hidden="true" className="size-3.5" />保存 models.json</Button>
        {/* The file is meant to be hand-editable, so a reload must exist; it is
            disabled while there are unsaved edits so it cannot silently
            discard them. */}
        <Button disabled={dirty} loading={snapshotQuery.isFetching} onClick={() => void reload()} size="sm" title={dirty ? '先保存或放弃当前修改' : '从磁盘重新读取'} variant="secondary"><RefreshCw aria-hidden="true" className="size-3.5" />重新读取</Button>
      </div>
    </div>

    {snapshot.configError ? <p className="mt-3 rounded-md border border-danger/40 bg-danger/5 p-2 text-xs text-danger" role="alert">Pi 当前无法使用该文件：{snapshot.configError}</p> : null}

    {snapshot.unmanaged.length > 0 ? <p className="mt-3 text-xs leading-5 text-muted-foreground">以下条目包含本页不管理的字段（如 headers / compat / modelOverrides，或非本机 HTTP 地址），因此按原样保留、不在此处编辑：<code className="break-all">{snapshot.unmanaged.join(', ')}</code></p> : null}

    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold text-muted-foreground">快速添加</span>
      {providerPresets.map((preset) => <Button key={preset.label} onClick={() => { setFeedback(null); setDraft((current) => [...(current ?? []), { rowId: nextRowId(), provider: createProvider(preset, (current ?? []).map((row) => row.provider)) }]) }} size="sm" title={preset.hint} variant="secondary">{preset.label}</Button>)}
    </div>

    {draft.length === 0 ? <p className="mt-3 text-xs text-muted-foreground">还没有自定义 Provider。上面的按钮会填入协议与默认地址，再补充模型 id，或先保存密钥后点“发现模型”让端点自己回答。</p> : null}

    {draft.map((row, providerIndex) => {
      // The key belongs to the provider id, so the status has to be looked up by
      // that id — a row being edited is simply “not stored” until it matches.
      const keyStored = statuses.find((entry) => entry.provider === row.provider.id.trim())?.credentialPresent === true
      const discovery = discoveries[row.rowId] ?? null
      return <ProviderRow
        discoverBusy={detect.isPending && detect.variables?.rowId === row.rowId}
        discovery={discovery}
        index={providerIndex}
        key={row.rowId}
        keyBusy={saveKey.isPending && saveKey.variables?.rowId === row.rowId}
        keyDraft={keyDrafts[row.rowId] ?? ''}
        keyStored={keyStored}
        onAddModel={() => update(providerIndex, { models: [...row.provider.models, createModel()] })}
        onAdoptSelected={() => {
          if (!discovery) return
          const adopted = adoptDiscoveredModels(row.provider, discovery.result, discovery.selected)
          if (adopted.added > 0) update(providerIndex, { models: adopted.provider.models })
          forgetDiscovery(row.rowId)
          setRowStatus(row.rowId, adopted.added > 0
            ? `已把 ${adopted.added} 个模型加入草稿，点“保存 models.json”后写入文件。`
            : '没有新增模型：选中的条目已经在列表里。')
        }}
        onClearKey={() => saveKey.mutate({ rowId: row.rowId, provider: row.provider.id.trim(), apiKey: null })}
        onDiscardDiscovery={() => { forgetDiscovery(row.rowId); setRowStatus(row.rowId, '已放弃本次发现结果，未写入任何内容。') }}
        onDiscover={() => { setRowStatus(row.rowId, null); detect.mutate({ rowId: row.rowId, provider: row.provider }) }}
        onKeyDraftChange={(value) => setKeyDrafts((current) => ({ ...current, [row.rowId]: value }))}
        onRemove={() => { forgetDiscovery(row.rowId); setDraft((current) => current?.filter((_, position) => position !== providerIndex) ?? current) }}
        onRemoveModel={(modelIndex) => update(providerIndex, { models: row.provider.models.filter((_, position) => position !== modelIndex) })}
        onSaveKey={() => saveKey.mutate({ rowId: row.rowId, provider: row.provider.id.trim(), apiKey: (keyDrafts[row.rowId] ?? '').trim() })}
        onSelectAllDiscovered={(selected) => setDiscoveries((current) => {
          const entry = current[row.rowId]
          if (!entry) return current
          return { ...current, [row.rowId]: { ...entry, selected: selected ? entry.result.models.map((model) => model.id) : [] } }
        })}
        onToggleDiscovered={(modelId) => setDiscoveries((current) => {
          const entry = current[row.rowId]
          if (!entry) return current
          const selected = entry.selected.includes(modelId)
            ? entry.selected.filter((id) => id !== modelId)
            : [...entry.selected, modelId]
          return { ...current, [row.rowId]: { ...entry, selected } }
        })}
        onUpdate={(patch) => update(providerIndex, patch)}
        onUpdateModel={(modelIndex, patch) => updateModel(providerIndex, modelIndex, patch)}
        provider={row.provider}
        saved={snapshot.providers.some((entry) => entry.id === row.provider.id)}
        status={rowFeedback[row.rowId] ?? null}
      />
    })}

    {issues.length > 0 ? <ul className="mt-3 grid gap-1 text-xs text-danger" role="alert">
      {issues.map((issue) => <li key={issue}>{issue}</li>)}
    </ul> : null}
    {feedback ? <p aria-live="polite" className="form-feedback mt-3" role="status">{feedback}</p> : null}
  </div>
}

function ProviderRow({ discovery, discoverBusy, index, keyBusy, keyDraft, keyStored, onAddModel, onAdoptSelected, onClearKey, onDiscardDiscovery, onDiscover, onKeyDraftChange, onRemove, onRemoveModel, onSaveKey, onSelectAllDiscovered, onToggleDiscovered, onUpdate, onUpdateModel, provider, saved, status }: {
  index: number
  provider: AgentCustomProvider
  /** A saved provider's id is the credential-vault key, so it is fixed here to
   * keep the stored key reachable; delete and re-add to rename one. */
  saved: boolean
  /** Whether safeStorage holds a credential for this exact provider id. */
  keyStored: boolean
  /** The key being typed. Only ever sent to Main, never rendered back. */
  keyDraft: string
  keyBusy: boolean
  discoverBusy: boolean
  discovery: DiscoveryState | null
  /** Result of the last action on this row, or null. */
  status: string | null
  onUpdate: (patch: Partial<AgentCustomProvider>) => void
  onRemove: () => void
  onAddModel: () => void
  onRemoveModel: (modelIndex: number) => void
  onUpdateModel: (modelIndex: number, patch: Partial<AgentCustomProviderModel>) => void
  onKeyDraftChange: (value: string) => void
  onSaveKey: () => void
  onClearKey: () => void
  onDiscover: () => void
  onToggleDiscovered: (modelId: string) => void
  onSelectAllDiscovered: (selected: boolean) => void
  onAdoptSelected: () => void
  onDiscardDiscovery: () => void
}): React.JSX.Element {
  const idError = customProviderIdIssue(provider.id)
  const urlError = customProviderUrlIssue(provider.baseUrl)
  const inputId = `custom-provider-${index}`
  // The probe's preconditions are stated before the button, not discovered as
  // a 401: a remote endpoint without a stored key is already known to fail.
  const probeIssue = discoveryRequestIssue(provider, keyStored)
  const pending = discovery ? pendingDiscoveredModels(provider, discovery.result) : []
  const pendingIds = new Set(pending.map((model) => model.id))
  const selectedCount = discovery ? discovery.selected.filter((id) => pendingIds.has(id)).length : 0
  const stale = discovery ? isDiscoveryStale(discovery.result, provider) : false
  return <div className="mt-3 rounded-md border border-border bg-muted/20 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs font-semibold text-foreground">Provider {index + 1}{saved ? '（已保存）' : '（新增）'}</span>
      <Button onClick={onRemove} size="sm" variant="ghost"><Trash2 aria-hidden="true" className="size-3.5" />删除</Button>
    </div>
    <div className="settings-form-grid mt-2">
      <Field error={idError ?? undefined} hint={saved ? '已保存的 id 不可修改：凭据按 id 存于 safeStorage。' : '小写字母、数字、点、下划线、短横线。'} htmlFor={`${inputId}-id`} label="Provider id">
        <Input id={`${inputId}-id`} onChange={(event) => onUpdate({ id: event.target.value })} readOnly={saved} value={provider.id} />
      </Field>
      <Field hint="留空则显示 id。" htmlFor={`${inputId}-name`} label="显示名">
        <Input id={`${inputId}-name`} onChange={(event) => onUpdate({ name: event.target.value })} value={provider.name} />
      </Field>
      <Field error={urlError ?? undefined} hint="远程必须 HTTPS；本机 localhost/127.0.0.1 允许 HTTP。" htmlFor={`${inputId}-url`} label="Base URL">
        <Input id={`${inputId}-url`} onChange={(event) => onUpdate({ baseUrl: event.target.value })} value={provider.baseUrl} />
      </Field>
      <Field htmlFor={`${inputId}-api`} label="协议（api）">
        <select className="select-control" id={`${inputId}-api`} onChange={(event) => onUpdate({ api: event.target.value as AgentCustomProviderApi })} value={provider.api}>
          {(Object.keys(apiLabels) as AgentCustomProviderApi[]).map((api) => <option key={api} value={api}>{apiLabels[api]}</option>)}
        </select>
      </Field>
    </div>

    {/* The key is stored per provider id in safeStorage. It is the one secret in
        this editor and it is write-only from the renderer: the field is cleared
        on success and the status line only ever says whether one exists. */}
    <div className="settings-form-grid mt-2">
      <Field hint="保存在本机 Main 的 safeStorage，不写入 models.json、SQLite 或日志。" htmlFor={`${inputId}-key`} label="API Key">
        <Input autoComplete="off" disabled={keyBusy} id={`${inputId}-key`} onChange={(event) => onKeyDraftChange(event.target.value)} placeholder={keyStored ? '已保存；输入新值可替换' : '粘贴该服务的 API Key'} type="password" value={keyDraft} />
      </Field>
      <div className="flex flex-wrap items-center gap-2 self-end pb-1">
        <Button disabled={keyBusy || keyDraft.trim().length === 0 || idError !== null} onClick={onSaveKey} size="sm" variant="primary"><KeyRound aria-hidden="true" className="size-3.5" />保存密钥</Button>
        <Button disabled={keyBusy || !keyStored} onClick={onClearKey} size="sm" variant="ghost"><Trash2 aria-hidden="true" className="size-3.5" />清除密钥</Button>
        <Button disabled={discoverBusy || probeIssue !== null} onClick={onDiscover} size="sm" title={probeIssue ?? '向该端点请求模型列表（只读，不写入任何内容）'} variant="secondary"><Radar aria-hidden="true" className="size-3.5" />{discoverBusy ? '正在发现…' : '发现模型'}</Button>
      </div>
    </div>
    <p className="mt-1 text-xs text-muted-foreground">{keyStored ? 'safeStorage 中已存在该 id 的凭据，页面不回显密钥。' : '未保存凭据：远程端点需先保存密钥再发现，本机 localhost 端点可直接发现。'}{probeIssue ? <span className="text-danger"> {probeIssue}</span> : null}</p>

    {discovery ? <div className="mt-2 rounded-md border border-border bg-background/40 p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-foreground">发现结果：{discovery.result.models.length} 个模型 · {formatDateTime(discovery.result.discoveredAt)}</span>
        <div className="flex flex-wrap items-center gap-2">
          {pending.length > 0 ? <Button onClick={() => onSelectAllDiscovered(selectedCount !== pending.length)} size="sm" variant="ghost">{selectedCount === pending.length ? '取消全选' : '全选'}</Button> : null}
          {/* The only path from a probe into the draft, and the draft still needs
              an explicit save before anything reaches the file. */}
          <Button disabled={selectedCount === 0 || stale} onClick={onAdoptSelected} size="sm" variant="primary"><ListPlus aria-hidden="true" className="size-3.5" />{`添加选中的 ${selectedCount} 个模型`}</Button>
          <Button onClick={onDiscardDiscovery} size="sm" variant="ghost"><X aria-hidden="true" className="size-3.5" />放弃</Button>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">来自 <code className="break-all">{discovery.result.baseUrl}</code> · {apiLabels[discovery.result.api]}。这些只是候选项：勾选并“添加”后进入草稿，点“保存 models.json”才写入文件。</p>
      {stale ? <p className="mt-1 text-xs text-danger" role="alert">该结果来自 {discovery.result.provider} / {discovery.result.baseUrl}，当前表单已修改：请重新发现，不要把这个端点的模型 id 写进另一个 Provider。</p> : null}
      {discovery.result.notice ? <p className="mt-1 text-xs text-muted-foreground">{discovery.result.notice}</p> : null}
      {discovery.result.models.length === 0 ? <p className="mt-1 text-xs text-muted-foreground">端点没有返回可用的模型 id。</p> : <ul className="mt-2 grid max-h-56 gap-1 overflow-auto">
        {discovery.result.models.map((model) => {
          const already = !pendingIds.has(model.id)
          const details = [model.name && model.name !== model.id ? model.name : null, model.contextWindow ? `上下文 ${model.contextWindow}` : null, model.maxTokens ? `最大输出 ${model.maxTokens}` : null, model.reasoning ? '支持思考' : null].filter((part): part is string => part !== null).join(' · ')
          return <li className="flex flex-wrap items-center gap-2 rounded border border-border/60 px-2 py-1 text-xs" key={model.id}>
            <label className="flex min-w-0 items-center gap-2"><input checked={discovery.selected.includes(model.id) && !already} disabled={already} onChange={() => onToggleDiscovered(model.id)} type="checkbox" /><code className="break-all text-foreground">{model.id}</code></label>
            {details ? <span className="text-muted-foreground">{details}</span> : null}
            {already ? <span className="text-muted-foreground">已在列表中</span> : null}
          </li>
        })}
      </ul>}
    </div> : null}
    {status ? <p aria-live="polite" className="mt-2 text-xs text-muted-foreground" role="status">{status}</p> : null}

    <div className="mt-2 grid gap-2">
      {provider.models.map((model, modelIndex) => <div className="grid items-end gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_auto_auto]" key={modelIndex}>
        <Field error={model.id.trim() ? undefined : '模型 id 不能为空。'} htmlFor={`${inputId}-model-${modelIndex}`} label={`模型 ${modelIndex + 1} id`}>
          <Input id={`${inputId}-model-${modelIndex}`} onChange={(event) => onUpdateModel(modelIndex, { id: event.target.value })} value={model.id} />
        </Field>
        <Field htmlFor={`${inputId}-model-${modelIndex}-name`} label="显示名">
          <Input id={`${inputId}-model-${modelIndex}-name`} onChange={(event) => onUpdateModel(modelIndex, { name: event.target.value })} value={model.name} />
        </Field>
        <Field htmlFor={`${inputId}-model-${modelIndex}-context`} label="上下文">
          <Input id={`${inputId}-model-${modelIndex}-context`} inputMode="numeric" onChange={(event) => onUpdateModel(modelIndex, { contextWindow: toOptionalNumber(event.target.value) })} placeholder="默认" value={model.contextWindow ?? ''} />
        </Field>
        <Field htmlFor={`${inputId}-model-${modelIndex}-max`} label="最大输出">
          <Input id={`${inputId}-model-${modelIndex}-max`} inputMode="numeric" onChange={(event) => onUpdateModel(modelIndex, { maxTokens: toOptionalNumber(event.target.value) })} placeholder="默认" value={model.maxTokens ?? ''} />
        </Field>
        <div className="flex items-center gap-2 pb-1">
          <label className="flex items-center gap-1 text-xs text-muted-foreground"><input checked={model.reasoning} onChange={(event) => onUpdateModel(modelIndex, { reasoning: event.target.checked })} type="checkbox" />思考</label>
          <Button aria-label={`删除模型 ${modelIndex + 1}`} onClick={() => onRemoveModel(modelIndex)} size="sm" variant="ghost"><Trash2 aria-hidden="true" className="size-3.5" /></Button>
        </div>
      </div>)}
      <div><Button onClick={onAddModel} size="sm" variant="secondary"><Plus aria-hidden="true" className="size-3.5" />添加模型</Button></div>
    </div>
  </div>
}

/** Per-provider messages, numbered so a long list still points at one row. */
function providerIssues(provider: AgentCustomProvider, index: number): string[] {
  const label = `Provider ${index + 1}`
  const issues: string[] = []
  const idIssue = customProviderIdIssue(provider.id)
  if (idIssue) issues.push(`${label}：${idIssue}`)
  const urlIssue = customProviderUrlIssue(provider.baseUrl)
  if (urlIssue) issues.push(`${label}：${urlIssue}`)
  if (provider.models.some((model) => model.id.trim().length === 0)) issues.push(`${label}：每个模型都需要 id。`)
  const ids = provider.models.map((model) => model.id.trim())
  if (new Set(ids).size !== ids.length) issues.push(`${label}：同一 Provider 下的模型 id 不能重复。`)
  return issues
}

function createModel(): AgentCustomProviderModel {
  return { id: '', name: '', reasoning: false, contextWindow: null, maxTokens: null }
}

function createProvider(preset: typeof providerPresets[number], existing: readonly AgentCustomProvider[]): AgentCustomProvider {
  return {
    id: uniqueId(preset.api === 'openai-responses' ? 'openai-responses' : preset.api.replace(/-messages|-completions|-generative-ai/u, ''), existing),
    name: preset.name,
    baseUrl: preset.baseUrl,
    api: preset.api,
    models: [createModel()]
  }
}

/** Ids must be unique because they are the credential-vault key as well as the
 * Pi provider id, so a second preset gets a numeric suffix instead of colliding. */
function uniqueId(base: string, existing: readonly AgentCustomProvider[]): string {
  const taken = new Set(existing.map((provider) => provider.id))
  if (!taken.has(base)) return base
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

/** Blank means "Pi's default", which is `null` on the wire rather than `0`. */
function toOptionalNumber(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}
