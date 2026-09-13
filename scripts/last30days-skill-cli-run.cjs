#!/usr/bin/env node
/*
 * Real last30days CLI run (opt-in, costs model tokens).
 *
 * This is the "no mock" half of the skill verification: it starts a real
 * Codex/Pi process with the *same* command line, working directory, and
 * credential-free environment the desktop app uses for a pinned-skill run, and
 * feeds it the briefing that `packages/workspace-service/src/skill-registry.ts`
 * builds. It then checks the artefact contract (badge on line 1, PASS-THROUGH
 * FOOTER present, raw evidence written into the isolated output directory).
 *
 * The command lines below are the ones produced by
 * `CodexRuntimeAdapter.command()` / `PiRuntimeAdapter.command()` in
 * `packages/agent-runtime/src/index.ts` for `skillExecution` runs, and the
 * environment allowlist mirrors `safeChildEnvironment()` there. Keep them in
 * sync; the assertions fail loudly if the CLI rejects a flag.
 *
 * Usage:
 *   node scripts/last30days-skill-cli-run.cjs --runtime=codex [--model=<id>]
 *   node scripts/last30days-skill-cli-run.cjs --runtime=pi --model=<id>
 *   node scripts/last30days-skill-cli-run.cjs --dry-run            # print argv + prompt only
 *   node scripts/last30days-skill-cli-run.cjs --replay=<run dir>   # re-check a recorded run
 *
 * Exit code is non-zero when any contract check fails, so a recorded run can be
 * re-verified later (`--replay`) without spending model tokens again.
 *
 * Never reads credentials: the child environment is an allowlist, and the
 * briefing forbids cookie extraction and key printing.
 */
'use strict'

const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const APP_ROOT = path.resolve(__dirname, '..')
const options = Object.fromEntries(
  process.argv.slice(2).map((value) => {
    const [key, ...rest] = value.replace(/^--/u, '').split('=')
    return [key, rest.join('=') || 'true']
  })
)
const runtime = options.runtime === 'pi' ? 'pi' : 'codex'
const model = options.model && options.model !== 'true' ? options.model : null
const topic = options.topic && options.topic !== 'true' ? options.topic : 'local-first research workbench'
const timeoutMs = Number.parseInt(options.timeout || '900000', 10)

const results = []
function assert(condition, message) {
  if (!condition) throw new Error(message)
}
function record(name, status, detail) {
  results.push({ name, status, detail })
  console.log(`[${status}] ${name}${detail ? `\n        ${String(detail).split('\n').join('\n        ')}` : ''}`)
}
function check(name, fn) {
  try {
    record(name, 'PASS', fn())
    return true
  } catch (error) {
    record(name, 'FAIL', error instanceof Error ? error.message : String(error))
    return false
  }
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `prw-${label}-`))
}

/** Mirrors `safeChildEnvironment()` in @prw/agent-runtime. */
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
  // The app forwards the model profile dir explicitly so the CLI reuses the
  // user's own login; the smoke run does the same and never reads its tokens.
  if (runtime === 'codex' && process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME
  if (runtime === 'pi' && process.env.PI_CODING_AGENT_DIR) env.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR
  return { ...env, ...(extra || {}) }
}

