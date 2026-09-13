import { createHash, randomUUID } from 'node:crypto'
import {
  lstat as nodeLstat,
  mkdir as nodeMkdir,
  readdir as nodeReaddir,
  realpath as nodeRealpath,
  writeFile as nodeWriteFile
} from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { IdSchema, PaperIdSchema, ProjectIdSchema, TaskIdSchema } from '@prw/contracts'

/**
 * Obsidian project layout is deliberately kept in a small, transport-neutral
 * module.  The dispatcher/connector/database owners can wire these functions
 * later without duplicating the path and frontmatter rules.
 */

/** Deprecated compatibility metadata for the legacy project-directory route.
 * The canonical root-level Vault flow is defined by
 * `DEFAULT_OBSIDIAN_VAULT_CATEGORIES` below. */
export const OBSIDIAN_LAYOUT_CATEGORIES = [
  { kind: 'daily_literature', enumName: 'DailyLiterature', directoryName: '每日文献推送', description: '按日期保存每日文献推送 Markdown。' },
  { kind: 'literature_matrix', enumName: 'LiteratureMatrix', directoryName: '文献矩阵', description: '保存文献矩阵 Markdown 与字段说明。' },
  { kind: 'literature_review', enumName: 'LiteratureReview', directoryName: '文献综述', description: '保存综述草稿和引用说明。' },
  { kind: 'writing_templates', enumName: 'WritingTemplates', directoryName: '写作模板', description: '保存写作模板 Markdown，不执行模板。' },
  { kind: 'prompt_library', enumName: 'PromptLibrary', directoryName: '提示词库', description: '保存提示词 Markdown，不执行 Prompt。' },
  { kind: 'tasks', enumName: 'Tasks', directoryName: '任务', description: '保存项目任务相关 Markdown。' },
  { kind: 'calendar', enumName: 'Calendar', directoryName: '日历', description: '保存日历 Markdown；日历投影默认只读。' },
  { kind: 'resources', enumName: 'Resources', directoryName: '资源', description: '保存项目资源和附件链接说明。' },
  { kind: 'knowledge_index', enumName: 'KnowledgeIndex', directoryName: '知识库索引', description: '保存知识库索引摘要与映射，不执行 RAG/Agent。' },
  { kind: 'anything_llm', enumName: 'AnythingLLM', directoryName: 'AnythingLLM', description: 'AnythingLLM workspace documents, index summaries and source mappings.' },
  { kind: 'llm_wiki', enumName: 'LLMWiki', directoryName: 'LLMWiki', description: 'LLMWiki pages, relationship maps and MCP knowledge indexes.' }
] as const

/** Root-level categories created for a new Vault. These are deliberately
 * unnumbered; users may add/rename folders later and projects are represented
 * by Markdown labels rather than directory nesting. */
export const DEFAULT_OBSIDIAN_VAULT_CATEGORIES = [
  '\u6bcf\u65e5\u6587\u732e\u63a8\u9001',
  '\u6bcf\u65e5\u8d44\u8baf\u63a8\u9001',
  '\u6587\u732e\u77e9\u9635',
  '\u6587\u732e\u7efc\u8ff0',
  '\u5199\u4f5c\u6a21\u677f',
  '\u63d0\u793a\u8bcd\u5e93',
  'AnythingLLM',
  'LLMWiki'
] as const

export type VaultLayoutPlan = {
  readonly planId: string
  readonly vaultRoot: string
  readonly profileId: string
  readonly categories: readonly { name: string; kind: 'daily_literature' | 'literature_matrix' | 'literature_review' | 'writing_templates' | 'prompt_library' | 'tasks' | 'calendar' | 'resources' | 'knowledge_index' | 'anything_llm' | 'llm_wiki' | 'custom'; relativePath: string; absolutePath: string }[]
  readonly readmeRelativePath: 'README.md'
  readonly readmePath: string
  readonly relativePaths: readonly string[]
  readonly existingPaths: readonly string[]
}

export type VaultLayoutReceipt = {
  readonly status: 'created' | 'partial'
  readonly profileId: string
  readonly createdPaths: readonly string[]
  readonly preservedPaths: readonly string[]
  readonly message: string
}

export type ObsidianLayoutKind = (typeof OBSIDIAN_LAYOUT_CATEGORIES)[number]['kind']
export type LayoutChoice = 'bind' | 'create' | 'cancel'
export type LayoutPathKind = 'directory' | 'file' | 'symlink' | 'missing' | 'unknown'

const categoryByDirectory = new Map<string, (typeof OBSIDIAN_LAYOUT_CATEGORIES)[number]>(
  OBSIDIAN_LAYOUT_CATEGORIES.map((category) => [canonicalSegment(category.directoryName), category])
)
// Root-level Vaults use human-readable folder names without the legacy
// numeric prefixes.  Keep those names as kind aliases for indexing, while
// deliberately avoiding any project inference from the first path segment.
for (const category of OBSIDIAN_LAYOUT_CATEGORIES) {
  categoryByDirectory.set(canonicalSegment(category.directoryName.replace(/^\d+-/u, '')), category)
}
const categoryByKind = new Map<string, (typeof OBSIDIAN_LAYOUT_CATEGORIES)[number]>([
  ...OBSIDIAN_LAYOUT_CATEGORIES.map((category) => [category.kind, category] as const),
  ...OBSIDIAN_LAYOUT_CATEGORIES.map((category) => [category.enumName, category] as const)
])

const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)
])

