import type { AgentPermissionMode, AgentToolProfile } from '@prw/contracts'
import type { Typebox } from './loader.js'

/**
 * The workbench tool surface handed to the embedded Agent.
 *
 * The Agent reaches the workbench only through the `workspace-mcp` server, so
 * this allowlist — not a prompt instruction — is what decides which records the
 * Agent can touch. Three rules produced it:
 *
 *  - Read tools are always available.
 *  - Record writes (tasks, todos, calendar, reminders) are available whenever
 *    the run's permission mode permits writes. The user asked for these to take
 *    effect immediately instead of waiting on an approval prompt, so they are
 *    ordinary tools rather than an approval-gated channel.
 *  - Destructive tools are never registered. `hardDelete` rows are
 *    unrecoverable, so absence is enforced here to stop a future server change
 *    from widening the Agent's reach by accident.
 *  - External systems have request tools, not write tools. The Agent may prepare
 *    a Zotero or Obsidian change, but executing it is a separate, user-decided
 *    step reachable only from the renderer; no tool in this list performs the
 *    write, which is why the names end in `.request`.
 */
export const workspaceReadTools: readonly string[] = [
  'projects.search',
  'tasks.search',
  'calendar.list',
  'calendar.markers.list',
  'literature.search',
  'literature.sessions',
  'literature.results',
  'papers.list',
  'notes.list',
  'notes.read',
  'zotero.capability',
  'zotero.collections',
  'zotero.items',
  'zotero.paperToZotero.preview',
  'literature.stagingToZotero.preview',
  'notes.metadata.preview',
  'automation.rules.list',
  'automation.runs.list',
  'agent.settings.get',
  'inbox.ai.list'
]

export const workspaceWriteTools: readonly string[] = [
  'tasks.create',
  'tasks.update',
  'tasks.move',
  'todos.capture',
  'calendar.create',
  'calendar.update',
  'calendar.markers.create',
  'calendar.markers.update'
]

/**
 * External writes the Agent may *ask* for.
 *
 * Each one runs the same preview the UI previews and then stores a pending
 * decision; none of them writes anything. They follow the write policy because a
 * read-only run — a scheduled digest, a retry — must not queue external changes
 * nobody asked for, and because the person who approves is the person who
 * started the run.
 */
export const workspaceExternalRequestTools: readonly string[] = [
  'zotero.paperToZotero.request',
  'literature.stagingToZotero.request',
  'notes.write.request',
  'notes.metadata.request'
]

/** Referenced by both the policy and the docs: matching any of these means the
 * tool is dropped even if a server starts advertising it. */
export const workspaceBlockedToolPatterns: readonly RegExp[] = [
  /harddelete/iu,
  /bulkdelete/iu,
  /\bdelete\b/iu,
  /\barchive\b/iu,
  /^(?:zotero|obsidian|notion|integrations)\..*\.(?:write|update|create|delete|remove|execute|sync)$/iu,
  /^(?:literature|knowledge)\.(?:write|update|create|delete|remove|execute)/u
]

export interface WorkspaceToolPolicyInput {
  readonly permissionMode?: AgentPermissionMode | undefined
  readonly toolProfile: AgentToolProfile
}

/** Effective permission mode. `toolProfile` is the legacy field carried on the
 * wire, so a caller that only sets it still gets the mode it implies. */
export function effectivePermissionMode(input: WorkspaceToolPolicyInput): AgentPermissionMode {
  if (input.permissionMode) return input.permissionMode
  return input.toolProfile === 'approved-write' ? 'auto' : 'read-only'
}

/** Whether a run may write workbench records. `full-access` and `auto` both
 * mean yes: the difference between them is about shell/file-system access,
 * which is permanently disabled for the embedded Agent. */
export function allowsWorkspaceWrites(input: WorkspaceToolPolicyInput): boolean {
  return effectivePermissionMode(input) !== 'read-only'
}

/** Names of the workbench tools the Agent may call in this run. */
export function workspaceToolAllowlist(input: WorkspaceToolPolicyInput): ReadonlySet<string> {
  const allowed = new Set(workspaceReadTools)
  if (allowsWorkspaceWrites(input)) {
    for (const name of workspaceWriteTools) allowed.add(name)
    for (const name of workspaceExternalRequestTools) allowed.add(name)
  }
  return allowed
}

export function isBlockedWorkspaceTool(name: string): boolean {
  return workspaceBlockedToolPatterns.some((pattern) => pattern.test(name))
}

export interface WorkspaceToolDescriptor {
  readonly name: string
  readonly description: string | undefined
  readonly inputSchema: unknown
}

