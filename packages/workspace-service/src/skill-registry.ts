import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { AGENT_SCHEDULE_SKILL_CATALOG, AGENT_SCHEDULE_SKILL_KEYS, type AgentResponseLanguage, type AgentScheduleSkillCatalogEntry, type AgentScheduleSkillKey, type AgentScheduleSkillOption } from '@prw/contracts'

/**
 * Repository-pinned agent skills.
 *
 * The single canonical source of every project skill is the repository's
 * `.agents/skills/<skillKey>/` directory. All Agent runtimes read the skill
 * from there; a packaged app gets a build-time *mirror* of the same directory
 * under `resources/skills/<skillKey>/` (electron-builder copies
 * `.agents/skills` → `skills`), which this module may resolve but never treats
 * as a second, hand-maintained source.
 *
 * `last30days` is a vendored upstream checkout under
 * `.agents/skills/last30days` (pinned commit + version recorded in its
 * `PRW-PIN.md`). A skill run is not just "a longer prompt": it must load a
 * specific `SKILL.md`, run a local engine with a specific interpreter, and
 * write its evidence into an isolated directory. This module therefore owns
 * discovery (which key maps to which canonical directory), validation (is the
 * `SKILL.md`/engine/interpreter actually usable) and injection metadata, and
 * turns everything that can fail into a discriminated result that callers can
 * record as an honest, diagnosable run instead of silently falling back to a
 * generic workflow.
 */

export const LAST30DAYS_SKILL_KEY = 'last30days'
export const LITERATURE_MATRIX_SKILL_KEY = 'literature-matrix'
export const LITERATURE_REVIEW_PUSH_SKILL_KEY = 'literature-review-push'

/**
 * The two instruction-only project skills.
 *
 * They have no engine and no interpreter: the execution contract *is* their
 * canonical `SKILL.md`. The Agent runtime reads that file (Pi receives it as
 * `--skill`, both runtimes receive its full text in the injected briefing) and
 * has to execute it step by step; the final answer is only the article body,
 * which the existing Artifact / Inbox / Obsidian projection then persists. The
 * registry therefore validates *the skill file* (path containment, frontmatter
 * identity, non-empty body) instead of probing a local engine.
 */
export const INSTRUCTION_SKILL_KEYS = [LITERATURE_MATRIX_SKILL_KEY, LITERATURE_REVIEW_PUSH_SKILL_KEY] as const

export type InstructionSkillKey = (typeof INSTRUCTION_SKILL_KEYS)[number]

/** Hard bound on an injected `SKILL.md`: a skill file is a prompt contract, not
 * a data dump, and an unbounded file would silently consume the whole context. */
export const INSTRUCTION_SKILL_MAX_CHARS = 400_000

/** A `SKILL.md` shorter than this cannot describe inputs, evidence rules, the
 * failure semantics and the output contract, so it is rejected as incomplete
 * instead of being injected as a plausible-looking stub. */
export const INSTRUCTION_SKILL_MIN_BODY_CHARS = 200

export function isInstructionSkillKey(skillKey: string): skillKey is InstructionSkillKey {
  return (INSTRUCTION_SKILL_KEYS as readonly string[]).includes(skillKey)
}

/** The engine needs `datetime.UTC`/`itertools.batched`-era stdlib features and
 * is only tested by upstream on 3.12+; a 3.11 interpreter fails at import time
 * with an unrelated traceback, so the gate lives here with a clear message. */
export const LAST30DAYS_MINIMUM_PYTHON: readonly [number, number] = [3, 12]

/** Canonical project-skill root, relative to the repository root. Every skill
 * source file (including `SKILL.md`) lives under here and nowhere else. */
export const PROJECT_SKILLS_RELATIVE_ROOT = join('.agents', 'skills')

/** Root a packaged app's `resources` directory mirrors the canonical root into.
 * The mirror is produced by the build from `.agents/skills`; editing it by hand
 * creates exactly the second source this module is designed to prevent. */
export const PACKAGED_SKILLS_MIRROR_ROOT = 'skills'

/** Repository root that owns `.agents/skills`, set by Electron Main for a
 * development/checkout process. The Core process runs with the user-data
 * directory as its working directory, so `process.cwd()` alone cannot find the
 * canonical skill sources; Main resolves the checkout once and passes it down
 * as an explicit anchor instead. An installed app never sets it. */
export const PROJECT_ROOT_ENV = 'PRW_PROJECT_ROOT'

/** Marks a packaged (installed) process. Discovery then reads only the
 * build-time `resources/skills` mirror and never walks out of the package into
 * a `.agents/skills` checkout that happens to sit above the working
 * directory. */
export const PACKAGED_APP_ENV = 'PRW_PACKAGED_APP'

/** Bounded walk-up, so a stray working directory cannot search a whole volume. */
const PROJECT_ROOT_MAX_DEPTH = 8

/** Relative to `.agents/skills/<skillKey>/` and to `resources/skills/<skillKey>/`. */
const last30daysSkillRelativePath = AGENT_SCHEDULE_SKILL_CATALOG[LAST30DAYS_SKILL_KEY].skillFileRelativePath
const engineRelativePath = join('scripts', 'last30days.py')

/**
 * Discovery + validation contract of one selectable skill key.
 *
 * The frozen selection catalog itself lives in `@prw/contracts` so the
 * renderer, the coordinator and this registry all read one definition; this
 * module owns the *runtime* facts on top of it (is the canonical `SKILL.md`
 * present, is the engine usable, which interpreter runs it).
 */
export type AgentSkillCatalogEntry = AgentScheduleSkillOption

export const AGENT_SKILL_CATALOG: Readonly<Record<AgentScheduleSkillKey, AgentSkillCatalogEntry>> = AGENT_SCHEDULE_SKILL_CATALOG

/** Skill keys with a registered execution contract in this build. */
export const SUPPORTED_AGENT_SKILL_KEYS = AGENT_SCHEDULE_SKILL_KEYS.filter(
  (key): key is typeof LAST30DAYS_SKILL_KEY => AGENT_SKILL_CATALOG[key].availability === 'shipped'
)
export type AgentSkillKey = (typeof SUPPORTED_AGENT_SKILL_KEYS)[number]

/** Skill keys the frozen schedule contract accepts but this build cannot run. */
export const RESERVED_AGENT_SKILL_KEYS: readonly AgentScheduleSkillKey[] = AGENT_SCHEDULE_SKILL_KEYS.filter(
  (key) => AGENT_SKILL_CATALOG[key].availability === 'reserved'
)

export type AgentSkillDiagnosticCode =
  | 'SKILL_UNSUPPORTED'
  | 'SKILL_NOT_INSTALLED'
  | 'SKILL_MISSING'
  /** The catalog entry or the skill file breaks the discovery contract: a
   * relative path that escapes its skill directory, or a file over the bounded
   * injectable size. Blocked instead of injecting an unvalidated path/blob. */
  | 'SKILL_FILE_UNSAFE'
  /** The skill file was found but is not a usable instruction skill: missing/
   * mismatched `name` frontmatter, unreadable, or an incomplete body. */
  | 'SKILL_FILE_INVALID'
  | 'SKILL_ENGINE_MISSING'
  | 'SKILL_PYTHON_MISSING'
  | 'SKILL_PYTHON_TOO_OLD'
  | 'SKILL_PROBE_FAILED'
  /** The skill's engine is a local process that used to be launched through the
   * spawned CLI's shell. The embedded Agent has no shell tool, so the engine has
   * no execution channel yet: the run is blocked instead of emitting prose where
   * engine evidence belongs. */
  | 'SKILL_ENGINE_UNAVAILABLE_INPROCESS'
  | 'SKILL_PROBE_NETWORK_UNREACHABLE'
  | 'SKILL_PROBE_PERMISSION_DENIED'
  | 'SKILL_SOURCES_UNAVAILABLE'

export interface AgentSkillDiagnostic {
  readonly code: AgentSkillDiagnosticCode
  /** One-line, operator-facing Chinese message. */
  readonly message: string
  /** Multi-line, redaction-safe evidence: which paths/interpreters were probed
   * and what each probe reported. Never contains an absolute user path. */
  readonly detail: string
}

export type Last30DaysPythonSource = 'env' | 'path' | 'windows-install'

export interface Last30DaysSkillRuntime {
  readonly key: AgentSkillKey
  /** Absolute `SKILL.md` the agent must read before acting. */
  readonly skillPath: string
  readonly skillDir: string
  readonly enginePath: string
  readonly pythonPath: string
  readonly pythonVersion: string
  readonly pythonSource: Last30DaysPythonSource
  readonly skillSource: 'env' | 'project' | 'packaged'
  /** Version/commit recorded in the checkout's `PRW-PIN.md`. `null` means the
   * checkout has no pin file; the run then honestly reports an unpinned skill
   * instead of inventing a version. */
  readonly pinnedVersion: string | null
  readonly pinnedCommit: string | null
}

export type ResolvedAgentSkill =
  | { readonly kind: 'none' }
  | { readonly kind: 'last30days'; readonly runtime: Last30DaysSkillRuntime }
  /** Instruction-only skill: the runtime executes the canonical `SKILL.md`.
   * Structurally shares `key`/`skillPath`/`skillDir`/`skillSource`/`pinnedVersion`
   * with `Last30DaysSkillRuntime` so the run ledger, the skill snapshot and the
   * adapter `--skill` argument reuse one code path; `enginePath` and
   * `pythonVersion` stay `null` because there is no local engine to run. */
  | { readonly kind: 'instruction'; readonly runtime: InstructionSkillRuntime }
  /** Unknown key: not part of the frozen schedule contract at all. */
  | { readonly kind: 'unsupported'; readonly skillKey: string; readonly diagnostic: AgentSkillDiagnostic }
  /** Known, selectable key without a registered execution contract in this
   * build. Kept distinct from `unsupported` because the operator action
   * differs: install/wait for the contract instead of picking a valid key. */
  | { readonly kind: 'not-installed'; readonly skillKey: string; readonly diagnostic: AgentSkillDiagnostic }

