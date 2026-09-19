/*
 * Live cross-module check for the in-process Agent.
 *
 * Unlike `e2e-electron.cjs`, this runs against a *copy of the real profile*:
 * the real provider credential, the real `models.json` custom provider, the
 * real Zotero profile and the real Obsidian Vault. It therefore needs a real
 * model call, a real Zotero Local API and a real Vault directory, and it is the
 * only check that can answer "does the Agent actually drive the workbench".
 *
 * Safety rules that shape this file:
 *  - The copy is a temp directory; the live profile is never opened, so no run
 *    can append to the user's own conversation history.
 *  - Every schedule cursor in the copy is pushed far into the future before the
 *    app starts, so the 30-second ticker and the startup catch-up cannot fire a
 *    real scheduled run behind our back.
 *  - Only reads touch Zotero and the Vault. The Agent's own external-write path
 *    (preview + in-chat confirmation) is not wired yet, so nothing here writes
 *    to either external system.
 *
 * Env:
 *  PRW_LIVE_SOURCE   profile to copy (default: %APPDATA%\@prw\desktop)
 *  PRW_LIVE_KEEP=1   keep the temp profile for inspection
 *  PRW_LIVE_ONLY=a,b  run only the named checks
 */
const { _electron: electron } = require('playwright-core')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const APP_ROOT = path.resolve(__dirname, '..')
const MAIN_ENTRY = path.join(APP_ROOT, 'apps', 'desktop', 'out', 'main', 'index.cjs')
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
const DEFAULT_SOURCE = path.join(process.env.APPDATA ?? os.homedir(), '@prw', 'desktop')
const PROVIDER_ID = process.env.PRW_LIVE_PROVIDER ?? 'openai-responses'
const RUN_TIMEOUT_MS = Number(process.env.PRW_LIVE_RUN_TIMEOUT_MS ?? 240_000)
const STAMP = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 12)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function log(line) {
  console.log(line)
}

/** `better-sqlite3` is native, so it has to be resolved from the package that
 * declares it rather than from this script's directory. */
function openDatabase(filePath, options = {}) {
  const { createRequire } = require('node:module')
  const requireFromDatabase = createRequire(path.join(APP_ROOT, 'packages', 'database', 'package.json'))
  const Database = requireFromDatabase('better-sqlite3')
  return new Database(filePath, options)
}

/**
 * Copy the live profile into a temp directory.
 *
 * The database is copied with SQLite's own online backup API rather than by
 * copying the file: the live app is running and its WAL holds committed rows
 * that a plain file copy would miss.
 */
function copyProfile(sourceDir) {
  assert(fs.existsSync(sourceDir), `Live profile not found: ${sourceDir}`)
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'prw-live-check-'))
  fs.mkdirSync(path.join(target, 'config'), { recursive: true })
  fs.mkdirSync(path.join(target, 'data', 'agent-runtime', 'pi'), { recursive: true })

  // `Local State` holds the random key that Chromium's OSCrypt wraps with DPAPI
  // on Windows, and `safeStorage` cannot decrypt the copied vault without it.
  // Copying only the encrypted blobs would leave every stored credential
  // unreadable in the isolated profile.
  for (const name of ['Local State', 'Local State.backup']) {
    const from = path.join(sourceDir, name)
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(target, name))
  }

  for (const name of ['workspace-secrets.json', 'workspace-service.json']) {
    const from = path.join(sourceDir, 'config', name)
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(target, 'config', name))
  }
  for (const name of ['models.json', 'models-store.json', 'auth.json']) {
    const from = path.join(sourceDir, 'data', 'agent-runtime', 'pi', name)
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(target, 'data', 'agent-runtime', 'pi', name))
  }

  const sourceDatabase = path.join(sourceDir, 'data', 'workspace.sqlite3')
  assert(fs.existsSync(sourceDatabase), `Live database not found: ${sourceDatabase}`)
  const live = openDatabase(sourceDatabase, { readonly: true })
  const copyPath = path.join(target, 'data', 'workspace.sqlite3')
  return live.backup(copyPath).then(() => {
    live.close()
    // Freeze every schedule cursor. The copy starts with the live cursors, and
    // any of them could be due right now - which would launch a real scheduled
    // run (network, artifacts, model spend) in the middle of this check.
    const copy = openDatabase(copyPath)
    copy.prepare('UPDATE schedules SET next_run_at = ?').run('2099-01-01T00:00:00.000Z')
    copy.close()
    return target
  })
}