function hasWindowsUnsafeComponent(value: string): boolean {
  if (/[\u0000-\u001f<>:"/\\|?*]/u.test(value) || /[. ]$/u.test(value)) return true
  const baseName = value.split('.')[0]?.toLocaleUpperCase('en-US') ?? value
  return WINDOWS_RESERVED_NAMES.has(baseName)
}

export class ObsidianLayoutError extends Error {
  readonly code:
    | 'INVALID_ROOT'
    | 'INVALID_SLUG'
    | 'OUTSIDE_ROOT'
    | 'SYMLINK_REJECTED'
    | 'NON_MARKDOWN'
    | 'COLLISION_CHOICE_REQUIRED'
    | 'COLLISION_CHANGED'
    | 'CONFIRMATION_REQUIRED'
    | 'CANCELED'
    | 'WRITE_FAILED'
    | 'FRONTMATTER_INVALID'

  constructor(code: ObsidianLayoutError['code'], message: string) {
    super(message)
    this.name = 'ObsidianLayoutError'
    this.code = code
  }
}

export interface LayoutEntrySnapshot {
  readonly name: string
  readonly kind: LayoutPathKind
}

export interface LayoutBuildInput {
  readonly vaultRoot: string
  readonly projectId: string
  readonly displayName: string
  /** A read-only root listing supplied by the caller. */
  readonly existingEntries?: readonly (LayoutEntrySnapshot | string)[]
  /** Resolve an already-existing directory when the user selected “bind”. */
  readonly choice?: LayoutChoice
}

export interface LayoutCategoryPlan {
  readonly kind: ObsidianLayoutKind
  readonly enumName: string
  readonly directoryName: string
  readonly relativePath: string
  readonly absolutePath: string
}

export interface LayoutCollision {
  readonly requestedSlug: string
  readonly existingName: string
  readonly existingKind: LayoutPathKind
  readonly choices: readonly LayoutChoice[]
}

export interface LayoutPlan {
  readonly planId: string
  readonly vaultRoot: string
  readonly projectId: string
  readonly displayName: string
  readonly requestedSlug: string
  readonly slug: string
  readonly projectRelativePath: string
  readonly projectPath: string
  readonly categories: readonly LayoutCategoryPlan[]
  readonly readmeRelativePath: string
  readonly readmePath: string
  /** Relative paths are the safe service-facing representation. */
  readonly relativePaths: readonly string[]
  /** Absolute paths are included for the local preview UI only. */
  readonly paths: readonly string[]
  readonly collision: LayoutCollision | null
  readonly requiresConfirmation: true
}

export interface LayoutFileSystem {
  readonly lstat: (path: string) => Promise<LayoutStats>
  readonly realpath: (path: string) => Promise<string>
  readonly readdir: (path: string) => Promise<readonly LayoutDirent[]>
  readonly mkdir: (path: string) => Promise<void>
  readonly writeFileExclusive: (path: string, content: string) => Promise<void>
}

export interface LayoutStats {
  readonly isDirectory: () => boolean
  readonly isFile: () => boolean
  readonly isSymbolicLink: () => boolean
}

export interface LayoutDirent {
  readonly name: string
  readonly isDirectory: () => boolean
  readonly isFile: () => boolean
  readonly isSymbolicLink: () => boolean
}

const nodeFileSystem: LayoutFileSystem = {
  lstat: async (path) => nodeLstat(path),
  realpath: async (path) => nodeRealpath(path),
  readdir: async (path) => nodeReaddir(path, { withFileTypes: true }),
  mkdir: async (path) => { await nodeMkdir(path) },
  writeFileExclusive: async (path, content) => {
    await nodeWriteFile(path, content, { encoding: 'utf8', flag: 'wx' })
  }
}

export interface ValidatedVaultRoot {
  readonly root: string
  readonly realRoot: string
}

/** Normalize a Windows/display name to a single safe project directory name. */
export function sanitizeProjectSlug(displayName: string): string {
  const input = displayName.normalize('NFC').trim()
  // Windows forbids controls and these characters in a directory component.
  let slug = input.replace(/[\u0000-\u001f<>:"/\\|?*]/gu, '-')
  slug = slug.replace(/\s+/gu, ' ').replace(/[. ]+$/gu, '').trim()
  if (!slug || slug === '.' || slug === '..') {
    throw new ObsidianLayoutError('INVALID_SLUG', '项目名称不能为空或仅包含 Windows 保留字符')
  }
  const baseName = slug.split('.')[0]?.toLocaleUpperCase('en-US') ?? slug
  if (WINDOWS_RESERVED_NAMES.has(baseName)) {
    // The reserved token is special even when an extension follows it, so
    // insert the disambiguating suffix before the first dot (CON.txt →
    // CON-project.txt).
    const dot = slug.indexOf('.')
    slug = dot < 0 ? `${slug}-project` : `${slug.slice(0, dot)}-project${slug.slice(dot)}`
  }
  // Keep enough room for the legacy category names while staying below the
  // Windows per-component limit.  Do not split surrogate pairs.
  if ([...slug].length > 180) slug = [...slug].slice(0, 180).join('').replace(/[. ]+$/gu, '').trim()
  if (!slug) throw new ObsidianLayoutError('INVALID_SLUG', '项目名称无法转换为安全目录名')
  return slug
}

/**
 * Validate a Vault-relative path. Backslashes are accepted as input but the
 * returned representation is always POSIX-style `/` for the service/API.
 */
export function normalizeVaultRelativePath(pathValue: string, markdown = false): string {
  if (typeof pathValue !== 'string' || !pathValue || pathValue.startsWith('/') || pathValue.startsWith('\\') || /^[A-Za-z]:/u.test(pathValue)) {
    throw new ObsidianLayoutError('OUTSIDE_ROOT', 'Obsidian 路径必须是 Vault 内的相对路径')
  }
  const normalized = pathValue.replaceAll('\\', '/')
  const segments = normalized.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new ObsidianLayoutError('OUTSIDE_ROOT', 'Obsidian 路径不能包含空段或目录遍历')
  }
  if (segments.some((segment) => isObsidianSegment(segment))) {
    throw new ObsidianLayoutError('OUTSIDE_ROOT', 'Obsidian 路径不能进入 .obsidian')
  }
  if (markdown && !segments.at(-1)!.toLocaleLowerCase('en-US').endsWith('.md')) {
    throw new ObsidianLayoutError('NON_MARKDOWN', '项目索引只接受 Markdown 文件')
  }
  return segments.join('/')
}

export function isPathWithinRoot(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate))
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
}

/** Root validation is fail-closed: roots and all existing ancestors may not be links/junctions. */
export async function validateVaultRoot(vaultRoot: string, fs: LayoutFileSystem = nodeFileSystem): Promise<ValidatedVaultRoot> {
  if (!isAbsolute(vaultRoot) || containsObsidianSegment(vaultRoot)) {
    throw new ObsidianLayoutError('INVALID_ROOT', 'Obsidian Vault 必须是授权的绝对目录')
  }
  const root = resolve(vaultRoot)
  let rootStat: LayoutStats
  try {
    rootStat = await fs.lstat(root)
  } catch {
    throw new ObsidianLayoutError('INVALID_ROOT', 'Obsidian Vault 不存在或不可访问')
  }
  if (rootStat.isSymbolicLink()) throw new ObsidianLayoutError('SYMLINK_REJECTED', 'Obsidian Vault 不接受符号链接或 junction')
  if (!rootStat.isDirectory()) throw new ObsidianLayoutError('INVALID_ROOT', 'Obsidian Vault 必须是目录')
  let realRoot: string
  try { realRoot = await fs.realpath(root) } catch { throw new ObsidianLayoutError('INVALID_ROOT', 'Obsidian Vault 无法解析真实路径') }
  if (containsObsidianSegment(realRoot) || !isPathWithinRoot(root, realRoot)) {
    throw new ObsidianLayoutError('OUTSIDE_ROOT', 'Obsidian Vault 真实路径不安全')
  }
  return { root, realRoot }
}

function toEntrySnapshot(entry: LayoutDirent): LayoutEntrySnapshot {
  return {
    name: entry.name,
    kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'unknown'
  }
}

function canonicalSegment(value: string): string {
  // Windows compares names case-insensitively and ignores trailing dots/spaces.
  return value.normalize('NFC').replace(/[. ]+$/gu, '').toLocaleLowerCase('en-US')
}

function isObsidianSegment(value: string): boolean {
  return canonicalSegment(value) === '.obsidian'
}

function containsObsidianSegment(pathValue: string): boolean {
  return pathValue.split(/[\\/]+/u).some((segment) => isObsidianSegment(segment))
}

function existingEntry(entries: readonly (LayoutEntrySnapshot | string)[], slug: string): LayoutEntrySnapshot | undefined {
  const key = canonicalSegment(slug)
  for (const value of entries) {
    const entry = typeof value === 'string' ? { name: value, kind: 'unknown' as const } : value
    if (canonicalSegment(entry.name) === key) return entry
  }
  return undefined
}

function uniqueSlug(requested: string, entries: readonly (LayoutEntrySnapshot | string)[]): string {
  if (!existingEntry(entries, requested)) return requested
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = sanitizeProjectSlug(`${requested}-${suffix}`)
    if (!existingEntry(entries, candidate)) return candidate
  }
  throw new ObsidianLayoutError('INVALID_SLUG', '无法生成不冲突的项目目录名')
}