function loadSkillRegistry() {
  const outDir = tempDir('skill-registry-build')
  const tsc = path.join(APP_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  const result = spawnSync(process.execPath, [
    tsc, '--skipLibCheck', '--target', 'es2023', '--module', 'commonjs', '--types', 'node',
    '--outDir', outDir,
    path.join(APP_ROOT, 'packages', 'workspace-service', 'src', 'skill-registry.ts')
  ], { cwd: APP_ROOT, encoding: 'utf8', windowsHide: true, timeout: 300_000 })
  const compiled = path.join(outDir, 'skill-registry.js')
  assert(result.status === 0 && fs.existsSync(compiled), `tsc failed: ${String(result.stdout || '')}${String(result.stderr || '')}`.slice(0, 600))
  return require(compiled)
}

function buildPrompt(registry, runtimeInfo, saveDir) {
  const briefing = registry.buildLast30DaysSkillBriefing({ runtime: runtimeInfo, saveDir, topic })
  // Mirrors `buildScheduleInstructions()` for a last30days schedule.
  const scheduleLines = [
    'Run the project-pinned last30days skill for all available sources from the latest 30 days.',
    'Language/output rule: write all user-readable narrative, summaries, analysis, section descriptions, and key points in Simplified Chinese (简体中文).',
    'Preserve source names, proper nouns, original URLs, necessary English titles, verbatim community quotes, the skill-required badge, citation/footer, and pass-through contract exactly as evidence. Do not translate or post-process the engine footer, do not add a separate Sources link dump, and do not expose tool execution logs in the article body.',
    `Topic: ${topic}`,
    `Scheduled research run: last30days 每日文献推送（${topic}）`
  ]
  return [briefing, '', '---', '', scheduleLines.join('\n\n')].join('\n')
}

function codexArgs(runDir) {
  const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--cd', runDir]
  if (model) args.push('--model', model)
  // skillExecution => workspace-write via --approve-for-me plus network access.
  args.push('--approve-for-me', '--config', 'sandbox_workspace_write.network_access=true')
  return args
}

function piArgs(runtimeInfo) {
  const args = ['-p', '--mode', 'json', '--no-session']
  if (model) args.push('--model', model)
  args.push('--skill', runtimeInfo.skillPath, '--approve', '--tools', 'read,grep,find,ls,bash,write')
  return args
}

function resolveCliCommand(name) {
  const fallback = { command: name, args: [], detail: `${name} (PATH)` }
  if (process.platform !== 'win32') return fallback
  const where = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true, timeout: 4_000 })
  const lines = String(where.stdout || '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  const entryRelative = name === 'codex'
    ? ['node_modules', '@openai', 'codex', 'bin', 'codex.js']
    : name === 'pi'
      ? ['node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js']
      : null
  if (!entryRelative) return fallback
  for (const line of lines) {
    const entry = path.join(path.dirname(line), ...entryRelative)
    if (!fs.existsSync(entry)) continue
    const nodeExe = path.join(path.dirname(line), 'node.exe')
    const interpreter = fs.existsSync(nodeExe) ? nodeExe : process.execPath
    return { command: interpreter, args: [entry], detail: `${interpreter} ${entry}` }
  }
  return { command: lines[0] || name, args: [], detail: `${lines[0] || name} (shim)` }
}

/**
 * Extract only the assistant messages, so engine stdout echoed by the CLI's
 * tool events is never mistaken for the model answer.
 */
function extractAgentMessages(events) {
  const messages = []
  for (const event of events) {
    const item = event && event.item
    if (event && event.type === 'item.completed' && item && item.type === 'agent_message' && typeof item.text === 'string') {
      messages.push(item.text)
      continue
    }
    if (event && typeof event.type === 'string' && /agent_message|assistant$|^message$/u.test(event.type) && typeof event.text === 'string') {
      messages.push(event.text)
    }
  }
  return messages
}

/** Every shell command the agent ran, so the engine call can be audited. */
function collectEngineCommands(events) {
  const commands = []
  for (const event of events) {
    const item = event && event.item
    if (item && typeof item.command === 'string' && item.command.includes('last30days.py')) commands.push(item.command)
  }
  return commands
}

function collectText(payload, depth = 0) {
  if (typeof payload === 'string') return payload
  if (!payload || typeof payload !== 'object' || depth > 6) return ''
  if (Array.isArray(payload)) return payload.map((entry) => collectText(entry, depth + 1)).filter(Boolean).join('\n')
  const value = payload
  const preferred = ['text', 'content', 'message', 'delta', 'output_text']
  const parts = []
  for (const key of preferred) {
    if (typeof value[key] === 'string' && value[key].length > 0) parts.push(value[key])
  }
  if (parts.length > 0) return parts.join('\n')
  return Object.values(value).map((entry) => collectText(entry, depth + 1)).filter(Boolean).join('\n')
}

async function runCli(command, args, cwd, env, prompt, timeout) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`CLI timed out after ${timeout} ms`))
    }, timeout)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    child.stdin.end(prompt, 'utf8')
  })
}

