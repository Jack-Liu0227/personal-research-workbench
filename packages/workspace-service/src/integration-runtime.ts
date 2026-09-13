import type {
  IntegrationProfile,
  Note,
  Paper,
  NoteListInput,
  DeleteNoteInput,
  NoteDeleteReceipt,
  DeleteNoteFolderInput,
  NoteFolderDeleteReceipt,
  CreateNoteFolderInput,
  NoteFolderCreateReceipt,
  MoveNoteInput,
  NoteMoveReceipt,
  NoteMetadataPatch,
  NoteMetadataPreview,
  NoteMetadataPreviewInput,
  NoteMetadataSummary,
  ApplyNoteMetadataInput,
  NoteDuplicateInput,
  NoteDuplicateReport,
  ObsidianLayoutKind,
  ReadNoteInput,
  SyncRun,
  WriteNoteInput,
  ZoteroCollection,
  ZoteroItem,
  ZoteroCollectionPage,
  ZoteroCollectionPageInput,
  ZoteroItemPage,
  ZoteroItemPageInput,
  ZoteroCapabilityStatus,
  PaperImportFromZoteroInput,
  PaperImportReceipt,
  ZoteroImportPreviewInput,
  ZoteroImportPreview,
  ZoteroImportExecuteInput,
  ZoteroImportResult,
  ZoteroCollectionWrite,
  ZoteroHandoff,
  PaperToZoteroPreviewInput,
  PaperToZoteroPreview,
  ZoteroImportFormat,
  ZoteroImportTransport,
  ZoteroBibtexExportInput,
  ZoteroBibtexExport,
  ZoteroRemoteDeletePreviewInput,
  ZoteroRemoteDeletePreview,
  ZoteroRemoteDeleteExecuteInput,
  ZoteroRemoteDeleteReceipt,
  ZoteroRemoteDeleteItemReceipt,
  ZoteroDeleteTarget,
  ObsidianIndexStatus,
  ObsidianLayoutPlan,
  ObsidianLayoutReceipt,
  ObsidianVaultLayoutPlan,
  ObsidianVaultLayoutReceipt
} from '@prw/contracts'
import { randomUUID } from 'node:crypto'
import {
  ProjectIdSchema,
  PaperIdSchema,
  ZoteroCapabilityStatusSchema,
  ZoteroCollectionPageInputSchema,
  ZoteroCollectionPageSchema,
  ZoteroItemPageInputSchema,
  ZoteroImportPreviewInputSchema,
  ZoteroImportExecuteInputSchema,
  PaperToZoteroPreviewInputSchema,
  ZoteroImportPreviewSchema,
  ZoteroImportResultSchema,
  ZoteroHandoffSchema,
  ZoteroRemoteDeletePreviewSchema,
  ZoteroRemoteDeleteReceiptSchema,
  PaperImportReceiptSchema,
  PaperSchema,
  ZoteroImportTransportSchema,
  ZoteroImportFormatSchema,
  ZoteroBibtexExportInputSchema,
  ZoteroBibtexExportSchema,
  IdSchema,
  ObsidianIndexStatusSchema,
  ObsidianLayoutPlanSchema,
  ObsidianLayoutReceiptSchema,
  ObsidianVaultLayoutPlanSchema,
  ObsidianVaultLayoutReceiptSchema
} from '@prw/contracts'
import type { WorkbenchRepository } from '@prw/database'
import {
  IntegrationRuntimeError,
  deleteZoteroRemoteItems,
  readZoteroRemoteItems,
  zoteroDeleteRemovedRemotely,
  ZOTERO_DELETE_ABSENT_MESSAGE,
  ZOTERO_DELETE_UNAVAILABLE_MESSAGE,
  assertObsidianVault,
  createObsidianLayoutFileSystem,
  inspectObsidianPaths,
  probeIntegration,
  probeObsidian,
  zoteroWriteBlockedMessage,
  pullIntegration,
  pullZotero,
  listZoteroCollections as fetchZoteroCollections,
  authorizeZotero,
  listObsidianNotes,
  readObsidianNote,
  snapshotObsidianRoot,
  writeNotionProjection,
  writeObsidianNote,
  deleteObsidianNote,
  deleteObsidianFolder,
  createObsidianFolder,
  moveObsidianEntry,
  writeObsidianProjection,
  createZoteroProjection,
  exportZoteroBibtex,
  writeZoteroProjection,
  type AdapterProfile,
  type ObsidianNote,
  type ManagedProjection,
  type ProjectionReceipt,
  type NormalizedExternalPaper
} from '@prw/connectors'
import { RedactedExternalError } from './errors.js'
import {
  initializeObsidianLayout as applyObsidianLayout,
  initializeObsidianVaultLayout as applyObsidianVaultLayout,
  buildLayoutPlan,
  previewObsidianVaultLayout as previewVaultLayout,
  ObsidianLayoutError,
  parseObsidianFrontmatter,
  updateManagedFrontmatter,
  type ManagedFrontmatterPatch,
  type LayoutPlan as InternalLayoutPlan,
  type LayoutReceipt as InternalLayoutReceipt,
  type VaultLayoutPlan as InternalVaultLayoutPlan,
  type VaultLayoutReceipt as InternalVaultLayoutReceipt
} from './obsidian-layout.js'

export interface IntegrationOperationInput {
  readonly id: string
  readonly secret: string | null
}

export interface IntegrationSyncInput extends IntegrationOperationInput {
  readonly direction: SyncRun['direction']
}

/** Optional migration-era note-index hooks are typed explicitly so the V2
 * service does not need an untyped repository escape hatch. */
type NoteIndexRepository = WorkbenchRepository & {
  readonly reconcileNoteIndex?: (profileId: string, entries: readonly unknown[], scanToken: string) => unknown
  readonly getNoteIndexStatus?: (profileId: string) => { status: 'ready' | 'changed' | 'error' | 'not_configured' | 'unavailable'; indexedAt: string | null; noteCount?: number; error?: unknown }
}

type StoredObsidianLayoutPlan = {
  readonly profileId: string
  readonly profileRevision: number
  readonly plan: InternalLayoutPlan
}
type StoredObsidianVaultLayoutPlan = {
  readonly profileId: string
  readonly profileRevision: number
  readonly plan: InternalVaultLayoutPlan
}

type ObsidianScanState = {
  readonly profileRevision: number
  readonly scanToken: string
  readonly indexedAt: string
  readonly noteCount: number
}

type ObsidianNoteIndexCache = {
  readonly profileRevision: number
  readonly fetchedAt: number
  readonly notes: Note[]
  readonly promise?: Promise<Note[]>
}

/** Zotero's `start` parameter is an offset, while the public API exposes an
 * opaque cursor. Prefixing and validating it here keeps the renderer from
 * depending on connector-specific pagination details. */
function filterObsidianNotes(notes: readonly Note[], query: string): Note[] {
  const normalized = query.trim().toLocaleLowerCase('en-US')
  if (!normalized) return [...notes]
  return notes.filter((note) => `${note.relativePath} ${note.title} ${note.tags.join(' ')}`.toLocaleLowerCase('en-US').includes(normalized))
}

function encodeZoteroItemCursor(start: number): string { return `offset:${start}` }
function decodeZoteroItemCursor(cursor: string | null | undefined): number {
  if (cursor === undefined || cursor === null || cursor.trim() === '') return 0
  const raw = cursor.startsWith('offset:') ? cursor.slice('offset:'.length) : cursor
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Zotero items cursor 无效')
  return value
}

type StoredZoteroPreview = {
  readonly profileId: string
  readonly paperIds: string[]
  readonly itemKeys: string[]
  readonly targetCollectionKey: string | null
  readonly format: ZoteroImportFormat
  readonly transport: ZoteroImportTransport
  /** Local project binding for the Zotero -> Workbench direction. */
  readonly projectId: string | null
  /** True only when the caller explicitly froze a top-level project
   * classification for a Paper -> Zotero write (including `null` = 未分类).
   * When false the automatic tag follows each Paper's own project binding. */
  readonly projectClassification: boolean
  readonly tags: string[]
  readonly direction: 'from-zotero' | 'to-zotero'
  /** Integration profile revision the preview was frozen against. */
  readonly profileRevision: number
  /** Per-Paper frozen identity.  `target: null` means the preview decided to
   * create a new Zotero item; a value means the preview matched an existing
   * remote item (stable external ID, DOI or URL) and the confirmed write must
   * update exactly that item and revision.  `decision: 'review'` blocks the
   * write because the preview could not prove whether a duplicate exists. */
  readonly frozenTargets: Array<{
    readonly decision: 'create' | 'update-candidate' | 'review'
    readonly target: { itemKey: string; locator: string | null; remoteRevision: string | null } | null
    readonly note: string | null
  }>
}

export class IntegrationCoordinator {
  private readonly zoteroPreviews = new Map<string, StoredZoteroPreview>()
  /** Preview plans are private because they contain validated absolute paths. */
  private readonly obsidianLayoutPlans = new Map<string, StoredObsidianLayoutPlan>()
  private readonly obsidianVaultLayoutPlans = new Map<string, StoredObsidianVaultLayoutPlan>()
  private readonly obsidianScans = new Map<string, ObsidianScanState>()
  private readonly obsidianNoteIndexes = new Map<string, ObsidianNoteIndexCache>()

  constructor(private readonly repository: NoteIndexRepository) {}

  /** Return only Obsidian profiles; credentials and absolute roots stay in Main. */
  listObsidianProfiles(): IntegrationProfile[] {
    return this.repository.listIntegrationProfiles().filter((profile) => profile.provider === 'obsidian')
  }

  getObsidianProfile(profileId: string): IntegrationProfile {
    const profile = this.repository.getIntegrationProfile(profileId)
    if (profile.provider !== 'obsidian') throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', '该配置不是 Obsidian Vault')
    return profile
  }

  async validateObsidianProfile(input: { vaultRoot: string; includeFolders?: string[]; excludeFolders?: string[] }): Promise<{ valid: boolean; message: string; capabilities: { read: boolean; write: boolean } }> {
    const probe = await probeObsidian({ provider: 'obsidian', location: input.vaultRoot, settings: { includeFolders: JSON.stringify(input.includeFolders ?? []), excludeFolders: JSON.stringify(input.excludeFolders ?? []) } })
    return { valid: probe.ok, message: probe.message, capabilities: { read: probe.capabilities.read, write: probe.capabilities.write } }
  }

  saveObsidianProfile(input: { id?: string; name: string; location: string; enabled?: boolean; settings?: Record<string, string | number | boolean | null>; expectedRevision: number | null }): IntegrationProfile {
    const parsed = { provider: 'obsidian' as const, name: input.name, location: input.location, enabled: input.enabled ?? true, settings: input.settings ?? {}, ...(input.id === undefined ? {} : { id: input.id }), expectedRevision: input.expectedRevision }
    return this.repository.saveIntegrationProfile(parsed, false)
  }

  async obsidianIndex(profileId: string, query = ''): Promise<Note[]> {
    const profile = this.getObsidianProfile(profileId)
    const current = this.obsidianNoteIndexes.get(profile.id)
    const now = Date.now()
    if (current?.profileRevision === profile.revision && current.promise) return filterObsidianNotes(await current.promise, query)
    if (current?.profileRevision === profile.revision && now - current.fetchedAt < 10_000) return filterObsidianNotes(current.notes, query)
    const promise = (async () => {
      const notes = await listObsidianNotes(toAdapterProfile(profile, null))
      const mapped = notes.map((note) => ({ ...note, id: `${profile.id}:${note.relativePath}`, vaultId: profile.id }))
      // Markdown bodies remain connector-owned and are never stored in SQLite.
      const scanToken = notes.map((note) => `${note.relativePath}:${note.fingerprint}`).join('|')
      const indexedAt = new Date().toISOString()
      this.obsidianScans.set(profile.id, { profileRevision: profile.revision, scanToken, indexedAt, noteCount: notes.length })
      this.repository.reconcileNoteIndex?.(profile.id, notes, scanToken)
      this.obsidianNoteIndexes.set(profile.id, { profileRevision: profile.revision, fetchedAt: Date.now(), notes: mapped })
      return mapped
    })()
    this.obsidianNoteIndexes.set(profile.id, { profileRevision: profile.revision, fetchedAt: now, notes: current?.notes ?? [], promise })
    try { return filterObsidianNotes(await promise, query) } catch (error) {
      this.obsidianNoteIndexes.delete(profile.id)
      throw error
    }
  }

  private invalidateObsidianIndex(profileId: string): void {
    this.obsidianNoteIndexes.delete(profileId)
  }

