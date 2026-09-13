import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { ProxyAgent } from 'undici'
import type {
  SearchInput,
  SearchResult,
  SearchSession,
  PageInput,
  SearchResultPage,
  LiteratureBatchPreviewInput,
  LiteratureBatchPreview,
  LiteratureBatchExecuteInput,
  LiteratureBatchResult,
  LiteratureBatchCancelInput,
  LiteratureBatchCancelReceipt,
  LiteratureBatchRetryInput,
  LiteratureBatchImportResultInput,
  LiteratureBatchSelection,
  LiteratureBatchTarget,
  LiteratureBatchAction,
  LiteratureBatchReceipt,
  PaperImportReceipt,
  SelectionKey,
  LiteratureClearSessionInput,
  LiteratureClearSessionReceipt,
  LiteratureStagingPageInput,
  LiteratureStagingPage,
  LiteratureStagingSaveInput,
  LiteratureStagingRecord,
  LiteratureStagingDeleteInput,
  LiteratureStagingDeleteReceipt,
  LiteratureStagingBulkDeleteInput,
  LiteratureStagingBulkDeleteResult,
  LiteratureStagingToZoteroPreviewInput,
  LiteratureStagingToZoteroPreview,
  LiteratureStagingToZoteroExecuteInput,
  LiteratureStagingToZoteroResult,
  LiteratureStagingToZoteroReceipt,
  ZoteroImportResult,
  ZoteroHandoff,
  IntegrationError,
  ExternalWriteError
} from '@prw/contracts'
import type { ProjectId } from '@prw/contracts'
import {
  ProjectIdSchema,
  LiteratureBatchPreviewInputSchema,
  LiteratureBatchExecuteInputSchema,
  LiteratureBatchCancelInputSchema,
  LiteratureBatchRetryInputSchema,
  LiteratureBatchImportResultInputSchema,
  LiteratureClearSessionInputSchema,
  LiteratureClearSessionReceiptSchema,
  PaperImportReceiptSchema,
  SearchResultPageSchema,
  LiteratureStagingPageInputSchema,
  LiteratureStagingSaveInputSchema,
  LiteratureStagingDeleteInputSchema,
  LiteratureStagingBulkDeleteInputSchema,
  LiteratureStagingToZoteroPreviewInputSchema,
  LiteratureStagingToZoteroExecuteInputSchema,
  LiteratureStagingToZoteroPreviewSchema,
  LiteratureStagingToZoteroResultSchema,
  type Paper
} from '@prw/contracts'
import type { WorkbenchRepository } from '@prw/database'
import { IntegrationRuntimeError } from '@prw/connectors'
import type { IntegrationCoordinator } from './integration-runtime.js'

/** The staging flow deliberately depends on the typed IntegrationCoordinator
 * surface only.  It never calls a Zotero connector from this module. */
type ZoteroStagingBridge = Pick<IntegrationCoordinator, 'previewPaperToZotero' | 'executePaperToZotero'>

const proxyAgents = new Map<string, ProxyAgent>()

function fetchWithConfiguredProxy(repository: WorkbenchRepository, url: URL, init: RequestInit): Promise<Response> {
  const profile = repository.listAgentProxyProfiles().find((item) => item.enabled && (item.httpProxy || item.httpsProxy))
  if (!profile) return fetch(url, init)
  const bypass = new Set((profile.noProxy ?? '').split(',').map((value) => value.trim().toLocaleLowerCase()).filter(Boolean))
  if (bypass.has(url.hostname.toLocaleLowerCase()) || bypass.has('localhost') && url.hostname === '127.0.0.1') return fetch(url, init)
  const proxy = url.protocol === 'https:' ? profile.httpsProxy ?? profile.httpProxy : profile.httpProxy ?? profile.httpsProxy
  if (!proxy) return fetch(url, init)
  let agent = proxyAgents.get(proxy)
  if (!agent) {
    agent = new ProxyAgent(proxy)
    proxyAgents.set(proxy, agent)
  }
  return fetch(url, { ...init, dispatcher: agent } as RequestInit & { dispatcher: ProxyAgent })
}

/**
 * The single project classification shared by every selected staging record.
 * Records that deliberately belong to different projects (or to none) yield
 * `null` so the preview freezes 未分类 instead of writing per-record tags that
 * the confirm step never showed.
 */
function sharedStagingProjectId(records: readonly LiteratureStagingRecord[]): ProjectId | null {
  const ids = new Set<ProjectId | null>(records.map((record) => record.projectId))
  return ids.size === 1 ? [...ids][0] ?? null : null
}

type StoredStagingZoteroPreview = {
  readonly profileId: string
  readonly stagingIds: string[]
  readonly paperIds: Paper['id'][]
  readonly integrationPreviewId: string
  readonly targetCollectionKey: string | null
  readonly format: LiteratureStagingToZoteroPreviewInput['format']
  readonly transport: LiteratureStagingToZoteroPreview['transport']
  /** Top-level project classification frozen by the preview (null = 未分类). */
  readonly projectId: ProjectId | null
  /** Exact Zotero tag resolved from `projectId` when the preview was frozen. */
  readonly projectTag: string
}

type BatchOperation = {
  readonly operationId: string
  readonly preview: StoredBatchPreview
  readonly result: LiteratureBatchResult
}
type StoredBatchPreview = {
  readonly selection: LiteratureBatchSelection
  readonly action: LiteratureBatchAction
  readonly target: LiteratureBatchTarget | null
}

type SearchContinuation = {
  readonly input: SearchInput
  nextRemotePage: number
  hasMore: boolean
  status: SearchResultPage['status']
}

type ScholarSidecarRecord = {
  sourceId: string
  title: string
  authors: string[]
  year: number | null
  venue: string
  abstract: string
  doi: string | null
  url: string | null
  isOpenAccess: boolean | null
  openMetric: number | null
}

async function runScholarSidecar(input: SearchInput, proxy: string | null): Promise<{ items: ScholarSidecarRecord[]; hasMore: boolean }> {
  const python = process.env['PRW_PYTHON']?.trim() || (process.platform === 'win32' ? 'python' : 'python3')
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const packagedScript = typeof resourcesPath === 'string' && resourcesPath.trim()
    ? join(resourcesPath, 'sidecars', 'scholar.py')
    : join(process.cwd(), 'sidecars', 'scholar.py')
  const script = process.env['PRW_SCHOLAR_SIDECAR']?.trim() || packagedScript
  const payload = JSON.stringify({ query: input.query, page: input.page, pageSize: input.pageSize, proxy: proxy ?? '' })
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      let output = ''
      let errorOutput = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error('请求超时')) }, 30_000)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { output += chunk })
      child.stderr.on('data', (chunk: string) => { errorOutput += chunk })
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(output)
        else reject(new Error(errorOutput.trim() || `sidecar exited with code ${code ?? 'unknown'}`))
      })
      child.stdin.end(payload)
    })
    const parsed: unknown = JSON.parse(stdout)
    if (!parsed || typeof parsed !== 'object') throw new Error('Google Scholar sidecar 返回格式无效')
    const record = parsed as { items?: unknown; hasMore?: unknown; error?: unknown }
    if (typeof record.error === 'string' && record.error.trim()) throw new Error(record.error)
    const items = Array.isArray(record.items) ? record.items.flatMap((item): ScholarSidecarRecord[] => {
      if (!item || typeof item !== 'object') return []
      const value = item as Record<string, unknown>
      if (typeof value.title !== 'string' || !value.title.trim()) return []
      return [{
        sourceId: typeof value.sourceId === 'string' ? value.sourceId : randomUUID(),
        title: value.title.trim(),
        authors: Array.isArray(value.authors) ? value.authors.filter((author): author is string => typeof author === 'string') : [],
        year: typeof value.year === 'number' ? value.year : null,
        venue: typeof value.venue === 'string' ? value.venue : '',
        abstract: typeof value.abstract === 'string' ? value.abstract : '',
        doi: typeof value.doi === 'string' ? value.doi : null,
        url: typeof value.url === 'string' ? value.url : null,
        isOpenAccess: typeof value.isOpenAccess === 'boolean' ? value.isOpenAccess : null,
        openMetric: typeof value.openMetric === 'number' ? value.openMetric : null
      }]
    }) : []
    return { items, hasMore: record.hasMore === true }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Google Scholar sidecar failed'
    throw new IntegrationRuntimeError('TEMPORARILY_UNAVAILABLE', `Google Scholar：${detail}`)
  }
}

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

