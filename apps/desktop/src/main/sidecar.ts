import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { SidecarStateSchema, type SidecarState } from '@prw/contracts'
import { isTrustedSender } from './ipc.js'

export const WORKBENCH_SIDECAR_INVOKE_CHANNEL = 'workbench:sidecar:invoke'
export const WORKBENCH_SIDECAR_STATE_CHANNEL = 'workbench:sidecar:state'

type SidecarOperation = 'state' | 'open' | 'stop'

/** The sidecar imports PyYAML/pypdf/pdfplumber and opens SQLite before it can
 * answer the first request, so the health probe outlives a cold disk. */
const START_TIMEOUT_MS = 45_000
const HEALTH_INTERVAL_MS = 250
const STOP_GRACE_MS = 3_000
const ERROR_TAIL_CHARS = 400

/** Never let a child process path or a captured traceback reach the renderer. */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/([A-Za-z]:[\\/]|\\\\|\/home\/|\/Users\/|Bearer\s+\S+|token=\S+|api[_-]?key=\S+)/giu, '[redacted]')
    .slice(-ERROR_TAIL_CHARS)
}

/**
 * Where the Python application lives.
 *
 * Packaged builds resolve it from `resources/sidecars`; development runs need
 * the repository root, which is two levels above `apps/desktop`.  The
 * environment override exists so an operator can point a local build at a
 * working copy without repackaging — the same escape hatch the Scholar adapter
 * already offers.
 */
function resolveSidecarHome(): string | null {
  const override = process.env['PRW_SIDECAR_HOME']?.trim()
  if (override) {
    return existsSync(join(resolve(override), 'server.py')) ? resolve(override) : null
  }
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [
    typeof resourcesPath === 'string' && resourcesPath.trim()
      ? join(resourcesPath, 'sidecars', 'research-workbench-py')
      : null,
    join(app.getAppPath(), '..', '..', 'sidecars', 'research-workbench-py'),
    join(process.cwd(), 'sidecars', 'research-workbench-py')
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, 'server.py'))) return candidate
  }
  return null
}

/**
 * The Python interpreter.
 *
 * A packaged build ships an embeddable CPython under `resources/python`; the
 * product deliberately refuses to install a system runtime behind the user's
 * back, so anything else must be an explicit override or a runtime already on
 * PATH.
 */
function resolvePython(): string {
  const override = process.env['PRW_SIDECAR_PYTHON']?.trim()
  if (override) return override
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (typeof resourcesPath === 'string' && resourcesPath.trim()) {
    for (const name of ['python.exe', 'python']) {
      const bundled = join(resourcesPath, 'python', name)
      if (existsSync(bundled)) return bundled
    }
  }
  return process.platform === 'win32' ? 'python' : 'python3'
}

/** Let the OS pick a free loopback port; a fixed 8765 would collide with the
 * standalone application and with a second workbench instance. */
async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const probe = createServer()
    probe.unref()
    probe.once('error', rejectPort)
    probe.listen({ port: 0, host: '127.0.0.1' }, () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => {
        if (port > 0) resolvePort(port)
        else rejectPort(new Error('无法分配本地端口'))
      })
    })
  })
}

function probeHealth(port: number): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path: '/', method: 'GET', timeout: 2_000 },
      (response) => {
        response.resume()
        resolveProbe(response.statusCode !== undefined && response.statusCode < 500)
      }
    )
    request.on('timeout', () => {
      request.destroy()
      resolveProbe(false)
    })
    request.on('error', () => resolveProbe(false))
    request.end()
  })
}

/**
 * Owns the Python sidecar process and the window it renders in.
 *
 * This is deliberately a Main-process concern: only Main may spawn children and
 * create windows, and the renderer must never receive the pid, the port, or the
 * launch arguments.  The window is its own session with no preload, so the
 * sidecar cannot reach the `workbench` bridge or the workbench's cookies.
 */
