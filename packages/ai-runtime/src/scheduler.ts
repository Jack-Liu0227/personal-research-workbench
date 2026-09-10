import { Cron } from 'croner'

export interface SchedulePreview {
  readonly nextRuns: string[]
  readonly nextRunAt: string | null
}

export function previewSchedule(pattern: string, timezone: string, count = 5, from = new Date()): SchedulePreview {
  if (count < 1 || count > 20) throw new Error('计划预览数量必须在 1 到 20 之间')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(from)
  } catch {
    throw new Error(`无效 IANA 时区：${timezone}`)
  }
  let cron: Cron
  try {
    cron = new Cron(pattern, { timezone, paused: true })
  } catch {
    throw new Error('无效 Cron 表达式')
  }
  const nextRuns = cron.nextRuns(count, from).map((date) => date.toISOString())
  if (nextRuns.length === 0) throw new Error('Cron 表达式没有可计算的下一次运行')
  return { nextRuns, nextRunAt: nextRuns[0] ?? null }
}

export function shouldCoalesceMissedRun(nextRunAt: string | null, now = new Date()): boolean {
  return nextRunAt !== null && new Date(nextRunAt).getTime() <= now.getTime()
}