  async obsidianIndexStatus(profileId: string): Promise<ObsidianIndexStatus> {
    const profile = this.getObsidianProfile(profileId)
    if (!profile.enabled || !profile.location.trim()) {
      return ObsidianIndexStatusSchema.parse({ profileId: profile.id, status: 'not_configured', indexedAt: null, noteCount: 0 })
    }
    const stored = this.repository.getNoteIndexStatus?.(profileId)
    if (stored !== undefined && stored.status !== 'unavailable') {
      return ObsidianIndexStatusSchema.parse({
        profileId: profile.id,
        status: stored.status,
        indexedAt: stored.indexedAt,
        noteCount: stored.noteCount ?? 0,
        ...(stored.error === undefined ? {} : { error: layoutStatusError(stored.error) })
      })
    }
    try {
      // A status query performs a real connector scan. It never reports ready
      // merely because a profile exists in SQLite.
      await assertObsidianVault(toAdapterProfile(profile, null))
      const notes = await listObsidianNotes(toAdapterProfile(profile, null))
      const scanToken = notes.map((note) => `${note.relativePath}:${note.fingerprint}`).join('|')
      const previous = this.obsidianScans.get(profile.id)
      const indexedAt = previous?.indexedAt ?? new Date().toISOString()
      const status = previous !== undefined && (previous.profileRevision !== profile.revision || previous.scanToken !== scanToken) ? 'changed' : 'ready'
      this.obsidianScans.set(profile.id, { profileRevision: profile.revision, scanToken, indexedAt, noteCount: notes.length })
      return ObsidianIndexStatusSchema.parse({ profileId: profile.id, status, indexedAt, noteCount: notes.length })
    } catch (error) {
      return ObsidianIndexStatusSchema.parse({ profileId: profile.id, status: 'error', indexedAt: null, noteCount: 0, error: layoutStatusError(error) })
    }
  }

  async previewObsidianLayout(input: { profileId: string; projectId: string; displayName: string }): Promise<ObsidianLayoutPlan> {
    const profile = this.getObsidianProfile(input.profileId)
    if (!profile.enabled) throw new IntegrationRuntimeError('NOT_CONNECTED', 'Obsidian profile is disabled.')
    await assertLayoutVault(toAdapterProfile(profile, null))
    let rootEntries: Awaited<ReturnType<typeof snapshotObsidianRoot>>
    try {
      rootEntries = await snapshotObsidianRoot(toAdapterProfile(profile, null))
    } catch (error) {
      throw new ObsidianLayoutError(layoutErrorCode(error), redactLayoutMessage(error))
    }
    const plan = buildLayoutPlan({ vaultRoot: profile.location, projectId: ProjectIdSchema.parse(input.projectId), displayName: input.displayName.trim(), existingEntries: rootEntries })
    if (plan.collision?.existingKind === 'symlink') throw new ObsidianLayoutError('SYMLINK_REJECTED', 'Obsidian project directory contains a symbolic link or junction.')
    if (plan.collision?.existingKind === 'directory') {
      let paths: Awaited<ReturnType<typeof inspectObsidianPaths>>
      try {
        paths = await inspectObsidianPaths(toAdapterProfile(profile, null), plan.relativePaths)
      } catch (error) {
        throw new ObsidianLayoutError(layoutErrorCode(error), redactLayoutMessage(error))
      }
      const categoryPaths = new Set(plan.categories.map((category) => category.relativePath))
      for (const path of paths) {
        if (path.kind === 'symlink') throw new ObsidianLayoutError('SYMLINK_REJECTED', 'Obsidian layout path contains a symbolic link or junction.')
        if (categoryPaths.has(path.name) && path.kind !== 'directory' && path.kind !== 'missing') throw new ObsidianLayoutError('WRITE_FAILED', 'Obsidian layout category path is not a directory.')
        if (path.name === plan.readmeRelativePath && path.kind !== 'missing' && path.kind !== 'file') throw new ObsidianLayoutError('NON_MARKDOWN', 'README.md target is not a regular Markdown file.')
      }
    }
    const publicPlan = mapLayoutPlan(plan, profile.id)
    ObsidianLayoutPlanSchema.parse(publicPlan)
    this.obsidianLayoutPlans.set(plan.planId, { profileId: profile.id, profileRevision: profile.revision, plan })
    return publicPlan
  }

  async initializeObsidianLayout(input: { profileId: string; projectId: string; displayName: string; planId: string; expectedRevision: number; confirmed: true; choice?: 'bind' | 'create' | 'cancel' | undefined }): Promise<ObsidianLayoutReceipt> {
    if (input.confirmed !== true) throw new ObsidianLayoutError('CONFIRMATION_REQUIRED', 'Obsidian layout initialization requires explicit confirmation.')
    const stored = this.obsidianLayoutPlans.get(input.planId)
    // Consume the plan before doing any I/O: plan IDs are one-use even when a
    // collision or filesystem error forces the user to preview again.
    this.obsidianLayoutPlans.delete(input.planId)
    if (stored === undefined) throw new IntegrationRuntimeError('NOT_FOUND', 'Obsidian layout preview is missing or already used.')
    const profile = this.getObsidianProfile(input.profileId)
    if (stored.profileId !== profile.id || stored.plan.projectId !== input.projectId || stored.plan.displayName !== input.displayName) {
      throw new ObsidianLayoutError('COLLISION_CHANGED', 'Obsidian layout preview does not match the current request.')
    }
    if (input.expectedRevision !== profile.revision || stored.profileRevision !== profile.revision) {
      throw new ObsidianLayoutError('COLLISION_CHANGED', 'Obsidian profile changed; preview the layout again.')
    }
    if (!profile.enabled) throw new IntegrationRuntimeError('NOT_CONNECTED', 'Obsidian profile is disabled.')
    await assertLayoutVault(toAdapterProfile(profile, null))
    const connectorFs = await createObsidianLayoutFileSystem(toAdapterProfile(profile, null))
    const receipt = await applyObsidianLayout(stored.plan, { confirmed: true, profileId: profile.id, fs: connectorFs, ...(input.choice === undefined ? {} : { choice: input.choice }) })
    const publicReceipt = mapLayoutReceipt(receipt, profile.id)
    ObsidianLayoutReceiptSchema.parse(publicReceipt)
    return publicReceipt
  }

  async previewObsidianVaultLayout(input: { profileId: string; categories?: readonly string[] }): Promise<ObsidianVaultLayoutPlan> {
    const profile = this.getObsidianProfile(input.profileId)
    if (!profile.enabled) throw new IntegrationRuntimeError('NOT_CONNECTED', 'Obsidian profile is disabled.')
    await assertLayoutVault(toAdapterProfile(profile, null))
    let plan: InternalVaultLayoutPlan
    try {
      plan = await previewVaultLayout({ vaultRoot: profile.location, profileId: profile.id, ...(input.categories === undefined ? {} : { categories: input.categories }) })
    } catch (error) {
      throw new ObsidianLayoutError(layoutErrorCode(error), redactLayoutMessage(error))
    }
    const publicPlan = ObsidianVaultLayoutPlanSchema.parse({
      planId: plan.planId,
      profileId: profile.id,
      categories: plan.categories.map(({ absolutePath: _absolutePath, ...category }) => category),
      readmeRelativePath: plan.readmeRelativePath,
      relativePaths: plan.relativePaths,
      existingPaths: plan.existingPaths,
      requiresConfirmation: true
    })
    this.obsidianVaultLayoutPlans.set(plan.planId, { profileId: profile.id, profileRevision: profile.revision, plan })
    return publicPlan
  }

  async initializeObsidianVaultLayout(input: { profileId: string; planId: string; expectedRevision: number; confirmed: true }): Promise<ObsidianVaultLayoutReceipt> {
    if (input.confirmed !== true) throw new ObsidianLayoutError('CONFIRMATION_REQUIRED', '初始化 Vault 布局需要明确确认')
    const stored = this.obsidianVaultLayoutPlans.get(input.planId)
    this.obsidianVaultLayoutPlans.delete(input.planId)
    if (stored === undefined) throw new IntegrationRuntimeError('NOT_FOUND', 'Obsidian Vault 布局预览不存在或已使用')
    const profile = this.getObsidianProfile(input.profileId)
    if (stored.profileId !== profile.id || stored.profileRevision !== profile.revision || input.expectedRevision !== profile.revision) {
      throw new ObsidianLayoutError('COLLISION_CHANGED', 'Obsidian profile changed; preview the Vault layout again.')
    }
    if (!profile.enabled) throw new IntegrationRuntimeError('NOT_CONNECTED', 'Obsidian profile is disabled.')
    await assertLayoutVault(toAdapterProfile(profile, null))
    const connectorFs = await createObsidianLayoutFileSystem(toAdapterProfile(profile, null))
    const receipt = await applyObsidianVaultLayout(stored.plan, { confirmed: true, fs: connectorFs })
    const publicReceipt = ObsidianVaultLayoutReceiptSchema.parse({ ...receipt, profileId: profile.id })
    return publicReceipt
  }

  async zoteroCapability(profileId: string, secret: string | null = null): Promise<ZoteroCapabilityStatus> {
    const profile = this.repository.getIntegrationProfile(profileId)
    if (profile.provider !== 'zotero') throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', '该配置不是 Zotero Library')
    const checkedAt = new Date().toISOString()
    if (!profile.enabled) return ZoteroCapabilityStatusSchema.parse({ status: 'not_configured', capability: { read: false, write: false }, checkedAt })
    try {
      const probe = await probeIntegration(toAdapterProfile(profile, secret))
      // The adapter now reports the exact cause of a read-only connection, so the
      // status no longer has to be guessed from human-readable prose.
      return ZoteroCapabilityStatusSchema.parse({
        status: probe.ok ? 'connected' : 'unavailable',
        capability: { read: probe.capabilities.read, write: probe.capabilities.write },
        writeBlockedReason: probe.capabilities.write ? null : probe.writeBlockedReason ?? null,
        checkedAt
      })
    } catch (error) {
      const code = error instanceof IntegrationRuntimeError ? error.code : ''
      const status = code === 'AUTH_REQUIRED' || code === 'PERMISSION_DENIED'
        ? 'unauthorized'
        : code === 'RATE_LIMITED'
          ? 'rate_limited'
          : code === 'NOT_CONNECTED'
            ? 'offline'
            : code === 'UNSUPPORTED_CAPABILITY'
              ? 'unsupported'
              : 'unavailable'
      return ZoteroCapabilityStatusSchema.parse({ status, capability: { read: false, write: false }, writeBlockedReason: 'probe-failed', checkedAt })
    }
  }

  /**
   * Record how the user answered Zotero's authorization dialog.  The mode itself
   * is not a secret ("one-time" or "persistent"), but it decides whether the
   * zero-effect write check may run: Zotero consumes a one-time key on the first
   * write that validates it, so an unrecorded mode has to be treated as unknown
   * rather than assumed persistent.
   */
  private recordZoteroLocalKeyMode(profile: IntegrationProfile, persistent: boolean): void {
    try {
      this.repository.saveIntegrationProfile({
        id: profile.id,
        provider: profile.provider,
        name: profile.name,
        enabled: profile.enabled,
        location: profile.location,
        settings: { ...profile.settings, zoteroLocalKeyPersistent: persistent },
        expectedRevision: profile.revision
      })
    } catch {
      // The authorization itself already succeeded and the key is owned by
      // Main; losing the recorded mode only downgrades the next probe to
      // `key-unverified`, which asks the user to authorize again.  It must never
      // turn a granted authorization into an unactionable error.
    }
  }

  /**
   * Freeze exactly what a two-sided Zotero deletion would touch.
   *
   * The remote revision of every selected item is read from Zotero now and
   * reported back, so the confirmation step is bound to real versions rather
   * than to whatever the Renderer had cached.  Items whose version cannot be
   * read are listed as `unavailable` instead of being silently dropped, and a
   * missing/one-time local key is reported as `writeBlockedReason` while the
   * entry itself stays visible.
   */
  async previewZoteroRemoteDelete(input: ZoteroRemoteDeletePreviewInput, secret: string | null = null): Promise<ZoteroRemoteDeletePreview> {
    const profile = this.repository.getIntegrationProfile(input.profileId)
    if (profile.provider !== 'zotero') throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', '该配置不是 Zotero Library')
    const itemKeys = [...new Set(input.itemKeys.map((key) => key.trim()).filter(Boolean))]
    if (itemKeys.length === 0) throw new IntegrationRuntimeError('INVALID_MAPPING', '至少选择一个 Zotero 条目后再请求删除。')
    if (!profile.enabled) throw new IntegrationRuntimeError('NOT_CONNECTED', 'Zotero 连接已停用。')
    const capability = await this.zoteroCapability(profile.id, secret)
    const read = await readZoteroRemoteItems(toAdapterProfile(profile, secret), itemKeys)
    const targets: ZoteroDeleteTarget[] = []
    for (const item of read.items) {
      const link = this.repository.findExternalPaperLink(profile.id, item.itemKey)
      const paper = link === null ? null : this.repository.getPapersByIds([link.entityId])[0] ?? null
      targets.push({
        itemKey: item.itemKey,
        remoteRevision: item.version,
        paperId: paper?.id ?? null,
        title: item.title ?? paper?.title ?? null,
        localRevision: paper?.revision ?? null
      })
    }
    const blockedReason = capability.capability.write ? null : capability.writeBlockedReason ?? 'probe-failed'
    if (targets.length === 0) {
      throw new IntegrationRuntimeError('NOT_FOUND', read.unavailable[0]?.message ?? '没有可删除的 Zotero 条目。')
    }
    return ZoteroRemoteDeletePreviewSchema.parse({
      profileId: profile.id,
      profileRevision: profile.revision,
      targets,
      unavailable: read.unavailable,
      writeBlockedReason: blockedReason,
      message: blockedReason === null
        ? `已冻结 ${targets.length} 个 Zotero 条目的远端版本；确认后会先删除 Zotero 远端条目，成功后再删除本地投影。`
        : `${zoteroWriteBlockedMessage(blockedReason)}本次不会向 Zotero 发送删除请求。`
    })
  }

