import {
  ApplyNoteMetadataInputSchema,
  LiteratureStagingToZoteroPreviewInputSchema,
  NoteMetadataPreviewInputSchema,
  PaperToZoteroPreviewInputSchema,
  ReadNoteInputSchema,
  WriteNoteInputSchema,
  type AgentExternalAction,
  type AgentExternalActionDecideInput,
  type AgentExternalActionKind,
  type LiteratureStagingToZoteroPreview,
  type LiteratureStagingToZoteroPreviewInput,
  type LiteratureStagingToZoteroResult,
  type Note,
  type NoteMetadataPatch,
  type NoteMetadataPreview,
  type NoteMetadataPreviewInput,
  type PaperToZoteroPreview,
  type PaperToZoteroPreviewInput,
  type ReadNoteInput,
  type WriteNoteInput,
  type ZoteroImportExecuteInput,
  type ZoteroImportResult
} from '@prw/contracts'
import type { WorkbenchRepository } from '@prw/database'
import { IntegrationRuntimeError } from '@prw/connectors'
import { RedactedExternalError } from './errors.js'
import { redactSecretValue } from './dispatcher.js'
import { randomUUID } from 'node:crypto'

/**
 * A write the Agent prepared and a person has to approve.
 *
 * The Agent can read Zotero and the Vault, and it can build a preview, but it
 * must not change another application's data on its own say-so. Every external
 * write therefore becomes a row the user decides on; approving replays exactly
 * the write that was previewed, without another model turn.
 */
export interface AgentExternalActionRequestResult {
  readonly action: AgentExternalAction
  /** What the model must tell the user. The write has NOT happened yet, and the
   * model reliably reports whatever this says. */
  readonly message: string
}

/** Where the request came from. Supplied by Core, never by the model. */
export interface AgentExternalActionContext {
  readonly runId: string
}

/** How long a pending write stays approvable. Long enough to read the card and
 * think, short enough that a stale preview cannot be approved after the target
 * moved on. */
const decisionWindowMs = 30 * 60 * 1000

interface FrozenZoteroPayload {
  readonly route: 'zotero-import'
  readonly previewId: string
}

interface FrozenLiteraturePayload {
  readonly route: 'literature-import'
  readonly previewId: string
}

interface FrozenNoteWritePayload {
  readonly route: 'obsidian-note'
  readonly vaultId: string
  readonly relativePath: string
  readonly content: string
  readonly expectedFingerprint: string | null
  readonly overwrites: boolean
}

interface FrozenMetadataPayload {
  readonly route: 'obsidian-metadata'
  readonly vaultId: string
  readonly relativePath: string
  readonly patch: NoteMetadataPatch
  readonly expectedFingerprint: string
}

type FrozenPayload = FrozenZoteroPayload | FrozenLiteraturePayload | FrozenNoteWritePayload | FrozenMetadataPayload

/**
 * The connector entry points this coordinator is allowed to use.
 *
 * Narrow on purpose, and bound by the host rather than passed as service
 * objects: the decision layer must replay exactly the preview-then-execute pair
 * the UI uses, and naming all eight methods makes any drift between the two
 * paths a compile error instead of a silent second implementation.
 */
export interface AgentExternalActionPorts {
  previewPaperToZotero(input: PaperToZoteroPreviewInput, secret: string | null): Promise<PaperToZoteroPreview>
  executePaperToZotero(input: ZoteroImportExecuteInput, secret: string | null, expectedProfileId: string): Promise<ZoteroImportResult>
  previewStagingToZotero(input: LiteratureStagingToZoteroPreviewInput, secret: string | null): Promise<LiteratureStagingToZoteroPreview>
  executeStagingToZotero(input: ZoteroImportExecuteInput, secret: string | null, expectedProfileId: string): Promise<LiteratureStagingToZoteroResult>
  readNote(input: ReadNoteInput): Promise<Note>
  writeNote(input: WriteNoteInput): Promise<Note>
  previewNoteMetadata(input: NoteMetadataPreviewInput): Promise<NoteMetadataPreview>
  applyNoteMetadata(input: NoteMetadataPreviewInput & { readonly expectedFingerprint: string; readonly confirmed: true }): Promise<Note>
}

export interface AgentExternalActionCoordinatorOptions {
  readonly repository: WorkbenchRepository
  readonly ports: AgentExternalActionPorts
  /**
   * Read one integration profile's secret from Electron Main.
   *
   * The pipe and parent-port RPC paths inject the secret with the request, but
   * the Agent's in-process MCP tools have no RPC envelope, so a Zotero write
   * they request has to fetch its own. `null` means "no credential stored",
   * which the connector reports as a connection failure instead of writing
   * anonymously.
   */
  readonly requestIntegrationSecret?: ((profileId: string) => Promise<string | null>) | undefined
  readonly now?: (() => Date) | undefined
  readonly newId?: (() => string) | undefined
}

