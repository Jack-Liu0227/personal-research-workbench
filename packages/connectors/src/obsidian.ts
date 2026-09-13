import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  AdapterProbe,
  AdapterProfile,
  AdapterPullResult,
  ManagedProjection,
  NormalizedExternalPaper,
  ProjectionReceipt,
  ProjectionTarget
} from './types.js'
import { IntegrationRuntimeError } from './types.js'

const ignoredSegments = new Set(['.obsidian', '.trash', '.git', 'node_modules'])
const maximumMarkdownBytes = 2 * 1024 * 1024
const maximumFiles = 20_000

interface SafeVaultRoot {
  readonly root: string
  readonly realRoot: string
}

function containsObsidianSegment(pathValue: string): boolean {
  return pathValue
    .split(/[\\/]+/u)
    .some((segment) => {
      const filesystemSegment = process.platform === 'win32'
        ? segment.replace(/[. ]+$/u, '')
        : segment
      return filesystemSegment.toLocaleLowerCase('en-US') === '.obsidian'
    })
}

function rejectObsidianSegment(pathValue: string, message: string): void {
  if (containsObsidianSegment(pathValue)) {
    throw new IntegrationRuntimeError('INVALID_MAPPING', message)
  }
}

function requireVaultRoot(profile: AdapterProfile): string {
  if (!profile.location || !isAbsolute(profile.location)) {
    throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian vault 必须是绝对路径')
  }
  const root = resolve(profile.location)
  rejectObsidianSegment(root, 'Obsidian vault 不能位于 .obsidian 内部目录')
  return root
}

function insideRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
}

async function requireSafeVaultRoot(profile: AdapterProfile): Promise<SafeVaultRoot> {
  const root = requireVaultRoot(profile)
  let realRoot: string
  try {
    const rootEntry = await lstat(root)
    if (rootEntry.isSymbolicLink()) {
      throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian vault root cannot be a symbolic link or junction.')
    }
    realRoot = await realpath(root)
  } catch (error) {
    if (error instanceof IntegrationRuntimeError) throw error
    throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian vault 路径不存在或不可访问')
  }
  rejectObsidianSegment(realRoot, 'Obsidian vault 的真实路径不能位于 .obsidian 内部目录')
  const rootStat = await stat(realRoot)
  if (!rootStat.isDirectory()) {
    throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian vault 必须是目录')
  }
  return { root, realRoot }
}

/**
 * Validate an Obsidian profile before a higher-level operation starts.  The
 * resolved paths intentionally stay inside the connector; callers only use
 * this as a capability/safety gate and must continue to pass the configured
 * profile location to their own operation-specific implementation.
 */
export async function assertObsidianVault(profile: AdapterProfile): Promise<void> {
  await requireSafeVaultRoot(profile)
}

export type ObsidianPathKind = 'directory' | 'file' | 'symlink' | 'missing' | 'unknown'

export interface ObsidianPathSnapshot {
  readonly name: string
  readonly kind: ObsidianPathKind
}

/**
 * Filesystem adapter for the layout service. The connector owns every
 * operation and captures no path outside the validated Vault boundary; the
 * service may use the returned methods only with its internally-built paths.
 */
export interface ObsidianLayoutFileSystem {
  readonly lstat: (path: string) => Promise<{ isDirectory: () => boolean; isFile: () => boolean; isSymbolicLink: () => boolean }>
  readonly realpath: (path: string) => Promise<string>
  readonly readdir: (path: string) => Promise<readonly { name: string; isDirectory: () => boolean; isFile: () => boolean; isSymbolicLink: () => boolean }[]>
  readonly mkdir: (path: string) => Promise<void>
  readonly writeFileExclusive: (path: string, content: string) => Promise<void>
}

export async function createObsidianLayoutFileSystem(profile: AdapterProfile): Promise<ObsidianLayoutFileSystem> {
  const { root } = await requireSafeVaultRoot(profile)
  const assertPath = (path: string): string => {
    const candidate = resolve(path)
    const relativePath = relative(root, candidate)
    if (path.split(/[\\/]+/u).some((segment) => segment === '.' || segment === '..') || !insideRoot(root, candidate) || containsObsidianSegment(relativePath)) {
      throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian layout path must stay inside the configured Vault.')
    }
    return candidate
  }
  return {
    lstat: async (path) => lstat(assertPath(path)),
    realpath: async (path) => realpath(assertPath(path)),
    readdir: async (path) => readdir(assertPath(path), { withFileTypes: true }),
    mkdir: async (path) => { await mkdir(assertPath(path)) },
    writeFileExclusive: async (path, content) => { await writeFile(assertPath(path), content, { encoding: 'utf8', flag: 'wx' }) }
  }
}

