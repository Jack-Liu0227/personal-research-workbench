#!/usr/bin/env node
/**
 * Verifies — without building anything — that `apps/desktop/electron-builder.yml`
 * excludes this dev-only release skill from `resources/skills`, while keeping the
 * skills the app actually ships.
 *
 * The filter list is read from the real config and evaluated with electron-builder's
 * own matcher (`FileMatcher.createFilter()`), so the verdict matches packaging
 * behaviour instead of a hand-rolled glob guess.
 *
 * Exit 0 = filter behaves as required, 1 = it does not (details printed).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const SKILL_DIR = path.resolve(import.meta.dirname, '..')
const REPO = path.resolve(SKILL_DIR, '..', '..', '..')
const CONFIG = path.join(REPO, 'apps', 'desktop', 'electron-builder.yml')
const SKILLS_SRC = path.join(REPO, '.agents', 'skills')
const REQUIRED_PATTERN = '!**/windows-release/**'

function fail(message) {
  console.error(`[FAIL] ${message}`)
  process.exit(1)
}

/** Loads the same matcher copyDir uses, from the installed app-builder-lib. */
function loadMatcher(patterns) {
  const store = path.join(REPO, 'node_modules', '.pnpm')
  if (!fs.existsSync(store)) fail('node_modules/.pnpm is missing; run pnpm install first')
  const entry = fs.readdirSync(store).filter((name) => name.startsWith('app-builder-lib@')).sort().pop()
  if (!entry) fail('app-builder-lib is not installed; run pnpm install first')
  const { FileMatcher } = require(
    path.join(store, entry, 'node_modules', 'app-builder-lib', 'out', 'fileMatcher.js'),
  )
  return new FileMatcher(SKILLS_SRC, 'skills', (value) => value, patterns)
}

const patterns = readExtraResourcesFilter(CONFIG)
const filter = loadMatcher(patterns).createFilter()
const file = () => ({ isDirectory: () => false })
console.log(`config   ${path.relative(REPO, CONFIG)}`)
console.log(`patterns ${patterns.join(' ')}`)

const excluded = ['windows-release/SKILL.md', 'windows-release/scripts/release.mjs']
const included = [
  'literature-matrix/SKILL.md',
  'literature-review-push/SKILL.md',
  'last30days/skills/last30days/SKILL.md',
]
let failures = 0
for (const relative of excluded) {
  const allowed = filter(path.join(SKILLS_SRC, relative), file())
  const ok = allowed === false
  if (!ok) failures += 1
  console.log(`[${ok ? 'PASS' : 'FAIL'}] excluded ${relative.padEnd(38)} allowed=${allowed}`)
}
for (const relative of included) {
  const allowed = filter(path.join(SKILLS_SRC, relative), file())
  const ok = allowed === true
  if (!ok) failures += 1
  console.log(`[${ok ? 'PASS' : 'FAIL'}] included ${relative.padEnd(38)} allowed=${allowed}`)
}
if (patterns.includes('!**/last30days/assets/**')) {
  const allowed = filter(path.join(SKILLS_SRC, 'last30days', 'assets', 'demo.mp4'), file())
  const ok = allowed === false
  if (!ok) failures += 1
  console.log(`[${ok ? 'PASS' : 'FAIL'}] excluded ${'last30days/assets/demo.mp4'.padEnd(38)} allowed=${allowed}`)
}

if (!patterns.includes(REQUIRED_PATTERN)) {
  console.error(
    `\n[FAIL] ${path.relative(REPO, CONFIG)} does not exclude this dev-only skill. Add\n` +
      `       ${REQUIRED_PATTERN}\n` +
      '       to the extraResources filter list, then re-run this check.',
  )
  process.exit(1)
}
if (failures > 0) fail(`${failures} expectation(s) failed`)
console.log(
  '\nOK: this skill stays out of the installer and the shipped skills stay in.\n' +
    'Note: directory entries are never excluded, so an empty windows-release/ folder may\n' +
    'still appear under win-unpacked/resources/skills; judge by files, not by the folder.',
)

/** Pulls the `filter:` list out of the `extraResources` block of the YAML. */
function readExtraResourcesFilter(file) {
  if (!fs.existsSync(file)) fail(`no electron-builder config at ${file}`)
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const start = lines.findIndex((line) => /^extraResources:/.test(line))
  if (start === -1) fail('electron-builder.yml has no extraResources block')
  const filterAt = lines.findIndex((line, i) => i > start && /^\s+filter:\s*$/.test(line))
  if (filterAt === -1) fail('extraResources has no filter: list')
  const indent = lines[filterAt].match(/^\s*/)[0].length
  const patterns = []
  for (let i = filterAt + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const item = line.match(/^\s*-\s*["']?(.+?)["']?\s*$/)
    if (!item || line.match(/^\s*/)[0].length <= indent) break
    patterns.push(item[1])
  }
  if (patterns.length === 0) fail('the extraResources filter list is empty')
  return patterns
}