export interface PythonProbeResult {
  readonly available: boolean
  readonly version: string | null
  /** Redaction-safe explanation of why the interpreter was rejected. */
  readonly detail: string
}

/**
 * Injectable environment access. Tests pass fakes; production passes nothing
 * and gets the real filesystem, `spawnSync` probe, and `process` values.
 */
export interface AgentSkillProbe {
  readonly exists?: ((path: string) => boolean) | undefined
  readonly listDirectory?: ((path: string) => readonly string[]) | undefined
  readonly readFile?: ((path: string) => string) | undefined
  readonly probePython?: ((command: string) => PythonProbeResult) | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly cwd?: string | undefined
  readonly resourcesPath?: string | undefined
  readonly platform?: NodeJS.Platform | undefined
  /** Explicit repository root (the directory that contains `.agents/skills`).
   * Highest-priority anchor, used by Electron Main and by tests. */
  readonly projectRoot?: string | undefined
  /** True when this process is an installed package: the canonical checkout is
   * not shipped, so only the `resources/skills` mirror may be used. */
  readonly packagedOnly?: boolean | undefined
}

export function isSupportedAgentSkillKey(skillKey: string): skillKey is AgentSkillKey {
  return (SUPPORTED_AGENT_SKILL_KEYS as readonly string[]).includes(skillKey)
}

/** Known = selectable in the frozen schedule contract, installed or not. */
export function isKnownAgentSkillKey(skillKey: string): skillKey is AgentScheduleSkillKey {
  return (AGENT_SCHEDULE_SKILL_KEYS as readonly string[]).includes(skillKey)
}

/** `null` for an unknown key, so callers can block an unknown selection with a
 * structured error instead of guessing a default skill. */
export function agentSkillCatalogEntry(skillKey: string | null | undefined): AgentSkillCatalogEntry | null {
  const normalized = normalizeAgentSkillKey(skillKey)
  return normalized !== null && isKnownAgentSkillKey(normalized) ? AGENT_SKILL_CATALOG[normalized] : null
}

/** Normalize any skill-key input. `''` and whitespace behave like "no skill"
 * so an empty select value can never select a skill by accident. */
export function normalizeAgentSkillKey(skillKey: string | null | undefined): string | null {
  const trimmed = skillKey?.trim() ?? ''
  return trimmed.length === 0 ? null : trimmed
}

/**
 * Installation state of one skill key. The three states need different
 * operator actions, so they are never collapsed into one boolean:
 *
 * - `runnable`: this build registers an execution contract for the key, so a
 *   run proceeds to the per-run capability probe.
 * - `not-installed`: the key is part of the frozen schedule contract but this
 *   build registers no execution contract for it (no engine, no injection
 *   rule), so the run is blocked with `SKILL_NOT_INSTALLED` instead of
 *   silently degrading to a generic workflow.
 * - `unsupported`: the key is not in the frozen contract at all, so nothing can
 *   be said about it; blocked with `SKILL_UNSUPPORTED`.
 *
 * Discovery is filesystem-only (no interpreter spawn), so classification is
 * cheap and safe to run while rendering the schedule editor.
 */
export type AgentSkillInstallationState = 'runnable' | 'not-installed' | 'unsupported'

export type AgentSkillInstallationVerdict =
  | { readonly skillKey: string; readonly state: 'runnable'; readonly diagnostic: null }
  | { readonly skillKey: string; readonly state: 'not-installed' | 'unsupported'; readonly diagnostic: AgentSkillDiagnostic }

/**
 * Classify a skill key without running anything. `resolveAgentSkill` and the
 * catalog projection both go through here, so the editor's "not installed"
 * label and the run's blocked diagnostic can never disagree about whether a
 * key is unknown, merely uninstalled, or actually runnable.
 */
export function classifyAgentSkillInstallation(
  skillKey: string,
  probe: AgentSkillProbe = {}
): AgentSkillInstallationVerdict {
  const normalized = normalizeAgentSkillKey(skillKey)
  const entry = normalized === null ? null : agentSkillCatalogEntry(normalized)
  if (!entry) {
    // An empty key already means "no skill" at the call sites; classifying it
    // here as unsupported keeps this function total (`resolveAgentSkill`
    // returns `none` before ever asking).
    const requested = normalized ?? ''
    return {
      skillKey: requested,
      state: 'unsupported',
      diagnostic: {
        code: 'SKILL_UNSUPPORTED',
        message: `未知的 skill "${requested}"；本版本的排程合同只接受 ${AGENT_SCHEDULE_SKILL_KEYS.map((key) => `"${key}"`).join('、')}。`,
        detail: [
          `请求的 skillKey: ${requested.length > 0 ? requested : '(空)'}`,
          `合同中的 skillKey: ${AGENT_SCHEDULE_SKILL_KEYS.join(', ')}`,
          `本构建已注册执行合同的 skillKey: ${SUPPORTED_AGENT_SKILL_KEYS.join(', ')}`
        ].join('\n')
      }
    }
  }
  // A reserved key is selectable but never runnable in this build: reporting it
  // as installed would let a schedule look like it produces a matrix/review
  // push while nothing behind it exists. A `SKILL.md` that already exists on
  // disk does *not* change this — without an execution contract and injection
  // rule there is nothing that could run it.
  if (entry.availability !== 'shipped') {
    const probeState = locateSkillFile(entry, probe)
    const fileFound = probeState.projectFound || probeState.packagedFound
    return {
      skillKey: entry.key,
      state: 'not-installed',
      diagnostic: {
        code: 'SKILL_NOT_INSTALLED',
        message: `skill "${entry.key}" 在本版本中尚未注册执行合同（计划中，未安装）；本次运行已阻断，不会退化为通用工作流。`,
        detail: [
          `skillKey: ${entry.key}`,
          `注册状态: reserved（仅预留 key，无引擎/注入合同）`,
          `规范 SKILL.md: ${fileFound ? '已存在，但本构建不会注入它' : '磁盘上未发现'}`,
          `预期产出: ${entry.summary}`,
          ...skillSourceDiagnosticLines(entry, probe, probeState)
        ].join('\n')
      }
    }
  }
  return { skillKey: entry.key, state: 'runnable', diagnostic: null }
}

export function resolveAgentSkill(
  skillKey: string | null | undefined,
  probe: AgentSkillProbe = {}
): ResolvedAgentSkill {
  const normalized = normalizeAgentSkillKey(skillKey)
  if (normalized === null) return { kind: 'none' }
  const verdict = classifyAgentSkillInstallation(normalized, probe)
  if (verdict.state === 'unsupported') {
    return { kind: 'unsupported', skillKey: verdict.skillKey, diagnostic: verdict.diagnostic }
  }
  if (verdict.state === 'not-installed') {
    return { kind: 'not-installed', skillKey: verdict.skillKey, diagnostic: verdict.diagnostic }
  }
  if (isInstructionSkillKey(verdict.skillKey)) {
    const entry = AGENT_SKILL_CATALOG[verdict.skillKey]
    const resolved = resolveInstructionSkill(entry, probe)
    // A shipped key whose file is missing, unsafe or unusable stays a structured
    // *block* (never a silently downgraded generic run). The kind is
    // `unsupported` for the whole "cannot be executed by this build/checkout"
    // family, exactly like the last30days missing-file path, and the diagnostic
    // code is what distinguishes an unknown key from an incomplete install.
    return resolved.ok
      ? { kind: 'instruction', runtime: resolved.runtime }
      : { kind: 'unsupported', skillKey: verdict.skillKey, diagnostic: resolved.diagnostic }
  }
  return resolveLast30DaysSkill(probe)
}

/**
 * Execution contract of an instruction-only skill.
 *
 * The shape deliberately mirrors the fields `toSkillSnapshot`/
 * `labelDiagnosticPath` already consume, so the coordinator does not grow a
 * second, skill-specific snapshot or path-redaction path.
 */
export interface InstructionSkillRuntime {
  readonly key: InstructionSkillKey
  /** Absolute `SKILL.md` the agent runtime must read and execute. */
  readonly skillPath: string
  readonly skillDir: string
  /** Validated full text of `skillPath`, read once at resolution so the
   * injected contract is exactly the file that was validated. */
  readonly markdown: string
  readonly enginePath: null
  readonly pythonVersion: null
  readonly skillSource: 'project' | 'packaged'
  /** Version declared by the skill file's own frontmatter (`null` when the
   * frontmatter carries none, which is reported honestly instead of invented). */
  readonly pinnedVersion: string | null
  readonly pinnedCommit: null
}

export type InstructionSkillResolution =
  | { readonly ok: true; readonly runtime: InstructionSkillRuntime }
  | { readonly ok: false; readonly diagnostic: AgentSkillDiagnostic }

/**
 * Validate one catalog entry's own relative path before joining it anywhere.
 *
 * The catalog is a frozen contract, so this is defence in depth: a tampered or
 * future entry can never make the registry read or inject a file outside
 * `.agents/skills/<key>/` (or its `resources/skills/<key>/` mirror).
 */
export function safeSkillFileRelativePath(entry: AgentSkillCatalogEntry): string | null {
  const raw = entry.skillFileRelativePath.trim()
  if (raw.length === 0) return null
  if (isAbsolute(raw) || /^[A-Za-z]:/u.test(raw) || /^[\\/]/u.test(raw)) return null
  if (raw.includes('\u0000')) return null
  const segments = raw.split(/[\\/]+/u)
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return null
  return join(...segments)
}

/** `resolve`-based containment check: `child` must sit strictly inside `parent`. */
export function isPathInsideDirectory(parent: string, child: string): boolean {
  const remainder = relative(resolve(parent), resolve(child))
  return remainder.length > 0 && !remainder.startsWith('..') && !isAbsolute(remainder)
}

