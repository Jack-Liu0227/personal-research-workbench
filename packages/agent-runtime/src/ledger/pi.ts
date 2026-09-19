import type { AgentRecordStatus, AgentRunRecordDraft } from '@prw/contracts'
import {
  BaseLedgerNormalizer,
  asRecord,
  asString,
  ledgerText,
  ledgerUsage,
  oneLine,
  safeJson
} from './types.js'

/**
 * Normalize Pi `-p --mode json` output.
 *
 * Pi prints one `AgentSessionEvent` per line (see
 * `@earendil-works/pi-coding-agent/dist/modes/json-event.js`), preceded by the
 * persisted session header. Streaming deltas arrive as
 * `message_update.assistantMessageEvent`, tool lifecycles as
 * `tool_execution_start/update/end`, and the prompt boundary as
 * `agent_start`/`turn_start`/`turn_end`/`agent_end`.
 */
export interface PiLedgerNormalizerOptions {
  readonly toolLabels?: ReadonlyMap<string, string> | undefined
}
export class PiLedgerNormalizer extends BaseLedgerNormalizer {
  private assistantOrdinal = 0
  private reasoningOrdinal = 0
  private assistantKey: string | null = null
  private reasoningKey: string | null = null
  /** Provider-visible tool name back to the workbench name it was registered
   * from. A tool is registered as `tasks_search` and documented as
   * `tasks.search`, and the ledger is read by people, so it shows the latter. */
  private readonly toolLabels: ReadonlyMap<string, string>

  constructor(options: PiLedgerNormalizerOptions = {}) {
    super()
    this.toolLabels = options.toolLabels ?? new Map()
  }

  accept(payload: unknown, createdAt: string): AgentRunRecordDraft[] {
    const event = asRecord(payload)
    if (!event) {
      const text = typeof payload === 'string' ? payload.trim() : ''
      return text === ''
        ? []
        : [{
          recordKey: this.uniqueKey('pi:text'),
          kind: 'diagnostic',
          status: 'info',
          turn: this.turn,
          step: this.step,
          title: 'Pi 输出',
          detail: text,
          startedAt: createdAt
        }]
    }
    const type = asString(event['type']) ?? ''
    switch (type) {
      // Session banner written by print mode before the first event.
      case 'session':
        return [{
          recordKey: 'pi:session',
          kind: 'system',
          status: 'info',
          turn: 0,
          step: 0,
          title: '本次运行会话',
          detail: asString(event['id']) ? `session ${asString(event['id'])}` : '',
          startedAt: createdAt
        }]
      // `agent_start` opens the prompt; the turn boundary is `turn_start`, and
      // `currentTurn()` covers a revision that only emits the prompt event.
      case 'agent_start':
        return []
      case 'turn_start':
        this.beginTurn()
        return []
      case 'turn_end':
        return this.turnEndRecords(event, createdAt, 'completed')
      case 'agent_end':
        return this.turnClosed || this.turn === 0 ? [] : this.turnEnd('completed', createdAt)
      case 'agent_settled':
        return []
      case 'message_start':
      case 'message_update':
      case 'message_end':
        return this.message(type, event, createdAt)
      case 'tool_execution_start':
      case 'tool_execution_update':
      case 'tool_execution_end':
        return this.tool(type, event, createdAt)
      case 'bash_execution_update':
        return this.bashEvent(event, createdAt)
      case 'compaction_start':
        return [{
          recordKey: 'pi:compaction',
          kind: 'compacted',
          status: 'running',
          turn: this.turn,
          step: this.step,
          title: `上下文压缩（${asString(event['reason']) ?? 'unknown'}）`,
          detail: '',
          startedAt: createdAt
        }]
      case 'compaction_end':
        return [{
          recordKey: 'pi:compaction',
          kind: 'compacted',
          status: asString(event['errorMessage']) !== null || event['aborted'] === true ? 'failed' : 'completed',
          turn: this.turn,
          step: this.step,
          title: `上下文压缩（${asString(event['reason']) ?? 'unknown'}）`,
          detail: asString(event['errorMessage']) ?? (event['result'] === undefined ? '' : safeJson(event['result'])),
          finishedAt: createdAt
        }]
      case 'auto_retry_start':
      case 'auto_retry_end':
      case 'summarization_retry_scheduled':
      case 'summarization_retry_attempt_start':
      case 'summarization_retry_finished':
        return this.retryEvent(type, event, createdAt)
      case 'queue_update':
        return [{
          recordKey: `pi:queue:${this.currentTurn()}`,
          kind: 'context',
          status: 'info',
          turn: this.currentTurn(),
          step: this.step,
          title: '排队消息',
          detail: [...asStringArray(event['steering']), ...asStringArray(event['followUp'])].join('\n'),
          startedAt: createdAt
        }]
      case 'session_info_changed':
        return [{
          recordKey: 'pi:session-info',
          kind: 'context',
          status: 'info',
          turn: this.turn,
          step: this.step,
          title: '会话信息',
          detail: asString(event['name']) ?? '',
          startedAt: createdAt
        }]
      case 'thinking_level_changed':
        return [{
          recordKey: 'pi:thinking-level',
          kind: 'context',
          status: 'info',
          turn: this.turn,
          step: this.step,
          title: '思考深度',
          detail: asString(event['level']) ?? '',
          startedAt: createdAt
        }]
      case 'model_select': {
        const model = asRecord(event['model'])
        return [{
          recordKey: 'pi:model',
          kind: 'context',
          status: 'info',
          turn: this.turn,
          step: this.step,
          title: '模型',
          detail: (model ? asString(model['id']) ?? asString(model['name']) : null) ?? '',
          startedAt: createdAt
        }]
      }
      // Session-persistence bookkeeping: the same content already arrived as
      // message/tool events, so mapping it to a record would duplicate the
      // transcript rather than inform it.
      case 'entry_appended':
        return []
      default:
        return [{
          recordKey: this.uniqueKey('pi:unknown'),
          kind: 'diagnostic',
          status: 'info',
          turn: this.turn,
          step: this.step,
          title: type ? `未识别的 Pi 事件：${type}` : '未识别的 Pi 输出',
          detail: '',
          outputText: safeJson(payload),
          startedAt: createdAt
        }]
    }
  }