export class SidecarController {
  private stateValue: SidecarState
  private child: ChildProcess | null = null
  private view: BrowserWindow | null = null
  private stderrTail = ''
  private starting: Promise<SidecarState> | null = null

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    this.stateValue = SidecarStateSchema.parse({
      phase: 'stopped',
      port: null,
      dataDir: this.dataDir(),
      message: null
    })
  }

  /**
   * User data lives beside the rest of the application's state, never inside
   * the installation directory: `Program Files` is usually unwritable and an
   * uninstall would take the user's notes with it.
   */
  private dataDir(): string {
    return join(app.getPath('userData'), 'sidecar-data')
  }

  state(): SidecarState {
    return this.stateValue
  }

  private setState(next: Partial<SidecarState>): void {
    this.stateValue = SidecarStateSchema.parse({ ...this.stateValue, ...next, dataDir: this.dataDir() })
    const owner = this.getWindow()
    if (owner && !owner.isDestroyed()) owner.webContents.send(WORKBENCH_SIDECAR_STATE_CHANNEL, this.stateValue)
  }

  /** Idempotent: opening an already-running sidecar only raises its window. */
  async open(): Promise<SidecarState> {
    if (this.stateValue.phase === 'running' && this.child !== null && this.child.exitCode === null) {
      this.focusView()
      return this.state()
    }
    if (this.starting !== null) return await this.starting
    const attempt = this.start()
    this.starting = attempt
    try {
      return await attempt
    } finally {
      this.starting = null
    }
  }

  private async start(): Promise<SidecarState> {
    const home = resolveSidecarHome()
    if (home === null) {
      this.setState({
        phase: 'error',
        port: null,
        message: '找不到侧车程序（sidecars/research-workbench-py）。开发环境下请从仓库根目录启动。'
      })
      return this.state()
    }

    this.setState({ phase: 'starting', message: null })
    let port: number
    try {
      port = await findFreePort()
    } catch (error) {
      this.setState({ phase: 'error', message: `无法分配本地端口：${safeMessage(error)}` })
      return this.state()
    }

    const dataDir = this.dataDir()
    try {
      mkdirSync(dataDir, { recursive: true })
    } catch (error) {
      this.setState({ phase: 'error', message: `无法创建数据目录：${safeMessage(error)}` })
      return this.state()
    }

    const started = await new Promise<boolean>((resolveStarted) => {
      this.stderrTail = ''
      let child: ChildProcess
      try {
        child = spawn(resolvePython(), [join(home, 'server.py'), '--port', String(port), '--no-open'], {
          cwd: home,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            RESEARCH_WORKBENCH_DATA: dataDir,
            RESEARCH_WORKBENCH_DB: join(dataDir, 'research.sqlite3'),
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1'
          }
        })
      } catch (error) {
        this.setState({ phase: 'error', message: `无法启动侧车：${safeMessage(error)}` })
        resolveStarted(false)
        return
      }

      this.child = child
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4_000)
      })
      child.once('error', (error) => {
        this.stderrTail = `${this.stderrTail}\n${safeMessage(error)}`
      })
      child.once('exit', (code) => {
        const wasActive = this.stateValue.phase === 'starting' || this.stateValue.phase === 'running'
        this.child = null
        this.closeView()
        if (!wasActive) return
        this.setState({
          phase: code === 0 ? 'stopped' : 'error',
          port: null,
          message: code === 0
            ? null
            : `侧车已退出（code ${code ?? 'unknown'}）：${safeMessage(new Error(this.stderrTail.trim() || '无输出'))}`
        })
      })
      resolveStarted(true)
    })

    if (!started) return this.state()

    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.child === null) return this.state() // the exit handler already reported it
      if (await probeHealth(port)) {
        this.setState({ phase: 'running', port, message: null })
        await this.createView(port)
        return this.state()
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, HEALTH_INTERVAL_MS))
    }

    this.setState({
      phase: 'error',
      port: null,
      message: `侧车启动超时：${safeMessage(new Error(this.stderrTail.trim() || '无输出'))}`
    })
    await this.kill()
    return this.state()
  }

  private async createView(port: number): Promise<void> {
    this.closeView()
    const origin = `http://127.0.0.1:${port}`
    const owner = this.getWindow()
    const view = new BrowserWindow({
      width: 1_280,
      height: 880,
      minWidth: 940,
      minHeight: 620,
      show: false,
      backgroundColor: '#f5f5f4',
      title: '科研工作',
      autoHideMenuBar: true,
      ...(owner && !owner.isDestroyed() ? { parent: owner } : {}),
      webPreferences: {
        // The sidecar is a separate origin this application did not write.
        // Give it its own session, no preload and no Node so it can neither
        // read the workbench bridge nor share its cookies.
        partition: 'sidecar',
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

    // The sidecar is a single-page application: keep it on its own loopback
    // origin and route any outward link to the user's browser instead.
    const isAllowed = (url: string): boolean => url === origin || url.startsWith(`${origin}/`) || url.startsWith(`${origin}?`)
    view.webContents.on('will-navigate', (event, url) => {
      if (isAllowed(url)) return
      event.preventDefault()
      if (/^https?:\/\//iu.test(url)) void shell.openExternal(url)
    })
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//iu.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })

    view.once('ready-to-show', () => view.show())
    view.on('closed', () => {
      if (this.view === view) this.view = null
    })
    this.view = view
    await view.loadURL(`${origin}/`)
  }

  private focusView(): void {
    const view = this.view
    if (view === null || view.isDestroyed()) {
      const port = this.stateValue.port
      if (port !== null) void this.createView(port)
      return
    }
    if (view.isMinimized()) view.restore()
    view.focus()
  }

  private closeView(): void {
    const view = this.view
    this.view = null
    if (view !== null && !view.isDestroyed()) view.destroy()
  }

  private async kill(): Promise<void> {
    const child = this.child
    this.child = null
    if (child === null || child.exitCode !== null) return
    await new Promise<void>((resolveKilled) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolveKilled()
      }, STOP_GRACE_MS)
      child.once('exit', () => {
        clearTimeout(timer)
        resolveKilled()
      })
      child.kill()
    })
  }

  async stop(): Promise<SidecarState> {
    this.setState({ phase: 'stopping', message: null })
    this.closeView()
    await this.kill()
    if (this.stateValue.phase !== 'error') this.setState({ phase: 'stopped', port: null, message: null })
    return this.state()
  }

  /**
   * Synchronous shutdown for `will-quit`, where Electron will not await a
   * promise.  Leaving an orphaned interpreter behind would hold the sidecar
   * database and the loopback port for the next launch.
   */
  disposeNow(): void {
    this.closeView()
    this.child?.kill()
    this.child = null
    this.stateValue = SidecarStateSchema.parse({
      phase: 'stopped',
      port: null,
      dataDir: this.dataDir(),
      message: null
    })
  }
}

export function registerSidecarHandlers(options: {
  readonly getWindow: () => BrowserWindow | null
  readonly developmentUrl: string | undefined
}): { controller: SidecarController; dispose: () => void } {
  const controller = new SidecarController(options.getWindow)
  ipcMain.handle(
    WORKBENCH_SIDECAR_INVOKE_CHANNEL,
    async (event: IpcMainInvokeEvent, operation: unknown): Promise<SidecarState | null> => {
      if (!isTrustedSender(event, options.getWindow(), options.developmentUrl)) return null
      if (operation !== 'state' && operation !== 'open' && operation !== 'stop') return null
      switch (operation as SidecarOperation) {
        case 'state': return controller.state()
        case 'open': return await controller.open()
        case 'stop': return await controller.stop()
      }
    }
  )
  const onWillQuit = (): void => controller.disposeNow()
  app.on('will-quit', onWillQuit)
  return {
    controller,
    dispose: () => {
      ipcMain.removeHandler(WORKBENCH_SIDECAR_INVOKE_CHANNEL)
      app.off('will-quit', onWillQuit)
    }
  }
}