  /**
   * Two-sided delete: Zotero first, local projection second.
   *
   * Every target is deleted with the frozen revision as an
   * `If-Unmodified-Since-Version` precondition, so Zotero itself refuses a stale
   * delete (`412`) or a missing item (`404`).  Only a confirmed `deleted` or
   * `absent` outcome removes the local projection; every other outcome keeps the
   * local Paper and link and is reported per item with a retry flag.
   */
  async executeZoteroRemoteDelete(input: ZoteroRemoteDeleteExecuteInput, secret: string | null = null): Promise<ZoteroRemoteDeleteReceipt> {
    const profile = this.repository.getIntegrationProfile(input.profileId)
    if (profile.provider !== 'zotero') throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', '该配置不是 Zotero Library')
    if (profile.revision !== input.expectedProfileRevision) {
      throw new IntegrationRuntimeError('REVISION_CONFLICT', 'Zotero 连接配置已变更，请重新预览后再确认删除。')
    }
    if (!profile.enabled) throw new IntegrationRuntimeError('NOT_CONNECTED', 'Zotero 连接已停用。')
    const targets: ZoteroDeleteTarget[] = []
    const seen = new Set<string>()
    for (const target of input.targets) {
      const itemKey = target.itemKey.trim()
      if (seen.has(itemKey)) continue
      seen.add(itemKey)
      targets.push({ ...target, itemKey })
    }
    const capability = await this.zoteroCapability(profile.id, secret)
    if (!capability.capability.write) {
      const reason = capability.writeBlockedReason ?? 'probe-failed'
      const message = `${zoteroWriteBlockedMessage(reason)}远端条目仍然存在，本地记录也保留。`
      return ZoteroRemoteDeleteReceiptSchema.parse({
        profileId: profile.id,
        status: 'blocked',
        remoteDeletedCount: 0,
        localRemovedCount: 0,
        items: targets.map((target) => ({
          itemKey: target.itemKey,
          remote: reason === 'authorization-denied' ? 'forbidden' : reason === 'rate-limited' ? 'rate-limited' : 'unauthorized',
          remoteVersion: null,
          local: 'kept',
          paperId: target.paperId,
          title: target.title,
          message,
          retryable: true
        })),
        message
      })
    }
    const { outcomes } = await deleteZoteroRemoteItems(toAdapterProfile(profile, secret), targets.map((target) => ({ itemKey: target.itemKey, remoteRevision: target.remoteRevision })))
    const byKey = new Map(outcomes.map((outcome) => [outcome.itemKey, outcome]))
    const items: ZoteroRemoteDeleteItemReceipt[] = []
    for (const target of targets) {
      const outcome = byKey.get(target.itemKey)
      const remote = outcome?.status ?? 'unavailable'
      let local: 'removed' | 'kept' | 'no-local-record' = 'kept'
      let message = outcome?.message ?? ZOTERO_DELETE_UNAVAILABLE_MESSAGE
      if (zoteroDeleteRemovedRemotely(remote)) {
        const removed = this.repository.removeExternalPaperProjection({ profileId: profile.id, externalId: target.itemKey })
        local = removed.linksRemoved > 0 || removed.archivedPaperId !== null ? 'removed' : 'no-local-record'
        if (local === 'removed' && remote === 'absent') {
          message = `${ZOTERO_DELETE_ABSENT_MESSAGE}本地投影已删除。`
        }
      } else {
        message = `${message}本地记录未删除。`
      }
      items.push({
        itemKey: target.itemKey,
        remote,
        remoteVersion: outcome?.remoteVersion ?? null,
        local,
        paperId: target.paperId,
        title: target.title,
        message,
        retryable: outcome?.retryable ?? true
      })
    }
    const remoteDeletedCount = items.filter((item) => item.remote === 'deleted').length
    const localRemovedCount = items.filter((item) => item.local === 'removed').length
    const stillRemote = items.filter((item) => item.remote !== 'deleted' && item.remote !== 'absent').length
    return ZoteroRemoteDeleteReceiptSchema.parse({
      profileId: profile.id,
      status: stillRemote === 0 ? 'completed' : remoteDeletedCount === 0 ? 'blocked' : 'partial',
      remoteDeletedCount,
      localRemovedCount,
      items,
      message: stillRemote === 0
        ? `Zotero 已删除 ${remoteDeletedCount} 个条目，本地删除 ${localRemovedCount} 个投影。`
        : remoteDeletedCount === 0
          ? `Zotero 未删除任何条目（${stillRemote} 个条目仍然存在于远端），因此本地记录全部保留。`
          : `部分完成：Zotero 删除 ${remoteDeletedCount} 个条目，另有 ${stillRemote} 个条目仍然存在于远端，其本地记录已保留。`
    })
  }

  async authorizeZotero(profileId: string, secret: string | null = null): Promise<{ profileId: string; key: string; remember: boolean }> {
    const profile = this.repository.getIntegrationProfile(profileId)
    if (profile.provider !== 'zotero') throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', '该配置不是 Zotero Library')
    const authorization = await authorizeZotero(toAdapterProfile(profile, secret))
    // `remember === false` means the user picked "Allow" (one-time).  Zotero
    // deletes that key as soon as any write validates it, so the mode has to be
    // persisted here: it is the only way a later probe can tell the user that a
    // multi-item import cannot work with this key.
    this.recordZoteroLocalKeyMode(profile, authorization.remember)
    return { profileId: profile.id, key: authorization.key, remember: authorization.remember }
  }

  async test(input: IntegrationOperationInput): Promise<{ ok: boolean; message: string }> {
    const profile = this.repository.getIntegrationProfile(input.id)
    if (!profile.enabled) {
      return { ok: false, message: 'Integration is disabled. Enable it before testing.' }
    }
    try {
      const probe = await probeIntegration(toAdapterProfile(profile, input.secret))
      const message = redactIntegrationSecret(probe.message, input.secret)
      this.repository.updateIntegrationStatus({
        id: profile.id,
        status: probe.ok ? 'ready' : 'error',
        lastError: probe.ok ? null : message,
        expectedRevision: profile.revision
      })
      return { ok: probe.ok, message }
    } catch (error) {
      const message = safeIntegrationMessage(error, input.secret)
      const latest = this.repository.getIntegrationProfile(profile.id)
      this.repository.updateIntegrationStatus({
        id: latest.id,
        status: 'error',
        lastError: message,
        expectedRevision: latest.revision
      })
      return { ok: false, message }
    }
  }

  async listNotes(input: NoteListInput): Promise<Note[]> {
    const profile = this.repository.getIntegrationProfile(input.vaultId)
    if (profile.provider !== 'obsidian') throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', '该配置不是 Obsidian Vault')
    return this.obsidianIndex(profile.id, input.query)
  }

  async readNote(input: ReadNoteInput): Promise<Note> {
    const profile = this.repository.getIntegrationProfile(input.vaultId)
    if (profile.provider !== 'obsidian') throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', '该配置不是 Obsidian Vault')
    const note = await readObsidianNote(toAdapterProfile(profile, null), input.relativePath)
    return projectObsidianNote(profile.id, note)
  }

  async writeNote(input: WriteNoteInput): Promise<Note> {
    const profile = this.repository.getIntegrationProfile(input.vaultId)
    if (profile.provider !== 'obsidian') throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', '该配置不是 Obsidian Vault')
    try {
      const note = await writeObsidianNote(toAdapterProfile(profile, null), input.relativePath, input.content, input.expectedFingerprint)
      this.invalidateObsidianIndex(profile.id)
      return projectObsidianNote(profile.id, note)
    } catch (error) {
      throw toExternalError(profile.provider, 'note', `${profile.id}:note`, null, error)
    }
  }

  async deleteNote(input: DeleteNoteInput): Promise<NoteDeleteReceipt> {
    const profile = this.repository.getIntegrationProfile(input.vaultId)
    if (profile.provider !== 'obsidian') throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', '当前配置不是 Obsidian Vault')
    try {
      const receipt = await deleteObsidianNote(toAdapterProfile(profile, null), input.relativePath, input.expectedFingerprint)
      this.invalidateObsidianIndex(profile.id)
      return { ...receipt, vaultId: profile.id }
    } catch (error) {
      throw toExternalError(profile.provider, 'note', `${profile.id}:note`, null, error)
    }
  }

  async deleteNoteFolder(input: DeleteNoteFolderInput): Promise<NoteFolderDeleteReceipt> {
    const profile = this.repository.getIntegrationProfile(input.vaultId)
    if (profile.provider !== 'obsidian') throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', '当前配置不是 Obsidian Vault')
    try {
      const receipt = await deleteObsidianFolder(toAdapterProfile(profile, null), input.relativePath)
      this.invalidateObsidianIndex(profile.id)
      return { ...receipt, vaultId: profile.id }
    } catch (error) {
      throw toExternalError(profile.provider, 'note', `${profile.id}:folder:${input.relativePath}`, null, error)
    }
  }

  /** Controlled root/nested folder creation for authoring new categories. */
  async createNoteFolder(input: CreateNoteFolderInput): Promise<NoteFolderCreateReceipt> {
    const profile = this.requireObsidianProfile(input.vaultId)
    try {
      const receipt = await createObsidianFolder(toAdapterProfile(profile, null), input.relativePath)
      if (receipt.status === 'created') this.invalidateObsidianIndex(profile.id)
      return { ...receipt, vaultId: profile.id }
    } catch (error) {
      throw toExternalError(profile.provider, 'note', `${profile.id}:folder:${input.relativePath}`, null, error)
    }
  }

  /** Rename/move a note or a root-level category; never overwrites a target. */
  async moveNote(input: MoveNoteInput): Promise<NoteMoveReceipt> {
    const profile = this.requireObsidianProfile(input.vaultId)
    try {
      const receipt = await moveObsidianEntry(
        toAdapterProfile(profile, null),
        input.kind,
        input.fromRelativePath,
        input.toRelativePath,
        input.expectedFingerprint
      )
      this.invalidateObsidianIndex(profile.id)
      return { ...receipt, vaultId: profile.id }
    } catch (error) {
      throw toExternalError(profile.provider, 'note', `${profile.id}:${input.fromRelativePath}`, null, error)
    }
  }

  /**
   * Compute the controlled frontmatter change without writing.  The renderer
   * shows this diff (changed fields, preserved unknown fields, warnings) before
   * anything touches the user's file.
   */
  async previewNoteMetadata(input: NoteMetadataPreviewInput): Promise<NoteMetadataPreview> {
    const profile = this.requireObsidianProfile(input.vaultId)
    try {
      const note = await readObsidianNote(toAdapterProfile(profile, null), input.relativePath)
      return buildNoteMetadataPreview(profile.id, input.relativePath, note, input.patch)
    } catch (error) {
      throw toExternalError(profile.provider, 'note', `${profile.id}:${input.relativePath}`, null, error)
    }
  }

  /**
   * Apply a previewed frontmatter patch through the connector's CAS write, so
   * an external Obsidian/editor edit surfaces as a conflict instead of being
   * silently overwritten.  Only managed keys change; unknown fields and the
   * body are preserved by `updateManagedFrontmatter`.
   */
  async applyNoteMetadata(input: ApplyNoteMetadataInput): Promise<Note> {
    const profile = this.requireObsidianProfile(input.vaultId)
    try {
      const adapter = toAdapterProfile(profile, null)
      const current = await readObsidianNote(adapter, input.relativePath)
      if (current.fingerprint !== input.expectedFingerprint) {
        throw new IntegrationRuntimeError('REVISION_CONFLICT', 'Obsidian 笔记已在外部更新，元数据未写入')
      }
      const next = updateManagedFrontmatter(current.content ?? '', toManagedFrontmatterPatch(input.patch))
      const note = await writeObsidianNote(adapter, input.relativePath, next, input.expectedFingerprint)
      this.invalidateObsidianIndex(profile.id)
      return projectObsidianNote(profile.id, note)
    } catch (error) {
      throw toExternalError(profile.provider, 'note', `${profile.id}:${input.relativePath}`, null, error)
    }
  }

