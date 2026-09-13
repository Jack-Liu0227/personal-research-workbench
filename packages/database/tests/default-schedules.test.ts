/*
 * Focused check for the shipped built-in schedule set.
 *
 * Requirement: a new install — and an upgrade of an existing database — owns
 * exactly three enabled rules (last30days / literature-matrix /
 * literature-review-push), and the seeding must be idempotent: a rule that
 * already exists is never inserted twice and never updated, so a user's own
 * edit, pause or archive survives every migration re-run.
 *
 * The test drives a real temporary SQLite file through the public repository
 * API, then re-applies the seeding migration through the raw handle to prove the
 * "write-only-when-absent" contract instead of trusting the one-shot ledger.
 *
 * Usage: pnpm test:default-schedules
 */
import { afterEach, describe, it } from 'node:test'
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { DEFAULT_AGENT_SCHEDULE_RULES, DEFAULT_DAILY_PUSH_SCHEDULE_INPUT, type DefaultAgentScheduleRule, type Schedule } from '@prw/contracts'
import { migrateDatabase } from '../src/migrations.ts'
import { WorkbenchRepository } from '../src/repository.ts'

/** The seeding migration. Re-applying it on an already-migrated database is the
 *  only way to exercise "the rule already exists" through the real SQL. */
const SEEDING_MIGRATION_ID = 28

const roots: string[] = []
const open: WorkbenchRepository[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'prw-default-schedules-'))
  roots.push(root)
  return root
}

function openRepository(root: string): WorkbenchRepository {
  const repository = new WorkbenchRepository({ filePath: join(root, 'workspace.sqlite3'), now: () => new Date('2026-09-13T04:00:00.000Z') })
  open.push(repository)
  return repository
}

function handleOf(repository: WorkbenchRepository): BetterSqlite3.Database {
  const handle = (repository as unknown as { sqlite?: BetterSqlite3.Database }).sqlite
  ok(handle !== undefined, 'repository must expose its sqlite handle')
  return handle
}

function reseed(handle: BetterSqlite3.Database): void {
  handle.prepare('DELETE FROM _prw_migrations WHERE id = ?').run(SEEDING_MIGRATION_ID)
  migrateDatabase(handle)
}

function find(rules: readonly Schedule[], id: string): Schedule {
  const rule = rules.find((candidate) => candidate.id === id)
  ok(rule !== undefined, `default rule ${id} missing (found: ${rules.map((rule) => rule.id).join(', ')})`)
  return rule
}

/** Every frozen field, so a drifted literal cannot pass on name alone. */
function assertFrozen(rule: Schedule, expected: DefaultAgentScheduleRule): void {
  strictEqual(rule.name, expected.name)
  strictEqual(rule.skillKey, expected.skillKey)
  strictEqual(rule.workflowKey, expected.workflowKey)
  strictEqual(rule.promptTemplateId, expected.promptTemplateId)
  strictEqual(rule.topic, expected.topic)
  strictEqual(rule.responseLanguage, expected.responseLanguage)
  deepStrictEqual(rule.sources, [...expected.sources])
  strictEqual(rule.lookbackDays, expected.lookbackDays)
  strictEqual(rule.outputFolder, expected.outputFolder)
  strictEqual(rule.frequency, expected.frequency)
  strictEqual(rule.cron, expected.cron)
  strictEqual(rule.timezone, expected.timezone)
  strictEqual(rule.runtime, expected.runtime)
  strictEqual(rule.assistantKey, expected.assistantKey)
  strictEqual(rule.enabled, expected.enabled)
  strictEqual(rule.projectId, null)
  strictEqual(rule.providerProfileId, null)
  strictEqual(rule.permissionMode, 'read-only')
  strictEqual(rule.approvalPolicy, 'on-request')
}

/** `id → revision/updatedAt`, the internal bookkeeping an upgrade must not touch. */
function cursors(repository: WorkbenchRepository): Record<string, string> {
  const snapshot: Record<string, string> = {}
  for (const rule of repository.listSchedules()) snapshot[rule.id] = `${rule.revision}|${rule.updatedAt}`
  return snapshot
}