async function launch(userData) {
  const launchEnv = {
    ...process.env,
    PRW_LAST30DAYS_SKILL_PATH: path.join(APP_ROOT, '.agents', 'skills', 'last30days', 'skills', 'last30days', 'SKILL.md')
  }
  delete launchEnv.OBSIDIAN_DIR
  delete launchEnv.ELECTRON_RENDERER_URL
  delete launchEnv.PRW_E2E_USER_DATA
  const app = await electron.launch({
    executablePath: process.env.PRW_ELECTRON || DEFAULT_ELECTRON,
    args: [MAIN_ENTRY, `--prw-user-data-dir=${userData}`],
    env: launchEnv,
    cwd: userData,
    timeout: 120_000
  })
  const page = await app.firstWindow({ timeout: 120_000 })
  const child = app.process()
  child.stdout?.on('data', (chunk) => process.stdout.write(`[main] ${String(chunk)}`))
  child.stderr?.on('data', (chunk) => process.stderr.write(`[main-err] ${String(chunk)}`))
  return { app, page }
}

/**
 * Renderer-side bridge. Every call goes through the typed preload API, so the
 * check exercises the same renderer → Main → Core path a user action takes.
 * Results are projected to small plain values: the raw ledger records carry up
 * to 64 KB of text each and would flood this process.
 */
/**
 * Install the page-side bridge.
 *
 * The bridge lives in the renderer so every call goes through the typed
 * preload API, which is the same renderer -> Main -> Core path a user action
 * takes. It is wrapped in a result envelope because a raw thrown value loses
 * the structured `code`/`details` that say which field actually failed.
 * Defined as a real function rather than built from a string so it works under
 * the packaged renderer's CSP.
 */
async function installBridge(page) {
  await page.evaluate(() => {
    const api = window.workbench
    window.__liveBridge = {
      catalog: () => api.agent.models.catalog(),
      credentials: () => api.agent.credentials.status(),
      settings: () => api.agent.settings.get(),
      customProviders: () => api.agent.models.customProviders.get(),
      discover: (input) => api.agent.models.customProviders.discover(input),
      integrations: () => api.v2.integrations.list(),
      capability: (profileId) => api.v2.zotero.capability(profileId),
      zoteroItems: (profileId) => api.v2.zotero.items(profileId),
      notes: (vaultId) => api.v2.notes.list({ vaultId, query: '' }),
      readNote: (input) => api.v2.notes.read(input),
      externalActions: (input) => api.agent.externalActions.list(input),
      decideExternalAction: (input) => api.agent.externalActions.decide(input),
      rules: () => api.agent.automation.rules(),
      saveRule: (input) => api.agent.automation.save(input),
      archiveRule: ({ id, revision }) => api.agent.automation.archive(id, revision),
      runNow: (id) => api.agent.automation.runNow(id),
      listRuns: async () => (await api.agent.runs.list({ page: { limit: 25 } })).map((run) => ({
        id: run.id,
        jobId: run.jobId,
        status: run.status,
        error: run.error,
        output: run.output.slice(0, 2_000),
        createdAt: run.createdAt,
        finishedAt: run.finishedAt
      })),
      records: async (runId) => (await api.agent.runs.recordsPage({ runId, limit: 400 }))
        .filter((row) => row.kind !== 'reasoning')
        .map((row) => ({
          seq: row.seq,
          kind: row.kind,
          status: row.status,
          title: row.title,
          toolName: row.toolName,
          detail: row.detail.slice(0, 600),
          outputText: (row.outputText ?? '').slice(0, 1_500)
        }))
    }
  })
}

async function live(page, name, arg) {
  const result = await page.evaluate(async (input) => {
    try {
      return { ok: true, value: await window.__liveBridge[input.name](input.arg) }
    } catch (error) {
      const info = {}
      for (const key of Object.getOwnPropertyNames(error)) {
        try {
          info[key] = error[key]
        } catch {
          // A getter that throws must not hide the failure being reported.
        }
      }
      info.message = String(error?.message ?? error)
      info.name = String(error?.name ?? 'Error')
      return { ok: false, info: JSON.parse(JSON.stringify(info)) }
    }
  }, { name, arg })
  if (result.ok) return result.value
  const info = result.info
  throw new Error(`[${name}] ${JSON.stringify({ ...info, stack: undefined }).slice(0, 1_200)}`)
}