/**
 * Owns the pending-approval lifecycle of every Agent-driven external write.
 *
 * Responsibilities stay deliberately narrow: turn a preview into a decision
 * row, then execute exactly one frozen payload when the user approves. The
 * connector, its revision checks and its redaction rules are reused unchanged,
 * so this class never talks to Zotero or the file system itself.
 */
export class AgentExternalActionCoordinator {
  constructor(private readonly options: AgentExternalActionCoordinatorOptions) {}

  /** Selected Papers → Zotero. The preview is produced here and frozen behind a
   * decision so a later UI selection cannot change what the user approves. */
  async requestZoteroImport(
    input: unknown,
    context: AgentExternalActionContext
  ): Promise<AgentExternalActionRequestResult> {
    const parsed = PaperToZoteroPreviewInputSchema.parse(input)
    const secret = await this.integrationSecret(parsed.profileId)
    const preview = await this.options.ports.previewPaperToZotero(parsed, secret)
    return this.record({
      context,
      kind: 'zotero-import',
      profileId: parsed.profileId,
      previewId: preview.previewId,
      summary: zoteroSummary(parsed.paperIds.length, parsed.profileId, preview),
      payload: { route: 'zotero-import', previewId: preview.previewId } satisfies FrozenZoteroPayload
    })
  }

  /** Search-staging records → Zotero.
   *
   * A separate route rather than a parameter on the one above: it previews
   * through the literature coordinator's own store and executes through its own
   * method, so a frozen payload has to say which one it belongs to. */
  async requestStagingZoteroImport(
    input: unknown,
    context: AgentExternalActionContext
  ): Promise<AgentExternalActionRequestResult> {
    const parsed = LiteratureStagingToZoteroPreviewInputSchema.parse(input)
    const secret = await this.integrationSecret(parsed.profileId)
    const preview = await this.options.ports.previewStagingToZotero(parsed, secret)
    return this.record({
      context,
      kind: 'zotero-import',
      profileId: parsed.profileId,
      previewId: preview.previewId,
      summary: zoteroSummary(parsed.stagingIds.length, parsed.profileId, preview, '（检索暂存）'),
      payload: { route: 'literature-import', previewId: preview.previewId } satisfies FrozenLiteraturePayload
    })
  }

  /** New or replaced Obsidian note. The target's current fingerprint is frozen
   * here, so an external edit between preview and approval is a conflict instead
   * of an overwrite. */
  async requestNoteWrite(input: unknown, context: AgentExternalActionContext): Promise<AgentExternalActionRequestResult> {
    const raw = input as { vaultId?: unknown; relativePath?: unknown; content?: unknown; expectedFingerprint?: unknown }
    const parsed = WriteNoteInputSchema.parse({
      vaultId: raw.vaultId,
      relativePath: raw.relativePath,
      content: raw.content,
      // `expectedFingerprint` is optional on the tool schema but required here;
      // "not supplied" means "create the file if it does not exist".
      expectedFingerprint: raw.expectedFingerprint ?? null
    })
    const current = await this.options.ports.readNote(
      ReadNoteInputSchema.parse({ vaultId: parsed.vaultId, relativePath: parsed.relativePath })
    ).then((note) => note.fingerprint, (error: unknown) => {
      // A missing file is the normal "create" case and is frozen as "must not
      // exist" (a null fingerprint). Anything else is a real failure the user
      // has to see before confirming, so it propagates instead of becoming an
      // empty preview.
      if (isMissingFile(error)) return null
      throw error
    })
    // A fingerprint the caller saw is only ever a *stricter* check: it must
    // still match what the note looks like now, so a caller cannot pin an older
    // version and overwrite a newer one. What gets frozen is always the
    // fingerprint this request observed, never the one the model supplied.
    if (parsed.expectedFingerprint !== null && parsed.expectedFingerprint !== current) {
      throw new IntegrationRuntimeError('REVISION_CONFLICT', 'Obsidian 笔记已在外部更新，请重新读取后再写入')
    }
    return this.record({
      context,
      kind: 'obsidian-note',
      profileId: parsed.vaultId,
      previewId: null,
      summary: `${current === null ? '新建' : '覆盖'} Obsidian 笔记 ${parsed.relativePath}（${parsed.content.length} 字符，Vault ${parsed.vaultId}）`,
      payload: {
        route: 'obsidian-note',
        vaultId: parsed.vaultId,
        relativePath: parsed.relativePath,
        content: parsed.content,
        expectedFingerprint: current,
        overwrites: current !== null
      } satisfies FrozenNoteWritePayload
    })
  }

