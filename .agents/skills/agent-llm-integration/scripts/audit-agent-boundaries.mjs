#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'

const root = resolve(process.argv[2] ?? process.cwd())
const required = [
  'packages/contracts',
  'packages/database',
  'packages/workspace-service',
  'packages/agent-runtime',
  'packages/workspace-mcp',
  'apps/desktop/src/preload',
  'apps/desktop/src/main'
]

const rendererSourceRoot = join(root, 'apps/desktop/src/renderer/src')
const rendererRoots = existsSync(rendererSourceRoot)
  ? [rendererSourceRoot]
  : [join(root, 'apps/desktop/src/renderer')]

const forbiddenRendererPatterns = [
  /(?:from|import\s*\()['"]electron(?:\/[^'"]*)?['"]/u,
  /(?:from|import\s*\()['"]node:[^'"]+['"]/u,
  /(?:from|import\s*\()['"](?:better-sqlite3|sqlite3)['"]/u
]

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|\s)\/\/.*$/gmu, '$1')
}

function walk(dir) {
  const files = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'dist') continue
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(absolute))
    else if (/\.(tsx?|jsx?)$/u.test(entry.name)) files.push(absolute)
  }
  return files
}

let findings = 0
console.log(`Agent boundary audit: ${root}`)

for (const path of required) {
  if (existsSync(join(root, path))) console.log(`OK   ${path}`)
  else {
    findings += 1
    console.log(`MISS ${path}`)
  }
}

for (const rendererRoot of rendererRoots) {
  if (!existsSync(rendererRoot)) continue
  for (const file of walk(rendererRoot)) {
    const source = withoutComments(readFileSync(file, 'utf8'))
    for (const pattern of forbiddenRendererPatterns) {
      if (!pattern.test(source)) continue
      findings += 1
      console.log(`FAIL renderer boundary ${relative(root, file)} (${basename(file)}): ${pattern}`)
    }
  }
}

if (findings > 0) {
  console.error(`Boundary audit failed with ${findings} finding(s). Review the skill checklist before implementation.`)
  process.exitCode = 1
} else {
  console.log(`PASS no conservative boundary findings (path separator: ${sep})`)
}