function makeLayoutPlan(input: LayoutBuildInput, root: string, entries: readonly (LayoutEntrySnapshot | string)[]): LayoutPlan {
  const projectId = ProjectIdSchema.parse(input.projectId)
  const requestedSlug = sanitizeProjectSlug(input.displayName)
  const collisionEntry = existingEntry(entries, requestedSlug)
  const collision = collisionEntry
    ? { requestedSlug, existingName: collisionEntry.name, existingKind: collisionEntry.kind, choices: ['bind', 'create', 'cancel'] as const }
    : null

  let slug = requestedSlug
  if (input.choice === 'create') slug = uniqueSlug(requestedSlug, entries)
  if (input.choice === 'bind' && collisionEntry?.kind === 'directory') slug = collisionEntry.name

  const projectRelativePath = normalizeVaultRelativePath(slug)
  const projectPath = resolve(root, ...projectRelativePath.split('/'))
  if (!isPathWithinRoot(root, projectPath) || isObsidianSegment(slug)) {
    throw new ObsidianLayoutError('OUTSIDE_ROOT', '项目目录不能离开 Vault 或进入 .obsidian')
  }
  const categories = OBSIDIAN_LAYOUT_CATEGORIES.map((category) => {
    const relativePath = `${projectRelativePath}/${category.directoryName}`
    const normalized = normalizeVaultRelativePath(relativePath)
    return {
      kind: category.kind,
      enumName: category.enumName,
      directoryName: category.directoryName,
      relativePath: normalized,
      absolutePath: resolve(root, ...normalized.split('/'))
    }
  })
  const readmeRelativePath = `${projectRelativePath}/README.md`
  const relativePaths = [projectRelativePath, ...categories.map((category) => category.relativePath), readmeRelativePath]
  const paths = [projectPath, ...categories.map((category) => category.absolutePath), resolve(root, ...readmeRelativePath.split('/'))]
  return {
    planId: randomUUID(),
    vaultRoot: root,
    projectId,
    displayName: input.displayName,
    requestedSlug,
    slug,
    projectRelativePath,
    projectPath,
    categories,
    readmeRelativePath,
    readmePath: paths.at(-1)!,
    relativePaths,
    paths,
    collision,
    requiresConfirmation: true
  }
}

/** Pure, side-effect-free plan construction (the existing listing is a snapshot). */
export function buildLayoutPlan(input: LayoutBuildInput): LayoutPlan {
  const root = validateVaultRootInput(input.vaultRoot)
  return makeLayoutPlan(input, root, input.existingEntries ?? [])
}

/** Compatibility alias used by callers that already have a root snapshot. */
export const previewLayout = buildLayoutPlan

/** Read-only on-disk preview. It never creates directories or files. */
export async function previewObsidianLayout(input: Omit<LayoutBuildInput, 'existingEntries' | 'choice'>, fs: LayoutFileSystem = nodeFileSystem): Promise<LayoutPlan> {
  const validated = await validateVaultRoot(input.vaultRoot, fs)
  let entries: readonly LayoutEntrySnapshot[]
  try {
    entries = (await fs.readdir(validated.root)).map(toEntrySnapshot)
  } catch {
    throw new ObsidianLayoutError('INVALID_ROOT', 'Obsidian Vault 目录无法读取')
  }
  const plan = makeLayoutPlan({ ...input, existingEntries: entries }, validated.root, entries)
  // A collision preview is still read-only, but reject an unsafe existing
  // directory before it can be offered as a bind target. Files remain a
  // normal collision (the user may choose a fresh slug).
  if (plan.collision?.existingKind === 'directory') {
    await validateExistingChain(plan.projectPath, validated, fs)
    for (const category of plan.categories) {
      await validateExistingChain(category.absolutePath, validated, fs)
      await inspectExisting(category.absolutePath, validated, fs)
    }
    await validateExistingChain(plan.readmePath, validated, fs)
    await inspectExisting(plan.readmePath, validated, fs)
  } else if (plan.collision?.existingKind === 'symlink') {
    throw new ObsidianLayoutError('SYMLINK_REJECTED', '项目目录包含符号链接或 junction')
  }
  return plan
}

function validateVaultRootInput(vaultRoot: string): string {
  if (!isAbsolute(vaultRoot) || containsObsidianSegment(vaultRoot)) {
    throw new ObsidianLayoutError('INVALID_ROOT', 'Obsidian Vault 必须是授权的绝对目录')
  }
  return resolve(vaultRoot)
}

function projectReadme(projectId: string, displayName: string): string {
  const categoryLines = OBSIDIAN_LAYOUT_CATEGORIES.map((category) => `- ${category.directoryName}（kind: ${category.kind}）：${category.description}`).join('\n')
  return `# ${displayName}\n\n<!-- Workbench project directory; generated without AI or prompt execution. -->\n\n- workbench_project_id: ${projectId}\n- 文件格式：Markdown（UTF-8）\n\n## 固定分类\n\n${categoryLines}\n`
}

