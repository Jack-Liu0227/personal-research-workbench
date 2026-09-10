export const rendererScheme = 'workbench'
export const rendererOrigin = `${rendererScheme}://app`

export function developmentRendererUrl(isPackaged: boolean, candidate: string | undefined): string | undefined {
  return isPackaged ? undefined : candidate
}

export function isAllowedRendererUrl(urlString: string, developmentUrl?: string): boolean {
  try {
    const url = new URL(urlString)
    if (url.protocol === `${rendererScheme}:` && url.hostname === 'app') return true
    return developmentUrl !== undefined && url.origin === new URL(developmentUrl).origin
  } catch {
    return false
  }
}
