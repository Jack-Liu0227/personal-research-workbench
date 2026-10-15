import { z } from 'zod'
import { IdSchema, IsoInstantSchema, ProjectIdSchema } from './v2.js'

export const AssistantIdSchema = z.string().regex(/^assistant\.[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9_-])?$/u)
export const AgentTeamIdSchema = z.string().regex(/^team\.[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9_-])?$/u)
const BindingKeysSchema = z.array(z.string().trim().min(1).max(100)).max(64)
  .refine((keys) => new Set(keys).size === keys.length, 'Bindings must be unique')
const AssistantFields = {
  name: z.string().trim().min(1).max(100), description: z.string().trim().max(1000).default(''),
  enabled: z.boolean().default(true), systemPrompt: z.string().trim().max(20000).default(''),
  provider: z.string().trim().min(1).max(100).nullable().default(null),
  model: z.string().trim().min(1).max(300).nullable().default(null),
  thinking: z.string().trim().max(50).nullable().default(null),
  toolProfile: z.enum(['read-only', 'approved-write']).default('read-only'),
  toolAllowlist: BindingKeysSchema.default([]), skillKeys: BindingKeysSchema.default([])
}
export const AgentAssistantSchema = z.strictObject({
  id: AssistantIdSchema, ...AssistantFields, archivedAt: IsoInstantSchema.nullable(),
  createdAt: IsoInstantSchema, updatedAt: IsoInstantSchema, revision: z.int().nonnegative()
})
export type AgentAssistant = z.infer<typeof AgentAssistantSchema>
export const AgentAssistantSaveInputSchema = z.strictObject({
  id: AssistantIdSchema, ...AssistantFields, expectedRevision: z.int().nonnegative().nullable()
}).refine((input) => (input.provider === null) === (input.model === null), {
  message: 'Choose both provider and model, or inherit both defaults.', path: ['model']
})
export type AgentAssistantSaveInput = z.infer<typeof AgentAssistantSaveInputSchema>
export const AgentAssistantArchiveInputSchema = z.strictObject({
  id: AssistantIdSchema, expectedRevision: z.int().nonnegative(), confirmed: z.literal(true)
})
export const AgentTeamMemberSchema = z.strictObject({
  assistantId: AssistantIdSchema, role: z.enum(['director', 'researcher', 'reviewer']),
  instructions: z.string().trim().max(4000).default('')
})
const TeamMembersSchema = z.array(AgentTeamMemberSchema).min(2).max(8)
  .refine((members) => new Set(members.map((member) => member.assistantId)).size === members.length, 'Members must be unique')
  .refine((members) => members.filter((member) => member.role === 'director').length === 1, 'Exactly one director is required')
