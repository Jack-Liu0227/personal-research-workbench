import { z } from 'zod'
import { IdSchema, IsoInstantSchema } from './v2.js'

export const AgentMcpServerIdSchema = z.string().regex(/^mcp\.[a-z0-9][a-z0-9_-]{0,48}$/u)
export const AgentInstructionSkillIdSchema = z.string().regex(/^skill\.user\.[a-z0-9][a-z0-9_-]{0,48}$/u)
export const AgentMcpEndpointSchema = z.string().trim().min(1).max(2000).refine((value) => {
  try {
    const url = new URL(value)
    return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
  } catch { return false }
}, 'Use HTTPS or literal loopback HTTP, without credentials, query or fragment.')
export function isBoundedAgentResourceJson(value: unknown): boolean {
  const pending = [{ value, depth: 0 }]
  const seen = new Set<object>()
  let nodes = 0
  while (pending.length) {
    const item = pending.pop()!
    if (++nodes > 8192 || item.depth > 32) return false
    if (item.value === null || typeof item.value === 'string' || typeof item.value === 'boolean') continue
    if (typeof item.value === 'number') { if (!Number.isFinite(item.value)) return false; continue }
    if (typeof item.value !== 'object' || seen.has(item.value)) return false
    seen.add(item.value)
    for (const [key, child] of Object.entries(item.value)) {
      if (key.length > 200) return false
      pending.push({ value: child, depth: item.depth + 1 })
    }
  }
  try { return new TextEncoder().encode(JSON.stringify(value)).length <= 32768 } catch { return false }
}
// Bound every subtree before Zod's recursive JSON parser (including defaults/examples).
const JsonObjectSchema = z.unknown().refine(isBoundedAgentResourceJson, 'JSON exceeds resource bounds')
  .pipe(z.record(z.string().max(200), z.json()))
export const AgentMcpToolSchema = z.strictObject({
  key: z.string().min(1).max(100), name: z.string().min(1).max(100),
  description: z.string().max(2000), inputSchema: JsonObjectSchema,
  schemaHash: z.string().regex(/^[a-f0-9]{64}$/u)
})
export type AgentMcpTool = z.infer<typeof AgentMcpToolSchema>
const McpFields = {
  name: z.string().trim().min(1).max(100), transport: z.literal('streamable-http'),
  endpoint: AgentMcpEndpointSchema, enabled: z.boolean()
}
export const AgentMcpServerSchema = z.strictObject({
  id: AgentMcpServerIdSchema, ...McpFields, tools: z.array(AgentMcpToolSchema).max(64),
  lastProbe: z.strictObject({ status: z.enum(['ok', 'failed']), checkedAt: IsoInstantSchema,
    diagnosticCode: z.string().max(100).nullable() }).nullable(),
  credentialPresent: z.boolean().default(false), archivedAt: IsoInstantSchema.nullable(),
  createdAt: IsoInstantSchema, updatedAt: IsoInstantSchema, revision: z.int().nonnegative()
})
export type AgentMcpServer = z.infer<typeof AgentMcpServerSchema>
export const AgentMcpServerSaveInputSchema = z.strictObject({
  id: AgentMcpServerIdSchema, ...McpFields, expectedRevision: z.int().nonnegative().nullable()
})
export type AgentMcpServerSaveInput = z.infer<typeof AgentMcpServerSaveInputSchema>
export const AgentMcpServerRevisionInputSchema = z.strictObject({ id: AgentMcpServerIdSchema, expectedRevision: z.int().nonnegative() })
export const AgentMcpServerRemoveInputSchema = AgentMcpServerRevisionInputSchema.extend({ confirmed: z.literal(true) })
export const AgentMcpCredentialSetInputSchema = AgentMcpServerRevisionInputSchema.extend({
  token: z.string().trim().min(1).max(8192).regex(/^[^\r\n]+$/u).nullable()
})
export const AgentInstructionMarkdownSchema = z.string().min(20).max(50000)
  .refine((value) => !value.includes('\u0000'), 'NUL is forbidden')