/** Return a root-only, vault-relative snapshot for safe layout planning. */
export async function snapshotObsidianRoot(profile: AdapterProfile): Promise<ObsidianPathSnapshot[]> {
  const { root } = await requireSafeVaultRoot(profile)
  return (await readdir(root, { withFileTypes: true })).map((entry) => ({
    name: entry.name,
    kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'unknown'
  }))
}

/**
 * Inspect validated Vault-relative paths without exposing their resolved
 * absolute locations. Existing links/junctions and containment escapes fail
 * closed before a layout preview can be confirmed.
 */
export async function inspectObsidianPaths(profile: AdapterProfile, relativePaths: readonly string[]): Promise<ObsidianPathSnapshot[]> {
  const { root, realRoot } = await requireSafeVaultRoot(profile)
  const snapshots: ObsidianPathSnapshot[] = []
  for (const value of relativePaths) {
    if (!value || isAbsolute(value) || value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/u.test(value) || value.split(/[\\/]+/u).some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian layout paths must stay inside the configured Vault.')
    }
    rejectObsidianSegment(value, 'Obsidian layout paths cannot enter .obsidian.')
    const normalized = value.replaceAll('\\', '/')
    const candidate = resolve(root, ...normalized.split('/'))
    if (!insideRoot(root, candidate)) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian layout path escaped the configured Vault.')
    await validateExistingParentChain(root, realRoot, dirname(candidate))
    let candidateStat
    try {
      candidateStat = await lstat(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        snapshots.push({ name: normalized, kind: 'missing' })
        continue
      }
      throw error
    }
    if (candidateStat.isSymbolicLink()) {
      snapshots.push({ name: normalized, kind: 'symlink' })
      continue
    }
    const resolvedCandidate = await realpath(candidate)
    if (!insideRoot(realRoot, resolvedCandidate)) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian layout path escaped the configured Vault.')
    snapshots.push({
      name: normalized,
      kind: candidateStat.isDirectory() ? 'directory' : candidateStat.isFile() ? 'file' : 'unknown'
    })
  }
  return snapshots
}

async function validateExistingParentChain(
  root: string,
  realRoot: string,
  parent: string
): Promise<void> {
  if (!insideRoot(root, parent)) {
    throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 写入目录位于 Vault 外部')
  }
  const pathFromRoot = relative(root, parent)
  if (pathFromRoot === '') return

  let current = root
  for (const segment of pathFromRoot.split(sep).filter(Boolean)) {
    current = resolve(current, segment)
    let entry
    try {
      entry = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    let resolvedEntry: string
    try {
      resolvedEntry = await realpath(current)
    } catch {
      throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 写入目录的现有父路径无法安全解析')
    }
    rejectObsidianSegment(resolvedEntry, 'Obsidian 写入目录的真实路径不能经过 .obsidian')
    if (!insideRoot(realRoot, resolvedEntry)) {
      throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 写入目录通过链接指向了 Vault 外部')
    }
    const entryStat = entry.isSymbolicLink() ? await stat(resolvedEntry) : entry
    if (!entryStat.isDirectory()) {
      throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 写入目录的父路径不是目录')
    }
  }
}

function extractFrontmatterRaw(markdown: string, key: string): string | null {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match?.[1]) return null
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return match[1].match(new RegExp(`^${escaped}:[ \\t]*(.*?)[ \\t]*$`, 'm'))?.[1]?.trim() ?? null
}

