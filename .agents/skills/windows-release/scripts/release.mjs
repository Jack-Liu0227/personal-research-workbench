#!/usr/bin/env node
/**
 * windows-release engine — deterministic parts of the Personal Research
 * Workbench Windows release: version sync, gate + NSIS build (with the
 * machine-local `.asar` fallback), artifact verification, install/launch/
 * uninstall smoke, tag + GitHub release.
 *
 * Rules: Node built-ins only; every step prints the evidence it produced;
 * `--dry-run` writes nothing; no user data is ever deleted; nothing is claimed
 * that did not actually run.
 *
 * Playbook: ../SKILL.md — failure modes: ../references/evidence-and-pitfalls.md
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const SKILL_DIR = path.resolve(import.meta.dirname, '..')
const REPO = path.resolve(SKILL_DIR, '..', '..', '..')
const DESKTOP_DIR = path.join(REPO, 'apps', 'desktop')
const CHANGELOG_DIR = path.join(REPO, 'docs', 'changelog')
const PRODUCT_NAME = 'Personal Research Workbench'
const EXECUTABLE_NAME = 'research-workbench.exe'

const rawArgs = process.argv.slice(2)
const command = rawArgs.find((arg) => !arg.startsWith('-')) ?? 'help'
const VALUED_FLAGS = new Set([
  '--out',
  '--electron-dist',
  '--install',
  '--profile',
  '--setup',
  '--version',
  '--notes-file',
])

const flag = (name) => rawArgs.includes(`--${name}`)
const log = (message) => console.log(message)
const step = (message) => console.log(`\n=== ${message}`)

function warn(message) {
  console.log(`[warn] ${message}`)
}

function fail(message, code = 1) {
  console.error(`[fail] ${message}`)
  process.exit(code)
}

function option(name, fallback = null) {
  const index = rawArgs.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = rawArgs[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value`)
  return value
}

function operands() {
  const out = []
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i]
    if (arg.startsWith('-')) {
      if (VALUED_FLAGS.has(arg)) i += 1
      continue
    }
    out.push(arg)
  }
  return out
}

function evidence(title, lines) {
  log(`\n--- evidence: ${title}`)
  for (const line of lines) log(`  ${line}`)
}

function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    cwd: options.cwd ?? REPO,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) fail(`${bin} could not start: ${result.error.message}`)
  return { code: result.status ?? 1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function mustRun(bin, args, options = {}) {
  const result = run(bin, args, options)
  if (result.code !== 0) {
    warn(`${bin} ${args.join(' ')} exited with ${result.code}`)
    log(result.out.split('\n').slice(-30).join('\n'))
    fail(`${bin} failed; stopping`)
  }
  return result.out
}

const requireWindows = () => process.platform === 'win32' || fail('the release pipeline is Windows-only (NSIS x64)')
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const currentVersion = () => readJson(path.join(REPO, 'package.json')).version

function walk(dir, depth = 0) {
  if (depth > 6) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'out', 'dist', '.git'].includes(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, depth + 1))
    else out.push(full)
  }
  return out
}

/** package.json files that carry the product version (discovered, not hard-coded). */
function versionPackageFiles() {
  const files = [path.join(REPO, 'package.json')]
  for (const group of ['apps', 'packages']) {
    const groupDir = path.join(REPO, group)
    if (!fs.existsSync(groupDir)) continue
    for (const name of fs.readdirSync(groupDir).sort()) {
      const candidate = path.join(groupDir, name, 'package.json')
      if (fs.existsSync(candidate)) files.push(candidate)
    }
  }
  return files
}

/** Source files that repeat the version as part of a public identity. */
function versionIdentityFiles(version) {
  const files = []
  for (const group of ['packages', 'apps']) {
    const groupDir = path.join(REPO, group)
    if (!fs.existsSync(groupDir)) continue
    for (const name of fs.readdirSync(groupDir).sort()) {
      const srcDir = path.join(groupDir, name, 'src')
      if (!fs.existsSync(srcDir)) continue
      for (const file of walk(srcDir)) {
        if (!/\.(ts|tsx|mts|cts)$/.test(file)) continue
        const text = fs.readFileSync(file, 'utf8')
        if (text.includes(`version: '${version}'`) || text.includes(`version: "${version}"`)) files.push(file)
      }
    }
  }
  return files
}

