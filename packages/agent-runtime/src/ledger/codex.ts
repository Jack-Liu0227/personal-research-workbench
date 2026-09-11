import type { AgentRecordKind, AgentRecordStatus, AgentRunRecordDraft, AgentUsage } from '@prw/contracts'
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
 * Codex `exec --json` item types mapped onto ledger kinds. The list mirrors the
 * item enum found in the installed Codex 0.153 CLI binary (`codex.exe`), which
 * prints `thread.started` / `turn.started` / `item.*` / `turn.completed` as
 * JSON lines on stdout.
 *
 * The table is intentionally open: an item type added by a future CLI revision
 * falls back to a generic tool card, so a new event type is visible in the
 * trajectory instead of being silently dropped.
 */
const codexItemKinds: Readonly<Record<string, AgentRecordKind>> = {
  agent_message: 'assistant',
  reasoning: 'reasoning',
  command_execution: 'tool',
  file_change: 'tool',
  mcp_tool_call: 'tool',
  web_search: 'tool',
  todo_list: 'context'
}

interface ToolDescription {
  readonly name: string
  readonly title: string
  readonly detail: string
  readonly input: string | null
  readonly output: string | null
  readonly failed: boolean
}

/** Normalize `codex exec --json` JSONL into ledger records. */
export class CodexLedgerNormalizer extends BaseLedgerNormalizer {
  accept(payload: unknown, createdAt: string): AgentRunRecordDraft[] {
    // Codex prints one JSON object per line. Anything else on stdout is a
    // warning the CLI did not wrap in an event, so it becomes a diagnostic
    // instead of assistant text.
    if (typeof payload === 'string') {
      const text = payload.trim()
      if (!text) return []
      return [{
        recordKey: this.uniqueKey('codex:text'),
        kind: 'diagnostic',
        status: 'info',
        turn: this.turn,
        step: this.step,
        title: 'Codex 输出',
        detail: text,
        startedAt: createdAt
      }]
    }
    const event = asRecord(payload)
    if (!event) return []
    const type = asString(event['type']) ?? ''
    switch (type) {
      case 'thread.started':
        return [{
          recordKey: 'codex:thread',
          kind: 'system',
          status: 'info',
          turn: 0,
          step: 0,
          title: 'Codex 会话已启动',
          detail: asString(event['thread_id']) ? `thread ${asString(event['thread_id'])}` : '',
          startedAt: createdAt
        }]
      case 'turn.started':
        this.beginTurn()
        return []
      case 'turn.completed': {
        const usage = ledgerUsage(event['usage'])
        return withTurnUsage(this.turnEnd('completed', createdAt), usage)
      }
      case 'turn.failed':
        return this.turnEnd('failed', createdAt, ledgerText(event['error'] ?? event['message']))
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        return this.item(type, event, createdAt)
      default:
        return [{
          recordKey: this.uniqueKey('codex:unknown'),
          kind: 'diagnostic',
          status: 'info',
          turn: this.turn,
          step: this.step,
          title: type ? `未识别的 Codex 事件：${type}` : '未识别的 Codex 输出',
          detail: '',
          outputText: safeJson(payload),
          startedAt: createdAt
        }]
    }
  }