async function inspectExisting(pathValue: string, root: ValidatedVaultRoot, fs: LayoutFileSystem): Promise<LayoutPathKind> {
  const relativePath = relative(root.root, resolve(pathValue))
  if (!isPathWithinRoot(root.root, pathValue) || containsObsidianSegment(relativePath)) {
    throw new ObsidianLayoutError('OUTSIDE_ROOT', '布局路径越过授权 Vault root')
  }
  let stat: LayoutStats
  try { stat = await fs.lstat(pathValue) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
  if (stat.isSymbolicLink()) throw new ObsidianLayoutError('SYMLINK_REJECTED', '布局路径包含符号链接或 junction')
  let realPath: string
  try { realPath = await fs.realpath(pathValue) } catch { throw new ObsidianLayoutError('OUTSIDE_ROOT', '布局路径无法解析真实路径') }
  if (!isPathWithinRoot(root.realRoot, realPath) || containsObsidianSegment(realPath)) {
    throw new ObsidianLayoutError('OUTSIDE_ROOT', '布局路径真实位置越过 Vault root')
  }
  if (stat.isDirectory()) return 'directory'
  if (stat.isFile()) return 'file'
  return 'unknown'
}

async function validateExistingChain(pathValue: string, root: ValidatedVaultRoot, fs: LayoutFileSystem): Promise<void> {
  const relativePath = relative(root.root, resolve(pathValue))
  if (!isPathWithinRoot(root.root, pathValue) || containsObsidianSegment(relativePath)) {
    throw new ObsidianLayoutError('OUTSIDE_ROOT', '布局路径越过授权 Vault root')
  }
  const segments = relativePath.split(sep).filter(Boolean)
  let current = root.root
  for (const segment of segments) {
    current = resolve(current, segment)
    const kind = await inspectExisting(current, root, fs)
    if (kind === 'missing') return
    if (kind !== 'directory') throw new ObsidianLayoutError('WRITE_FAILED', '布局路径的父级不是目录')
  }
}

export interface LayoutReceipt {
  readonly status: 'created' | 'bound' | 'canceled' | 'partial'
  readonly profileId?: string
  readonly projectId: string
  readonly slug: string | null
  readonly projectRelativePath: string | null
  readonly createdPaths: readonly string[]
  readonly preservedPaths: readonly string[]
  readonly message: string
}

export interface InitializeLayoutOptions {
  readonly confirmed: true
  readonly choice?: LayoutChoice
  readonly fs?: LayoutFileSystem
  /** Optional profile ID is carried for the eventual Service mapping commit. */
  readonly profileId?: string
}

/**
 * Apply a previously reviewed plan. Confirmation is mandatory and all paths
 * are revalidated against a fresh root snapshot to close the TOCTOU window.
 */
export async function initializeObsidianLayout(plan: LayoutPlan, options: InitializeLayoutOptions): Promise<LayoutReceipt> {
  if (options.confirmed !== true) throw new ObsidianLayoutError('CONFIRMATION_REQUIRED', '初始化布局需要明确确认')
  const fs = options.fs ?? nodeFileSystem
  const root = await validateVaultRoot(plan.vaultRoot, fs)
  const choice = options.choice
  const currentEntries = (await fs.readdir(root.root)).map(toEntrySnapshot)
  const currentCollision = existingEntry(currentEntries, plan.requestedSlug)

  if (choice === 'cancel') {
    return { status: 'canceled', ...(options.profileId === undefined ? {} : { profileId: options.profileId }), projectId: plan.projectId, slug: null, projectRelativePath: null, createdPaths: [], preservedPaths: [], message: '已取消 Obsidian 项目目录初始化。' }
  }
  if (plan.collision && choice === undefined) throw new ObsidianLayoutError('COLLISION_CHOICE_REQUIRED', '项目目录已存在，请选择绑定、创建新 slug 或取消')
  if (choice === 'bind' && (!currentCollision || currentCollision.kind !== 'directory')) throw new ObsidianLayoutError('COLLISION_CHANGED', '待绑定的项目目录已不存在或不是目录')

  let slug = plan.slug
  if (choice === 'create') slug = uniqueSlug(plan.requestedSlug, currentEntries)
  if (choice === 'bind' && currentCollision) slug = currentCollision.name
  const executionPlan = makeLayoutPlan({ vaultRoot: root.root, projectId: plan.projectId, displayName: plan.displayName, existingEntries: currentEntries, ...(choice === undefined ? {} : { choice }) }, root.root, currentEntries)
  // The freshly computed plan is authoritative for paths; never trust paths
  // supplied by a renderer or stale preview object.
  if (executionPlan.slug !== slug) slug = executionPlan.slug
  const projectPath = resolve(root.root, ...normalizeVaultRelativePath(slug).split('/'))
  if (!isPathWithinRoot(root.root, projectPath) || isObsidianSegment(slug)) throw new ObsidianLayoutError('OUTSIDE_ROOT', '项目目录不能离开 Vault')
  const createdPaths: string[] = []
  const preservedPaths: string[] = []
  let bound = false
  try {
    const projectKind = await inspectExisting(projectPath, root, fs)
    if (projectKind === 'symlink') throw new ObsidianLayoutError('SYMLINK_REJECTED', '项目目录包含符号链接或 junction')
    if (projectKind === 'file' || projectKind === 'unknown') throw new ObsidianLayoutError('WRITE_FAILED', '项目目录目标不是目录')
    if (projectKind === 'directory') {
      if (choice !== 'bind' && !plan.collision) throw new ObsidianLayoutError('COLLISION_CHANGED', '项目目录在确认前已被创建，请重新预览并选择绑定或新 slug')
      bound = choice === 'bind' || Boolean(plan.collision)
      preservedPaths.push(plan.projectRelativePath)
    } else {
      await validateExistingChain(projectPath, root, fs)
      await fs.mkdir(projectPath)
      createdPaths.push(executionPlan.projectRelativePath)
    }

    for (const category of executionPlan.categories) {
      await validateExistingChain(projectPath, root, fs)
      const categoryKind = await inspectExisting(category.absolutePath, root, fs)
      if (categoryKind === 'directory') preservedPaths.push(category.relativePath)
      else if (categoryKind === 'missing') { await fs.mkdir(category.absolutePath); createdPaths.push(category.relativePath) }
      else throw new ObsidianLayoutError('WRITE_FAILED', '分类路径不是安全目录')
    }

    await validateExistingChain(projectPath, root, fs)
    const readmeKind = await inspectExisting(executionPlan.readmePath, root, fs)
    if (readmeKind === 'missing') {
      await fs.writeFileExclusive(executionPlan.readmePath, projectReadme(plan.projectId, plan.displayName))
      createdPaths.push(executionPlan.readmeRelativePath)
    } else if (readmeKind === 'file') {
      // Existing README is user-owned; preserving it is intentionally idempotent.
      preservedPaths.push(executionPlan.readmeRelativePath)
    } else {
      throw new ObsidianLayoutError('NON_MARKDOWN', 'README.md 目标不是普通 Markdown 文件')
    }
  } catch (error) {
    if (createdPaths.length > 0) {
      return { status: 'partial', ...(options.profileId === undefined ? {} : { profileId: options.profileId }), projectId: plan.projectId, slug, projectRelativePath: executionPlan.projectRelativePath, createdPaths, preservedPaths, message: error instanceof ObsidianLayoutError ? `目录已部分初始化：${error.message}` : '目录已部分初始化，请检查 Vault 后重试。' }
    }
    throw error
  }
  return { status: bound ? 'bound' : 'created', ...(options.profileId === undefined ? {} : { profileId: options.profileId }), projectId: plan.projectId, slug, projectRelativePath: executionPlan.projectRelativePath, createdPaths, preservedPaths, message: bound ? '已绑定现有 Obsidian 项目目录。' : '已创建 Obsidian 项目目录。' }
}

function vaultCategoryKind(name: string, index: number): VaultLayoutPlan['categories'][number]['kind'] {
  const known: Record<string, VaultLayoutPlan['categories'][number]['kind']> = {
    '\u6bcf\u65e5\u6587\u732e\u63a8\u9001': 'daily_literature',
    '\u6587\u732e\u77e9\u9635': 'literature_matrix',
    '\u6587\u732e\u7efc\u8ff0': 'literature_review',
    '\u5199\u4f5c\u6a21\u677f': 'writing_templates',
    '\u63d0\u793a\u8bcd\u5e93': 'prompt_library',
    AnythingLLM: 'anything_llm',
    LLMWiki: 'llm_wiki'
  }
  return known[name] ?? (index < 0 ? 'custom' : 'custom')
}

/** Build a root-level Vault plan. This never creates a project folder. */
export function buildVaultLayoutPlan(input: {
  readonly vaultRoot: string
  readonly profileId: string
  readonly categories?: readonly string[]
  readonly existingEntries?: readonly (LayoutEntrySnapshot | string)[]
}): VaultLayoutPlan {
  const root = validateVaultRootInput(input.vaultRoot)
  const names = (input.categories && input.categories.length > 0 ? input.categories : DEFAULT_OBSIDIAN_VAULT_CATEGORIES).map((value) => value.trim())
  const unique = new Set<string>()
  if (names.length === 0 || names.length > 64) throw new ObsidianLayoutError('INVALID_SLUG', 'Vault 分类至少需要一个文件夹，且不能超过 64 个')
  const categories = names.map((name, index) => {
    if (!name || hasWindowsUnsafeComponent(name) || isObsidianSegment(name) || name.includes('/') || name.includes('\\')) throw new ObsidianLayoutError('INVALID_SLUG', 'Vault 分类名称必须是安全的单级文件夹名')
    const key = canonicalSegment(name)
    if (unique.has(key)) throw new ObsidianLayoutError('INVALID_SLUG', 'Vault 分类名称不能重复')
    unique.add(key)
    return { name, kind: vaultCategoryKind(name, index), relativePath: normalizeVaultRelativePath(name), absolutePath: resolve(root, name) }
  })
  const readmeRelativePath = 'README.md' as const
  const relativePaths = [...categories.map((category) => category.relativePath), readmeRelativePath]
  const existingEntries = input.existingEntries ?? []
  const existingPaths = existingEntries
    .filter((entry) => typeof entry === 'string' ? relativePaths.includes(entry) : relativePaths.includes(entry.name))
    .map((entry) => typeof entry === 'string' ? entry : entry.name)
  return {
    planId: randomUUID(),
    vaultRoot: root,
    profileId: IdSchema.parse(input.profileId),
    categories,
    readmeRelativePath,
    readmePath: resolve(root, readmeRelativePath),
    relativePaths,
    existingPaths
  }
}

export async function previewObsidianVaultLayout(input: {
  readonly vaultRoot: string
  readonly profileId: string
  readonly categories?: readonly string[]
}, fs: LayoutFileSystem = nodeFileSystem): Promise<VaultLayoutPlan> {
  const validated = await validateVaultRoot(input.vaultRoot, fs)
  let entries: readonly LayoutEntrySnapshot[]
  try { entries = (await fs.readdir(validated.root)).map(toEntrySnapshot) } catch { throw new ObsidianLayoutError('INVALID_ROOT', 'Obsidian Vault 目录无法读取') }
  const existingDirectories = entries.filter((entry) => entry.kind === 'directory' && !isObsidianSegment(entry.name) && !['.git', 'node_modules', '.trash'].includes(canonicalSegment(entry.name))).map((entry) => entry.name)
  // Always preview the standard root taxonomy and preserve any user-created
  // root folders.  An unrelated existing folder must not suppress creation of
  // the default categories.
  const categories = input.categories === undefined
    ? [...new Set([...DEFAULT_OBSIDIAN_VAULT_CATEGORIES, ...existingDirectories])]
    : input.categories
  const plan = buildVaultLayoutPlan({ ...input, vaultRoot: validated.root, ...(categories === undefined ? {} : { categories }), existingEntries: entries })
  for (const category of plan.categories) {
    const kind = await inspectExisting(category.absolutePath, validated, fs)
    if (kind === 'symlink') throw new ObsidianLayoutError('SYMLINK_REJECTED', 'Vault 分类路径包含符号链接或 junction')
    if (kind === 'file' || kind === 'unknown') throw new ObsidianLayoutError('WRITE_FAILED', 'Vault 分类路径已被文件占用')
  }
  const readmeKind = await inspectExisting(plan.readmePath, validated, fs)
  if (readmeKind === 'symlink') throw new ObsidianLayoutError('SYMLINK_REJECTED', 'README.md 包含符号链接或 junction')
  if (readmeKind !== 'missing' && readmeKind !== 'file') throw new ObsidianLayoutError('NON_MARKDOWN', 'README.md 目标不是普通 Markdown 文件')
  return plan
}

export async function initializeObsidianVaultLayout(plan: VaultLayoutPlan, options: { confirmed: true; fs?: LayoutFileSystem }): Promise<VaultLayoutReceipt> {
  if (options.confirmed !== true) throw new ObsidianLayoutError('CONFIRMATION_REQUIRED', '初始化 Vault 布局需要明确确认')
  const fs = options.fs ?? nodeFileSystem
  const root = await validateVaultRoot(plan.vaultRoot, fs)
  const createdPaths: string[] = []
  const preservedPaths: string[] = []
  try {
    for (const category of plan.categories) {
      const kind = await inspectExisting(category.absolutePath, root, fs)
      if (kind === 'directory') preservedPaths.push(category.relativePath)
      else if (kind === 'missing') { await fs.mkdir(category.absolutePath); createdPaths.push(category.relativePath) }
      else throw new ObsidianLayoutError('WRITE_FAILED', 'Vault 分类路径不是安全目录')
    }
    const readmeKind = await inspectExisting(plan.readmePath, root, fs)
    if (readmeKind === 'missing') {
      const lines = plan.categories.map((category) => `- ${category.name}`)
      await fs.writeFileExclusive(plan.readmePath, `# Personal Research Workbench\n\n<!-- Generated once; user content is preserved on subsequent initialization. -->\n\n## Vault categories\n\n${lines.join('\n')}\n\n## Project labels\n\nAdd a \`projectId\\: <id>\` or \`labels\\: [project:<id>]\` frontmatter field to associate a note with a project.\n`)
      createdPaths.push(plan.readmeRelativePath)
    } else if (readmeKind === 'file') preservedPaths.push(plan.readmeRelativePath)
    else throw new ObsidianLayoutError('NON_MARKDOWN', 'README.md 目标不是普通 Markdown 文件')
  } catch (error) {
    if (createdPaths.length === 0) throw error
    return { status: 'partial', profileId: plan.profileId, createdPaths, preservedPaths, message: 'Vault 已部分初始化，请检查后重试。' }
  }
  return { status: 'created', profileId: plan.profileId, createdPaths, preservedPaths, message: 'Vault 根目录分类已初始化；项目通过 Markdown 标签隔离。' }
}

export interface ParsedFrontmatter {
  readonly present: boolean
  readonly projectId: string | null
  readonly kind: ObsidianLayoutKind | null
  readonly kindValid: boolean
  readonly title: string | null
  readonly date: string | null
  readonly paperIds: readonly string[]
  readonly taskIds: readonly string[]
  readonly parent: string | null
  /** Non-project labels. `project:<id>` bindings are returned separately as projectId. */
  readonly tags: readonly string[]
  /** Unknown keys are returned as raw scalar/list values and never rewritten. */
  readonly unknownFields: Readonly<Record<string, unknown>>
  readonly unknownRaw: Readonly<Record<string, string>>
  readonly warnings: readonly string[]
}

interface FrontmatterEntry { readonly key: string; readonly value: unknown; readonly raw: string; readonly line: number }

function parseScalar(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return null
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1)
  if (trimmed === 'null' || trimmed === '~') return null
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/u.test(trimmed)) return Number(trimmed)
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed) as unknown } catch { /* retain the raw scalar */ }
  }
  return trimmed
}

