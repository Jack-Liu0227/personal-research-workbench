import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentConnector, AgentProxyProfile, AgentRuntimeKind, IntegrationProfile, IntegrationProvider, KnowledgeEngineConfig, KnowledgeEngineKind, Project } from '@prw/contracts'
import { Cable, ChevronDown, ChevronUp, Edit3, FolderOpen, Plus, RefreshCw, Save, TestTube2 } from 'lucide-react'
import { Fragment, useEffect, useId, useState, type FormEvent, type ReactElement } from 'react'
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../../components/states'
import { Button, Dialog, DialogClose, DialogContent, DialogTrigger, Field, Input, Textarea } from '../../components/ui'
import { cn, formatDateTime, getErrorMessage } from '../../lib/utils'
import { getWorkbenchAgentApi, getWorkbenchApi } from '../../lib/workbench'
import { queryKeys, useIntegrationsQuery, useSyncRunsQuery } from '../queries'
import { MutationFeedback, ResearchPanel, ResearchTabs, StatusBadge, SyncRunList } from './shared'

type SettingsTab = 'general' | 'workspace' | 'literature' | 'proxy' | 'connectors' | 'agent' | 'engines' | 'mcp' | 'security'

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

  if (integrations.isLoading) return <LoadingState label="正在读取集成配置…" />
  if (integrations.error) return <ErrorState error={integrations.error} onRetry={() => void integrations.refetch()} />

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <ResearchPanel action={<IntegrationDialog profile={null} trigger={<Button variant="primary"><Plus aria-hidden="true" className="size-4" />新建连接</Button>} />} eyebrow="CONNECTORS / PROFILES" title="Obsidian · Zotero · Notion">
        <p className="border-b border-border px-4 py-3 text-xs leading-5 text-muted-foreground">连接地址和字段设置保存在工作区数据库，重启后继续生效；凭据仅由主进程安全存储。开发环境可用 .env 作为新建配置的默认值，打包后请直接在此处填写并验证。</p>
        {integrations.data?.length === 0 ? <div className="p-4"><EmptyState description="保存 Obsidian 配置后必须先验证；其他连接的读写仍保持显式、手动触发。" title="尚无连接配置" /></div> : null}
        <div className="divide-y divide-border">
          {integrations.data?.map((profile) => (
            <article className="settings-row" key={profile.id}>
              <div className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-muted text-primary"><Cable aria-hidden="true" className="size-4" /></div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-bold text-foreground">{profile.name}</h3><StatusBadge status={profile.status} /><span className="research-tag">{integrationLabels[profile.provider]}</span></div>
                <p className="mt-1 overflow-wrap-anywhere text-xs text-muted-foreground">{profile.provider === 'obsidian' ? 'Vault 路径已保存（不会在列表回显）' : profile.location || '未填写位置'} · 上次同步 {formatDateTime(profile.lastSyncAt)}</p>
                {profile.lastError ? <p className="mt-1 text-xs text-danger">{profile.provider === 'obsidian' ? 'Vault 探测失败（错误摘要已脱敏）' : profile.lastError}</p> : null}
                {testMutation.variables === profile.id && testMutation.data ? <p className={testMutation.data.ok ? 'mt-1 text-xs text-success' : 'mt-1 text-xs text-danger'} role="status">{testMutation.data.message}</p> : null}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2"><IntegrationDialog profile={profile} trigger={<Button aria-label={`编辑连接：${profile.name}`} size="icon" variant="ghost"><Edit3 aria-hidden="true" className="size-4" /></Button>} /><Button loading={testMutation.isPending && testMutation.variables === profile.id} onClick={() => testMutation.mutate(profile.id)} size="sm"><TestTube2 aria-hidden="true" className="size-3.5" />{profile.provider === 'obsidian' ? '验证' : '测试'}</Button><Button disabled={!profile.enabled} loading={syncMutation.isPending && syncMutation.variables?.id === profile.id && syncMutation.variables.direction === 'pull'} onClick={() => syncMutation.mutate({ id: profile.id, direction: 'pull' })} size="sm"><RefreshCw aria-hidden="true" className="size-3.5" />拉取</Button><Button disabled={!profile.enabled} loading={syncMutation.isPending && syncMutation.variables?.id === profile.id && syncMutation.variables.direction === 'push'} onClick={() => { if (profile.provider === 'notion' && !window.confirm('将按最近一次拉取的页面版本写回 Workbench Summary、Tags 和 Collections。Notion API 不提供原子条件更新；若页面刚被他人修改，本次写回仍可能冲突。确认继续？')) return; syncMutation.mutate({ id: profile.id, direction: 'push' }) }} size="sm" variant="primary"><RefreshCw aria-hidden="true" className="size-3.5" />写回</Button></div>
            </article>
          ))}
        </div>
        <MutationFeedback error={testMutation.error ?? syncMutation.error} success={syncMutation.isSuccess ? '同步任务已提交。' : undefined} />
      </ResearchPanel>
      <ResearchPanel eyebrow="SYNC / RECENT" title="最近同步">{syncRuns.isLoading ? <p className="research-empty-inline">正在读取…</p> : null}{syncRuns.error ? <p className="form-feedback form-feedback-error m-3" role="alert">{getErrorMessage(syncRuns.error)}</p> : null}{syncRuns.data ? <SyncRunList runs={syncRuns.data} /> : null}</ResearchPanel>
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
  const runtimes: Array<{ runtime: AgentRuntimeKind; label: string }> = [{ runtime: 'codex', label: 'Codex' }, { runtime: 'pi', label: 'Pi' }]
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

