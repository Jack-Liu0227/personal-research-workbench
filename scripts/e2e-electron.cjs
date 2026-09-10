/*
 * Packaged-like Electron smoke test.
 *
 * This deliberately drives the real renderer/preload/core stack instead of
 * mocking IPC. It creates an isolated user-data directory and a temporary
 * Obsidian Vault, so the run cannot touch the developer's workbench database
 * or external notes. Set PRW_E2E_USER_DATA to retain a profile for debugging;
 * otherwise a new profile is created below the OS temp directory.
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

function absoluteNonRoot(value) {
  const resolved = path.resolve(value)
  const parsed = path.parse(resolved)
  if (resolved === parsed.root) throw new Error(`Refusing root user-data path: ${resolved}`)
  return resolved
}

function makeIsolatedProfile() {
  if (process.env.PRW_E2E_USER_DATA) return absoluteNonRoot(process.env.PRW_E2E_USER_DATA)
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prw-workbench-e2e-'))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function clickNav(page, label) {
  const target = page.getByText(label, { exact: true }).first()
  await target.waitFor({ state: 'visible', timeout: 20_000 })
  await target.click()
  // The shell keeps one renderer mounted while swapping route content. Wait
  // for the main landmark before inspecting text so a slow Core response does
  // not make a previous page look like the current one.
  await page.locator('main').waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(350)
}

async function bodyText(page) {
  return page.locator('body').innerText()
}

async function main() {
  assert(fs.existsSync(MAIN_ENTRY), `Build output not found: ${MAIN_ENTRY}`)
  const userData = makeIsolatedProfile()
  fs.mkdirSync(userData, { recursive: true })
  // Run the development entry with the isolated profile as its working
  // directory. Main's application-owned default Vault is then created under
  // this temp tree (rather than beside the source checkout). Keep the
  // project-pinned skill path explicit because changing cwd must not change
  // which instructions scheduled runs resolve.
  const launchEnv = { ...process.env, PRW_LAST30DAYS_SKILL_PATH: path.join(APP_ROOT, '.agents', 'skills', 'last30days', 'skills', 'last30days', 'SKILL.md') }
  delete launchEnv.OBSIDIAN_DIR
  // Packaged code must use workbench://app, never a caller-provided dev URL.
  delete launchEnv.ELECTRON_RENDERER_URL
  const app = await electron.launch({
    executablePath: process.env.PRW_ELECTRON || DEFAULT_ELECTRON,
    args: [MAIN_ENTRY, `--prw-user-data-dir=${userData}`],
    env: launchEnv,
    cwd: userData,
    timeout: 90_000
  })
  const errors = []
  const captureErrors = (window) => {
    window.on('pageerror', (error) => errors.push(error.message))
    window.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
  }
  app.on('window', captureErrors)
  const page = await app.firstWindow({ timeout: 90_000 })
  captureErrors(page)
  page.on('dialog', async (dialog) => {
    // All destructive actions in this smoke use an isolated profile.
    await dialog.accept()
  })

  try {
    await page.waitForSelector('text=仪表盘', { timeout: 90_000 })
    assert(page.url().startsWith('workbench://app/'), `Unexpected renderer origin: ${page.url()}`)
    console.log('shell: ok', await page.title())

    const labels = ['仪表盘', '日历', '任务', '项目空间', '文献检索', 'Obsidian', 'Zotero', 'Agent', '定时任务', '设置']
    for (const label of labels) {
      await clickNav(page, label)
      console.log(`nav ${label}: ok`)
    }
    assert(!(await bodyText(page)).includes('INSPECTOR / CONTEXT'), 'Global redundant Inspector is still rendered')

    // Project-space knowledge categories use the same safe empty-folder
    // deletion contract as the dedicated Obsidian page, including select-all
    // and per-category actions (the layout preview also exposes empty roots).
    await clickNav(page, '项目空间')
    let knowledgeTab = page.getByRole('tab', { name: '知识映射' })
    if (await knowledgeTab.count() === 0) {
      // A fresh isolated profile has no projects. Create one through the
      // normal dialog so the aggregate page is exercised without seeding
      // hidden demo records.
      await clickNav(page, '仪表盘')
      await clickNav(page, '仪表盘')
      const createProjectButton = page.getByRole('button', { name: '新建项目' })
      await createProjectButton.waitFor({ state: 'visible', timeout: 30_000 })
      await createProjectButton.click()
      await page.getByRole('dialog').getByRole('textbox').first().fill('E2E 分类项目')
      await page.getByRole('dialog').getByRole('button', { name: '创建项目' }).click()
      await page.waitForTimeout(700)
      await clickNav(page, '项目空间')
      knowledgeTab = page.getByRole('tab', { name: '知识映射' })
    }
    await knowledgeTab.waitFor({ state: 'visible', timeout: 20_000 })
    await knowledgeTab.click()
    await page.waitForTimeout(1_000)
    assert(await page.locator('input[aria-label="全选知识库分类"]').count() === 1, 'Project-space knowledge select-all missing')
    assert(await page.locator('input[aria-label^="选择知识库分类："]').count() >= 1, 'Project-space knowledge categories missing')
    await page.screenshot({ path: path.join(userData, 'project-space-knowledge-smoke.png'), fullPage: true })
    console.log('project-space category controls: ok')

    // Dashboard must explain empty/real data instead of presenting demo cards.
    await clickNav(page, '仪表盘')
    await page.getByRole('heading', { name: '今日工作面' }).waitFor({ state: 'visible', timeout: 20_000 })
    let text = await bodyText(page)
    assert(text.includes('最近科研产物'), 'Dashboard recent-artifacts card missing')
    assert(text.includes('不是演示数据'), 'Dashboard truthfulness explanation missing')
    console.log('dashboard truthfulness: ok')

    // Agent controls: one runtime bar, selectable model/thinking/permission,
    // and no conversations created merely by opening the app. The header and
    // composer must not wait for the CLI capability probe.
    const agentNavigationStarted = Date.now()
    await clickNav(page, 'Agent')
    await page.waitForSelector('select[aria-label="模型"]', { timeout: 30_000 })
    console.log(`timing Agent shell: ${Date.now() - agentNavigationStarted}ms`)
    assert(await page.locator('select[aria-label="模型"]').count() === 1, 'Agent has duplicate model selectors')
    assert(await page.locator('select[aria-label="思考深度"]').count() === 1, 'Agent thinking selector missing/duplicated')
    assert(await page.locator('select[aria-label="权限模式"]').count() === 1, 'Agent permission selector missing/duplicated')
    assert(await page.getByRole('button', { name: 'Codex' }).count() >= 1, 'Codex runtime control missing')
    assert(await page.getByRole('button', { name: 'Pi' }).count() >= 1, 'Pi runtime control missing')
    const codexModels = await page.locator('select[aria-label="模型"] option').count()
    await page.getByRole('button', { name: 'Pi' }).first().click()
    // Pi model discovery is delegated to the installed CLI and can take a
    // few seconds on a cold catalog refresh. Give it time to expose the full
    // provider-qualified list, while retaining a safe one-option fallback on
    // machines where Pi is not installed.
    await page.waitForFunction(() => document.querySelectorAll('select[aria-label="模型"] option').length > 2, null, { timeout: 15_000 }).catch(() => undefined)
    const piModels = await page.locator('select[aria-label="模型"] option').count()
    assert(codexModels >= 1 && piModels >= 1, 'Runtime model selectors have no fallback option')
    await page.getByRole('button', { name: 'Codex' }).first().click()
    await page.screenshot({ path: path.join(userData, 'agent-smoke.png'), fullPage: true })
    const conversationItems = page.locator('button[aria-label^="删除对话："]')
    assert(await conversationItems.count() === 0, 'Opening the app created an unexpected conversation')
    console.log(`agent selectors: ok (Codex options=${codexModels}, Pi options=${piModels})`)

    // Literature keeps its live import preview in the local right Inspector.
    await clickNav(page, '文献检索')
    await page.getByText('INSPECTOR / PAPER', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
    for (const selector of ['select[aria-label="Zotero Collection"]', 'select[aria-label="Zotero 导出格式"]', 'select[aria-label="结果排序"]', 'select[aria-label="导入项目"]']) {
      // The project binding control is intentionally rendered both in the
      // compact filter row and inside the expandable “更多筛选” group so it
      // remains available at narrow widths.  Other controls remain unique.
      const count = await page.locator(selector).count()
      assert(count >= 1, `Literature control missing: ${selector}`)
    }
    const zoteroFormats = await page.locator('select[aria-label="Zotero 导出格式"] option').allTextContents()
    assert(zoteroFormats.includes('Better BibTeX') && zoteroFormats.includes('RIS'), 'Literature Zotero export formats missing')
    const sortValues = await page.locator('select[aria-label="结果排序"] option').evaluateAll((options) => options.map((option) => option.value))
    assert(sortValues.includes('year-desc') && sortValues.includes('year-asc'), 'Literature year sort options missing')
    assert(sortValues.includes('impact-desc') && sortValues.includes('impact-asc'), 'Literature impact-factor sort options missing')
    assert(await page.locator('select option[value="google_scholar"]').count() >= 1, 'Google Scholar source option missing')
    assert(await page.locator('select[aria-label="每页数量"] option[value="50"]').count() === 1, 'Literature 50-per-page option missing')
    assert(await page.getByRole('button', { name: '下一页' }).count() >= 1, 'Literature next-page action missing')
    text = await bodyText(page)
    assert(text.includes('实时导入预览'), 'Literature live preview panel missing')
    assert(await page.getByRole('button', { name: '预览导入 Zotero' }).count() >= 1, 'Literature Zotero preview action missing')
    await page.screenshot({ path: path.join(userData, 'literature-smoke.png'), fullPage: true })
    console.log('literature Inspector/live preview: ok')

    // Zotero page must expose the real bridge and never surface the old Zod
    // shape error. The actual BBT RPC is smoke-tested separately against the
    // running local Zotero process; this check covers packaged IPC/UI wiring.
    const zoteroNavigationStarted = Date.now()
    await clickNav(page, 'Zotero')
    await page.getByRole('heading', { name: 'Zotero', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
    console.log(`timing Zotero shell: ${Date.now() - zoteroNavigationStarted}ms`)
    await page.waitForTimeout(1_200)
    text = await bodyText(page)
    assert(text.includes('Zotero'), 'Zotero page did not render')
    assert(!text.includes('The request did not match the expected shape.'), 'Zotero still shows the old expected-shape error')
    assert(text.includes('Better BibTeX'), 'Better BibTeX export bridge label missing')
    assert(await page.getByRole('button', { name: '预览导入工作台' }).count() >= 1 || text.includes('尚未配置 Zotero'), 'Zotero Workbench bridge action missing')
    await page.screenshot({ path: path.join(userData, 'zotero-smoke.png'), fullPage: true })
    console.log('Zotero bridge surface: ok')

    // Obsidian keeps edit/preview in one full-height central workspace and
    // exposes category selection/deletion without leaving the page.
    const obsidianNavigationStarted = Date.now()
    await clickNav(page, 'Obsidian')
    await page.getByRole('heading', { name: 'Obsidian', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
    console.log(`timing Obsidian shell: ${Date.now() - obsidianNavigationStarted}ms`)
    await page.waitForTimeout(1_000)
    text = await bodyText(page)
    assert(text.includes('编辑器与实时预览共享中央工作区'), 'Obsidian editor/preview workspace policy missing')
    assert(!text.includes('读取失败'), 'Obsidian index unexpectedly reports a read failure')
    assert(await page.getByText('每日文献推送', { exact: true }).count() >= 1, 'Obsidian default folder is missing from the tree')
    assert(await page.getByText('README.md', { exact: true }).count() >= 1, 'Obsidian default Markdown file is missing from the tree')
    assert(text.includes('分类删除只处理 Vault 根目录下的空文件夹'), 'Safe category deletion policy missing')
    assert(await page.locator('input[aria-label="全选知识库分类"]').count() === 1, 'Obsidian category select-all missing')
    const categoryChecks = page.locator('input[aria-label^="选择分类："]')
    if (await categoryChecks.count() > 0) {
      await categoryChecks.first().check()
      assert(await page.getByRole('button', { name: '删除选中的知识库分类' }).count() === 1, 'Obsidian category delete action missing')
    }
    await page.screenshot({ path: path.join(userData, 'obsidian-smoke.png'), fullPage: true })
    console.log('Obsidian combined editor/category controls: ok')

    // Create a dated Todo, filter the exact same calendar day, then hard-delete
    // it. This catches the previous UTC shift and fake-delete regressions.
    await clickNav(page, '任务')
    await page.getByRole('button', { name: '新建任务' }).first().click()
    await page.getByLabel('任务标题').fill('E2E 8.30 date filter task')
    await page.getByLabel('截止日期').fill('2026-08-30T12:00')
    await page.getByRole('button', { name: '创建任务' }).click()
    await page.waitForTimeout(900)
    await page.getByRole('button', { name: '列表' }).click()
    const dateFieldToggle = page.getByRole('button', { name: /切换日期字段/ })
    if ((await dateFieldToggle.textContent())?.includes('创建时间')) await dateFieldToggle.click()
    await page.locator('select[aria-label="日期筛选"]').selectOption('custom')
    const dateRangeDialog = page.getByRole('dialog', { name: '日期范围选择器' })
    await dateRangeDialog.waitFor({ state: 'visible', timeout: 10_000 })
    assert(await dateRangeDialog.locator('.date-range-month').count() === 2, 'Date range picker must render two calendar months')
    assert(await dateRangeDialog.getByRole('button', { name: '今天' }).count() === 1, 'Date range quick presets missing')
    await page.screenshot({ path: path.join(userData, 'date-range-picker-smoke.png'), fullPage: false })
    await page.getByLabel('开始日期').fill('2026-08-30')
    await page.getByLabel('结束日期').fill('2026-08-30')
    await page.waitForTimeout(900)
    text = await bodyText(page)
    assert(text.includes('E2E 8.30 date filter task'), 'Same-day 8/30 date filter did not return the task')
    // Use the row's direct-delete action (single-item deletion is allowed for
    // active work after explicit confirmation; bulk hard-delete intentionally
    // remains archived-only).
    const datedTaskRow = page.locator('.task-row').filter({ hasText: 'E2E 8.30 date filter task' }).first()
    assert(await datedTaskRow.count() === 1, 'Dated task row missing before delete')
    await datedTaskRow.getByRole('button', { name: '任务菜单' }).click()
    await page.getByRole('menuitem', { name: '直接删除' }).click()
    await page.locator('.task-row').filter({ hasText: 'E2E 8.30 date filter task' }).waitFor({ state: 'detached', timeout: 10_000 })
    console.log('task date filter + delete: ok')

    // Optional knowledge engines have real configuration fields and explicit
    // health-test actions; no service is reported connected by default.
    await clickNav(page, '设置')
    await page.getByRole('button', { name: '代理' }).click()
    await page.waitForTimeout(350)
    assert((await bodyText(page)).includes('统一网络代理'), 'Unified proxy settings missing')
    assert(await page.locator('input[placeholder="http://127.0.0.1:7897"]').count() >= 1, 'Proxy endpoint field missing')
    console.log('unified proxy settings: ok')
    await page.getByRole('button', { name: '知识引擎' }).click()
    await page.waitForTimeout(450)
    assert(await page.locator('input[aria-label="AnythingLLM 服务地址"]').count() === 1, 'AnythingLLM settings missing')
    assert(await page.locator('input[aria-label="LLMWiki 服务地址"]').count() === 1, 'LLMWiki settings missing')
    assert((await bodyText(page)).includes('测试连接'), 'Knowledge-engine test controls missing')
    console.log('AnythingLLM/LLMWiki settings: ok')

    // Schedule is seeded once, defaults enabled, and can be paused/resumed.
    await clickNav(page, '定时任务')
    await page.waitForFunction(() => !document.body.innerText.includes('正在读取定时任务') && document.body.innerText.includes('Last 30 days'), null, { timeout: 30_000 })
    text = await bodyText(page)
    assert((text.match(/Last 30 days/g) || []).length >= 1, 'Built-in Last 30 days schedule missing')
    assert(text.includes('每天') && text.includes('09:00'), 'Daily 09:00 schedule semantics missing')
    await page.getByRole('button', { name: '新建定时任务' }).click()
    assert((await bodyText(page)).includes('每日推送正文使用简体中文'), 'Last30days Chinese output guidance missing')
    await page.getByRole('button', { name: '取消' }).first().click()
    const scheduleToggle = page.getByRole('button', { name: /暂停 Last 30 days|启用 Last 30 days/ }).first()
    assert(await scheduleToggle.count() === 1, 'Schedule pause/enable control missing')
    const initialLabel = await scheduleToggle.getAttribute('aria-label')
    if ((initialLabel || '').startsWith('启用')) {
      await scheduleToggle.click()
      await page.waitForTimeout(450)
    }
    await page.getByRole('button', { name: '暂停 Last 30 days' }).click()
    await page.waitForTimeout(500)
    assert((await bodyText(page)).includes('已暂停'), 'Schedule did not pause')
    await page.getByRole('button', { name: '启用 Last 30 days' }).click()
    await page.waitForTimeout(500)
    assert((await bodyText(page)).includes('已启用'), 'Schedule did not re-enable')
    await page.screenshot({ path: path.join(userData, 'schedule-smoke.png'), fullPage: true })
    console.log('schedule default/daily/pause-enable: ok')

    assert(errors.length === 0, `Renderer console/page errors: ${JSON.stringify(errors.slice(0, 10))}`)
    console.log('e2e: PASS')
    console.log(`evidence: ${path.join(userData, 'schedule-smoke.png')}`)
    console.log(`date-range evidence: ${path.join(userData, 'date-range-picker-smoke.png')}`)
  } finally {
    await app.close()
  }
}

main().catch((error) => {
  console.error(error.stack || error)
  process.exitCode = 1
})