/** Thin wrappers keep the call sites read as `bridge.something(page, args)`. */
const bridge = {
  catalog: (page) => live(page, 'catalog'),
  credentials: (page) => live(page, 'credentials'),
  settings: (page) => live(page, 'settings'),
  customProviders: (page) => live(page, 'customProviders'),
  discover: (page, input) => live(page, 'discover', input),
  integrations: (page) => live(page, 'integrations'),
  capability: (page, profileId) => live(page, 'capability', profileId),
  zoteroItems: (page, profileId) => live(page, 'zoteroItems', profileId),
  notes: (page, vaultId) => live(page, 'notes', vaultId),
  readNote: (page, input) => live(page, 'readNote', input),
  externalActions: (page, input) => live(page, 'externalActions', input),
  decideExternalAction: (page, input) => live(page, 'decideExternalAction', input),
  rules: (page) => live(page, 'rules'),
  saveRule: (page, input) => live(page, 'saveRule', input),
  archiveRule: (page, id, revision) => live(page, 'archiveRule', { id, revision }),
  runNow: (page, id) => live(page, 'runNow', id),
  listRuns: (page) => live(page, 'listRuns'),
  records: (page, runId) => live(page, 'records', runId)
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'partial', 'failed', 'canceled', 'blocked', 'missed'])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Send one message through the real composer and wait for its run to settle. */
async function sendTurn(page, text) {
  const known = new Set((await bridge.listRuns(page)).map((run) => run.id))
  await page.locator('.agent-composer-input').waitFor({ state: 'visible', timeout: 60_000 })
  await page.locator('.agent-composer-input').fill(text)
  await page.locator('.agent-composer-input').press('Enter')
  const deadline = Date.now() + RUN_TIMEOUT_MS
  while (Date.now() < deadline) {
    const runs = await bridge.listRuns(page)
    const started = runs.find((run) => !known.has(run.id))
    if (started && TERMINAL_RUN_STATUSES.has(started.status)) return started
    await sleep(2_000)
  }
  throw new Error(`Agent run did not finish within ${RUN_TIMEOUT_MS} ms: ${text.slice(0, 60)}`)
}

/** Wait for a run started by a non-composer path (a “Run now” schedule). */
async function waitForRun(page, runId) {
  const deadline = Date.now() + RUN_TIMEOUT_MS
  while (Date.now() < deadline) {
    const runs = await bridge.listRuns(page)
    const run = runs.find((entry) => entry.id === runId)
    if (run && TERMINAL_RUN_STATUSES.has(run.status)) return run
    await sleep(2_000)
  }
  throw new Error(`Run ${runId} did not finish within ${RUN_TIMEOUT_MS} ms`)
}

function toolRecords(records) {
  return records.filter((record) => record.kind === 'tool' || record.kind === 'subtool')
}

function assistantText(records) {
  return records
    .filter((record) => record.kind === 'assistant')
    .map((record) => record.detail)
    .join('\n')
}

/** Assert that one named tool was called by the model and answered without error. */
function assertToolCall(records, name) {
  const calls = toolRecords(records).filter((record) => record.toolName === name)
  if (calls.length === 0) {
    const seen = toolRecords(records).map((record) => record.toolName).filter(Boolean)
    throw new Error(`the model never called ${name} (tools it did call: ${seen.length > 0 ? seen.join(', ') : 'none'})`)
  }
  const failed = calls.filter((record) => record.status === 'failed')
  if (failed.length > 0) throw new Error(`${name} failed: ${failed[0].detail.slice(0, 300)}`)
  return calls[0]
}

/** One check, reported as a line and collected for the exit code. */
const results = []
const only = (process.env.PRW_LIVE_ONLY ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)

