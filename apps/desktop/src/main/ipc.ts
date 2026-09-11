import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import type { AgentLedgerPush, AgentRpcMethod, RpcRequest, RpcResponse } from '@prw/contracts'
import {
  AgentLedgerPushSchema,
  AgentLedgerSubscriptionInputSchema,
  AgentRpcRequestSchema,
  RpcRequestSchema,
  IntegrationProfileSchema,
  SaveIntegrationProfileInputSchema,
  PaperImportFromZoteroInputSchema,
  ZoteroCapabilityInputSchema,
  ZoteroAuthorizeInputSchema,
  ZoteroAuthorizeResultSchema,
  ZoteroCollectionPageInputSchema,
  ZoteroItemPageInputSchema,
  ZoteroBibtexExportInputSchema,
  ZoteroImportInputSchema,
  ZoteroImportPreviewInputSchema,
  ZoteroImportPreviewSchema,
  ZoteroImportExecuteInputSchema,
  PaperToZoteroPreviewInputSchema,
  PaperToZoteroPreviewSchema,
  PaperToZoteroExecuteInputSchema,
  LiteratureStagingToZoteroPreviewInputSchema,
  LiteratureStagingToZoteroPreviewSchema,
  LiteratureStagingToZoteroExecuteInputSchema,
  KnowledgeEngineKindSchema,
  KnowledgeEngineSaveInputSchema,
  KnowledgeEngineTestInputSchema,
  IntegrationErrorSchema,
  SystemSelectFolderResultSchema,
  SystemRevealPathInputSchema,
  SystemSaveTextFileInputSchema,
  SystemSaveTextFileResultSchema
} from '@prw/contracts'
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { z, ZodError } from 'zod'
import type { CredentialRpcCredential } from '../core/client.js'
import { appError } from '../core/errors.js'
import {
  CredentialVaultError,
  credentialKey,
  type CredentialVault
} from './credentials.js'

export const WORKBENCH_RPC_CHANNEL = 'workbench:v2:rpc'
export const WORKBENCH_AGENT_RPC_CHANNEL = 'workbench:agent:v1'
/** Renderer registers interest in one run's ledger; Main forwards validated
 * pushes back on a separate, one-way channel. */
export const WORKBENCH_AGENT_LEDGER_SUBSCRIBE_CHANNEL = 'workbench:agent:ledger-subscribe'
export const WORKBENCH_AGENT_LEDGER_PUSH_CHANNEL = 'workbench:agent:ledger-push'

interface RegisterRpcOptions {
  readonly client: CoreRpcTransport
  readonly credentialVault: CredentialVault
  readonly getWindow: () => BrowserWindow | null
  readonly developmentUrl: string | undefined
}

export interface CoreRpcTransport {
  request(method: RpcRequest['method'], payload: unknown): Promise<RpcResponse>
  requestAgent?(method: AgentRpcMethod, payload: unknown): Promise<RpcResponse>
  /** Subscribe to normalized ledger pushes originating in the Core process.
   * Main is the only subscriber; it forwards to window webContents that asked
   * for the specific run. */
  onLedgerPush?(listener: (push: AgentLedgerPush) => void): () => void
  /** Main-only credential transport.  The implementation wraps the public
   * request in a typed side-channel envelope; credentials must never be put in
   * the public payload passed to request(). */
  requestWithCredential?(
    method: RpcRequest['method'],
    payload: unknown,
    credential: CredentialRpcCredential
  ): Promise<RpcResponse>
}

const IdInputSchema = z.object({ id: z.string().min(1) })
const ArchiveInputSchema = IdInputSchema.extend({ expectedRevision: z.int().nonnegative() })
const IntegrationSyncInputSchema = IdInputSchema.extend({
  direction: z.enum(['pull', 'push'])
})
const ExternalUrlSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value)
  if (!['https:', 'http:', 'zotero:', 'file:'].includes(url.protocol)) {
    context.addIssue({ code: 'custom', message: 'Only approved external URL protocols may be opened.' })
  }
  if (['https:', 'http:'].includes(url.protocol) && (url.username || url.password)) {
    context.addIssue({ code: 'custom', message: 'External URL must not contain credentials.' })
  }
})

