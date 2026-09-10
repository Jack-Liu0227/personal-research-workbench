import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ProjectIdSchema, type ArtifactKind, type Project, type ResearchArtifact } from '@prw/contracts'
import {
  FilePlus2,
  FileText,
  Save
} from 'lucide-react'
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import { EmptyState, ErrorState, PageHeader } from '../../components/states'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
  Field,
  Input
} from '../../components/ui'
import { cn, formatDateTime } from '../../lib/utils'
import { getWorkbenchApi } from '../../lib/workbench'
import { useArtifactsQuery } from '../queries'
import { MutationFeedback, ResearchPanel, ResearchTabs, StatusBadge } from './shared'
import { MarkdownEditor } from '../../components/markdown-editor'

type WritingKind = Extract<ArtifactKind, 'research_idea' | 'research_plan' | 'literature_review' | 'outline' | 'manuscript'>

const kindLabels: Record<WritingKind, string> = {
  research_idea: '研究想法',
  research_plan: '研究方案',
  literature_review: '文献综述',
  outline: '论文大纲',
  manuscript: '论文文本'
}

const writingKinds = Object.keys(kindLabels) as WritingKind[]

function CreateArtifactDialog({ projects, defaultKind, onCreated }: {
  projects: Project[]
  defaultKind: WritingKind
  onCreated: (artifact: ResearchArtifact) => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<WritingKind>(defaultKind)
  const [projectId, setProjectId] = useState('')
  const [attempted, setAttempted] = useState(false)
  const titleId = useId()
  const kindId = useId()
  const projectIdField = useId()

  useEffect(() => {
    if (open) setKind(defaultKind)
  }, [defaultKind, open])

  const mutation = useMutation({
    mutationFn: () => getWorkbenchApi().artifacts.create({
      projectId: projectId ? ProjectIdSchema.parse(projectId) : null,
      kind,
      title: title.trim(),
      content: '',
      sourcePaperIds: [],
      citations: [],
      status: 'draft'
    }),
    onSuccess: async (artifact) => {
      await queryClient.invalidateQueries({ queryKey: ['artifacts'] })
      onCreated(artifact)
      setTitle('')
      setAttempted(false)
      setOpen(false)
    }
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setAttempted(true)
    if (!title.trim()) {
      document.getElementById(titleId)?.focus()
      return
    }
    if (mutation.isPending) return
    mutation.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => {
      setOpen(next)
      if (!next) mutation.reset()
    }}>
      <DialogTrigger asChild>
        <Button variant="primary"><FilePlus2 aria-hidden="true" className="size-4" />新建文档</Button>
      </DialogTrigger>
      <DialogContent description="创建后在 Markdown 编辑区中继续写作。" title="新建科研文档">
        <form className="grid gap-4" onSubmit={submit}>
          <Field error={attempted && !title.trim() ? '请填写文档标题。' : undefined} htmlFor={titleId} label="标题">
            <Input autoFocus id={titleId} maxLength={500} onChange={(event) => setTitle(event.target.value)} value={title} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field htmlFor={kindId} label="文档类型">
              <select className="select-control" id={kindId} onChange={(event) => setKind(event.target.value as WritingKind)} value={kind}>
                {writingKinds.map((item) => <option key={item} value={item}>{kindLabels[item]}</option>)}
              </select>
            </Field>
            <Field htmlFor={projectIdField} label="所属项目">
              <select className="select-control" id={projectIdField} onChange={(event) => setProjectId(event.target.value)} value={projectId}>
                <option value="">未分配项目</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </Field>
          </div>
          <MutationFeedback error={mutation.error} />
          <div className="flex justify-end gap-2">
            <DialogClose asChild><Button type="button" variant="ghost">取消</Button></DialogClose>
            <Button loading={mutation.isPending} type="submit" variant="primary">创建并开始写作</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ArtifactList({ artifacts, selectedId, onSelect }: {
  artifacts: ResearchArtifact[]
  selectedId: string | null
  onSelect: (artifact: ResearchArtifact) => void
}): React.JSX.Element {
  if (artifacts.length === 0) return <p className="research-empty-inline">当前类型还没有文档。</p>
  return (
    <div className="divide-y divide-border">
      {artifacts.map((artifact) => (
        <button
          aria-current={artifact.id === selectedId ? 'true' : undefined}
          className={cn('artifact-list-item', artifact.id === selectedId && 'artifact-list-item-active')}
          key={artifact.id}
          onClick={() => onSelect(artifact)}
          type="button"
        >
          <FileText aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-xs font-bold text-foreground">{artifact.title}</span>
            <span className="mt-1 block text-[10px] text-muted-foreground">{formatDateTime(artifact.updatedAt)}</span>
          </span>
          <StatusBadge status={artifact.status} />
        </button>
      ))}
    </div>
  )
}

export function WritingWorkbenchPage({ projects }: { projects: Project[] }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<WritingKind>('research_idea')
  const [projectFilter, setProjectFilter] = useState('')
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [status, setStatus] = useState<ResearchArtifact['status']>('draft')
  const [dirty, setDirty] = useState(false)
  const artifactFilter = useMemo(() => ({
    kind,
    ...(projectFilter ? { projectId: projectFilter } : {})
  }), [kind, projectFilter])
  const artifactsQuery = useArtifactsQuery(artifactFilter)
  const selectedArtifact = artifactsQuery.data?.find((artifact) => artifact.id === selectedArtifactId) ?? null

  useEffect(() => {
    const first = artifactsQuery.data?.[0]
    if (!selectedArtifactId && first) setSelectedArtifactId(first.id)
    if (selectedArtifactId && artifactsQuery.data && !artifactsQuery.data.some((artifact) => artifact.id === selectedArtifactId)) {
      setSelectedArtifactId(first?.id ?? null)
    }
  }, [artifactsQuery.data, selectedArtifactId])

  useEffect(() => {
    if (!selectedArtifact) return
    setTitle(selectedArtifact.title)
    setContent(selectedArtifact.content)
    setStatus(selectedArtifact.status)
    setDirty(false)
  }, [selectedArtifact])

  const saveMutation = useMutation({
    mutationFn: () => getWorkbenchApi().artifacts.update({
      id: selectedArtifact!.id,
      title: title.trim(),
      content,
      status,
      expectedRevision: selectedArtifact!.revision
    }),
    onSuccess: async () => {
      setDirty(false)
      await queryClient.invalidateQueries({ queryKey: ['artifacts'] })
    }
  })


  const selectArtifact = (artifact: ResearchArtifact) => {
    if (dirty && !window.confirm('当前修改尚未保存，确定切换文档吗？')) return
    setSelectedArtifactId(artifact.id)
  }

  const switchKind = (nextKind: WritingKind) => {
    if (dirty && !window.confirm('当前修改尚未保存，确定切换类型吗？')) return
    setKind(nextKind)
    setSelectedArtifactId(null)
  }

  const changeProjectFilter = (nextProjectId: string) => {
    if (dirty && !window.confirm('当前修改尚未保存，确定切换项目筛选吗？')) return
    setProjectFilter(nextProjectId)
    setSelectedArtifactId(null)
  }

  return (
    <div className="page-scroll">
      <PageHeader
        actions={(
          <>
            <label>
              <span className="sr-only">按项目筛选文档</span>
              <select className="select-control min-w-44" onChange={(event) => changeProjectFilter(event.target.value)} value={projectFilter}>
                <option value="">全部项目</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
            <CreateArtifactDialog defaultKind={kind} onCreated={(artifact) => {
              setKind(artifact.kind as WritingKind)
              setSelectedArtifactId(artifact.id)
            }} projects={projects} />
          </>
        )}
        description="把研究想法、方案、证据与论文草稿放在同一条可追溯的写作链上。"
        eyebrow="AI4S / WRITING"
        title="科研思路与写作工作台"
      />

      <div className="mt-4">
        <ResearchTabs
          items={writingKinds.map((item) => ({ value: item, label: kindLabels[item] }))}
          label="文档类型"
          onChange={switchKind}
          value={kind}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[14rem_minmax(24rem,1fr)]">
        <ResearchPanel className="min-w-0" eyebrow="ARTIFACTS / FILES" title={kindLabels[kind]}>
          {artifactsQuery.isLoading ? <p className="research-empty-inline">正在读取文档…</p> : null}
          {artifactsQuery.error ? <div className="p-3"><ErrorState compact error={artifactsQuery.error} onRetry={() => void artifactsQuery.refetch()} /></div> : null}
          {artifactsQuery.data ? <ArtifactList artifacts={artifactsQuery.data} onSelect={selectArtifact} selectedId={selectedArtifactId} /> : null}
        </ResearchPanel>

        <ResearchPanel
          action={selectedArtifact ? (
            <div className="flex items-center gap-2">
              {dirty ? <span className="text-[11px] font-semibold text-accent">有未保存修改</span> : <span className="text-[11px] text-muted-foreground">已保存</span>}
              <Button disabled={!dirty || !title.trim()} loading={saveMutation.isPending} onClick={() => saveMutation.mutate()} size="sm" variant="primary"><Save aria-hidden="true" className="size-3.5" />保存</Button>
            </div>
          ) : null}
          className="min-w-0"
          eyebrow="MARKDOWN / EDITOR"
          title="Markdown 编辑器"
        >
          {!selectedArtifact && !artifactsQuery.isLoading ? (
            <div className="p-4"><EmptyState description="新建文档后，可在这里编辑 Markdown 内容。" title="请选择或新建文档" /></div>
          ) : null}
          {selectedArtifact ? (
            <div className="grid min-h-[34rem] grid-rows-[auto_1fr_auto]">
              <div className="grid gap-3 border-b border-border p-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
                <label>
                  <span className="sr-only">文档标题</span>
                  <Input maxLength={500} onChange={(event) => { setTitle(event.target.value); setDirty(true) }} value={title} />
                </label>
                <label>
                  <span className="sr-only">文档状态</span>
                  <select className="select-control" onChange={(event) => { setStatus(event.target.value as ResearchArtifact['status']); setDirty(true) }} value={status}>
                    <option value="draft">草稿</option>
                    <option value="review">待审阅</option>
                    <option value="final">已定稿</option>
                    <option value="archived">已归档</option>
                  </select>
                </label>
              </div>
              <div className="min-h-0">
                <MarkdownEditor onChange={(next) => { setContent(next); setDirty(true) }} placeholder="# 研究问题\n\n从可验证的命题开始…" value={content} />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
                <span className="font-mono">Markdown · {content.length.toLocaleString('zh-CN')} 字符</span>
                <span>更新于 {formatDateTime(selectedArtifact.updatedAt)}</span>
              </div>
              <MutationFeedback error={saveMutation.error} success={saveMutation.isSuccess && !dirty ? '文档已保存。' : undefined} />
            </div>
          ) : null}
        </ResearchPanel>

      </div>
    </div>
  )
}
