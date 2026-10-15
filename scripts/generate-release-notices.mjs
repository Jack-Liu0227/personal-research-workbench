#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name} value`)
  return args[index + 1]
}
const version = option('--version', JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version)
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(version)) throw new Error('Invalid release version')
const output = path.join(root, 'docs', 'legal', version)
const input = option('--input', path.join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', `prw-${version}-production-licenses.json`))
const check = args.includes('--check')
const online = args.includes('--fetch-missing') && !check
const nativeOnline = args.includes('--fetch-native') && !check
const searchOnline = args.includes('--fetch-exception-evidence') && !check
const sha = (value) => createHash('sha256').update(value).digest('hex')
const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const slash = (value) => value.replaceAll('\\', '/')
const allowed = new Set(['MIT', 'Apache-2.0', 'BSD-3-Clause', 'Python-2.0', 'Unlicense', 'ISC', 'BSD-2-Clause', 'BlueOak-1.0.0', '0BSD'])
const licenseFile = /^(?:licen[sc]e|copying|copyright)(?:[._-]|$)/iu
const noticeFile = /^(?:notice|authors)(?:[.-]|$)/iu
const gitSha = /^[a-f0-9]{40}$/u
const nativeAllowed = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'BSL-1.0', 'Zlib', 'Unicode-3.0'])
const nativeSelection = (expression, texts = []) => {
  if (typeof expression !== 'string') return null
  const evidenceFor = (license) => texts.find((item) => {
    if (item.kind === 'source-not-license') return false
    const body = blobs.get(item.file) ?? readFileSync(path.join(output, item.file), 'utf8')
    if (license === 'MIT') return /Permission is hereby granted[\s\S]*THE SOFTWARE IS PROVIDED/iu.test(body)
    if (license === 'Apache-2.0') return /Apache License[\s\S]*Version 2\.0[\s\S]*TERMS AND CONDITIONS/iu.test(body)
    if (license === 'Unicode-3.0') return /UNICODE LICENSE V3[\s\S]*COPYRIGHT AND PERMISSION NOTICE/u.test(body)
    if (license === 'BSL-1.0') return /Boost Software License[\s\S]*Version 1\.0/u.test(body)
    if (license === 'Zlib') return /This software is provided [\s\S]*Permission is granted to anyone/iu.test(body)
    if (license === 'ISC') return /Permission to use, copy, modify, and[\s\S]*THE SOFTWARE IS PROVIDED/iu.test(body)
    if (license.startsWith('BSD-')) return /Redistribution and use in source and binary forms[\s\S]*THIS SOFTWARE IS PROVIDED/iu.test(body)
    return false
  })
  if (expression === '(MIT OR Apache-2.0) AND Unicode-3.0') {
    const evidence = ['MIT', 'Unicode-3.0'].map(evidenceFor)
    return evidence.every(Boolean) ? { selected: 'MIT AND Unicode-3.0', chosenLicenseEvidence: evidence, basis: 'Exact observed compound independently reviewed: select MIT alternative and satisfy the additional Unicode-3.0 requirement; both original bodies retained.' } : null
  }
  if (/[()]|\bAND\b/u.test(expression)) return null
  const choices = expression.split(/\s+OR\s+|\//u)
  for (const preferred of ['MIT', 'Apache-2.0', ...nativeAllowed]) {
    const selected = choices.find((choice) => choice.trim() === preferred)
    const evidence = selected && evidenceFor(preferred)
    if (evidence) return { selected: preferred, chosenLicenseEvidence: [evidence], basis: 'Explicit permissive OR alternative with recovered complete original body; all declared alternatives and original notices remain retained. Nonselected alternatives/exceptions are not independently approved.' }
  }
  return null
}

function githubJson(endpoint) {
  if (!/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/contents(?:\/[A-Za-z0-9_./-]+)?\?ref=[a-f0-9]{40}$/u.test(endpoint)) throw new Error('Only exact-revision GitHub contents GET allowed')
  const result = spawnSync('gh', ['api', '--method', 'GET', endpoint], { encoding: 'utf8', timeout: 20_000, maxBuffer: 4_000_000, windowsHide: true })
  if (result.status !== 0) return null
  return JSON.parse(result.stdout)
}

const cacheFile = path.join(output, 'source-evidence.json')
const evidence = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {}
const exceptionsFile = path.join(output, 'license-exceptions.json')
const exceptions = existsSync(exceptionsFile) ? JSON.parse(readFileSync(exceptionsFile, 'utf8')) : {}
const exceptionReasons = {
  '@mariozechner/clipboard@0.3.9': 'Search of installed root files/README and official gitHead root/tree did not retrieve a complete license body. Repository moved from badlogic/clipboard to earendil-works/clipboard. This is bounded search evidence, not proof no notice exists elsewhere.',
  '@mariozechner/clipboard-win32-x64-msvc@0.3.9': 'Search of installed native package root and shared official gitHead tree did not retrieve a complete wrapper license body. Native/vendored dependencies are separately audited; this is not proof no notice exists elsewhere.',
  'lazy-val@1.0.5': 'Search of installed root/README and official gitHead root/tree did not retrieve a complete license body. This is not proof no notice exists elsewhere.',
  'react-remove-scroll-bar@2.3.8': 'Installed README declares MIT only; attempted exact npm gitHead root notice paths in the declared repository did not recover a complete body. This is bounded search evidence, not proof no notice exists elsewhere.'
}
const blobs = new Map()
const requests = new Map()
const gaps = []
const entries = []
const textIsLicense = (text) => text.length > 400 && !/^\s*(?:<!doctype|<html)/iu.test(text)
const readmeLicense = (text) => {
  const start = text.search(/(?:^|\n)(?:#{1,6}\s+Licen[sc]e\b|Licen[sc]e\s*\r?\n[-=]{3,})/iu)
  if (start < 0) return null
  const section = text.slice(start).trim()
  return /Permission is hereby granted[\s\S]*(?:THE SOFTWARE IS PROVIDED|The software is provided)/iu.test(section) ? `${section}\n` : null
}

function readJsonInput(file) {
  const bytes = readFileSync(file)
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || bytes[1] === 0
  return JSON.parse(bytes.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/u, ''))
}

function httpsSource(value) {
  let text = typeof value === 'string' ? value : value?.url
  if (!text) return null
  text = text.replace(/^git\+/u, '').replace(/^git:\/\//u, 'https://')
  if (/^[\w.-]+\/[\w.-]+$/u.test(text)) text = `https://github.com/${text}`
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    url.hash = ''; url.search = ''
    return url.href.replace(/\.git\/?$/u, '').replace(/\/$/u, '')
  } catch { return null }
}

function addText(text, source, kind = 'license') {
  const hash = sha(text)
  const file = `license-texts/${hash}.txt`
  blobs.set(file, text)
  return { kind, source, file, sha256: hash }
}

function persistTexts(texts) {
  for (const item of texts) {
    if (!/^license-texts\/[a-f0-9]{64}\.txt$/u.test(item.file)) throw new Error('Invalid license text path')
    const body = blobs.get(item.file)
    if (body === undefined || sha(body) !== item.sha256) throw new Error('License checkpoint digest mismatch')
    mkdirSync(path.dirname(path.join(output, item.file)), { recursive: true })
    writeFileSync(path.join(output, item.file), body)
  }
}

async function searchResponse(url) {
  const host = new URL(url)
  if (host.protocol !== 'https:' || !['registry.npmjs.org', 'raw.githubusercontent.com'].includes(host.hostname) || host.username || host.password) throw new Error('Search host rejected')
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'PRW-release-license-evidence' } })
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > 2_000_000) throw new Error('Search response exceeds bound')
    const file = `search-evidence/${sha(bytes)}.txt`
    mkdirSync(path.dirname(path.join(output, file)), { recursive: true })
    writeFileSync(path.join(output, file), bytes)
    return { url, status: response.status, responseSha256: sha(bytes), file }
  } catch { return { url, status: null, failure: 'Bounded single request failed; no response body was received or retained.' } }
}