/**
 * Resolve the instruction-only execution contract of one catalog entry.
 *
 * Only two locations are ever considered — the canonical
 * `.agents/skills/<key>/` directory and the build-time `resources/skills/<key>/`
 * mirror — and both are checked to still be *inside* the skill directory after
 * joining, so the skill source stays single and the injected path stays safe.
 */
export function resolveInstructionSkill(
  entry: AgentSkillCatalogEntry,
  probe: AgentSkillProbe = {}
): InstructionSkillResolution {
  if (!isInstructionSkillKey(entry.key)) {
    return {
      ok: false,
      diagnostic: {
        code: 'SKILL_FILE_UNSAFE',
        message: `skill "${entry.key}" 不是指令型 skill，无法用该合同执行；本次运行已阻断。`,
        detail: `skillKey: ${entry.key}\n允许的指令型 key: ${INSTRUCTION_SKILL_KEYS.join(', ')}`
      }
    }
  }
  const skillKey: InstructionSkillKey = entry.key
  const relativePath = safeSkillFileRelativePath(entry)
  if (relativePath === null) {
    return {
      ok: false,
      diagnostic: {
        code: 'SKILL_FILE_UNSAFE',
        message: `skill "${entry.key}" 的 catalog 条目声明了不安全的 SKILL.md 相对路径，本次运行已阻断。`,
        detail: [
          `skillKey: ${entry.key}`,
          `声明的相对路径: ${JSON.stringify(entry.skillFileRelativePath)}`,
          '只允许 .agents/skills/<key>/ 下的普通相对路径（不允许绝对路径、盘符、.. 穿越或空组件）。'
        ].join('\n')
      }
    }
  }
  const candidates: Array<{ readonly dir: string; readonly source: 'project' | 'packaged' }> = [
    { dir: projectSkillDirectory(entry, probe), source: 'project' }
  ]
  const packagedDir = packagedSkillDirectory(entry, probe)
  if (packagedDir) candidates.push({ dir: packagedDir, source: 'packaged' })
  const fileState = locateSkillFile(entry, probe)
  for (const candidate of candidates) {
    const path = join(resolve(candidate.dir), relativePath)
    if (!isPathInsideDirectory(candidate.dir, path)) continue
    const read = readInstructionSkillFile(path, skillKey, probe)
    if (read.kind === 'missing') continue
    if (read.kind === 'invalid') {
      return {
        ok: false,
        diagnostic: {
          code: 'SKILL_FILE_INVALID',
          message: `skill "${entry.key}" 的 SKILL.md 存在但不可用作指令合同（frontmatter 身份/正文不完整或超出上限）；本次运行已阻断。`,
          detail: [
            `skillKey: ${entry.key}`,
            `SKILL.md: ${labelDiagnosticPath(path, probe)}`,
            `原因: ${read.reason}`,
            ...skillSourceDiagnosticLines(entry, probe, fileState)
          ].join('\n')
        }
      }
    }
    return {
      ok: true,
      runtime: {
        key: skillKey,
        skillPath: path,
        skillDir: dirname(path),
        markdown: read.markdown,
        enginePath: null,
        pythonVersion: null,
        skillSource: candidate.source,
        pinnedVersion: read.version,
        pinnedCommit: null
      }
    }
  }
  return {
    ok: false,
    diagnostic: {
      code: 'SKILL_MISSING',
      message: `skill "${entry.key}" 未安装：未发现规范 SKILL.md（打包镜像也未发现）；本次运行已阻断，不会退化为通用工作流。`,
      detail: [
        `skillKey: ${entry.key}`,
        `期望的 SKILL.md 相对路径: ${relativePath}`,
        ...skillSourceDiagnosticLines(entry, probe, fileState),
        '修复方式: 在仓库的 .agents/skills 目录补齐该 skill 的 SKILL.md（唯一手工维护位置）；不要手工创建 resources/skills 副本。'
      ].join('\n')
    }
  }
}

/**
 * Read + validate the injectable skill file.
 *
 * Validation is about *identity and size*, not about the skill's subject
 * matter: the frontmatter `name` must match the catalog key (so a renamed or
 * swapped file is never injected as the requested skill), the body must be a
 * real contract rather than a stub, and the file must stay within the bounded
 * injectable size.
 */
export function readInstructionSkillFile(
  skillPath: string,
  skillKey: InstructionSkillKey,
  probe: AgentSkillProbe = {}
): { readonly kind: 'missing' } | { readonly kind: 'invalid'; readonly reason: string } | { readonly kind: 'ok'; readonly markdown: string; readonly version: string | null } {
  const exists = probe.exists ?? existsSync
  if (!exists(skillPath)) return { kind: 'missing' }
  const readFile = probe.readFile ?? readFileSyncDefault
  let markdown: string
  try {
    markdown = readFile(skillPath)
  } catch (error) {
    return { kind: 'invalid', reason: `无法读取文件（${error instanceof Error ? error.name : 'read failed'}）` }
  }
  if (markdown.includes('\u0000')) return { kind: 'invalid', reason: '文件包含 NUL 字节' }
  if (markdown.length > INSTRUCTION_SKILL_MAX_CHARS) {
    return { kind: 'invalid', reason: `文件长度 ${String(markdown.length)} 超过可注入上限 ${String(INSTRUCTION_SKILL_MAX_CHARS)}` }
  }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(markdown)
  if (!frontmatter) return { kind: 'invalid', reason: '缺少 --- 分隔的 YAML frontmatter' }
  const frontmatterBlock = frontmatter[1] ?? ''
  const name = /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/mu.exec(frontmatterBlock)?.[1]?.trim() ?? null
  if (name !== skillKey) {
    return { kind: 'invalid', reason: `frontmatter 的 name 必须是 "${skillKey}"，实际 ${JSON.stringify(name)}` }
  }
  const version = /^version:\s*["']?([^"'\r\n]+?)["']?\s*$/mu.exec(frontmatterBlock)?.[1]?.trim() ?? null
  const body = markdown.slice(frontmatter[0].length).trim()
  if (body.length < INSTRUCTION_SKILL_MIN_BODY_CHARS) {
    return { kind: 'invalid', reason: `正文长度 ${String(body.length)} 小于 ${String(INSTRUCTION_SKILL_MIN_BODY_CHARS)}，不足以构成执行合同` }
  }
  return { kind: 'ok', markdown, version: version && version.length > 0 ? version : null }
}

/**
 * Repository root that owns the canonical `.agents/skills` directory, or `null`
 * when this process has no checkout to read from (an installed app).
 *
 * `process.cwd()` is deliberately the *last* anchor instead of the only one:
 * the Core process is launched with the workbench user-data directory as its
 * working directory, so a `pnpm dev`/e2e run must never depend on it. Explicit
 * anchors (`probe.projectRoot`, `PRW_PROJECT_ROOT`) win, then a bounded walk up
 * from the working directory (which finds the checkout from `apps/desktop`),
 * and a packaged process stops at the mirror instead of walking anywhere.
 */
