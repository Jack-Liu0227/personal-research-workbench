#!/usr/bin/env node
/*
 * App-level check for the pinned-skill selection path.
 *
 * It launches the built Electron app (isolated user-data directory, no model
 * call is required for the failure path) and drives the real agent bridge:
 *
 *   1. `PRW_LAST30DAYS_SKILL_PATH` points at a missing SKILL.md, so the run must
 *      be blocked with a `SKILL_MISSING` diagnostic instead of silently running
 *      a generic digest. The ledger record is read back and checked for
 *      redaction-safe paths.
 *   2. An unknown `skillKey` must be rejected at schedule-save time.
 *   3. With the real skill path the run starts, the ledger must contain the
 *      `run:skill` profile record (interpreter, skill path, isolated output
 *      dir), and the run is cancelled immediately so no model tokens are spent.
 *
 * Usage: node scripts/last30days-skill-run-check.cjs
 */
'use strict'

const { _electron: electron } = require('playwright-core')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const APP_ROOT = path.resolve(__dirname, '..')
const MAIN_ENTRY = path.join(APP_ROOT, 'apps', 'desktop', 'out', 'main', 'index.cjs')
const REAL_SKILL = path.join(APP_ROOT, '.agents', 'skills', 'last30days', 'skills', 'last30days', 'SKILL.md')
const DEFAULT_ELECTRON = path.join(
  APP_ROOT,
  'node_modules',
  '.pnpm',
  'electron@43.4.1',
  'node_modules',
  'electron',
  'dist',
  'electron.exe'
)

