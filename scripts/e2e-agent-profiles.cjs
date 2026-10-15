/* Real Renderer/Preload/Core smoke with a fresh isolated profile and no keys.
 * This is not an NSIS/installed-application acceptance test. */
const { _electron: electron } = require('playwright-core')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const main = path.join(root, 'apps', 'desktop', 'out', 'main', 'index.cjs')
const executablePath = process.env.PRW_ELECTRON || path.join(root, 'node_modules', '.pnpm', 'electron@43.4.1', 'node_modules', 'electron', 'dist', 'electron.exe')
const zoomProfile = process.env.PRW_AGENT_PROFILE_ZOOM_PROFILE
const paletteOnly = process.argv.includes('--palette-only')
assert(!(zoomProfile && paletteOnly), 'Palette sanity must use a fresh isolated profile, not supplemental evidence')
const profile = zoomProfile ? path.resolve(zoomProfile) : fs.mkdtempSync(path.join(os.tmpdir(), 'prw-agent-profiles-e2e-'))
if (zoomProfile) {
  assert.equal(path.dirname(profile).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase(), 'Supplemental screenshots require an isolated temp profile')
  assert(/^prw-agent-profiles-e2e-/.test(path.basename(profile)) && fs.existsSync(path.join(profile, 'agent-profiles-evidence.json')), 'Missing original isolated profile evidence')
}
const errors = []
const evidence = { installedNsis: false, realProviderCalls: false, liveTeamCancellation: 'NOT RUN: missing credentials make the real child fail immediately; no mocked success or live provider used', profile, workflows: [], screenshots: [] }
const capturedWindows = new WeakSet()
let app
let page
let acceptNextDialog = true

async function launch() {
  const env = { ...process.env, PRW_LAST30DAYS_SKILL_PATH: path.join(root, '.agents', 'skills', 'last30days', 'skills', 'last30days', 'SKILL.md') }
  delete env.OBSIDIAN_DIR
  delete env.ELECTRON_RENDERER_URL
  delete env.PRW_E2E_USER_DATA
  app = await electron.launch({ executablePath, args: [main, `--prw-user-data-dir=${profile}`], cwd: profile, env, timeout: 90_000 })
  const capture = (window) => {
    if (capturedWindows.has(window)) return
    capturedWindows.add(window)
    window.on('pageerror', (error) => errors.push(error.message))
    window.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    window.on('dialog', async (dialog) => { if (acceptNextDialog) await dialog.accept(); else await dialog.dismiss() })
  }
  app.on('window', capture)
  page = await app.firstWindow({ timeout: 90_000 })
  capture(page)
  page.setDefaultTimeout(20_000)
  await page.locator('.sidebar .nav-item[title="设置"]').waitFor()
  assert(page.url().startsWith('workbench://app/'), 'Unexpected renderer origin')
  assert.deepEqual(await page.evaluate(() => ({ node: typeof process, require: typeof require, ipc: typeof window.ipcRenderer })), { node: 'undefined', require: 'undefined', ipc: 'undefined' })
}

async function nav(label) {
  const target = page.locator(`.sidebar .nav-item[title="${label}"]`).first()
  if (!(await target.isVisible())) await page.locator('button[aria-controls="sidebar-research-nav"]').click()
  await target.click()
  await page.locator('main').waitFor()
}

async function tab(label) {
  await page.getByRole('navigation', { name: '设置分区侧边栏', exact: true }).getByRole('button', { name: label, exact: true }).click()
}

async function checkSettingsNavigation() {
  const sidebar = page.getByRole('navigation', { name: '设置分区侧边栏', exact: true })
  const sections = [
    ['通用', '通用'], ['工作区与数据', '工作区与数据'], ['文献检索', '文献检索'],
    ['科研工作', '科研工作（旧侧车已退休）'], ['代理', '统一网络代理'],
    ['工具连接', 'Obsidian · Zotero · Notion'], ['RSS 来源', 'RSS 订阅源（每日文献推送）'],
    ['模型与 Agent', '模型与 Agent'], ['AI 助手', 'AI 助手'], ['协作团队', '协作团队'],
    ['工具与 MCP 绑定', '工具与 MCP 绑定'], ['技能绑定', '技能绑定'],
    ['知识引擎', '知识引擎'], ['MCP Server', 'MCP Server'], ['安全与审计', '安全与审计'], ['关于与更新', '关于与更新']
  ]
  assert.equal(await sidebar.locator('.settings-nav-item').count(), 16, 'Some settings sections are missing from the left navigation')
  assert.equal(await page.locator('.settings-workspace .research-tabs').count(), 0, 'Settings must not use a top tab strip')
  for (const [label, heading] of sections) {
    await tab(label)
    assert.equal(await sidebar.getByRole('button', { name: label, exact: true }).getAttribute('aria-current'), 'page', `Missing active state for ${label}`)
    await page.locator('#settings-section-content').getByRole('heading', { name: heading, exact: true }).waitFor()
    if (label === '科研工作') {
      const state = await page.evaluate(() => window.workbench.v2.sidecar.state())
      assert.equal(state.phase, 'error', 'Retired sidecar compatibility endpoint did not report unavailable')
      assert.equal(state.port, null, 'Retired sidecar exposed a running port')
      await page.locator('#settings-section-content').getByText('旧 Python 科研工作侧车已退休，不可启动。', { exact: true }).waitFor()
      assert.equal(await page.locator('#settings-section-content').getByRole('button', { name: /打开|停止/ }).count(), 0, 'Retired sidecar exposes executable controls')
      evidence.legacySidecar = { phase: state.phase, started: false, sourceRestored: false }
    }
  }
  const general = sidebar.getByRole('button', { name: '通用', exact: true })
  const about = sidebar.getByRole('button', { name: '关于与更新', exact: true })
  await about.focus()
  await page.keyboard.press('Home')
  assert(await general.evaluate((node) => node === document.activeElement), 'Home did not focus the first settings section')
  await page.keyboard.press('Enter')
  assert.equal(await general.getAttribute('aria-current'), 'page', 'Enter did not activate the focused first section')
  await page.keyboard.press('End')
  assert(await about.evaluate((node) => node === document.activeElement), 'End did not focus the last settings section')
  await page.keyboard.press('Enter')
  assert.equal(await about.getAttribute('aria-current'), 'page', 'Enter did not activate the focused last section')
  await page.keyboard.press('ArrowUp')
  assert(await sidebar.getByRole('button', { name: '安全与审计', exact: true }).evaluate((node) => node === document.activeElement), 'ArrowUp did not move settings navigation focus')
  await page.keyboard.press('ArrowDown')
  assert(await about.evaluate((node) => node === document.activeElement), 'ArrowDown did not restore settings navigation focus')
  evidence.workflows.push('All 16 sections are left sidebar navigation, no top tabs; Home/End/ArrowUp/ArrowDown plus Enter activate sections; legacy sidecar remains stopped')
}