function extractFrontmatter(markdown: string): { body: string; eol: string; entries: FrontmatterEntry[] } | null {
  const match = /^---(\r?\n)([\s\S]*?)(\r?\n)---(?:\r?\n|$)/u.exec(markdown)
  if (!match) return null
  const eol = match[1] ?? '\n'
  const body = match[2] ?? ''
  const lines = body.split(/\r?\n/u)
  const entries: FrontmatterEntry[] = []
  let listKey: string | null = null
  let listEntryIndex: number | null = null
  let listValues: unknown[] = []
  let listRaw: string[] = []
  const flushList = (): void => {
    if (listKey === null) return
    if (listEntryIndex !== null && entries[listEntryIndex] !== undefined) {
      entries[listEntryIndex] = { ...entries[listEntryIndex]!, value: listValues, raw: listRaw.join(eol) }
    }
    listKey = null
    listEntryIndex = null
    listValues = []
    listRaw = []
  }
  let parent: string | null = null
  lines.forEach((line, lineNumber) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return
    const listMatch = /^\s*-\s*(.*?)\s*$/u.exec(line)
    if (listMatch && listKey !== null) {
      listValues.push(parseScalar(listMatch[1] ?? ''))
      listRaw.push(line)
      return
    }
    flushList()
    const field = /^(\s*)([^:#][^:]*?):(?:\s*(.*))?$/u.exec(line)
    if (!field) return
    const indent = field[1]?.length ?? 0
    const rawKey = field[2]?.trim() ?? ''
    const key = indent > 0 && parent === 'workbench' ? `workbench.${rawKey}` : rawKey
    const rawValue = field[3] ?? ''
    if (indent === 0 && rawKey === 'workbench' && rawValue.trim() === '') {
      parent = 'workbench'
      entries.push({ key, value: null, raw: line, line: lineNumber })
      return
    }
    if (indent === 0) parent = null
    const value = parseScalar(rawValue)
    entries.push({ key, value, raw: line, line: lineNumber })
    if (rawValue.trim() === '') {
      listKey = key
      listEntryIndex = entries.length - 1
      listValues = []
      listRaw = [line]
    }
  })
  flushList()
  return { body, eol, entries }
}

function entryValue(entries: readonly FrontmatterEntry[], ...keys: string[]): FrontmatterEntry | undefined {
  return keys.map((key) => entries.find((entry) => entry.key === key)).find((entry): entry is FrontmatterEntry => entry !== undefined)
}

/** Merge `labels` and `tags` from both their inline and YAML-list forms. */
function collectLabelValues(entries: readonly FrontmatterEntry[]): unknown[] {
  const values: unknown[] = []
  for (const entry of entries) {
    if (entry.key !== 'labels' && entry.key !== 'tags') continue
    values.push(...(Array.isArray(entry.value) ? entry.value : [entry.value]))
  }
  return values
}

function parseIdList(entry: FrontmatterEntry | undefined, schema: typeof PaperIdSchema | typeof TaskIdSchema, label: string, warnings: string[]): string[] {
  if (!entry) return []
  const values = Array.isArray(entry.value) ? entry.value : [entry.value]
  const result: string[] = []
  for (const value of values) {
    const parsed = schema.safeParse(value)
    if (parsed.success) result.push(parsed.data)
    else warnings.push(`${label} 中存在无效 ID，已忽略。`)
  }
  return [...new Set(result)]
}

export function parseObsidianFrontmatter(markdown: string): ParsedFrontmatter {
  const parsed = extractFrontmatter(markdown)
  if (!parsed) return { present: false, projectId: null, kind: null, kindValid: true, title: null, date: null, paperIds: [], taskIds: [], parent: null, tags: [], unknownFields: {}, unknownRaw: {}, warnings: [] }
  const warnings: string[] = []
  const projectEntry = entryValue(parsed.entries, 'workbench_project_id', 'workbench.projectId', 'projectId', 'project_id')
  const projectResult = projectEntry ? ProjectIdSchema.safeParse(projectEntry.value) : null
  if (projectEntry && !projectResult?.success) warnings.push('workbench_project_id 无效，未建立项目关联。')
  const labelValues = collectLabelValues(parsed.entries)
  const labelProjectResult = labelValues
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.toLocaleLowerCase('en-US').startsWith('project:'))
    .map((value) => ProjectIdSchema.safeParse(value.slice('project:'.length).trim()))
    .find((result) => result.success)
  const labelProjectId = labelProjectResult?.success ? labelProjectResult.data : null
  const kindEntry = entryValue(parsed.entries, 'workbench_kind', 'workbench.kind')
  const kindRaw = typeof kindEntry?.value === 'string' ? kindEntry.value : null
  const category = kindRaw === null ? undefined : categoryByKind.get(kindRaw) ?? categoryByKind.get(kindRaw.toLocaleLowerCase('en-US'))
  const kindValid = kindEntry === undefined || category !== undefined
  if (!kindValid) warnings.push('workbench_kind 未知，文件归入未分类且不会被移动。')
  const duplicateGroups = [
    ['workbench_project_id', 'workbench.projectId'],
    ['workbench_kind', 'workbench.kind'],
    ['workbench_title', 'title'],
    ['workbench_date', 'workbench.date']
  ]
  for (const group of duplicateGroups) {
    const count = parsed.entries.filter((entry) => group.includes(entry.key)).length
    if (count > 1) warnings.push(`${group[0]} 在 frontmatter 中重复，已采用第一个值。`)
  }
  const parentEntry = entryValue(parsed.entries, 'workbench_parent', 'parent')
  const knownKeys = new Set(['workbench', 'workbench_project_id', 'workbench.projectId', 'projectId', 'project_id', 'labels', 'tags', 'workbench_kind', 'workbench.kind', 'workbench_title', 'title', 'workbench_date', 'workbench.date', 'paper_ids', 'paperIds', 'workbench.paperIds', 'task_ids', 'taskIds', 'workbench.taskIds', 'workbench_parent', 'parent'])
  const unknownFields: Record<string, unknown> = {}
  const unknownRaw: Record<string, string> = {}
  for (const entry of parsed.entries) {
    if (!knownKeys.has(entry.key)) {
      unknownFields[entry.key] = entry.value
      unknownRaw[entry.key] = entry.raw
    }
  }
  return {
    present: true,
    projectId: projectResult?.success ? projectResult.data : labelProjectId,
    kind: category?.kind ?? null,
    kindValid,
    title: typeof entryValue(parsed.entries, 'workbench_title', 'title')?.value === 'string' ? String(entryValue(parsed.entries, 'workbench_title', 'title')!.value) : null,
    date: typeof entryValue(parsed.entries, 'workbench_date', 'workbench.date')?.value === 'string' ? String(entryValue(parsed.entries, 'workbench_date', 'workbench.date')!.value) : null,
    paperIds: parseIdList(entryValue(parsed.entries, 'paper_ids', 'paperIds', 'workbench.paperIds'), PaperIdSchema, 'paper_ids', warnings),
    taskIds: parseIdList(entryValue(parsed.entries, 'task_ids', 'taskIds', 'workbench.taskIds'), TaskIdSchema, 'task_ids', warnings),
    parent: typeof parentEntry?.value === 'string' ? parentEntry.value : null,
    tags: [...new Set(labelValues
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && !value.toLocaleLowerCase('en-US').startsWith('project:')))],
    unknownFields,
    unknownRaw,
    warnings
  }
}