async function check(name, run) {
  if (only.length > 0 && !only.includes(name)) return
  try {
    const detail = await run()
    results.push({ name, ok: true })
    log(`ok   ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    results.push({ name, ok: false, message: error.message })
    log(`FAIL ${name} — ${error.message}`)
  }
}

const researchNavLabels = ['仪表盘', '项目空间', '文献检索', 'Obsidian', 'Zotero', '定时任务']

async function clickNav(page, label) {
  if (researchNavLabels.includes(label)) {
    const group = page.locator('button[aria-controls="sidebar-research-nav"]')
    if (await group.count() === 1 && await group.getAttribute('aria-expanded') !== 'true') await group.click()
  }
  const target = page.getByText(label, { exact: true }).first()
  await target.waitFor({ state: 'visible', timeout: 60_000 })
  await target.click()
  await page.locator('main').waitFor({ state: 'visible', timeout: 60_000 })
  await page.waitForTimeout(400)
}

async function main() {
  assert(fs.existsSync(MAIN_ENTRY), `Build output not found: ${MAIN_ENTRY}. Run \`pnpm build\` first.`)
  const source = process.env.PRW_LIVE_SOURCE ?? DEFAULT_SOURCE
  const userData = await copyProfile(source)
  log(`live profile copy: ${userData}`)

  const { app, page } = await launch(userData)
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text())
  })
  page.on('dialog', (dialog) => dialog.accept())

  const database = openDatabase(path.join(userData, 'data', 'workspace.sqlite3'), { readonly: true })
  const queryOne = (sql, ...params) => database.prepare(sql).get(...params)
  const queryAll = (sql, ...params) => database.prepare(sql).all(...params)

  // Resolved once: the Zotero profile and the Vault id are what the Agent has
  // to be told, and reading them here is also the independent RPC-level check
  // that the connections themselves work before any model is involved.
  let zoteroProfileId = null
  let vaultId = null
  const evidence = {}

  /**
   * Resolve the Zotero profile and Vault ids on demand.
   *
   * A `PRW_LIVE_ONLY` run skips `connection-rpc`, and without this the
   * expected-value assertions in `agent-research-read` would compare against
   * `null` and pass vacuously — which is exactly how a rejected `zotero.items`
   * call slipped through once already.
   */
  const resolveConnections = async () => {
    if (zoteroProfileId !== null && vaultId !== null) return { zoteroProfileId, vaultId }
    const connections = await bridge.integrations(page)
    zoteroProfileId = connections.find((profile) => profile.provider === 'zotero')?.id ?? null
    vaultId = connections.find((profile) => profile.provider === 'obsidian')?.id ?? null
    assert(zoteroProfileId !== null, 'no Zotero profile is configured')
    assert(vaultId !== null, 'no Obsidian Vault is configured')
    return { zoteroProfileId, vaultId }
  }

  try {
    await page.waitForSelector('text=仪表盘', { timeout: 120_000 })
    assert(page.url().startsWith('workbench://app/'), `Unexpected renderer origin: ${page.url()}`)
    await installBridge(page)

    await check('connection-rpc', async () => {
      const connections = await resolveConnections()
      const capability = await bridge.capability(page, connections.zoteroProfileId)
      const items = await bridge.zoteroItems(page, connections.zoteroProfileId)
      const notes = await bridge.notes(page, connections.vaultId)
      evidence.zotero = { capability, itemCount: items.length, firstTitle: items[0]?.title ?? null }
      evidence.notes = { count: notes.length, firstPath: notes[0]?.relativePath ?? null }
      assert(capability.status !== 'error', `Zotero capability probe failed: ${capability.status} / ${capability.writeBlockedReason ?? ''}`)
      assert(items.length > 0, 'the configured Zotero library returned no items')
      assert(notes.length > 0, 'the configured Obsidian Vault returned no indexed notes')
      return `zotero=${capability.status} ${items.length} items, notes=${notes.length}`
    })

    await check('provider-credential', async () => {
      const catalog = await bridge.catalog(page)
      const entry = catalog.find((candidate) => candidate.provider === PROVIDER_ID)
      assert(entry, `the model catalog has no ${PROVIDER_ID} provider (has: ${catalog.map((candidate) => candidate.provider).join(', ')})`)
      const credentials = await bridge.credentials(page)
      const credential = credentials.find((candidate) => candidate.provider === PROVIDER_ID)
      assert(credential?.credentialPresent === true, `${PROVIDER_ID} has no stored credential`)
      const settings = await bridge.settings(page)
      assert(settings.provider === PROVIDER_ID, `the default provider is ${String(settings.provider)}, not ${PROVIDER_ID}`)
      assert(settings.model === 'gpt-5.6-sol', `the default model is ${String(settings.model)}, not gpt-5.6-sol`)
      const model = entry.models.find((candidate) => candidate.id === 'gpt-5.6-sol')
      assert(model, `${PROVIDER_ID} does not offer gpt-5.6-sol (has: ${entry.models.map((candidate) => candidate.id).join(', ')})`)
      evidence.provider = { name: entry.name, source: entry.source, authTypes: entry.authTypes, models: entry.models.map((candidate) => candidate.id), permissionMode: settings.permissionMode, credentialUpdatedAt: credential.updatedAt }
      return `${entry.name} (${entry.source}) · ${entry.models.length} models · default ${settings.provider}/${settings.model} · ${settings.permissionMode}`
    })

    await check('provider-discovery', async () => {
      const store = await bridge.customProviders(page)
      const provider = store.providers.find((candidate) => candidate.id === PROVIDER_ID)
      assert(provider, `models.json has no ${PROVIDER_ID} entry`)
      const result = await bridge.discover(page, { provider: PROVIDER_ID, baseUrl: provider.baseUrl, api: provider.api })
      evidence.discovery = { api: result.api, modelCount: result.models.length, notice: result.notice, sample: result.models.slice(0, 10).map((model) => model.id) }
      assert(result.models.length > 0, `the endpoint advertised no models (notice: ${String(result.notice)})`)
      return `${result.api} advertised ${result.models.length} models (${evidence.discovery.sample.slice(0, 4).join(', ')})`
    })

    await clickNav(page, 'Agent')

    await check('composer-selection', async () => {
      const providerSelect = page.locator('select[aria-label="Agent Provider"]')
      await providerSelect.waitFor({ state: 'visible', timeout: 60_000 })
      const options = await providerSelect.locator('option').evaluateAll((nodes) => nodes.map((node) => node.value))
      assert(options.includes(PROVIDER_ID), `the composer offers no ${PROVIDER_ID} provider (options: ${options.join(', ')})`)
      await providerSelect.selectOption(PROVIDER_ID)
      const modelSelect = page.locator('select[aria-label="Agent 模型"]')
      await modelSelect.locator(`option[value="gpt-5.6-sol"]`).waitFor({ state: 'attached', timeout: 30_000 })
      await modelSelect.selectOption('gpt-5.6-sol')
      await page.waitForTimeout(300)
      assert(await modelSelect.inputValue() === 'gpt-5.6-sol', 'the composer did not keep the chosen model')
      return `${PROVIDER_ID}/gpt-5.6-sol selectable and sticky`
    })

    await check('agent-task-write', async () => {
      const title = `Agent 连通性自检 ${STAMP}`
      const run = await sendTurn(page, `请调用工作区工具创建一条任务：标题「${title}」，截止时间明天 15:00（时区 Asia/Shanghai）。创建完成后只回复任务 id 和 dueAt，不要做别的。`)
      const records = await bridge.records(page, run.id)
      evidence.taskWrite = { run: run.id, status: run.status, records: toolRecords(records).map((record) => `${record.toolName}:${record.status}`) }
      assert(run.status === 'completed', `the run ended as ${run.status}: ${run.error ?? ''}`)
      assertToolCall(records, 'tasks.create')
      const row = queryOne('SELECT id, title, due_at AS dueAt, created_at AS createdAt FROM tasks WHERE title = ?', title)
      assert(row, `no tasks row was written for 「${title}」`)
      assert(row.dueAt !== null, `the task was written without due_at (the model did not resolve 「明天 15:00」): ${JSON.stringify(row)}`)
      evidence.taskWrite.row = row
      return `${row.id} due ${row.dueAt}`
    })

    await check('agent-calendar-write', async () => {
      const title = `Agent 连通性自检会议 ${STAMP}`
      const run = await sendTurn(page, `请调用工作区工具创建日历事件：标题「${title}」，开始时间明天 10:00（时区 Asia/Shanghai），时长 30 分钟。创建完成后只回复事件 id、startsAt 和 endsAt，不要做别的。`)
      const records = await bridge.records(page, run.id)
      evidence.calendarWrite = { run: run.id, status: run.status, records: toolRecords(records).map((record) => `${record.toolName}:${record.status}`) }
      assert(run.status === 'completed', `the run ended as ${run.status}: ${run.error ?? ''}`)
      assertToolCall(records, 'calendar.create')
      const row = queryOne('SELECT id, title, starts_at AS startsAt, ends_at AS endsAt, timezone FROM calendar_events WHERE title = ?', title)
      assert(row, `no calendar_events row was written for 「${title}」`)
      assert(row.startsAt !== null && row.endsAt !== null, `the event has no time range: ${JSON.stringify(row)}`)
      evidence.calendarWrite.row = row
      return `${row.id} ${row.startsAt} → ${row.endsAt} (${row.timezone})`
    })

    await check('agent-research-read', async () => {
      const run = await sendTurn(page, '请分别调用 zotero 工具和 notes 工具，各给我 3 条真实结果：先用 zotero 工具列出我 Zotero 库里的前 3 条文献标题，再用 notes 工具列出 Obsidian Vault 里的前 3 个笔记相对路径。只列工具真实返回的内容，找不到就说没有。')
      const records = await bridge.records(page, run.id)
      evidence.researchRead = { run: run.id, status: run.status, records: toolRecords(records).map((record) => `${record.toolName}:${record.status}`) }
      assert(run.status === 'completed', `the run ended as ${run.status}: ${run.error ?? ''}`)
      const zoteroCall = assertToolCall(records, 'zotero.items')
      assertToolCall(records, 'notes.list')
      const toolText = toolRecords(records).map((record) => `${record.detail}\n${record.outputText}`).join('\n')
      // Read the same data through the connector RPC so the comparison is
      // against a freshly observed value in every mode, never against `null`.
      const connections = await resolveConnections()
      const rpcItems = await bridge.zoteroItems(page, connections.zoteroProfileId)
      const rpcNotes = await bridge.notes(page, connections.vaultId)
      const expectedTitle = rpcItems[0]?.title ?? null
      const expectedPath = rpcNotes[0]?.relativePath ?? null
      assert(expectedTitle !== null && expectedPath !== null, 'the connector RPC read produced no expected value, so this check cannot be verified')
      assert(!/did not match the expected shape|VALIDATION_FAILED/u.test(toolText), `a tool call was rejected instead of answered: ${toolText.slice(0, 400)}`)
      // JSON escaping in the tool output must not defeat the comparison.
      const strip = (value) => [...value].filter((ch) => ch !== '"' && ch !== String.fromCharCode(92)).join('')
      const observed = strip(toolText)
      const fragment = (value) => strip(value).slice(0, 24)
      assert(observed.includes(fragment(expectedTitle)), `the Zotero tool output does not contain the library's first title (${expectedTitle})`)
      assert(observed.includes(fragment(expectedPath)), `the notes tool output does not contain the Vault's first path (${expectedPath})`)
      evidence.researchRead.zoteroTool = zoteroCall.detail.slice(0, 300)
      evidence.researchRead.expected = { title: fragment(expectedTitle), path: fragment(expectedPath) }
      evidence.researchRead.sample = toolText.slice(0, 1_500)
      return `zotero.items + notes.list returned live data (${expectedTitle} / ${expectedPath})`
    })

    // The external-write chain, exercised without writing anything: the model
    // prepares a real Obsidian write from a real fingerprint, a pending row
    // appears, and the harness rejects it. Approval is deliberately never sent,
    // because approving would modify the user's real Vault.
    await check('agent-external-write-guard', async () => {
      const connections = await resolveConnections()
      const notes = await bridge.notes(page, connections.vaultId)
      assert(notes.length > 0, 'the Vault has no note to target')
      const relativePath = notes[0].relativePath
      const before = await bridge.readNote(page, { vaultId: connections.vaultId, relativePath })
      const run = await sendTurn(
        page,
        `请调用工作区工具 notes.write.request 准备写入 Obsidian 笔记（注意是 .request 工具，不是直接写入）：`
        + `vaultId 用「${connections.vaultId}」，relativePath 用「${relativePath}」，content 用「PRW 自检占位」。`
        + `这个工具只会创建待确认请求，不会真的写入。完成后只回复请求 id，不要做别的。`
      )
      const records = await bridge.records(page, run.id)
      const pending = (await bridge.externalActions(page, { runId: run.id })).filter((action) => action.status === 'pending')
      evidence.externalWriteGuard = {
        run: run.id,
        status: run.status,
        records: toolRecords(records).map((record) => `${record.toolName}:${record.status}`),
        pending: pending.map((action) => ({ id: action.id, kind: action.kind, summary: action.summary }))
      }
      assert(run.status === 'completed', `the run ended as ${run.status}: ${run.error ?? ''}`)
      assertToolCall(records, 'notes.write.request')
      assert(pending.length === 1, `expected exactly one pending external action, saw ${pending.length}`)
      assert(pending[0].kind === 'obsidian-note', `unexpected action kind ${pending[0].kind}`)
      assert(pending[0].summary.includes(relativePath), `the card does not name the target: ${pending[0].summary}`)

      // Rejecting must leave the real file byte-identical.
      const rejected = await bridge.decideExternalAction(page, { id: pending[0].id, decision: 'reject', expectedRevision: 0 })
      assert(rejected.status === 'rejected', `the decision settled as ${rejected.status}`)
      const after = await bridge.readNote(page, { vaultId: connections.vaultId, relativePath })
      assert(after.fingerprint === before.fingerprint, `the rejected write changed the file (${before.fingerprint} → ${after.fingerprint})`)
      assert(after.content === before.content, 'the rejected write changed the note content')
      evidence.externalWriteGuard.rejected = { before: before.fingerprint, after: after.fingerprint }
      return `notes.write.request froze ${before.fingerprint}, rejected, file unchanged`
    })

    await check('agent-literature-search', async () => {
      const run = await sendTurn(page, '请调用工作区工具 literature.search 搜索「retrieval augmented generation evaluation」，只回复 sessionId 和前 3 条结果的标题，不要做别的。')
      const records = await bridge.records(page, run.id)
      evidence.literature = { run: run.id, status: run.status, records: toolRecords(records).map((record) => `${record.toolName}:${record.status}`) }
      assert(run.status === 'completed', `the run ended as ${run.status}: ${run.error ?? ''}`)
      const call = assertToolCall(records, 'literature.search')
      const output = `${call.detail}\n${call.outputText}`
      assert(/sessionId|"results"|doi/i.test(output), `the literature tool returned no structured result: ${output.slice(0, 200)}`)
      return `literature.search answered from the shared coordinator`
    })

    await check('scheduled-run', async () => {
      const title = `定时任务自检 ${STAMP}`
      const rule = await bridge.saveRule(page, {
        name: `Agent 自检定时任务 ${STAMP}`,
        workflowKey: 'daily_digest',
        runtime: 'pi',
        model: null,
        assistantKey: 'researcher',
        frequency: 'daily',
        cron: '0 9 * * *',
        timezone: 'Asia/Shanghai',
        enabled: true,
        permissionMode: 'auto',
        approvalPolicy: 'never',
        skillKey: null,
        topic: '',
        prompt: `只做一件事：调用工作区工具 tasks.create 创建任务，标题「${title}」，其它字段留空。完成后回复任务 id。`,
        responseLanguage: 'zh-CN'
      })
      const started = await bridge.runNow(page, rule.id)
      const run = await waitForRun(page, started.id)
      const records = await bridge.records(page, run.id)
      evidence.scheduledRun = { ruleId: rule.id, run: run.id, status: run.status, model: started.input?.model ?? null, permissionMode: started.permissionMode, records: toolRecords(records).map((record) => `${record.toolName}:${record.status}`) }
      assert(run.status === 'completed', `the scheduled run ended as ${run.status}: ${run.error ?? ''}`)
      assertToolCall(records, 'tasks.create')
      const row = queryOne('SELECT id, title, created_at AS createdAt FROM tasks WHERE title = ?', title)
      assert(row, `the scheduled run wrote no tasks row for 「${title}」`)
      evidence.scheduledRun.row = row
      const current = (await bridge.rules(page)).find((candidate) => candidate.id === rule.id)
      if (current) await bridge.archiveRule(page, current.id, current.revision).catch(() => {})
      return `scheduled run ${run.id} wrote ${row.id}`
    })
  } finally {
    database.close()
    await app.close().catch(() => {})
    const reportPath = path.join(os.tmpdir(), `prw-agent-live-report-${STAMP}.json`)
    fs.writeFileSync(reportPath, `${JSON.stringify({ provider: PROVIDER_ID, source, checks: results, evidence, pageErrors }, null, 2)}\n`)
    if (process.env.PRW_LIVE_KEEP === '1') {
      log(`kept profile: ${userData}`)
    } else {
      fs.rmSync(userData, { recursive: true, force: true })
    }
    log('')
    const failed = results.filter((entry) => !entry.ok)
    log(`checks: ${results.length - failed.length}/${results.length} passed`)
    if (pageErrors.length > 0) log(`renderer errors: ${pageErrors.slice(0, 5).join(' | ')}`)
    log(`report: ${reportPath}`)
    if (failed.length > 0) log(`failed: ${failed.map((entry) => entry.name).join(', ')}`)
    process.exitCode = failed.length > 0 ? 1 : 0
  }
}

main().catch((error) => {
  console.error(`live check aborted: ${error.stack ?? error.message}`)
  process.exitCode = 1
})