  private message(type: string, event: Record<string, unknown>, createdAt: string): AgentRunRecordDraft[] {
    const message = asRecord(event['message'])
    const role = message ? asString(message['role']) : null
    // Pi emits the same start/end pair for the user prompt, which the
    // coordinator already persisted as the run's `user` record.
    if (role !== null && role !== 'assistant') return []
    if (type === 'message_update') return this.messageUpdate(event, createdAt)
    const fullText = ledgerText(message?.['content'])
    const recordKey = this.assistant()
    if (type === 'message_start') {
      const isNew = this.touch(recordKey, createdAt, 'assistant', 'running')
      return [{
        recordKey,
        kind: 'assistant',
        status: 'running',
        turn: this.currentTurn(),
        step: this.step,
        title: 'Pi',
        detail: this.accumulate(recordKey, fullText, false),
        ...(isNew ? { startedAt: createdAt } : {})
      }]
    }
    const usage = ledgerUsage(message?.['usage'])
    const isNew = this.touch(recordKey, createdAt, 'assistant', 'completed')
    return [
      {
        recordKey,
        kind: 'assistant',
        status: 'completed',
        turn: this.currentTurn(),
        step: this.step,
        title: 'Pi',
        detail: this.accumulate(recordKey, fullText, false),
        ...(isNew ? { startedAt: createdAt } : {}),
        finishedAt: createdAt,
        durationMs: this.durationOf(recordKey, createdAt),
        ...(usage === null ? {} : { usage })
      },
      // The thinking of an assistant message is finished with the message; Pi
      // never sends a second boundary for it, so without this close the Chat
      // view would keep a Thinking row spinning for the rest of the run.
      ...this.closeReasoning(createdAt)
    ]
  }

