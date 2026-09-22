import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentAuthPromptKind, AgentAuthPromptOption, AgentAuthType, AgentConnector, AgentCredentialStatus, AgentModelCatalogEntry, AgentPermissionMode, AgentProxyProfile, AgentRuntimeKind, AgentSettingsSaveInput, AgentToolProfile, ArchiveBulkResult, IntegrationProfile, IntegrationProvider, KnowledgeEngineConfig, KnowledgeEngineKind, Project, SyncRun, UpdateState } from '@prw/contracts'
import { Cable, CheckCircle2, ChevronDown, ChevronUp, Download, Edit3, ExternalLink, FolderOpen, KeyRound, Plus, RefreshCw, Save, TestTube2, Trash2 } from 'lucide-react'
import { Fragment, useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { ArchiveReceiptList, SelectionBar, SelectionCheckbox } from '../../components/selection'
import { ExternalUrlLink } from '../../components/external-link'
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../../components/states'
import { Button, Dialog, DialogClose, DialogContent, DialogTrigger, Field, Input, Textarea } from '../../components/ui'
import { cn, formatDateTime, getErrorMessage } from '../../lib/utils'
import { defaultSelectionIssue, defaultSelectionSummary } from '../../lib/model-discovery'
import { getWorkbenchAgentApi, getWorkbenchApi } from '../../lib/workbench'
import { queryKeys, useIntegrationsQuery, useSyncRunsQuery } from '../queries'
import { CustomProviderSection } from './custom-providers'
import { describeSyncRun, MutationFeedback, ResearchPanel, ResearchTabs, StatusBadge, SyncRunList } from './shared'
import { RssSourceSettings } from './rss-source-settings'

type SettingsTab = 'general' | 'workspace' | 'literature' | 'proxy' | 'connectors' | 'rss' | 'agent' | 'engines' | 'mcp' | 'security' | 'about'

/**
 * Deep-link target requested by another surface before it navigates here.
 *
 * The Agent workspace keeps no run configuration of its own, so its composer
 * points at the section that owns it. The shell unmounts a page when the route
 * changes, which makes a one-shot module value enough — and it avoids putting a
 * route parameter on every intermediate component just for one hint link.
 */
let pendingSection: SettingsTab | null = null

/** Select the section shown the next time Settings mounts. */
export function openSettingsSection(section: SettingsTab): void {
  pendingSection = section
}

const integrationLabels: Record<IntegrationProvider, string> = {
  obsidian: 'Obsidian',
  zotero: 'Zotero',
  notion: 'Notion'
}

type IntegrationSettings = Record<string, string | number | boolean | null>

const defaultIntegrationSettings: Record<IntegrationProvider, IntegrationSettings> = {
  obsidian: { managedFolder: '' },
  zotero: { libraryType: 'users', libraryId: '0', limit: 100 },
  notion: {
    titleProperty: 'Name',
    authorsProperty: 'Authors',
    tagsProperty: 'Tags',
    collectionsProperty: 'Collections',
    managedProperty: 'Workbench Summary'
  }
}

function parseIntegrationSettings(value: string): IntegrationSettings | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const entries = Object.entries(parsed)
    if (!entries.every(([, item]) => item === null || ['string', 'number', 'boolean'].includes(typeof item))) return null
    return Object.fromEntries(entries) as IntegrationSettings
  } catch {
    return null
  }
}

/** Render the first safe Zod issue returned by Main for this form. The full
 * error object stays in Main/Preload; only a bounded, redacted message is
 * shown to help users correct values such as a misspelled Zotero host. */
function integrationValidationMessage(error: unknown): string | null {
  if (error instanceof Error && /expected shape/i.test(error.message)) {
    return '连接配置字段格式不正确：请检查服务地址、凭据字段和 JSON 设置。Zotero 地址必须使用 https:// 或 localhost 回环地址（例如 http://127.0.0.1:23119/api/）。'
  }
  if (!error || typeof error !== 'object') return null
  const details = (error as { details?: unknown }).details
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null
  const issues = (details as { issues?: unknown }).issues
  if (!Array.isArray(issues)) return null
  const issue = issues.find((candidate): candidate is { message?: unknown; path?: unknown } => (
    Boolean(candidate) && typeof candidate === 'object' && !Array.isArray(candidate)
  ))
  if (!issue || typeof issue.message !== 'string' || issue.message.length === 0 || issue.message.length > 500) return null
  // Zod messages should not contain raw credentials or absolute paths. Keep a
  // second guard here because this value crosses the Main -> Renderer boundary.
  if (/([A-Za-z]:[\\/]|\\\\|Bearer\s|token=|api[_-]?key|password=|secret=)/i.test(issue.message)) return null
  const path = Array.isArray(issue.path) ? issue.path[0] : null
  if (path === 'name') return `配置名：${issue.message}`
  if (path === 'location') return `位置：${issue.message}`
  if (path === 'settings') return `字段与范围设置：${issue.message}`
  return issue.message
}

