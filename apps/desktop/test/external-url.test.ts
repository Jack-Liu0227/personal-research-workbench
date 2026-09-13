import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EXTERNAL_OPEN_URL_PROTOCOLS, ExternalOpenUrlSchema, externalOpenUrlIssue } from '@prw/contracts'
import {
  copyTextToClipboard,
  externalAnchorAttributes,
  externalLinkAriaLabel,
  doiExternalUrl,
  externalUrlFieldLabel,
  openExternalUrl,
  resolveExternalUrl
} from '../src/renderer/src/lib/external-url.js'

/**
 * The Literature Inspector may only hand http/https URLs to the operating
 * system, and it must do so through the Main-process `system.openExternal`
 * RPC. These assertions pin the one allowlist shared by contracts (RPC
 * payload), preload, Main `shell.openExternal` and the renderer link.
 */

test('the openExternal contract rejects everything except plain http/https', () => {
  assert.deepEqual([...EXTERNAL_OPEN_URL_PROTOCOLS], ['http:', 'https:'])
  for (const ok of ['https://doi.org/10.1000/xyz', 'http://localhost:23119/api/users/0/items', 'https://europepmc.org/article/MED/1?a=b#c']) {
    assert.equal(externalOpenUrlIssue(ok), null, ok)
    assert.equal(ExternalOpenUrlSchema.parse(ok), ok)
  }
  // `file:` reached `shell.openExternal` before this task; it addresses the
  // local filesystem and must never be a renderer-reachable link.
  for (const blocked of [
    'file:///C:/Windows/System32/calc.exe',
    'file://server/share/secret.txt',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'ms-msdt:/id PCWDiagnostic',
    'zotero://select/library/items/ABCD1234',
    'https://user:secret@example.com/private.pdf',
    'http://user:secret@localhost:23119/api'
  ]) {
    assert.notEqual(externalOpenUrlIssue(blocked), null, blocked)
    assert.throws(() => ExternalOpenUrlSchema.parse(blocked), undefined, blocked)
  }
  assert.notEqual(externalOpenUrlIssue('not a url'), null)
  assert.notEqual(externalOpenUrlIssue(''), null)
})

test('renderer resolution mirrors the contract instead of inventing links', () => {
  assert.deepEqual(resolveExternalUrl(null), { kind: 'empty' })
  assert.deepEqual(resolveExternalUrl('   '), { kind: 'empty' })
  assert.deepEqual(resolveExternalUrl('https://example.com/a.pdf'), { kind: 'openable', href: 'https://example.com/a.pdf', pdf: true })
  assert.deepEqual(resolveExternalUrl('https://example.com/a.PDF?download=1'), { kind: 'openable', href: 'https://example.com/a.PDF?download=1', pdf: true })
  // Bare hosts from free sources get https, never the caller's guess.
  assert.deepEqual(resolveExternalUrl('europepmc.org/article/MED/1'), { kind: 'openable', href: 'https://europepmc.org/article/MED/1', pdf: false })
  const blocked = resolveExternalUrl('file:///C:/Windows/System32/calc.exe')
  assert.equal(blocked.kind, 'blocked')
  assert.equal(blocked.kind === 'blocked' ? blocked.raw : '', 'file:///C:/Windows/System32/calc.exe')
  assert.equal(resolveExternalUrl('javascript:alert(1)').kind, 'blocked')
  assert.equal(resolveExternalUrl('10.1000/xyz').kind, 'blocked')
  // A landing page is never relabelled as a PDF just because it is open access.
  assert.equal(externalUrlFieldLabel(resolveExternalUrl('https://example.com/article'), '来源链接'), '来源链接')
  assert.equal(externalUrlFieldLabel(resolveExternalUrl('https://example.com/a.pdf'), '来源链接'), 'PDF URL')
})

