import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { CoreRpcClient } from '../core/client.js'
import {
  IntegrationProfileSchema,
  ObsidianVaultLayoutInitializeInputSchema,
  ObsidianVaultLayoutPlanSchema,
  ObsidianVaultLayoutReceiptSchema,
  SaveIntegrationProfileInputSchema
} from '@prw/contracts'
import {
  CredentialVault,
  credentialKey,
  electronSecretCryptography
} from './credentials.js'
import { readAgentCredential, removeAgentCredential, writeAgentCredential } from './agent-credentials.js'
import { registerRpcHandler } from './ipc.js'
import { FeishuBindingController } from './feishu-binding.js'
import { migrateLegacyUserData } from './data-migration.js'
import { registerUpdateHandlers } from './updater.js'
import {
  developmentRendererUrl,
  hardenSession,
  hardenWindow,
  registerRendererProtocol,
  rendererOrigin
} from './security.js'
import { requestedUserDataPath } from './user-data.js'

loadDevelopmentEnvironment()
configureUserData()

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let coreClient: CoreRpcClient | null = null
let removeRpcHandler: (() => void) | null = null
let removeUpdateHandlers: (() => void) | null = null
const developmentUrl = developmentRendererUrl(app.isPackaged, process.env['ELECTRON_RENDERER_URL'])

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    // The literature workspace supplies its own compact toolbar.  Keep the
    // native menu available through Alt for keyboard users without consuming
    // the first viewport row in the focused research view.
    autoHideMenuBar: true,
    backgroundColor: '#f5f5f4',
    title: '个人科研工作台',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: !app.isPackaged
    }
  })

  hardenWindow(window, developmentUrl)
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  if (developmentUrl) {
    void window.loadURL(developmentUrl)
  } else {
    void window.loadURL(`${rendererOrigin}/index.html`)
  }
  return window
}

async function bootstrap(): Promise<void> {
  if (app.isPackaged) {
    const legacyRoot = dirname(app.getPath('exe'))
    const migration = await migrateLegacyUserData(legacyRoot, app.getPath('userData'))
    if (migration.migrated) console.info('[workbench] migrated legacy user data to per-user storage')
  }
  const rendererRoot = join(__dirname, '../renderer')
  await registerRendererProtocol(rendererRoot)
  hardenSession()

  const databasePath = join(app.getPath('userData'), 'data', 'workspace.sqlite3')
  const servicePipePath = process.platform === 'win32'
    ? `\\\\.\\pipe\\prw-workspace-v2-${createHash('sha256').update(databasePath).digest('hex').slice(0, 24)}`
    : join(app.getPath('userData'), 'workspace-service.sock')
  const serviceInfoPath = join(app.getPath('userData'), 'config', 'workspace-service.json')
  coreClient = new CoreRpcClient({
    workerPath: join(__dirname, 'core-worker.cjs'),
    databasePath,
    appVersion: workbenchVersion(),
    servicePipePath,
    serviceHandshakeToken: randomUUID(),
    serviceInfoPath,
    projectRoot: developmentProjectRoot(),
    packagedApp: app.isPackaged
  })
  await coreClient.waitUntilReady()
  await ensureDefaultZoteroProfile(coreClient)
  await ensureDefaultObsidianVault(coreClient)

  const credentialVault = new CredentialVault(
    join(app.getPath('userData'), 'config', 'workspace-secrets.json'),
    electronSecretCryptography()
  )

  // The embedded Agent produces credentials inside the Core process but cannot
  // persist them: `safeStorage` only exists here. Every write therefore arrives
  // as a request, and Core waits for this ack instead of continuing on a token
  // the vault never accepted.
  coreClient.setCredentialWriter(async (provider, credential) => {
    if (credential === null) await removeAgentCredential(credentialVault, provider)
    else await writeAgentCredential(credentialVault, provider, credential)
  })
  // The mirror of the write channel: a run Core starts on its own (a scheduled
  // occurrence, or the startup catch-up) has no renderer and therefore no
  // per-RPC credential envelope. It asks for one provider, and a provider the
  // vault does not hold simply resolves to `null`, which the run reports as
  // `AGENT_CREDENTIAL_MISSING` instead of borrowing someone else's key.
  coreClient.setCredentialReader(async (provider) => {
    const entry = await readAgentCredential(credentialVault, provider)
    return entry === null ? null : entry.credential
  })
  // Connection secrets travel the same way and for the same reason: an Agent
  // tool call arrives over the in-process MCP transport with no credential
  // envelope, so a Zotero write it requests asks for exactly one profile's key.
  coreClient.setIntegrationSecretReader(async (profileId) =>
    credentialVault.get(credentialKey('integration', profileId)))
  // Message-side push (literature_daily_msg): Main owns the Feishu token and the
  // bound openId in its vault, so Core only hands over the rendered text and
  // learns ok/error — the token never crosses the process boundary. The bound
  // probe refuses a scheduled run before any model call.
  const feishuController = new FeishuBindingController({
    vault: credentialVault,
    keyOf: (id) => credentialKey('integration', id)
  })
  coreClient.setFeishuSender(async (text) => {
    const status = await feishuController.getStatus()
    if (!status.bound || status.boundUserOpenId === null) {
      return { ok: false, error: 'FEISHU_NOT_BOUND：尚未绑定飞书应用，消息未发送。' }
    }
    await feishuController.sendText(status.boundUserOpenId, text)
    return { ok: true }
  })
  coreClient.setFeishuStatusReader(async () => (await feishuController.getStatus()).bound)
  // An OAuth flow inside Core cannot open a browser, so it hands the URL over.
  // Validation stays with the shared `ExternalOpenUrlSchema` allowlist applied
  // in `CoreRpcClient` before this callback runs.
  coreClient.setExternalOpener((url) => { void shell.openExternal(url) })

  removeRpcHandler = registerRpcHandler({
    client: coreClient,
    credentialVault,
    getWindow: () => mainWindow,
    developmentUrl,
    feishu: feishuController
  })
  const updates = registerUpdateHandlers({
    getWindow: () => mainWindow,
    developmentUrl
  })
  removeUpdateHandlers = updates.dispose
  mainWindow = createWindow()
  if (app.isPackaged) setTimeout(() => { void updates.controller.check() }, 3_000)
}