async function waitForTruth(predicate, message) {
  const end = Date.now() + 30_000
  while (Date.now() < end) {
    const value = await page.evaluate(predicate)
    if (value) return value
    await page.waitForTimeout(150)
  }
  throw new Error(message)
}

async function createAssistant(name) {
  await page.getByRole('button', { name: '新建助手', exact: true }).click()
  await page.getByLabel('助手名称', { exact: true }).fill(name)
  await page.getByLabel('用途说明', { exact: true }).fill('隔离 UI 验证，无真实凭据或个人数据。')
  await page.getByLabel('系统指令', { exact: true }).fill('只读取已授权研究记录，不创建或修改外部内容。')
  const catalog = await page.evaluate(() => window.workbench.agent.models.catalog())
  const provider = catalog.find((entry) => entry.models.length > 0)
  assert(provider, 'Embedded model catalog is empty')
  await page.getByLabel('Provider', { exact: true }).selectOption(provider.provider)
  await page.getByLabel('模型', { exact: true }).selectOption(provider.models[0].id)
  await page.getByRole('button', { name: '保存助手', exact: true }).click()
  await page.getByText('助手已保存；下一次启动使用此版本。', { exact: true }).waitFor()
  return await page.evaluate(async (label) => (await window.workbench.v2.assistants.list()).find((assistant) => assistant.name === label), name)
}

async function setSize(width, height) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setMinimumSize(320, 400)
    window.setSize(size.width, size.height)
  }, { width, height })
  await page.waitForTimeout(250)
}

async function checkOverflow() {
  return await page.evaluate(() => {
    const width = window.innerWidth
    const offenders = []
    for (const node of document.querySelectorAll('button,input,select,textarea')) {
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') continue
      let parent = node.parentElement
      let scroller = false
      while (parent && parent !== document.body) {
        const css = getComputedStyle(parent)
        if (['auto', 'scroll'].includes(css.overflowX) && parent.scrollWidth > parent.clientWidth + 1) { scroller = true; break }
        parent = parent.parentElement
      }
      if (!scroller && (rect.left < -1 || rect.right > width + 1)) offenders.push(node.getAttribute('aria-label') || node.tagName)
    }
    return { width, documentOverflow: document.documentElement.scrollWidth > width + 1, offenders }
  })
}

async function screenshot(name, resetTop = true) {
  const filename = `${name}.png`
  if (resetTop) await page.locator('.page-scroll').evaluateAll((nodes) => nodes.forEach((node) => { node.scrollTop = 0 }))
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.waitForTimeout(80)
  // CDP clips zoomed Electron screenshots in CSS pixels. Capture the actual
  // compositor for all evidence so every image covers the user's viewport.
  const capture = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(profile, filename), Buffer.from(capture, 'base64'))
  const overflow = await checkOverflow()
  assert.equal(overflow.documentOverflow, false, `${name}: document horizontal overflow`)
  assert.deepEqual(overflow.offenders, [], `${name}: clipped controls`)
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio }))
  const png = fs.readFileSync(path.join(profile, filename))
  const imageSize = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
  assert(Math.abs(imageSize.width - viewport.width * viewport.devicePixelRatio) <= 3, 'Screenshot does not cover the actual physical viewport width')
  assert(Math.abs(imageSize.height - viewport.height * viewport.devicePixelRatio) <= 3, 'Screenshot does not cover the actual physical viewport height')
  evidence.screenshots.push({ filename, viewport, imageSize, overflow })
}

async function bindingMatrix(mode) {
  await tab(mode === 'tools' ? '工具与 MCP 绑定' : '技能绑定')
  await page.getByRole('button', { name: '跨助手矩阵', exact: true }).click()
  await page.getByRole('button', { name: '重新载入矩阵', exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '重新载入矩阵', exact: true }).evaluate((node) => node.scrollIntoView({ block: 'nearest' }))
  await page.waitForFunction(() => !document.querySelector('.agent-binding-matrix-footer button:last-of-type')?.disabled)
}

async function saveMatrix() {
  await page.getByRole('button', { name: '保存矩阵', exact: true }).click()
  await page.getByText('矩阵已原子保存；下次运行使用新绑定，已有运行保持冻结快照。', { exact: true }).waitFor()
  await page.waitForFunction(() => !document.querySelector('.agent-binding-matrix-footer button:last-of-type')?.disabled)
}

