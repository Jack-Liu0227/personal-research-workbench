import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Check, ChevronLeft, ChevronRight, Download, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { PaperIdSchema, ProjectIdSchema } from '@prw/contracts'
import type {
  ExternalLink as ExternalLinkDto,
  Project,
  ZoteroCapabilityStatus,
  ZoteroCollection,
  ZoteroBibtexExport,
  ZoteroImportPreview,
  ZoteroImportResult,
  ZoteroItem,
  ZoteroRemoteDeleteReceipt,
  ZoteroRemoteDeletePreview,
  PaperToZoteroPreview,
  ZoteroHandoff
} from '@prw/contracts'
import { SelectionBar } from '../components/selection'
import { PaneResizeSeparator, paneBoundaryOffset, usePaneResizeEnabled, usePaneWidth } from '../components/resizable-pane'
import { ExternalUrlLink } from '../components/external-link'
import { EmptyState, ErrorState, InlineLoadingState, PageHeader, PanelSkeleton } from '../components/states'
import { Button, Input } from '../components/ui'
import { cn, formatDateTime, getErrorMessage } from '../lib/utils'
import { useDefaultProjectId } from '../lib/recent-project'
import { collectionWriteLabel, confirmLabels, remoteDeleteLabels, remoteDeleteReceiptRows, remoteDeleteReceiptSummary, writeBlockedExplanation } from '../lib/zotero-write'
import { getWorkbenchApi } from '../lib/workbench'
import { useIntegrationsQuery } from './queries'
import { ResearchPanel, StatusBadge } from './research/shared'

const PAGE_SIZE = 50

/** Zotero workspace rails. The bounds are shared by drag, keyboard and the
 * published aria-valuemin/max. The defaults match the previous fixed grid
 * (16rem Collections / 18rem Inspector). */
const ZOTERO_COLLECTIONS_MIN_WIDTH = 224
const ZOTERO_COLLECTIONS_MAX_WIDTH = 400
const ZOTERO_COLLECTIONS_DEFAULT_WIDTH = 256
const ZOTERO_INSPECTOR_MIN_WIDTH = 224
const ZOTERO_INSPECTOR_MAX_WIDTH = 440
const ZOTERO_INSPECTOR_DEFAULT_WIDTH = 288