  /**
   * Conservative duplicate probe: only an exact path match or a normalized
   * title match is reported, and an existing target is returned with its
   * fingerprint so the caller can offer "update" instead of overwriting.
   */
  async noteDuplicates(input: NoteDuplicateInput): Promise<NoteDuplicateReport> {
    const profile = this.requireObsidianProfile(input.vaultId)
    try {
      const notes = await this.obsidianIndex(profile.id, '')
      const requestedTitle = normalizeNoteTitle(input.title ?? noteTitleFromPath(input.relativePath))
      const candidates = notes
        .filter((note) => note.isFolder !== true)
        .map((note) => ({ note, title: normalizeNoteTitle(note.title) }))
        .filter((entry) => entry.note.relativePath === input.relativePath || (requestedTitle.length > 0 && entry.title === requestedTitle))
        .map((entry) => ({
          relativePath: entry.note.relativePath,
          title: entry.note.title,
          fingerprint: entry.note.fingerprint,
          updatedAt: entry.note.updatedAt,
          match: entry.note.relativePath === input.relativePath ? 'path' as const : 'title' as const
        }))
        .sort((left, right) => (left.match === right.match ? right.updatedAt.localeCompare(left.updatedAt) : left.match === 'path' ? -1 : 1))
      const target = candidates.find((candidate) => candidate.relativePath === input.relativePath) ?? null
      const duplicates = candidates.filter((candidate) => candidate.relativePath !== input.relativePath)
      return {
        vaultId: profile.id,
        relativePath: input.relativePath,
        status: target !== null ? 'exists' : duplicates.length > 0 ? 'duplicate' : 'new',
        targetFingerprint: target?.fingerprint ?? null,
        candidates
      }
    } catch (error) {
      throw toExternalError(profile.provider, 'note', `${profile.id}:${input.relativePath}`, null, error)
    }
  }

  private requireObsidianProfile(vaultId: string) {
    const profile = this.repository.getIntegrationProfile(vaultId)
    if (profile.provider !== 'obsidian') throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', '当前配置不是 Obsidian Vault')
    return profile
  }

  async listZoteroItems(profileId: string, collectionKey?: string, secret: string | null = null): Promise<ZoteroItem[]> {
    const profile = this.repository.getIntegrationProfile(profileId)
    if (profile.provider !== 'zotero') throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', '该配置不是 Zotero Library')
    const result = await pullZotero(toAdapterProfile(profile, secret))
    return result.papers.filter((paper) => collectionKey === undefined || paper.collections.includes(collectionKey)).map(normalizedToZoteroItem)
  }

  async listZoteroItemPage(input: ZoteroItemPageInput & { secret?: string | null }): Promise<ZoteroItemPage> {
    // `secret` belongs to Main/Core's private credential envelope and is not a
    // field in the public strict DTO. Strip it before validation; passing the
    // combined object to Zod was the source of the renderer's generic
    // “request did not match the expected shape” failure.
    const { secret, ...publicInput } = input
    const parsed = ZoteroItemPageInputSchema.parse(publicInput)
    const profile = this.getIntegrationProfileForProvider(parsed.profileId, 'zotero')
    const pageSize = Math.min(Math.max(parsed.page?.limit ?? parsed.pageSize ?? 50, 1), 100)
    const continuation = parsed.cursor ?? parsed.page?.cursor
    const start = decodeZoteroItemCursor(continuation)
    // `since` is a sync/version cursor, not a page offset. Using it here made
    // the second page empty after the first successful read. Keep page reads
    // on Zotero's documented `start` + `limit` pagination instead.
    const settingsWithPage = { ...profile.settings, limit: pageSize, start }
    try {
      const query = parsed.query?.trim().toLocaleLowerCase() ?? ''
      const items: ZoteroItem[] = []
      let remoteStart = start
      let hasMore = true
      let pagesRead = 0
      // Filtering is intentionally done in Core, but the cursor advances by
      // the number of remote records consumed (not by the number of matches).
      // This keeps a title/author/collection search from repeating or skipping
      // records when a page contains attachments or non-matching items.
      while (items.length < pageSize && hasMore && pagesRead < 100) {
        const pulled = await pullZotero(toAdapterProfile({ ...profile, settings: { ...settingsWithPage, start: remoteStart } }, secret ?? null))
        const matching = pulled.papers
          .filter((paper) => (parsed.collectionKey === undefined || paper.collections.includes(parsed.collectionKey)) && (!query || paper.title.toLocaleLowerCase().includes(query) || paper.authors.some((author) => author.toLocaleLowerCase().includes(query))))
          .map(normalizedToZoteroItem)
        items.push(...matching.slice(0, pageSize - items.length))
        const fetchedCount = pulled.fetchedCount ?? pulled.papers.length
        if (fetchedCount <= 0) {
          hasMore = false
          break
        }
        remoteStart += fetchedCount
        hasMore = pulled.hasMore ?? fetchedCount >= pageSize
        pagesRead += 1
      }
      const nextCursor = hasMore ? encodeZoteroItemCursor(remoteStart) : null
      return { items, nextCursor, status: nextCursor === null ? 'connected' : 'partial' }
    } catch (error) {
      const status = zoteroPageStatus(error)
      return { items: [], nextCursor: null, status }
    }
  }

  async listZoteroCollections(profileId: string, secret: string | null = null): Promise<ZoteroCollection[]> {
    const profile = this.getIntegrationProfileForProvider(profileId, 'zotero')
    const page = await fetchZoteroCollections(toAdapterProfile(profile, secret))
    return page.collections.map((collection) => ({
      key: collection.key,
      name: collection.name,
      parentKey: collection.parentKey,
      itemCount: collection.itemCount
    }))
  }

  async listZoteroCollectionPage(input: ZoteroCollectionPageInput & { secret?: string | null }): Promise<ZoteroCollectionPage> {
    const { secret, ...publicInput } = input
    const parsed = ZoteroCollectionPageInputSchema.parse(publicInput)
    try {
      const profile = this.getIntegrationProfileForProvider(parsed.profileId, 'zotero')
      const page = await fetchZoteroCollections(toAdapterProfile(profile, secret ?? null), { cursor: parsed.cursor ?? null, limit: 100 })
      return ZoteroCollectionPageSchema.parse({ items: page.collections, nextCursor: page.nextCursor, status: page.nextCursor ? 'partial' : 'connected' })
    } catch (error) {
      return { items: [], nextCursor: null, status: zoteroPageStatus(error) }
    }
  }

  async exportZoteroBibtex(input: ZoteroBibtexExportInput & { secret?: string | null }): Promise<ZoteroBibtexExport> {
    const { secret, ...publicInput } = input
    const parsed = ZoteroBibtexExportInputSchema.parse(publicInput)
    const profile = this.getIntegrationProfileForProvider(parsed.profileId, 'zotero')
    try {
      const exported = await exportZoteroBibtex(
        toAdapterProfile(profile, secret ?? null),
        parsed.itemKeys,
        parsed.tags,
        parsed.projectTag,
      )
      return ZoteroBibtexExportSchema.parse({
        profileId: profile.id,
        itemKeys: parsed.itemKeys,
        citationKeys: exported.citationKeys,
        provider: 'better-bibtex',
        format: 'bibtex',
        content: exported.content,
        generatedAt: new Date().toISOString()
      })
    } catch (error) {
      throw toExternalError(profile.provider, 'paper', parsed.itemKeys[0] ?? 'selection', null, error)
    }
  }

  private getIntegrationProfileForProvider(profileId: string, provider: IntegrationProfile['provider']): IntegrationProfile {
    const profile = this.repository.getIntegrationProfile(profileId)
    if (profile.provider !== provider) throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', '集成配置类型不匹配')
    return profile
  }

  async importZoteroItem(input: { profileId: string; itemKey: string; projectId: string | null; secret: string | null }): Promise<Paper> {
    const receipt = await this.importZoteroPaper({ profileId: input.profileId, itemKey: input.itemKey, projectId: input.projectId === null ? null : ProjectIdSchema.parse(input.projectId), conflictPolicy: 'review', secret: input.secret })
    if (receipt.paper === null) throw new IntegrationRuntimeError('NOT_FOUND', 'Zotero 条目未能导入')
    return receipt.paper
  }

  async importFromZotero(input: PaperImportFromZoteroInput & { secret?: string | null }): Promise<PaperImportReceipt> {
    return this.importZoteroPaper(input)
  }

  private async importZoteroPaper(input: PaperImportFromZoteroInput & { secret?: string | null; tags?: readonly string[] }): Promise<PaperImportReceipt> {
    const existing = this.repository.listExternalLinks(input.profileId).find((link) =>
      link.entityKind === 'paper' && link.externalId === input.itemKey
    )
    if (existing) {
      const paper = this.repository.getPapersByIds([existing.entityId])[0]
      if (paper) {
        const decision = input.conflictPolicy === 'skip' ? 'skipped' : 'existing'
        return PaperImportReceiptSchema.parse({
          status: decision,
          decision,
          paper,
          profileId: input.profileId,
          itemKey: input.itemKey,
          locator: existing.locator,
          remoteRevision: existing.remoteRevision,
          duplicate: { kind: 'external-id', existingPaperId: paper.id, decision }
        })
      }
    }
    const profile = this.repository.getIntegrationProfile(input.profileId)
    if (profile.provider !== 'zotero') throw new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', '该配置不是 Zotero Library')
    let item: ZoteroItem | undefined
    let remoteRevision: string | null = null
    try {
      const found = await this.findRemoteZoteroItem(profile.id, input.itemKey, input.secret ?? null)
      item = found?.item
      remoteRevision = found?.remoteRevision ?? null
    } catch (error) {
      throw toExternalError(profile.provider, 'paper', input.itemKey, input.itemKey, error)
    }
    if (!item) throw new IntegrationRuntimeError('NOT_FOUND', 'Zotero 条目不存在')
    const duplicate = this.repository.listPapers({ query: item.doi ?? item.title, includeArchived: true }).find((paper) => (item.doi !== null && paper.doi === item.doi) || paper.title.trim().toLocaleLowerCase() === item.title.trim().toLocaleLowerCase())
    if (duplicate !== undefined) {
      const decision = input.conflictPolicy === 'skip' ? 'skipped' : 'conflict'
      return PaperImportReceiptSchema.parse({ status: decision, decision, paper: duplicate, profileId: input.profileId, itemKey: input.itemKey, locator: item.locator ?? null, remoteRevision, duplicate: { kind: item.doi !== null && duplicate.doi === item.doi ? 'doi' : 'title', existingPaperId: duplicate.id, decision } })
    }
    // `upsertExternalPaper` owns a single SQLite transaction for the Paper and
    // its stable ExternalLink. It also preserves local edits and makes a
    // repeated (profileId,itemKey) import idempotent.
    const stored = this.repository.upsertExternalPaper(profile.id, profile.provider, {
      externalId: item.key,
      locator: item.locator ?? `zotero://select/items/${item.key}`,
      remoteRevision,
      managedBlockId: null,
      paper: {
        projectId: input.projectId === null ? null : ProjectIdSchema.parse(input.projectId),
        title: item.title,
        authors: item.creators,
        year: item.year,
        venue: item.publicationTitle,
        abstract: item.abstract,
        doi: item.doi,
        url: item.url,
        citationKey: item.citationKey ?? null,
        tags: this.zoteroStoredTags([this.zoteroProjectTag(input.projectId), ...(input.tags ?? []), ...item.tags]),
        collections: item.collectionKeys,
        status: 'inbox',
        rating: 0,
        localPdfPath: null
      },
      expectedRevision: null
    })
    return PaperImportReceiptSchema.parse({ status: 'created', decision: 'created', paper: stored.paper, profileId: input.profileId, itemKey: input.itemKey, locator: stored.link.locator, remoteRevision: stored.link.remoteRevision })
  }

  async previewZoteroImport(input: ZoteroImportPreviewInput & { secret?: string | null }): Promise<ZoteroImportPreview> {
    const { secret, ...publicInput } = input
    const parsed = ZoteroImportPreviewInputSchema.parse(publicInput)
    const profile = this.getIntegrationProfileForProvider(parsed.profileId, 'zotero')
    const capability = await this.zoteroCapability(parsed.profileId, secret ?? null)
    const direction: StoredZoteroPreview['direction'] = parsed.paperIds.length > 0 ? 'to-zotero' : 'from-zotero'
    const transport = parsed.transport ?? (direction === 'to-zotero' && capability.capability.write ? 'api' : 'save-file')
    const items = direction === 'to-zotero'
      ? await this.previewPaperToZoteroItems(profile.id, parsed.paperIds, transport, secret ?? null)
      : await this.previewRemoteZoteroItems(parsed, secret ?? null)
    const previewId = randomUUID()
    this.zoteroPreviews.set(previewId, {
      profileId: profile.id,
      paperIds: parsed.paperIds,
      itemKeys: items.map((item) => item.itemKey),
      targetCollectionKey: parsed.targetCollectionKey,
      format: parsed.format,
      transport,
      projectId: parsed.projectId,
      projectClassification: false,
      tags: parsed.tags,
      direction,
      profileRevision: profile.revision,
      frozenTargets: direction === 'to-zotero'
        ? items.map((item) => ({
            decision: item.decision === 'create' || item.decision === 'review' ? item.decision : ('update-candidate' as const),
            target: item.decision === 'create' || item.decision === 'review'
              ? null
              : { itemKey: item.itemKey, locator: item.locator, remoteRevision: item.remoteRevision ?? null },
            note: item.note ?? null
          }))
        : []
    })
    const result = {
      previewId,
      profileId: profile.id,
      targetCollectionKey: parsed.targetCollectionKey,
      format: parsed.format,
      transport,
      capability: direction === 'to-zotero' ? (capability.capability.write ? 'write' : capability.capability.read ? 'read' : 'unsupported') : (capability.capability.read ? 'read' : 'unsupported'),
      profileRevision: profile.revision,
      items,
      total: items.length,
      requiresConfirmation: true as const
    }
    return ZoteroImportPreviewSchema.parse(result)
  }