function AgentRuntimeSettingsPanel(): React.JSX.Element {
  const queryClient = useQueryClient()
  const connectors = useQuery({ queryKey: ['agent-connectors'], queryFn: () => getWorkbenchAgentApi().connectors.list(), refetchInterval: 30_000 })
  const [paths, setPaths] = useState<Partial<Record<AgentRuntimeKind, string>>>({})
  const [enabled, setEnabled] = useState<Partial<Record<AgentRuntimeKind, boolean>>>({})
  const [proxy, setProxy] = useState<Partial<Record<AgentRuntimeKind, { enabled: boolean; http: string; https: string; noProxy: string }>>>({})
  const [feedback, setFeedback] = useState<string | null>(null)
  const runtimeLabels: Record<AgentRuntimeKind, string> = { codex: 'Codex', pi: 'Pi' }

  useEffect(() => {
    if (!connectors.data) return
    setPaths(Object.fromEntries(connectors.data.map((connector) => [connector.runtime, connector.executablePath ?? ''])))
    setEnabled(Object.fromEntries(connectors.data.map((connector) => [connector.runtime, connector.enabled])))
    setProxy(Object.fromEntries(connectors.data.map((connector) => [connector.runtime, {
      enabled: connector.proxyEnabled,
      http: connector.httpProxy ?? '',
      https: connector.httpsProxy ?? '',
      noProxy: connector.noProxy ?? ''
    }])))
  }, [connectors.data])

  const testMutation = useMutation({
    mutationFn: (runtime: AgentRuntimeKind) => getWorkbenchAgentApi().connectors.test(runtime),
    onSuccess: (result) => { setFeedback(`${runtimeLabels[result.runtime]}：${result.message}`); void queryClient.invalidateQueries({ queryKey: ['agent-connectors'] }) },
    onError: (error) => setFeedback(getErrorMessage(error))
  })
  const saveMutation = useMutation({
    mutationFn: (connector: AgentConnector) => {
      const currentProxy = proxy[connector.runtime]
      return getWorkbenchAgentApi().connectors.save({
        id: connector.id,
        runtime: connector.runtime,
        executablePath: (paths[connector.runtime] ?? '').trim() || null,
        enabled: enabled[connector.runtime] ?? connector.enabled,
        proxyEnabled: currentProxy?.enabled ?? connector.proxyEnabled,
        httpProxy: currentProxy?.http.trim() || null,
        httpsProxy: currentProxy?.https.trim() || null,
        noProxy: currentProxy?.noProxy.trim() || null,
        expectedRevision: connector.revision
      })
    },
    onSuccess: (result) => { setFeedback(`${runtimeLabels[result.runtime]} 配置已保存。`); void queryClient.invalidateQueries({ queryKey: ['agent-connectors'] }) },
    onError: (error) => setFeedback(getErrorMessage(error))
  })

  if (connectors.isLoading) return <SettingInfoPanel eyebrow="SETTINGS / AGENT" title="Agent 运行时"><LoadingState label="正在读取 Codex/Pi 配置…" /></SettingInfoPanel>
  if (connectors.error) return <SettingInfoPanel eyebrow="SETTINGS / AGENT" title="Agent 运行时"><ErrorState error={connectors.error} onRetry={() => void connectors.refetch()} /></SettingInfoPanel>

  return <AgentRuntimeSettingsView
    connectors={connectors.data ?? []}
    enabled={enabled}
    feedback={feedback}
    onEnabledChange={(runtime, value) => setEnabled((current) => ({ ...current, [runtime]: value }))}
    onPathChange={(runtime, value) => setPaths((current) => ({ ...current, [runtime]: value }))}
    onSave={(connector) => saveMutation.mutate(connector)}
    onTest={(runtime) => testMutation.mutate(runtime)}
    paths={paths}
    savingRuntime={saveMutation.isPending ? saveMutation.variables?.runtime ?? null : null}
    testingRuntime={testMutation.isPending ? testMutation.variables ?? null : null}
    />

  /* Legacy one-line renderer retained temporarily for reference while the
   * settings view is split into the accessible proxy-aware component below.

  return <SettingInfoPanel eyebrow="SETTINGS / AGENT" title="Agent 运行时"><p>配置本机 Codex 与 Pi runtime。路径、启用状态和最近一次探测结果由 Workspace Service 保存；模型与助手在 Agent 首页或定时任务中选择。</p><div className="grid gap-3">{(connectors.data ?? []).map((connector) => <article className="rounded-lg border border-border bg-muted/20 p-4" key={connector.id}><div className="flex flex-wrap items-start gap-3"><div className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-surface text-primary"><span aria-hidden="true" className={cn('status-led', connector.available && connector.enabled ? 'bg-online' : 'bg-danger')} /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-bold text-foreground">{runtimeLabels[connector.runtime]}</h3><span className={cn('research-status', connector.available && connector.enabled ? 'research-status-positive' : 'research-status-warning')}>{connector.available && connector.enabled ? '可用' : connector.enabled ? '未探测' : '已停用'}</span>{connector.version ? <code className="text-[11px] text-muted-foreground">{connector.version}</code> : null}</div><p className="mt-1 text-xs leading-5 text-muted-foreground">{connector.message || '尚未探测。保存路径后点击探测。'}</p><div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">{connector.localDefaultModel ? <span className="research-tag">本机模型：{connector.localDefaultModel}</span> : null}{connector.localThinkingLevel ? <span className="research-tag">Thinking：{connector.localThinkingLevel}</span> : null}{connector.localPermission ? <span className="research-tag">本机权限：{connector.localPermission}</span> : null}</div></div></div><div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center"><label className="sr-only" htmlFor={`agent-runtime-path-${connector.runtime}`}>{runtimeLabels[connector.runtime]} 可执行文件路径</label><Input id={`agent-runtime-path-${connector.runtime}`} onChange={(event) => setPaths((current) => ({ ...current, [connector.runtime]: event.target.value }))} placeholder={connector.runtime === 'codex' ? '例如 codex 或 C:\\Tools\\codex.cmd' : '例如 pi 或 C:\\Tools\\pi.cmd'} value={paths[connector.runtime] ?? ''} /><Button loading={saveMutation.isPending && saveMutation.variables?.runtime === connector.runtime} onClick={() => saveMutation.mutate(connector)} size="sm" variant="secondary"><Save aria-hidden="true" className="size-3.5" />保存</Button><Button disabled={!connector.enabled} loading={testMutation.isPending && testMutation.variables === connector.runtime} onClick={() => testMutation.mutate(connector.runtime)} size="sm"><TestTube2 aria-hidden="true" className="size-3.5" />探测</Button></div><label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><input checked={enabled[connector.runtime] ?? connector.enabled} className="research-checkbox" onChange={(event) => setEnabled((current) => ({ ...current, [connector.runtime]: event.target.checked }))} type="checkbox" />允许在 Agent 首页和定时任务中使用</label></article>)}</div>{feedback ? <p aria-live="polite" className="form-feedback form-feedback-success" role="status">{feedback}</p> : null}<div className="rounded-lg border border-border bg-muted/20 p-4 text-xs leading-5"><p className="font-semibold text-foreground">安全边界</p><p className="mt-1">CLI 只接收受控环境变量和隔离 run 目录；不会读取 Pi/Codex 用户认证目录。凭据配置将在 Main safeStorage 适配器完成后开放，当前定时任务保持 read-only。</p></div></SettingInfoPanel>
  */
}

