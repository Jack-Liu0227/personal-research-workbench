import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { equal, match, ok } from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchRepository } from '@prw/database'
import { AgentCoordinator } from '../src/agent-coordinator.js'

/**
 * 每日文献推送（消息侧）协调器级行为：
 * - 未绑定飞书 → 计划任务在模型调用前被阻断（blocked run + 已结算 occurrence），
 *   不消耗模型额度、不创建会话、不产生误导性的 failed；
 * - 绑定时钩子缺失（bare host）→ 不阻断，交给完成时的 NO_SINK 兜底；
 * - 矩阵增强注入发生在 runAutomationNow 的指令拼接处（模块级已测格式）。
 */

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'prw-feishu-msg-coord-'))
}

describe('literature_daily_msg scheduled run gate', () => {
  let root: string
  let repository: WorkbenchRepository
  let coordinator: AgentCoordinator

  afterEach(() => {
    coordinator?.dispose()
    repository?.close()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('blocks the occurrence before any model call when Feishu is not bound', async () => {
    root = makeRoot()
    repository = new WorkbenchRepository({ filePath: join(root, 'workspace.sqlite3'), now: () => new Date('2026-09-20T04:00:00.000Z') })
    coordinator = new AgentCoordinator(repository, {
      runRoot: join(root, 'agent-runs'),
      // No agentRuntime at all: if the gate fires first, no runtime is ever
      // probed and no model call can happen. A gate that reached the runtime
      // would surface as a runtime-unavailable run instead of the bound refusal.
      requestFeishuStatus: async () => false
    })

    const run = await coordinator.runAutomationNow('builtin.schedule.feishu-daily-msg')
    equal(run.status, 'blocked')
    match(run.error ?? '', /未绑定飞书应用/)
    equal(run.jobId, 'builtin.schedule.feishu-daily-msg')
    equal(run.workflowKey, 'literature_daily_msg')
    // No conversation was created: the refusal happens before any session.
    const history = coordinator.listAutomationRunHistory({ limit: 10, scheduleId: 'builtin.schedule.feishu-daily-msg' })
    const entry = history.find((item) => item.runId === run.id)
    ok(entry, 'the blocked run must be visible in run history')
    equal(entry.status, 'blocked')
    match(entry.blockedReason ?? '', /未绑定飞书应用/)
    // A blocked run is retryable by contract: a later trigger mints a fresh
    // occurrence key (`:retry:` suffix) and refuses again instead of replaying
    // the old row — the slot stays explainable and the next bound state wins.
    const again = await coordinator.runAutomationNow('builtin.schedule.feishu-daily-msg')
    equal(again.status, 'blocked')
    equal(again.jobId, 'builtin.schedule.feishu-daily-msg')
    ok(again.id !== run.id, 'a retried blocked run is a fresh run row')
  })

  it('does not consult the Feishu hook for other workflows', async () => {
    root = makeRoot()
    repository = new WorkbenchRepository({ filePath: join(root, 'workspace.sqlite3'), now: () => new Date('2026-09-20T04:00:00.000Z') })
    let probed = 0
    coordinator = new AgentCoordinator(repository, {
      runRoot: join(root, 'agent-runs'),
      requestFeishuStatus: async () => {
        probed += 1
        return false
      }
    })
    // A runtime-less host reports the daily-digest rule as a blocked run (the
    // runtime-unavailable path returns, it does not throw). The Feishu probe is
    // scoped to the message workflow only: it must never have been consulted.
    const run = await coordinator.runAutomationNow('builtin.schedule.last30days')
    equal(run.status, 'blocked')
    equal(probed, 0)
  })

  it('passes the bound gate and then runs the RSS fast path without a runtime', async () => {
    root = makeRoot()
    repository = new WorkbenchRepository({ filePath: join(root, 'workspace.sqlite3'), now: () => new Date('2026-09-20T04:00:00.000Z') })
    coordinator = new AgentCoordinator(repository, {
      runRoot: join(root, 'agent-runs'),
      requestFeishuStatus: async () => true,
      // Bound passes; increment 3 routes the rule into the RSS fast path, which
      // never probes an agent runtime. Stub the feed so no real network is hit.
      rssFetchImpl: async () => new Response('<?xml version="1.0"?><rss version="2.0"><channel><title>E</title></channel></rss>', { status: 200 })
    })
    const run = await coordinator.runAutomationNow('builtin.schedule.feishu-daily-msg')
    equal(run.status, 'completed')
    equal(run.jobId, 'builtin.schedule.feishu-daily-msg')
    equal(run.workflowKey, 'literature_daily_msg')
  })
})