const TeamFields = {
  name: z.string().trim().min(1).max(100), description: z.string().trim().max(1000).default(''),
  enabled: z.boolean().default(true), members: TeamMembersSchema, maxSteps: z.int().min(2).max(12).default(6)
}
export const AgentTeamSchema = z.strictObject({
  id: AgentTeamIdSchema, ...TeamFields, archivedAt: IsoInstantSchema.nullable(),
  createdAt: IsoInstantSchema, updatedAt: IsoInstantSchema, revision: z.int().nonnegative()
})
export type AgentTeam = z.infer<typeof AgentTeamSchema>
export const AgentTeamSaveInputSchema = z.strictObject({
  id: AgentTeamIdSchema, ...TeamFields, expectedRevision: z.int().nonnegative().nullable()
})
export type AgentTeamSaveInput = z.infer<typeof AgentTeamSaveInputSchema>
export const AgentTeamArchiveInputSchema = z.strictObject({
  id: AgentTeamIdSchema, expectedRevision: z.int().nonnegative(), confirmed: z.literal(true)
})
export const AgentTeamRunStartInputSchema = z.strictObject({
  teamId: AgentTeamIdSchema, expectedRevision: z.int().nonnegative(),
  projectId: ProjectIdSchema.nullable().default(null), instructions: z.string().trim().min(1).max(20000),
  idempotencyKey: z.string().trim().min(1).max(200)
})
export type AgentTeamRunStartInput = z.infer<typeof AgentTeamRunStartInputSchema>
export const AgentTeamRunSchema = z.strictObject({
  id: IdSchema, teamId: AgentTeamIdSchema, projectId: ProjectIdSchema.nullable(),
  instructions: z.string().max(20000), idempotencyKey: z.string().max(200),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled', 'interrupted']),
  snapshot: z.strictObject({ team: AgentTeamSchema, assistants: z.array(AgentAssistantSchema).max(8) }),
  childRunIds: z.array(IdSchema).max(12), output: z.string().max(100000), error: z.string().max(500).nullable(),
  createdAt: IsoInstantSchema, updatedAt: IsoInstantSchema, revision: z.int().nonnegative()
})
export type AgentTeamRun = z.infer<typeof AgentTeamRunSchema>
export const AgentTeamRunCancelInputSchema = z.strictObject({ id: IdSchema, expectedRevision: z.int().nonnegative() })
export const AgentTeamRunListInputSchema = z.strictObject({ limit: z.int().min(1).max(100).default(30) })
export const AgentBindingCatalogSchema = z.strictObject({
  tools: z.array(z.strictObject({ name: z.string().max(100), kind: z.enum(['read', 'local-write', 'external-request']) })).max(100),
  skills: z.array(z.strictObject({ key: z.string().max(100), name: z.string().max(200) })).max(64),
  remoteMcpSupported: z.boolean()
})
export type AgentBindingCatalog = z.infer<typeof AgentBindingCatalogSchema>
export const AgentBindingMatrixSchema = z.strictObject({
  catalog: AgentBindingCatalogSchema, assistants: z.array(AgentAssistantSchema).max(100)
})
export type AgentBindingMatrix = z.infer<typeof AgentBindingMatrixSchema>
export const AgentBindingMatrixSaveInputSchema = z.strictObject({
  updates: z.array(z.strictObject({
    assistantId: AssistantIdSchema, expectedRevision: z.int().nonnegative(),
    toolAllowlist: BindingKeysSchema.optional(), skillKeys: BindingKeysSchema.optional()
  }).refine((update) => update.toolAllowlist !== undefined || update.skillKeys !== undefined,
    'At least one binding kind is required')).min(1).max(100)
    .refine((updates) => new Set(updates.map((update) => update.assistantId)).size === updates.length,
      'Assistant updates must be unique')
})
export type AgentBindingMatrixSaveInput = z.infer<typeof AgentBindingMatrixSaveInputSchema>
export const AgentBindingSetInputSchema = z.strictObject({
  assistantId: AssistantIdSchema, expectedRevision: z.int().nonnegative(),
  kind: z.enum(['tool', 'skill']), key: z.string().trim().min(1).max(100), enabled: z.boolean()
})
export type AgentBindingSetInput = z.infer<typeof AgentBindingSetInputSchema>
export const AgentProfilePayloadSchemas = {
  'assistants.list': z.null(), 'assistants.save': AgentAssistantSaveInputSchema,
  'assistants.archive': AgentAssistantArchiveInputSchema,
  'agentTeams.list': z.null(), 'agentTeams.save': AgentTeamSaveInputSchema,
  'agentTeams.archive': AgentTeamArchiveInputSchema, 'agentBindings.catalog': z.null(),
  'agentBindings.matrix': z.null(), 'agentBindings.saveMatrix': AgentBindingMatrixSaveInputSchema,
  'agentBindings.set': AgentBindingSetInputSchema,
  'agentTeams.runs.start': AgentTeamRunStartInputSchema, 'agentTeams.runs.list': AgentTeamRunListInputSchema,
  'agentTeams.runs.get': z.strictObject({ id: IdSchema }), 'agentTeams.runs.cancel': AgentTeamRunCancelInputSchema
} as const
export const AgentProfileResultSchemas = {
  'assistants.list': z.array(AgentAssistantSchema).max(100), 'assistants.save': AgentAssistantSchema,
  'assistants.archive': z.null(), 'agentTeams.list': z.array(AgentTeamSchema).max(100),
  'agentTeams.save': AgentTeamSchema, 'agentTeams.archive': z.null(), 'agentBindings.catalog': AgentBindingCatalogSchema,
  'agentBindings.matrix': AgentBindingMatrixSchema, 'agentBindings.saveMatrix': z.array(AgentAssistantSchema).min(1).max(100),
  'agentBindings.set': AgentAssistantSchema,
  'agentTeams.runs.start': AgentTeamRunSchema, 'agentTeams.runs.list': z.array(AgentTeamRunSchema).max(100),
  'agentTeams.runs.get': AgentTeamRunSchema, 'agentTeams.runs.cancel': AgentTeamRunSchema
} as const
export interface WorkbenchAgentProfilesApi {
  assistants: {
    list(): Promise<AgentAssistant[]>
    save(input: AgentAssistantSaveInput): Promise<AgentAssistant>
    archive(input: z.infer<typeof AgentAssistantArchiveInputSchema>): Promise<null>
  }
  agentTeams: {
    list(): Promise<AgentTeam[]>
    save(input: AgentTeamSaveInput): Promise<AgentTeam>
    archive(input: z.infer<typeof AgentTeamArchiveInputSchema>): Promise<null>
    runs: {
      start(input: AgentTeamRunStartInput): Promise<AgentTeamRun>
      list(input?: z.infer<typeof AgentTeamRunListInputSchema>): Promise<AgentTeamRun[]>
      get(id: string): Promise<AgentTeamRun>
      cancel(input: z.infer<typeof AgentTeamRunCancelInputSchema>): Promise<AgentTeamRun>
    }
  }
  agentBindings: {
    catalog(): Promise<AgentBindingCatalog>
    matrix(): Promise<AgentBindingMatrix>
    saveMatrix(input: AgentBindingMatrixSaveInput): Promise<AgentAssistant[]>
    set(input: AgentBindingSetInput): Promise<AgentAssistant>
  }
}
