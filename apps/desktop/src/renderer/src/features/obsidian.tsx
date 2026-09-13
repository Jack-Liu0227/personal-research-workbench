import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, FileText, Folder, FolderOpen, FolderPlus, ListChecks, RefreshCw, RefreshCcwDot, Save, ShieldCheck, Plus, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Trash2, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import type { IntegrationProfile, Note, NoteDuplicateReport, NoteMetadataPatch, NoteMetadataPreview, Project } from '@prw/contracts'
import { ObsidianRelativePathSchema, ProjectIdSchema } from '@prw/contracts'
import { SelectionBar, SelectionCheckbox } from '../components/selection'
import { PaneResizeSeparator, usePaneResizeEnabled, usePaneWidth } from '../components/resizable-pane'
import { EmptyState, ErrorState, InlineLoadingState, PageHeader, PanelSkeleton } from '../components/states'
import { Button, Dialog, DialogClose, DialogContent, Disclosure, Input } from '../components/ui'
import { cn, formatDateTime, getErrorMessage } from '../lib/utils'
import { splitMarkdownSections, type MarkdownSectionLines } from '../lib/markdown-sections'
import { getWorkbenchApi } from '../lib/workbench'
import { queryKeys, useIntegrationsQuery, useNotesQuery } from './queries'

type TreeNode = {
  name: string
  path: string
  folders: Map<string, TreeNode>
  notes: Note[]
}

/** Obsidian workspace rails. One set of bounds for the drag, the keyboard step
 * and the published aria-valuemin/max, so they cannot drift apart. */
const OBSIDIAN_PANE_MIN_WIDTH = 184
const OBSIDIAN_PANE_MAX_WIDTH = 380
const OBSIDIAN_TREE_DEFAULT_WIDTH = 240
const OBSIDIAN_INSPECTOR_DEFAULT_WIDTH = 224

type KnowledgeCategoryId = string

type KnowledgeCategory = {
  id: KnowledgeCategoryId
  label: string
  description: string
  tokens: string[]
  createPath: string
  template: string
  /** Controlled `workbench_kind` for the fixed research categories. Custom
   * folders stay null so the renderer never invents a classification. */
  kind: import('@prw/contracts').ObsidianLayoutKind | null
}

/** Only the eleven fixed research kinds may be written to `workbench_kind`. */
const categoryKinds: Readonly<Record<string, import('@prw/contracts').ObsidianLayoutKind>> = {
  '每日文献推送': 'daily_literature',
  '每日资讯推送': 'daily_literature',
  '文献矩阵': 'literature_matrix',
  '文献综述': 'literature_review',
  '写作模板': 'writing_templates',
  '提示词库': 'prompt_library',
  '任务': 'tasks',
  '日历': 'calendar',
  '资源': 'resources',
  '知识库索引': 'knowledge_index',
  'AnythingLLM': 'anything_llm',
  'LLMWiki': 'llm_wiki'
}

/** Only the fields the service actually rewrites are rendered, so the
 * confirmation dialog never implies a change that will not happen. */
function metadataDiffRows(preview: NoteMetadataPreview): Array<{ label: string; before: string; after: string }> {
  const value = (input: string | null): string => input ?? '（未设置）'
  const list = (input: readonly string[]): string => input.length > 0 ? input.join('、') : '（空）'
  return [
    // Labels match the service's `changedFields` names so the diff rows and the
    // field list below them read as the same vocabulary.
    { label: '项目绑定', before: value(preview.before.projectId), after: value(preview.after.projectId) },
    { label: '文献分类', before: value(preview.before.kind), after: value(preview.after.kind) },
    { label: '标题', before: value(preview.before.title), after: value(preview.after.title) },
    { label: '日期', before: value(preview.before.date), after: value(preview.after.date) },
    { label: '父笔记', before: value(preview.before.parentRelativePath), after: value(preview.after.parentRelativePath) },
    { label: '关联文献', before: list(preview.before.paperIds), after: list(preview.after.paperIds) },
    { label: '关联任务', before: list(preview.before.taskIds), after: list(preview.after.taskIds) },
    { label: '标签', before: list(preview.before.labels), after: list(preview.after.labels) }
  ].filter((row) => row.before !== row.after)
}

/** The context menu is fixed-position and grows with the project list, so clamp
 * it into the viewport instead of letting rows fall outside the window. */
function contextMenuPosition(event: MouseEvent, estimatedHeight: number): { x: number; y: number } {
  const maxX = Math.max(8, window.innerWidth - 236)
  const maxY = Math.max(8, window.innerHeight - estimatedHeight)
  return { x: Math.max(8, Math.min(event.clientX, maxX)), y: Math.max(8, Math.min(event.clientY, maxY)) }
}

function noteMatchesCategory(note: Note, category: KnowledgeCategory): boolean {
  if (category.id === 'all') return true
  const haystack = `${note.relativePath} ${note.title} ${note.tags.join(' ')}`.toLocaleLowerCase('zh-CN')
  return category.tokens.some((token) => haystack.includes(token.toLocaleLowerCase('zh-CN')))
}

function categoryTemplate(folderName: string): string {
  if (folderName === '\u6587\u732e\u77e9\u9635') return '# 文献矩阵\n\n| 文献 | 方法 | 数据 | 结论 | 备注 |\n| --- | --- | --- | --- | --- |\n\n'
  if (folderName === '\u6587\u732e\u7efc\u8ff0') return '# 文献综述\n\n## 研究问题\n\n## 综述正文\n\n## 参考文献\n'
  if (folderName === '\u6bcf\u65e5\u6587\u732e\u63a8\u9001') return '# 每日文献推送\n\n## 论文推送\n\n## 新闻推送\n\n'
  if (folderName === '\u63d0\u793a\u8bcd\u5e93') return '# 提示词\n\n## 用途\n\n## Prompt\n\n## 变量\n\n'
  if (folderName === '\u5199\u4f5c\u6a21\u677f') return '# 写作模板\n\n## 适用场景\n\n## 模板正文\n\n'
  if (folderName === 'AnythingLLM') return '# AnythingLLM Workspace\n\n## Sources\n\n## Index notes\n\n'
  if (folderName === 'LLMWiki') return '# LLM Wiki Page\n\n## Relations\n\n## MCP index\n\n'
  return '# 新建笔记\n\n'
}

/** Knowledge tabs are derived from first-level folders in the connected Vault.
 * Missing folders are not fabricated by the renderer. */
function buildDynamicKnowledgeCategories(notes: readonly Note[] | undefined, extraFolders: readonly string[] = []): KnowledgeCategory[] {
  const folders = new Set<string>()
  for (const note of notes ?? []) {
    // Root-level Markdown files belong to the catch-all view. Top-level
    // knowledge tabs represent folders only, never individual note names.
    if (!note.isFolder && !note.relativePath.includes('/')) continue
    const first = note.relativePath.split('/')[0]
    if (first && first !== '.obsidian') folders.add(first)
  }
  for (const folder of extraFolders) if (folder && folder !== '.obsidian') folders.add(folder)
  return [
    { id: 'all', label: '全部', description: '浏览 Vault 中已索引的 Markdown。', tokens: [], createPath: '新建笔记.md', template: '# 新建笔记\n\n', kind: null },
    ...[...folders].sort((a, b) => a.localeCompare(b)).map((folderName) => ({
      id: `folder:${folderName}`,
      label: folderName,
      description: `来自 Vault 根目录的 ${folderName} 文件夹；项目通过 frontmatter 标签隔离。`,
      tokens: [folderName],
      createPath: `${folderName}/新建笔记.md`,
      template: categoryTemplate(folderName),
      kind: categoryKinds[folderName] ?? null
    }))
  ]
}

/**
 * Small, dependency-free Markdown preview. It intentionally renders only
 * inert elements and safe http(s)/mailto links; it never injects HTML from a
 * Vault file into the renderer DOM.
 */
function renderInlineMarkdown(value: string): ReactNode[] {
  const tokens = value.split(/(`[^`]*`|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\((?:https?:\/\/|mailto:)[^)]+\))/g)
  return tokens.map((token, index) => {
    if (token.startsWith('`') && token.endsWith('`')) return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]" key={`${index}-code`}>{token.slice(1, -1)}</code>
    if ((token.startsWith('**') && token.endsWith('**')) || (token.startsWith('__') && token.endsWith('__'))) return <strong key={`${index}-strong`}>{token.slice(2, -2)}</strong>
    const link = /^\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)]+)\)$/.exec(token)
    if (link) return <span aria-label={`外部链接：${link[2]}`} className="text-primary underline decoration-primary/50 underline-offset-2" key={`${index}-link`} title="预览中的外部链接不会自动打开">{link[1]}</span>
    return token
  })
}

/** Render one section's lines into inert preview blocks. `keyPrefix` keeps
 * React keys unique across sections without relying on document offsets. */
function renderMarkdownBlocks(lines: readonly string[], keyPrefix: string): ReactNode[] {
  const blocks: ReactNode[] = []
  let codeLines: string[] | null = null
  let codeKey = 0
  const renderCodeBlock = (code: readonly string[], key: string): React.JSX.Element => {
    const text = code.join('\n')
    return <div className="relative overflow-hidden rounded-md border border-border bg-muted" key={key}><button aria-label="复制代码" className="absolute right-2 top-2 inline-flex items-center gap-1 rounded border border-border bg-surface px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => { void navigator.clipboard?.writeText(text) }} type="button"><Copy aria-hidden="true" className="size-3" />复制</button><pre className="overflow-x-auto p-3 pr-20 text-xs leading-5"><code>{text}</code></pre></div>
  }
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith('```')) {
      if (codeLines === null) codeLines = []
      else {
        blocks.push(renderCodeBlock(codeLines, `${keyPrefix}-code-${codeKey++}`))
        codeLines = null
      }
      return
    }
    if (codeLines !== null) {
      codeLines.push(line)
      return
    }
    if (!line.trim()) {
      return
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      const level = heading[1]!.length
      const Heading = `h${level}` as keyof React.JSX.IntrinsicElements
      blocks.push(<Heading className={level === 1 ? 'text-xl font-bold' : level === 2 ? 'text-lg font-bold' : 'text-base font-semibold'} key={`${keyPrefix}-heading-${index}`}>{renderInlineMarkdown(heading[2]!)}</Heading>)
      return
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr className="border-border" key={`${keyPrefix}-hr-${index}`} />)
      return
    }
    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (unordered) {
      blocks.push(<p className="pl-5 leading-6 before:mr-2 before:content-['•']" key={`${keyPrefix}-li-${index}`}>{renderInlineMarkdown(unordered[1]!)}</p>)
      return
    }
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line)
    if (ordered) {
      const marker = /^\s*(\d+)[.)]/.exec(line)?.[1] ?? '1'
      blocks.push(<p className="pl-5 leading-6" key={`${keyPrefix}-oli-${index}`}><span aria-hidden="true" className="mr-2 text-muted-foreground">{marker}.</span>{renderInlineMarkdown(ordered[1]!)}</p>)
      return
    }
    if (line.startsWith('>')) {
      blocks.push(<blockquote className="border-l-2 border-primary/50 pl-3 italic text-muted-foreground" key={`${keyPrefix}-quote-${index}`}>{renderInlineMarkdown(line.replace(/^>\s?/, ''))}</blockquote>)
      return
    }
    blocks.push(<p className="whitespace-pre-wrap leading-6" key={`${keyPrefix}-paragraph-${index}`}>{renderInlineMarkdown(line)}</p>)
  })
  const remainingCode = codeLines as string[] | null
  if (remainingCode && remainingCode.length > 0) blocks.push(renderCodeBlock(remainingCode, `${keyPrefix}-code-${codeKey}`))
  return blocks
}