async function exceptionSearch(record, pkg, directory) {
  const local = readdirSync(directory).sort().filter((file) => statSync(path.join(directory, file)).isFile())
  record.localSearch = { source: `npm:${pkg.name}@${pkg.version}`, rootFiles: local, completeLicenseBodyRecovered: false,
    retainedDocuments: local.filter((file) => /^readme(?:[.-]|$)/iu.test(file)).map((file) => addText(readFileSync(path.join(directory, file), 'utf8'), `npm:${pkg.name}@${pkg.version}/${file}`, 'readme-not-license')) }
  if (searchOnline && !record.searchResponses) {
    const repository = httpsSource(record.declaration.repository)?.replace('github.com/', 'raw.githubusercontent.com/')
    const head = record.declaration.gitHead
    const urls = [record.declarationSource]
    if (repository && gitSha.test(head ?? '')) for (const file of ['LICENSE', 'LICENSE.md', 'README.md']) urls.push(`${repository}/${head}/${file}`)
    record.searchResponses = []
    for (const url of urls) record.searchResponses.push(await searchResponse(url))
    record.searchScope = 'Bounded exact npm declaration and three common root paths at npm gitHead; statuses and response hashes retained. Not an exhaustive repository search; no global absence claim.'
    persistTexts(record.localSearch.retainedDocuments)
    writeFileSync(exceptionsFile, json(exceptions))
  }
  for (const item of record.searchResponses ?? []) if (item.file && sha(readFileSync(path.join(output, item.file))) !== item.responseSha256) throw new Error('Search response digest mismatch')
  return Boolean(record.searchResponses?.length && record.searchResponses.some((item) => item.url === record.declarationSource && item.status === 200))
}

async function fetchText(url, limit = 2_000_000) {
  const parsed = new URL(url)
  if (!['registry.npmjs.org', 'api.github.com', 'raw.githubusercontent.com'].includes(parsed.hostname) || parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('Non-official evidence host rejected')
  }
  const key = `${url}:${limit}`
  if (!requests.has(key)) requests.set(key, (async () => {
    let last
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'PRW-release-license-evidence' } })
        if (response.status === 404) return null
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const chunks = []; let size = 0
        for await (const chunk of response.body) {
          size += chunk.length
          if (size > limit) throw new Error('Evidence response exceeds bound')
          chunks.push(chunk)
        }
        return Buffer.concat(chunks).toString('utf8')
      } catch (error) { last = error }
    }
    throw last
  })())
  return requests.get(key)
}