/**
 * Materialize a non-secret Zotero profile from the adjacent .env/defaults so
 * the renderer can immediately run a real capability probe. Existing user
 * profiles are never overwritten and no credential is passed through this
 * bootstrap path.
 */
async function ensureDefaultZoteroProfile(client: CoreRpcClient): Promise<void> {
  const listed = await client.request('integrations.list', null)
  if (!listed.ok || !Array.isArray(listed.data)) return
  const profiles = listed.data.flatMap((value) => {
    const parsed = IntegrationProfileSchema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })
  if (profiles.some((profile) => profile.provider === 'zotero')) return

  const location = process.env['ZOTERO_API_URL']?.trim() || 'http://localhost:23119/api/'
  try {
    const url = new URL(location)
    const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
    if (url.username || url.password || ((!loopback && url.protocol !== 'https:') || (loopback && !['http:', 'https:'].includes(url.protocol)))) return
    url.search = ''
    url.hash = ''
    if (!url.pathname.endsWith('/')) url.pathname += '/'
    const payload = SaveIntegrationProfileInputSchema.parse({
      id: randomUUID(),
      provider: 'zotero',
      name: '我的 Zotero',
      enabled: true,
      location: url.toString(),
      settings: { libraryType: 'users', libraryId: '0', limit: 100 },
      expectedRevision: null
    })
    await client.request('integrations.save', payload)
  } catch {
    // Invalid .env input is surfaced by Settings; startup must remain usable.
  }
}

/**
 * Bootstrap the application-owned Vault once when the user has not configured
 * an Obsidian profile yet. OBSIDIAN_DIR can name that same default root;
 * other configured roots remain behind the Settings preview/confirmation
 * flow. Re-running the default bootstrap preserves existing folders and
 * README content through the layout service.
 */
async function ensureDefaultObsidianVault(client: CoreRpcClient): Promise<void> {
  const listed = await client.request('integrations.list', null)
  if (!listed.ok || !Array.isArray(listed.data)) return
  const profiles = listed.data.flatMap((value) => {
    const parsed = IntegrationProfileSchema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })
  const obsidianProfiles = profiles.filter((profile) => profile.provider === 'obsidian')
  const envRoot = app.isPackaged ? dirname(app.getPath('exe')) : process.cwd()
  const defaultLocation = join(envRoot, 'workbench')
  const configuredValue = process.env['OBSIDIAN_DIR']?.trim() || ''
  const configuredLocation = configuredValue
    ? resolve(envRoot, configuredValue)
    : null
  // The shipped `.env` uses `.\\workbench`; it is the same app-owned default
  // after resolution. Windows path comparison also ignores drive/path case.
  const useOwnedDefault = configuredLocation === null || relative(defaultLocation, configuredLocation) === ''
  const location = useOwnedDefault ? defaultLocation : configuredLocation
  // An existing saved profile always wins.  The adjacent .env is only a
  // first-launch default and must never silently replace a user-selected root.
  const defaultProfile = useOwnedDefault
    ? obsidianProfiles.find((profile) => relative(defaultLocation, profile.location) === '' && profile.enabled)
    : undefined
  try {
    if (obsidianProfiles.length === 0) {
      // The default root is application-owned. Custom/external roots are
      // intentionally never created implicitly by startup.
      if (useOwnedDefault) await mkdir(location, { recursive: true })
      const payload = SaveIntegrationProfileInputSchema.parse({
        id: randomUUID(),
        provider: 'obsidian',
        name: '我的 Obsidian Vault',
        enabled: true,
        location,
        settings: {},
        expectedRevision: null
      })
      const savedResponse = await client.request('integrations.save', payload)
      if (!savedResponse.ok) return
      const saved = IntegrationProfileSchema.safeParse(savedResponse.data)
      if (!saved.success || saved.data.provider !== 'obsidian' || !saved.data.enabled) return
      // Do not write categories/README into an explicitly configured external
      // Vault during startup. The app-owned default is initialized; external
      // roots are still probed so the tree can show existing Markdown/folders.
      if (useOwnedDefault) await initializeDefaultObsidianLayout(client, saved.data.id, saved.data.revision)
      await client.request('integrations.test', { id: saved.data.id })
      return
    }
    if (defaultProfile) {
      await initializeDefaultObsidianLayout(client, defaultProfile.id, defaultProfile.revision)
      if (defaultProfile.status !== 'ready') await client.request('integrations.test', { id: defaultProfile.id })
    }
  } catch {
    // Startup remains usable when the install directory is read-only or the
    // filesystem is temporarily unavailable. The Obsidian page exposes the
    // existing preview/initialize retry path.
  }
}

