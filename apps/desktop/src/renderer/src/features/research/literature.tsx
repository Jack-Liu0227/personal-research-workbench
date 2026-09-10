import { BookOpen, ChevronLeft, ChevronRight, Download, ExternalLink, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  LiteratureStagingRecord,
  LiteratureStagingToZoteroPreview,
  LiteratureStagingToZoteroResult,
  Project,
  SearchResult,
  SearchResultPage,
  SearchSession,
  SearchSourceId,
  ZoteroCollection,
  ZoteroHandoff
} from '@prw/contracts'
import { ProjectIdSchema } from '@prw/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Input } from '../../components/ui'
import { EmptyState, ErrorState, LoadingState } from '../../components/states'
import { getWorkbenchApi } from '../../lib/workbench'
import { queryKeys, useIntegrationsQuery, useLiteratureStagingQuery, useSearchSessionsQuery } from '../queries'
import { MutationFeedback, ResearchPanel } from './shared'

const sourceLabels: Record<SearchSourceId, string> = {
  all: '全部免费来源', local: '本地索引', crossref: 'Crossref', openalex: 'OpenAlex', pubmed: 'PubMed', arxiv: 'arXiv', semantic_scholar: 'Semantic Scholar', google_scholar: 'Google Scholar（scholarly）'
}
const sources: SearchSourceId[] = ['all', 'crossref', 'openalex', 'pubmed', 'arxiv', 'semantic_scholar', 'google_scholar']
type LiteratureTab = 'search' | 'staging'
type ResultSort = 'relevance' | 'year-asc' | 'year-desc' | 'impact-asc' | 'impact-desc' | 'metric-asc' | 'metric-desc' | 'title'
type ZoteroExportFormat = 'ris' | 'bibtex'