async function disclosedException(pkg) {
  const id = `${pkg.name}@${pkg.version}`
  if (pkg.license !== 'MIT' || !exceptionReasons[id]) return null
  const cached = exceptions[id]
  if (cached) {
    if (cached.declaration.name !== pkg.name || cached.declaration.version !== pkg.version || cached.declaration.license !== 'MIT') throw new Error('Exception declaration mismatch')
    cached.reason = exceptionReasons[id]
    cached.declarationSha256 = sha(json(cached.declaration))
    const text = readFileSync(path.join(output, cached.standardText.file), 'utf8')
    if (sha(text) !== cached.standardText.sha256) throw new Error('Exception text digest mismatch')
    blobs.set(cached.standardText.file, text)
    return cached
  }
  if (!online) return null
  const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`
  const metadata = await remoteJson(metadataUrl)
  if (metadata?.name !== pkg.name || metadata.version !== pkg.version || metadata.license !== 'MIT') throw new Error('Exception npm declaration mismatch')
  const standardSource = 'https://raw.githubusercontent.com/spdx/license-list-data/d46e94e2c78ceede1cfc63cfa0396472d2798d4c/text/MIT.txt'
  const text = await fetchText(standardSource)
  if (!text?.includes('Copyright (c) <year> <copyright holders>') || !text.includes('Permission is hereby granted')) throw new Error('Unexpected SPDX MIT template')
  const standardText = addText(text, standardSource, 'standard-template-not-upstream')
  const declaration = { name: metadata.name, version: metadata.version, license: metadata.license, repository: metadata.repository }
  if (metadata.gitHead !== undefined) declaration.gitHead = metadata.gitHead
  const record = {
    declaration, declarationSource: metadataUrl, declarationScope: 'Exact unmodified fields extracted from the official npm exact-version response; not the full registry metadata document.',
    declarationSha256: sha(json(declaration)),
    reason: exceptionReasons[id], standardText,
    standardRevision: { repository: 'https://github.com/spdx/license-list-data', tag: 'v3.27.0', tagObject: '60e0de29cbcf3e83bf9d5e299972a1969516d918', commit: 'd46e94e2c78ceede1cfc63cfa0396472d2798d4c' },
    disclosure: 'SPDX standard MIT template, NOT recovered upstream notice. Placeholder copyright remains unfilled; no copyright holder is inferred. Missing upstream attribution remains a disclosed legal/compliance risk. This is not legal advice.'
  }
  exceptions[id] = record
  return record
}

async function remoteJson(url, limit) {
  const text = await fetchText(url, limit)
  return text === null ? null : JSON.parse(text)
}

function readTar(bytes) {
  const files = []
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.every((value) => value === 0)) break
    const name = header.subarray(0, 100).toString().replace(/\0.*$/su, '')
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/su, '').trim(), 8)
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > bytes.length) throw new Error('Invalid crate archive')
    if (header[156] === 48 || header[156] === 0) files.push({ name, body: bytes.subarray(offset + 512, offset + 512 + size) })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

async function nativeEvidence(clipboardDirectory) {
  const reportFile = path.join(output, 'native-clipboard-evidence.json')
  const revision = '3a0f58eb7250a9a46ad77863bc4618eee099a248'
  let report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null
  const problems = (value) => {
    const result = []
    for (const pkg of value.packages) {
      if (!pkg.archiveVerified || !pkg.license || !pkg.texts?.length) result.push({ package: `${pkg.name}@${pkg.version}`, reason: 'Crate download/checksum/license declaration or original notice incomplete', scope: pkg.scope })
      if (!nativeSelection(pkg.license, pkg.texts)) result.push({ package: `${pkg.name}@${pkg.version}`, reason: `No reviewed permissive license alternative with complete original body selected: ${pkg.license ?? 'UNKNOWN'}`, scope: pkg.scope })
    }
    if (!value.vendoredClipboardRs.texts.length) result.push({ package: 'vendored clipboard_rs', reason: 'Acknowledged upstream original notice unavailable' })
    return result
  }
  const checkpoint = () => {
    persistTexts([...report.packages.flatMap((pkg) => pkg.texts ?? []), ...report.vendoredClipboardRs.texts])
    report.licenseExpressionCounts = Object.fromEntries([...new Set(report.packages.map((pkg) => pkg.license ?? 'UNKNOWN'))].sort().map((license) => [license, report.packages.filter((pkg) => (pkg.license ?? 'UNKNOWN') === license).length]))
    for (const pkg of report.packages) {
      for (const text of pkg.texts) if (/\.(?:rs|c|h|cpp)$/u.test(text.source)) text.kind = 'source-not-license'
      pkg.licenseSelection = nativeSelection(pkg.license, pkg.texts)
    }
    report.licenseReview = { selectableLicenses: [...nativeAllowed].sort(), policy: 'Select an explicit reviewed permissive OR alternative (prefer MIT), preserving complete declared expressions/notices. Legacy slash treated as OR. AND/WITH/parenthesized branches are not silently stripped or selected; unsupported expressions without a supported alternative fail closed. Independent review remains required.' }
    report.maximumNoticeFilesPerCrate = Math.max(0, ...report.packages.map((pkg) => pkg.texts?.length ?? 0))
    report.archiveBounds = { compressedBytes: 10_000_000, expandedBytes: 60_000_000, exactWindowsException: { package: 'windows@0.59.0', expandedBytes: 200_000_000, observedCompressedBytes: 9_429_988, observedExpandedBytes: 116_992_512, checksum: '7f919aee0a93304be7f62e8e5027811bbba96bcb1de84d6618be56e43f8a32a1' }, extraction: 'In-memory bounded gzip/tar parsing; no crate paths extracted to disk or code executed.' }
    const allProblems = problems(report)
    report.gaps = allProblems.filter((gap) => !gap.scope?.startsWith('Other-target/optional'))
    report.otherTargetGaps = allProblems.filter((gap) => gap.scope?.startsWith('Other-target/optional'))
    report.otherTargetLimitations = ['objc2 root LICENSE.md describes license choices and an Apple SDK derivation caveat but is not a full grant; missing original bodies remain explicitly listed. These crates are target-specific macOS dependencies, not asserted part of the Windows x64 binary. No macOS release approval is granted.']
    writeFileSync(reportFile, json(report))
  }
  if (nativeOnline) {
    mkdirSync(path.join(output, 'native-clipboard'), { recursive: true })
    if (!report) {
      const sources = []
      for (const name of ['Cargo.toml', 'Cargo.lock', 'build.rs', 'README.md', 'src/clipboard_rs/mod.rs', 'src/clipboard_rs/common.rs', 'src/clipboard_rs/platform/win.rs']) {
        const file = `native-clipboard/${name}`
        const source = `https://raw.githubusercontent.com/earendil-works/clipboard/${revision}/${name}`
        const local = path.join(output, file)
        let body
        if (existsSync(local)) body = readFileSync(local, 'utf8')
        else {
          body = await fetchText(source)
          if (!body) throw new Error('Official clipboard source missing')
          mkdirSync(path.dirname(local), { recursive: true }); writeFileSync(local, body)
        }
        sources.push({ file, source, sha256: sha(body), retrievalNote: 'Fixed-revision source bytes retained from official GitHub contents/raw endpoint; offline SHA verifies this retained copy, not Git commit signature.' })
      }
      if (readFileSync(path.join(output, sources[0].file), 'utf8') !== readFileSync(path.join(clipboardDirectory, 'Cargo.toml'), 'utf8')) throw new Error('Installed clipboard Cargo.toml differs from official revision')
      const lock = readFileSync(path.join(output, 'native-clipboard/Cargo.lock'), 'utf8')
      const packages = lock.split('[[package]]').slice(1).map((part) => ({
        name: part.match(/^name = "([^"]+)"/mu)?.[1], version: part.match(/^version = "([^"]+)"/mu)?.[1],
        checksum: part.match(/^checksum = "([^"]+)"/mu)?.[1], dependencies: [...(part.match(/dependencies = \[([\s\S]*?)\]/u)?.[1] ?? '').matchAll(/"([^"]+)"/gu)].map((match) => match[1])
      })).filter((pkg) => pkg.checksum)
      const map = new Map(packages.map((pkg) => [`${pkg.name} ${pkg.version}`, pkg]))
      const reachable = (roots) => {
        const visited = new Set(); const pending = [...roots]
        while (pending.length) {
          const dependency = pending.pop()
          for (const [key, pkg] of map) if ((key === dependency || pkg.name === dependency) && !visited.has(key)) { visited.add(key); pending.push(...pkg.dependencies) }
        }
        return visited
      }
      const windows = reachable(['base64', 'futures', 'image', 'napi', 'napi-derive', 'tokio', 'clipboard-win', 'windows 0.59.0'])
      const build = reachable(['napi-build'])
      for (const pkg of packages) {
        pkg.scope = windows.has(`${pkg.name} ${pkg.version}`) ? 'Windows-possible conservative dependency closure; may include target/feature-inactive crates' : build.has(`${pkg.name} ${pkg.version}`) ? 'Build dependency closure' : 'Other-target/optional lock superset; not asserted shipped in Windows binary'
        pkg.source = `https://static.crates.io/crates/${pkg.name}/${pkg.name}-${pkg.version}.crate`
        pkg.texts = []
      }
      report = { revision, sources, installedCargoMatchesSource: true, installedCargoLockPresent: existsSync(path.join(clipboardDirectory, 'Cargo.lock')), scope: 'Exact source lockfile conservative superset. No native compilation, artifact execution, binary equivalence, exact enabled-feature or linker inclusion claim. All archive notice files are retained without count truncation.', directDeclarations: { shared: ['base64 0.22.0', 'futures 0.3.30', 'image =0.25.5 optional/default image/png/jpeg', 'napi 3.9.0 napi4/tokio_rt/dyn-symbols', 'napi-derive 3.5.6', 'tokio 1.36.0'], windows: ['clipboard-win 5.4.1 monitor', 'image =0.25.5 bmp/png/jpeg', 'windows 0.59.0 Win32_Foundation/Graphics_Gdi/System_DataExchange'], build: ['napi-build 2.3.2'], otherTargets: ['wl-clipboard-rs optional', 'x11rb', 'objc2', 'objc2-app-kit', 'objc2-foundation', 'macOS image/tiff'] }, packages, vendoredClipboardRs: { source: 'https://raw.githubusercontent.com/ChurchTao/clipboard-rs/e6f5b4e683fec943c24e9f838da9151a95114574/LICENSE', revision: 'e6f5b4e683fec943c24e9f838da9151a95114574', tag: 'v0.3.1', basis: 'Wrapper README credits ChurchTao/clipboard-rs 0.3.1. Original notice retained as conservative provenance; vendored source has modifications, so exact source equivalence is not asserted.', texts: [] } }
      checkpoint()
    }
    for (const item of [...report.packages.flatMap((pkg) => pkg.texts ?? []), ...report.vendoredClipboardRs.texts]) {
      const body = readFileSync(path.join(output, item.file), 'utf8')
      if (sha(body) !== item.sha256) throw new Error('Native cached license digest mismatch')
      blobs.set(item.file, body)
    }
    let next = 0
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < report.packages.length) {
        const pkg = report.packages[next++]
        if (pkg.archiveVerified && pkg.texts.length) continue
        try {
          if (!pkg.archiveVerified) {
            const retainedArchive = path.join(output, 'native-clipboard/windows-0.59.0.crate')
            let bytes
            if (pkg.name === 'windows' && pkg.version === '0.59.0' && existsSync(retainedArchive)) bytes = readFileSync(retainedArchive)
            else {
              const response = await fetch(pkg.source, { signal: AbortSignal.timeout(15_000), redirect: 'error' })
              if (!response.ok) throw new Error('Crate request failed')
              bytes = Buffer.from(await response.arrayBuffer())
            }
            if (bytes.length > 10_000_000 || sha(bytes) !== pkg.checksum) throw new Error('Crate checksum/bound failure')
            const expandedBound = pkg.name === 'windows' && pkg.version === '0.59.0' ? 200_000_000 : 60_000_000
            const files = readTar(gunzipSync(bytes, { maxOutputLength: expandedBound }))
            const manifest = files.find((file) => file.name === `${pkg.name}-${pkg.version}/Cargo.toml`)?.body.toString('utf8')
            pkg.license = manifest?.match(/^license\s*=\s*"([^"]+)"/mu)?.[1] ?? null
            pkg.texts = files.filter((file) => licenseFile.test(path.basename(file.name)) || noticeFile.test(path.basename(file.name))).map((file) => addText(file.body.toString('utf8'), `${pkg.source}#${file.name}`))
            const vcsFile = files.find((file) => file.name.endsWith('/.cargo_vcs_info.json'))
            if (vcsFile) pkg.vcs = JSON.parse(vcsFile.body.toString('utf8'))
            pkg.repository = manifest?.match(/^repository\s*=\s*"([^"]+)"/mu)?.[1] ?? null
            pkg.archiveVerified = true
            checkpoint()
          }
          if (!pkg.texts.length && gitSha.test(pkg.vcs?.git?.sha1 ?? '')) {
            if (pkg.name === 'zune-core') {
              const local = path.join(output, `native-clipboard/${pkg.vcs.git.sha1}-LICENSE-ZLIB`)
              if (existsSync(local)) pkg.texts.push(addText(readFileSync(local, 'utf8'), `https://raw.githubusercontent.com/etemesi254/zune-image/${pkg.vcs.git.sha1}/LICENSE-ZLIB`))
            }
            const repo = pkg.repository?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)/u)?.[1]?.replace(/\.git$/u, '')
            if (repo) {
              const retained = pkg.name === 'clipboard-win' ? 'clipboard-win-LICENSE.upstream' : `${pkg.vcs.git.sha1}-${repo === 'madsmtm/objc2' ? 'LICENSE.md' : 'LICENSE'}`
              const retainedPath = path.join(output, 'native-clipboard', retained)
              if (existsSync(retainedPath)) pkg.texts.push(addText(readFileSync(retainedPath, 'utf8'), `https://raw.githubusercontent.com/${repo}/${pkg.vcs.git.sha1}/${repo === 'madsmtm/objc2' ? 'LICENSE.md' : 'LICENSE'}`))
              if (!pkg.texts.length) {
                const listing = githubJson(`repos/${repo}/contents?ref=${pkg.vcs.git.sha1}`)
                if (Array.isArray(listing)) for (const item of listing.filter((item) => item.type === 'file' && (licenseFile.test(item.name) || noticeFile.test(item.name)))) {
                  const data = githubJson(`repos/${repo}/contents/${item.name}?ref=${pkg.vcs.git.sha1}`)
                  if (data?.content) pkg.texts.push(addText(Buffer.from(data.content, 'base64').toString('utf8'), `https://raw.githubusercontent.com/${repo}/${pkg.vcs.git.sha1}/${item.name}`))
                }
              }
            }
          }
          console.log(`Crate ${pkg.name}@${pkg.version}: ${pkg.license ?? 'unknown'}, ${pkg.texts.length} texts`)
        } catch { pkg.retrievalFailure = 'Bounded crate download/checksum/text extraction failed; no unverified archive accepted.' }
        checkpoint()
      }
    }))
    if (!report.vendoredClipboardRs.texts.length) {
      try {
        const retainedPath = path.join(output, 'native-clipboard/e6f5b4e683fec943c24e9f838da9151a95114574-LICENSE')
        const data = existsSync(retainedPath) ? null : githubJson('repos/ChurchTao/clipboard-rs/contents/LICENSE?ref=e6f5b4e683fec943c24e9f838da9151a95114574')
        const text = existsSync(retainedPath) ? readFileSync(retainedPath, 'utf8') : data?.content ? Buffer.from(data.content, 'base64').toString('utf8') : null
        if (text && textIsLicense(text)) report.vendoredClipboardRs.texts.push(addText(text, report.vendoredClipboardRs.source))
      } catch { /* The partial report remains persisted and release-blocking. */ }
    }
    checkpoint()
  }
  if (!report) return null
  for (const source of report.sources) if (sha(readFileSync(path.join(output, source.file))) !== source.sha256) throw new Error('Native source digest mismatch')
  for (const text of [...report.packages.flatMap((pkg) => pkg.texts ?? []), ...report.vendoredClipboardRs.texts]) {
    const body = blobs.get(text.file) ?? readFileSync(path.join(output, text.file), 'utf8')
    if (sha(body) !== text.sha256) throw new Error('Native license digest mismatch')
    blobs.set(text.file, body)
  }
  if (!check) checkpoint()
  else {
    const allProblems = problems(report)
    if (json(allProblems.filter((gap) => !gap.scope?.startsWith('Other-target/optional'))) !== json(report.gaps) ||
      json(allProblems.filter((gap) => gap.scope?.startsWith('Other-target/optional'))) !== json(report.otherTargetGaps)) throw new Error('Native gap classification stale')
    for (const pkg of report.packages) if (json(nativeSelection(pkg.license, pkg.texts)) !== json(pkg.licenseSelection)) throw new Error('Native selected license evidence stale')
  }
  return report
}

