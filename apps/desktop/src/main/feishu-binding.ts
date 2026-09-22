import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { URL } from 'node:url'
import {
  type FeishuBeginBindResult,
  type FeishuBindingStatus,
  type FeishuSaveAppInput,
  type FeishuSendTestResult
} from '@prw/contracts'

/**
 * 飞书本机扫码绑定（Feishu OAuth binding, Main-owned).
 *
 * The workbench binds a Feishu self-built app entirely from Main:
 * - credentials (app_id / app_secret) and the OAuth token pair live in the
 *   safeStorage vault under `v2:integration:feishu:*`; nothing secret reaches
 *   the renderer or Core,
 * - `beginBind` starts a local HTTP callback server on a fixed loopback port,
 *   opens the Feishu authorize page (QR scan / account login) in the system
 *   browser, validates the returned `state` (CSRF), exchanges the `code` for a
 *   `user_access_token`, fetches the bound user's open_id and stores the pair,
 * - messages are sent with the app's `tenant_access_token` (bot identity) to
 *   the bound user's open_id, so the push arrives from the bot.
 *
 * The controller is Electron-free apart from `shell.openExternal`, which is
 * injected through options so a plain-node test can drive the OAuth state
 * machine with a recording double.
 */

const FEISHU_API_BASE = 'https://open.feishu.cn'
const CALLBACK_PATH = '/feishu/callback'
const BIND_TIMEOUT_MS = 5 * 60_000

/** One logical secret per vault entry; ids are stable so upgrades never
 * orphan a binding. */
const VAULT_APP_ID = 'feishu.app_id'
const VAULT_APP_SECRET = 'feishu.app_secret'
const VAULT_USER_TOKENS = 'feishu.user_tokens'
const VAULT_PROFILE = 'feishu.profile'

interface VaultLike {
  get(key: string): Promise<string | null>
  set(key: string, secret: string): Promise<void>
  remove(key: string): Promise<void>
}

interface FeishuTokenSet {
  accessToken: string
  refreshToken: string
  /** ISO expiry of `accessToken`. */
  expiresAt: string
  /** ISO expiry of `refreshToken`. */
  refreshExpiresAt: string
  scope: string
}

interface FeishuProfile {
  openId: string
  name: string
  appId: string
}

export interface FeishuBindingControllerOptions {
  readonly vault: VaultLike
  /** Vault key prefix helper; defaults to the app's `credentialKey`. */
  readonly keyOf?: (id: string) => string
  readonly port?: number
  /** Browser opener, injected so tests can record the authorize URL. */
  readonly openExternal?: (url: string) => Promise<void>
  readonly fetchImpl?: typeof fetch
  readonly now?: () => Date
}

export class FeishuBindingError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'FeishuBindingError'
    this.code = code
  }
}

export class FeishuBindingController {
  private readonly vault: VaultLike
  private readonly keyOf: (id: string) => string
  private readonly port: number
  private readonly openExternal: (url: string) => Promise<void>
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date
  private server: Server | null = null
  private pendingState: { value: string; expiresAt: number } | null = null