const ZoteroLocationSchema = z.string().superRefine((value, context) => {
  if (!value) return
  try {
    const url = new URL(value)
    const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
    if (url.username || url.password) {
      context.addIssue({
        code: 'custom',
        message: 'Zotero 地址不能包含用户名或密码。'
      })
    }
    if ((!loopback && url.protocol !== 'https:') || (loopback && !['http:', 'https:'].includes(url.protocol))) {
      context.addIssue({
        code: 'custom',
        message: 'Zotero 地址必须使用 HTTPS，或使用 localhost/127.0.0.1 回环地址。'
      })
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'Zotero 地址不是有效 URL，请检查协议和主机名。' })
  }
})

class ExistingIntegrationLocationError extends Error {
  constructor(
    readonly code: 'CORE_UNAVAILABLE' | 'VALIDATION_FAILED',
    message: string,
    readonly retryable: boolean
  ) {
    super(message)
    this.name = 'ExistingIntegrationLocationError'
  }
}

function normalizeZoteroLocation(value: string): string {
  const candidate = value.trim() || process.env['ZOTERO_API_URL']?.trim() || ''
  if (!candidate) return ''
  const validated = ZoteroLocationSchema.parse(candidate)
  if (!validated) return ''
  const url = new URL(validated)
  url.search = ''
  url.hash = ''
  return url.toString()
}

function normalizeObsidianLocation(value: string): string {
  // Packaged builds keep the default Vault beside the installed executable;
  // development falls back to the repository root. An explicit setting or
  // adjacent .env value still wins and can be changed later in Settings.
  const envRoot = app.isPackaged ? dirname(app.getPath('exe')) : process.cwd()
  const configured = value.trim() || process.env['OBSIDIAN_DIR']?.trim() || ''
  // Resolve `.env` values relative to the same app directory that loads the
  // file; connectors always receive an absolute Vault root.
  return configured ? resolve(envRoot, configured) : join(envRoot, 'workbench')
}

type ZoteroProfileRequest =
  | z.infer<typeof ZoteroCapabilityInputSchema>
  | z.infer<typeof ZoteroAuthorizeInputSchema>
  | z.infer<typeof ZoteroCollectionPageInputSchema>
  | z.infer<typeof ZoteroItemPageInputSchema>
  | z.infer<typeof ZoteroBibtexExportInputSchema>
  | z.infer<typeof ZoteroImportInputSchema>
  | z.infer<typeof ZoteroImportPreviewInputSchema>
  | z.infer<typeof PaperToZoteroPreviewInputSchema>
  | z.infer<typeof LiteratureStagingToZoteroPreviewInputSchema>
  | z.infer<typeof PaperImportFromZoteroInputSchema>

export class SecureRpcRouter {
  /** Preview IDs are opaque to Renderer.  Main keeps only the profile mapping
   * needed to retrieve the safeStorage credential at execute time. */
  private readonly zoteroPreviewProfiles = new Map<string, string>()

  constructor(
    private readonly client: CoreRpcTransport,
    private readonly credentialVault: CredentialVault
  ) {}

  private parseZoteroProfileRequest(method: RpcRequest['method'], payload: unknown): ZoteroProfileRequest {
    switch (method) {
      case 'zotero.capability':
        return ZoteroCapabilityInputSchema.parse(payload)
      case 'zotero.authorize':
        return ZoteroAuthorizeInputSchema.parse(payload)
      case 'zotero.collections':
      case 'zotero.collectionsPage':
        return ZoteroCollectionPageInputSchema.parse(payload)
      case 'zotero.items':
      case 'zotero.itemsPage':
        return ZoteroItemPageInputSchema.parse(payload)
      case 'zotero.bibtexExport':
        return ZoteroBibtexExportInputSchema.parse(payload)
      case 'zotero.import':
        return ZoteroImportInputSchema.parse(payload)
      case 'zotero.importSelected.preview':
        return ZoteroImportPreviewInputSchema.parse(payload)
      case 'zotero.paperToZotero.preview':
        return PaperToZoteroPreviewInputSchema.parse(payload)
      case 'literature.stagingToZotero.preview':
        return LiteratureStagingToZoteroPreviewInputSchema.parse(payload)
      case 'papers.importFromZotero':
        return PaperImportFromZoteroInputSchema.parse(payload)
      default:
        throw new Error('The request does not identify a Zotero profile.')
    }
  }

