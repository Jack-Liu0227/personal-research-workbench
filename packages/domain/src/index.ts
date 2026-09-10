import type { ProjectId, ProjectProgress, Task } from '@prw/contracts'

const dayMs = 24 * 60 * 60 * 1_000

export function calculateProjectProgress(projectId: string, tasks: Task[], now = new Date()): ProjectProgress {
  const active = tasks.filter((task) => task.projectId === projectId && task.status !== 'canceled')
  const completed = active.filter((task) => task.status === 'done')
  const totalWeight = active.reduce((sum, task) => sum + (task.estimateMinutes ?? 1), 0)
  const completedWeight = completed.reduce((sum, task) => sum + (task.estimateMinutes ?? 1), 0)
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()

  return {
    // ProjectId brands are compile-time only; keep the database/string wire value unchanged.
    projectId: projectId as ProjectId,
    totalTasks: active.length,
    completedTasks: completed.length,
    blockedTasks: active.filter((task) => task.status === 'blocked').length,
    overdueTasks: active.filter((task) => {
      if (!task.dueAt || task.status === 'done') return false
      return new Date(task.dueAt).getTime() < todayStart
    }).length,
    completedWeight,
    totalWeight,
    percent: totalWeight === 0 ? 0 : Math.round((completedWeight / totalWeight) * 100)
  }
}

export function isDueToday(task: Task, now = new Date()): boolean {
  if (!task.dueAt) return false
  const due = new Date(task.dueAt)
  return due.getFullYear() === now.getFullYear()
    && due.getMonth() === now.getMonth()
    && due.getDate() === now.getDate()
}

export function isUpcoming(task: Task, now = new Date(), days = 7): boolean {
  if (!task.dueAt) return false
  const due = new Date(task.dueAt).getTime()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return due >= start && due < start + days * dayMs
}

export function assertRevision(actual: number, expected: number): void {
  if (actual !== expected) {
    const error = new Error(`Revision conflict: expected ${expected}, received ${actual}`)
    error.name = 'RevisionConflictError'
    throw error
  }
}

export function normalizedSortKeys(count: number, step = 1_024): number[] {
  return Array.from({ length: count }, (_, index) => (index + 1) * step)
}
