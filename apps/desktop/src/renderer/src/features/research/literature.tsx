import { BookOpen, ChevronLeft, ChevronRight, CircleHelp, Download, ExternalLink, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
  ZoteroHandoff,
} from '@prw/contracts'
import { ProjectIdSchema } from '@prw/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Dialog, DialogContent, DialogTrigger, Input } from '../../components/ui'
import { ExternalUrlLink } from '../../components/external-link'
import { SelectionBar } from '../../components/selection'
import { PaneResizeSeparator, usePaneResizeEnabled, usePaneWidth } from '../../components/resizable-pane'
import { doiExternalUrl, externalUrlFieldLabel, resolveExternalUrl, type ExternalOpenOutcome } from '../../lib/external-url'
import { EmptyState, ErrorState, LoadingState } from '../../components/states'
import { getWorkbenchApi } from '../../lib/workbench'
import { resolveRecentProjectId, useDefaultProjectId } from '../../lib/recent-project'
import { type ZoteroWritePlan, authorizationGrantNotice, collectionDisplayLabel, collectionWriteLabel, confirmLabels, frozenWriteValues, permissionEntryBrief, permissionEntryDiagnosis, permissionEntryHeadline, permissionEntryLabels, permissionRequestFailureMessage, pendingProjectTagLabel, prepareLabels, projectTagLabel, requestPermissionLabels, resultActionLabel, type ZoteroPermissionEntry, writeBlockedExplanation, writeStatusLabel, zoteroPermissionEntry, zoteroWritePlan } from '../../lib/zotero-write'
import { getErrorMessage } from '../../lib/utils'
import { queryKeys, useIntegrationsQuery, useLiteratureStagingQuery, useSearchSessionsQuery, useZoteroCapabilityQuery } from '../queries'
import { MutationFeedback, ResearchPanel } from './shared'

const sourceLabels: Record<SearchSourceId, string> = {
  all: '全部免费来源', local: '本地索引', crossref: 'Crossref', openalex: 'OpenAlex', pubmed: 'PubMed', arxiv: 'arXiv', semantic_scholar: 'Semantic Scholar', google_scholar: 'Google Scholar（scholarly）'
}

/** Bounds of the 文献检索 results/Inspector split. The width is a percentage of
 * the split container, and the same numbers are published as aria-valuemin/max
 * so the keyboard contract and the clamp cannot drift apart. */
const INSPECTOR_MIN_RATIO = 16
const INSPECTOR_MAX_RATIO = 40
const INSPECTOR_DEFAULT_RATIO = 17
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

/** `undefined` keeps the records' own project bindings, `null` is an explicit
 * 未分类 classification and a project id freezes that project for the write. */
type ZoteroWriteProject = string | null | undefined

/** The RPC payload keeps the three-state classification (omit / 未分类 / project)
 * while the wire contract carries a branded project id. */
function writeProjectInput(projectId: ZoteroWriteProject): null | undefined | ReturnType<typeof ProjectIdSchema.parse> {
  if (projectId === undefined) return undefined
  if (projectId === null) return null
  return ProjectIdSchema.parse(projectId)
}

/**
 * The top-level project classification of one Zotero write.  Every value shown
 * by the *frozen* variant comes from the preview/receipt, never from the live
 * UI selection; the `pending` variant is the deliberate choice the *next*
 * preview will freeze.
 */
function ZoteroProjectField({ projectId, tagText, tagValue, projects, onProjectChange, disabled, selectLabel = 'Zotero 写入顶层项目分类', tagHint, pending }: { projectId: ZoteroWriteProject; tagText: string; tagValue: string; projects: Project[]; onProjectChange: (projectId: ZoteroWriteProject) => void; disabled: boolean; selectLabel?: string; tagHint: string; pending?: boolean }): React.JSX.Element {
  return <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
    <label className="flex items-center gap-2"><span>顶层项目分类</span><select aria-label={selectLabel} className="select-control" disabled={disabled} onChange={(event) => { const value = event.target.value; onProjectChange(value === '__auto__' ? undefined : value === '__none__' ? null : value) }} value={projectId === undefined ? '__auto__' : projectId ?? '__none__'}><option value="__auto__">自动（按各条文献项目绑定）</option><option value="__none__">未分类</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
    <span className="research-tag" data-zotero-project-tag={tagValue}>{pending ? '将写入标签' : '写入标签'} {tagText}</span>
    <span className="w-full leading-5 text-muted-foreground">{tagHint}</span>
  </div>
}

/** Everything the (mandatory) permission entry needs to render one state. */
type ZoteroPermissionView = {
  entry: ZoteroPermissionEntry
  headline: string
  brief: string
  diagnosis: string
  pending: boolean
  failure: string | null
  onRequest: () => void
}

/**
 * The mandatory "request Zotero write permission" entry.
 *
 * It renders at every literature write entry point and in every profile state:
 * a pending or failed probe, an empty result list and a missing preview never
 * remove it.  Only an already-probed write connection (nothing to request) and
 * a missing connection (nothing to target) replace the action with a stated
 * diagnosis, and Zotero 9 — which can never authorize because it returns no
 * `Zotero-Server-ID` — shows `无法授权（查看说明）` instead of faking a grant.
 */
function ZoteroWritePermissionEntry({ view, className }: { view: ZoteroPermissionView; className?: string }): React.JSX.Element {
  const [explanationOpen, setExplanationOpen] = useState(false)
  const showExplanation = view.entry === 'explain' && explanationOpen
  return <div className={className ?? 'mt-2'} data-zotero-permission-entry={view.entry}>
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="font-semibold text-foreground">{view.headline}</span>
      {view.entry === 'request' ? <Button aria-label={requestPermissionLabels.action} disabled={view.pending} loading={view.pending} onClick={view.onRequest} size="sm" variant="secondary">{view.pending ? requestPermissionLabels.pending : requestPermissionLabels.action}</Button> : null}
      {view.entry === 'explain' ? <><Button aria-label={requestPermissionLabels.action} disabled title="当前 Zotero 版本不支持写入授权" size="sm" variant="secondary">{requestPermissionLabels.action}</Button><Button aria-expanded={explanationOpen} aria-label={permissionEntryLabels.explainAction} onClick={() => setExplanationOpen((current) => !current)} size="sm" variant="secondary">{explanationOpen ? permissionEntryLabels.explainCollapse : permissionEntryLabels.explainAction}</Button></> : null}
      {view.entry === 'no-profile' ? <Button aria-label={requestPermissionLabels.action} disabled title="请先在设置中启用 Zotero 连接" size="sm" variant="secondary">{requestPermissionLabels.action}</Button> : null}
      {view.entry === 'granted' ? <Button aria-label={permissionEntryLabels.grantedTitle} disabled title={permissionEntryLabels.granted} size="sm" variant="secondary">{permissionEntryLabels.grantedTitle}</Button> : null}
    </div>
    <p className="mt-1 leading-5 text-muted-foreground">{view.brief}</p>
    {view.entry === 'request' ? <p className="mt-1 leading-5 text-muted-foreground">{requestPermissionLabels.help}</p> : null}
    {showExplanation ? <p className="mt-1 leading-5 write-blocked-note" role="status">{view.diagnosis}</p> : null}
    {view.failure !== null ? <p className="form-feedback form-feedback-error mt-1" role="alert">{view.failure}</p> : null}
  </div>
}

/**
 * The write hand-off block shared by the search-results and staging entries:
 * the probed write status, the mandatory permission entry and the top-level
 * project classification the *next* preview will freeze.
 */