export class LiteratureCoordinator {
  private readonly batchPreviews = new Map<string, StoredBatchPreview>()
  private readonly batchOperations = new Map<string, BatchOperation>()
  /** Search status is kept out of the disposable SearchSession DTO.  The
   * result-page contract exposes it without making a session a second source
   * of truth for remote connector state. */
  private readonly searchStatuses = new Map<string, SearchResultPage['status']>()
  private readonly searchContinuations = new Map<string, SearchContinuation>()
  private readonly stagingZoteroPreviews = new Map<string, StoredStagingZoteroPreview>()

  constructor(
    private readonly repository: WorkbenchRepository,
    private readonly stagingIntegration?: ZoteroStagingBridge
  ) {}

  async search(input: SearchInput): Promise<{ session: SearchSession; results: SearchResult[] }> {
    const id = randomUUID()
    let found: SearchResult[]
    let status: SearchResultPage['status'] = 'complete'
    if (input.source === 'local') {
      found = this.localResults(input)
    } else if (input.source === 'all') {
      const aggregate = await this.allSourceResults(input)
      found = aggregate.results
      status = aggregate.status
    } else {
      // Crossref, PubMed and the other public adapters may return a DOI
      // without a journal metric. Resolve those DOIs through the same
      // optional OpenAlex source lookup used by the all-sources path so a
      // single-source search exposes the same sortable IF-style value.
      found = await this.enrichMissingImpactFactors(await this.remoteResults(input))
    }
    const ordered = [...found].sort((left, right) => {
      switch (input.sort) {
        case 'year-asc': return compareYear(left.year, right.year, false)
        case 'year-desc': return compareYear(left.year, right.year, true)
        case 'impact-asc': return compareImpactFactor(left.impactFactor, right.impactFactor, false)
        case 'impact-desc': return compareImpactFactor(left.impactFactor, right.impactFactor, true)
        case 'metric-asc': return compareOpenMetric(left.openMetric, right.openMetric, false)
        case 'metric-desc': return compareOpenMetric(left.openMetric, right.openMetric, true)
        default: return 0
      }
    })
    const results = ordered.map((result) => ({ ...result, sessionId: id }))
    const session: SearchSession = {
      id,
      query: input.query,
      source: input.source,
      // Keep the connector paging/sort choices with the disposable session so
      // a restored session can continue from the same remote page. These are
      // implementation metadata, not user supplied credentials or content.
      filters: { ...input.filters, __prwSort: input.sort, __prwPageSize: input.pageSize },
      createdAt: new Date().toISOString(),
      resultCount: results.length
    }
    const storedSession = this.repository.createSearchSession(session, results)
    this.searchStatuses.set(id, status)
    this.searchContinuations.set(id, {
      input: { ...input, filters: input.filters },
      nextRemotePage: 2,
      hasMore: input.source !== 'local' && results.length > 0,
      status
    })
    return { session: storedSession, results }
  }

  listSessions(): SearchSession[] {
    return this.repository.listSearchSessions()
  }

  /** Clear a disposable search session without touching imported Papers. */
  clearSession(input: LiteratureClearSessionInput): LiteratureClearSessionReceipt {
    const parsed = LiteratureClearSessionInputSchema.parse(input)
    const receipt = this.repository.clearSearchSession(parsed.sessionId)
    if (receipt.deletedSession) {
      this.searchStatuses.delete(parsed.sessionId)
      this.searchContinuations.delete(parsed.sessionId)
    }
    return LiteratureClearSessionReceiptSchema.parse(receipt)
  }

  listResults(sessionId: string): SearchResult[] {
    return this.listResultsPage({ sessionId }).items
  }

  resultsPage(input: { sessionId: string; page?: PageInput | undefined }): SearchResultPage {
    const results = this.repository.listSearchResults(input.sessionId)
    if (results.length === 0) {
      const session = this.repository.listSearchSessions(100).find((item) => item.id === input.sessionId)
      if (!session) throw new IntegrationRuntimeError('NOT_FOUND', '检索会话不存在')
    }
    const limit = input.page?.limit ?? (results.length || 50)
    const cursor = input.page?.cursor
    const offset = cursor === undefined || cursor === null ? 0 : decodeCursor(cursor)
    const items = results.slice(offset, offset + limit)
    const nextOffset = offset + items.length
    const continuation = this.getSearchContinuation(input.sessionId, results)
    const nextCursor = nextOffset < results.length
      ? encodeCursor(nextOffset)
      : continuation?.hasMore
        ? encodeRemoteCursor(input.sessionId, nextOffset, continuation.nextRemotePage)
        : null
    return SearchResultPageSchema.parse({ items, total: results.length, nextCursor, status: this.searchStatuses.get(input.sessionId) ?? 'complete' })
  }

  /** Fetch a remote continuation page only after the caller presents the
   * opaque cursor returned by resultsPage. The fetched rows are appended in a
   * transaction, so subsequent cursors never skip rows already loaded. */
  async loadResultsPage(input: { sessionId: string; page?: PageInput | undefined }): Promise<SearchResultPage> {
    const cursor = input.page?.cursor
    if (!cursor || !cursor.startsWith('remote:')) return this.resultsPage(input)
    const decoded = decodeRemoteCursor(cursor)
    if (!decoded || decoded.sessionId !== input.sessionId) throw new IntegrationRuntimeError('INVALID_MAPPING', '检索分页游标无效')
    await this.fetchContinuation(decoded.sessionId, decoded.remotePage, decoded.offset, input.page?.limit ?? 50)
    return this.resultsPage({ sessionId: input.sessionId, page: { limit: input.page?.limit ?? 50, cursor: encodeCursor(decoded.offset) } })
  }

  private getSearchContinuation(sessionId: string, results: SearchResult[]): SearchContinuation | undefined {
    const existing = this.searchContinuations.get(sessionId)
    if (existing) return existing
    const session = this.repository.listSearchSessions(100).find((item) => item.id === sessionId)
    if (!session || session.source === 'local' || results.length === 0) return undefined
    const persistedSort = session.filters.__prwSort
    const sort: SearchInput['sort'] = persistedSort === 'year-asc' || persistedSort === 'year-desc' || persistedSort === 'impact-asc' || persistedSort === 'impact-desc' || persistedSort === 'metric-asc' || persistedSort === 'metric-desc' ? persistedSort : 'relevance'
    const persistedPageSize = typeof session.filters.__prwPageSize === 'number' && session.filters.__prwPageSize >= 1 && session.filters.__prwPageSize <= 100 ? session.filters.__prwPageSize : 50
    const continuation: SearchContinuation = {
      input: { query: session.query, source: session.source, page: 1, pageSize: persistedPageSize, filters: session.filters, sort },
      nextRemotePage: 2,
      hasMore: true,
      status: this.searchStatuses.get(sessionId) ?? 'complete'
    }
    this.searchContinuations.set(sessionId, continuation)
    return continuation
  }