test('DOI links are always rebuilt on the https resolver', () => {
  const doi = doiExternalUrl('10.1145/3290605.3300233')
  assert.deepEqual(doi, { kind: 'openable', href: 'https://doi.org/10.1145/3290605.3300233', pdf: false })
  // Stored values arrive with every prefix variant; all of them resolve to the
  // same canonical https link.
  for (const value of ['doi:10.1145/3290605.3300233', 'https://doi.org/10.1145/3290605.3300233', 'http://dx.doi.org/10.1145/3290605.3300233']) {
    assert.deepEqual(doiExternalUrl(value), doi, value)
  }
  // A DOI is never treated as a protocol: it is appended to the https prefix.
  const hostile = doiExternalUrl('javascript:alert(1)')
  assert.equal(hostile.kind, 'openable')
  assert.equal(hostile.kind === 'openable' ? hostile.href : '', 'https://doi.org/javascript:alert(1)')
  assert.deepEqual(doiExternalUrl(null), { kind: 'empty' })
  assert.deepEqual(doiExternalUrl('  '), { kind: 'empty' })
})

test('opening goes through the injected RPC and reports failure instead of throwing', async () => {
  const opened: string[] = []
  const success = await openExternalUrl('https://doi.org/10.1/abc', (url) => { opened.push(url); return Promise.resolve() })
  assert.deepEqual(success, { ok: true, message: '已在系统浏览器中打开链接。' })
  assert.deepEqual(opened, ['https://doi.org/10.1/abc'])

  const rejected = new Error('No application is registered for the protocol.')
  const failure = await openExternalUrl('https://example.com', () => Promise.reject(rejected))
  assert.equal(failure.ok, false)
  assert.match(failure.ok === false ? failure.message : '', /打开链接失败/u)
  assert.match(failure.ok === false ? failure.message : '', /No application is registered/u)

  // A blocked URL never reaches the opener at all.
  let called = 0
  const blocked = await openExternalUrl('file:///C:/Windows/System32/calc.exe', () => { called += 1; return Promise.resolve() })
  assert.equal(blocked.ok, false)
  assert.match(blocked.ok === false ? blocked.message : '', /http\/https/u)
  assert.equal(called, 0)
})

test('copy reports the real outcome and survives a denied clipboard permission', async () => {
  assert.deepEqual(await copyTextToClipboard('   '), { ok: false, message: '没有可复制的内容。' })
  const copied: string[] = []
  assert.deepEqual(await copyTextToClipboard(' 10.1/abc ', { writeText: (text) => { copied.push(text); return Promise.resolve() } }), { ok: true, message: '已复制到剪贴板。' })
  assert.deepEqual(copied, ['10.1/abc'])
  // hardenSession() denies renderer permissions, so the async clipboard API can
  // reject; the synchronous fallback still has to work.
  const fallback = await copyTextToClipboard('https://example.com', {
    writeText: () => Promise.reject(new Error('Clipboard permission denied')),
    fallback: () => true
  })
  assert.equal(fallback.ok, true)
  const failed = await copyTextToClipboard('https://example.com', {
    writeText: () => Promise.reject(new Error('Clipboard permission denied')),
    fallback: () => false
  })
  assert.deepEqual(failed, { ok: false, message: '复制失败，请手动选择文本后复制。' })
})

/**
 * The anchor contract the `ExternalUrlLink` component spreads (href/rel/target/
 * title/accessible name) is asserted through the shared lib, so the control
 * cannot regress into an icon-only element, an unwindowed navigation, or a
 * credential-bearing href.  A blocked value resolves to no anchor attributes at
 * all: it is rendered as plain text with its reason, never as a link.
 */
test('the link contract stays a labelled new-window noopener anchor', () => {
  const doi = externalAnchorAttributes(doiExternalUrl('10.1145/3290605.3300233'))
  assert.deepEqual(doi, {
    href: 'https://doi.org/10.1145/3290605.3300233',
    rel: 'noreferrer noopener',
    target: '_blank',
    title: 'https://doi.org/10.1145/3290605.3300233'
  })
  const source = externalAnchorAttributes(resolveExternalUrl('europepmc.org/article/MED/1'))
  assert.equal(source?.href, 'https://europepmc.org/article/MED/1')
  assert.equal(externalAnchorAttributes(resolveExternalUrl('file:///C:/Windows/System32/calc.exe')), null)
  assert.equal(externalAnchorAttributes(resolveExternalUrl('javascript:alert(1)')), null)
  assert.equal(externalAnchorAttributes({ kind: 'empty' }), null)
  // The icon-only trigger still gets a full accessible name.
  assert.equal(externalLinkAriaLabel('来源链接', 'europepmc.org/article/MED/1'), '来源链接：europepmc.org/article/MED/1（在系统浏览器中打开）')
})
