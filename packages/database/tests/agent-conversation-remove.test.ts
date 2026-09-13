/*
 * Focused contract for the Agent history rail's conversation deletion.
 *
 * "删除" in the conversation history is a CAS-locked soft archive of the
 * conversation *record*: it leaves the default list projection, but the row and
 * every associated `agent_runs` / `agent_events` / `agent_messages` row stay
 * readable for audit. These checks pin the promises the UI renders from:
 * per-record outcomes (succeeded/skipped/conflict/failed), a revision lock on
 * every write, no cascade into runs/events/messages, other conversations or the
 * project, a refusal to delete a conversation whose run is still active, and
 * never a dropped row.
 *
 * Usage: pnpm test:agent-history-delete
 */
import { afterEach, describe, it } from 'node:test'
import { deepStrictEqual, equal, throws } from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { WorkbenchRepository } from '../src/repository.ts'

const roots: string[] = []
const open: WorkbenchRepository[] = []

function openRepository(): { filePath: string; repository: WorkbenchRepository } {
  const root = mkdtempSync(join(tmpdir(), 'prw-agent-conversation-remove-'))
  roots.push(root)
  const filePath = join(root, 'workspace.sqlite3')
  const repository = new WorkbenchRepository({ filePath, now: () => new Date('2026-09-13T00:00:00.000Z') })
  open.push(repository)
  return { filePath, repository }
}

