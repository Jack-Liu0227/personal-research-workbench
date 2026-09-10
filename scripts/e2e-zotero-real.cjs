/*
 * Real local Zotero + Better BibTeX smoke test.
 *
 * This is intentionally opt-in: unlike scripts/e2e-electron.cjs it uses the
 * user's configured profile and writes one generated export to Downloads.
 * It never calls a Zotero write route and never opens zotero.sqlite.
 *
 * Optional environment variables:
 *   PRW_REAL_USER_DATA  Workbench user-data root (defaults to %APPDATA%/@prw/desktop)
 *   PRW_REAL_DOWNLOADS  Download directory used for the generated file
 */
const { _electron: electron } = require('playwright-core')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const APP_ROOT = path.resolve(__dirname, '..')
const MAIN_ENTRY = path.join(APP_ROOT, 'apps', 'desktop', 'out', 'main', 'index.cjs')
const ELECTRON = path.join(
  APP_ROOT,
  'node_modules',
  '.pnpm',
  'electron@43.4.1',
  'node_modules',
  'electron',
  'dist',
  'electron.exe'
)
const userData = path.resolve(
  process.env.PRW_REAL_USER_DATA || path.join(process.env.APPDATA || os.homedir(), '@prw', 'desktop')
)
const downloads = path.resolve(
  process.env.PRW_REAL_DOWNLOADS || path.join(process.env.USERPROFILE || os.homedir(), 'Downloads')
)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function hasMissingProjectTag(content) {
  return content.includes(`#${String.fromCodePoint(0x672a, 0x5206, 0x7c7b)}`)
}

async function main() {
  assert(fs.existsSync(MAIN_ENTRY), `Build output not found: ${MAIN_ENTRY}`)
  assert(fs.existsSync(ELECTRON), `Electron executable not found: ${ELECTRON}`)
  assert(fs.existsSync(userData), `Workbench user-data directory not found: ${userData}`)
  assert(fs.existsSync(downloads), `Downloads directory not found: ${downloads}`)

  const before = new Set(fs.readdirSync(downloads))
  const launchEnv = {
    ...process.env,
    PRW_LAST30DAYS_SKILL_PATH: path.join(APP_ROOT, '.agents', 'skills', 'last30days', 'skills', 'last30days', 'SKILL.md')
  }
  delete launchEnv.ELECTRON_RENDERER_URL

  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [MAIN_ENTRY, `--prw-user-data-dir=${userData}`],
    env: launchEnv,
    cwd: userData,
    timeout: 90_000
  })
  const errors = []
  try {
    const page = await app.firstWindow({ timeout: 90_000 })
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })

    // The last exact match is the workspace navigation item (the first can
    // be the open-tab label in a persisted session).
    await page.getByText('Zotero', { exact: true }).last().click()
    await page.locator('article.paper-row').first().waitFor({ state: 'visible', timeout: 90_000 })
    const rowCount = await page.locator('article.paper-row').count()
    const buttons = await page.locator('button').evaluateAll((nodes) => nodes.map((node, index) => ({
      index,
      label: node.getAttribute('aria-label') || '',
      disabled: node.disabled
    })))
    const exportButton = buttons.find((button) => button.label.includes('Better BibTeX') && !button.label.includes('下载'))
    assert(exportButton !== undefined, 'Better BibTeX export action is missing')

    await page.locator('article.paper-row').first().locator('input[type="checkbox"]').check()
    const initialBbtButtons = await page.locator('button[aria-label*="Better BibTeX"]').count()
    await page.locator('button').nth(exportButton.index).click()
    await page.waitForFunction(
      (initial) => document.querySelectorAll('button[aria-label*="Better BibTeX"]').length > initial,
      initialBbtButtons,
      { timeout: 60_000 }
    )
    const generatedButtons = await page.locator('button').evaluateAll((nodes) => nodes.map((node, index) => ({
      index,
      label: node.getAttribute('aria-label') || ''
    })))
    const downloadButton = generatedButtons.find((button) => button.label.includes('Better BibTeX') && button.index !== exportButton.index)
    assert(downloadButton !== undefined, 'Generated Better BibTeX save action is missing')
    await page.locator('button').nth(downloadButton.index).click()

    let file
    let content = ''
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const newFiles = fs.readdirSync(downloads).filter((name) => !before.has(name))
      const candidate = newFiles
        .map((name) => ({ name, fullPath: path.join(downloads, name) }))
        .sort((a, b) => fs.statSync(b.fullPath).mtimeMs - fs.statSync(a.fullPath).mtimeMs)[0]
      if (candidate && fs.statSync(candidate.fullPath).size > 0) {
        file = candidate
        content = fs.readFileSync(candidate.fullPath, 'utf8')
        if (/@[A-Za-z]+\s*\{/m.test(content) && hasMissingProjectTag(content)) break
      }
      await page.waitForTimeout(100)
    }
    assert(file !== undefined && content.length > 0, 'No Better BibTeX file appeared in Downloads')
    const result = {
      rows: rowCount,
      fileName: file.name,
      bytes: Buffer.byteLength(content),
      validBibtex: /@[A-Za-z]+\s*\{/m.test(content),
      projectTag: hasMissingProjectTag(content),
      errors
    }
    await page.screenshot({ path: path.join(userData, 'zotero-real-browser-smoke.png'), fullPage: true })
    await page.screenshot({ path: path.join(userData, 'zotero-real-browser-smoke-viewport.png'), fullPage: false })
    assert(result.validBibtex, 'Downloaded file is not valid BibTeX')
    assert(result.projectTag, 'Downloaded file is missing the #未分类 project tag')
    assert(errors.length === 0, `Browser reported errors: ${errors.join('; ')}`)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    await app.close().catch(() => {})
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
