import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, FileText, Folder, FolderOpen, RefreshCw, Save, ShieldCheck, Plus, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import type { IntegrationProfile, Note, Project } from '@prw/contracts'
import { ObsidianRelativePathSchema } from '@prw/contracts'
import { EmptyState, ErrorState, InlineLoadingState, PageHeader, PanelSkeleton } from '../components/states'
import { Button, Input } from '../components/ui'
import { formatDateTime, getErrorMessage } from '../lib/utils'
import { getWorkbenchApi } from '../lib/workbench'
import { queryKeys, useIntegrationsQuery, useNotesQuery } from './queries'

type TreeNode = {
  name: string
  path: string
  folders: Map<string, TreeNode>
  notes: Note[]
}

type KnowledgeCategoryId = string

type KnowledgeCategory = {
  id: KnowledgeCategoryId
  label: string
  description: string
  tokens: string[]
  createPath: string
  template: string
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
    { id: 'all', label: '全部', description: '浏览 Vault 中已索引的 Markdown。', tokens: [], createPath: '新建笔记.md', template: '# 新建笔记\n\n' },
    ...[...folders].sort((a, b) => a.localeCompare(b)).map((folderName) => ({
      id: `folder:${folderName}`,
      label: folderName,
      description: `来自 Vault 根目录的 ${folderName} 文件夹；项目通过 frontmatter 标签隔离。`,
      tokens: [folderName],
      createPath: `${folderName}/新建笔记.md`,
      template: categoryTemplate(folderName)
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

function MarkdownPreview({ source }: { source: string }): React.JSX.Element {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let codeLines: string[] | null = null
  let codeKey = 0
  const renderCodeBlock = (lines: readonly string[], key: string): React.JSX.Element => {
    const code = lines.join('\n')
    return <div className="relative overflow-hidden rounded-md border border-border bg-muted" key={key}><button aria-label="复制代码" className="absolute right-2 top-2 inline-flex items-center gap-1 rounded border border-border bg-surface px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => { void navigator.clipboard?.writeText(code) }} type="button"><Copy aria-hidden="true" className="size-3" />复制</button><pre className="overflow-x-auto p-3 pr-20 text-xs leading-5"><code>{code}</code></pre></div>
  }
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith('```')) {
      if (codeLines === null) codeLines = []
      else {
        blocks.push(renderCodeBlock(codeLines, `code-${codeKey++}`))
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
      blocks.push(<Heading className={level === 1 ? 'text-xl font-bold' : level === 2 ? 'text-lg font-bold' : 'text-base font-semibold'} key={`heading-${index}`}>{renderInlineMarkdown(heading[2]!)}</Heading>)
      return
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr className="border-border" key={`hr-${index}`} />)
      return
    }
    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (unordered) {
      blocks.push(<p className="pl-5 leading-6 before:mr-2 before:content-['•']" key={`li-${index}`}>{renderInlineMarkdown(unordered[1]!)}</p>)
      return
    }
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line)
    if (ordered) {
      const marker = /^\s*(\d+)[.)]/.exec(line)?.[1] ?? '1'
      blocks.push(<p className="pl-5 leading-6" key={`oli-${index}`}><span aria-hidden="true" className="mr-2 text-muted-foreground">{marker}.</span>{renderInlineMarkdown(ordered[1]!)}</p>)
      return
    }
    if (line.startsWith('>')) {
      blocks.push(<blockquote className="border-l-2 border-primary/50 pl-3 italic text-muted-foreground" key={`quote-${index}`}>{renderInlineMarkdown(line.replace(/^>\s?/, ''))}</blockquote>)
      return
    }
    blocks.push(<p className="whitespace-pre-wrap leading-6" key={`paragraph-${index}`}>{renderInlineMarkdown(line)}</p>)
  })
  const remainingCode = codeLines as string[] | null
  if (remainingCode && remainingCode.length > 0) blocks.push(renderCodeBlock(remainingCode, `code-${codeKey}`))
  return <div aria-label="Markdown 实时预览" className="grid content-start gap-3 overflow-auto p-4 text-sm text-foreground">{blocks.length > 0 ? blocks : <p className="text-sm text-muted-foreground">暂无内容，开始编辑后将在这里实时预览。</p>}</div>
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