/** Short aliases for index consumers that do not need the Obsidian prefix. */
export const parseFrontmatter = parseObsidianFrontmatter

export interface ObsidianNoteIndexEntry {
  readonly relativePath: string
  readonly title: string
  readonly kind: ObsidianLayoutKind | 'unclassified'
  readonly kindSource: 'frontmatter' | 'directory' | 'unclassified'
  readonly projectId: string | null
  readonly projectAssociation: 'frontmatter' | 'directory' | 'none'
  readonly paperIds: readonly string[]
  readonly taskIds: readonly string[]
  readonly fingerprint: string
  readonly unknownFields: Readonly<Record<string, unknown>>
  readonly warnings: readonly string[]
}

export interface NoteIndexOptions {
  /** Map first-level project directory slug to a validated ProjectId. */
  readonly projectDirectories?: ReadonlyMap<string, string> | Readonly<Record<string, string>>
}

export function mapMarkdownToIndex(relativePath: string, markdown: string, options: NoteIndexOptions = {}): ObsidianNoteIndexEntry {
  void options
  const normalizedPath = normalizeVaultRelativePath(relativePath, true)
  const segments = normalizedPath.split('/')
  const filename = segments.at(-1)!.replace(/\.md$/iu, '')
  const frontmatter = parseObsidianFrontmatter(markdown)
  const directoryCategory = segments.length > 1 ? categoryByDirectory.get(canonicalSegment(segments.at(-2)!)) : undefined
  const kindSource: ObsidianNoteIndexEntry['kindSource'] = frontmatter.kindValid && frontmatter.kind !== null ? 'frontmatter' : frontmatter.kindValid && directoryCategory ? 'directory' : 'unclassified'
  const kind = frontmatter.kindValid && frontmatter.kind !== null ? frontmatter.kind : directoryCategory?.kind ?? 'unclassified'
  const projectId = frontmatter.projectId
  const projectAssociation: ObsidianNoteIndexEntry['projectAssociation'] = frontmatter.projectId !== null ? 'frontmatter' : 'none'
  const warnings = [...frontmatter.warnings]
  if (frontmatter.projectId === null) warnings.push('未发现有效项目关联，请在 frontmatter 中设置 projectId 或 labels。')
  if (!frontmatter.kindValid) warnings.push('未知 kind 保留原文件位置并归入未分类。')
  const heading = markdown.match(/^#\s+(.+?)\s*$/mu)?.[1]?.trim()
  return {
    relativePath: normalizedPath,
    title: (frontmatter.title ?? heading ?? filename) || 'Untitled',
    kind,
    kindSource,
    projectId,
    projectAssociation,
    paperIds: frontmatter.paperIds,
    taskIds: frontmatter.taskIds,
    fingerprint: createHash('sha256').update(markdown, 'utf8').digest('hex'),
    unknownFields: frontmatter.unknownFields,
    warnings
  }
}

export const indexMarkdownNote = mapMarkdownToIndex

export interface ManagedFrontmatterPatch {
  readonly projectId?: string | null
  readonly kind?: ObsidianLayoutKind | null
  readonly title?: string
  readonly date?: string
  readonly paperIds?: readonly string[]
  readonly taskIds?: readonly string[]
  /** Parent note for a child note; `null` clears the relation. */
  readonly parent?: string | null
  /** Non-project labels. The `project:<id>` label is derived from `projectId`. */
  readonly labels?: readonly string[]
}

/** Every managed key owns one or more frontmatter field names.  Aliases are
 * kept in sync so a legacy `projectId:` line cannot contradict the canonical
 * `workbench_project_id:` value. */
const managedFieldNames: Readonly<Record<keyof ManagedFrontmatterPatch, readonly string[]>> = {
  projectId: ['workbench_project_id', 'projectId'],
  kind: ['workbench_kind'],
  title: ['workbench_title'],
  date: ['workbench_date'],
  paperIds: ['paper_ids'],
  taskIds: ['task_ids'],
  parent: ['workbench_parent'],
  labels: ['labels', 'tags']
}

export const MANAGED_FRONTMATTER_FIELDS: Readonly<Record<keyof ManagedFrontmatterPatch, readonly string[]>> = managedFieldNames

function nonProjectLabels(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0 && !value.toLocaleLowerCase('en-US').startsWith('project:')))]
}

