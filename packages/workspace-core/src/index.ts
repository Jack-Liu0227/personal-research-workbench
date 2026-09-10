import type { ZodType } from 'zod'
import type {
  WorkspaceActor,
  WorkspaceServiceStatus,
  WorkspaceToolRisk
} from '@prw/contracts'

export type WorkspaceScope =
  | { kind: 'all' }
  | { kind: 'project'; projectId: string }
  | { kind: 'vault'; profileId: string }
  | { kind: 'collection'; profileId: string; collectionKey: string }

export interface ToolContext {
  readonly actor: WorkspaceActor
  readonly scope: WorkspaceScope
  readonly confirmationToken?: string
}

export interface WorkspaceToolDefinition<I, O> {
  readonly name: string
  readonly description: string
  readonly inputSchema: ZodType<I>
  readonly outputSchema: ZodType<O>
  readonly risk: WorkspaceToolRisk
  readonly idempotent: boolean
  execute(context: ToolContext, input: I): Promise<O>
}

export interface WorkspaceQueryService {
  readonly dashboard: { getSummary(input?: unknown): Promise<unknown> }
  readonly projects: { list(input?: unknown): Promise<unknown>; get(input: unknown): Promise<unknown> }
  readonly tasks: { list(input?: unknown): Promise<unknown>; get(input: unknown): Promise<unknown> }
  readonly calendar: { list(input: unknown): Promise<unknown> }
  readonly literature: { search(input: unknown): Promise<unknown>; sessions(): Promise<unknown>; results(input: unknown): Promise<unknown> }
  readonly notes: { list(input: unknown): Promise<unknown>; read(input: unknown): Promise<unknown> }
  readonly zotero: { collections(input: unknown): Promise<unknown>; items(input: unknown): Promise<unknown> }
  readonly ai: { jobs(input?: unknown): Promise<unknown>; runs(input?: unknown): Promise<unknown>; artifacts(input?: unknown): Promise<unknown> }
  readonly settings: { get(input?: unknown): Promise<unknown> }
}

export interface WorkspaceCommandService {
  readonly projects: { create(input: unknown): Promise<unknown>; update(input: unknown): Promise<unknown>; archive(input: unknown): Promise<unknown> }
  readonly tasks: { create(input: unknown): Promise<unknown>; update(input: unknown): Promise<unknown>; move(input: unknown): Promise<unknown>; archive(input: unknown): Promise<unknown> }
  readonly calendar: { create(input: unknown): Promise<unknown>; update(input: unknown): Promise<unknown>; remove(input: unknown): Promise<unknown> }
  readonly papers: { create(input: unknown): Promise<unknown>; update(input: unknown): Promise<unknown>; import(input: unknown): Promise<unknown> }
  readonly notes: { write(input: unknown): Promise<unknown> }
  readonly ai: { createJob(input: unknown): Promise<unknown>; cancel(input: unknown): Promise<unknown>; approve(input: unknown): Promise<unknown> }
  readonly settings: { update(input: unknown): Promise<unknown> }
}

export interface ToolAuditEvent {
  readonly tool: string
  readonly actor: WorkspaceActor
  readonly risk: WorkspaceToolRisk
  readonly outcome: 'allowed' | 'denied' | 'failed'
}

export class ToolRegistry {
  private readonly definitions = new Map<string, WorkspaceToolDefinition<unknown, unknown>>()

  constructor(private readonly audit?: (event: ToolAuditEvent) => void) {}

  register<I, O>(definition: WorkspaceToolDefinition<I, O>): void {
    if (this.definitions.has(definition.name)) throw new Error(`Tool already registered: ${definition.name}`)
    this.definitions.set(definition.name, definition as WorkspaceToolDefinition<unknown, unknown>)
  }

  list(): ReadonlyArray<WorkspaceToolDefinition<unknown, unknown>> {
    return [...this.definitions.values()]
  }

  async execute(name: string, context: ToolContext, input: unknown): Promise<unknown> {
    const definition = this.definitions.get(name)
    if (!definition) throw new Error(`Tool not found: ${name}`)
    if (definition.risk !== 'read' && !context.confirmationToken) {
      this.audit?.({ tool: name, actor: context.actor, risk: definition.risk, outcome: 'denied' })
      throw new Error('This tool requires explicit confirmation.')
    }
    try {
      const parsedInput = definition.inputSchema.parse(input)
      const result = await definition.execute(context, parsedInput)
      const parsedOutput = definition.outputSchema.parse(result)
      this.audit?.({ tool: name, actor: context.actor, risk: definition.risk, outcome: 'allowed' })
      return parsedOutput
    } catch (error) {
      this.audit?.({ tool: name, actor: context.actor, risk: definition.risk, outcome: 'failed' })
      throw error
    }
  }
}

export interface WorkspaceApplication {
  readonly query: WorkspaceQueryService
  readonly command: WorkspaceCommandService
  readonly tools: ReadonlyMap<string, WorkspaceToolDefinition<unknown, unknown>>
  status(): Promise<WorkspaceServiceStatus>
}

export function defineTool<I, O>(definition: WorkspaceToolDefinition<I, O>): WorkspaceToolDefinition<I, O> {
  return definition
}

export type InferToolInput<T> = T extends WorkspaceToolDefinition<infer I, unknown> ? I : never
export type InferToolOutput<T> = T extends WorkspaceToolDefinition<unknown, infer O> ? O : never