type RuntimeProxyDraft = { enabled: boolean; http: string; https: string; noProxy: string }

function formatRuntimePermission(runtime: AgentRuntimeKind, value: string): string {
  if (runtime === 'codex' && value === 'user') return '按需确认'
  if (runtime === 'codex' && value === 'never') return '全自动'
  if (runtime === 'pi' && value === 'ask') return '询问'
  return value
}

function AgentRuntimeSettingsView({
  connectors,
  enabled,
  feedback,
  onEnabledChange,
  onPathChange,
  onSave,
  onTest,
  paths,
  savingRuntime,
  testingRuntime
}: {
  connectors: AgentConnector[]
  enabled: Partial<Record<AgentRuntimeKind, boolean>>
  feedback: string | null
  onEnabledChange: (runtime: AgentRuntimeKind, value: boolean) => void
  onPathChange: (runtime: AgentRuntimeKind, value: string) => void
  onSave: (connector: AgentConnector) => void
  onTest: (runtime: AgentRuntimeKind) => void
  paths: Partial<Record<AgentRuntimeKind, string>>
  savingRuntime: AgentRuntimeKind | null
  testingRuntime: AgentRuntimeKind | null
}): React.JSX.Element {
  const runtimeLabels: Record<AgentRuntimeKind, string> = { codex: 'Codex', pi: 'Pi' }
  const [expanded, setExpanded] = useState<Set<AgentRuntimeKind>>(() => new Set())
  const toggle = (runtime: AgentRuntimeKind): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(runtime)) next.delete(runtime)
      else next.add(runtime)
      return next
    })
  }
  return <SettingInfoPanel eyebrow="SETTINGS / AGENT" title="Agent 运行时">
    <p>集中管理本机 Codex 与 Pi runtime。点击任意行展开详细配置；模型、Thinking 和权限状态来自真实 runtime 探测。</p>
    <div className="agent-runtime-table-wrap" role="region" aria-label="Agent runtime 配置表" tabIndex={0}>
      <table className="agent-runtime-table">
        <thead><tr><th>Runtime</th><th>可执行文件</th><th>版本</th><th>登录</th><th>默认模型</th><th>权限</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>{connectors.map((connector) => {
          const isExpanded = expanded.has(connector.runtime)
          const detailsId = `agent-runtime-details-${connector.runtime}`
          const status = connector.enabled ? (connector.available ? '可用' : '未探测') : '已停用'
          return <Fragment key={connector.id}>
            <tr className={cn('agent-runtime-row', isExpanded && 'agent-runtime-row-expanded')} aria-expanded={isExpanded} onClick={() => toggle(connector.runtime)}>
              <td><button className="agent-runtime-name" onClick={(event) => { event.stopPropagation(); toggle(connector.runtime) }} aria-controls={detailsId} aria-expanded={isExpanded}><span aria-hidden="true" className={cn('status-led', connector.available && connector.enabled ? 'bg-online' : 'bg-danger')} />{runtimeLabels[connector.runtime]}{isExpanded ? <ChevronUp aria-hidden="true" className="size-3.5" /> : <ChevronDown aria-hidden="true" className="size-3.5" />}</button></td>
              <td className="agent-runtime-path-cell" title={connector.executablePath ?? '未配置'}>{connector.executablePath ?? '未配置'}</td>
              <td>{connector.version ?? '—'}</td>
              <td>{connector.authReady === true ? '已就绪' : connector.authReady === false ? '需登录' : '—'}</td>
              <td>{connector.localDefaultModel ?? '—'}</td>
              <td>{connector.localPermission ? formatRuntimePermission(connector.runtime, connector.localPermission) : '—'}</td>
              <td><span className={cn('research-status', connector.available && connector.enabled ? 'research-status-positive' : 'research-status-warning')}>{status}</span></td>
              <td><Button aria-controls={detailsId} aria-expanded={isExpanded} onClick={(event) => { event.stopPropagation(); toggle(connector.runtime) }} size="sm" variant="ghost">{isExpanded ? '收起' : '编辑'}</Button></td>
            </tr>
            {isExpanded ? <tr className="agent-runtime-details-row"><td colSpan={8}><div className="agent-runtime-details" id={detailsId}>
              <div className="agent-runtime-detail-heading"><div><h3>{runtimeLabels[connector.runtime]} 详细配置</h3><p>{connector.message || '尚未探测。保存路径后点击探测。'}</p></div><span className="research-tag">{connector.localThinkingLevel ? `Thinking：${connector.localThinkingLevel}` : 'Thinking：未探测'}</span></div>
              <div className="agent-runtime-detail-grid"><label>可执行文件路径<Input aria-label={`${runtimeLabels[connector.runtime]} 可执行文件路径`} onChange={(event) => onPathChange(connector.runtime, event.target.value)} placeholder={connector.runtime === 'codex' ? '例如 codex 或 C:\\Tools\\codex.cmd' : '例如 pi 或 C:\\Tools\\pi.cmd'} value={paths[connector.runtime] ?? ''} /></label><label className="agent-runtime-switch"><span>允许在 Agent 首页和定时任务中使用</span><input checked={enabled[connector.runtime] ?? connector.enabled} className="research-checkbox" onChange={(event) => onEnabledChange(connector.runtime, event.target.checked)} type="checkbox" /></label></div>
              <div className="agent-runtime-detail-actions"><span className="text-xs text-muted-foreground">代理由“设置 → 代理”统一管理；凭据不会在此页面显示。</span><div className="flex gap-2"><Button loading={savingRuntime === connector.runtime} onClick={() => onSave(connector)} size="sm" variant="secondary"><Save aria-hidden="true" className="size-3.5" />保存</Button><Button disabled={!connector.enabled} loading={testingRuntime === connector.runtime} onClick={() => onTest(connector.runtime)} size="sm"><TestTube2 aria-hidden="true" className="size-3.5" />探测</Button></div></div>
            </div></td></tr> : null}
          </Fragment>
        })}</tbody>
      </table>
    </div>
    {feedback ? <p aria-live="polite" className="form-feedback form-feedback-success" role="status">{feedback}</p> : null}
    <div className="rounded-lg border border-border bg-muted/20 p-4 text-xs leading-5"><p className="font-semibold text-foreground">安全边界</p><p className="mt-1">工作台只通过 Codex/Pi CLI 自带的登录状态检查确认本机凭据是否可用，不读取或复制 token，也不会把凭据写入 SQLite。运行时沿用本机 CLI 的模型、Thinking 和登录配置；工作台仍强制使用隔离 run 目录与 read-only 工具策略。</p></div>
  </SettingInfoPanel>
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
  const [tab, setTab] = useState<SettingsTab>('general')
  return <div className="page-scroll"><PageHeader description="管理工作区、外部工具、代理、Agent 运行时和知识引擎映射；页面仅显示后端真实状态。" eyebrow="SETTINGS / WORKSPACE" title="设置" /><div className="mt-4"><ResearchTabs items={[{ value: 'general', label: '通用' }, { value: 'workspace', label: '工作区与数据' }, { value: 'literature', label: '文献检索' }, { value: 'proxy', label: '代理' }, { value: 'connectors', label: '工具连接' }, { value: 'agent', label: 'Agent 运行时' }, { value: 'engines', label: '知识引擎' }, { value: 'mcp', label: 'MCP Server' }, { value: 'security', label: '安全与审计' }]} label="设置分区" onChange={setTab} value={tab} /></div><div className="mt-4">{tab === 'general' ? <GeneralSettingsPanel /> : null}{tab === 'workspace' ? <WorkspaceSettingsPanel /> : null}{tab === 'literature' ? <LiteratureSettingsPanel /> : null}{tab === 'proxy' ? <ProxySettingsPanel /> : null}{tab === 'connectors' ? <ConnectorsPanel /> : null}{tab === 'agent' ? <AgentRuntimeSettingsPanel /> : null}{tab === 'engines' ? <EnginesPanel /> : null}{tab === 'mcp' ? <McpSettingsPanel /> : null}{tab === 'security' ? <SecuritySettingsPanel /> : null}</div></div>
}