async function matrixWorkflow(mode, director, reviewer) {
  await bindingMatrix(mode)
  const data = await page.evaluate(() => window.workbench.v2.agentBindings.matrix())
  const key = mode === 'tools' ? data.catalog.tools.find((tool) => tool.kind === 'read').name : data.catalog.skills[0]?.key
  assert(key, `${mode}: real binding catalog is empty`)
  const field = mode === 'tools' ? 'toolAllowlist' : 'skillKeys'
  const cell = (id) => page.getByRole('checkbox', { name: `绑定 ${id} ${key}`, exact: true })
  const before = data.assistants.filter((assistant) => [director.id, reviewer.id].includes(assistant.id))
  await page.getByLabel('查找绑定能力', { exact: true }).fill(key)
  await page.getByRole('button', { name: `关闭能力全部助手 ${key}`, exact: true }).click()
  await page.getByRole('button', { name: `启用能力全部助手 ${key}`, exact: true }).click()
  assert(await cell(director.id).isChecked() && await cell(reviewer.id).isChecked(), 'Row enable did not update both draft cells')
  const persistedBefore = await page.evaluate(() => window.workbench.v2.assistants.list())
  for (const assistant of before) assert.deepEqual(persistedBefore.find((item) => item.id === assistant.id)[field], assistant[field], 'Unchecked draft already changed persisted authorization')
  acceptNextDialog = false
  await page.getByRole('button', { name: '重新载入矩阵', exact: true }).click()
  assert(await cell(reviewer.id).isChecked(), 'Dismissed reload lost draft')
  await page.getByRole('button', { name: '单助手编辑', exact: true }).click()
  assert(await cell(reviewer.id).isChecked(), 'Dismissed view switch lost draft')
  acceptNextDialog = true
  await saveMatrix()
  const first = await page.evaluate(() => window.workbench.v2.assistants.list())
  for (const id of [director.id, reviewer.id]) assert(first.find((assistant) => assistant.id === id)[field].includes(key), 'Saved enable not persisted')
  await page.getByRole('button', { name: `关闭助手全部绑定 ${director.id}`, exact: true }).click()
  assert(!(await cell(director.id).isChecked()), 'Filtered column disable failed')
  await saveMatrix()
  const disabled = await page.evaluate(() => window.workbench.v2.assistants.list())
  assert(!disabled.find((assistant) => assistant.id === director.id)[field].includes(key) && disabled.find((assistant) => assistant.id === reviewer.id)[field].includes(key), 'Mixed saved enable/disable state wrong')

  // Freeze two revisions in a draft, then change one through the actual IPC.
  await cell(director.id).check()
  await cell(reviewer.id).uncheck()
  await page.evaluate(async (id) => {
    const { archivedAt, createdAt, updatedAt, revision, ...fields } = (await window.workbench.v2.assistants.list()).find((assistant) => assistant.id === id)
    await window.workbench.v2.assistants.save({ ...fields, description: '矩阵并发更新', expectedRevision: revision })
  }, director.id)
  await page.getByRole('button', { name: '保存矩阵', exact: true }).click()
  await page.locator('.agent-binding-matrix-footer .form-feedback-error').waitFor()
  assert(await cell(director.id).isChecked() && !(await cell(reviewer.id).isChecked()), 'CAS failure lost matrix draft')
  const afterFailure = await page.evaluate(() => window.workbench.v2.assistants.list())
  for (const assistant of disabled) assert.deepEqual(afterFailure.find((item) => item.id === assistant.id)[field], assistant[field], 'Failed atomic CAS partially granted or removed capabilities')
  await page.getByRole('button', { name: '重新载入矩阵', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.agent-binding-matrix-footer button:last-of-type')?.disabled)
  assert(!(await cell(director.id).isChecked()) && await cell(reviewer.id).isChecked(), 'Reload did not restore committed mixed state')
  await page.getByLabel('查找绑定能力', { exact: true }).fill('')

  if (mode === 'tools') {
    const write = data.catalog.tools.find((tool) => tool.kind !== 'read')
    assert(write, 'Catalog lacks policy test tool')
    assert(await page.getByRole('checkbox', { name: `绑定 ${director.id} ${write.name}`, exact: true }).isDisabled(), 'Read-only policy cell was enabled')
  }
  const rejection = await page.evaluate(async ({ id, key, mode }) => {
    const current = (await window.workbench.v2.assistants.list()).find((assistant) => assistant.id === id)
    try { await window.workbench.v2.agentBindings.set({ assistantId: id, expectedRevision: current.revision, kind: mode === 'tools' ? 'tool' : 'skill', key: 'unknown.invalid.smoke', enabled: true }); return false } catch { return true }
  }, { id: director.id, key, mode })
  assert(rejection, 'Unknown single-cell enable showed success')
  const invalidBulk = await page.evaluate(async ({ a, b, field, key }) => {
    const items = await window.workbench.v2.assistants.list()
    const first = items.find((assistant) => assistant.id === a)
    const second = items.find((assistant) => assistant.id === b)
    try { await window.workbench.v2.agentBindings.saveMatrix({ updates: [{ assistantId: a, expectedRevision: first.revision, [field]: [...first[field], key] }, { assistantId: b, expectedRevision: second.revision, [field]: ['unknown.invalid.smoke'] }] }); return false } catch { return true }
  }, { a: director.id, b: reviewer.id, field, key })
  assert(invalidBulk, 'Invalid bulk showed success')
  const afterInvalid = await page.evaluate(() => window.workbench.v2.assistants.list())
  for (const assistant of afterFailure) assert.deepEqual(afterInvalid.find((item) => item.id === assistant.id)[field], assistant[field], 'Invalid bulk partially committed')
  evidence.workflows.push(`${mode} matrix: two stable identities, draft-only, row enable/column disable, atomic save, reload/view dirty dismiss, stale CAS preserves draft and no partial writes, unknown cell and invalid bulk reject, mixed committed state`)
  return { key, field, disabledId: director.id, enabledId: reviewer.id }
}

async function matrixKeyboard() {
  await page.keyboard.press('Tab')
  const cells = page.locator('.agent-binding-matrix td input:enabled')
  const count = await cells.count()
  assert(count >= 2, 'No keyboard-operable matrix cells')
  for (let index = 0; index < count; index++) {
    await cells.nth(index).focus()
    assert(await cells.nth(index).evaluate((node) => node === document.activeElement && getComputedStyle(node).outlineStyle !== 'none'), `Matrix cell ${index} lacks visible keyboard focus`)
  }
  const first = cells.first()
  const old = await first.isChecked()
  await first.focus()
  await page.keyboard.press('Space')
  assert.equal(await first.isChecked(), !old, 'Native checkbox Space did not toggle')
  await page.keyboard.press('Space')
  assert.equal(await first.isChecked(), old, 'Native checkbox Space did not restore draft')
  evidence.workflows.push(`Dense matrix: all ${count} enabled cells can receive visible keyboard focus; Space toggles/restores without a second nested table scroller`)
}

async function customAccent(color) {
  await page.getByLabel('自定义主色', { exact: true }).evaluate((node, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
    node.dispatchEvent(new Event('change', { bubbles: true }))
  }, color)
  await page.getByRole('button', { name: '使用自定义主色', exact: true }).click()
}

async function checkContrast(theme, accent) {
  await page.waitForTimeout(220)
  const measured = await page.locator('.agent-bindings-view-picker button[data-variant="primary"]').evaluate((node) => {
    const css = getComputedStyle(node)
    const luminance = (color) => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
      const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 1, 1)
      const values = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((channel) => { const value = channel / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4 })
      return values[0] * .2126 + values[1] * .7152 + values[2] * .0722
    }
    const a = luminance(css.color); const b = luminance(css.backgroundColor)
    return { foreground: css.color, background: css.backgroundColor, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }
  })
  assert(measured.contrast >= 4.5, `${theme}/${accent}: actual primary button text contrast ${measured.contrast} < 4.5`)
  evidence.contrast ??= []
  evidence.contrast.push({ theme, accent, ...measured })
}

