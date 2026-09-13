import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PaperIdSchema, ProjectIdSchema, type LiteratureMatrixEntry, type Paper, type Project } from '@prw/contracts'
import { Edit3, Plus, Save, Trash2 } from 'lucide-react'
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import { SelectionBar } from '../../components/selection'
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../../components/states'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
  Field,
  Textarea
} from '../../components/ui'
import { getWorkbenchApi } from '../../lib/workbench'
import { useMatrixQuery, usePapersQuery } from '../queries'
import { MutationFeedback, ResearchPanel } from './shared'

function MatrixEditorDialog({
  entry,
  papers,
  trigger,
  onSaved
}: {
  entry: LiteratureMatrixEntry | null
  papers: Paper[]
  trigger: React.ReactElement
  onSaved?: () => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [paperId, setPaperId] = useState('')
  const [researchQuestion, setResearchQuestion] = useState('')
  const [method, setMethod] = useState('')
  const [data, setData] = useState('')
  const [keyFindings, setKeyFindings] = useState('')
  const [limitations, setLimitations] = useState('')
  const [evidence, setEvidence] = useState('')
  const [relevance, setRelevance] = useState('')
  const [quality, setQuality] = useState('0')
  const [attempted, setAttempted] = useState(false)
  const paperIdField = useId()
  const questionId = useId()
  const methodId = useId()
  const dataId = useId()
  const findingsId = useId()
  const limitationsId = useId()
  const evidenceId = useId()
  const relevanceId = useId()
  const qualityId = useId()
  const qualityScore = Number(quality)
  const invalidQuality = quality === '' || !Number.isInteger(qualityScore) || qualityScore < 0 || qualityScore > 100

  useEffect(() => {
    if (!open) return
    setPaperId(entry?.paperId ?? papers[0]?.id ?? '')
    setResearchQuestion(entry?.researchQuestion ?? '')
    setMethod(entry?.method ?? '')
    setData(entry?.data ?? '')
    setKeyFindings(entry?.keyFindings ?? '')
    setLimitations(entry?.limitations ?? '')
    setEvidence(entry?.evidence ?? '')
    setRelevance(entry?.relevance ?? '')
    setQuality(String(entry?.qualityScore ?? 0))
    setAttempted(false)
  }, [entry, open, papers])

  const mutation = useMutation({
    mutationFn: () => getWorkbenchApi().matrix.upsert({
      paperId: PaperIdSchema.parse(paperId),
      researchQuestion: researchQuestion.trim(),
      method: method.trim(),
      data: data.trim(),
      keyFindings: keyFindings.trim(),
      limitations: limitations.trim(),
      evidence: evidence.trim(),
      relevance: relevance.trim(),
      qualityScore,
      customFields: entry?.customFields ?? {},
      expectedRevision: entry?.revision ?? null
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['matrix'] })
      setOpen(false)
      onSaved?.()
    }
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setAttempted(true)
    if (!paperId) {
      document.getElementById(paperIdField)?.focus()
      return
    }
    if (invalidQuality) {
      document.getElementById(qualityId)?.focus()
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
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        className="max-h-[90dvh] w-[min(95vw,58rem)] overflow-y-auto"
        description="将论文的问题、方法与证据拆成可比较字段。"
        title={entry ? '编辑文献矩阵' : '新建矩阵条目'}
      >
        <form className="grid gap-4" onSubmit={submit}>
          <Field error={attempted && !paperId ? '请选择文献。' : undefined} htmlFor={paperIdField} label="文献">
            <select className="select-control" disabled={Boolean(entry)} id={paperIdField} onChange={(event) => setPaperId(event.target.value)} value={paperId}>
              {papers.length === 0 ? <option value="">文献库为空</option> : null}
              {papers.map((paper) => <option key={paper.id} value={paper.id}>{paper.title}</option>)}
            </select>
          </Field>
          <div className="grid gap-4 lg:grid-cols-2">
            <Field htmlFor={questionId} label="研究问题">
              <Textarea id={questionId} maxLength={20000} onChange={(event) => setResearchQuestion(event.target.value)} value={researchQuestion} />
            </Field>
            <Field htmlFor={methodId} label="方法">
              <Textarea id={methodId} maxLength={20000} onChange={(event) => setMethod(event.target.value)} value={method} />
            </Field>
            <Field htmlFor={dataId} label="数据 / 材料">
              <Textarea id={dataId} maxLength={20000} onChange={(event) => setData(event.target.value)} value={data} />
            </Field>
            <Field htmlFor={findingsId} label="关键发现">
              <Textarea id={findingsId} maxLength={40000} onChange={(event) => setKeyFindings(event.target.value)} value={keyFindings} />
            </Field>
            <Field htmlFor={limitationsId} label="局限">
              <Textarea id={limitationsId} maxLength={20000} onChange={(event) => setLimitations(event.target.value)} value={limitations} />
            </Field>
            <Field htmlFor={evidenceId} label="证据摘录">
              <Textarea id={evidenceId} maxLength={40000} onChange={(event) => setEvidence(event.target.value)} value={evidence} />
            </Field>
            <Field htmlFor={relevanceId} label="与当前项目的关联">
              <Textarea id={relevanceId} maxLength={20000} onChange={(event) => setRelevance(event.target.value)} value={relevance} />
            </Field>
            <Field error={attempted && invalidQuality ? '质量分必须是 0–100 的整数。' : undefined} htmlFor={qualityId} label="质量分（0–100）">
              <input className="select-control" id={qualityId} max="100" min="0" onChange={(event) => setQuality(event.target.value)} type="number" value={quality} />
            </Field>
          </div>
          <MutationFeedback error={mutation.error} />
          <div className="flex justify-end gap-2">
            <DialogClose asChild><Button type="button" variant="ghost">取消</Button></DialogClose>
            <Button loading={mutation.isPending} type="submit" variant="primary"><Save aria-hidden="true" className="size-4" />保存矩阵</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function MatrixCell({ value, fallback = '未填写' }: { value: string; fallback?: string }): React.JSX.Element {
  return (
    <td className="matrix-cell">
      <p className={value ? 'line-clamp-4' : 'text-muted-foreground'} title={value || fallback}>{value || fallback}</p>
    </td>
  )
}

export function LiteratureMatrixPage({ projects, embedded = false }: { projects: Project[]; embedded?: boolean }): React.JSX.Element {
  const [projectId, setProjectId] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [deleteFeedback, setDeleteFeedback] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const matrixQuery = useMatrixQuery(projectId || null)
  const paperFilter = useMemo(() => projectId ? { projectId: ProjectIdSchema.parse(projectId) } : {}, [projectId])
  const papersQuery = usePapersQuery(paperFilter)
  const paperMap = new Map((papersQuery.data ?? []).map((paper) => [paper.id, paper]))
  const availablePapers = papersQuery.data ?? []
  const mappedPaperIds = new Set((matrixQuery.data ?? []).map((entry) => entry.paperId))
  const unmappedPapers = availablePapers.filter((paper) => !mappedPaperIds.has(paper.id))
  const entries = matrixQuery.data ?? []
  const allSelected = entries.length > 0 && entries.every((entry) => selectedIds.has(entry.id))
  // The matrix list is loaded in full for the active project filter, so "全选"
  // can honestly cover every row of the current filter — and the bar says which
  // filter that is instead of implying the whole library is selected.
  const projectFilterLabel = projectId ? projects.find((project) => project.id === projectId)?.name ?? '已失效项目' : '全部项目'

  useEffect(() => {
    const available = new Set(entries.map((entry) => entry.id))
    setSelectedIds((current) => new Set([...current].filter((id) => available.has(id))))
  }, [matrixQuery.data])

  const deleteMutation = useMutation({
    mutationFn: (ids: string[]) => {
      const byId = new Map(entries.map((entry) => [entry.id, entry]))
      return getWorkbenchApi().matrix.bulkDelete({
        items: ids.flatMap((id) => {
          const entry = byId.get(id)
          return entry ? [{ id: entry.id, expectedRevision: entry.revision }] : []
        })
      })
    },
    onSuccess: async (result) => {
      setSelectedIds(new Set())
      setDeleteFeedback(result.failed > 0 ? `已删除 ${result.succeeded} 条；${result.failed} 条因修订冲突未删除，请刷新后重试。` : `已删除 ${result.succeeded} 条矩阵记录。`)
      await queryClient.invalidateQueries({ queryKey: ['matrix'] })
    },
    onError: (error) => setDeleteFeedback(error instanceof Error ? error.message : '矩阵删除失败，请刷新后重试。')
  })

  const toggleAll = () => setSelectedIds((current) => allSelected
    ? new Set([...current].filter((id) => !entries.some((entry) => entry.id === id)))
    : new Set([...current, ...entries.map((entry) => entry.id)]))
  const removeSelected = (ids: string[]) => {
    if (ids.length === 0 || deleteMutation.isPending) return
    if (!window.confirm(`确认永久删除 ${ids.length} 条文献矩阵记录？此操作不可撤销，原文献不会被删除。`)) return
    deleteMutation.mutate(ids)
  }

  return (
    // `embedded` keeps the page's own scroll container out of a host page that
    // already scrolls (Project Space), which otherwise nests two vertical
    // scrollers and steals the wheel from the outer page.
    <div className={embedded ? 'matrix-embedded' : 'page-scroll'}>
      <PageHeader
        actions={(
          <div className="flex items-center gap-2">
            <label>
              <span className="sr-only">按项目筛选矩阵</span>
              <select className="select-control min-w-44" onChange={(event) => setProjectId(event.target.value)} value={projectId}>
                <option value="">全部项目</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
            <MatrixEditorDialog
              entry={null}
              papers={unmappedPapers}
              trigger={<Button disabled={matrixQuery.isLoading || Boolean(matrixQuery.error) || unmappedPapers.length === 0} title={availablePapers.length > 0 && unmappedPapers.length === 0 ? '当前文献已全部进入矩阵' : undefined} variant="primary"><Plus aria-hidden="true" className="size-4" />新建条目</Button>}
            />
          </div>
        )}
        description="用统一字段比较问题、方法、数据、发现与局限，保留人工评估。"
        eyebrow="EVIDENCE / MATRIX"
        title="文献矩阵"
      />
      <div className="mt-4">
        <ResearchPanel
          action={(
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">{entries.length} 条证据记录</span>
            </div>
          )}
          eyebrow="COMPARE / EVIDENCE"
          title="结构化比较"
        >
          <div className="px-4 pt-3">
            <SelectionBar
              allSelected={allSelected}
              disabled={entries.length === 0}
              indeterminate={selectedIds.size > 0 && !allSelected}
              label="文献矩阵选择"
              onClear={() => setSelectedIds(new Set())}
              onToggleAll={toggleAll}
              scope={`范围：${projectFilterLabel}下的全部 ${entries.length} 条矩阵记录（无分页）；删除为永久操作，不会删除原文献`}
              selectAllLabel="全选矩阵条目"
              selectedCount={selectedIds.size}
              totalCount={entries.length}
            >
              <Button aria-label={`删除选中的 ${selectedIds.size} 条矩阵记录`} disabled={selectedIds.size === 0 || deleteMutation.isPending} loading={deleteMutation.isPending} onClick={() => removeSelected([...selectedIds])} size="sm" variant="danger"><Trash2 aria-hidden="true" className="size-3.5" />删除选中</Button>
            </SelectionBar>
          </div>
          {matrixQuery.isLoading || papersQuery.isLoading ? <div className="p-4"><LoadingState label="正在组装文献矩阵…" /></div> : null}
          {matrixQuery.error ? <div className="p-4"><ErrorState error={matrixQuery.error} onRetry={() => void matrixQuery.refetch()} /></div> : null}
          {papersQuery.error ? <div className="p-4"><ErrorState error={papersQuery.error} onRetry={() => void papersQuery.refetch()} /></div> : null}
          {deleteFeedback ? <p className="form-feedback px-4 py-2" role="status">{deleteFeedback}</p> : null}
          {matrixQuery.data?.length === 0 ? (
            <div className="p-4">
              <EmptyState
                description={availablePapers.length === 0 ? '请先在文献库中新建或同步文献。' : '从一篇文献开始，提取可比较的问题、方法和证据。'}
                title="当前范围还没有矩阵条目"
              />
            </div>
          ) : null}
          {matrixQuery.data && matrixQuery.data.length > 0 ? (
            <div className="matrix-scroll" tabIndex={0} aria-label="文献矩阵表格，可水平滚动">
              <table className="matrix-table">
                <thead>
                  <tr>
                    <th className="w-10" scope="col"><span className="sr-only">选择</span></th>
                    <th scope="col">文献</th>
                    <th scope="col">研究问题</th>
                    <th scope="col">方法</th>
                    <th scope="col">数据</th>
                    <th scope="col">关键发现</th>
                    <th scope="col">局限</th>
                    <th scope="col">质量</th>
                    <th scope="col"><span className="sr-only">操作</span></th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => {
                    const paper = paperMap.get(entry.paperId)
                    return (
                      <tr key={entry.id}>
                        <td className="w-10 px-2 text-center">
                          <input aria-label={`选择矩阵：${paper?.title ?? entry.paperId}`} checked={selectedIds.has(entry.id)} className="research-checkbox" onChange={() => setSelectedIds((current) => {
                            const next = new Set(current)
                            next.has(entry.id) ? next.delete(entry.id) : next.add(entry.id)
                            return next
                          })} type="checkbox" />
                        </td>
                        <th className="matrix-paper-cell" scope="row">
                          <p className="line-clamp-4 overflow-wrap-anywhere" title={paper?.title ?? entry.paperId}>{paper?.title ?? '文献不在当前筛选范围'}</p>
                        </th>
                        <MatrixCell value={entry.researchQuestion} />
                        <MatrixCell value={entry.method} />
                        <MatrixCell value={entry.data} />
                        <MatrixCell value={entry.keyFindings} />
                        <MatrixCell value={entry.limitations} />
                        <td className="matrix-score-cell">
                          <span className="tabular-nums text-lg font-bold text-foreground">{entry.qualityScore}</span>
                          <span className="text-[10px] text-muted-foreground">/100</span>
                        </td>
                        <td className="w-12 px-2 text-center">
                          <div className="flex items-center justify-center gap-1">
                            <MatrixEditorDialog
                              entry={entry}
                              papers={paper ? [paper] : availablePapers}
                              trigger={<Button aria-label={`编辑矩阵：${paper?.title ?? entry.paperId}`} size="icon" variant="ghost"><Edit3 aria-hidden="true" className="size-4" /></Button>}
                            />
                            <Button aria-label={`删除矩阵：${paper?.title ?? entry.paperId}`} disabled={deleteMutation.isPending} onClick={() => removeSelected([entry.id])} size="icon" variant="ghost"><Trash2 aria-hidden="true" className="size-4 text-danger" /></Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </ResearchPanel>
      </div>
    </div>
  )
}
