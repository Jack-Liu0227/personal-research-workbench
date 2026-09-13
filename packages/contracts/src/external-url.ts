import { z } from 'zod'

/**
 * Protocols `system.openExternal` may hand to the operating system.
 *
 * `file:` is deliberately absent: it addresses the local filesystem and would
 * turn one renderer click into "open this local path with whatever handler the
 * OS registered".  Custom schemes (`zotero:`, `ms-msdt:`, `ms-officecmd:`, …)
 * are absent for the same reason - they forward attacker-controlled arguments
 * to a registered handler instead of a browser.  Explicit `revealPath`
 * operations stay on their own dedicated RPC.
 */
export const EXTERNAL_OPEN_URL_PROTOCOLS = ['http:', 'https:'] as const

/** Shared, dependency-free classification used by Main, preload and renderer
 * so all three layers reject exactly the same URLs.  `null` means openable. */
export function externalOpenUrlIssue(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return '外部链接为空，无法打开。'
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return '外部链接不是有效的绝对 URL。'
  }
  if (!(EXTERNAL_OPEN_URL_PROTOCOLS as readonly string[]).includes(url.protocol)) {
    return '仅允许在系统浏览器中打开 http/https 链接。'
  }
  if (url.username || url.password) {
    return '外部链接不能包含用户名或密码。'
  }
  return null
}

/** `system.openExternal` payload contract.  The RPC only ever carries an
 * absolute http/https URL without embedded credentials; anything else is
 * rejected before Main reaches `shell.openExternal`. */
export const ExternalOpenUrlSchema = z.string().url().superRefine((value, context) => {
  const issue = externalOpenUrlIssue(value)
  if (issue) context.addIssue({ code: 'custom', message: issue })
})
