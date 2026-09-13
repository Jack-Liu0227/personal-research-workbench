#!/usr/bin/env node
/*
 * last30days skill verification.
 *
 * Three layers, in increasing cost:
 *   1. resolution unit checks  — the real `skill-registry.ts` is bundled with
 *      esbuild and driven through fake probes, so every failure branch
 *      (unknown key, missing SKILL.md, missing engine, missing/old Python) is
 *      exercised without touching the filesystem or a real interpreter.
 *   2. engine CLI checks       — the real vendored python engine answers
 *      `--help` and `--preflight` from an isolated directory.
 *   3. real keyless run        — `--network` only. Runs the engine for real
 *      (never `--mock`) with the same credential-free environment the app
 *      hands to an agent CLI, and asserts the badge/footer contract.
 *
 * Usage:
 *   node scripts/last30days-skill-smoke.cjs              # layers 1-2
 *   node scripts/last30days-skill-smoke.cjs --network     # layers 1-3
 *   node scripts/last30days-skill-smoke.cjs --json         # machine-readable
 *
 * Exit code 0 means every executed check passed. A layer that cannot run
 * (no python on this machine, engine missing) is reported as BLOCKED and exits
 * non-zero, because a silent skip would read as "verified".
 */
'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const APP_ROOT = path.resolve(__dirname, '..')
const SKILL_ROOT = path.join(APP_ROOT, '.agents', 'skills', 'last30days')
const ENGINE = path.join(SKILL_ROOT, 'skills', 'last30days', 'scripts', 'last30days.py')
const SKILL_FILE = path.join(SKILL_ROOT, 'skills', 'last30days', 'SKILL.md')
const args = new Set(process.argv.slice(2))
const wantNetwork = args.has('--network')
const asJson = args.has('--json')
const packagedFlag = process.argv.slice(2).find((value) => value.startsWith('--packaged='))
const packagedResources = packagedFlag ? path.resolve(packagedFlag.slice('--packaged='.length)) : null

const results = []
let blocked = 0

function record(name, status, detail) {
  results.push({ name, status, detail })
  if (status === 'BLOCKED') blocked += 1
  if (!asJson) {
    const badge = status === 'PASS' ? 'PASS' : status === 'BLOCKED' ? 'BLOCKED' : status
    console.log(`[${badge}] ${name}${detail ? `\n        ${String(detail).split('\n').join('\n        ')}` : ''}`)
  }
}

function check(name, fn) {
  try {
    const detail = fn()
    record(name, 'PASS', detail)
    return true
  } catch (error) {
    record(name, 'FAIL', error instanceof Error ? error.message : String(error))
    return false
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `prw-${label}-`))
}

/**
 * The app forwards only this allowlist to an agent CLI. Reproducing it here
 * (rather than inheriting the shell) means the smoke run proves the engine
 * works *without* any ambient API key or proxy variable.
 */
function appLikeEnvironment(extra) {
  const allowed = [
    'Path', 'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE',
    'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'COMSPEC',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM'
  ]
  const env = {}
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return { ...env, ...(extra || {}) }
}

function assertNoCredentials(env) {
  const suspicious = Object.keys(env).filter((key) =>
    /(_API_KEY|API_KEY|_TOKEN|AUTH_TOKEN|CT0|SECRET|PASSWORD|COOKIE)/iu.test(key)
  )
  assert(suspicious.length === 0, `child environment leaks credentials: ${suspicious.join(', ')}`)
}

// ---------------------------------------------------------------------------
// Layer 1: resolution branches, driven through the real module.
// ---------------------------------------------------------------------------

/**
 * Load the real `skill-registry.ts` module through the repository's own jiti
 * loader (the same one the other focused test scripts use).
 *
 * The workspace packages are TypeScript sources with `.js` specifiers, so plain
 * `require` cannot load them; jiti maps those specifiers onto the `.ts` files
 * while still exercising the shipping module rather than a copy of its rules.
 */
function bundleSkillRegistry() {
  const { createJiti } = require('jiti')
  const jiti = createJiti(__filename)
  return jiti(path.join(APP_ROOT, 'packages', 'workspace-service', 'src', 'skill-registry.ts'))
}

