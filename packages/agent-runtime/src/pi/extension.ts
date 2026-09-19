import type * as Pi from '@earendil-works/pi-coding-agent'
import type { AgentWorkspaceToolClient } from '../index.js'
import type { Typebox } from './loader.js'
import { agentToolNames, promptSnippet, toToolParameters, type WorkspaceToolDescriptor } from './tools.js'

export interface WorkspaceExtensionInput {
  readonly typebox: Typebox
  readonly client: AgentWorkspaceToolClient
  readonly tools: readonly WorkspaceToolDescriptor[]
  /** Reports a failed tool call so the run can record a diagnostic. The tool
   * still returns the error text to the model: the Agent needs to see why a
   * write was rejected in order to try something else. */
  readonly onToolError?: ((toolName: string, message: string) => void) | undefined
}

/** Structured details attached to every workbench tool result. */
interface WorkspaceToolDetails {
  readonly tool: string
  readonly ok?: boolean
}

/** Flatten an MCP tool result into the text the model reads. */
function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (item === null || typeof item !== 'object') continue
    const block = item as { type?: unknown; text?: unknown }
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else parts.push(JSON.stringify(item))
  }
  return parts.join('\n')
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : JSON.stringify(error)
}

/**
 * Pi treats extensions as the supported place for tools that are not built in,
 * and an in-process extension is how the workbench hands the Agent its record
 * tools.
 *
 * The extension is built from an already-fetched tool list rather than awaiting
 * `listTools()` inside the factory, because a factory that resolves late would
 * register tools after the session snapshot was taken.
 */
export function createWorkspaceExtension(input: WorkspaceExtensionInput): Pi.InlineExtension {
  // The names the model sees, computed once: the extension registers these and
  // the ledger prints the MCP name back, so both must come from one mapping.
  const names = agentToolNames(input.tools.map((spec) => spec.name))
  const factory: Pi.ExtensionFactory = (pi) => {
    for (const spec of input.tools) {
      const description = spec.description ?? spec.name
      pi.registerTool({
        name: names.get(spec.name) ?? spec.name,
        label: spec.name,
        description,
        promptSnippet: promptSnippet(description),
        parameters: toToolParameters(input.typebox, spec.inputSchema) as never,
        execute: async (_toolCallId, params, signal): Promise<Pi.AgentToolResult<WorkspaceToolDetails>> => {
          try {
            const result = await input.client.callTool({ name: spec.name, arguments: params as Record<string, unknown> })
            const call = result as { content?: unknown; isError?: boolean }
            const text = contentToText(call.content)
            if (call.isError === true) input.onToolError?.(spec.name, text)
            return {
              content: [{ type: 'text' as const, text: text.length > 0 ? text : 'ok' }],
              details: { tool: spec.name }
            }
          } catch (error) {
            const message = errorMessage(error)
            input.onToolError?.(spec.name, message)
            if (signal?.aborted === true) throw error
            return {
              content: [{ type: 'text' as const, text: `${spec.name} failed: ${message}` }],
              details: { tool: spec.name, ok: false }
            }
          }
        }
      })
    }
  }
  return { name: 'workbench-workspace', factory }
}