function randomConfirmationToken(prefix: string): string { return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}` }
async function downloadZoteroHandoff(handoff: ZoteroHandoff): Promise<string> {
  const result = await getWorkbenchApi().system.saveTextFile({
    fileName: handoff.fileName,
    content: handoff.content,
    mimeType: handoff.format === 'bibtex' ? 'application/x-bibtex;charset=utf-8' : 'application/x-research-info-systems;charset=utf-8'
  })
  if (!result.saved) throw new Error('文件未保存，请重试。')
  return result.fileName
}
function parseTagInput(value: string): string[] {
  return [...new Set(value.split(/[\s,，]+/u).map((tag) => tag.replace(/^#+/u, '').trim()).filter(Boolean))].slice(0, 20)
}
function latestSession(sessions: SearchSession[] | undefined): SearchSession | null { return [...(sessions ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null }
function stagingSource(result: SearchResult): Exclude<SearchSourceId, 'all'> { return result.source === 'all' || result.source === 'local' ? 'crossref' : result.source }
function stagingInput(result: SearchResult, projectId: string) {
  return { sessionId: result.sessionId, projectId: projectId ? ProjectIdSchema.parse(projectId) : null, source: stagingSource(result), sourceId: result.sourceId, title: result.title, authors: result.authors, year: result.year, venue: result.venue, abstract: result.abstract, doi: result.doi, url: result.url, isOpenAccess: result.isOpenAccess, openMetric: result.openMetric ?? null, fingerprint: result.fingerprint, dedupeReason: result.dedupeReason, dedupeConfidence: result.dedupeConfidence, paperId: null, expectedRevision: null }
}
function stagingProjectUpdate(record: LiteratureStagingRecord, projectId: string) {
  return { id: record.id, expectedRevision: record.revision, sessionId: record.sessionId, projectId: projectId ? ProjectIdSchema.parse(projectId) : null, source: record.source, sourceId: record.sourceId, title: record.title, authors: record.authors, year: record.year, venue: record.venue, abstract: record.abstract, doi: record.doi, url: record.url, isOpenAccess: record.isOpenAccess, openMetric: record.openMetric ?? null, fingerprint: record.fingerprint, dedupeReason: record.dedupeReason, dedupeConfidence: record.dedupeConfidence, paperId: record.paperId }
}
function metadataLine(result: Pick<SearchResult, 'authors' | 'year' | 'venue' | 'source'>): string { return `${result.authors.length > 0 ? result.authors.join(', ') : '作者未知'} · ${result.venue || sourceLabels[result.source]} · ${result.year ?? '年份未知'}` }
function compareImpactFactor(left: number | null | undefined, right: number | null | undefined, descending: boolean): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1
  if (right === null || right === undefined) return -1
  return descending ? right - left : left - right
}
function compareYear(left: number | null | undefined, right: number | null | undefined, descending: boolean): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1
  if (right === null || right === undefined) return -1
  return descending ? right - left : left - right
}
function compareOpenMetric(left: number | null | undefined, right: number | null | undefined, descending: boolean): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1
  if (right === null || right === undefined) return -1
  return descending ? right - left : left - right
}

function InspectorResizeHandle({ containerRef, onResize, ratio }: { containerRef: { current: HTMLDivElement | null }; onResize: (ratio: number) => void; ratio: number }): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    if (!dragging) return
    const handleMove = (event: PointerEvent) => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0) return
      onResize(Math.min(40, Math.max(16, ((rect.right - event.clientX) / rect.width) * 100)))
    }
    const stopDragging = () => setDragging(false)
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', stopDragging)
    return () => { window.removeEventListener('pointermove', handleMove); window.removeEventListener('pointerup', stopDragging) }
  }, [containerRef, dragging, onResize])
  const adjust = (delta: number) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return
    const current = Number.parseFloat(getComputedStyle(containerRef.current!).getPropertyValue('--literature-inspector-ratio')) || 17
    onResize(Math.min(40, Math.max(16, current + delta)))
  }
  return <div aria-label="拖动调整结果详情宽度" aria-orientation="vertical" aria-valuemax={40} aria-valuemin={16} aria-valuenow={Math.round(ratio)} className={`literature-resize-handle ${dragging ? 'literature-resize-handle-active' : ''}`} onKeyDown={(event) => { if (event.key === 'ArrowLeft') { event.preventDefault(); adjust(1) } else if (event.key === 'ArrowRight') { event.preventDefault(); adjust(-1) } }} onPointerDown={(event) => { event.preventDefault(); setDragging(true) }} role="separator" tabIndex={0} />
}

function SearchResultRow({ result, index, selected, inspected, staged, failed, zoteroProfile, onSelect, onStage, onQueue, onInspect, onContextMenu }: { result: SearchResult; index: number; selected: boolean; inspected: boolean; staged: boolean; failed: boolean; zoteroProfile: boolean; onSelect: (checked: boolean) => void; onStage: () => void; onQueue?: () => void; onInspect: () => void; onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void }): React.JSX.Element {
  return <div className={`paper-row ${inspected ? 'paper-row-inspected' : ''} ${selected ? 'paper-row-active' : ''}`} onContextMenu={onContextMenu} role="article">
    <span aria-hidden="true" className="literature-result-number">{index}</span>
    <label className="grid size-8 shrink-0 cursor-pointer place-items-center" title="选择文献"><span className="sr-only">选择 {result.title}</span><input aria-label={`选择文献：${result.title}`} checked={selected} className="research-checkbox" onChange={(event) => onSelect(event.target.checked)} onClick={(event) => event.stopPropagation()} type="checkbox" /></label>
    <button aria-label={`${result.title} ${metadataLine(result)}`} className="min-w-0 flex-1 cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onInspect} type="button"><h3 className="overflow-wrap-anywhere text-sm font-semibold text-foreground">{result.title}</h3><p className="literature-result-meta"><span>{result.authors.length > 0 ? result.authors.slice(0, 3).join(', ') : '作者未知'}</span><span aria-hidden="true">·</span><span>{result.venue || sourceLabels[result.source]}</span><span aria-hidden="true">·</span><span>{result.year ?? '年份未知'}</span>{result.openMetric !== null && result.openMetric !== undefined ? <span className="literature-open-metric-badge">引用 {result.openMetric}</span> : null}</p>{result.abstract ? <p className="literature-result-abstract">{result.abstract}</p> : null}</button>
    <div className="literature-paper-actions">{result.impactFactor !== null && result.impactFactor !== undefined ? <span className="literature-impact-badge" title={`${result.impactFactorSource ?? '公开来源'}${result.impactFactorFetchedAt ? ` · ${new Date(result.impactFactorFetchedAt).toLocaleString()}` : ''}`}>{result.impactFactorSource?.includes('IF 风格') ? 'IF*' : 'IF'} {result.impactFactor.toFixed(1)}</span> : <span className="literature-impact-badge literature-impact-missing" title="公开免费来源未提供可验证的期刊影响因子或 IF 风格指标">IF 未提供</span>}{failed ? <span className="literature-paper-failure">Zotero 写入失败</span> : null}{result.url ? <a aria-label={`打开 ${result.title}`} className="literature-paper-icon-button" href={result.url} onClick={(event) => event.stopPropagation()} rel="noreferrer" target="_blank"><ExternalLink aria-hidden="true" className="size-3.5" /></a> : null}{onQueue ? <Button aria-label={`加入待读：${result.title}`} onClick={(event) => { event.stopPropagation(); onQueue() }} size="icon" variant="ghost"><BookOpen aria-hidden="true" className="size-3.5" /></Button> : null}<Button aria-label={failed ? `重新导入 Zotero：${result.title}` : staged ? `再次预览导入 Zotero：${result.title}` : `暂存并准备导入 Zotero：${result.title}`} onClick={(event) => { event.stopPropagation(); onStage() }} size="sm" variant={failed ? 'danger' : staged ? 'secondary' : 'secondary'}>{failed ? <><RefreshCw aria-hidden="true" className="size-3.5" />重新导入</> : staged ? <><RefreshCw aria-hidden="true" className="size-3.5" />再次预览</> : zoteroProfile ? '保存到 Zotero' : '加入待分类'}</Button></div>
  </div>
}

function Inspector({ result, open, onToggle, preview, onCancelPreview, onExecutePreview, executePending, targetCollection, containerRef, onResize, ratio, staged, failed }: { result: SearchResult | null; open: boolean; onToggle: () => void; preview: LiteratureStagingToZoteroPreview | null; onCancelPreview: () => void; onExecutePreview: () => void; executePending: boolean; targetCollection: string | null; containerRef: { current: HTMLDivElement | null }; onResize: (ratio: number) => void; ratio: number; staged: boolean; failed: boolean }): React.JSX.Element {
  return <ResearchPanel className={`literature-inspector-panel ${open ? '' : 'literature-inspector-panel-collapsed'} xl:sticky xl:top-3`} action={<Button aria-label={open ? '折叠结果详情' : '展开结果详情'} onClick={onToggle} size="icon" variant="ghost">{open ? <ChevronRight aria-hidden="true" className="size-4" /> : <ChevronLeft aria-hidden="true" className="size-4" />}</Button>} eyebrow="INSPECTOR / PAPER" title="结果详情">
    {open ? <InspectorResizeHandle containerRef={containerRef} onResize={onResize} ratio={ratio} /> : null}
    {!open ? <p className="p-4 text-xs text-muted-foreground">详情已折叠。点击右上角展开。</p> : null}
    {open && !result ? <EmptyState description="从检索结果中选择一篇文献。" title="尚未选择结果" /> : null}
    {open && !result && !preview ? <div className="border-t border-border p-4 text-xs"><p className="font-semibold text-foreground">实时导入预览</p><p className="mt-2 leading-5 text-muted-foreground">选择检索结果或批量勾选后，这里会显示目标 Collection、标签和逐条写入回执；未确认前不会触发 Zotero 外部写入。</p></div> : null}
    {open && result ? <div className="literature-inspector-body"><div className="literature-inspector-tabs" role="tablist"><button aria-selected="true" className="literature-inspector-tab literature-inspector-tab-active" role="tab" type="button">文献信息</button><button aria-selected="false" className="literature-inspector-tab" role="tab" type="button">笔记</button><button aria-selected="false" className="literature-inspector-tab" role="tab" type="button">相关文献</button></div><div className="literature-inspector-paper-head"><div aria-hidden="true" className="literature-inspector-thumb"><BookOpen className="size-5" /></div><div className="min-w-0"><h3 className="text-sm font-bold leading-5 text-foreground">{result.title}</h3><p className="mt-1 text-xs text-muted-foreground">{metadataLine(result)}</p><span className="literature-inspector-if">{result.impactFactor !== null && result.impactFactor !== undefined ? `${result.impactFactorSource?.includes('IF 风格') ? 'IF*' : 'IF'} ${result.impactFactor.toFixed(1)}` : 'IF 未提供'}</span></div></div><dl className="literature-inspector-fields"><div><dt>作者</dt><dd>{result.authors.join('、') || '作者未知'}</dd></div><div><dt>年份</dt><dd>{result.year ?? '未提供'}</dd></div><div><dt>期刊</dt><dd>{result.venue || '未提供'}</dd></div>{result.impactFactorSource ? <div><dt>影响因子来源</dt><dd>{result.impactFactorSource}</dd></div> : null}{result.impactFactorFetchedAt ? <div><dt>获取时间</dt><dd>{new Date(result.impactFactorFetchedAt).toLocaleString()}</dd></div> : null}<div><dt>公开引用指标</dt><dd>{result.openMetric ?? '未提供'}{result.openMetric !== null && result.openMetric !== undefined ? '（来源记录）' : ''}</dd></div></dl>{result.doi ? <div className="literature-inspector-doi"><span>DOI</span><a href={`https://doi.org/${result.doi.replace(/^https?:\/\/doi.org\//iu, '')}`} rel="noreferrer" target="_blank">{result.doi}</a><button aria-label="复制 DOI" onClick={() => { void navigator.clipboard?.writeText(result.doi ?? '') }} type="button">复制</button></div> : null}<div className={`literature-inspector-zotero-status ${failed ? 'literature-inspector-zotero-failed' : ''}`}><strong>Zotero 导入状态</strong><span>{failed ? '写入失败，可再次导入' : preview ? '待确认写入' : staged ? '已加入待分类' : '尚未写入'}</span>{failed ? <small>修复连接后可以再次导入此文献。</small> : null}</div><div><p className="literature-inspector-label">摘要</p><p className="literature-inspector-abstract">{result.abstract || '暂无摘要'}</p></div>{result.url ? <div><p className="literature-inspector-label">URL</p><a className="literature-inspector-url" href={result.url} rel="noreferrer" target="_blank">{result.url}</a></div> : null}</div> : null}
    {open && preview ? <div className="border-t border-border p-4 text-xs"><div className="flex items-center justify-between gap-2"><p className="font-semibold text-foreground">实时导入预览</p><span className="research-tag">{preview.total} 条</span></div><p className="mt-2 leading-5 text-muted-foreground">目标 Collection：{targetCollection ?? '默认'} · capability：{preview.capability} · {preview.transport}</p><p className="mt-2 leading-5 text-muted-foreground">外部写入尚未发生。{preview.transport === 'api' ? preview.capability === 'write' ? '确认后才会调用 Zotero，失败项会逐条返回。' : '当前连接没有写入权限；确认后会逐条返回失败回执，修复设置后可重新导入。' : '确认后将生成 RIS/BibTeX 导入包，不会伪称已写入 Zotero。'}</p><div className="mt-3 flex gap-2"><Button onClick={onCancelPreview} size="sm">取消</Button><Button loading={executePending} onClick={onExecutePreview} size="sm" variant="primary">{preview.transport === 'api' ? '确认并写入' : '确认并生成导入包'}</Button></div></div> : null}
  </ResearchPanel>
}

