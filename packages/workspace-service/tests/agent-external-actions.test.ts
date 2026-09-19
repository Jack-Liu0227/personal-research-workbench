/*
 * Behaviour of the Agent external-write decision layer.
 *
 * These are the properties the whole "the Agent may prepare, a person decides"
 * design rests on, and each one is a way it could silently become unsafe:
 *
 *   1. Requesting a write previews it and stores nothing else. No port that
 *      mutates anything may be called before a decision exists.
 *   2. Approving replays exactly the frozen preview — the id the preview
 *      returned, the profile the row names — and never re-derives it from a
 *      later selection.
 *   3. A connector conflict settles as `conflict`, a refusal settles as
 *      `failed`; neither is reported as success and neither leaves the row
 *      pending.
 *   4. Rejecting never touches a port at all.
 *   5. Every outcome lands as a ledger record on the run, so the conversation
 *      shows what happened without another model turn.
 *   6. A secret that reached the connector is redacted out of any stored error.
 *
 * The ports are stubs: this layer must not be tested through the connector, and
 * the tests that do exercise a real Zotero/Obsidian are separate.
 *
 * Usage: pnpm test:agent-external-actions
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IntegrationRuntimeError } from '@prw/connectors'
import { WorkbenchRepository } from '@prw/database'
import { AgentExternalActionCoordinator, type AgentExternalActionPorts } from '../src/agent-external-actions.js'
import { RedactedExternalError } from '../src/errors.js'

interface Harness {
  readonly coordinator: AgentExternalActionCoordinator
  readonly repository: WorkbenchRepository
  readonly calls: string[]
  readonly runId: string
  readonly conversationId: string
  /** The action of this run whose summary contains `match`, or the newest one
   * when no `match` is given. */
  readonly actionId: (match?: string) => string
  readonly close: () => void
}

const previewFields = { targetCollectionKey: 'COLL-1', format: 'ris', transport: 'api' }