  async previewPaperToZotero(input: PaperToZoteroPreviewInput & { secret?: string | null }): Promise<PaperToZoteroPreview> {
    const { secret, ...publicInput } = input
    const parsed = PaperToZoteroPreviewInputSchema.parse(publicInput)
    const preview = await this.previewZoteroImport({
      profileId: parsed.profileId,
      itemKeys: [],
      paperIds: parsed.paperIds,
      targetCollectionKey: parsed.targetCollectionKey,
      format: parsed.format,
      projectId: null,
      tags: [],
      ...(parsed.transport === undefined ? {} : { transport: parsed.transport }),
      ...(secret === undefined ? {} : { secret })
    })
    const stored = this.zoteroPreviews.get(preview.previewId)
    if (stored !== undefined) {
      // The preview freezes the top-level project classification exactly as the
      // caller sent it: an omitted value keeps each Paper's own binding, while
      // an explicit `null` (未分类) must not be confused with "not specified".
      this.zoteroPreviews.set(preview.previewId, {
        ...stored,
        tags: parsed.tags,
        ...(parsed.projectId === undefined ? {} : { projectId: parsed.projectId, projectClassification: true })
      })
    }
    return { ...preview, paperIds: parsed.paperIds, itemKeys: preview.items.map((item) => item.itemKey) }
  }

  async executeZoteroImport(input: ZoteroImportExecuteInput, secret: string | null = null, expectedProfileId?: string): Promise<ZoteroImportResult> {
    const parsed = ZoteroImportExecuteInputSchema.parse(input)
    if (!parsed.confirmationToken) throw new IntegrationRuntimeError('PERMISSION_DENIED', 'Zotero 导入需要明确确认')
    const preview = this.zoteroPreviews.get(parsed.previewId)
    if (!preview) throw new IntegrationRuntimeError('NOT_FOUND', 'Zotero 导入预览已过期')
    if (expectedProfileId !== undefined && expectedProfileId !== preview.profileId) {
      throw new IntegrationRuntimeError('PERMISSION_DENIED', 'Credential profile does not match the Zotero preview.')
    }
    // The preview froze the profile revision, transport and item matching.
    // Re-check the revision so an edited connection (including a re-probe that
    // flipped the write capability) can never be applied under the old
    // confirmation; the write itself is still guarded per item by revision.
    const currentProfile = this.repository.getIntegrationProfile(preview.profileId)
    if (currentProfile.revision !== preview.profileRevision) {
      throw new IntegrationRuntimeError('REVISION_CONFLICT', 'Zotero 连接配置在预览后已变更。请重新生成预览并再次确认。')
    }
    this.zoteroPreviews.delete(parsed.previewId)
    const items = preview.direction === 'to-zotero'
      ? await Promise.all(preview.paperIds.map((paperId, index) => this.writePaperToZotero({ profileId: preview.profileId, paperId, targetCollectionKey: preview.targetCollectionKey, format: preview.format, transport: preview.transport, tags: preview.tags, frozen: preview.frozenTargets[index] ?? null, ...(preview.projectClassification ? { projectId: preview.projectId } : {}) }, secret)))
      : await Promise.all(preview.itemKeys.map((itemKey) => this.importReceiptAsZoteroReceipt({ profileId: preview.profileId, itemKey, format: preview.format, transport: preview.transport, projectId: preview.projectId, tags: preview.tags }, secret)))
    // Only an explicitly selected export produces a transient handoff.
    // Failed API writes remain failed receipts and can be retried manually.
    const fallbackPaperIds = preview.direction === 'to-zotero'
      ? preview.paperIds.filter((_paperId, index) => {
        const receipt = items[index]
        return receipt?.outcome === 'generated' && receipt.transport !== 'api'
      })
      : []
    const handoff = fallbackPaperIds.length > 0
      ? this.buildPaperHandoff(fallbackPaperIds, preview.format, preview.targetCollectionKey, preview.tags)
      : null
    return ZoteroImportResultSchema.parse({
      items,
      succeeded: items.filter((item) => item.outcome === 'written' || item.outcome === 'generated').length,
      skipped: items.filter((item) => item.outcome === 'skipped' || item.outcome === 'unsupported').length,
      failed: items.filter((item) => item.outcome === 'failed').length,
      canceled: false,
      handoff
    })
  }

  async executePaperToZotero(input: ZoteroImportExecuteInput, secret: string | null = null, expectedProfileId?: string): Promise<ZoteroImportResult> {
    return this.executeZoteroImport(input, secret, expectedProfileId)
  }