const outputDir = (version) =>
  path.resolve(option('out') ?? path.join(REPO, `release-${version}`, 'build'))
const electronDistDir = (version) =>
  path.resolve(option('electron-dist') ?? path.join(REPO, `release-${version}`, 'electron-dist'))
const listDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [])

function electronVersion() {
  const pkg = readJson(path.join(DESKTOP_DIR, 'package.json'))
  const declared = pkg.devDependencies?.electron ?? pkg.dependencies?.electron
  if (!declared) fail('apps/desktop/package.json does not declare electron')
  return declared.replace(/^[\^~]/, '')
}

function findElectronZip(version) {
  const cache = path.join(os.homedir(), 'AppData', 'Local', 'electron', 'Cache')
  if (!fs.existsSync(cache)) return null
  for (const entry of listDir(cache)) {
    const zip = path.join(cache, entry, `electron-v${version}-win32-x64.zip`)
    if (fs.existsSync(zip)) return zip
  }
  return null
}

function findSevenZip() {
  const cache = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache')
  if (!fs.existsSync(cache)) return null
  for (const entry of listDir(cache)) {
    if (!entry.startsWith('7zip@')) continue
    for (const inner of listDir(path.join(cache, entry))) {
      const candidate = path.join(cache, entry, inner, 'bin', '7za.exe')
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return null
}

function prepareElectronDist(version, dryRun) {
  const target = electronDistDir(version)
  if (fs.existsSync(path.join(target, 'electron.exe'))) {
    log(`reusing extracted Electron dist: ${target}`)
    return target
  }
  const zip = findElectronZip(electronVersion())
  const sevenZip = findSevenZip()
  if (!zip || !sevenZip) {
    fail(
      'the .asar lock workaround needs a cached Electron zip and electron-builder 7za. ' +
        'Run any electron-builder command once to populate the caches, or pass ' +
        '--electron-dist <dir> for an already extracted electron-v<ver>-win32-x64 directory.',
    )
  }
  log(`extracting ${zip}\n        -> ${target}`)
  if (dryRun) return target
  fs.mkdirSync(target, { recursive: true })
  mustRun(sevenZip, ['x', '-bso0', '-bsp0', `-o${target}`, zip])
  if (!fs.existsSync(path.join(target, 'electron.exe'))) fail(`extraction produced no electron.exe in ${target}`)
  return target
}

function hashFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase()
}

function powershell(script) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]).out.trim()
}

function authenticode(file) {
  const out = powershell(
    `$s = Get-AuthenticodeSignature -LiteralPath '${file}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`,
  )
  const [status, signer] = out.split('|')
  return {
    status: status || 'unknown',
    signer: (signer ?? '').trim() || '(none)',
    productVersion: powershell(`(Get-Item -LiteralPath '${file}').VersionInfo.ProductVersion`),
  }
}

function findInstaller(version) {
  const dir = outputDir(version)
  if (!fs.existsSync(dir)) fail(`no build output at ${dir}; run the build step first`)
  const candidates = listDir(dir).filter((name) => name.endsWith('-Setup.exe'))
  const pick = candidates.find((name) => name === `${PRODUCT_NAME.replace(/ /g, '-')}-${version}-Setup.exe`) ?? candidates[0]
  if (!pick) fail(`no *-Setup.exe inside ${dir}`)
  return path.join(dir, pick)
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function waitFor(label, predicate, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    sleep(1000)
  }
  warn(`timed out waiting for ${label}`)
  return false
}

const git = (args) => run('git', args)

// ------------------------------------------------------------------ status