/** Project labels always mirror the controlled project binding. */
function labelsWithProject(labels: readonly string[], projectId: string | null | undefined): string[] {
  return [...nonProjectLabels(labels), ...(typeof projectId === 'string' ? [`project:${projectId}`] : [])]
}

function patchValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return JSON.stringify(value)
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

function validateManagedPatch(patch: ManagedFrontmatterPatch): void {
  if (patch.projectId !== undefined && patch.projectId !== null) ProjectIdSchema.parse(patch.projectId)
  if (patch.kind !== undefined && patch.kind !== null && !categoryByKind.has(patch.kind)) {
    throw new ObsidianLayoutError('FRONTMATTER_INVALID', 'workbench_kind 不是固定分类')
  }
  if (patch.paperIds !== undefined) {
    for (const id of patch.paperIds) PaperIdSchema.parse(id)
  }
  if (patch.taskIds !== undefined) {
    for (const id of patch.taskIds) TaskIdSchema.parse(id)
  }
  if (patch.parent !== undefined && patch.parent !== null) {
    normalizeVaultRelativePath(patch.parent, true)
  }
  for (const label of patch.labels ?? []) {
    if (typeof label !== 'string' || label.trim().length === 0 || label.length > 200 || /[\r\n]/u.test(label)) {
      throw new ObsidianLayoutError('FRONTMATTER_INVALID', '标签必须是非空的单行文本')
    }
  }
}