function TreeBranch({ node, selectedPath, selectedPaths = [], onSelect, onToggle, onContextMenu, showSelection = false, root = false }: {
  node: TreeNode
  selectedPath: string | null
  onSelect: (path: string) => void
  selectedPaths?: readonly string[]
  onToggle: ((path: string) => void) | undefined
  onContextMenu: ((path: string, event: MouseEvent) => void) | undefined
  showSelection?: boolean
  root?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(root)
  const folders = [...node.folders.values()].sort((left, right) => left.name.localeCompare(right.name))
  const notes = [...node.notes].sort((left, right) => left.title.localeCompare(right.title))
  return (
    <div className={root ? '' : 'ml-3 border-l border-border pl-2'}>
      {!root ? (
        <button className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setOpen((value) => !value)} type="button">
          {open ? <FolderOpen aria-hidden="true" className="size-3.5 text-primary" /> : <Folder aria-hidden="true" className="size-3.5 text-primary" />}
          <span className="truncate">{node.name}</span>
        </button>
      ) : null}
      {open ? (
        <div className="space-y-0.5">
          {folders.map((folder) => <TreeBranch key={folder.path} node={folder} onSelect={onSelect} onContextMenu={onContextMenu} onToggle={onToggle} selectedPaths={selectedPaths} selectedPath={selectedPath} showSelection={showSelection} />)}
          {notes.map((note) => (
            <div className={`flex items-start gap-1 rounded px-1 py-1 ${note.relativePath === selectedPath ? 'bg-primary/10' : 'hover:bg-muted'}`} key={note.relativePath} onContextMenu={(event) => onContextMenu?.(note.relativePath, event)}>
              {showSelection ? <input aria-label={`选择 ${note.title}`} checked={selectedPaths.includes(note.relativePath)} className="vault-note-checkbox research-checkbox mt-2" onChange={() => onToggle?.(note.relativePath)} type="checkbox" /> : null}
              <button aria-current={note.relativePath === selectedPath ? 'true' : undefined} className={`flex min-w-0 flex-1 items-start gap-2 rounded px-1 py-1 text-left ${note.relativePath === selectedPath ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`} onClick={() => onSelect(note.relativePath)} type="button">
                <FileText aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary" />
                <span className="min-w-0"><span className="block truncate text-xs font-semibold">{note.title}</span><span className="mt-0.5 block truncate text-[10px]">{note.relativePath}</span></span>
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

function upsertNoteMetadata(source: string, projectId: string | null, tags: readonly string[]): string {
  // Project binding is represented by one reserved tag. Remove any previous
  // binding before adding the new one so unbinding cannot leave stale project
  // filters behind.
  const normalizedTags = [...new Set(tags.filter(Boolean).filter((tag) => !tag.startsWith('project:')).concat(projectId ? [`project:${projectId}`] : []))]
  const labels = `[${normalizedTags.map((tag) => JSON.stringify(tag)).join(', ')}]`
  const frontmatter = `projectId: ${projectId ? JSON.stringify(projectId) : 'null'}\nworkbench_project_id: ${projectId ? JSON.stringify(projectId) : 'null'}\ntags: ${labels}\nlabels: ${labels}`
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/u.exec(source)
  if (!match) return `---\n${frontmatter}\n---\n\n${source}`
  const body = match[2]!.split(/\r?\n/u).filter((line) => !/^(?:projectId|workbench_project_id|tags|labels)\s*:/iu.test(line))
  return `${match[1]}${frontmatter}${body.length > 0 ? `\n${body.join('\n')}` : ''}${match[3]}${source.slice(match[0].length)}`
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
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [noteMenu, setNoteMenu] = useState<{ path: string; x: number; y: number } | null>(null)
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
  const knowledgeCategories = useMemo(() => buildDynamicKnowledgeCategories(notes.data, existingVaultFolders), [existingVaultFolders, notes.data])
  const category = knowledgeCategories.find((item) => item.id === activeCategory) ?? knowledgeCategories[0]!
  const visibleNotes = useMemo(() => notes.data?.filter((note) => noteMatchesCategory(note, category)), [category, notes.data])
  const visibleFileCount = useMemo(() => (visibleNotes ?? []).filter((note) => !note.isFolder).length, [visibleNotes])
  const visiblePaths = useMemo(() => (visibleNotes ?? []).map((note) => note.relativePath), [visibleNotes])
  const allVisibleSelected = visiblePaths.length > 0 && visiblePaths.every((path) => selectedPaths.includes(path))
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
  }, [selected.data])

  useEffect(() => {
    const firstFile = visibleNotes?.find((note) => !note.isFolder)
    if (!selectedPath && firstFile) setSelectedPath(firstFile.relativePath)
    if (!dirty && selectedPath && visibleNotes && !visibleNotes.some((note) => !note.isFolder && note.relativePath === selectedPath)) setSelectedPath(firstFile?.relativePath ?? null)
  }, [dirty, selectedPath, visibleNotes])

  // Keep bulk selection scoped to the current search/category result. This
  // prevents a hidden note from being deleted after the user changes filters.
  useEffect(() => {
    setSelectedPaths((current) => {
      const allowed = new Set(visiblePaths)
      const next = current.filter((path) => allowed.has(path))
      return next.length === current.length ? current : next
    })
  }, [visiblePaths])

  useEffect(() => {
    setSelectedPath(null)
    setContent('')
    setFingerprint(null)
    setDirty(false)
    setCreateMode(false)
    setConflictReloaded(false)
    setActiveCategory('all')
    setSelectedPaths([])
    setSelectedCategories([])
    setNoteMenu(null)
    setVaultPlan(null)
    setVaultMessage(null)
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
    mutationFn: () => getWorkbenchApi().notes.write({ vaultId: activeProfile!.id, relativePath: newPath.trim(), content: category.template, expectedFingerprint: null }),
    onSuccess: async (note) => {
      setCreateMode(false)
      setNewPathError(null)
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
    onSuccess: async (_receipts, paths) => {
      setSelectedPaths([])
      setNoteMenu(null)
      if (selectedPath && paths.includes(selectedPath)) {
        setSelectedPath(null)
        setContent('')
        setFingerprint(null)
      }
      await notes.refetch()
    }
  })

  const folderCategories = knowledgeCategories.filter((item) => item.id !== 'all')
  const allCategoriesSelected = folderCategories.length > 0 && folderCategories.every((item) => selectedCategories.includes(item.label))
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

  const bindProject = useMutation({
    mutationFn: async ({ path, projectId }: { path: string; projectId: string | null }) => {
      const note = path === selectedPath && selected.data
        ? selected.data
        : await getWorkbenchApi().notes.read({ vaultId: activeProfile!.id, relativePath: path })
      // If the selected note has a draft, bind against that draft so the
      // metadata write does not silently discard edits made in the editor.
      const sourceContent = path === selectedPath && dirty ? content : note.content ?? ''
      const sourceFingerprint = path === selectedPath && dirty ? fingerprint : note.fingerprint
      const nextContent = upsertNoteMetadata(sourceContent, projectId, note.tags)
      return getWorkbenchApi().notes.write({ vaultId: activeProfile!.id, relativePath: path, content: nextContent, expectedFingerprint: sourceFingerprint })
    },
    onSuccess: async (note) => {
      if (note.relativePath === selectedPath) {
        setContent(note.content ?? '')
        setFingerprint(note.fingerprint)
        setDirty(false)
      }
      setNoteMenu(null)
      await notes.refetch()
    }
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
    setSelectedPaths((current) => {
      if (allVisibleSelected) return current.filter((path) => !visiblePaths.includes(path))
      return [...new Set([...current, ...visiblePaths])]
    })
  }

  const toggleAllCategories = () => setSelectedCategories((current) => allCategoriesSelected ? [] : folderCategories.map((item) => item.label))
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
        {vaultPlan && vaultPlan.categories.some((item) => !vaultPlan.existingPaths.some((path) => path.toLocaleLowerCase('en-US') === item.relativePath.toLocaleLowerCase('en-US'))) ? <section className="research-panel mt-4"><header className="flex min-h-12 items-center gap-3 border-b border-border px-4"><div className="min-w-0 flex-1"><p className="instrument-label">VAULT / INITIALIZE</p><h2 className="text-sm font-bold text-foreground">初始化根目录分类</h2></div><Button disabled={vaultPreview.isFetching || vaultInitialize.isPending} onClick={() => void vaultPreview.refetch()} size="sm" variant="ghost"><RefreshCw aria-hidden="true" className="size-3.5" />重新探测</Button><Button loading={vaultInitialize.isPending} onClick={() => { if (window.confirm('确认在当前 Vault 根目录创建缺失的分类文件夹和 README.md 吗？不会覆盖已有文件。')) vaultInitialize.mutate() }} size="sm" variant="primary">创建缺失分类</Button></header><div className="p-4"><p className="text-xs leading-5 text-muted-foreground">默认分类来自当前 Vault 根目录；项目通过 Markdown frontmatter 的 projectId / labels 隔离。已有文件夹和 README.md 会保留。</p><div className="mt-3 flex flex-wrap gap-2">{vaultPlan.categories.map((item) => { const exists = vaultPlan.existingPaths.some((path) => path.toLocaleLowerCase('en-US') === item.relativePath.toLocaleLowerCase('en-US')); return <span className={`research-tag ${exists ? '' : 'border-primary/40 text-primary'}`} key={item.relativePath}>{item.name}{exists ? ' 已存在' : ' 待创建'}</span> })}</div>{vaultMessage ? <p className="mt-3 text-xs text-muted-foreground" role="status">{vaultMessage}</p> : null}</div></section> : null}
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
            {folderCategories.length > 0 ? <label className="ml-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground"><input aria-label="全选知识库分类" checked={allCategoriesSelected} className="research-checkbox" onChange={toggleAllCategories} type="checkbox" />全选分类</label> : null}
            {selectedCategories.length > 0 ? <Button aria-label="删除选中的知识库分类" disabled={deleteFolders.isPending} loading={deleteFolders.isPending} onClick={() => removeCategories(selectedCategories)} size="sm" variant="danger"><Trash2 aria-hidden="true" className="size-3.5" />删除分类</Button> : null}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">分类删除只处理 Vault 根目录下的空文件夹；含有文件的分类会被安全拒绝，请先在文件树中批量删除或移动内容。</p>
        </section>
        <div className={`obsidian-workspace mt-4 grid min-h-0 gap-4 ${leftCollapsed ? 'obsidian-left-collapsed' : ''} ${rightCollapsed ? 'obsidian-right-collapsed' : ''}`}>
          <section className={`${leftCollapsed ? 'hidden' : ''} obsidian-tree-panel research-panel min-w-0`}>
            <header className="flex min-h-12 items-center gap-2 border-b border-border px-3"><FolderOpen aria-hidden="true" className="size-4 text-primary" /><h2 className="flex-1 text-sm font-bold text-foreground">Vault 文件树</h2><Button aria-label={leftCollapsed ? '展开文件树' : '折叠文件树'} onClick={() => setLeftCollapsed((value) => !value)} size="icon" variant="ghost">{leftCollapsed ? <PanelLeftOpen aria-hidden="true" className="size-4" /> : <PanelLeftClose aria-hidden="true" className="size-4" />}</Button></header>
            <div className="border-b border-border p-2"><label><span className="sr-only">搜索 Vault 文件</span><Input onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件名或标签" value={query} /></label></div>
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs">
              <label className="inline-flex min-w-0 items-center gap-2 text-muted-foreground">
                <input aria-label="全选当前结果" checked={allVisibleSelected} className="research-checkbox" disabled={visiblePaths.length === 0} onChange={toggleAllVisible} type="checkbox" />
                <span>全选当前结果</span>
              </label>
              <span className="shrink-0 text-[11px] text-muted-foreground">{selectedPaths.length > 0 ? `已选 ${selectedPaths.length}` : `${visiblePaths.length} 个结果`}</span>
            </div>
            {notes.isFetching && notes.data ? <div className="px-3 py-2"><InlineLoadingState label="正在更新索引…" /></div> : null}
            {notes.isLoading ? <PanelSkeleton lines={6} /> : null}
            {notes.error ? <div className="p-3"><ErrorState compact error={notes.error} onRetry={() => void notes.refetch()} /><p className="mt-2 text-xs text-muted-foreground">索引不可用时不会覆盖已有列表；请检查设置中的 Vault 路径和权限后重试。</p></div> : null}
            {!notes.isLoading && !notes.error && visibleNotes?.length === 0 ? <p className="research-empty-inline">当前目录没有匹配的 Markdown 文件或文件夹。</p> : null}
            <div className="obsidian-tree-scroll p-2"><TreeBranch node={createTree(visibleNotes ?? [])} onContextMenu={(path, event) => { event.preventDefault(); selectPath(path); setNoteMenu({ path, x: event.clientX, y: event.clientY }) }} onSelect={selectPath} onToggle={(path) => setSelectedPaths((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path])} selectedPaths={selectedPaths} selectedPath={selectedPath} root /></div>
          </section>
          <section className="obsidian-editor-panel research-panel min-w-0">
            <header className="flex min-h-12 items-center justify-between gap-3 border-b border-border px-4"><div className="min-w-0 flex-1"><p className="instrument-label">MARKDOWN / {editorMode === 'preview' ? 'PREVIEW' : 'EDITOR'}</p><h2 className="truncate text-sm font-bold text-foreground">{selected.data?.title ?? selectedPath ?? '请选择文件'}</h2></div><div className="obsidian-editor-actions flex shrink-0 items-center gap-2"><Button onClick={() => setEditorMode((mode) => mode === 'preview' ? 'edit' : 'preview')} size="sm" variant="secondary">{editorMode === 'preview' ? '编辑' : '预览'}</Button><Button aria-label={leftCollapsed ? '展开文件树' : '折叠文件树'} onClick={() => setLeftCollapsed((value) => !value)} size="icon" variant="ghost">{leftCollapsed ? <PanelLeftOpen aria-hidden="true" className="size-4" /> : <PanelLeftClose aria-hidden="true" className="size-4" />}</Button><Button aria-label={rightCollapsed ? '展开属性面板' : '折叠属性面板'} onClick={() => setRightCollapsed((value) => !value)} size="icon" variant="ghost">{rightCollapsed ? <PanelRightOpen aria-hidden="true" className="size-4" /> : <PanelRightClose aria-hidden="true" className="size-4" />}</Button><Button disabled={selectedPaths.length === 0} loading={deleteNotes.isPending} onClick={() => { if (window.confirm(`确认删除 ${selectedPaths.length} 个 Markdown 文件？此操作不可撤回。`)) deleteNotes.mutate(selectedPaths) }} size="sm" variant="ghost"><Trash2 aria-hidden="true" className="size-3.5" />删除选中</Button><Button onClick={beginCreate} size="sm"><Plus aria-hidden="true" className="size-3.5" />新建{activeCategory === 'all' ? '笔记' : category.label}</Button><Button disabled={!dirty || !selectedPath} loading={save.isPending} onClick={() => selectedPath && save.mutate({ path: selectedPath, content, fingerprint, generation: saveGeneration.current })} size="sm" variant="primary"><Save aria-hidden="true" className="size-3.5" />保存</Button></div></header>
            {selected.isFetching && selected.data ? <div className="border-b border-border px-4 py-2"><InlineLoadingState label="正在更新笔记…" /></div> : null}{selected.isLoading ? <PanelSkeleton lines={5} /> : null}{selected.error ? <div className="p-4"><ErrorState error={selected.error} onRetry={() => void selected.refetch()} /></div> : null}
            {createMode ? <form className="grid gap-3 p-4" onSubmit={(event) => { event.preventDefault(); const error = relativePathError(newPath); setNewPathError(error); if (!error && !create.isPending) create.mutate() }}><label className="grid gap-1.5"><span className="text-xs font-semibold">Markdown 相对路径</span><Input aria-invalid={Boolean(newPathError)} onChange={(event) => { setNewPath(event.target.value); setNewPathError(null) }} placeholder="例如：文献综述/新建笔记.md" value={newPath} /></label><p className="text-xs text-muted-foreground">仅接受 Vault 内的 .md 文件；服务端还会检查 .obsidian、.git、临时文件和链接越界。</p>{newPathError ? <p className="form-feedback form-feedback-error" role="alert">{newPathError}</p> : null}{create.error ? <p className="form-feedback form-feedback-error" role="alert">{getErrorMessage(create.error)}</p> : null}<div className="flex gap-2"><Button loading={create.isPending} type="submit" variant="primary"><Plus aria-hidden="true" className="size-4" />创建笔记</Button><Button onClick={() => setCreateMode(false)} type="button" variant="ghost">取消</Button></div></form> : null}
            {!createMode && !selected.data && !selected.isLoading && !selected.error ? <div className="obsidian-editor-empty" role="status"><FileText aria-hidden="true" className="size-7 text-primary" /><p className="mt-2 text-sm font-semibold text-foreground">从左侧选择一个 Markdown 文件</p><p className="mt-1 text-xs text-muted-foreground">文件夹可以直接展开；初始化只在你确认后创建缺失分类。</p></div> : null}
            {!createMode && selected.data ? editorMode === 'preview' ? <div className="obsidian-editor-content flex min-h-[34rem] flex-1 flex-col"><div className="border-b border-border px-4 py-2"><p className="instrument-label">LIVE PREVIEW</p><p className="text-[11px] text-muted-foreground">预览模式占满主编辑区。</p></div><div className="min-h-0 flex-1 overflow-auto"><MarkdownPreview source={content} /></div></div> : <div className="obsidian-editor-content flex min-h-[34rem] flex-1 flex-col"><div className="border-b border-border px-4 py-2"><p className="instrument-label">EDIT</p><p className="text-[11px] text-muted-foreground">停止输入 0.8 秒自动保存；Ctrl+S 可立即保存。</p></div><textarea aria-label="Markdown 内容" className="markdown-editor min-h-0 flex-1 w-full resize-none" onChange={(event) => { saveGeneration.current += 1; setContent(event.target.value); setDirty(true); setConflictReloaded(false); if (save.error) save.reset() }} value={content} /></div> : null}
            {save.error ? <div className="m-3 rounded-md border border-danger/30 bg-danger-subtle p-3 text-xs" role="alert"><p className="font-semibold text-danger">{isConflictError(save.error) ? '文件发生外部修改，未覆盖外部内容。' : getErrorMessage(save.error)}</p>{isConflictError(save.error) ? <div className="mt-2 flex flex-wrap items-center gap-2"><Button loading={selected.isFetching} onClick={() => void reloadAfterConflict()} size="sm" variant="primary">重新读取最新版本</Button><span className="text-muted-foreground">重新读取会放弃当前草稿并更新 expectedFingerprint。</span></div> : <p className="mt-1 text-muted-foreground">请检查 Vault 状态后重试。</p>}</div> : null}
            {!save.error && conflictReloaded ? <p className="form-feedback m-3 text-success" role="status">已重新读取最新版本并更新 expectedFingerprint；请确认内容后再编辑。</p> : null}
          </section>
          <aside className={`${rightCollapsed ? 'hidden' : ''} obsidian-inspector-panel research-panel`}>
            <header className="flex min-h-12 items-center gap-2 border-b border-border px-4 py-3"><div className="min-w-0 flex-1"><p className="instrument-label">INSPECTOR / NOTE</p><h2 className="mt-0.5 text-sm font-bold text-foreground">属性</h2></div><Button aria-label={rightCollapsed ? '展开属性面板' : '折叠属性面板'} onClick={() => setRightCollapsed((value) => !value)} size="icon" variant="ghost">{rightCollapsed ? <PanelRightOpen aria-hidden="true" className="size-4" /> : <PanelRightClose aria-hidden="true" className="size-4" />}</Button></header>
            {selected.data ? <dl className="grid gap-3 p-4 text-xs"><div><dt className="text-muted-foreground">相对路径</dt><dd className="mt-1 break-all font-mono text-foreground">{selected.data.relativePath}</dd></div><div><dt className="text-muted-foreground">标签</dt><dd className="mt-1 text-foreground">{selected.data.tags.join('、') || '无标签'}</dd></div><div><dt className="text-muted-foreground">修改时间</dt><dd className="mt-1 text-foreground">{formatDateTime(selected.data.updatedAt)}</dd></div><div><dt className="text-muted-foreground">版本校验</dt><dd className="mt-1 text-foreground">{dirty ? '草稿未保存，保存时要求 expectedFingerprint' : '已载入文件指纹'}</dd></div><div><dt className="text-muted-foreground">状态</dt><dd className="mt-1 text-foreground">{dirty ? '有未保存修改' : '已读取'}</dd></div></dl> : <p className="research-empty-inline">选择一个 Markdown 文件查看属性。</p>}
            {selected.data ? <div className="border-t border-border p-4"><label className="grid gap-1.5"><span className="text-xs font-semibold text-muted-foreground">项目标签 / 绑定项目</span><select className="select-control" disabled={bindProject.isPending} onChange={(event) => bindProject.mutate({ path: selected.data!.relativePath, projectId: event.target.value === 'none' ? null : event.target.value })} value={selected.data.tags.find((tag) => tag.startsWith('project:'))?.slice('project:'.length) ?? 'none'}><option value="none">不绑定项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><p className="mt-2 text-[11px] text-muted-foreground">绑定会更新 Markdown frontmatter 的 projectId 与 tags；保存前仍会校验指纹。</p>{bindProject.error ? <p className="mt-2 text-xs text-danger" role="alert">{getErrorMessage(bindProject.error)}</p> : null}</div> : null}
          </aside>
        </div>
        {noteMenu ? <div className="fixed z-50 min-w-52 rounded-md border border-border bg-surface p-1 shadow-lg" onClick={(event) => event.stopPropagation()} style={{ left: noteMenu.x, top: noteMenu.y }}><p className="px-2 py-1 text-[11px] text-muted-foreground">{noteMenu.path}</p><button className="context-menu-item w-full" onClick={() => { setSelectedPaths((current) => current.includes(noteMenu.path) ? current.filter((item) => item !== noteMenu.path) : [...current, noteMenu.path]); setNoteMenu(null) }} type="button">{selectedPaths.includes(noteMenu.path) ? '取消选择' : '加入选择'}</button><button className="context-menu-item w-full" onClick={() => { if (activeProfile) void getWorkbenchApi().system.revealPath({ vaultId: activeProfile.id, relativePath: noteMenu.path }); setNoteMenu(null) }} type="button">在资源管理器中查看</button><button className="context-menu-item w-full text-danger" disabled={deleteNotes.isPending} onClick={() => { if (window.confirm('确认直接删除此 Markdown 文件？')) deleteNotes.mutate([noteMenu.path]) }} type="button">直接删除</button><div className="my-1 border-t border-border" /><p className="px-2 py-1 text-[11px] text-muted-foreground">绑定项目</p><button className="context-menu-item w-full" onClick={() => bindProject.mutate({ path: noteMenu.path, projectId: null })} type="button">取消项目绑定</button>{projects.map((project) => <button className="context-menu-item w-full" key={project.id} onClick={() => bindProject.mutate({ path: noteMenu.path, projectId: project.id })} type="button">绑定：{project.name}</button>)}</div> : null}
        </>
      )}
    </div>
  )
}