function cmdStatus() {
  const version = currentVersion()
  step('versions')
  for (const file of versionPackageFiles()) {
    const pkg = readJson(file)
    log(`  ${path.relative(REPO, file).replace(/\\/g, '/').padEnd(44)} ${pkg.version}${pkg.private ? ' (private)' : ''}`)
  }
  for (const file of versionIdentityFiles(version)) {
    log(`  ${path.relative(REPO, file).replace(/\\/g, '/').padEnd(44)} ${version} (identity)`)
  }

  step('git')
  log(`  branch       ${git(['rev-parse', '--abbrev-ref', 'HEAD']).out.trim()}`)
  log(`  head         ${git(['log', '--oneline', '-1']).out.trim()}`)
  const tags = git(['tag', '--list']).out.trim()
  log(`  tags         ${tags ? tags.split('\n').join(', ') : '(none)'}`)
  const dirty = git(['status', '--porcelain']).out.trim()
  log(`  working tree ${dirty ? `dirty (${dirty.split('\n').length} paths)` : 'clean'}`)
  for (const line of dirty.split('\n').filter(Boolean).slice(0, 10)) log(`    ${line}`)
  log(`  notes        ${listDir(CHANGELOG_DIR).join(', ') || '(none)'}`)

  step('releases')
  const gh = run('gh', ['release', 'list', '--limit', '5'])
  log(gh.code === 0 && gh.out.trim() ? gh.out.trim().split('\n').map((line) => `  ${line}`).join('\n') : '  (gh unavailable or no releases)')

  step('artifacts on disk')
  const dir = outputDir(version)
  const files = listDir(dir).filter((name) => name.endsWith('.exe') || name.endsWith('.blockmap'))
  if (files.length === 0) log(`  (nothing at ${dir})`)
  for (const name of files) log(`  ${name.padEnd(52)} ${fs.statSync(path.join(dir, name)).size.toLocaleString('en-US')} bytes`)
  const dist = electronDistDir(version)
  log(`  electron-dist ${fs.existsSync(path.join(dist, 'electron.exe')) ? `ready at ${dist}` : 'not prepared'}`)
}

// ----------------------------------------------------------------- version

function cmdVersion() {
  const from = currentVersion()
  const target = operands()[1]
  if (flag('check') || !target) {
    step(`version check (current ${from})`)
    let mismatches = 0
    for (const file of versionPackageFiles()) {
      const actual = readJson(file).version
      if (actual !== from) {
        mismatches += 1
        log(`  MISMATCH ${path.relative(REPO, file)} -> ${actual}`)
      }
    }
    const identities = versionIdentityFiles(from)
    if (identities.length === 0) {
      mismatches += 1
      warn('no source file carries the current version as an identity; the pattern may have changed')
    }
    for (const file of identities) log(`  identity ${path.relative(REPO, file)} -> ${from}`)
    log(mismatches === 0 ? '\nversion is consistent' : `\n${mismatches} mismatch(es)`)
    if (flag('check') && mismatches > 0) process.exit(1)
    return
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(target)) fail(`"${target}" is not a semver version`)
  const dryRun = flag('dry-run')
  if (!fs.existsSync(path.join(CHANGELOG_DIR, `v${target}.md`))) {
    warn(`docs/changelog/v${target}.md does not exist yet; write the release notes before publishing`)
  }
  const [major, minor, patch] = from.split('.').map(Number)
  const [nextMajor, nextMinor, nextPatch] = target.split('.').map(Number)
  const downgrade =
    nextMajor < major || (nextMajor === major && (nextMinor < minor || (nextMinor === minor && nextPatch < patch)))
  if (downgrade) warn(`${target} is LOWER than the current ${from}: disclose this as a downgrade in the notes and report`)

  step(`version ${from} -> ${target}${dryRun ? ' (dry-run)' : ''}`)
  const pattern = /("version"\s*:\s*")([^"]+)(")/
  for (const file of versionPackageFiles()) {
    const text = fs.readFileSync(file, 'utf8')
    const match = text.match(pattern)
    if (!match) fail(`${path.relative(REPO, file)} has no "version" field`)
    if (match[2] !== from) fail(`${path.relative(REPO, file)} carries ${match[2]}, expected ${from}`)
    if (!dryRun) fs.writeFileSync(file, text.replace(pattern, `$1${target}$3`), 'utf8')
    log(`  ${path.relative(REPO, file).replace(/\\/g, '/').padEnd(44)} ${from} -> ${target}`)
  }
  const identityPattern = /(version:\s*['"])([^'"]+)(['"])/
  for (const file of versionIdentityFiles(from)) {
    const text = fs.readFileSync(file, 'utf8')
    if (!dryRun) fs.writeFileSync(file, text.replace(identityPattern, `$1${target}$3`), 'utf8')
    log(`  ${path.relative(REPO, file).replace(/\\/g, '/').padEnd(44)} ${from} -> ${target} (identity)`)
  }

  step('re-read')
  const stale = versionPackageFiles().filter((file) => readJson(file).version !== target)
  for (const file of stale) log(`  STILL ${readJson(file).version} in ${path.relative(REPO, file)}`)
  if (stale.length > 0 && !dryRun) fail('version sync incomplete')
  log(dryRun ? '  dry-run: nothing written' : `  all ${versionPackageFiles().length} package.json files report ${target}`)
}