function extractFrontmatterValue(markdown: string, key: string): string | null {
  const value = extractFrontmatterRaw(markdown, key)
  if (!value) return null
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function extractFrontmatterJson(markdown: string, key: string): unknown | null {
  const raw = extractFrontmatterRaw(markdown, key)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function managedNullableString(markdown: string, key: string): string | null | undefined {
  const raw = extractFrontmatterRaw(markdown, key)
  if (raw === null) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'string' || value === null ? value : undefined
  } catch {
    return undefined
  }
}

function managedString(markdown: string, key: string): string | null {
  const value = extractFrontmatterJson(markdown, key)
  return typeof value === 'string' ? value : null
}

function managedStringList(markdown: string, key: string): string[] | null {
  const value = extractFrontmatterJson(markdown, key)
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null
}

function extractTitle(markdown: string, fallback: string): string {
  const frontmatterTitle = extractFrontmatterValue(markdown, 'title')
  if (frontmatterTitle) return frontmatterTitle
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim()
  return heading || fallback
}

function extractYamlList(markdown: string, key: string): string[] {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match?.[1]) return []
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const property = new RegExp(`^${escaped}:[ \\t]*(.*)$`, 'm').exec(match[1])
  if (!property) return []
  const inline = property[1]?.trim() ?? ''
  if (inline) {
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((value) => value.trim().replace(/^['"]|['"]$/g, '').replace(/^#/, ''))
      .filter(Boolean)
  }

  const tail = match[1].slice((property.index ?? 0) + property[0].length)
  const values: string[] = []
  for (const line of tail.split(/\r?\n/).slice(1)) {
    const item = line.match(/^\s+-\s+(.+?)\s*$/)?.[1]
    if (item) {
      values.push(item.replace(/^['"]|['"]$/g, '').replace(/^#/, ''))
      continue
    }
    if (/^\S/.test(line)) break
  }
  return values
}

function extractManagedList(markdown: string, key: string): string[] | null {
  const raw = extractFrontmatterValue(markdown, key)
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return raw.replace(/^\[|\]$/g, '').split(',').map((value) => value.trim()).filter(Boolean)
  }
}

function extractManagedBlockId(markdown: string): string | null {
  const matches = [...markdown.matchAll(/<!-- workbench:begin id="([^"]+)" revision="[^"]+" -->/g)]
  return matches.length === 1 ? matches[0]?.[1] ?? null : null
}

function upsertWorkbenchFrontmatter(markdown: string, projection: ManagedProjection): string {
  const managed = new Map<string, string>([
    ['workbench_id', JSON.stringify(projection.workbenchId)],
    ['workbench_kind', 'literature-note'],
    ['workbench_title', JSON.stringify(projection.title)],
    ['workbench_tags', JSON.stringify(projection.tags)],
    ['workbench_collections', JSON.stringify(projection.collections)]
  ])
  if (projection.authors !== undefined) managed.set('workbench_authors', JSON.stringify(projection.authors))
  if (projection.year !== undefined) managed.set('workbench_year', JSON.stringify(projection.year))
  if (projection.venue !== undefined) managed.set('workbench_venue', JSON.stringify(projection.venue))
  if (projection.abstract !== undefined) managed.set('workbench_abstract', JSON.stringify(projection.abstract))
  if (projection.doi !== undefined) managed.set('workbench_doi', JSON.stringify(projection.doi))
  if (projection.url !== undefined) managed.set('workbench_url', JSON.stringify(projection.url))
  if (projection.citationKey !== undefined) managed.set('workbench_citation_key', JSON.stringify(projection.citationKey))
  const frontmatter = markdown.match(/^---(\r?\n)([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!frontmatter) {
    const lines = [...managed].map(([key, value]) => `${key}: ${value}`).join('\n')
    return `---\n${lines}\n---\n\n${markdown}`
  }

  const eol = frontmatter[1] ?? '\n'
  const lines = (frontmatter[2] ?? '').split(/\r?\n/)
  for (const [key, value] of managed) {
    const matches = lines.flatMap((line, index) => line.match(new RegExp(`^${key}:\\s*`)) ? [index] : [])
    if (matches.length > 1) throw new IntegrationRuntimeError('REVISION_CONFLICT', `Obsidian frontmatter 中存在重复的 ${key}`)
    if (matches.length === 1) lines[matches[0]!] = `${key}: ${value}`
    else lines.push(`${key}: ${value}`)
  }
  const replacement = `---${eol}${lines.join(eol)}${eol}---${eol}`
  return `${replacement}${markdown.slice(frontmatter[0].length)}`
}

export function upsertManagedBlock(markdown: string, projection: ManagedProjection): string {
  const begin = `<!-- workbench:begin id="${projection.blockId}" revision="${projection.revision}" -->`
  const end = `<!-- workbench:end id="${projection.blockId}" -->`
  const escaped = projection.blockId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const blockPattern = new RegExp(
    `<!-- workbench:begin id="${escaped}" revision="[^"]+" -->[\\s\\S]*?<!-- workbench:end id="${escaped}" -->`,
    'g'
  )
  const matches = markdown.match(blockPattern) ?? []
  if (matches.length > 1) {
    throw new IntegrationRuntimeError('REVISION_CONFLICT', '检测到重复的工作台托管区块')
  }
  const block = `${begin}\n## ${projection.title}\n\n${projection.markdown.trim()}\n${end}`
  const withId = upsertWorkbenchFrontmatter(markdown, projection)
  if (matches.length === 1) return withId.replace(blockPattern, block)
  return `${withId.trimEnd()}\n\n${block}\n`
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ignoredSegments.has(entry.name.toLocaleLowerCase('en-US'))) continue
      const fullPath = resolve(current, entry.name)
      if (!insideRoot(root, fullPath)) continue
      if (entry.isDirectory()) queue.push(fullPath)
      if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') files.push(fullPath)
      if (files.length > maximumFiles) {
        throw new IntegrationRuntimeError('INVALID_MAPPING', `Vault Markdown 文件超过 ${maximumFiles} 个安全上限`)
      }
    }
  }
  return files
}

export async function probeObsidian(profile: AdapterProfile): Promise<AdapterProbe> {
  try {
    await requireSafeVaultRoot(profile)
    return {
      ok: true,
      message: 'Obsidian Vault 可访问；仅处理 Markdown，忽略 .obsidian',
      capabilities: { read: true, write: true, attachments: 'link_only', incremental: false }
    }
  } catch {
    return {
      ok: false,
      message: '无法访问 Obsidian Vault，请检查目录授权',
      capabilities: { read: false, write: false, attachments: 'link_only', incremental: false }
    }
  }
}

export async function pullObsidian(profile: AdapterProfile): Promise<AdapterPullResult> {
  const { root } = await requireSafeVaultRoot(profile)
  const papers: NormalizedExternalPaper[] = []
  for (const filePath of await listMarkdownFiles(root)) {
    const fileStat = await stat(filePath)
    if (fileStat.size > maximumMarkdownBytes) continue
    const markdown = await readFile(filePath, 'utf8')
    const externalId = extractFrontmatterValue(markdown, 'workbench_id') ?? relative(root, filePath).replaceAll('\\', '/')
    const managedYear = extractFrontmatterJson(markdown, 'workbench_year')
    const managedDoi = managedNullableString(markdown, 'workbench_doi')
    const managedUrl = managedNullableString(markdown, 'workbench_url')
    const managedCitationKey = managedNullableString(markdown, 'workbench_citation_key')
    const doi = managedDoi === undefined ? extractFrontmatterValue(markdown, 'doi') : managedDoi
    const url = managedUrl === undefined ? extractFrontmatterValue(markdown, 'url') : managedUrl
    papers.push({
      externalId,
      locator: filePath,
      remoteRevision: `${fileStat.mtimeMs}:${fileStat.size}`,
      managedBlockId: extractManagedBlockId(markdown),
      title: managedString(markdown, 'workbench_title') ?? extractTitle(markdown, filePath.split(/[\\/]/).at(-1)?.replace(/\.md$/i, '') ?? 'Untitled'),
      authors: managedStringList(markdown, 'workbench_authors') ?? extractYamlList(markdown, 'authors'),
      year: typeof managedYear === 'number' && Number.isInteger(managedYear) ? managedYear : null,
      venue: managedString(markdown, 'workbench_venue') ?? '',
      abstract: managedString(markdown, 'workbench_abstract') ?? extractFrontmatterValue(markdown, 'abstract') ?? '',
      doi,
      url,
      citationKey: managedCitationKey === undefined
        ? extractFrontmatterValue(markdown, 'citation_key')
        : managedCitationKey,
      tags: extractManagedList(markdown, 'workbench_tags') ?? (() => {
        const tags = extractYamlList(markdown, 'tags')
        return tags.length > 0 ? tags : extractYamlList(markdown, 'labels')
      })(),
      collections: extractManagedList(markdown, 'workbench_collections') ?? extractYamlList(markdown, 'collections'),
      localPdfPath: null
    })
  }
  return { cursor: new Date().toISOString(), papers }
}

export interface ObsidianNote {
  readonly relativePath: string
  readonly title: string
  readonly tags: string[]
  readonly updatedAt: string
  readonly fingerprint: string
  readonly content?: string
  readonly isFolder?: boolean
}

export async function listObsidianNotes(profile: AdapterProfile, query = ''): Promise<ObsidianNote[]> {
  const { root } = await requireSafeVaultRoot(profile)
  const normalizedQuery = query.trim().toLocaleLowerCase('en-US')
  const notes: ObsidianNote[] = []
  const folders: string[] = []
  const folderQueue = [root]
  while (folderQueue.length > 0) {
    const current = folderQueue.shift()
    if (!current) continue
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ignoredSegments.has(entry.name.toLocaleLowerCase('en-US'))) continue
      const fullPath = resolve(current, entry.name)
      if (!insideRoot(root, fullPath)) continue
      if (entry.isDirectory()) {
        // `path.relative` uses the host separator.  Normalize one separator
        // character at a time so Windows folder entries satisfy the
        // vault-relative wire contract (and nested folders remain readable).
        folders.push(relative(root, fullPath).replaceAll('\\', '/'))
        folderQueue.push(fullPath)
      }
    }
  }
  for (const filePath of await listMarkdownFiles(root)) {
    const fileStat = await stat(filePath)
    if (fileStat.size > maximumMarkdownBytes) continue
    const markdown = await readFile(filePath, 'utf8')
    const relativePath = relative(root, filePath).replaceAll('\\', '/')
    const title = extractTitle(markdown, filePath.split(/[\\/]/u).at(-1)?.replace(/\.md$/i, '') ?? 'Untitled')
    const tags = extractManagedList(markdown, 'workbench_tags') ?? (() => {
      const tags = extractYamlList(markdown, 'tags')
      return tags.length > 0 ? tags : extractYamlList(markdown, 'labels')
    })()
    if (normalizedQuery && ![relativePath, title, ...tags].join(' ').toLocaleLowerCase('en-US').includes(normalizedQuery)) continue
    notes.push({
      relativePath,
      title,
      tags,
      updatedAt: fileStat.mtime.toISOString(),
      fingerprint: `${fileStat.mtimeMs}:${fileStat.size}`
    })
  }
  for (const folder of folders) {
    if (!normalizedQuery || folder.toLocaleLowerCase('en-US').includes(normalizedQuery)) notes.push({ relativePath: folder, title: folder.split('/').at(-1) ?? folder, tags: [], updatedAt: new Date(0).toISOString(), fingerprint: 'folder', isFolder: true })
  }
  return notes.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.relativePath.localeCompare(right.relativePath))
}

