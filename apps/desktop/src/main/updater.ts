import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { autoUpdater, type UpdateDownloadedEvent, type UpdateInfo } from 'electron-updater'
import { UpdateStateSchema, type UpdateState } from '@prw/contracts'
import { isTrustedSender } from './ipc.js'

export const WORKBENCH_UPDATE_INVOKE_CHANNEL = 'workbench:updates:invoke'
export const WORKBENCH_UPDATE_STATE_CHANNEL = 'workbench:updates:state'

type UpdateOperation = 'state' | 'check' | 'download' | 'install'

function currentVersion(): string {
  return app.getVersion() || '0.0.0'
}

function initialState(): UpdateState {
  return UpdateStateSchema.parse({
    phase: 'idle',
    currentVersion: currentVersion(),
    availableVersion: null,
    downloadedVersion: null,
    progress: null,
    message: null
  })
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '更新请求失败。'
  return message.replace(/([A-Za-z]:[\\/]|\\\\|Bearer\s+\S+|token=\S+|api[_-]?key=\S+)/giu, '[redacted]').slice(0, 500)
}

export class UpdateController {
  private stateValue: UpdateState = initialState()
  private configured = false

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  configure(): void {
    if (this.configured) return
    this.configured = true
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.on('checking-for-update', () => this.setState({ phase: 'checking', message: null, progress: null }))
    autoUpdater.on('update-available', (info: UpdateInfo) => this.setState({
      phase: 'available',
      availableVersion: info.version,
      downloadedVersion: null,
      progress: null,
      message: `发现新版本 ${info.version}。`
    }))
    autoUpdater.on('update-not-available', () => this.setState({
      phase: 'idle',
      availableVersion: null,
      downloadedVersion: null,
      progress: null,
      message: '当前已是最新版本。'
    }))
    autoUpdater.on('download-progress', (progress) => this.setState({
      phase: 'downloading',
      progress: Math.max(0, Math.min(100, progress.percent)),
      message: `正在下载更新（${Math.round(progress.percent)}%）。`
    }))
    autoUpdater.on('update-downloaded', (info: UpdateDownloadedEvent) => this.setState({
      phase: 'downloaded',
      availableVersion: info.version,
      downloadedVersion: info.version,
      progress: 100,
      message: `更新 ${info.version} 已下载，重启后安装。`
    }))
    autoUpdater.on('error', (error) => this.setState({
      phase: 'error',
      progress: null,
      message: safeMessage(error)
    }))
  }

  state(): UpdateState {
    return this.stateValue
  }

  async check(): Promise<UpdateState> {
    if (!app.isPackaged) {
      this.setState({ phase: 'idle', message: '开发模式不检查应用更新。', progress: null })
      return this.stateValue
    }
    this.setState({ phase: 'checking', message: null, progress: null })
    try {
      const result = await autoUpdater.checkForUpdates()
      if (result?.updateInfo?.version && result.updateInfo.version !== currentVersion()) {
        this.setState({
          phase: 'available',
          availableVersion: result.updateInfo.version,
          downloadedVersion: null,
          progress: null,
          message: `发现新版本 ${result.updateInfo.version}。`
        })
      } else if (this.stateValue.phase === 'checking') {
        this.setState({ phase: 'idle', message: '当前已是最新版本。', progress: null })
      }
    } catch (error) {
      this.setState({ phase: 'error', progress: null, message: safeMessage(error) })
    }
    return this.stateValue
  }

  async download(): Promise<UpdateState> {
    if (!app.isPackaged || this.stateValue.phase !== 'available') return this.stateValue
    this.setState({ phase: 'downloading', progress: 0, message: '正在下载更新。' })
    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      this.setState({ phase: 'error', progress: null, message: safeMessage(error) })
    }
    return this.stateValue
  }

  install(): void {
    if (!app.isPackaged || this.stateValue.phase !== 'downloaded') return
    autoUpdater.quitAndInstall(false, true)
  }

  private setState(next: Partial<UpdateState>): void {
    this.stateValue = UpdateStateSchema.parse({ ...this.stateValue, ...next, currentVersion: currentVersion() })
    const owner = this.getWindow()
    if (owner && !owner.isDestroyed()) owner.webContents.send(WORKBENCH_UPDATE_STATE_CHANNEL, this.stateValue)
  }
}

export function registerUpdateHandlers(options: {
  readonly getWindow: () => BrowserWindow | null
  readonly developmentUrl: string | undefined
}): { controller: UpdateController; dispose: () => void } {
  const controller = new UpdateController(options.getWindow)
  controller.configure()
  ipcMain.handle(WORKBENCH_UPDATE_INVOKE_CHANNEL, async (event: IpcMainInvokeEvent, operation: unknown): Promise<UpdateState | null> => {
    if (!isTrustedSender(event, options.getWindow(), options.developmentUrl)) return null
    if (operation !== 'state' && operation !== 'check' && operation !== 'download' && operation !== 'install') return null
    switch (operation as UpdateOperation) {
      case 'state': return controller.state()
      case 'check': return controller.check()
      case 'download': return controller.download()
      case 'install': controller.install(); return controller.state()
    }
  })
  return {
    controller,
    dispose: () => ipcMain.removeHandler(WORKBENCH_UPDATE_INVOKE_CHANNEL)
  }
}