export function resolveProjectRoot(probe: AgentSkillProbe = {}): string | null {
  const exists = probe.exists ?? existsSync
  const env = readEnv(probe)
  const hasSkillsRoot = (root: string): boolean => exists(join(root, PROJECT_SKILLS_RELATIVE_ROOT))
  for (const configured of [probe.projectRoot, env[PROJECT_ROOT_ENV]]) {
    const value = configured?.trim() ?? ''
    if (value.length === 0) continue
    const root = resolve(value)
    if (hasSkillsRoot(root)) return root
  }
  if (probe.packagedOnly ?? env[PACKAGED_APP_ENV] === '1') return null
  let directory = resolve(probe.cwd ?? process.cwd())
  for (let depth = 0; depth <= PROJECT_ROOT_MAX_DEPTH; depth += 1) {
    if (hasSkillsRoot(directory)) return directory
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return null
}

/** Canonical project skill directory of a catalog entry (`%REPO%/.agents/skills/<key>`).
 * Without a resolvable checkout this returns the path a diagnostic should name,
 * so an operator still sees which directory was expected. */
export function projectSkillDirectory(entry: AgentSkillCatalogEntry, probe: AgentSkillProbe = {}): string {
  const root = resolveProjectRoot(probe) ?? resolve(probe.cwd ?? process.cwd())
  return join(root, PROJECT_SKILLS_RELATIVE_ROOT, entry.key)
}

/** Build-time mirror directory a packaged app exposes as `resources/skills/<key>`. */
export function packagedSkillDirectory(entry: AgentSkillCatalogEntry, probe: AgentSkillProbe = {}): string | null {
  const resourcesPath = probe.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return resourcesPath ? join(resourcesPath, PACKAGED_SKILLS_MIRROR_ROOT, entry.key) : null
}

/** Discovery: which `SKILL.md` (if any) exists for a catalog entry. */
interface SkillFileProbeState {
  readonly projectPath: string
  readonly projectFound: boolean
  readonly packagedPath: string | null
  readonly packagedFound: boolean
}

function locateSkillFile(entry: AgentSkillCatalogEntry, probe: AgentSkillProbe): SkillFileProbeState {
  const exists = probe.exists ?? existsSync
  const projectPath = join(projectSkillDirectory(entry, probe), entry.skillFileRelativePath)
  const packagedDir = packagedSkillDirectory(entry, probe)
  const packagedPath = packagedDir ? join(packagedDir, entry.skillFileRelativePath) : null
  return {
    projectPath,
    projectFound: exists(projectPath),
    packagedPath,
    packagedFound: packagedPath !== null && exists(packagedPath)
  }
}

/**
 * Runtime projection of the frozen skill catalog for the schedule editor.
 *
 * The editor must not fake availability: a reserved key (no registered
 * execution contract in this build) or a shipped key whose canonical
 * `SKILL.md` is not on disk is reported as not runnable with an explicit
 * reason, so selecting it in the UI warns about the blocked run instead of
 * looking like an installed skill. Discovery is filesystem-only (no
 * interpreter spawn) so rendering the catalog is cheap; the per-run capability
 * probe still gates the actual execution.
 */
export function describeAgentSkillCatalog(probe: AgentSkillProbe = {}): AgentScheduleSkillCatalogEntry[] {
  return AGENT_SCHEDULE_SKILL_KEYS.map((key) => {
    const entry = AGENT_SKILL_CATALOG[key]
    const state = locateSkillFile(entry, probe)
    const fileFound = state.projectFound || state.packagedFound
    // One classification pass decides the state. The catalog only enumerates
    // contract keys, so an entry is either runnable (contract + discovered
    // `SKILL.md`) or not-installed — the editor must never present the second
    // kind as an apparently usable option.
    const verdict = classifyAgentSkillInstallation(entry.key, probe)
    // A shipped instruction-only skill is only runnable if its file is really
    // injectable (present, inside its skill directory, identity + size valid),
    // so the editor's label is produced by the same contract the run enforces
    // and cannot promise a run that would then be blocked.
    const instruction =
      verdict.state === 'runnable' && isInstructionSkillKey(entry.key) ? resolveInstructionSkill(entry, probe) : null
    const runnable = verdict.state === 'runnable' && fileFound && (instruction === null || instruction.ok)
    const skillTarget = `${PROJECT_SKILLS_RELATIVE_ROOT}/${entry.key}/${entry.skillFileRelativePath}`
    return {
      key: entry.key,
      label: entry.label,
      availability: entry.availability,
      skillFileRelativePath: entry.skillFileRelativePath,
      requiredInputs: [...entry.requiredInputs],
      summary: entry.summary,
      skillFileFound: state.projectFound,
      packagedSkillFileFound: state.packagedFound,
      runnable,
      blockedReason: runnable
        ? ''
        : verdict.state === 'not-installed'
          ? `未安装：本版本只预留 skill key “${entry.key}”，尚未注册执行合同（无引擎与注入规则）；规范 SKILL.md ${fileFound ? '已存在' : '未发现'}（${skillTarget}），但本构建不会注入它；选择后运行会被阻断并记录 SKILL_NOT_INSTALLED。`
          : instruction && !instruction.ok
            ? `${instruction.diagnostic.message}（${instruction.diagnostic.code}）规范文件：${skillTarget}。`
            : `未安装：未发现 ${skillTarget}（打包镜像也未发现）；选择后运行会被阻断并记录 SKILL_MISSING。`
    }
  })
}

/**
 * Redaction-safe discovery lines for a diagnostic. The canonical source is
 * always `.agents/skills/<key>`; `resources/skills/<key>` is only the mirror the
 * build generates from it, so an operator is never pointed at a second place
 * where a skill could (or should) be hand-edited.
 */
function skillSourceDiagnosticLines(
  entry: AgentSkillCatalogEntry,
  probe: AgentSkillProbe,
  state: SkillFileProbeState
): string[] {
  const mirrorNote = '由构建从 .agents/skills 镜像生成，不是第二份手工源文件'
  return [
    `项目路径（规范源目录，唯一手工维护位置）: ${labelDiagnosticPath(projectSkillDirectory(entry, probe), probe)}`,
    `规范 SKILL.md: ${labelDiagnosticPath(state.projectPath, probe)}（${state.projectFound ? '已发现' : '未发现'}）`,
    `打包镜像 SKILL.md: ${state.packagedPath ? `${labelDiagnosticPath(state.packagedPath, probe)}（${state.packagedFound ? '已发现' : '未发现'}）` : '(无 resourcesPath，非打包进程)'} [${mirrorNote}]`
  ]
}

function readEnv(probe: AgentSkillProbe): Record<string, string | undefined> {
  return { ...(probe.env ?? process.env) }
}

function pathTokens(probe: AgentSkillProbe, env: Record<string, string | undefined>) {
  const cwd = probe.cwd ?? process.cwd()
  const projectRoot = resolveProjectRoot(probe)
  const resourcesPath = probe.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates: Array<[string | undefined, string]> = [
    [resourcesPath, '%RESOURCES%'],
    [env['LOCALAPPDATA'], '%LOCALAPPDATA%'],
    [env['APPDATA'], '%APPDATA%'],
    [env['USERPROFILE'], '%USERPROFILE%'],
    [env['ProgramFiles'], '%PROGRAMFILES%'],
    [env['TEMP'], '%TEMP%'],
    [env['HOME'], '%HOME%'],
    [projectRoot ?? undefined, '%REPO%'],
    [cwd, '%REPO%']
  ]
  return candidates
    .flatMap(([root, label]) => (root && root.trim().length > 0 ? [{ root: resolve(root), label }] : []))
    .sort((left, right) => right.root.length - left.root.length)
}

/**
 * Render a path for a stored diagnostic (run ledger / run event) without ever
 * writing an absolute user path. The repository redacts `C:\...` in stored
 * text, which would erase exactly the information needed to fix a broken
 * install, so the label keeps the identifying tail plus a `%TOKEN%` root.
 */
export function labelDiagnosticPath(absolutePath: string, probe: AgentSkillProbe = {}): string {
  const env = readEnv(probe)
  const tokens = pathTokens(probe, env)
  const normalized = resolve(absolutePath)
  for (const token of tokens) {
    if (normalized.toLocaleLowerCase().startsWith(token.root.toLocaleLowerCase())) {
      const tail = relative(token.root, normalized)
      return tail.length === 0 ? token.label : `${token.label}\\${tail.replace(/[\\/]+/gu, '\\')}`
    }
  }
  const segments = normalized.split(/[\\/]+/u).filter(Boolean)
  const tail = segments.slice(Math.max(0, segments.length - 2)).join('\\')
  return `…\\${tail}`
}

function diagnosticProbeLines(probe: AgentSkillProbe, env: Record<string, string | undefined>): string[] {
  const entry = AGENT_SKILL_CATALOG[LAST30DAYS_SKILL_KEY]
  const state = locateSkillFile(entry, probe)
  const configured = env['PRW_LAST30DAYS_SKILL_PATH']?.trim()
  return [
    `PRW_LAST30DAYS_SKILL_PATH: ${configured && configured.length > 0 ? labelDiagnosticPath(configured, probe) : '(未设置)'}`,
    ...skillSourceDiagnosticLines(entry, probe, state)
  ]
}

function resolveSkillFile(
  probe: AgentSkillProbe,
  env: Record<string, string | undefined>
): { readonly skillPath: string; readonly skillSource: Last30DaysSkillRuntime['skillSource'] } | null {
  const exists = probe.exists ?? existsSync
  const entry = AGENT_SKILL_CATALOG[LAST30DAYS_SKILL_KEY]
  const packagedDir = packagedSkillDirectory(entry, probe)
  const configured = env['PRW_LAST30DAYS_SKILL_PATH']?.trim()
  // An explicit override is an operator decision: if it points nowhere the run
  // is blocked with the full probe list instead of silently executing a
  // different skill source than the one that was asked for.
  if (configured && configured.length > 0) {
    const path = firstExistingSkillFile(exists, configured)
    return path === null ? null : { skillPath: path, skillSource: 'env' }
  }
  const candidates: Array<{ path: string | undefined; source: Last30DaysSkillRuntime['skillSource'] }> = [
    { path: join(projectSkillDirectory(entry, probe), entry.skillFileRelativePath), source: 'project' },
    { path: packagedDir ? join(packagedDir, entry.skillFileRelativePath) : undefined, source: 'packaged' }
  ]
  for (const candidate of candidates) {
    const value = candidate.path
    if (!value || value.length === 0) continue
    const path = firstExistingSkillFile(exists, value)
    if (path !== null) return { skillPath: path, skillSource: candidate.source }
  }
  return null
}

/** A configured path may be either the `SKILL.md` itself or the directory that
 * contains it; accepting both keeps the e2e/CI override usable. */
function firstExistingSkillFile(
  exists: (path: string) => boolean,
  value: string
): string | null {
  for (const path of value.toLocaleLowerCase().endsWith('.md') ? [value] : [join(value, 'SKILL.md'), value]) {
    if (!isAbsolute(path)) continue
    if (exists(path)) return resolve(path)
  }
  return null
}

function resolveEnginePath(skillPath: string): string {
  // Upstream layout: `skills/last30days/SKILL.md` next to `skills/last30days/scripts/last30days.py`.
  return join(dirname(skillPath), engineRelativePath)
}

const pythonProbeCache = new Map<string, { readonly at: number; readonly value: PythonProbeResult }>()
const pythonProbeCacheTtlMs = 5 * 60_000

function parsePythonVersion(version: string | null): readonly [number, number] | null {
  if (!version) return null
  const match = /^(\d+)\.(\d+)(?:\.\d+)?/u.exec(version.trim())
  const major = match?.[1]
  const minor = match?.[2]
  if (major === undefined || minor === undefined) return null
  return [Number.parseInt(major, 10), Number.parseInt(minor, 10)]
}

function defaultPythonProbe(command: string, env: Record<string, string | undefined>): PythonProbeResult {
  const cached = pythonProbeCache.get(command)
  if (cached && Date.now() - cached.at < pythonProbeCacheTtlMs) return cached.value
  const value = runPythonProbe(command, env)
  pythonProbeCache.set(command, { at: Date.now(), value })
  return value
}

function runPythonProbe(command: string, env: Record<string, string | undefined>): PythonProbeResult {
  // Only `sys` is imported: no site-packages, no user code, no argv prompt.
  const script = 'import sys; print("%d.%d.%d" % sys.version_info[:3])'
  // The child gets the same credential-free allowlist as an agent CLI run so a
  // probe can never read ambient API keys even by accident.
  const childEnv: NodeJS.ProcessEnv = {}
  for (const key of ['Path', 'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMPUTERNAME']) {
    const value = env[key]
    if (value !== undefined) childEnv[key] = value
  }
  const result = spawnSync(command, ['-c', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 8_000,
    env: childEnv
  })
  if (result.error) {
    return { available: false, version: null, detail: `无法执行 (${result.error.name})` }
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  const match = /(\d+\.\d+\.\d+)/u.exec(output)
  const version = match?.[1]
  if (result.status !== 0 || version === undefined) {
    return { available: false, version: null, detail: `退出码 ${String(result.status)}，未识别版本输出` }
  }
  const parsed = parsePythonVersion(version)
  const [minimumMajor = 3, minimumMinor = 12] = LAST30DAYS_MINIMUM_PYTHON
  const supported = parsed !== null && (parsed[0] > minimumMajor || (parsed[0] === minimumMajor && parsed[1] >= minimumMinor))
  return {
    available: supported,
    version,
    detail: supported ? version : `${version} < ${minimumMajor}.${minimumMinor}`
  }
}

interface PythonCandidate {
  readonly command: string
  readonly source: Last30DaysPythonSource
  readonly label: string
}

function pythonVersionRank(directoryName: string): number {
  const match = /python3?(\d{2,3})$/iu.exec(directoryName.trim())
  return match?.[1] ? Number.parseInt(match[1], 10) : -1
}

function windowsPythonCandidates(
  probe: AgentSkillProbe,
  env: Record<string, string | undefined>
): PythonCandidate[] {
  const listDirectory = probe.listDirectory ?? readdirSync
  const exists = probe.exists ?? existsSync
  const roots = [
    env['LOCALAPPDATA'] ? join(env['LOCALAPPDATA'], 'Programs', 'Python') : null,
    env['ProgramFiles'] ? join(env['ProgramFiles'], 'Python') : null,
    'C:\\'
  ].filter((value): value is string => Boolean(value))
  const directories: string[] = []
  for (const root of roots) {
    let entries: readonly string[] = []
    try {
      entries = listDirectory(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!/^Python3\d{1,2}$/iu.test(entry.trim())) continue
      directories.push(join(root, entry))
    }
  }
  return [...new Set(directories)]
    .sort((left, right) => pythonVersionRank(right) - pythonVersionRank(left))
    .flatMap((directory) => {
      const executable = join(directory, 'python.exe')
      return exists(executable)
        ? [{ command: executable, source: 'windows-install' as const, label: labelDiagnosticPath(executable, probe) }]
        : []
    })
}

function resolvePython(
  probe: AgentSkillProbe,
  env: Record<string, string | undefined>
): { readonly candidate: PythonCandidate; readonly result: PythonProbeResult } | { readonly rejection: string } {
  const platform = probe.platform ?? process.platform
  const probePython = probe.probePython
  const candidates: PythonCandidate[] = []
  const configured = env['PRW_LAST30DAYS_PYTHON']?.trim()
  if (configured && configured.length > 0) {
    candidates.push({ command: configured, source: 'env', label: labelDiagnosticPath(configured, probe) })
  }
  for (const name of ['python3.13', 'python3.12', 'python3', 'python']) {
    if (probePython) {
      // Injected probes address interpreters by name; tests do not have a PATH.
      candidates.push({ command: name, source: 'path', label: name })
    }
  }
  if (!probePython && platform === 'win32') {
    for (const name of ['python3.13', 'python3.12', 'python3', 'python']) {
      for (const resolved of windowsWhereLookup(name, env)) {
        candidates.push({ command: resolved, source: 'path', label: labelDiagnosticPath(resolved, probe) })
      }
    }
  }
  if (!probePython && platform !== 'win32') {
    for (const name of ['python3.13', 'python3.12', 'python3', 'python']) {
      const resolved = posixWhichLookup(name, env)
      if (resolved) candidates.push({ command: resolved, source: 'path', label: labelDiagnosticPath(resolved, probe) })
    }
  }
  if (!probePython) {
    candidates.push(...windowsPythonCandidates(probe, env))
  }
  const seen = new Set<string>()
  const rejections: string[] = []
  const unique = candidates.filter((candidate) => {
    const key = candidate.command.toLocaleLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  for (const candidate of unique) {
    const result = probePython ? probePython(candidate.command) : defaultPythonProbe(candidate.command, env)
    if (result.available) return { candidate, result }
    rejections.push(`${candidate.label}: ${result.detail}`)
  }
  return {
    rejection: [
      `PRW_LAST30DAYS_PYTHON: ${configured && configured.length > 0 ? labelDiagnosticPath(configured, probe) : '(未设置)'}`,
      `PATH 候选: ${['python3.13', 'python3.12', 'python3', 'python'].join(', ')}`,
      'Windows 安装目录候选: %LOCALAPPDATA%\\Programs\\Python\\Python3*、%PROGRAMFILES%\\Python\\Python3*、C:\\Python3*',
      ...(rejections.length > 0 ? ['', '各候选结果:', ...rejections.map((line) => `- ${line}`)] : [])
    ].join('\n')
  }
}

function windowsWhereLookup(name: string, env: Record<string, string | undefined>): string[] {
  const result = spawnSync('where.exe', [name], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 3_000,
    env: { Path: env['Path'] ?? env['PATH'], PATH: env['PATH'] ?? env['Path'], PATHEXT: env['PATHEXT'], SystemRoot: env['SystemRoot'] }
  })
  if (result.status !== 0) return []
  return String(result.stdout ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.toLocaleLowerCase().endsWith('.exe'))
    .slice(0, 4)
}

function posixWhichLookup(name: string, env: Record<string, string | undefined>): string | null {
  const result = spawnSync('which', [name], {
    encoding: 'utf8',
    timeout: 3_000,
    env: { PATH: env['PATH'] ?? '' }
  })
  if (result.status !== 0) return null
  const first = String(result.stdout ?? '').split(/\r?\n/u).map((line) => line.trim()).find(Boolean)
  return first && first.startsWith('/') ? first : null
}

function resolveLast30DaysSkill(probe: AgentSkillProbe): ResolvedAgentSkill {
  const env = readEnv(probe)
  const skill = resolveSkillFile(probe, env)
  if (!skill) {
    return {
      kind: 'unsupported',
      skillKey: LAST30DAYS_SKILL_KEY,
      diagnostic: {
        code: 'SKILL_MISSING',
        message: 'last30days skill 未找到；规范源目录是仓库的 `.agents/skills/last30days/`（打包镜像仅由构建从该目录生成）。',
        detail: ['已检查 SKILL.md 路径:', ...diagnosticProbeLines(probe, env)].join('\n')
      }
    }
  }
  const exists = probe.exists ?? existsSync
  const enginePath = resolveEnginePath(skill.skillPath)
  if (!exists(enginePath)) {
    return {
      kind: 'unsupported',
      skillKey: LAST30DAYS_SKILL_KEY,
      diagnostic: {
        code: 'SKILL_ENGINE_MISSING',
        message: 'last30days 引擎脚本缺失；skill 目录不完整（缺少 scripts/last30days.py）。',
        detail: [
          `SKILL.md: ${labelDiagnosticPath(skill.skillPath, probe)}`,
          `缺少引擎: ${labelDiagnosticPath(enginePath, probe)}`
        ].join('\n')
      }
    }
  }
  const python = resolvePython(probe, env)
  if ('rejection' in python) {
    // "No candidate at all" and "candidates exist but none is new enough" are
    // different repair actions, so keep them separate codes.
    const tooOld = /\d+\.\d+(?:\.\d+)? < \d+\.\d+/u.test(python.rejection)
    const [minimumMajor = 3, minimumMinor = 12] = LAST30DAYS_MINIMUM_PYTHON
    return {
      kind: 'unsupported',
      skillKey: LAST30DAYS_SKILL_KEY,
      diagnostic: {
        code: tooOld ? 'SKILL_PYTHON_TOO_OLD' : 'SKILL_PYTHON_MISSING',
        message: tooOld
          ? `last30days 需要 Python >= ${minimumMajor}.${minimumMinor}；找到的解释器版本过低。`
          : `last30days 需要 Python >= ${minimumMajor}.${minimumMinor}；未找到可用的 python 解释器。`,
        detail: ['解释器探测:', python.rejection].join('\n')
      }
    }
  }
  return {
    kind: 'last30days',
    runtime: {
      key: LAST30DAYS_SKILL_KEY,
      skillPath: skill.skillPath,
      skillDir: dirname(skill.skillPath),
      enginePath,
      pythonPath: python.candidate.command,
      pythonVersion: python.result.version ?? python.result.detail,
      pythonSource: python.candidate.source,
      skillSource: skill.skillSource,
      ...readPinnedSkillIdentity(dirname(skill.skillPath), probe)
    }
  }
}

/**
 * Read the vendored checkout's pin file into a durable skill identity.
 *
 * A run stores this so a retry reproduces the *pinned* skill instead of
 * silently executing whatever version happens to be installed later. Only the
 * two scalar fields are read; the checkout path itself is never returned.
 */
export function readPinnedSkillIdentity(
  skillDir: string,
  probe: AgentSkillProbe = {}
): { readonly pinnedVersion: string | null; readonly pinnedCommit: string | null } {
  const readFile = probe.readFile ?? ((path: string) => readFileSyncDefault(path))
  try {
    const pin = readFile(join(skillDir, 'PRW-PIN.md'))
    const version = pin.match(/^\s*-\s*Skill version\s*:\s*`([^`]+)`/mu)?.[1]?.trim() ?? null
    const commit = pin.match(/^\s*-\s*Commit\s*:\s*`([^`]+)`/mu)?.[1]?.trim() ?? null
    return {
      pinnedVersion: version && version.length > 0 ? version : null,
      pinnedCommit: commit && commit.length > 0 ? commit : null
    }
  } catch {
    return { pinnedVersion: null, pinnedCommit: null }
  }
}

function readFileSyncDefault(path: string): string {
  return readFileSync(path, 'utf8')
}

export interface Last30DaysPromptInput {
  readonly runtime: Last30DaysSkillRuntime
  /** Isolated run directory the engine may write into. */
  readonly saveDir: string
  readonly topic: string | null
  /** Requested engine sources (`--search`); empty keeps the engine default of
   * "every source the capability probe reported as available". */
  readonly sources?: readonly string[] | undefined
  /** Rolling window in days (`--days`); omitted keeps the engine default. */
  readonly lookbackDays?: number | undefined
  /** Requested sources the probe reported as unavailable. They are never
   * invented away: the briefing only points at the engine's own Partial
   * Coverage note. */
  readonly unavailableSources?: readonly string[] | undefined
  /** Narrative language of the delivered article (`zh-CN` is the frozen
   * default). It only governs the prose: source names, proper nouns, original
   * titles, community quotes, the pass-through footer and URLs stay verbatim
   * in every language so the evidence remains checkable. */
  readonly responseLanguage?: AgentResponseLanguage | undefined
  readonly probe?: AgentSkillProbe | undefined
}

/** Shared language rule for a skill run: the same wording feeds the skill
 * briefing and the schedule instructions, so a run cannot end up "Chinese in
 * the prompt, English in the heading". */
export function skillResponseLanguageRule(language: AgentResponseLanguage | null | undefined): string {
  return language === 'en'
    ? 'Language/output rule: write all user-readable narrative, summaries, analysis, section descriptions, and key points in English. Preserve source names, proper nouns, original titles, community quotes, URLs, and the skill-required badge/footer contract exactly as evidence; do not translate or post-process them.'
    : '语言/输出规则：正文叙述、分析与要点用简体中文（What I learned 段落）；来源名、专有名词、必要的英文标题、社区引语、URL 以及 skill 约定的徽章/footer 合同逐字保留作为证据，不翻译、不改写。'
}

/**
 * The contract block injected above the ordinary prompt. It is deliberately
 * explicit about *commands and paths* rather than "please use the skill": the
 * engine has a CLI surface that changed across versions, and a model that
 * improvises flags produces a plausible-looking article with no evidence.
 */
export function buildLast30DaysSkillBriefing(input: Last30DaysPromptInput): string {
  const { runtime, saveDir } = input
  const topic = (input.topic ?? '').trim()
  const sources = normalizeSourceList(input.sources ?? [])
  const unavailableSources = normalizeSourceList(input.unavailableSources ?? [])
  const lookbackDays =
    typeof input.lookbackDays === 'number' && Number.isInteger(input.lookbackDays) && input.lookbackDays > 0
      ? Math.min(input.lookbackDays, 365)
      : null
  const engineCommand = [
    quoteShellArgument(runtime.pythonPath),
    quoteShellArgument(runtime.enginePath),
    topic.length > 0 ? quoteShellArgument(topic) : '"<每日主题>"',
    '--emit=compact',
    '--auto-resolve',
    '--no-browser-cookies',
    '--save-dir=' + quoteShellArgument(saveDir),
    '--save-suffix=v3',
    ...(sources.length > 0 ? ['--search=' + quoteShellArgument(sources.join(','))] : []),
    ...(lookbackDays === null ? [] : [`--days=${String(lookbackDays)}`])
  ].join(' ')
  return [
    '## 项目锁定 skill：last30days（必须真实执行，不得凭记忆复述）',
    '',
    `- 读取并遵守 skill 文件全文: ${quoteShellArgument(runtime.skillPath)}`,
    `- 引擎入口: ${quoteShellArgument(runtime.enginePath)}`,
    `- Python 解释器（必须使用此解释器，版本要求 >= 3.12；实际 ${runtime.pythonVersion}）: ${quoteShellArgument(runtime.pythonPath)}`,
    `- 本次运行隔离输出目录（唯一允许写入的位置，产物落在其中）: ${quoteShellArgument(saveDir)}`,
    ...(sources.length > 0
      ? [`- 本次请求来源（引擎 --search，必须原样传递，不得增删）: ${sources.join(', ')}`]
      : []),
    ...(lookbackDays === null ? [] : [`- 回看天数（引擎 --days，必须原样传递，不得改写）: ${String(lookbackDays)}`]),
    ...(unavailableSources.length > 0
      ? [
          `- 预检报告当前不可用的来源: ${unavailableSources.join(', ')}；不要为它们索要 key、不要改配置，按引擎的 Partial Coverage 原样保留。`
        ]
      : []),
    '- 执行命令（工作目录为本次运行目录；不要改写参数）：',
    '  ' + engineCommand,
    '',
    '执行约束：',
    '1. 只通过上面的命令调用引擎（注释：Windows 上 shell 可能是 PowerShell，此时请用调用运算符 & 执行同一命令，参数与引号保持不变）；不得使用 --mock/伪造数据，不得安装任何工具（pip/npm/pnpm/brew/apt）、不得运行首次配置向导、不得交互式提问或等待输入。',
    '2. 网络与来源：允许联网；缺失的可选来源、缺失的 key、来源失败都不是错误，按引擎输出的 Partial Coverage 原样保留，不要编造补充。命令已带 --no-browser-cookies：不要从浏览器读取 cookie/登录态，也不要为了补全来源去要 key 或改配置。',
    `3. 引擎可能先写文件到隔离目录（含 raw 证据与本地库），用它们作为证据来源；不要在仓库、桌面或 Obsidian vault 里创建临时文件。`,
    '4. 不得读取、复制或输出任何凭据类内容（API key、token、cookie、.env）；不要把工具日志、命令行回显放进正文。',
    '5. 输出契约：引擎输出第 1 行的版本徽章（🌐 last30days v... · synced ...）与 PASS-THROUGH FOOTER（✅ All agents reported back! 起的 emoji 树）必须逐字保留、不得翻译/改写/省略；不要输出 EVIDENCE FOR SYNTHESIS 内部结构、不要输出形如 "### 1. (score N, M items, sources: ...)" 的证据块、不要追加额外的 Sources 列表。',
    '6. ' + skillResponseLanguageRule(input.responseLanguage),
    '7. 最终回答只包含文章正文（含徽章与 footer）。如果引擎失败或网络不可达，说明失败原因与可执行的修复建议，不要伪造证据。'
  ].join('\n')
}

export interface InstructionSkillPromptInput {
  readonly runtime: InstructionSkillRuntime
  /** Full validated `SKILL.md` text, read from the canonical (or mirrored) file
   * of this same run. Required: the injection contract *is* this text. */
  readonly markdown: string
  readonly topic: string | null
  readonly sources?: readonly string[] | undefined
  readonly lookbackDays?: number | undefined
  readonly responseLanguage?: AgentResponseLanguage | null | undefined
  /** Vault-relative output folder of the rule (the projection's write target). */
  readonly outputFolder?: string | null | undefined
  readonly projectId?: string | null | undefined
  /** Isolated per-run directory the runtime is started in. */
  readonly runDir?: string | undefined
  readonly probe?: AgentSkillProbe | undefined
}

/**
 * The contract block injected above the ordinary prompt of an instruction-only
 * skill run.
 *
 * The block carries the *validated* `SKILL.md` text itself instead of a
 * paraphrase, because "use the skill" is not an execution contract: the runtime
 * must follow the file's inputs, evidence rules, failure semantics and output
 * contract step by step. Everything that could bypass the workbench boundary
 * (external writes, credentials, fabricated citations, second skill sources) is
 * restated here as an explicit prohibition, and the final answer is defined as
 * the article body only because the existing Artifact / Inbox / Obsidian
 * projection owns frontmatter, title and footer.
 */
export function buildInstructionSkillBriefing(input: InstructionSkillPromptInput): string {
  const { runtime } = input
  const topic = (input.topic ?? '').trim()
  const sources = normalizeSourceList(input.sources ?? [])
  const lookbackDays =
    typeof input.lookbackDays === 'number' && Number.isInteger(input.lookbackDays) && input.lookbackDays > 0
      ? Math.min(input.lookbackDays, 365)
      : null
  const outputFolder = (input.outputFolder ?? '').trim()
  return [
    `## 项目 skill：${runtime.key}（指令型合同：Agent runtime 按 SKILL.md 逐步执行）`,
    '',
    `- skill 文件（唯一执行依据，必须先读完再动手）: ${quoteShellArgument(runtime.skillPath)}`,
    `- skill 来源: ${runtime.skillSource === 'packaged' ? '打包镜像 resources/skills（由 .agents/skills 构建镜像）' : '仓库 .agents/skills（唯一手工维护源）'}；版本: ${runtime.pinnedVersion ?? '(未声明)'}`,
    '- 本 skill 没有本地引擎/解释器：全部检索、取证与写作由你（Agent runtime）按 SKILL.md 执行。',
    ...(input.runDir ? [`- 本次运行目录（临时文件只允许写在这里）: ${quoteShellArgument(input.runDir)}`] : []),
    ...(topic.length > 0 ? [`- 主题（topic）: ${topic}`] : ['- 主题（topic）: 未设置；SKILL.md 要求主题缺失时按诊断码阻断，不要自行编造主题。']),
    ...(lookbackDays === null ? [] : [`- 回看天数（lookbackDays）: ${String(lookbackDays)}`]),
    ...(sources.length > 0
      ? [`- 请求来源（sources，不得增删或替换成编造来源）: ${sources.join(', ')}`]
      : ['- 请求来源（sources）: 未限制，使用工作台当前可用的来源。']),
    ...(outputFolder.length > 0 ? [`- 输出目录（outputFolder，Vault 相对路径，由投影层写入）: ${outputFolder}`] : []),
    ...(input.projectId ? [`- 绑定项目: ${input.projectId}（只使用本次运行显式注入的文献上下文）`] : []),
    '- ' + skillResponseLanguageRule(input.responseLanguage),
    '',
    '执行约束（与 SKILL.md 冲突时以更严格的约束为准）：',
    '1. 逐条执行 SKILL.md：输入归一化 → 能力/来源预检 → 取证 → 去重同一性 → 按输出契约生成正文 → 自检；不得用记忆、常识或历史对话代替本次证据，不得凭记忆复述旧结果。',
    '2. 引用与证据：只写本次真实取得的内容；取不到出处的字段按 SKILL.md 写「未报告」或丢弃并计数；绝不生成/补全/猜测 DOI、URL、作者、期刊、年份或引用数。',
    '3. 输出契约：最终回答只包含正文 Markdown（无 YAML frontmatter、无 `#` 一级标题、无来源页脚），frontmatter/标题/来源行由工作台 Artifact / Inbox / Obsidian 投影层写入；正文前 4,000 字符要自包含，因为 SQLite 只保留有界摘录。',
    '4. 安全边界：不写 Zotero、不写 Obsidian/.obsidian、不触碰 zotero.sqlite 或凭据；不自动投稿/发邮件/上传/发布；不安装任何工具（pip/npm/pnpm/brew/apt）；不读、不复制、不输出 API key、token、cookie、.env。',
    '5. 降级与失败：部分来源不可用要在覆盖状态里声明为部分覆盖，不得写成完整覆盖；空结果写「本次时间窗与来源内未检索到」，不得写成领域结论；阻断/失败时按 SKILL.md 的诊断块输出（状态/诊断码/消息/输入/证据/下一步），不要附带半成品正文。',
    '6. 真实联网检索与真实模型运行是否成功，只能由本次运行的实际输出证明；不得声称已验证未验证的步骤。',
    '',
    `### SKILL.md 全文（${runtime.key} · ${runtime.pinnedVersion ?? '未声明版本'}；内容已在运行时校验：路径位于 skill 目录内、frontmatter name 与 skillKey 一致、正文非空且未超上限）`,
    '',
    input.markdown.trim(),
    '',
    '### SKILL.md 全文结束；以上内容为执行合同，正文请按它的输出契约生成。'
  ].join('\n')
}

/** Redaction-safe summary of a resolved instruction-only skill run. */
export function describeInstructionSkillRuntime(runtime: InstructionSkillRuntime, probe: AgentSkillProbe = {}): string {
  return [
    `skill: ${runtime.key}（来源 ${runtime.skillSource}）`,
    `SKILL.md: ${labelDiagnosticPath(runtime.skillPath, probe)}`,
    'engine: 无（指令型合同：由 Agent runtime 按 SKILL.md 执行）',
    `pin: ${runtime.pinnedVersion ?? '(未记录版本)'} @ (无 commit，非 vendored 引擎)`
  ].join('\n')
}

/** Redaction-safe summary of a resolved skill run for the run ledger. */
export function describeLast30DaysRuntime(runtime: Last30DaysSkillRuntime, probe: AgentSkillProbe = {}): string {
  return [
    `skill: ${runtime.key}（来源 ${runtime.skillSource}）`,
    `SKILL.md: ${labelDiagnosticPath(runtime.skillPath, probe)}`,
    `engine: ${labelDiagnosticPath(runtime.enginePath, probe)}`,
    `python: ${labelDiagnosticPath(runtime.pythonPath, probe)}（${runtime.pythonVersion}，来源 ${runtime.pythonSource}）`,
    `pin: ${runtime.pinnedVersion ?? '(未记录版本)'} @ ${runtime.pinnedCommit?.slice(0, 12) ?? '(未记录 commit)'}`
  ].join('\n')
}

function quoteShellArgument(value: string): string {
  // Double quotes survive both cmd/PowerShell and bash for paths, and JSON
  // escaping keeps a topic containing a quote from terminating the argument.
  return JSON.stringify(value.replace(/[\r\n]+/gu, ' ').slice(0, 500))
}

/** Trim, lower-case and de-duplicate engine source tokens. */
export function normalizeSourceList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLocaleLowerCase()).filter((value) => value.length > 0))]
}