async function mainTest() {
  assert(fs.existsSync(main), 'Run pnpm build first')
  await launch()
  try {
    await paletteCoverage()
    if (paletteOnly) {
      assert.deepEqual(errors, [], 'Palette Renderer console/page errors')
      evidence.status = 'PASS'
      console.log(`Palette sanity PASS: ${evidence.workflows.length} workflows, ${evidence.screenshots.length} native screenshots`)
      console.log(`Evidence: ${path.join(profile, 'agent-palette-evidence.json')}`)
      return
    }
    await nav('设置')
    await checkSettingsNavigation()
    await tab('AI 助手')
    const director = await createAssistant('Smoke 统筹')
    const reviewer = await createAssistant('Smoke 复核')
    assert(director && reviewer && director.toolAllowlist.length === 0, 'New assistant identity/empty allowlist mismatch')
    evidence.workflows.push('Two assistants created through the real UI')

    await page.getByLabel('助手名称', { exact: true }).fill('未保存名字')
    acceptNextDialog = false
    await tab('协作团队')
    assert.equal(await page.getByLabel('助手名称', { exact: true }).inputValue(), '未保存名字', 'Dismissed dirty switch lost the draft')
    acceptNextDialog = true
    await tab('工具与 MCP 绑定')
    assert.equal(await page.getByRole('navigation', { name: '设置分区侧边栏', exact: true }).getByRole('button', { name: '工具与 MCP 绑定', exact: true }).getAttribute('aria-current'), 'page', 'Accepted dirty switch did not activate the requested section')
    await page.getByRole('button', { name: '单助手编辑', exact: true }).click()
    await page.getByLabel('绑定目标助手', { exact: true }).selectOption(director.id)
    const toolCheckbox = page.locator('.agent-binding-grid input[type="checkbox"]:enabled').first()
    await toolCheckbox.check()
    const toolKey = await toolCheckbox.locator('..').locator('strong').innerText()
    await page.getByRole('button', { name: '保存绑定', exact: true }).click()
    await page.getByText('绑定已保存，与助手使用同一修订号。', { exact: true }).waitFor()
    assert((await page.evaluate(async (id) => (await window.workbench.v2.assistants.list()).find((assistant) => assistant.id === id), director.id)).toolAllowlist.includes(toolKey), 'Tool binding not persisted')
    assert((await page.locator('body').innerText()).includes('第三方 stdio MCP 暂不支持'), 'Unsupported third-party stdio MCP boundary missing from UI')
    evidence.workflows.push('Dirty-switch dismiss preserves draft; read tool binding persists; third-party stdio MCP is explicitly unsupported')

    await tab('技能绑定')
    await page.getByRole('button', { name: '单助手编辑', exact: true }).click()
    await page.getByLabel('绑定目标助手', { exact: true }).selectOption(director.id)
    const skillCheckbox = page.locator('.agent-binding-grid input[type="checkbox"]:enabled').first()
    if (await skillCheckbox.count()) {
      await skillCheckbox.check()
      await page.getByRole('button', { name: '保存绑定', exact: true }).click()
      await page.getByText('绑定已保存，与助手使用同一修订号。', { exact: true }).waitFor()
      evidence.workflows.push('Installed skill binding persists through assistant CAS')
    } else {
      assert((await page.locator('body').innerText()).includes('当前没有已安装技能'), 'Missing installed skill empty state')
      evidence.workflows.push('No installed skills: truthful empty state (binding path not executed)')
    }

    const matrixStates = [await matrixWorkflow('tools', director, reviewer), await matrixWorkflow('skills', director, reviewer)]
    await tab('AI 助手')
    await page.getByRole('button', { name: /Smoke 统筹/ }).first().click()
    const oldName = await page.getByLabel('助手名称', { exact: true }).inputValue()
    await page.evaluate(async (id) => {
      const { archivedAt, createdAt, updatedAt, revision, ...fields } = (await window.workbench.v2.assistants.list()).find((assistant) => assistant.id === id)
      await window.workbench.v2.assistants.save({ ...fields, description: '另一操作已更新此记录', expectedRevision: revision })
    }, director.id)
    await page.getByLabel('助手名称', { exact: true }).fill('不应覆盖的过期修改')
    await page.getByRole('button', { name: '保存助手', exact: true }).click()
    await page.locator('.form-feedback-error').waitFor()
    assert.equal((await page.evaluate(async (id) => (await window.workbench.v2.assistants.list()).find((assistant) => assistant.id === id), director.id)).name, oldName, 'Stale CAS save overwrote a new revision')
    await page.getByRole('button', { name: '重新载入', exact: true }).click()
    await page.getByLabel('助手名称', { exact: true }).waitFor()
    evidence.workflows.push('Stale revision save rejected without changing persisted name')

    await tab('协作团队')
    await page.getByRole('button', { name: '新建团队', exact: true }).click()
    await page.getByLabel('团队名称', { exact: true }).fill('Smoke 科研团队')
    await page.getByLabel('最大运行步骤（2–12）', { exact: true }).fill('4')
    await page.getByRole('button', { name: '移除成员 2', exact: true }).click()
    await page.getByLabel('成员 1', { exact: true }).selectOption(director.id)
    await page.getByRole('button', { name: '添加成员', exact: true }).click()
    await page.getByLabel('成员 2', { exact: true }).selectOption(reviewer.id)
    await page.getByLabel('角色', { exact: true }).nth(0).selectOption('director')
    await page.getByLabel('角色', { exact: true }).nth(1).selectOption('reviewer')
    await page.getByRole('button', { name: '保存团队', exact: true }).click()
    await page.getByText('团队已保存；下一次运行冻结此配置快照。', { exact: true }).waitFor()
    const team = await page.evaluate(async () => (await window.workbench.v2.agentTeams.list()).find((item) => item.name === 'Smoke 科研团队'))
    assert(team && team.members.length === 2 && team.maxSteps === 4, 'Team configuration was not persisted')
    evidence.workflows.push('Team created through UI with director/reviewer roles and maxSteps=4')

    await nav('Agent')
    await page.getByLabel('Agent 运行方式', { exact: true }).selectOption('team')
    await page.getByRole('combobox', { name: '协作团队', exact: true }).selectOption(team.id)
    await page.getByLabel('发送给 Agent 的消息', { exact: true }).fill('隔离 smoke：只读列出任务。没有凭据时请明确失败。')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    const teamRun = await waitForTruth(async () => (await window.workbench.v2.agentTeams.runs.list()).find((run) => run.snapshot.team.name === 'Smoke 科研团队' && run.status === 'failed'), 'Team did not fail honestly without credentials')
    assert.equal(teamRun.status, 'failed')
    assert(teamRun.childRunIds.length > 0, 'Failed team did not preserve a child run link')
    await page.getByRole('button', { name: '查看成员运行 1', exact: true }).waitFor()
    const child = await page.evaluate((id) => window.workbench.agent.runs.get(id), teamRun.childRunIds[0])
    assert(['failed', 'blocked'].includes(child.status), 'Missing credential child was presented as success')
    assert.equal(child.assistantId, director.id)
    assert.equal(child.teamId, team.id)
    assert(child.conversationId, 'Child cannot be inspected in the conversation UI')
    await page.getByRole('button', { name: '查看成员运行 1', exact: true }).click()
    await page.getByRole('listbox', { name: '运行轨迹', exact: true }).waitFor()
    assert.equal(await page.getByLabel('助手', { exact: true }).inputValue(), director.id)
    evidence.workflows.push('Team with no credentials fails honestly; child assistant/team identity and ledger link are preserved')

    await app.close()
    app = null
    await launch()
    await nav('设置')
    const persisted = await page.evaluate(async () => ({ assistants: await window.workbench.v2.assistants.list(), teams: await window.workbench.v2.agentTeams.list(), runs: await window.workbench.v2.agentTeams.runs.list() }))
    const savedDirector = persisted.assistants.find((assistant) => assistant.id === director.id)
    assert(savedDirector, 'Assistant identity lost after restart')
    for (const state of matrixStates) {
      assert(!persisted.assistants.find((assistant) => assistant.id === state.disabledId)[state.field].includes(state.key), 'Disabled matrix cell enabled after restart')
      assert(persisted.assistants.find((assistant) => assistant.id === state.enabledId)[state.field].includes(state.key), 'Enabled matrix cell disabled after restart')
    }
    assert(persisted.teams.some((item) => item.id === team.id && item.maxSteps === 4), 'Team configuration lost after restart')
    assert(persisted.runs.some((item) => item.id === teamRun.id && item.status === 'failed'), 'Team failure history lost after restart')
    evidence.workflows.push('Restart preserves assistant bindings, team config and failed team ledger')

    await page.evaluate(async (id) => {
      const { id: sourceId, archivedAt, createdAt, updatedAt, revision, ...fields } = (await window.workbench.v2.assistants.list()).find((assistant) => assistant.id === id)
      for (let index = 0; index < 6; index++) await window.workbench.v2.assistants.save({ ...fields, id: `assistant.${crypto.randomUUID()}`, expectedRevision: null, name: index < 2 ? '同名矩阵助手' : `矩阵助手 ${index + 1}`, description: '隔离密集矩阵测试' })
    }, reviewer.id)

    for (const theme of ['light', 'dark']) {
      await nav('设置')
      await tab('通用')
      await page.locator('#general-theme').selectOption(theme)
      await page.locator('#general-font-scale').selectOption('large')
      for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 720 }, { width: 720, height: 880 }, { width: 320, height: 720 }]) {
        await setSize(size.width, size.height)
        await nav('设置')
        await tab('AI 助手')
        await page.getByRole('button', { name: /Smoke 统筹/ }).first().click()
        await screenshot(`assistants-${theme}-${size.width}`)
        if (size.width === 1440) await screenshot(`settings-sidebar-${theme}-${size.width}`)
        if (size.width === 320) {
          const expand = page.getByRole('button', { name: '展开设置分区侧边栏', exact: true })
          await expand.click()
          const collapse = page.getByRole('button', { name: '收起设置分区侧边栏', exact: true })
          assert.equal(await collapse.getAttribute('aria-expanded'), 'true', 'Narrow settings drawer did not expand')
          await screenshot(`settings-sidebar-${theme}-${size.width}`)
          await collapse.focus()
          await page.keyboard.press('Escape')
          assert.equal(await expand.getAttribute('aria-expanded'), 'false', 'Escape did not collapse the narrow settings drawer')
          assert(await expand.evaluate((node) => node === document.activeElement), 'Drawer Escape did not restore toggle focus')
          evidence.workflows.push(`${theme} 320px settings icon rail expands as left drawer; Escape collapses and restores focus`)
        }
        await tab('协作团队')
        await page.getByRole('button', { name: /Smoke 科研团队/ }).first().click()
        await screenshot(`teams-${theme}-${size.width}`)
        await nav('Agent')
        if (size.width <= 720) await narrowHistory(`${theme}/${size.width}`)
        await page.getByLabel('Agent 运行方式', { exact: true }).selectOption('assistant')
        if (size.width <= 720) {
          await page.getByLabel('助手', { exact: true }).selectOption('')
          await composerBounds(`${theme}/${size.width}/default-assistant`)
          await screenshot(`agent-${theme}-${size.width}-default-composer`)
        }
        await page.getByLabel('助手', { exact: true }).selectOption(director.id)
        await screenshot(`agent-${theme}-${size.width}`)
        await nav('设置')
        for (const mode of ['tools', 'skills']) {
          await bindingMatrix(mode)
          if (size.width === 1440) await matrixKeyboard()
          await screenshot(`matrix-${mode}-${theme}-${size.width}`)
          if (size.width === 320) {
            assert(await page.locator('.agent-binding-matrix-intro > div').evaluate((node) => node.getBoundingClientRect().width > 100), 'Narrow matrix explanation collapsed into a single-character column')
            await page.locator('.agent-binding-matrix-scroll').evaluate((node) => { node.scrollIntoView({ block: 'start' }); node.scrollLeft = 125 })
            await screenshot(`matrix-${mode}-${theme}-320-cells`, false)
            await page.locator('.agent-binding-matrix-footer').evaluate((node) => node.scrollIntoView({ block: 'start' }))
            await screenshot(`matrix-${mode}-${theme}-320-save`, false)
          }
        }
      }
    }
    const views = [['仪表盘', 'dashboard'], ['任务', 'tasks'], ['日历', 'calendar'], ['项目空间', 'project'], ['文献检索', 'literature'], ['Obsidian', 'obsidian'], ['Zotero', 'zotero'], ['Agent', 'agent'], ['定时任务', 'automation'], ['情报日报', 'intel-daily'], ['设置', 'settings']]
    for (const theme of ['light', 'dark']) {
      await setSize(1440, 900)
      await nav('设置')
      await tab('通用')
      await page.locator('#general-theme').selectOption(theme)
      await page.locator('#general-font-scale').selectOption('comfortable')
      await customAccent('#b2563d')
      const primary = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim())
      assert.notEqual(primary, theme === 'light' ? '#176b87' : '#79c8e0', 'Custom primary was not applied')
      await bindingMatrix('tools'); await checkContrast(theme, 'custom')
      for (const size of [{ width: 1440, height: 900 }, { width: 720, height: 880 }]) {
        await setSize(size.width, size.height)
        for (const [label, view] of views) { await nav(label); await page.locator(`[data-workbench-view="${view}"]`).waitFor(); await page.waitForTimeout(180); await screenshot(`page-${view}-${theme}-custom-${size.width}`) }
      }
      await setSize(1440, 900)
      for (const [label, key] of [['海蓝', 'ocean'], ['青绿', 'teal'], ['石墨', 'slate'], ['铜棕', 'copper']]) {
        await nav('设置'); await tab('通用')
        await page.getByRole('button', { name: `主色：${label}`, exact: true }).click()
        for (const mode of ['tools', 'skills']) { await bindingMatrix(mode); await checkContrast(theme, key); await screenshot(`matrix-${mode}-${theme}-${key}-1440`) }
      }
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2))
      evidence.workflows.push(`${theme}: real Electron webContents 200% zoom, not a font-size substitute`)
      for (const mode of ['tools', 'skills']) { await nav('设置'); await bindingMatrix(mode); await matrixKeyboard(); await screenshot(`matrix-${mode}-${theme}-zoom200`) }
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
    }
    evidence.pageViews = views.map((entry) => entry[1])
    await nav('设置'); await tab('通用'); await customAccent('#b2563d')
    await app.close(); app = null; await launch(); await nav('设置'); await tab('通用')
    assert.equal(await page.getByLabel('自定义主色', { exact: true }).inputValue(), '#b2563d', 'Custom primary lost after restart')
    assert.equal(await page.evaluate(() => localStorage.getItem('workbench-accent')), 'custom', 'Custom primary selection lost after restart')
    evidence.workflows.push('All 11 real views rendered in both themes at desktop/narrow with custom primary; all four primary presets and custom choice verified, custom persists after restart')
    await visualCoverage()
    await setSize(1440, 900)
    await nav('设置')
    await tab('AI 助手')
    const disposable = await createAssistant('Smoke 待归档')
    acceptNextDialog = false
    await page.getByRole('button', { name: '归档助手', exact: true }).click()
    assert.equal((await page.evaluate(async (id) => (await window.workbench.v2.assistants.list()).find((assistant) => assistant.id === id), disposable.id)).archivedAt, null, 'Dismissed archive modified record')
    acceptNextDialog = true
    await page.getByRole('button', { name: '归档助手', exact: true }).click()
    await page.getByText('助手已归档；既有运行记录仍保留。', { exact: true }).waitFor()
    assert(!(await page.evaluate(async (id) => (await window.workbench.v2.assistants.list()).some((assistant) => assistant.id === id), disposable.id)), 'Confirmed archive stayed in the active list')
    evidence.workflows.push('Archive dismiss/confirm checked in isolated profile')
    assert.deepEqual(errors, [], 'Renderer console/page errors')
    evidence.consoleErrors = errors
    evidence.status = 'PASS'
    console.log(`Agent profile UI smoke PASS: ${evidence.workflows.length} workflows, ${evidence.screenshots.length} screenshots`)
    console.log(`Evidence: ${path.join(profile, 'agent-profiles-evidence.json')}`)
  } catch (error) {
    evidence.status = 'FAIL'
    evidence.error = error.message
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(profile, 'failure.png'), fullPage: true }).catch(() => {})
    throw error
  } finally {
    if (app) await app.close()
    evidence.consoleErrors = errors
    fs.writeFileSync(path.join(profile, paletteOnly ? 'agent-palette-evidence.json' : 'agent-profiles-evidence.json'), JSON.stringify(evidence, null, 2))
  }
}

