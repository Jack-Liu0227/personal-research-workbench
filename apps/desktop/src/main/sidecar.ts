import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { SidecarStateSchema, type SidecarState } from '@prw/contracts'
import { isTrustedSender } from './ipc.js'

export const WORKBENCH_SIDECAR_INVOKE_CHANNEL = 'workbench:sidecar:invoke'
export const WORKBENCH_SIDECAR_STATE_CHANNEL = 'workbench:sidecar:state'

// Compatibility-only: retired Python sources are not executable capabilities.
export class SidecarController {
  state(): SidecarState {
    return SidecarStateSchema.parse({ phase: 'error', port: null, dataDir: 'Not used',
      message: 'The legacy Python sidecar is retired. Use the embedded workbench Agent and settings.' })
  }
  async open(): Promise<SidecarState> { return this.state() }
  async stop(): Promise<SidecarState> { return this.state() }
  disposeNow(): void {}
}

export function registerSidecarHandlers(options: {
  readonly getWindow: () => BrowserWindow | null
  readonly developmentUrl: string | undefined
}): { controller: SidecarController; dispose: () => void } {
  const controller = new SidecarController()
  ipcMain.handle(WORKBENCH_SIDECAR_INVOKE_CHANNEL,
    async (event: IpcMainInvokeEvent, operation: unknown): Promise<SidecarState | null> => {
      if (!isTrustedSender(event, options.getWindow(), options.developmentUrl)) return null
      if (operation !== 'state' && operation !== 'open' && operation !== 'stop') return null
      return controller.state()
    })
  return { controller, dispose: () => ipcMain.removeHandler(WORKBENCH_SIDECAR_INVOKE_CHANNEL) }
}