  /** Managed frontmatter of an existing note. The preview contributes the
   * fingerprint and the changed-field list, so the card names what will change. */
  async requestNoteMetadata(input: unknown, context: AgentExternalActionContext): Promise<AgentExternalActionRequestResult> {
    const parsed = NoteMetadataPreviewInputSchema.parse(input)
    const preview = await this.options.ports.previewNoteMetadata(parsed)
    return this.record({
      context,
      kind: 'obsidian-metadata',
      profileId: parsed.vaultId,
      previewId: null,
      summary: `更新 Obsidian 笔记 ${parsed.relativePath} 的托管元数据（字段：${preview.changedFields.join('、') || '无'}）`,
      payload: {
        route: 'obsidian-metadata',
        vaultId: parsed.vaultId,
        relativePath: parsed.relativePath,
        patch: parsed.patch,
        expectedFingerprint: preview.fingerprint
      } satisfies FrozenMetadataPayload
    })
  }

  list(filter: { readonly runId?: string; readonly conversationId?: string; readonly status?: AgentExternalAction['status'] }): AgentExternalAction[] {
    return this.options.repository.listAgentExternalActions(filter)
  }

  /** Close decision windows that have passed, so the card cannot offer a write
   * whose preview no longer exists. */
  expire(): number {
    return this.options.repository.expireAgentExternalActions()
  }

  /**
   * Apply the user's decision.
   *
   * Rejection writes nothing. Approval executes the frozen payload through the
   * same connector entry points the UI uses, always with `confirmed`, and the
   * outcome is recorded as a receipt on the row *and* as a ledger record on the
   * run, so the conversation shows what actually happened without another model
   * turn. A connector conflict settles as `conflict`, not as a generic failure:
   * the user needs to know that something changed underneath them.
   */
  async decide(input: AgentExternalActionDecideInput): Promise<AgentExternalAction> {
    const decided = this.options.repository.decideAgentExternalAction(input)
    if (decided.status === 'rejected') {
      this.recordReceipt(decided, 'rejected', '已拒绝该外部写入请求，未修改任何外部数据。')
      return decided
    }
    const stored = this.options.repository.getAgentExternalActionPayload(decided.id)
    const payload = stored?.payload as FrozenPayload | undefined
    if (payload === undefined) {
      return this.settle(decided, 'failed', '写入请求已丢失，请让 Agent 重新生成预览。', null)
    }
    let secret: string | null = null
    try {
      secret = await this.integrationSecret(payload.route === 'zotero-import' ? decided.profileId : null)
      const receipt = await this.execute(payload, decided.profileId, secret)
      return this.settle(decided, 'executed', '', receipt)
    } catch (error) {
      const message = redactText(errorMessage(error), secret)
      const conflict = isConflict(error)
      return this.settle(decided, conflict ? 'conflict' : 'failed', message, null)
    }
  }

  private async execute(payload: FrozenPayload, profileId: string, secret: string | null): Promise<unknown> {
    switch (payload.route) {
      case 'zotero-import': {
        // The `confirmationToken` here is a fixed literal, not a capability: the
        // service only checks that it is non-empty. The real gate is the stored
        // decision this method is only reachable behind.
        const input = { previewId: payload.previewId, confirmed: true as const, confirmationToken: 'user-approved' }
        return await this.options.ports.executePaperToZotero(input, secret, profileId)
      }
      case 'literature-import': {
        const input = { previewId: payload.previewId, confirmed: true as const, confirmationToken: 'user-approved' }
        return await this.options.ports.executeStagingToZotero(input, secret, profileId)
      }
      case 'obsidian-note': {
        const note = await this.options.ports.writeNote({
          vaultId: payload.vaultId,
          relativePath: payload.relativePath,
          content: payload.content,
          expectedFingerprint: payload.expectedFingerprint
        })
        return { relativePath: note.relativePath, fingerprint: note.fingerprint }
      }
      case 'obsidian-metadata': {
        const note = await this.options.ports.applyNoteMetadata(ApplyNoteMetadataInputSchema.parse({
          vaultId: payload.vaultId,
          relativePath: payload.relativePath,
          patch: payload.patch,
          expectedFingerprint: payload.expectedFingerprint,
          confirmed: true
        }))
        return { relativePath: note.relativePath, fingerprint: note.fingerprint }
      }
    }
  }