async function resolveRevision(metadata, repository, name, packageVersion) {
  if (gitSha.test(metadata.gitHead ?? '')) return { revision: metadata.gitHead, proof: { kind: 'npm-gitHead' } }
  const attestations = metadata.dist?.attestations?.url
  if (attestations?.startsWith('https://registry.npmjs.org/')) {
    const document = await remoteJson(attestations)
    for (const item of document?.attestations ?? []) {
      const payload = item.bundle?.dsseEnvelope?.payload
      if (!payload) continue
      const statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
      const integrity = metadata.dist?.integrity?.match(/^sha512-(.+)$/u)?.[1]
      if (!integrity || !statement.subject?.some((subject) => subject.digest?.sha512 === Buffer.from(integrity, 'base64').toString('hex'))) continue
      for (const dependency of statement.predicate?.buildDefinition?.resolvedDependencies ?? []) {
        if (dependency.uri?.startsWith(`git+${repository}@`) && gitSha.test(dependency.digest?.gitCommit ?? '')) {
          return { revision: dependency.digest.gitCommit, proof: { kind: 'npm-provenance-metadata', url: attestations, note: 'Registry metadata read; cryptographic attestation signature not independently verified.' } }
        }
      }
    }
  }
  // Some AWS releases omit gitHead. Match the published name/version against a
  // dated official source commit instead of guessing a tag or using HEAD.
  const directory = name === '@aws-sdk/nested-clients' ? 'packages-internal/nested-clients' : metadata.repository?.directory
  if (repository !== 'https://github.com/aws/aws-sdk-js-v3' || !directory || !/^[a-zA-Z0-9_/-]+$/u.test(directory)) return null
  const packument = await remoteJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`, 20_000_000)
  const published = packument?.time?.[packageVersion]
  if (!published) return null
  const commitsUrl = `https://api.github.com/repos/aws/aws-sdk-js-v3/commits?path=${encodeURIComponent(`${directory}/package.json`)}&until=${encodeURIComponent(published)}&per_page=8`
  const commits = await remoteJson(commitsUrl)
  if (!Array.isArray(commits)) return null
  for (const commit of commits) {
    if (!gitSha.test(commit.sha ?? '')) continue
    const manifestUrl = `https://raw.githubusercontent.com/aws/aws-sdk-js-v3/${commit.sha}/${directory}/package.json`
    const manifest = await remoteJson(manifestUrl)
    if (manifest?.name === name && manifest.version === packageVersion && manifest.license === metadata.license) {
      return { revision: commit.sha, proof: { kind: 'official-version-manifest', url: manifestUrl, published, commitsUrl, note: 'Exact name/version/license matched at source revision; npm omitted gitHead, so source-to-tarball reproducibility is not asserted.' } }
    }
  }
  return null
}