function IntegrationDialog({ profile, trigger }: { profile: IntegrationProfile | null; trigger: ReactElement }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [provider, setProvider] = useState<IntegrationProvider>('obsidian')
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [credential, setCredential] = useState('')
  const [settingsText, setSettingsText] = useState('{}')
  const [enabled, setEnabled] = useState(true)
  const [attempted, setAttempted] = useState(false)
  const [probeResult, setProbeResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const providerId = useId()
  const nameId = useId()
  const locationId = useId()
  const credentialId = useId()
  const settingsId = useId()
  const parsedSettings = parseIntegrationSettings(settingsText)

  useEffect(() => {
    if (!open) return
    setProvider(profile?.provider ?? 'obsidian')
    setName(profile?.name ?? '')
    // Do not echo a stored absolute Vault root in the renderer. Editing an
    // existing profile requires the user to re-enter the authorized root.
    setLocation(profile?.provider === 'obsidian' ? '' : profile?.location ?? '')
    setCredential('')
    setSettingsText(JSON.stringify(profile?.settings ?? defaultIntegrationSettings[profile?.provider ?? 'obsidian'], null, 2))
    setEnabled(profile?.enabled ?? true)
    setAttempted(false)
    setProbeResult(null)
    setPickerError(null)
  }, [open, profile])

  const mutation = useMutation({
    mutationFn: async () => {
      const saved = await getWorkbenchApi().integrations.save({
        ...(profile ? { id: profile.id } : {}),
        provider,
        name: name.trim(),
        enabled,
        // Existing profiles intentionally do not echo the stored Vault/API
        // location into the editable field. Preserve it when the user leaves
        // the field blank; otherwise a routine settings edit would silently
        // disconnect the integration.
        location: location.trim() || profile?.location || '',
        settings: parsedSettings ?? {},
        ...(credential ? { credential } : {}),
        expectedRevision: profile?.revision ?? null
      })
      // Saving and probing are separate, explicit operations. A failed probe
      // leaves the profile saved and visible as unavailable rather than ready.
      const probe = provider === 'obsidian' && enabled ? await getWorkbenchApi().integrations.test(saved.id) : null
      return { saved, probe }
    },
    onSuccess: async ({ probe }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.integrations })
      setProbeResult(probe)
      if (!probe || probe.ok) setOpen(false)
    }
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setAttempted(true)
    if (!name.trim()) {
      document.getElementById(nameId)?.focus()
      return
    }
    // A new Obsidian profile may use the packaged/default Vault resolved by
    // Main from OBSIDIAN_DIR or the install directory. When a custom Vault is
    // desired, the folder picker remains the only way to enter its path.
    if (provider === 'zotero') {
      try {
        const parsedUrl = new URL(location.trim() || 'http://127.0.0.1:23119/api/')
        const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsedUrl.hostname)
        if ((!local && parsedUrl.protocol !== 'https:') || (local && !['http:', 'https:'].includes(parsedUrl.protocol))) throw new Error('Zotero 地址必须是 HTTPS 或 localhost 回环地址。')
      } catch (error) {
        setPickerError(error instanceof Error ? error.message : '请输入有效的 Zotero Local API 地址。')
        document.getElementById(locationId)?.focus()
        return
      }
      const zoteroSettings = parsedSettings
      if (!zoteroSettings || (zoteroSettings.libraryType !== undefined && !['users', 'groups'].includes(String(zoteroSettings.libraryType))) || (zoteroSettings.libraryId !== undefined && !/^\d+$/u.test(String(zoteroSettings.libraryId)))) {
        setPickerError('Zotero 字段设置必须包含合法的 libraryType（users/groups）和数字 libraryId。')
        document.getElementById(settingsId)?.focus()
        return
      }
    }
    if (!parsedSettings) {
      document.getElementById(settingsId)?.focus()
      return
    }
    if (!mutation.isPending) mutation.mutate()
  }

  const selectVaultFolder = async (): Promise<void> => {
    if (provider !== 'obsidian') return
    setPickerError(null)
    try {
      const selected = await getWorkbenchApi().system.selectFolder()
      // Cancel is intentionally a no-op so editing a profile never clears a
      // previously selected value.
      if (selected !== null) setLocation(selected)
    } catch (error) {
      setPickerError(getErrorMessage(error))
    }
  }

  const locationHint = provider === 'obsidian'
    ? `${profile ? '可重新选择 Vault；留空将保留当前路径。' : '可使用“选择文件夹”指定已有 Vault，或留空使用默认 Vault。'} 路径不会在设置列表回显，保存时会由后端执行 realpath、根目录和符号链接检查。`
    : provider === 'zotero'
      ? `${profile ? '编辑时留空将保留当前地址。' : '填写 Zotero Local API 地址或库定位信息。'} 地址必须是 HTTPS 或 localhost 回环地址，凭据单独保存。`
      : '填写已授权的 Notion Data Source ID（32–36 位）。'

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) { mutation.reset(); setProbeResult(null) } }}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto" description="连接信息仅由本地主进程保存与使用。Obsidian Vault 会在保存后执行一次真实探测。" title={profile ? '编辑集成配置' : '新建集成配置'}>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field htmlFor={providerId} label="服务">
              <select className="select-control" disabled={Boolean(profile)} id={providerId} onChange={(event) => {
                const next = event.target.value as IntegrationProvider
                setProvider(next)
                if (!profile) {
                  setLocation('')
                  setPickerError(null)
                  setSettingsText(JSON.stringify(defaultIntegrationSettings[next], null, 2))
                }
              }} value={provider}>
                {Object.entries(integrationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <Field error={attempted && !name.trim() ? '请填写配置名。' : undefined} htmlFor={nameId} label="配置名">
              <Input id={nameId} maxLength={120} onChange={(event) => setName(event.target.value)} placeholder={`例如：我的 ${integrationLabels[provider]}`} value={name} />
            </Field>
          </div>
          <Field error={pickerError ?? undefined} hint={locationHint} htmlFor={locationId} label={provider === 'obsidian' ? 'Vault 路径' : provider === 'zotero' ? 'Local API 地址' : '位置 / 根对象'}>
            {provider === 'obsidian' ? (
              <div className="flex items-center gap-2">
                 <Input aria-describedby={`${locationId}-description`} id={locationId} maxLength={4000} placeholder={profile ? '未选择新路径（留空保持当前 Vault）' : '留空使用默认 Vault，或请选择文件夹'} readOnly value={location} />
                <Button aria-describedby={`${locationId}-description`} aria-label="选择 Vault 文件夹" id={`${locationId}-picker`} onClick={() => void selectVaultFolder()} type="button"><FolderOpen aria-hidden="true" className="size-4" />选择文件夹</Button>
              </div>
            ) : <Input id={locationId} maxLength={4000} onChange={(event) => setLocation(event.target.value)} placeholder={profile ? '留空保持当前地址，或输入新地址' : undefined} value={location} />}
          </Field>
          {provider === 'zotero' ? <div className="rounded-md border border-border bg-muted/20 p-3 text-xs leading-5 text-muted-foreground"><p className="font-semibold text-foreground">仅使用 Zotero Local API</p><p className="mt-1">工作台只连接本机 Zotero Local API（localhost / 127.0.0.1）。这里不会要求或保存 Zotero Web API Key；请在 Zotero 中启用本地 API 后直接测试连接。</p></div> : <Field hint={profile?.credentialPresent ? '已存在密钥；留空将保留原值。' : '可选，需要授权时填写 Token / API Key。'} htmlFor={credentialId} label="凭据">
            <Input autoComplete="off" id={credentialId} maxLength={20000} onChange={(event) => setCredential(event.target.value)} type="password" value={credential} />
          </Field>}
          <Field error={attempted && !parsedSettings ? '设置必须是 JSON 对象，值仅支持字符串、数字、布尔值或 null。' : undefined} hint="高级字段映射。Zotero 可配置 libraryType/libraryId；Notion 可配置属性名；Obsidian 可配置 managedFolder。" htmlFor={settingsId} label="字段与范围设置（JSON）">
            <Textarea className="min-h-32 font-mono text-xs" id={settingsId} onChange={(event) => setSettingsText(event.target.value)} spellCheck={false} value={settingsText} />
          </Field>
          <label className="research-check-row"><input checked={enabled} className="research-checkbox" onChange={(event) => setEnabled(event.target.checked)} type="checkbox" /><span>启用这个连接配置</span></label>
          {mutation.error ? <p className="form-feedback form-feedback-error" role="alert">{integrationValidationMessage(mutation.error) ?? getErrorMessage(mutation.error)}</p> : null}
          {probeResult && !probeResult.ok ? <p className="form-feedback form-feedback-error" role="alert">已保存配置，但 Vault 探测未通过：{probeResult.message}。请修正路径后再次验证。</p> : null}
          <div className="flex justify-end gap-2"><DialogClose asChild><Button type="button" variant="ghost">取消</Button></DialogClose><Button loading={mutation.isPending} type="submit" variant="primary"><Save aria-hidden="true" className="size-4" />{provider === 'obsidian' && enabled ? '验证并保存' : '保存配置'}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ConnectorsPanel(): React.JSX.Element {
  const queryClient = useQueryClient()
  const integrations = useIntegrationsQuery()
  const syncRuns = useSyncRunsQuery()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [receipt, setReceipt] = useState<ArchiveBulkResult | null>(null)
  const [deleteFeedback, setDeleteFeedback] = useState<string | null>(null)
  // Receipt copy has to survive the refetch that follows a delete, where the
  // archived row is no longer in the list and its name would be lost.
  const receiptNames = useRef<Map<string, string>>(new Map())
  const profiles = integrations.data ?? []
  // `integrations.list` only returns active records. A record that disappeared
  // (deleted in another window, or through the single-record path) must not stay
  // selected, otherwise the count would name a scope the bulk command cannot
  // reach. Returning the current set unchanged keeps this effect render-safe.
  useEffect(() => {
    setSelectedIds((current) => {
      if (current.size === 0) return current
      const next = new Set([...current].filter((id) => (integrations.data ?? []).some((profile) => profile.id === id)))
      return next.size === current.size ? current : next
    })
  }, [integrations.data])
  const selectedProfiles = profiles.filter((profile) => selectedIds.has(profile.id))
  const toggleProfile = (id: string, checked: boolean): void => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }
  const deleteMutation = useMutation({
    mutationFn: (locks: { id: string; expectedRevision: number }[]) => getWorkbenchApi().integrations.bulkRemove({ items: locks }),
    onSuccess: async (result) => {
      setReceipt(result)
      setDeleteFeedback(result.conflict > 0 || result.failed > 0 ? '部分连接记录未删除：修订冲突或失败的记录保持原状，请刷新列表后重试。' : `已删除 ${result.succeeded} 条连接记录（跳过 ${result.skipped} 条）。`)
      setSelectedIds(new Set())
      await queryClient.invalidateQueries({ queryKey: queryKeys.integrations })
    },
    onError: (error) => { setReceipt(null); setDeleteFeedback(getErrorMessage(error)) }
  })
  const removeOneMutation = useMutation({
    mutationFn: (profile: IntegrationProfile) => getWorkbenchApi().integrations.remove(profile.id, profile.revision),
    onSuccess: async (_value, profile) => {
      setReceipt(null)
      setDeleteFeedback(`已删除连接“${profile.name}”；该连接记录与本机安全存储中属于它的凭据已移除，Obsidian Vault 与 Zotero 数据库不受影响。`)
      await queryClient.invalidateQueries({ queryKey: queryKeys.integrations })
    },
    onError: (error) => setDeleteFeedback(getErrorMessage(error))
  })
  const removeOne = (profile: IntegrationProfile): void => {
    if (removeOneMutation.isPending || deleteMutation.isPending) return
    const confirmed = window.confirm(`删除连接“${profile.name}”？将删除该连接记录，并移除主进程安全存储中属于它的凭据（该连接之后需重新填写凭据）。Obsidian Vault 与 Zotero 数据库不会被改动。`)
    if (!confirmed) return
    setDeleteFeedback(null)
    removeOneMutation.mutate(profile)
  }
  const removeSelected = (): void => {
    if (deleteMutation.isPending || removeOneMutation.isPending) return
    if (selectedProfiles.length === 0) return
    const names = selectedProfiles.map((profile) => profile.name).join('、')
    const confirmed = window.confirm([
      `将删除选中的 ${selectedProfiles.length} 条连接记录（当前列表共 ${profiles.length} 条）：${names}。`,
      '删除范围仅限“设置 → 工具连接”当前列表中的连接记录本身；本机安全存储中的密钥、同步记录/外部链接，以及 Obsidian Vault 与 Zotero 数据库都不会被改动。',
      '其中已被其他操作修改过的记录会以“修订冲突”逐条回报且不会被写入。确认继续？'
    ].join('\n'))
    if (!confirmed) return
    receiptNames.current = new Map(selectedProfiles.map((profile) => [profile.id, profile.name]))
    setDeleteFeedback(null)
    deleteMutation.mutate(selectedProfiles.map((profile) => ({ id: profile.id, expectedRevision: profile.revision })))
  }
  const describeReceipt = (id: string): string => profiles.find((profile) => profile.id === id)?.name ?? receiptNames.current.get(id) ?? '该连接记录（已不在当前列表）'
  const testMutation = useMutation({
    mutationFn: (id: string) => getWorkbenchApi().integrations.test(id),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.integrations }) }
  })
  const syncMutation = useMutation({
    mutationFn: ({ id, direction }: { id: string; direction: 'pull' | 'push' }) => getWorkbenchApi().integrations.sync(id, direction),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.integrations }),
        queryClient.invalidateQueries({ queryKey: ['sync-runs'] })
      ])
    }
  })

  // --- Settings → 最近同步 (connection sync run records) ---------------------
  // The loaded range is the whole query result, and every rendered run owns a
  // checkbox, so "全选" here can never name a row the user cannot see. Removal
  // is a CAS-locked soft archive: the audit row, the connection record, its
  // safeStorage credential, external links and external systems stay intact.
  const runs = syncRuns.data ?? []
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set())
  const [runReceipt, setRunReceipt] = useState<ArchiveBulkResult | null>(null)
  const [runFeedback, setRunFeedback] = useState<string | null>(null)
  // Receipt copy has to survive the refetch that follows a removal, where the
  // archived run is no longer in the list and its label would be lost.
  const runReceiptLabels = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    setSelectedRunIds((current) => {
      if (current.size === 0) return current
      const next = new Set([...current].filter((id) => (syncRuns.data ?? []).some((run) => run.id === id)))
      return next.size === current.size ? current : next
    })
  }, [syncRuns.data])
  const selectedRuns = runs.filter((run) => selectedRunIds.has(run.id))
  const toggleRun = (id: string, checked: boolean): void => {
    setSelectedRunIds((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }
  const removeRunMutation = useMutation({
    mutationFn: (run: SyncRun) => getWorkbenchApi().integrations.removeRun(run.id, run.revision),
    onSuccess: async (_value, run) => {
      setRunReceipt(null)
      setRunFeedback(`已删除同步记录“${describeSyncRun(run)}”；该记录已从列表移除（本机审计行保留），连接配置、密钥、外链索引与外部数据均未改动。`)
      await queryClient.invalidateQueries({ queryKey: ['sync-runs'] })
    },
    onError: (error) => setRunFeedback(getErrorMessage(error))
  })
  const removeRunsMutation = useMutation({
    mutationFn: (locks: { id: string; expectedRevision: number }[]) => getWorkbenchApi().integrations.bulkRemoveRuns({ items: locks }),
    onSuccess: async (result) => {
      setRunReceipt(result)
      setRunFeedback(result.conflict > 0 || result.failed > 0 ? '部分同步记录未删除：修订冲突或失败的记录保持原状，请刷新列表后重试。' : `已删除 ${result.succeeded} 条同步记录（跳过 ${result.skipped} 条）。`)
      setSelectedRunIds(new Set())
      await queryClient.invalidateQueries({ queryKey: ['sync-runs'] })
    },
    onError: (error) => { setRunReceipt(null); setRunFeedback(getErrorMessage(error)) }
  })
  const removeOneRun = (run: SyncRun): void => {
    if (removeRunMutation.isPending || removeRunsMutation.isPending) return
    const confirmed = window.confirm(`删除同步记录“${describeSyncRun(run)}”？该记录会从“最近同步”列表移除，本机数据库中的审计行保留；连接配置、密钥、外链索引与任何外部数据都不会被改动。`)
    if (!confirmed) return
    setRunFeedback(null)
    removeRunMutation.mutate(run)
  }
  const removeSelectedRuns = (): void => {
    if (removeRunsMutation.isPending || removeRunMutation.isPending) return
    if (selectedRuns.length === 0) return
    const labels = selectedRuns.map((run) => describeSyncRun(run)).join('、')
    const confirmed = window.confirm([
      `将删除选中的 ${selectedRuns.length} 条同步记录（当前加载 ${runs.length} 条）：${labels}。`,
      '删除范围仅限“设置 → 最近同步”当前加载的同步记录；本机数据库保留审计行，连接配置、safeStorage 密钥、外链索引（external_links）以及 Obsidian Vault / Zotero / Notion 等外部数据都不会被改动。',
      '其中已被其他操作更新过的记录会以“修订冲突”逐条回报且不会被写入。确认继续？'
    ].join('\n'))
    if (!confirmed) return
    runReceiptLabels.current = new Map(selectedRuns.map((run) => [run.id, describeSyncRun(run)]))
    setRunFeedback(null)
    removeRunsMutation.mutate(selectedRuns.map((run) => ({ id: run.id, expectedRevision: run.revision })))
  }
  const describeRunReceipt = (id: string): string => {
    const run = runs.find((candidate) => candidate.id === id)
    return run ? describeSyncRun(run) : runReceiptLabels.current.get(id) ?? '该同步记录（已不在当前列表）'
  }

  if (integrations.isLoading) return <LoadingState label="正在读取集成配置…" />
  if (integrations.error) return <ErrorState error={integrations.error} onRetry={() => void integrations.refetch()} />

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <ResearchPanel action={<IntegrationDialog profile={null} trigger={<Button variant="primary"><Plus aria-hidden="true" className="size-4" />新建连接</Button>} />} eyebrow="CONNECTORS / PROFILES" title="Obsidian · Zotero · Notion">
        <p className="border-b border-border px-4 py-3 text-xs leading-5 text-muted-foreground">连接地址和字段设置保存在工作区数据库，重启后继续生效；凭据仅由主进程安全存储。开发环境可用 .env 作为新建配置的默认值，打包后请直接在此处填写并验证。</p>
        {integrations.data?.length === 0 ? <div className="p-4"><EmptyState description="保存 Obsidian 配置后必须先验证；其他连接的读写仍保持显式、手动触发。" title="尚无连接配置" /></div> : null}
        <SelectionBar
          allSelected={profiles.length > 0 && selectedProfiles.length === profiles.length}
          disabled={profiles.length === 0}
          indeterminate={selectedProfiles.length > 0 && selectedProfiles.length < profiles.length}
          label="连接记录批量操作"
          onClear={() => setSelectedIds(new Set())}
          onToggleAll={(checked) => setSelectedIds(checked ? new Set(profiles.map((profile) => profile.id)) : new Set())}
          scope={`全选仅覆盖“设置 → 工具连接”当前列表的 ${profiles.length} 条连接记录（不含已归档；本列表无分页、无筛选）`}
          selectAllLabel="全选当前列表连接记录"
          selectedCount={selectedProfiles.length}
          totalCount={profiles.length}
        >
          <Button
            aria-label={`删除选中的 ${selectedProfiles.length} 条连接记录`}
            disabled={selectedProfiles.length === 0 || removeOneMutation.isPending}
            loading={deleteMutation.isPending}
            onClick={removeSelected}
            size="sm"
            variant="secondary"
          ><Trash2 aria-hidden="true" className="size-3.5" />删除选中</Button>
        </SelectionBar>
        {deleteFeedback ? <p aria-live="polite" className={receipt && (receipt.conflict > 0 || receipt.failed > 0) ? 'form-feedback form-feedback-error mx-4 mt-3' : 'form-feedback form-feedback-success mx-4 mt-3'} role="status">{deleteFeedback}</p> : null}
        {receipt ? <ArchiveReceiptList className="m-3" describe={describeReceipt} result={receipt} succeededVerb="已删除" /> : null}
        <div className="divide-y divide-border">
          {integrations.data?.map((profile) => (
            <article className="settings-row" key={profile.id}>
              <SelectionCheckbox ariaLabel={`选择连接：${profile.name}`} checked={selectedIds.has(profile.id)} onChange={(checked) => toggleProfile(profile.id, checked)} title={`选择连接：${profile.name}`} />
              <div className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-muted text-primary"><Cable aria-hidden="true" className="size-4" /></div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-bold text-foreground">{profile.name}</h3><StatusBadge status={profile.status} /><span className="research-tag">{integrationLabels[profile.provider]}</span></div>
                <p className="mt-1 overflow-wrap-anywhere text-xs text-muted-foreground">{profile.provider === 'obsidian' ? 'Vault 路径已保存（不会在列表回显）' : profile.location || '未填写位置'} · 上次同步 {formatDateTime(profile.lastSyncAt)}</p>
                {profile.lastError ? <p className="mt-1 text-xs text-danger">{profile.provider === 'obsidian' ? 'Vault 探测失败（错误摘要已脱敏）' : profile.lastError}</p> : null}
                {testMutation.variables === profile.id && testMutation.data ? <p className={testMutation.data.ok ? 'mt-1 text-xs text-success' : 'mt-1 text-xs text-danger'} role="status">{testMutation.data.message}</p> : null}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2"><IntegrationDialog profile={profile} trigger={<Button aria-label={`编辑连接：${profile.name}`} size="icon" variant="ghost"><Edit3 aria-hidden="true" className="size-4" /></Button>} /><Button loading={testMutation.isPending && testMutation.variables === profile.id} onClick={() => testMutation.mutate(profile.id)} size="sm"><TestTube2 aria-hidden="true" className="size-3.5" />{profile.provider === 'obsidian' ? '验证' : '测试'}</Button><Button aria-label={`删除连接：${profile.name}`} disabled={deleteMutation.isPending} loading={removeOneMutation.isPending && removeOneMutation.variables?.id === profile.id} onClick={() => removeOne(profile)} size="sm" variant="secondary"><Trash2 aria-hidden="true" className="size-3.5" />删除</Button><Button disabled={!profile.enabled} loading={syncMutation.isPending && syncMutation.variables?.id === profile.id && syncMutation.variables.direction === 'pull'} onClick={() => syncMutation.mutate({ id: profile.id, direction: 'pull' })} size="sm"><RefreshCw aria-hidden="true" className="size-3.5" />拉取</Button><Button disabled={!profile.enabled} loading={syncMutation.isPending && syncMutation.variables?.id === profile.id && syncMutation.variables.direction === 'push'} onClick={() => { if (profile.provider === 'notion' && !window.confirm('将按最近一次拉取的页面版本写回 Workbench Summary、Tags 和 Collections。Notion API 不提供原子条件更新；若页面刚被他人修改，本次写回仍可能冲突。确认继续？')) return; syncMutation.mutate({ id: profile.id, direction: 'push' }) }} size="sm" variant="primary"><RefreshCw aria-hidden="true" className="size-3.5" />写回</Button></div>
            </article>
          ))}
        </div>
        <MutationFeedback error={testMutation.error ?? syncMutation.error} success={syncMutation.isSuccess ? '同步任务已提交。' : undefined} />
      </ResearchPanel>
      <ResearchPanel eyebrow="SYNC / RECENT" title="最近同步">
        <p className="border-b border-border px-4 py-3 text-xs leading-5 text-muted-foreground">最近同步记录来自本机数据库的审计表。勾选后可逐条删除或批量删除：只会把记录从本列表移除（审计行保留），连接配置、密钥、外链索引与外部数据都不会被改动。</p>
        {syncRuns.isLoading ? <p className="research-empty-inline">正在读取…</p> : null}
        {syncRuns.error ? <p className="form-feedback form-feedback-error m-3" role="alert">{getErrorMessage(syncRuns.error)}</p> : null}
        {syncRuns.data ? <>
          <div className="px-3 pt-2">
            <SelectionBar
              allSelected={runs.length > 0 && selectedRuns.length === runs.length}
              className="selection-bar-compact"
              disabled={runs.length === 0}
              indeterminate={selectedRuns.length > 0 && selectedRuns.length < runs.length}
              label="同步记录批量操作"
              onClear={() => setSelectedRunIds(new Set())}
              onToggleAll={(checked) => setSelectedRunIds(checked ? new Set(runs.map((run) => run.id)) : new Set())}
              scope={`全选仅覆盖“设置 → 最近同步”当前加载的 ${runs.length} 条同步记录（无分页、无筛选；不含定时任务 RUN HISTORY）`}
              selectAllLabel="全选当前加载的同步记录"
              selectedCount={selectedRuns.length}
              totalCount={runs.length}
            >
              <Button
                aria-label={`删除选中的 ${selectedRuns.length} 条同步记录`}
                disabled={selectedRuns.length === 0 || removeRunMutation.isPending}
                loading={removeRunsMutation.isPending}
                onClick={removeSelectedRuns}
                size="sm"
                variant="secondary"
              ><Trash2 aria-hidden="true" className="size-3.5" />删除选中</Button>
            </SelectionBar>
          </div>
          {runFeedback ? <p aria-live="polite" className={runReceipt && (runReceipt.conflict > 0 || runReceipt.failed > 0) ? 'form-feedback form-feedback-error mx-3 mt-2' : 'form-feedback form-feedback-success mx-3 mt-2'} role="status">{runFeedback}</p> : null}
          {runReceipt ? <ArchiveReceiptList className="m-3" describe={describeRunReceipt} result={runReceipt} succeededVerb="已删除" /> : null}
          <SyncRunList
            emptyText="尚无同步记录；执行拉取或写回后会出现逐条记录。"
            rowAction={(run) => <Button aria-label={`删除同步记录：${describeSyncRun(run)}`} disabled={removeRunsMutation.isPending} loading={removeRunMutation.isPending && removeRunMutation.variables?.id === run.id} onClick={() => removeOneRun(run)} size="sm" variant="secondary"><Trash2 aria-hidden="true" className="size-3.5" />删除</Button>}
            runs={runs}
            selection={{ selectedIds: selectedRunIds, onToggle: toggleRun }}
          />
        </> : null}
      </ResearchPanel>
    </div>
  )
}