function LiteratureWriteEntry({ permission, plan, writeBlockedNote, capabilityError, projects, writeProjectId, onProjectChange, disabled }: { permission: ZoteroPermissionView; plan: ZoteroWritePlan; writeBlockedNote: string; capabilityError: string | null; projects: Project[]; writeProjectId: ZoteroWriteProject; onProjectChange: (projectId: ZoteroWriteProject) => void; disabled: boolean }): React.JSX.Element {
  return <div className="literature-write-entry" data-zotero-write-entry>
    <p className={`literature-write-status ${plan === 'read-only' ? 'write-blocked-note' : 'text-muted-foreground'}`} data-zotero-write-plan={plan} role="status">{writeStatusLabel(plan)}{plan === 'read-only' ? `：${writeBlockedNote}` : ''}</p>
    {capabilityError !== null ? <p className="form-feedback form-feedback-error mt-1" role="alert">Zotero 写入能力探测失败：{capabilityError}</p> : null}
    <ZoteroWritePermissionEntry view={permission} />
    <ZoteroProjectField disabled={disabled} onProjectChange={onProjectChange} pending projects={projects} projectId={writeProjectId} selectLabel="下次写入的顶层项目分类" tagHint={`下次预览将冻结该分类；更改分类会丢弃当前预览，需要重新生成。`} tagText={pendingProjectTagLabel(writeProjectId, typeof writeProjectId === 'string' ? projects.find((project) => project.id === writeProjectId)?.name ?? null : null)} tagValue={writeProjectId ?? ''} />
  </div>
}

/** Label/value rows of the values a preview froze, shared by the Inspector and
 * the staging confirmation so both state the same frozen plan. */
function FrozenWriteValues({ values }: { values: readonly { label: string; value: string }[] }): React.JSX.Element {
  return <dl className="research-frozen-values mt-2 grid gap-1 text-xs">{values.map((entry) => <div className="flex flex-wrap gap-2" key={entry.label}><dt className="font-semibold text-foreground">{entry.label}</dt><dd className="min-w-0 flex-1 text-muted-foreground">{entry.value}</dd></div>)}</dl>
}

/** Page-level channel for a click that never reached the system browser, so
 * the reason stays discoverable next to the other literature feedback. */
