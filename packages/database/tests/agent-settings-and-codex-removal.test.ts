/*
 * Focused check for the Agent runtime cutover (migrations 30 + 31).
 *
 * Two things must hold at once and they pull in opposite directions:
 *
 *   1. Codex history is removed, because no Codex executable exists any more
 *      and the contract now only accepts `runtime: 'pi'`. A single stale row
 *      makes the whole Agent page fail to read, so the delete must be total
 *      and the cascades must actually run.
 *   2. Everything that is *not* Codex history survives: Pi runs, the user's
 *      own schedules (repointed, not deleted) and the conversation rows they
 *      hang off.
 *
 * The test therefore builds a real v29 database, puts Codex rows in it, then
 * reopens it so migrations 30/31 run through the production path — including
 * the pre-migration backup.
 *
 * Usage: pnpm test:agent-settings
 */
import { afterEach, describe, it } from 'node:test'
import { ok, strictEqual } from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { AgentRunRecordSchema, AgentRuntimeTransportSchema } from '@prw/contracts'
import { WorkbenchRepository } from '../src/repository.ts'

/** Migrations that create the post-cutover state. Rolling their ledger rows
 *  back (and undoing their DDL) is what turns a migrated file into a v29 file,
 *  which is the only honest way to exercise the upgrade path. */
const CUTOVER_MIGRATION_IDS = [30, 31]

const roots: string[] = []
const open: WorkbenchRepository[] = []

function makeDatabasePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'prw-agent-settings-'))
  roots.push(root)
  return join(root, 'workspace.sqlite3')
}

function handleOf(repository: WorkbenchRepository): BetterSqlite3.Database {
  const handle = (repository as unknown as { sqlite?: BetterSqlite3.Database }).sqlite
  ok(handle !== undefined, 'repository must expose its sqlite handle')
  return handle
}

function openRepository(filePath: string): WorkbenchRepository {
  const repository = new WorkbenchRepository({ filePath })
  open.push(repository)
  return repository
}

/** Turn a fully migrated file back into the shape a v0.0.3 install has:
 *  the cutover DDL is undone and its ledger rows are removed, so reopening the
 *  file genuinely replays migrations 30 and 31. */
function rewindToV29(handle: BetterSqlite3.Database): void {
  handle.exec(`
    DROP TABLE IF EXISTS agent_settings;
    ALTER TABLE agent_conversations DROP COLUMN runtime_session_id;
  `)
  const placeholders = CUTOVER_MIGRATION_IDS.map(() => '?').join(', ')
  handle.prepare(`DELETE FROM _prw_migrations WHERE id IN (${placeholders})`).run(...CUTOVER_MIGRATION_IDS)
}

interface SeededIds {
  readonly piConversationId: string
  readonly piRunId: string
  readonly codexConversationId: string
  readonly codexRunId: string
}

/** Insert one Codex and one Pi conversation/run pair plus the connector and
 *  binding rows.
 *
 *  The rows are created through the normal repository API and then flipped to
 *  `codex` with raw SQL: the contract already refuses to write `runtime:
 *  'codex'`, which is precisely why the migration has to clean it up. */
function seedRuntimes(repository: WorkbenchRepository): SeededIds {
  const handle = handleOf(repository)
  const timestamp = '2026-09-13T04:00:00.000Z'
  const piConversation = repository.createAgentConversation({ title: 'Pi 对话' })
  const codexConversation = repository.createAgentConversation({ title: 'Codex 对话' })
  const piRun = repository.startManagedAgentRun({
    jobId: null,
    conversationId: piConversation.id,
    runtime: 'pi',
    transport: 'inprocess',
    workflowKey: 'research_plan',
    projectId: null,
    paperIds: [],
    instructions: 'Pi 提问',
    toolProfile: 'read-only',
    idempotencyKey: 'seed.pi'
  })
  const codexRun = repository.startManagedAgentRun({
    jobId: null,
    conversationId: codexConversation.id,
    runtime: 'pi',
    transport: 'inprocess',
    workflowKey: 'research_plan',
    projectId: null,
    paperIds: [],
    instructions: 'Codex 提问',
    toolProfile: 'read-only',
    idempotencyKey: 'seed.codex'
  })

  handle.prepare("UPDATE agent_conversations SET runtime = 'codex' WHERE id = ?").run(codexConversation.id)
  handle.prepare("UPDATE agent_runs SET runtime = 'codex' WHERE id = ?").run(codexRun.id)
  // Dependent rows exist to prove the cascades run rather than leaving orphans
  // that `foreign_key_check` would reject.
  handle.prepare(
    `INSERT INTO agent_run_records (id, run_id, seq, record_key, kind, status, turn, step, created_at)
     VALUES ('rec.codex', ?, 0, 'run:user', 'user', 'completed', 0, 0, ?)`
  ).run(codexRun.id, timestamp)
  handle.prepare(
    `INSERT INTO agent_messages (id, conversation_id, run_id, role, content, created_at, seq)
     VALUES ('msg.codex', ?, ?, 'user', 'hi', ?, 0)`
  ).run(codexConversation.id, codexRun.id, timestamp)

  handle.prepare(
    `INSERT INTO agent_connectors (id, runtime, version, enabled, available, mcp, structured_output, workspace_write, message, proxy_enabled, updated_at, revision)
     VALUES ('builtin.agent.codex.seed', 'codex', '0.1.0', 1, 1, 1, 1, 1, '', 0, ?, 0)`
  ).run(timestamp)
  handle.prepare(
    `INSERT INTO agent_bindings (id, project_id, runtime, fallback_runtime, created_at, updated_at, revision)
     VALUES ('binding.codex', NULL, 'codex', 'pi', ?, ?, 0)`
  ).run(timestamp, timestamp)

  return {
    piConversationId: piConversation.id,
    piRunId: piRun.id,
    codexConversationId: codexConversation.id,
    codexRunId: codexRun.id
  }
}