// ------------------------------------------------------------------- build

/**
 * pnpm is a .cmd shim: Node refuses to spawn it without a shell (EINVAL) and
 * bare `pnpm` is not on PATH as an .exe (ENOENT), so route it through cmd.exe.
 * The command string must stay space-free because cmd/argv quoting is not
 * round-trip safe; every path we pass is therefore relative to apps/desktop.
 */
function pnpmRun(args, cwd = REPO) {
  const line = ['pnpm', ...args].join(' ')
  if (/\s/.test(line)) fail(`internal: refusing to run a command line containing spaces: ${line}`)
  return run('cmd.exe', ['/d', '/s', '/c', line], { cwd })
}

function desktopRelative(target) {
  return path.relative(DESKTOP_DIR, target).split(path.sep).join('/')
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
}

const ASAR_LOCK_SIGNATURE = /EBUSY|EPERM|resource busy or locked|default_app\.asar/i

function printTail(text, lines = 12) {
  const tail = text.trim().split('\n').slice(-lines)
  for (const line of tail) log(`  ${line}`)
}

function cmdBuild() {
  requireWindows()
  const version = currentVersion()
  const dryRun = flag('dry-run')
  const out = outputDir(version)
  const buildArgs = [
    'exec',
    'electron-builder',
    '--win',
    'nsis',
    '--x64',
    `-c.directories.output=${desktopRelative(out)}`,
  ]

  if (flag('skip-gate')) {
    warn('--skip-gate: an earlier gate result is assumed, not re-verified on this tree')
  } else {
    for (const script of ['typecheck', 'build']) {
      step(`gate: pnpm ${script}`)
      if (dryRun) {
        log('  (dry-run: not executed)')
        continue
      }
      const result = pnpmRun([script])
      if (result.code !== 0) {
        printTail(result.out, 30)
        fail(`pnpm ${script} failed`)
      }
      log('  ok')
    }
  }

  step(`electron-builder nsis x64 -> ${out}`)
  log(`  pnpm ${buildArgs.join(' ')}`)
  if (dryRun) {
    log('  (dry-run: not executed)')
    return
  }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const logFile = path.join(path.dirname(out), `build-${stamp()}.log`)

  const first = pnpmRun(buildArgs, DESKTOP_DIR)
  fs.writeFileSync(logFile, first.out, 'utf8')
  if (first.code === 0) {
    log('  default electron-builder path succeeded')
    printTail(first.out)
    evidence('build', [`log ${logFile}`, `output ${out}`, 'path default electron-builder (no electronDist fallback)'])
    return
  }

  if (!ASAR_LOCK_SIGNATURE.test(first.out)) {
    printTail(first.out, 30)
    fail(`electron-builder failed and the error is not the known .asar lock; log ${logFile}`)
  }

  warn('the .asar file lock hit the default path; retrying with an extracted Electron dist')
  printTail(first.out, 6)
  const dist = prepareElectronDist(version, false)
  const retry = pnpmRun([...buildArgs, `-c.electronDist=${desktopRelative(dist)}`], DESKTOP_DIR)
  fs.appendFileSync(logFile, retry.out, 'utf8')
  if (retry.code !== 0) {
    printTail(retry.out, 30)
    fail(`electron-builder failed on the electronDist fallback too; log ${logFile}`)
  }
  log('  electronDist fallback succeeded')
  printTail(retry.out)
  evidence('build', [
    `log ${logFile}`,
    `output ${out}`,
    `path electronDist fallback (${dist})`,
    'deviation: electronDist skips cleanupAfterUnpack, so the package keeps an inert resources/default_app.asar',
  ])
}

// ------------------------------------------------------------------ verify