  private async previewRemoteZoteroItems(input: ZoteroImportPreviewInput, secret: string | null): Promise<import('@prw/contracts').ZoteroImportPreviewItem[]> {
    // Selected keys can come from any page in a large library. Walk the
    // connector's offset cursor until every requested key is found (or the
    // remote collection is exhausted), instead of assuming the first page.
    const byKey = new Map<string, ZoteroItem>()
    let cursor: string | null = null
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = await this.listZoteroItemPage({ profileId: input.profileId, pageSize: 100, ...(cursor === null ? {} : { cursor }), secret })
      if (page.status !== 'connected' && page.status !== 'partial') {
        throw new IntegrationRuntimeError('NOT_CONNECTED', 'Zotero 文献列表不可用，请检查连接设置。')
      }
      for (const item of page.items) byKey.set(item.key, item)
      if (input.itemKeys.every((key) => byKey.has(key)) || page.nextCursor === null) break
      cursor = page.nextCursor
    }
    return input.itemKeys.map((itemKey) => {
      const item = byKey.get(itemKey)
      const existing = item === undefined ? undefined : this.findPaperDuplicate(item.doi, item.title)
      return {
        itemKey,
        paperId: existing?.id ?? null,
        decision: existing === undefined ? 'create' : 'review',
        duplicate: existing === undefined ? null : { kind: item?.doi !== null && item?.doi !== undefined && existing.doi === item.doi ? 'doi' as const : 'title' as const, existingPaperId: existing.id, decision: 'review' as const },
        locator: item?.locator ?? null,
        remoteRevision: item?.remoteRevision ?? null,
        note: existing === undefined ? null : 'Workbench 中已存在相同文献，已标记为需复核，确认导入时会跳过该条目。'
      }
    })
  }

  /** Resolve one stable Zotero key across paged Local API results. The
   * renderer may select an item from any page, so a first-page-only lookup is
   * not a valid import implementation. */
  private async findRemoteZoteroItem(profileId: string, itemKey: string, secret: string | null): Promise<{ item: ZoteroItem; remoteRevision: string | null } | null> {
    let cursor: string | null = null
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const page = await this.listZoteroItemPage({ profileId, pageSize: 100, ...(cursor === null ? {} : { cursor }), secret })
      if (page.status !== 'connected' && page.status !== 'partial') {
        throw new IntegrationRuntimeError('NOT_CONNECTED', 'Zotero 文献列表不可用，请检查连接设置。')
      }
      const item = page.items.find((candidate) => candidate.key === itemKey)
      if (item) return { item, remoteRevision: item.remoteRevision ?? null }
      if (page.nextCursor === null) return null
      cursor = page.nextCursor
    }
    return null
  }

  /**
   * Freeze the per-Paper Zotero decision for a Paper -> Zotero preview.
   *
   * Identity resolution order:
   * 1. a persisted Workbench external link (stable external ID) — the item is
   *    updated in place;
   * 2. for an API write, a bounded scan of the remote library matching the
   *    normalised DOI and then the normalised URL — a Zotero item the user
   *    already created by hand must be updated rather than duplicated;
   * 3. otherwise a new item is created.  A title-only match is reported as a
   *    `note` but still creates, because updating an item matched only by a
   *    title could overwrite an unrelated reference.
   * When the library is larger than the scan bound the preview must not guess:
   * those Papers are marked `review` and the confirmed write skips them with an
   * explicit reason instead of silently creating a duplicate.
   */
  private async previewPaperToZoteroItems(profileId: string, paperIds: readonly string[], transport: ZoteroImportTransport, secret: string | null): Promise<import('@prw/contracts').ZoteroImportPreviewItem[]> {
    const initial = paperIds.map((paperId) => this.previewPaperToZoteroItem(profileId, paperId))
    if (transport !== 'api' || initial.every((item) => item.decision !== 'create')) return initial
    const index = await this.remoteZoteroMatchIndex(profileId, secret)
    return initial.map((item) => {
      if (item.decision !== 'create' || item.paperId === null) return item
      const paper = this.repository.getPapersByIds([item.paperId])[0]
      if (paper === undefined) return item
      const match = index.match(paper)
      if (match !== undefined) {
        if (match.kind === 'title') {
          return { ...item, note: `Zotero 中已有相同标题的条目，导入后将新建一条（如需更新请先在 Zotero 中确认）。` }
        }
        return {
          ...item,
          itemKey: match.itemKey,
          decision: 'update-candidate' as const,
          duplicate: { kind: match.kind, existingPaperId: paper.id, decision: 'update-candidate' as const },
          locator: match.locator,
          remoteRevision: match.remoteRevision,
          note: match.kind === 'doi' ? '已按 DOI 匹配到 Zotero 中现有条目，导入将更新该条目而不是新建重复项。' : '已按 URL 匹配到 Zotero 中现有条目，导入将更新该条目而不是新建重复项。'
        }
      }
      return index.complete ? item : { ...item, decision: 'review' as const, note: `Zotero 库超过 ${index.scanned} 条的检查范围，预览无法确认是否已存在该文献；确认导入时将跳过，请手动复核。` }
    })
  }

  /**
   * Build a bounded DOI/URL/title index of the remote Zotero library.
   * `complete === false` means the library is larger than the scan bound, so
   * the caller must treat an unmatched Paper as unverified instead of unique.
   */
  private async remoteZoteroMatchIndex(profileId: string, secret: string | null): Promise<{ complete: boolean; scanned: number; match: (paper: Paper) => { kind: 'doi' | 'url' | 'title'; itemKey: string; locator: string | null; remoteRevision: string | null } | undefined }> {
    const byDoi = new Map<string, ZoteroItem>()
    const byUrl = new Map<string, ZoteroItem>()
    const byTitle = new Map<string, ZoteroItem>()
    const maxPages = 5
    let cursor: string | null = null
    let complete = false
    let scanned = 0
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const page = await this.listZoteroItemPage({ profileId, pageSize: 100, ...(cursor === null ? {} : { cursor }), secret })
      if (page.status !== 'connected' && page.status !== 'partial') {
        throw new IntegrationRuntimeError('NOT_CONNECTED', 'Zotero 文献列表不可用，请检查连接设置。')
      }
      for (const item of page.items) {
        const doi = normalizeMatchKey(item.doi)
        if (doi !== null && !byDoi.has(doi)) byDoi.set(doi, item)
        const url = normalizeMatchKey(item.url)
        if (url !== null && !byUrl.has(url)) byUrl.set(url, item)
        const title = normalizeMatchKey(item.title)
        if (title !== null && !byTitle.has(title)) byTitle.set(title, item)
      }
      scanned += page.items.length
      if (page.nextCursor === null) {
        complete = true
        break
      }
      cursor = page.nextCursor
    }
    const describe = (item: ZoteroItem, kind: 'doi' | 'url' | 'title') => ({
      kind,
      itemKey: item.key,
      locator: item.locator ?? null,
      remoteRevision: item.remoteRevision ?? null
    })
    return {
      complete,
      scanned,
      match: (paper) => {
        const doi = normalizeMatchKey(paper.doi)
        if (doi !== null) {
          const item = byDoi.get(doi)
          if (item !== undefined) return describe(item, 'doi')
        }
        const url = normalizeMatchKey(paper.url)
        if (url !== null) {
          const item = byUrl.get(url)
          if (item !== undefined) return describe(item, 'url')
        }
        const title = normalizeMatchKey(paper.title)
        if (title !== null) {
          const item = byTitle.get(title)
          if (item !== undefined) return describe(item, 'title')
        }
        return undefined
      }
    }
  }

  private previewPaperToZoteroItem(profileId: string, paperId: string): import('@prw/contracts').ZoteroImportPreviewItem {
    const paper = this.repository.getPapersByIds([paperId])[0]
    if (!paper) throw new IntegrationRuntimeError('NOT_FOUND', '本地 Paper 不存在')
    const link = this.repository.listExternalLinks(profileId).find((value) => value.entityKind === 'paper' && value.entityId === paper.id)
    return {
      itemKey: link?.externalId ?? paper.id,
      paperId: paper.id,
      decision: link === undefined ? 'create' : 'update-candidate',
      duplicate: link === undefined ? null : { kind: 'external-id', existingPaperId: paper.id, decision: 'update-candidate' },
      locator: link?.locator ?? null,
      remoteRevision: link?.remoteRevision ?? null,
      note: link === undefined ? null : '已建立 Workbench 映射，导入将更新该 Zotero 条目。'
    }
  }

  /**
   * Project membership is the authoritative namespace for Zotero tags. Keep
   * the stored value free of the presentation `#` prefix; the renderer adds
   * it when displaying tags. Unbound papers use the explicit `未分类` tag.
   */
  private zoteroProjectTag(projectId: string | null | undefined): string {
    if (!projectId) return '未分类'
    return this.repository.listProjects().find((project) => project.id === projectId)?.name ?? '未分类'
  }

  /** Workbench stores tags without the presentation `#` prefix. Zotero's
   * external tag field receives the explicit `#项目名` form so filtering in
   * either application is deterministic. */
  private zoteroStoredTags(values: readonly (string | null | undefined)[]): string[] {
    return [...new Set(values
      .map((value) => normalizedHandoffText(value).replace(/^#+/u, '').trim())
      .filter(Boolean))]
  }

  private zoteroExternalTags(values: readonly (string | null | undefined)[]): string[] {
    return this.zoteroStoredTags(values).map((value) => `#${value}`)
  }

  private findPaperDuplicate(doi: string | null | undefined, title: string): Paper | undefined {
    return this.repository.listPapers({ query: doi ?? title, includeArchived: true }).find((paper) => (doi !== null && doi !== undefined && paper.doi === doi) || paper.title.trim().toLocaleLowerCase() === title.trim().toLocaleLowerCase())
  }

  private async importReceiptAsZoteroReceipt(input: { profileId: string; itemKey: string; format: ZoteroImportFormat; transport: ZoteroImportTransport; projectId: string | null; tags: readonly string[] }, secret: string | null): Promise<import('@prw/contracts').ZoteroImportReceipt> {
    try {
      const imported = await this.importZoteroPaper({ profileId: input.profileId, itemKey: input.itemKey, projectId: input.projectId === null ? null : ProjectIdSchema.parse(input.projectId), conflictPolicy: 'skip', tags: input.tags, secret })
      return {
        profileId: input.profileId,
        itemKey: input.itemKey,
        paperId: imported.paper?.id ?? null,
        outcome: imported.status === 'created' ? 'written' : 'skipped',
        transport: input.transport,
        format: input.format,
        locator: imported.locator ?? null,
        remoteRevision: imported.remoteRevision ?? null,
        duplicateDecision: mapDuplicateDecision(imported.decision),
        // Importing *from* Zotero never writes a collection membership.
        targetCollectionKey: null,
        collectionWrite: 'not-written',
        error: null
      }
    } catch (error) {
      return this.zoteroReceiptError(input.profileId, input.itemKey, input.format, input.transport, error)
    }
  }

  private async writePaperToZotero(input: { profileId: string; paperId: string; targetCollectionKey: string | null; format: ZoteroImportFormat; transport: ZoteroImportTransport; tags?: readonly string[]; frozen?: StoredZoteroPreview['frozenTargets'][number] | null; projectId?: string | null }, secret: string | null): Promise<import('@prw/contracts').ZoteroImportReceipt> {
    const paper = this.repository.getPapersByIds([input.paperId])[0]
    if (!paper) return this.zoteroReceiptError(input.profileId, input.paperId, input.format, input.transport, new IntegrationRuntimeError('NOT_FOUND', '本地 Paper 不存在'))
    const frozen = input.frozen ?? null
    const frozenTarget = frozen?.target ?? null
    const targetCollectionKey = input.targetCollectionKey
    // Project membership is the single source for the automatic Zotero tag.
    // An explicitly frozen top-level classification (including `null` = 未分类)
    // wins; otherwise each Paper keeps its own binding.  Keep the unbound case
    // explicit so an exported/imported item can always be filtered later
    // (`#未分类` in the UI, `未分类` in Zotero's tag field).
    const projectTag = this.zoteroProjectTag(input.projectId === undefined ? paper.projectId : input.projectId)
    const projectionForZotero = (blockId: string, workbenchId: string): ManagedProjection => {
      const projection = paperProjection(paper, blockId, workbenchId)
      return { ...projection, tags: this.zoteroExternalTags([projectTag, ...(input.tags ?? []), ...projection.tags]) }
    }
    let zoteroItemKey: string = frozenTarget?.itemKey ?? paper.id
    let zoteroRemoteRevision: string | null = null
    try {
      const profile = this.getIntegrationProfileForProvider(input.profileId, 'zotero')
      const link = this.repository.listExternalLinks(input.profileId).find((value) => value.entityKind === 'paper' && value.entityId === paper.id)
      zoteroItemKey = link?.externalId ?? frozenTarget?.itemKey ?? paper.id
      zoteroRemoteRevision = link?.remoteRevision ?? frozenTarget?.remoteRevision ?? null
      if (input.transport !== 'api') {
        // Generating an import package never touches Zotero, so the frozen
        // collection is recorded but explicitly not applied.
        return { profileId: input.profileId, itemKey: zoteroItemKey, paperId: paper.id, outcome: 'generated', transport: input.transport, format: input.format, locator: null, remoteRevision: link?.remoteRevision ?? null, duplicateDecision: link === undefined ? 'create' : 'update-candidate', targetCollectionKey, collectionWrite: 'not-written', error: null }
      }
      if (frozen?.decision === 'review') {
        return this.zoteroReceiptError(input.profileId, zoteroItemKey, input.format, input.transport, new IntegrationRuntimeError('UNSUPPORTED_CAPABILITY', frozen.note ?? '预览未能确认 Zotero 中是否已存在该文献，已跳过写入。请在 Zotero 中手动复核后重新导入。'), paper.id, zoteroRemoteRevision, { outcome: 'skipped', targetCollectionKey, duplicateDecision: 'review' })
      }
      const capability = await this.zoteroCapability(input.profileId, secret)
      if (!capability.capability.write) {
        // Report the probe's own cause (consumed one-time key, denied dialog,
        // revoked key, Zotero 9 without Server-ID) instead of a generic
        // "no write permission": the generic text is what made a dead local
        // key look like a transient failure the user could retry.
        const reason = capability.writeBlockedReason
        throw new IntegrationRuntimeError(
          reason === 'key-invalid' || reason === 'authorization-denied' ? 'AUTH_REQUIRED' : 'PERMISSION_DENIED',
          zoteroWriteBlockedMessage(reason)
        )
      }
      if (link === undefined) {
        if (frozenTarget !== null) {
          // The preview matched an existing Zotero item by DOI/URL rather than
          // a Workbench link.  Verify the frozen revision before replacing
          // anything the user may have edited since the preview.
          if (frozenTarget.remoteRevision === null) {
            throw new IntegrationRuntimeError('REVISION_CONFLICT', '缺少 Zotero 条目版本。请先刷新 Zotero 条目，再重新预览导入。')
          }
          const receipt = await writeProjection(profile, toAdapterProfile(profile, secret), { externalId: frozenTarget.itemKey, locator: frozenTarget.locator ?? frozenTarget.itemKey, remoteRevision: frozenTarget.remoteRevision, collectionKey: targetCollectionKey }, projectionForZotero(frozenTarget.itemKey, frozenTarget.itemKey))
          this.repository.saveExternalLink({
            profileId: profile.id,
            entityKind: 'paper',
            entityId: paper.id,
            externalId: frozenTarget.itemKey,
            locator: receipt.locator,
            managedBlockId: null,
            remoteRevision: receipt.remoteRevision,
            syncState: 'synced',
            lastSyncedAt: new Date().toISOString()
          })
          return { profileId: input.profileId, itemKey: frozenTarget.itemKey, paperId: paper.id, outcome: 'written', transport: 'api', format: input.format, locator: receipt.locator, remoteRevision: receipt.remoteRevision, duplicateDecision: 'update-candidate', targetCollectionKey, collectionWrite: targetCollectionKey === null ? 'unchanged' : 'set', error: null }
        }
        const receipt = await createZoteroProjection(toAdapterProfile(profile, secret), targetCollectionKey, projectionForZotero(paper.id, paper.id))
        this.repository.saveExternalLink({
          profileId: profile.id,
          entityKind: 'paper',
          entityId: paper.id,
          externalId: receipt.externalId,
          locator: receipt.locator,
          managedBlockId: null,
          remoteRevision: receipt.remoteRevision,
          syncState: 'synced',
          lastSyncedAt: new Date().toISOString()
        })
        return { profileId: input.profileId, itemKey: receipt.externalId, paperId: paper.id, outcome: 'written', transport: 'api', format: input.format, locator: receipt.locator, remoteRevision: receipt.remoteRevision, duplicateDecision: 'create', targetCollectionKey, collectionWrite: targetCollectionKey === null ? 'unchanged' : 'set', error: null }
      }
      if (frozenTarget !== null && frozenTarget.itemKey === link.externalId && frozenTarget.remoteRevision !== null && link.remoteRevision !== null && link.remoteRevision !== frozenTarget.remoteRevision) {
        throw new IntegrationRuntimeError('REVISION_CONFLICT', '预览后 Zotero 条目已在外部更新。请重新生成预览并再次确认。')
      }
      if (link.remoteRevision === null) {
        throw new IntegrationRuntimeError('REVISION_CONFLICT', '缺少 Zotero 条目版本。请先刷新 Zotero 条目，再重新预览导入。')
      }
      const receipt = await writeProjection(profile, toAdapterProfile(profile, secret), { externalId: link.externalId, locator: link.locator, remoteRevision: link.remoteRevision, collectionKey: targetCollectionKey }, projectionForZotero(link.managedBlockId ?? link.id, link.externalId))
      this.repository.saveExternalLink({
        profileId: profile.id,
        entityKind: 'paper',
        entityId: paper.id,
        externalId: link.externalId,
        locator: receipt.locator,
        managedBlockId: link.managedBlockId,
        remoteRevision: receipt.remoteRevision,
        syncState: 'synced',
        lastSyncedAt: new Date().toISOString()
      })
      return { profileId: input.profileId, itemKey: link.externalId, paperId: paper.id, outcome: 'written', transport: 'api', format: input.format, locator: receipt.locator, remoteRevision: receipt.remoteRevision, duplicateDecision: 'update-candidate', targetCollectionKey, collectionWrite: targetCollectionKey === null ? 'unchanged' : 'set', error: null }
    } catch (error) {
      return this.zoteroReceiptError(input.profileId, zoteroItemKey, input.format, input.transport, error, paper.id, zoteroRemoteRevision, { targetCollectionKey })
    }
  }

  /**
   * Render local Papers into a standards-compatible import package.  This is
   * intentionally kept in Core rather than the Renderer so metadata is
   * validated once at the trusted boundary and no repository object or local
   * PDF path can leak into the browser.  The result is transient and is only
   * returned after the user confirms the one-use preview.
   */
  private buildPaperHandoff(
    paperIds: readonly string[],
    format: ZoteroImportFormat,
    targetCollectionKey: string | null,
    additionalTags: readonly string[]
  ): ZoteroHandoff {
    const papers = paperIds
      .map((paperId) => this.repository.getPapersByIds([paperId])[0])
      .filter((paper): paper is Paper => paper !== undefined)
    if (papers.length === 0) throw new IntegrationRuntimeError('NOT_FOUND', '没有可生成导入包的本地 Paper')

    const projects = this.repository.listProjects()
    const rendered = papers.map((paper) => {
      const projectName = paper.projectId === null
        ? '未分类'
        : projects.find((project) => project.id === paper.projectId)?.name ?? '未分类'
      const tags = [...new Set([
        projectName,
        ...additionalTags,
        ...paper.tags
      ].map(normalizeHandoffTag).filter((tag): tag is string => tag !== null))]
      return { paper, tags }
    })

    // Keep citation keys unique across the complete package while still
    // handling duplicate citationKey values from manually-created Papers.
    const usedKeys = new Set<string>()
    const entries = rendered.map((entry, index) => ({
      ...entry,
      key: uniqueHandoffCitationKey(entry.paper, index, usedKeys)
    }))
    const content = format === 'bibtex'
      ? renderBibtexHandoff(entries, targetCollectionKey)
      : renderRisHandoff(entries, targetCollectionKey)
    if (!content.trim()) throw new IntegrationRuntimeError('INVALID_MAPPING', '导入包内容为空')
    if (content.length > 5_000_000) throw new IntegrationRuntimeError('INVALID_MAPPING', '导入包超过 5 MB 限制，请分批导出')
    const extension = format === 'bibtex' ? 'bib' : 'ris'
    return ZoteroHandoffSchema.parse({
      format,
      fileName: `workbench-zotero-import-${new Date().toISOString().slice(0, 10)}.${extension}`,
      content,
      targetCollectionKey,
      itemCount: entries.length
    })
  }

  private zoteroReceiptError(profileId: string, itemKey: string, format: ZoteroImportFormat, transport: ZoteroImportTransport, error: unknown, paperId: string | null = null, remoteRevision: string | null = null, extra: { outcome?: 'failed' | 'skipped'; targetCollectionKey?: string | null; collectionWrite?: ZoteroCollectionWrite; duplicateDecision?: 'create' | 'update-candidate' | 'review' | null } = {}): import('@prw/contracts').ZoteroImportReceipt {
    const mapped = toExternalError('zotero', 'paper', paperId ?? itemKey, itemKey, error)
    return {
      profileId,
      itemKey,
      paperId: paperId === null ? null : PaperIdSchema.parse(paperId),
      // A Paper that the preview could not verify is skipped, not failed: the
      // user was told before confirming and nothing was written.
      outcome: extra.outcome ?? 'failed',
      transport,
      format,
      locator: null,
      remoteRevision,
      duplicateDecision: extra.duplicateDecision ?? null,
      targetCollectionKey: extra.targetCollectionKey ?? null,
      collectionWrite: extra.collectionWrite ?? 'not-written',
      error: {
        code: mapped.code,
        provider: mapped.provider,
        entityKind: mapped.entityKind,
        entityId: mapped.entityId,
        externalId: mapped.externalId,
        remoteRevision: mapped.remoteRevision,
        retryable: mapped.retryable,
        requiresConfirmation: mapped.requiresConfirmation,
        partial: mapped.partial,
        message: mapped.message
      }
    }
  }

  async sync(input: IntegrationSyncInput): Promise<SyncRun> {
    const initialProfile = this.repository.getIntegrationProfile(input.id)
    const run = this.repository.createSyncRun(initialProfile.id, input.direction)
    if (!initialProfile.enabled) {
      return this.repository.completeSyncRun(run.id, {
        status: 'failed',
        pulled: 0,
        pushed: 0,
        conflicts: 0,
        message: 'Integration is disabled. Enable it before syncing.'
      })
    }
    if (initialProfile.provider === 'notion' && input.direction === 'both') {
      return this.repository.completeSyncRun(run.id, {
        status: 'failed',
        pulled: 0,
        pushed: 0,
        conflicts: 0,
        message: 'Notion requires separate pull and explicitly confirmed push operations.'
      })
    }
    let profile = this.repository.updateIntegrationStatus({
      id: initialProfile.id,
      status: 'syncing',
      lastError: null,
      expectedRevision: initialProfile.revision
    })
    this.repository.updateSyncRun({ id: run.id, status: 'running' })

    let pulled = 0
    let pushed = 0
    let conflicts = 0
    try {
      const adapterProfile = toAdapterProfile(profile, input.secret)
      if (input.direction === 'pull' || input.direction === 'both') {
        const pull = await pullIntegration(adapterProfile)
        const links = this.repository.listExternalLinks(profile.id)
        for (const external of pull.papers) {
          const existingLink = links.find((link) =>
            link.entityKind === 'paper' && link.externalId === external.externalId
          )
          const existingPaper = existingLink
            ? this.repository.getPapersByIds([existingLink.entityId])[0]
            : undefined
          const stored = this.repository.upsertExternalPaper(profile.id, profile.provider, {
            externalId: external.externalId,
            locator: external.locator,
            remoteRevision: external.remoteRevision,
            managedBlockId: existingLink?.managedBlockId ?? external.managedBlockId,
            ...(existingPaper ? {
              paperId: existingPaper.id,
              expectedRevision: existingPaper.revision
            } : {}),
            paper: {
              projectId: existingPaper?.projectId ?? null,
              title: external.title,
              authors: external.authors,
              year: external.year,
              venue: external.venue,
              abstract: external.abstract,
              doi: external.doi,
              url: external.url,
              citationKey: external.citationKey,
              tags: this.zoteroStoredTags([this.zoteroProjectTag(existingPaper?.projectId), ...external.tags]),
              collections: external.collections,
              status: existingPaper?.status ?? 'inbox',
              rating: existingPaper?.rating ?? 0,
              localPdfPath: external.localPdfPath ?? existingPaper?.localPdfPath ?? null
            }
          })
          if (stored.link.syncState === 'conflict') conflicts += 1
          else pulled += 1
        }
      }

      if (input.direction === 'push' || input.direction === 'both') {
        const pushResult = await this.pushMappedPapers(profile, toAdapterProfile(profile, input.secret))
        pushed = pushResult.pushed
        conflicts += pushResult.conflicts
      }

      const finishedAt = new Date().toISOString()
      const completed = this.repository.completeSyncRun(run.id, {
        pulled,
        pushed,
        conflicts,
        message: conflicts > 0 ? 'Sync completed with conflicts.' : 'Sync completed.'
      })
      profile = this.repository.getIntegrationProfile(profile.id)
      this.repository.updateIntegrationStatus({
        id: profile.id,
        status: conflicts > 0 ? 'error' : 'ready',
        lastSyncAt: finishedAt,
        lastError: conflicts > 0 ? `${conflicts} mapped item(s) require conflict review.` : null,
        expectedRevision: profile.revision
      })
      return completed
    } catch (error) {
      const message = safeIntegrationMessage(error, input.secret)
      const failed = this.repository.completeSyncRun(run.id, {
        status: 'failed',
        pulled,
        pushed,
        conflicts,
        message
      })
      profile = this.repository.getIntegrationProfile(profile.id)
      this.repository.updateIntegrationStatus({
        id: profile.id,
        status: 'error',
        lastError: message,
        expectedRevision: profile.revision
      })
      return failed
    }
  }

  private async pushMappedPapers(
    profile: IntegrationProfile,
    adapterProfile: AdapterProfile
  ): Promise<{ pushed: number; conflicts: number }> {
    let pushed = 0
    let conflicts = 0
    const candidates = this.repository.listExternalLinks(profile.id).filter((link) =>
      link.entityKind === 'paper'
      && link.syncState === 'local_changed'
    )

    for (const link of candidates) {
      const paper = this.repository.getPapersByIds([link.entityId])[0]
      if (!paper) continue
      const projection = paperProjection(
        paper,
        link.managedBlockId ?? link.id,
        profile.provider === 'obsidian' ? link.externalId : paper.id
      )
      const externalProjection = profile.provider === 'zotero'
        ? {
            ...projection,
            tags: this.zoteroExternalTags([this.zoteroProjectTag(paper.projectId), ...projection.tags])
          }
        : projection
      try {
        const receipt = await writeProjection(profile, adapterProfile, {
          externalId: link.externalId,
          locator: link.locator,
          remoteRevision: link.remoteRevision
        }, externalProjection)
        this.repository.saveExternalLink({
          ...link,
          locator: receipt.locator,
          managedBlockId: profile.provider === 'obsidian' ? externalProjection.blockId : link.managedBlockId,
          remoteRevision: receipt.remoteRevision,
          syncState: 'synced',
          lastSyncedAt: new Date().toISOString()
        })
        pushed += 1
      } catch (error) {
        if (error instanceof IntegrationRuntimeError && error.code === 'REVISION_CONFLICT') {
          this.repository.saveExternalLink({ ...link, syncState: 'conflict' })
          conflicts += 1
          continue
        }
        throw error
      }
    }
    return { pushed, conflicts }
  }
}

function toAdapterProfile(profile: IntegrationProfile, secret: string | null): AdapterProfile {
  return {
    provider: profile.provider,
    location: profile.location,
    settings: profile.settings,
    ...(secret === null ? {} : { credential: secret })
  }
}

function paperProjection(paper: Paper, blockId: string, workbenchId: string): ManagedProjection {
  const metadata = [
    paper.authors.length > 0 ? `**Authors:** ${paper.authors.join(', ')}` : '',
    paper.year !== null ? `**Year:** ${paper.year}` : '',
    paper.doi ? `**DOI:** ${paper.doi}` : '',
    paper.url ? `**URL:** ${paper.url}` : ''
  ].filter(Boolean).join('\n\n')
  return {
    blockId,
    revision: paper.revision,
    title: paper.title,
    markdown: `${metadata}${metadata && paper.abstract ? '\n\n' : ''}${paper.abstract}`,
    workbenchId,
    tags: paper.tags,
    collections: paper.collections,
    authors: paper.authors,
    year: paper.year,
    venue: paper.venue,
    abstract: paper.abstract,
    doi: paper.doi,
    url: paper.url,
    citationKey: paper.citationKey
  }
}

function normalizedHandoffText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.replace(/[\r\n]+/gu, ' ').replace(/\s+/gu, ' ').trim() : ''
}