afterEach(() => {
  // Windows refuses to delete a SQLite file that still has an open handle, so
  // every repository opened by a test is closed before its temp root is removed.
  for (const repository of open.splice(0)) repository.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('default schedule rules', () => {
  it('seeds exactly the three frozen enabled rules on a fresh database', () => {
    const repository = openRepository(makeRoot())
    const rules = repository.listSchedules()
    deepStrictEqual(
      rules.map((rule) => rule.id).sort(),
      DEFAULT_AGENT_SCHEDULE_RULES.map((rule) => rule.id).sort()
    )
    strictEqual(rules.length, 3, `expected exactly 3 default rules, got ${rules.length}`)
    for (const expected of DEFAULT_AGENT_SCHEDULE_RULES) {
      const rule = find(rules, expected.id)
      assertFrozen(rule, expected)
      ok(rule.revision >= 0, 'default rule must carry a revision')
    }
    // The news rule is the shared push template, not a second copy of it.
    const daily = find(rules, 'builtin.schedule.last30days')
    strictEqual(daily.topic, DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.topic)
    strictEqual(daily.outputFolder, DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.outputFolder)
    strictEqual(daily.responseLanguage, DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.responseLanguage)
    strictEqual(daily.lookbackDays, DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.lookbackDays)
    deepStrictEqual(daily.sources, [...DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.sources])
  })

  it('is idempotent: re-applying the seeding migration duplicates and rewrites nothing', () => {
    const root = makeRoot()
    const repository = openRepository(root)
    const before = cursors(repository)
    reseed(handleOf(repository))
    deepStrictEqual(cursors(repository), before, 're-applying the seed must not bump revision/updatedAt')
    deepStrictEqual(repository.listSchedules().map((rule) => rule.id).sort(), DEFAULT_AGENT_SCHEDULE_RULES.map((rule) => rule.id).sort())
    // A second open on the same file (the normal upgrade path) is equally stable.
    const reopened = openRepository(root)
    deepStrictEqual(cursors(reopened), before)
    strictEqual(reopened.listSchedules().length, 3)
  })

  it('recreates a missing default rule without touching the other two', () => {
    const repository = openRepository(makeRoot())
    const handle = handleOf(repository)
    handle.prepare('DELETE FROM schedules WHERE id = ?').run('builtin.schedule.literature-matrix')
    const survivors = cursors(repository)
    delete survivors['builtin.schedule.literature-matrix']
    reseed(handle)
    const after = cursors(repository)
    const restoredCursor = after['builtin.schedule.literature-matrix']
    delete after['builtin.schedule.literature-matrix']
    deepStrictEqual(after, survivors, 'the surviving rules must keep their revision/updatedAt')
    ok(restoredCursor !== undefined, 'the missing rule must be recreated')
    const restored = find(repository.listSchedules(), 'builtin.schedule.literature-matrix')
    assertFrozen(restored, DEFAULT_AGENT_SCHEDULE_RULES[1]!)
    strictEqual(restored.revision, 0, 'a recreated default starts a fresh revision chain')
  })

  it('never overwrites a user edit, a pause or an archive', () => {
    const repository = openRepository(makeRoot())
    const handle = handleOf(repository)
    const matrix = find(repository.listSchedules(), 'builtin.schedule.literature-matrix')
    repository.saveSchedule({ ...matrix, name: '我的矩阵', topic: '我的主题', outputFolder: '我的目录', expectedRevision: matrix.revision })
    const review = find(repository.listSchedules(), 'builtin.schedule.literature-review-push')
    repository.saveSchedule({ ...review, enabled: false, expectedRevision: review.revision })
    const daily = find(repository.listSchedules(), 'builtin.schedule.last30days')
    repository.removeSchedule(daily.id, daily.revision)

    reseed(handle)

    const rules = repository.listSchedules()
    strictEqual(rules.length, 2, 'the archived rule stays archived and nothing is resurrected')
    const edited = find(rules, 'builtin.schedule.literature-matrix')
    strictEqual(edited.name, '我的矩阵')
    strictEqual(edited.topic, '我的主题')
    strictEqual(edited.outputFolder, '我的目录')
    strictEqual(find(rules, 'builtin.schedule.literature-review-push').enabled, false, 'a pause must survive a re-seed')
    const archived = handle.prepare('SELECT enabled, archived_at AS archivedAt FROM schedules WHERE id = ?').get('builtin.schedule.last30days') as { enabled: number; archivedAt: string | null }
    strictEqual(archived.archivedAt !== null, true)
    strictEqual(archived.enabled, 0)
  })

  it('leaves a user rule that selects the same skill alone', () => {
    const repository = openRepository(makeRoot())
    const handle = handleOf(repository)
    const custom = repository.saveSchedule({
      name: '我的矩阵规则',
      workflowKey: 'literature_matrix',
      promptTemplateId: 'builtin.prompt.matrix-extraction',
      skillKey: 'literature-matrix',
      topic: '自定义主题',
      responseLanguage: 'zh-CN',
      sources: [],
      lookbackDays: 7,
      outputFolder: '文献矩阵',
      cron: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      enabled: true
    })
    reseed(handle)
    const rules = repository.listSchedules()
    strictEqual(rules.length, 4, 'a user rule must not be dropped or merged into a default')
    strictEqual(find(rules, custom.id).topic, '自定义主题')
    assertFrozen(find(rules, 'builtin.schedule.literature-matrix'), DEFAULT_AGENT_SCHEDULE_RULES[1]!)
  })

  it('guards the migration SQL against drifting from the contract constant', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/migrations.ts'), 'utf8')
    const block = /id:\s*28,\s*name:\s*'three_builtin_schedule_rules',\s*sql:\s*`([\s\S]*?)`/.exec(source)
    ok(block !== null, 'the three_builtin_schedule_rules migration must exist')
    const sql = block[1]!.replace(/--[^\n]*/gu, '')
    const statements = sql.split(';').map((statement) => statement.trim()).filter((statement) => statement.length > 0)
    strictEqual(statements.length, 3, 'exactly three seeding statements')
    for (const statement of statements) ok(statement.startsWith('INSERT OR IGNORE INTO schedules'), `seeding must stay insert-only, got: ${statement.slice(0, 40)}`)
    for (const rule of DEFAULT_AGENT_SCHEDULE_RULES) {
      for (const literal of [rule.id, rule.name, rule.skillKey, rule.workflowKey, rule.promptTemplateId, rule.topic, rule.outputFolder, rule.cron, rule.timezone]) {
        ok(sql.includes(literal), `migration SQL is missing the frozen literal ${literal}`)
      }
    }
  })
})
