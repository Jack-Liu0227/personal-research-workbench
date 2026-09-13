#!/usr/bin/env node
/*
 * Focused check for Task 06 — "last30days AI 最新资讯中文推送".
 *
 * It drives the real modules on an isolated SQLite database and a temporary run
 * root (no user data, no credentials):
 *
 *   1. frozen rule: the shipped default is one object
 *      (skill=last30days / topic=AI 最新资讯 / zh-CN / 30 days / 每日资讯推送)
 *      and the migrated built-in schedule row carries exactly those values.
 *   2. prompt plumbing: the topic and the narrative language reach the *engine
 *      command line and the instruction block* (not just an editor label), and
 *      the coordinator reads them back from the stored rule — so a Chinese/English
 *      choice changes the prompt, not the UI.
 *   3. four separable diagnostics: no key (optional source), missing optional
 *      source, network failure, CLI permission failure. Each has its own code or
 *      degradation note and none of them is reported as success.
 *   4. projection: the article lands in `每日资讯推送` and SQLite keeps an index +
 *      bounded excerpt that names the Vault file as the body authority.
 *   5. real keyless engine run (`--engine-run`, never `--mock`): the pinned engine
 *      answers the frozen schedule parameters and keeps the badge/footer
 *      contract, writing raw evidence only into the isolated directory.
 *
 * Usage: pnpm test:last30days:digest
 *        pnpm test:last30days:digest -- --engine-run   (spends ~30s of network)
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { WorkbenchRepository, migrateDatabase } from '@prw/database'
import { DEFAULT_DAILY_PUSH_SCHEDULE_INPUT } from '@prw/contracts'
import { AgentCoordinator, buildScheduleInstructions } from '../packages/workspace-service/src/agent-coordinator.ts'
import {
  buildLast30DaysDegradationNotes,
  buildLast30DaysSkillBriefing,
  classifyLast30DaysProbeFailure,
  classifyLast30DaysRunFailure,
  parseLast30DaysDiagnose,
  probeLast30DaysCapability,
  skillResponseLanguageRule,
  summarizeLast30DaysDiagnose,
  type Last30DaysSkillRuntime
} from '../packages/workspace-service/src/skill-registry.ts'
import {
  DAILY_LITERATURE_FOLDER,
  buildDailyLiteratureMarkdown,
  buildDailyLiteratureProjection,
  dailyLiteratureExcerpt,
  dailyLiteratureRelativePath
} from '../packages/workspace-service/src/daily-literature.ts'

const results: Array<{ name: string; status: 'PASS' | 'FAIL' | 'BLOCKED'; detail: string }> = []
function record(name: string, status: 'PASS' | 'FAIL' | 'BLOCKED', detail: string): void {
  results.push({ name, status, detail })
  console.log(`[${status}] ${name}${detail ? `\n        ${detail.split('\n').join('\n        ')}` : ''}`)
}
function check(name: string, fn: () => string): boolean {
  try {
    record(name, 'PASS', fn())
    return true
  } catch (error) {
    record(name, 'FAIL', error instanceof Error ? error.message : String(error))
    return false
  }
}
function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const APP_ROOT = resolve(process.cwd())
const SKILL_DIR = join(APP_ROOT, '.agents', 'skills', 'last30days', 'skills', 'last30days')
const ENGINE = join(SKILL_DIR, 'scripts', 'last30days.py')

/** A runtime shaped exactly like the resolved skill, minus the interpreter probe. */
function fakeRuntime(pythonPath: string): Last30DaysSkillRuntime {
  return {
    key: 'last30days',
    skillDir: SKILL_DIR,
    skillPath: join(SKILL_DIR, 'SKILL.md'),
    enginePath: ENGINE,
    pythonPath,
    pythonVersion: '3.13.5',
    skillSource: 'project',
    pythonSource: 'path',
    pinnedVersion: '3.22.0',
    pinnedCommit: '0'.repeat(40)
  } as unknown as Last30DaysSkillRuntime
}

function pythonInterpreter(): string | null {
  for (const candidate of [process.env['PRW_LAST30DAYS_PYTHON'], 'python', 'python3'].filter(
    (value): value is string => Boolean(value)
  )) {
    const probe = spawnSync(candidate, ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)'], {
      encoding: 'utf8'
    })
    if (probe.status === 0) return candidate
  }
  return null
}

const tempRoot = mkdtempSync(join(tmpdir(), 'prw-l30d-digest-'))
const engineRun = process.argv.includes('--engine-run')