function SettingInfoPanel({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }): React.JSX.Element {
  return <ResearchPanel eyebrow={eyebrow} title={title}><div className="grid gap-3 p-5 text-sm leading-6 text-muted-foreground">{children}</div></ResearchPanel>
}

function GeneralSettingsPanel(): React.JSX.Element {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const value = localStorage.getItem('workbench-theme')
      return value === 'light' ? 'light' : 'dark'
    } catch {
      return 'dark'
    }
  })
  const [fontScale, setFontScale] = useState<'compact' | 'comfortable' | 'large'>(() => {
    try {
      const value = localStorage.getItem('workbench-font-scale')
      return value === 'compact' || value === 'large' ? value : 'comfortable'
    } catch {
      return 'comfortable'
    }
  })

  const publish = (nextTheme: 'light' | 'dark', nextScale: 'compact' | 'comfortable' | 'large'): void => {
    try {
      localStorage.setItem('workbench-theme', nextTheme)
      localStorage.setItem('workbench-font-scale', nextScale)
    } catch { /* optional renderer storage */ }
    document.documentElement.classList.toggle('dark', nextTheme === 'dark')
    document.documentElement.style.colorScheme = nextTheme
    document.documentElement.style.setProperty('--app-font-size', nextScale === 'compact' ? '13px' : nextScale === 'large' ? '16px' : '14px')
    window.dispatchEvent(new Event('workbench-preferences-change'))
  }

  return <SettingInfoPanel eyebrow="SETTINGS / GENERAL" title="通用"><div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1.5 text-xs font-semibold text-foreground" htmlFor="general-theme"><span>主题</span><select className="select-control" id="general-theme" onChange={(event) => { const next = event.target.value as 'light' | 'dark'; setTheme(next); publish(next, fontScale) }} value={theme}><option value="dark">深色</option><option value="light">浅色</option></select></label><label className="grid gap-1.5 text-xs font-semibold text-foreground" htmlFor="general-font-scale"><span>字号</span><select className="select-control" id="general-font-scale" onChange={(event) => { const next = event.target.value as 'compact' | 'comfortable' | 'large'; setFontScale(next); publish(theme, next) }} value={fontScale}><option value="compact">紧凑（13px）</option><option value="comfortable">标准（14px）</option><option value="large">大号（16px）</option></select></label></div><p>主题和字号会保存在当前用户配置并立即应用；左侧底部主题按钮与此处保持同步。</p><p>全局快捷创建支持顶部 Todo 输入；Ctrl K 搜索入口当前跳转到文献检索工作区。</p></SettingInfoPanel>
}