afterEach(() => {
  // Windows keeps a file handle alive until the connection is closed, so the
  // temp directory can only be removed afterwards.
  while (open.length > 0) open.pop()!.close()
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

/** One conversation as the history rail lists it. */
function conversation(repository: WorkbenchRepository, title: string) {
  return repository.createAgentConversation({ title, runtime: 'codex' })
}

/** One run of a conversation, plus the ledger rows the delete must not touch. */
function conversationRun(repository: WorkbenchRepository, conversationId: string, idempotencyKey: string) {
  const run = repository.startManagedAgentRun({
    jobId: null,
    conversationId,
    runtime: 'codex',
    transport: 'inprocess',
    workflowKey: 'research_plan',
    projectId: null,
    paperIds: [],
    instructions: '题目检索',
    toolProfile: 'read-only',
    idempotencyKey
  })
  repository.appendAgentEvent(run.id, 'progress', { message: 'progress' })
  const message = repository.appendAgentMessage({ conversationId, runId: run.id, role: 'assistant', content: '回答正文' })
  return { run, message }
}

/** The CAS lock the rail renders for one conversation: its current revision. */
function lock(repository: WorkbenchRepository, conversationId: string): { id: string; expectedRevision: number } {
  const row = repository.listAgentConversations({ includeArchived: false, limit: 100 }).find((candidate) => candidate.id === conversationId)
  if (!row) throw new Error(`conversation ${conversationId} missing from the history range`)
  return { id: row.id, expectedRevision: row.revision }
}

function conversationRow(filePath: string, id: string) {
  const database = new BetterSqlite3(filePath, { readonly: true })
  try {
    return database.prepare('select status, archived_at, revision from agent_conversations where id = ?').get(id) as {
      status: string
      archived_at: string | null
      revision: number
    } | undefined
  } finally {
    database.close()
  }
}

function tableCount(filePath: string, table: 'agent_conversations' | 'agent_runs' | 'agent_run_events' | 'agent_messages'): number {
  const database = new BetterSqlite3(filePath, { readonly: true })
  try {
    return (database.prepare(`select count(*) as total from ${table}`).get() as { total: number }).total
  } finally {
    database.close()
  }
}

describe('Agent conversation history removal (Agent → 对话)', () => {
  it('soft-archives each locked conversation with a per-record CAS receipt', () => {
    const { repository, filePath } = openRepository()
    const keep = conversation(repository, '保留的对话')
    // The conversation changed *after* the list was read: the selection is a
    // stale lock and must report a conflict instead of being removed.
    const stale = conversation(repository, '已更新的对话')
    const staleLock = lock(repository, stale.id)
    repository.appendAgentMessage({ conversationId: stale.id, role: 'user', content: '新的一轮' })
    const fresh = conversation(repository, '新对话')
    const keepLock = lock(repository, keep.id)
    const freshLock = lock(repository, fresh.id)

    const result = repository.removeAgentConversations({
      items: [keepLock, staleLock, freshLock, { id: 'missing-conversation', expectedRevision: 0 }]
    })

    deepStrictEqual(result.items.map((item) => [item.id, item.outcome]), [
      [keep.id, 'succeeded'],
      [stale.id, 'conflict'],
      [fresh.id, 'succeeded'],
      ['missing-conversation', 'skipped']
    ])
    deepStrictEqual(result.items[1]?.error, { code: 'REVISION_CONFLICT', message: '对话已被更新，请刷新历史列表后重试。', retryable: true })
    equal(result.items[0]?.error, null)
    equal(result.succeeded, 2)
    equal(result.skipped, 1)
    equal(result.conflict, 1)
    equal(result.failed, 0)
    equal(result.canceled, false)

    // Only the conflicted conversation stays in the loaded range.
    deepStrictEqual(repository.listAgentConversations({ includeArchived: false, limit: 100 }).map((row) => row.id), [stale.id])
    equal(conversationRow(filePath, keep.id)?.archived_at !== null, true)
    equal(conversationRow(filePath, keep.id)?.status, 'archived')
    equal(conversationRow(filePath, keep.id)?.revision, keepLock.expectedRevision + 1)
    equal(conversationRow(filePath, stale.id)?.archived_at, null)
    equal(conversationRow(filePath, stale.id)?.revision, staleLock.expectedRevision + 1)
    // Archives are audit rows, never dropped.
    equal(tableCount(filePath, 'agent_conversations'), 3)
    equal(repository.getAgentConversation(keep.id).archivedAt !== null, true)
    // Archived conversations remain readable by id (still inspectable/recoverable).
    equal(repository.listAgentConversations({ includeArchived: true, limit: 100 }).length, 3)
  })

  it('keeps the runs, events and messages of a deleted conversation readable', () => {
    const { repository, filePath } = openRepository()
    const removed = conversation(repository, '带运行的对话')
    const { run, message } = conversationRun(repository, removed.id, 'conversation-run')
    repository.updateManagedAgentRun({ id: run.id, status: 'completed', output: '摘要正文', error: null })
    const before = {
      runs: tableCount(filePath, 'agent_runs'),
      events: tableCount(filePath, 'agent_run_events'),
      messages: tableCount(filePath, 'agent_messages')
    }

    equal(repository.removeAgentConversations({ items: [lock(repository, removed.id)] }).succeeded, 1)

    deepStrictEqual(repository.listAgentConversations({ includeArchived: false, limit: 100 }), [])
    // Nothing cascaded: the run ledger and the chat log are byte-identical.
    equal(tableCount(filePath, 'agent_runs'), before.runs)
    equal(tableCount(filePath, 'agent_run_events'), before.events)
    equal(tableCount(filePath, 'agent_messages'), before.messages)
    const storedRun = repository.getManagedAgentRun(run.id)
    equal(storedRun.status, 'completed')
    equal(storedRun.output, '摘要正文')
    equal(repository.listAgentMessages(removed.id, 500)[0]?.content, message.content)
    // The conversation row itself is still there (audit), only hidden from list.
    equal(conversationRow(filePath, removed.id)?.archived_at !== null, true)
  })

  it('refuses to delete a conversation whose run is still active, then deletes it once the run ends', () => {
    const { repository, filePath } = openRepository()
    const busy = conversation(repository, '运行中的对话')
    const { run } = conversationRun(repository, busy.id, 'conversation-active-run')
    const activeLock = lock(repository, busy.id)

    const refused = repository.removeAgentConversations({ items: [activeLock] })
    deepStrictEqual(refused.items, [{
      id: busy.id,
      outcome: 'failed',
      error: { code: 'AGENT_CONVERSATION_RUN_ACTIVE', message: '对话仍有正在运行的 Agent 运行，请先停止或等待完成后再删除。', retryable: true }
    }])
    equal(refused.failed, 1)
    equal(refused.succeeded, 0)
    // Nothing was written: the conversation is still listed with its old revision.
    deepStrictEqual(repository.listAgentConversations({ includeArchived: false, limit: 100 }).map((row) => row.id), [busy.id])
    equal(conversationRow(filePath, busy.id)?.archived_at, null)
    equal(conversationRow(filePath, busy.id)?.revision, activeLock.expectedRevision)

    repository.updateManagedAgentRun({ id: run.id, status: 'completed', output: '完成' })
    equal(repository.removeAgentConversations({ items: [lock(repository, busy.id)] }).succeeded, 1)
    deepStrictEqual(repository.listAgentConversations({ includeArchived: false, limit: 100 }), [])
  })

  it('reports an already removed conversation as skipped without writing again', () => {
    const { repository, filePath } = openRepository()
    const removed = conversation(repository, '重复删除的对话')
    const selected = [lock(repository, removed.id)]
    equal(repository.removeAgentConversations({ items: selected }).succeeded, 1)

    const repeat = repository.removeAgentConversations({ items: selected })
    deepStrictEqual(repeat.items, [{ id: removed.id, outcome: 'skipped', error: null }])
    equal(repeat.succeeded, 0)
    equal(repeat.skipped, 1)
    equal(conversationRow(filePath, removed.id)?.revision, selected[0]!.expectedRevision + 1)
    equal(tableCount(filePath, 'agent_conversations'), 1)
  })

  it('rejects duplicate locks before writing anything', () => {
    const { repository, filePath } = openRepository()
    const target = conversation(repository, '重复锁的对话')
    const selected = lock(repository, target.id)
    throws(() => repository.removeAgentConversations({ items: [selected, selected] }), /unique/u)
    equal(conversationRow(filePath, target.id)?.archived_at, null)
    equal(repository.listAgentConversations({ includeArchived: false, limit: 100 }).length, 1)
  })

  it('still enforces CAS on the single-conversation delete path', () => {
    const { repository, filePath } = openRepository()
    const target = conversation(repository, '单条删除的对话')
    const staleLock = lock(repository, target.id)
    // A new message while the row is selected invalidates the old lock.
    repository.appendAgentMessage({ conversationId: target.id, role: 'user', content: '并发写入' })

    const conflicted = repository.removeAgentConversation(target.id, staleLock.expectedRevision)
    deepStrictEqual(conflicted, {
      id: target.id,
      outcome: 'conflict',
      error: { code: 'REVISION_CONFLICT', message: '对话已被更新，请刷新历史列表后重试。', retryable: true }
    })
    equal(conversationRow(filePath, target.id)?.archived_at, null)
    equal(repository.listAgentConversations({ includeArchived: false, limit: 100 }).length, 1)

    const current = lock(repository, target.id)
    const removed = repository.removeAgentConversation(current.id, current.expectedRevision)
    deepStrictEqual(removed, { id: target.id, outcome: 'succeeded', error: null })
    deepStrictEqual(repository.listAgentConversations({ includeArchived: false, limit: 100 }), [])
    equal(conversationRow(filePath, target.id)?.archived_at !== null, true)
    equal(tableCount(filePath, 'agent_conversations'), 1)
  })
})