async function supplementalZoom() {
  await launch()
  try {
    await visualCoverage()
    assert.deepEqual(errors, [], 'Supplemental Renderer errors')
    evidence.status = 'PASS'
    evidence.zoomFactor = 2
    evidence.originalEvidence = path.join(profile, 'agent-profiles-evidence.json')
    console.log(`Supplemental 200% visual PASS: ${evidence.screenshots.length} screenshots`)
  } catch (error) { evidence.status = 'FAIL'; evidence.error = error.message; throw error }
  finally { await app.close(); evidence.consoleErrors = errors; fs.writeFileSync(path.join(profile, 'agent-profiles-zoom-evidence.json'), JSON.stringify(evidence, null, 2)) }
}

async function visualCoverage() {
    await setSize(1440, 900)
    for (const theme of ['light', 'dark']) {
      await nav('设置'); await tab('通用')
      await page.locator('#general-theme').selectOption(theme)
      await page.locator('#general-font-scale').selectOption('comfortable')
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2))
      for (const mode of ['tools', 'skills']) {
        await bindingMatrix(mode)
        const cells = page.locator('.agent-binding-matrix td input:enabled')
        await page.keyboard.press('Tab')
        for (let index = 0; index < await cells.count(); index++) await visibleTarget(cells.nth(index), true)
        evidence.workflows.push(`${theme}/${mode}: every enabled matrix cell passes actual viewport bounds, center hit-test and keyboard-focus style at 200%`)
        await visibleTarget(cells.first(), true)
        const before = await cells.first().isChecked()
        await page.keyboard.press('Space'); assert.equal(await cells.first().isChecked(), !before)
        await page.keyboard.press('Space'); assert.equal(await cells.first().isChecked(), before)
        await screenshot(`matrix-${mode}-${theme}-zoom200-cells`, false)
        await page.keyboard.press('Space'); assert.equal(await cells.first().isChecked(), !before)
        assert.equal(await page.getByRole('button', { name: '保存矩阵', exact: true }).isEnabled(), true)
        await visibleTarget(page.getByRole('button', { name: '重新载入矩阵', exact: true }))
        await visibleTarget(page.getByRole('button', { name: '保存矩阵', exact: true }), true)
        await screenshot(`matrix-${mode}-${theme}-zoom200-save`, false)
        await visibleTarget(cells.first(), true)
        await page.keyboard.press('Space'); assert.equal(await cells.first().isChecked(), before)
      }
      assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()), 2)
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
      await nav('Agent')
      const expandHistory = page.getByRole('button', { name: '展开对话历史', exact: true })
      if (await expandHistory.count()) await expandHistory.click()
      await page.getByLabel('Agent 运行方式', { exact: true }).selectOption('assistant')
      await page.getByLabel('助手', { exact: true }).selectOption('')
      await page.getByRole('group', { name: 'Agent 视图', exact: true }).getByRole('button', { name: '对话', exact: true }).click()
      if (await page.getByRole('button', { name: '并排显示轨迹', exact: true }).count()) await page.getByRole('button', { name: '并排显示轨迹', exact: true }).click()
      await page.getByRole('complementary', { name: '并排运行轨迹', exact: true }).waitFor({ state: 'visible' })
      assert.equal(await page.locator('.agent-thread-shell').evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length), 3)
      await composerBounds(`${theme}/comfortable/default-assistant`)
      await screenshot(`agent-${theme}-conversation-three-columns`)
      const assistantId = await page.getByLabel('助手', { exact: true }).locator('option:enabled').evaluateAll((nodes) => nodes.find((node) => node.value)?.value)
      assert(assistantId, 'Named assistant missing for composer layout coverage')
      await page.getByLabel('助手', { exact: true }).selectOption(assistantId)
      await composerBounds(`${theme}/comfortable/named-assistant`)
      await page.getByLabel('助手', { exact: true }).selectOption('')
      await nav('设置'); await tab('通用')
      await page.locator('#general-font-scale').selectOption('large')
      await nav('Agent')
      await composerBounds(`${theme}/large/default-assistant`)
      await page.getByLabel('助手', { exact: true }).selectOption(assistantId)
      await composerBounds(`${theme}/large/named-assistant`)
      await page.getByLabel('助手', { exact: true }).selectOption('')
      await nav('设置'); await tab('通用')
      await page.locator('#general-font-scale').selectOption('comfortable')
      await nav('设置'); await tab('模型与 Agent')
      await page.locator('#settings-section-content .agent-provider-card').first().waitFor({ state: 'visible' })
      await page.getByText('正在准备表单…', { exact: true }).waitFor({ state: 'hidden' })
      await page.locator('#settings-section-content .settings-form-grid select').first().waitFor({ state: 'visible' })
      evidence.providerCards ??= []
      evidence.providerCards.push({ theme, count: await page.locator('#settings-section-content .agent-provider-card').count(), loading: await page.getByText('正在准备表单…', { exact: true }).isVisible() })
      await page.waitForTimeout(220)
      await screenshot(`providers-${theme}-cards`)
    }
    evidence.workflows.push('Actual viewport native captures cover 200% matrix cells/save, nonoverlapping default/named assistant three-column composer controls and fully loaded Provider cards in both themes')
}