function fakeProbe(overrides) {
  return {
    env: {},
    cwd: 'C:\\repo',
    platform: 'win32',
    exists: (candidate) => (overrides.existing || []).some((entry) => path.resolve(entry) === path.resolve(candidate)),
    listDirectory: () => [],
    probePython: overrides.probePython || (() => ({ available: false, version: null, detail: 'not found' })),
    ...(overrides.resourcesPath ? { resourcesPath: overrides.resourcesPath } : {})
  }
}

function runResolutionChecks(registry) {
  const skillFile = path.join('C:\\repo', '.agents', 'skills', 'last30days', 'skills', 'last30days', 'SKILL.md')
  const engineFile = path.join(path.dirname(skillFile), 'scripts', 'last30days.py')

  check('resolution: null/empty key selects no skill', () => {
    for (const value of [null, undefined, '', '   ']) {
      const resolved = registry.resolveAgentSkill(value, fakeProbe({}))
      assert(resolved.kind === 'none', `expected kind=none for ${JSON.stringify(value)}`)
    }
    return 'null, undefined, "", "   " -> kind=none'
  })

  check('resolution: ordinary workflow keys are rejected (never mis-injected)', () => {
    const resolved = registry.resolveAgentSkill('daily-digest', fakeProbe({ existing: [skillFile, engineFile] }))
    assert(resolved.kind === 'unsupported', 'unknown key must not resolve to the pinned skill')
    assert(resolved.diagnostic.code === 'SKILL_UNSUPPORTED', `unexpected code ${resolved.diagnostic.code}`)
    return `${resolved.diagnostic.code}: ${resolved.diagnostic.message}`
  })

  check('resolution: missing SKILL.md blocks with SKILL_MISSING', () => {
    const resolved = registry.resolveAgentSkill('last30days', fakeProbe({}))
    assert(resolved.kind === 'unsupported' && resolved.diagnostic.code === 'SKILL_MISSING', 'expected SKILL_MISSING')
    assert(/\.agents\\skills\\last30days/u.test(resolved.diagnostic.detail), 'detail must name the probed project path')
    assert(!/[A-Za-z]:\\/u.test(resolved.diagnostic.detail), 'detail must not leak an absolute path')
    return resolved.diagnostic.detail.split('\n').slice(0, 3).join(' | ')
  })

  check('resolution: incomplete skill (no engine script) blocks with SKILL_ENGINE_MISSING', () => {
    const resolved = registry.resolveAgentSkill('last30days', fakeProbe({ existing: [skillFile] }))
    assert(resolved.kind === 'unsupported' && resolved.diagnostic.code === 'SKILL_ENGINE_MISSING', 'expected SKILL_ENGINE_MISSING')
    return resolved.diagnostic.message
  })

  check('resolution: no usable interpreter blocks with SKILL_PYTHON_MISSING', () => {
    const resolved = registry.resolveAgentSkill('last30days', fakeProbe({
      existing: [skillFile, engineFile],
      probePython: () => ({ available: false, version: null, detail: 'spawn failed' })
    }))
    assert(resolved.kind === 'unsupported' && resolved.diagnostic.code === 'SKILL_PYTHON_MISSING', 'expected SKILL_PYTHON_MISSING')
    return resolved.diagnostic.message
  })

  check('resolution: python 3.11 blocks with SKILL_PYTHON_TOO_OLD', () => {
    const resolved = registry.resolveAgentSkill('last30days', fakeProbe({
      existing: [skillFile, engineFile],
      probePython: () => ({ available: false, version: '3.11.9', detail: '3.11.9 < 3.12' })
    }))
    assert(resolved.kind === 'unsupported' && resolved.diagnostic.code === 'SKILL_PYTHON_TOO_OLD', 'expected SKILL_PYTHON_TOO_OLD')
    return resolved.diagnostic.message
  })

  check('resolution: packaged resources path resolves when the repo checkout is absent', () => {
    const resources = 'C:\\Program Files\\Workbench\\resources'
    const packaged = path.join(resources, 'skills', 'last30days', 'skills', 'last30days', 'SKILL.md')
    const resolved = registry.resolveAgentSkill('last30days', fakeProbe({
      existing: [packaged, path.join(path.dirname(packaged), 'scripts', 'last30days.py')],
      resourcesPath: resources,
      probePython: () => ({ available: true, version: '3.13.5', detail: '3.13.5' })
    }))
    assert(resolved.kind === 'last30days', `expected resolved skill, got ${resolved.kind}`)
    assert(resolved.runtime.skillSource === 'packaged', `expected packaged source, got ${resolved.runtime.skillSource}`)
    assert(resolved.runtime.pythonSource === 'path', `unexpected python source ${resolved.runtime.pythonSource}`)
    return registry.describeLast30DaysRuntime(resolved.runtime, fakeProbe({ resourcesPath: resources }))
  })

  check('resolution: PRW_LAST30DAYS_SKILL_PATH override wins (e2e hook)', () => {
    const override = 'D:\\ci\\skills\\last30days\\SKILL.md'
    const resolved = registry.resolveAgentSkill('last30days', {
      ...fakeProbe({
        existing: [override, path.join(path.dirname(override), 'scripts', 'last30days.py')],
        probePython: () => ({ available: true, version: '3.12.10', detail: '3.12.10' })
      }),
      env: { PRW_LAST30DAYS_SKILL_PATH: override }
    })
    assert(resolved.kind === 'last30days' && resolved.runtime.skillSource === 'env', 'env override must win')
    assert(resolved.runtime.skillPath === override, 'override path must be used verbatim')
    return resolved.runtime.skillPath
  })

  // --- project-root discovery -------------------------------------------
  // The Core process runs with the workbench user-data directory as its
  // working directory, so discovery must not depend on `process.cwd()`.
  const repoRoot = path.join('C:\\', 'repo')
  const nestedCwd = path.join(repoRoot, 'apps', 'desktop', 'out', 'main')
  const repoSkillsRoot = path.join(repoRoot, '.agents', 'skills')
  const repoSkillFile = path.join(repoSkillsRoot, 'last30days', 'skills', 'last30days', 'SKILL.md')
  const repoProbe = (overrides) => ({
    env: {},
    cwd: nestedCwd,
    platform: 'win32',
    exists: (candidate) => [repoSkillsRoot, repoSkillFile]
      .some((entry) => path.resolve(entry) === path.resolve(candidate)),
    listDirectory: () => [],
    ...overrides
  })

  check('project root: a nested working directory walks up to the canonical .agents/skills', () => {
    const root = registry.resolveProjectRoot(repoProbe({}))
    assert(path.resolve(root) === path.resolve(repoRoot), `expected ${repoRoot}, got ${String(root)}`)
    return `${nestedCwd} -> ${root}`
  })

  check('project root: explicit anchors win over the working directory', () => {
    const other = path.join('D:\\', 'checkout')
    const root = registry.resolveProjectRoot({
      ...repoProbe({}),
      cwd: 'D:\\elsewhere',
      exists: (candidate) => path.resolve(candidate) === path.resolve(path.join(other, '.agents', 'skills')),
      projectRoot: other
    })
    assert(path.resolve(root) === path.resolve(other), `expected ${other}, got ${String(root)}`)
    const viaEnv = registry.resolveProjectRoot({
      ...repoProbe({}),
      cwd: 'D:\\elsewhere',
      env: { PRW_PROJECT_ROOT: other },
      exists: (candidate) => path.resolve(candidate) === path.resolve(path.join(other, '.agents', 'skills'))
    })
    assert(path.resolve(viaEnv) === path.resolve(other), `PRW_PROJECT_ROOT must be honoured, got ${String(viaEnv)}`)
    return `${other} via projectRoot and PRW_PROJECT_ROOT`
  })

  check('project root: an installed app never walks out of the package', () => {
    const packaged = registry.resolveProjectRoot(repoProbe({ packagedOnly: true }))
    assert(packaged === null, `expected null, got ${String(packaged)}`)
    const viaEnv = registry.resolveProjectRoot(repoProbe({ env: { PRW_PACKAGED_APP: '1' } }))
    assert(viaEnv === null, `PRW_PACKAGED_APP must disable the walk-up, got ${String(viaEnv)}`)
    return 'no checkout anchor -> packaged resources/skills mirror only'
  })

  check('catalog: an explicit project root makes every shipped skill runnable (no reserved key left)', () => {
    const catalog = registry.describeAgentSkillCatalog(repoProbe({ projectRoot: repoRoot }))
    const last30days = catalog.find((entry) => entry.key === 'last30days')
    assert(Boolean(last30days), 'last30days must be part of the frozen catalog')
    assert(last30days.skillFileFound === true, 'the canonical SKILL.md must be reported as found')
    assert(last30days.runnable === true && last30days.blockedReason === '', `expected runnable, got ${JSON.stringify(last30days)}`)
    assert(last30days.packagedSkillFileFound === false, 'a dev run must not claim a packaged mirror')
    // Task 07 promoted the two literature skills to shipped instruction-only
    // contracts, so no reserved key may remain; each shipped key must be
    // selectable *and* keep a meaningful blocked reason only when its file is
    // missing. `last30days` itself must stay runnable (no regression).
    const reserved = catalog.filter((entry) => entry.availability === 'reserved')
    assert(reserved.length === 0, `no key may stay reserved, got ${reserved.map((entry) => entry.key).join(', ')}`)
    // This probe's filesystem fake only knows the last30days tree, so the other
    // shipped keys must degrade to a *truthful* blocked reason (their canonical
    // file is genuinely invisible here) instead of a fake "installed" label.
    for (const entry of catalog) {
      if (entry.runnable) {
        assert(entry.blockedReason === '', `${entry.key} must carry no blocked reason when runnable`)
        continue
      }
      assert(entry.blockedReason.includes(`${entry.key}/SKILL.md`), `${entry.key} must name its canonical SKILL.md`)
      assert(entry.blockedReason.includes('SKILL_MISSING'), `${entry.key} must report SKILL_MISSING, got ${entry.blockedReason}`)
    }
    return `${last30days.key}: runnable=${String(last30days.runnable)}; keys=${catalog.map((entry) => `${entry.key}=${String(entry.runnable)}`).join(', ')}`
  })

  check('catalog: without a checkout the shipped skill is reported as not installed', () => {
    const catalog = registry.describeAgentSkillCatalog({ env: {}, cwd: path.join('C:\\', 'nope'), platform: 'win32', exists: () => false, listDirectory: () => [], packagedOnly: true })
    const last30days = catalog.find((entry) => entry.key === 'last30days')
    assert(last30days.runnable === false, 'no discovered SKILL.md must never look runnable')
    assert(/\.agents\\skills[/\\]last30days/u.test(last30days.blockedReason), `the reason must name the canonical path, got ${last30days.blockedReason}`)
    return last30days.blockedReason.slice(0, 120)
  })

  check('resolution: a configured-but-missing override blocks instead of silently using the checkout', () => {
    const resolved = registry.resolveAgentSkill('last30days', {
      ...repoProbe({ projectRoot: repoRoot }),
      env: { PRW_LAST30DAYS_SKILL_PATH: path.join('D:\\', 'gone', 'SKILL.md') },
      probePython: () => ({ available: true, version: '3.13.5', detail: '3.13.5' })
    })
    assert(resolved.kind === 'unsupported' && resolved.diagnostic.code === 'SKILL_MISSING', `expected SKILL_MISSING, got ${resolved.kind}`)
    assert(resolved.diagnostic.detail.includes('PRW_LAST30DAYS_SKILL_PATH'), 'the diagnostic must name the override')
    assert(resolved.diagnostic.detail.includes('项目路径'), 'the diagnostic must name the canonical project path')
    return resolved.diagnostic.detail.split('\n').filter(Boolean).slice(0, 3).join(' / ')
  })

  check('resolution: diagnostic paths never contain an absolute user path', () => {
    const samples = [
      registry.labelDiagnosticPath('C:\\Users\\someone\\AppData\\Local\\Temp\\x\\SKILL.md', fakeProbe({})),
      registry.labelDiagnosticPath('D:\\CodingProject\\Personal Workshop\\.agents\\skills\\last30days\\skills\\last30days\\SKILL.md', {
        ...fakeProbe({}),
        cwd: 'D:\\CodingProject\\Personal Workshop'
      })
    ]
    for (const sample of samples) {
      assert(!/[A-Za-z]:\\/u.test(sample), `leaked absolute path: ${sample}`)
      assert(!/\/(?:Users|home|tmp|var|opt|workspace)\//u.test(sample), `leaked posix absolute path: ${sample}`)
    }
    return samples.join(' | ')
  })

  check('prompt: skill briefing pins interpreter, isolated dir, engine flags and output contract', () => {
    const skillPath = path.join('C:\\repo', '.agents', 'skills', 'last30days', 'skills', 'last30days', 'SKILL.md')
    const enginePath = path.join(path.dirname(skillPath), 'scripts', 'last30days.py')
    const resolved = registry.resolveAgentSkill('last30days', fakeProbe({
      existing: [skillPath, enginePath],
      probePython: () => ({ available: true, version: '3.13.5', detail: '3.13.5' })
    }))
    assert(resolved.kind === 'last30days', 'skill must resolve')
    const briefing = registry.buildLast30DaysSkillBriefing({
      runtime: resolved.runtime,
      saveDir: 'C:\\runs\\run-1\\skill-output',
      topic: 'local first research workbench "quoted"'
    })
    for (const expected of [
      JSON.stringify(enginePath),
      JSON.stringify(resolved.runtime.skillPath),
      '--emit=compact',
      '--auto-resolve',
      '--no-browser-cookies',
      '--save-suffix=v3',
      JSON.stringify('C:\\runs\\run-1\\skill-output'),
      'PASS-THROUGH FOOTER',
      '--mock',
      '简体中文'
    ]) {
      assert(briefing.includes(expected), `briefing is missing ${expected}`)
    }
    const commandLine = briefing.split('\n').find((line) => line.includes('--emit=compact')) || ''
    assert(commandLine.trimStart().startsWith('"'), `engine command line not found in briefing`)
    assert(commandLine.includes('--save-dir='), 'the isolated save dir must be part of the command')
    return `${briefing.length} chars, engine command on one line: ${commandLine.trim().slice(0, 120)}...`
  })

  check('resolution: real repository checkout resolves with a supported interpreter', () => {
    const resolved = registry.resolveAgentSkill('last30days')
    if (resolved.kind !== 'last30days') {
      throw new Error(`${resolved.diagnostic.code}: ${resolved.diagnostic.message}`)
    }
    const [major, minor] = resolved.runtime.pythonVersion.split('.').map((part) => Number.parseInt(part, 10))
    assert(major > 3 || (major === 3 && minor >= 12), `python too old: ${resolved.runtime.pythonVersion}`)
    assert(fs.existsSync(resolved.runtime.skillPath), 'resolved SKILL.md must exist')
    assert(fs.existsSync(resolved.runtime.enginePath), 'resolved engine must exist')
    return `${resolved.runtime.pythonPath} (${resolved.runtime.pythonVersion}, ${resolved.runtime.pythonSource}), skill from ${resolved.runtime.skillSource}`
  })

  if (packagedResources) {
    check('packaged layout: resources/skills resolves without the repo checkout', () => {
      // `cwd` points at a directory that does not exist, so the only path that
      // can resolve is the packaged one; the real filesystem and the real
      // interpreter probe are used, not fakes.
      const resolved = registry.resolveAgentSkill('last30days', {
        cwd: path.join(os.tmpdir(), 'prw-no-repo-checkout'),
        resourcesPath: packagedResources,
        env: appLikeEnvironment()
      })
      if (resolved.kind !== 'last30days') {
        throw new Error(`${resolved.diagnostic.code}: ${resolved.diagnostic.message}`)
      }
      assert(resolved.runtime.skillSource === 'packaged', `expected packaged source, got ${resolved.runtime.skillSource}`)
      assert(fs.existsSync(resolved.runtime.skillPath), 'packaged SKILL.md must exist')
      assert(fs.existsSync(resolved.runtime.enginePath), 'packaged engine must exist')
      assert(fs.existsSync(path.join(path.dirname(resolved.runtime.enginePath), 'lib')), 'packaged engine libraries must exist')
      assert(fs.existsSync(path.join(resolved.runtime.skillDir, 'references')), 'packaged references must exist')
      return `${resolved.runtime.skillPath}\n        python: ${resolved.runtime.pythonPath} (${resolved.runtime.pythonVersion})`
    })
  } else {
    record('packaged layout: resources/skills resolves without the repo checkout', 'SKIP', 'pass --packaged=<dir>/resources to verify a built win-unpacked tree')
  }
}

// ---------------------------------------------------------------------------
// Layer 2/3: real engine invocations.
// ---------------------------------------------------------------------------

function resolvePython() {
  const registry = bundleSkillRegistry()
  const resolved = registry.resolveAgentSkill('last30days')
  assert(resolved.kind === 'last30days', 'cannot probe the engine without a resolved skill')
  return resolved.runtime.pythonPath
}

function runEngine(pythonPath, enginePath, engineArgs, options) {
  const env = appLikeEnvironment(options.env)
  assertNoCredentials(env)
  const started = Date.now()
  const result = spawnSync(pythonPath, [enginePath, ...engineArgs], {
    cwd: options.cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs || 120_000,
    maxBuffer: 32 * 1024 * 1024
  })
  return {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    durationMs: Date.now() - started
  }
}

function runEngineChecks(pythonPath) {
  check('engine: --help exits 0 and documents the compact contract', () => {
    const out = runEngine(pythonPath, ENGINE, ['--help'], { cwd: tempDir('help'), timeoutMs: 60_000 })
    assert(out.status === 0, `exit ${out.status}: ${out.stderr.slice(0, 300)}`)
    assert(out.stdout.includes('--emit'), 'help must document --emit')
    assert(out.stdout.includes('--preflight'), 'help must document --preflight')
    return `exit 0 in ${out.durationMs} ms`
  })

  check('engine: --preflight is safe, keyless and non-blocking on missing optional tools', () => {
    const saveDir = tempDir('preflight')
    const out = runEngine(pythonPath, ENGINE, ['--preflight', `--save-dir=${saveDir}`], { cwd: saveDir, timeoutMs: 120_000 })
    assert(out.status === 0, `preflight must not fail on missing optional dependencies: exit ${out.status}`)
    assert(/Status:/u.test(out.stdout), 'preflight must print a status line')
    const files = fs.readdirSync(saveDir)
    assert(files.length === 0, `--preflight wrote files: ${files.join(', ')}`)
    const statusLine = out.stdout.split('\n').find((line) => /Status:/u.test(line)) || ''
    const missing = /Missing:/u.test(`${out.stdout}\n${out.stderr}`) ? 'reports missing optional sources' : 'no missing optional sources'
    return `${statusLine.trim()} | ${missing} | ${out.durationMs} ms`
  })

  check('engine: a missing engine path fails loudly instead of silently succeeding', () => {
    const saveDir = tempDir('missing-engine')
    const out = runEngine(pythonPath, path.join(saveDir, 'does-not-exist.py'), ['--preflight'], { cwd: saveDir, timeoutMs: 30_000 })
    assert(out.status !== 0, 'python must exit non-zero for a missing script')
    return `exit ${out.status}`
  })
}

function runNetworkCheck(pythonPath, registry) {
  const resolved = registry.resolveAgentSkill('last30days')
  assert(resolved.kind === 'last30days', 'skill must resolve before a real run')
  const saveDir = tempDir('network')
  const engineArgs = [
    'local-first research workbench',
    '--emit=compact',
    '--auto-resolve',
    '--quick',
    '--no-browser-cookies',
    `--save-dir=${saveDir}`,
    '--save-suffix=v3'
  ]
  const out = runEngine(pythonPath, resolved.runtime.enginePath, engineArgs, {
    cwd: saveDir,
    env: { LAST30DAYS_MEMORY_DIR: saveDir, LAST30DAYS_PYTHON: resolved.runtime.pythonPath },
    timeoutMs: 300_000
  })
  const lines = out.stdout.split(/\r?\n/u)
  const badge = lines[0] || ''
  const footerStart = lines.findIndex((line) => /PASS-THROUGH FOOTER/u.test(line))
  const footer = out.stdout.includes('✅ All agents reported back!')
  const partial = out.stdout.includes('## Partial Coverage')
  const sourceLine = lines.find((line) => /^- Sources:/u.test(line)) || ''
  const failures = out.stdout.split(/\r?\n/u).filter((line) => /unreachable/u.test(line)).slice(0, 3)
  const saved = fs.readdirSync(saveDir)
  const detail = [
    `badge: ${badge}`,
    `${sourceLine.replace(/^-\s*/u, '')}`,
    `footer: ${footer ? 'present' : 'MISSING'}; partial-coverage section: ${partial ? 'present' : 'absent'}; footer block at line ${footerStart >= 0 ? footerStart + 1 : 'n/a'}`,
    `unreachable sources: ${failures.length === 0 ? 'none' : failures.map((line) => line.replace(/^-\s*/u, '').slice(0, 120)).join(' ; ')}`,
    `save dir files: ${saved.length === 0 ? 'none' : saved.join(', ')}`,
    `duration ${out.durationMs} ms, exit ${out.status}`
  ].join('\n')
  check('engine: real keyless run (no --mock) keeps the badge/footer contract', () => {
    assert(out.status === 0, `exit ${out.status}: ${out.stderr.slice(0, 400)}`)
    assert(/^🌐 last30days v\d+\.\d+\.\d+/u.test(badge), `badge missing on line 1: ${badge.slice(0, 120)}`)
    assert(footer, 'PASS-THROUGH FOOTER ("✅ All agents reported back!") was not emitted')
    assert(!/--mock/u.test(engineArgs.join(' ')), 'mock must never be used for the recorded run')
    assert(saved.length > 0, 'the engine did not write its raw evidence into the isolated save dir')
    return detail
  })
  // A run with zero reachable sources is still a real result, but it must be
  // reported as partial rather than presented as a complete success.
  check('engine: empty source coverage is reported as partial, never as success', () => {
    const noSources = /^-\s*Sources:\s*none\s*$/u.test(sourceLine)
    assert(!noSources || partial, 'a run with no reachable source must report Partial Coverage')
    return noSources ? 'Sources: none -> Partial Coverage present' : sourceLine.replace(/^-\s*/u, '')
  })
  return detail
}

function main() {
  const registry = bundleSkillRegistry()

  console.log('# last30days skill verification')
  console.log(`engine: ${ENGINE}`)
  console.log(`skill:  ${SKILL_FILE}`)
  console.log(`network run: ${wantNetwork ? 'enabled (real, no --mock)' : 'skipped (pass --network to run it)'}`)
  console.log(`packaged resources: ${packagedResources ?? 'not provided'}`)
  console.log('')

  runResolutionChecks(registry)

  let pythonPath = null
  try {
    pythonPath = resolvePython()
  } catch (error) {
    record('engine: locate python interpreter', 'BLOCKED', error instanceof Error ? error.message : String(error))
  }
  if (pythonPath) {
    runEngineChecks(pythonPath)
    if (wantNetwork) runNetworkCheck(pythonPath, registry)
    else record('engine: real keyless run', 'SKIP', 'not requested; re-run with --network (mock runs are never substituted)')
  }

  const passed = results.filter((entry) => entry.status === 'PASS').length
  const failed = results.filter((entry) => entry.status === 'FAIL').length
  const skipped = results.filter((entry) => entry.status === 'SKIP').length
  if (asJson) {
    console.log(JSON.stringify({ passed, failed, blocked, skipped, results }, null, 2))
  } else {
    console.log('')
    console.log(`summary: ${passed} passed, ${failed} failed, ${blocked} blocked, ${skipped} skipped`)
  }
  process.exitCode = failed > 0 || blocked > 0 ? 1 : 0
}

main()