  async route(method: RpcRequest['method'], payload: unknown): Promise<RpcResponse> {
    try {
      switch (method) {
        case 'integrations.save':
          return await this.saveIntegration(payload)
        case 'integrations.remove':
          return await this.removeProfile('integration', method, payload)
        case 'integrations.test':
          return await this.withSecret('integration', method, IdInputSchema.parse(payload))
        case 'integrations.sync':
          return await this.withSecret('integration', method, IntegrationSyncInputSchema.parse(payload))
        case 'knowledge.engines.save':
          return await this.saveKnowledgeEngine(payload)
        case 'knowledge.engines.test':
          return await this.withEngineSecret(KnowledgeEngineTestInputSchema.parse(payload))
        case 'zotero.collections':
        case 'zotero.collectionsPage':
        case 'zotero.items':
        case 'zotero.itemsPage':
        case 'zotero.bibtexExport':
        case 'zotero.import':
        case 'zotero.capability':
        case 'zotero.authorize':
        case 'zotero.importSelected.preview':
        case 'zotero.paperToZotero.preview':
        case 'literature.stagingToZotero.preview':
        case 'papers.importFromZotero': {
          const profileValue = this.parseZoteroProfileRequest(method, payload)
          const secret = await this.credentialVault.get(credentialKey('integration', profileValue.profileId))
          const response = await this.requestWithCredential(method, profileValue, profileValue.profileId, secret)
          if (response.ok && method === 'zotero.authorize') {
            const authorization = response.data && typeof response.data === 'object' ? response.data as { key?: unknown; remember?: unknown } : {}
            if (typeof authorization.key !== 'string' || authorization.key.length === 0 || typeof authorization.remember !== 'boolean') return { id: response.id, ok: false, error: appError('VALIDATION_FAILED', 'Zotero 授权响应格式无效。') }
            await this.credentialVault.set(credentialKey('integration', profileValue.profileId), authorization.key)
            return { id: response.id, ok: true, data: ZoteroAuthorizeResultSchema.parse({ authorized: true, remember: authorization.remember }) }
          }
          if (response.ok && (method === 'zotero.importSelected.preview' || method === 'zotero.paperToZotero.preview' || method === 'literature.stagingToZotero.preview')) {
            const preview = (method === 'zotero.importSelected.preview'
              ? ZoteroImportPreviewSchema
              : method === 'zotero.paperToZotero.preview'
                ? PaperToZoteroPreviewSchema
                : LiteratureStagingToZoteroPreviewSchema).safeParse(response.data)
            if (preview.success) this.zoteroPreviewProfiles.set(preview.data.previewId, preview.data.profileId)
          }
          return response
        }
        case 'zotero.importSelected.execute':
        case 'zotero.paperToZotero.execute':
        case 'literature.stagingToZotero.execute':
          // Execute payloads contain only an opaque confirmation/preview ID;
          // Main resolves the profile mapping without exposing credentials to
          // Renderer.  Unknown/expired previews are delegated to Core.
          {
            const input = method === 'zotero.importSelected.execute'
              ? ZoteroImportExecuteInputSchema.parse(payload)
              : method === 'zotero.paperToZotero.execute'
                ? PaperToZoteroExecuteInputSchema.parse(payload)
                : LiteratureStagingToZoteroExecuteInputSchema.parse(payload)
            const profileId = this.zoteroPreviewProfiles.get(input.previewId)
            if (profileId === undefined) return this.client.request(method, input)
            const secret = await this.credentialVault.get(credentialKey('integration', profileId))
            this.zoteroPreviewProfiles.delete(input.previewId)
            return this.requestWithCredential(method, input, profileId, secret)
          }
      case 'system.openExternal':
          await shell.openExternal(ExternalUrlSchema.parse(payload))
          return { id: 'external-opened', ok: true, data: null }
        default:
          return this.client.request(method, payload)
      }
    } catch (error) {
      return { id: 'secure-request', ok: false, error: normalizeMainError(error) }
    }
  }

  async runSchedule(id: string): Promise<RpcResponse> {
    // Keep the method for the Main-only scheduler's structural dependency,
    // but never route a legacy schedule command through the V2 Core transport.
    return {
      id: 'legacy-schedule-disabled',
      ok: false,
      error: appError('FEATURE_DISABLED', `Schedule execution is not available in V2 (${id}).`)
    }
  }

