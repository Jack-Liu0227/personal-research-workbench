import { DateRangeSchema, type DateRange } from '@prw/contracts'

export const TASK_DATE_FILTER_STORAGE_KEY = 'workbench-task-date-range:v1'
export const TASK_DATE_FILTER_EVENT = 'workbench:task-date-filter-change'

export function readSharedTaskDateRange(): DateRange | null {
  try {
    const value = localStorage.getItem(TASK_DATE_FILTER_STORAGE_KEY)
    if (!value) return null
    const parsed = DateRangeSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function writeSharedTaskDateRange(value: DateRange | null): void {
  try {
    if (value) localStorage.setItem(TASK_DATE_FILTER_STORAGE_KEY, JSON.stringify(value))
    else localStorage.removeItem(TASK_DATE_FILTER_STORAGE_KEY)
    window.dispatchEvent(new Event(TASK_DATE_FILTER_EVENT))
  } catch { /* optional renderer storage */ }
}