// ---------------------------------------------------------------- 1. frozen rule
check('默认规则：主题/语言/回看/目录由单一合同冻结', () => {
  const defaults = DEFAULT_DAILY_PUSH_SCHEDULE_INPUT
  assert(defaults.skillKey === 'last30days', `skillKey=${defaults.skillKey}`)
  assert(defaults.topic === 'AI 最新资讯', `topic=${defaults.topic}（不得是泛化的 research updates）`)
  assert(defaults.responseLanguage === 'zh-CN', `responseLanguage=${defaults.responseLanguage}`)
  assert(defaults.lookbackDays === 30, `lookbackDays=${String(defaults.lookbackDays)}`)
  assert(defaults.outputFolder === DAILY_LITERATURE_FOLDER, `outputFolder=${defaults.outputFolder}`)
  return `${defaults.skillKey} / ${defaults.topic} / ${defaults.responseLanguage} / ${String(defaults.lookbackDays)} 天 / ${defaults.outputFolder}`
})

const repository = new WorkbenchRepository({ filePath: join(tempRoot, 'workbench.sqlite') })
const rawSqlite = (repository as unknown as { sqlite?: { exec: (sql: string) => void } }).sqlite
assert(rawSqlite !== undefined, 'repository 未暴露 sqlite handle')
migrateDatabase(rawSqlite as never)
const builtin = repository.getSchedule('builtin.schedule.last30days')

check('内置规则落库后真实运行参数为 AI 最新资讯 + zh-CN + 30 天 + 每日资讯推送', () => {
  assert(builtin.topic === 'AI 最新资讯', `topic=${builtin.topic}`)
  assert(builtin.responseLanguage === 'zh-CN', `responseLanguage=${builtin.responseLanguage}`)
  assert(builtin.lookbackDays === 30, `lookbackDays=${String(builtin.lookbackDays)}`)
  assert(builtin.outputFolder === DAILY_LITERATURE_FOLDER, `outputFolder=${builtin.outputFolder}`)
  assert(builtin.skillKey === 'last30days', `skillKey=${String(builtin.skillKey)}`)
  return `${builtin.name} · ${builtin.cron} ${builtin.timezone} · ${builtin.skillKey}/${builtin.topic}/${builtin.responseLanguage}/${String(builtin.lookbackDays)}/${builtin.outputFolder}`
})

const coordinator = new AgentCoordinator(repository, { runRoot: join(tempRoot, 'runs'), now: () => new Date('2026-01-02T01:00:00.000Z') })

check('规则字段进入运行请求：语言与回看来自已存规则而非界面默认值', () => {
  const internal = coordinator as unknown as {
    last30DaysRequest: (jobId: string | null) => { readonly sources: readonly string[]; readonly lookbackDays: number; readonly responseLanguage: string | null }
    scheduleTopic: (jobId: string | null) => string | null
  }
  const request = internal.last30DaysRequest('builtin.schedule.last30days')
  assert(request.responseLanguage === 'zh-CN', `responseLanguage=${String(request.responseLanguage)}`)
  assert(request.lookbackDays === 30, `lookbackDays=${String(request.lookbackDays)}`)
  assert(internal.scheduleTopic('builtin.schedule.last30days') === 'AI 最新资讯', '主题未从规则读出')
  // A user-edited rule must flow through unchanged (proves the value is read, not hardcoded).
  repository.saveSchedule({ ...repository.getSchedule('builtin.schedule.last30days'), topic: 'AI Agent 框架', responseLanguage: 'en', lookbackDays: 7, expectedRevision: repository.getSchedule('builtin.schedule.last30days').revision })
  const edited = internal.last30DaysRequest('builtin.schedule.last30days')
  assert(edited.responseLanguage === 'en' && edited.lookbackDays === 7, '规则改动未进入运行请求')
  assert(internal.scheduleTopic('builtin.schedule.last30days') === 'AI Agent 框架', '主题改动未进入运行请求')
  repository.saveSchedule({ ...repository.getSchedule('builtin.schedule.last30days'), topic: 'AI 最新资讯', responseLanguage: 'zh-CN', lookbackDays: 30, expectedRevision: repository.getSchedule('builtin.schedule.last30days').revision })
  return '内置规则与用户改动都从存储读取：zh-CN/30 → 编辑后 en/7 → 复原'
})