  private async saveIntegration(payload: unknown): Promise<RpcResponse> {
    const input = SaveIntegrationProfileInputSchema.parse(payload)
    const { credential, ...publicFields } = input
    const id = input.id ?? randomUUID()
    // Obsidian paths are intentionally not echoed to the Renderer. When a
    // user edits a profile (for example to toggle it) and leaves the path
    // field blank, retain the existing value instead of silently replacing it
    // with an empty string when packaged mode has no .env fallback. Zotero
    // locations follow the same rule so a blank edit cannot disconnect a
    // working Local API profile. The lookup stays in Main and only the
    // validated profile is forwarded to Core; no path is logged or returned.
    const existingLocation = input.id !== undefined && !input.location.trim() &&
      (input.provider === 'obsidian' || input.provider === 'zotero')
      ? await this.lookupIntegrationLocation(input.id, input.provider)
      : null
    const location = input.location.trim() || existingLocation || ''
    const normalizedPublicFields = input.provider === 'zotero'
      ? { ...publicFields, location: normalizeZoteroLocation(location) }
      : input.provider === 'obsidian'
        ? { ...publicFields, location: normalizeObsidianLocation(location) }
        : publicFields
    const key = credentialKey('integration', id)
    const secretWasProvided = credential !== undefined && credential.length > 0
    const previous = secretWasProvided ? await this.credentialVault.get(key) : null
    if (secretWasProvided) await this.credentialVault.set(key, credential)
    try {
      const secret = secretWasProvided && credential !== undefined
        ? credential
        : await this.credentialVault.get(key)
      const response = await this.requestWithCredential('integrations.save', {
        ...normalizedPublicFields,
        id,
      }, id, secret)
      if (!response.ok && secretWasProvided) await this.restoreSecret(key, previous)
      return response
    } catch (error) {
      if (secretWasProvided) await this.restoreSecret(key, previous)
      throw error
    }
  }

  private async saveKnowledgeEngine(payload: unknown): Promise<RpcResponse> {
    const input = KnowledgeEngineSaveInputSchema.parse(payload)
    const { credential, ...publicFields } = input
    const kind = KnowledgeEngineKindSchema.parse(input.kind)
    const key = credentialKey('engine', kind)
    const secretWasProvided = credential !== undefined && credential.length > 0
    const previous = secretWasProvided ? await this.credentialVault.get(key) : null
    if (secretWasProvided) await this.credentialVault.set(key, credential)
    try {
      const secret = secretWasProvided ? credential ?? null : await this.credentialVault.get(key)
      const response = await this.requestWithCredential('knowledge.engines.save', publicFields, kind, secret)
      if (!response.ok && secretWasProvided) await this.restoreSecret(key, previous)
      return response
    } catch (error) {
      if (secretWasProvided) await this.restoreSecret(key, previous)
      throw error
    }
  }

  private async lookupIntegrationLocation(
    id: string,
    provider: 'obsidian' | 'zotero'
  ): Promise<string> {
    const response = await this.client.request('integrations.list', null)
    if (!response.ok) {
      // Do not risk erasing a configured external location when Core cannot
      // read the current profile. Propagate the typed response through a
      // regular error so the caller receives a truthful failure.
      throw new ExistingIntegrationLocationError(
        'CORE_UNAVAILABLE',
        '无法读取现有连接配置，未修改连接地址。请稍后重试。',
        true
      )
    }
    const parsed = z.array(IntegrationProfileSchema).safeParse(response.data)
    if (!parsed.success) {
      throw new ExistingIntegrationLocationError(
        'VALIDATION_FAILED',
        '现有连接配置格式无效，未修改连接地址。请重新打开设置并输入完整位置。',
        false
      )
    }
    const profile = parsed.data.find((candidate) => candidate.id === id && candidate.provider === provider)
    if (profile === undefined) {
      throw new ExistingIntegrationLocationError(
        'VALIDATION_FAILED',
        '找不到要编辑的连接配置，未修改连接地址。请刷新设置后重试。',
        false
      )
    }
    return profile.location.trim()
  }

  private async removeProfile(
    kind: 'integration',
    method: 'integrations.remove',
    payload: unknown
  ): Promise<RpcResponse> {
    const input = ArchiveInputSchema.parse(payload)
    const response = await this.client.request(method, input)
    if (response.ok) await this.credentialVault.remove(credentialKey(kind, input.id))
    return response
  }