async function main() {
  const registry = loadSkillRegistry()
  const resolved = registry.resolveAgentSkill('last30days')
  if (resolved.kind !== 'last30days') {
    record('skill resolution', 'BLOCKED', `${resolved.diagnostic.code}: ${resolved.diagnostic.message}`)
    process.exitCode = 1
    return
  }
  const runtimeInfo = resolved.runtime
  const replayDir = options.replay && options.replay !== 'true' ? path.resolve(options.replay) : null
  const runDir = replayDir ?? tempDir(`cli-run-${runtime}`)
  const saveDir = path.join(runDir, 'skill-output')
  if (!replayDir) fs.mkdirSync(saveDir, { recursive: true })
  const prompt = buildPrompt(registry, runtimeInfo, saveDir)
  if (!replayDir) fs.writeFileSync(path.join(runDir, 'input.txt'), prompt, 'utf8')

  console.log(`runtime:  ${runtime}${model ? ` (model ${model})` : ''}`)
  console.log(`python:   ${runtimeInfo.pythonPath} (${runtimeInfo.pythonVersion}, ${runtimeInfo.pythonSource})`)
  console.log(`skill:    ${runtimeInfo.skillPath}`)
  console.log(`run dir:  ${runDir}`)
  console.log(`prompt:   ${prompt.length} chars`)
  console.log('')

  const cli = resolveCliCommand(runtime)
  const args = runtime === 'codex' ? codexArgs(runDir) : piArgs(runtimeInfo)
  const commandArgs = [...cli.args, ...args]
  const env = appLikeEnvironment({
    LAST30DAYS_MEMORY_DIR: saveDir,
    LAST30DAYS_PYTHON: runtimeInfo.pythonPath
  })
  if (options['dry-run'] === 'true') {
    console.log(`cli:      ${cli.detail}`)
    console.log(`argv:     ${commandArgs.join(' ')}   (prompt on stdin)`)
    console.log(`env keys: ${Object.keys(env).sort().join(', ')}`)
    console.log('--- prompt ---')
    console.log(prompt)
    return
  }
  const started = Date.now()
  const result = replayDir
    ? {
        code: 0,
        stdout: fs.readFileSync(path.join(replayDir, 'stdout.jsonl'), 'utf8'),
        stderr: fs.existsSync(path.join(replayDir, 'stderr.txt')) ? fs.readFileSync(path.join(replayDir, 'stderr.txt'), 'utf8') : ''
      }
    : await runCli(cli.command, commandArgs, runDir, env, prompt, timeoutMs)
  const durationMs = replayDir ? 0 : Date.now() - started
  if (!replayDir) {
    fs.writeFileSync(path.join(runDir, 'stdout.jsonl'), result.stdout, 'utf8')
    fs.writeFileSync(path.join(runDir, 'stderr.txt'), result.stderr, 'utf8')
  }

  const jsonLines = result.stdout.split(/\r?\n/u).filter((line) => line.trim().startsWith('{'))
  const events = []
  for (const line of jsonLines) {
    try {
      events.push(JSON.parse(line))
    } catch {
      /* non-JSON diagnostics stay in stdout.jsonl */
    }
  }
  const agentMessages = extractAgentMessages(events)
  const answer = agentMessages.length > 0
    ? agentMessages[agentMessages.length - 1]
    : events.map((event) => collectText(event)).filter(Boolean).join('\n\n')
  const answerLines = answer.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  const badgeLine = answerLines.find((line) => /^🌐 last30days v\d+\.\d+\.\d+/u.test(line)) || ''
  const engineCommands = collectEngineCommands(events)
  const savedFiles = fs.existsSync(saveDir) ? fs.readdirSync(saveDir) : []

  check(`cli: ${runtime} exits 0 for a pinned-skill run`, () => {
    assert(result.code === 0, `exit ${result.code}; stderr tail: ${result.stderr.slice(-400)}`)
    return `${replayDir ? 'replayed' : `exit 0 in ${durationMs} ms`} (${jsonLines.length} JSON events, ${agentMessages.length} agent messages)`
  })
  check('cli: the engine was called with the pinned flags, never --mock', () => {
    assert(engineCommands.length > 0, 'the agent never invoked last30days.py — the skill was skipped')
    // Windows paths appear as `C:/x`, `C:\\x` or `C:\\\\x` depending on how the
    // CLI wrapped the command; collapse to a single separator before comparing.
    const sep = String.fromCharCode(92)
    const normalize = (value) => value
      .replace(/"/gu, '')
      .split('/').join(sep)
      .split(sep + sep).join(sep)
      .split(sep + sep).join(sep)
    const runs = engineCommands.filter((command) => command.includes('--save-dir='))
    assert(runs.length > 0, `the agent read the engine but never ran it: ${engineCommands[0].slice(0, 200)}`)
    const pinned = runs.find((command) =>
      ['--emit=compact', '--auto-resolve', '--no-browser-cookies', '--save-suffix=v3'].every((flag) => command.includes(flag))
    )
    assert(Boolean(pinned), `no engine run used the pinned flags; last run: ${runs[runs.length - 1].slice(-300)}`)
    assert(!/--mock/u.test(pinned), `the agent used --mock: ${pinned.slice(-200)}`)
    assert(
      normalize(pinned).includes(normalize(saveDir)),
      `engine run did not write into the isolated run dir: ${pinned.slice(-300)}`
    )
    return `${engineCommands.length} engine mention(s), ${runs.length} run(s); pinned run wrote into the isolated run dir`
  })
  check('cli: engine wrote isolated evidence', () => {
    assert(savedFiles.length > 0, `no evidence written to ${saveDir}; stderr tail: ${result.stderr.slice(-300)}`)
    const raw = savedFiles.find((file) => file.endsWith('.md'))
    assert(Boolean(raw), `no raw markdown in save dir: ${savedFiles.join(', ')}`)
    return savedFiles.join(', ')
  })
  check('cli: the answer is the article, badge first, footer verbatim', () => {
    assert(badgeLine.length > 0, `badge missing from the model answer (first 200 chars: ${answer.slice(0, 200)})`)
    assert(answerLines[0] === badgeLine, `the badge is not the first line of the article: ${answerLines.slice(0, 2).join(' | ')}`)
    assert(answer.includes('✅ All agents reported back!'), 'PASS-THROUGH FOOTER missing from the model answer')
    assert(!/EVIDENCE FOR SYNTHESIS/u.test(answer), 'the model dumped the raw evidence block instead of synthesizing')
    assert(!/^### \d+\. /mu.test(answer), 'the model emitted the forbidden ranked-evidence list')
    assert(!/^\s*Sources:\s*$/mu.test(answer), 'the model appended a separate Sources block')
    return `${badgeLine} | answer ${answer.length} chars`
  })
  check('cli: coverage limits are stated instead of faked', () => {
    const coverage = answerLines.filter((line) => /partial coverage|不可达|未覆盖|timeout|unreachable|覆盖/i.test(line))
    assert(coverage.length > 0, 'the article never states its coverage limits even though sources can time out')
    return coverage[0].slice(0, 160)
  })
  check('cli: article body is Chinese prose (not an English dump)', () => {
    const han = (answer.match(/[\u4e00-\u9fff]/gu) || []).length
    const latin = (answer.match(/[A-Za-z]/gu) || []).length
    assert(han > 200, `expected a Chinese narrative, found ${han} Han characters`)
    assert(han > latin / 4, `answer looks untranslated (Han ${han} vs latin ${latin})`)
    return `Han ${han} chars, latin ${latin} chars`
  })

  const artifacts = {
    runtime,
    cli: cli.detail,
    model,
    replayed: replayDir ?? false,
    durationMs,
    runDir,
    saveDir,
    python: `${runtimeInfo.pythonPath} (${runtimeInfo.pythonVersion}, ${runtimeInfo.pythonSource})`,
    skillPath: runtimeInfo.skillPath,
    badge: badgeLine,
    engineCommands,
    savedFiles,
    answerChars: answer.length,
    checks: results
  }
  const reportPath = path.join(runDir, replayDir ? 'run-report.replay.json' : 'run-report.json')
  fs.writeFileSync(reportPath, JSON.stringify(artifacts, null, 2), 'utf8')
  console.log('')
  console.log(`report: ${reportPath}`)
  console.log(`article head:\n${answerLines.slice(0, 12).join('\n')}`)
  const failed = results.filter((entry) => entry.status === 'FAIL').length
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
