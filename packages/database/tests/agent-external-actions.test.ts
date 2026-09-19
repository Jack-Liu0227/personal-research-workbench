/*
 * Focused check for the Agent external-write decision row (migration 32).
 *
 * The table is the only place an Agent-requested Zotero/Obsidian write waits for
 * a person, so the properties that matter are about the decision, not the write:
 *
 *   1. A request lands as `pending` and is listed by run and by conversation.
 *   2. Approving is a guarded transition. It records the decision and bumps the
 *      revision, and a second decide on the same row — the double click, or a
 *      stale card — is a conflict instead of a second write.
 *   3. The window closes. `expireAgentExternalActions` retires only what nobody
 *      decided, and never a row that was already approved or settled: expiring
 *      an executed write would rewrite history.
 *   4. Settling records the outcome and the receipt, and the frozen payload
 *      stays retrievable for the execution that follows the approval.
 *
 * Usage: pnpm test:agent-external-actions
 */
import { afterEach, describe, it } from 'node:test'
import { deepEqual, equal, ok, strictEqual, throws } from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import { WorkbenchRepository } from '../src/repository.ts'

const roots: string[] = []
const open: WorkbenchRepository[] = []

function makeRepository(): WorkbenchRepository {
  const root = mkdtempSync(join(tmpdir(), 'prw-external-actions-'))
  roots.push(root)
  const repository = new WorkbenchRepository({ filePath: join(root, 'workspace.sqlite3') })
  open.push(repository)
  return repository
}

function handleOf(repository: WorkbenchRepository): BetterSqlite3.Database {
  const handle = (repository as unknown as { sqlite?: BetterSqlite3.Database }).sqlite
  ok(handle !== undefined, 'repository must expose its sqlite handle')
  return handle
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close()
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
  }
})

/** One conversation with one run, which is what a request hangs off. */
function seedRun(repository: WorkbenchRepository): { conversationId: string; runId: string } {
  const conversation = repository.createAgentConversation({ title: '外部写入', runtime: 'pi' })
  const run = repository.startManagedAgentRun({
    jobId: null,
    conversationId: conversation.id,
    runtime: 'pi',
    transport: 'inprocess',
    workflowKey: 'research_plan',
    projectId: null,
    paperIds: [],
    instructions: '把这篇写进 Zotero',
    toolProfile: 'approved-write',
    idempotencyKey: null
  })
  return { conversationId: conversation.id, runId: run.id }
}

/** Far enough ahead that the wall clock cannot make these rows expire
 * mid-test; the expiry tests set their own dates. */
const expiresAt = '2036-09-13T04:30:00.000Z'

function request(repository: WorkbenchRepository, ids: { conversationId: string; runId: string }, overrides: {
  readonly id?: string
  readonly expiresAt?: string
} = {}) {
  return repository.createAgentExternalAction({
    id: overrides.id ?? 'action-1',
    runId: ids.runId,
    conversationId: ids.conversationId,
    kind: 'zotero-import',
    profileId: 'profile-1',
    summary: '写入 Zotero：2 条文献 → 连接 profile-1',
    previewId: 'preview-1',
    payload: { route: 'zotero-import', previewId: 'preview-1' },
    expiresAt: overrides.expiresAt ?? expiresAt
  })
}