async function initializeDefaultObsidianLayout(client: CoreRpcClient, profileId: string, expectedRevision: number): Promise<void> {
  const previewResponse = await client.request('obsidian.vaultLayout.preview', { profileId })
  if (!previewResponse.ok) return
  const plan = ObsidianVaultLayoutPlanSchema.safeParse(previewResponse.data)
  if (!plan.success) return
  const input = ObsidianVaultLayoutInitializeInputSchema.parse({
    profileId,
    planId: plan.data.planId,
    expectedRevision,
    confirmed: true
  })
  const receiptResponse = await client.request('obsidian.vaultLayout.initialize', input)
  if (receiptResponse.ok) ObsidianVaultLayoutReceiptSchema.safeParse(receiptResponse.data)
}

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

if (hasSingleInstanceLock) {
  app.whenReady().then(bootstrap).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : 'Unknown startup error'
    dialog.showErrorBox('个人科研工作台启动失败', detail)
    app.quit()
  })
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && coreClient) {
    mainWindow = createWindow()
  }
})

app.on('before-quit', () => {
  removeUpdateHandlers?.()
  removeUpdateHandlers = null
  removeRpcHandler?.()
  removeRpcHandler = null
  coreClient?.dispose()
  coreClient = null
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * Repository checkout that owns the canonical `.agents/skills` sources, for a
 * development/e2e process only.
 *
 * Main resolves it once from its own bundle location instead of letting the
 * Core process guess from `process.cwd()`: Core runs with the workbench
 * user-data directory as its working directory, so a dev run must not depend on
 * the launch directory. An installed app returns `undefined` and discovers
 * skills through the build-generated `resources/skills` mirror alone.
 */
function developmentProjectRoot(): string | undefined {
  if (app.isPackaged) return undefined
  let directory = __dirname
  for (let depth = 0; depth <= 8; depth += 1) {
    if (existsSync(join(directory, '.agents', 'skills'))) return directory
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

function workbenchVersion(): string {
  if (app.isPackaged) return app.getVersion()
  try {
    const packageJson: unknown = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf8')
    )
    if (packageJson && typeof packageJson === 'object' && 'version' in packageJson) {
      const version = packageJson.version
      if (typeof version === 'string' && version.length > 0) return version
    }
  } catch {
    // Electron reports its own version when a built main entry is launched directly.
  }
  return app.getVersion()
}

function configureUserData(): void {
  const selected = requestedUserDataPath(
    app.isPackaged,
    process.argv,
    process.env['PRW_E2E_USER_DATA']
  )
  if (selected !== undefined) {
    app.setPath('userData', selected)
    return
  }
  // Packaged data belongs to the current Windows user, not Program Files.
  // This keeps SQLite, safeStorage metadata and service state writable across
  // upgrades while the explicit switch remains available for isolated runs.
  if (app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'Personal Research Workbench'))
}

/** Load non-secret local connector defaults from the working directory during
 * development or beside the packaged executable. Credentials remain in Main
 * safeStorage and are never read from this file. */
function loadDevelopmentEnvironment(): void {
  try {
    const envRoot = app.isPackaged ? dirname(app.getPath('exe')) : process.cwd()
    const envPath = join(envRoot, '.env')
    const text = readFileSync(envPath, 'utf8')
    for (const line of text.split(/\r?\n/u)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line)
      if (!match) continue
      const [, key, rawValue] = match
      if (key !== 'OBSIDIAN_DIR' && key !== 'ZOTERO_API_URL') continue
      const value = (rawValue ?? '').replace(/^['"]|['"]$/gu, '').trim()
      if (value && !process.env[key]) process.env[key] = value
    }
  } catch {
    // A missing development .env is valid; the settings UI remains explicit.
  }
}