  private closeReasoning(createdAt: string): AgentRunRecordDraft[] {
    const recordKey = this.reasoningKey
    if (recordKey === null || this.openStatus(recordKey) !== 'running') return []
    const durationMs = this.durationOf(recordKey, createdAt)
    this.touch(recordKey, createdAt, 'reasoning', 'completed')
    return [{
      recordKey,
      kind: 'reasoning',
      status: 'completed',
      turn: this.currentTurn(),
      step: this.step,
      finishedAt: createdAt,
      ...(durationMs === null ? {} : { durationMs })
    }]
  }

  private messageUpdate(event: Record<string, unknown>, createdAt: string): AgentRunRecordDraft[] {
    const assistantEvent = asRecord(event['assistantMessageEvent'])
    if (!assistantEvent) return []
    const eventType = asString(assistantEvent['type']) ?? ''
    if (eventType === 'text_delta' || eventType === 'text_end') {
      const recordKey = this.assistant()
      const chunk = eventType === 'text_end'
        ? asString(assistantEvent['content']) ?? ''
        : asString(assistantEvent['delta']) ?? ''
      const isNew = this.touch(recordKey, createdAt, 'assistant', 'running')
      return [{
        recordKey,
        kind: 'assistant',
        status: 'running',
        turn: this.currentTurn(),
        step: this.step,
        title: 'Pi',
        detail: this.accumulate(recordKey, chunk, eventType === 'text_delta'),
        ...(isNew ? { startedAt: createdAt } : {})
      }]
    }
    if (eventType === 'thinking_delta' || eventType === 'thinking_end') {
      const recordKey = this.reasoning()
      const chunk = eventType === 'thinking_end'
        ? asString(assistantEvent['content']) ?? ''
        : asString(assistantEvent['delta']) ?? ''
      const isNew = this.touch(recordKey, createdAt, 'reasoning', 'running')
      return [{
        recordKey,
        kind: 'reasoning',
        status: 'running',
        turn: this.currentTurn(),
        step: this.step,
        title: 'Thinking',
        detail: this.accumulate(recordKey, chunk, eventType === 'thinking_delta'),
        ...(isNew ? { startedAt: createdAt } : {})
      }]
    }
    if (eventType === 'toolcall_end') {
      const call = asRecord(assistantEvent['toolCall'])
      return call ? [this.toolRecord(call, createdAt, 'running')] : []
    }
    if (eventType === 'error') {
      const message = asString(assistantEvent['errorMessage']) ?? ledgerText(assistantEvent)
      return [{
        recordKey: this.uniqueKey('pi:error'),
        kind: 'error',
        status: 'failed',
        turn: this.currentTurn(),
        step: this.step,
        title: 'Pi 流错误',
        detail: message,
        startedAt: createdAt
      }]
    }
    // `start`, `text_start`, `thinking_start`, `toolcall_start`, `toolcall_delta`
    // and `done` carry no text of their own.
    return []
  }

  private tool(type: string, event: Record<string, unknown>, createdAt: string): AgentRunRecordDraft[] {
    const callId = asString(event['toolCallId']) ?? this.uniqueKey('pi:tool')
    const recordKey = `pi:tool:${callId}`
    const failed = type === 'tool_execution_end' && event['isError'] === true
    const status: AgentRecordStatus = type === 'tool_execution_end' ? (failed ? 'failed' : 'completed') : 'running'
    const isNew = this.touch(recordKey, createdAt, 'tool', status)
    if (isNew) this.nextStep()
    const name = this.toolLabel(asString(event['toolName']) ?? 'tool')
    const output = type === 'tool_execution_start'
      ? ''
      : ledgerText(asRecord(event['partialResult'])?.['content'] ?? asRecord(event['result'])?.['content'])
    const text = output
      ? this.accumulate(recordKey, output, type === 'tool_execution_update')
      : ''
    return [{
      recordKey,
      kind: 'tool',
      status,
      turn: this.currentTurn(),
      step: this.step,
      title: name,
      detail: oneLine(safeJson(event['args'])),
      inputText: event['args'] === undefined ? null : safeJson(event['args']),
      ...(text ? { outputText: text } : {}),
      toolName: name,
      callId,
      ...(isNew ? { startedAt: createdAt } : {}),
      ...(type === 'tool_execution_end' ? { finishedAt: createdAt, durationMs: this.durationOf(recordKey, createdAt) } : {})
    }]
  }