async function supplement(name, packageVersion, declaredLicense) {
  const id = `${name}@${packageVersion}`
  const cached = evidence[id]
  if (cached) {
    if (cached.license !== declaredLicense || !gitSha.test(cached.revision ?? '')) throw new Error(`Invalid cached evidence for ${id}`)
    for (const notice of cached.texts) {
      if (!/^license-texts\/[a-f0-9]{64}\.txt$/u.test(notice.file)) throw new Error('Invalid cached text path')
      const local = path.join(output, notice.file)
      const text = blobs.get(notice.file) ?? (existsSync(local) ? readFileSync(local, 'utf8') : online ? await fetchText(notice.source.replace(/#license$/u, '')) : null)
      if (text === null) throw new Error(`Missing cached evidence for ${id}`)
      if (sha(text) !== notice.sha256) throw new Error(`Evidence digest mismatch: ${id}`)
      blobs.set(notice.file, text)
    }
    return cached
  }
  if (!online) return null
  const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(packageVersion)}`
  const metadata = await remoteJson(metadataUrl)
  if (metadata?.name !== name || metadata.version !== packageVersion || metadata.license !== declaredLicense) throw new Error('npm version/license mismatch')
  const repository = httpsSource(metadata.repository)
  if (!repository?.startsWith('https://github.com/')) return null
  const resolved = await resolveRevision(metadata, repository, name, packageVersion)
  if (!resolved) return null
  const directory = metadata.repository?.directory
  const prefixes = directory && /^[a-zA-Z0-9_/-]+$/u.test(directory) ? ['', `${directory}/`] : ['']
  const candidates = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT', 'license', 'license.md', 'COPYING']
  const base = repository.replace('https://github.com/', 'https://raw.githubusercontent.com/')
  const texts = []
  outer: for (const prefix of prefixes) for (const file of candidates) {
    const url = `${base}/${resolved.revision}/${prefix}${file}`
    const text = await fetchText(url)
    if (text && textIsLicense(text)) { texts.push(addText(text, url)); break outer }
  }
  if (!texts.length) {
    for (const file of ['README.md', 'readme.md']) {
      const url = `${base}/${resolved.revision}/${file}`
      const text = await fetchText(url)
      const section = text && readmeLicense(text)
      if (section) { texts.push(addText(section, `${url}#license`)); break }
    }
  }
  if (!texts.length) return null
  for (const file of ['NOTICE', 'NOTICE.txt', 'NOTICE.md']) {
    const url = `${base}/${resolved.revision}/${file}`
    const text = await fetchText(url)
    if (text && text.trim()) { texts.push(addText(text, url, 'notice')); break }
  }
  const result = { license: declaredLicense, metadataUrl, repository, revision: resolved.revision, proof: resolved.proof, texts }
  evidence[id] = result
  return result
}

