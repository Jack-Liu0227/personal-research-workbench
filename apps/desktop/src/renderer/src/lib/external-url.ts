import { externalOpenUrlIssue } from '@prw/contracts'
import { getErrorMessage } from './utils'
import { getWorkbenchApi } from './workbench'

/**
 * Renderer-side half of the external-link contract.
 *
 * Every decision that has to be identical for the Inspector, the result rows
 * and the copy button lives in this module so it can be unit tested without a
 * DOM or an Electron runtime.  Opening is always delegated to the Main-process
 * `system.openExternal` RPC: the renderer never imports `shell`, `fs` or any
 * other Node module, and a URL that fails the shared allowlist is rendered as
 * plain text with an explanation instead of a dead or dangerous link.
 */

export type ExternalUrlTarget =
  | { kind: 'empty' }
  | { kind: 'openable'; href: string; pdf: boolean }
  | { kind: 'blocked'; reason: string; raw: string }

const absoluteScheme = /^[a-z][a-z0-9+.-]*:/iu
const bareHost = /^(?:[^\s/:@.]+\.[^\s/:@.]*\.)*[^\s/:@.]+\.[A-Za-z]{2,}(?:[/?#]|$)/u

/** Search sources return bare hosts (`europepmc.org/article/…`) as often as
 * full URLs.  Only an obvious `host.tld` value is upgraded to `https://`;
 * anything else is reported instead of guessed. */
function withScheme(value: string): string {
  if (absoluteScheme.test(value)) return value
  if (bareHost.test(value)) return `https://${value}`
  return value
}

export function resolveExternalUrl(value: string | null | undefined): ExternalUrlTarget {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return { kind: 'empty' }
  const candidate = withScheme(trimmed)
  const issue = externalOpenUrlIssue(candidate)
  if (issue !== null) return { kind: 'blocked', reason: issue, raw: trimmed }
  return {
    kind: 'openable',
    href: new URL(candidate).toString(),
    // Only a URL whose own path is a PDF file is labelled as a PDF. The
    // "isOpenAccess" flag alone never turns a landing page into a PDF claim.
    pdf: /\.pdf(?:$|[?#])/iu.test(candidate)
  }
}

/** Canonical DOI resolver link. The DOI itself is never trusted as a protocol:
 * it is appended to the https://doi.org prefix, and a `doi:`/`doi.org` prefix
 * on the stored value is stripped first. */
export function doiExternalUrl(doi: string | null | undefined): ExternalUrlTarget {
  const normalized = (doi ?? '').trim().replace(/^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)/iu, '').replace(/^\/+/u, '')
  if (!normalized) return { kind: 'empty' }
  const candidate = `https://doi.org/${encodeURI(normalized)}`
  const issue = externalOpenUrlIssue(candidate)
  if (issue !== null) return { kind: 'blocked', reason: issue, raw: normalized }
  return { kind: 'openable', href: candidate, pdf: false }
}

/** The Inspector names a link by what it actually is: a URL whose own path is a
 * PDF file keeps that name, everything else stays the caller's field name.
 * `isOpenAccess` never turns a landing page into a PDF claim. */
export function externalUrlFieldLabel(target: ExternalUrlTarget, fallback: string): string {
  return target.kind === 'openable' && target.pdf ? 'PDF URL' : fallback
}

/** Anchor attributes for a resolved link. Kept in this module (not only in the
 * component) so a focused test can pin the new-window/noopener/rel contract and
 * the accessible name without a DOM.  `null` means "render no link at all". */
export interface ExternalAnchorAttributes {
  href: string
  rel: 'noreferrer noopener'
  target: '_blank'
  title: string
}

export function externalAnchorAttributes(target: ExternalUrlTarget): ExternalAnchorAttributes | null {
  if (target.kind !== 'openable') return null
  return { href: target.href, rel: 'noreferrer noopener', target: '_blank', title: target.href }
}

/** Accessible name for the icon-only trigger; the visible-text variant keeps its
 * visible label as the name. */
export function externalLinkAriaLabel(fieldLabel: string, label: string): string {
  return `${fieldLabel}：${label}（在系统浏览器中打开）`
}

export type ExternalOpenOutcome = { ok: true; message: string } | { ok: false; message: string }

export type ExternalOpener = (url: string) => Promise<void>

/**
 * Open an already-resolved link in the OS browser.  Failure is reported back to
 * the caller instead of becoming an unhandled rejection, so the UI can show a
 * diagnosable message (blocked protocol, missing handler, RPC failure).
 */
export async function openExternalUrl(href: string, opener?: ExternalOpener): Promise<ExternalOpenOutcome> {
  const issue = externalOpenUrlIssue(href)
  if (issue !== null) return { ok: false, message: issue }
  try {
    const open = opener ?? ((url: string) => getWorkbenchApi().system.openExternal(url))
    await open(href)
    return { ok: true, message: '已在系统浏览器中打开链接。' }
  } catch (error) {
    return { ok: false, message: `打开链接失败：${getErrorMessage(error)}` }
  }
}

export type CopyOutcome = { ok: true; message: string } | { ok: false; message: string }

export interface ClipboardDeps {
  writeText?: (text: string) => Promise<void>
  fallback?: (text: string) => boolean
}

/** `hardenSession()` denies every renderer permission, so the async Clipboard
 * API can reject even for a write.  Keep a synchronous `execCommand` fallback
 * and report the real outcome instead of silently claiming a copy. */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  try {
    const holder = document.createElement('textarea')
    holder.value = text
    holder.setAttribute('readonly', 'readonly')
    holder.style.position = 'fixed'
    holder.style.opacity = '0'
    document.body.append(holder)
    holder.select()
    const copied = document.execCommand?.('copy') === true
    holder.remove()
    return copied
  } catch {
    return false
  }
}

export async function copyTextToClipboard(value: string, deps: ClipboardDeps = {}): Promise<CopyOutcome> {
  const text = (value ?? '').trim()
  if (!text) return { ok: false, message: '没有可复制的内容。' }
  const writeText = deps.writeText
    ?? ((candidate: string) => globalThis.navigator?.clipboard?.writeText(candidate) ?? Promise.reject(new Error('Clipboard unavailable')))
  try {
    await writeText(text)
    return { ok: true, message: '已复制到剪贴板。' }
  } catch {
    const fallback = deps.fallback ?? legacyCopy
    return fallback(text)
      ? { ok: true, message: '已复制到剪贴板。' }
      : { ok: false, message: '复制失败，请手动选择文本后复制。' }
  }
}