function cmdVerify() {
  requireWindows()
  const version = currentVersion()
  const installer = findInstaller(version)
  const blockmap = `${installer}.blockmap`
  const sig = authenticode(installer)
  const out = outputDir(version)
  const unpacked = path.join(out, 'win-unpacked')
  const resources = path.join(unpacked, 'resources')
  const skills = listDir(path.join(resources, 'skills'))
  const sidecars = listDir(path.join(resources, 'sidecars'))
  const appAsar = path.join(resources, 'app.asar')
  const defaultAsar = path.join(resources, 'default_app.asar')

  if (skills.includes('windows-release')) {
    warn('resources/skills contains windows-release: the electron-builder filter is missing !**/windows-release/**')
  }
  evidence('artifacts', [
    `installer    ${path.basename(installer)}`,
    `size         ${fs.statSync(installer).size} bytes`,
    `sha256       ${hashFile(installer)}`,
    `signature    ${sig.status} / ${sig.signer}`,
    `productVer   ${sig.productVersion}`,
    `blockmap     ${fs.existsSync(blockmap) ? `${path.basename(blockmap)} (${fs.statSync(blockmap).size} bytes)` : 'MISSING'}`,
  ])
  evidence('packaged payload (win-unpacked)', [
    `executable   ${fs.existsSync(path.join(unpacked, EXECUTABLE_NAME)) ? EXECUTABLE_NAME : 'MISSING'}`,
    `uninstaller  ${listDir(unpacked).find((n) => n.startsWith('Uninstall')) ?? 'MISSING'}`,
    `app.asar     ${fs.existsSync(appAsar) ? `${fs.statSync(appAsar).size} bytes` : 'MISSING'}`,
    `default.asar ${fs.existsSync(defaultAsar) ? `${fs.statSync(defaultAsar).size} bytes (electronDist fallback artifact)` : 'absent'}`,
    `skills       ${skills.join(', ') || 'MISSING'}`,
    `sidecars     ${sidecars.join(', ') || 'MISSING'}`,
  ])
  log('\n(expected skill mirror: grill-me, grilling, last30days, literature-matrix, literature-review-push, ponytail, ui-ux-pro-max)')
}

// ------------------------------------------------------------------- smoke

function processCount(image) {
  const out = run('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH']).out.toLowerCase()
  return out.split('\n').filter((line) => line.includes(image.toLowerCase())).length
}

function killApp() {
  if (processCount(EXECUTABLE_NAME) === 0) return 0
  run('taskkill', ['/IM', EXECUTABLE_NAME, '/F'])
  waitFor(`${EXECUTABLE_NAME} to exit`, () => processCount(EXECUTABLE_NAME) === 0, 30_000)
  return processCount(EXECUTABLE_NAME)
}

function findUninstaller(installDir) {
  return listDir(installDir)
    .filter((name) => name.toLowerCase().startsWith('uninstall') && name.toLowerCase().endsWith('.exe'))
    .map((name) => path.join(installDir, name))[0]
}

function sqliteEvidence(dbPath) {
  const dir = (() => {
    const store = path.join(REPO, 'node_modules', '.pnpm')
    if (!fs.existsSync(store)) return null
    const entry = listDir(store).filter((name) => name.startsWith('better-sqlite3@')).sort().pop()
    return entry ? path.join(store, entry, 'node_modules', 'better-sqlite3') : null
  })()
  if (!dir) return ['skipped: better-sqlite3 is not installed in this checkout']
  try {
    const Database = require(dir)
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const tables = db.prepare("select name from sqlite_master where type='table' order by name").all().map((r) => r.name)
    const migrationTable = tables.find((name) => /migration/i.test(name))
    const lines = [
      `header       ${fs.readFileSync(dbPath).subarray(0, 15).toString('latin1')}`,
      `tables       ${tables.length}`,
      migrationTable
        ? `migrations   ${db.prepare(`select count(*) as c from ${migrationTable}`).get().c} rows, max id ${db.prepare(`select max(id) as m from ${migrationTable}`).get().m}`
        : 'migrations   MISSING',
    ]
    if (tables.includes('schedules')) {
      const rules = db.prepare('select id, workflow_key, enabled, cron, timezone from schedules order by id').all()
      lines.push(`schedules    ${rules.length} rows`)
      for (const rule of rules) {
        lines.push(`  ${rule.id} workflow=${rule.workflow_key} enabled=${rule.enabled} cron=${rule.cron} tz=${rule.timezone}`)
      }
    }
    const counts = ['tasks', 'papers', 'projects']
      .filter((table) => tables.includes(table))
      .map((table) => `${table}=${db.prepare(`select count(*) as c from ${table}`).get().c}`)
    lines.push(`row counts   ${counts.join(', ')}`)
    db.close()
    return lines
  } catch (error) {
    return [`skipped: ${error.message}`]
  }
}