export async function readObsidianNote(profile: AdapterProfile, relativePath: string): Promise<ObsidianNote> {
  const { root, realRoot } = await requireSafeVaultRoot(profile)
  rejectObsidianSegment(relativePath, 'Obsidian 文件不能位于 .obsidian 内部目录')
  const filePath = resolve(root, relativePath)
  if (!insideRoot(root, filePath) || extname(filePath).toLowerCase() !== '.md') {
    throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 文件必须位于 Vault 内且为 Markdown')
  }
  const realFilePath = await realpath(filePath)
  if (!insideRoot(realRoot, realFilePath)) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 文件位于 Vault 外部')
  const fileStat = await stat(filePath)
  if (fileStat.size > maximumMarkdownBytes) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 文件超过大小限制')
  const content = await readFile(filePath, 'utf8')
  return {
    relativePath: relative(root, filePath).replaceAll('\\', '/'),
    title: extractTitle(content, filePath.split(/[\\/]/u).at(-1)?.replace(/\.md$/i, '') ?? 'Untitled'),
    tags: extractManagedList(content, 'workbench_tags') ?? (() => {
      const tags = extractYamlList(content, 'tags')
      return tags.length > 0 ? tags : extractYamlList(content, 'labels')
    })(),
    updatedAt: fileStat.mtime.toISOString(),
    fingerprint: `${fileStat.mtimeMs}:${fileStat.size}`,
    content
  }
}