/**
 * Capability probe result for the pinned engine.
 *
 * The engine's own `--diagnose` is the only trustworthy source of "which
 * sources can actually answer right now": it is local, fast and knows about
 * network reachability and optional credentials. A scheduled push must decide
 * *before* spending a model run whether the sources a rule asked for exist.
 */
export type Last30DaysCapability =
  | {
      readonly ok: true
      readonly availableSources: readonly string[]
      /** Optional, key-gated sources the engine reports as unauthenticated. */
      readonly missingCredentials: readonly string[]
      /** Optional external commands (yt-dlp, gh, ...) that are not installed. */
      readonly missingOptionalSources: readonly string[]
      readonly detail: string
    }
  | { readonly ok: false; readonly diagnostic: AgentSkillDiagnostic }

export interface Last30DaysCapabilityProbeDeps {
  /** Injected for tests; production runs the real interpreter. */
  readonly runDiagnose?: ((runtime: Last30DaysSkillRuntime) => { readonly status: number | null; readonly stdout: string; readonly stderr: string }) | undefined
  readonly now?: (() => number) | undefined
  readonly ttlMs?: number | undefined
}

const capabilityCache = new Map<string, { readonly at: number; readonly value: Last30DaysCapability }>()
const capabilityCacheTtlMs = 60_000