async function paletteCoverage() {
  const localState = () => page.evaluate(async () => ({
    conversations: (await window.workbench.agent.conversations.list()).map((entry) => entry.id).sort(),
    runs: (await window.workbench.agent.runs.list()).map((entry) => entry.id).sort()
  }))
  const before = await localState()
  for (const theme of ['light', 'dark']) {
    await setSize(1440, 900)
    await nav('设置'); await tab('通用')
    await page.locator('#general-theme').selectOption(theme)
    await page.locator('#general-font-scale').selectOption('comfortable')
    for (const width of [1440, 320]) {
      await setSize(width, width === 320 ? 720 : 900)
      await nav('Agent')
      if (width === 320) {
        const collapse = page.getByRole('button', { name: '折叠对话历史', exact: true })
        if (await collapse.count()) await collapse.click()
      }
      await page.getByLabel('Agent 运行方式', { exact: true }).selectOption('assistant')
      await page.getByLabel('助手', { exact: true }).selectOption('')
      const input = page.locator('.agent-composer-input')
      const palette = page.getByRole('listbox', { name: '命令补全', exact: true })
      const options = palette.getByRole('option')
      const layout = async (target) => {
        const state = await target.evaluate((node) => {
          const palette = node.closest('.agent-command-palette')
          const paletteBounds = palette.getBoundingClientRect()
          const thread = node.closest('.agent-thread').getBoundingClientRect()
          const composer = document.querySelector('.agent-composer').getBoundingClientRect()
          const rect = node.getBoundingClientRect()
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          return { position: getComputedStyle(palette).position, clippedByDock: Boolean(palette.closest('.agent-composer-dock')),
            above: paletteBounds.bottom <= composer.top + 1,
            bounded: paletteBounds.left >= Math.max(0, thread.left) - 1 && paletteBounds.right <= Math.min(innerWidth, thread.right) + 1 && paletteBounds.top >= Math.max(0, thread.top) - 1,
            inputHeight: document.querySelector('.agent-composer-input').getBoundingClientRect().height,
            hit: hit === node || node.contains(hit), hitTag: hit?.tagName ?? null, hitClass: hit?.className ?? null, rect: { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width }, scrollTop: palette.scrollTop, threadShell: document.querySelector('.agent-thread-shell').className, focusedInput: document.activeElement === document.querySelector('.agent-composer-input'),
            option: node.textContent, palette: { top: paletteBounds.top, bottom: paletteBounds.bottom, width: paletteBounds.width }, composerTop: composer.top }
        })
        assert.equal(state.position, 'absolute', 'Palette must overlay, not displace, the composer')
        assert(!state.clippedByDock && state.above && state.bounded && state.hit && state.inputHeight < 90, `${theme}/${width}: palette unreachable or unanchored: ${JSON.stringify(state)}`)
        evidence.commandPalettes ??= []
        evidence.commandPalettes.push({ theme, width, ...state })
      }
      const resultCount = await page.locator('.agent-command-result').count()
      await input.fill('/')
      await palette.waitFor({ state: 'visible' })
      assert(await options.count() >= 5, 'Palette did not list local command options')
      const help = options.filter({ hasText: '/help' }).first()
      await layout(help)
      await screenshot(`agent-palette-${theme}-${width}`, false)
      await help.click()
      assert.equal(await input.inputValue(), '/help', 'Actual mouse completion did not fill /help')
      assert(await input.evaluate((node) => node === document.activeElement), 'Mouse completion did not restore composer focus')
      await input.press('Enter')
      await page.waitForFunction((count) => document.querySelectorAll('.agent-command-result').length === count + 1, resultCount)
      assert.equal(await page.locator('.agent-command-result').count(), resultCount + 1, 'Local /help did not create exactly one result')
      assert((await page.locator('.agent-command-result').last().textContent()).includes('/model use'), 'Local help result missing command reference')
      await input.fill('/')
      await input.press('ArrowDown')
      assert.equal(await palette.locator('[aria-selected="true"] code').textContent(), '/model list', 'ArrowDown did not select next command')
      await layout(palette.locator('[aria-selected="true"]'))
      await input.press('Tab')
      assert.equal(await input.inputValue(), '/model list', 'Tab did not accept selected completion')
      await input.fill('/')
      await input.press('ArrowUp')
      assert.equal(await palette.locator('[aria-selected="true"] code').textContent(), '/logout', 'ArrowUp did not wrap to the last command')
      await layout(palette.locator('[aria-selected="true"]'))
      await input.press('Escape')
      await palette.waitFor({ state: 'hidden' })
      assert.equal(await input.inputValue(), '/', 'Escape cleared command text')
      await input.fill('/he')
      await input.press('Enter')
      assert.equal(await input.inputValue(), '/help', 'Enter did not complete a partial command')
      assert.equal(await page.locator('.agent-command-result').count(), resultCount + 1, 'Partial-command completion executed before explicit submission')
      await input.press('Escape')
      await input.fill('')
      assert.deepEqual(await localState(), before, 'Local commands created a conversation or Agent run')
      evidence.workflows.push(`${theme}/${width}: absolute bounded palette outside dock clip; actual /help mouse click/local execution, ArrowDown/Tab, last-option ArrowUp scroll/hit, Enter completion and Escape; no conversation/run created`)
    }
  }
  await setSize(1440, 900)
}