type RenderedMarkdownSection = MarkdownSectionLines & { blocks: ReactNode[] }

function MarkdownPreview({ source }: { source: string }): React.JSX.Element {
  const [collapsedSections, setCollapsedSections] = useState<readonly string[]>([])
  const sections = useMemo<RenderedMarkdownSection[]>(() => splitMarkdownSections(source).map((section) => ({ ...section, blocks: renderMarkdownBlocks(section.lines, section.key) })), [source])
  const foldableSections = sections.filter((section) => section.title !== null)
  const foldable = foldableSections.length >= 2
  const allFolded = foldable && foldableSections.every((section) => collapsedSections.includes(section.key))
  const toggleSection = (key: string) => setCollapsedSections((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key])
  const hasContent = sections.some((section) => section.title !== null || section.blocks.length > 0)
  return (
    <div aria-label="Markdown 实时预览" className="grid content-start gap-3 overflow-auto p-4 text-sm text-foreground">
      {foldable ? <div className="sticky top-0 z-10 -mx-4 -mt-4 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-4 py-2">
        <p className="text-xs text-muted-foreground">共 {foldableSections.length} 个小节，可逐节折叠；折叠只影响预览，不会修改文件。</p>
        <Button aria-expanded={!allFolded} onClick={() => setCollapsedSections(allFolded ? [] : foldableSections.map((section) => section.key))} size="sm" variant="ghost">{allFolded ? '展开全部小节' : '折叠全部小节'}</Button>
      </div> : null}
      {hasContent ? sections.map((section) => {
        if (section.title === null) return section.blocks.length > 0 ? <div className="grid gap-3" key={section.key}>{section.blocks}</div> : null
        if (!foldable) return <section className="grid gap-3" key={section.key}><h2 className="break-words text-lg font-bold">{renderInlineMarkdown(section.title)}</h2>{section.blocks.length > 0 ? <div className="grid gap-3">{section.blocks}</div> : null}</section>
        const collapsed = collapsedSections.includes(section.key)
        const panelId = `${section.key}-panel`
        return <section className="grid gap-2" key={section.key}>
          <h2 className="text-lg font-bold">
            <button aria-controls={panelId} aria-expanded={!collapsed} className="flex w-full items-center gap-1.5 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => toggleSection(section.key)} type="button">
              <ChevronRight aria-hidden="true" className={cn('size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', !collapsed && 'rotate-90')} />
              <span className="min-w-0 break-words">{renderInlineMarkdown(section.title)}</span>
            </button>
          </h2>
          <div className="grid gap-3 pl-5" hidden={collapsed} id={panelId}>
            {section.blocks.length > 0 ? section.blocks : <p className="text-xs text-muted-foreground">本节暂无内容。</p>}
          </div>
        </section>
      }) : <p className="text-sm text-muted-foreground">暂无内容，开始编辑后将在这里实时预览。</p>}
    </div>
  )
}

function createTree(notes: Note[], extraFolders: readonly string[] = []): TreeNode {
  const root: TreeNode = { name: 'Vault', path: '', folders: new Map(), notes: [] }
  for (const folder of extraFolders) {
    let current = root
    for (const segment of folder.split('/').filter(Boolean)) {
      const path = current.path ? `${current.path}/${segment}` : segment
      const child = current.folders.get(segment) ?? { name: segment, path, folders: new Map(), notes: [] }
      current.folders.set(segment, child)
      current = child
    }
  }
  for (const note of notes) {
    if (note.isFolder) {
      let current = root
      for (const segment of note.relativePath.split('/').filter(Boolean)) {
        const path = current.path ? `${current.path}/${segment}` : segment
        const child = current.folders.get(segment) ?? { name: segment, path, folders: new Map(), notes: [] }
        current.folders.set(segment, child)
        current = child
      }
      continue
    }
    let current = root
    const segments = note.relativePath.split('/')
    for (const segment of segments.slice(0, -1)) {
      const path = current.path ? `${current.path}/${segment}` : segment
      const child = current.folders.get(segment) ?? { name: segment, path, folders: new Map(), notes: [] }
      current.folders.set(segment, child)
      current = child
    }
    current.notes.push(note)
  }
  return root
}