/** Interpret the engine's diagnose JSON. Kept separate so the parsing contract
 * (and its failure mode) is testable without spawning Python. */
export function parseLast30DaysDiagnose(stdout: string): { readonly availableSources: readonly string[]; readonly detail: string } | null {
  const summary = summarizeLast30DaysDiagnose(stdout)
  return summary === null ? null : { availableSources: summary.availableSources, detail: summary.detail }
}

/**
 * Structured capability summary of one `--diagnose` run.
 *
 * The engine reports three *different* kinds of degradation that a daily push
 * must not merge into one "it failed" message:
 *
 * - `availableSources` — what can answer right now. Sources that are quiet or
 *   merely unconfigured are simply not listed here.
 * - `missingCredentials` — optional, key-gated sources (X/Twitter via
 *   bird/CT0, Bright Data, hosted planner keys). Missing keys are a supported
 *   state: the keyless sources run and the engine emits its own coverage note.
 * - `missingOptionalSources` — optional external commands (`yt-dlp`, `gh`, ...)
 *   that unlock extra lanes; also non-blocking.
 * - `networkSafe` — the engine's own read-only/network preflight verdict.
 *
 * A network failure is *not* representable here: when the engine cannot even
 * complete `--diagnose`, `classifyLast30DaysProbeFailure` names that case.
 */