  private async withSecret(
    kind: 'integration',
    method: 'integrations.test' | 'integrations.sync',
    input: { id: string; [key: string]: unknown }
  ): Promise<RpcResponse> {
    const secret = await this.credentialVault.get(credentialKey(kind, input.id))
    return this.requestWithCredential(method, input, input.id, secret)
  }

  private async withEngineSecret(input: { kind: z.infer<typeof KnowledgeEngineKindSchema> }): Promise<RpcResponse> {
    const kind = KnowledgeEngineKindSchema.parse(input.kind)
    const secret = await this.credentialVault.get(credentialKey('engine', kind))
    return this.requestWithCredential('knowledge.engines.test', input, kind, secret)
  }

  private requestWithCredential(
    method: RpcRequest['method'],
    payload: unknown,
    profileId: string,
    secret: string | null
  ): Promise<RpcResponse> {
    const transport = this.client.requestWithCredential
    if (transport === undefined) {
      return Promise.resolve({
        id: 'secure-request',
        ok: false,
        error: appError('CORE_UNAVAILABLE', 'Credential transport is not available.', true)
      })
    }
    return transport.call(this.client, method, payload, { profileId, secret })
  }

  private async restoreSecret(key: string, previous: string | null): Promise<void> {
    if (previous === null) await this.credentialVault.remove(key)
    else await this.credentialVault.set(key, previous)
  }
}

export function registerRpcHandler(options: RegisterRpcOptions): () => void {
  const router = new SecureRpcRouter(options.client, options.credentialVault)
  ipcMain.handle(
    WORKBENCH_RPC_CHANNEL,
    async (event: IpcMainInvokeEvent, method: unknown, payload: unknown): Promise<RpcResponse> => {
      if (!isTrustedSender(event, options.getWindow(), options.developmentUrl)) {
        return {
          id: 'rejected-request',
          ok: false,
          error: appError('NOT_AUTHORIZED', 'The request did not come from the workbench window.')
        }
      }

      const provisional: unknown = { id: 'validated-in-core', method, payload }
      const parsed = RpcRequestSchema.safeParse(provisional)
      if (!parsed.success) {
        return {
          id: 'invalid-request',
          ok: false,
          error: appError('VALIDATION_FAILED', 'The RPC method is not supported.', false, {
            issues: parsed.error.issues
          })
        }
      }
      if (parsed.data.method === 'system.selectFolder') {
        return selectFolder(options, event)
      }
      if (parsed.data.method === 'system.revealPath') {
        return revealPath(options, event, SystemRevealPathInputSchema.parse(parsed.data.payload))
      }
      if (parsed.data.method === 'system.saveTextFile') {
        return saveTextFile(options, event, SystemSaveTextFileInputSchema.parse(parsed.data.payload))
      }
      return router.route(parsed.data.method, parsed.data.payload)
    }
  )
  ipcMain.handle(
    WORKBENCH_AGENT_RPC_CHANNEL,
    async (event: IpcMainInvokeEvent, method: unknown, payload: unknown): Promise<RpcResponse> => {
      if (!isTrustedSender(event, options.getWindow(), options.developmentUrl)) {
        return {
          id: 'rejected-agent-request',
          ok: false,
          error: appError('NOT_AUTHORIZED', 'The request did not come from the workbench window.')
        }
      }
      const provisional: unknown = { id: 'validated-agent-in-main', method, payload }
      const parsed = AgentRpcRequestSchema.safeParse(provisional)
      if (!parsed.success) {
        return {
          id: 'invalid-agent-request',
          ok: false,
          error: appError('VALIDATION_FAILED', 'The Agent request did not match the expected shape.', false, {
            issues: parsed.error.issues
          })
        }
      }
      const requestAgent = options.client.requestAgent
      if (requestAgent === undefined) {
        return {
          id: parsed.data.id,
          ok: false,
          error: appError('CORE_UNAVAILABLE', 'The Agent service is not available.', true)
        }
      }
      return requestAgent.call(options.client, parsed.data.method, parsed.data.payload)
    }
  )

  // Ledger subscriptions are tracked per renderer window (`webContents.id`).
  // Main forwards only pushes whose run was actually requested by that window,
  // and a window's subscriptions disappear with the window.
  const ledgerSubscriptions = new Map<number, { readonly webContents: WebContents; readonly runIds: Set<string> }>()
  const disposeLedgerPush = options.client.onLedgerPush?.((push) => {
    for (const subscription of ledgerSubscriptions.values()) {
      if (!subscription.runIds.has(push.runId)) continue
      if (subscription.webContents.isDestroyed()) continue
      subscription.webContents.send(WORKBENCH_AGENT_LEDGER_PUSH_CHANNEL, push)
    }
  })
  ipcMain.handle(
    WORKBENCH_AGENT_LEDGER_SUBSCRIBE_CHANNEL,
    (event: IpcMainInvokeEvent, payload: unknown): { readonly ok: boolean } => {
      if (!isTrustedSender(event, options.getWindow(), options.developmentUrl)) return { ok: false }
      const parsed = AgentLedgerSubscriptionInputSchema.safeParse(payload)
      if (!parsed.success) return { ok: false }
      const senderId = event.sender.id
      let subscription = ledgerSubscriptions.get(senderId)
      if (!subscription) {
        const created = { webContents: event.sender, runIds: new Set<string>() }
        subscription = created
        ledgerSubscriptions.set(senderId, created)
        event.sender.once('destroyed', () => { ledgerSubscriptions.delete(senderId) })
        // A reload reuses the same `webContents.id`, so the previous document's
        // subscriptions would otherwise keep pushing into the new document.
        // `isSameDocument` must be excluded: fragment/history navigation (the
        // calendar sets `window.location.hash`) fires this event too, and
        // clearing there would silently stop live pushes for the rest of a run.
        event.sender.on('did-start-navigation', (details: { readonly isMainFrame: boolean; readonly isSameDocument: boolean }) => {
          if (details.isMainFrame && !details.isSameDocument) created.runIds.clear()
        })
      }
      if (parsed.data.action === 'subscribe') {
        // Bound the set so a renderer bug cannot accumulate run ids forever.
        if (subscription.runIds.size >= 200) return { ok: false }
        subscription.runIds.add(parsed.data.runId)
      } else {
        subscription.runIds.delete(parsed.data.runId)
      }
      return { ok: true }
    }
  )

  return () => {
    disposeLedgerPush?.()
    ledgerSubscriptions.clear()
    ipcMain.removeHandler(WORKBENCH_AGENT_LEDGER_SUBSCRIBE_CHANNEL)
    ipcMain.removeHandler(WORKBENCH_RPC_CHANNEL)
    ipcMain.removeHandler(WORKBENCH_AGENT_RPC_CHANNEL)
  }
}