  constructor(options: FeishuBindingControllerOptions) {
    this.vault = options.vault
    this.keyOf = options.keyOf ?? ((id) => `v2:integration:${id}`)
    this.port = options.port ?? 35_231
    // Electron is imported lazily so the controller stays importable in plain
    // node tests that inject `openExternal` / `fetchImpl`.
    this.openExternal = options.openExternal ?? (async (url) => {
      const { shell } = await import('electron')
      await shell.openExternal(url)
    })
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args))
    this.now = options.now ?? (() => new Date())
  }

  async saveApp(input: FeishuSaveAppInput): Promise<FeishuBindingStatus> {
    await this.vault.set(this.keyOf(VAULT_APP_ID), input.appId)
    await this.vault.set(this.keyOf(VAULT_APP_SECRET), input.appSecret)
    return this.getStatus()
  }

  async getStatus(): Promise<FeishuBindingStatus> {
    const appId = await this.vault.get(this.keyOf(VAULT_APP_ID))
    const appSecret = await this.vault.get(this.keyOf(VAULT_APP_SECRET))
    const tokens = await this.readTokens()
    const profile = await this.readProfile()
    const configured = appId !== null && appSecret !== null
    const bound = configured && tokens !== null && profile !== null
    return {
      bound,
      appId,
      boundUserOpenId: profile?.openId ?? null,
      boundUserName: profile?.name ?? null,
      expiresAt: tokens?.expiresAt ?? null,
      message: bound
        ? `已绑定 ${profile?.name ?? ''}（${profile?.appId ?? appId ?? ''}）`
        : configured
          ? '已保存应用凭据，尚未完成扫码绑定。'
          : '未配置飞书应用。请填写自建应用的 App ID 与 App Secret。'
    }
  }

  /** Start the local callback wait and open the authorize page. The renderer
   * polls `getStatus` afterwards until the state flips to bound or fails. */
  async beginBind(): Promise<FeishuBeginBindResult> {
    const appId = await this.vault.get(this.keyOf(VAULT_APP_ID))
    const appSecret = await this.vault.get(this.keyOf(VAULT_APP_SECRET))
    if (appId === null || appSecret === null) {
      return { ok: false, message: '请先在设置中保存飞书应用的 App ID 与 App Secret。' }
    }
    if (this.pendingState !== null) {
      return { ok: false, message: '已有一个绑定流程在进行中，请完成或等待其超时后再试。' }
    }
    try {
      await this.ensureServer()
    } catch (error) {
      return { ok: false, message: `本地回调服务启动失败：${error instanceof Error ? error.message : String(error)}` }
    }
    const state = randomUUID()
    this.pendingState = { value: state, expiresAt: this.now().getTime() + BIND_TIMEOUT_MS }
    const redirectUri = this.redirectUri()
    const authorize = new URL('/open-apis/authen/v1/authorize', FEISHU_API_BASE)
    authorize.searchParams.set('app_id', appId)
    authorize.searchParams.set('redirect_uri', redirectUri)
    // Minimal scope: user identity for the binding card. Message delivery uses
    // the app's tenant_access_token, which needs the `im:message` permission
    // enabled in the console instead.
    authorize.searchParams.set('scope', 'contact:user.base:readonly')
    authorize.searchParams.set('state', state)
    await this.openExternal(authorize.toString())
    return { ok: true, message: '已在系统浏览器中打开飞书授权页（扫码或账号登录）。完成后本页会自动回跳，稍候将显示绑定结果。' }
  }

  async unbind(): Promise<FeishuBindingStatus> {
    this.pendingState = null
    await Promise.all([
      this.vault.remove(this.keyOf(VAULT_APP_ID)),
      this.vault.remove(this.keyOf(VAULT_APP_SECRET)),
      this.vault.remove(this.keyOf(VAULT_USER_TOKENS)),
      this.vault.remove(this.keyOf(VAULT_PROFILE))
    ])
    await this.closeServer()
    return this.getStatus()
  }

  async sendTest(): Promise<FeishuSendTestResult> {
    const status = await this.getStatus()
    if (!status.bound || status.boundUserOpenId === null || status.boundUserName === null) {
      return { ok: false, message: status.message }
    }
    try {
      await this.sendText(status.boundUserOpenId, '✅ 工作台飞书绑定成功。每日文献推送将从此机器人送达。')
      return { ok: true, message: `测试消息已发送给 ${status.boundUserName}。` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Send a text message to the bound user (bot identity). Reused by the daily
   * literature message workflow. */
  async sendText(openId: string, text: string): Promise<void> {
    const tenantToken = await this.ensureTenantToken()
    const url = new URL('/open-apis/im/v1/messages', FEISHU_API_BASE)
    url.searchParams.set('receive_id_type', 'open_id')
    const response = await this.fetchImpl(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenantToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({ receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }) })
    })
    const body = await this.readJson<{ code?: number; msg?: string }>(response)
    if (!response.ok || body.code !== 0) {
      throw new FeishuBindingError(
        'FEISHU_SEND_FAILED',
        `飞书发送消息失败（${response.status} / code ${body.code ?? 'n/a'}）：${body.msg ?? '未知错误'}。请确认应用已开启「获取与发送单聊、群组消息」权限并已发布，且你的账号在可用范围内。`
      )
    }
  }

  private async ensureTenantToken(): Promise<string> {
    const appId = await this.vault.get(this.keyOf(VAULT_APP_ID))
    const appSecret = await this.vault.get(this.keyOf(VAULT_APP_SECRET))
    if (appId === null || appSecret === null) {
      throw new FeishuBindingError('FEISHU_NOT_CONFIGURED', '未配置飞书应用凭据。')
    }
    const response = await this.fetchImpl(`${FEISHU_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret })
    })
    const body = await this.readJson<{ code?: number; msg?: string; tenant_access_token?: string }>(response)
    if (!response.ok || body.code !== 0 || !body.tenant_access_token) {
      throw new FeishuBindingError(
        'FEISHU_TENANT_TOKEN_FAILED',
        `获取 tenant_access_token 失败（${response.status} / code ${body.code ?? 'n/a'}）：${body.msg ?? '未知错误'}。请检查 App ID 与 App Secret。`
      )
    }
    return body.tenant_access_token
  }

  private async handleCallback(code: string, state: string): Promise<string> {
    if (this.pendingState === null || this.pendingState.value !== state) {
      return this.html('绑定失败', '回调状态校验失败（state 不匹配或已过期）。请关闭本页，在应用中重新发起绑定。')
    }
    this.pendingState = null
    const appId = await this.vault.get(this.keyOf(VAULT_APP_ID))
    const appSecret = await this.vault.get(this.keyOf(VAULT_APP_SECRET))
    if (appId === null || appSecret === null) {
      return this.html('绑定失败', '应用凭据缺失，请重新保存 App ID 与 App Secret。')
    }
    const tokenResponse = await this.fetchImpl(`${FEISHU_API_BASE}/open-apis/authen/v1/oidc/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, app_id: appId, app_secret: appSecret })
    })
    const tokenBody = await this.readJson<{
      code?: number
      msg?: string
      data?: { access_token?: string; refresh_token?: string; expires_in?: number; refresh_expires_in?: number; scope?: string }
    }>(tokenResponse)
    const tokenData = tokenBody.data
    if (!tokenResponse.ok || tokenBody.code !== 0 || !tokenData?.access_token) {
      return this.html(
        '绑定失败',
        `换取访问令牌失败（${tokenResponse.status} / code ${tokenBody.code ?? 'n/a'}）：${tokenBody.msg ?? '未知错误'}。请确认重定向 URL 已在应用后台「安全设置 → 重定向 URL」中登记为 ${this.redirectUri()}。`
      )
    }
    const nowMs = this.now().getTime()
    const tokens: FeishuTokenSet = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token ?? '',
      expiresAt: new Date(nowMs + (tokenData.expires_in ?? 7200) * 1000).toISOString(),
      refreshExpiresAt: new Date(nowMs + (tokenData.refresh_expires_in ?? 2_592_000) * 1000).toISOString(),
      scope: tokenData.scope ?? ''
    }
    const userResponse = await this.fetchImpl(`${FEISHU_API_BASE}/open-apis/authen/v1/user_info`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` }
    })
    const userBody = await this.readJson<{
      code?: number
      msg?: string
      data?: { open_id?: string; name?: string }
    }>(userResponse)
    const openId = userBody.data?.open_id
    const name = userBody.data?.name ?? '未知用户'
    if (!userResponse.ok || userBody.code !== 0 || !openId) {
      return this.html(
        '绑定失败',
        `获取用户信息失败（${userResponse.status} / code ${userBody.code ?? 'n/a'}）：${userBody.msg ?? '未知错误'}。`
      )
    }
    const profile: FeishuProfile = { openId, name, appId }
    await this.vault.set(this.keyOf(VAULT_USER_TOKENS), JSON.stringify(tokens))
    await this.vault.set(this.keyOf(VAULT_PROFILE), JSON.stringify(profile))
    return this.html('绑定成功', `已绑定飞书用户「${name}」。请关闭本页并返回工作台。`)
  }

  private async ensureServer(): Promise<void> {
    if (this.server !== null) return
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${this.port}`)
      if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('Not found')
        return
      }
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      void (async (): Promise<void> => {
        const html = code !== null && state !== null
          ? await this.handleCallback(code, state)
          : this.html('绑定失败', '回调缺少 code 或 state 参数。')
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(html)
      })()
    })
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        throw new FeishuBindingError('FEISHU_CALLBACK_PORT_BUSY', `本地回调端口 ${this.port} 被占用，请关闭占用程序后重试。`)
      }
      throw error
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.port, '127.0.0.1')
    })
    this.server = server
  }

  private async closeServer(): Promise<void> {
    const server = this.server
    this.server = null
    if (server === null) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private redirectUri(): string {
    return `http://127.0.0.1:${this.port}${CALLBACK_PATH}`
  }

  private async readTokens(): Promise<FeishuTokenSet | null> {
    const raw = await this.vault.get(this.keyOf(VAULT_USER_TOKENS))
    if (raw === null) return null
    try {
      const parsed = JSON.parse(raw) as Partial<FeishuTokenSet>
      if (typeof parsed.accessToken !== 'string' || parsed.accessToken.length === 0) return null
      return {
        accessToken: parsed.accessToken,
        refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : '',
        expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : new Date(0).toISOString(),
        refreshExpiresAt: typeof parsed.refreshExpiresAt === 'string' ? parsed.refreshExpiresAt : new Date(0).toISOString(),
        scope: typeof parsed.scope === 'string' ? parsed.scope : ''
      }
    } catch {
      return null
    }
  }

  private async readProfile(): Promise<FeishuProfile | null> {
    const raw = await this.vault.get(this.keyOf(VAULT_PROFILE))
    if (raw === null) return null
    try {
      const parsed = JSON.parse(raw) as Partial<FeishuProfile>
      if (typeof parsed.openId !== 'string' || parsed.openId.length === 0) return null
      return {
        openId: parsed.openId,
        name: typeof parsed.name === 'string' ? parsed.name : '未知用户',
        appId: typeof parsed.appId === 'string' ? parsed.appId : ''
      }
    } catch {
      return null
    }
  }

  private async readJson<T>(response: Response): Promise<T> {
    try {
      return await response.json() as T
    } catch {
      return { code: -1, msg: '响应不是有效 JSON' } as T
    }
  }

  private html(title: string, body: string): string {
    const escaped = body.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;padding:48px;text-align:center"><h1>${title}</h1><p>${escaped}</p></body></html>`
  }
}