export interface Last30DaysDiagnoseSummary {
  readonly availableSources: readonly string[]
  readonly missingCredentials: readonly string[]
  readonly missingOptionalSources: readonly string[]
  readonly networkSafe: boolean | null
  readonly engineVersion: string | null
  readonly detail: string
}

export function summarizeLast30DaysDiagnose(stdout: string): Last30DaysDiagnoseSummary | null {
  const start = stdout.indexOf('{')
  if (start < 0) return null
  let record: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start))
    if (!parsed || typeof parsed !== 'object') return null
    record = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const sources = Array.isArray(record['available_sources'])
    ? record['available_sources'].filter((value): value is string => typeof value === 'string')
    : []
  const preflight = isRecord(record['permission_preflight']) ? record['permission_preflight'] : null
  const credentials = preflight && isRecord(preflight['credentials']) ? preflight['credentials'] : null
  const missingCredentials: string[] = []
  if (credentials) {
    for (const [name, value] of Object.entries(credentials)) {
      if (!isRecord(value) || value['present'] !== false) continue
      const label = typeof value['label'] === 'string' && value['label'].trim().length > 0 ? value['label'].trim() : name
      missingCredentials.push(`${name}（${label}）`)
    }
  }
  // X/Twitter and Bright Data are the two key-gated sources the engine exposes
  // as top-level booleans rather than through the credential catalogue.
  if (record['bird_authenticated'] === false) missingCredentials.push('x（X/Twitter AUTH_TOKEN/CT0）')
  if (record['brightdata_authenticated'] === false) missingCredentials.push('brightdata（Bright Data 凭据）')
  const externalCommands = preflight && isRecord(preflight['external_commands']) ? preflight['external_commands'] : null
  const missingOptionalSources: string[] = []
  if (externalCommands) {
    for (const [name, value] of Object.entries(externalCommands)) {
      const status = isRecord(value) ? value['status'] : value
      if (status === 'available') continue
      missingOptionalSources.push(name)
    }
  }
  const engineVersion = typeof record['version'] === 'string' ? record['version'] : null
  const networkSafe = preflight && typeof preflight['safe'] === 'boolean'
    ? preflight['safe']
    : typeof record['safe'] === 'boolean' ? record['safe'] : null
  return {
    availableSources: normalizeSourceList(sources),
    missingCredentials: [...new Set(missingCredentials)].sort(),
    missingOptionalSources: [...new Set(missingOptionalSources)].sort(),
    networkSafe,
    engineVersion,
    detail: [
      `available_sources: ${sources.length > 0 ? sources.join(', ') : '(引擎未报告任何来源)'}`,
      `missing_credentials（无需修复，keyless 来源仍在运行）: ${missingCredentials.length > 0 ? [...new Set(missingCredentials)].join(', ') : '(无)'}`,
      `missing_optional_sources（可选外部命令，不阻断）: ${missingOptionalSources.length > 0 ? [...new Set(missingOptionalSources)].join(', ') : '(无)'}`,
      `network_preflight_safe: ${String(networkSafe ?? '(未报告)')}`,
      `safe_defaults: ${String(record['safe'] ?? '(未报告)')}`,
      `engine_version: ${engineVersion ?? '(未报告)'}`
    ].join('\n')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Distinguish *why* the local `--diagnose` preflight could not produce a
 * parseable answer. Three states are actionable in different ways, so a single
 * "probe failed" message would send the operator to the wrong place:
 *
 * - `SKILL_PROBE_NETWORK_UNREACHABLE` — the engine ran but the network (or a
 *   proxy) is unreachable; retrying later or fixing the proxy is the fix.
 * - `SKILL_PROBE_PERMISSION_DENIED` — the interpreter/engine could not be
 *   executed or read (sandbox, ACL, antivirus); fixing credentials/ACLs is the
 *   fix and a retry will not help.
 * - `SKILL_PROBE_FAILED` — anything else (crash, schema drift, missing file).
 */
export type Last30DaysProbeFailureKind = 'network' | 'permission' | 'engine'

export interface Last30DaysProbeFailure {
  readonly kind: Last30DaysProbeFailureKind
  readonly code: 'SKILL_PROBE_NETWORK_UNREACHABLE' | 'SKILL_PROBE_PERMISSION_DENIED' | 'SKILL_PROBE_FAILED'
  readonly message: string
}

const last30DaysPermissionPattern = /permission denied|access is denied|access denied|operation not permitted|not permitted|eperm|eacces|unauthorized access|sandbox\S* denial|approval|拒绝访问|权限/iu
const last30DaysNetworkPattern = /temporary failure in name resolution|name or service not known|nodename nor servname|getaddrinfo|enotfound|econnrefused|econnreset|etimedout|network is unreachable|no route to host|proxy|timed? ?out|tls|certificate verify|connection (?:refused|reset|error)|dns|网络|无法连接/iu

export function classifyLast30DaysProbeFailure(input: {
  readonly status: number | null
  readonly stdout?: string | undefined
  readonly stderr?: string | undefined
}): Last30DaysProbeFailure {
  const haystack = `${input.stderr ?? ''}\n${input.stdout ?? ''}`
  if (last30DaysPermissionPattern.test(haystack)) {
    return {
      kind: 'permission',
      code: 'SKILL_PROBE_PERMISSION_DENIED',
      message: 'last30days 能力预检被权限拒绝：解释器或引擎脚本无法执行/读取（文件 ACL、安全软件或沙箱拦截）。本次推送已阻断；重试不会恢复，请修复执行权限。'
    }
  }
  if (last30DaysNetworkPattern.test(haystack)) {
    return {
      kind: 'network',
      code: 'SKILL_PROBE_NETWORK_UNREACHABLE',
      message: 'last30days 能力预检时网络不可达（DNS/代理/连接被拒或超时）。本次推送已阻断，不会生成成功产物；请检查网络或代理规则后重试。'
    }
  }
  return {
    kind: 'engine',
    code: 'SKILL_PROBE_FAILED',
    message: 'last30days 能力预检失败：引擎 --diagnose 无法执行或输出不可识别，本次推送已阻断（不会生成成功产物）。'
  }
}

/**
 * Classify a failed *run* (the CLI transport itself died) for a skill run.
 *
 * The two cases the operator must be able to tell apart from an ordinary crash:
 * a CLI that was denied the write/network access the skill needs, and a CLI
 * that failed because the network it needs is unreachable. Both are reported as
 * their own code so the daily push can never be mistaken for a content failure.
 */
export function classifyLast30DaysRunFailure(message: string): Last30DaysProbeFailure | null {
  if (last30DaysPermissionPattern.test(message)) {
    return {
      kind: 'permission',
      code: 'SKILL_PROBE_PERMISSION_DENIED',
      message: 'Agent CLI 因权限被拒绝而失败（沙箱/批准策略/文件权限）。本次推送未产出可信结果，请检查 runtime 的权限与批准设置后重试。'
    }
  }
  if (last30DaysNetworkPattern.test(message)) {
    return {
      kind: 'network',
      code: 'SKILL_PROBE_NETWORK_UNREACHABLE',
      message: 'Agent CLI 因网络不可达而失败（DNS/代理/连接被拒或超时）。本次推送未产出可信结果，请检查网络与代理规则后重试。'
    }
  }
  return null
}

/**
 * Language the delivered article must be written in, plus the degradation
 * notes that must survive into the article. A keyless run is a *supported*
 * state: the badge/footer contract stays and the missing optional sources are
 * named, so a partially covered digest is never presented as full coverage.
 */
export function buildLast30DaysDegradationNotes(
  summary: Pick<Last30DaysDiagnoseSummary, 'missingCredentials' | 'missingOptionalSources'> | null
): string {
  if (!summary) return ''
  const lines: string[] = []
  if (summary.missingCredentials.length > 0) {
    lines.push(`- 无 key（可选来源，不影响 keyless 来源运行）: ${summary.missingCredentials.join(', ')}`)
  }
  if (summary.missingOptionalSources.length > 0) {
    lines.push(`- 缺少可选来源（外部命令未安装，不阻断）: ${summary.missingOptionalSources.join(', ')}`)
  }
  return lines.join('\n')
}

/**
 * Run the engine's local preflight. A probe that cannot be executed or parsed
 * is *not* treated as "a few sources are missing": the run is blocked with
 * actionable evidence instead, because a push that silently degrades to zero
 * sources still produces a plausible-looking article.
 */
export function probeLast30DaysCapability(
  runtime: Last30DaysSkillRuntime,
  deps: Last30DaysCapabilityProbeDeps = {}
): Last30DaysCapability {
  const now = deps.now ?? Date.now
  const ttl = deps.ttlMs ?? capabilityCacheTtlMs
  const cacheKey = `${runtime.pythonPath}::${runtime.enginePath}`
  const cached = capabilityCache.get(cacheKey)
  if (!deps.runDiagnose && cached && now() - cached.at < ttl) return cached.value

  const run = deps.runDiagnose ?? defaultDiagnoseRunner
  let result: { readonly status: number | null; readonly stdout: string; readonly stderr: string }
  try {
    result = run(runtime)
  } catch (error) {
    result = { status: null, stdout: '', stderr: error instanceof Error ? error.message : 'diagnose failed' }
  }
  const parsed = result.status === 0 ? summarizeLast30DaysDiagnose(result.stdout) : null
  const value: Last30DaysCapability = parsed
    ? {
        ok: true,
        availableSources: parsed.availableSources,
        missingCredentials: parsed.missingCredentials,
        missingOptionalSources: parsed.missingOptionalSources,
        detail: parsed.detail
      }
    : (() => {
        // A failed probe is classified before it is reported: "network down" and
        // "permission denied" need different operator actions, and neither may be
        // presented as a content result.
        const failure = classifyLast30DaysProbeFailure(result)
        return {
          ok: false as const,
          diagnostic: {
            code: failure.code,
            message: failure.message,
            detail: [
              `失败类别: ${failure.kind}`,
              '命令: <python> <engine> --diagnose --no-browser-cookies',
              `退出码: ${String(result.status)}`,
              `stdout 片段: ${truncateForDiagnostic(result.stdout)}`,
              `stderr 片段: ${truncateForDiagnostic(result.stderr)}`
            ].join('\n')
          }
        }
      })()
  // A failing probe is cached too (with the same short TTL) so a broken engine
  // cannot make every 30-second tick spawn a new interpreter; the cache is keyed
  // by interpreter+engine so re-pointing PRW_LAST30DAYS_PYTHON retries at once.
  capabilityCache.set(cacheKey, { at: now(), value })
  return value
}

function defaultDiagnoseRunner(runtime: Last30DaysSkillRuntime): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const childEnv: NodeJS.ProcessEnv = {}
  for (const key of ['Path', 'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMPUTERNAME']) {
    const value = process.env[key]
    if (value !== undefined) childEnv[key] = value
  }
  const result = spawnSync(runtime.pythonPath, [runtime.enginePath, '--diagnose', '--no-browser-cookies'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
    cwd: runtime.skillDir,
    env: childEnv
  })
  if (result.error) return { status: null, stdout: '', stderr: result.error.message }
  return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
}