async function composerBounds(context) {
  const state = await page.locator('.agent-composer-toolbar').evaluate((toolbar) => {
    const boundary = toolbar.getBoundingClientRect()
    const controls = [...toolbar.querySelectorAll('select,button')].map((node) => {
      const rect = node.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return { label: node.getAttribute('aria-label'), left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width,
        disabled: node.disabled, hit: hit === node || node.contains(hit),
        inside: rect.left >= boundary.left - 1 && rect.right <= boundary.right + 1 && rect.top >= boundary.top - 1 && rect.bottom <= boundary.bottom + 1 }
    }).filter((node) => node.width > 0)
    const overlapping = []
    for (let a = 0; a < controls.length; a++) for (let b = a + 1; b < controls.length; b++) {
      const first = controls[a]; const second = controls[b]
      if (Math.min(first.right, second.right) - Math.max(first.left, second.left) > 1 && Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > 1) overlapping.push([first.label, second.label])
    }
    return { controls, overlapping }
  })
  assert.deepEqual(state.overlapping, [], `${context}: composer controls overlap`)
  for (const control of state.controls) assert(control.inside && control.width >= (control.label === '添加上下文' || control.label === '发送' ? 30 : 70), `${context}: composer control lacks readable bounded area: ${JSON.stringify(control)}`)
  if (context.includes('default-assistant')) for (const label of ['在项目中工作', 'Agent Provider', 'Agent 模型', 'Agent 运行方式', '助手']) assert(state.controls.some((control) => control.label === label), `${context}: default control missing: ${label}`)
  const reachable = page.locator('.agent-composer textarea, .agent-composer-toolbar select, .agent-composer-toolbar button')
  state.reachable = []
  for (let index = 0; index < await reachable.count(); index++) {
    const control = reachable.nth(index)
    await control.evaluate((node) => node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }))
    if (await control.isEnabled()) await control.focus()
    const actual = await control.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      const bounds = [document.querySelector('main'), node.closest('.agent-thread'), node.closest('.agent-composer-dock')].map((ancestor) => ancestor.getBoundingClientRect())
      const clip = { left: Math.max(0, ...bounds.map((bound) => bound.left)), top: Math.max(0, ...bounds.map((bound) => bound.top)), right: Math.min(innerWidth, ...bounds.map((bound) => bound.right)), bottom: Math.min(innerHeight, ...bounds.map((bound) => bound.bottom)) }
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return { label: node.getAttribute('aria-label'), disabled: node.disabled, focused: document.activeElement === node, hit: hit === node || node.contains(hit),
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, clip,
        inside: rect.left >= clip.left - 1 && rect.right <= clip.right + 1 && rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1 }
    })
    assert(actual.inside && (actual.disabled || (actual.hit && actual.focused)), `${context}: composer control not reachable after real scroll/focus: ${JSON.stringify(actual)}`)
    state.reachable.push(actual)
  }
  evidence.composerLayouts ??= []
  evidence.composerLayouts.push({ context, ...state })
}