function normalizeHandoffTag(value: string | null | undefined): string | null {
  const text = normalizedHandoffText(value).replace(/^#+/u, '').trim()
  return text ? `#${text}` : null
}

function escapeBibtex(value: string): string {
  return normalizedHandoffText(value)
    .replace(/\\/gu, '\\\\')
    .replace(/[{}]/gu, (character) => `\\${character}`)
}

function uniqueHandoffCitationKey(paper: Paper, index: number, used: Set<string>): string {
  const source = normalizedHandoffText(paper.citationKey) || [
    paper.authors[0]?.split(/\s+/u).at(-1) ?? 'paper',
    paper.year ?? '',
    paper.title.split(/\s+/u).slice(0, 3).join(' ')
  ].join('')
  const base = source
    .replace(/[^A-Za-z0-9:_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 120) || `paper-${index + 1}`
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) candidate = `${base}-${suffix++}`
  used.add(candidate)
  return candidate
}

type HandoffEntry = { paper: Paper; tags: string[]; key: string }

function renderBibtexHandoff(entries: readonly HandoffEntry[], targetCollectionKey: string | null): string {
  const header = [
    '% Generated by Personal Research Workbench',
    targetCollectionKey ? `% Zotero collection: ${normalizedHandoffText(targetCollectionKey)}` : '% Zotero collection: default'
  ].join('\n')
  const body = entries.map(({ paper, tags, key }) => {
    const fields = [
      `  title = {${escapeBibtex(paper.title)}}`,
      paper.authors.length > 0 ? `  author = {${paper.authors.map(escapeBibtex).join(' and ')}}` : '',
      paper.year === null ? '' : `  year = {${paper.year}}`,
      normalizedHandoffText(paper.venue) ? `  journal = {${escapeBibtex(paper.venue)}}` : '',
      normalizedHandoffText(paper.doi) ? `  doi = {${escapeBibtex(paper.doi ?? '')}}` : '',
      normalizedHandoffText(paper.url) ? `  url = {${escapeBibtex(paper.url ?? '')}}` : '',
      normalizedHandoffText(paper.abstract) ? `  abstract = {${escapeBibtex(paper.abstract)}}` : '',
      tags.length > 0 ? `  keywords = {${tags.map(escapeBibtex).join(', ')}}` : ''
    ].filter(Boolean)
    return `@article{${key},\n${fields.join(',\n')}\n}`
  }).join('\n\n')
  return `${header}\n\n${body}\n`
}

function renderRisHandoff(entries: readonly HandoffEntry[], targetCollectionKey: string | null): string {
  return entries.map(({ paper, tags }) => {
    const lines = [
      'TY  - JOUR',
      `TI  - ${normalizedHandoffText(paper.title)}`,
      ...paper.authors.map((author) => `AU  - ${normalizedHandoffText(author)}`),
      paper.year === null ? '' : `PY  - ${paper.year}`,
      normalizedHandoffText(paper.venue) ? `JO  - ${normalizedHandoffText(paper.venue)}` : '',
      normalizedHandoffText(paper.abstract) ? `AB  - ${normalizedHandoffText(paper.abstract)}` : '',
      normalizedHandoffText(paper.doi) ? `DO  - ${normalizedHandoffText(paper.doi)}` : '',
      normalizedHandoffText(paper.url) ? `UR  - ${normalizedHandoffText(paper.url)}` : '',
      ...tags.map((tag) => `KW  - ${tag}`),
      targetCollectionKey ? `N1  - Workbench Zotero collection: ${normalizedHandoffText(targetCollectionKey)}` : 'N1  - Workbench Zotero collection: default',
      'ER  -'
    ].filter(Boolean)
    return `${lines.join('\n')}\n`
  }).join('\n')
}

function writeProjection(
  profile: IntegrationProfile,
  adapterProfile: AdapterProfile,
  target: { externalId: string; locator: string; remoteRevision: string | null; collectionKey?: string | null },
  projection: ManagedProjection
): Promise<ProjectionReceipt> {
  switch (profile.provider) {
    case 'obsidian': return writeObsidianProjection(adapterProfile, target, projection)
    case 'zotero': return writeZoteroProjection(adapterProfile, target, projection)
    case 'notion': return writeNotionProjection(adapterProfile, target, projection)
  }
}

function safeIntegrationMessage(error: unknown, secret: string | null = null): string {
  const message = error instanceof IntegrationRuntimeError
    ? error.message
    : 'Integration sync failed. Review the profile and try again.'
  return redactIntegrationSecret(message, secret)
}

function redactIntegrationSecret(message: string, secret: string | null): string {
  return secret === null || secret.length === 0 ? message : message.split(secret).join('[redacted]')
}

/** Normalise a DOI/URL/title into a stable comparison key.  A DOI keeps only
 * its suffix form, so `https://doi.org/10.1/x`, `doi:10.1/X` and `10.1/x`
 * collapse into one key and a hand-created Zotero entry is still matched. */
function normalizeMatchKey(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLocaleLowerCase()
  if (!trimmed) return null
  return trimmed
    .replace(/^https?:\/\/(dx\.)?doi\.org\//u, '')
    .replace(/^doi:\s*/u, '')
    .replace(/\/+$/u, '')
}

function normalizedToZoteroItem(paper: NormalizedExternalPaper): ZoteroItem {
  return {
    key: paper.externalId,
    title: paper.title,
    creators: paper.authors,
    publicationTitle: paper.venue,
    year: paper.year,
    abstract: paper.abstract,
    doi: paper.doi,
    url: paper.url,
    tags: paper.tags,
    collectionKeys: paper.collections,
    attachmentCount: paper.localPdfPath ? 1 : 0,
    citationKey: paper.citationKey ?? null,
    locator: paper.locator,
    remoteRevision: paper.remoteRevision
  }
}

/** The controlled frontmatter projection the renderer shows before a write. */
interface NoteMetadataSnapshot {
  readonly projectId: string | null
  readonly kind: ObsidianLayoutKind | null
  readonly title: string | null
  readonly date: string | null
  readonly parentRelativePath: string | null
  readonly paperIds: readonly string[]
  readonly taskIds: readonly string[]
  readonly labels: readonly string[]
  readonly unknownFieldKeys: readonly string[]
  readonly warnings: readonly string[]
}

const NOTE_METADATA_LABELS = {
  projectId: '项目绑定',
  kind: '文献分类',
  title: '标题',
  date: '日期',
  paperIds: '关联文献',
  taskIds: '关联任务',
  parentRelativePath: '父笔记',
  labels: '标签'
} as const satisfies Record<keyof NoteMetadataPatch, string>

function summarizeNoteMetadata(markdown: string): NoteMetadataSnapshot {
  const parsed = parseObsidianFrontmatter(markdown)
  return {
    projectId: parsed.projectId,
    kind: parsed.kind,
    title: parsed.title,
    date: parsed.date,
    parentRelativePath: parsed.parent,
    paperIds: [...parsed.paperIds],
    taskIds: [...parsed.taskIds],
    labels: [...parsed.tags],
    unknownFieldKeys: Object.keys(parsed.unknownFields).sort(),
    warnings: parsed.warnings
  }
}

function toNoteMetadataSummary(snapshot: NoteMetadataSnapshot): NoteMetadataSummary {
  return {
    projectId: snapshot.projectId,
    kind: snapshot.kind,
    title: snapshot.title,
    date: snapshot.date,
    parentRelativePath: snapshot.parentRelativePath,
    paperIds: [...snapshot.paperIds],
    taskIds: [...snapshot.taskIds],
    labels: [...snapshot.labels]
  }
}

function sameMetadataValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => value === right[index])
  return left === right
}