describe('agent external actions', () => {
  it('records a request as pending and lists it by run and conversation', () => {
    const repository = makeRepository()
    const ids = seedRun(repository)
    const created = request(repository, ids)

    strictEqual(created.status, 'pending')
    strictEqual(created.revision, 0)
    strictEqual(created.decidedAt, null)
    equal(created.receipt, null)
    strictEqual(created.error, '')
    strictEqual(created.previewId, 'preview-1')
    // The frozen payload is deliberately not part of the renderer shape; it is
    // read separately so a card can never hand it back to the model.
    equal('payload' in created, false)

    deepEqual(repository.listAgentExternalActions({ runId: ids.runId }).map((action) => action.id), ['action-1'])
    deepEqual(repository.listAgentExternalActions({ conversationId: ids.conversationId }).map((action) => action.id), ['action-1'])
    deepEqual(repository.listAgentExternalActions({ status: 'executed' }), [])
    deepEqual(repository.getAgentExternalActionPayload('action-1')?.payload, { route: 'zotero-import', previewId: 'preview-1' })
  })

  it('decides once and refuses every later decision as a conflict', () => {
    const repository = makeRepository()
    const ids = seedRun(repository)
    request(repository, ids)

    const approved = repository.decideAgentExternalAction({ id: 'action-1', decision: 'approve', expectedRevision: 0 })
    strictEqual(approved.status, 'approved')
    strictEqual(approved.revision, 1)
    ok(approved.decidedAt !== null)

    // Double click, stale card, competing window: all the same answer.
    throws(() => repository.decideAgentExternalAction({ id: 'action-1', decision: 'approve', expectedRevision: 1 }), /already decided/u)
    throws(() => repository.decideAgentExternalAction({ id: 'action-1', decision: 'reject', expectedRevision: 0 }), /already decided/u)
  })

  it('refuses a decision made against a revision the card no longer holds', () => {
    const repository = makeRepository()
    const ids = seedRun(repository)
    request(repository, ids)
    throws(() => repository.decideAgentExternalAction({ id: 'action-1', decision: 'approve', expectedRevision: 3 }), /changed since/u)
    // The failed attempt must not have decided anything.
    strictEqual(repository.getAgentExternalAction('action-1')?.status, 'pending')
  })

  it('settles an approved write with its receipt and keeps the payload readable', () => {
    const repository = makeRepository()
    const ids = seedRun(repository)
    request(repository, ids)
    repository.decideAgentExternalAction({ id: 'action-1', decision: 'approve', expectedRevision: 0 })
    const executed = repository.settleAgentExternalAction({
      id: 'action-1',
      status: 'executed',
      receipt: { created: 2, skipped: 0, conflict: 0, failed: 0 }
    })

    strictEqual(executed.status, 'executed')
    deepEqual(executed.receipt, { created: 2, skipped: 0, conflict: 0, failed: 0 })
    strictEqual(executed.error, '')
    deepEqual(repository.getAgentExternalActionPayload('action-1')?.payload, { route: 'zotero-import', previewId: 'preview-1' })
  })

  it('keeps a rejected write without a receipt', () => {
    const repository = makeRepository()
    const ids = seedRun(repository)
    request(repository, ids)
    const rejected = repository.decideAgentExternalAction({ id: 'action-1', decision: 'reject', expectedRevision: 0 })
    strictEqual(rejected.status, 'rejected')
    equal(rejected.receipt, null)
  })

  it('expires only the requests nobody decided', () => {
    const repository = makeRepository()
    const ids = seedRun(repository)
    request(repository, ids, { id: 'action-old', expiresAt: '2000-01-01T03:00:00.000Z' })
    request(repository, ids, { id: 'action-future', expiresAt: '2036-09-13T03:00:00.000Z' })
    repository.decideAgentExternalAction({ id: 'action-future', decision: 'approve', expectedRevision: 0 })

    strictEqual(repository.expireAgentExternalActions(), 1)
    strictEqual(repository.getAgentExternalAction('action-old')?.status, 'expired')
    // An approved write is mid-flight or executed; expiring it would report a
    // decision that was never made and hide a receipt that exists.
    strictEqual(repository.getAgentExternalAction('action-future')?.status, 'approved')
    strictEqual(repository.expireAgentExternalActions(), 0)
  })

  it('refuses to decide a request whose window already closed', () => {
    const repository = makeRepository()
    const ids = seedRun(repository)
    request(repository, ids, { expiresAt: '2000-01-01T00:00:00.000Z' })
    throws(() => repository.decideAgentExternalAction({ id: 'action-1', decision: 'approve', expectedRevision: 0 }), /expired/u)
    strictEqual(repository.getAgentExternalAction('action-1')?.status, 'expired')
  })

  it('drops the request with its run', () => {
    const repository = makeRepository()
    const ids = seedRun(repository)
    request(repository, ids)
    handleOf(repository).prepare('DELETE FROM agent_runs WHERE id = ?').run(ids.runId)
    deepEqual(repository.listAgentExternalActions({}), [])
  })
})