function countOf(handle: BetterSqlite3.Database, sql: string, ...parameters: unknown[]): number {
  const row = handle.prepare(sql).get(...parameters) as { n?: number } | undefined
  return Number(row?.n ?? 0)
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close()
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('Agent runtime cutover (Agent → 对话 / 设置)', () => {
  it('removes Codex history, keeps Pi history and repoints user schedules', () => {
    const filePath = makeDatabasePath()
    const first = openRepository(filePath)
    const handle = handleOf(first)
    const ids = seedRuntimes(first)
    // A schedule that predates the cutover still names the removed runtime. The
    // migration must repoint it rather than delete a user's recurring task.
    handle.prepare("UPDATE schedules SET runtime = 'codex' WHERE id = 'builtin.schedule.literature-matrix'").run()
    rewindToV29(handle)
    first.close()
    open.pop()

    const reopened = openRepository(filePath)
    const after = handleOf(reopened)

    strictEqual(countOf(after, "SELECT COUNT(*) AS n FROM agent_runs WHERE runtime = 'codex'"), 0)
    strictEqual(countOf(after, 'SELECT COUNT(*) AS n FROM agent_runs WHERE id = ?', ids.codexRunId), 0)
    strictEqual(countOf(after, 'SELECT COUNT(*) AS n FROM agent_conversations WHERE id = ?', ids.codexConversationId), 0)
    strictEqual(countOf(after, "SELECT COUNT(*) AS n FROM agent_run_records WHERE id = 'rec.codex'"), 0, 'records cascade with their run')
    strictEqual(countOf(after, "SELECT COUNT(*) AS n FROM agent_messages WHERE id = 'msg.codex'"), 0, 'messages cascade with their conversation')
    strictEqual(countOf(after, "SELECT COUNT(*) AS n FROM agent_connectors WHERE runtime = 'codex'"), 0)
    strictEqual(countOf(after, "SELECT COUNT(*) AS n FROM agent_bindings WHERE runtime = 'codex'"), 0)
    strictEqual(countOf(after, 'SELECT COUNT(*) AS n FROM agent_runs WHERE id = ?', ids.piRunId), 1, 'Pi history is untouched')
    strictEqual(countOf(after, 'SELECT COUNT(*) AS n FROM agent_conversations WHERE id = ?', ids.piConversationId), 1)
    strictEqual((after.prepare("SELECT runtime FROM schedules WHERE id = 'builtin.schedule.literature-matrix'").get() as { runtime: string }).runtime, 'pi', 'the schedule is repointed, not deleted')

    // The whole point of the delete: the contract only accepts `pi`, so the
    // conversation list must be readable again.
    ok(reopened.listAgentConversations({ includeArchived: true }).every((conversation) => conversation.runtime === 'pi'))
  })

  it('keeps run rows written by the removed CLI transport readable', () => {
    const repository = openRepository(makeDatabasePath())
    const handle = handleOf(repository)
    const conversation = repository.createAgentConversation({ title: '旧 CLI 对话' })
    const run = repository.startManagedAgentRun({
      jobId: null,
      conversationId: conversation.id,
      runtime: 'pi',
      transport: 'inprocess',
      workflowKey: 'research_plan',
      projectId: null,
      paperIds: [],
      instructions: '旧的 CLI 运行',
      toolProfile: 'read-only',
      idempotencyKey: 'seed.legacy-cli'
    })
    // History from the removed spawned-CLI transport. The contract refuses to
    // write this literal, so raw SQL is the only way to produce it — exactly
    // the state an upgraded profile is still in (`agent_runs.transport` keeps
    // a SQLite CHECK that cannot be narrowed in place).
    handle.prepare("UPDATE agent_runs SET transport = 'cli' WHERE id = ?").run(run.id)

    const stored = repository.listManagedAgentRuns().find((candidate) => candidate.id === run.id)
    ok(stored !== undefined, 'the legacy run must stay listed')
    strictEqual(stored.transport, 'cli', 'the stored transport is reported as it was recorded')
    // The Agent page reads this list through the shared record schema, so one
    // unparseable row used to fail every run listing for the whole profile.
    strictEqual(AgentRunRecordSchema.array().parse(repository.listManagedAgentRuns()).length > 0, true)

    // Reading history is wide; starting a run is not.
    strictEqual(AgentRuntimeTransportSchema.safeParse('cli').success, false)
    strictEqual(AgentRuntimeTransportSchema.safeParse('inprocess').success, true)
  })

  it('takes a findable backup before the destructive migration', () => {
    const filePath = makeDatabasePath()
    const first = openRepository(filePath)
    seedRuntimes(first)
    rewindToV29(handleOf(first))
    first.close()
    open.pop()

    const reopened = openRepository(filePath)
    const backupPath = `${filePath}.pre-v30-codex.bak`
    ok(existsSync(backupPath), 'the upgrade must leave a rollback copy beside the database')
    strictEqual(reopened.listMigrationBackups()[0], backupPath)

    // The copy is the *pre-migration* state, so the Codex rows are still in it.
    const backup = new BetterSqlite3(backupPath, { readonly: true })
    try {
      strictEqual(countOf(backup, "SELECT COUNT(*) AS n FROM agent_runs WHERE runtime = 'codex'"), 1)
      const hasSettingsTable = backup.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_settings'").get()
      strictEqual(hasSettingsTable, undefined, 'the backup predates the new table')
    } finally {
      backup.close()
    }
  })

  it('skips the backup when there is no Codex history to lose', () => {
    const filePath = makeDatabasePath()
    const first = openRepository(filePath)
    rewindToV29(handleOf(first))
    first.close()
    open.pop()

    const reopened = openRepository(filePath)
    ok(!existsSync(`${filePath}.pre-v30-codex.bak`), 'a Pi-only database must not get a pointless backup')
    strictEqual(reopened.listMigrationBackups().length, 0)
  })

  it('seeds one global Agent settings row with the post-cutover defaults', () => {
    const repository = openRepository(makeDatabasePath())
    const settings = repository.getAgentSettings()
    strictEqual(settings.provider, null)
    strictEqual(settings.model, null)
    strictEqual(settings.thinking, null)
    strictEqual(settings.permissionMode, 'auto')
    strictEqual(settings.toolProfile, 'approved-write')
    strictEqual(settings.approvalPolicy, 'never')
    strictEqual(settings.responseLanguage, 'zh-CN')
    strictEqual(settings.revision, 0)
    strictEqual(countOf(handleOf(repository), 'SELECT COUNT(*) AS n FROM agent_settings'), 1)
  })

  it('bumps revision on every save and rejects a stale write', () => {
    const repository = openRepository(makeDatabasePath())
    const initial = repository.getAgentSettings()
    const saved = repository.saveAgentSettings({
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      thinking: 'high',
      permissionMode: 'auto',
      toolProfile: 'approved-write',
      approvalPolicy: 'never',
      responseLanguage: 'zh-CN',
      expectedRevision: initial.revision
    })
    strictEqual(saved.revision, 1)
    strictEqual(saved.model, 'claude-sonnet-4')

    // A second writer that still holds revision 0 must not silently win.
    let conflict = false
    try {
      repository.saveAgentSettings({
        provider: 'openai',
        model: 'gpt-5',
        thinking: null,
        permissionMode: 'auto',
        toolProfile: 'approved-write',
        approvalPolicy: 'never',
        responseLanguage: 'zh-CN',
        expectedRevision: initial.revision
      })
    } catch (error) {
      conflict = (error as { code?: string }).code === 'REVISION_CONFLICT'
    }
    ok(conflict, 'stale expectedRevision must fail with a CAS conflict')

    // Reading back proves the rejected write changed nothing.
    strictEqual(repository.getAgentSettings().revision, 1)
  })

  it('re-creates the settings row instead of failing when it was hand-deleted', () => {
    const repository = openRepository(makeDatabasePath())
    handleOf(repository).prepare('DELETE FROM agent_settings').run()
    const recovered = repository.getAgentSettings()
    strictEqual(recovered.permissionMode, 'auto')
    strictEqual(countOf(handleOf(repository), 'SELECT COUNT(*) AS n FROM agent_settings'), 1)
  })

  it('stores and clears the Pi session path without bumping the conversation revision', () => {
    const repository = openRepository(makeDatabasePath())
    const conversation = repository.createAgentConversation({ title: '会话' })
    repository.setAgentConversationRuntimeSession(conversation.id, 'C:/profile/sessions/1.jsonl')

    const after = repository.listAgentConversations().find((candidate) => candidate.id === conversation.id)
    ok(after !== undefined)
    strictEqual(after.runtimeSessionId, 'C:/profile/sessions/1.jsonl')
    // Working-state writes must not invalidate a concurrent archive/rename CAS.
    strictEqual(after.revision, conversation.revision)

    repository.setAgentConversationRuntimeSession(conversation.id, null)
    strictEqual(repository.listAgentConversations().find((candidate) => candidate.id === conversation.id)!.runtimeSessionId, null)
  })
})