const results = []
function assert(condition, message) {
  if (!condition) throw new Error(message)
}
function check(name, fn) {
  try {
    const detail = fn()
    results.push({ name, status: 'PASS', detail })
    console.log(`[PASS] ${name}${detail ? `\n        ${detail}` : ''}`)
  } catch (error) {
    results.push({ name, status: 'FAIL', detail: String(error) })
    console.log(`[FAIL] ${name}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}
const absolutePath = /(?:^|[\s"'=(])[A-Za-z]:\\\\?(?:[^\s"'\\]|\\\\?)*\\\\|(?:^|[\s"'=])[A-Za-z]:\\/u

async function launch(skillPathOverride) {
  assert(fs.existsSync(MAIN_ENTRY), `Build output not found: ${MAIN_ENTRY}`)
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'prw-skill-run-check-'))
  const env = { ...process.env, PRW_LAST30DAYS_SKILL_PATH: skillPathOverride }
  delete env.OBSIDIAN_DIR
  delete env.ELECTRON_RENDERER_URL
  const app = await electron.launch({
    executablePath: process.env.PRW_ELECTRON || DEFAULT_ELECTRON,
    args: [MAIN_ENTRY, `--prw-user-data-dir=${userData}`],
    env,
    cwd: userData,
    timeout: 90_000
  })
  const page = await app.firstWindow({ timeout: 90_000 })
  page.on('dialog', async (dialog) => { await dialog.accept() })
  await page.waitForSelector('text=仪表盘', { timeout: 90_000 })
  return { app, page }
}

/** Drives the real preload bridge from the renderer context. */
async function drive(page, mode) {
  return await page.evaluate(async (requested) => {
    const agent = window.workbench.agent
    const rules = await agent.automation.rules()
    const rule = rules.find((entry) => entry.skillKey === 'last30days')
      || rules.find((entry) => /Last 30 days/u.test(entry.name))
    if (!rule) throw new Error(`no last30days schedule: ${rules.map((entry) => `${entry.name}:${entry.skillKey}`).join(', ')}`)
    const summary = { rule: { id: rule.id, name: rule.name, skillKey: rule.skillKey, topic: rule.topic, permissionMode: rule.permissionMode } }

    if (requested === 'unsupported') {
      let rejected = null
      try {
        await agent.automation.save({
          id: rule.id,
          name: rule.name,
          workflowKey: rule.workflowKey,
          runtime: rule.runtime,
          model: rule.model,
          assistantKey: rule.assistantKey,
          workspacePath: rule.workspacePath,
          frequency: rule.frequency,
          executionMode: rule.executionMode,
          conversationId: rule.conversationId,
          prompt: rule.prompt,
          skillKey: 'not-a-real-skill',
          topic: rule.topic,
          outputFolder: rule.outputFolder,
          permissionMode: rule.permissionMode,
          approvalPolicy: rule.approvalPolicy,
          projectId: rule.projectId,
          cron: rule.cron,
          timezone: rule.timezone,
          enabled: rule.enabled,
          expectedRevision: rule.revision
        })
      } catch (error) {
        rejected = error instanceof Error ? error.message : String(error)
      }
      summary.rejected = rejected
      return summary
    }

    const started = await agent.automation.runNow(rule.id)
    const deadline = Date.now() + 45_000
    let run = started
    let records = []
    for (;;) {
      run = await agent.runs.get(started.id)
      records = await agent.runs.recordsPage({ runId: started.id, beforeSeq: null, afterSeq: null, limit: 200 })
      const settled = run.status !== 'running' && run.status !== 'queued'
      const hasSkillRecord = records.some((entry) => entry.kind === 'diagnostic' || entry.recordKey === 'run:skill')
      if (settled || hasSkillRecord || Date.now() > deadline) break
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    summary.run = {
      id: run.id,
      status: run.status,
      error: run.error,
      permissionMode: run.permissionMode,
      toolProfile: run.toolProfile,
      input: run.input
    }
    summary.records = records.map((entry) => ({
      recordKey: entry.recordKey,
      kind: entry.kind,
      status: entry.status,
      title: entry.title,
      detail: entry.detail.slice(0, 600)
    }))

    if (requested === 'cancel') {
      await agent.runs.cancel(started.id)
      const cancelled = await agent.runs.get(started.id)
      summary.cancelledStatus = cancelled.status
    }
    return summary
  }, mode)
}

async function main() {
  const missingSkill = path.join(os.tmpdir(), `prw-missing-skill-${Date.now()}`, 'SKILL.md')

  // --- 1. missing skill -> blocked run with a structured diagnostic ---------
  let blocked = null
  {
    const { app, page } = await launch(missingSkill)
    try {
      blocked = await drive(page, 'blocked')
    } finally {
      await app.close()
    }
  }
  check('schedule: the built-in last30days schedule reaches the skill path', () => {
    assert(blocked.rule.skillKey === 'last30days', `schedule skillKey is ${blocked.rule.skillKey}`)
    return `${blocked.rule.name} (topic "${blocked.rule.topic}", permission ${blocked.rule.permissionMode})`
  })
  check('blocked: a missing SKILL.md blocks the run instead of degrading', () => {
    assert(blocked.run.status === 'blocked', `run status is ${blocked.run.status}`)
    assert(Boolean(blocked.run.error) && blocked.run.error.includes('SKILL_MISSING'), `run error: ${blocked.run.error}`)
    return `${blocked.run.id} → ${blocked.run.status}: ${String(blocked.run.error).slice(0, 120)}`
  })
  check('blocked: the ledger explains which paths were probed', () => {
    const diagnostic = blocked.records.find((entry) => entry.kind === 'diagnostic')
    assert(Boolean(diagnostic), `no diagnostic record: ${blocked.records.map((entry) => entry.recordKey).join(', ')}`)
    assert(diagnostic.recordKey === 'run:skill-diagnostic', `unexpected recordKey ${diagnostic.recordKey}`)
    assert(diagnostic.title.includes('SKILL_MISSING'), `title: ${diagnostic.title}`)
    assert(diagnostic.detail.includes('PRW_LAST30DAYS_SKILL_PATH'), 'the diagnostic must name the probed env override')
    assert(diagnostic.detail.includes('项目路径'), 'the diagnostic must name the probed project path')
    return `${diagnostic.title} | ${diagnostic.detail.split('\n').filter(Boolean).slice(0, 3).join(' / ')}`
  })
  check('blocked: no absolute path is persisted in the ledger', () => {
    const text = blocked.records.map((entry) => `${entry.title}\n${entry.detail}`).join('\n')
    assert(!absolutePath.test(text), `ledger leaked an absolute path: ${text.match(absolutePath)?.[0]}`)
    assert(!/Temp\\prw-missing-skill/u.test(text) || text.includes('%'), 'probe path should be tokenised')
    return 'paths are rendered as %TOKEN% labels'
  })
  check('blocked: the run never starts a runtime the user did not ask for', () => {
    assert(blocked.run.status === 'blocked', 'a blocked run must not be left queued')
    assert(!blocked.records.some((entry) => entry.kind === 'tool'), 'a blocked run must not emit tool records')
    return `permissionMode ${blocked.run.permissionMode}, toolProfile ${blocked.run.toolProfile}`
  })

  // --- 2. unknown skillKey is rejected at write time ------------------------
  {
    const { app, page } = await launch(REAL_SKILL)
    let unsupported = null
    let started = null
    try {
      unsupported = await drive(page, 'unsupported')
      started = await drive(page, 'cancel')
    } finally {
      await app.close()
    }

    check('schedule: an unknown skillKey is rejected instead of stored', () => {
      assert(Boolean(unsupported.rejected), 'saving an unknown skillKey was accepted')
      assert(/not-a-real-skill/u.test(unsupported.rejected), `unexpected error: ${unsupported.rejected}`)
      return unsupported.rejected.slice(0, 160)
    })
    check('skill run: the ledger records the execution profile before the runtime starts', () => {
      const profile = started.records.find((entry) => entry.recordKey === 'run:skill')
      assert(Boolean(profile), `no run:skill record: ${started.records.map((entry) => entry.recordKey).join(', ')}`)
      assert(/python/iu.test(profile.detail), `profile does not name the interpreter: ${profile.detail.slice(0, 200)}`)
      assert(/skill-output/u.test(profile.detail), 'profile does not name the isolated output directory')
      assert(/执行 profile.*workspace-write.*网络/iu.test(profile.detail), `profile does not state the sandbox and network mode: ${profile.detail}`)
      assert(/full-access/iu.test(profile.detail), 'profile does not state that full access is not used')
      assert(!absolutePath.test(`${profile.title}\n${profile.detail}`), 'profile record leaked an absolute path')
      return `${profile.title} | ${profile.detail.split('\n').filter((line) => /python|执行 profile/iu.test(line)).join(' | ')}`
    })
    check('skill run: cancelling stops the run (it is never left running)', () => {
      assert(
        ['canceled', 'failed'].includes(started.cancelledStatus),
        `status after cancel: ${started.cancelledStatus}`
      )
      // `failed` here is the pre-existing race between the kill and the child's
      // exit handler; what matters for skill selection is that the run settles
      // and that no skill-injection error is reported.
      assert(!String(started.run.error ?? '').includes('SKILL_'), `skill injection failed: ${started.run.error}`)
      return `${started.run.id} → ${started.cancelledStatus}${started.run.error ? ` (${String(started.run.error).slice(0, 80)})` : ''}`
    })
  }

  const failed = results.filter((entry) => entry.status === 'FAIL').length
  console.log('')
  console.log(`summary: ${results.length - failed} passed, ${failed} failed`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