function parseTagInput(value: string): string[] {
  return [...new Set(value.split(/[\s,，;；]+/u).map((tag) => tag.replace(/^#+/u, '').trim()).filter(Boolean))].slice(0, 20)
}

function displayTag(value: string): string {
  const normalized = value.replace(/^#+/u, '').trim()
  return `#${normalized || '未分类'}`
}

function isLoopbackZoteroLocation(location: string): boolean {
  try {
    const url = new URL(location)
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLocaleLowerCase('en-US'))
  } catch {
    return false
  }
}

async function downloadBibtex(content: string): Promise<string> {
  const result = await getWorkbenchApi().system.saveTextFile({
    fileName: `zotero-better-bibtex-${new Date().toISOString().slice(0, 10)}.bib`,
    content,
    mimeType: 'application/x-bibtex;charset=utf-8'
  })
  if (!result.saved) throw new Error('文件未保存，请重试。')
  return result.fileName
}

async function downloadZoteroHandoff(handoff: ZoteroHandoff): Promise<string> {
  const result = await getWorkbenchApi().system.saveTextFile({
    fileName: handoff.fileName,
    content: handoff.content,
    mimeType: handoff.format === 'bibtex' ? 'application/x-bibtex;charset=utf-8' : 'application/x-research-info-systems;charset=utf-8'
  })
  if (!result.saved) throw new Error('文件未保存，请重试。')
  return result.fileName
}

function randomConfirmationToken(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}`
}

const capabilityStatusLabels: Record<ZoteroCapabilityStatus['status'], string> = {
  connected: '已连接（真实 Local API 探测）',
  disconnected: '未连接',
  offline: '离线',
  unauthorized: '未授权',
  rate_limited: '请求受限',
  unavailable: '不可用',
  error: '探测异常',
  not_configured: '未配置',
  unsupported: '不支持'
}

const pageStatusLabels: Record<string, string> = {
  connected: '已连接',
  partial: '部分结果',
  offline: '离线',
  unauthorized: '未授权',
  rate_limited: '请求受限',
  error: '读取异常',
  unsupported: '不支持'
}

function mergeByKey<T extends { key: string }>(current: T[], incoming: T[]): T[] {
  const merged = new Map(current.map((item) => [item.key, item]))
  for (const item of incoming) merged.set(item.key, item)
  return [...merged.values()]
}

function pageStatusMessage(status: string): string {
  return `Zotero ${pageStatusLabels[status] ?? status}：${status === 'unsupported' ? '当前连接器未提供该读取能力。' : '请刷新或检查 Zotero 是否正在运行。'}`
}

function capabilityUnavailableMessage(status: ZoteroCapabilityStatus['status'] | undefined): string {
  switch (status) {
    case 'connected': return 'Zotero 已连接，但当前未提供读取能力。'
    case 'unauthorized': return 'Zotero Local API 未授权；请在 Zotero 中启用本地 API 后重新探测。'
    case 'offline':
    case 'disconnected': return 'Zotero 当前离线；启动 Zotero 后重新探测。'
    case 'rate_limited': return 'Zotero 请求受限；稍后重新探测。'
    case 'unsupported': return '当前连接器不支持所需的 Zotero 能力。'
    case 'unavailable': return 'Zotero 当前不可用；请检查本机服务后重新探测。'
    case 'error': return 'Zotero 能力探测异常；请重新探测并检查错误详情。'
    case 'not_configured': return 'Zotero 尚未配置；请先完成配置。'
    default: return '尚未完成 Zotero 能力探测；请重新探测。'
  }
}

function importDecisionLabel(decision: string): string {
  return ({ create: '将创建', skip: '跳过重复', review: '需复核重复项', 'update-candidate': '更新候选', conflict: '存在冲突' } as Record<string, string>)[decision] ?? decision
}

function CollectionTree({
  collections,
  selectedKey,
  onSelect
}: {
  collections: ZoteroCollection[]
  selectedKey: string | null
  onSelect: (key: string | null) => void
}): React.JSX.Element {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set())
  const byParent = useMemo(() => {
    const result = new Map<string | null, ZoteroCollection[]>()
    for (const collection of collections) {
      const values = result.get(collection.parentKey) ?? []
      values.push(collection)
      result.set(collection.parentKey, values)
    }
    for (const values of result.values()) values.sort((a, b) => a.name.localeCompare(b.name))
    return result
  }, [collections])
  useEffect(() => {
    setExpandedKeys((current) => {
      if (current.size > 0 || collections.length === 0) return current
      return new Set((byParent.get(null) ?? []).filter((collection) => byParent.has(collection.key)).map((collection) => collection.key))
    })
  }, [byParent, collections.length])

  const renderBranch = (parentKey: string | null, depth = 0): React.JSX.Element[] => (byParent.get(parentKey) ?? []).flatMap((collection) => [
    <div className="grid" key={collection.key}>
      <button
        className={cn('artifact-list-item', selectedKey === collection.key && 'artifact-list-item-active')}
        onClick={() => onSelect(collection.key)}
        style={{ paddingLeft: `${0.75 + depth * 0.9}rem` }}
        type="button"
      >
        <span
          aria-label={expandedKeys.has(collection.key) ? '折叠子 Collection' : '展开子 Collection'}
          className="grid size-4 shrink-0 place-items-center rounded hover:bg-muted"
          onClick={(event) => {
            if (!byParent.has(collection.key)) return
            event.stopPropagation()
            setExpandedKeys((current) => {
              const next = new Set(current)
              next.has(collection.key) ? next.delete(collection.key) : next.add(collection.key)
              return next
            })
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if ((event.key === 'Enter' || event.key === ' ') && byParent.has(collection.key)) {
              event.preventDefault()
              setExpandedKeys((current) => {
                const next = new Set(current)
                next.has(collection.key) ? next.delete(collection.key) : next.add(collection.key)
                return next
              })
            }
          }}
        >
          {byParent.has(collection.key) ? <ChevronRight aria-hidden="true" className={cn('size-3 text-muted-foreground transition-transform', expandedKeys.has(collection.key) && 'rotate-90')} /> : <span className="size-3" />}
        </span>
        <span className="min-w-0 flex-1 truncate text-left text-xs">{collection.name}</span>
        <span className="text-[10px] text-muted-foreground">{collection.itemCount}</span>
      </button>
      {expandedKeys.has(collection.key) ? renderBranch(collection.key, depth + 1) : null}
    </div>
  ])

  return (
    <div className="divide-y divide-border">
      <button className={cn('artifact-list-item', selectedKey === null && 'artifact-list-item-active')} onClick={() => onSelect(null)} type="button">
        <BookOpen aria-hidden="true" className="size-3.5 text-primary" />
        <span className="text-xs font-bold">全部条目</span>
      </button>
      {renderBranch(null)}
    </div>
  )
}

function ItemInspector({ item, link }: { item: ZoteroItem | null; link: ExternalLinkDto | undefined }): React.JSX.Element {
  if (!item) return <EmptyState description="选择一个条目查看只读元数据和附件 locator。" title="尚未选择条目" />
  return (
    <div className="grid gap-3 p-4 text-xs">
      <div>
        <p className="text-[11px] text-muted-foreground">标题</p>
        <h3 className="mt-1 overflow-wrap-anywhere text-sm font-bold text-foreground">{item.title}</h3>
      </div>
      <dl className="grid gap-2">
        <div><dt className="text-[11px] text-muted-foreground">作者</dt><dd className="mt-0.5 text-foreground">{item.creators.join('、') || '未记录'}</dd></div>
        <div><dt className="text-[11px] text-muted-foreground">类型 / 年份</dt><dd className="mt-0.5 text-foreground">{item.itemType ?? '未记录'} · {item.year ?? '未知'}</dd></div>
        <div><dt className="text-[11px] text-muted-foreground">期刊</dt><dd className="mt-0.5 text-foreground">{item.publicationTitle || '未记录'}</dd></div>
        <div><dt className="text-[11px] text-muted-foreground">DOI</dt><dd className="mt-0.5 break-all text-foreground">{item.doi ?? '未记录'}</dd></div>
        <div><dt className="text-[11px] text-muted-foreground">Zotero item key</dt><dd className="mt-0.5 font-mono text-foreground">{item.key}</dd></div>
        <div><dt className="text-[11px] text-muted-foreground">Better BibTeX citation key</dt><dd className="mt-0.5 break-all font-mono text-foreground">{item.citationKey ?? '未提供（请确认已安装 Better BibTeX）'}</dd></div>
        <div><dt className="text-[11px] text-muted-foreground">附件</dt><dd className="mt-0.5 text-foreground">{item.attachmentCount} 个链接 · locator：{item.locator ?? '无'}</dd></div>
        <div><dt className="text-[11px] text-muted-foreground">remoteRevision</dt><dd className="mt-0.5 break-all font-mono text-foreground">{item.remoteRevision ?? '无'}</dd></div>
        {link ? <div><dt className="text-[11px] text-muted-foreground">已关联本地 Paper</dt><dd className="mt-0.5 break-all font-mono text-foreground">{link.entityId} · {link.syncState} · {formatDateTime(link.lastSyncedAt)}</dd></div> : null}
      </dl>
      <div><p className="text-[11px] text-muted-foreground">摘要</p><p className="mt-1 whitespace-pre-wrap leading-5 text-foreground">{item.abstract || '未提供摘要。'}</p></div>
      {item.tags.length > 0 ? <div className="flex flex-wrap gap-1">{item.tags.map((tag) => <span className="research-tag" key={tag}>{displayTag(tag)}</span>)}</div> : null}
      {item.url ? <ExternalUrlLink className="zotero-item-link" fieldLabel="条目链接" href={item.url} label="打开条目链接" /> : null}
      <p className="text-[11px] leading-5 text-muted-foreground">附件只保留 Zotero locator/链接，不复制 PDF 或上传附件正文。</p>
    </div>
  )
}

export function ZoteroPage({ projects }: { projects: Project[] }): React.JSX.Element {
  const queryClient = useQueryClient()
  const profilesQuery = useIntegrationsQuery()
  const zoteroProfiles = useMemo(() => (profilesQuery.data ?? []).filter((profile) => profile.provider === 'zotero'), [profilesQuery.data])
  const [profileId, setProfileId] = useState('')
  const profile = zoteroProfiles.find((item) => item.id === profileId) ?? null
  const [collectionKey, setCollectionKey] = useState<string | null>(null)
  const [collectionCursor, setCollectionCursor] = useState<string | null>(null)
  const [collectionEntries, setCollectionEntries] = useState<ZoteroCollection[]>([])
  const [itemCursor, setItemCursor] = useState<string | null>(null)
  const [itemEntries, setItemEntries] = useState<ZoteroItem[]>([])
  const [query, setQuery] = useState('')
  const [selectedItemKeys, setSelectedItemKeys] = useState<Set<string>>(() => new Set())
  const [inspectedItemKey, setInspectedItemKey] = useState<string | null>(null)
  // Better BibTeX is the primary Zotero bridge in this workspace.  Keep RIS
  // available as an explicit fallback, but make the first-use export match
  // the user's requested batch BibTeX workflow.
  const [format, setFormat] = useState<'ris' | 'bibtex'>('bibtex')
  const [importPreview, setImportPreview] = useState<ZoteroImportPreview | null>(null)
  const [importResult, setImportResult] = useState<ZoteroImportResult | null>(null)
  const [paperIds, setPaperIds] = useState<Set<string>>(() => new Set())
  const [paperPreview, setPaperPreview] = useState<PaperToZoteroPreview | null>(null)
  const [paperResult, setPaperResult] = useState<ZoteroImportResult | null>(null)
  const [bibtexExport, setBibtexExport] = useState<ZoteroBibtexExport | null>(null)
  const { chooseProjectId: setExportProjectId, projectId: exportProjectId } = useDefaultProjectId(projects)
  const [exportTags, setExportTags] = useState('')
  const [operationMessage, setOperationMessage] = useState<string | null>(null)
  const [operationMessageKind, setOperationMessageKind] = useState<'error' | 'status'>('status')
  const [remoteDeleteReceipt, setRemoteDeleteReceipt] = useState<ZoteroRemoteDeleteReceipt | null>(null)
  const [remoteDeletePreview, setRemoteDeletePreview] = useState<ZoteroRemoteDeletePreview | null>(null)
  // Keep the two navigation/preview rails visible on first load. Collapsing
  // them remains available, but a blank center pane made a healthy Zotero
  // connection look like a failed read in the previous default state.
  const [collectionsOpen, setCollectionsOpen] = useState(true)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  // Collections/条目详情 rails are user widths now, clamped to [224, 400] and
  // [224, 440] and persisted with the repository's optional-storage convention.
  // The three-column grid is only laid out above 721px (below that the CSS
  // stacks the workspace).
  const collectionsPane = usePaneWidth({ storageKey: 'zotero-collections-width', defaultWidth: ZOTERO_COLLECTIONS_DEFAULT_WIDTH, min: ZOTERO_COLLECTIONS_MIN_WIDTH, max: ZOTERO_COLLECTIONS_MAX_WIDTH })
  const inspectorPane = usePaneWidth({ storageKey: 'zotero-inspector-width', defaultWidth: ZOTERO_INSPECTOR_DEFAULT_WIDTH, min: ZOTERO_INSPECTOR_MIN_WIDTH, max: ZOTERO_INSPECTOR_MAX_WIDTH })
  const workspaceSplitEnabled = usePaneResizeEnabled('(min-width: 721px)')
  // Both Zotero rails scroll internally, so the splitters are positioned inside
  // the (non-scrolling) grid container instead of inside the panes: a handle
  // that scrolls away with a pane is not a usable drag affordance. Collapsed
  // rails drop their splitter, and a stacked workspace keeps it as disabled.
  const workspaceStyle = workspaceSplitEnabled
    ? {
        gridTemplateColumns: `${collectionsOpen ? `minmax(0, ${collectionsPane.width}px)` : '3rem'} minmax(0, 1fr) ${inspectorOpen ? `minmax(0, ${inspectorPane.width}px)` : '3rem'}`
      }
    : undefined
  const workspaceSeparators = <>
    {collectionsOpen ? <PaneResizeSeparator defaultValue={ZOTERO_COLLECTIONS_DEFAULT_WIDTH} disabled={!workspaceSplitEnabled} label="调整 Collections 宽度（左右方向键调整，Home 最小，End 最大，双击恢复默认）" max={ZOTERO_COLLECTIONS_MAX_WIDTH} min={ZOTERO_COLLECTIONS_MIN_WIDTH} onReset={collectionsPane.resetWidth} onResize={collectionsPane.setWidth} style={{ left: paneBoundaryOffset(collectionsPane.width) }} value={collectionsPane.width} /> : null}
    {inspectorOpen ? <PaneResizeSeparator defaultValue={ZOTERO_INSPECTOR_DEFAULT_WIDTH} disabled={!workspaceSplitEnabled} invert label="调整条目详情宽度（左右方向键调整，Home 最小，End 最大，双击恢复默认）" max={ZOTERO_INSPECTOR_MAX_WIDTH} min={ZOTERO_INSPECTOR_MIN_WIDTH} onReset={inspectorPane.resetWidth} onResize={inspectorPane.setWidth} style={{ right: paneBoundaryOffset(inspectorPane.width) }} value={inspectorPane.width} /> : null}
  </>

  useEffect(() => {
    const fallbackProfile = zoteroProfiles.find((item) => item.enabled) ?? zoteroProfiles[0]
    if (!profileId && fallbackProfile) setProfileId(fallbackProfile.id)
    if (profileId && !zoteroProfiles.some((item) => item.id === profileId)) setProfileId(fallbackProfile?.id ?? '')
  }, [profileId, zoteroProfiles])
  useEffect(() => {
    const bound = profile?.settings?.zoteroCollectionKey
    setCollectionKey(typeof bound === 'string' && bound.trim() ? bound : null)
  }, [profile?.id])

  const capabilityQuery = useQuery({
    queryKey: ['zotero-capability', profileId],
    queryFn: () => getWorkbenchApi().zotero.capability(profileId),
    enabled: Boolean(profileId),
    staleTime: 60_000,
    retry: false
  })
  const canRead = capabilityQuery.data?.capability.read === true
  const canWrite = capabilityQuery.data?.capability.write === true
  const localZotero = profile ? isLoopbackZoteroLocation(profile.location) : false
  const authorizeMutation = useMutation({
    mutationFn: () => getWorkbenchApi().zotero.authorize({ profileId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['zotero-capability', profileId] })
      setOperationMessage('Zotero 本机写入已授权；密钥已由主进程安全保存。')
      setOperationMessageKind('status')
    },
    onError: (error) => {
      setOperationMessage(getErrorMessage(error))
      setOperationMessageKind('error')
    }
  })
  const confirmedPaperPreview = paperPreview?.requiresConfirmation === true ? paperPreview : null
  // A read-only/offline Local API can still produce a standards-compatible
  // handoff package.  Only an API transport requires the probed write bit.
  const canExecutePaper = confirmedPaperPreview !== null && (confirmedPaperPreview.transport !== 'api' || canWrite)

  const collectionsQuery = useQuery({
    queryKey: ['zotero-collections-page', profileId, collectionCursor],
    queryFn: () => getWorkbenchApi().zotero.collectionsPage({ profileId, ...(collectionCursor === null ? {} : { cursor: collectionCursor }) }),
    enabled: Boolean(profileId && canRead && collectionsOpen),
    staleTime: 30_000,
    retry: false
  })
  const itemsQuery = useQuery({
    queryKey: ['zotero-items-page', profileId, collectionKey, query.trim(), itemCursor],
    queryFn: () => getWorkbenchApi().zotero.itemsPage({
      profileId,
      ...(collectionKey === null ? {} : { collectionKey }),
      ...(query.trim() ? { query: query.trim() } : {}),
      page: { limit: PAGE_SIZE, ...(itemCursor === null ? {} : { cursor: itemCursor }) }
    }),
    enabled: Boolean(profileId && canRead),
    staleTime: 30_000,
    retry: false
  })
  const linksQuery = useQuery({
    queryKey: ['zotero-links', profileId],
    queryFn: () => getWorkbenchApi().integrations.links(profileId),
    enabled: Boolean(profileId && inspectedItemKey),
    staleTime: 30_000,
    retry: false,
    placeholderData: (previous) => previous
  })
  // The visible page has no Paper selector. Keep the projection workflow
  // available for its explicit selection path without loading every Paper on mount.
  const papersQuery = useQuery({
    queryKey: ['papers-for-zotero-export'],
    queryFn: () => getWorkbenchApi().papers.list({}),
    enabled: Boolean(profileId && paperIds.size > 0),
    staleTime: 30_000,
    retry: false,
    placeholderData: (previous) => previous
  })
  const bibtexExportMutation = useMutation({
    mutationFn: () => {
      if (!profileId) throw new Error('请先选择 Zotero 配置。')
      if (selectedItemKeys.size === 0) throw new Error('请至少选择一篇 Zotero 文献。')
      return getWorkbenchApi().zotero.bibtexExport({
        profileId,
        itemKeys: [...selectedItemKeys],
        projectTag: projects.find((project) => project.id === exportProjectId)?.name ?? '未分类',
        tags: parseTagInput(exportTags)
      })
    },
    onSuccess: (result) => {
      // Keep the final save behind a visible user gesture. The export is
      // generated in Core, while an asynchronous renderer anchor can be
      // rejected by Electron's download manager after the mutation resolves.
      setBibtexExport(result)
      setOperationMessage(`已通过 Better BibTeX 生成 ${result.citationKeys.length} 篇文献；请点击“下载 BibTeX 文件”保存。`)
      setOperationMessageKind('status')
    },
    onError: (error) => {
      setOperationMessage(getErrorMessage(error))
      setOperationMessageKind('error')
    }
  })
  const collectionBindingMutation = useMutation({
    mutationFn: (binding: string | null) => {
      if (!profile) throw new Error('请先选择 Zotero 配置。')
      return getWorkbenchApi().integrations.save({
        id: profile.id,
        provider: 'zotero',
        name: profile.name,
        enabled: profile.enabled,
        location: profile.location,
        settings: { ...profile.settings, zoteroCollectionKey: binding },
        expectedRevision: profile.revision
      })
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['integrations'] }); setOperationMessage('Collection 绑定已更新。'); setOperationMessageKind('status') },
    onError: (error) => { setOperationMessage(error instanceof Error ? error.message : 'Collection 绑定更新失败。'); setOperationMessageKind('error') }
  })
  // 两侧删除：preview 冻结远端 revision 与本地投影，用户显式确认后才 execute。
  // 远端删除失败时回执保留本地记录，因此这里从不先删本地再尝试远端。
  const remoteDeleteMutation = useMutation({
    mutationFn: async (itemKeys: string[]) => {
      if (!profileId || !profile) throw new Error('请先选择 Zotero 配置。')
      if (itemKeys.length === 0) throw new Error('请至少选择一个 Zotero 条目。')
      const api = getWorkbenchApi()
      const preview = await api.zotero.deleteRemote.preview({ profileId, itemKeys })
      setRemoteDeletePreview(preview)
      if (preview.writeBlockedReason !== null) {
        throw new Error(preview.message)
      }
      if (!window.confirm(`${preview.message}\n\n${remoteDeleteLabels.confirm}`)) {
        throw new Error('已取消：没有向 Zotero 发送任何删除请求。')
      }
      return api.zotero.deleteRemote.execute({
        profileId,
        expectedProfileRevision: preview.profileRevision,
        targets: preview.targets,
        confirmed: true
      })
    },
    onSuccess: async (receipt) => {
      setRemoteDeleteReceipt(receipt)
      setRemoteDeletePreview(null)
      setOperationMessage(remoteDeleteReceiptSummary(receipt))
      setOperationMessageKind(receipt.status === 'completed' ? 'status' : 'error')
      await queryClient.invalidateQueries({ queryKey: ['integrations'] })
      setSelectedItemKeys(new Set())
      itemsQuery.refetch()
    },
    onError: (error) => { setOperationMessage(getErrorMessage(error)); setOperationMessageKind('error') }
  })
  const requestRemoteDelete = () => {
    if (selectedItemKeys.size === 0 || remoteDeleteMutation.isPending) return
    remoteDeleteMutation.mutate([...selectedItemKeys])
  }

  useEffect(() => {
    setCollectionCursor(null)
    setCollectionEntries([])
    setItemCursor(null)
    setItemEntries([])
    setSelectedItemKeys(new Set())
    setInspectedItemKey(null)
    setImportPreview(null)
    setImportResult(null)
    setPaperPreview(null)
    setPaperResult(null)
    setBibtexExport(null)
    setOperationMessage(null)
    setOperationMessageKind('status')
  }, [profileId])
  useEffect(() => {
    setItemCursor(null)
    setItemEntries([])
    setSelectedItemKeys(new Set())
    setInspectedItemKey(null)
    setImportPreview(null)
    setImportResult(null)
    setBibtexExport(null)
  }, [collectionKey, query])
  useEffect(() => {
    if (!collectionsQuery.data) return
    setCollectionEntries((current) => collectionCursor === null ? mergeByKey([], collectionsQuery.data.items) : mergeByKey(current, collectionsQuery.data.items))
  }, [collectionCursor, collectionsQuery.data])
  useEffect(() => {
    if (!itemsQuery.data) return
    setItemEntries((current) => itemCursor === null ? mergeByKey([], itemsQuery.data.items) : mergeByKey(current, itemsQuery.data.items))
  }, [itemCursor, itemsQuery.data])

  const papers = papersQuery.data ?? []
  const allPapersSelected = papers.length > 0 && papers.every((paper) => paperIds.has(paper.id))
  // The items rail accumulates pages, so "全选" can only ever mean the rows
  // that are actually loaded; every boundary is spelled out in the bar's scope.
  const allLoadedItemsSelected = itemEntries.length > 0 && itemEntries.every((item) => selectedItemKeys.has(item.key))
  const someLoadedItemsSelected = itemEntries.some((item) => selectedItemKeys.has(item.key))
  const toggleAllLoadedItems = () => setSelectedItemKeys((current) => {
    const next = new Set(current)
    const allSelected = itemEntries.length > 0 && itemEntries.every((item) => current.has(item.key))
    for (const item of itemEntries) {
      if (allSelected) next.delete(item.key)
      else next.add(item.key)
    }
    return next
  })
  const clearLoadedItems = () => setSelectedItemKeys((current) => {
    const next = new Set(current)
    for (const item of itemEntries) next.delete(item.key)
    return next
  })
  const inspectedItem = itemEntries.find((item) => item.key === inspectedItemKey) ?? null
  const inspectedLink = inspectedItem ? linksQuery.data?.find((link) => link.entityKind === 'paper' && link.externalId === inspectedItem.key) : undefined

  const resetPaging = () => {
    setCollectionCursor(null)
    setCollectionEntries([])
    setItemCursor(null)
    setItemEntries([])
    setPaperPreview(null)
    setPaperResult(null)
    setBibtexExport(null)
    if (profileId) {
      void queryClient.invalidateQueries({ queryKey: ['zotero-capability', profileId] })
      void queryClient.invalidateQueries({ queryKey: ['zotero-collections-page', profileId] })
      void queryClient.invalidateQueries({ queryKey: ['zotero-items-page', profileId] })
    }
  }

  const importPreviewMutation = useMutation({
    mutationFn: () => getWorkbenchApi().zotero.importSelected.preview({
      profileId,
      itemKeys: [...selectedItemKeys],
      paperIds: [],
      targetCollectionKey: null,
      format,
      transport: 'api',
      projectId: exportProjectId ? ProjectIdSchema.parse(exportProjectId) : null,
      tags: parseTagInput(exportTags)
    }),
    onSuccess: (preview) => {
      setImportPreview(preview)
      setImportResult(null)
      setOperationMessage('预览已生成。请检查重复决策、locator 和 remoteRevision 后再确认。')
      setOperationMessageKind('status')
    },
    onError: (error) => { setOperationMessage(getErrorMessage(error)); setOperationMessageKind('error') }
  })
  const importExecuteMutation = useMutation({
    mutationFn: () => importPreview
      ? getWorkbenchApi().zotero.importSelected.execute({ previewId: importPreview.previewId, confirmed: true, confirmationToken: randomConfirmationToken('zotero-import') })
      : Promise.reject(new Error('请先生成 Zotero 导入预览。')),
    onSuccess: (result) => {
      setImportResult(result)
      setImportPreview(null)
      setOperationMessage(result.failed > 0 ? '导入完成，但存在失败条目；请逐条检查回执。' : '导入完成。')
      setOperationMessageKind(result.failed > 0 ? 'error' : 'status')
      setSelectedItemKeys(new Set())
      void queryClient.invalidateQueries({ queryKey: ['papers'] })
      void queryClient.invalidateQueries({ queryKey: ['papers-for-zotero-export'] })
      void queryClient.invalidateQueries({ queryKey: ['resource-links'] })
      void queryClient.invalidateQueries({ queryKey: ['zotero-links', profileId] })
    },
    onError: (error) => { setOperationMessage(getErrorMessage(error)); setOperationMessageKind('error') }
  })
  const paperPreviewMutation = useMutation({
    mutationFn: () => getWorkbenchApi().zotero.paperToZotero.preview({
      profileId,
      paperIds: [...paperIds].map((id) => PaperIdSchema.parse(id)),
      targetCollectionKey: collectionKey,
      format,
      tags: parseTagInput(exportTags),
      transport: canWrite ? 'api' : 'save-file'
    }),
    onMutate: () => {
      setPaperPreview(null)
      setPaperResult(null)
    },
    onSuccess: (preview) => {
      setPaperPreview(preview)
      setPaperResult(null)
      setOperationMessage('Paper → Zotero 预览已生成。外部写入仍需明确确认。')
      setOperationMessageKind('status')
    },
    onError: (error) => { setOperationMessage(getErrorMessage(error)); setOperationMessageKind('error') }
  })
  const paperExecuteMutation = useMutation({
    mutationFn: () => confirmedPaperPreview
      ? getWorkbenchApi().zotero.paperToZotero.execute({ previewId: confirmedPaperPreview.previewId, confirmed: true, confirmationToken: randomConfirmationToken('paper-zotero') })
      : Promise.reject(new Error('请先生成 Paper → Zotero 预览。')),
    onSuccess: (result) => {
      setPaperResult(result)
      setPaperPreview(null)
      const hasGeneratedHandoff = result.items.some((item) => item.outcome === 'generated')
      const hasUnsupported = result.items.some((item) => item.outcome === 'unsupported')
      setOperationMessage(hasGeneratedHandoff ? `已生成 ${result.handoff?.fileName ?? 'RIS/BibTeX'} 中转包；这不代表 Zotero 已完成导入。` : hasUnsupported ? '部分条目不支持 Zotero API 写入，尚未完成导入。' : 'Paper → Zotero 操作完成。')
      setOperationMessageKind(result.failed > 0 ? 'error' : 'status')
    },
    onError: (error) => { setOperationMessage(getErrorMessage(error)); setOperationMessageKind('error') }
  })

  const toggleItem = (key: string) => {
    setSelectedItemKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const togglePaper = (id: string) => {
    setPaperPreview(null)
    setPaperResult(null)
    setPaperIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleAllPapers = () => {
    setPaperPreview(null)
    setPaperResult(null)
    setPaperIds((current) => {
      if (papers.length > 0 && papers.every((paper) => current.has(paper.id))) return new Set()
      return new Set(papers.map((paper) => paper.id))
    })
  }
  const changeFormat = (nextFormat: 'ris' | 'bibtex') => {
    setFormat(nextFormat)
    setImportPreview(null)
    setImportResult(null)
    setPaperPreview(null)
    setPaperResult(null)
  }

  if (profilesQuery.isLoading) return <div className="page-scroll"><PageHeader description="通过 Workspace Service 的 typed Zotero routes 读取本机数据；不会打开 zotero.sqlite，也不会复制附件。" eyebrow="LIBRARY / ZOTERO LOCAL" title="Zotero" /><div className="mt-4"><PanelSkeleton lines={8} /></div></div>
  if (profilesQuery.error) return <div className="page-scroll"><PageHeader description="通过 Workspace Service 的 typed Zotero routes 读取本机数据；不会打开 zotero.sqlite，也不会复制附件。" eyebrow="LIBRARY / ZOTERO LOCAL" title="Zotero" /><div className="mt-4"><ErrorState error={profilesQuery.error} onRetry={() => void profilesQuery.refetch()} /></div></div>

  return (
    <div className="page-scroll">
      <PageHeader
        actions={profile ? <Button onClick={resetPaging} size="sm"><RefreshCw aria-hidden="true" className="size-3.5" />重新探测并刷新</Button> : undefined}
        description="通过 Workspace Service 的 typed Zotero routes 读取本机数据；不会打开 zotero.sqlite，也不会复制附件。"
        eyebrow="LIBRARY / ZOTERO LOCAL"
        title="Zotero"
      />
      {zoteroProfiles.length === 0 ? (
        <div className="mt-4"><EmptyState description="请先在设置中添加 Zotero 配置。未配置时不会显示演示数据。" title="尚未配置 Zotero" /></div>
      ) : (
        <div className="mt-4 grid gap-4">
          <div className="grid gap-3 rounded-md border border-border bg-surface px-4 py-3"><label className="grid gap-1.5" htmlFor="zotero-profile"><span className="text-xs font-semibold text-foreground">Zotero 配置</span><select className="select-control" id="zotero-profile" onChange={(event) => setProfileId(event.target.value)} value={profileId}>{zoteroProfiles.map((item) => <option key={item.id} value={item.id}>{item.name}{item.enabled ? '' : '（已停用）'}</option>)}</select></label><div className="flex flex-wrap items-center gap-2 text-xs"><span className="text-muted-foreground">连接状态：</span>{capabilityQuery.isLoading ? <span className="text-muted-foreground">正在探测…</span> : capabilityQuery.data ? <span className={cn('research-status', capabilityQuery.data.status === 'connected' ? 'research-status-positive' : 'research-status-warning')}>{capabilityStatusLabels[capabilityQuery.data.status]}</span> : <span className="text-muted-foreground">尚未探测</span>}{profile ? <Button aria-label="请求本机 Zotero 写入授权" disabled={authorizeMutation.isPending || capabilityQuery.isFetching || !localZotero} loading={authorizeMutation.isPending || capabilityQuery.isFetching} onClick={() => { void capabilityQuery.refetch().finally(() => authorizeMutation.mutate()) }} size="sm" title={localZotero ? '重新探测并请求本机写入授权' : '只有 localhost/127.0.0.1 Zotero Local API 支持本机写入授权'} variant="secondary">请求本机写入授权</Button> : <Button disabled size="sm" variant="secondary">请求本机写入授权</Button>}</div><p className="text-xs leading-5 text-muted-foreground">连接能力、授权和探测结果统一在“设置 → 工具连接”管理；本页仅浏览实际可读的集合与条目。Better BibTeX 导出为只读操作；写入 Zotero 前需在 Zotero 中启用 Local API 并完成本机写入授权。</p>{capabilityQuery.data && !canWrite ? <p className="mt-2 text-xs leading-5 write-blocked-note" role="status">只读：{writeBlockedExplanation(capabilityQuery.data.writeBlockedReason, capabilityQuery.data.status)}</p> : null}</div>

          {!canRead ? (
            <ResearchPanel eyebrow="ZOTERO / UNAVAILABLE" title="暂时无法读取">
              <div className="p-4"><p className="text-sm text-muted-foreground">{capabilityUnavailableMessage(capabilityQuery.data?.status)}</p></div>
            </ResearchPanel>
          ) : (<>
<div className={cn('zotero-workspace-grid pane-resize-host grid min-h-[38rem] gap-4 xl:grid-cols-[16rem_minmax(0,1fr)_18rem]', !collectionsOpen && 'zotero-workspace-grid-collections-collapsed', !inspectorOpen && 'zotero-workspace-grid-inspector-collapsed')} style={workspaceStyle}>
              {workspaceSeparators}
              <ResearchPanel className={!collectionsOpen ? 'zotero-collapsed-panel' : undefined} action={<Button aria-expanded={collectionsOpen} aria-label={collectionsOpen ? '折叠 Collections 到左侧' : '展开 Collections'} onClick={() => setCollectionsOpen((current) => !current)} size="icon" title={collectionsOpen ? '折叠 Collections 到左侧' : '展开 Collections'} variant="ghost">{collectionsOpen ? <ChevronLeft aria-hidden="true" className="size-4" /> : <ChevronRight aria-hidden="true" className="size-4" />}</Button>} eyebrow="COLLECTIONS / PAGE" title="Collections">
                {!collectionsOpen ? <p className="p-4 text-xs text-muted-foreground">集合已折叠。</p> : null}
                {collectionsOpen ? <>
                {collectionsQuery.isLoading && collectionEntries.length === 0 ? <PanelSkeleton lines={7} /> : null}
                {collectionsQuery.isFetching && collectionEntries.length > 0 ? <div className="px-3 py-2"><InlineLoadingState label="正在更新集合…" /></div> : null}
                {collectionsQuery.error ? <div className="p-3"><ErrorState compact error={collectionsQuery.error} onRetry={() => void collectionsQuery.refetch()} /></div> : null}
                {collectionsQuery.data ? <p className={cn('px-3 py-2 text-[11px]', collectionsQuery.data.status === 'partial' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>页面状态：{pageStatusLabels[collectionsQuery.data.status] ?? collectionsQuery.data.status}</p> : null}
                {collectionsQuery.data && collectionsQuery.data.status !== 'connected' && collectionsQuery.data.status !== 'partial' ? <p className="p-3 text-xs text-danger" role="alert">{pageStatusMessage(collectionsQuery.data.status)}</p> : null}
                <CollectionTree collections={collectionEntries} onSelect={(key) => { setCollectionKey(key); setPaperPreview(null); setPaperResult(null) }} selectedKey={collectionKey} />
                <div className="border-t border-border p-3">
                  <div className="mb-2 grid gap-2">
                    <label className="grid gap-1"><span className="text-[11px] text-muted-foreground">项目标签（导入/导出）</span><select aria-label="导出项目标签" className="select-control h-8 text-xs" id="zotero-export-project" onChange={(event) => setExportProjectId(event.target.value)} value={exportProjectId}><option value="">#未分类（不绑定项目）</option>{projects.map((project) => <option key={project.id} value={project.id}>#{project.name}</option>)}</select></label>
                    <label className="grid gap-1"><span className="text-[11px] text-muted-foreground">附加标签（空格或逗号分隔）</span><Input aria-label="BibTeX 附加标签" className="h-8 text-xs" onChange={(event) => setExportTags(event.target.value)} placeholder="#方法学, #重点" value={exportTags} /></label>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button aria-label="通过 Better BibTeX 导出已选文献" disabled={selectedItemKeys.size === 0 || bibtexExportMutation.isPending} loading={bibtexExportMutation.isPending} onClick={() => bibtexExportMutation.mutate()} size="sm" variant="secondary">通过 Better BibTeX 导出</Button>
                    <Button aria-label="预览导入工作台" disabled={selectedItemKeys.size === 0 || importPreviewMutation.isPending} loading={importPreviewMutation.isPending} onClick={() => importPreviewMutation.mutate()} size="sm" variant="primary">预览导入工作台</Button>
                  </div>
                  {bibtexExport ? <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-emerald-300/60 bg-emerald-50/60 px-3 py-2 text-xs dark:bg-emerald-950/20"><span className="min-w-0 flex-1 text-emerald-800 dark:text-emerald-200">已生成 Better BibTeX（{bibtexExport.citationKeys.length} 篇，{new TextEncoder().encode(bibtexExport.content).byteLength} bytes）</span><Button aria-label="下载 Better BibTeX 文件" onClick={() => { void downloadBibtex(bibtexExport.content).then((fileName) => { setOperationMessage(`已保存到 Downloads：${fileName}`); setOperationMessageKind('status') }).catch((error) => { setOperationMessage(getErrorMessage(error)); setOperationMessageKind('error') }) }} size="sm" variant="secondary"><Download aria-hidden="true" className="size-3.5" />下载 BibTeX 文件</Button><Button aria-label="清除 Better BibTeX 导出" onClick={() => setBibtexExport(null)} size="sm" variant="ghost">清除</Button></div> : null}
                  <p className="mt-2 text-[11px] leading-5 text-muted-foreground">导入会创建本地 Paper 和稳定关联；项目标签自动使用所选项目，未绑定时为 #未分类。确认前不会写入 Zotero；本地 Paper 投影会在预览阶段建立以便做重复检查。</p>
                </div>
                {collectionsQuery.data?.nextCursor && collectionsQuery.data.nextCursor !== collectionCursor ? <div className="p-3"><Button onClick={() => setCollectionCursor(collectionsQuery.data?.nextCursor ?? null)} size="sm" variant="ghost">加载更多集合</Button></div> : null}
                </> : null}
              </ResearchPanel>

              <ResearchPanel
                action={<div className="flex flex-wrap items-center gap-2"><select aria-label="导出格式" className="select-control h-8 text-xs" onChange={(event) => changeFormat(event.target.value as 'ris' | 'bibtex')} value={format}><option value="ris">RIS</option><option value="bibtex">BibTeX</option></select><Button aria-label="绑定当前 Collection" disabled={collectionBindingMutation.isPending || !collectionKey} loading={collectionBindingMutation.isPending} onClick={() => collectionBindingMutation.mutate(collectionKey)} size="sm" variant="ghost">绑定 Collection</Button><Button aria-label="移除 Collection 绑定" disabled={collectionBindingMutation.isPending || !profile?.settings?.zoteroCollectionKey} onClick={() => { setCollectionKey(null); collectionBindingMutation.mutate(null) }} size="sm" variant="ghost">移除绑定</Button><Button aria-label={`${remoteDeleteLabels.entry}（${remoteDeleteLabels.entryHint}）`} disabled={selectedItemKeys.size === 0 || remoteDeleteMutation.isPending} loading={remoteDeleteMutation.isPending} onClick={requestRemoteDelete} size="sm" variant="secondary" title={remoteDeleteLabels.entryHint}><Trash2 aria-hidden="true" className="size-3.5" />{remoteDeleteLabels.entryHint}</Button><span className="text-xs text-muted-foreground">已选 {selectedItemKeys.size}</span></div>}
                eyebrow="ZOTERO / ITEMS PAGE"
                title={collectionKey ? `条目 · ${collectionEntries.find((item) => item.key === collectionKey)?.name ?? collectionKey}` : '全部条目'}
              >
                <div className="border-b border-border p-3"><Input aria-label="搜索 Zotero 条目" onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题或作者" value={query} /></div>
                <div className="px-3 pt-2">
                  <SelectionBar
                    allSelected={allLoadedItemsSelected}
                    disabled={itemEntries.length === 0}
                    indeterminate={someLoadedItemsSelected}
                    label="Zotero 条目选择"
                    onClear={clearLoadedItems}
                    onToggleAll={toggleAllLoadedItems}
                    scope={`范围：全选仅覆盖已加载的 ${itemEntries.length} 条（单页最多 ${PAGE_SIZE} 条，“加载下一页”会保留已选）；切换 Collection、查询词或连接会清空已选，不会选中未加载页`}
                    selectAllLabel="全选已加载条目"
                    selectedCount={selectedItemKeys.size}
                    totalCount={itemEntries.length}
                  />
                </div>
                {itemsQuery.isLoading && itemEntries.length === 0 ? <PanelSkeleton lines={8} /> : null}
                {itemsQuery.isFetching && itemEntries.length > 0 ? <div className="px-3 py-2"><InlineLoadingState label="正在更新条目…" /></div> : null}
                {itemsQuery.error ? <div className="p-4"><ErrorState error={itemsQuery.error} onRetry={() => void itemsQuery.refetch()} /></div> : null}
                {itemsQuery.data ? <p className={cn('px-3 py-2 text-[11px]', itemsQuery.data.status === 'partial' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>页面状态：{pageStatusLabels[itemsQuery.data.status] ?? itemsQuery.data.status}</p> : null}
                {itemsQuery.data && itemsQuery.data.status !== 'connected' && itemsQuery.data.status !== 'partial' ? <p className="p-3 text-xs text-danger" role="alert">{pageStatusMessage(itemsQuery.data.status)}</p> : null}
                {itemEntries.length === 0 && !itemsQuery.isLoading ? <p className="research-empty-inline">当前查询没有条目。</p> : null}
                <div className="divide-y divide-border">{itemEntries.map((item) => <article className={cn('paper-row', inspectedItemKey === item.key && 'paper-row-active')} key={item.key}>
                  <label className="grid size-8 shrink-0 cursor-pointer place-items-center" title="选择条目"><span className="sr-only">选择 {item.title}</span><input checked={selectedItemKeys.has(item.key)} className="research-checkbox" onChange={() => toggleItem(item.key)} type="checkbox" /></label>
                  <button className="min-w-0 flex-1 cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setInspectedItemKey(item.key)} type="button"><h3 className="overflow-wrap-anywhere text-sm font-bold text-foreground">{item.title}</h3><p className="mt-1 truncate text-xs text-muted-foreground">{item.creators.join('、') || '未记录作者'} · {item.year ?? '年份未知'}{item.publicationTitle ? ` · ${item.publicationTitle}` : ''}</p><div className="mt-2 flex flex-wrap gap-1">{item.tags.slice(0, 4).map((tag) => <span className="research-tag" key={tag}>{displayTag(tag)}</span>)}{item.attachmentCount > 0 ? <span className="research-tag">附件链接 {item.attachmentCount}</span> : null}</div></button>
                </article>)}</div>
                {itemsQuery.data?.nextCursor && itemsQuery.data.nextCursor !== itemCursor ? <div className="flex justify-center p-3"><Button onClick={() => setItemCursor(itemsQuery.data?.nextCursor ?? null)} size="sm" variant="ghost">加载下一页</Button></div> : null}
                <div className="border-t border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button aria-label={remoteDeleteLabels.entry} disabled={selectedItemKeys.size === 0 || remoteDeleteMutation.isPending} loading={remoteDeleteMutation.isPending} onClick={requestRemoteDelete} size="sm" variant="secondary"><Trash2 aria-hidden="true" className="size-3.5" />{remoteDeleteLabels.entry}</Button>
                    <span className="text-[11px] leading-5 text-muted-foreground">{remoteDeleteLabels.entryHint}：先删除 Zotero 远端条目（永久删除），只有 Zotero 确认删除或返回 404 后才归档本地投影；远端删除失败时本地记录保留。{remoteDeletePreview && remoteDeletePreview.writeBlockedReason !== null ? ` 当前不可删除：${remoteDeletePreview.message}` : ''}</span>
                  </div>
                  {remoteDeleteReceipt ? <div className="mt-3 grid gap-2 rounded-md border border-border bg-surface-muted p-3 text-xs" data-zotero-delete-receipt={remoteDeleteReceipt.status}><p className="font-semibold text-foreground">{remoteDeleteReceiptSummary(remoteDeleteReceipt)}</p><div className="divide-y divide-border rounded-md border border-border bg-surface">{remoteDeleteReceiptRows(remoteDeleteReceipt).map((row) => <div className="grid gap-1 px-3 py-2" key={row.key}><div className="flex items-center gap-3"><span className="font-mono text-muted-foreground">{row.key}</span><span className="min-w-0 flex-1 font-medium text-foreground">{row.outcome}</span></div><span className="leading-5 text-muted-foreground">{row.detail}</span></div>)}</div></div> : null}
                </div>
              </ResearchPanel>

              <ResearchPanel className={!inspectorOpen ? 'zotero-collapsed-panel' : undefined} action={<Button aria-expanded={inspectorOpen} aria-label={inspectorOpen ? '折叠条目详情到右侧' : '展开条目详情'} onClick={() => setInspectorOpen((current) => !current)} size="icon" title={inspectorOpen ? '折叠条目详情到右侧' : '展开条目详情'} variant="ghost">{inspectorOpen ? <ChevronRight aria-hidden="true" className="size-4" /> : <ChevronLeft aria-hidden="true" className="size-4" />}</Button>} eyebrow="INSPECTOR / READ-ONLY" title="条目详情">{inspectorOpen ? <ItemInspector item={inspectedItem} link={inspectedLink} /> : null}</ResearchPanel>
            </div>
              {importPreview ? <ResearchPanel className="mt-4" action={<div className="flex gap-2"><Button disabled={importExecuteMutation.isPending} onClick={() => { setImportPreview(null); setOperationMessage(null) }} size="sm">取消</Button><Button disabled={importExecuteMutation.isPending} loading={importExecuteMutation.isPending} onClick={() => importExecuteMutation.mutate()} size="sm" variant="primary"><Check aria-hidden="true" className="size-3.5" />确认导入工作台</Button></div>} eyebrow="ZOTERO / WORKBENCH IMPORT" title={`导入预览 · ${importPreview.total} 条`}><div className="p-4"><div className="grid gap-1 text-xs text-muted-foreground"><p>目标项目：<span className="font-semibold text-foreground">{projects.find((project) => project.id === exportProjectId)?.name ?? '未分类'}</span></p><p>附加标签：{parseTagInput(exportTags).map((tag) => displayTag(tag)).join(' ') || '无'}</p><p>连接：只读 Local API；确认后创建本地 Paper 与稳定 Zotero 关联。</p></div><div className="mt-3 divide-y divide-border rounded-md border border-border">{importPreview.items.map((item) => <div className="flex items-center gap-3 px-3 py-2 text-xs" key={item.itemKey}><span className="font-mono text-muted-foreground">{item.itemKey}</span><span className="min-w-0 flex-1 truncate">{item.paperId ?? '新 Paper'}</span><span className={cn('research-tag', item.decision === 'create' ? 'border-emerald-300 text-emerald-700 dark:text-emerald-300' : 'border-amber-300 text-amber-700 dark:text-amber-300')}>{importDecisionLabel(item.decision)}</span></div>)}</div><p className="mt-3 text-[11px] leading-5 text-muted-foreground">重复项默认跳过，locator 与 remoteRevision 会写入关联回执；附件只保留链接，不复制 PDF。</p></div></ResearchPanel> : null}
              {importResult ? <ResearchPanel className="mt-4" eyebrow="ZOTERO / WORKBENCH RESULT" title="导入回执"><div className="grid gap-2 p-4 text-xs"><p className="text-foreground">成功 {importResult.succeeded} · 跳过 {importResult.skipped} · 失败 {importResult.failed}</p><div className="divide-y divide-border rounded-md border border-border">{importResult.items.map((item) => <div className="flex items-center gap-3 px-3 py-2" key={`${item.itemKey}:${item.paperId ?? 'none'}`}><span className="font-mono text-muted-foreground">{item.itemKey}</span><span className="min-w-0 flex-1">{item.paperId ?? '未创建 Paper'}</span><span className="research-tag">{item.outcome}</span></div>)}</div></div></ResearchPanel> : null}
            </>)}

          {paperPreview ? <ResearchPanel className="mt-4" action={<div className="flex gap-2"><Button disabled={paperExecuteMutation.isPending} onClick={() => { setPaperPreview(null); setOperationMessage(null) }} size="sm">取消</Button><Button aria-label={confirmLabels[paperPreview.transport === 'api' ? 'write' : 'read-only']} disabled={!canExecutePaper || paperExecuteMutation.isPending} loading={paperExecuteMutation.isPending} onClick={() => paperExecuteMutation.mutate()} size="sm" variant="primary"><Check aria-hidden="true" className="size-3.5" />{confirmLabels[paperPreview.transport === 'api' ? 'write' : 'read-only']}</Button></div>} eyebrow="ZOTERO / PAPER CONFIRMATION" title={`导出预览 · ${paperPreview.total} 条`}><div className="p-4 text-xs"><p className="text-muted-foreground">目标 Collection：<span className="font-semibold text-foreground">{paperPreview.targetCollectionKey ?? '默认'}</span> · capability：{paperPreview.capability} · transport：{paperPreview.transport}</p><div className="mt-3 divide-y divide-border rounded-md border border-border">{paperPreview.items.map((item) => <div className="flex flex-wrap items-center gap-3 px-3 py-2" key={`${item.itemKey}:${item.paperId ?? 'none'}`}><span className="font-mono text-muted-foreground">{item.itemKey}</span><span className="min-w-0 flex-1">{papers.find((paper) => paper.id === item.paperId)?.title ?? item.paperId ?? '本地 Paper'}</span><span className="research-tag">{importDecisionLabel(item.decision)}</span>{item.note ? <span className="basis-full leading-5 text-amber-700 dark:text-amber-300">{item.note}</span> : null}</div>)}</div><p className="mt-3 leading-5 text-muted-foreground">{paperPreview.transport === 'api' ? '这是一份一次性写入预览：预览已冻结条目匹配、目标 Collection 和 profile revision；只有点击“确认并写入 Zotero”才会调用 Zotero，失败项会逐条返回回执。' : `这是一份一次性生成预览：${writeBlockedExplanation(capabilityQuery.data?.writeBlockedReason, capabilityQuery.data?.status)}`}{paperPreview.targetCollectionKey === null ? ' 未指定 Collection 时不会改动 Zotero 中现有条目的 Collection 成员关系。' : ''}</p></div></ResearchPanel> : null}
          {paperResult ? <ResearchPanel className="mt-4" eyebrow="ZOTERO / PAPER RESULT" title="Paper → Zotero 回执"><div className="grid gap-2 p-4 text-xs"><p className="text-foreground">成功 {paperResult.succeeded} · 跳过 {paperResult.skipped} · 失败 {paperResult.failed}</p>{paperResult.handoff ? <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300/60 bg-amber-50/60 px-3 py-2 dark:bg-amber-950/20"><span className="min-w-0 flex-1 text-amber-800 dark:text-amber-200">已生成 {paperResult.handoff.itemCount} 条 {paperResult.handoff.format.toUpperCase()} 导入包（未写入 Zotero，目标 Collection：{paperResult.handoff.targetCollectionKey ?? '默认'}）。回执中的“已生成”只有在下载并由 Zotero 导入后才生效。</span><Button aria-label="下载 Zotero 导入包" onClick={() => { void downloadZoteroHandoff(paperResult.handoff!).then((fileName) => { setOperationMessage(`已保存到 Downloads：${fileName}`); setOperationMessageKind('status') }).catch((error) => { setOperationMessage(getErrorMessage(error)); setOperationMessageKind('error') }) }} size="sm" variant="secondary"><Download aria-hidden="true" className="size-3.5" />下载导入包</Button></div> : null}<div className="divide-y divide-border rounded-md border border-border">{paperResult.items.map((item) => <div className="flex flex-wrap items-center gap-3 px-3 py-2" key={`${item.itemKey}:${item.paperId ?? 'none'}`}><span className="font-mono text-muted-foreground">{item.itemKey}</span><span className="min-w-0 flex-1">{item.paperId ?? '未创建 Paper'}</span><span className="research-tag">{item.outcome}</span><span className="research-tag">{collectionWriteLabel(item.collectionWrite, item.targetCollectionKey)}</span>{item.remoteRevision ? <span className="font-mono text-muted-foreground">v{item.remoteRevision}</span> : null}{item.error ? <span className="basis-full text-danger">{item.error.message}</span> : null}</div>)}</div></div></ResearchPanel> : null}

          {operationMessage ? <p className={cn('form-feedback', operationMessageKind === 'error' ? 'form-feedback-error' : 'form-feedback-success')} role={operationMessageKind === 'error' ? 'alert' : 'status'}>{operationMessage}</p> : null}
        </div>
      )}
    </div>
  )
}