function externalOutcomeError(outcome: ExternalOpenOutcome): Error | null {
  return outcome.ok ? null : new Error(outcome.message)
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

function LiteratureHelpDialog(): React.JSX.Element {
  return <Dialog>
    <DialogTrigger asChild><Button aria-label="文献检索帮助" size="icon" variant="ghost"><CircleHelp aria-hidden="true" className="size-4" /></Button></DialogTrigger>
    <DialogContent description="检索、待分类与 Zotero 写入的完整流程。" title="文献检索帮助">
      <div className="grid gap-3 text-xs leading-5 text-muted-foreground">
        <p><strong className="text-foreground">检索</strong>：输入关键词、DOI、标题或作者后点击“检索”。来源可切换为单个数据库；结果支持年份、影响因子和引用指标排序与筛选。</p>
        <p><strong className="text-foreground">结果操作</strong>：勾选后可批量暂存、加入待读或准备导入；单行右侧按钮对单篇文献执行同一操作。右键行可在光标位置打开同样两个操作。</p>
        <p><strong className="text-foreground">待分类</strong>：暂存的文献持久保存，可分配到项目；未绑定项目的文献会带上 <code>#未分类</code> 标签。</p>
        <p><strong className="text-foreground">Zotero 导入</strong>：流程固定为“探测能力 → 生成预览 → 明确确认 → 逐条回执”。预览会冻结目标 Collection、格式、标签和条目匹配；确认前不会发生任何外部写入。</p>
        <p><strong className="text-foreground">顶层项目分类</strong>：每次写入都带一个顶层项目分类，写入的 Zotero 标签会精确包含 <code># 项目名</code>（未绑定项目为 <code># 未分类</code>）。分类在写入预览时冻结并显示，确认面板可更改，更改后必须重新生成预览；回执会重复该分类。</p>
        <p><strong className="text-foreground">只读连接</strong>：当 Zotero 版本或授权不支持写入时，页面会明确标出只读并只提供“准备 RIS/BibTeX 导入包”，不会显示无效的写入按钮。缺少写入授权时可点击“请求 Zotero 写入权限”：请求经安全存储保存后仍会重新探测写入能力，未探测到之前不会写入。</p>
        <p><strong className="text-foreground">键盘</strong>：Esc 关闭本帮助并把焦点还给帮助按钮；对话框内 Tab 只在帮助内容中循环。结果详情面板可用左右方向键调整宽度。</p>
      </div>
    </DialogContent>
  </Dialog>
}

function SearchResultRow({ result, index, selected, inspected, staged, failed, zoteroProfile, plan, onSelect, onStage, onQueue, onInspect, onContextMenu, onExternalOutcome }: { result: SearchResult; index: number; selected: boolean; inspected: boolean; staged: boolean; failed: boolean; zoteroProfile: boolean; plan: ZoteroWritePlan; onSelect: (checked: boolean) => void; onStage: () => void; onQueue?: () => void; onInspect: () => void; onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void; onExternalOutcome: (outcome: ExternalOpenOutcome) => void }): React.JSX.Element {
  // The row action only prepares or re-opens a preview, so its wording follows
  // the frozen capability: a read-only connection never offers to "save".
  const actionState: 'ready' | 'staged' | 'failed' = failed ? 'failed' : staged ? 'staged' : 'ready'
  const actionLabel = zoteroProfile
    ? resultActionLabel(plan, actionState)
    : actionState === 'staged' ? '再次预览' : actionState === 'failed' ? '重新导入' : '加入待分类'
  // Acting before the capability probe resolves could freeze the wrong
  // transport (a writable Zotero downgraded to an import package).
  const actionDisabled = zoteroProfile && plan === 'checking'
  return <div className={`paper-row ${inspected ? 'paper-row-inspected' : ''} ${selected ? 'paper-row-active' : ''}`} onContextMenu={onContextMenu} role="article">
    <span aria-hidden="true" className="literature-result-number">{index}</span>
    <label className="grid size-8 shrink-0 cursor-pointer place-items-center" title="选择文献"><span className="sr-only">选择 {result.title}</span><input aria-label={`选择文献：${result.title}`} checked={selected} className="research-checkbox" onChange={(event) => onSelect(event.target.checked)} onClick={(event) => event.stopPropagation()} type="checkbox" /></label>
    <button aria-label={`${result.title} ${metadataLine(result)}`} className="min-w-0 flex-1 cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onInspect} type="button"><h3 className="overflow-wrap-anywhere text-sm font-semibold text-foreground">{result.title}</h3><p className="literature-result-meta"><span>{result.authors.length > 0 ? result.authors.slice(0, 3).join(', ') : '作者未知'}</span><span aria-hidden="true">·</span><span>{result.venue || sourceLabels[result.source]}</span><span aria-hidden="true">·</span><span>{result.year ?? '年份未知'}</span>{result.openMetric !== null && result.openMetric !== undefined ? <span className="literature-open-metric-badge">引用 {result.openMetric}</span> : null}</p>{result.abstract ? <p className="literature-result-abstract">{result.abstract}</p> : null}</button>
    <div className="literature-paper-actions">{result.impactFactor !== null && result.impactFactor !== undefined ? <span className="literature-impact-badge" title={`${result.impactFactorSource ?? '公开来源'}${result.impactFactorFetchedAt ? ` · ${new Date(result.impactFactorFetchedAt).toLocaleString()}` : ''}`}>{result.impactFactorSource?.includes('IF 风格') ? 'IF*' : 'IF'} {result.impactFactor.toFixed(1)}</span> : <span className="literature-impact-badge literature-impact-missing" title="公开免费来源未提供可验证的期刊影响因子或 IF 风格指标">IF 未提供</span>}{failed ? <span className="literature-paper-failure">{plan === 'write' ? 'Zotero 写入失败' : 'Zotero 导入失败'}</span> : null}{result.url ? <ExternalUrlLink ariaLabel={`打开 ${result.title}`} className="literature-paper-link" fieldLabel="来源链接" href={result.url} iconMode label={result.title} linkClassName="literature-paper-icon-button" onOutcome={onExternalOutcome} /> : null}{onQueue ? <Button aria-label={`加入待读：${result.title}`} onClick={(event) => { event.stopPropagation(); onQueue() }} size="icon" variant="ghost"><BookOpen aria-hidden="true" className="size-3.5" /></Button> : null}<Button aria-label={`${actionLabel}：${result.title}`} disabled={actionDisabled} onClick={(event) => { event.stopPropagation(); onStage() }} size="sm" variant={failed ? 'danger' : 'secondary'}>{actionState === 'failed' || actionState === 'staged' ? <RefreshCw aria-hidden="true" className="size-3.5" /> : null}{actionLabel}</Button></div>
  </div>
}

function Inspector({ result, open, onToggle, preview, onCancelPreview, onExecutePreview, executePending, targetCollectionName, resizer, staged, failed, plan, writeBlockedNote, onExternalOutcome, projects, onProjectChange, permission }: { result: SearchResult | null; open: boolean; onToggle: () => void; preview: LiteratureStagingToZoteroPreview | null; onCancelPreview: () => void; onExecutePreview: () => void; executePending: boolean; targetCollectionName: string | null; resizer: ReactNode; staged: boolean; failed: boolean; plan: ZoteroWritePlan; writeBlockedNote: string; onExternalOutcome: (outcome: ExternalOpenOutcome) => void; projects: Project[]; onProjectChange: (projectId: ZoteroWriteProject) => void; permission: ZoteroPermissionView }): React.JSX.Element {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const previewId = preview?.previewId ?? null
  // The preview is the explicit hand-off point of the whole flow: move focus
  // onto the confirmation action and announce the frozen plan so the next
  // required step is never left to the user's memory.
  useEffect(() => {
    if (previewId !== null) confirmRef.current?.focus()
  }, [previewId])
  // The source link is resolved once per selected paper so the field name can
  // state what the target really is (a PDF file URL keeps its own label) and
  // an unsafe value is reported instead of rendered as a dead link.
  const sourceTarget = useMemo(() => resolveExternalUrl(result?.url), [result?.url])
  const doiTarget = useMemo(() => doiExternalUrl(result?.doi), [result?.doi])
  const awaitingPlan: ZoteroWritePlan = preview === null ? plan : preview.transport === 'api' ? 'write' : 'read-only'
  const reviewItems = preview?.items.filter((item) => item.decision === 'review') ?? []
  const matchedItems = preview?.items.filter((item) => item.decision === 'update-candidate') ?? []
  // The frozen plan is derived from the preview itself, so the confirmation
  // always names the values the execute call will re-check (target Collection,
  // classification, write scope and profile revision).
  const previewFrozenValues = preview === null ? [] : frozenWriteValues({
    transport: preview.transport,
    capability: preview.capability,
    total: preview.total,
    targetCollectionKey: preview.targetCollectionKey,
    targetCollectionName: targetCollectionName,
    projectTag: preview.projectTag,
    profileRevision: preview.profileRevision,
    updateCandidates: matchedItems.length,
    reviewItems: reviewItems.length
  })
  const announcement = preview === null
    ? ''
    : `已生成${awaitingPlan === 'write' ? ' Zotero 写入' : ' RIS/BibTeX'}预览，共 ${preview.total} 条${reviewItems.length > 0 ? `，其中 ${reviewItems.length} 条需复核并在确认时跳过` : ''}。等待确认${awaitingPlan === 'write' ? '写入 Zotero' : '生成导入包'}。`
  return <ResearchPanel className={`literature-inspector-panel ${open ? '' : 'literature-inspector-panel-collapsed'} xl:sticky xl:top-3`} action={<Button aria-label={open ? '折叠结果详情' : '展开结果详情'} onClick={onToggle} size="icon" variant="ghost">{open ? <ChevronRight aria-hidden="true" className="size-4" /> : <ChevronLeft aria-hidden="true" className="size-4" />}</Button>} eyebrow="INSPECTOR / PAPER" title="结果详情">
    {resizer}
    <div className="literature-inspector-scroll">
    {!open ? <p className="p-4 text-xs text-muted-foreground">详情已折叠。点击右上角展开。</p> : null}
    {open && !result ? <EmptyState description="从检索结果中选择一篇文献。" title="尚未选择结果" /> : null}
    {open && result ? <div className="literature-inspector-body"><div className="literature-inspector-tabs"><span className="literature-inspector-tab literature-inspector-tab-active">文献信息</span><button className="literature-inspector-tab" disabled title="笔记编辑器尚未实现">笔记（尚未实现）</button><button className="literature-inspector-tab" disabled title="相关文献推荐尚未实现">相关文献（尚未实现）</button></div><div className="literature-inspector-paper-head"><div aria-hidden="true" className="literature-inspector-thumb"><BookOpen className="size-5" /></div><div className="min-w-0"><h3 className="text-sm font-bold leading-5 text-foreground">{result.title}</h3><p className="mt-1 text-xs text-muted-foreground">{metadataLine(result)}</p><span className="literature-inspector-if">{result.impactFactor !== null && result.impactFactor !== undefined ? `${result.impactFactorSource?.includes('IF 风格') ? 'IF*' : 'IF'} ${result.impactFactor.toFixed(1)}` : 'IF 未提供'}</span></div></div><dl className="literature-inspector-fields"><div><dt>作者</dt><dd>{result.authors.join('、') || '作者未知'}</dd></div><div><dt>年份</dt><dd>{result.year ?? '未提供'}</dd></div><div><dt>期刊</dt><dd>{result.venue || '未提供'}</dd></div>{result.impactFactorSource ? <div><dt>影响因子来源</dt><dd>{result.impactFactorSource}</dd></div> : null}{result.impactFactorFetchedAt ? <div><dt>获取时间</dt><dd>{new Date(result.impactFactorFetchedAt).toLocaleString()}</dd></div> : null}<div><dt>公开引用指标</dt><dd>{result.openMetric ?? '未提供'}{result.openMetric !== null && result.openMetric !== undefined ? '（来源记录）' : ''}</dd></div></dl>{result.doi ? <div className="literature-inspector-doi"><span>DOI</span><ExternalUrlLink copyClassName="literature-inspector-copy" fieldLabel="DOI" label={result.doi} linkClassName="literature-inspector-doi-link" onOutcome={onExternalOutcome} target={doiTarget} /></div> : null}<div className={`literature-inspector-zotero-status ${failed ? 'literature-inspector-zotero-failed' : ''}`}><strong>Zotero 导入状态</strong><span>{failed ? '写入失败，可再次导入' : preview ? '待确认写入' : staged ? '已加入待分类' : '尚未写入'}</span>{failed ? <small>修复连接后可以再次导入此文献。</small> : null}</div><div><p className="literature-inspector-label">摘要</p><p className="literature-inspector-abstract">{result.abstract || '暂无摘要'}</p></div>{result.url ? <div><p className="literature-inspector-label">{externalUrlFieldLabel(sourceTarget, '来源链接')}</p><ExternalUrlLink fieldLabel={externalUrlFieldLabel(sourceTarget, '来源链接')} label={result.url} linkClassName="literature-inspector-url" onOutcome={onExternalOutcome} target={sourceTarget} /></div> : null}</div> : null}
    </div>
    <div className="literature-inspector-footer">
      <p aria-live="polite" className="sr-only" role="status">{announcement}</p>
      {preview === null ? <div className="text-xs"><p className="font-semibold text-foreground">实时导入预览</p><p className="mt-2 leading-5 text-muted-foreground">选择检索结果或批量勾选后，这里会显示目标 Collection、顶层项目分类、标签和逐条写入回执；未确认前不会触发 Zotero 外部写入。</p><p className={plan === 'read-only' ? 'mt-2 leading-5 write-blocked-note' : 'mt-2 leading-5 text-muted-foreground'}>{plan === 'checking' ? '正在探测 Zotero 写入能力…' : writeBlockedNote}</p><ZoteroWritePermissionEntry view={permission} /></div> : <div className="text-xs"><div className="flex items-center justify-between gap-2"><p className="font-semibold text-foreground">实时导入预览</p><span className="research-tag">{preview.total} 条</span></div><p className="mt-2 leading-5 text-muted-foreground">预览已冻结以下写入计划；确认前不会调用 Zotero，也不会产生任何外部写入。</p><FrozenWriteValues values={previewFrozenValues} /><ZoteroProjectField disabled={executePending} onProjectChange={onProjectChange} projectId={preview.projectId} projects={projects} selectLabel="Zotero 写入顶层项目分类" tagHint="更改分类会丢弃当前预览，需要重新生成；确认时使用预览冻结的分类。" tagText={projectTagLabel(preview.projectTag)} tagValue={preview.projectTag ?? ''} />{awaitingPlan === 'read-only' ? <p className="mt-2 leading-5 write-blocked-note" data-zotero-write-plan="read-only" role="status">{writeStatusLabel('read-only')}：{writeBlockedNote}</p> : null}{reviewItems.length > 0 ? <p className="mt-2 leading-5 write-blocked-note">{reviewItems.length} 条无法确认是否与 Zotero 中已有条目重复，确认后会跳过并保留重试入口。</p> : null}{matchedItems.length > 0 ? <p className="mt-2 leading-5 text-muted-foreground">{matchedItems.length} 条将更新 Zotero 中已匹配的条目：按条目 revision 校验，Zotero 侧在预览后发生的修改会返回版本冲突。</p> : null}<ZoteroWritePermissionEntry view={permission} /><div className="mt-3 flex gap-2"><Button onClick={onCancelPreview} size="sm">取消</Button><Button loading={executePending} onClick={onExecutePreview} ref={confirmRef} size="sm" variant="primary">{awaitingPlan === 'write' ? '确认并写入 Zotero' : '确认并生成 RIS/BibTeX 导入包'}</Button></div></div>}
    </div>
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
  // Top-level project classification of the next Zotero write.  `undefined`
  // keeps each record's own project binding, `null` is an explicit 未分类 and a
  // project id freezes that project for the confirmed write.
  const [writeProjectId, setWriteProjectId] = useState<ZoteroWriteProject>(undefined)
  const [permissionFailure, setPermissionFailure] = useState<string | null>(null)
  const sessionsQuery = useSearchSessionsQuery(); const stagingQuery = useLiteratureStagingQuery('', stagingProjectFilter); const profilesQuery = useIntegrationsQuery()
  // A disabled profile must not be treated as an import target.  Keeping the
  // lookup enabled-only makes the UI and the Core capability gate agree: when
  // Zotero is disabled, the result actions stay in staging mode and retry is
  // offered again as soon as the profile is enabled.
  const zoteroProfile = useMemo(() => (profilesQuery.data ?? []).find((profile) => profile.provider === 'zotero' && profile.enabled), [profilesQuery.data])
  // The frozen capability decides the wording of every Zotero action on this
  // page.  A read-only connection (for example Zotero 9, which returns no
  // Zotero-Server-ID) is labelled as an RIS/BibTeX package and never offered a
  // write, instead of showing a button that can only fail.
  const capabilityQuery = useZoteroCapabilityQuery(zoteroProfile?.id ?? null)
  const plan = zoteroWritePlan(capabilityQuery.isLoading, capabilityQuery.data?.capability.write)
  const writeBlockedNote = zoteroProfile === null
    ? '尚未配置可用的 Zotero 连接：请在“设置 → 工具连接”中启用 Zotero。当前只能生成 RIS/BibTeX 导入包。'
    : writeBlockedExplanation(capabilityQuery.data?.writeBlockedReason, capabilityQuery.data?.status)
  const [tab, setTab] = useState<LiteratureTab>('search'); const [query, setQuery] = useState(''); const [source, setSource] = useState<SearchSourceId>('all'); const [results, setResults] = useState<SearchResult[]>([]); const [resultCache, setResultCache] = useState<Record<string, SearchResult>>({}); const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set()); const [selectedResult, setSelectedResult] = useState<SearchResult | null>(null); const [inspectorOpen, setInspectorOpen] = useState(true); const [filter, setFilter] = useState(''); const [yearFilter, setYearFilter] = useState('all'); const [sort, setSort] = useState<ResultSort>('relevance'); const [pageSize, setPageSize] = useState(50); const [currentPage, setCurrentPage] = useState(1); const [totalResults, setTotalResults] = useState(0); const [hasMorePages, setHasMorePages] = useState(false); const [activeSessionId, setActiveSessionId] = useState<string | null>(null); const [feedback, setFeedback] = useState<string | null>(null); const [feedbackError, setFeedbackError] = useState<unknown>(null); const [contextMenu, setContextMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null); const [zoteroPreview, setZoteroPreview] = useState<LiteratureStagingToZoteroPreview | null>(null); const [zoteroHandoff, setZoteroHandoff] = useState<ZoteroHandoff | null>(null); const [activePreviewRecords, setActivePreviewRecords] = useState<LiteratureStagingRecord[]>([]); const [retryableStaging, setRetryableStaging] = useState<LiteratureStagingRecord[]>([]); const [zoteroReceipts, setZoteroReceipts] = useState<LiteratureStagingToZoteroResult['items']>([]); const [receiptTitles, setReceiptTitles] = useState<Record<string, string>>({}); const [collectionKey, setCollectionKey] = useState<string | null>(null); const pageCursors = useRef<Record<number, string | null>>({}); const literatureLayoutRef = useRef<HTMLDivElement>(null)
  // Inspector width as a percentage of the split container, persisted with the
  // repository's optional-storage convention and clamped to [16, 40].
  const inspectorPane = usePaneWidth({ storageKey: 'literature-inspector-ratio', defaultWidth: INSPECTOR_DEFAULT_RATIO, min: INSPECTOR_MIN_RATIO, max: INSPECTOR_MAX_RATIO })
  // The results/Inspector split only exists from 1051px up (see the literature
  // layout media queries); a stacked column must not offer a column splitter.
  const inspectorResizeEnabled = usePaneResizeEnabled('(min-width: 1051px)')
  const latest = useMemo(() => latestSession(sessionsQuery.data), [sessionsQuery.data])
  // Import/staging flows start on the most recently used project, while an
  // explicit 未分类 choice stays available and is remembered as such.
  const { chooseProjectId, projectId } = useDefaultProjectId(projects)
  const restoredResultsQuery = useQuery<SearchResultPage>({ queryKey: ['literature-results', latest?.id ?? 'none', pageSize], queryFn: () => api.literature.resultsPage({ sessionId: latest!.id, page: { limit: pageSize } }), enabled: Boolean(latest?.id) })
  const collectionsQuery = useQuery({ queryKey: queryKeys.zoteroCollections(zoteroProfile?.id ?? 'none'), queryFn: () => api.zotero.collectionsPage({ profileId: zoteroProfile!.id }), enabled: Boolean(zoteroProfile?.id) })
  const collections = collectionsQuery.data?.items ?? []
  /** Real Collection name of the frozen target; the stable key stays as
   * auxiliary information in every place the target is shown. */
  const collectionName = (key: string | null): string | null =>
    key === null ? null : collections.find((collection: ZoteroCollection) => collection.key === key)?.name ?? null
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
  const previewMutation = useMutation({ mutationFn: async (records: LiteratureStagingRecord[]) => { if (!zoteroProfile) throw new Error('请先在设置中配置并启用 Zotero'); return api.literature.stagingToZotero.preview({ profileId: zoteroProfile.id, stagingIds: records.map((record) => record.id), targetCollectionKey: collectionKey, format: zoteroFormat, projectId: writeProjectInput(writeProjectId), tags: parseTagInput(zoteroTags), transport: capabilityQuery.data?.capability.write === true ? 'api' : 'save-file' }) }, onMutate: (records) => { setActivePreviewRecords(records); setZoteroReceipts([]); setReceiptTitles({}); setZoteroHandoff(null) }, onSuccess: (preview) => { setZoteroPreview(preview); setFeedback(`${preview.transport === 'api' ? `Zotero 写入预览已生成 ${preview.total} 条；明确确认后才会写入` : `已生成 ${preview.total} 条 RIS/BibTeX 导入预览；明确确认后生成导入包，不会写入 Zotero`}（冻结的顶层项目分类：${projectTagLabel(preview.projectTag)}）`); setFeedbackError(null) }, onError: (error) => { setFeedback(null); setFeedbackError(error) } })
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
  /**
   * A changed top-level project classification is a different external write:
   * drop the frozen preview instead of silently re-freezing a new tag, so the
   * confirmed write is always the one that was shown.
   */
  function chooseWriteProject(projectId: ZoteroWriteProject): void {
    setWriteProjectId(projectId)
    setZoteroPreview(null)
    setZoteroReceipts([])
    setZoteroHandoff(null)
    setFeedback(projectId === undefined ? '已改为按各条文献的项目绑定写入；请重新生成预览。' : `已选择顶层项目分类：${projectTagLabel(projectId === null ? '未分类' : projects.find((project) => project.id === projectId)?.name ?? '未分类')}；请重新生成预览。`)
  }
  // The entry point only asks Main to store the Zotero write credential
  // through safeStorage; the capability probe decides what is reported, so a
  // granted request is never presented as a successful Zotero write.
  const permissionMutation = useMutation({
    mutationFn: async () => {
      if (!zoteroProfile) throw new Error('请先在“设置 → 工具连接”中启用 Zotero 连接。')
      return api.zotero.authorize({ profileId: zoteroProfile.id })
    },
    onSuccess: async (result) => {
      setFeedbackError(null)
      setPermissionFailure(null)
      try {
        const refreshed = await capabilityQuery.refetch()
        // Report what Zotero actually granted.  A one-time key ("Allow" instead
        // of "Always Allow") is destroyed by the first write that validates it,
        // so it must never be presented as a completed setup.
        setFeedback(authorizationGrantNotice(result.remember, '本机 safeStorage'))
        // The request is only reported as granted when the re-probe actually
        // found the write capability; otherwise the real reason is stated.
        if (refreshed.data?.capability.write !== true) setPermissionFailure(`${permissionEntryLabels.requestTitle}：授权请求已提交，但重新探测后仍未发现写入能力。${refreshed.error ? getErrorMessage(refreshed.error) : permissionEntryBrief('request', refreshed.data?.writeBlockedReason, refreshed.data?.status)}`)
      } catch (error) {
        setFeedback(null)
        setPermissionFailure(permissionRequestFailureMessage(error))
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.zoteroCapability(zoteroProfile?.id ?? 'none') })
    },
    onError: (error) => { const message = permissionRequestFailureMessage(error); setFeedback(null); setPermissionFailure(message); setFeedbackError(new Error(message)) }
  })
  /**
   * One permission entry for every literature write entry point of this page
   * (results panel, staging panel, Inspector, confirmation panel).  It is
   * derived from the probe only, so an empty result list, a pending probe or a
   * missing preview can never remove the request action.
   */
  const permissionReason = capabilityQuery.data?.writeBlockedReason ?? null
  const permissionStatus = capabilityQuery.data?.status
  const permissionEntry = zoteroPermissionEntry({ hasProfile: zoteroProfile !== null, canWrite: capabilityQuery.data?.capability.write, reason: permissionReason })
  const permissionView: ZoteroPermissionView = {
    entry: permissionEntry,
    headline: permissionEntryHeadline(permissionEntry),
    brief: permissionEntryBrief(permissionEntry, permissionReason, permissionStatus),
    diagnosis: permissionEntryDiagnosis(permissionEntry, permissionReason, permissionStatus),
    pending: permissionMutation.isPending,
    failure: permissionFailure,
    onRequest: () => permissionMutation.mutate()
  }
  const capabilityProbeError = capabilityQuery.isError ? getErrorMessage(capabilityQuery.error) : null
  /** Top-level Literature action: always re-read the local capability first;
   * authorize only when the fresh probe says the connection is readable but not
   * writable. Main owns the key and the authorize round-trip. */
  const requestOrProbeZotero = async (): Promise<void> => {
    if (!zoteroProfile) {
      setPermissionFailure('请先在“设置 → 工具连接”中启用 Zotero 连接。')
      return
    }
    setPermissionFailure(null)
    try {
      const refreshed = await capabilityQuery.refetch()
      if (refreshed.error) throw refreshed.error
      if (refreshed.data?.capability.write === true) {
        setFeedback('已重新探测：Zotero 写入能力已就绪。')
        return
      }
      if (refreshed.data?.writeBlockedReason === 'server-id-missing') {
        setPermissionFailure(permissionEntryDiagnosis('explain', refreshed.data.writeBlockedReason, refreshed.data.status))
        return
      }
      if (refreshed.data?.writeBlockedReason === 'rate-limited') {
        // Zotero limits /api/local/authorize to a handful of prompts per minute;
        // asking again would only burn the window the user has to click in.
        setPermissionFailure(permissionEntryDiagnosis('request', 'rate-limited', refreshed.data.status))
        return
      }
      await permissionMutation.mutateAsync()
    } catch (error) {
      setFeedback(null)
      setPermissionFailure(permissionRequestFailureMessage(error))
    }
  }
  // The confirmation panel restates the frozen plan of the pending preview so
  // the values the execute call re-checks are visible before the confirmation.
  const stagingFrozenValues = zoteroPreview === null ? [] : frozenWriteValues({
    transport: zoteroPreview.transport,
    capability: zoteroPreview.capability,
    total: zoteroPreview.total,
    targetCollectionKey: zoteroPreview.targetCollectionKey,
    targetCollectionName: collectionName(zoteroPreview.targetCollectionKey),
    projectTag: zoteroPreview.projectTag,
    profileRevision: zoteroPreview.profileRevision,
    updateCandidates: zoteroPreview.items.filter((item) => item.decision === 'update-candidate').length,
    reviewItems: zoteroPreview.items.filter((item) => item.decision === 'review').length
  })
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
  const recentStagingProjectId = resolveRecentProjectId(projects)
  const recentStagingProject = projects.find((project) => project.id === recentStagingProjectId) ?? null
  // Search results and staging rows share one id set, so every 清除选择 action
  // removes only the ids that belong to the surface the user is looking at.
  const clearSelectedIds = (scope: readonly { id: string }[]) => setSelectedIds((current) => {
    const next = new Set(current)
    for (const item of scope) next.delete(item.id)
    return next
  })
  const toggleVisibleSelection = (scope: readonly { id: string }[]) => setSelectedIds((current) => {
    const next = new Set(current)
    const allSelected = scope.length > 0 && scope.every((item) => current.has(item.id))
    for (const item of scope) {
      if (allSelected) next.delete(item.id)
      else next.add(item.id)
    }
    return next
  })
  const allVisibleResultsSelected = visibleResults.length > 0 && visibleResults.every((result) => selectedIds.has(result.id))
  const someVisibleResultsSelected = visibleResults.some((result) => selectedIds.has(result.id))
  const allStagingSelected = stagedItems.length > 0 && stagedItems.every((record) => selectedIds.has(record.id))
  const someStagingSelected = stagedItems.some((record) => selectedIds.has(record.id))
  const stagingFilterLabel = stagingProjectFilter === undefined ? '全部项目' : stagingProjectFilter === null ? '未分配项目' : projects.find((project) => project.id === stagingProjectFilter)?.name ?? '已失效项目'
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
    // Probe first: acting while the capability is unknown would freeze the
    // wrong transport and could downgrade a writable Zotero to a package.
    if (zoteroProfile && plan === 'checking') return
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
  // Every external link shares one outcome channel: a click that never reached
  // the system browser must be visible in the page feedback, not swallowed.
  const reportExternalOutcome = (outcome: ExternalOpenOutcome) => {
    const error = externalOutcomeError(outcome)
    if (error === null) { setFeedbackError(null); return }
    setFeedback(null)
    setFeedbackError(error)
  }
  const literatureLayoutStyle = { '--literature-inspector-ratio': inspectorOpen ? `${inspectorPane.width}%` : '3rem' } as React.CSSProperties
  // The splitter is owned by the Inspector panel, so it only exists while that
  // pane is expanded; on a stacked (single column) layout it stays in the DOM
  // as a disabled splitter instead of promising a split that cannot happen.
  const inspectorResizer = inspectorOpen
    ? <PaneResizeSeparator containerRef={literatureLayoutRef} defaultValue={INSPECTOR_DEFAULT_RATIO} disabled={!inspectorResizeEnabled} invert label="调整结果详情宽度（左右方向键调整，Home 最小，End 最大，双击恢复默认）" max={INSPECTOR_MAX_RATIO} min={INSPECTOR_MIN_RATIO} onReset={inspectorPane.resetWidth} onResize={inspectorPane.setWidth} style={{ left: 0 }} unit="percent" value={inspectorPane.width} />
    : null

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
        <Button aria-label={permissionEntry === 'granted' ? '重新探测 Zotero 写入能力' : '请求 Zotero 写入权限'} data-zotero-capability-action disabled={!zoteroProfile || permissionEntry === 'explain' || capabilityQuery.isFetching || permissionMutation.isPending} loading={capabilityQuery.isFetching || permissionMutation.isPending} onClick={() => { void requestOrProbeZotero() }} size="sm" title={permissionEntry === 'granted' ? '重新读取本机 Zotero 写入能力' : permissionEntry === 'request' ? '先重新探测 Zotero，再请求本机写入授权' : permissionEntryBrief(permissionEntry, permissionReason, permissionStatus)} variant="secondary"><RefreshCw aria-hidden="true" className="size-3.5" />{permissionEntry === 'granted' ? '重新探测 Zotero 写入能力' : '请求 Zotero 写入权限'}</Button>
        <details className="literature-history"><summary aria-label="查看检索历史" className="literature-toolbar-text-button">检索历史</summary><div className="literature-history-content"><strong>最近检索</strong>{(sessionsQuery.data ?? []).slice(0, 8).map((session) => <button key={session.id} onClick={() => { void restoreSession(session) }} type="button"><span>{session.query}</span><small>{session.resultCount} 条 · {new Date(session.createdAt).toLocaleString()}</small></button>)}{(sessionsQuery.data ?? []).length === 0 ? <span className="literature-history-empty">暂无检索历史</span> : null}</div></details>
        <LiteratureHelpDialog />
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
        <label className="literature-filter-field literature-optional-filter"><span>导入项目</span><select aria-label="导入项目" className="select-control" onChange={(event) => chooseProjectId(event.target.value)} value={projectId}><option value="">未分类（不绑定项目）</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <details className="literature-more-filters"><summary>更多筛选</summary><div className="literature-more-filters-content"><label>筛选当前结果<Input aria-label="筛选当前结果" className="input-control h-8 text-xs" onChange={(event) => setFilter(event.target.value)} placeholder="标题、作者或期刊" value={filter} /></label><label>导入项目<select aria-label="导入项目" className="select-control h-8 text-xs" onChange={(event) => chooseProjectId(event.target.value)} value={projectId}><option value="">未分类（不绑定项目）</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label>Zotero 附加标签<input aria-label="Zotero 附加标签" className="input-control h-8 text-xs" onChange={(event) => setZoteroTags(event.target.value)} placeholder="#方法学, #重点" value={zoteroTags} /></label><span>项目标签会自动使用所选项目名称；未绑定项目使用 #未分类。</span></div></details>
      </section>
      <div className={inspectorOpen ? 'literature-search-layout mt-4 grid items-start gap-4' : 'literature-search-layout literature-inspector-collapsed mt-4 grid items-start gap-4'} ref={literatureLayoutRef} style={literatureLayoutStyle}>
        <ResearchPanel className="literature-search-panel" eyebrow="SEARCH / FREE SOURCES" title="联网检索">
          <p className="literature-search-panel-note">使用上方搜索栏并行检索 Crossref、OpenAlex、PubMed、arXiv、Semantic Scholar 和 scholarly；结果可排序、筛选并分配到项目。</p>
        </ResearchPanel>
        <ResearchPanel className="literature-results-panel" action={<div className="literature-results-actions flex flex-nowrap items-center gap-2">
          <select aria-label="Zotero Collection" className="select-control literature-collection-select" disabled={!zoteroProfile || collectionsQuery.isLoading} onChange={(event) => { setCollectionKey(event.target.value || null); setZoteroPreview(null); setZoteroHandoff(null) }} value={collectionKey ?? ''}><option value="">Zotero 默认 Collection</option>{collections.map((collection: ZoteroCollection) => <option key={collection.key} value={collection.key}>{collection.name}</option>)}</select>
          <select aria-label="Zotero 导出格式" className="select-control literature-format-select" onChange={(event) => { setZoteroFormat(event.target.value as ZoteroExportFormat); setZoteroPreview(null); setZoteroHandoff(null) }} value={zoteroFormat}><option value="bibtex">Better BibTeX</option><option value="ris">RIS</option></select>
          <Button disabled={selectedResults.length === 0 || batchStageMutation.isPending} loading={batchStageMutation.isPending} onClick={() => batchStageMutation.mutate(selectedResults)} size="sm"><Plus aria-hidden="true" className="size-3.5" />批量暂存</Button>
          <Button disabled={selectedResults.length === 0 || queueMutation.isPending} loading={queueMutation.isPending} onClick={() => queueMutation.mutate(selectedResults)} size="sm"><BookOpen aria-hidden="true" className="size-3.5" />加入待读</Button>
          <Button aria-label={prepareLabels[plan]} disabled={selectedResults.length === 0 || previewMutation.isPending || plan === 'checking'} loading={previewMutation.isPending} onClick={() => void previewSelected(selectedResults)} size="sm" variant="primary">{prepareLabels[plan]}</Button>
        </div>} eyebrow={`RESULTS / ${pageSize} PER PAGE`} title={`检索结果${visibleResults.length ? ` · ${visibleResults.length}` : ''}`}>
          <LiteratureWriteEntry capabilityError={capabilityProbeError} disabled={previewMutation.isPending} onProjectChange={chooseWriteProject} permission={permissionView} plan={plan} projects={projects} writeBlockedNote={writeBlockedNote} writeProjectId={writeProjectId} />
          <SelectionBar
            allSelected={allVisibleResultsSelected}
            disabled={visibleResults.length === 0}
            indeterminate={someVisibleResultsSelected}
            label="检索结果选择"
            onClear={() => clearSelectedIds(Object.values(resultCache))}
            onToggleAll={() => toggleVisibleSelection(visibleResults)}
            scope={`范围：全选仅覆盖当前页筛选后的 ${visibleResults.length} 条（本页 ${results.length} 条，已加载 ${Object.keys(resultCache).length} 条）；翻页会保留已选，重新检索会清空，且不会选中未加载的页`}
            selectAllLabel="全选当前页"
            selectedCount={selectedResults.length}
            totalCount={Object.keys(resultCache).length}
          />
          {searchMutation.isPending || pageMutation.isPending || restoredResultsQuery.isLoading ? <LoadingState label="正在读取联网检索结果…" /> : null}
          {searchMutation.error && results.length === 0 ? <ErrorState error={searchMutation.error} onRetry={() => searchMutation.mutate()} /> : null}
          {!searchMutation.isPending && !restoredResultsQuery.isLoading && visibleResults.length === 0 ? <EmptyState description="输入关键词后检索 Crossref、OpenAlex、PubMed、arXiv、Semantic Scholar 和 scholarly。" title="暂无检索结果" /> : null}
          <div className="literature-results-list divide-y divide-border">{visibleResults.map((result, index) => <SearchResultRow index={index + 1} inspected={selectedResult?.id === result.id} key={`${result.source}:${result.sourceId}`} onContextMenu={(event) => { event.preventDefault(); setContextMenu({ x: event.clientX, y: event.clientY, ids: [result.id] }) }} onInspect={() => { setSelectedResult(result); setInspectorOpen(true) }} onQueue={() => queueMutation.mutate([result])} onSelect={(checked) => setSelectedIds((current) => { const next = new Set(current); checked ? next.add(result.id) : next.delete(result.id); return next })} onStage={() => plusAction(result)} onExternalOutcome={reportExternalOutcome} failed={failedByFingerprint.has(result.fingerprint)} plan={plan} result={result} zoteroProfile={Boolean(zoteroProfile)} selected={selectedIds.has(result.id)} staged={stagedByFingerprint.has(result.fingerprint)} />)}</div>
          <SearchPagination currentPage={currentPage} onPageChange={goToPage} pageSize={pageSize} pending={searchMutation.isPending || pageMutation.isPending} totalPages={totalPages} totalResults={totalResults} hasMore={hasMorePages} />
        </ResearchPanel>
        <Inspector executePending={executeMutation.isPending} failed={selectedResult ? failedByFingerprint.has(selectedResult.fingerprint) : false} onCancelPreview={() => setZoteroPreview(null)} onExecutePreview={executePreview} onProjectChange={chooseWriteProject} onExternalOutcome={reportExternalOutcome} onToggle={() => setInspectorOpen((current) => !current)} open={inspectorOpen} permission={permissionView} plan={plan} projects={projects} resizer={inspectorResizer} preview={zoteroPreview} result={selectedResult} staged={selectedResult ? stagedByFingerprint.has(selectedResult.fingerprint) : false} targetCollectionName={collectionName(zoteroPreview?.targetCollectionKey ?? collectionKey)} writeBlockedNote={writeBlockedNote} />
      </div>
    </> : <div className="mt-4 grid gap-4">
      <ResearchPanel action={<div className="flex flex-wrap items-center gap-2">
        <select aria-label="按项目筛选待分类文献" className="select-control max-w-48" onChange={(event) => setStagingProjectFilter(event.target.value === "__unassigned__" ? null : event.target.value || undefined)} value={stagingProjectFilter === null ? "__unassigned__" : stagingProjectFilter ?? ""}><option value="">全部项目</option><option value="__unassigned__">未分配项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
        <select aria-label="将选中文献分配到项目" className="select-control max-w-48" disabled={selectedStaging.length === 0 || assignProjectsMutation.isPending} onChange={(event) => { const target = event.target.value === '__unassigned__' ? '' : event.target.value; assignProjectsMutation.mutate({ records: selectedStaging, projectId: target }) }} defaultValue="__placeholder__"><option value="__placeholder__" disabled>批量分配到…</option><option value="__unassigned__">未分类</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
        <Button disabled={selectedStaging.length === 0 || deleteMutation.isPending} loading={deleteMutation.isPending} onClick={() => deleteMutation.mutate(selectedStaging)} size="sm" variant="danger"><Trash2 aria-hidden="true" className="size-3.5" />删除选中</Button>
        <Button aria-label={prepareLabels[plan]} disabled={selectedStaging.length === 0 || previewMutation.isPending || plan === 'checking'} loading={previewMutation.isPending} onClick={() => previewMutation.mutate(selectedStaging)} size="sm" variant="primary">{prepareLabels[plan]}</Button>
      </div>} eyebrow="STAGING / PERSISTENT" title="待分类文献">
        <SelectionBar
          allSelected={allStagingSelected}
          disabled={stagedItems.length === 0}
          indeterminate={someStagingSelected}
          label="待分类文献选择"
          onClear={() => clearSelectedIds(stagedItems)}
          onToggleAll={() => toggleVisibleSelection(stagedItems)}
          scope={`范围：项目筛选「${stagingFilterLabel}」下已加载的 ${stagedItems.length} 条（单页最多 100 条，不代表全部待分类记录）；选择只作用于列表中的记录`}
          selectAllLabel="全选当前结果"
          selectedCount={selectedStaging.length}
          totalCount={stagedItems.length}
        >
          {recentStagingProject ? <Button aria-label={`将选中文献分派到最近项目：${recentStagingProject.name}`} disabled={selectedStaging.length === 0 || assignProjectsMutation.isPending} onClick={() => assignProjectsMutation.mutate({ records: selectedStaging, projectId: recentStagingProject.id })} size="sm" variant="secondary">分派到最近项目：{recentStagingProject.name}</Button> : null}
        </SelectionBar>
        <div className="border-t border-border px-4 pb-3" data-zotero-staging-permission-entry><ZoteroWritePermissionEntry view={permissionView} /></div>
        {stagingQuery.isLoading ? <LoadingState label="正在读取待分类文献…" /> : null}
        {stagingQuery.error ? <ErrorState error={stagingQuery.error} onRetry={() => void stagingQuery.refetch()} /> : null}
        {!stagingQuery.isLoading && !stagingQuery.error && stagedItems.length === 0 ? <EmptyState description="在检索结果中点击“加入待分类”后，文献会持久保存在这里，并可分配或移动到任意项目。" title="待分类为空" /> : null}
        <div className="divide-y divide-border">{stagedItems.map((record, index) => <div className="paper-row literature-staging-row" key={record.id}>
          <span aria-hidden="true" className="literature-result-number">{index + 1}</span>
          <label className="grid size-8 shrink-0 cursor-pointer place-items-center"><span className="sr-only">选择待分类文献</span><input aria-label={`选择待分类文献：${record.title}`} checked={selectedIds.has(record.id)} className="research-checkbox" onChange={(event) => setSelectedIds((current) => { const next = new Set(current); event.target.checked ? next.add(record.id) : next.delete(record.id); return next })} type="checkbox" /></label>
          <div className="min-w-0 flex-1"><h3 className="overflow-wrap-anywhere text-sm font-semibold text-foreground">{record.title}</h3><p className="mt-1 truncate text-xs text-muted-foreground">{record.authors.join(', ') || '作者未知'} · {record.venue || sourceLabels[record.source]} · {record.year ?? '年份未知'}</p><span className="literature-project-badge">{record.projectId ? projects.find((project) => project.id === record.projectId)?.name ?? '已分配项目' : '未分类'}</span></div>
          <select aria-label={`为 ${record.title} 分配项目`} className="select-control max-w-48" disabled={assignProjectMutation.isPending} onChange={(event) => assignProjectMutation.mutate({ record, projectId: event.target.value })} value={record.projectId ?? ""}><option value="">未分类</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
          {zoteroProfile ? <Button aria-label={`${prepareLabels[plan]}：${record.title}`} disabled={previewMutation.isPending} onClick={() => previewMutation.mutate([record])} size="icon" variant="ghost"><RefreshCw aria-hidden="true" className="size-3.5" /></Button> : null}
          <Button aria-label={`删除 ${record.title}`} onClick={() => deleteMutation.mutate([record])} size="icon" variant="ghost"><X aria-hidden="true" className="size-4" /></Button>
        </div>)}</div>
      </ResearchPanel>
    </div>}
    {tab === 'staging' && zoteroPreview ? <ResearchPanel className="mt-4" action={<div className="flex gap-2"><Button onClick={() => setZoteroPreview(null)} size="sm">取消</Button><Button aria-label={confirmLabels[zoteroPreview.transport === 'api' ? 'write' : 'read-only']} disabled={executeMutation.isPending} loading={executeMutation.isPending} onClick={executePreview} size="sm" variant="primary">{confirmLabels[zoteroPreview.transport === 'api' ? 'write' : 'read-only']}</Button></div>} eyebrow="ZOTERO / CONFIRMATION" title={`导入预览 · ${zoteroPreview.total} 条`}><div className="p-4 text-xs text-muted-foreground"><p>目标：{zoteroProfile?.name ?? '未配置 Zotero'} · Collection：{collectionDisplayLabel(collectionName(zoteroPreview.targetCollectionKey), zoteroPreview.targetCollectionKey)} · capability：{zoteroPreview.capability} · transport：{zoteroPreview.transport}</p><FrozenWriteValues values={stagingFrozenValues} /><ZoteroProjectField disabled={executeMutation.isPending} onProjectChange={chooseWriteProject} projectId={zoteroPreview.projectId} projects={projects} selectLabel="Zotero 写入顶层项目分类" tagHint={`更改分类会丢弃当前预览，需要重新生成；确认时使用预览冻结的分类。`} tagText={projectTagLabel(zoteroPreview.projectTag)} tagValue={zoteroPreview.projectTag ?? ''} /><ZoteroWritePermissionEntry view={permissionView} /><p className="mt-2">{zoteroPreview.transport === 'api' ? '这是一次性写入预览：预览已冻结条目匹配、Collection 和 profile revision。只有点击明确确认后才会调用 Zotero；失败项会逐条返回并保留“重新导入”入口。' : '这是一次性生成预览：Zotero 只读时确认后只会生成 RIS/BibTeX 导入包，不会调用写入接口。'}{zoteroPreview.capability !== 'write' && zoteroPreview.transport === 'api' ? ' 当前连接没有写入权限，确认后将逐条显示失败；完成授权后可再次导入。' : ''}</p></div></ResearchPanel> : null}
    {zoteroHandoff ? <ResearchPanel className="mt-4" eyebrow="ZOTERO / IMPORT PACKAGE" title="待下载的导入包"><div className="flex flex-wrap items-center gap-2 p-4 text-xs"><span className="min-w-0 flex-1 text-amber-800 dark:text-amber-200">已生成 {zoteroHandoff.itemCount} 条 {zoteroHandoff.format.toUpperCase()} 元数据（未写入 Zotero）；目标 Collection：{zoteroHandoff.targetCollectionKey ?? '默认'}。下载后在 Zotero 中选择“导入”完成导入，回执中的“已生成导入包”不代表已写入。</span><Button aria-label="下载文献 Zotero 导入包" onClick={() => { void downloadZoteroHandoff(zoteroHandoff).then((fileName) => setFeedback(`已保存到 Downloads：${fileName}`)).catch((error) => { setFeedback(null); setFeedbackError(error) }) }} size="sm" variant="secondary"><Download aria-hidden="true" className="size-3.5" />下载导入包</Button></div></ResearchPanel> : null}
    {zoteroReceipts.length > 0 ? <ResearchPanel className="mt-4" eyebrow="ZOTERO / RECEIPTS" title="逐条写入回执"><div className="divide-y divide-border">{zoteroReceipts.map((receipt) => { const status = receipt.outcome === 'written' ? '已写入' : receipt.outcome === 'generated' ? '已生成导入包（未写入 Zotero）' : receipt.outcome === 'failed' ? '写入失败' : receipt.outcome === 'unsupported' ? '不支持' : '已跳过'; const retryRecord = retryableStaging.find((record) => record.id === receipt.stagingId); return <div className="px-4 py-3 text-xs" data-zotero-receipt={receipt.outcome} key={receipt.stagingId}><div className="flex items-center gap-3"><span className="min-w-0 flex-1 font-medium text-foreground">{receiptTitles[receipt.stagingId] ?? receipt.stagingId}</span><span className={receipt.outcome === 'failed' || receipt.outcome === 'unsupported' ? 'text-danger' : 'text-muted-foreground'}>{status}</span>{retryRecord ? <Button aria-label={`再次导入 ${retryRecord.title}`} disabled={previewMutation.isPending} onClick={() => previewMutation.mutate([retryRecord])} size="sm" variant="danger"><RefreshCw aria-hidden="true" className="size-3.5" />再次导入</Button> : null}</div><div className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground"><span className="research-tag">{collectionWriteLabel(receipt.collectionWrite, receipt.targetCollectionKey, collectionName(receipt.targetCollectionKey))}</span>{receipt.projectTag ? <span className="research-tag">{projectTagLabel(receipt.projectTag)}</span> : null}{receipt.remoteRevision ? <span className="font-mono">v{receipt.remoteRevision}</span> : null}{receipt.error ? <span className={`min-w-0 flex-1 leading-5 ${receipt.outcome === 'failed' || receipt.outcome === 'unsupported' ? 'text-danger' : ''}`}>{receipt.error.message}</span> : null}</div></div> })}</div></ResearchPanel> : null}
    {retryableStaging.length > 0 ? <ResearchPanel className="mt-4" eyebrow="ZOTERO / RETRY" title={`失败项 · ${retryableStaging.length} 条`}><div className="flex flex-wrap items-center gap-2 p-4 text-xs"><span className="min-w-0 flex-1 text-muted-foreground">以下文献未成功写入，可在修复 Zotero 连接后重新生成预览并再次写入。</span><Button disabled={previewMutation.isPending} loading={previewMutation.isPending} onClick={() => previewMutation.mutate(retryableStaging)} size="sm" variant="primary">重试失败项</Button></div><div className="divide-y divide-border">{retryableStaging.map((record) => <div className="flex items-center gap-3 px-4 py-3 text-xs" key={record.id}><span className="min-w-0 flex-1 font-medium text-foreground">{record.title}</span><span className="text-danger">写入失败</span><Button disabled={previewMutation.isPending} onClick={() => previewMutation.mutate([record])} size="sm" variant="danger"><RefreshCw aria-hidden="true" className="size-3.5" />重新导入</Button></div>)}</div></ResearchPanel> : null}
    {contextMenu ? <div className="fixed z-50 min-w-48 rounded-md border border-border bg-surface p-1 shadow-lg" onClick={(event) => event.stopPropagation()} style={{ left: contextMenu.x, top: contextMenu.y }}><button className="flex min-h-8 w-full items-center gap-2 rounded px-2.5 text-left text-xs hover:bg-muted" onClick={() => { const items = results.filter((result) => contextMenu.ids.includes(result.id)); batchStageMutation.mutate(items); setContextMenu(null) }} type="button"><Plus aria-hidden="true" className="size-3.5" />加入待分类</button><button className="flex min-h-8 w-full items-center gap-2 rounded px-2.5 text-left text-xs hover:bg-muted" onClick={() => { const items = results.filter((result) => contextMenu.ids.includes(result.id)); void previewSelected(items); setContextMenu(null) }} type="button"><ExternalLink aria-hidden="true" className="size-3.5" />{prepareLabels[plan]}</button></div> : null}
  </div>
}