// ------------------------------------------------------- 2. prompt / engine wiring
check('Agent prompt：主题与语言进入 skill briefing 与 engine 命令行', () => {
  const runtime = fakeRuntime('python3.13')
  const briefing = buildLast30DaysSkillBriefing({
    runtime,
    saveDir: join(tempRoot, 'skill-output'),
    topic: 'AI 最新资讯',
    lookbackDays: 30,
    responseLanguage: 'zh-CN'
  })
  assert(briefing.includes('"AI 最新资讯"'), '主题未作为 engine 位置参数注入')
  assert(briefing.includes('--days=30'), '回看天数未注入 engine 参数')
  assert(briefing.includes('--no-browser-cookies'), '缺少 keyless 约束参数')
  const engineLine = briefing.split('\n').find((line) => line.includes('--emit=compact')) ?? ''
  assert(engineLine.length > 0, '未找到引擎命令行')
  assert(!engineLine.includes('--mock'), `引擎命令行不得包含 --mock: ${engineLine}`)
  assert(briefing.includes(skillResponseLanguageRule('zh-CN')), '中文语言规则未注入 skill briefing')
  assert(briefing.includes('🌐 last30days v'), 'badge 合同未在 briefing 中声明')
  assert(briefing.includes('PASS-THROUGH'), 'footer 合同未在 briefing 中声明')
  const english = buildLast30DaysSkillBriefing({ runtime, saveDir: join(tempRoot, 'skill-output'), topic: 'AI Weekly', lookbackDays: 7, responseLanguage: 'en' })
  assert(english.includes(skillResponseLanguageRule('en')) && !english.includes(skillResponseLanguageRule('zh-CN')), 'en 规则的语言注入未生效（语言只是界面标签）')
  assert(english.includes('"AI Weekly"') && english.includes('--days=7'), '主题/回看未随规则变化')
  return `briefing ${String(briefing.length)} 字符；主题位置参数 + --days=30 + 中文规则 + badge/footer 合同；en/7 变体生效`
})

check('调度指令块：主题、语言、回看、输出目录都以规则字段注入', () => {
  const instructions = buildScheduleInstructions(repository.getSchedule('builtin.schedule.last30days'))
  assert(instructions.includes('Topic: AI 最新资讯'), '指令块缺少主题')
  assert(instructions.includes(skillResponseLanguageRule('zh-CN')), '指令块缺少语言规则')
  assert(instructions.includes('Lookback window: 30 days'), '指令块缺少回看天数')
  assert(instructions.includes(`Output folder (Vault-relative, the only authorized write location): ${DAILY_LITERATURE_FOLDER}`), '指令块缺少输出目录')
  assert(instructions.includes('last30days'), '指令块缺少 skill 选择')
  return instructions.split('\n').filter((line) => line.trim().length > 0).slice(0, 4).join(' | ')
})

// ------------------------------------------------------- 3. four diagnostics
const diagnoseFixture = JSON.stringify({
  version: '3.22.0',
  safe: true,
  available_sources: ['reddit', 'hackernews'],
  bird_authenticated: false,
  brightdata_authenticated: false,
  permission_preflight: {
    safe: true,
    status: 'ready',
    credentials: {
      github: { label: 'GitHub token or gh auth', present: true },
      openai: { label: 'OpenAI API key', present: false }
    },
    external_commands: { gh: { status: 'available' }, 'yt-dlp': { status: 'unavailable' } }
  }
})

check('诊断①无 key：报为可选来源降级且不阻断 keyless 主流程', () => {
  const summary = summarizeLast30DaysDiagnose(diagnoseFixture)
  assert(summary !== null, 'diagnose 解析失败')
  assert(summary.availableSources.length === 2, `available=${summary.availableSources.join(',')}`)
  assert(summary.missingCredentials.some((entry) => entry.startsWith('x（')), `missingCredentials=${summary.missingCredentials.join(',')}`)
  assert(summary.missingCredentials.some((entry) => entry.startsWith('openai（')), '未报告缺失的 planner key')
  const notes = buildLast30DaysDegradationNotes(summary)
  assert(notes.includes('无 key'), `降级说明缺少无 key 分类: ${notes}`)
  return `available=${summary.availableSources.join('/')} · ${summary.missingCredentials.join(', ')}`
})