async function narrowHistory(context) {
  const expand = page.getByRole('button', { name: '展开对话历史', exact: true })
  if (await expand.count()) await expand.click()
  const open = await page.locator('.agent-thread').boundingBox()
  const shell = await page.locator('.agent-thread-shell').boundingBox()
  assert(open.width >= shell.width - 50 && Math.abs(open.x - shell.x - 48) < 2, `${context}: opened overlay misplaced main thread into history column`)
  await page.getByRole('button', { name: '折叠对话历史', exact: true }).click()
  const closed = await page.locator('.agent-thread').boundingBox()
  assert(Math.abs(closed.width - open.width) < 2 && Math.abs(closed.x - open.x) < 2, `${context}: collapsing overlay changed main grid placement`)
  await page.getByRole('button', { name: '展开对话历史', exact: true }).click()
  await page.getByRole('button', { name: '折叠对话历史', exact: true }).click()
  evidence.narrowHistory ??= []
  evidence.narrowHistory.push({ context, open, closed })
}

async function visibleTarget(locator, keyboard = false) {
  await locator.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }))
  if (keyboard) await locator.focus()
  const actual = await locator.evaluate((node) => {
    const rect = node.getBoundingClientRect(); const main = document.querySelector('main').getBoundingClientRect()
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return { label: node.getAttribute('aria-label') || node.textContent, x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      inside: rect.left >= main.left && rect.right <= main.right && rect.top >= main.top && rect.bottom <= main.bottom,
      hit: hit === node || node.contains(hit), focused: document.activeElement === node && getComputedStyle(node).outlineStyle !== 'none' }
  })
  assert(actual.inside && actual.hit && (!keyboard || actual.focused), `Actual viewport control obscured: ${JSON.stringify(actual)}`)
  evidence.visibleControls ??= []
  evidence.visibleControls.push(actual)
}

(zoomProfile ? supplementalZoom() : mainTest()).catch((error) => { console.error(error.message); process.exitCode = 1 })