function UpdatesSettingsPanel(): React.JSX.Element {
  const [state, setState] = useState<UpdateState | null>(null)
  const [busy, setBusy] = useState<'check' | 'download' | 'install' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const api = getWorkbenchApi().updates
    void api.state().then((value) => { if (active) setState(value) }).catch((reason) => { if (active) setError(getErrorMessage(reason)) })
    const unsubscribe = api.onState((value) => { if (active) setState(value) })
    return () => { active = false; unsubscribe() }
  }, [])

  const run = async (operation: 'check' | 'download' | 'install'): Promise<void> => {
    if (busy) return
    setBusy(operation)
    setError(null)
    try {
      const next = operation === 'check'
        ? await getWorkbenchApi().updates.check()
        : operation === 'download'
          ? await getWorkbenchApi().updates.download()
          : await getWorkbenchApi().updates.install().then(() => getWorkbenchApi().updates.state())
      setState(next)
    } catch (reason) {
      setError(getErrorMessage(reason))
    } finally {
      setBusy(null)
    }
  }

  const phaseLabel: Record<UpdateState['phase'], string> = {
    idle: '已是最新', checking: '正在检查', available: '发现新版本', downloading: '正在下载', downloaded: '等待重启安装', error: '检查失败'
  }
  const phase = state?.phase ?? 'checking'
  return <SettingInfoPanel eyebrow="SETTINGS / ABOUT" title="关于与更新">
    <div className="update-hero"><div><p className="instrument-label">PERSONAL RESEARCH WORKBENCH</p><h3 className="mt-1 text-lg font-bold text-foreground">保持工作台稳定、可恢复、可更新</h3><p className="mt-1 text-xs leading-5">更新只替换应用文件；项目、任务、文献、连接配置和安全存储保留在当前 Windows 用户数据目录。</p></div><div className="update-version-mark"><span>当前版本</span><strong>{state?.currentVersion ?? '读取中'}</strong></div></div>
    <div className="update-status-row" role="status" aria-live="polite"><span className="flex items-center gap-2"><span className={cn('status-led', phase === 'error' ? 'bg-danger' : phase === 'downloaded' ? 'bg-online' : 'bg-primary')} />{phaseLabel[phase]}</span>{state?.availableVersion ? <span>目标版本 {state.availableVersion}</span> : null}{state?.message ? <span className="text-muted-foreground">{state.message}</span> : null}</div>
    {phase === 'downloading' ? <div className="update-progress" aria-label="更新下载进度"><span style={{ width: `${state?.progress ?? 0}%` }} /></div> : null}
    <div className="flex flex-wrap gap-2"><Button loading={busy === 'check' || phase === 'checking'} disabled={busy !== null || phase === 'downloading'} onClick={() => { void run('check') }} size="sm" variant="secondary"><RefreshCw aria-hidden="true" className="size-3.5" />检查更新</Button>{phase === 'available' ? <Button loading={busy === 'download'} disabled={busy !== null} onClick={() => { void run('download') }} size="sm" variant="primary"><Download aria-hidden="true" className="size-3.5" />下载更新</Button> : null}{phase === 'downloaded' ? <Button loading={busy === 'install'} disabled={busy !== null} onClick={() => { void run('install') }} size="sm" variant="primary"><CheckCircle2 aria-hidden="true" className="size-3.5" />重启并安装</Button> : null}</div>
    {error ? <p className="form-feedback form-feedback-error" role="alert">{error}</p> : null}
    <p className="text-xs">应用内更新需要可访问 GitHub Release。网络不可用时可以继续使用当前版本，稍后再检查。</p>
  </SettingInfoPanel>
}

function LegacyWorkspaceSettingsPanel(): React.JSX.Element {
  return <SettingInfoPanel eyebrow="SETTINGS / WORKSPACE" title="工作区与数据"><p>当前使用新的 <code className="font-mono text-foreground">workspace.sqlite3</code>。旧 <code className="font-mono text-foreground">workbench.sqlite3</code> 不读取、不删除。</p><p>SQLite、WAL 和迁移由 Workspace Service 管理；索引重建、备份恢复将在后续阶段加入。</p></SettingInfoPanel>
}

function LegacyLiteratureSettingsPanel(): React.JSX.Element {
  return <SettingInfoPanel eyebrow="SETTINGS / LITERATURE" title="文献检索"><p>当前可用来源：本地库、Crossref、OpenAlex、PubMed、arXiv、Semantic Scholar 和 Google Scholar scholarly 侧车。结果默认每页 50 条，可按年份、影响因子和公开引用代理排序。</p><p>Google Scholar 只在用户主动搜索时逐页运行；遇到验证码、限流或解析失败立即停止，不绕过验证，也不会标记为期刊影响因子。</p></SettingInfoPanel>
}

function LegacyEnginesPanel(): React.JSX.Element {
  return <SettingInfoPanel eyebrow="SETTINGS / ENGINES" title="知识引擎"><div className="settings-engine-grid"><div className="settings-engine"><strong>AnythingLLM</strong><span className="research-tag">只读映射</span><p>仅展示授权目录、Workspace 标识和索引状态；当前不会触发 Agent 或写入 Vault。</p></div><div className="settings-engine"><strong>LLMWiki</strong><span className="research-tag">只读映射</span><p>仅展示 Wiki、文档 ID、来源谱系和索引状态；当前不会写入 Markdown。</p></div></div></SettingInfoPanel>
}

function LegacyMcpSettingsPanel(): React.JSX.Element {
  const status = useQuery({ queryKey: ['workspace-status'], queryFn: () => getWorkbenchApi().workspace.status() })
  return <SettingInfoPanel eyebrow="SETTINGS / MCP" title="MCP Server"><p>首期仅提供本机 stdio MCP；不开放远程 Streamable HTTP。</p><p>当前状态：<strong className="text-foreground">{status.data?.mcp === 'connected' ? '已连接' : '未配置'}</strong>。Resources 与 Tools 通过同一个 Workspace Service 执行。</p><p>写入工具要求调用方显式确认；调用失败不会被显示为成功。</p></SettingInfoPanel>
}

function SecuritySettingsPanel(): React.JSX.Element {
  const integrations = useIntegrationsQuery()
  const credentials = (integrations.data ?? []).filter((profile) => profile.credentialPresent).length
  return <SettingInfoPanel eyebrow="SETTINGS / SECURITY" title="安全与审计"><p>Renderer 不持有 Node、数据库句柄或明文 credential。凭据由 Electron safeStorage 保护。</p><p>当前已保存 credential：<strong className="text-foreground">{credentials}</strong> 个配置；密钥不会回显到页面。</p><p>Service、Connector 和 MCP 的审计记录只保存脱敏摘要。</p></SettingInfoPanel>
}

function WorkspaceSettingsPanel(): React.JSX.Element {
  const status = useQuery({ queryKey: ['workspace-status'], queryFn: () => getWorkbenchApi().workspace.status(), refetchInterval: 5000 })
  return <SettingInfoPanel eyebrow="SETTINGS / WORKSPACE" title="工作区与数据"><p>Workbench 使用安装目录下由 Main/Core 解析的 <code className="font-mono text-foreground">workspace.sqlite3</code> 作为统一权威数据库；Renderer 不直接持有数据库句柄。</p><div className="grid gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs"><span>Service：<strong className="text-foreground">{status.data?.status ?? '检测中'}</strong></span><span>Database：<strong className="text-foreground">{status.data?.database ?? '检测中'}</strong></span><span>配置可以来自安装目录 .env，打包后覆盖 .env 并重启即可。</span></div><p>迁移由 Workspace Service 执行并保留版本记录；切换数据目录必须通过受信任的安装目录或显式绝对路径。</p></SettingInfoPanel>
}