async function revealPath(options: RegisterRpcOptions, event: IpcMainInvokeEvent, input: z.infer<typeof SystemRevealPathInputSchema>): Promise<RpcResponse> {
  if (!isTrustedSender(event, options.getWindow(), options.developmentUrl)) {
    return { id: 'rejected-request', ok: false, error: appError('NOT_AUTHORIZED', 'The request did not come from the workbench window.') }
  }
  try {
    const response = await options.client.request('integrations.list', null)
    if (!response.ok) return response
    const profiles = z.array(IntegrationProfileSchema).parse(response.data)
    const profile = profiles.find((item) => item.id === input.vaultId && item.provider === 'obsidian')
    if (!profile || !profile.location.trim()) return { id: 'reveal-path', ok: false, error: appError('NOT_FOUND', 'Obsidian Vault 配置不存在。') }
    const root = resolve(profile.location)
    const candidate = resolve(root, ...input.relativePath.split('/'))
    const pathFromRoot = relative(root, candidate)
    if (isAbsolute(pathFromRoot) || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || input.relativePath.split('/').some((segment) => segment.toLocaleLowerCase() === '.obsidian')) {
      return { id: 'reveal-path', ok: false, error: appError('VALIDATION_FAILED', '只能查看 Vault 内的安全相对路径。') }
    }
    shell.showItemInFolder(candidate)
    return { id: 'reveal-path', ok: true, data: null }
  } catch (error) {
    return { id: 'reveal-path', ok: false, error: normalizeMainError(error) }
  }
}