  private async fetchContinuation(sessionId: string, remotePage: number, offset: number, limit: number): Promise<void> {
    const current = this.repository.listSearchResults(sessionId)
    const continuation = this.getSearchContinuation(sessionId, current)
    if (!continuation || !continuation.hasMore) return
    let page = Math.max(2, remotePage)
    let appended: SearchResult[] = []
    let status = continuation.status
    // A provider can return a page containing only records already merged from
    // another source. Advance a small bounded number of pages before exposing
    // an empty result, while keeping the request lazy and cancellable by the
    // caller.
    for (let attempt = 0; attempt < 4 && appended.length === 0; attempt += 1) {
      const request: SearchInput = { ...continuation.input, page, pageSize: Math.max(limit, continuation.input.pageSize) }
      let fetched: SearchResult[]
      if (request.source === 'all') {
        const aggregate = await this.allSourceResults(request)
        fetched = aggregate.results
        status = aggregate.status
      } else if (request.source === 'local') {
        fetched = this.localResults(request)
      } else {
        fetched = await this.enrichMissingImpactFactors(await this.remoteResults(request))
      }
      const seen = new Set(current.map((result) => `${result.source}\u0000${result.sourceId}`))
      appended = fetched.filter((result) => {
        const key = `${result.source}\u0000${result.sourceId}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      }).map((result) => ({ ...result, sessionId }))
      if (fetched.length === 0) {
        continuation.hasMore = false
        break
      }
      page += 1
    }
    if (appended.length > 0) {
      this.repository.appendSearchResults(sessionId, appended)
      continuation.nextRemotePage = page
      continuation.status = status
      this.searchStatuses.set(sessionId, status)
    }
    if (appended.length === 0 && continuation.hasMore) {
      continuation.nextRemotePage = page
    }
    // The offset is part of the cursor contract; it is intentionally checked
    // here so a stale cursor cannot silently return a different page.
    if (offset > current.length) throw new IntegrationRuntimeError('INVALID_MAPPING', '检索分页游标已过期')
  }

  private listResultsPage(input: { sessionId: string; page?: PageInput | undefined }): SearchResultPage {
    return this.resultsPage(input)
  }

  /** Read the durable, SearchSession-independent staging snapshots. */
  listStaging(input: LiteratureStagingPageInput = { query: '' }): LiteratureStagingPage {
    return this.repository.listLiteratureStagingPage(LiteratureStagingPageInputSchema.parse(input))
  }

  /** Explicit alias used by callers that name the operation after its page DTO. */
  stagingPage(input: LiteratureStagingPageInput = { query: '' }): LiteratureStagingPage {
    return this.listStaging(input)
  }

  saveStaging(input: LiteratureStagingSaveInput): LiteratureStagingRecord {
    return this.repository.saveLiteratureStagingRecord(LiteratureStagingSaveInputSchema.parse(input))
  }

  deleteStaging(input: LiteratureStagingDeleteInput): LiteratureStagingDeleteReceipt {
    return this.repository.deleteLiteratureStagingRecord(LiteratureStagingDeleteInputSchema.parse(input))
  }

  bulkDeleteStaging(input: LiteratureStagingBulkDeleteInput): LiteratureStagingBulkDeleteResult {
    return this.repository.bulkDeleteLiteratureStagingRecords(LiteratureStagingBulkDeleteInputSchema.parse(input))
  }

  /** Persist a staging row's local Paper projection when the Zotero flow
   * needs one.  The projection is idempotent and preserves duplicate DOI /
   * title decisions rather than silently creating a second Paper. */
  private ensureStagingPaper(record: LiteratureStagingRecord): { record: LiteratureStagingRecord; paperId: Paper['id'] } {
    const linked = record.paperId === null ? undefined : this.repository.getPapersByIds([record.paperId])[0]
    if (linked !== undefined) return { record, paperId: linked.id }

    const duplicate = this.repository.listPapers({ query: record.doi ?? record.title, includeArchived: true }).find((paper) =>
      (record.doi !== null && paper.doi === record.doi)
      || paper.title.trim().toLocaleLowerCase() === record.title.trim().toLocaleLowerCase()
    )
    const paper = duplicate ?? this.repository.createPaper({
      projectId: record.projectId,
      title: record.title,
      authors: record.authors,
      year: record.year,
      venue: record.venue,
      abstract: record.abstract,
      doi: record.doi,
      url: record.url,
      citationKey: null,
      tags: [],
      collections: [],
      status: 'inbox',
      rating: 0,
      localPdfPath: null,
      source: 'import'
    })

    if (record.paperId === paper.id) return { record, paperId: paper.id }
    const linkedRecord = this.saveStaging({
      id: record.id,
      sessionId: record.sessionId,
      projectId: record.projectId,
      source: record.source,
      sourceId: record.sourceId,
      title: record.title,
      authors: record.authors,
      year: record.year,
      venue: record.venue,
      abstract: record.abstract,
      doi: record.doi,
      url: record.url,
      isOpenAccess: record.isOpenAccess,
      openMetric: record.openMetric,
      fingerprint: record.fingerprint,
      dedupeReason: record.dedupeReason,
      dedupeConfidence: record.dedupeConfidence,
      paperId: paper.id,
      expectedRevision: record.revision
    })
    return { record: linkedRecord, paperId: paper.id }
  }

  /** Build a one-use staging -> Zotero preview by delegating all capability,
   * duplicate and external-target logic to IntegrationCoordinator's existing
   * Paper -> Zotero preview path. */
  async previewStagingToZotero(
    input: LiteratureStagingToZoteroPreviewInput,
    integration?: ZoteroStagingBridge,
    secret: string | null = null
  ): Promise<LiteratureStagingToZoteroPreview> {
    const parsed = LiteratureStagingToZoteroPreviewInputSchema.parse(input)
    const bridge = integration ?? this.stagingIntegration
    if (bridge === undefined) throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', 'Zotero staging integration is unavailable')
    const records = parsed.stagingIds.map((id) => this.repository.getLiteratureStagingRecord(id))
    const projections = records.map((record) => this.ensureStagingPaper(record))
    // One frozen top-level classification per confirmed write.  An explicit
    // projectId (including `null` = 未分类) always wins; otherwise the selected
    // records' shared binding is used so a homogeneous selection keeps the
    // existing automatic tag, and a mixed selection is previewed as 未分类
    // instead of writing different tags than the one shown before confirming.
    const projectId = parsed.projectId === undefined ? sharedStagingProjectId(records) : parsed.projectId
    const projectTag = this.zoteroProjectTag(projectId)
    const paperPreview = await bridge.previewPaperToZotero({
      profileId: parsed.profileId,
      paperIds: projections.map(({ paperId }) => paperId),
      targetCollectionKey: parsed.targetCollectionKey,
      format: parsed.format,
      // The classification is resolved here so the exact tag written by the
      // confirmed external write is the one shown in the preview.
      projectId,
      tags: parsed.tags,
      // An import is an API write only when the capability probe granted write
      // access.  When the caller did not freeze a transport, the integration
      // layer derives it from that same probe, so a read-only connection
      // (Zotero 9 without a server id) yields the RIS/BibTeX fallback package
      // instead of an API request that is guaranteed to fail.
      ...(parsed.transport === undefined ? {} : { transport: parsed.transport }),
      secret
    })
    const previewId = randomUUID()
    const result = LiteratureStagingToZoteroPreviewSchema.parse({
      previewId,
      profileId: parsed.profileId,
      stagingIds: projections.map(({ record }) => record.id),
      targetCollectionKey: parsed.targetCollectionKey,
      format: parsed.format,
      transport: paperPreview.transport,
      capability: paperPreview.capability,
      projectId,
      projectTag,
      profileRevision: paperPreview.profileRevision,
      items: projections.map(({ record }, index) => {
        const item = paperPreview.items[index]
        if (item === undefined) throw new IntegrationRuntimeError('TEMPORARILY_UNAVAILABLE', 'Zotero preview returned an incomplete item list')
        return {
          stagingId: record.id,
          paperId: item.paperId,
          itemKey: item.itemKey,
          decision: item.decision,
          duplicate: item.duplicate,
          locator: item.locator,
          remoteRevision: item.remoteRevision ?? null,
          note: item.note ?? null
        }
      }),
      total: projections.length,
      requiresConfirmation: true
    })
    this.stagingZoteroPreviews.set(previewId, {
      profileId: parsed.profileId,
      stagingIds: projections.map(({ record }) => record.id),
      paperIds: projections.map(({ paperId }) => paperId),
      integrationPreviewId: paperPreview.previewId,
      targetCollectionKey: parsed.targetCollectionKey,
      format: parsed.format,
      transport: paperPreview.transport,
      projectId,
      projectTag
    })
    return result
  }

  /** The automatic Zotero tag for a project classification.  `null` is the
   * explicit 未分类 case; an unknown/deleted project falls back to it as well
   * instead of inventing a name.  The integration layer resolves the same value
   * from the frozen `projectId` at write time, so preview and write agree. */
  private zoteroProjectTag(projectId: string | null): string {
    if (projectId === null) return '未分类'
    return this.repository.listProjects().find((project) => project.id === projectId)?.name ?? '未分类'
  }

  /** Consume the staging preview and delegate the confirmed external write to
   * IntegrationCoordinator.  No connector or remote API is called directly. */
  async executeStagingToZotero(
    input: LiteratureStagingToZoteroExecuteInput,
    integration?: ZoteroStagingBridge,
    secret: string | null = null,
    expectedProfileId?: string
  ): Promise<LiteratureStagingToZoteroResult> {
    const parsed = LiteratureStagingToZoteroExecuteInputSchema.parse(input)
    const bridge = integration ?? this.stagingIntegration
    if (bridge === undefined) throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', 'Zotero staging integration is unavailable')
    const stored = this.stagingZoteroPreviews.get(parsed.previewId)
    if (stored === undefined) throw new IntegrationRuntimeError('NOT_FOUND', 'Zotero staging preview is missing or already used')
    if (expectedProfileId !== undefined && expectedProfileId !== stored.profileId) {
      throw new IntegrationRuntimeError('PERMISSION_DENIED', 'Credential profile does not match the Zotero staging preview')
    }
    const result = await bridge.executePaperToZotero({
      ...parsed,
      previewId: stored.integrationPreviewId
    }, secret, stored.profileId)
    // Keep the preview available when the external call throws so the user
    // can retry the same confirmed operation after fixing the connection.
    // Consume it only after a structured result has been returned.
    this.stagingZoteroPreviews.delete(parsed.previewId)
    return LiteratureStagingToZoteroResultSchema.parse(this.mapStagingZoteroResult(stored, result))
  }

  private mapStagingZoteroResult(stored: StoredStagingZoteroPreview, result: ZoteroImportResult): LiteratureStagingToZoteroResult {
    const items: LiteratureStagingToZoteroReceipt[] = stored.stagingIds.map((stagingId, index) => {
      const receipt = result.items[index]
      if (receipt === undefined) {
        throw new IntegrationRuntimeError('TEMPORARILY_UNAVAILABLE', 'Zotero write returned an incomplete item list')
      }
      return {
        stagingId,
        profileId: stored.profileId,
        paperId: receipt.paperId,
        itemKey: receipt.itemKey,
        outcome: receipt.outcome,
        transport: receipt.transport,
        format: receipt.format,
        locator: receipt.locator ?? null,
        remoteRevision: receipt.remoteRevision ?? null,
        duplicateDecision: receipt.duplicateDecision ?? null,
        targetCollectionKey: receipt.targetCollectionKey ?? stored.targetCollectionKey,
        collectionWrite: receipt.collectionWrite ?? 'not-written',
        projectId: stored.projectId,
        projectTag: stored.projectTag,
        error: mapStagingZoteroError(receipt.error)
      }
    })
    return {
      items,
      succeeded: items.filter((item) => item.outcome === 'written' || item.outcome === 'generated').length,
      skipped: items.filter((item) => item.outcome === 'skipped' || item.outcome === 'unsupported').length,
      failed: items.filter((item) => item.outcome === 'failed').length,
      canceled: result.canceled,
      handoff: result.handoff as ZoteroHandoff | null
    }
  }

  /** Resolve a stable search result identity into one local Paper write. */
  importResult(input: LiteratureBatchImportResultInput): PaperImportReceipt {
    const parsed = LiteratureBatchImportResultInputSchema.parse(input)
    const result = this.repository.listSearchResults(input.sessionId).find((value) => value.id === input.resultKey || value.sourceId === input.resultKey)
    if (!result) throw new IntegrationRuntimeError('NOT_FOUND', '检索结果不存在')
    const existing = this.repository.listPapers({ query: result.doi ?? result.title, includeArchived: true }).find((paper) => (result.doi !== null && paper.doi === result.doi) || paper.title.trim().toLocaleLowerCase() === result.title.trim().toLocaleLowerCase())
    if (existing) return PaperImportReceiptSchema.parse({
      status: 'existing',
      decision: 'existing',
      paper: existing,
      source: result.source,
      sourceId: result.sourceId,
      duplicate: { kind: result.doi !== null && existing.doi === result.doi ? 'doi' : 'title', existingPaperId: existing.id, decision: 'existing' }
    })
    const paper = this.repository.createPaper({
      projectId: parsed.projectId === null ? null : ProjectIdSchema.parse(parsed.projectId),
      title: result.title,
      authors: result.authors,
      year: result.year,
      venue: result.venue,
      abstract: result.abstract,
      doi: result.doi,
      url: result.url,
      citationKey: null,
      tags: [],
      collections: [],
      status: 'inbox',
      rating: 0,
      localPdfPath: null,
      source: 'import'
    })
    return PaperImportReceiptSchema.parse({ status: 'created', decision: 'created', paper, source: result.source, sourceId: result.sourceId })
  }

  previewBatch(input: LiteratureBatchPreviewInput): LiteratureBatchPreview {
    const parsed = LiteratureBatchPreviewInputSchema.parse(input)
    const selected = this.resolveSelection(parsed.selection)
    const previewId = randomUUID()
    const target = parsed.target ?? null
    const stored: StoredBatchPreview = { selection: parsed.selection, action: parsed.action, target }
    this.batchPreviews.set(previewId, stored)
    const duplicateDecisions = selected.flatMap((result) => {
      const existing = this.findDuplicate(result)
      return [{
        key: { source: result.source, sourceId: result.sourceId },
        decision: existing === undefined ? 'create' as const : 'review' as const,
        existingPaperId: existing?.id ?? null
      }]
    })
    return {
      previewId,
      total: selected.length,
      unknownPages: 0,
      selected,
      action: parsed.action,
      selection: parsed.selection,
      target,
      duplicateDecisions,
      requiresConfirmation: true
    }
  }

  executeBatch(input: LiteratureBatchExecuteInput): LiteratureBatchResult {
    const parsed = LiteratureBatchExecuteInputSchema.parse(input)
    if (!parsed.confirmationToken) throw new IntegrationRuntimeError('PERMISSION_DENIED', '批量操作需要明确确认')
    const preview = this.batchPreviews.get(parsed.previewId)
    if (!preview) throw new IntegrationRuntimeError('NOT_FOUND', '批量预览已过期')
    this.batchPreviews.delete(parsed.previewId)
    const operationId = randomUUID()
    if (parsed.cancelRequested) {
      const result: LiteratureBatchResult = { operationId, items: [], succeeded: 0, skipped: 0, failed: 0, canceled: true }
      this.batchOperations.set(operationId, { operationId, preview, result })
      return result
    }
    const result = this.runBatch(operationId, preview)
    this.batchOperations.set(operationId, { operationId, preview, result })
    return result
  }

  cancelBatch(input: LiteratureBatchCancelInput): LiteratureBatchCancelReceipt {
    const parsed = LiteratureBatchCancelInputSchema.parse(input)
    const operationId = parsed.operationId ?? parsed.previewId
    if (parsed.previewId !== undefined) this.batchPreviews.delete(parsed.previewId)
    if (operationId === undefined) throw new IntegrationRuntimeError('NOT_FOUND', '批量操作不存在')
    return { operationId, canceled: true, canceledAt: new Date().toISOString() }
  }

  retryBatch(input: LiteratureBatchRetryInput): LiteratureBatchResult {
    const parsed = LiteratureBatchRetryInputSchema.parse(input)
    if (!parsed.confirmationToken) throw new IntegrationRuntimeError('PERMISSION_DENIED', '重试操作需要明确确认')
    const operation = parsed.operationId === undefined
      ? (parsed.previewId === undefined ? undefined : this.batchPreviews.has(parsed.previewId) ? {
          operationId: parsed.previewId,
          preview: this.batchPreviews.get(parsed.previewId)!,
          result: { items: [], succeeded: 0, skipped: 0, failed: 0, canceled: false }
        } : undefined)
      : this.batchOperations.get(parsed.operationId)
    if (!operation) throw new IntegrationRuntimeError('NOT_FOUND', '批量操作不存在')
    const failedKeys = parsed.failedKeys.length > 0
      ? new Set(parsed.failedKeys.map(selectionKey))
      : new Set(operation.result.items.filter((item) => item.outcome === 'failed').map((item) => selectionKey(item.key)))
    const selection: LiteratureBatchSelection = {
      ...operation.preview.selection,
      mode: 'explicit',
      selectedKeys: operation.preview.selection.selectedKeys.filter((key) => failedKeys.has(selectionKey(key))),
      excludedKeys: []
    }
    const retryPreview: StoredBatchPreview = { ...operation.preview, selection }
    const retryOperationId = randomUUID()
    const result = this.runBatch(retryOperationId, retryPreview)
    this.batchOperations.set(retryOperationId, { operationId: retryOperationId, preview: retryPreview, result })
    return result
  }

  private runBatch(operationId: string, preview: StoredBatchPreview): LiteratureBatchResult {
    const selected = this.resolveSelection(preview.selection)
    const items: LiteratureBatchReceipt[] = []
    for (const result of selected) {
      const key = { source: result.source, sourceId: result.sourceId }
      try {
        if (preview.action === 'import_zotero') throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', 'Zotero 批量导入能力需要单独的显式预览')
        if (preview.action === 'add_project' || preview.action === 'mark_reading') {
          const imported = this.importResult({ sessionId: result.sessionId, resultKey: result.sourceId, projectId: preview.target?.projectId ?? null })
          if (preview.action === 'mark_reading' && imported.paper !== null) {
            this.repository.updatePaper({ id: imported.paper.id, status: 'reading', expectedRevision: imported.paper.revision })
          }
          const status = imported.status === 'existing' ? 'existing' : imported.status === 'created' ? 'created' : imported.status === 'skipped' ? 'skipped' : 'failed'
          const outcome = imported.status === 'created' ? 'succeeded' : imported.status === 'conflict' ? 'failed' : 'skipped'
          items.push({ key, outcome, status, paperId: imported.paper?.id ?? null, error: outcome === 'failed' ? { code: 'DUPLICATE_CONFLICT', message: '检测到重复文献，需要人工决定。', retryable: false } : null, retryable: false })
          continue
        } else if (preview.action === 'create_tasks') {
          const projectId = preview.target?.projectId ?? null
          this.repository.createTask({ title: result.title, notes: result.abstract, projectId: projectId === null ? null : ProjectIdSchema.parse(projectId), priority: 'normal', estimateMinutes: null, dueAt: null, tags: [] })
        } else if (preview.action === 'add_matrix') {
          const imported = this.importResult({ sessionId: result.sessionId, resultKey: result.sourceId, projectId: preview.target?.projectId ?? null })
          if (imported.paper !== null) this.repository.upsertLiteratureMatrix({ paperId: imported.paper.id, researchQuestion: '', method: '', data: '', keyFindings: '', limitations: '', evidence: '', relevance: '', qualityScore: 0, customFields: {}, expectedRevision: null })
        } else if (preview.action === 'export') {
          // Export is a Main save-dialog hand-off; do not write a file here.
          items.push({ key, outcome: 'skipped', status: 'skipped', locator: null, error: { code: 'EXPORT_HANDOFF_REQUIRED', message: '导出需要由桌面端保存对话框完成', retryable: false }, retryable: false })
          continue
        }
        items.push({ key, outcome: 'succeeded', status: 'created', error: null, retryable: false })
      } catch (error) {
        const normalized = error instanceof IntegrationRuntimeError ? { code: `EXTERNAL_${error.code}`, message: error.message, retryable: ['RATE_LIMITED', 'TEMPORARILY_UNAVAILABLE'].includes(error.code) } : { code: 'INTERNAL_ERROR', message: '批量操作失败', retryable: false }
        items.push({ key, outcome: 'failed', status: 'failed', error: normalized, retryable: normalized.retryable })
      }
    }
    return { operationId, items, succeeded: items.filter((item) => item.outcome === 'succeeded').length, skipped: items.filter((item) => item.outcome === 'skipped').length, failed: items.filter((item) => item.outcome === 'failed').length, canceled: false }
  }

  private resolveSelection(selection: LiteratureBatchSelection): SearchResult[] {
    if (selection.mode === 'none') return []
    const all = selection.sessionId ? this.repository.listSearchResults(selection.sessionId) : []
    const selected = selection.mode === 'all-results' ? all : all.filter((result) => selection.selectedKeys.some((key) => key.source === result.source && key.sourceId === result.sourceId))
    return selected.filter((result) => !selection.excludedKeys.some((key) => key.source === result.source && key.sourceId === result.sourceId))
  }

  private findDuplicate(result: SearchResult): Paper | undefined {
    return this.repository.listPapers({ query: result.doi ?? result.title, includeArchived: true }).find((paper) => (result.doi !== null && paper.doi === result.doi) || paper.title.trim().toLocaleLowerCase() === result.title.trim().toLocaleLowerCase())
  }

  private localResults(input: SearchInput): SearchResult[] {
    return this.repository.listPapers({ query: input.query }).slice(
      (input.page - 1) * input.pageSize,
      input.page * input.pageSize
    ).map((paper) => this.toResult(input, paper.id, {
      title: paper.title,
      authors: paper.authors,
      year: paper.year,
      venue: paper.venue,
      abstract: paper.abstract,
      doi: paper.doi,
      url: paper.url,
      isOpenAccess: null
    }, '本地已保存文献'))
  }

  /** Run every public/free adapter in parallel for the default search mode.
   * One unavailable source must not hide successful results from the others;
   * if every adapter fails, surface the first typed integration error. */
  private async allSourceResults(input: SearchInput): Promise<{ results: SearchResult[]; status: SearchResultPage['status'] }> {
    const sources: Exclude<SearchInput['source'], 'all'>[] = [
      'local', 'crossref', 'openalex', 'pubmed', 'arxiv', 'semantic_scholar', 'google_scholar'
    ]
    const settled = await Promise.allSettled(sources.map(async (source) => source === 'local'
      ? this.localResults({ ...input, source })
      : this.remoteResults({ ...input, source })))
    const successes = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
    const fulfilledCount = settled.filter((result) => result.status === 'fulfilled').length
    if (fulfilledCount === 0) {
      const firstFailure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (firstFailure) throw redactedSearchError(firstFailure.reason)
      throw new IntegrationRuntimeError('TEMPORARILY_UNAVAILABLE', '文献来源暂时不可用，请稍后重试')
    }
    const partial = settled.some((result) => result.status === 'rejected')
    // Keep one row per DOI/title, but merge metrics discovered by a later
    // source into the row that was already selected.  Crossref often arrives
    // before OpenAlex; dropping the duplicate would otherwise hide the
    // OpenAlex IF-style metric from an "all sources" search.
    const merged = new Map<string, SearchResult>()
    for (const result of successes) {
      const key = result.doi?.toLocaleLowerCase('en-US') || `${result.title.toLocaleLowerCase('en-US')}\u0000${result.year ?? ''}`
      const existing = merged.get(key)
      if (existing === undefined) {
        merged.set(key, result)
        continue
      }
      const hasImpactFactor = existing.impactFactor !== null && existing.impactFactor !== undefined
      const hasOpenMetric = existing.openMetric !== null && existing.openMetric !== undefined
      merged.set(key, {
        ...existing,
        ...(hasImpactFactor || result.impactFactor === null || result.impactFactor === undefined ? {} : {
          impactFactor: result.impactFactor,
          impactFactorSource: result.impactFactorSource ?? null,
          impactFactorFetchedAt: result.impactFactorFetchedAt ?? null
        }),
        ...(hasOpenMetric || result.openMetric === null || result.openMetric === undefined ? {} : { openMetric: result.openMetric })
      })
    }
    // OpenAlex's source metric is useful even when the visible row came from
    // Local or Crossref. Resolve missing DOI rows in one batched OpenAlex
    // lookup so the IF-style sort does not depend on which connector won the
    // de-duplication race.
    const enriched = await this.enrichMissingImpactFactors([...merged.values()])
    return { results: enriched, status: partial ? 'partial' : 'complete' }
  }

  private async remoteResults(input: SearchInput): Promise<SearchResult[]> {
    if (input.source === 'pubmed') return this.pubmedResults(input)
    if (input.source === 'arxiv') return this.arxivResults(input)
    if (input.source === 'semantic_scholar') return this.semanticScholarResults(input)
    if (input.source === 'google_scholar') return this.googleScholarResults(input)
    if (input.source !== 'crossref' && input.source !== 'openalex') {
      throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', '该文献来源将在后续阶段接入；当前可用 Crossref、OpenAlex 和本地库')
    }
    const url = input.source === 'crossref'
      ? new URL('https://api.crossref.org/works')
      : new URL('https://api.openalex.org/works')
    url.searchParams.set(input.source === 'crossref' ? 'query.bibliographic' : 'search', input.query)
    url.searchParams.set(input.source === 'crossref' ? 'rows' : 'per-page', String(input.pageSize))
    // Crossref uses an offset for continuation while OpenAlex accepts a page
    // number. Keep the connector request aligned with each provider so a
    // caller can request a later page without receiving page one again.
    if (input.source === 'crossref') url.searchParams.set('offset', String((input.page - 1) * input.pageSize))
    else url.searchParams.set('page', String(input.page))
    const response = await fetchWithConfiguredProxy(this.repository, url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    if (!response.ok) {
      if (response.status === 429) throw new IntegrationRuntimeError('RATE_LIMITED', '文献来源请求过于频繁，请稍后重试')
      throw new IntegrationRuntimeError('TEMPORARILY_UNAVAILABLE', `文献来源请求失败（${response.status}）`)
    }
    const payload: unknown = await response.json()
    if (input.source === 'crossref') return this.crossrefResults(input, payload)
    const results = this.openAlexResults(input, payload)
    // OpenAlex work records identify the journal source, while the source
    // endpoint carries its free 2-year mean citedness. Fetch that metric in a
    // single optional batch so the UI can show and sort an IF-style value
    // without confusing it with Clarivate's proprietary JCR impact factor.
    return this.enrichOpenAlexImpactFactors(results, payload)
  }

  private async enrichOpenAlexImpactFactors(results: SearchResult[], payload: unknown): Promise<SearchResult[]> {
    const root = toRecord(payload)
    const raw = root?.results
    if (!Array.isArray(raw) || results.length === 0) return results
    const sourceByResult = new Map<string, string>()
    const resultBySourceId = new Map(results.map((result) => [result.sourceId, result]))
    for (const value of raw) {
      const item = toRecord(value)
      const location = item === null ? null : toRecord(item.primary_location)
      const source = location === null ? null : toRecord(location.source)
      const sourceUrl = typeof source?.id === 'string' ? source.id : ''
      const sourceId = parseOpenAlexSourceId(sourceUrl)
      const result = item === null || typeof item.id !== 'string' ? undefined : resultBySourceId.get(item.id)
      if (sourceId && result) sourceByResult.set(result.id, sourceId)
    }
    const sourceIds = [...new Set(sourceByResult.values())]
    if (sourceIds.length === 0) return results
    try {
      const metrics = await this.fetchOpenAlexSourceMetrics(sourceIds)
      return results.map((result) => {
        const sourceId = sourceByResult.get(result.id)
        const metric = sourceId === undefined ? undefined : metrics.get(sourceId)
        if (metric === undefined) return result
        return {
          ...result,
          impactFactor: metric.value,
          impactFactorSource: 'OpenAlex 2yr_mean_citedness（IF 风格指标，非 JCR）',
          impactFactorFetchedAt: metric.fetchedAt
        }
      })
    } catch {
      // IF enrichment is supplementary. A source timeout must not hide the
      // bibliographic search results; those rows remain explicitly “未提供”.
      return results
    }
  }

  /** Resolve journal metrics for rows whose winning connector did not carry
   * an OpenAlex work record (for example a local or Crossref DOI). OpenAlex's
   * DOI filter is public and supports a bounded batch, so this remains a
   * single optional enrichment request per batch rather than one request per
   * paper. */
  private async enrichMissingImpactFactors(results: SearchResult[]): Promise<SearchResult[]> {
    const missing = results.filter((result) => (result.impactFactor === null || result.impactFactor === undefined) && result.doi)
    if (missing.length === 0) return results
    const records = new Map<string, { sourceId: string }>()
    for (let offset = 0; offset < missing.length; offset += 40) {
      const chunk = missing.slice(offset, offset + 40)
      try {
        const dois = chunk.map((result) => normalizeDoi(result.doi ?? '')).filter(Boolean)
        if (dois.length === 0) continue
        const url = new URL('https://api.openalex.org/works')
        url.searchParams.set('filter', `doi:${dois.join('|')}`)
        url.searchParams.set('per-page', String(dois.length))
        url.searchParams.set('select', 'doi,primary_location')
        const response = await fetchWithConfiguredProxy(this.repository, url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
        if (!response.ok) continue
        const root = toRecord(await response.json())
        const rows = Array.isArray(root?.results) ? root.results : []
        for (const value of rows) {
          const row = toRecord(value)
          const doi = typeof row?.doi === 'string' ? normalizeDoi(row.doi) : ''
          const source = toRecord(toRecord(row?.primary_location)?.source)
          const sourceId = typeof source?.id === 'string' ? parseOpenAlexSourceId(source.id) : undefined
          if (doi && sourceId) records.set(doi, { sourceId })
        }
      } catch {
        // Metric enrichment is supplementary; preserve the bibliographic row
        // and its explicit “未提供” state when the public endpoint is down.
      }
    }
    const metrics = await this.fetchOpenAlexSourceMetrics([...new Set([...records.values()].map((record) => record.sourceId))])
    if (metrics.size === 0) return results
    return results.map((result) => {
      const sourceId = result.doi ? records.get(normalizeDoi(result.doi))?.sourceId : undefined
      const metric = sourceId ? metrics.get(sourceId) : undefined
      return metric ? {
        ...result,
        impactFactor: metric.value,
        impactFactorSource: 'OpenAlex 2yr_mean_citedness（IF 风格指标，非 JCR）',
        impactFactorFetchedAt: metric.fetchedAt
      } : result
    })
  }

  private async fetchOpenAlexSourceMetrics(sourceIds: string[]): Promise<Map<string, { value: number; fetchedAt: string }>> {
    const metrics = new Map<string, { value: number; fetchedAt: string }>()
    if (sourceIds.length === 0) return metrics
    try {
      const url = new URL('https://api.openalex.org/sources')
      url.searchParams.set('filter', `ids.openalex:${sourceIds.join('|')}`)
      url.searchParams.set('per-page', String(Math.min(100, sourceIds.length)))
      url.searchParams.set('select', 'id,summary_stats,updated_date')
      const response = await fetchWithConfiguredProxy(this.repository, url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
      if (!response.ok) return metrics
      const sourcePayload = toRecord(await response.json())
      const sourceRows = Array.isArray(sourcePayload?.results) ? sourcePayload.results : []
      for (const row of sourceRows) {
        const sourceRecord = toRecord(row)
        if (sourceRecord === null) continue
        const sourceId = typeof sourceRecord.id === 'string' ? parseOpenAlexSourceId(sourceRecord.id) : undefined
        const stats = toRecord(sourceRecord.summary_stats)
        const candidate = stats?.['2yr_mean_citedness']
        if (!sourceId || typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) continue
        metrics.set(sourceId, { value: candidate, fetchedAt: new Date().toISOString() })
      }
    } catch {
      // Optional endpoint: callers keep the original row when unavailable.
    }
    return metrics
  }

  private async pubmedResults(input: SearchInput): Promise<SearchResult[]> {
    const start = (input.page - 1) * input.pageSize
    const searchUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi')
    searchUrl.searchParams.set('db', 'pubmed')
    searchUrl.searchParams.set('term', input.query)
    searchUrl.searchParams.set('retmode', 'json')
    searchUrl.searchParams.set('retstart', String(start))
    searchUrl.searchParams.set('retmax', String(input.pageSize))
    const searchResponse = await fetchWithConfiguredProxy(this.repository, searchUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    if (!searchResponse.ok) throw new IntegrationRuntimeError('TEMPORARILY_UNAVAILABLE', `PubMed request failed (${searchResponse.status})`)
    const searchPayload = toRecord(await searchResponse.json())
    const resultRoot = toRecord(searchPayload?.esearchresult)
    const idList = resultRoot?.idlist
    if (!Array.isArray(idList) || idList.length === 0) return []
    const ids = idList.filter((id): id is string => typeof id === 'string')
    const summaryUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi')
    summaryUrl.searchParams.set('db', 'pubmed')
    summaryUrl.searchParams.set('id', ids.join(','))
    summaryUrl.searchParams.set('retmode', 'json')
    const summaryResponse = await fetchWithConfiguredProxy(this.repository, summaryUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    if (!summaryResponse.ok) throw new IntegrationRuntimeError('TEMPORARILY_UNAVAILABLE', `PubMed summary failed (${summaryResponse.status})`)
    const summaryRoot = toRecord(await summaryResponse.json())
    const result = toRecord(summaryRoot?.result)
    if (!result) return []
    return ids.flatMap((id, index) => {
      const item = toRecord(result[id])
      const title = typeof item?.title === 'string' ? item.title : ''
      if (!title) return []
      const authors = Array.isArray(item?.authors) ? item.authors.flatMap((author) => {
        const record = toRecord(author)
        return typeof record?.name === 'string' ? [record.name] : []
      }) : []
      const dateValue = typeof item?.sortpubdate === 'string' ? Number(item.sortpubdate.slice(0, 4)) : null
      return [this.toResult(input, id || `pubmed-${index}`, {
        title,
        authors,
        year: Number.isInteger(dateValue) ? dateValue : null,
        venue: typeof item?.fulljournalname === 'string' ? item.fulljournalname : '',
        abstract: '',
        doi: null,
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
        isOpenAccess: null,
        openMetric: null
      }, 'PubMed PMID')]
    })
  }

  private async arxivResults(input: SearchInput): Promise<SearchResult[]> {
    const url = new URL('https://export.arxiv.org/api/query')
    url.searchParams.set('search_query', `all:${input.query}`)
    url.searchParams.set('start', String((input.page - 1) * input.pageSize))
    url.searchParams.set('max_results', String(input.pageSize))
    const response = await fetchWithConfiguredProxy(this.repository, url, { headers: { accept: 'application/atom+xml' }, signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new IntegrationRuntimeError('TEMPORARILY_UNAVAILABLE', `arXiv request failed (${response.status})`)
    const xml = await response.text()
    return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].flatMap((match, index) => {
      const block = match[1] ?? ''
      const title = decodeXml(xmlTag(block, 'title'))
      if (!title) return []
      const id = xmlTag(block, 'id').trim()
      const authors = [...block.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map((entry) => decodeXml(entry[1] ?? '').trim()).filter(Boolean)
      const published = xmlTag(block, 'published').trim()
      const year = Number(published.slice(0, 4))
      return [this.toResult(input, id || `arxiv-${index}`, {
        title,
        authors,
        year: Number.isInteger(year) ? year : null,
        venue: 'arXiv',
        abstract: decodeXml(xmlTag(block, 'summary')),
        doi: null,
        url: id || null,
        isOpenAccess: true,
        openMetric: null
      }, 'arXiv ID')]
    })
  }

  private async semanticScholarResults(input: SearchInput): Promise<SearchResult[]> {
    const url = new URL('https://api.semanticscholar.org/graph/v1/paper/search')
    url.searchParams.set('query', input.query)
    url.searchParams.set('limit', String(input.pageSize))
    url.searchParams.set('offset', String((input.page - 1) * input.pageSize))
    url.searchParams.set('fields', 'title,authors,year,venue,abstract,externalIds,openAccessPdf,url,citationCount')
    const response = await fetchWithConfiguredProxy(this.repository, url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    if (!response.ok) {
      if (response.status === 429) throw new IntegrationRuntimeError('RATE_LIMITED', 'Semantic Scholar rate limit reached')
      throw new IntegrationRuntimeError('TEMPORARILY_UNAVAILABLE', `Semantic Scholar request failed (${response.status})`)
    }
    const root = toRecord(await response.json())
    const items = root?.data
    if (!Array.isArray(items)) return []
    return items.flatMap((value, index) => {
      const item = toRecord(value)
      const title = typeof item?.title === 'string' ? item.title : ''
      if (!title) return []
      const authors = Array.isArray(item?.authors) ? item.authors.flatMap((author) => {
        const record = toRecord(author)
        return typeof record?.name === 'string' ? [record.name] : []
      }) : []
      const externalIds = toRecord(item?.externalIds)
      const doi = typeof externalIds?.DOI === 'string' ? externalIds.DOI : null
      const openAccess = toRecord(item?.openAccessPdf)
      return [this.toResult(input, typeof item?.paperId === 'string' ? item.paperId : `semantic-${index}`, {
        title,
        authors,
        year: typeof item?.year === 'number' ? item.year : null,
        venue: typeof item?.venue === 'string' ? item.venue : '',
        abstract: typeof item?.abstract === 'string' ? item.abstract : '',
        doi,
        url: typeof openAccess?.url === 'string' ? openAccess.url : typeof item?.url === 'string' ? item.url : null,
        isOpenAccess: Boolean(openAccess),
        openMetric: typeof item?.citationCount === 'number' ? item.citationCount : null
      }, doi ? 'Semantic Scholar DOI' : 'Semantic Scholar ID')]
    })
  }

  private crossrefResults(input: SearchInput, payload: unknown): SearchResult[] {
    const root = toRecord(payload)
    if (root === null) return []
    const message = toRecord(root.message)
    const items = message?.items
    if (!Array.isArray(items)) return []
    return items.flatMap((value, index) => {
      const item = toRecord(value)
      if (item === null) return []
      const titleValue = item.title
      const title = Array.isArray(titleValue) && typeof titleValue[0] === 'string' ? titleValue[0] : ''
      if (!title) return []
      const authors = Array.isArray(item.author) ? item.author.flatMap((author) => {
        const value = toRecord(author)
        if (value === null) return []
        const name = [value.given, value.family].filter((part): part is string => typeof part === 'string').join(' ')
        return name ? [name] : []
      }) : []
      const published = toRecord(item.published)
      const dateParts = published?.['date-parts']
      const firstDateParts = Array.isArray(dateParts) ? dateParts[0] : undefined
      const year = Array.isArray(firstDateParts) && typeof firstDateParts[0] === 'number' ? firstDateParts[0] : null
      const impactFactor = readExplicitImpactFactor(item)
      return [this.toResult(input, String(item.DOI ?? `crossref-${index}`), {
        title,
        authors,
        year,
        venue: Array.isArray(item['container-title']) && typeof item['container-title'][0] === 'string' ? item['container-title'][0] : '',
        abstract: typeof item.abstract === 'string' ? item.abstract.replace(/<[^>]+>/g, '') : '',
        doi: typeof item.DOI === 'string' ? item.DOI : null,
        url: typeof item.URL === 'string' ? item.URL : null,
        isOpenAccess: Array.isArray(item.link) && item.link.length > 0,
        // Crossref exposes the work-level reference count as public metadata.
        // Keep it as an open citation proxy; it is deliberately not mapped to
        // the journal impact factor field.
        openMetric: typeof item['is-referenced-by-count'] === 'number' && item['is-referenced-by-count'] >= 0
          ? item['is-referenced-by-count']
          : null,
        ...(impactFactor === null ? {} : {
          impactFactor,
          impactFactorSource: 'Crossref 元数据（提供时）',
          impactFactorFetchedAt: new Date().toISOString()
        })
      }, 'Crossref DOI / 元数据')]
    })
  }

  private openAlexResults(input: SearchInput, payload: unknown): SearchResult[] {
    const root = toRecord(payload)
    if (root === null) return []
    const raw = root.results
    if (!Array.isArray(raw)) return []
    return raw.flatMap((value, index) => {
      const item = toRecord(value)
      if (item === null) return []
      const title = typeof item.title === 'string' ? item.title : ''
      if (!title) return []
      const authors = Array.isArray(item.authorships) ? item.authorships.flatMap((author) => {
        const authorRecord = toRecord(author)
        if (authorRecord === null) return []
        const name = toRecord(authorRecord.author)
        if (name === null) return []
        const displayName = name.display_name
        return typeof displayName === 'string' ? [displayName] : []
      }) : []
      const location = toRecord(item.primary_location)
      const source = location === null ? null : toRecord(location.source)
      const openAccess = toRecord(item.open_access)
      const impactFactor = readExplicitImpactFactor(item)
      return [this.toResult(input, String(item.id ?? `openalex-${index}`), {
        title,
        authors,
        year: typeof item.publication_year === 'number' ? item.publication_year : null,
        venue: typeof source?.display_name === 'string' ? source.display_name : '',
        abstract: decodeAbstract(item.abstract_inverted_index),
        doi: typeof item.doi === 'string' ? item.doi.replace(/^https?:\/\/doi.org\//i, '') : null,
        url: typeof location?.landing_page_url === 'string' ? location.landing_page_url : null,
        isOpenAccess: typeof openAccess?.is_oa === 'boolean' ? openAccess.is_oa : null,
        openMetric: typeof item.cited_by_count === 'number' ? item.cited_by_count : null,
        ...(impactFactor === null ? {} : {
          impactFactor,
          impactFactorSource: 'OpenAlex 元数据（提供时）',
          impactFactorFetchedAt: new Date().toISOString()
        })
      }, 'OpenAlex 作品元数据')]
    })
  }

  private async googleScholarResults(input: SearchInput): Promise<SearchResult[]> {
    const proxyProfile = this.repository.listAgentProxyProfiles().find((item) => item.enabled && (item.httpProxy || item.httpsProxy))
    const response = await runScholarSidecar(input, proxyProfile?.httpsProxy ?? proxyProfile?.httpProxy ?? null)
    return response.items.map((item) => this.toResult(input, item.sourceId, {
      title: item.title,
      authors: item.authors,
      year: item.year,
      venue: item.venue,
      abstract: item.abstract,
      doi: item.doi,
      url: item.url,
      isOpenAccess: item.isOpenAccess,
      openMetric: item.openMetric
    }, 'Google Scholar'))
  }

  private toResult(
    input: SearchInput,
    sourceId: string,
    value: Omit<SearchResult, 'id' | 'sessionId' | 'source' | 'sourceId' | 'fingerprint' | 'dedupeReason' | 'dedupeConfidence'>,
    dedupeReason: string
  ): SearchResult {
    const fingerprint = createHash('sha256').update([
      value.doi ?? '', value.title.toLocaleLowerCase('en-US'), value.authors[0] ?? '', String(value.year ?? '')
    ].join('|')).digest('hex')
    return {
      id: randomUUID(),
      sessionId: '',
      source: input.source,
      sourceId,
      ...value,
      impactFactor: value.impactFactor ?? null,
      impactFactorSource: value.impactFactorSource ?? null,
      impactFactorFetchedAt: value.impactFactorFetchedAt ?? null,
      fingerprint,
      dedupeReason,
      dedupeConfidence: value.doi ? 1 : 0.65
    }
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) result[key] = entry
  return result
}

/** OpenAlex identifiers are normally full URLs (https://openalex.org/S123),
 * but fixtures and older cached responses may contain the bare S identifier.
 * Normalize both forms before joining works to their journal source metrics. */
function parseOpenAlexSourceId(value: string): string | undefined {
  const match = value.trim().match(/(?:^|\/)(S\d+)$/iu)
  return match?.[1]?.toUpperCase()
}

function normalizeDoi(value: string): string {
  return value.trim().replace(/^https?:\/\/doi\.org\//iu, '').replace(/[.,;]+$/u, '').toLocaleLowerCase('en-US')
}

/**
 * Only accept an explicitly named, numeric impact-factor field from a
 * provider. Citation counts and SJR are intentionally not converted to IF
 * because they are different metrics. OpenAlex's 2yr_mean_citedness is added
 * separately as an explicitly labelled IF-style public metric. Crossref and
 * other sources usually omit an IF field, in which case the UI shows
 * “未提供” and IF sorting keeps missing values at the end.
 */
function readExplicitImpactFactor(value: Record<string, unknown>): number | null {
  // A few provider adapters nest journal metadata under `source`, `journal`,
  // or `primary_location.source`.  Read only explicitly named IF fields from
  // those records.  Citation counts and OpenAlex citedness remain separate
  // metrics and are never promoted to an impact factor here.
  const primaryLocation = toRecord(value.primary_location)
  const records = [
    value,
    toRecord(value.journal),
    toRecord(value.source),
    primaryLocation,
    primaryLocation === null ? null : toRecord(primaryLocation.source),
  ]
  for (const record of records) {
    if (record === null) continue
    const candidate = record.impactFactor ?? record.impact_factor ?? record['journal-impact-factor']
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) return candidate
    if (typeof candidate === 'string' && /^\d+(?:\.\d+)?$/u.test(candidate.trim())) {
      const numeric = Number(candidate)
      if (Number.isFinite(numeric)) return numeric
    }
  }

  return null
}

function decodeAbstract(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const positions: Array<[number, string]> = []
  for (const [word, indexes] of Object.entries(value)) {
    if (!Array.isArray(indexes)) continue
    for (const index of indexes) if (typeof index === 'number') positions.push([index, word])
  }
  return positions.sort((left, right) => left[0] - right[0]).map(([, word]) => word).join(' ')
}

function xmlTag(value: string, tag: string): string {
  const match = value.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'))
  return match?.[1]?.trim() ?? ''
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function selectionKey(value: SelectionKey): string {
  return `${value.source}\u0000${value.sourceId}`
}

/** Staging receipts intentionally expose only structured integration or
 * external-write errors.  The generic compatibility error accepted by the
 * older Zotero route is normalized here so it cannot leak arbitrary details. */
function mapStagingZoteroError(error: ZoteroImportResult['items'][number]['error']): NonNullable<LiteratureStagingToZoteroReceipt['error']> | null {
  if (error === null) return null
  if (isExternalWriteError(error)) return error
  if (isIntegrationError(error)) return error
  return {
    code: 'INTEGRATION_VALIDATION_FAILED',
    provider: 'zotero',
    operation: 'literature.stagingToZotero.execute',
    kind: 'input',
    fields: [{ path: ['receipt'], code: error.code, message: 'Zotero 操作失败。' }],
    retryable: error.retryable,
    message: 'Zotero 操作失败，请检查连接后重试。'
  }
}

function isExternalWriteError(value: unknown): value is ExternalWriteError {
  return typeof value === 'object' && value !== null
    && 'provider' in value && 'entityKind' in value && 'externalId' in value
    && 'requiresConfirmation' in value && 'partial' in value
}

function isIntegrationError(value: unknown): value is IntegrationError {
  return typeof value === 'object' && value !== null
    && 'operation' in value && 'kind' in value && 'fields' in value
}

function redactedSearchError(error: unknown): IntegrationRuntimeError {
  if (error instanceof IntegrationRuntimeError) return error
  return new IntegrationRuntimeError('TEMPORARILY_UNAVAILABLE', '文献来源暂时不可用，请稍后重试')
}

function encodeCursor(offset: number): string {
  return `offset:${offset}`
}

function decodeCursor(cursor: string): number {
  const value = Number(cursor.startsWith('offset:') ? cursor.slice('offset:'.length) : Number.NaN)
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function encodeRemoteCursor(sessionId: string, offset: number, remotePage: number): string {
  return `remote:${encodeURIComponent(sessionId)}:${offset}:${remotePage}`
}

function decodeRemoteCursor(cursor: string): { sessionId: string; offset: number; remotePage: number } | null {
  const match = /^remote:([^:]+):(\d+):(\d+)$/.exec(cursor)
  if (!match) return null
  const sessionId = decodeURIComponent(match[1] ?? '')
  const offset = Number(match[2])
  const remotePage = Number(match[3])
  if (!sessionId || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(remotePage) || remotePage < 2) return null
  return { sessionId, offset, remotePage }
}