  private bashEvent(event: Record<string, unknown>, createdAt: string): AgentRunRecordDraft[] {
    const id = asString(event['id']) ?? 'stream'
    const recordKey = `pi:bash:${id}`
    const isNew = this.touch(recordKey, createdAt, 'tool', 'running')
    if (isNew) this.nextStep()
    const text = this.accumulate(recordKey, asString(event['delta']) ?? '', true)
    return [{
      recordKey,
      kind: 'tool',
      status: 'running',
      turn: this.currentTurn(),
      step: this.step,
      title: 'bash',
      detail: '',
      ...(text ? { outputText: text } : {}),
      toolName: 'bash',
      callId: id,
      ...(isNew ? { startedAt: createdAt } : {})
    }]
  }

  private turnEndRecords(event: Record<string, unknown>, createdAt: string, status: 'completed' | 'failed'): AgentRunRecordDraft[] {
    const usage = ledgerUsage(asRecord(event['message'])?.['usage'])
    const records = this.turnEnd(status, createdAt)
    // Reset the per-turn message identities so the next turn keys new records.
    this.assistantKey = null
    this.reasoningKey = null
    if (usage === null) return records
    return records.map((record, index) => index === records.length - 1 ? { ...record, usage } : record)
  }

  private toolRecord(call: Record<string, unknown>, createdAt: string, status: AgentRecordStatus): AgentRunRecordDraft {
    const callId = asString(call['id']) ?? this.uniqueKey('pi:tool')
    const recordKey = `pi:tool:${callId}`
    const isNew = this.touch(recordKey, createdAt, 'tool', status)
    if (isNew) this.nextStep()
    const name = this.toolLabel(asString(call['name']) ?? 'tool')
    const args = call['arguments']
    return {
      recordKey,
      kind: 'tool',
      status,
      turn: this.currentTurn(),
      step: this.step,
      title: name,
      detail: oneLine(safeJson(args)),
      inputText: args === undefined ? null : safeJson(args),
      toolName: name,
      callId,
      ...(isNew ? { startedAt: createdAt } : {})
    }
  }

  /** Provider-visible tool name to the workbench name it was registered from. */
  private toolLabel(name: string): string {
    return this.toolLabels.get(name) ?? name
  }

  /** The current assistant record key; each assistant message in a turn is its
   * own record, so a turn that produces two messages keeps both. */
  private assistant(): string {
    if (this.assistantKey === null) {
      this.currentTurn()
      this.assistantKey = `pi:msg:${this.turn}:${this.assistantOrdinal++}`
    }
    return this.assistantKey
  }

  private reasoning(): string {
    if (this.reasoningKey === null) {
      this.currentTurn()
      this.reasoningKey = `pi:think:${this.turn}:${this.reasoningOrdinal++}`
    }
    return this.reasoningKey
  }

  private retryEvent(type: string, event: Record<string, unknown>, createdAt: string): AgentRunRecordDraft[] {
    const attempt = typeof event['attempt'] === 'number' ? event['attempt'] : null
    const detail = asString(event['errorMessage']) ?? asString(event['finalError']) ?? safeJson(event)
    return [{
      recordKey: 'pi:retry',
      kind: 'diagnostic',
      status: type.endsWith('_start') || type.endsWith('_scheduled') ? 'running' : 'completed',
      turn: this.turn,
      step: this.step,
      title: attempt === null ? '自动重试' : `自动重试（第 ${attempt} 次）`,
      detail,
      startedAt: createdAt
    }]
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}