async function selectFolder(options: RegisterRpcOptions, event: IpcMainInvokeEvent): Promise<RpcResponse> {
  if (!isTrustedSender(event, options.getWindow(), options.developmentUrl)) {
    return {
      id: 'rejected-request',
      ok: false,
      error: appError('NOT_AUTHORIZED', 'The request did not come from the workbench window.')
    }
  }
  const owner = options.getWindow()
  if (!owner || owner.isDestroyed()) {
    return {
      id: 'system-select-folder',
      ok: false,
      error: appError('NOT_AUTHORIZED', '工作台窗口不可用，请重试。')
    }
  }
  try {
    const result = await dialog.showOpenDialog(owner, {
      properties: ['openDirectory'],
      title: '选择 Obsidian Vault 文件夹'
    })
    // Cancel is a successful, nullable result. Electron only returns existing
    // directory paths for openDirectory; service-side realpath/containment
    // checks remain authoritative before saving a profile.
    const selected = result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    return { id: 'system-select-folder', ok: true, data: SystemSelectFolderResultSchema.parse(selected) }
  } catch (error) {
    return { id: 'system-select-folder', ok: false, error: normalizeMainError(error) }
  }
}

async function saveTextFile(
  options: RegisterRpcOptions,
  event: IpcMainInvokeEvent,
  input: z.infer<typeof SystemSaveTextFileInputSchema>
): Promise<RpcResponse> {
  if (!isTrustedSender(event, options.getWindow(), options.developmentUrl)) {
    return { id: 'rejected-request', ok: false, error: appError('NOT_AUTHORIZED', 'The request did not come from the workbench window.') }
  }
  try {
    const downloadsRoot = app.getPath('downloads')
    await mkdir(downloadsRoot, { recursive: true })
    // Save only to the OS Downloads directory. The filename schema already
    // disallows separators and traversal; the wx loop prevents overwriting a
    // previous export when the user repeats a batch operation.
    let fileName = input.fileName
    const extension = input.fileName.match(/(\.[^.]+)$/u)?.[1] ?? ''
    const stem = extension.length > 0
      ? input.fileName.slice(0, -extension.length)
      : input.fileName
    for (let suffix = 0; suffix < 100; suffix += 1) {
      const candidate = suffix === 0
        ? fileName
        : `${stem}-${suffix}${extension}`
      try {
        await writeFile(join(downloadsRoot, candidate), input.content, { encoding: 'utf8', flag: 'wx' })
        fileName = candidate
        return {
          id: 'system-save-text-file',
          ok: true,
          data: SystemSaveTextFileResultSchema.parse({ saved: true, fileName, location: 'downloads' })
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
      }
    }
    return { id: 'system-save-text-file', ok: false, error: appError('CONFLICT', '下载目录中已有过多同名导出文件，请整理后重试。') }
  } catch (error) {
    return { id: 'system-save-text-file', ok: false, error: normalizeMainError(error) }
  }
}

function normalizeMainError(error: unknown) {
  if (error instanceof CredentialVaultError) {
    return appError(error.code, error.message)
  }
  if (error instanceof ExistingIntegrationLocationError) {
    return appError(error.code, error.message, error.retryable)
  }
  if (error instanceof ZodError) {
    return appError('VALIDATION_FAILED', 'The request did not match the expected shape.', false, {
      issues: error.issues
    })
  }
  // Core already emits a redacted, field-addressable IntegrationError for
  // input and remote-response failures. Preserve that envelope if a Main
  // transport implementation surfaces it as a thrown value rather than a
  // normal RpcResponse, instead of collapsing it into INTERNAL_ERROR.
  const integrationError = IntegrationErrorSchema.safeParse(error)
  if (integrationError.success) return integrationError.data
  return appError('INTERNAL_ERROR', 'The secure request could not be completed.')
}

function isTrustedSender(
  event: IpcMainInvokeEvent,
  window: BrowserWindow | null,
  developmentUrl?: string
): boolean {
  if (!window || window.isDestroyed() || event.sender !== window.webContents) return false
  if (event.senderFrame !== window.webContents.mainFrame) return false

  const senderUrl = event.senderFrame.url
  try {
    const url = new URL(senderUrl)
    if (url.protocol === 'workbench:' && url.hostname === 'app') return true
    if (!developmentUrl) return false
    return url.origin === new URL(developmentUrl).origin
  } catch {
    return false
  }
}
