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

    // Daily push is a read-only calendar projection backed by the schedule and
    // occurrence ledger; the smoke checks its UI contract without inventing a
    // run or an artifact in the isolated profile.
    await clickNav(page, '日历')
    await page.getByText('只读投影：任务 / 项目截止日期，以及每日推送', { exact: false }).waitFor({ state: 'visible', timeout: 20_000 })
    assert(await page.locator('select[aria-label="按类型筛选"] option[value="daily_push"]').count() === 1, 'Calendar daily-push type filter missing')
    assert(await page.locator('[data-calendar-readonly-legend]').count() === 1, 'Calendar read-only projection legend missing')

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
    // Task 04: one shared selection bar owns 全选/半选/计数/清除 and states the
    // boundary the select-all really covers.
    const categoryBar = page.locator('.selection-bar').filter({ hasText: '全选知识库分类' })
    assert(await categoryBar.count() === 1, 'Project-space shared selection bar missing')
    assert((await categoryBar.textContent()).includes('范围：Vault 根目录下扫描到的'), 'Project-space selection scope text missing')
    await page.locator('input[aria-label^="选择知识库分类："]').first().check()
    await page.waitForTimeout(150)
    const categoryPartial = await page.locator('input[aria-label="全选知识库分类"]').evaluate((element) => ({ checked: element.checked, indeterminate: element.indeterminate }))
    assert(categoryPartial.checked === false && categoryPartial.indeterminate === true, `Project-space partial selection must render a mixed select-all state (got ${JSON.stringify(categoryPartial)})`)
    assert((await categoryBar.locator('.selection-bar-count').textContent()).startsWith('已选 1 /'), 'Project-space selection count text missing')
    await categoryBar.getByRole('button', { name: '清除选择' }).click()
    await page.waitForTimeout(150)
    assert((await categoryBar.locator('.selection-bar-count').textContent()).startsWith('共 '), 'Project-space clear action did not reset the selection count')
    // Keyboard path: the control is a native checkbox, so Space must select all
    // and Space again must clear it again.
    await page.locator('input[aria-label="全选知识库分类"]').focus()
    await page.keyboard.press('Space')
    await page.waitForTimeout(150)
    const categoryAllText = (await categoryBar.locator('.selection-bar-count').textContent()) ?? ''
    const categoryTotal = Number((categoryAllText.match(/\/ (\d+)$/) ?? [])[1] ?? '0')
    assert(categoryAllText.startsWith(`已选 ${categoryTotal} /`) && categoryTotal >= 1, `Keyboard select-all did not select every category (got "${categoryAllText}")`)
    await page.keyboard.press('Space')
    await page.waitForTimeout(150)
    assert(((await categoryBar.locator('.selection-bar-count').textContent()) ?? '').startsWith('共 '), 'Keyboard select-all toggle did not clear the selection')
    await page.screenshot({ path: path.join(userData, 'project-space-knowledge-smoke.png'), fullPage: true })
    console.log('project-space category controls: ok')

    // Dashboard must explain empty/real data instead of presenting demo cards.
    // The recent-artifacts card was removed: the Agent inbox card is now the
    // only Agent surface and it must be the join of the real inbox table with
    // the real push ledger.
    await clickNav(page, '仪表盘')
    await page.getByRole('heading', { name: '今日工作面' }).waitFor({ state: 'visible', timeout: 20_000 })
    let text = await bodyText(page)
    assert(!text.includes('最近科研产物'), 'Dashboard still renders the removed recent-artifacts card')
    assert(text.includes('Agent 收件箱'), 'Dashboard Agent inbox card missing')
    assert(text.includes('不是演示数据'), 'Dashboard truthfulness explanation missing')
    const inboxRows = page.locator('.dashboard-record-row')
    const inboxRowCount = await inboxRows.count()
    const matchedRows = await page.locator('.dashboard-record-row[data-source-kind="push"]').count()
    const unmatchedRows = await page.locator('.dashboard-record-row[data-source-kind="none"]').count()
    // Every list row is one of exactly two honest shapes: it carries a real
    // ledger entry, or it is explicitly marked as having none. A row can never
    // render an invented source, and the unmatched note must exist whenever an
    // unmatched row is shown.
    assert(inboxRowCount === 0 || matchedRows + unmatchedRows === inboxRowCount, 'Dashboard rows lack a ledger-backed source marker')
    const unmatchedNoteCount = await page.locator('[data-inbox-unmatched-note="true"]').count()
    assert(unmatchedRows === 0 ? unmatchedNoteCount <= 1 : unmatchedNoteCount === 1, `Dashboard unmatched explanation does not match ${unmatchedRows} unmatched rows`)
    console.log(`dashboard truthfulness: ok (${matchedRows} ledger-backed / ${unmatchedRows} unmatched rows)`)

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
    // Task 04: choosing a project in one flow must pre-select it as the default in
    // the next one (most recently used project), while 未分类 stays explicit.
    const agentProjectSelect = page.locator('select[aria-label="在项目中工作"]')
    assert(await agentProjectSelect.count() === 1, 'Agent composer project select missing')
    const firstProjectId = await agentProjectSelect.locator('option').nth(1).getAttribute('value')
    assert(Boolean(firstProjectId), 'Agent composer project select has no project option')
    await agentProjectSelect.selectOption(firstProjectId)
    await page.waitForTimeout(200)
    assert(await agentProjectSelect.inputValue() === firstProjectId, 'Agent composer did not keep the chosen project')
    assert(await agentProjectSelect.locator('option[value=""]').count() === 1, 'Agent composer lost its explicit 未分类 option')
    console.log(`agent selectors: ok (Codex options=${codexModels}, Pi options=${piModels})`)

    // The Agent page exposes two projections of the normalized ledger. The
    // trajectory tab must render its empty state without a run, and switching
    // tabs must not create a conversation or duplicate the runtime controls.
    assert(await page.getByRole('button', { name: '对话', exact: true }).count() === 1, 'Agent conversation tab missing')
    assert(await page.getByRole('button', { name: '轨迹' }).count() === 1, 'Agent trajectory tab missing')
    await page.getByRole('button', { name: '轨迹' }).first().click()
    await page.getByRole('heading', { name: '还没有运行轨迹' }).waitFor({ state: 'visible', timeout: 20_000 })
    await page.screenshot({ path: path.join(userData, 'agent-trajectory-empty-smoke.png'), fullPage: true })
    await page.getByRole('button', { name: '对话', exact: true }).first().click()
    await page.getByRole('heading', { name: '准备好开始了吗？' }).waitFor({ state: 'visible', timeout: 20_000 })
    assert(await page.locator('select[aria-label="模型"]').count() === 1, 'Agent tabs duplicated the model selector')
    assert(await conversationItems.count() === 0, 'Switching Agent tabs created an unexpected conversation')
    console.log('agent conversation/trajectory tabs: ok')

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
    // Task 04: literature search keeps the page boundary explicit instead of
    // advertising a cross-page "全选".
    const resultsBar = page.locator('.selection-bar').filter({ hasText: '全选当前页' })
    assert(await resultsBar.count() === 1, 'Literature results selection bar missing')
    assert((await resultsBar.textContent()).includes('全选仅覆盖当前页筛选后'), 'Literature results selection scope text missing')
    assert(await resultsBar.locator('input[aria-label="全选当前页"]').isDisabled(), 'Literature select-all must stay disabled while the result list is empty')
    const importProjectSelect = page.locator('select[aria-label="导入项目"]').first()
    assert(await importProjectSelect.count() >= 1, 'Literature import-project select missing')
    assert(await importProjectSelect.inputValue() === firstProjectId, 'Literature import-project select did not default to the most recently used project')
    assert(await page.getByRole('button', { name: '下一页' }).count() >= 1, 'Literature next-page action missing')
    text = await bodyText(page)
    assert(text.includes('实时导入预览'), 'Literature live preview panel missing')
    assert(text.includes('未确认前不会触发 Zotero 外部写入'), 'Literature confirmation policy text missing')
    // The action name follows the frozen capability probe: a writable Zotero
    // offers "准备 Zotero 导入" while a read-only connection (for example
    // Zotero 9 without Zotero-Server-ID) must offer the RIS/BibTeX package
    // instead of a write that is guaranteed to fail.
    // Playwright matches a RegExp accessible name against the whole value, so
    // the three capability-driven names are counted explicitly instead.
    let prepareActions = 0
    for (const name of ['准备导入预览', '准备 Zotero 导入', '准备 RIS/BibTeX 导入包']) prepareActions += await page.getByRole('button', { name }).count()
    assert(prepareActions >= 1, `Literature Zotero preview action missing (found ${await page.locator('button[aria-label^="准备"]').count()} prefixed actions)`)
    assert(await page.locator('[data-zotero-capability-action]').count() === 1, 'Literature top-level Zotero capability action missing')
    assert(await page.locator('[data-zotero-permission-entry]').count() >= 2, 'Literature write-permission entry must remain visible in results and Inspector')
    await page.getByRole('tab', { name: /^待分类/ }).click()
    assert(await page.locator('[data-zotero-permission-entry]').count() >= 1, 'Literature write-permission entry must remain visible in staging')
    await page.getByRole('tab', { name: /^检索/ }).click()
    assert(await page.getByRole('button', { name: '确认并写入 Zotero' }).count() === 0, 'Literature must not offer a write before a preview exists')
    assert(await page.getByRole('button', { name: '确认并生成 RIS/BibTeX 导入包' }).count() === 0, 'Literature must not offer a confirmation before a preview exists')
    // The help affordance is a real dialog: it opens by name, carries the
    // four-step import contract, and returns focus to its trigger on Escape.
    const helpTrigger = page.getByRole('button', { name: '文献检索帮助' })
    assert(await helpTrigger.count() === 1, 'Literature help trigger missing')
    await helpTrigger.click()
    const helpDialog = page.getByRole('dialog', { name: '文献检索帮助' })
    await helpDialog.waitFor({ state: 'visible', timeout: 5_000 })
    assert(await helpDialog.getByText('探测能力 → 生成预览 → 明确确认 → 逐条回执', { exact: false }).count() >= 1, 'Literature help dialog content missing')
    await page.keyboard.press('Escape')
    await helpDialog.waitFor({ state: 'hidden', timeout: 5_000 })
    // Radix restores focus after the overlay is torn down, so poll briefly
    // instead of sampling activeElement in the same tick.
    const focusReturned = await page
      .waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '文献检索帮助', undefined, { timeout: 5_000 })
      .then(() => true, () => false)
    assert(focusReturned, `Escape did not return focus to the help trigger (activeElement=${await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? 'none')})`)
    console.log('literature help dialog: ok')
    // Task 03: every literature URL is opened through Main `system.openExternal`
    // with one http/https allowlist. The preload/Main boundary must reject
    // filesystem paths, script protocols and credential URLs before any OS
    // handler is reached, and a rejected attempt must not spawn a window.
    // Deliberately harmless vectors only: none of them targets an existing
    // executable, so a regression cannot launch anything during the smoke run.
    const windowCountBefore = app.windows().length
    const openExternalRejections = await page.evaluate(async () => {
      const candidates = [
        'file:///C:/prw-e2e-disallowed/calc.exe',
        'javascript:alert(1)',
        'ms-msdt:/id PCWDiagnostic',
        'zotero://select/library/items/ABCD1234',
        'https://user:password@example.com/private.pdf'
      ]
      const results = []
      for (const candidate of candidates) {
        const outcome = await Promise.resolve()
          .then(() => window.workbench.v2.system.openExternal(candidate))
          .then(() => 'opened', (error) => String(error && error.message ? error.message : error))
        results.push({ candidate, outcome })
      }
      return results
    })
    for (const { candidate, outcome } of openExternalRejections) {
      assert(outcome !== 'opened', `system.openExternal must reject ${candidate} (got ${outcome})`)
    }
    assert(app.windows().length === windowCountBefore, 'A rejected external URL spawned a new window')
    console.log(`literature external URL allowlist: ok (${openExternalRejections.length} rejected vectors)`)
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
    // Task 04: the Zotero items rail accumulates pages, so its select-all has to
    // say "已加载" rather than implying the whole library is selected.
    const zoteroItemsBar = page.locator('.selection-bar').filter({ hasText: '全选已加载条目' })
    assert(await zoteroItemsBar.count() === 1, 'Zotero items selection bar missing')
    assert((await zoteroItemsBar.textContent()).includes('切换 Collection、查询词或连接会清空已选'), 'Zotero items selection scope text missing')
    // The most recently used project is remembered: choosing it in one flow must
    // pre-select it in the next one, while 未分类 stays an explicit option.
    const zoteroProjectTagSelect = page.locator('select[aria-label="导出项目标签"]')
    assert(await zoteroProjectTagSelect.count() === 1, 'Zotero export project-tag select missing')
    assert(await zoteroProjectTagSelect.inputValue() === firstProjectId, 'Zotero export did not default to the most recently used project')
    assert(await zoteroProjectTagSelect.locator('option[value=""]').count() === 1, 'Zotero export lost its explicit 未分类 option')
    // The item eraser is a real two-sided delete now, so the entry must state the
    // two-sided effect and must never fall back to the old "not implemented" copy.
    const zoteroDeleteEntry = page.getByRole('button', { name: '删除 Zotero 条目' })
    assert(!text.includes('没有实现 Zotero Local/Web API 的条目删除'), 'Zotero delete entry still claims the erase capability is unimplemented')
    if ((await zoteroDeleteEntry.count()) > 0) {
      assert((await page.locator('text=两侧都删').count()) >= 1, 'Zotero delete entry does not state the two-sided effect')
    }
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
    // Task 04: file-level batch selection must be reachable again (the toggle was
    // wired to a state flag no control ever changed) and stays file-scoped.
    const vaultSelectAll = page.locator('input[aria-label="全选当前结果"]')
    assert(await vaultSelectAll.count() === 1, 'Vault file select-all missing')
    assert(await page.locator('input[aria-label^="选择 "]').count() === 0, 'Vault file checkboxes must stay hidden outside batch mode')
    const batchToggle = page.getByRole('button', { name: '进入批量选择' })
    assert(await batchToggle.count() === 1, 'Vault batch-mode entry missing')
    await batchToggle.click()
    await page.waitForTimeout(200)
    const vaultFileCheckboxes = page.locator('input[aria-label^="选择 "]')
    const vaultFileCount = await vaultFileCheckboxes.count()
    assert(vaultFileCount >= 1, 'Vault batch mode did not reveal file checkboxes')
    await vaultFileCheckboxes.first().check()
    await page.waitForTimeout(150)
    const vaultBar = page.locator('.selection-bar').filter({ hasText: '全选当前结果' })
    const vaultCountText = (await vaultBar.locator('.selection-bar-count').textContent()) ?? ''
    // The bar reports the whole file domain (which can include files nested in
    // collapsed folders), so compare against that total instead of the rendered rows.
    const vaultDomainTotal = Number((vaultCountText.match(/\/ (\d+)$/) ?? [])[1] ?? '0')
    assert(vaultCountText.startsWith('已选 1 /') && vaultDomainTotal >= 1, `Vault selection count text missing (got "${vaultCountText}")`)
    const vaultSelectAllState = await vaultSelectAll.evaluate((element) => ({ checked: element.checked, indeterminate: element.indeterminate }))
    // One file is a complete selection; more than one has to render mixed instead
    // of claiming every file is selected.
    assert(vaultDomainTotal === 1 ? vaultSelectAllState.checked === true : vaultSelectAllState.checked === false && vaultSelectAllState.indeterminate === true, `Vault select-all state does not match the ${vaultDomainTotal}-file domain (got ${JSON.stringify(vaultSelectAllState)})`)
    await page.getByRole('button', { name: '退出批量选择' }).click()
    await page.waitForTimeout(200)
    assert(await page.locator('input[aria-label^="选择 "]').count() === 0, 'Leaving batch mode did not hide the file checkboxes')
    // Task 05: the tree context menu is kind-aware, and the controlled
    // frontmatter flow is reachable again (preview → confirm) instead of only
    // existing as unreachable state.
    // The folder row also carries the 空文件夹 marker, so match on a prefix and
    // scope to the tree instead of relying on an exact accessible name.
    const dailyPushFolder = page.locator('.obsidian-tree-scroll').getByRole('button', { name: /每日文献推送/ }).first()
    assert(await dailyPushFolder.count() >= 1, 'Obsidian default folder row missing for the context menu')
    await dailyPushFolder.click({ button: 'right' })
    await page.waitForTimeout(250)
    const treeMenu = page.locator('div.fixed.z-50').first()
    assert(await treeMenu.count() === 1, 'Vault tree context menu did not open')
    let treeMenuText = (await treeMenu.textContent()) ?? ''
    assert(treeMenuText.includes('重命名分类') && treeMenuText.includes('删除空分类'), `Folder context menu lost its category actions (got "${treeMenuText}")`)
    assert(!treeMenuText.includes('直接删除'), `Folder context menu must not offer the file-only delete action (got "${treeMenuText}")`)
    await page.getByRole('heading', { name: 'Obsidian', exact: true }).click()
    await page.waitForTimeout(250)
    assert(await page.locator('div.fixed.z-50').count() === 0, 'Tree context menu stayed open after an outside click')

    const readmeRow = page.locator('.obsidian-tree-scroll div.group').filter({ hasText: 'README.md' }).first()
    assert(await readmeRow.count() === 1, 'README.md tree row missing for the context menu')
    await readmeRow.click({ button: 'right' })
    await page.waitForTimeout(250)
    const noteMenu = page.locator('div.fixed.z-50').first()
    assert(await noteMenu.count() === 1, 'Vault note context menu did not open')
    treeMenuText = (await noteMenu.textContent()) ?? ''
    assert(treeMenuText.includes('新建子笔记') && treeMenuText.includes('加入选择'), `File context menu lost its authoring actions (got "${treeMenuText}")`)
    assert(treeMenuText.includes('绑定项目（预览后写入）') && treeMenuText.includes('取消项目绑定'), `File context menu lost the controlled binding actions (got "${treeMenuText}")`)
    assert(!treeMenuText.includes('删除空分类'), `File context menu must not offer folder-only actions (got "${treeMenuText}")`)
    const bindProjectButton = noteMenu.getByRole('button', { name: /^绑定：/ }).first()
    if (await bindProjectButton.count() === 1) {
      await bindProjectButton.click()
      const metadataDialog = page.getByRole('dialog', { name: '受控 frontmatter 预览' })
      await metadataDialog.waitFor({ state: 'visible', timeout: 10_000 })
      const dialogText = (await metadataDialog.textContent()) ?? ''
      assert(dialogText.includes('项目绑定') && dialogText.includes('changedFields'), `Controlled frontmatter preview lost its controlled diff (got "${dialogText}")`)
      assert(dialogText.includes('保留的未知字段'), 'Controlled frontmatter preview lost the preserved-field report')
      await metadataDialog.getByRole('button', { name: '确认写入' }).click()
      await page.waitForTimeout(900)
      assert(await page.getByText(/已更新 README\.md 的受控 frontmatter/).count() >= 1, 'Controlled frontmatter apply feedback missing')
      assert(await page.getByRole('dialog', { name: '受控 frontmatter 预览' }).count() === 0, 'Controlled frontmatter dialog stayed open after a successful apply')
      // The inspector has to report the controlled binding; the legacy
      // `project:` tag lookup reported 未分类 for every controlled write.
      const bindingSelect = page.locator('select[aria-label="项目绑定"]')
      if (await bindingSelect.count() === 1) {
        const projectOptionValue = await bindingSelect.locator('option', { hasText: 'E2E 分类项目' }).first().getAttribute('value')
        if (projectOptionValue !== null) {
          const selectedBinding = await bindingSelect.inputValue()
          assert(selectedBinding === projectOptionValue, `Obsidian inspector did not reflect the applied project binding (got "${selectedBinding}", expected "${projectOptionValue}")`)
        } else {
          console.log('Obsidian project binding check skipped: E2E project option not rendered')
        }
      }
    } else {
      console.log('Obsidian note binding check skipped: no project option rendered in the note menu')
      await page.getByRole('heading', { name: 'Obsidian', exact: true }).click()
      await page.waitForTimeout(200)
    }
    assert(await page.locator('div.fixed.z-50').count() === 0, 'Vault context menu stayed open after the binding flow')
    await page.screenshot({ path: path.join(userData, 'obsidian-smoke.png'), fullPage: true })
    // Task 05: folding has to be keyboard-operable and stateful in ARIA. The
    // inspector keeps primary metadata visible and folds relation/fingerprint
    // detail behind an explicit aria-expanded toggle.
    const inspectorDisclosure = page.locator('aside .disclosure-summary').filter({ hasText: '关联与版本校验' })
    if (await inspectorDisclosure.count() === 1) {
      assert(await inspectorDisclosure.getAttribute('aria-expanded') === 'false', 'Obsidian inspector disclosure must default to collapsed')
      const panelId = await inspectorDisclosure.getAttribute('aria-controls')
      assert(typeof panelId === 'string' && panelId.length > 0, 'Obsidian inspector disclosure is missing aria-controls')
      await inspectorDisclosure.focus()
      await page.keyboard.press('Enter')
      assert(await inspectorDisclosure.getAttribute('aria-expanded') === 'true', 'Obsidian inspector disclosure did not expand via keyboard')
      assert(await page.locator(`[id="${panelId}"]`).isVisible(), 'Obsidian inspector disclosure panel stayed hidden after expanding')
      await page.keyboard.press('Space')
      assert(await inspectorDisclosure.getAttribute('aria-expanded') === 'false', 'Obsidian inspector disclosure did not collapse via keyboard')
      assert(!(await page.locator(`[id="${panelId}"]`).isVisible()), 'Obsidian inspector disclosure panel stayed visible after collapsing')
    } else {
      console.log('Obsidian inspector disclosure check skipped: no note selected')
    }
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
    // Task 04: the list shares the selection bar and must state that its 全选 only
    // covers the filtered result set, never a fabricated whole-store selection.
    const taskBar = page.locator('.selection-bar').filter({ hasText: '选择当前筛选结果' })
    assert(await taskBar.count() === 1, 'Task list shared selection bar missing')
    assert((await taskBar.textContent()).includes('范围：全选仅覆盖当前筛选结果'), 'Task selection scope text missing')
    const taskRowChecks = page.locator('input[aria-label^="选择任务："]')
    const taskRowCount = await taskRowChecks.count()
    assert(taskRowCount >= 1, 'Task list rendered no selectable rows')
    await taskRowChecks.first().check()
    await page.waitForTimeout(150)
    const taskCountText = (await taskBar.locator('.selection-bar-count').textContent()) ?? ''
    const taskDomainTotal = Number((taskCountText.match(/\/ (\d+)$/) ?? [])[1] ?? '0')
    assert(taskCountText.startsWith('已选 1 /') && taskDomainTotal >= 1, `Task selection count text missing (got "${taskCountText}")`)
    const taskSelectAllState = await page.locator('input[aria-label="选择当前筛选结果"]').evaluate((element) => ({ checked: element.checked, indeterminate: element.indeterminate }))
    assert(taskDomainTotal === 1 ? taskSelectAllState.checked === true : taskSelectAllState.checked === false && taskSelectAllState.indeterminate === true, `Task select-all must mirror a partial row selection (domain=${taskDomainTotal}, got ${JSON.stringify(taskSelectAllState)})`)
    await taskBar.getByRole('button', { name: '清除选择' }).click()
    await page.waitForTimeout(150)
    assert((await taskBar.locator('.selection-bar-count').textContent()).startsWith('共 '), 'Task clear action did not reset the selection count')
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
    // Settings → 工具连接: connection records expose the shared select-all /
    // clear / bulk delete bar, with an exact scope sentence and a per-row
    // delete affordance. An empty list must stay disabled rather than claim a
    // bulk action over zero rows.
    await page.getByRole('button', { name: '工具连接' }).click()
    await page.waitForTimeout(450)
    const connectorBar = page.locator('.selection-bar[aria-label="连接记录批量操作"]')
    assert(await connectorBar.count() === 1, 'Connection bulk delete bar missing')
    const connectorBarText = await connectorBar.innerText()
    assert(connectorBarText.includes('全选仅覆盖'), 'Connection selection scope text missing')
    assert(connectorBarText.includes('本列表无分页、无筛选'), 'Connection selection scope boundary missing')
    assert(/共 \d+|已选 \d+/.test(connectorBarText), 'Connection selection count missing')
    const connectionRowCount = await page.locator('.settings-row').count()
    if (connectionRowCount === 0) {
      assert(await connectorBar.getByLabel('全选当前列表连接记录').isDisabled(), 'Empty connection list must disable select-all')
      assert(await connectorBar.getByRole('button', { name: '删除选中的 0 条连接记录' }).isDisabled(), 'Empty connection list must disable bulk delete')
    } else {
      assert(await page.locator('input[aria-label^="选择连接："]').count() === connectionRowCount, 'Per-row connection checkbox missing')
      assert(await page.locator('button[aria-label^="删除连接："]').count() === connectionRowCount, 'Per-row connection delete missing')
    }
    console.log('connection bulk delete bar: ok')

    // Schedule is seeded once, defaults enabled, and can be paused/resumed.
    await clickNav(page, '定时任务')
    await page.waitForFunction(() => !document.body.innerText.includes('正在读取定时任务') && document.body.innerText.includes('Last 30 days'), null, { timeout: 30_000 })
    text = await bodyText(page)
    assert((text.match(/Last 30 days/g) || []).length >= 1, 'Built-in Last 30 days schedule missing')
    assert(text.includes('每天') && text.includes('09:00'), 'Daily 09:00 schedule semantics missing')
    // Daily push naming and rule fields must be visible and drift-free: the
    // frozen shared default (skill last30days, topic AI 最新资讯, zh-CN, 30 days)
    // owns the schedule surface, and 每日文献推送 stays an Obsidian layout
    // category (checked on the Obsidian page) instead of a second schedule folder.
    assert(text.includes('每日资讯推送'), 'Daily push output folder missing from the schedule card')
    assert(!text.includes('每日文献推送'), 'Schedule surface still shows the legacy 每日文献推送 folder')
    assert(text.includes('来源 全部可用'), 'Daily push source scope missing from the schedule card')
    assert(text.includes('近 30 天'), 'Daily push lookback window missing from the schedule card')
    assert(text.includes('AI 最新资讯'), 'Daily push topic missing from the schedule card')
    assert(text.includes('简体中文'), 'Daily push response language missing from the schedule card')
    // The shipped schedule surface is exactly the three frozen
    // DEFAULT_AGENT_SCHEDULE_RULES entries, all enabled, so a fresh install can
    // neither silently lose a default rule nor grow a duplicate.
    const scheduleCards = page.locator('.schedule-card')
    assert(await scheduleCards.count() === 3, `Expected exactly 3 default schedules, got ${await scheduleCards.count()}: ${await scheduleCards.allInnerTexts()}`)
    assert(text.includes('3 个任务'), 'Default schedule count badge is not exactly 3')
    const scheduleCardTexts = await scheduleCards.allInnerTexts()
    for (const [skillKey, topic, outputFolder] of [['last30days', 'AI 最新资讯', '每日资讯推送'], ['literature-matrix', '长上下文检索', '文献矩阵'], ['literature-review-push', '长上下文检索', '文献综述']]) {
      const card = scheduleCardTexts.find((value) => value.includes(`技能 ${skillKey} ·`))
      assert(card !== undefined, `Default schedule for ${skillKey} missing: ${scheduleCardTexts.join(' | ')}`)
      assert(card.includes('已启用'), `Default schedule ${skillKey} is not enabled: ${card}`)
      assert(card.includes(`主题 ${topic}`) && card.includes(outputFolder), `Default schedule ${skillKey} fields drifted: ${card}`)
    }
    await page.getByRole('button', { name: '新建定时任务' }).click()
    assert(await page.getByRole('heading', { name: '新建定时任务', exact: true }).count() === 1, 'Schedule editor panel missing')
    assert((await bodyText(page)).includes('每日推送正文使用简体中文'), 'Last30days Chinese output guidance missing')
    assert((await bodyText(page)).includes('能力预检'), 'Capability preflight guidance missing from the schedule editor')
    assert(await page.getByLabel('来源（逗号分隔，留空＝全部可用）').count() === 1, 'Daily push source field missing')
    assert(await page.getByLabel('回看天数').count() === 1, 'Daily push lookback field missing')
    assert(await page.getByLabel('研究主题').count() === 1, 'Daily push topic field missing')
    assert(await page.getByLabel('回复语言').count() === 1, 'Daily push response language field missing')
    assert(await page.getByLabel('输出目录').count() === 1, 'Daily push output folder field missing')
    // Editor defaults must come from the frozen shared contract, not a second
    // renderer-side literal.
    assert(await page.locator('#schedule-skill').inputValue() === 'last30days', 'Schedule editor skill default drifted')
    assert(await page.locator('#schedule-topic').inputValue() === 'AI 最新资讯', 'Schedule editor topic default drifted')
    assert(await page.locator('#schedule-lookback').inputValue() === '30', 'Schedule editor lookback default drifted')
    assert(await page.locator('#schedule-language').inputValue() === 'zh-CN', 'Schedule editor language default drifted')
    assert(await page.locator('#schedule-output-folder').inputValue() === '每日资讯推送', 'Schedule editor output folder default drifted')
    // Both project-owned instruction skills are installed under the canonical
    // `.agents/skills` source and therefore selectable. Missing/unknown keys are
    // still blocked by the registry at run time; this assertion only checks the
    // editor's discovered catalog.
    for (const skillKey of ['literature-matrix', 'literature-review-push']) {
      const skillOption = page.locator(`#schedule-skill option[value="${skillKey}"]`)
      assert(await skillOption.count() === 1, `Installed skill key missing from the schedule editor: ${skillKey}`)
      assert(!(await skillOption.isDisabled()), `Installed skill must be selectable: ${skillKey}`)
      assert(!((await skillOption.textContent()) || '').includes('未安装'), `Installed skill is incorrectly labelled not installed: ${skillKey}`)
    }
    const selectableSkillKeys = await page.locator('#schedule-skill').evaluate((select) => Array.from(select.options).filter((option) => !option.disabled).map((option) => option.value))
    assert(JSON.stringify(selectableSkillKeys) === JSON.stringify(['', 'last30days', 'literature-matrix', 'literature-review-push']), `Unexpected selectable skills: ${JSON.stringify(selectableSkillKeys)}`)
    // The custom directory is the same stored field as the dropdown, checked by
    // the shared safety predicate before anything is sent.
    await page.locator('#schedule-output-folder').selectOption('__custom__')
    assert(await page.locator('#schedule-custom-output-folder').count() === 1, 'Custom output directory input missing')
    await page.locator('#schedule-custom-output-folder').fill('../escape')
    await page.locator('#schedule-custom-output-folder').blur()
    await page.waitForFunction(() => document.body.innerText.includes('上级穿越'), null, { timeout: 5_000 })
    await page.locator('#schedule-custom-output-folder').fill('每日资讯推送/AI')
    await page.waitForTimeout(150)
    assert(await page.locator('#schedule-custom-output-folder').inputValue() === '每日资讯推送/AI', 'Custom output directory not bound to the stored folder field')
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
    // Recent-run projection: the Automation page must expose the occurrence, the
    // blocked reason, the Artifact and the Obsidian delivery state of each run.
    assert(await page.getByRole('heading', { name: '最近运行', exact: true }).count() === 1, 'Automation run-history panel missing')
    const historyText = await bodyText(page)
    assert(historyText.includes('尚无定时运行记录') || historyText.includes('阻断/失败原因'), 'Automation run-history empty state and rows both missing')
    assert(historyText.includes('尚无定时运行记录') || (historyText.includes('Artifact：') && historyText.includes('Obsidian：')), 'Automation run-history Artifact/Obsidian delivery projection missing')
    await page.screenshot({ path: path.join(userData, 'schedule-smoke.png'), fullPage: true })
    console.log('schedule default/daily/pause-enable: ok')

    // --- Task 08: cross-module UI/UX + responsive/release acceptance --------
    // The packaged window clamps to `minWidth: 1080`, so widths below that are
    // forced through the BrowserWindow API here. They verify the CSS/React
    // contract for narrow viewports, not a window size a user can reach in the
    // shipped app (the Task 08 doc records them as CSS-level evidence). The
    // production minimum size is restored before the run ends.
    const setWindowWidth = async (width, height = 880) => {
      await app.evaluate(async ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) return
        win.setMinimumSize(320, 400)
        win.setSize(size.width, size.height)
      }, { width, height })
      await page.waitForTimeout(450)
      return page.evaluate(() => window.innerWidth)
    }
    const restoreWindowMinimum = async () => {
      await app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) return
        win.setMinimumSize(1080, 680)
        win.setSize(1440, 920)
      })
      await page.waitForTimeout(400)
    }
    // Navigation by nav-item title, so the sweep also works on the narrow rail
    // where CSS hides the visible label.
    const openPage = async (label) => {
      const item = page.locator(`.sidebar .nav-item[title="${label}"]`).first()
      assert(await item.count() === 1, `Nav item missing: ${label}`)
      await item.click()
      await page.locator('main').waitFor({ state: 'visible', timeout: 20_000 })
      await page.waitForTimeout(350)
    }
    // Every interactive control must sit inside the viewport and the document
    // itself must not gain a horizontal scrollbar. Controls inside an
    // intentional horizontal scroller (for example the Tasks kanban board) are
    // exempt, because that overflow is the designed affordance.
    const measureOverflow = () => page.evaluate(() => {
      const vw = window.innerWidth
      const offenders = []
      for (const node of document.querySelectorAll('button, a, input, select, textarea, [role="tab"], [role="checkbox"]')) {
        const rect = node.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) continue
        const style = getComputedStyle(node)
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue
        let ancestor = node.parentElement
        let insideScroller = false
        while (ancestor && ancestor !== document.body) {
          const ancestorStyle = getComputedStyle(ancestor)
          if ((ancestorStyle.overflowX === 'auto' || ancestorStyle.overflowX === 'scroll') && ancestor.scrollWidth > ancestor.clientWidth + 1) {
            insideScroller = true
            break
          }
          ancestor = ancestor.parentElement
        }
        if (insideScroller) continue
        if (rect.right > vw + 1 || rect.left < -1) {
          offenders.push(`${node.tagName.toLowerCase()}[${(node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 24)}]`)
        }
      }
      return {
        vw,
        horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        offenders
      }
    })
    const responsiveLabels = ['仪表盘', '日历', '任务', '项目空间', '文献检索', 'Obsidian', 'Zotero', 'Agent', '定时任务', '设置']
    for (const width of [1440, 1080, 720, 320]) {
      await setWindowWidth(width)
      for (const label of responsiveLabels) {
        await openPage(label)
        const overflow = await measureOverflow()
        assert(overflow.horizontalOverflow <= 1, `${label} at ${overflow.vw}px: document scrolls horizontally by ${overflow.horizontalOverflow}px`)
        assert(overflow.offenders.length === 0, `${label} at ${overflow.vw}px: interactive controls outside the viewport: ${overflow.offenders.join(', ')}`)
      }
    }
    console.log('responsive overflow sweep (1440/1080/720/320): ok')

    // Narrow sidebar: the collapse control must change layout state instead of
    // flipping aria-pressed on a rail that CSS had already collapsed, and the
    // opened drawer has to reveal labels, dim the workspace and close again.
    await setWindowWidth(720)
    await openPage('仪表盘')
    const railWidth = () => page.evaluate(() => Math.round(document.querySelector('.sidebar').getBoundingClientRect().width))
    const railLabelVisible = () => page.evaluate(() => {
      const label = document.querySelector('.sidebar .sidebar-label')
      if (!label) return false
      const rect = label.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })
    const sidebarToggle = page.locator('button[aria-label="折叠侧栏"], button[aria-label="展开侧栏"]').first()
    assert(await sidebarToggle.getAttribute('aria-pressed') === 'true', 'Narrow viewport must report the navigation rail as collapsed')
    assert(await sidebarToggle.getAttribute('aria-expanded') === 'false', 'Collapsed rail must report aria-expanded=false')
    assert(await railWidth() <= 80, `Narrow rail width unexpected: ${await railWidth()}`)
    assert(await railLabelVisible() === false, 'Narrow rail must not render full labels')
    await sidebarToggle.click()
    await page.waitForTimeout(350)
    assert(await sidebarToggle.getAttribute('aria-pressed') === 'false', 'Opened drawer must report aria-pressed=false')
    assert(await sidebarToggle.getAttribute('aria-expanded') === 'true', 'Opened drawer must report aria-expanded=true')
    assert(await railWidth() >= 180, `Drawer did not expand (width=${await railWidth()})`)
    assert(await railLabelVisible() === true, 'Drawer must reveal navigation labels')
    assert(await page.getByRole('button', { name: '关闭导航抽屉' }).count() === 1, 'Drawer scrim missing')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    assert(await railWidth() <= 80, 'Escape did not close the navigation drawer')
    await sidebarToggle.click()
    await page.waitForTimeout(300)
    await openPage('任务')
    assert(await railWidth() <= 80, 'Navigating from the drawer must close it again')
    console.log('narrow sidebar drawer semantics: ok')

    // The help entry has to stay visible and actionable at the narrowest
    // supported width instead of being clipped by the page header.
    await setWindowWidth(320)
    await openPage('文献检索')
    const narrowHelpTrigger = page.getByRole('button', { name: '文献检索帮助' })
    assert(await narrowHelpTrigger.isVisible(), 'Help entry must stay visible at 320px')
    const narrowHelpBox = await narrowHelpTrigger.boundingBox()
    const narrowViewportWidth = await page.evaluate(() => window.innerWidth)
    assert(
      narrowHelpBox && narrowHelpBox.x >= -1 && narrowHelpBox.x + narrowHelpBox.width <= narrowViewportWidth + 1,
      `Help entry is clipped at 320px (${JSON.stringify(narrowHelpBox)} inside ${narrowViewportWidth}px)`
    )
    await narrowHelpTrigger.click()
    await page.getByRole('dialog', { name: '文献检索帮助' }).waitFor({ state: 'visible', timeout: 5_000 })
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: '文献检索帮助' }).waitFor({ state: 'hidden', timeout: 5_000 })
    console.log('help entry visible/actionable at 320px: ok')

    await restoreWindowMinimum()

    // Embedded Matrix must not nest a second page scroller: the host page keeps
    // the only `.page-scroll`, so the wheel never fights two containers.
    await openPage('项目空间')
    const projectSelect = page.locator('select[aria-label="选择项目空间"]')
    const projectOptionValues = await projectSelect.locator('option').evaluateAll((options) => options.map((option) => option.value).filter(Boolean))
    if (projectOptionValues.length > 0) {
      await projectSelect.selectOption(projectOptionValues[0])
      await page.getByRole('tab', { name: '文献矩阵' }).click()
      await page.waitForTimeout(700)
      const matrixLayout = await page.evaluate(() => ({
        pageScrollers: document.querySelectorAll('.page-scroll').length,
        embeddedRoots: document.querySelectorAll('.matrix-embedded').length,
        embeddedScrollers: [...document.querySelectorAll('.matrix-embedded')].filter((node) => node.scrollHeight > node.clientHeight + 1).length
      }))
      assert(matrixLayout.embeddedRoots === 1, `Project Space 文献矩阵 did not render embedded (found ${matrixLayout.embeddedRoots} .matrix-embedded roots)`)
      assert(matrixLayout.pageScrollers === 1, `Project Space 文献矩阵 nested ${matrixLayout.pageScrollers} .page-scroll containers`)
      assert(matrixLayout.embeddedScrollers === 0, 'Embedded matrix root owns its own scroll container')
      console.log('embedded matrix single-scroller: ok')
    } else {
      console.log('embedded matrix single-scroller: skipped (isolated profile has no project)')
    }

    // Long-content contract: the Inspector and the Agent thread own the vertical
    // scroll and stay bounded by the viewport, so long records scroll inside the
    // pane instead of growing the window content.
    const assertScrollablePane = (name, probe) => {
      assert(!probe.missing, `${name} scroll container missing`)
      assert(probe.overflowY === 'auto' || probe.overflowY === 'scroll', `${name} is not a scroll container (overflow-y: ${probe.overflowY})`)
      assert(probe.scrollTop > 0, `${name} did not scroll long content (scrollTop=${probe.scrollTop})`)
      assert(probe.clientHeight > 0 && probe.clientHeight <= probe.viewportHeight, `${name} is not bounded by the viewport (${probe.clientHeight} of ${probe.viewportHeight})`)
    }
    const probeScrollablePane = (selector) => page.evaluate(async (sel) => {
      const scroller = document.querySelector(sel)
      if (!scroller) return { missing: true }
      const overflowY = getComputedStyle(scroller).overflowY
      const filler = document.createElement('div')
      filler.setAttribute('data-e2e-probe', 'long-content')
      filler.style.height = '4000px'
      // The Agent thread is a flex column, so the filler must not be allowed to
      // shrink back into the container; otherwise no overflow is produced and
      // the probe would silently test nothing.
      filler.style.flex = '0 0 auto'
      filler.style.minHeight = '4000px'
      scroller.append(filler)
      // The Agent thread scrolls smoothly, so wait for the animated scroll to
      // report a position instead of sampling scrollTop in the same tick.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      scroller.scrollTop = 999999
      await new Promise((resolve) => setTimeout(resolve, 200))
      const probe = {
        overflowY,
        clientHeight: Math.round(scroller.clientHeight),
        scrollHeight: Math.round(scroller.scrollHeight),
        scrollTop: Math.round(scroller.scrollTop),
        viewportHeight: window.innerHeight
      }
      filler.remove()
      return probe
    }, selector)
    await openPage('文献检索')
    assertScrollablePane('literature Inspector', await probeScrollablePane('.literature-inspector-scroll'))
    await openPage('Agent')
    assertScrollablePane('Agent thread', await probeScrollablePane('.agent-thread-messages'))
    console.log('long-content scroll contract (Inspector/Agent): ok')

    // Screenshot set required by the Task 08 doc. A fresh isolated profile is
    // intentionally empty, so these capture the real shell and empty states.
    for (const width of [1440, 1280, 1050, 768, 320]) {
      await setWindowWidth(width)
      await openPage('仪表盘')
      await page.screenshot({ path: path.join(userData, `shell-${width}.png`) })
    }
    await restoreWindowMinimum()
    console.log(`responsive screenshots: ${path.join(userData, 'shell-<width>.png')}`)

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