function harness(
  overrides: Partial<AgentExternalActionPorts> = {},
  secret: string | null = null,
  /** Shifts this harness's clock so the decision window can be tested without
   * waiting for it. Always relative to the real clock, because the repository
   * expires rows against its own `now`. */
  clockOffsetMs = 0
): Harness {
  const root = mkdtempSync(join(tmpdir(), 'prw-external-action-service-'))
  const repository = new WorkbenchRepository({ filePath: join(root, 'workspace.sqlite3') })
  const calls: string[] = []
  const startedAt = Date.now() + clockOffsetMs
  const conversation = repository.createAgentConversation({ title: '外部写入', runtime: 'pi' })
  const run = repository.startManagedAgentRun({
    jobId: null,
    conversationId: conversation.id,
    runtime: 'pi',
    transport: 'inprocess',
    workflowKey: 'research_plan',
    projectId: null,
    paperIds: [],
    instructions: '写进 Zotero',
    toolProfile: 'approved-write',
    idempotencyKey: null
  })
  const base: AgentExternalActionPorts = {
    previewPaperToZotero: async (input) => {
      calls.push(`previewPaper:${input.profileId}:${input.paperIds.join(',')}`)
      return { previewId: 'preview-paper', ...previewFields } as never
    },
    executePaperToZotero: async (input, receivedSecret) => {
      calls.push(`executePaper:${input.previewId}:${receivedSecret ?? 'none'}`)
      return { created: 2, updated: 0, skipped: 0, conflict: 0, failed: 0 } as never
    },
    previewStagingToZotero: async (input) => {
      calls.push(`previewStaging:${input.profileId}:${input.stagingIds.join(',')}`)
      return { previewId: 'preview-staging', ...previewFields } as never
    },
    executeStagingToZotero: async (input) => {
      calls.push(`executeStaging:${input.previewId}`)
      return { created: 1, skipped: 0, conflict: 0, failed: 0 } as never
    },
    readNote: async (input) => {
      calls.push(`readNote:${input.relativePath}`)
      return { relativePath: input.relativePath, content: 'old', fingerprint: '111:222' } as never
    },
    writeNote: async (input) => {
      calls.push(`writeNote:${input.relativePath}:${input.expectedFingerprint ?? 'new'}`)
      return { relativePath: input.relativePath, fingerprint: '333:444' } as never
    },
    previewNoteMetadata: async (input) => {
      calls.push(`previewMetadata:${input.relativePath}`)
      return { fingerprint: '555:666', changedFields: ['title'] } as never
    },
    applyNoteMetadata: async (input) => {
      calls.push(`applyMetadata:${input.relativePath}:${input.expectedFingerprint}`)
      return { relativePath: input.relativePath, fingerprint: '777:888' } as never
    },
    ...overrides
  }
  const coordinator = new AgentExternalActionCoordinator({
    repository,
    ports: base,
    requestIntegrationSecret: () => Promise.resolve(secret),
    newId: () => `action-${repository.listAgentExternalActions({}).length + 1}`,
    now: () => new Date(startedAt)
  })
  return {
    coordinator,
    repository,
    calls,
    runId: run.id,
    conversationId: conversation.id,
    actionId: (match) => {
      const actions = repository.listAgentExternalActions({ runId: run.id })
      const found = match === undefined ? actions[0] : actions.find((action) => action.summary.includes(match))
      assert.ok(found, `the request must have stored an action${match === undefined ? '' : ` matching ${match}`}`)
      return found.id
    },
    close: () => {
      repository.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

describe('agent external action requests', () => {
  it('previews and stores a pending decision without writing anything', async () => {
    const h = harness()
    try {
      const result = await h.coordinator.requestZoteroImport(
        { profileId: 'profile-1', paperIds: ['paper-1', 'paper-2'] },
        { runId: h.runId }
      )
      assert.equal(result.action.status, 'pending')
      assert.equal(result.action.kind, 'zotero-import')
      assert.equal(result.action.previewId, 'preview-paper')
      assert.equal(result.action.conversationId, h.conversationId)
      assert.match(result.action.summary, /2 条文献/u)
      assert.match(result.action.summary, /COLL-1/u)
      // The message is what the model repeats to the user, so it has to say the
      // write has not happened.
      assert.match(result.message, /尚未写入/u)
      assert.deepEqual(h.calls, ['previewPaper:profile-1:paper-1,paper-2'])
    } finally {
      h.close()
    }
  })

  it('routes a staging request to the staging preview and names the origin', async () => {
    const h = harness()
    try {
      const result = await h.coordinator.requestStagingZoteroImport(
        { profileId: 'profile-1', stagingIds: ['stage-1'] },
        { runId: h.runId }
      )
      assert.match(result.action.summary, /检索暂存/u)
      assert.deepEqual(h.repository.getAgentExternalActionPayload(h.actionId())?.payload, {
        route: 'literature-import',
        previewId: 'preview-staging'
      })
      assert.deepEqual(h.calls, ['previewStaging:profile-1:stage-1'])
    } finally {
      h.close()
    }
  })

  it('keeps the two Zotero routes apart so a staging write cannot execute a Paper preview', async () => {
    const h = harness()
    try {
      await h.coordinator.requestZoteroImport({ profileId: 'profile-1', paperIds: ['paper-1'] }, { runId: h.runId })
      await h.coordinator.requestStagingZoteroImport({ profileId: 'profile-1', stagingIds: ['stage-1'] }, { runId: h.runId })
      const decided = await h.coordinator.decide({ id: h.actionId('检索暂存'), decision: 'approve', expectedRevision: 0 })
      assert.equal(decided.status, 'executed')
      assert.deepEqual(h.calls, [
        'previewPaper:profile-1:paper-1',
        'previewStaging:profile-1:stage-1',
        'executeStaging:preview-staging'
      ])
      // The Paper request is untouched and still waiting for its own decision.
      assert.equal(h.coordinator.list({ conversationId: h.conversationId }).filter((a) => a.status === 'pending').length, 1)
    } finally {
      h.close()
    }
  })

  it('freezes the current fingerprint of an Obsidian note and reuses it on approval', async () => {
    const h = harness()
    try {
      const result = await h.coordinator.requestNoteWrite(
        { vaultId: 'vault-1', relativePath: 'Notes/a.md', content: 'new text' },
        { runId: h.runId }
      )
      assert.match(result.action.summary, /覆盖 Obsidian 笔记/u)
      assert.deepEqual(h.repository.getAgentExternalActionPayload(h.actionId())?.payload, {
        route: 'obsidian-note',
        vaultId: 'vault-1',
        relativePath: 'Notes/a.md',
        content: 'new text',
        expectedFingerprint: '111:222',
        overwrites: true
      })
      const decided = await h.coordinator.decide({ id: h.actionId(), decision: 'approve', expectedRevision: 0 })
      assert.equal(decided.status, 'executed')
      assert.deepEqual(h.calls, ['readNote:Notes/a.md', 'writeNote:Notes/a.md:111:222'])
    } finally {
      h.close()
    }
  })

  it('refuses to write over a note whose fingerprint moved since it was read', async () => {
    const h = harness()
    try {
      await assert.rejects(
        h.coordinator.requestNoteWrite(
          { vaultId: 'vault-1', relativePath: 'Notes/a.md', content: 'body', expectedFingerprint: '999:000' },
          { runId: h.runId }
        ),
        /已在外部更新/u
      )
      // Nothing was queued, so there is no card offering a write that has
      // already lost its race.
      assert.deepEqual(h.repository.listAgentExternalActions({}), [])
      assert.deepEqual(h.calls, ['readNote:Notes/a.md'])
    } finally {
      h.close()
    }
  })

  it('treats a missing Obsidian note as create-new instead of a failure', async () => {
    const missing = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    const h = harness({ readNote: () => Promise.reject(missing) })
    try {
      const result = await h.coordinator.requestNoteWrite(
        { vaultId: 'vault-1', relativePath: 'Notes/new.md', content: 'body' },
        { runId: h.runId }
      )
      assert.match(result.action.summary, /新建/u)
      assert.deepEqual(h.repository.getAgentExternalActionPayload(h.actionId())?.payload, {
        route: 'obsidian-note',
        vaultId: 'vault-1',
        relativePath: 'Notes/new.md',
        content: 'body',
        expectedFingerprint: null,
        overwrites: false
      })
    } finally {
      h.close()
    }
  })

  it('reports a non-ENOENT read failure instead of previewing an empty note', async () => {
    const failure = new IntegrationRuntimeError('NOT_CONNECTED', 'Vault 未连接')
    const h = harness({ readNote: () => Promise.reject(failure) })
    try {
      await assert.rejects(
        h.coordinator.requestNoteWrite({ vaultId: 'vault-1', relativePath: 'Notes/a.md', content: 'body' }, { runId: h.runId }),
        /Vault 未连接/u
      )
      assert.deepEqual(h.repository.listAgentExternalActions({}), [])
    } finally {
      h.close()
    }
  })

  it('freezes the metadata preview fingerprint and names the changed fields', async () => {
    const h = harness()
    try {
      const result = await h.coordinator.requestNoteMetadata(
        { vaultId: 'vault-1', relativePath: 'Notes/a.md', patch: { title: '新标题' } },
        { runId: h.runId }
      )
      assert.match(result.action.summary, /title/u)
      assert.deepEqual(h.repository.getAgentExternalActionPayload(h.actionId())?.payload, {
        route: 'obsidian-metadata',
        vaultId: 'vault-1',
        relativePath: 'Notes/a.md',
        patch: { title: '新标题' },
        expectedFingerprint: '555:666'
      })
    } finally {
      h.close()
    }
  })
})

describe('agent external action decisions', () => {
  it('never touches a port when the user rejects', async () => {
    const h = harness()
    try {
      await h.coordinator.requestZoteroImport({ profileId: 'profile-1', paperIds: ['paper-1'] }, { runId: h.runId })
      const rejected = await h.coordinator.decide({ id: h.actionId(), decision: 'reject', expectedRevision: 0 })
      assert.equal(rejected.status, 'rejected')
      assert.equal(rejected.receipt, null)
      assert.deepEqual(h.calls, ['previewPaper:profile-1:paper-1'])
    } finally {
      h.close()
    }
  })

  it('settles a connector conflict as a conflict rather than a success or a generic failure', async () => {
    for (const error of [
      new IntegrationRuntimeError('REVISION_CONFLICT', 'Zotero 条目已在外部更新'),
      new RedactedExternalError({
        code: 'EXTERNAL_CONFLICT',
        provider: 'obsidian',
        entityKind: 'note',
        entityId: 'Notes/a.md',
        externalId: null,
        remoteRevision: null,
        retryable: false,
        requiresConfirmation: false,
        partial: false,
        message: 'Obsidian 文件已在外部更新'
      })
    ]) {
      const h = harness({ executePaperToZotero: () => Promise.reject(error) })
      try {
        await h.coordinator.requestZoteroImport({ profileId: 'profile-1', paperIds: ['paper-1'] }, { runId: h.runId })
        const decided = await h.coordinator.decide({ id: h.actionId(), decision: 'approve', expectedRevision: 0 })
        assert.equal(decided.status, 'conflict', error.constructor.name)
        assert.equal(decided.receipt, null)
        assert.match(decided.error, /外部更新/u)
      } finally {
        h.close()
      }
    }
  })

  it('settles an unrelated connector failure as failed', async () => {
    const h = harness({ executePaperToZotero: () => Promise.reject(new IntegrationRuntimeError('RATE_LIMITED', 'Zotero 限流')) })
    try {
      await h.coordinator.requestZoteroImport({ profileId: 'profile-1', paperIds: ['paper-1'] }, { runId: h.runId })
      const decided = await h.coordinator.decide({ id: h.actionId(), decision: 'approve', expectedRevision: 0 })
      assert.equal(decided.status, 'failed')
      assert.match(decided.error, /限流/u)
    } finally {
      h.close()
    }
  })

  it('fails honestly when the frozen payload is gone', async () => {
    const h = harness()
    try {
      await h.coordinator.requestZoteroImport({ profileId: 'profile-1', paperIds: ['paper-1'] }, { runId: h.runId })
      // Simulates a row whose payload was never written or was removed: the
      // approval must not silently "succeed" without executing anything.
      h.repository.getAgentExternalActionPayload = () => null
      const decided = await h.coordinator.decide({ id: h.actionId(), decision: 'approve', expectedRevision: 0 })
      assert.equal(decided.status, 'failed')
      assert.match(decided.error, /重新生成预览/u)
      assert.deepEqual(h.calls, ['previewPaper:profile-1:paper-1'])
    } finally {
      h.close()
    }
  })

  it('redacts the integration secret out of a stored failure', async () => {
    const h = harness(
      { executePaperToZotero: () => Promise.reject(new Error('rejected key secret-value-1234 by Zotero')) },
      'secret-value-1234'
    )
    try {
      await h.coordinator.requestZoteroImport({ profileId: 'profile-1', paperIds: ['paper-1'] }, { runId: h.runId })
      const decided = await h.coordinator.decide({ id: h.actionId(), decision: 'approve', expectedRevision: 0 })
      assert.equal(decided.error.includes('secret-value-1234'), false)
      assert.match(decided.error, /rejected key/u)
    } finally {
      h.close()
    }
  })

  it('writes one ledger receipt per outcome so the conversation can show it', async () => {
    const h = harness()
    try {
      await h.coordinator.requestZoteroImport({ profileId: 'profile-1', paperIds: ['paper-1'] }, { runId: h.runId })
      const id = h.actionId()
      await h.coordinator.decide({ id, decision: 'approve', expectedRevision: 0 })
      const records = h.repository.listAgentRunRecords({ runId: h.runId, beforeSeq: null, afterSeq: null, limit: 50 })
      const receipt = records.find((record) => record.recordKey === `external-action:${id}`)
      assert.ok(receipt, 'the decision must leave a ledger record')
      assert.equal(receipt.status, 'completed')
      assert.equal(receipt.toolName, 'agent.externalActions.decide')
      assert.match(receipt.detail ?? '', /外部写入已执行/u)
    } finally {
      h.close()
    }
  })

  it('never expires a request that is still inside its window', async () => {
    const h = harness()
    try {
      await h.coordinator.requestZoteroImport({ profileId: 'profile-1', paperIds: ['paper-1'] }, { runId: h.runId })
      assert.equal(h.coordinator.expire(), 0)
      assert.equal(h.coordinator.list({ conversationId: h.conversationId })[0]?.status, 'pending')
    } finally {
      h.close()
    }
  })

  it('expires an undecided request so a stale preview cannot be approved later', async () => {
    // The request was made an hour ago, so its 30-minute window has closed.
    const h = harness({}, null, -60 * 60 * 1000)
    try {
      await h.coordinator.requestZoteroImport({ profileId: 'profile-1', paperIds: ['paper-1'] }, { runId: h.runId })
      assert.equal(h.coordinator.expire(), 1)
      const expired = h.coordinator.list({ conversationId: h.conversationId })[0]
      assert.equal(expired?.status, 'expired')
      assert.match(expired?.error ?? '', /过期/u)
      // Either message is acceptable — expired rows are no longer `pending`, so
      // the guard reports the decision as already made. What matters is that no
      // port ran.
      await assert.rejects(
        h.coordinator.decide({ id: h.actionId(), decision: 'approve', expectedRevision: 1 }),
        /(expired|already decided)/u
      )
      // The preview is never replayed for a decision nobody made in time.
      assert.deepEqual(h.calls, ['previewPaper:profile-1:paper-1'])
    } finally {
      h.close()
    }
  })
})