/** Controlled frontmatter is projected read-only next to the body: the file
 * stays authoritative, the DTO only exposes what the inspector may render.
 * Read and write paths share this projection, so a note returned by an apply
 * reports the same binding/kind/parent relation as a fresh read. */
function projectObsidianNote(profileId: string, note: ObsidianNote): Note {
  const frontmatter = parseObsidianFrontmatter(note.content ?? '')
  return {
    ...note,
    id: `${profileId}:${note.relativePath}`,
    vaultId: profileId,
    projectId: frontmatter.projectId ? ProjectIdSchema.parse(frontmatter.projectId) : null,
    kind: frontmatter.kind,
    parentRelativePath: frontmatter.parent
  }
}

/** Map the transport patch onto the controlled frontmatter keys. */
function toManagedFrontmatterPatch(patch: NoteMetadataPatch): ManagedFrontmatterPatch {
  const mapped: {
    projectId?: string | null
    kind?: ObsidianLayoutKind | null
    title?: string
    date?: string
    paperIds?: readonly string[]
    taskIds?: readonly string[]
    parent?: string | null
    labels?: readonly string[]
  } = {}
  if (patch.projectId !== undefined) mapped.projectId = patch.projectId
  if (patch.kind !== undefined) mapped.kind = patch.kind
  if (patch.title !== undefined) mapped.title = patch.title
  if (patch.date !== undefined) mapped.date = patch.date
  if (patch.paperIds !== undefined) mapped.paperIds = patch.paperIds
  if (patch.taskIds !== undefined) mapped.taskIds = patch.taskIds
  if (patch.parentRelativePath !== undefined) mapped.parent = patch.parentRelativePath
  if (patch.labels !== undefined) mapped.labels = patch.labels
  return mapped
}

function noteTitleFromPath(relativePath: string): string {
  const name = relativePath.split('/').at(-1) ?? relativePath
  return name.replace(/\.md$/iu, '')
}

/** Title comparison is intentionally lossy-but-safe: case, whitespace and
 * punctuation differences must not create a duplicate-looking report for two
 * genuinely different notes. */
function normalizeNoteTitle(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\s_\-–—:：,，.。()（）\[\]【】]/gu, '')
}

function buildNoteMetadataPreview(
  vaultId: string,
  relativePath: string,
  note: ObsidianNote,
  patch: NoteMetadataPatch
): NoteMetadataPreview {
  const before = summarizeNoteMetadata(note.content ?? '')
  const next = updateManagedFrontmatter(note.content ?? '', toManagedFrontmatterPatch(patch))
  const after = summarizeNoteMetadata(next)
  const changedFields = (Object.keys(NOTE_METADATA_LABELS) as Array<keyof NoteMetadataPatch>)
    .filter((key) => !sameMetadataValue(before[key], after[key]))
    .map((key) => NOTE_METADATA_LABELS[key])
  return {
    vaultId,
    relativePath,
    fingerprint: note.fingerprint,
    before: toNoteMetadataSummary(before),
    after: toNoteMetadataSummary(after),
    changedFields,
    preservedUnknownFields: before.unknownFieldKeys.filter((key) => after.unknownFieldKeys.includes(key)),
    warnings: [...new Set([...before.warnings, ...after.warnings])],
    canApply: true
  }
}

function toExternalError(
  provider: IntegrationProfile['provider'],
  entityKind: 'project' | 'task' | 'paper' | 'note' | 'calendar-event',
  entityId: string,
  externalId: string | null,
  error: unknown
): RedactedExternalError {
  const code = error instanceof IntegrationRuntimeError
    ? ({ AUTH_REQUIRED: 'EXTERNAL_UNAUTHORIZED', PERMISSION_DENIED: 'EXTERNAL_UNAUTHORIZED', RATE_LIMITED: 'EXTERNAL_RATE_LIMITED', TEMPORARILY_UNAVAILABLE: 'EXTERNAL_UNAVAILABLE', NOT_FOUND: 'EXTERNAL_VALIDATION', INVALID_MAPPING: 'EXTERNAL_VALIDATION', REVISION_CONFLICT: 'EXTERNAL_CONFLICT', UNSUPPORTED_CAPABILITY: 'EXTERNAL_UNSUPPORTED', NOT_CONNECTED: 'EXTERNAL_NOT_CONFIGURED' } as const)[error.code]
    : 'EXTERNAL_IO'
  const message = error instanceof IntegrationRuntimeError ? error.message : '外部连接操作失败，请稍后重试'
  return new RedactedExternalError({ code: code ?? 'EXTERNAL_IO', provider, entityKind, entityId, externalId, remoteRevision: null, retryable: ['EXTERNAL_UNAVAILABLE', 'EXTERNAL_RATE_LIMITED', 'EXTERNAL_IO'].includes(code ?? ''), requiresConfirmation: false, partial: false, message: message.replace(/[A-Za-z]:[\\/][^\s]*/g, '外部资源') })
}

function redactLayoutMessage(value: unknown): string {
  const source = value instanceof Error ? value.message : String(value)
  const redacted = source
    .replace(/[A-Za-z]:[\\/][^\s)]+/gu, '[redacted path]')
    .replace(/\\\\[^\s)]+/gu, '[redacted path]')
    .replace(/(?:^|\s)\/(?:[^\s/]+\/)+[^\s)]*/gu, ' [redacted path]')
    .replace(/Bearer\s+[^\s]+/giu, 'Bearer [redacted]')
    .replace(/(?:token|api[_-]?key)=[^\s]+/giu, '$1=[redacted]')
    .trim()
  return (redacted || 'Obsidian operation failed.').slice(0, 500)
}

function layoutErrorCode(error: unknown): import('@prw/contracts').ObsidianLayoutError['code'] {
  if (error instanceof ObsidianLayoutError) return error.code
  if (error instanceof IntegrationRuntimeError) {
    switch (error.code) {
      case 'NOT_CONNECTED':
      case 'INVALID_MAPPING': return /symbolic\s+link|junction|符号链接|链接/u.test(error.message) ? 'SYMLINK_REJECTED' : 'INVALID_ROOT'
      case 'REVISION_CONFLICT': return 'COLLISION_CHANGED'
      case 'PERMISSION_DENIED': return 'CONFIRMATION_REQUIRED'
      case 'NOT_FOUND': return 'COLLISION_CHANGED'
      default: return 'WRITE_FAILED'
    }
  }
  return 'WRITE_FAILED'
}

function layoutStatusError(error: unknown): import('@prw/contracts').ObsidianLayoutError {
  const code = layoutErrorCode(error)
  return {
    code,
    message: redactLayoutMessage(error),
    retryable: false,
    requiresConfirmation: code === 'CONFIRMATION_REQUIRED' || code === 'COLLISION_CHOICE_REQUIRED',
    partial: false
  }
}

async function assertLayoutVault(profile: AdapterProfile): Promise<void> {
  try {
    await assertObsidianVault(profile)
  } catch (error) {
    throw new ObsidianLayoutError(layoutErrorCode(error), redactLayoutMessage(error))
  }
}

function mapLayoutPlan(plan: InternalLayoutPlan, profileId: string): ObsidianLayoutPlan {
  return ObsidianLayoutPlanSchema.parse({
    planId: plan.planId,
    profileId,
    projectId: plan.projectId,
    displayName: plan.displayName,
    requestedSlug: plan.requestedSlug,
    slug: plan.slug,
    projectRelativePath: plan.projectRelativePath,
    categories: plan.categories.map(({ absolutePath: _absolutePath, ...category }) => category),
    readmeRelativePath: plan.readmeRelativePath,
    relativePaths: plan.relativePaths,
    collision: plan.collision,
    requiresConfirmation: true
  })
}

function mapLayoutReceipt(receipt: InternalLayoutReceipt, profileId: string): ObsidianLayoutReceipt {
  return ObsidianLayoutReceiptSchema.parse({
    status: receipt.status,
    profileId,
    projectId: receipt.projectId,
    slug: receipt.slug,
    projectRelativePath: receipt.projectRelativePath,
    createdPaths: receipt.createdPaths,
    preservedPaths: receipt.preservedPaths,
    message: redactLayoutMessage(receipt.message),
    ...(receipt.status === 'partial' ? {
      error: {
        code: 'WRITE_FAILED',
        message: redactLayoutMessage(receipt.message),
        retryable: false,
        requiresConfirmation: false,
        partial: true
      }
    } : {})
  })
}

function zoteroPageStatus(error: unknown): import('@prw/contracts').ZoteroPageStatus {
  if (error instanceof IntegrationRuntimeError) {
    switch (error.code) {
      case 'AUTH_REQUIRED':
      case 'PERMISSION_DENIED': return 'unauthorized'
      case 'RATE_LIMITED': return 'rate_limited'
      case 'UNSUPPORTED_CAPABILITY': return 'unsupported'
      case 'NOT_CONNECTED': return 'offline'
      case 'TEMPORARILY_UNAVAILABLE': return 'offline'
      default: return 'error'
    }
  }
  return 'error'
}

function mapDuplicateDecision(value: string | undefined): import('@prw/contracts').ZoteroDuplicateDecision | null {
  switch (value) {
    case 'created': return 'create'
    case 'existing':
    case 'updated-candidate': return 'update-candidate'
    case 'skipped': return 'skip'
    case 'conflict': return 'conflict'
    default: return null
  }
}