function SearchPagination({ currentPage, totalPages, totalResults, pageSize, onPageChange, pending, hasMore }: { currentPage: number; totalPages: number; totalResults: number; pageSize: number; onPageChange: (page: number) => void; pending: boolean; hasMore: boolean }): React.JSX.Element {
  if (totalResults <= 0) return <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground">暂无结果</div>
  const first = (currentPage - 1) * pageSize + 1
  const last = Math.min(totalResults, currentPage * pageSize)
  const pages = Array.from({ length: totalPages }, (_, index) => index + 1).filter((page) => page === 1 || page === totalPages || Math.abs(page - currentPage) <= 2)
  return <nav aria-label="文献结果分页" className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-xs">
    <span className="text-muted-foreground">显示 {first}-{last} / 共 {totalResults}{hasMore ? '+' : ''} 条</span>
    <div className="flex items-center gap-1">
      <Button aria-label="上一页" disabled={pending || currentPage <= 1} onClick={() => onPageChange(currentPage - 1)} size="sm" variant="secondary">上一页</Button>
      {pages.map((page, index) => <span className="flex items-center gap-1" key={page}>{index > 0 && pages[index - 1] !== page - 1 ? <span className="px-1 text-muted-foreground">…</span> : null}<Button aria-current={page === currentPage ? 'page' : undefined} aria-label={`第 ${page} 页`} disabled={pending} onClick={() => onPageChange(page)} size="sm" variant={page === currentPage ? 'primary' : 'secondary'}>{page}</Button></span>)}
      <Button aria-label="下一页" disabled={pending || (!hasMore && currentPage >= totalPages)} onClick={() => onPageChange(currentPage + 1)} size="sm" variant="secondary">下一页</Button>
    </div>
  </nav>
}

