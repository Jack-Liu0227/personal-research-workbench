import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, net, protocol, session } from 'electron'
import { isAllowedRendererUrl, rendererScheme } from './renderer-trust.js'
export { developmentRendererUrl, isAllowedRendererUrl, rendererOrigin } from './renderer-trust.js'

protocol.registerSchemesAsPrivileged([
  {
    scheme: rendererScheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false
    }
  }
])

export async function registerRendererProtocol(rendererRoot: string): Promise<void> {
  const absoluteRoot = resolve(rendererRoot)
  const rootPrefix = `${absoluteRoot}${sep}`.toLocaleLowerCase('en-US')

  await protocol.handle(rendererScheme, (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'app') return textResponse('Not found', 404)
      const relativePath = decodeURIComponent(url.pathname).replace(/^[/\\]+/, '') || 'index.html'
      const requestedPath = resolve(absoluteRoot, relativePath)
      const normalized = requestedPath.toLocaleLowerCase('en-US')
      if (requestedPath !== absoluteRoot && !normalized.startsWith(rootPrefix)) {
        return textResponse('Forbidden', 403)
      }
      return net.fetch(pathToFileURL(requestedPath).toString())
    } catch {
      return textResponse('Bad request', 400)
    }
  })
}

export function hardenSession(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)
}

export function hardenWindow(window: BrowserWindow, developmentUrl?: string): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isAllowedRendererUrl(navigationUrl, developmentUrl)) event.preventDefault()
  })
}

function textResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' }
  })
}