function LiteratureSettingsPanel(): React.JSX.Element {
  const sources = [['Crossref', 'https://api.crossref.org/works'], ['OpenAlex', 'https://api.openalex.org/works'], ['PubMed', 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'], ['arXiv', 'https://export.arxiv.org/api/query'], ['Semantic Scholar', 'https://api.semanticscholar.org/graph/v1/paper/search'], ['Google Scholar', 'scholarly sidecar（用户触发、逐页）']]
  return <SettingInfoPanel eyebrow="SETTINGS / LITERATURE" title="文献检索"><p>默认使用全部免费来源并行检索，每页 50 条；失败来源按部分失败显示，不伪造成功。排序支持相关性、年份、影响因子、标题和开放引用代理指标。</p><div className="grid gap-2">{sources.map(([name, url]) => <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs" key={name}><span className="font-semibold text-foreground">{name}</span><code className="break-all font-mono text-muted-foreground">{url}</code></div>)}</div><p>Crossref/OpenAlex 等公共元数据源不提供 JCR 期刊影响因子；页面只展示来源明确提供的影响因子及获取时间，并将公开引用指标单独标为“公开引用指标”。各来源 API Key（如有）通过连接配置的凭据字段保存到 Main safeStorage；不会写入 SQLite、localStorage 或日志。Google Scholar 通过本机 scholarly 侧车按用户触发、逐页运行，遇到验证码或限流立即停止。首次使用请安装项目附带的 <code className="font-mono text-foreground">sidecars/requirements.txt</code>，应用不会静默安装 Python 依赖。</p><p>检索结果导入 Zotero 固定走 API 预览 → 明确确认 → 逐条回执。权限不足、版本冲突或网络错误会显示为失败，并可从失败项重新预览和再次导入；不会把生成文件误报为已写入。</p></SettingInfoPanel>
}

function ProxySettingsPanel(): React.JSX.Element {
  const profiles = useQuery({ queryKey: ['proxy-profiles'], queryFn: () => getWorkbenchAgentApi().proxyProfiles.list() })
  const bindings = useQuery({ queryKey: ['proxy-bindings'], queryFn: () => getWorkbenchAgentApi().proxyBindings.list() })
  const [name, setName] = useState('默认代理')
  const [endpoint, setEndpoint] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [editing, setEditing] = useState<AgentProxyProfile | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: () => getWorkbenchAgentApi().proxyProfiles.save({ id: editing?.id, name: name.trim() || '默认代理', enabled, httpProxy: endpoint.trim() || null, httpsProxy: endpoint.trim() || null, noProxy: 'localhost,127.0.0.1,::1', expectedRevision: editing?.revision ?? null }),
    onSuccess: async () => { setFeedback('代理 Profile 已保存；文献、Scholar 和 Agent 将使用启用的配置。'); setEditing(null); setName('默认代理'); setEndpoint(''); setEnabled(true); await profiles.refetch() },
    onError: (error) => setFeedback(getErrorMessage(error))
  })
  const bind = useMutation({
    mutationFn: ({ runtime, profileId }: { runtime: AgentRuntimeKind; profileId: string }) => {
      const current = (bindings.data ?? []).find((item) => item.runtime === runtime)
      return getWorkbenchAgentApi().proxyBindings.save({ id: current?.id, runtime, profileId, expectedRevision: current?.revision ?? null })
    },
    onSuccess: async () => { setFeedback('Agent runtime 的代理绑定已保存。'); await bindings.refetch() },
    onError: (error) => setFeedback(getErrorMessage(error))
  })
  const runtimes: Array<{ runtime: AgentRuntimeKind; label: string }> = [{ runtime: 'pi', label: 'Pi（内嵌 Agent）' }]
  return <SettingInfoPanel eyebrow="SETTINGS / PROXY" title="统一网络代理">
    <p>代理配置与文献检索同级管理。启用的 Profile 会供 Literature、Google Scholar、Agent 和其他联网工具复用；本机地址默认绕过代理。</p>
    <div className="settings-form-grid">
      <label>Profile 名称<Input value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>HTTP / HTTPS 代理<Input placeholder="http://127.0.0.1:7897" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label>
    </div>
    <label className="research-check-row mt-3"><input checked={enabled} className="research-checkbox" onChange={(event) => setEnabled(event.target.checked)} type="checkbox" /><span>启用此代理 Profile</span></label>
    <div className="form-actions mt-3"><Button loading={save.isPending} onClick={() => save.mutate()} size="sm" variant="primary"><Save aria-hidden="true" className="size-3.5" />{editing ? '保存 Profile 修改' : '保存代理 Profile'}</Button>{editing ? <Button onClick={() => { setEditing(null); setName('默认代理'); setEndpoint(''); setEnabled(true) }} size="sm" variant="ghost">取消编辑</Button> : null}</div>
    {feedback ? <p className="form-feedback mt-3" role="status">{feedback}</p> : null}
    <div className="mt-4 grid gap-2">{(profiles.data ?? []).map((profile) => <div className="settings-row rounded-md border border-border" key={profile.id}><div className="min-w-0 flex-1"><span className="font-semibold text-foreground">{profile.name}</span><span className="ml-2 text-xs text-muted-foreground">{profile.enabled ? '已启用' : '已停用'} · {profile.httpProxy ?? '未配置'}</span></div><Button aria-label={`编辑代理 Profile ${profile.name}`} onClick={() => { setEditing(profile); setName(profile.name); setEndpoint(profile.httpsProxy ?? profile.httpProxy ?? ''); setEnabled(profile.enabled); setFeedback(null) }} size="icon" variant="ghost"><Edit3 aria-hidden="true" className="size-3.5" /></Button></div>)}</div>
    <div className="mt-4 rounded-lg border border-border bg-muted/20 p-4">
      <p className="text-sm font-semibold text-foreground">Agent runtime 绑定</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">绑定只决定 Agent 使用哪个 Profile；未绑定时自动使用第一个启用的 Profile。Literature、scholarly 和其他工具共享启用的 Profile。</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">{runtimes.map(({ runtime, label }) => {
        const selected = (bindings.data ?? []).find((item) => item.runtime === runtime)?.profileId ?? ''
        return <label className="grid gap-1 text-xs font-semibold text-muted-foreground" key={runtime}>{label}
          <select className="select-control" disabled={bind.isPending || (profiles.data ?? []).filter((profile) => profile.enabled).length === 0} onChange={(event) => { if (event.target.value) bind.mutate({ runtime, profileId: event.target.value }) }} value={selected}>
            {!selected ? <option value="">自动选择启用的 Profile</option> : null}
            {(profiles.data ?? []).map((profile) => <option disabled={!profile.enabled} key={profile.id} value={profile.id}>{profile.name}{profile.enabled ? '' : '（已停用）'}</option>)}
          </select>
        </label>
      })}</div>
    </div>
    <p className="mt-3 text-xs text-muted-foreground">Agent 页面只维护运行时能力和启用状态；代理 Profile 与绑定统一在这里维护。Zotero Local API、Workspace Service 和其他 localhost 地址由 NO_PROXY 绕过。</p>
  </SettingInfoPanel>
}

/** One in-flight interactive login. `prompt` is the only blocking step; the
 * owning Provider row stays expanded until Core pushes `done` or the user cancels. */
interface ActiveLogin {
  loginId: string
  provider: string
  authType: AgentAuthType
  message: string
  url: string | null
  instructions: string | null
  deviceCode: { userCode: string; verificationUri: string } | null
  prompt: { promptId: string; kind: AgentAuthPromptKind; message: string; placeholder: string | null; options: AgentAuthPromptOption[] } | null
}

interface AgentAuthState {
  login: ActiveLogin | null
  promptValue: string
}

const authTypeLabels: Record<AgentAuthType, string> = { api_key: 'API Key', oauth: 'OAuth 登录' }
const permissionModeLabels: Record<AgentPermissionMode, string> = { 'read-only': '只读（不写入）', auto: '自动批准（本地写入直接生效）', 'full-access': '完全访问（本地写入直接生效）' }
const toolProfileLabels: Record<AgentToolProfile, string> = { 'read-only': '仅读取任务/日历', 'approved-write': '可创建与更新任务、日历、提醒' }

/** Provider configuration: credentials, default model and local write policy.
 * Everything here is app-owned. Secrets move one way only — the API Key input is
 * cleared on success and the vault status is a boolean, never the value. */
function AgentModelSettingsPanel({ authFeedback, authState, onLoginAttempt, onLoginCancelled, onLoginPromptAnswered, onLoginStarted, onPromptValueChange }: {
  authFeedback: string | null
  authState: AgentAuthState
  onLoginAttempt: (provider: string) => void
  onLoginCancelled: (loginId: string) => void
  onLoginPromptAnswered: (loginId: string) => void
  onLoginStarted: (loginId: string) => void
  onPromptValueChange: (value: string) => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const statusQuery = useQuery({ queryKey: ['agent-credential-status'], queryFn: () => getWorkbenchAgentApi().credentials.status() })
  const catalogQuery = useQuery({ queryKey: ['agent-model-catalog'], queryFn: () => getWorkbenchAgentApi().models.catalog() })
  const settingsQuery = useQuery({ queryKey: ['agent-settings'], queryFn: () => getWorkbenchAgentApi().settings.get() })
  const [draft, setDraft] = useState<AgentSettingsSaveInput | null>(null)
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  // One inline key editor at a time. The value is renderer state only until it
  // is submitted, and the reply from Main is a status list, never the key.
  const [keyTarget, setKeyTarget] = useState<string | null>(null)
  const [keyValue, setKeyValue] = useState('')
  const [providerFilter, setProviderFilter] = useState('')
  const [feedback, setFeedback] = useState<string | null>(null)
  const { login, promptValue } = authState

  const settings = settingsQuery.data ?? null
  // The form is seeded from the stored row and then owned locally, so a slow
  // refetch cannot overwrite what the user is currently editing.
  useEffect(() => {
    if (!settings) return
    setDraft((current) => current ?? {
      provider: settings.provider,
      model: settings.model,
      thinking: settings.thinking,
      permissionMode: settings.permissionMode,
      toolProfile: settings.toolProfile,
      approvalPolicy: settings.approvalPolicy,
      responseLanguage: settings.responseLanguage,
      expectedRevision: settings.revision
    })
  }, [settings])
  useEffect(() => {
    if (selectedProvider || !settings) return
    setSelectedProvider(settings.provider ?? '')
  }, [selectedProvider, settings])
  useEffect(() => {
    // A `/key <provider>` command in the Agent chat can only hand over a provider
    // id, never a key, so the command's whole effect is to land here with that
    // provider's key editor already open.
    const target = takePendingProviderTarget()
    if (!target) return
    setSelectedProvider(target.provider)
    if (target.intent === 'key') setKeyTarget(target.provider)
  }, [])

  const saveCredential = useMutation({
    mutationFn: (input: { provider: string; apiKey: string | null }) => getWorkbenchAgentApi().credentials.save(input),
    onSuccess: (statuses, input) => {
      setKeyValue('')
      setKeyTarget(null)
      setFeedback(input.apiKey === null ? `${input.provider} 的凭据已清除。` : `${input.provider} 的 API Key 已保存到本机 safeStorage；页面不会回显密钥。`)
      queryClient.setQueryData(['agent-credential-status'], statuses)
      void queryClient.invalidateQueries({ queryKey: ['agent-model-catalog'] })
    },
    onError: (error) => setFeedback(getErrorMessage(error))
  })
  const startLogin = useMutation({
    mutationFn: (provider: string) => getWorkbenchAgentApi().models.loginStart({ provider }),
    onMutate: (provider) => onLoginAttempt(provider),
    onSuccess: (result, provider) => { onLoginStarted(result.loginId); setSelectedProvider(provider); setFeedback(null) },
    onError: (error) => { onLoginCancelled(''); setFeedback(getErrorMessage(error)) }
  })
  const answerLogin = useMutation({
    mutationFn: (input: { loginId: string; promptId: string; value: string }) => getWorkbenchAgentApi().models.loginAnswer(input),
    onSuccess: (_result, input) => { onPromptValueChange(''); onLoginPromptAnswered(input.loginId) },
    onError: (error) => setFeedback(getErrorMessage(error))
  })
  const cancelLogin = useMutation({
    mutationFn: (loginId: string) => getWorkbenchAgentApi().models.loginCancel({ loginId }),
    onSuccess: (_result, loginId) => { onLoginCancelled(loginId); setFeedback('已取消登录。') },
    onError: (error) => setFeedback(getErrorMessage(error))
  })
  const logout = useMutation({
    mutationFn: (provider: string) => getWorkbenchAgentApi().models.logout({ provider }),
    onSuccess: (statuses) => { setFeedback('已登出并清除本机凭据。'); queryClient.setQueryData(['agent-credential-status'], statuses) },
    onError: (error) => setFeedback(getErrorMessage(error))
  })
  const saveSettings = useMutation({
    mutationFn: (input: AgentSettingsSaveInput) => getWorkbenchAgentApi().settings.save(input),
    onSuccess: (saved) => { setFeedback('默认模型与本地写入策略已保存。'); setDraft({ ...saved, expectedRevision: saved.revision }); queryClient.setQueryData(['agent-settings'], saved) },
    onError: (error) => setFeedback(getErrorMessage(error))
  })

  if (statusQuery.isLoading || catalogQuery.isLoading || settingsQuery.isLoading) {
    return <SettingInfoPanel eyebrow="SETTINGS / MODELS" title="模型与 Agent"><LoadingState label="正在加载内嵌 Pi 运行时与模型目录…" /></SettingInfoPanel>
  }
  if (statusQuery.error || catalogQuery.error || settingsQuery.error) {
    return <SettingInfoPanel eyebrow="SETTINGS / MODELS" title="模型与 Agent"><ErrorState error={statusQuery.error ?? catalogQuery.error ?? settingsQuery.error} onRetry={() => { void statusQuery.refetch(); void catalogQuery.refetch(); void settingsQuery.refetch() }} /></SettingInfoPanel>
  }
  if (!draft) return <SettingInfoPanel eyebrow="SETTINGS / MODELS" title="模型与 Agent"><LoadingState label="正在准备表单…" /></SettingInfoPanel>

  const catalog = catalogQuery.data ?? []
  const providerEntries = mergeProviderEntries(catalog, statusQuery.data ?? [])
  const activeCatalog = catalog.find((entry) => entry.provider === draft.provider) ?? null
  const configuredProviders = providerEntries.filter((entry) => entry.credentialPresent)
  const selectedModel = (activeCatalog?.models ?? []).find((model) => model.id === draft.model) ?? null
  // The stored default is an exact `provider/modelId` selector, so it is only
  // savable while that exact pair exists in the catalog. Allowing anything else
  // would store a preference for a model that does not exist and move the
  // failure to the next run instead of leaving it here.
  const defaultIssue = defaultSelectionIssue(draft.provider, draft.model, catalog)
  return <SettingInfoPanel eyebrow="SETTINGS / MODELS" title="模型与 Agent">
    <p>模型凭据、默认模型与本地写入策略都在这里维护。凭据只保存在本机 Main 进程的 safeStorage 中，不写入数据库、不进入日志，也不会复用 Pi CLI 的个人登录态；运行时在本进程内直接加载 Pi SDK，不启动外部 CLI 进程，也不读取 <code>~/.pi</code>、<code>~/.codex</code>。</p>

    <ProviderSetupList
      catalog={catalog}
      disabled={saveCredential.isPending || startLogin.isPending || logout.isPending}
      entries={providerEntries}
      filter={providerFilter}
      answerPending={answerLogin.isPending}
      keyTarget={keyTarget}
      keyValue={keyValue}
      onCancelKey={() => { setKeyTarget(null); setKeyValue('') }}
      onClear={(provider) => saveCredential.mutate({ provider, apiKey: null })}
      onFilterChange={setProviderFilter}
      onKeyChange={setKeyValue}
      onLogin={(provider) => { setFeedback(null); startLogin.mutate(provider) }}
      onLogout={(provider) => logout.mutate(provider)}
      onOpenKey={(provider) => { setSelectedProvider(provider); setKeyTarget(provider); setKeyValue('') }}
      onSaveKey={(provider) => saveCredential.mutate({ provider, apiKey: keyValue })}
      login={login}
      onAnswerLogin={(input) => answerLogin.mutate(input)}
      onLoginAttempt={onLoginAttempt}
      onCancelLogin={(loginId) => cancelLogin.mutate(loginId)}
      onPromptValueChange={onPromptValueChange}
      promptValue={promptValue}
      onSelect={setSelectedProvider}
    />
    <p className="agent-credential-status" id="agent-api-key-hint">API Key 只在密码输入框中提交，保存后立即写入 Main 的 safeStorage 并只回传状态；页面、SQLite、账本与日志都不保存密钥明文。</p>

    <div className="settings-form-grid mt-4">
      <label>默认 Provider
        <select className="select-control" onChange={(event) => setDraft({ ...draft, provider: event.target.value || null, model: null, thinking: null })} value={draft.provider ?? ''}>
          <option value="">未指定（运行时使用第一个已配置的凭据）</option>
          {configuredProviders.map((entry) => <option key={entry.provider} value={entry.provider}>{entry.label}</option>)}
        </select>
      </label>
      <label>默认模型
        <select className="select-control" disabled={draft.provider === null} onChange={(event) => { const model = (activeCatalog?.models ?? []).find((item) => item.id === event.target.value) ?? null; setDraft({ ...draft, model: event.target.value || null, thinking: model && draft.thinking && model.thinkingLevels.includes(draft.thinking) ? draft.thinking : (model?.thinkingLevels[0] ?? null) }) }} value={draft.model ?? ''}>
          <option value="">跟随 provider 默认</option>
          {(activeCatalog?.models ?? []).map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </label>
      <label>Thinking 深度
        <select className="select-control" disabled={!selectedModel || selectedModel.thinkingLevels.length === 0} onChange={(event) => setDraft({ ...draft, thinking: event.target.value || null })} value={draft.thinking ?? ''}>
          <option value="">模型默认</option>
          {(selectedModel?.thinkingLevels ?? []).map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
      </label>
      <label>默认权限模式
        <select className="select-control" onChange={(event) => setDraft({ ...draft, permissionMode: event.target.value as AgentPermissionMode })} value={draft.permissionMode}>
          {(Object.keys(permissionModeLabels) as AgentPermissionMode[]).map((mode) => <option key={mode} value={mode}>{permissionModeLabels[mode]}</option>)}
        </select>
      </label>
      <label>本地工具范围
        <select className="select-control" onChange={(event) => setDraft({ ...draft, toolProfile: event.target.value as AgentToolProfile })} value={draft.toolProfile}>
          {(Object.keys(toolProfileLabels) as AgentToolProfile[]).map((profile) => <option key={profile} value={profile}>{toolProfileLabels[profile]}</option>)}
        </select>
      </label>
    </div>
    <div className="form-actions mt-3">
      <Button disabled={defaultIssue !== null} loading={saveSettings.isPending} onClick={() => saveSettings.mutate({ ...draft, model: draft.model?.trim() || null, thinking: draft.thinking?.trim() || null })} size="sm" variant="primary"><Save aria-hidden="true" className="size-3.5" />保存默认配置</Button>
      <span className="text-xs text-muted-foreground">Revision {settings?.revision ?? 0} · 最近更新 {settings ? formatDateTime(settings.updatedAt) : '—'}</span>
    </div>
    <p className="mt-2 text-xs text-muted-foreground">{defaultSelectionSummary(draft.provider, draft.model)}</p>
    {defaultIssue ? <p className="mt-1 text-xs text-danger" role="alert">{defaultIssue}</p> : null}
    {feedback ?? authFeedback ? <p aria-live="polite" className="form-feedback mt-3" role="status">{feedback ?? authFeedback}</p> : null}

    <CustomProviderSection />
  </SettingInfoPanel>
}

/**
 * The Agent chat cannot carry a secret, so `/key <provider>` leaves the provider
 * id here and the panel picks it up when it mounts. Reading is a take: the
 * request is consumed so a later unrelated Settings visit does not reopen it.
 */
function takePendingProviderTarget(): { provider: string; intent: 'key' | 'login' } | null {
  try {
    const provider = localStorage.getItem('workbench-agent-command-provider')
    if (!provider) return null
    const intent = localStorage.getItem('workbench-agent-command-intent') === 'key' ? 'key' : 'login'
    localStorage.removeItem('workbench-agent-command-provider')
    localStorage.removeItem('workbench-agent-command-intent')
    return { provider, intent }
  } catch {
    // Renderer storage is optional; a blocked store only means no deep link.
    return null
  }
}

/** Providers are the union of the SDK catalog and the stored vault index, so a
 * credential whose provider disappeared from the SDK stays visible and therefore
 * deletable instead of becoming an invisible orphan in safeStorage. */
function mergeProviderEntries(catalog: AgentModelCatalogEntry[], statuses: AgentCredentialStatus[]): AgentCredentialStatus[] {
  const merged = new Map<string, AgentCredentialStatus>()
  for (const status of statuses) merged.set(status.provider, status)
  for (const entry of catalog) {
    const existing = merged.get(entry.provider)
    merged.set(entry.provider, {
      provider: entry.provider,
      label: existing?.label && existing.label !== entry.provider ? existing.label : entry.name,
      credentialPresent: existing?.credentialPresent ?? false,
      authType: existing?.authType ?? null,
      updatedAt: existing?.updatedAt ?? null
    })
  }
  return [...merged.values()].sort((left, right) => Number(right.credentialPresent) - Number(left.credentialPresent) || left.label.localeCompare(right.label))
}

/**
 * Pi's OAuth detail stays inside the provider row. This is intentionally not a
 * page-level dialog: the URL/device code/manual callback answer belongs to the
 * provider that started the login and must remain adjacent to its controls.
 */
function ProviderAuthFlow({ login, promptValue, answerPending, onAnswerLogin, onCancelLogin, onPromptValueChange }: {
  login: ActiveLogin
  promptValue: string
  answerPending: boolean
  onAnswerLogin: (input: { loginId: string; promptId: string; value: string }) => void
  onCancelLogin: (loginId: string) => void
  onPromptValueChange: (value: string) => void
}): React.JSX.Element {
  const prompt = login.prompt
  return <div aria-live="polite" className="agent-provider-auth-flow" role="status">
    <div className="agent-provider-auth-heading">
      <strong>{authTypeLabels[login.authType]}</strong>
      <span className="research-tag">{login.message}</span>
    </div>
    {login.url ? <p className="agent-provider-auth-copy">授权地址：<ExternalUrlLink ariaLabel="在浏览器中打开授权地址" fieldLabel="授权地址" href={login.url} label={login.url} />{login.instructions ? ` — ${login.instructions}` : ''}</p> : null}
    {login.deviceCode ? <p className="agent-provider-auth-copy">设备码 <code>{login.deviceCode.userCode}</code> · <ExternalUrlLink ariaLabel="在浏览器中打开设备码验证页" fieldLabel="设备码验证地址" href={login.deviceCode.verificationUri} label={login.deviceCode.verificationUri} /></p> : null}
    {prompt ? <form className="agent-provider-auth-form" onSubmit={(event) => { event.preventDefault(); onAnswerLogin({ loginId: login.loginId, promptId: prompt.promptId, value: promptValue }) }}>
      <label>{prompt.message}
        {prompt.kind === 'select'
          ? <select className="select-control" disabled={answerPending} onChange={(event) => onPromptValueChange(event.target.value)} value={promptValue}>{prompt.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          : <Input autoComplete="off" disabled={answerPending} onChange={(event) => onPromptValueChange(event.target.value)} placeholder={prompt.placeholder ?? '按 Pi 提示输入'} type={prompt.kind === 'secret' ? 'password' : 'text'} value={promptValue} />}
      </label>
      <div className="agent-provider-auth-actions"><Button disabled={answerPending || (prompt.kind === 'select' && promptValue === '')} loading={answerPending} size="sm" type="submit" variant="primary">提交</Button><Button disabled={answerPending} onClick={() => onCancelLogin(login.loginId)} size="sm" type="button" variant="ghost">取消登录</Button></div>
    </form> : <div className="agent-provider-auth-actions"><Button disabled={answerPending} onClick={() => onCancelLogin(login.loginId)} size="sm" variant="ghost">取消登录</Button></div>}
  </div>
}

/**
 * Provider rows, each of which owns its credential.
 *
 * One consolidated row per provider is deliberate: a key belongs to exactly one
 * provider, and a shared "Provider + API Key" pair above the list let the two
 * halves disagree (a key could be typed while another provider was selected).
 * The row never renders a stored secret — `credentialPresent` is a boolean.
 */
function ProviderSetupList({ answerPending, catalog, disabled, entries, filter, keyTarget, keyValue, login, onAnswerLogin, onCancelKey, onCancelLogin, onClear, onFilterChange, onKeyChange, onLogin, onLoginAttempt, onLogout, onOpenKey, onPromptValueChange, onSaveKey, onSelect, promptValue }: {
  catalog: AgentModelCatalogEntry[]
  disabled: boolean
  answerPending: boolean
  entries: AgentCredentialStatus[]
  filter: string
  keyTarget: string | null
  keyValue: string
  onCancelKey: () => void
  onClear: (provider: string) => void
  onFilterChange: (value: string) => void
  onKeyChange: (value: string) => void
  onLogin: (provider: string) => void
  onLoginAttempt: (provider: string) => void
  onLogout: (provider: string) => void
  onOpenKey: (provider: string) => void
  onSaveKey: (provider: string) => void
  login: ActiveLogin | null
  onAnswerLogin: (input: { loginId: string; promptId: string; value: string }) => void
  onCancelLogin: (loginId: string) => void
  onPromptValueChange: (value: string) => void
  promptValue: string
  onSelect: (provider: string) => void
}): React.JSX.Element {
  if (entries.length === 0) {
    return <p className="mt-4 text-xs text-muted-foreground">模型目录为空：内嵌的 Pi SDK 未返回任何 provider，请检查安装是否完整。</p>
  }
  const needle = filter.trim().toLowerCase()
  const visible = needle.length === 0
    ? entries
    : entries.filter((entry) => entry.provider.toLowerCase().includes(needle) || entry.label.toLowerCase().includes(needle))
  return <div className="mt-4 grid gap-2">
    {entries.length > 8
      ? <Input aria-label="筛选 Provider" className="max-w-sm" onChange={(event) => onFilterChange(event.target.value)} placeholder="按名称或 id 筛选 Provider" type="search" value={filter} />
      : null}
    {visible.length === 0 ? <p className="text-xs text-muted-foreground">没有匹配 “{filter.trim()}” 的 Provider。</p> : null}
    {visible.map((entry) => {
      const authTypes = catalog.find((item) => item.provider === entry.provider)?.authTypes ?? []
      const editing = keyTarget === entry.provider
      const keyLabel = entry.credentialPresent && entry.authType === 'api_key' ? '更换 API Key' : '设置 API Key'
      const activeLogin = login?.provider === entry.provider ? login : null
      return <div className="settings-row rounded-md border border-border" key={entry.provider}>
        <div className="min-w-0 flex-1">
          <button className="agent-runtime-name" onClick={() => onSelect(entry.provider)} type="button"><span aria-hidden="true" className={cn('agent-runtime-dot', entry.credentialPresent ? 'agent-runtime-dot-online' : 'agent-runtime-dot-muted')} />{entry.label}</button>
          <span className="ml-2 text-xs text-muted-foreground">{entry.credentialPresent ? `已配置${entry.authType ? ` · ${authTypeLabels[entry.authType]}` : ''}${entry.updatedAt ? ` · ${formatDateTime(entry.updatedAt)}` : ''}` : '未配置'} · 可用认证：{authTypes.length > 0 ? authTypes.map((type) => authTypeLabels[type]).join(' / ') : '未声明'}</span>
        </div>
        {authTypes.includes('api_key')
          ? <Button disabled={disabled} onClick={() => (editing ? onCancelKey() : onOpenKey(entry.provider))} size="sm" variant="secondary"><KeyRound aria-hidden="true" className="size-3.5" />{editing ? '取消' : keyLabel}</Button>
          : null}
        {authTypes.includes('oauth')
          ? <Button disabled={disabled || login !== null} onClick={() => { onLoginAttempt(entry.provider); onLogin(entry.provider) }} size="sm" variant="secondary">{entry.credentialPresent && entry.authType === 'oauth' ? '重新授权' : 'OAuth 登录'}<ExternalLink aria-hidden="true" className="size-3.5" /></Button>
          : null}
        {entry.credentialPresent ? <Button disabled={disabled} onClick={() => (entry.authType === 'oauth' ? onLogout(entry.provider) : onClear(entry.provider))} size="sm" variant="ghost"><Trash2 aria-hidden="true" className="size-3.5" />{entry.authType === 'oauth' ? '登出并清除' : '清除凭据'}</Button> : null}
        {editing ? <form className="settings-row-key" onSubmit={(event) => { event.preventDefault(); if (keyValue.trim().length > 0) onSaveKey(entry.provider) }}>
          <Input
            aria-describedby="agent-api-key-hint"
            aria-label={`${entry.label} 的 API Key`}
            autoComplete="off"
            disabled={disabled}
            onChange={(event) => onKeyChange(event.target.value)}
            placeholder={entry.credentialPresent ? '已保存；输入新值可替换' : '粘贴该服务的 API Key'}
            type="password"
            value={keyValue}
          />
          <Button disabled={disabled || keyValue.trim().length === 0} size="sm" type="submit" variant="primary"><Save aria-hidden="true" className="size-3.5" />保存</Button>
        </form> : null}
        {activeLogin ? <ProviderAuthFlow
          answerPending={answerPending}
          login={activeLogin}
          onAnswerLogin={onAnswerLogin}
          onCancelLogin={onCancelLogin}
          onPromptValueChange={onPromptValueChange}
          promptValue={promptValue}
        /> : null}
      </div>
    })}
  </div>
}

type KnowledgeEngineDraft = {
  enabled: boolean
  baseUrl: string
  workspace: string
  collection: string
  credential: string
}

const emptyKnowledgeEngineDraft = (): KnowledgeEngineDraft => ({
  enabled: true,
  baseUrl: '',
  workspace: '',
  collection: '',
  credential: ''
})

function EnginesPanel(): React.JSX.Element {
  const queryClient = useQueryClient()
  const engines = useQuery({
    queryKey: ['knowledge-engines'],
    queryFn: () => getWorkbenchApi().knowledge.engines.list()
  })
  const [drafts, setDrafts] = useState<Record<KnowledgeEngineKind, KnowledgeEngineDraft>>({
    anythingllm: emptyKnowledgeEngineDraft(),
    llmwiki: emptyKnowledgeEngineDraft()
  })
  const [feedback, setFeedback] = useState<string | null>(null)
  const labels: Record<KnowledgeEngineKind, string> = { anythingllm: 'AnythingLLM', llmwiki: 'LLMWiki' }
  const descriptions: Record<KnowledgeEngineKind, string> = {
    anythingllm: '连接本机或 HTTPS AnythingLLM 工作区，用于后续文献语料索引。',
    llmwiki: '连接 LLMWiki 页面/知识图服务；不会覆盖 Obsidian 原始文本。'
  }

  useEffect(() => {
    if (!engines.data) return
    setDrafts((current) => Object.fromEntries(engines.data.map((engine) => [engine.kind, {
      enabled: engine.enabled,
      baseUrl: engine.baseUrl,
      workspace: engine.workspace,
      collection: engine.collection,
      // Credentials never round-trip through Renderer.
      credential: current[engine.kind].credential
    }])) as Record<KnowledgeEngineKind, KnowledgeEngineDraft>)
  }, [engines.data])

  const saveMutation = useMutation({
    mutationFn: (kind: KnowledgeEngineKind) => {
      const current = engines.data?.find((engine) => engine.kind === kind)
      const draft = drafts[kind]
      return getWorkbenchApi().knowledge.engines.save({
        kind,
        enabled: draft.enabled,
        baseUrl: draft.baseUrl.trim(),
        workspace: draft.workspace.trim(),
        collection: draft.collection.trim(),
        ...(draft.credential ? { credential: draft.credential } : {}),
        expectedRevision: current?.revision ?? null
      })
    },
    onSuccess: async (saved) => {
      setDrafts((current) => ({ ...current, [saved.kind]: { ...current[saved.kind], credential: '' } }))
      setFeedback(`${labels[saved.kind]} 配置已保存；点击“测试连接”获取实时状态。`)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['knowledge-engines'] }),
        queryClient.invalidateQueries({ queryKey: ['workspace-status'] })
      ])
    },
    onError: (error) => setFeedback(getErrorMessage(error))
  })
  const testMutation = useMutation({
    mutationFn: (kind: KnowledgeEngineKind) => getWorkbenchApi().knowledge.engines.test({ kind }),
    onSuccess: async (result) => {
      setFeedback(result.message)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['knowledge-engines'] }),
        queryClient.invalidateQueries({ queryKey: ['workspace-status'] })
      ])
    },
    onError: (error) => setFeedback(getErrorMessage(error))
  })

  if (engines.isLoading) return <SettingInfoPanel eyebrow="SETTINGS / ENGINES" title="知识引擎"><LoadingState label="正在读取知识引擎配置…" /></SettingInfoPanel>
  if (engines.error) return <SettingInfoPanel eyebrow="SETTINGS / ENGINES" title="知识引擎"><ErrorState error={engines.error} onRetry={() => void engines.refetch()} /></SettingInfoPanel>

  return <SettingInfoPanel eyebrow="SETTINGS / ENGINES" title="知识引擎">
    <p>地址、工作区和集合标识保存在 SQLite；API Key 仅保存在 Electron Main 的 safeStorage，页面不会回显。</p>
    <div className="grid gap-3 xl:grid-cols-2">
      {(engines.data ?? []).map((engine: KnowledgeEngineConfig) => {
        const draft = drafts[engine.kind]
        return <article className="settings-engine gap-3 p-4" key={engine.kind}>
          <div className="flex flex-wrap items-start justify-between gap-2"><div><strong>{labels[engine.kind]}</strong><p className="mt-1">{descriptions[engine.kind]}</p></div><StatusBadge status={engine.status} /></div>
          <label className="grid gap-1 text-[11px] font-semibold text-muted-foreground">服务地址<Input aria-label={`${labels[engine.kind]} 服务地址`} onChange={(event) => setDrafts((current) => ({ ...current, [engine.kind]: { ...current[engine.kind], baseUrl: event.target.value } }))} placeholder={engine.kind === 'anythingllm' ? 'http://127.0.0.1:3001' : 'http://127.0.0.1:8000'} value={draft.baseUrl} /></label>
          <div className="grid gap-2 sm:grid-cols-2"><label className="grid gap-1 text-[11px] font-semibold text-muted-foreground">Workspace<Input aria-label={`${labels[engine.kind]} Workspace`} onChange={(event) => setDrafts((current) => ({ ...current, [engine.kind]: { ...current[engine.kind], workspace: event.target.value } }))} placeholder="可选" value={draft.workspace} /></label><label className="grid gap-1 text-[11px] font-semibold text-muted-foreground">Collection / Wiki<Input aria-label={`${labels[engine.kind]} Collection`} onChange={(event) => setDrafts((current) => ({ ...current, [engine.kind]: { ...current[engine.kind], collection: event.target.value } }))} placeholder="可选" value={draft.collection} /></label></div>
          <label className="grid gap-1 text-[11px] font-semibold text-muted-foreground">API Key<Input aria-label={`${labels[engine.kind]} API Key`} autoComplete="off" onChange={(event) => setDrafts((current) => ({ ...current, [engine.kind]: { ...current[engine.kind], credential: event.target.value } }))} placeholder={engine.credentialPresent ? '已安全保存；留空保持不变' : '可选'} type="password" value={draft.credential} /></label>
          <div className="flex flex-wrap items-center gap-2"><label className="mr-auto flex items-center gap-2 text-xs text-muted-foreground"><input checked={draft.enabled} className="research-checkbox" onChange={(event) => setDrafts((current) => ({ ...current, [engine.kind]: { ...current[engine.kind], enabled: event.target.checked } }))} type="checkbox" />启用</label><Button loading={saveMutation.isPending && saveMutation.variables === engine.kind} onClick={() => saveMutation.mutate(engine.kind)} size="sm" variant="secondary"><Save aria-hidden="true" className="size-3.5" />保存</Button><Button disabled={!draft.enabled || !draft.baseUrl.trim()} loading={testMutation.isPending && testMutation.variables === engine.kind} onClick={() => testMutation.mutate(engine.kind)} size="sm"><TestTube2 aria-hidden="true" className="size-3.5" />测试连接</Button></div>
          <p className="text-[11px]">上次检查：{formatDateTime(engine.lastCheckedAt)}{engine.lastError ? ` · ${engine.lastError}` : ''}</p>
        </article>
      })}
    </div>
    {feedback ? <p aria-live="polite" className={cn('form-feedback', (saveMutation.error || testMutation.error) ? 'form-feedback-error' : 'form-feedback-success')} role="status">{feedback}</p> : null}
    <p className="text-xs">只有真实健康探测成功才显示 connected。HTTP 仅允许 localhost/127.0.0.1；远程服务必须使用 HTTPS。</p>
  </SettingInfoPanel>
}