check('诊断②缺少可选来源：外部命令缺失单独列出，不与无 key 混淆', () => {
  const summary = summarizeLast30DaysDiagnose(diagnoseFixture)
  assert(summary !== null, 'diagnose 解析失败')
  assert(summary.missingOptionalSources.includes('yt-dlp'), `missingOptionalSources=${summary.missingOptionalSources.join(',')}`)
  assert(!summary.missingOptionalSources.includes('gh'), '已安装的 gh 被误报')
  const notes = buildLast30DaysDegradationNotes(summary)
  assert(notes.includes('缺少可选来源'), `降级说明缺少可选来源分类: ${notes}`)
  assert(!notes.includes('缺少可选来源（外部命令未安装，不阻断）: gh'), '已安装命令被写进降级说明')
  assert(parseLast30DaysDiagnose('not json') === null, '非 JSON 输出必须返回 null 而不是空成功')
  return `missingOptionalSources=${summary.missingOptionalSources.join(',')}；无 key 与缺少可选来源各一行`
})

check('诊断③网络失败：探针失败归类为 SKILL_PROBE_NETWORK_UNREACHABLE 并阻断', () => {
  const runtime = fakeRuntime('python3.13')
  const capability = probeLast30DaysCapability(runtime, {
    ttlMs: 0,
    runDiagnose: () => ({ status: 1, stdout: '', stderr: 'Temporary failure in name resolution' })
  })
  assert(!capability.ok, '网络失败不得报告为可用')
  assert(capability.diagnostic.code === 'SKILL_PROBE_NETWORK_UNREACHABLE', `code=${capability.diagnostic.code}`)
  assert(capability.diagnostic.detail.includes('失败类别: network'), '诊断详情缺少分类')
  const classified = classifyLast30DaysProbeFailure({ status: 1, stderr: 'curl: (7) Failed to connect: connection refused' })
  assert(classified.code === 'SKILL_PROBE_NETWORK_UNREACHABLE', `classified=${classified.code}`)
  return capability.diagnostic.message
})

check('诊断④CLI 权限失败：与网络失败区分，普通崩溃不冒充内容失败', () => {
  const runtime = fakeRuntime('python3.13')
  const probe = probeLast30DaysCapability(runtime, {
    ttlMs: 0,
    runDiagnose: () => ({ status: 1, stdout: '', stderr: 'python.exe: Permission denied while opening last30days.py' })
  })
  assert(!probe.ok, '权限失败不得报告为可用')
  assert(probe.diagnostic.code === 'SKILL_PROBE_PERMISSION_DENIED', `code=${probe.diagnostic.code}`)
  const runFailure = classifyLast30DaysRunFailure('sandbox: operation not permitted (write denied)')
  assert(runFailure?.code === 'SKILL_PROBE_PERMISSION_DENIED', `runFailure=${String(runFailure?.code)}`)
  assert(classifyLast30DaysRunFailure('ENOTFOUND registry.npmjs.org')?.kind === 'network', '网络类 CLI 失败未归类')
  assert(classifyLast30DaysRunFailure('agent crashed: unexpected EOF') === null, '普通崩溃不得被归类为权限/网络')
  const generic = classifyLast30DaysProbeFailure({ status: 2, stderr: 'Traceback: boom' })
  assert(generic.code === 'SKILL_PROBE_FAILED' && generic.kind === 'engine', `generic=${generic.code}`)
  return `${probe.diagnostic.code} · CLI 权限/网络分别归类；一般失败保持 SKILL_PROBE_FAILED`
})