  private settle(
    action: AgentExternalAction,
    status: 'executed' | 'failed' | 'conflict',
    error: string,
    receipt: unknown
  ): AgentExternalAction {
    const settled = this.options.repository.settleAgentExternalAction({
      id: action.id,
      status,
      ...(receipt === null ? {} : { receipt }),
      error
    })
    const detail = status === 'executed'
      ? `外部写入已执行：${action.summary}`
      : status === 'conflict'
        ? `外部写入冲突，未覆盖：${error}`
        : `外部写入失败：${error}`
    this.recordReceipt(settled, status, detail)
    return settled
  }

  /** Append the receipt to the run's ledger so the conversation shows the
   * outcome next to the request that produced it. */
  private recordReceipt(action: AgentExternalAction, status: string, detail: string): void {
    try {
      this.options.repository.upsertAgentRunRecord(action.runId, {
        recordKey: `external-action:${action.id}`,
        kind: 'tool',
        status: status === 'executed' ? 'completed' : status === 'rejected' ? 'canceled' : 'failed',
        title: `外部写入（${action.kind}）`,
        detail: detail.slice(0, 2_000),
        outputText: action.receipt === null ? null : JSON.stringify(action.receipt).slice(0, 4_000),
        toolName: 'agent.externalActions.decide',
        startedAt: action.createdAt,
        finishedAt: this.now().toISOString()
      })
    } catch {
      // A run deleted between the request and the decision must not turn the
      // decision itself into a failure: the row is already settled and audited.
    }
  }

  private async record(input: {
    readonly context: AgentExternalActionContext
    readonly kind: AgentExternalActionKind
    readonly profileId: string
    readonly previewId: string | null
    readonly summary: string
    readonly payload: FrozenPayload
  }): Promise<AgentExternalActionRequestResult> {
    const run = this.options.repository.getManagedAgentRun(input.context.runId)
    const action = this.options.repository.createAgentExternalAction({
      id: this.newId(),
      runId: run.id,
      conversationId: run.conversationId,
      kind: input.kind,
      profileId: input.profileId,
      summary: input.summary,
      previewId: input.previewId,
      payload: input.payload,
      expiresAt: new Date(this.now().getTime() + decisionWindowMs).toISOString()
    })
    return {
      action,
      message: `已生成待确认的外部写入（id=${action.id}）。尚未写入任何外部数据，`
        + `请在对话中的确认卡片里由用户批准或拒绝。不要在回答里说已经写入。`
    }
  }

  /**
   * Read one integration secret from Main.
   *
   * `null` is a legitimate answer (a Local-API Zotero profile needs no key) and
   * is not cached here: the vault stays in Main and every request reads it once.
   */
  private async integrationSecret(profileId: string | null): Promise<string | null> {
    if (profileId === null || profileId === '') return null
    const reader = this.options.requestIntegrationSecret
    if (reader === undefined) return null
    return reader(profileId)
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  private newId(): string {
    return this.options.newId?.() ?? randomUUID()
  }
}

/** Strip a secret from anything that will be stored or shown. An integration
 * key must never reach the receipt, the ledger or the error text. */
function redactText(value: string, secret: string | null): string {
  if (secret === null || secret === '') return value
  return String(redactSecretValue(value, secret))
}

/** A missing target file, as Node reports it. Zotero/connector failures are not
 * ENOENT, so this cannot swallow a real connection problem. */
function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * Detect "something changed underneath the preview".
 *
 * Two different layers can report it and both must settle as a conflict, not as
 * a generic failure: Core's own protocol errors, and the redacted external
 * errors the Obsidian write path wraps connector failures in.
 */
function isConflict(error: unknown): boolean {
  if (error instanceof IntegrationRuntimeError) return error.code === 'REVISION_CONFLICT'
  if (error instanceof RedactedExternalError) return error.code === 'EXTERNAL_CONFLICT'
  return false
}

function errorMessage(error: unknown): string {
  if (error instanceof IntegrationRuntimeError) return error.message
  return error instanceof Error ? error.message : '未知错误'
}

/** The card's text for both Zotero routes. It names the count, the target and
 * the transport the preview froze, so a user can tell two similar writes apart. */
function zoteroSummary(
  itemCount: number,
  profileId: string,
  preview: { readonly targetCollectionKey: string | null; readonly format: string; readonly transport: string },
  origin = ''
): string {
  return `写入 Zotero${origin}：${itemCount} 条文献 → 连接 ${profileId}`
    + `${preview.targetCollectionKey === null ? '' : `，分类 ${preview.targetCollectionKey}`}`
    + `（格式 ${preview.format}，传输 ${preview.transport}）`
}