function McpSettingsPanel(): React.JSX.Element {
  const status = useQuery({ queryKey: ['workspace-status'], queryFn: () => getWorkbenchApi().workspace.status(), refetchInterval: 5000 })
  return <SettingInfoPanel eyebrow="SETTINGS / MCP" title="MCP Server"><p>首期仅本机 stdio MCP，不开放远程 Streamable HTTP。当前状态：<strong className="text-foreground">{status.data?.mcp ?? '检测中'}</strong>。</p><div className="rounded-md border border-border bg-muted/30 p-3 text-xs leading-5"><p className="font-semibold text-foreground">给其他 Agent 的配置</p><code className="mt-2 block whitespace-pre-wrap font-mono">workspace-mcp --transport stdio{`\n`}# Resources：只读检索/读取{`\n`}# Tools：写入前必须 preview + confirmed=true</code></div><p>启用/禁用由宿主进程和 MCP 客户端配置控制；页面只呈现真实探测状态和配置教程。</p></SettingInfoPanel>
}

export function IntegrationsSettingsPage({ projects: _projects }: { projects: Project[] }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [authState, setAuthState] = useState<AgentAuthState>({ login: null, promptValue: '' })
  const [authFeedback, setAuthFeedback] = useState<string | null>(null)
  const activeLoginId = useRef<string | null>(null)
  const expectedLoginProvider = useRef<string | null>(null)
  const ownedLoginIds = useRef(new Set<string>())

  // Auth events are subscribed above the tab panels. Switching settings tabs
  // must not orphan Pi's login coroutine or lose the prompt needed to finish it.
  useEffect(() => {
    const unsubscribe = getWorkbenchAgentApi().models.onAuthEvent((event) => {
      const owned = ownedLoginIds.current.has(event.loginId)
      const expected = event.kind === 'started' && expectedLoginProvider.current === event.provider
      if (!owned && event.kind === 'started' && activeLoginId.current === null && expected) {
        ownedLoginIds.current.add(event.loginId)
        activeLoginId.current = event.loginId
        expectedLoginProvider.current = null
      }
      if (!ownedLoginIds.current.has(event.loginId) || (activeLoginId.current !== null && activeLoginId.current !== event.loginId)) return
      switch (event.kind) {
        case 'started':
          activeLoginId.current = event.loginId
          setAuthState({ login: { loginId: event.loginId, provider: event.provider, authType: event.authType, message: '正在启动授权…', url: null, instructions: null, deviceCode: null, prompt: null }, promptValue: '' })
          break
        case 'info':
          setAuthState((current) => current.login ? { ...current, login: { ...current.login, message: event.message } } : current)
          break
        case 'auth_url':
          setAuthState((current) => current.login ? { ...current, login: { ...current.login, message: '已请求用系统浏览器打开授权页面；若未自动打开，请点击下方链接。', url: event.url, instructions: event.instructions } } : current)
          break
        case 'device_code':
          setAuthState((current) => current.login ? { ...current, login: { ...current.login, message: '已在浏览器中打开验证页面；若未打开，请点击下方链接。', deviceCode: { userCode: event.userCode, verificationUri: event.verificationUri } } } : current)
          break
        case 'progress':
          setAuthState((current) => current.login ? { ...current, login: { ...current.login, message: event.message } } : current)
          break
        case 'prompt':
          setAuthState((current) => current.login ? { ...current, promptValue: event.promptKind === 'select' ? (event.options[0]?.value ?? '') : '', login: { ...current.login, prompt: { promptId: event.promptId, kind: event.promptKind, message: event.message, placeholder: event.placeholder, options: event.options } } } : current)
          break
        case 'done':
          setAuthFeedback(event.ok ? `${event.provider} 登录完成，凭据已保存到本机 safeStorage。` : (event.error ?? `${event.provider} 登录未完成。`))
          if (event.ok) {
            void queryClient.invalidateQueries({ queryKey: ['agent-credential-status'] })
            void queryClient.invalidateQueries({ queryKey: ['agent-model-catalog'] })
          }
          ownedLoginIds.current.delete(event.loginId)
          if (activeLoginId.current === event.loginId) activeLoginId.current = null
          setAuthState({ login: null, promptValue: '' })
          break
      }
    })
    return () => {
      unsubscribe()
      const loginId = activeLoginId.current
      if (loginId) void getWorkbenchAgentApi().models.loginCancel({ loginId }).catch(() => {})
    }
  }, [queryClient])

  // `pendingSection` is read once on mount and cleared, so a later manual tab
  // change is not undone when the page re-renders.
  const [tab, setTab] = useState<SettingsTab>(() => {
    const requested = pendingSection ?? 'general'
    pendingSection = null
    return requested
  })
  return <div className="page-scroll"><PageHeader description="管理工作区、外部工具、代理、模型认证与知识引擎映射；页面仅显示后端真实状态。" eyebrow="SETTINGS / WORKSPACE" title="设置" /><div className="mt-4"><ResearchTabs items={[{ value: 'general', label: '通用' }, { value: 'workspace', label: '工作区与数据' }, { value: 'literature', label: '文献检索' }, { value: 'proxy', label: '代理' }, { value: 'connectors', label: '工具连接' }, { value: 'rss', label: 'RSS 来源' }, { value: 'agent', label: '模型与 Agent' }, { value: 'engines', label: '知识引擎' }, { value: 'mcp', label: 'MCP Server' }, { value: 'security', label: '安全与审计' }, { value: 'about', label: '关于与更新' }]} label="设置分区" onChange={setTab} value={tab} /></div><div className="mt-4">{tab === 'general' ? <GeneralSettingsPanel /> : null}{tab === 'workspace' ? <WorkspaceSettingsPanel /> : null}{tab === 'literature' ? <LiteratureSettingsPanel /> : null}{tab === 'proxy' ? <ProxySettingsPanel /> : null}{tab === 'connectors' ? <ConnectorsPanel /> : null}{tab === 'rss' ? <RssSourceSettings /> : null}{tab === 'agent' ? <AgentModelSettingsPanel authFeedback={authFeedback} authState={authState} onLoginAttempt={(provider) => { expectedLoginProvider.current = provider; setAuthFeedback(null) }} onLoginCancelled={(loginId) => { expectedLoginProvider.current = null; ownedLoginIds.current.delete(loginId); activeLoginId.current = null; setAuthState({ login: null, promptValue: '' }) }} onLoginPromptAnswered={(loginId) => setAuthState((current) => current.login?.loginId === loginId ? { ...current, promptValue: '', login: { ...current.login, prompt: null } } : current)} onLoginStarted={(loginId) => { ownedLoginIds.current.add(loginId); activeLoginId.current = loginId; expectedLoginProvider.current = null }} onPromptValueChange={(value) => setAuthState((current) => ({ ...current, promptValue: value }))} /> : null}{tab === 'engines' ? <EnginesPanel /> : null}{tab === 'mcp' ? <McpSettingsPanel /> : null}{tab === 'security' ? <SecuritySettingsPanel /> : null}{tab === 'about' ? <UpdatesSettingsPanel /> : null}</div></div>
}