/** Update only controlled keys while retaining every unknown frontmatter line.
 *
 * Notes that already carry both `labels` and `tags` keep both; the project
 * label is always derived from `projectId` so binding/unbinding cannot leave a
 * stale `project:<id>` behind. */
export function updateManagedFrontmatter(markdown: string, patch: ManagedFrontmatterPatch): string {
  validateManagedPatch(patch)
  const parsed = extractFrontmatter(markdown)
  const patchEntries = (Object.keys(managedFieldNames) as Array<keyof ManagedFrontmatterPatch>).filter((key) => patch[key] !== undefined)
  // A project binding change has to rewrite the label list even when the
  // caller did not supply labels, otherwise the reserved `project:` label
  // would contradict `workbench_project_id`.
  const syncLabels = patch.labels !== undefined || patch.projectId !== undefined
  if (patchEntries.length === 0 && !syncLabels) return markdown
  const values: Partial<Record<keyof ManagedFrontmatterPatch, unknown>> = { ...patch }
  if (syncLabels) {
    const sourceLabels = patch.labels !== undefined
      ? patch.labels
      : collectLabelValues(parsed?.entries ?? []).filter((value): value is string => typeof value === 'string')
    values.labels = labelsWithProject(sourceLabels, patch.projectId)
  }
  const fieldValues = (key: keyof ManagedFrontmatterPatch): string => patchValue(values[key])
  const entriesToWrite = (Object.keys(managedFieldNames) as Array<keyof ManagedFrontmatterPatch>)
    .filter((key) => values[key] !== undefined || (key === 'labels' && syncLabels))
  for (const key of entriesToWrite) {
    for (const fieldName of managedFieldNames[key]) {
      const duplicates = parsed?.entries.filter((entry) => entry.key === fieldName).length ?? 0
      if (duplicates > 1) throw new ObsidianLayoutError('FRONTMATTER_INVALID', `frontmatter 中存在重复的 ${fieldName}`)
    }
  }
  if (!parsed) {
    const lines = ['---']
    for (const key of entriesToWrite) {
      for (const fieldName of managedFieldNames[key]) lines.push(`${fieldName}: ${fieldValues(key)}`)
    }
    lines.push('---', markdown)
    return lines.join('\n')
  }
  const lines = parsed.body.split(/\r?\n/u)
  const present = new Set<string>()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const match = /^(\s*)([^:#][^:]*?):(?:\s*(.*))?$/u.exec(line)
    if (!match || (match[1] ?? '') !== '') continue
    const fieldName = match[2]?.trim() ?? ''
    const key = entriesToWrite.find((entryKey) => managedFieldNames[entryKey].includes(fieldName))
    if (!key) continue
    lines[index] = `${fieldName}: ${fieldValues(key)}`
    present.add(fieldName)
    // Remove an old indented YAML list belonging to this managed field; the
    // replacement is a JSON-encoded array, and unknown fields remain intact.
    if (Array.isArray(values[key])) {
      while (index + 1 < lines.length && /^\s+-\s*/u.test(lines[index + 1]!)) lines.splice(index + 1, 1)
    }
  }
  const additions: string[] = []
  for (const key of entriesToWrite) {
    // A stale alias (for example `projectId:` when only `workbench_project_id:`
    // existed) is written too so both names agree.
    for (const fieldName of managedFieldNames[key]) {
      if (!present.has(fieldName)) additions.push(`${fieldName}: ${fieldValues(key)}`)
    }
  }
  if (additions.length > 0) lines.push(...additions)
  const body = lines.join(parsed.eol)
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(markdown)
  const consumed = match?.[0] ?? ''
  const closingEol = consumed.endsWith(parsed.eol) ? parsed.eol : ''
  const prefix = `---${parsed.eol}${body}${parsed.eol}---${closingEol}`
  return `${prefix}${markdown.slice(consumed.length)}`
}

export const updateFrontmatter = updateManagedFrontmatter