function TreeBranch({ node, selectedPath, selectedPaths = [], onSelect, onToggle, onContextMenu, onFolderContextMenu, showSelection = false, root = false }: {
  node: TreeNode
  selectedPath: string | null
  onSelect: (path: string) => void
  selectedPaths?: readonly string[]
  onToggle: ((path: string) => void) | undefined
  onContextMenu: ((path: string, event: MouseEvent) => void) | undefined
  onFolderContextMenu?: ((path: string, event: MouseEvent) => void) | undefined
  showSelection?: boolean
  root?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(root)
  const folders = [...node.folders.values()].sort((left, right) => left.name.localeCompare(right.name))
  const notes = [...node.notes].sort((left, right) => left.title.localeCompare(right.title))
  // An empty folder is a real, visible Vault state and must not be hidden just
  // because there is nothing to list inside it.
  return (
    <div className={root ? '' : 'ml-3 border-l border-border pl-2'}>
      {!root ? (
        <button aria-expanded={open} className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setOpen((value) => !value)} onContextMenu={(event) => { if (!onFolderContextMenu) return; event.preventDefault(); onFolderContextMenu(node.path, event) }} title={node.name} type="button">
          {open ? <FolderOpen aria-hidden="true" className="size-3.5 shrink-0 text-primary" /> : <Folder aria-hidden="true" className="size-3.5 shrink-0 text-primary" />}
          <span className="min-w-0 break-words text-left">{node.name}</span>
          {folders.length === 0 && notes.length === 0 ? <span className="vault-empty-folder ml-1 shrink-0 text-[11px] font-normal text-muted-foreground">空文件夹</span> : null}
        </button>
      ) : null}
      {open ? (
        <div className="space-y-0.5">
          {folders.map((folder) => <TreeBranch key={folder.path} node={folder} onFolderContextMenu={onFolderContextMenu} onSelect={onSelect} onContextMenu={onContextMenu} onToggle={onToggle} selectedPaths={selectedPaths} selectedPath={selectedPath} showSelection={showSelection} />)}
          {notes.map((note) => (
            <div className={`group flex items-start gap-1 rounded px-1 py-1 ${note.relativePath === selectedPath ? 'bg-primary/10' : 'hover:bg-muted'}`} key={note.relativePath} onContextMenu={(event) => onContextMenu?.(note.relativePath, event)}>
              {showSelection ? <input aria-label={`选择 ${note.title}`} checked={selectedPaths.includes(note.relativePath)} className="vault-note-checkbox vault-note-checkbox-active research-checkbox mt-2" onChange={() => onToggle?.(note.relativePath)} type="checkbox" /> : null}
              <button aria-current={note.relativePath === selectedPath ? 'true' : undefined} className={`flex min-w-0 flex-1 items-start gap-2 rounded px-1 py-1 text-left ${note.relativePath === selectedPath ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`} onClick={() => onSelect(note.relativePath)} type="button">
                <FileText aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary" />
                <span className="min-w-0 flex-1"><span className="block break-words text-xs font-semibold leading-5">{note.title}</span><span className="mt-0.5 block break-all text-[11px] leading-4 text-muted-foreground" title={note.relativePath}>{note.relativePath}</span></span>
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function isConflictError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  return code === 'EXTERNAL_CONFLICT' || code === 'INTEGRATION_REVISION_CONFLICT' || error.message.includes('外部更新')
}

function relativePathError(value: string): string | null {
  const trimmed = value.trim()
  const segments = trimmed.split('/')
  if (trimmed.includes('\\') || segments.some((segment) => segment.toLocaleLowerCase() === '.git')) return '请输入 Vault 内的 Markdown 相对路径（仅使用 /，不能访问 .git）。'
  const result = ObsidianRelativePathSchema.safeParse(trimmed)
  return result.success ? null : '请输入 Vault 内的 Markdown 相对路径（使用 /，不能包含 .obsidian、.git 或 ..）。'
}

function connectionLabel(profile: IntegrationProfile | null): { title: string; detail: string; tone: string } {
  if (!profile) return { title: '未配置', detail: '请在设置中保存一个 Vault 配置。', tone: 'text-muted-foreground' }
  if (!profile.enabled) return { title: '已配置但未启用', detail: '该 Vault 配置已停用，未执行文件扫描。', tone: 'text-muted-foreground' }
  if (profile.status === 'ready') return { title: '已连接', detail: '最近一次后端探测成功。', tone: 'text-success' }
  if (profile.status === 'syncing') return { title: '正在同步', detail: '后端正在处理连接任务。', tone: 'text-primary' }
  if (profile.status === 'error') return { title: '不可用', detail: '后端探测失败；请检查 Vault 授权和目录。', tone: 'text-danger' }
  return { title: '已配置，尚未验证', detail: '配置存在，但不能把配置本身当作已连接。', tone: 'text-accent' }
}

function indexLabel(profile: IntegrationProfile | null, loading: boolean, error: unknown, notes: Note[] | undefined): { title: string; detail: string; tone: string } {
  if (!profile) return { title: '未配置', detail: '没有可扫描的 Vault。', tone: 'text-muted-foreground' }
  if (!profile.enabled) return { title: '已停用', detail: '启用 Vault 后才能扫描 Markdown。', tone: 'text-muted-foreground' }
  if (loading) return { title: '扫描中', detail: '仅扫描授权 Vault 内的 Markdown；不会读取 .obsidian 或 .git。', tone: 'text-primary' }
  if (error) return { title: '不可用', detail: '索引扫描失败，之前的列表不会被静默覆盖。', tone: 'text-danger' }
  if (!notes) return { title: '尚未扫描', detail: '点击“重新索引”开始一次真实扫描。', tone: 'text-muted-foreground' }
  return { title: '已就绪', detail: `已读取 ${notes.length} 个 Markdown 文件（实时扫描结果）。`, tone: 'text-success' }
}

export function ObsidianPage({ projects }: { projects: Project[] }): React.JSX.Element {
  const queryClient = useQueryClient()
  const profiles = useIntegrationsQuery()
  const obsidianProfiles = profiles.data?.filter((item) => item.provider === 'obsidian') ?? []
  const profile = obsidianProfiles.find((item) => item.enabled) ?? obsidianProfiles[0] ?? null
  const activeProfile = profile?.enabled ? profile : null
  const [query, setQuery] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [createMode, setCreateMode] = useState(false)
  const [editorMode, setEditorMode] = useState<'preview' | 'edit'>('preview')
  // New notes are created at the Vault root by default.  Category-specific
  // templates replace this path when a category is selected; no synthetic
  // `_Workbench` or project directory is introduced.
  const [newPath, setNewPath] = useState('新建笔记.md')
  const [newPathError, setNewPathError] = useState<string | null>(null)
  const [conflictReloaded, setConflictReloaded] = useState(false)
  const [activeCategory, setActiveCategory] = useState<KnowledgeCategoryId>('all')
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  // Batch mode is the entry point for file-level multi-select. It was wired to
  // a state flag that no control ever toggled and that `TreeBranch` never
  // received, so the tree could not produce a selection at all.
  const [selectionMode, setSelectionMode] = useState(false)
  const [treeFeedback, setTreeFeedback] = useState<string | null>(null)
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  // Both side rails are user-resizable. Widths are clamped to [184, 380] and
  // persisted with the repository's optional-storage convention; the split is
  // only active from 901px up, where the workspace really has three columns.
  const treePane = usePaneWidth({ storageKey: 'obsidian-tree-width', defaultWidth: OBSIDIAN_TREE_DEFAULT_WIDTH, min: OBSIDIAN_PANE_MIN_WIDTH, max: OBSIDIAN_PANE_MAX_WIDTH })
  const inspectorPane = usePaneWidth({ storageKey: 'obsidian-inspector-width', defaultWidth: OBSIDIAN_INSPECTOR_DEFAULT_WIDTH, min: OBSIDIAN_PANE_MIN_WIDTH, max: OBSIDIAN_PANE_MAX_WIDTH })
  const workspaceSplitEnabled = usePaneResizeEnabled('(min-width: 901px)')
  // The three-column template is composed here (instead of only in CSS) because
  // the two rails are user widths now. Every track keeps `minmax(0, …)`, so a
  // wide stored value can never overflow the workspace.
  const workspaceStyle = workspaceSplitEnabled
    ? {
        gridTemplateColumns: leftCollapsed && rightCollapsed
          ? 'minmax(0, 1fr)'
          : leftCollapsed
            ? `minmax(0, 1fr) minmax(0, ${inspectorPane.width}px)`
            : rightCollapsed
              ? `minmax(0, ${treePane.width}px) minmax(0, 1fr)`
              : `minmax(0, ${treePane.width}px) minmax(0, 1fr) minmax(0, ${inspectorPane.width}px)`
      }
    : undefined
  // The file-tree splitter lives inside the non-scrolling tree panel at its
  // right edge; the resized pane is the panel left of the handle. A stacked
  // (single column) workspace keeps the handle in the DOM as disabled.
  const treeSeparator = !leftCollapsed
    ? <PaneResizeSeparator defaultValue={OBSIDIAN_TREE_DEFAULT_WIDTH} disabled={!workspaceSplitEnabled} label="调整文件树宽度（左右方向键调整，Home 最小，End 最大，双击恢复默认）" max={OBSIDIAN_PANE_MAX_WIDTH} min={OBSIDIAN_PANE_MIN_WIDTH} onReset={treePane.resetWidth} onResize={treePane.setWidth} style={{ right: 0 }} value={treePane.width} />
    : null
  // The 属性 panel scrolls, so its splitter is mounted in the editor panel's
  // non-scrolling right edge instead of inside the pane it resizes.
  const inspectorSeparator = !rightCollapsed
    ? <PaneResizeSeparator defaultValue={OBSIDIAN_INSPECTOR_DEFAULT_WIDTH} disabled={!workspaceSplitEnabled} invert label="调整属性面板宽度（左右方向键调整，Home 最小，End 最大，双击恢复默认）" max={OBSIDIAN_PANE_MAX_WIDTH} min={OBSIDIAN_PANE_MIN_WIDTH} onReset={inspectorPane.resetWidth} onResize={inspectorPane.setWidth} style={{ right: 0 }} value={inspectorPane.width} />
    : null
  const [noteMenu, setNoteMenu] = useState<{ path: string; kind: 'file' | 'directory'; x: number; y: number } | null>(null)
  // Controlled frontmatter editing is preview-first: the dialog renders the
  // service-computed diff (changed fields, preserved unknown fields) and the
  // write only happens on explicit confirmation with the previewed fingerprint.
  const [metadataPreview, setMetadataPreview] = useState<{ preview: NoteMetadataPreview; patch: NoteMetadataPatch } | null>(null)
  const [metadataFeedback, setMetadataFeedback] = useState<string | null>(null)
  const [moveForm, setMoveForm] = useState<{ kind: 'file' | 'directory'; from: string; to: string } | null>(null)
  const [moveError, setMoveError] = useState<string | null>(null)
  const [folderForm, setFolderForm] = useState<{ path: string } | null>(null)
  // A duplicate write has to be previewed before it happens; the report keeps
  // the existing fingerprint so an intentional update can still be CAS-guarded.
  const [duplicateReport, setDuplicateReport] = useState<NoteDuplicateReport | null>(null)
  const [childNoteParent, setChildNoteParent] = useState<string | null>(null)
  const [dismissedExternal, setDismissedExternal] = useState<string | null>(null)
  const [vaultPlan, setVaultPlan] = useState<import('@prw/contracts').ObsidianVaultLayoutPlan | null>(null)
  const [vaultMessage, setVaultMessage] = useState<string | null>(null)
  const saveGeneration = useRef(0)
  const [deferredQuery, setDeferredQuery] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => setDeferredQuery(query), 250)
    return () => window.clearTimeout(timer)
  }, [query])
  const notes = useNotesQuery(activeProfile?.id ?? null, deferredQuery, activeProfile?.revision)
  const existingVaultFolders = useMemo(() => vaultPlan?.categories.filter((item) => vaultPlan.existingPaths.some((path) => path.toLocaleLowerCase('en-US') === item.relativePath.toLocaleLowerCase('en-US'))).map((item) => item.name) ?? [], [vaultPlan])
  const vaultMissingCount = useMemo(() => vaultPlan ? vaultPlan.categories.filter((item) => !vaultPlan.existingPaths.some((path) => path.toLocaleLowerCase('en-US') === item.relativePath.toLocaleLowerCase('en-US'))).length : 0, [vaultPlan])
  const knowledgeCategories = useMemo(() => buildDynamicKnowledgeCategories(notes.data, existingVaultFolders), [existingVaultFolders, notes.data])
  const category = knowledgeCategories.find((item) => item.id === activeCategory) ?? knowledgeCategories[0]!
  const visibleNotes = useMemo(() => notes.data?.filter((note) => noteMatchesCategory(note, category)), [category, notes.data])
  // Selection is file-scoped on purpose: folders are only rendered as tree
  // branches (no checkbox) and are deleted through the separate empty-folder
  // category contract. Selecting folder paths here would let the file list act
  // on rows the user cannot see.
  const visibleFilePaths = useMemo(() => (visibleNotes ?? []).filter((note) => !note.isFolder).map((note) => note.relativePath), [visibleNotes])
  // The notes index polls every 15s: that poll is the Vault watcher. An external
  // edit shows up as a list fingerprint that no longer matches the loaded one,
  // and the editor never silently replaces the buffer with the external body.
  const listedFingerprint = useMemo(() => notes.data?.find((note) => !note.isFolder && note.relativePath === selectedPath)?.fingerprint ?? null, [notes.data, selectedPath])
  const listedUpdatedAt = useMemo(() => notes.data?.find((note) => !note.isFolder && note.relativePath === selectedPath)?.updatedAt ?? null, [notes.data, selectedPath])
  const visibleFileCount = visibleFilePaths.length
  const allVisibleSelected = visibleFilePaths.length > 0 && visibleFilePaths.every((path) => selectedPaths.includes(path))
  const someVisibleSelected = selectedPaths.some((path) => visibleFilePaths.includes(path))
  const selected = useQuery({
    queryKey: ['note', activeProfile?.id ?? 'none', activeProfile?.revision ?? 0, selectedPath ?? 'none'],
    queryFn: () => getWorkbenchApi().notes.read({ vaultId: activeProfile!.id, relativePath: selectedPath! }),
    enabled: Boolean(activeProfile && selectedPath)
  })

  useEffect(() => {
    if (!selected.data) return
    setContent(selected.data.content ?? '')
    setFingerprint(selected.data.fingerprint)
    setDirty(false)
    // A fresh read invalidates any earlier "ignored" external-change notice.
    setDismissedExternal(null)
  }, [selected.data])

  const externalChange = Boolean(
    selected.data &&
    listedFingerprint &&
    fingerprint &&
    listedFingerprint !== fingerprint &&
    dismissedExternal !== `${selectedPath ?? ''}:${listedFingerprint}`
  )

  useEffect(() => {
    const firstFile = visibleNotes?.find((note) => !note.isFolder)
    if (!selectedPath && firstFile) setSelectedPath(firstFile.relativePath)
    if (!dirty && selectedPath && visibleNotes && !visibleNotes.some((note) => !note.isFolder && note.relativePath === selectedPath)) setSelectedPath(firstFile?.relativePath ?? null)
  }, [dirty, selectedPath, visibleNotes])

  // Keep bulk selection scoped to the current search/category result. This
  // prevents a hidden note from being deleted after the user changes filters.
  useEffect(() => {
    setSelectedPaths((current) => {
      const allowed = new Set(visibleFilePaths)
      const next = current.filter((path) => allowed.has(path))
      return next.length === current.length ? current : next
    })
  }, [visibleFilePaths])

  useEffect(() => {
    setSelectedPath(null)
    setContent('')
    setFingerprint(null)
    setDirty(false)
    setCreateMode(false)
    setConflictReloaded(false)
    setActiveCategory('all')
    setSelectedPaths([])
    setSelectionMode(false)
    setTreeFeedback(null)
    setSelectedCategories([])
    setNoteMenu(null)
    setVaultPlan(null)
    setVaultMessage(null)
    setMetadataPreview(null)
    setMetadataFeedback(null)
    setMoveForm(null)
    setMoveError(null)
    setFolderForm(null)
    setDuplicateReport(null)
    setChildNoteParent(null)
    setDismissedExternal(null)
  }, [activeProfile?.id])

  const probe = useMutation({
    mutationFn: () => getWorkbenchApi().integrations.test(profile!.id),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.integrations }) }
  })
  const vaultPreview = useQuery({
    queryKey: ['obsidian-vault-layout-preview', activeProfile?.id ?? 'none', activeProfile?.revision ?? 0],
    queryFn: () => getWorkbenchApi().obsidian.vaultLayout.preview({ profileId: activeProfile!.id }),
    enabled: Boolean(activeProfile),
    staleTime: 60_000,
    retry: false
  })
  useEffect(() => {
    if (vaultPreview.data) { setVaultPlan(vaultPreview.data); setVaultMessage(null) }
  }, [vaultPreview.data])
  useEffect(() => {
    if (vaultPreview.error) setVaultMessage(getErrorMessage(vaultPreview.error))
  }, [vaultPreview.error])
  const vaultInitialize = useMutation({
    mutationFn: () => vaultPlan
      ? getWorkbenchApi().obsidian.vaultLayout.initialize({ profileId: activeProfile!.id, planId: vaultPlan.planId, expectedRevision: activeProfile!.revision, confirmed: true })
      : Promise.reject(new Error('请先预览 Vault 初始化布局。')),
    onSuccess: async (receipt) => {
      setVaultMessage(`${receipt.message} 已创建 ${receipt.createdPaths.length} 项。`)
      setVaultPlan(null)
      await notes.refetch()
    },
    onError: (error) => setVaultMessage(getErrorMessage(error))
  })
  const refresh = useMutation({
    mutationFn: async () => {
      const result = await notes.refetch()
      const health = await getWorkbenchApi().integrations.test(activeProfile!.id)
      return { result, health }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.integrations })
      await queryClient.invalidateQueries({ queryKey: queryKeys.noteIndex(activeProfile!.id, deferredQuery) })
    }
  })
  const create = useMutation({
    mutationFn: async (variables: { expectedFingerprint: string | null }) => {
      const note = await getWorkbenchApi().notes.write({ vaultId: activeProfile!.id, relativePath: newPath.trim(), content: category.template, expectedFingerprint: variables.expectedFingerprint })
      // A child note records its parent through controlled frontmatter instead
      // of a copied body, so the relation stays traceable and removable.
      if (childNoteParent) {
        return getWorkbenchApi().notes.applyMetadata({
          vaultId: activeProfile!.id,
          relativePath: note.relativePath,
          patch: { parentRelativePath: childNoteParent, kind: category.kind ?? undefined },
          expectedFingerprint: note.fingerprint,
          confirmed: true
        })
      }
      return note
    },
    onSuccess: async (note) => {
      setCreateMode(false)
      setNewPathError(null)
      setDuplicateReport(null)
      setChildNoteParent(null)
      setSelectedPath(note.relativePath)
      await notes.refetch()
    }
  })
  const save = useMutation({
    mutationFn: (variables: { path: string; content: string; fingerprint: string | null; generation: number }) => getWorkbenchApi().notes.write({ vaultId: activeProfile!.id, relativePath: variables.path, content: variables.content, expectedFingerprint: variables.fingerprint }),
    onSuccess: async (note, variables) => {
      setFingerprint(note.fingerprint)
      if (variables.generation === saveGeneration.current) setDirty(false)
      setConflictReloaded(false)
      await queryClient.invalidateQueries({ queryKey: queryKeys.noteIndex(activeProfile!.id, deferredQuery) })
      await selected.refetch()
    }
  })

  const deleteNotes = useMutation({
    mutationFn: async (paths: readonly string[]) => {
      const indexed = new Map((notes.data ?? []).map((note) => [note.relativePath, note]))
      const receipts = []
      for (const path of paths) {
        const note = indexed.get(path)
        receipts.push(await getWorkbenchApi().notes.delete({ vaultId: activeProfile!.id, relativePath: path, expectedFingerprint: note?.fingerprint ?? null }))
      }
      return receipts
    },
    onSuccess: async (receipts, paths) => {
      const deleted = receipts.filter((receipt) => receipt.status === 'deleted').length
      const missing = receipts.length - deleted
      setTreeFeedback(missing > 0
        ? `批量删除完成：已删除 ${deleted} 个，${missing} 个文件在删除前已不存在。`
        : `已删除 ${deleted} 个 Markdown 文件。`)
      setSelectedPaths([])
      setNoteMenu(null)
      if (selectedPath && paths.includes(selectedPath)) {
        setSelectedPath(null)
        setContent('')
        setFingerprint(null)
      }
      await notes.refetch()
    },
    onError: (error) => setTreeFeedback(`批量删除中断：${getErrorMessage(error)}；已删除的文件不会回滚，请重新索引后确认剩余文件。`)
  })

  const folderCategories = knowledgeCategories.filter((item) => item.id !== 'all')
  const allCategoriesSelected = folderCategories.length > 0 && folderCategories.every((item) => selectedCategories.includes(item.label))
  const someCategoriesSelected = selectedCategories.some((label) => folderCategories.some((item) => item.label === label))
  const deleteFolders = useMutation({
    mutationFn: async (folders: readonly string[]) => {
      const receipts = []
      for (const folder of folders) receipts.push(await getWorkbenchApi().notes.deleteFolder({ vaultId: activeProfile!.id, relativePath: folder }))
      return receipts
    },
    onSuccess: async (receipts) => {
      const blocked = receipts.filter((receipt) => receipt.status === 'not-empty')
      setSelectedCategories([])
      if (activeCategory !== 'all' && receipts.some((receipt) => receipt.relativePath === category.label && receipt.status === 'deleted')) setActiveCategory('all')
      setVaultMessage(blocked.length > 0
        ? `${blocked.map((receipt) => `${receipt.relativePath}（仍有 ${receipt.remainingEntries} 个条目）`).join('、')}：请先删除或移动其中的文件。`
        : receipts.length > 0 ? `已删除 ${receipts.filter((receipt) => receipt.status === 'deleted').length} 个空分类。` : null)
      await Promise.all([notes.refetch(), vaultPreview.refetch()])
    }
  })

  /** Ask the service for the exact frontmatter diff before writing anything. */
  const previewMetadata = useMutation({
    mutationFn: (variables: { path: string; patch: NoteMetadataPatch }) => getWorkbenchApi().notes.previewMetadata({
      vaultId: activeProfile!.id,
      relativePath: variables.path,
      patch: variables.patch
    }),
    onSuccess: (preview, variables) => {
      setMetadataFeedback(null)
      setMetadataPreview({ preview, patch: variables.patch })
    },
    onError: (error) => setMetadataFeedback(`元数据预览失败：${getErrorMessage(error)}`)
  })
  /** The confirmed write reuses the previewed fingerprint, so an external edit
   * between preview and apply fails the CAS instead of being overwritten. */
  const applyMetadata = useMutation({
    mutationFn: (variables: { preview: NoteMetadataPreview; patch: NoteMetadataPatch }) => getWorkbenchApi().notes.applyMetadata({
      vaultId: activeProfile!.id,
      relativePath: variables.preview.relativePath,
      patch: variables.patch,
      expectedFingerprint: variables.preview.fingerprint,
      confirmed: true
    }),
    onSuccess: async (note) => {
      setMetadataPreview(null)
      setNoteMenu(null)
      setMetadataFeedback(`已更新 ${note.relativePath} 的受控 frontmatter；未知字段与正文保持不变。`)
      if (note.relativePath === selectedPath) {
        setContent(note.content ?? '')
        setFingerprint(note.fingerprint)
        setDirty(false)
      }
      await Promise.all([notes.refetch(), selected.refetch()])
    },
    onError: (error) => setMetadataFeedback(isConflictError(error)
      ? `文件已在外部修改，受控 frontmatter 未写入：${getErrorMessage(error)}`
      : `元数据写入失败：${getErrorMessage(error)}`)
  })
  /** Every controlled frontmatter change goes through the preview first: the
   * dialog shows the service-computed diff and nothing is written before an
   * explicit confirmation with the previewed fingerprint. */
  const requestMetadataPatch = (path: string, patch: NoteMetadataPatch) => {
    // The preview reads the file on disk; a pending draft would be replaced by
    // the applied version, so metadata edits wait for an explicit save.
    if (dirty && path === selectedPath) {
      setNoteMenu(null)
      setMetadataFeedback('当前笔记有未保存草稿，请先保存或放弃草稿后再修改 frontmatter。')
      return
    }
    previewMetadata.mutate({ path, patch })
  }
  const requestProjectBinding = (path: string, projectId: string | null) => {
    // `ProjectIdSchema.parse` brands the renderer's plain option value, so the
    // wire patch stays typed instead of being cast.
    requestMetadataPatch(path, { projectId: projectId === null ? null : ProjectIdSchema.parse(projectId) })
  }
  /** A child note is created as a normal note and then linked through the
   * controlled `workbench_parent` field, so the relation stays removable. */
  const beginChildNote = (parentRelativePath: string) => {
    const slash = parentRelativePath.lastIndexOf('/')
    const directory = slash === -1 ? '' : `${parentRelativePath.slice(0, slash)}/`
    const leaf = parentRelativePath.split('/').at(-1) ?? 'parent'
    const baseName = leaf.toLowerCase().endsWith('.md') ? leaf.slice(0, -3) : leaf
    setChildNoteParent(parentRelativePath)
    setNewPath(`${directory}${baseName} 子笔记.md`)
    setNewPathError(null)
    setDuplicateReport(null)
    setCreateMode(true)
    setNoteMenu(null)
  }
  const beginCreateNote = () => {
    setChildNoteParent(null)
    beginCreate()
  }
  /** Renaming must not race a pending draft: the CAS fingerprint would be stale. */
  const beginMove = (kind: 'file' | 'directory', from: string) => {
    if (kind === 'file' && from === selectedPath && dirty) {
      setNoteMenu(null)
      setTreeFeedback('当前笔记有未保存草稿，请先保存或放弃草稿后再重命名或移动。')
      return
    }
    setMoveError(null)
    setMoveForm({ kind, from, to: from })
    setNoteMenu(null)
  }
  const noteFingerprint = (path: string): string | null => path === selectedPath
    ? fingerprint
    : notes.data?.find((note) => !note.isFolder && note.relativePath === path)?.fingerprint ?? null

  const moveEntry = useMutation({
    mutationFn: (variables: { kind: 'file' | 'directory'; from: string; to: string }) => getWorkbenchApi().notes.move({
      vaultId: activeProfile!.id,
      kind: variables.kind,
      fromRelativePath: variables.from,
      toRelativePath: variables.to.trim(),
      expectedFingerprint: variables.kind === 'file' ? noteFingerprint(variables.from) : null
    }),
    onSuccess: async (receipt) => {
      setMoveForm(null)
      setMoveError(null)
      setNoteMenu(null)
      setTreeFeedback(`已移动 ${receipt.fromRelativePath} → ${receipt.toRelativePath}；目标已存在时会被拒绝，不会覆盖。`)
      if (receipt.kind === 'file' && selectedPath === receipt.fromRelativePath) setSelectedPath(receipt.toRelativePath)
      await Promise.all([notes.refetch(), vaultPreview.refetch()])
    },
    onError: (error) => setMoveError(getErrorMessage(error))
  })

  const createFolder = useMutation({
    mutationFn: (variables: { path: string }) => getWorkbenchApi().notes.createFolder({
      vaultId: activeProfile!.id,
      relativePath: variables.path.trim()
    }),
    onSuccess: async (receipt) => {
      setFolderForm(null)
      setTreeFeedback(receipt.status === 'created'
        ? `已创建文件夹 ${receipt.relativePath}。`
        : `文件夹 ${receipt.relativePath} 已存在，未做修改。`)
      await Promise.all([notes.refetch(), vaultPreview.refetch()])
    },
    onError: (error) => setTreeFeedback(`创建文件夹失败：${getErrorMessage(error)}`)
  })

  /** Duplicate probe runs before the first write; an existing path is never
   * overwritten without an explicit, fingerprint-guarded confirmation. */
  const checkDuplicates = useMutation({
    mutationFn: (variables: { path: string; expectedFingerprint: string | null }) => getWorkbenchApi().notes.duplicates({
      vaultId: activeProfile!.id,
      relativePath: variables.path
    }),
    onSuccess: (report) => {
      if (report.status === 'new') {
        create.mutate({ expectedFingerprint: null })
        return
      }
      setDuplicateReport(report)
    },
    onError: (error) => setNewPathError(getErrorMessage(error))
  })

  useEffect(() => {
    if (!dirty || !selectedPath || save.isPending) return
    const timer = window.setTimeout(() => save.mutate({ path: selectedPath, content, fingerprint, generation: saveGeneration.current }), 800)
    return () => window.clearTimeout(timer)
  }, [content, dirty, fingerprint, save.isPending, selectedPath])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== 's') return
      if (!dirty || !selectedPath || save.isPending) return
      event.preventDefault()
      save.mutate({ path: selectedPath, content, fingerprint, generation: saveGeneration.current })
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [content, dirty, fingerprint, save.isPending, save.mutate, selectedPath])

  // Controlled frontmatter is the authority for the binding shown here; the
  // former `project:` tag lookup would report "未分类" for every note written
  // through `workbench_project_id`.
  const selectedProjectId = selected.data?.projectId ?? null
  const selectedProjectBound = selectedProjectId !== null && projects.some((project) => project.id === selectedProjectId)
  const connection = connectionLabel(profile)
  const index = indexLabel(profile, refresh.isPending || notes.isFetching, notes.error ?? refresh.error, notes.data)
  const selectPath = (path: string) => {
    if (dirty && !window.confirm('当前修改尚未保存，确定放弃草稿并切换文件吗？')) return
    setConflictReloaded(false)
    setNoteMenu(null)
    setSelectedPath(path)
  }
  const selectCategory = (next: KnowledgeCategoryId) => {
    if (dirty && !window.confirm('当前修改尚未保存，确定放弃草稿并切换内容库吗？')) return
    setActiveCategory(next)
    if (dirty) {
      setContent('')
      setFingerprint(null)
      setDirty(false)
      save.reset()
    }
    setConflictReloaded(false)
  }
  const beginCreate = () => {
    const selectedCategory = category
    setNewPath(selectedCategory.createPath)
    setCreateMode(true)
    setNewPathError(null)
    setConflictReloaded(false)
  }
  const reloadAfterConflict = async () => {
    save.reset()
    await selected.refetch()
    setConflictReloaded(true)
  }

  const toggleAllVisible = () => {
    // Pressing 全选 on a list that is not in batch mode turns the checkboxes on
    // in the same gesture, so the selection is always visible while it exists.
    setSelectionMode(true)
    setSelectedPaths((current) => {
      if (allVisibleSelected) return current.filter((path) => !visibleFilePaths.includes(path))
      return [...new Set([...current, ...visibleFilePaths])]
    })
  }
  const toggleSelectionMode = () => {
    setSelectionMode((current) => {
      if (current && selectedPaths.length > 0) {
        // Leaving batch mode hides every checkbox; keeping a hidden selection
        // would let the next bulk action delete rows the user cannot see.
        setSelectedPaths([])
        setTreeFeedback('已退出批量选择，并清除已选文件。')
        return false
      }
      return !current
    })
  }
  const removeSelectedNotes = (paths: readonly string[]) => {
    if (paths.length === 0 || deleteNotes.isPending) return
    if (!window.confirm(`确认删除 ${paths.length} 个 Markdown 文件？此操作不可撤回。`)) return
    deleteNotes.mutate(paths)
  }

  const toggleAllCategories = () => setSelectedCategories((current) => allCategoriesSelected ? [] : folderCategories.map((item) => item.label))
  const targetNote = duplicateReport?.candidates.find((candidate) => candidate.match === 'path') ?? null
  const suggestedDuplicatePath = duplicateReport && !targetNote
    ? duplicateReport.relativePath.toLowerCase().endsWith('.md')
      ? `${duplicateReport.relativePath.slice(0, -3)}-2.md`
      : `${duplicateReport.relativePath}-2.md`
    : null
  const removeCategories = (folders: readonly string[]) => {
    if (folders.length === 0 || deleteFolders.isPending) return
    if (!window.confirm(`确认删除 ${folders.length} 个 Vault 根目录分类？仅允许删除空文件夹，不会递归删除文件。`)) return
    deleteFolders.mutate(folders)
  }

  useEffect(() => {
    const closeMenu = () => setNoteMenu(null)
    window.addEventListener('click', closeMenu)
    return () => window.removeEventListener('click', closeMenu)
  }, [])

  if (profiles.isLoading) return <div className="page-scroll"><PageHeader description="仅浏览和编辑已授权 Vault 内的 Markdown；服务端负责路径、realpath、符号链接和敏感目录检查。" eyebrow="KNOWLEDGE / OBSIDIAN" title="Obsidian" /><div className="mt-4"><PanelSkeleton lines={8} /></div></div>
  if (profiles.error) return <div className="page-scroll"><PageHeader description="仅浏览和编辑已授权 Vault 内的 Markdown；服务端负责路径、realpath、符号链接和敏感目录检查。" eyebrow="KNOWLEDGE / OBSIDIAN" title="Obsidian" /><div className="mt-4"><ErrorState error={profiles.error} onRetry={() => void profiles.refetch()} /></div></div>

  return (
    <div className="obsidian-page page-scroll">
      <PageHeader
        actions={undefined}
        description="仅浏览和编辑已授权 Vault 内的 Markdown；服务端负责路径、realpath、符号链接和敏感目录检查。"
        eyebrow="KNOWLEDGE / OBSIDIAN"
        title="Obsidian"
      />
      {!profile ? <div className="mt-4"><EmptyState description="请先在设置的 Obsidian 区域保存并验证 Vault 配置；配置本身不会被视为已连接。" title="尚未配置 Obsidian" /></div> : !activeProfile ? <div className="mt-4"><EmptyState description="该 Vault 已配置但处于停用状态。请在设置中启用后再进行索引和文件操作。" title="Obsidian 已停用" /></div> : (
        <>
        {vaultPlan && vaultMissingCount > 0 ? <section className="research-panel mt-4"><header className="flex min-h-12 items-center gap-3 border-b border-border px-4"><div className="min-w-0 flex-1"><p className="instrument-label">VAULT / INITIALIZE</p><h2 className="text-sm font-bold text-foreground">初始化根目录分类</h2></div><Button disabled={vaultPreview.isFetching || vaultInitialize.isPending} onClick={() => void vaultPreview.refetch()} size="sm" variant="ghost"><RefreshCw aria-hidden="true" className="size-3.5" />重新探测</Button><Button loading={vaultInitialize.isPending} onClick={() => { if (window.confirm('确认在当前 Vault 根目录创建缺失的分类文件夹和 README.md 吗？不会覆盖已有文件。')) vaultInitialize.mutate() }} size="sm" variant="primary">创建缺失分类</Button></header><div className="p-4"><p className="text-xs leading-5 text-muted-foreground">默认分类来自当前 Vault 根目录；项目通过 Markdown frontmatter 的 projectId / labels 隔离。已有文件夹和 README.md 会保留。</p><Disclosure className="mt-3" hint={`${vaultMissingCount} 待创建 · ${vaultPlan.categories.length - vaultMissingCount} 已存在`} title="分类清单"><div className="flex flex-wrap gap-2 pt-1">{vaultPlan.categories.map((item) => { const exists = vaultPlan.existingPaths.some((path) => path.toLocaleLowerCase('en-US') === item.relativePath.toLocaleLowerCase('en-US')); return <span className={`research-tag ${exists ? '' : 'border-primary/40 text-primary'}`} key={item.relativePath}>{item.name}{exists ? ' 已存在' : ' 待创建'}</span> })}</div></Disclosure>{vaultMessage ? <p className="mt-3 text-xs text-muted-foreground" role="status">{vaultMessage}</p> : null}</div></section> : null}
        <section aria-label="Obsidian 内容库" className="mt-4 rounded-lg border border-border bg-surface p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><p className="instrument-label">LIBRARY / EDITABLE</p><h2 className="text-sm font-bold text-foreground">知识库入口</h2><p className="mt-1 text-xs text-muted-foreground">{category.description} 编辑器与实时预览共享中央工作区。</p></div>
            <span className="research-tag">{visibleFileCount} 个 Markdown 文件</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2" role="tablist" aria-label="知识库分类">
            {knowledgeCategories.map((item) => (
              <div className="inline-flex items-center" key={item.id}>
                {item.id !== 'all' ? <input aria-label={`选择分类：${item.label}`} checked={selectedCategories.includes(item.label)} className="research-checkbox mr-1.5" onChange={() => setSelectedCategories((current) => current.includes(item.label) ? current.filter((name) => name !== item.label) : [...current, item.label])} type="checkbox" /> : null}
                <button aria-selected={item.id === activeCategory} className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${item.id === activeCategory ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'}`} onClick={() => selectCategory(item.id)} onContextMenu={(event) => { if (!activeProfile || item.id === 'all') return; event.preventDefault(); event.stopPropagation(); void getWorkbenchApi().system.revealPath({ vaultId: activeProfile.id, relativePath: item.createPath.replace(/\/[^/]+$/u, '') }) }} role="tab" title={item.id === 'all' ? '全部文件' : '右键在资源管理器中查看此分类'} type="button">{item.label}</button>
              </div>
            ))}
            {folderCategories.length > 0 ? <label className="ml-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground"><SelectionCheckbox ariaLabel="全选知识库分类" checked={allCategoriesSelected} indeterminate={someCategoriesSelected} onChange={toggleAllCategories} />全选分类</label> : null}
            {selectedCategories.length > 0 ? <Button aria-label="删除选中的知识库分类" disabled={deleteFolders.isPending} loading={deleteFolders.isPending} onClick={() => removeCategories(selectedCategories)} size="sm" variant="danger"><Trash2 aria-hidden="true" className="size-3.5" />删除分类</Button> : null}
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">分类删除只处理 Vault 根目录下的空文件夹；含有文件的分类会被安全拒绝，请先在文件树中批量删除或移动内容。</p>
        </section>
        <div className={`obsidian-workspace mt-4 grid min-h-0 gap-4 ${leftCollapsed ? 'obsidian-left-collapsed' : ''} ${rightCollapsed ? 'obsidian-right-collapsed' : ''}`} style={workspaceStyle}>
          <section className={`${leftCollapsed ? 'hidden' : ''} obsidian-tree-panel research-panel pane-resize-host min-w-0`}>
            {treeSeparator}
            <header className="flex min-h-12 items-center gap-2 border-b border-border px-3"><FolderOpen aria-hidden="true" className="size-4 text-primary" /><h2 className="flex-1 text-sm font-bold text-foreground">Vault 文件树</h2><Button aria-label="新建 Vault 文件夹" onClick={() => { setFolderForm({ path: activeCategory === 'all' ? '' : `${category.label}/` }); setTreeFeedback(null) }} size="sm" variant="ghost"><FolderPlus aria-hidden="true" className="size-3.5" />新建文件夹</Button><Button aria-label={selectionMode ? '退出批量选择' : '进入批量选择'} aria-pressed={selectionMode} onClick={toggleSelectionMode} size="sm" variant={selectionMode ? 'primary' : 'ghost'}><ListChecks aria-hidden="true" className="size-3.5" />批量选择</Button><Button aria-label={leftCollapsed ? '展开文件树' : '折叠文件树'} onClick={() => setLeftCollapsed((value) => !value)} size="icon" variant="ghost">{leftCollapsed ? <PanelLeftOpen aria-hidden="true" className="size-4" /> : <PanelLeftClose aria-hidden="true" className="size-4" />}</Button></header>
            <div className="border-b border-border p-2"><label><span className="sr-only">搜索 Vault 文件</span><Input onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件名或标签" value={query} /></label></div>
            {folderForm ? <form className="grid gap-2 border-b border-border p-3" onSubmit={(event) => { event.preventDefault(); if (!createFolder.isPending) createFolder.mutate({ path: folderForm.path }) }}><label className="grid gap-1.5"><span className="text-xs font-semibold">新文件夹（Vault 相对路径）</span><Input aria-label="新文件夹路径" onChange={(event) => setFolderForm({ path: event.target.value })} placeholder="例如：文献综述/2026" value={folderForm.path} /></label><p className="text-[11px] text-muted-foreground">只创建缺失的目录；不会写入 .obsidian，同名文件不会被覆盖。</p><div className="flex gap-2"><Button loading={createFolder.isPending} size="sm" type="submit" variant="primary">创建文件夹</Button><Button onClick={() => setFolderForm(null)} size="sm" type="button" variant="ghost">取消</Button></div></form> : null}
            {moveForm ? <form className="grid gap-2 border-b border-border p-3" onSubmit={(event) => { event.preventDefault(); if (!moveEntry.isPending) moveEntry.mutate(moveForm) }}><label className="grid gap-1.5"><span className="text-xs font-semibold">{moveForm.kind === 'directory' ? '重命名分类（Vault 根目录单层目录）' : '重命名 / 移动 Markdown 文件'}</span><Input aria-label="移动目标路径" onChange={(event) => setMoveForm({ ...moveForm, to: event.target.value })} value={moveForm.to} /></label><p className="text-[11px] text-muted-foreground">源：<span className="font-mono">{moveForm.from}</span>；目标必须不存在，且目标文件夹必须已存在；不会创建目录或覆盖文件。</p>{moveError ? <p className="form-feedback form-feedback-error" role="alert">{moveError}</p> : null}<div className="flex gap-2"><Button loading={moveEntry.isPending} size="sm" type="submit" variant="primary">确认移动</Button><Button onClick={() => { setMoveForm(null); setMoveError(null) }} size="sm" type="button" variant="ghost">取消</Button></div></form> : null}
            <div className="border-b border-border px-3 py-2">
              <SelectionBar
                allSelected={allVisibleSelected}
                disabled={visibleFilePaths.length === 0}
                indeterminate={someVisibleSelected}
                label="Vault 文件选择"
                onClear={() => { setSelectedPaths([]); setTreeFeedback(null) }}
                onToggleAll={toggleAllVisible}
                scope={selectionMode ? `范围：${category.label} 分类的当前筛选结果，共 ${visibleFilePaths.length} 个 Markdown 文件（不含目录）；切换分类或搜索会清除已选` : `未进入批量选择；当前分类有 ${visibleFilePaths.length} 个 Markdown 文件（不含目录）`}
                selectAllLabel="全选当前结果"
                selectedCount={selectedPaths.length}
                totalCount={visibleFilePaths.length}
              >
                <Button aria-label={`删除当前选中的 ${selectedPaths.length} 个 Markdown 文件`} disabled={selectedPaths.length === 0 || deleteNotes.isPending} loading={deleteNotes.isPending} onClick={() => removeSelectedNotes(selectedPaths)} size="sm" variant="danger"><Trash2 aria-hidden="true" className="size-3.5" />删除选中</Button>
              </SelectionBar>
              {treeFeedback ? <p className="form-feedback mt-2" role="status">{treeFeedback}</p> : null}
            </div>
            {notes.isFetching && notes.data ? <div className="px-3 py-2"><InlineLoadingState label="正在更新索引…" /></div> : null}
            {notes.isLoading ? <PanelSkeleton lines={6} /> : null}
            {notes.error ? <div className="p-3"><ErrorState compact error={notes.error} onRetry={() => void notes.refetch()} /><p className="mt-2 text-xs text-muted-foreground">索引不可用时不会覆盖已有列表；请检查设置中的 Vault 路径和权限后重试。</p></div> : null}
            {!notes.isLoading && !notes.error && visibleNotes?.length === 0 ? <div className="research-empty-inline" role="status"><p className="font-semibold text-foreground">当前分类没有匹配的 Markdown 文件或文件夹。</p><p className="mt-1 text-[11px] leading-5">可以清除搜索关键词、切换到“全部”，或直接新建文件夹和笔记。</p></div> : null}
            <div className="obsidian-tree-scroll p-2"><TreeBranch node={createTree(visibleNotes ?? [])} onContextMenu={(path, event) => { event.preventDefault(); selectPath(path); setNoteMenu({ path, kind: 'file', ...contextMenuPosition(event, Math.min(window.innerHeight - 24, 282 + projects.length * 26)) }) }} onFolderContextMenu={(path, event) => { setNoteMenu({ path, kind: 'directory', ...contextMenuPosition(event, 132) }) }} onSelect={selectPath} onToggle={(path) => setSelectedPaths((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path])} selectedPaths={selectedPaths} selectedPath={selectedPath} showSelection={selectionMode} root /></div>
          </section>
          <section className="obsidian-editor-panel research-panel pane-resize-host min-w-0">
            {inspectorSeparator}
            <header className="flex min-h-12 items-center justify-between gap-3 border-b border-border px-4"><div className="min-w-0 flex-1"><p className="instrument-label">MARKDOWN / {editorMode === 'preview' ? 'PREVIEW' : 'EDITOR'}</p><h2 className="break-words text-sm font-bold text-foreground">{selected.data?.title ?? selectedPath ?? '请选择文件'}</h2></div><div className="obsidian-editor-actions flex shrink-0 items-center gap-2"><Button onClick={() => setEditorMode((mode) => mode === 'preview' ? 'edit' : 'preview')} size="sm" variant="secondary">{editorMode === 'preview' ? '编辑' : '预览'}</Button><Button aria-label={leftCollapsed ? '展开文件树' : '折叠文件树'} onClick={() => setLeftCollapsed((value) => !value)} size="icon" variant="ghost">{leftCollapsed ? <PanelLeftOpen aria-hidden="true" className="size-4" /> : <PanelLeftClose aria-hidden="true" className="size-4" />}</Button><Button aria-label={rightCollapsed ? '展开属性面板' : '折叠属性面板'} onClick={() => setRightCollapsed((value) => !value)} size="icon" variant="ghost">{rightCollapsed ? <PanelRightOpen aria-hidden="true" className="size-4" /> : <PanelRightClose aria-hidden="true" className="size-4" />}</Button><Button onClick={beginCreateNote} size="sm"><Plus aria-hidden="true" className="size-3.5" />新建{activeCategory === 'all' ? '笔记' : category.label}</Button><Button disabled={!dirty || !selectedPath} loading={save.isPending} onClick={() => selectedPath && save.mutate({ path: selectedPath, content, fingerprint, generation: saveGeneration.current })} size="sm" variant="primary"><Save aria-hidden="true" className="size-3.5" />保存</Button></div></header>
            {externalChange ? <div className="m-3 rounded-md border border-accent/40 bg-muted p-3 text-xs" data-testid="obsidian-external-change" role="status"><p className="font-semibold text-foreground">检测到外部修改：{selected.data?.relativePath}</p><p className="mt-1 text-muted-foreground">{dirty ? '当前草稿基于旧版本，保存会被指纹校验拒绝，不会覆盖 Obsidian 中的新内容。' : '本页显示的仍是上次读取的内容；重新读取后才会显示外部版本。'}</p><p className="mt-1 text-muted-foreground">列表轮询指纹 {listedFingerprint} ≠ 本页指纹 {fingerprint}；外部版本修改时间 {formatDateTime(listedUpdatedAt)}。</p><div className="mt-2 flex gap-2"><Button loading={selected.isFetching} onClick={() => { setDirty(false); void selected.refetch() }} size="sm" variant="primary"><RefreshCcwDot aria-hidden="true" className="size-3.5" />重新读取外部版本</Button><Button onClick={() => setDismissedExternal(`${selectedPath ?? ''}:${listedFingerprint ?? ''}`)} size="sm" variant="ghost">暂时忽略</Button></div></div> : null}
            {selected.isFetching && selected.data ? <div className="border-b border-border px-4 py-2"><InlineLoadingState label="正在更新笔记…" /></div> : null}{selected.isLoading ? <PanelSkeleton lines={5} /> : null}{selected.error ? <div className="p-4"><ErrorState error={selected.error} onRetry={() => void selected.refetch()} /></div> : null}
            {createMode ? <form className="grid gap-3 p-4" onSubmit={(event) => { event.preventDefault(); const error = relativePathError(newPath); setNewPathError(error); if (error || create.isPending || checkDuplicates.isPending) return; setDuplicateReport(null); checkDuplicates.mutate({ path: newPath.trim(), expectedFingerprint: null }) }}><label className="grid gap-1.5"><span className="text-xs font-semibold">Markdown 相对路径</span><Input aria-invalid={Boolean(newPathError)} onChange={(event) => { setNewPath(event.target.value); setNewPathError(null) }} placeholder="例如：文献综述/新建笔记.md" value={newPath} /></label><p className="text-xs text-muted-foreground">仅接受 Vault 内的 .md 文件；服务端还会检查 .obsidian、.git、临时文件和链接越界。创建前先做重复检查，不会静默覆盖已有文件。</p>{childNoteParent ? <p className="text-xs text-muted-foreground">子笔记：将在受控 frontmatter 写入 <span className="font-mono">workbench_parent = {childNoteParent}</span>。</p> : null}{newPathError ? <p className="form-feedback form-feedback-error" role="alert">{newPathError}</p> : null}{duplicateReport ? <div className="rounded-md border border-accent/40 bg-muted p-3 text-xs" role="status"><p className="font-semibold text-foreground">{duplicateReport.status === 'exists' ? '该路径已存在 Markdown 文件，未自动覆盖。' : '已存在同名笔记，未自动覆盖。'}</p><ul className="mt-2 grid gap-1">{duplicateReport.candidates.map((candidate) => <li className="break-all" key={candidate.relativePath}>{candidate.match === 'path' ? '同路径' : '同标题'}：<span className="font-mono">{candidate.relativePath}</span>（{formatDateTime(candidate.updatedAt)}）</li>)}</ul><div className="mt-2 flex flex-wrap gap-2">{targetNote ? <Button onClick={() => { setSelectedPath(targetNote.relativePath); setCreateMode(false); setDuplicateReport(null); setChildNoteParent(null) }} size="sm" variant="secondary">{targetNote.match === 'path' ? '打开已有笔记' : '打开同名笔记'}</Button> : null}{targetNote ? <Button onClick={() => create.mutate({ expectedFingerprint: targetNote.fingerprint })} size="sm" variant="danger">指纹校验后覆盖更新</Button> : null}{suggestedDuplicatePath ? <Button onClick={() => { setNewPath(suggestedDuplicatePath); setDuplicateReport(null) }} size="sm" variant="secondary">改用 {suggestedDuplicatePath}</Button> : null}<Button onClick={() => setDuplicateReport(null)} size="sm" variant="ghost">取消创建</Button></div></div> : null}{create.error ? <p className="form-feedback form-feedback-error" role="alert">{getErrorMessage(create.error)}</p> : null}<div className="flex gap-2"><Button loading={create.isPending || checkDuplicates.isPending} type="submit" variant="primary"><Plus aria-hidden="true" className="size-4" />创建笔记</Button><Button onClick={() => { setCreateMode(false); setChildNoteParent(null); setDuplicateReport(null) }} type="button" variant="ghost">取消</Button></div></form> : null}
            {!createMode && !selected.data && !selected.isLoading && !selected.error ? <div className="obsidian-editor-empty" role="status"><FileText aria-hidden="true" className="size-7 text-primary" /><p className="mt-2 text-sm font-semibold text-foreground">从左侧选择一个 Markdown 文件</p><p className="mt-1 text-xs text-muted-foreground">文件夹可以直接展开；初始化只在你确认后创建缺失分类。</p></div> : null}
            {!createMode && selected.data ? editorMode === 'preview' ? <div className="obsidian-editor-content flex min-h-[34rem] flex-1 flex-col"><div className="border-b border-border px-4 py-2"><p className="instrument-label">LIVE PREVIEW</p><p className="text-[11px] text-muted-foreground">只读预览，不会写回 Vault；{content.trim() ? `共 ${content.split('\n').length} 行 · ${content.length} 字符` : '暂无内容'}。</p></div><div className="min-h-0 flex-1 overflow-auto"><MarkdownPreview source={content} /></div></div> : <div className="obsidian-editor-content flex min-h-[34rem] flex-1 flex-col"><div className="border-b border-border px-4 py-2"><p className="instrument-label">EDIT</p><p className="text-[11px] text-muted-foreground">停止输入 0.8 秒自动保存；Ctrl+S 可立即保存。</p></div><textarea aria-label="Markdown 内容" className="markdown-editor min-h-0 flex-1 w-full resize-none" onChange={(event) => { saveGeneration.current += 1; setContent(event.target.value); setDirty(true); setConflictReloaded(false); if (save.error) save.reset() }} value={content} /></div> : null}
            {save.error ? <div className="m-3 rounded-md border border-danger/30 bg-danger-subtle p-3 text-xs" role="alert"><p className="font-semibold text-danger">{isConflictError(save.error) ? '文件发生外部修改，未覆盖外部内容。' : getErrorMessage(save.error)}</p>{isConflictError(save.error) ? <div className="mt-2 flex flex-wrap items-center gap-2"><Button loading={selected.isFetching} onClick={() => void reloadAfterConflict()} size="sm" variant="primary">重新读取最新版本</Button><span className="text-muted-foreground">重新读取会放弃当前草稿并更新 expectedFingerprint。</span></div> : <p className="mt-1 text-muted-foreground">请检查 Vault 状态后重试。</p>}</div> : null}
            {!save.error && conflictReloaded ? <p className="form-feedback m-3 text-success" role="status">已重新读取最新版本并更新 expectedFingerprint；请确认内容后再编辑。</p> : null}
          </section>
          <aside className={`${rightCollapsed ? 'hidden' : ''} obsidian-inspector-panel research-panel`}>
            <header className="flex min-h-12 items-center gap-2 border-b border-border px-4 py-3"><div className="min-w-0 flex-1"><p className="instrument-label">INSPECTOR / NOTE</p><h2 className="mt-0.5 text-sm font-bold text-foreground">属性</h2></div><Button aria-label={rightCollapsed ? '展开属性面板' : '折叠属性面板'} onClick={() => setRightCollapsed((value) => !value)} size="icon" variant="ghost">{rightCollapsed ? <PanelRightOpen aria-hidden="true" className="size-4" /> : <PanelRightClose aria-hidden="true" className="size-4" />}</Button></header>
            {selected.data ? <div className="grid gap-3 p-4 text-xs">
              <dl className="grid gap-3">
                <div><dt className="text-muted-foreground">相对路径</dt><dd className="mt-1 break-all font-mono text-foreground">{selected.data.relativePath}</dd></div>
                <div><dt className="text-muted-foreground">标签</dt><dd className="mt-1 break-words text-foreground">{selected.data.tags.join('、') || '无标签'}</dd></div>
                <div><dt className="text-muted-foreground">受控类型</dt><dd className="mt-1 text-foreground">{selected.data.kind ?? '未设置'}</dd></div>
                <div><dt className="text-muted-foreground">修改时间</dt><dd className="mt-1 text-foreground">{formatDateTime(selected.data.updatedAt)}</dd></div>
                <div><dt className="text-muted-foreground">状态</dt><dd className={dirty ? 'mt-1 font-semibold text-accent' : 'mt-1 text-foreground'}>{dirty ? '有未保存修改' : '已读取'}</dd></div>
              </dl>
              <Disclosure hint="父笔记 · 指纹校验" title="关联与版本校验">
                <dl className="grid gap-3 pt-1">
                  <div><dt className="text-muted-foreground">父笔记</dt><dd className="mt-1 break-all font-mono text-foreground">{selected.data.parentRelativePath ?? '未关联'}</dd></div>
                  <div><dt className="text-muted-foreground">版本校验</dt><dd className="mt-1 leading-5 text-foreground">{dirty ? '草稿未保存，保存时要求 expectedFingerprint' : '已载入文件指纹'}</dd></div>
                </dl>
              </Disclosure>
            </div> : <div className="p-4"><p className="research-empty-inline">选择一个 Markdown 文件查看属性。</p><p className="text-[11px] leading-5 text-muted-foreground">从左侧文件树选中 Markdown 后会显示路径、标签、类型、指纹状态和项目绑定。</p></div>}
            {selected.data ? <div className="border-t border-border p-4"><label className="grid gap-1.5"><span className="text-xs font-semibold text-muted-foreground">项目绑定（预览后写入）</span><select aria-label="项目绑定" className="select-control" disabled={previewMetadata.isPending || applyMetadata.isPending} onChange={(event) => requestProjectBinding(selected.data!.relativePath, event.target.value === 'none' ? null : event.target.value)} value={selectedProjectBound && selectedProjectId ? selectedProjectId : 'none'}><option value="none">不绑定项目 / 未分类</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><p className="mt-2 text-xs leading-5 text-muted-foreground">写入受控字段 workbench_project_id；未绑定项目的笔记归入未分类。</p><Disclosure className="mt-2" hint="changedFields · 指纹" title="写入规则说明"><p className="text-[11px] leading-5 text-muted-foreground">先显示服务端计算的差异（changedFields、保留的未知字段、warnings），确认后才按预览指纹 expectedFingerprint 写入；文件在外部被修改时会被拒绝，而不是覆盖外部内容。</p></Disclosure><div className="mt-2 flex flex-wrap gap-2"><Button disabled={!selected.data.parentRelativePath} onClick={() => requestMetadataPatch(selected.data!.relativePath, { parentRelativePath: null })} size="sm" variant="secondary">解除父笔记关联</Button></div>{metadataFeedback ? <p className="form-feedback mt-2" role="status">{metadataFeedback}</p> : null}{previewMetadata.error ? <p className="mt-2 text-xs text-danger" role="alert">{getErrorMessage(previewMetadata.error)}</p> : null}{applyMetadata.error ? <p className="mt-2 text-xs text-danger" role="alert">{getErrorMessage(applyMetadata.error)}</p> : null}</div> : null}
          </aside>
        </div>
        <Dialog open={metadataPreview !== null} onOpenChange={(next) => { if (!next) { setMetadataPreview(null); applyMetadata.reset() } }}>
          <DialogContent className="max-h-[90dvh] w-[min(95vw,44rem)] overflow-y-auto" description="差异由服务端从磁盘上的文件计算；确认后才按预览指纹写入，正文与未知 frontmatter 字段原样保留。" title="受控 frontmatter 预览">
            {metadataPreview ? <div className="grid gap-3">
              <p className="break-all font-mono text-xs text-muted-foreground">{metadataPreview.preview.relativePath}</p>
              {metadataDiffRows(metadataPreview.preview).length > 0 ? <div className="grid gap-1">
                {metadataDiffRows(metadataPreview.preview).map((row) => <div className="grid grid-cols-[4.5rem_1fr] items-start gap-2 rounded-md border border-border p-2 text-xs" key={row.label}>
                  <span className="text-muted-foreground">{row.label}</span>
                  <span className="break-all"><span className="text-muted-foreground line-through">{row.before}</span><span aria-hidden="true" className="mx-1.5 text-muted-foreground">→</span><span className="font-semibold text-foreground">{row.after}</span></span>
                </div>)}
              </div> : <p className="text-xs text-muted-foreground">受控字段没有变化；确认写入只会重写相同的前置元数据。</p>}
              <div className="text-xs"><p className="font-semibold text-foreground">changedFields</p><p className="mt-1 text-muted-foreground">{metadataPreview.preview.changedFields.length > 0 ? metadataPreview.preview.changedFields.join('、') : '无'}</p></div>
              <Disclosure hint={`${metadataPreview.preview.preservedUnknownFields.length} 个字段`} title="保留的未知字段"><p className="break-all text-xs text-muted-foreground">{metadataPreview.preview.preservedUnknownFields.length > 0 ? metadataPreview.preview.preservedUnknownFields.join('、') : '没有未知字段需要保留'}</p></Disclosure>
              {metadataPreview.preview.warnings.length > 0 ? <div className="rounded-md border border-accent/40 bg-muted p-2 text-xs" role="alert"><p className="font-semibold text-foreground">warnings</p><ul className="mt-1 grid gap-1 text-muted-foreground">{metadataPreview.preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div> : null}
              {applyMetadata.error ? <p className="form-feedback form-feedback-error" role="alert">{isConflictError(applyMetadata.error) ? `文件已在外部修改，受控 frontmatter 未写入：${getErrorMessage(applyMetadata.error)}` : `元数据写入失败：${getErrorMessage(applyMetadata.error)}`}</p> : null}
              <div className="flex flex-wrap justify-end gap-2">
                <DialogClose asChild><Button onClick={() => { setMetadataPreview(null); applyMetadata.reset() }} type="button" variant="ghost">取消</Button></DialogClose>
                <Button disabled={metadataPreview.preview.changedFields.length === 0} loading={applyMetadata.isPending} onClick={() => applyMetadata.mutate({ preview: metadataPreview.preview, patch: metadataPreview.patch })} type="button" variant="primary"><ShieldCheck aria-hidden="true" className="size-4" />确认写入</Button>
              </div>
            </div> : null}
          </DialogContent>
        </Dialog>
        {noteMenu ? <div className="fixed z-50 max-h-[70vh] min-w-52 overflow-y-auto rounded-md border border-border bg-surface p-1 shadow-lg" onClick={(event) => event.stopPropagation()} style={{ left: noteMenu.x, top: noteMenu.y }}><p className="px-2 py-1 text-[11px] text-muted-foreground">{noteMenu.path}</p>
            {noteMenu.kind === 'directory' ? <>
              <button className="context-menu-item w-full" onClick={() => beginMove('directory', noteMenu.path)} type="button">重命名分类</button>
              <button className="context-menu-item w-full" onClick={() => { if (activeProfile) void getWorkbenchApi().system.revealPath({ vaultId: activeProfile.id, relativePath: noteMenu.path }); setNoteMenu(null) }} type="button">在资源管理器中查看</button>
              <button className="context-menu-item w-full text-danger" disabled={deleteFolders.isPending} onClick={() => removeCategories([noteMenu.path])} type="button">删除空分类</button>
            </> : <>
              <button className="context-menu-item w-full" onClick={() => { setSelectedPaths((current) => current.includes(noteMenu.path) ? current.filter((item) => item !== noteMenu.path) : [...current, noteMenu.path]); setSelectionMode(true); setNoteMenu(null) }} type="button">{selectedPaths.includes(noteMenu.path) ? '取消选择' : '加入选择'}</button>
              <button className="context-menu-item w-full" onClick={() => beginChildNote(noteMenu.path)} type="button">新建子笔记</button>
              <button className="context-menu-item w-full" onClick={() => { if (activeProfile) void getWorkbenchApi().system.revealPath({ vaultId: activeProfile.id, relativePath: noteMenu.path }); setNoteMenu(null) }} type="button">在资源管理器中查看</button>
              <div className="my-1 border-t border-border" />
              <p className="px-2 py-1 text-[11px] text-muted-foreground">绑定项目（预览后写入）</p>
              <button className="context-menu-item w-full" onClick={() => requestProjectBinding(noteMenu.path, null)} type="button">取消项目绑定</button>
              {projects.map((project) => <button className="context-menu-item w-full" key={project.id} onClick={() => requestProjectBinding(noteMenu.path, project.id)} type="button">{noteMenu.path === selectedPath && selectedProjectId === project.id ? `已绑定：${project.name}` : `绑定：${project.name}`}</button>)}
              <div className="my-1 border-t border-border" />
              <button className="context-menu-item w-full text-danger" disabled={deleteNotes.isPending} onClick={() => { if (window.confirm('确认删除此 Markdown 文件？此操作不可撤回。')) deleteNotes.mutate([noteMenu.path]) }} type="button">直接删除</button>
            </>}
          </div> : null}
        </>
      )}
    </div>
  )
}