function truncateForDiagnostic(value: string): string {
  const single = value.replace(/[\r\n]+/gu, ' ').trim().slice(0, 300)
  return single.length > 0 ? single : '(空)'
}

/**
 * Reconcile the sources a rule asked for with what the probe reports. A
 * partially unavailable request still runs (the engine keeps its own Partial
 * Coverage note); a request where *nothing* can answer is a hard stop.
 */
export type Last30DaysSourceSelection =
  | { readonly ok: true; readonly sources: readonly string[]; readonly unavailable: readonly string[] }
  | { readonly ok: false; readonly diagnostic: AgentSkillDiagnostic }

export function selectLast30DaysSources(
  requested: readonly string[],
  available: readonly string[]
): Last30DaysSourceSelection {
  const wanted = normalizeSourceList(requested)
  const usable = new Set(available.map((source) => source.toLocaleLowerCase()))
  if (usable.size === 0) {
    return {
      ok: false,
      diagnostic: {
        code: 'SKILL_SOURCES_UNAVAILABLE',
        message: 'last30days 预检未发现任何可用来源（可能无网络、代理未生效或引擎依赖缺失）；本次推送已阻断。',
        detail: '引擎 --diagnose 的 available_sources 为空。请检查网络/代理设置后重试，或运行 `--preflight` 查看详细修复建议。'
      }
    }
  }
  if (wanted.length === 0) return { ok: true, sources: [], unavailable: [] }
  const runnable = wanted.filter((source) => usable.has(source))
  const unavailable = wanted.filter((source) => !usable.has(source))
  if (runnable.length === 0) {
    return {
      ok: false,
      diagnostic: {
        code: 'SKILL_SOURCES_UNAVAILABLE',
        message: `规则要求的来源（${wanted.join(', ')}）当前都不可用；本次推送已阻断。`,
        detail: [
          `请求来源: ${wanted.join(', ')}`,
          `预检可用来源: ${available.join(', ')}`,
          '处理建议: 在规则中改用可用来源，或清空来源以使用引擎默认的全部可用来源。'
        ].join('\n')
      }
    }
  }
  return { ok: true, sources: runnable, unavailable }
}