export function LiteraturePage({ projects }: { projects: Project[] }): React.JSX.Element {
  const api = getWorkbenchApi(); const queryClient = useQueryClient()
  const [zoteroTags, setZoteroTags] = useState('')
  const [stagingProjectFilter, setStagingProjectFilter] = useState<string | null | undefined>(undefined)
  const [zoteroFormat, setZoteroFormat] = useState<ZoteroExportFormat>('bibtex')
  const sessionsQuery = useSearchSessionsQuery(); const stagingQuery = useLiteratureStagingQuery('', stagingProjectFilter); const profilesQuery = useIntegrationsQuery()
  // A disabled profile must not be treated as an import target.  Keeping the
  // lookup enabled-only makes the UI and the Core capability gate agree: when
  // Zotero is disabled, the result actions stay in staging mode and retry is
  // offered again as soon as the profile is enabled.
  const zoteroProfile = useMemo(() => (profilesQuery.data ?? []).find((profile) => profile.provider === 'zotero' && profile.enabled), [profilesQuery.data])
  const [tab, setTab] = useState<LiteratureTab>('search'); const [query, setQuery] = useState(''); const [source, setSource] = useState<SearchSourceId>('all'); const [projectId, setProjectId] = useState(''); const [results, setResults] = useState<SearchResult[]>([]); const [resultCache, setResultCache] = useState<Record<string, SearchResult>>({}); const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set()); const [selectedResult, setSelectedResult] = useState<SearchResult | null>(null); const [inspectorOpen, setInspectorOpen] = useState(true); const [inspectorRatio, setInspectorRatio] = useState(17); const [filter, setFilter] = useState(''); const [yearFilter, setYearFilter] = useState('all'); const [sort, setSort] = useState<ResultSort>('relevance'); const [pageSize, setPageSize] = useState(50); const [currentPage, setCurrentPage] = useState(1); const [totalResults, setTotalResults] = useState(0); const [hasMorePages, setHasMorePages] = useState(false); const [activeSessionId, setActiveSessionId] = useState<string | null>(null); const [feedback, setFeedback] = useState<string | null>(null); const [feedbackError, setFeedbackError] = useState<unknown>(null); const [contextMenu, setContextMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null); const [zoteroPreview, setZoteroPreview] = useState<LiteratureStagingToZoteroPreview | null>(null); const [zoteroHandoff, setZoteroHandoff] = useState<ZoteroHandoff | null>(null); const [activePreviewRecords, setActivePreviewRecords] = useState<LiteratureStagingRecord[]>([]); const [retryableStaging, setRetryableStaging] = useState<LiteratureStagingRecord[]>([]); const [zoteroReceipts, setZoteroReceipts] = useState<LiteratureStagingToZoteroResult['items']>([]); const [receiptTitles, setReceiptTitles] = useState<Record<string, string>>({}); const [collectionKey, setCollectionKey] = useState<string | null>(null); const pageCursors = useRef<Record<number, string | null>>({}); const literatureLayoutRef = useRef<HTMLDivElement>(null)
  const latest = useMemo(() => latestSession(sessionsQuery.data), [sessionsQuery.data])
  const restoredResultsQuery = useQuery<SearchResultPage>({ queryKey: ['literature-results', latest?.id ?? 'none', pageSize], queryFn: () => api.literature.resultsPage({ sessionId: latest!.id, page: { limit: pageSize } }), enabled: Boolean(latest?.id) })
  const collectionsQuery = useQuery({ queryKey: queryKeys.zoteroCollections(zoteroProfile?.id ?? 'none'), queryFn: () => api.zotero.collectionsPage({ profileId: zoteroProfile!.id }), enabled: Boolean(zoteroProfile?.id) })
  const collections = collectionsQuery.data?.items ?? []
  const stagedItems = stagingQuery.data?.items ?? []
  const ensureStaging = async (result: SearchResult): Promise<LiteratureStagingRecord> => {
    const source = stagingSource(result)
    const findByIdentity = (items: readonly LiteratureStagingRecord[]): LiteratureStagingRecord | undefined => items.find((item) => item.source === source && item.sourceId === result.sourceId)
    const cached = findByIdentity(stagedItems)
    if (cached) return cached
    // The visible staging query is paged. Resolve an exact identity before inserting
    // so repeated preview/batch actions remain idempotent even after the first page.
    const matchingPage = await api.literature.staging.page({ query: result.sourceId, page: { limit: 100 } })
    const existing = findByIdentity(matchingPage.items)
    if (existing) return existing
    return api.literature.staging.save(stagingInput(result, projectId))
  }
  useEffect(() => { if (!latest || results.length > 0) return; setQuery(latest.query); setSource(latest.source) }, [latest, results.length])
  useEffect(() => { if (results.length > 0 || !restoredResultsQuery.data || !latest?.id) return; setActiveSessionId(latest.id); pageCursors.current = { 1: null, 2: restoredResultsQuery.data.nextCursor }; setHasMorePages(restoredResultsQuery.data.nextCursor !== null); setResults(restoredResultsQuery.data.items); setResultCache(Object.fromEntries(restoredResultsQuery.data.items.map((item) => [item.id, item]))); setTotalResults(restoredResultsQuery.data.total); setSelectedResult(restoredResultsQuery.data.items[0] ?? null) }, [latest?.id, restoredResultsQuery.data, results.length])
  useEffect(() => { if (!contextMenu) return; const close = () => setContextMenu(null); window.addEventListener('click', close); return () => window.removeEventListener('click', close) }, [contextMenu])

  const searchMutation = useMutation({ mutationFn: async (requestedSort?: ResultSort) => { const selectedSort = requestedSort ?? sort; const serviceSort: Exclude<ResultSort, 'title'> = selectedSort === 'title' ? 'relevance' : selectedSort; const value = await api.literature.search({ query: query.trim(), source, page: 1, pageSize, sort: serviceSort, filters: {} }); const pageData = await api.literature.resultsPage({ sessionId: value.session.id, page: { limit: pageSize } }); return { value, pageData } }, onSuccess: async ({ value, pageData }) => { setActiveSessionId(value.session.id); pageCursors.current = { 1: null, 2: pageData.nextCursor }; setHasMorePages(pageData.nextCursor !== null); setCurrentPage(1); setResults(pageData.items); setResultCache(Object.fromEntries(pageData.items.map((item) => [item.id, item]))); setTotalResults(pageData.total); setSelectedResult(pageData.items[0] ?? null); setInspectorOpen(true); setSelectedIds(new Set()); setFeedback(`已检索第 1 页，${pageData.items.length} 条结果${pageData.nextCursor !== null ? '，可继续翻页' : ''}`); setFeedbackError(null); await queryClient.invalidateQueries({ queryKey: queryKeys.searchSessions }) }, onError: (error) => { setFeedback(null); setFeedbackError(error) } })
  const pageMutation = useMutation({ mutationFn: async (page: number) => {
    if (!activeSessionId) throw new Error('请先执行一次文献检索')
    let pageData: SearchResultPage | null = null
    if (page === 1) {
      pageData = await api.literature.resultsPage({ sessionId: activeSessionId, page: { limit: pageSize } })
      pageCursors.current[2] = pageData.nextCursor
    } else {
      // Cursor pagination is sequential. A page button may be selected before
      // its cursor is known, so advance through the cached cursor chain. The
      // service fetches a remote continuation only when that opaque cursor is
      // reached and appends it to the same search session.
      for (let requestedPage = 2; requestedPage <= page; requestedPage += 1) {
        const cursor = pageCursors.current[requestedPage]
        if (cursor === undefined || cursor === null) throw new Error('已经到达最后一页')
        pageData = await api.literature.resultsPage({ sessionId: activeSessionId, page: { limit: pageSize, cursor } })
        pageCursors.current[requestedPage + 1] = pageData.nextCursor
      }
    }
    if (!pageData) throw new Error('无法加载文献结果')
    return { page, pageData }
  }, onSuccess: ({ page, pageData }) => { if (pageData.items.length === 0) { setHasMorePages(false); setFeedback(`第 ${page} 页没有更多结果`); setFeedbackError(null); return } setCurrentPage(page); setResults(pageData.items); setResultCache((current) => ({ ...current, ...Object.fromEntries(pageData.items.map((item) => [item.id, item])) })); setTotalResults((current) => Math.max(current, pageData.total, page * pageSize)); setHasMorePages(pageData.nextCursor !== null); setSelectedResult(pageData.items[0] ?? null); setFeedback(`已加载第 ${page} 页，${pageData.items.length} 条结果`); setFeedbackError(null) }, onError: (error) => { setFeedback(null); setFeedbackError(error) } })
  const totalPages = Math.max(1, Math.ceil(totalResults / pageSize), hasMorePages ? currentPage + 1 : 1)
  const goToPage = (page: number) => { const next = Math.max(1, page); if ((!hasMorePages && next > totalPages) || next === currentPage || searchMutation.isPending || pageMutation.isPending) return; pageMutation.mutate(next) }
  const stageMutation = useMutation({ mutationFn: (result: SearchResult) => ensureStaging(result), onSuccess: async (record) => { setFeedback(`已加入待分类：${record.title}`); setFeedbackError(null); await queryClient.invalidateQueries({ queryKey: ['literature-staging'] }) }, onError: (error) => { setFeedback(null); setFeedbackError(error) } })
  const batchStageMutation = useMutation({ mutationFn: async (items: SearchResult[]) => Promise.all(items.map((result) => ensureStaging(result))), onSuccess: async (records) => { setFeedback(`已加入待分类 ${records.length} 条`); setFeedbackError(null); setSelectedIds(new Set()); await queryClient.invalidateQueries({ queryKey: ['literature-staging'] }) }, onError: (error) => { setFeedback(null); setFeedbackError(error) } })
  const queueMutation = useMutation({
    mutationFn: async (items: SearchResult[]) => {
      if (items.length === 0) throw new Error('请至少选择一篇文献。')
      return Promise.all(items.map(async (result) => {
        const imported = await api.literature.importResult({ sessionId: result.sessionId, resultKey: result.id, projectId: projectId ? ProjectIdSchema.parse(projectId) : null })
        if (!imported.paper) throw new Error(`无法创建 Paper：${result.title}`)
        return api.papers.update({ id: imported.paper.id, status: 'queued', expectedRevision: imported.paper.revision })
      }))
    },
    onSuccess: async (papers) => {
      setFeedback(`已加入待读 ${papers.length} 篇；可在仪表盘“待读文献”查看。`)
      setFeedbackError(null)
      setSelectedIds(new Set())
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['papers'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      ])
    },
    onError: (error) => { setFeedback(null); setFeedbackError(error) }
  })
  const previewMutation = useMutation({ mutationFn: async (records: LiteratureStagingRecord[]) => { if (!zoteroProfile) throw new Error('请先在设置中配置并启用 Zotero'); return api.literature.stagingToZotero.preview({ profileId: zoteroProfile.id, stagingIds: records.map((record) => record.id), targetCollectionKey: collectionKey, format: zoteroFormat, tags: parseTagInput(zoteroTags), transport: 'api' }) }, onMutate: (records) => { setActivePreviewRecords(records); setZoteroReceipts([]); setReceiptTitles({}); setZoteroHandoff(null) }, onSuccess: (preview) => { setZoteroPreview(preview); setFeedback(`Zotero API 预览已生成 ${preview.total} 条；确认后才会写入`); setFeedbackError(null) }, onError: (error) => { setFeedback(null); setFeedbackError(error) } })
  const executeMutation = useMutation({
    mutationFn: (operation: { previewId: string; records: LiteratureStagingRecord[] }) => api.literature.stagingToZotero.execute({ previewId: operation.previewId, confirmed: true, confirmationToken: randomConfirmationToken('literature-zotero') }),
    onSuccess: async (result, operation) => {
      const failedIds = new Set(result.items.filter((item) => item.outcome === 'failed' || item.outcome === 'unsupported').map((item) => item.stagingId))
      setRetryableStaging((current) => {
        const activeIds = new Set(operation.records.map((record) => record.id))
        return [...current.filter((record) => !activeIds.has(record.id)), ...operation.records.filter((record) => failedIds.has(record.id))]
      })
      setZoteroReceipts(result.items)
      setReceiptTitles(Object.fromEntries(operation.records.map((record) => [record.id, record.title])))
      setZoteroPreview((current) => current?.previewId === operation.previewId ? null : current)
      setZoteroHandoff(result.handoff)
      setFeedback(result.handoff ? `已生成 ${result.handoff.fileName}，尚未写入 Zotero。` : `Zotero 操作完成：成功 ${result.succeeded}，跳过 ${result.skipped}，失败 ${result.failed}`)
      setFeedbackError(failedIds.size > 0 ? new Error('部分文献未写入 Zotero，请查看逐条回执并重新导入') : null)
      await queryClient.invalidateQueries({ queryKey: ['literature-staging'] })
    },
    onError: (error, operation) => {
      setRetryableStaging((current) => [...new Map([...current, ...operation.records].map((record) => [record.id, record])).values()])
      setReceiptTitles(Object.fromEntries(operation.records.map((record) => [record.id, record.title])))
      setFeedback(null)
      setFeedbackError(error)
    }
  })
  const executePreview = () => {
    if (!zoteroPreview || executeMutation.isPending) return
    executeMutation.mutate({ previewId: zoteroPreview.previewId, records: activePreviewRecords })
  }
  const deleteMutation = useMutation({ mutationFn: (records: LiteratureStagingRecord[]) => api.literature.staging.bulkDelete({ selection: { mode: 'explicit', selectedIds: records.map((record) => record.id), excludedIds: [], queryFingerprint: null }, expectedRevisions: records.map((record) => ({ id: record.id, expectedRevision: record.revision })) }), onSuccess: async (value) => { setFeedback(`待分类清理完成：成功 ${value.succeeded}，跳过 ${value.skipped}，失败 ${value.failed}`); setFeedbackError(value.failed > 0 ? new Error('部分记录未删除') : null); setSelectedIds(new Set()); await queryClient.invalidateQueries({ queryKey: ['literature-staging'] }) }, onError: (error) => { setFeedback(null); setFeedbackError(error) } })

  const assignProjectMutation = useMutation({ mutationFn: ({ record, projectId }: { record: LiteratureStagingRecord; projectId: string }) => api.literature.staging.save(stagingProjectUpdate(record, projectId)), onSuccess: async (record) => { setFeedback(`已将「${record.title}」分配到${record.projectId ? '项目' : '未分类'}`); setFeedbackError(null); await queryClient.invalidateQueries({ queryKey: ['literature-staging'] }) }, onError: (error) => { setFeedback(null); setFeedbackError(error) } })
  const assignProjectsMutation = useMutation({
    mutationFn: async ({ records, projectId }: { records: LiteratureStagingRecord[]; projectId: string }) => {
      const settled = await Promise.allSettled(records.map((record) => api.literature.staging.save(stagingProjectUpdate(record, projectId))))
      const failed = settled.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
      if (failed.length > 0) throw new Error(`${failed.length} 条文献分配失败，其他记录已保留`)
      return settled.length
    },
    onSuccess: async (count) => { setFeedback(`已批量分配 ${count} 条待分类文献`); setFeedbackError(null); setSelectedIds(new Set()); await queryClient.invalidateQueries({ queryKey: ['literature-staging'] }) },
    onError: (error) => { setFeedback(null); setFeedbackError(error); void queryClient.invalidateQueries({ queryKey: ['literature-staging'] }) }
  })
  const stagedByFingerprint = useMemo(() => new Set((stagingQuery.data?.items ?? []).map((record) => record.fingerprint)), [stagingQuery.data?.items])
  const failedByFingerprint = useMemo(() => new Set(retryableStaging.map((record) => record.fingerprint)), [retryableStaging])
  // Keep the year filter populated with every page already fetched, rather
  // than replacing its options when the user advances to another page.
  const availableYears = useMemo(() => {
    const loaded = Object.values(resultCache)
    const allLoaded = loaded.length === 0 ? results : [...loaded, ...results]
    return [...new Set(allLoaded.flatMap((result) => result.year === null || result.year === undefined ? [] : [result.year]))].sort((left, right) => right - left)
  }, [resultCache, results])
  const sortedResults = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase()
    const filtered = results.filter((result) => {
      const matchesText = !needle || `${result.title} ${result.authors.join(' ')} ${result.venue}`.toLocaleLowerCase().includes(needle)
      const matchesYear = yearFilter === 'all' || (yearFilter === 'unknown' ? result.year === null || result.year === undefined : String(result.year) === yearFilter)
      return matchesText && matchesYear
    })
    return [...filtered].sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'year-asc' ? compareYear(a.year, b.year, false) : sort === 'year-desc' ? compareYear(a.year, b.year, true) : sort === 'impact-asc' ? compareImpactFactor(a.impactFactor, b.impactFactor, false) : sort === 'impact-desc' ? compareImpactFactor(a.impactFactor, b.impactFactor, true) : sort === 'metric-asc' ? compareOpenMetric(a.openMetric, b.openMetric, false) : sort === 'metric-desc' ? compareOpenMetric(a.openMetric, b.openMetric, true) : 0)
  }, [filter, results, sort, yearFilter])
  const visibleResults = sortedResults
  const selectedResults = useMemo(() => Object.values(resultCache).filter((result) => selectedIds.has(result.id)), [resultCache, selectedIds]); const selectedStaging = stagedItems.filter((record) => selectedIds.has(record.id))
  const previewSelected = async (items: SearchResult[]) => {
    if (items.length === 0) return
    try {
      const records = await Promise.all(items.map((result) => ensureStaging(result)))
      await queryClient.invalidateQueries({ queryKey: ['literature-staging'] })
      previewMutation.mutate(records)
    } catch (error) {
      setFeedback(null)
      setFeedbackError(error)
    }
  }
  const plusAction = (result: SearchResult) => {
    if (zoteroProfile) void previewSelected([result])
    else stageMutation.mutate(result)
  }
  const changeSort = (next: ResultSort) => {
    setSort(next)
    if (!query.trim() || searchMutation.isPending || pageMutation.isPending) return
    setResults([])
    setResultCache({})
    setTotalResults(0)
    setHasMorePages(false)
    setCurrentPage(1)
    searchMutation.mutate(next)
  }
  const restoreSession = async (session: SearchSession) => {
    try {
      const pageData = await api.literature.resultsPage({ sessionId: session.id, page: { limit: pageSize } })
      setActiveSessionId(session.id)
      setQuery(session.query)
      setSource(session.source)
      pageCursors.current = { 1: null, 2: pageData.nextCursor }
      setHasMorePages(pageData.nextCursor !== null)
      setCurrentPage(1)
      setResults(pageData.items)
      setResultCache(Object.fromEntries(pageData.items.map((item) => [item.id, item])))
      setTotalResults(pageData.total)
      setSelectedResult(pageData.items[0] ?? null)
      setSelectedIds(new Set())
      setFeedback(`已恢复检索“${session.query}”，${pageData.items.length} 条结果`)
      setFeedbackError(null)
    } catch (error) {
      setFeedback(null)
      setFeedbackError(error)
    }
  }
  const resizeInspector = (ratio: number) => setInspectorRatio(Math.min(40, Math.max(16, ratio)))
  const literatureLayoutStyle = { '--literature-inspector-ratio': inspectorOpen ? `${inspectorRatio}%` : '3rem' } as React.CSSProperties

  return <div className="page-scroll literature-page">
    <header className="literature-target-toolbar">
      <div className="literature-target-toolbar-main">
        <div className="literature-target-nav" aria-label="检索导航">
          <Button aria-label="返回上一页" onClick={() => window.history.back()} size="icon" variant="ghost"><ChevronLeft aria-hidden="true" className="size-4" /></Button>
          <Button aria-label="前进到下一页" onClick={() => window.history.forward()} size="icon" variant="ghost"><ChevronRight aria-hidden="true" className="size-4" /></Button>
        </div>
        <form className="literature-target-query" onSubmit={(event) => { event.preventDefault(); if (query.trim()) searchMutation.mutate() }}>
          <Search aria-hidden="true" className="literature-target-query-icon" />
          <Input aria-label="文献关键词" className="literature-target-query-input" onChange={(event) => setQuery(event.target.value)} placeholder="输入关键词、DOI、标题或作者" value={query} />
          <Button disabled={!query.trim()} loading={searchMutation.isPending} type="submit" variant="primary"><Search aria-hidden="true" className="size-3.5" />检索</Button>
        </form>
        <select aria-label="检索来源" className="select-control literature-target-source" onChange={(event) => setSource(event.target.value as SearchSourceId)} value={source}>{sources.map((item) => <option key={item} value={item}>{item === 'all' ? '学术搜索（全部免费来源）' : sourceLabels[item]}</option>)}</select>
        <Button aria-label="打开高级检索选项" className="literature-advanced-button" onClick={() => document.getElementById('literature-filter-row')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })} variant="secondary"><span aria-hidden="true">☷</span>高级检索</Button>
      </div>
      <div className="literature-target-toolbar-actions">
        <details className="literature-history"><summary aria-label="查看检索历史" className="literature-toolbar-text-button">检索历史</summary><div className="literature-history-content"><strong>最近检索</strong>{(sessionsQuery.data ?? []).slice(0, 8).map((session) => <button key={session.id} onClick={() => { void restoreSession(session) }} type="button"><span>{session.query}</span><small>{session.resultCount} 条 · {new Date(session.createdAt).toLocaleString()}</small></button>)}{(sessionsQuery.data ?? []).length === 0 ? <span className="literature-history-empty">暂无检索历史</span> : null}</div></details>
        <button aria-label="查看文献检索帮助" className="literature-toolbar-icon-button" onClick={() => setFeedback('输入关键词、DOI、标题或作者后点击“检索”；结果可排序、筛选并分配到项目。')} type="button">?</button>
      </div>
    </header>
    <section className="literature-target-heading">
      <div className="literature-target-heading-copy">
        <p className="instrument-label">SEARCH / FREE SOURCES</p>
        <h1>联网检索</h1>
        <p>从全球学术资源中检索文献，支持多数据库、智能筛选与一键导入</p>
      </div>
      <div aria-label="文献工作区" className="literature-mode-switch" role="tablist">
        <button aria-selected={tab === 'search'} className={tab === 'search' ? 'literature-mode-button literature-mode-button-active' : 'literature-mode-button'} onClick={() => setTab('search')} role="tab" type="button">检索 <span>{totalResults || results.length}</span></button>
        <button aria-selected={tab === 'staging'} className={tab === 'staging' ? 'literature-mode-button literature-mode-button-active' : 'literature-mode-button'} onClick={() => setTab('staging')} role="tab" type="button">待分类 <span>{stagedItems.length}</span></button>
      </div>
    </section>
    <div className="literature-feedback"><MutationFeedback error={feedbackError} success={feedback ?? undefined} /></div>
    {tab === 'search' ? <>
      <section aria-label="检索筛选" className="literature-target-filter-row" id="literature-filter-row">
        <label className="literature-filter-field"><span>检索范围</span><select aria-label="检索范围" className="select-control" onChange={(event) => setSource(event.target.value as SearchSourceId)} value={source}>{sources.map((item) => <option key={item} value={item}>{item === 'all' ? '全部结果' : sourceLabels[item]}</option>)}</select></label>
        <label className="literature-filter-field"><span>初始显示</span><select aria-label="每页数量" className="select-control" onChange={(event) => { setPageSize(Number(event.target.value)); setCurrentPage(1); setResults([]); setResultCache({}); setTotalResults(0); setHasMorePages(false); pageCursors.current = {} }} value={pageSize}><option value={10}>10</option><option value={20}>20</option><option value={50}>50</option></select></label>
        <label className="literature-filter-field"><span>年份</span><select aria-label="按年份筛选" className="select-control" onChange={(event) => setYearFilter(event.target.value)} value={yearFilter}><option value="all">不限年份</option>{availableYears.map((year) => <option key={year} value={year}>{year}</option>)}<option value="unknown">年份未知</option></select></label>
        <label className="literature-filter-field literature-filter-field-wide literature-optional-filter"><span>筛选当前结果</span><Input aria-label="筛选当前结果" onChange={(event) => setFilter(event.target.value)} placeholder="标题、作者或期刊" value={filter} /></label>
        <label className="literature-filter-field"><span>排序</span><select aria-label="结果排序" className="select-control" onChange={(event) => changeSort(event.target.value as ResultSort)} value={sort}><option value="relevance">相关性</option><option value="year-desc">年份最新</option><option value="year-asc">年份最早</option><option value="impact-desc">影响因子最高</option><option value="impact-asc">影响因子最低</option><option value="metric-desc">引用指标最高</option><option value="metric-asc">引用指标最低</option><option value="title">标题</option></select></label>
        <label className="literature-filter-field literature-optional-filter"><span>导入项目</span><select aria-label="导入项目" className="select-control" onChange={(event) => setProjectId(event.target.value)} value={projectId}><option value="">不绑定项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <details className="literature-more-filters"><summary>更多筛选</summary><div className="literature-more-filters-content"><label>筛选当前结果<Input aria-label="筛选当前结果" className="input-control h-8 text-xs" onChange={(event) => setFilter(event.target.value)} placeholder="标题、作者或期刊" value={filter} /></label><label>导入项目<select aria-label="导入项目" className="select-control h-8 text-xs" onChange={(event) => setProjectId(event.target.value)} value={projectId}><option value="">不绑定项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label>Zotero 附加标签<input aria-label="Zotero 附加标签" className="input-control h-8 text-xs" onChange={(event) => setZoteroTags(event.target.value)} placeholder="#方法学, #重点" value={zoteroTags} /></label><span>项目标签会自动使用所选项目名称；未绑定项目使用 #未分类。</span></div></details>
      </section>
      <div className={inspectorOpen ? 'literature-search-layout mt-4 grid items-start gap-4' : 'literature-search-layout literature-inspector-collapsed mt-4 grid items-start gap-4'} ref={literatureLayoutRef} style={literatureLayoutStyle}>
        <ResearchPanel className="literature-search-panel" eyebrow="SEARCH / FREE SOURCES" title="联网检索">
          <p className="literature-search-panel-note">使用上方搜索栏并行检索 Crossref、OpenAlex、PubMed、arXiv、Semantic Scholar 和 scholarly；结果可排序、筛选并分配到项目。</p>
        </ResearchPanel>
        <ResearchPanel className="literature-results-panel" action={<div className="literature-results-actions flex flex-nowrap items-center gap-2">
          <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><input aria-label="全选当前页" checked={visibleResults.length > 0 && visibleResults.every((result) => selectedIds.has(result.id))} className="research-checkbox" onChange={(event) => setSelectedIds((current) => { const next = new Set(current); for (const result of visibleResults) event.target.checked ? next.add(result.id) : next.delete(result.id); return next })} type="checkbox" />全选</label>
          <select aria-label="Zotero Collection" className="select-control literature-collection-select" disabled={!zoteroProfile || collectionsQuery.isLoading} onChange={(event) => setCollectionKey(event.target.value || null)} value={collectionKey ?? ''}><option value="">Zotero 默认 Collection</option>{collections.map((collection: ZoteroCollection) => <option key={collection.key} value={collection.key}>{collection.name}</option>)}</select>
          <select aria-label="Zotero 导出格式" className="select-control literature-format-select" onChange={(event) => { setZoteroFormat(event.target.value as ZoteroExportFormat); setZoteroPreview(null); setZoteroHandoff(null) }} value={zoteroFormat}><option value="bibtex">Better BibTeX</option><option value="ris">RIS</option></select>
          <Button disabled={selectedResults.length === 0 || batchStageMutation.isPending} loading={batchStageMutation.isPending} onClick={() => batchStageMutation.mutate(selectedResults)} size="sm"><Plus aria-hidden="true" className="size-3.5" />批量暂存</Button>
          <Button disabled={selectedResults.length === 0 || queueMutation.isPending} loading={queueMutation.isPending} onClick={() => queueMutation.mutate(selectedResults)} size="sm"><BookOpen aria-hidden="true" className="size-3.5" />加入待读</Button>
          <Button disabled={selectedResults.length === 0 || previewMutation.isPending} loading={previewMutation.isPending} onClick={() => void previewSelected(selectedResults)} size="sm" variant="primary">预览导入 Zotero</Button>
        </div>} eyebrow={`RESULTS / ${pageSize} PER PAGE`} title={`检索结果${visibleResults.length ? ` · ${visibleResults.length}` : ''}`}>
          {searchMutation.isPending || pageMutation.isPending || restoredResultsQuery.isLoading ? <LoadingState label="正在读取联网检索结果…" /> : null}
          {searchMutation.error && results.length === 0 ? <ErrorState error={searchMutation.error} onRetry={() => searchMutation.mutate()} /> : null}
          {!searchMutation.isPending && !restoredResultsQuery.isLoading && visibleResults.length === 0 ? <EmptyState description="输入关键词后检索 Crossref、OpenAlex、PubMed、arXiv、Semantic Scholar 和 scholarly。" title="暂无检索结果" /> : null}
          <div className="literature-results-list divide-y divide-border">{visibleResults.map((result, index) => <SearchResultRow index={index + 1} inspected={selectedResult?.id === result.id} key={`${result.source}:${result.sourceId}`} onContextMenu={(event) => { event.preventDefault(); setContextMenu({ x: event.clientX, y: event.clientY, ids: [result.id] }) }} onInspect={() => { setSelectedResult(result); setInspectorOpen(true) }} onQueue={() => queueMutation.mutate([result])} onSelect={(checked) => setSelectedIds((current) => { const next = new Set(current); checked ? next.add(result.id) : next.delete(result.id); return next })} onStage={() => plusAction(result)} failed={failedByFingerprint.has(result.fingerprint)} result={result} zoteroProfile={Boolean(zoteroProfile)} selected={selectedIds.has(result.id)} staged={stagedByFingerprint.has(result.fingerprint)} />)}</div>
          <SearchPagination currentPage={currentPage} onPageChange={goToPage} pageSize={pageSize} pending={searchMutation.isPending || pageMutation.isPending} totalPages={totalPages} totalResults={totalResults} hasMore={hasMorePages} />
        </ResearchPanel>
        <Inspector containerRef={literatureLayoutRef} executePending={executeMutation.isPending} failed={selectedResult ? failedByFingerprint.has(selectedResult.fingerprint) : false} onCancelPreview={() => setZoteroPreview(null)} onExecutePreview={executePreview} onResize={resizeInspector} onToggle={() => setInspectorOpen((current) => !current)} open={inspectorOpen} ratio={inspectorRatio} preview={zoteroPreview} result={selectedResult} staged={selectedResult ? stagedByFingerprint.has(selectedResult.fingerprint) : false} targetCollection={collectionKey} />
      </div>
    </> : <div className="mt-4 grid gap-4">
      <ResearchPanel action={<div className="flex flex-wrap items-center gap-2">
        <select aria-label="按项目筛选待分类文献" className="select-control max-w-48" onChange={(event) => setStagingProjectFilter(event.target.value === "__unassigned__" ? null : event.target.value || undefined)} value={stagingProjectFilter === null ? "__unassigned__" : stagingProjectFilter ?? ""}><option value="">全部项目</option><option value="__unassigned__">未分配项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
        <select aria-label="将选中文献分配到项目" className="select-control max-w-48" disabled={selectedStaging.length === 0 || assignProjectsMutation.isPending} onChange={(event) => { const target = event.target.value === '__unassigned__' ? '' : event.target.value; assignProjectsMutation.mutate({ records: selectedStaging, projectId: target }) }} defaultValue="__placeholder__"><option value="__placeholder__" disabled>批量分配到…</option><option value="__unassigned__">未分类</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
        <Button disabled={selectedStaging.length === 0 || deleteMutation.isPending} loading={deleteMutation.isPending} onClick={() => deleteMutation.mutate(selectedStaging)} size="sm" variant="danger"><Trash2 aria-hidden="true" className="size-3.5" />删除选中</Button>
        <Button disabled={selectedStaging.length === 0 || previewMutation.isPending} loading={previewMutation.isPending} onClick={() => previewMutation.mutate(selectedStaging)} size="sm" variant="primary">预览导入 Zotero</Button>
      </div>} eyebrow="STAGING / PERSISTENT" title="待分类文献">
        {stagingQuery.isLoading ? <LoadingState label="正在读取待分类文献…" /> : null}
        {stagingQuery.error ? <ErrorState error={stagingQuery.error} onRetry={() => void stagingQuery.refetch()} /> : null}
        {!stagingQuery.isLoading && !stagingQuery.error && stagedItems.length === 0 ? <EmptyState description="在检索结果中点击“加入待分类”后，文献会持久保存在这里，并可分配或移动到任意项目。" title="待分类为空" /> : null}
        <div className="divide-y divide-border">{stagedItems.map((record, index) => <div className="paper-row literature-staging-row" key={record.id}>
          <span aria-hidden="true" className="literature-result-number">{index + 1}</span>
          <label className="grid size-8 shrink-0 cursor-pointer place-items-center"><span className="sr-only">选择待分类文献</span><input aria-label={`选择待分类文献：${record.title}`} checked={selectedIds.has(record.id)} className="research-checkbox" onChange={(event) => setSelectedIds((current) => { const next = new Set(current); event.target.checked ? next.add(record.id) : next.delete(record.id); return next })} type="checkbox" /></label>
          <div className="min-w-0 flex-1"><h3 className="overflow-wrap-anywhere text-sm font-semibold text-foreground">{record.title}</h3><p className="mt-1 truncate text-xs text-muted-foreground">{record.authors.join(', ') || '作者未知'} · {record.venue || sourceLabels[record.source]} · {record.year ?? '年份未知'}</p><span className="literature-project-badge">{record.projectId ? projects.find((project) => project.id === record.projectId)?.name ?? '已分配项目' : '未分类'}</span></div>
          <select aria-label={`为 ${record.title} 分配项目`} className="select-control max-w-48" disabled={assignProjectMutation.isPending} onChange={(event) => assignProjectMutation.mutate({ record, projectId: event.target.value })} value={record.projectId ?? ""}><option value="">未分类</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
          {zoteroProfile ? <Button aria-label={`重新预览导入 Zotero：${record.title}`} disabled={previewMutation.isPending} onClick={() => previewMutation.mutate([record])} size="icon" variant="ghost"><RefreshCw aria-hidden="true" className="size-3.5" /></Button> : null}
          <Button aria-label={`删除 ${record.title}`} onClick={() => deleteMutation.mutate([record])} size="icon" variant="ghost"><X aria-hidden="true" className="size-4" /></Button>
        </div>)}</div>
      </ResearchPanel>
    </div>}
    {tab === 'staging' && zoteroPreview ? <ResearchPanel className="mt-4" action={<div className="flex gap-2"><Button onClick={() => setZoteroPreview(null)} size="sm">取消</Button><Button disabled={executeMutation.isPending} loading={executeMutation.isPending} onClick={executePreview} size="sm" variant="primary">明确确认并写入</Button></div>} eyebrow="ZOTERO / CONFIRMATION" title={`导入预览 · ${zoteroPreview.total} 条`}><div className="p-4 text-xs text-muted-foreground"><p>目标：{zoteroProfile?.name ?? '未配置 Zotero'} · Collection：{collectionKey ?? '默认'} · capability：{zoteroPreview.capability} · transport：{zoteroPreview.transport}</p><p className="mt-2">这是一次性 API 写入预览。只有点击明确确认后才会调用 Zotero；失败项会逐条返回并保留“重新导入”入口。{zoteroPreview.capability !== 'write' ? ' 当前连接没有写入权限，确认后将逐条显示失败；完成授权后可再次导入。' : ''}</p></div></ResearchPanel> : null}
    {zoteroHandoff ? <ResearchPanel className="mt-4" eyebrow="ZOTERO / IMPORT PACKAGE" title="待下载的导入包"><div className="flex flex-wrap items-center gap-2 p-4 text-xs"><span className="min-w-0 flex-1 text-amber-800 dark:text-amber-200">Zotero 当前为只读，已生成 {zoteroHandoff.itemCount} 条 {zoteroHandoff.format.toUpperCase()} 元数据；目标 Collection：{zoteroHandoff.targetCollectionKey ?? '默认'}。下载后在 Zotero 中选择“导入”，不会伪称已写入。</span><Button aria-label="下载文献 Zotero 导入包" onClick={() => { void downloadZoteroHandoff(zoteroHandoff).then((fileName) => setFeedback(`已保存到 Downloads：${fileName}`)).catch((error) => { setFeedback(null); setFeedbackError(error) }) }} size="sm" variant="secondary"><Download aria-hidden="true" className="size-3.5" />下载导入包</Button></div></ResearchPanel> : null}
    {zoteroReceipts.length > 0 ? <ResearchPanel className="mt-4" eyebrow="ZOTERO / RECEIPTS" title="逐条写入回执"><div className="divide-y divide-border">{zoteroReceipts.map((receipt) => { const status = receipt.outcome === 'written' ? '已写入' : receipt.outcome === 'generated' ? '已生成文件（未写入）' : receipt.outcome === 'failed' ? '写入失败' : receipt.outcome === 'unsupported' ? '不支持' : '已跳过'; const retryRecord = retryableStaging.find((record) => record.id === receipt.stagingId); return <div className="flex items-center gap-3 px-4 py-3 text-xs" key={receipt.stagingId}><span className="min-w-0 flex-1 font-medium text-foreground">{receiptTitles[receipt.stagingId] ?? receipt.stagingId}</span><span className={receipt.outcome === 'failed' || receipt.outcome === 'unsupported' ? 'text-danger' : 'text-muted-foreground'}>{status}</span>{receipt.error ? <span className="max-w-[30rem] truncate text-muted-foreground">{receipt.error.message}</span> : null}{retryRecord ? <Button aria-label={`再次导入 ${retryRecord.title}`} disabled={previewMutation.isPending} onClick={() => previewMutation.mutate([retryRecord])} size="sm" variant="danger"><RefreshCw aria-hidden="true" className="size-3.5" />再次导入</Button> : null}</div> })}</div></ResearchPanel> : null}
    {retryableStaging.length > 0 ? <ResearchPanel className="mt-4" eyebrow="ZOTERO / RETRY" title={`失败项 · ${retryableStaging.length} 条`}><div className="flex flex-wrap items-center gap-2 p-4 text-xs"><span className="min-w-0 flex-1 text-muted-foreground">以下文献未成功写入，可在修复 Zotero 连接后重新生成预览并再次写入。</span><Button disabled={previewMutation.isPending} loading={previewMutation.isPending} onClick={() => previewMutation.mutate(retryableStaging)} size="sm" variant="primary">重试失败项</Button></div><div className="divide-y divide-border">{retryableStaging.map((record) => <div className="flex items-center gap-3 px-4 py-3 text-xs" key={record.id}><span className="min-w-0 flex-1 font-medium text-foreground">{record.title}</span><span className="text-danger">写入失败</span><Button disabled={previewMutation.isPending} onClick={() => previewMutation.mutate([record])} size="sm" variant="danger"><RefreshCw aria-hidden="true" className="size-3.5" />重新导入</Button></div>)}</div></ResearchPanel> : null}
    {contextMenu ? <div className="fixed z-50 min-w-48 rounded-md border border-border bg-surface p-1 shadow-lg" onClick={(event) => event.stopPropagation()} style={{ left: contextMenu.x, top: contextMenu.y }}><button className="flex min-h-8 w-full items-center gap-2 rounded px-2.5 text-left text-xs hover:bg-muted" onClick={() => { const items = results.filter((result) => contextMenu.ids.includes(result.id)); batchStageMutation.mutate(items); setContextMenu(null) }} type="button"><Plus aria-hidden="true" className="size-3.5" />加入待分类</button><button className="flex min-h-8 w-full items-center gap-2 rounded px-2.5 text-left text-xs hover:bg-muted" onClick={() => { const items = results.filter((result) => contextMenu.ids.includes(result.id)); void previewSelected(items); setContextMenu(null) }} type="button"><ExternalLink aria-hidden="true" className="size-3.5" />预览导入 Zotero</button></div> : null}
  </div>
}