  private item(phase: string, event: Record<string, unknown>, createdAt: string): AgentRunRecordDraft[] {
    // Codex wraps the item in `item`; a revision that flattens it still works.
    const item = asRecord(event['item']) ?? event
    const itemType = asString(item['item_type']) ?? asString(item['type']) ?? ''
    const id = asString(item['id']) ?? this.uniqueKey('codex:item')
    const recordKey = `codex:item:${id}`
    const completed = phase === 'item.completed'
    const kind = itemType === 'error' ? 'error' : codexItemKinds[itemType] ?? 'tool'
    if (kind === 'tool') {
      // A tool call owns its own step inside the turn.
      const tool = describeCodexTool(itemType, item, payload(event))
      const status: AgentRecordStatus = tool.failed ? 'failed' : completed ? 'completed' : 'running'
      const isNew = this.touch(recordKey, createdAt, 'tool', status)
      if (isNew) this.nextStep()
      return [{
        recordKey,
        kind: 'tool',
        status,
        turn: this.currentTurn(),
        step: this.step,
        title: tool.title,
        detail: tool.detail,
        inputText: tool.input,
        ...(completed && tool.output ? { outputText: tool.output } : {}),
        toolName: tool.name,
        callId: id,
        ...(isNew ? { startedAt: createdAt } : {}),
        ...(completed ? { finishedAt: createdAt, durationMs: this.durationOf(recordKey, createdAt) } : {})
      }]
    }
    if (kind === 'assistant' || kind === 'reasoning') {
      // A streamed message grows in place: `detail` always carries the current
      // full text, so the ledger never appends a row per delta.
      const status: AgentRecordStatus = completed ? 'completed' : 'running'
      const text = this.accumulate(recordKey, ledgerText(item['text'] ?? item['delta'] ?? item['content']), typeof item['delta'] === 'string')
      const isNew = this.touch(recordKey, createdAt, kind, status)
      return [{
        recordKey,
        kind,
        status,
        turn: this.currentTurn(),
        step: this.step,
        title: kind === 'reasoning' ? 'Reasoning' : 'Codex',
        detail: text,
        ...(isNew ? { startedAt: createdAt } : {}),
        ...(completed ? { finishedAt: createdAt, durationMs: this.durationOf(recordKey, createdAt) } : {})
      }]
    }
    const status: AgentRecordStatus = completed ? 'completed' : 'info'
    const isNew = this.touch(recordKey, createdAt, kind, status)
    return [{
      recordKey,
      kind,
      status,
      turn: this.currentTurn(),
      step: this.step,
      title: itemType ? `Codex ${itemType}` : 'Codex 条目',
      detail: ledgerText(item['text'] ?? item['content']) || safeJson(item),
      ...(isNew ? { startedAt: createdAt } : {}),
      ...(completed ? { finishedAt: createdAt } : {})
    }]
  }
}

function payload(event: Record<string, unknown>): unknown {
  return event['item'] ?? event
}

/** Turn usage belongs to the `turn_end` record, which `turnEnd` puts last. */
function withTurnUsage(records: AgentRunRecordDraft[], usage: AgentUsage | null): AgentRunRecordDraft[] {
  if (usage === null) return records
  return records.map((record, index) => index === records.length - 1 ? { ...record, usage } : record)
}

function describeCodexTool(itemType: string, item: Record<string, unknown>, raw: unknown): ToolDescription {
  const status = asString(item['status']) ?? ''
  switch (itemType) {
    case 'command_execution': {
      const command = asString(item['command']) ?? ''
      const exitCode = item['exit_code']
      const failed = status === 'failed' || (typeof exitCode === 'number' && exitCode !== 0)
      const output = asString(item['aggregated_output']) ?? asString(item['formatted_output']) ?? asString(item['stdout']) ?? ''
      return {
        name: 'shell',
        title: oneLine(command) || 'shell',
        detail: oneLine(command),
        input: command ? safeJson({ command }) : null,
        output: output || null,
        failed
      }
    }
    case 'file_change': {
      const changes = item['changes']
      const paths = Array.isArray(changes)
        ? changes.flatMap((entry) => {
          const record = asRecord(entry)
          const path = record ? asString(record['path']) ?? asString(record['file']) : null
          return path ? [path] : []
        })
        : []
      return {
        name: 'apply_patch',
        title: '文件变更',
        detail: oneLine(paths.join(', ')) || safeJson(changes),
        input: changes === undefined ? null : safeJson(changes),
        output: null,
        failed: status === 'failed'
      }
    }
    case 'mcp_tool_call': {
      const server = asString(item['server']) ?? ''
      const tool = asString(item['tool']) ?? ''
      const name = [server, tool].filter(Boolean).join('.') || 'mcp'
      const result = item['result'] ?? item['output']
      return {
        name,
        title: name,
        detail: oneLine(safeJson(item['arguments'])) || name,
        input: item['arguments'] === undefined ? null : safeJson(item['arguments']),
        output: result === undefined ? null : safeJson(result),
        failed: status === 'failed'
      }
    }
    case 'web_search': {
      const query = asString(item['query']) ?? ''
      return {
        name: 'web_search',
        title: oneLine(query) || 'web search',
        detail: oneLine(query),
        input: query ? safeJson({ query }) : null,
        output: asString(item['output']) ?? null,
        failed: status === 'failed'
      }
    }
    default:
      return {
        name: itemType || 'codex_item',
        title: itemType ? oneLine(itemType) : 'Codex 条目',
        detail: '',
        input: null,
        output: safeJson(raw),
        failed: status === 'failed'
      }
  }
}
