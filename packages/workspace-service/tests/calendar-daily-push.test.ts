import { describe, it } from 'node:test'
import { deepEqual, equal, match } from 'node:assert/strict'
import { CalendarEventSchema, CreateCalendarEventInputSchema, UpdateCalendarEventInputSchema, type Schedule, type ScheduleOccurrence } from '@prw/contracts'
import {
  buildDailyPushCalendarEvents,
  dailyPushRunOutcome,
  dailyPushVirtualEventId,
  isCalendarVirtualId
} from '../src/calendar-daily-push.ts'

const schedule = (overrides: Partial<Schedule> = {}): Schedule => ({
  id: 'schedule-1',
  name: '真实每日推送',
  workflowKey: 'daily_digest',
  runtime: 'pi',
  model: null,
  assistantKey: 'researcher',
  workspacePath: null,
  frequency: 'daily',
  executionMode: 'new_conversation',
  conversationId: null,
  prompt: '根据主题检索并生成推送',
  skillKey: 'last30days',
  topic: 'AI 最新资讯',
  sources: ['OpenAlex', 'arXiv'],
  lookbackDays: 30,
  responseLanguage: 'zh-CN',
  outputFolder: '每日资讯推送',
  permissionMode: 'read-only',
  approvalPolicy: 'on-request',
  projectId: null,
  cron: '0 9 * * *',
  timezone: 'Asia/Shanghai',
  enabled: true,
  nextRunAt: '2026-09-15T01:00:00.000Z',
  lastRunAt: null,
  revision: 1,
  ...overrides
})

const occurrence = (overrides: Partial<ScheduleOccurrence> = {}): ScheduleOccurrence => ({
  id: 'occurrence-1',
  scheduleId: 'schedule-1',
  occurrenceAt: '2026-09-14T01:00:00.000Z',
  localDateKey: '2026-09-14',
  idempotencyKey: 'schedule-1:2026-09-14',
  source: 'scheduler',
  status: 'completed',
  runId: 'run-1',
  reason: '',
  claimedAt: '2026-09-14T01:00:00.000Z',
  settledAt: '2026-09-14T01:02:00.000Z',
  revision: 1,
  ...overrides
})

const range = { startsAt: '2026-09-14T00:00:00.000Z', endsAt: '2026-09-16T00:00:00.000Z' }

const completedRun = dailyPushRunOutcome({
  run: { id: 'run-1', status: 'completed' },
  artifact: { id: 'artifact-1', title: 'AI 最新资讯 · 2026-09-14' },
  events: [{ kind: 'progress', payload: { code: 'OBSIDIAN_DAILY_NOTE_WRITTEN', relativePath: '每日资讯推送/2026-09-14.md', message: 'written' } }]
})

describe('daily push calendar projection', () => {
  it('projects a real plan and occurrence without copying the pushed body', () => {
    const events = buildDailyPushCalendarEvents({
      range,
      schedules: [schedule()],
      occurrences: [occurrence()],
      runs: new Map([['run-1', completedRun]])
    })
    equal(events.length, 2)
    equal(events[0]?.id, dailyPushVirtualEventId('schedule-1', 'occurrence-1'))
    equal(events[0]?.dailyPush?.state, 'occurred')
    equal(events[0]?.dailyPush?.artifact?.title, 'AI 最新资讯 · 2026-09-14')
    equal(events[0]?.dailyPush?.obsidianRelativePath, '每日资讯推送/2026-09-14.md')
    equal(events[1]?.dailyPush?.state, 'planned')
    equal(events[1]?.dailyPush?.occurrenceStatus, null)
    equal(events[1]?.dailyPush?.artifact, null)
    match(events[0]?.description ?? '', /已完成/u)
    equal((events[0]?.description ?? '').includes('written'), false)
    for (const event of events) deepEqual(CalendarEventSchema.parse(event), event)
  })

  it('keeps historical occurrences after a rule is disabled and respects [from,to)', () => {
    const events = buildDailyPushCalendarEvents({
      range,
      schedules: [schedule({ enabled: false, nextRunAt: '2026-09-16T01:00:00.000Z' })],
      occurrences: [
        occurrence(),
        occurrence({ id: 'outside', occurrenceAt: '2026-09-16T00:00:00.000Z', runId: null, status: 'skipped', reason: '未满足运行条件' })
      ],
      runs: new Map()
    })
    equal(events.length, 1)
    equal(events[0]?.id, 'daily-push:schedule-1:occurrence-1')
    equal(events[0]?.dailyPush?.occurrenceStatus, 'completed')
    equal(events[0]?.dailyPush?.artifact, null)
    equal(events[0]?.dailyPush?.obsidianRelativePath, null)
  })

  it('keeps the virtual event family read-only at the input boundary', () => {
    const input = {
      projectId: null,
      title: '伪造每日推送',
      description: '',
      type: 'daily_push',
      startsAt: '2026-09-14T01:00:00.000Z',
      endsAt: '2026-09-14T01:00:00.000Z',
      timezone: 'Asia/Shanghai',
      allDay: false,
      taskId: null,
      paperId: null
    }
    equal(CreateCalendarEventInputSchema.safeParse(input).success, false)
    equal(UpdateCalendarEventInputSchema.safeParse({ ...input, id: 'daily-push:schedule-1:occurrence-1', expectedRevision: 0 }).success, false)
    equal(isCalendarVirtualId('daily-push:schedule-1:occurrence-1'), true)
  })

  it('supports the daily_push type filter and excludes other workflows', () => {
    const events = buildDailyPushCalendarEvents({
      range,
      types: ['meeting'],
      schedules: [schedule()],
      occurrences: [occurrence()],
      runs: new Map()
    })
    equal(events.length, 0)
    equal(buildDailyPushCalendarEvents({
      range,
      schedules: [schedule({ workflowKey: 'literature_matrix' })],
      occurrences: [],
      runs: new Map()
    }).length, 0)
  })
})
