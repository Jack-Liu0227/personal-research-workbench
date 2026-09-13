#!/usr/bin/env node
/*
 * literature-matrix / literature-review-push skill verification (offline).
 *
 * Task 07 adds two project skills whose only source is
 * `.agents/skills/<key>/SKILL.md`. Nothing here touches the network, a model, a
 * Zotero database or an Obsidian vault — the checks are structural plus the
 * real registry module:
 *
 *   1. skill structure  — frontmatter (name/version/availability/language),
 *      required input parameters, required sections, evidence/citation rules,
 *      empty-result/degradation/failure semantics, safety boundaries and the
 *      Artifact/Obsidian projection contract.
 *   2. registry discovery — the real `skill-registry.ts` is loaded through the
 *      repository's jiti loader and driven with fake/real probes: the two keys
 *      are discovered in the canonical `.agents/skills` directory, resolve as
 *      `not-installed` (never as runnable), and the three installation states
 *      (runnable / not-installed / unsupported) stay distinguishable.
 *   3. single source + mirror — `.agents/skills` is the only hand-maintained
 *      location (no second copy anywhere in the repo) and the packaged
 *      `resources/skills` tree is only ever a build-time mirror produced by
 *      `apps/desktop/electron-builder.yml`.
 *
 * Usage:
 *   node scripts/literature-skills-smoke.cjs           # human readable
 *   node scripts/literature-skills-smoke.cjs --json     # machine readable
 *
 * Exit code 0 means every executed check passed. A check that cannot run is
 * reported as BLOCKED and exits non-zero, because a silent skip reads as
 * "verified".
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const APP_ROOT = path.resolve(__dirname, '..')
const SKILLS_ROOT = path.join(APP_ROOT, '.agents', 'skills')
const asJson = new Set(process.argv.slice(2)).has('--json')

/**
 * One description per project skill: what its `SKILL.md` must declare and what
 * the registry must report for it. Kept in this file (not in the skill) so the
 * skills cannot relax their own acceptance criteria.
 */
const SKILLS = [
  {
    key: 'literature-matrix',
    extraInputs: ['fieldTemplate'],
    requiredHeadings: [
      '## 输入参数',
      '## 执行流程',
      '## 证据与引用规则',
      '## 矩阵字段模板',
      '## 输出契约',
      '## 空结果 / 来源降级 / 失败语义',
      '## 安全边界',
      '## 自检清单',
      '## 诊断输出'
    ],
    requiredPhrases: [
      '不得伪造引用',
      '未报告',
      '不写 Zotero',
      'zotero.sqlite',
      '不自动外部写入',
      'Artifact',
      '4,000',
      'zh-CN'
    ],
    diagnosticCodes: [
      'MATRIX_INPUT_TOPIC_MISSING',
      'MATRIX_INPUT_WINDOW_INVALID',
      'MATRIX_SOURCES_UNAVAILABLE',
      'MATRIX_SOURCE_DEGRADED',
      'MATRIX_EMPTY_RESULT',
      'MATRIX_EVIDENCE_INSUFFICIENT',
      'MATRIX_RUN_FAILED',
      'MATRIX_EXTERNAL_WRITE_REFUSED'
    ]
  },
  {
    key: 'literature-review-push',
    extraInputs: ['reviewType'],
    requiredHeadings: [
      '## 输入参数',
      '## 综述类型要求',
      '## 执行流程',
      '## 证据与引用要求',
      '## 输出契约',
      '## 空结果 / 来源降级 / 失败语义',
      '## 安全边界',
      '## 自检清单',
      '## 诊断输出'
    ],
    requiredPhrases: ['不得伪造引用', '推断：', '缺口', '不写 Zotero', 'zotero.sqlite', '不自动投稿', 'Artifact', '4,000', 'zh-CN'],
    diagnosticCodes: [
      'REVIEW_INPUT_TOPIC_MISSING',
      'REVIEW_INPUT_TYPE_INVALID',
      'REVIEW_INPUT_WINDOW_INVALID',
      'REVIEW_SOURCES_UNAVAILABLE',
      'REVIEW_SOURCE_DEGRADED',
      'REVIEW_FULLTEXT_UNAVAILABLE',
      'REVIEW_EMPTY_RESULT',
      'REVIEW_CITATION_UNVERIFIED',
      'REVIEW_RUN_FAILED',
      'REVIEW_EXTERNAL_WRITE_REFUSED'
    ]
  }
]