const SkillFields = {
  name: z.string().trim().min(1).max(100), description: z.string().trim().max(1000),
  markdown: AgentInstructionMarkdownSchema, enabled: z.boolean()
}
export const AgentInstructionSkillSchema = z.strictObject({
  id: AgentInstructionSkillIdSchema, ...SkillFields, contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  archivedAt: IsoInstantSchema.nullable(), createdAt: IsoInstantSchema, updatedAt: IsoInstantSchema,
  revision: z.int().nonnegative()
})
export type AgentInstructionSkill = z.infer<typeof AgentInstructionSkillSchema>
export const AgentInstructionSkillSaveInputSchema = z.strictObject({
  id: AgentInstructionSkillIdSchema, ...SkillFields, expectedRevision: z.int().nonnegative().nullable(), confirmed: z.literal(true)
})
export type AgentInstructionSkillSaveInput = z.infer<typeof AgentInstructionSkillSaveInputSchema>
export const AgentInstructionSkillRemoveInputSchema = z.strictObject({
  id: AgentInstructionSkillIdSchema, expectedRevision: z.int().nonnegative(), confirmed: z.literal(true)
})
export const AgentMcpCallSchema = z.strictObject({
  id: IdSchema, runId: IdSchema, assistantId: z.string().max(100), serverId: AgentMcpServerIdSchema,
  serverRevision: z.int().nonnegative(), endpoint: AgentMcpEndpointSchema,
  toolKey: z.string().max(100), toolName: z.string().max(100), schemaHash: z.string().regex(/^[a-f0-9]{64}$/u),
  argumentsJson: z.string().max(32768), argsHash: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.enum(['pending', 'executing', 'completed', 'failed', 'rejected', 'invalidated']),
  result: z.string().max(32768), error: z.string().max(500).nullable(),
  expiresAt: IsoInstantSchema, createdAt: IsoInstantSchema, updatedAt: IsoInstantSchema,
  revision: z.int().nonnegative()
})
export type AgentMcpCall = z.infer<typeof AgentMcpCallSchema>
export const AgentMcpCallListInputSchema = z.strictObject({ runId: IdSchema.optional(), limit: z.int().min(1).max(100).default(30) })
export const AgentMcpCallDecideInputSchema = z.strictObject({
  id: IdSchema, expectedRevision: z.int().nonnegative(), decision: z.enum(['approve', 'reject']), confirmed: z.literal(true)
})
export type AgentMcpCallDecideInput = z.infer<typeof AgentMcpCallDecideInputSchema>
export const AgentResourcePayloadSchemas = {
  'agentMcpServers.list': z.null(), 'agentMcpServers.save': AgentMcpServerSaveInputSchema,
  'agentMcpServers.probe': AgentMcpServerRevisionInputSchema, 'agentMcpServers.remove': AgentMcpServerRemoveInputSchema,
  'agentMcpServers.setCredential': AgentMcpCredentialSetInputSchema,
  'agentInstructionSkills.list': z.null(), 'agentInstructionSkills.get': z.strictObject({ id: AgentInstructionSkillIdSchema }),
  'agentInstructionSkills.save': AgentInstructionSkillSaveInputSchema, 'agentInstructionSkills.remove': AgentInstructionSkillRemoveInputSchema,
  'agentMcpCalls.list': AgentMcpCallListInputSchema, 'agentMcpCalls.decide': AgentMcpCallDecideInputSchema
} as const
export const AgentResourceResultSchemas = {
  'agentMcpServers.list': z.array(AgentMcpServerSchema).max(32), 'agentMcpServers.save': AgentMcpServerSchema,
  'agentMcpServers.probe': AgentMcpServerSchema, 'agentMcpServers.remove': z.null(),
  'agentMcpServers.setCredential': AgentMcpServerSchema,
  'agentInstructionSkills.list': z.array(AgentInstructionSkillSchema).max(32), 'agentInstructionSkills.get': AgentInstructionSkillSchema,
  'agentInstructionSkills.save': AgentInstructionSkillSchema, 'agentInstructionSkills.remove': z.null(),
  'agentMcpCalls.list': z.array(AgentMcpCallSchema).max(100), 'agentMcpCalls.decide': AgentMcpCallSchema
} as const
export interface WorkbenchAgentResourcesApi {
  agentMcpServers: {
    list(): Promise<AgentMcpServer[]>
    save(input: AgentMcpServerSaveInput): Promise<AgentMcpServer>
    probe(input: z.infer<typeof AgentMcpServerRevisionInputSchema>): Promise<AgentMcpServer>
    remove(input: z.infer<typeof AgentMcpServerRemoveInputSchema>): Promise<null>
    setCredential(input: z.infer<typeof AgentMcpCredentialSetInputSchema>): Promise<AgentMcpServer>
  }
  agentInstructionSkills: {
    list(): Promise<AgentInstructionSkill[]>
    get(id: string): Promise<AgentInstructionSkill>
    save(input: AgentInstructionSkillSaveInput): Promise<AgentInstructionSkill>
    remove(input: z.infer<typeof AgentInstructionSkillRemoveInputSchema>): Promise<null>
  }
  agentMcpCalls: {
    list(input?: z.infer<typeof AgentMcpCallListInputSchema>): Promise<AgentMcpCall[]>
    decide(input: AgentMcpCallDecideInput): Promise<AgentMcpCall>
  }
}