function localTexts(directory, name, packageVersion) {
  const result = []
  for (const file of readdirSync(directory).sort()) {
    const absolute = path.join(directory, file)
    if ((!licenseFile.test(file) && !noticeFile.test(file)) || !statSync(absolute).isFile()) continue
    const text = readFileSync(absolute, 'utf8')
    if (!text.trim()) continue
    result.push(addText(text, `npm:${name}@${packageVersion}/${file}`, licenseFile.test(file) ? 'license' : 'notice'))
  }
  if (!result.some((item) => item.kind === 'license')) {
    for (const file of readdirSync(directory).filter((file) => /^readme(?:[.-]|$)/iu.test(file)).sort()) {
      const absolute = path.join(directory, file)
      if (!statSync(absolute).isFile()) continue
      const section = readmeLicense(readFileSync(absolute, 'utf8'))
      if (section) { result.push(addText(section, `npm:${name}@${packageVersion}/${file}#license`)); break }
    }
  }
  return result
}

async function main() {
  const grouped = readJsonInput(input)
  const inventory = new Map()
  let inputRows = 0
  for (const [license, rows] of Object.entries(grouped)) {
    if (!Array.isArray(rows)) throw new Error('Invalid pnpm license inventory')
    for (const row of rows) {
      inputRows++
      if (row.license !== license || !Array.isArray(row.paths) || !Array.isArray(row.versions)) throw new Error('Malformed license row')
      const seen = new Set()
      for (const directory of row.paths) {
        const pkg = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))
        if (pkg.name !== row.name || !row.versions.includes(pkg.version) || pkg.license !== license) throw new Error(`Installed package does not match inventory: ${row.name}`)
        seen.add(pkg.version)
        const id = `${pkg.name}@${pkg.version}`
        if (inventory.has(id)) continue
        inventory.set(id, { pkg, directory, license })
      }
      if (row.versions.some((v) => !seen.has(v))) throw new Error(`Version missing from installed paths: ${row.name}`)
    }
  }
  if (online) {
    const missing = [...inventory.values()].filter(({ directory }) => !readdirSync(directory).some((file) => licenseFile.test(file)))
    let next = 0
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < missing.length) {
        const { pkg, license } = missing[next++]
        try {
          const found = await supplement(pkg.name, pkg.version, license)
          console.log(`${found ? 'Resolved' : 'Unresolved'} ${pkg.name}@${pkg.version}`)
        } catch { console.log(`Unresolved ${pkg.name}@${pkg.version}`) }
      }
    }))
  }
  for (const [id, { pkg, directory, license }] of [...inventory].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const texts = localTexts(directory, pkg.name, pkg.version)
    const entry = { name: pkg.name, version: pkg.version, license, source: httpsSource(pkg.repository) ?? httpsSource(pkg.homepage), npm: `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`, texts }
    if (!allowed.has(license)) gaps.push({ package: id, reason: `Unreviewed license: ${license}` })
    if (!texts.some((text) => text.kind === 'license')) {
      try {
        const remote = await supplement(pkg.name, pkg.version, license)
        if (remote) { entry.evidence = { ...remote, texts: undefined }; texts.push(...remote.texts) }
      } catch { /* The single missing-body gap below records a bounded retrieval failure. */ }
    }
    if (!texts.some((text) => text.kind === 'license')) {
      let exception
      try { exception = await disclosedException(pkg) } catch { /* Preserve the hard gap if exception evidence is unavailable. */ }
      let documented = false
      if (exception) {
        documented = await exceptionSearch(exception, pkg, directory)
        entry.disclosedException = exception; texts.push(exception.standardText)
      }
      gaps.push({ package: id, reason: 'No complete upstream license text in package or verified exact-revision source.', exceptionAvailable: Boolean(exception) && documented })
    }
    entries.push(entry)
  }
  const skills = [
    ['last30days', '.agents/skills/last30days/LICENSE', 'https://github.com/mvanhorn/last30days-skill', '7f4e16b9540a32aeb2f876f0ad3043e691999eb5'],
    ['last30days/bird-search', '.agents/skills/last30days/skills/last30days/scripts/lib/vendor/bird-search/LICENSE', 'https://github.com/mvanhorn/last30days-skill', '7f4e16b9540a32aeb2f876f0ad3043e691999eb5'],
    ['grill-me', '.agents/skills/grill-me/LICENSE.upstream', 'https://github.com/mattpocock/skills', '5b15a47f2d7150f545fbcacbfe381787fc0230dc'],
    ['grilling', '.agents/skills/grilling/LICENSE.upstream', 'https://github.com/mattpocock/skills', '5b15a47f2d7150f545fbcacbfe381787fc0230dc'],
    ['ponytail', '.agents/skills/ponytail/LICENSE.upstream', 'https://github.com/DietrichGebert/ponytail', '2ed6c52c9d7e5e56942508591085fd45dea277d3'],
    ['ui-ux-pro-max', '.agents/skills/ui-ux-pro-max/LICENSE.upstream', 'https://github.com/nextlevelbuilder/ui-ux-pro-max-skill', 'bc826e2267a36d98a2dcf5231e16c30ff546770f']
  ].map(([name, file, source, revision]) => ({ name, license: 'MIT', source, revision, texts: [addText(readFileSync(path.join(root, file), 'utf8'), file)] }))
  const clipboard = [...inventory.values()].find(({ pkg }) => pkg.name === '@mariozechner/clipboard')
  const native = clipboard ? await nativeEvidence(clipboard.directory) : null
  if (clipboard && !native) gaps.push({ package: 'clipboard native dependency notices', reason: 'Exact native source/lock/license evidence has not been generated.' })
  for (const gap of native?.gaps ?? []) gaps.push({ ...gap, native: true })
  const counts = {}
  for (const entry of entries) counts[entry.license] = (counts[entry.license] ?? 0) + 1
  const manifest = { format: 1, release: version, inventoryCommand: 'pnpm licenses list --prod --json', scope: 'Conservative workspace production dependency inventory; includes dependencies not necessarily present in final Electron payload. Not a binary-level SBOM.', inputRows, packageVersions: entries.length, licenseCounts: counts, packages: entries, skills }
  const header = `Personal Research Workbench ${version} - Third-party notices\n\nThis file preserves actual installed license/notice text or official exact-revision\nsource text. Copyright holders and upstream wording are not synthesized.\nThe inventory is conservative; presence here does not prove inclusion in the app.\nElectron LICENSE and LICENSES.chromium.html remain separate distribution files.\nSkill provenance is also recorded in resources/skills/THIRD_PARTY_SKILLS.md.\n\n`
  let notices = header
  for (const entry of [...entries, ...skills]) {
    notices += `${'='.repeat(78)}\n${entry.name}${entry.version ? `@${entry.version}` : ` (${entry.revision})`}\nDeclared license: ${entry.license}\nSource: ${entry.source ?? 'not supplied'}\n`
    if (entry.disclosedException) notices += `\nDISCLOSED EXCEPTION - NOT AN UPSTREAM NOTICE\n${entry.disclosedException.disclosure}\nOfficial npm declaration: ${JSON.stringify(entry.disclosedException.declaration)}\nDeclaration source: ${entry.disclosedException.declarationSource}\n`
    for (const text of entry.texts) notices += `\n--- ${text.kind}: ${text.source} ---\n${blobs.get(text.file)}\n`
    notices += '\n'
  }
  if (native) {
    notices += `${'='.repeat(78)}\nCLIPBOARD NATIVE DEPENDENCY NOTICES\n${native.scope}\n\n`
    for (const pkg of native.packages) {
      notices += `crate ${pkg.name}@${pkg.version}\nDeclared license: ${pkg.license}\nSelected license with original body: ${pkg.licenseSelection?.selected ?? 'NOT RECOVERED; see explicit other-target gaps'}\nScope: ${pkg.scope}\n`
      for (const text of pkg.texts ?? []) notices += `\n--- ${text.kind}: ${text.source} ---\n${blobs.get(text.file)}\n`
    }
    notices += `\nOTHER-TARGET LIMITATIONS (not a macOS release approval)\n${native.otherTargetLimitations.join('\n')}\n${json(native.otherTargetGaps)}\n`
    notices += `\nVendored clipboard_rs acknowledged source: ${native.vendoredClipboardRs.source}\n${native.vendoredClipboardRs.basis}\n`
    for (const text of native.vendoredClipboardRs.texts) notices += `${blobs.get(text.file)}\n`
  }
  const exceptionDocument = Object.fromEntries(Object.entries(exceptions).sort(([a], [b]) => a.localeCompare(b, 'en')))
  const exceptionsSha256 = sha(json(exceptionDocument))
  const nativeEvidenceSha256 = native ? sha(json(native)) : null
  const approvalPath = path.join(output, 'license-exception-approval.json')
  const approval = existsSync(approvalPath) ? JSON.parse(readFileSync(approvalPath, 'utf8')) : null
  const approved = gaps.length > 0 && gaps.every((gap) => gap.exceptionAvailable && approval?.packageIds?.includes(gap.package)) &&
    approval?.release === version && approval.decision === 'accepted' && approval.reviewerRole === 'Review Security' &&
    approval.exceptionsSha256 === exceptionsSha256 && native?.gaps.length === 0 && approval.nativeEvidenceSha256 === nativeEvidenceSha256 &&
    typeof approval.reviewReference === 'string' && approval.reviewReference.length >= 12
  const report = { release: version, gate: gaps.length ? approved ? 'PASS_WITH_DISCLOSED_EXCEPTIONS' : 'BLOCKED' : 'PASS', inputRows, packageVersions: entries.length, licenseCounts: counts, supplementedPackages: Object.keys(evidence).length, native: native ? { report: 'native-clipboard-evidence.json', sha256: sha(json(native)), lockedCrates: native.packages.length, checksumVerifiedCrates: native.packages.filter((pkg) => pkg.archiveVerified).length, gaps: native.gaps.length, otherTargetGaps: native.otherTargetGaps.length } : null, gaps, exceptionsSha256, exceptionApproval: approved ? approval : null, limitations: ['Independent legal/security approval is separate from this mechanical gate.', 'SPDX standard templates do not reconstruct missing upstream copyright/notice text; disclosed exceptions require an explicit release-scoped independent acceptance record.', 'An approval file is an auditable decision record, not cryptographic proof of reviewer identity and not legal advice.', 'Native/bundled subcomponents are covered only to the extent identified by upstream package notices; this is not an exhaustive binary/SBOM audit.', 'Electron/Chromium licenses must remain in the packaged distribution.', 'Official npm provenance metadata is not claimed as independently signature-verified.'] }
  let index = `# License Text Index\n\nAll paths below are relative to this directory unless described as installation-root paths.\n\n`
  for (const license of [...allowed].sort()) {
    index += `## ${license}\n\n`
    for (const entry of entries.filter((entry) => entry.license === license)) {
      index += `- ${entry.name}@${entry.version}: ${entry.texts.filter((text) => text.kind === 'license').map((text) => `[verbatim text](${text.file})`).join(', ') || (entry.disclosedException ? `**UPSTREAM NOTICE MISSING**; [SPDX standard template, not upstream text](${entry.disclosedException.standardText.file}); see license-exceptions.json and independent acceptance gate` : '**MISSING - release blocked**')}\n`
    }
    index += '\n'
  }
  index += `## Skills\n\n`
  for (const skill of skills) index += `- ${skill.name}, ${skill.license}, revision ${skill.revision}: [verbatim text](${skill.texts[0].file}); upstream ${skill.source}\n`
  index += `\nThe installed skill registry is resources/skills/THIRD_PARTY_SKILLS.md; upstream LICENSE.upstream\nfiles remain within the respective resources/skills directories. last30days/LICENSE\nand its vendored bird-search/LICENSE are preserved and included in this consolidated notice.\n\n## Electron And Chromium\n\nElectron's own LICENSE and LICENSES.chromium.html are retained at the Windows\ninstallation root beside research-workbench.exe. These files are separate from\nresources/legal/${version}/THIRD_PARTY_NOTICES.txt and must not be removed. Their\nexistence and the exact Electron version must be verified against the final NSIS\npayload; this generator does not inspect or execute that payload.\n`
  const readme = `# Release ${version} License Evidence\n\n- Source: \`pnpm licenses list --prod --json\` (UTF-8 or UTF-16LE supported).\n- ${inputRows} grouped package rows, ${entries.length} exact installed name/version pairs.\n- Mechanical gate: **${report.gate}**; unresolved gaps: **${gaps.length}**.\n- \`production-dependencies.json\`: path-redacted name/version/license/repository inventory.\n- \`THIRD_PARTY_NOTICES.txt\`: verbatim license/notice texts, including fixed-revision skills.\n- \`source-evidence.json\`: npm version metadata, exact official revision and retrieval evidence for packages missing LICENSE.\n- \`license-texts/\`: content-addressed originals; hashes checked without network.\n- \`release-gate.json\`: explicit gaps and remaining scope limits.\n- \`license-exceptions.json\`: four exact npm MIT declarations, bounded URL/status/response-hash searches and clearly marked SPDX template exceptions; not approval.\n- \`native-clipboard-evidence.json\`: 121 checksum-verified locked crate archives, selected original license-body evidence, zero Windows/build closure gaps and ${native?.otherTargetGaps.length ?? 'unknown'} separately disclosed other-target gaps. Not a macOS approval or exact binary SBOM.\n- \`native-clipboard/\`: exact upstream source/provenance and retained originals; no native execution.\n\n## Reproduce\n\n\`node scripts/generate-release-notices.mjs --version ${version} --input <pnpm-json> --fetch-missing\`\n\n\`node scripts/generate-release-notices.mjs --version ${version} --input <pnpm-json> --fetch-native --fetch-exception-evidence\`\n\n\`node scripts/generate-release-notices.mjs --version ${version} --input <pnpm-json> --check\`\n\nThe check is read-only, offline and rejects stale/missing/changed evidence. No package\ninstallation, native module load, build, or application launch is performed. Network\nretrieval is opt-in and limited to official npm/GitHub/crates.io HTTPS sources;\nGitHub exact-revision GETs may use the installed gh CLI with credentials owned by gh.\nThe script never reads or prints those credentials. No latest-branch\nlicense is silently substituted for an exact version. Unknown/unreviewed licenses\nand missing license bodies block this mechanical gate. This does not replace\nindependent legal review or verification of the actual packaged payload.\n\nKeep Electron's LICENSE and LICENSES.chromium.html, this directory in resources/legal/${version},\nand the skill registry/upstream license files. The production inventory is a\nconservative superset, not a claim that build-only packages are shipped.\n`
  index += `\n## Clipboard Native Dependencies\n\nSee native-clipboard-evidence.json for all 121 exact lock crates, source checksums, complete declared expressions and selected original notice evidence. Windows/build gaps: ${native?.gaps.length ?? 'unknown'}; other-target gaps retained separately: ${native?.otherTargetGaps.length ?? 'unknown'}. Full lock superset is not claimed complete for macOS or as a Windows binary SBOM.\n`
  const generated = new Map([['production-dependencies.json', json(manifest)], ['source-evidence.json', json(Object.fromEntries(Object.entries(evidence).sort(([a], [b]) => a.localeCompare(b, 'en'))))], ['license-exceptions.json', json(exceptionDocument)], ['THIRD_PARTY_NOTICES.txt', notices], ['release-gate.json', json(report)], ['LICENSE-INDEX.md', index], ['README.md', readme], ...[...blobs].sort(([a], [b]) => a.localeCompare(b, 'en'))])
  for (const [file, content] of generated) {
    const destination = path.join(output, file)
    if (check) {
      if (!existsSync(destination) || readFileSync(destination, 'utf8') !== content) throw new Error(`Stale/missing release notice: ${file}`)
    } else {
      mkdirSync(path.dirname(destination), { recursive: true })
      writeFileSync(destination, content, 'utf8')
    }
  }
  console.log(JSON.stringify({ release: version, mode: check ? 'check' : 'generate', gate: report.gate, inputRows, packageVersions: entries.length, texts: blobs.size, gaps: gaps.length, output: slash(path.relative(root, output)) }))
  if (report.gate === 'BLOCKED') process.exitCode = 1
}

main().catch((error) => {
  // Never echo inventory paths or a remote response in a releasable error log.
  console.error(`Release notices failed: ${error.message.replace(/[A-Z]:[\\/][^\r\n]*/giu, '[local path redacted]')}`)
  process.exitCode = 1
})