/** Input parameters every project skill shares with the schedule contract. */
const SHARED_INPUTS = ['topic', 'lookbackDays', 'sources', 'responseLanguage', 'project', 'outputFolder']

const results = []
let blocked = 0

function record(name, status, detail) {
  results.push({ name, status, detail })
  if (status === 'BLOCKED') blocked += 1
  if (!asJson) console.log(`[${status}] ${name}${detail ? `\n        ${String(detail).split('\n').join('\n        ')}` : ''}`)
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

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function readSkill(key) {
  const file = path.join(SKILLS_ROOT, key, 'SKILL.md')
  assert(fs.existsSync(file), `missing canonical skill file ${path.relative(APP_ROOT, file)}`)
  return { file, text: fs.readFileSync(file, 'utf8') }
}

/**
 * Minimal YAML subset parser for frontmatter: nested mappings plus `- item`
 * lists. Enough for these skill files and deliberately dependency-free, so the
 * structure check can never pass because a YAML library resolved a document the
 * agents themselves would misread.
 */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(text)
  assert(match, 'SKILL.md must start with a YAML frontmatter block delimited by ---')
  const scalars = new Map()
  const lists = new Map()
  const stack = []
  for (const rawLine of match[1].split(/\r?\n/u)) {
    if (rawLine.trim().length === 0 || /^\s*#/u.test(rawLine)) continue
    const item = /^(\s*)-\s+(.*)$/u.exec(rawLine)
    if (item) {
      const key = stack.map((entry) => entry.key).join('.')
      const list = lists.get(key) ?? []
      list.push(item[2].trim())
      lists.set(key, list)
      continue
    }
    const entry = /^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/u.exec(rawLine)
    if (!entry) continue
    const indent = entry[1].length
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
    stack.push({ indent, key: entry[2] })
    const value = entry[3].trim()
    if (value.length > 0) scalars.set(stack.map((part) => part.key).join('.'), value.replace(/^["'](.*)["']$/u, '$1'))
  }
  return { scalars, lists }
}

// ---------------------------------------------------------------------------
// Layer 1: skill structure (offline, filesystem only).
// ---------------------------------------------------------------------------

function runStructureChecks() {
  for (const skill of SKILLS) {
    const { text } = readSkill(skill.key)
    const { scalars, lists } = parseFrontmatter(text)

    check(`structure: ${skill.key} frontmatter declares name, semver version and the workbench contract`, () => {
      assert(scalars.get('name') === skill.key, `name must be "${skill.key}", got ${JSON.stringify(scalars.get('name'))}`)
      const version = scalars.get('version') ?? ''
      assert(/^\d+\.\d+\.\d+$/u.test(version), `version must be semver, got ${JSON.stringify(version)}`)
      assert((scalars.get('description') ?? '').length >= 40, 'description must explain what the skill produces')
      assert((scalars.get('allowed-tools') ?? '').includes('Read'), 'allowed-tools must include Read')
      assert(scalars.get('user-invocable') === 'true', 'user-invocable must be true so the skill can be read directly')
      assert(scalars.get('metadata.workbench.skillKey') === skill.key, 'metadata.workbench.skillKey must match name')
      assert(
        scalars.get('metadata.workbench.sourceDirectory') === `.agents/skills/${skill.key}`,
        'metadata.workbench.sourceDirectory must point at the canonical .agents/skills directory'
      )
      // The catalog owns availability; the skill must not claim more than the build does.
      assert(
        scalars.get('metadata.workbench.availability') === 'shipped',
        'availability must state the honest build state (shipped: instruction-only contract registered)'
      )
      assert(scalars.get('metadata.workbench.externalWrites') === 'none', 'externalWrites must be none')
      assert(scalars.get('metadata.workbench.writesToZotero') === 'false', 'writesToZotero must be false')
      assert(scalars.get('metadata.workbench.writesToObsidian') === 'false', 'writesToObsidian must be false')
      return `version ${version}; availability shipped (instruction-only); tools ${scalars.get('allowed-tools')}`
    })

    check(`structure: ${skill.key} declares topic/window/sources/language/project/output inputs (Chinese default, configurable)`, () => {
      const declared = lists.get('metadata.workbench.requiredInputs') ?? []
      for (const input of [...SHARED_INPUTS, ...skill.extraInputs]) {
        assert(declared.includes(input), `requiredInputs must declare "${input}", got ${JSON.stringify(declared)}`)
        assert(new RegExp(`\\b${input}\\b`, 'u').test(text), `body must document the "${input}" input parameter`)
      }
      assert(scalars.get('metadata.workbench.defaultResponseLanguage') === 'zh-CN', 'defaultResponseLanguage must be zh-CN')
      const languages = lists.get('metadata.workbench.responseLanguages') ?? []
      assert(languages.includes('zh-CN') && languages.includes('en'), `responseLanguages must offer zh-CN and en, got ${JSON.stringify(languages)}`)
      assert(/`zh-CN`（默认）/.test(text), 'the body must state that zh-CN is the default')
      return `${declared.join(', ')}; languages ${languages.join('/')}`
    })

    check(`structure: ${skill.key} documents evidence, citation and required output sections`, () => {
      for (const heading of skill.requiredHeadings) {
        assert(text.includes(heading), `missing required section "${heading}"`)
      }
      for (const phrase of skill.requiredPhrases) {
        assert(text.includes(phrase), `body must state "${phrase}"`)
      }
      assert(/不得伪造引用/u.test(text), 'anti-fabrication rule must be explicit')
      assert(/(没有报告|未报告)/u.test(text), 'missing data must have an explicit placeholder instead of a guess')
      assert(/证据/u.test(text), 'the body must define evidence requirements')
      return `${skill.requiredHeadings.length} required sections, ${skill.requiredPhrases.length} required statements`
    })

    check(`structure: ${skill.key} defines empty-result, source-degradation and failure semantics`, () => {
      const codes = [...new Set(text.match(/\b(?:MATRIX|REVIEW)_[A-Z_]+\b/gu) ?? [])]
      assert(codes.length > 0, 'no diagnostic codes declared')
      for (const code of codes) {
        assert(code.startsWith(`${skill.key === 'literature-matrix' ? 'MATRIX' : 'REVIEW'}_`), `diagnostic code ${code} does not belong to ${skill.key}`)
      }
      for (const code of skill.diagnosticCodes) {
        assert(codes.includes(code), `missing documented diagnostic code ${code}`)
      }
      assert(/空结果|EMPTY_RESULT/u.test(text), 'empty result must be defined as a valid, declared outcome')
      assert(/(降级|DEGRADED)/u.test(text), 'source degradation must be defined')
      assert(/(阻断|失败)/u.test(text), 'failure semantics must be defined')
      return `codes: ${skill.diagnosticCodes.length} declared (${codes.length} distinct in file)`
    })

    check(`structure: ${skill.key} states the safety boundaries and the projection contract`, () => {
      assert(/不写 Zotero/u.test(text), 'must refuse Zotero writes')
      assert(/不触碰 `\.obsidian\/`/u.test(text), 'must refuse .obsidian writes')
      assert(/zotero\.sqlite/u.test(text), 'must name the forbidden database')
      assert(/凭据/u.test(text), 'must refuse credential handling')
      assert(/Artifact/u.test(text) && /Obsidian/u.test(text), 'output must be written for the existing Artifact/Obsidian projection')
      assert(/4,000/u.test(text), 'must state the bounded excerpt limit of the SQLiteArtifact/Inbox projection')
      assert(text.includes('不要写 YAML frontmatter'), 'must forbid the agent from emitting its own YAML frontmatter (the projection owns it)')
      return 'no external writes; credentials untouched; projection-owned frontmatter/title/footer'
    })

    check(`structure: ${skill.key} contains no credential material or second skill source`, () => {
      const suspicious = [
        [/\bsk-[A-Za-z0-9]{16,}/u, 'OpenAI-style key'],
        [/(api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_\-]{12,}/iu, 'inline credential assignment'],
        [/BEGIN [A-Z ]*PRIVATE KEY/u, 'private key'],
        [/[A-Za-z]:[\\/]Users[\\/]/iu, 'absolute user path']
      ]
      for (const [pattern, label] of suspicious) {
        assert(!pattern.test(text), `SKILL.md must not contain ${label}`)
      }
      const dirEntries = fs.readdirSync(path.join(SKILLS_ROOT, skill.key))
      assert(dirEntries.includes('SKILL.md'), 'SKILL.md must live directly in .agents/skills/<key>/')
      return `files: ${dirEntries.join(', ')}`
    })
  }
}

// ---------------------------------------------------------------------------
// Layer 2 + 3: registry discovery, three installation states, single source.
// ---------------------------------------------------------------------------

function bundleSkillRegistry() {
  const { createJiti } = require('jiti')
  const jiti = createJiti(__filename)
  return jiti(path.join(APP_ROOT, 'packages', 'workspace-service', 'src', 'skill-registry.ts'))
}

function runRegistryChecks(registry) {
  check('registry: the frozen catalog keeps both keys with SKILL.md at the canonical relative path', () => {
    const catalog = registry.AGENT_SKILL_CATALOG
    for (const skill of SKILLS) {
      const entry = catalog[skill.key]
      assert(Boolean(entry), `${skill.key} must be part of the frozen schedule contract`)
      assert(entry.skillFileRelativePath === 'SKILL.md', `${skill.key} must resolve SKILL.md inside .agents/skills/<key>/`)
      assert(registry.LITERATURE_MATRIX_SKILL_KEY === 'literature-matrix', 'matrix key constant drifted')
      assert(registry.LITERATURE_REVIEW_PUSH_SKILL_KEY === 'literature-review-push', 'review key constant drifted')
    }
    assert(registry.projectSkillDirectory(catalog['literature-matrix'], { projectRoot: APP_ROOT }) === path.join(SKILLS_ROOT, 'literature-matrix'), 'project skill directory must be .agents/skills/literature-matrix')
    assert(registry.packagedSkillDirectory(catalog['literature-matrix'], { resourcesPath: 'C:\\app\\resources' }) === path.join('C:\\app\\resources', 'skills', 'literature-matrix'), 'packaged mirror must be resources/skills/<key>')
    return `${Object.keys(catalog).join(', ')}; mirror root ${registry.PACKAGED_SKILLS_MIRROR_ROOT}/<key>/SKILL.md`
  })

  check('registry: the three installation states stay distinguishable (runnable / not-installed / unsupported)', () => {
    const states = {
      last30days: registry.classifyAgentSkillInstallation('last30days', { projectRoot: APP_ROOT }).state,
      matrix: registry.classifyAgentSkillInstallation('literature-matrix', { projectRoot: APP_ROOT }).state,
      review: registry.classifyAgentSkillInstallation('literature-review-push', { projectRoot: APP_ROOT }).state,
      unknown: registry.classifyAgentSkillInstallation('daily-digest', { projectRoot: APP_ROOT }).state
    }
    assert(states.last30days === 'runnable', `last30days must stay runnable, got ${states.last30days}`)
    assert(states.matrix === 'runnable', `literature-matrix must be runnable, got ${states.matrix}`)
    assert(states.review === 'runnable', `literature-review-push must be runnable, got ${states.review}`)
    assert(states.unknown === 'unsupported', `an unknown key must be unsupported, got ${states.unknown}`)
    const unknown = registry.classifyAgentSkillInstallation('daily-digest', { projectRoot: APP_ROOT })
    assert(unknown.diagnostic && unknown.diagnostic.code === 'SKILL_UNSUPPORTED', 'unsupported state must carry SKILL_UNSUPPORTED')
    assert(registry.classifyAgentSkillInstallation('literature-matrix', { projectRoot: APP_ROOT }).diagnostic === null, 'a runnable key must not carry a blocking diagnostic')
    return `last30days=${states.last30days}; matrix=${states.matrix}; review=${states.review}; unknown=${states.unknown}`
  })

  check('registry: both new skills resolve as the instruction-only contract (no engine, no second logic)', () => {
    for (const skill of SKILLS) {
      const resolved = registry.resolveAgentSkill(skill.key, { projectRoot: APP_ROOT, cwd: APP_ROOT })
      assert(resolved.kind === 'instruction', `${skill.key} must resolve as instruction, got ${resolved.kind}`)
      const runtime = resolved.runtime
      assert(runtime.skillPath === path.join(SKILLS_ROOT, skill.key, 'SKILL.md'), `${skill.key}: the canonical SKILL.md must be resolved`)
      assert(runtime.skillSource === 'project', `${skill.key}: a checkout resolves the project source`)
      assert(runtime.enginePath === null && runtime.pythonVersion === null, `${skill.key}: an instruction skill must resolve no engine/interpreter`)
      assert(runtime.pinnedVersion === '1.0.0', `${skill.key}: the runtime must carry the version declared by the skill file, got ${runtime.pinnedVersion}`)
      assert(typeof runtime.markdown === 'string' && runtime.markdown.includes(`name: ${skill.key}`), `${skill.key}: the validated skill text must travel with the runtime`)
      assert(!/[A-Za-z]:[\\/]/u.test(registry.describeInstructionSkillRuntime(runtime)), 'the ledger summary must not leak absolute paths')
    }
    const unknown = registry.resolveAgentSkill('daily-digest', { projectRoot: APP_ROOT })
    assert(unknown.kind === 'unsupported' && unknown.diagnostic.code === 'SKILL_UNSUPPORTED', `unknown key must stay blocked, got ${unknown.kind}`)
    return 'both keys -> kind=instruction + canonical SKILL.md + enginePath=null; unknown key still SKILL_UNSUPPORTED'
  })

  check('registry: the injected briefing carries the validated SKILL.md text plus the rule inputs', () => {
    for (const skill of SKILLS) {
      const resolved = registry.resolveAgentSkill(skill.key, { projectRoot: APP_ROOT, cwd: APP_ROOT })
      assert(resolved.kind === 'instruction', `${skill.key} must resolve as instruction`)
      const briefing = registry.buildInstructionSkillBriefing({
        runtime: resolved.runtime,
        markdown: resolved.runtime.markdown,
        topic: '长上下文检索',
        sources: ['Zotero', 'Obsidian'],
        lookbackDays: 90,
        responseLanguage: 'zh-CN',
        outputFolder: '每日资讯推送',
        projectId: 'project-1'
      })
      assert(briefing.includes(`## 项目 skill：${skill.key}`), `${skill.key}: the briefing must name the skill`)
      assert(briefing.includes('SKILL.md 全文') && briefing.includes(`name: ${skill.key}`), `${skill.key}: the real SKILL.md text must be injected`)
      assert(briefing.includes('长上下文检索'), `${skill.key}: the rule topic must be injected`)
      assert(briefing.includes('zotero, obsidian'), `${skill.key}: normalized sources must be injected`)
      assert(briefing.includes('90'), `${skill.key}: the lookback window must be injected`)
      assert(briefing.includes('每日资讯推送'), `${skill.key}: the output folder must be injected`)
      assert(briefing.includes('Artifact') && briefing.includes('4,000'), `${skill.key}: the projection/output contract must be restated`)
      assert(briefing.includes('不安装任何工具') && briefing.includes('不写 Zotero'), `${skill.key}: the safety boundary must be restated`)
      assert(!/BEGIN [A-Z ]*PRIVATE KEY/u.test(briefing), `${skill.key}: no key material may be injected`)
      assert(!/[A-Za-z]:[\\/]Users[\\/]/iu.test(briefing), `${skill.key}: the briefing must not embed an absolute user path`)
    }
    return 'briefing carries the full SKILL.md + normalized rule inputs + boundary/output contract'
  })

  check('registry: a shipped instruction skill is blocked structurally when the file is missing, unsafe or invalid', () => {
    const offline = { env: {}, cwd: path.join('C:\\', 'nope'), platform: 'win32', exists: () => false, listDirectory: () => [], packagedOnly: true }
    for (const skill of SKILLS) {
      // A shipped key stays a build fact; the *run* is still blocked without its file.
      const verdict = registry.classifyAgentSkillInstallation(skill.key, offline)
      assert(verdict.state === 'runnable', `${skill.key} must stay a registered contract without a checkout, got ${verdict.state}`)
      const resolved = registry.resolveAgentSkill(skill.key, offline)
      assert(resolved.kind === 'unsupported', `${skill.key} must be blocked when the file is missing, got ${resolved.kind}`)
      assert(resolved.diagnostic.code === 'SKILL_MISSING', `${skill.key}: missing file must be SKILL_MISSING, got ${resolved.diagnostic.code}`)
      assert(resolved.diagnostic.detail.includes('规范 SKILL.md'), `${skill.key}: the diagnostic must name the canonical file`)
      assert(!/[A-Za-z]:[\\/]/u.test(resolved.diagnostic.detail), `${skill.key}: stored diagnostics must not leak absolute paths`)
    }
    const tampered = { ...registry.AGENT_SKILL_CATALOG['literature-matrix'], skillFileRelativePath: '../../secret/SKILL.md' }
    const unsafe = registry.resolveInstructionSkill(tampered, { projectRoot: APP_ROOT })
    assert(unsafe.ok === false && unsafe.diagnostic.code === 'SKILL_FILE_UNSAFE', `a traversal path must be SKILL_FILE_UNSAFE, got ${unsafe.ok ? 'resolved' : unsafe.diagnostic.code}`)
    assert(registry.safeSkillFileRelativePath(tampered) === null, 'safeSkillFileRelativePath must reject the traversal entry')
    assert(registry.safeSkillFileRelativePath(registry.AGENT_SKILL_CATALOG['literature-matrix']) === 'SKILL.md', 'the real entry must stay acceptable')
    const swapped = registry.resolveInstructionSkill(registry.AGENT_SKILL_CATALOG['literature-matrix'], {
      projectRoot: APP_ROOT,
      readFile: () => '---\nname: something-else\nversion: "9.9.9"\n---\n' + 'x'.repeat(400)
    })
    assert(swapped.ok === false && swapped.diagnostic.code === 'SKILL_FILE_INVALID', `a name mismatch must be SKILL_FILE_INVALID, got ${swapped.ok ? 'resolved' : swapped.diagnostic.code}`)
    const stub = registry.resolveInstructionSkill(registry.AGENT_SKILL_CATALOG['literature-matrix'], {
      projectRoot: APP_ROOT,
      readFile: () => '---\nname: literature-matrix\nversion: "1.0.0"\n---\ntoo short'
    })
    assert(stub.ok === false && stub.diagnostic.code === 'SKILL_FILE_INVALID', `an incomplete body must be SKILL_FILE_INVALID, got ${stub.ok ? 'resolved' : stub.diagnostic.code}`)
    const wrongKey = registry.resolveInstructionSkill({ ...registry.AGENT_SKILL_CATALOG['last30days'], skillFileRelativePath: 'SKILL.md' }, { projectRoot: APP_ROOT })
    assert(wrongKey.ok === false && wrongKey.diagnostic.code === 'SKILL_FILE_UNSAFE', 'an engine skill must not be resolved through the instruction contract')
    return 'missing -> SKILL_MISSING; traversal -> SKILL_FILE_UNSAFE; swapped name / stub body -> SKILL_FILE_INVALID; last30days uses its own contract'
  })

  check('registry: the schedule editor catalog reports both skills as installed and selectable', () => {
    const catalog = registry.describeAgentSkillCatalog({ projectRoot: APP_ROOT, cwd: APP_ROOT })
    for (const skill of SKILLS) {
      const entry = catalog.find((candidate) => candidate.key === skill.key)
      assert(Boolean(entry), `${skill.key} must appear in the catalog`)
      assert(entry.skillFileFound === true, `${skill.key}: the canonical SKILL.md must be reported as discovered`)
      assert(entry.packagedSkillFileFound === false, `${skill.key}: a checkout must not claim a packaged mirror`)
      assert(entry.availability === 'shipped', `${skill.key}: the key must be shipped now that the contract landed`)
      assert(entry.runnable === true, `${skill.key}: contract + discovered SKILL.md must be selectable in the editor`)
      assert(entry.blockedReason === '', `${skill.key}: a runnable skill must carry no blocked reason, got ${entry.blockedReason}`)
      assert(entry.requiredInputs.includes('topic'), `${skill.key}: topic must be a required input of the schedule contract`)
      assert(entry.blockedReason.length <= 500, `${skill.key}: blockedReason must fit the contract limit`)
    }
    const last30 = catalog.find((candidate) => candidate.key === 'last30days')
    assert(last30 && last30.availability === 'shipped', 'last30days must stay shipped (no regression)')
    return catalog.map((entry) => `${entry.key}: runnable=${String(entry.runnable)}`).join('; ')
  })

  check('registry: a build-time resources/skills mirror keeps both skills runnable without a checkout', () => {
    const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'prw-skills-mirror-'))
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prw-skills-cwd-'))
    try {
      for (const skill of SKILLS) {
        const target = path.join(resources, 'skills', skill.key)
        fs.mkdirSync(target, { recursive: true })
        fs.copyFileSync(path.join(SKILLS_ROOT, skill.key, 'SKILL.md'), path.join(target, 'SKILL.md'))
      }
      const catalog = registry.describeAgentSkillCatalog({ resourcesPath: resources, cwd, packagedOnly: true })
      for (const skill of SKILLS) {
        const entry = catalog.find((candidate) => candidate.key === skill.key)
        assert(entry.packagedSkillFileFound === true, `${skill.key}: the mirror copy must be discovered`)
        assert(entry.skillFileFound === false, `${skill.key}: a packaged app has no checkout to report`)
        assert(entry.runnable === true, `${skill.key}: the mirrored SKILL.md must be usable by an installed app`)
      }
      const resolved = registry.resolveAgentSkill('literature-matrix', { resourcesPath: resources, cwd, packagedOnly: true })
      assert(resolved.kind === 'instruction' && resolved.runtime.skillSource === 'packaged', `the mirror must resolve as the packaged source, got ${resolved.kind}`)
      assert(!resolved.runtime.skillPath.includes('.agents'), 'a packaged process must read the mirror, never a checkout')
      assert(resolved.runtime.skillPath.startsWith(resources), 'the resolved path must stay inside the mirror root')
      return `resources/skills/<key>/SKILL.md resolved as the packaged source: ${SKILLS.map((skill) => skill.key).join(', ')} (mirror is still build-generated only)`
    } finally {
      fs.rmSync(resources, { recursive: true, force: true })
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  check('registry: the two skill files are mirrored by the build config only (single source of truth)', () => {
    const builder = fs.readFileSync(path.join(APP_ROOT, 'apps', 'desktop', 'electron-builder.yml'), 'utf8')
    assert(/from:\s*\.\.\/\.\.\/\.agents\/skills/u.test(builder), 'electron-builder must mirror .agents/skills')
    assert(/to:\s*skills/u.test(builder), 'the mirror target must be resources/skills')
    assert(!/literature-matrix|literature-review-push/u.test(builder), 'the mirror config must not special-case a skill (no second copy)')
    for (const forbidden of [path.join(APP_ROOT, 'resources', 'skills'), path.join(APP_ROOT, 'apps', 'desktop', 'resources', 'skills')]) {
      assert(!fs.existsSync(forbidden), `a hand-written mirror must not exist: ${path.relative(APP_ROOT, forbidden)}`)
    }
    return 'from ../../.agents/skills -> to skills; no hand-written resources/skills copy'
  })

  check('registry: no second hand-maintained copy of either SKILL.md exists in the repository', () => {
    const roots = ['apps', 'packages', 'scripts', 'docs', 'sidecars', '.codex-tasks']
    const found = []
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'out' || entry.name === 'dist') continue
        const full = path.join(directory, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name === 'SKILL.md') found.push(full)
      }
    }
    for (const root of roots) {
      const full = path.join(APP_ROOT, root)
      if (fs.existsSync(full)) walk(full)
    }
    for (const file of found) {
      const text = fs.readFileSync(file, 'utf8')
      for (const skill of SKILLS) {
        assert(!text.includes(`name: ${skill.key}`), `a second copy of ${skill.key} exists at ${path.relative(APP_ROOT, file)}`)
      }
    }
    return `scanned ${found.length} SKILL.md outside .agents/skills; no duplicate of the two project skills`
  })
}

/**
 * Offline helper checks: each project skill ships an executable helper
 * (`scripts/*.py`, stdlib only) plus a machine-readable `schema/contract.json`.
 * The helper self-test is the real offline smoke — it is executed here so a
 * broken helper fails this suite instead of silently passing as prose.
 */
const SKILL_HELPERS = [
  { key: 'literature-matrix', helper: 'scripts/litmatrix.py', prefix: 'MATRIX' },
  { key: 'literature-review-push', helper: 'scripts/litreview.py', prefix: 'REVIEW' },
]

function runHelperSelfTest(helperFile) {
  const { spawnSync } = require('node:child_process')
  const attempts = ['python', 'python3', 'py'].map((bin) =>
    spawnSync(bin, [helperFile, 'self-test'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
  )
  return attempts.find((run) => run.status === 0 && typeof run.stdout === 'string' && run.stdout.trim().startsWith('{')) || null
}

function runHelperChecks() {
  for (const { key, helper, prefix } of SKILL_HELPERS) {
    const helperFile = path.join(SKILLS_ROOT, key, helper)
    const contractFile = path.join(SKILLS_ROOT, key, 'schema', 'contract.json')

    check(`helper: ${key} ships a keyless, contract-backed helper inside its own directory`, () => {
      assert(fs.existsSync(helperFile), `missing ${path.relative(APP_ROOT, helperFile)}`)
      assert(fs.existsSync(contractFile), `missing ${path.relative(APP_ROOT, contractFile)}`)
      const contract = JSON.parse(fs.readFileSync(contractFile, 'utf8'))
      assert(contract.skillKey === key, `contract skillKey ${contract.skillKey} != ${key}`)
      assert(contract.diagnosticPrefix === prefix, `contract diagnosticPrefix ${contract.diagnosticPrefix} != ${prefix}`)
      const networkSources = (contract.sources || []).filter((source) => source.kind === 'network')
      assert(networkSources.length >= 4, `${key} declares ${networkSources.length} network sources`)
      assert(networkSources.every((source) => source.auth === 'none'), `${key} network sources must be keyless (auth=none)`)
      const forbidden = contract.security.forbiddenReads || contract.security.forbiddenPaths || []
      assert(forbidden.includes('zotero.sqlite'), `${key} contract must forbid reading zotero.sqlite`)
      assert(contract.evidence.helperLevel, `${key} contract must state which evidence levels the helper may set`)
      assert(contract.cache.defaultLocation.includes('prw-literature-cache'), `${key} cache must default outside the repository`)
      return `${path.relative(APP_ROOT, helperFile)} + contract (${prefix}_* codes, ${networkSources.length} keyless network sources, writes only to ${contract.cache.defaultLocation.slice(0, 24)}…)`
    })

    check(`helper: ${key} offline self-test passes and never leaks cross-skill diagnostic codes`, () => {
      const text = fs.readFileSync(helperFile, 'utf8')
      const foreign = [...new Set((text.match(/\b(?:MATRIX|REVIEW)_[A-Z_]+\b/g) || []).filter((code) => !code.startsWith(`${prefix}_`)))]
      assert(foreign.length === 0, `${key} helper emits foreign diagnostic codes: ${foreign.join(', ')}`)
      assert(!/\bauth(orization)?\b\s*[=:]/i.test(text), `${key} helper must not build an Authorization header`)
      assert(!/\bsk-[A-Za-z0-9]{16,}/.test(text), `${key} helper must not embed secret-looking literals`)
      const run = runHelperSelfTest(helperFile)
      assert(run, `${key} helper self-test did not run (no python interpreter produced a JSON envelope)`)
      const payload = JSON.parse(run.stdout)
      assert(payload.status === 'ok', `${key} helper self-test status=${payload.status}: ${JSON.stringify((payload.diagnostics || []).map((item) => item.code))}`)
      assert(payload.data.passed === payload.data.total, `${key} helper self-test ${payload.data.passed}/${payload.data.total}`)
      assert(payload.data.total >= 10, `${key} helper self-test only ran ${payload.data.total} checks`)
      return `${payload.data.passed}/${payload.data.total} offline checks passed; no credential material, no cross-skill codes`
    })
  }
}

function main() {
  console.log('# literature-matrix / literature-review-push skill verification (offline)')
  console.log(`skills root: ${SKILLS_ROOT}`)
  console.log(`network / model run: not part of this check (see docs/implementation/14 and 15 for the unverified items)`)
  console.log('')

  runStructureChecks()
  runHelperChecks()
  const registry = bundleSkillRegistry()
  runRegistryChecks(registry)

  const passed = results.filter((entry) => entry.status === 'PASS').length
  const failed = results.filter((entry) => entry.status === 'FAIL').length
  if (asJson) {
    console.log(JSON.stringify({ passed, failed, blocked, results }, null, 2))
  } else {
    console.log('')
    console.log(`summary: ${passed} passed, ${failed} failed, ${blocked} blocked`)
  }
  process.exitCode = failed > 0 || blocked > 0 ? 1 : 0
}

main()