function removable(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    return true
  } catch (error) {
    warn(`could not clear ${dir} (${error.code ?? error.message}); continuing`)
    return false
  }
}

function shortcutState() {
  const candidates = [
    path.join(process.env.USERPROFILE ?? '', 'Desktop', `${PRODUCT_NAME}.lnk`),
    path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${PRODUCT_NAME}.lnk`),
  ]
  return candidates.map((file) => `${fs.existsSync(file) ? 'present' : 'absent '} ${file}`)
}

function registryState() {
  const result = run('reg', [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    '/s',
    '/f',
    PRODUCT_NAME,
  ])
  return result.code === 0 ? `${PRODUCT_NAME} uninstall entry present` : 'no uninstall entry'
}

function cmdSmoke() {
  requireWindows()
  const version = currentVersion()
  const dryRun = flag('dry-run')
  const setupSource = path.resolve(option('setup') ?? findInstaller(version))
  if (!fs.existsSync(setupSource)) fail(`no installer at ${setupSource}`)
  const installDir = path.resolve(option('install') ?? path.join(os.tmpdir(), `prw-smoke-${version}`))
  const profileDir = path.resolve(option('profile') ?? path.join(os.tmpdir(), `prw-profile-${version}`))
  for (const [label, dir] of [
    ['install', installDir],
    ['profile', profileDir],
  ]) {
    if (dir.includes(' ')) fail(`${label} directory must not contain spaces (NSIS /D= and cmd quoting): ${dir}`)
  }
  // NSIS `/D=` is unquoted and must stay last, and cmd cannot round-trip spaces,
  // so the installer is copied out of the (space-containing) repository path.
  const setup = path.join(os.tmpdir(), `prw-setup-${version}.exe`)
  const dbPath = path.join(profileDir, 'data', 'workspace.sqlite3')

  step(`smoke install of ${path.basename(setupSource)}`)
  log(`  installer ${setupSource}`)
  log(`  install   ${installDir}`)
  log(`  profile   ${profileDir}`)
  log(`  mode      ${dryRun ? 'dry-run' : flag('keep') ? 'keep the installation' : 'install, launch, uninstall'}`)
  if (dryRun) return

  killApp()
  removable(installDir)
  removable(profileDir)
  if (path.resolve(setup) !== setupSource) fs.copyFileSync(setupSource, setup)

  step('1/5 silent install (cmd /c "<setup> /S /D=<dir>")')
  const install = run('cmd.exe', ['/d', '/s', '/c', `${setup} /S /D=${installDir}`])
  if (install.code !== 0) {
    printTail(install.out, 10)
    fail(`installer exited with ${install.code}`)
  }
  const installed = waitFor('the installation to appear', () => fs.existsSync(path.join(installDir, EXECUTABLE_NAME)), 180_000)
  if (!installed) fail(`nothing installed into ${installDir}`)
  const entries = listDir(installDir)
  const resources = path.join(installDir, 'resources')
  evidence('install', [
    `entries      ${entries.length}: ${entries.slice(0, 6).join(', ')}${entries.length > 6 ? ', ...' : ''}`,
    `executable   ${EXECUTABLE_NAME}`,
    `uninstaller  ${path.basename(findUninstaller(installDir) ?? 'MISSING')}`,
    `app.asar     ${fs.existsSync(path.join(resources, 'app.asar')) ? `${fs.statSync(path.join(resources, 'app.asar')).size} bytes` : 'MISSING'}`,
    `default.asar ${fs.existsSync(path.join(resources, 'default_app.asar')) ? `${fs.statSync(path.join(resources, 'default_app.asar')).size} bytes` : 'absent'}`,
    `skills       ${listDir(path.join(resources, 'skills')).join(', ') || 'MISSING'}`,
    `sidecars     ${listDir(path.join(resources, 'sidecars')).join(', ') || 'MISSING'}`,
    `processes    ${processCount(EXECUTABLE_NAME)} running (the NSIS installer starts the app)`,
  ])

  step('2/5 launch with an isolated --prw-user-data-dir profile')
  killApp()
  const exe = path.join(installDir, EXECUTABLE_NAME)
  const child = spawn(exe, [`--prw-user-data-dir=${profileDir}`], { cwd: installDir, detached: true, stdio: 'ignore' })
  child.unref()
  waitFor('the isolated profile database', () => fs.existsSync(dbPath), 120_000)
  if (!fs.existsSync(dbPath)) fail(`no database in ${profileDir}; the profile flag may have been ignored`)
  evidence('first run (isolated profile)', [
    `profile      ${listDir(profileDir).join(', ')}`,
    ...sqliteEvidence(dbPath),
  ])

  step('3/5 stop the application')
  const leftover = killApp()
  log(leftover === 0 ? `  all ${EXECUTABLE_NAME} processes stopped` : `  ${leftover} process(es) still running`)

  if (flag('keep')) {
    step('4/5 uninstall skipped (--keep)')
  } else {
    step('4/5 silent uninstall')
    const uninstaller = findUninstaller(installDir)
    if (!uninstaller) fail('no uninstaller in the install directory')
    const result = run(uninstaller, ['/S'], { cwd: installDir })
    log(`  exit code ${result.code}`)
    if (result.code !== 0) warn('the uninstaller reported a non-zero exit code')
    waitFor('the uninstaller to finish', () => !fs.existsSync(path.join(installDir, EXECUTABLE_NAME)), 180_000)
    const remaining = listDir(installDir)
    evidence('uninstall', [
      `exit code    ${result.code}`,
      `remaining    ${remaining.length} entries${remaining.length ? `: ${remaining.join(', ')}` : ''}`,
      ...shortcutState(),
      registryState(),
    ])
    if (remaining.length > 0) {
      warn('leftovers are usually the transient .asar lock; retry the deletion later and do not report it as an app defect')
    }
  }

  step('5/5 summary')
  log(`  install dir   ${removable(installDir) ? 'cleared' : 'still present'}`)
  log(`  profile dir   ${removable(profileDir) ? 'cleared' : 'still present'}`)
  log('  record only the steps that ran; signing, auto-update and packaged UI regression are still unverified')
}

// ----------------------------------------------------------------- publish

function cmdPublish() {
  const dryRun = flag('dry-run')
  const version = option('version') ?? currentVersion()
  const tag = `v${version}`
  const notes = path.resolve(option('notes-file') ?? path.join(CHANGELOG_DIR, `v${version}.md`))

  step(`publish ${tag}`)
  if (!fs.existsSync(notes)) fail(`no release notes at ${notes}; write docs/changelog/${tag}.md first`)
  const stale = versionPackageFiles().filter((file) => readJson(file).version !== version)
  if (stale.length > 0) {
    fail(`version mismatch: ${stale.map((file) => `${path.relative(REPO, file)}=${readJson(file).version}`).join(', ')}`)
  }
  const dirty = git(['status', '--porcelain']).out.trim()
  if (dirty && !flag('allow-dirty')) {
    fail(`working tree is dirty; commit it first (or pass --allow-dirty, discouraged):\n${dirty}`)
  }
  if (dirty) warn(`--allow-dirty: publishing with ${dirty.split('\n').length} uncommitted path(s)`)

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out.trim()
  const unpushed = git(['rev-list', '--count', `origin/${branch}..HEAD`]).out.trim()
  if (unpushed !== '0') fail(`${unpushed} commit(s) are not on origin/${branch}; push the branch before publishing`)
  if (git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).code === 0) fail(`tag ${tag} already exists locally`)
  if (run('git', ['ls-remote', '--tags', 'origin', tag]).out.trim()) fail(`tag ${tag} already exists on origin`)
  if (run('gh', ['release', 'view', tag]).code === 0) fail(`GitHub release ${tag} already exists`)
  if (fs.existsSync(path.join(REPO, '.github', 'workflows'))) {
    warn('CI workflows exist: check that they will not publish a second artifact for this tag')
  }

  const installer = findInstaller(version)
  const assets = [installer, `${installer}.blockmap`].filter((file) => fs.existsSync(file))
  const sig = authenticode(installer)
  if (sig.status !== 'Valid') {
    warn(`the installer signature is ${sig.status}; the release notes must say the build is unsigned`)
  }
  const body = fs.readFileSync(notes, 'utf8')
  for (const match of body.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)) {
    warn(`the notes contain the relative link "${match[1]}", which does not resolve on the release page`)
  }

  evidence('publish plan', [
    `branch    ${branch} (in sync with origin/${branch})`,
    `tag       ${tag} (does not exist yet)`,
    `notes     ${path.relative(REPO, notes)}`,
    `installer ${path.basename(installer)} ${fs.statSync(installer).size} bytes ${sig.status}`,
    `sha256    ${hashFile(installer)}`,
    `assets    ${assets.map((file) => path.basename(file)).join(', ')}`,
    `commands  git tag -a ${tag} -m "${PRODUCT_NAME} ${version}"`,
    `          git push origin ${tag}`,
    `          gh release create ${tag} --title "${PRODUCT_NAME} ${version}" --notes-file ${path.relative(REPO, notes)} <assets>`,
  ])
  if (dryRun) {
    log('\n  dry-run: nothing tagged, pushed or published')
    return
  }
  if (!flag('yes')) fail('publishing needs explicit consent: re-run with --yes')

  mustRun('git', ['tag', '-a', tag, '-m', `${PRODUCT_NAME} ${version}`])
  mustRun('git', ['push', 'origin', tag])
  const created = run('gh', [
    'release',
    'create',
    tag,
    '--title',
    `${PRODUCT_NAME} ${version}`,
    '--notes-file',
    notes,
    ...assets,
  ])
  if (created.code !== 0) {
    printTail(created.out, 20)
    fail(`gh release create failed for ${tag}; the tag is pushed, re-run only the release step`)
  }
  const view = mustRun('gh', ['release', 'view', tag, '--json', 'url,tagName,isDraft,isPrerelease,createdAt,assets'])
  let parsed = null
  try {
    parsed = JSON.parse(view)
  } catch {
    warn('could not parse gh release view output')
  }
  evidence('published release', [
    `url        ${parsed?.url ?? view.trim().split('\n')[0]}`,
    `tag        ${parsed?.tagName ?? tag} draft=${parsed?.isDraft} prerelease=${parsed?.isPrerelease} created=${parsed?.createdAt}`,
    ...(parsed?.assets ?? []).map((asset) => `asset      ${asset.name} ${asset.size} bytes state=${asset.state}`),
    'still unverified: signing, auto-update, packaged-app UI regression, external services',
  ])
}

// -------------------------------------------------------------------- help

function cmdHelp() {
  log(`windows-release — Personal Research Workbench Windows release engine

Usage: node .agents/skills/windows-release/scripts/release.mjs <command> [options]

Commands
  status                     versions, git state, releases, artifacts (read-only)
  version <x.y.z>            write the version into every package + MCP identity
  version --check            fail when the version files disagree
  build                      pnpm typecheck + build, then electron-builder NSIS x64
  verify                     installer identity + packaged skills/sidecars
  smoke                      install, launch (isolated profile), DB evidence, uninstall
  publish --version <x.y.z>  tag, push the tag, create the GitHub release

Options
  --dry-run          print the plan without writing, tagging or publishing
  --out <dir>        build output directory (default release-<version>/build)
  --electron-dist <dir>  use a pre-extracted Electron dist (skips the .asar lock)
  --force-electron-dist  skip the default electron-builder attempt
  --skip-gate        skip pnpm typecheck/build (assumes an earlier pass)
  --setup <exe>      smoke an existing installer instead of the current build
  --install <dir>    --profile <dir>  space-free smoke directories
  --keep             keep the smoke installation (skip uninstall)
  --notes-file <path>  release notes (default docs/changelog/v<version>.md)
  --yes              required acknowledgement for publish
  --allow-dirty      publish with uncommitted changes (discouraged)

Exit codes: 0 success, 1 failure (the failing step is printed with [fail]).
`)
}

switch (command) {
  case 'status':
    cmdStatus()
    break
  case 'version':
    cmdVersion()
    break
  case 'build':
    cmdBuild()
    break
  case 'verify':
    cmdVerify()
    break
  case 'smoke':
    cmdSmoke()
    break
  case 'publish':
    cmdPublish()
    break
  case 'help':
  case '--help':
    cmdHelp()
    break
  default:
    cmdHelp()
    fail(`unknown command "${command}"`)
}
