import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ProjectIdSchema, type Project, type TaskPriority, type TaskStatus } from '@prw/contracts'
import { Check, Plus } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent, type ReactElement } from 'react'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
  Field,
  Input,
  Textarea
} from '../components/ui'
import { getErrorMessage, toEndOfDayIso } from '../lib/utils'
import { getWorkbenchApi } from '../lib/workbench'
import { queryKeys } from './queries'

function useRefreshWorkspace(): () => Promise<void> {
  const queryClient = useQueryClient()
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
      queryClient.invalidateQueries({ queryKey: ['columns'] }),
      queryClient.invalidateQueries({ queryKey: ['calendar'] })
    ])
  }
}

export function CreateProjectDialog({ trigger }: { trigger: ReactElement }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [attempted, setAttempted] = useState(false)
  const nameId = useId()
  const descriptionId = useId()
  const refresh = useRefreshWorkspace()
  const mutation = useMutation({
    mutationFn: () => getWorkbenchApi().projects.create({
      name: name.trim(),
      description: description.trim(),
      startAt: null,
      dueAt: null
    }),
    onSuccess: async () => {
      await refresh()
      setName('')
      setDescription('')
      setAttempted(false)
      setOpen(false)
    }
  })
  const nameError = name.length > 120
    ? '项目名不能超过 120 个字符。'
    : !name.trim() && attempted
      ? '请填写项目名。'
      : undefined

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setAttempted(true)
    if (!name.trim() || name.length > 120 || mutation.isPending) return
    mutation.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => {
      setOpen(next)
      if (!next) {
        mutation.reset()
        setAttempted(false)
      }
    }}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        description="项目是任务、进度与后续文献工作的组织边界。"
        title="建立科研项目"
      >
        <form className="grid gap-4" onSubmit={submit}>
          <Field error={nameError} htmlFor={nameId} label="项目名">
            <Input
              autoFocus
              id={nameId}
              maxLength={121}
              onChange={(event) => {
                setName(event.target.value)
                mutation.reset()
              }}
              placeholder="例如：钙钛矿晶体结构预测"
              value={name}
            />
          </Field>
          <Field htmlFor={descriptionId} label="项目说明" hint="可选，记录目标、范围或阶段性产出。">
            <Textarea
              id={descriptionId}
              maxLength={2000}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="这个项目要解决什么问题？"
              value={description}
            />
          </Field>
          {mutation.error ? <p className="text-xs text-danger" role="alert">{getErrorMessage(mutation.error)}</p> : null}
          <div className="mt-1 flex justify-end gap-2">
            <DialogClose asChild><Button type="button" variant="ghost">取消</Button></DialogClose>
            <Button loading={mutation.isPending} type="submit" variant="primary">
              <Plus aria-hidden="true" className="size-4" />
              创建项目
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function CreateTaskDialog({
  projects,
  defaultProjectId = null,
  defaultColumnId = null,
  defaultStatus,
  trigger,
  open: controlledOpen,
  onOpenChange
}: {
  projects: Project[]
  defaultProjectId?: string | null
  defaultColumnId?: string | null
  defaultStatus?: TaskStatus
  trigger?: ReactElement
  open?: boolean
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const [internalOpen, setInternalOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [projectId, setProjectId] = useState(defaultProjectId ?? '')
  const [columnId, setColumnId] = useState<string | null>(defaultColumnId)
  const [priority, setPriority] = useState<TaskPriority>('normal')
  const [estimate, setEstimate] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [attempted, setAttempted] = useState(false)
  const titleId = useId()
  const notesId = useId()
  const projectIdField = useId()
  const priorityId = useId()
  const estimateId = useId()
  const dueDateId = useId()
  const refresh = useRefreshWorkspace()
  const open = controlledOpen ?? internalOpen
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next)
    onOpenChange?.(next)
  }

  useEffect(() => {
    if (open) {
      setProjectId(defaultStatus === 'inbox' ? '' : defaultProjectId ?? '')
      setColumnId(defaultStatus === 'inbox' ? null : defaultColumnId ?? (defaultStatus ? `status:${defaultStatus}` : null))
    }
  }, [defaultColumnId, defaultProjectId, defaultStatus, open])

  const estimateMinutes = estimate ? Number(estimate) : null
  const mutation = useMutation({
    mutationFn: () => getWorkbenchApi().tasks.create({
      title: title.trim(),
      notes: notes.trim(),
      projectId: projectId ? ProjectIdSchema.parse(projectId) : null,
      columnId: projectId ? columnId : null,
      priority,
      estimateMinutes,
      dueAt: toEndOfDayIso(dueDate),
      tags: []
    }),
    onSuccess: async () => {
      await refresh()
      setTitle('')
      setNotes('')
      setPriority('normal')
      setEstimate('')
      setDueDate('')
      setAttempted(false)
      setOpen(false)
    }
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setAttempted(true)
    if (!title.trim() || title.length > 240 || mutation.isPending) return
    if (estimateMinutes !== null && (!Number.isInteger(estimateMinutes) || estimateMinutes <= 0 || estimateMinutes > 100_000)) return
    mutation.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => {
      setOpen(next)
      if (!next) {
        mutation.reset()
        setAttempted(false)
      }
    }}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent description="先记下可以立即行动的下一步，细节可以稍后补充。" title="新建任务">
        <form className="grid gap-4" onSubmit={submit}>
          <Field
            error={!title.trim() && attempted ? '请填写任务标题。' : undefined}
            htmlFor={titleId}
            label="任务标题"
          >
            <Input
              autoFocus
              id={titleId}
              maxLength={240}
              onChange={(event) => {
                setTitle(event.target.value)
                mutation.reset()
              }}
              placeholder="例如：核对实验组的特征编码"
              value={title}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field htmlFor={projectIdField} label="所属项目">
              <select
                className="select-control"
                id={projectIdField}
                 onChange={(event) => {
                   setProjectId(event.target.value)
                   // Preserve the status requested by a board-column create
                   // action.  The service resolves `status:<status>` against
                   // the selected project once the user chooses it.
                   setColumnId(defaultColumnId ?? (defaultStatus ? `status:${defaultStatus}` : null))
                 }}
                value={projectId}
              >
                <option value="">收件箱（暂不分类）</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </Field>
            <Field htmlFor={priorityId} label="优先级">
              <select
                className="select-control"
                id={priorityId}
                onChange={(event) => setPriority(event.target.value as TaskPriority)}
                value={priority}
              >
                <option value="low">低</option>
                <option value="normal">普通</option>
                <option value="high">高</option>
                <option value="urgent">紧急</option>
              </select>
            </Field>
            <Field
              error={attempted && estimateMinutes !== null && (!Number.isInteger(estimateMinutes) || estimateMinutes <= 0 || estimateMinutes > 100_000)
                ? '请输入 1 到 100000 之间的整数。'
                : undefined}
              htmlFor={estimateId}
              label="预计分钟"
            >
              <Input
                id={estimateId}
                inputMode="numeric"
                max="100000"
                min="1"
                onChange={(event) => setEstimate(event.target.value)}
                placeholder="例如：45"
                type="number"
                value={estimate}
              />
            </Field>
            <Field htmlFor={dueDateId} label="截止日期">
              <Input id={dueDateId} onChange={(event) => setDueDate(event.target.value)} type="datetime-local" value={dueDate} />
            </Field>
          </div>
          <Field htmlFor={notesId} label="备注" hint="可选，只写执行这一步必需的背景。">
            <Textarea id={notesId} maxLength={20000} onChange={(event) => setNotes(event.target.value)} value={notes} />
          </Field>
          {mutation.error ? <p className="text-xs text-danger" role="alert">{getErrorMessage(mutation.error)}</p> : null}
          <div className="mt-1 flex justify-end gap-2">
            <DialogClose asChild><Button type="button" variant="ghost">取消</Button></DialogClose>
            <Button loading={mutation.isPending} type="submit" variant="primary">
              <Plus aria-hidden="true" className="size-4" />
              创建任务
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function QuickTodo(): React.JSX.Element {
  const [title, setTitle] = useState('')
  const inputId = useId()
  const refresh = useRefreshWorkspace()
  const mutation = useMutation({
    mutationFn: () => getWorkbenchApi().tasks.create({
      title: title.trim(),
      notes: '',
      projectId: null,
      columnId: null,
      priority: 'normal',
      estimateMinutes: null,
      dueAt: null,
      tags: []
    }),
    onSuccess: async () => {
      setTitle('')
      await refresh()
    }
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim() || mutation.isPending) return
    mutation.mutate()
  }

  return (
    <form className="quick-todo" onSubmit={submit}>
      <label className="sr-only" htmlFor={inputId}>快速添加 Todo</label>
      <Plus aria-hidden="true" className="ml-2 size-4 shrink-0 text-muted-foreground" />
      <input
        className="min-w-24 flex-1 bg-transparent px-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        disabled={mutation.isPending}
        id={inputId}
        maxLength={240}
        onChange={(event) => {
          setTitle(event.target.value)
          mutation.reset()
        }}
        placeholder="快速记下 Todo…"
        value={title}
      />
      <Button aria-label="添加 Todo" className="m-0.5" disabled={!title.trim()} loading={mutation.isPending} size="icon" type="submit" variant="ghost">
        <Check aria-hidden="true" className="size-4" />
      </Button>
      {mutation.error ? <span className="sr-only" role="alert">{getErrorMessage(mutation.error)}</span> : null}
    </form>
  )
}