/** Remove one Markdown note after checking the caller's last-seen revision.
 * This is intentionally a separate explicit operation; it never touches
 * `.obsidian`, symlinks or non-Markdown files and reports a missing file as a
 * typed no-op. */
export async function deleteObsidianNote(
  profile: AdapterProfile,
  relativePath: string,
  expectedFingerprint: string | null
): Promise<{ vaultId?: string; relativePath: string; status: 'deleted' | 'not-found' }> {
  const { root, realRoot } = await requireSafeVaultRoot(profile)
  rejectObsidianSegment(relativePath, 'Obsidian note cannot be deleted from .obsidian')
  const filePath = resolve(root, relativePath)
  if (!insideRoot(root, filePath) || extname(filePath).toLowerCase() !== '.md') {
    throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian note must be a Markdown file inside the Vault')
  }
  let currentFingerprint: string | null = null
  try {
    const entry = await lstat(filePath)
    if (entry.isSymbolicLink()) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian note cannot be a symbolic link')
    const realFilePath = await realpath(filePath)
    if (!insideRoot(realRoot, realFilePath)) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian note resolves outside the Vault')
    const fileStat = await stat(filePath)
    currentFingerprint = `${fileStat.mtimeMs}:${fileStat.size}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { relativePath: relative(root, filePath).replaceAll('\\', '/'), status: 'not-found' }
    throw error
  }
  if (expectedFingerprint !== null && expectedFingerprint !== currentFingerprint) {
    throw new IntegrationRuntimeError('REVISION_CONFLICT', 'Obsidian note changed externally; deletion was cancelled')
  }
  await unlink(filePath)
  return { relativePath: relative(root, filePath).replaceAll('\\', '/'), status: 'deleted' }
}

/**
 * Remove an empty root-level Vault category.  A category is an external
 * directory, so recursive deletion is deliberately not exposed: callers
 * must remove or move its Markdown notes first and the operation refuses any
 * remaining file, attachment, hidden entry or link.  This keeps the command
 * useful for cleaning up user-created categories without risking unrelated
 * Vault content.
 */
export async function deleteObsidianFolder(
  profile: AdapterProfile,
  relativePath: string
): Promise<{ relativePath: string; status: 'deleted' | 'not-found' | 'not-empty'; remainingEntries: number }> {
  const { root, realRoot } = await requireSafeVaultRoot(profile)
  const normalized = relativePath.replaceAll('\\', '/').trim()
  if (!normalized || normalized.includes('/') || normalized === '.' || normalized === '..' || containsObsidianSegment(normalized)) {
    throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 分类必须是 Vault 根目录下的安全文件夹名')
  }
  const folderPath = resolve(root, normalized)
  if (!insideRoot(root, folderPath)) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 分类路径越过 Vault 根目录')
  let entry
  try {
    entry = await lstat(folderPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { relativePath: normalized, status: 'not-found', remainingEntries: 0 }
    throw error
  }
  if (entry.isSymbolicLink()) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 分类不能是符号链接或 junction')
  if (!entry.isDirectory()) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 分类目标不是文件夹')
  const realFolder = await realpath(folderPath)
  if (!insideRoot(realRoot, realFolder)) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 分类位于 Vault 外部')
  const entries = await readdir(folderPath, { withFileTypes: true })
  if (entries.length > 0) return { relativePath: normalized, status: 'not-empty', remainingEntries: entries.length }
  try {
    await rmdir(folderPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { relativePath: normalized, status: 'not-found', remainingEntries: 0 }
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return { relativePath: normalized, status: 'not-empty', remainingEntries: 1 }
    throw error
  }
  return { relativePath: normalized, status: 'deleted', remainingEntries: 0 }
}

/**
 * Normalize a Vault-relative path into validated POSIX segments.  Shared by
 * the folder/move primitives so both reject traversal, drive letters,
 * `.obsidian` and Windows-unsafe names before any filesystem call.
 */
function requireVaultRelativeSegments(relativePath: string, label: string): string[] {
  if (typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath) || relativePath.startsWith('/') || relativePath.startsWith('\\') || /^[A-Za-z]:/u.test(relativePath)) {
    throw new IntegrationRuntimeError('INVALID_MAPPING', `${label}必须是 Vault 内的相对路径`)
  }
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
  const segments = normalized.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new IntegrationRuntimeError('INVALID_MAPPING', `${label}不能包含空段或目录遍历`)
  }
  rejectObsidianSegment(normalized, `${label}不能进入 .obsidian`)
  for (const segment of segments) {
    if (/[<>:"|?*\u0000-\u001f]/u.test(segment) || /[. ]$/u.test(segment) || segment.length > 255) {
      throw new IntegrationRuntimeError('INVALID_MAPPING', `${label}包含 Windows 不支持的字符`)
    }
  }
  return segments
}

/**
 * Create a folder inside the Vault one segment at a time.  Every level is
 * validated before it is created, so the command cannot follow a link out of
 * the Vault, cannot write into `.obsidian`, and cannot replace a file.  An
 * already existing folder is reported as `exists` instead of failing, which
 * makes the operation idempotent for the UI.
 */
export async function createObsidianFolder(
  profile: AdapterProfile,
  relativePath: string
): Promise<{ relativePath: string; status: 'created' | 'exists' }> {
  const { root, realRoot } = await requireSafeVaultRoot(profile)
  const segments = requireVaultRelativeSegments(relativePath, 'Obsidian 目录路径')
  if (segments.some((segment) => segment.toLocaleLowerCase('en-US').endsWith('.md'))) {
    // `.md` is reserved for notes; a folder with that suffix would make the
    // path ambiguous for every later read/write and for the README convention.
    throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 目录名不能使用 .md 扩展名')
  }
  let current = root
  let created = false
  for (const segment of segments) {
    current = resolve(current, segment)
    if (!insideRoot(root, current)) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 目录路径越过 Vault 根目录')
    await validateExistingParentChain(root, realRoot, dirname(current))
    let entry
    try {
      entry = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // The parent chain was validated above, so a single-level mkdir cannot
      // follow a link that appeared outside the Vault.
      await mkdir(current)
      created = true
      continue
    }
    if (entry.isSymbolicLink()) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 目录不能是符号链接或 junction')
    const realEntry = await realpath(current)
    if (!insideRoot(realRoot, realEntry)) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 目录位于 Vault 外部')
    if (!entry.isDirectory()) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 目录目标已被同名文件占用')
  }
  return { relativePath: segments.join('/'), status: created ? 'created' : 'exists' }
}

export interface ObsidianMoveReceipt {
  readonly kind: 'file' | 'directory'
  readonly fromRelativePath: string
  readonly toRelativePath: string
  /** Fingerprint of the moved note after the rename; folders have none. */
  readonly fingerprint: string | null
}

/**
 * Rename or move one Markdown note or one root-level Vault folder.
 *
 * The command never overwrites an existing target: a collision fails with
 * `INVALID_MAPPING` so the caller has to preview the conflict.  Notes are
 * additionally guarded by the last-seen fingerprint (`REVISION_CONFLICT`), and
 * files, folders and every traversed parent are checked for links and Vault
 * containment before and after the rename.
 */
export async function moveObsidianEntry(
  profile: AdapterProfile,
  kind: ObsidianMoveReceipt['kind'],
  fromRelativePath: string,
  toRelativePath: string,
  expectedFingerprint: string | null
): Promise<ObsidianMoveReceipt> {
  const { root, realRoot } = await requireSafeVaultRoot(profile)
  const fromSegments = requireVaultRelativeSegments(fromRelativePath, 'Obsidian 源路径')
  const toSegments = requireVaultRelativeSegments(toRelativePath, 'Obsidian 目标路径')
  if (kind === 'directory' && (fromSegments.length !== 1 || toSegments.length !== 1)) {
    throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 分类移动只支持 Vault 根目录下的单层目录')
  }
  const fromPath = resolve(root, ...fromSegments)
  const toPath = resolve(root, ...toSegments)
  if (!insideRoot(root, fromPath) || !insideRoot(root, toPath)) {
    throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 移动路径越过 Vault 根目录')
  }
  if (kind === 'file') {
    if (extname(fromPath).toLowerCase() !== '.md' || extname(toPath).toLowerCase() !== '.md') {
      throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 笔记移动只支持 Markdown 文件')
    }
  } else if (expectedFingerprint !== null) {
    throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 目录移动不支持指纹校验')
  }
  const fromKey = fromSegments.join('/')
  const toKey = toSegments.join('/')
  let sourceEntry
  try {
    sourceEntry = await lstat(fromPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new IntegrationRuntimeError('NOT_FOUND', 'Obsidian 源路径已不存在，请重新加载知识库')
    }
    throw error
  }
  if (fromKey === toKey) return { kind, fromRelativePath: fromKey, toRelativePath: toKey, fingerprint: expectedFingerprint }
  if (sourceEntry.isSymbolicLink()) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 移动的源不能是符号链接或 junction')
  if (kind === 'directory' && !sourceEntry.isDirectory()) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 源路径不是文件夹')
  const realFrom = await realpath(fromPath)
  if (!insideRoot(realRoot, realFrom)) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 源路径位于 Vault 外部')
  await validateExistingParentChain(root, realRoot, dirname(toPath))
  // Moving must not invent new folders inside the user's Vault: the target
  // parent has to exist already and is validated as a real directory.
  let targetParentStat
  try {
    const targetParentEntry = await lstat(dirname(toPath))
    targetParentStat = targetParentEntry.isSymbolicLink() ? await stat(await realpath(dirname(toPath))) : targetParentEntry
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 目标文件夹不存在，请先创建目标分类目录')
    }
    throw error
  }
  if (!targetParentStat.isDirectory()) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 目标父路径不是文件夹')
  let currentFingerprint: string | null = null
  if (kind === 'file') {
    const fromStat = await stat(fromPath)
    currentFingerprint = `${fromStat.mtimeMs}:${fromStat.size}`
    if (expectedFingerprint !== null && expectedFingerprint !== currentFingerprint) {
      throw new IntegrationRuntimeError('REVISION_CONFLICT', 'Obsidian 笔记已在外部修改，移动已取消')
    }
  }
  try {
    const targetEntry = await lstat(toPath)
    if (targetEntry.isSymbolicLink()) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 移动目标不能是符号链接或 junction')
    throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 目标路径已存在，拒绝覆盖现有内容')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await rename(fromPath, toPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new IntegrationRuntimeError('NOT_FOUND', 'Obsidian 源路径在移动完成前消失，请重新加载知识库')
    if (code === 'ENOTEMPTY' || code === 'EEXIST') throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 目标路径已存在，拒绝覆盖现有内容')
    throw error
  }
  if (kind === 'directory') {
    const realTarget = await realpath(toPath)
    if (!insideRoot(realRoot, realTarget)) {
      // Fail closed: move the folder back rather than leave it outside the root.
      await rename(toPath, fromPath).catch(() => undefined)
      throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 分类移动后越过了 Vault 根目录')
    }
    return { kind, fromRelativePath: fromKey, toRelativePath: toKey, fingerprint: null }
  }
  const afterStat = await stat(toPath)
  return { kind, fromRelativePath: fromKey, toRelativePath: toKey, fingerprint: `${afterStat.mtimeMs}:${afterStat.size}` }
}

export async function writeObsidianNote(
  profile: AdapterProfile,
  relativePath: string,
  content: string,
  expectedFingerprint: string | null
): Promise<ObsidianNote> {
  const { root, realRoot } = await requireSafeVaultRoot(profile)
  rejectObsidianSegment(relativePath, 'Obsidian 文件不能位于 .obsidian 内部目录')
  const filePath = resolve(root, relativePath)
  if (!insideRoot(root, filePath) || extname(filePath).toLowerCase() !== '.md') {
    throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 文件必须位于 Vault 内且为 Markdown')
  }
  const parent = dirname(filePath)
  await validateExistingParentChain(root, realRoot, parent)
  let currentFingerprint: string | null = null
  try {
    const currentStat = await stat(filePath)
    currentFingerprint = `${currentStat.mtimeMs}:${currentStat.size}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (expectedFingerprint !== currentFingerprint) {
    throw new IntegrationRuntimeError('REVISION_CONFLICT', 'Obsidian 文件已在外部更新')
  }
  await mkdir(parent, { recursive: true })
  const realParent = await realpath(parent)
  if (!insideRoot(realRoot, realParent)) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 写入目录位于 Vault 外部')
  const temporaryPath = `${filePath}.workbench-note-${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' })
    const verifiedParent = await realpath(dirname(filePath))
    if (!insideRoot(realRoot, verifiedParent)) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 写入路径发生变化')
    await rename(temporaryPath, filePath)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
  return readObsidianNote(profile, relativePath)
}

export async function writeObsidianProjection(
  profile: AdapterProfile,
  target: ProjectionTarget,
  projection: ManagedProjection
): Promise<ProjectionReceipt> {
  const { root, realRoot } = await requireSafeVaultRoot(profile)
  const managedFolder = String(profile.settings['managedFolder'] ?? '').trim().replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
  const requested = target.locator || (managedFolder ? `${managedFolder}/${projection.workbenchId}.md` : `${projection.workbenchId}.md`)
  rejectObsidianSegment(requested, 'Obsidian 写入目标不能经过 .obsidian 内部目录')
  const filePath = resolve(root, requested)
  const pathFromRoot = relative(root, filePath)
  rejectObsidianSegment(pathFromRoot, 'Obsidian 写入目标不能经过 .obsidian 内部目录')
  if (!insideRoot(root, filePath) || extname(filePath).toLowerCase() !== '.md') {
    throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 写入目标必须位于 Vault 内且为 Markdown')
  }
  await validateExistingParentChain(root, realRoot, dirname(filePath))
  await mkdir(dirname(filePath), { recursive: true })
  const realParent = await realpath(dirname(filePath))
  rejectObsidianSegment(realParent, 'Obsidian 写入目录的真实路径不能经过 .obsidian')
  if (!insideRoot(realRoot, realParent)) {
    throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 写入目录通过链接指向了 Vault 外部')
  }
  let current = ''
  let currentRevision: string | null = null
  try {
    const targetStat = await lstat(filePath)
    if (targetStat.isSymbolicLink()) {
      throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 不写入符号链接文件')
    }
    const realFilePath = await realpath(filePath)
    if (!insideRoot(realRoot, realFilePath)) {
      throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 写入文件位于 Vault 外部')
    }
    const currentStat = await stat(filePath)
    currentRevision = `${currentStat.mtimeMs}:${currentStat.size}`
    current = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (target.remoteRevision !== currentRevision) {
    throw new IntegrationRuntimeError('REVISION_CONFLICT', 'Obsidian 文件已在外部更新')
  }
  const next = upsertManagedBlock(current, projection)
  const temporaryPath = `${filePath}.workbench-${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, next, { encoding: 'utf8', flag: 'wx' })
    const [realTemporaryPath, verifiedParent] = await Promise.all([
      realpath(temporaryPath),
      realpath(dirname(filePath))
    ])
    await validateExistingParentChain(root, realRoot, dirname(filePath))
    if (!insideRoot(realRoot, realTemporaryPath) || !insideRoot(realRoot, verifiedParent)) {
      throw new IntegrationRuntimeError('INVALID_MAPPING', 'Obsidian 写入路径在提交前发生了变化')
    }
    await rename(temporaryPath, filePath)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
  const fileStat = await stat(filePath)
  return {
    externalId: target.externalId || projection.workbenchId,
    locator: filePath,
    remoteRevision: `${fileStat.mtimeMs}:${fileStat.size}`
  }
}