// ------------------------------------------------------- 4. projection
check('投影：结果落到 每日资讯推送，SQLite 只存索引与有界摘录（非第二权威正文）', () => {
  const dateKey = '2026-01-02'
  const content = `🌐 last30days v3.22.0 · synced ${dateKey}\n\nWhat I learned:\n\n这是一段中文正文。${'内容'.repeat(3000)}\n\n<!-- PASS-THROUGH FOOTER -->\n✅ All agents reported back!\n<!-- END PASS-THROUGH FOOTER -->`
  const relativePath = dailyLiteratureRelativePath({ outputFolder: DAILY_LITERATURE_FOLDER, dateKey, scheduleId: builtin.id, runId: 'run-1234' })
  assert(relativePath.startsWith(`${DAILY_LITERATURE_FOLDER}/`), `relativePath=${relativePath}`)
  const markdown = buildDailyLiteratureMarkdown({
    dateKey,
    scheduleId: builtin.id,
    content,
    outputFolder: DAILY_LITERATURE_FOLDER,
    topic: builtin.topic,
    lookbackDays: builtin.lookbackDays,
    sources: [],
    run: { id: 'run-1234', runtime: 'codex', workflowKey: 'daily_digest' } as never
  })
  assert(markdown.includes('workbench_kind: daily_literature'), 'frontmatter 缺少 workbench_kind')
  assert(markdown.includes('workbench_topic: "AI 最新资讯"'), 'frontmatter 缺少主题')
  assert(markdown.startsWith('---'), 'frontmatter 必须位于文件开头')
  assert(markdown.includes(content), '正文必须逐字写入 Vault 投影（含 badge/footer）')
  const projection = buildDailyLiteratureProjection({
    delivery: { status: 'written', relativePath, bytes: content.length, fingerprint: 'x' } as never,
    content,
    dateKey,
    scheduleId: builtin.id,
    run: { id: 'run-1234', runtime: 'codex', workflowKey: 'daily_digest' } as never
  })
  assert(projection.body.includes(`Obsidian 投影（正文权威）: ${relativePath}`), '投影未指明正文权威')
  assert(projection.body.includes('不保存第二份权威正文'), '投影未声明 SQLite 不是正文权威')
  assert(projection.body.length < content.length, 'SQLite 投影不得等于完整正文')
  assert(dailyLiteratureExcerpt(content).includes('正文已截断'), '摘录必须有界')
  return `${relativePath} · SQLite ${String(projection.body.length)} 字 vs 正文 ${String(content.length)} 字`
})

// ------------------------------------------------------- 5. real keyless engine
if (engineRun) {
  const python = pythonInterpreter()
  if (!python) {
    record('真实 keyless engine 运行（无 --mock）', 'BLOCKED', '未找到 Python >= 3.12；保留 BLOCKED，不伪造内容')
  } else {
    check('真实 keyless engine 运行（无 --mock）保持 badge/footer 与隔离写入', () => {
      const saveDir = join(tempRoot, 'engine-run')
      const started = Date.now()
      const run = spawnSync(
        python,
        [ENGINE, 'AI 最新资讯', '--emit=compact', '--auto-resolve', '--no-browser-cookies', `--save-dir=${saveDir}`, '--save-suffix=v3', '--days=30'],
        { encoding: 'utf8', cwd: SKILL_DIR, timeout: 600_000, windowsHide: true }
      )
      const stdout = String(run.stdout ?? '')
      const firstLine = stdout.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? ''
      assert(!/--mock/u.test(String(run.error ?? '')), '不得使用 --mock')
      assert(run.status === 0, `exit=${String(run.status)} stderr=${String(run.stderr ?? '').slice(0, 400)}`)
      assert(firstLine.startsWith('🌐 last30days v'), `第一行不是版本徽章: ${firstLine.slice(0, 80)}`)
      assert(stdout.includes('✅ All agents reported back!'), '缺少 PASS-THROUGH FOOTER')
      assert(/Sources?:\s/u.test(stdout), '缺少来源覆盖行')
      const files = readdirSync(saveDir)
      const raw = files.find((file) => file.endsWith('-raw-v3.md'))
      assert(Boolean(raw), `隔离目录未写入 raw 证据: ${files.join(', ')}`)
      const rawText = readFileSync(join(saveDir, raw as string), 'utf8')
      assert(rawText.includes('AI 最新资讯'), 'raw 证据未记录本次主题')
      return [
        `badge: ${firstLine}`,
        `footer: present · Sources: ${(/Sources?:[^\n]*/u.exec(stdout) ?? ['-'])[0]}`,
        `save dir: ${files.join(', ')}`,
        `duration ${String(Date.now() - started)} ms, exit 0`
      ].join('\n')
    })
  }
} else {
  record('真实 keyless engine 运行（无 --mock）', 'BLOCKED', '未请求；用 `pnpm test:last30days:digest -- --engine-run` 运行真实 keyless 引擎（不得用 --mock 代替）')
}

coordinator.dispose()
repository.close()
rmSync(tempRoot, { recursive: true, force: true })

const failed = results.filter((entry) => entry.status === 'FAIL').length
const blocked = results.filter((entry) => entry.status === 'BLOCKED').length
const passed = results.filter((entry) => entry.status === 'PASS').length
console.log(`\nsummary: ${String(passed)} passed, ${String(failed)} failed, ${String(blocked)} blocked`)
process.exit(failed > 0 || (blocked > 0 && engineRun) ? 1 : 0)