/**
 * Keep only the tools the policy allows, and only ones the server actually
 * advertises. A tool named in the allowlist but missing from the server is
 * silently skipped rather than failing the run: the workbench must stay usable
 * with an older server.
 */
export function selectWorkspaceTools(
  advertised: readonly WorkspaceToolDescriptor[],
  input: WorkspaceToolPolicyInput
): WorkspaceToolDescriptor[] {
  const allowed = workspaceToolAllowlist(input)
  return advertised.filter((tool) => allowed.has(tool.name) && !isBlockedWorkspaceTool(tool.name))
}

/** OpenAI-compatible tool names: `^[a-zA-Z0-9_-]{1,64}$`. */
export const agentToolNamePattern = /^[a-zA-Z0-9_-]{1,64}$/u
const agentToolNameMaxLength = 64

/**
 * Provider-visible name of a workbench tool.
 *
 * MCP allows dots (`tasks.search`), but OpenAI answers a dotted tool name with
 * `400 invalid_request` for `tools[0].name`, which fails the whole request
 * before the model ever sees a tool. Only the name registered with Pi is
 * normalized: the descriptor keeps the MCP name, and that is what `callTool`
 * receives, so no reverse mapping is needed at call time.
 */
export function agentToolName(mcpName: string): string {
  const sanitized = mcpName.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, agentToolNameMaxLength)
  return sanitized.length > 0 ? sanitized : 'tool'
}

/**
 * Unique provider-visible names for a set of MCP tool names.
 *
 * Two MCP names can sanitize to the same string (`a.b` and `a b`), and Pi
 * would then silently drop one registration, so collisions get a numeric
 * suffix. Keyed by the MCP name; the ledger reads the inverse through
 * `agentToolLabels`.
 */
export function agentToolNames(names: readonly string[]): ReadonlyMap<string, string> {
  const assigned = new Map<string, string>()
  const used = new Set<string>()
  for (const name of names) {
    if (assigned.has(name)) continue
    const base = agentToolName(name)
    let candidate = base
    let suffix = 2
    while (used.has(candidate)) {
      const tail = `_${suffix}`
      candidate = `${base.slice(0, agentToolNameMaxLength - tail.length)}${tail}`
      suffix += 1
    }
    used.add(candidate)
    assigned.set(name, candidate)
  }
  return assigned
}

/**
 * Provider-visible name back to the workbench (MCP) name.
 *
 * The ledger reads a run as a person does, so it prints `tasks.search` rather
 * than the `tasks_search` the provider was given. Direction matters: the
 * registration map is keyed by the MCP name, this one by the provider name.
 */
export function agentToolLabels(names: readonly string[]): ReadonlyMap<string, string> {
  const labels = new Map<string, string>()
  for (const [mcpName, providerName] of agentToolNames(names)) labels.set(providerName, mcpName)
  return labels
}

/**
 * Strip the two JSON Schema keywords Pi's TypeBox validation cannot accept.
 *
 * `$schema` is a meta keyword and `additionalProperties` is re-derived by the
 * compiler; leaving either in place makes provider-side argument validation
 * reject a payload that looks correct. This mirrors what
 * `pi-mcp-adapter`'s `normalizeDirectToolInputSchema` does for the same MCP
 * `inputSchema` values, so both integrations feed Pi the same shape.
 */
export function normalizeToolParametersSchema(schema: unknown): Record<string, unknown> {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} }
  }
  const { $schema: _meta, additionalProperties: _additional, ...rest } = schema as Record<string, unknown>
  return rest
}

/**
 * Convert an MCP JSON Schema into the `parameters` a Pi tool requires.
 *
 * `Type.Unsafe` passes the schema through untouched, which is what keeps a
 * nested MCP schema intact. Older TypeBox builds expose no `Unsafe`; the raw
 * schema is then used directly, because a TypeBox schema *is* JSON Schema.
 */
export function toToolParameters(typebox: Typebox, schema: unknown): unknown {
  const normalized = normalizeToolParametersSchema(schema)
  const Type = typebox.Type as { Unsafe?: (input: unknown) => unknown } | undefined
  return typeof Type?.Unsafe === 'function' ? Type.Unsafe(normalized) : normalized
}

/** Collapse a tool description to the one-line snippet the system prompt shows. */
export function promptSnippet(description: string, limit = 100): string {
  const collapsed = description.replace(/\s+/gu, ' ').trim()
  if (collapsed.length <= limit) return collapsed
  const cut = collapsed.slice(0, limit)
  const boundary = cut.lastIndexOf(' ')
  return `${boundary > limit / 2 ? cut.slice(0, boundary) : cut}…`
}
