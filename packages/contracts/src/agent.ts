import { z } from 'zod'
import { AgentLookbackDaysSchema, AgentOutputFolderSchema, AgentResponseLanguageSchema, AgentSourceListSchema, AgentWorkflowKeySchema, ArchiveBulkInputSchema, ArtifactKindSchema, DEFAULT_DAILY_PUSH_SCHEDULE_INPUT } from './research.js'
import type { AgentScheduleSkillCatalogEntry, ArchiveBulkInput, ArchiveBulkReceipt, ArchiveBulkResult } from './research.js'
import { IdSchema, IsoInstantSchema, PageInputSchema, ProjectIdSchema } from './v2.js'

const IsoDateSchema = IsoInstantSchema

export const AgentRuntimeKindSchema = z.enum(['pi'])
export type AgentRuntimeKind = z.infer<typeof AgentRuntimeKindSchema>

/** Every supported runtime is embedded in the Core utility process. The
 * `cli` transport existed for spawned Codex/Pi binaries and no longer has an
 * implementation; keeping the literal union narrow makes that structural. */
export const AgentRuntimeTransportSchema = z.enum(['inprocess'])
export type AgentRuntimeTransport = z.infer<typeof AgentRuntimeTransportSchema>

/** Transport of a *stored* run record.
 *
 * Deliberately wider than `AgentRuntimeTransportSchema`, which selects a
 * runtime and must stay narrow. `agent_runs.transport` still holds `cli` for
 * runs written by the removed spawned-CLI transport, and its SQLite CHECK
 * cannot be narrowed in place; a stored record that this schema rejects makes
 * every run listing fail to parse. The history therefore stays honest instead
 * of being rewritten — no code path can *start* a `cli` run. */
export const AgentRunRecordTransportSchema = z.enum(['inprocess', 'cli'])
export type AgentRunRecordTransport = z.infer<typeof AgentRunRecordTransportSchema>

export const AgentToolProfileSchema = z.enum(['read-only', 'approved-write'])
export type AgentToolProfile = z.infer<typeof AgentToolProfileSchema>

/** User-facing permission modes. `read-only` keeps every write tool out of
 * the session, `auto` allows workbench record writes without prompting, and
 * `full-access` is reserved: it never enables shell/file-system tools.
 * The legacy toolProfile remains on the wire for backwards compatibility. */
export const AgentPermissionModeSchema = z.enum(['read-only', 'auto', 'full-access'])
export type AgentPermissionMode = z.infer<typeof AgentPermissionModeSchema>
export const AgentApprovalPolicySchema = z.enum(['on-request', 'never'])
export type AgentApprovalPolicy = z.infer<typeof AgentApprovalPolicySchema>

/**
 * Runtime credentials are owned by Electron Main's `safeStorage` vault.
 *
 * The workbench never reads, copies or reuses the login state a user may have
 * created for `~/.pi`: the embedded Pi agent runs against an app-owned
 * `agentDir`, and credentials reach it only through an app-owned
 * `CredentialStore` whose writes are persisted by Main. Provider identifiers
 * are Pi's own provider ids, so the catalog is generated from the installed
 * SDK instead of being re-listed here (where it would silently drift).
 */
export const AgentCredentialProviderSchema = z.string().trim().min(1).max(100)
export type AgentCredentialProvider = z.infer<typeof AgentCredentialProviderSchema>

/** How a provider authenticates. `api_key` is a pasted secret, `oauth` is an
 * interactive browser/device-code login orchestrated by this app. */
export const AgentAuthTypeSchema = z.enum(['api_key', 'oauth'])
export type AgentAuthType = z.infer<typeof AgentAuthTypeSchema>

/** Non-secret credential status. The secret itself never leaves Main. */
export const AgentCredentialStatusSchema = z.strictObject({
  provider: AgentCredentialProviderSchema,
  /** Display name resolved from the Pi provider catalog. */
  label: z.string().max(200),
  credentialPresent: z.boolean(),
  authType: AgentAuthTypeSchema.nullable(),
  updatedAt: IsoDateSchema.nullable()
})
export type AgentCredentialStatus = z.infer<typeof AgentCredentialStatusSchema>

/** Main-only write. An empty `apiKey` clears the stored credential. */
export const AgentCredentialSaveInputSchema = z.strictObject({
  provider: AgentCredentialProviderSchema,
  apiKey: z.string().max(20_000).nullable().default(null)
})
export type AgentCredentialSaveInput = z.infer<typeof AgentCredentialSaveInputSchema>

/** One model offered by a configured-or-configurable provider. */
export const AgentModelOptionSchema = z.strictObject({
  id: z.string().min(1).max(300),
  name: z.string().max(300),
  reasoning: z.boolean(),
  /** Thinking levels the SDK reports for this model; empty means the UI hides
   * the thinking selector instead of offering a level the model rejects. */
  thinkingLevels: z.array(z.string().max(50)).max(20).default([]),
  /** Wire protocol this model is called with, when the provider declares one.
   * A provider can offer several (`openai-completions` next to
   * `openai-responses`), so the UI labels each model instead of assuming the
   * provider has exactly one. `null` means the SDK does not report one. */
  api: z.string().max(64).nullable().default(null)
})
export type AgentModelOption = z.infer<typeof AgentModelOptionSchema>

/**
 * Provider catalog entry generated from the embedded Pi SDK at request time.
 * It carries no credential material: presence/updatedAt come from the
 * Main-owned vault and are merged by the renderer, so a credentials-change
 * never invalidates this cache.
 */
export const AgentModelCatalogEntrySchema = z.strictObject({
  provider: AgentCredentialProviderSchema,
  name: z.string().max(200),
  authTypes: z.array(AgentAuthTypeSchema).max(2).default([]),
  models: z.array(AgentModelOptionSchema).max(500).default([]),
  /** `builtin` comes from the embedded SDK, `custom` from the app-owned
   * `models.json`. The renderer only uses this to group the list, never to
   * decide whether a provider works. */
  source: z.enum(['builtin', 'custom']).default('builtin')
})
export type AgentModelCatalogEntry = z.infer<typeof AgentModelCatalogEntrySchema>

/**
 * Wire protocols a user-added provider may speak.
 *
 * Deliberately a subset of Pi's `Api`: these are the protocols a local server,
 * a gateway or a self-hosted model actually implements. Vendor-cloud-only APIs
 * (Bedrock SigV4, Vertex ADC, Copilot, Codex, …) are excluded because they need
 * that vendor's own account machinery, which this app does not manage.
 */
export const AgentCustomProviderApiSchema = z.enum([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai'
])
export type AgentCustomProviderApi = z.infer<typeof AgentCustomProviderApiSchema>
export const AGENT_CUSTOM_PROVIDER_APIS: readonly AgentCustomProviderApi[] = AgentCustomProviderApiSchema.options

/** Provider ids double as Pi provider ids and as credential-vault keys, so the
 * character set stays narrow enough for both a JSON key and a vault key. */
export const AGENT_CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u

/** Dependency-free id check shared by the RPC schema, the renderer form and the
 * agent-runtime file reader, so all three agree on what an editable provider is
 * instead of one of them silently reclassifying the others' output. */
export function customProviderIdIssue(value: string): string | null {
  if (!value.trim()) return 'Provider id 不能为空。'
  if (value.length > 100) return 'Provider id 不能超过 100 个字符。'
  if (!AGENT_CUSTOM_PROVIDER_ID_PATTERN.test(value)) return 'Provider id 只能包含小写字母、数字、点、下划线和短横线，且必须以字母或数字开头。'
  return null
}

/**
 * Dependency-free endpoint check, shared for the same reason as the id check.
 *
 * HTTP is accepted only for loopback: an API key sent to a remote host over
 * plain HTTP would be readable on the wire. A plain-HTTP LAN endpoint can still
 * be added by hand-editing the file — such an entry is preserved verbatim and
 * listed as read-only instead of being rejected or rewritten.
 */
export function customProviderUrlIssue(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return '模型地址不能为空。'
  if (trimmed.length > 2_048) return '模型地址过长。'
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return '模型地址必须是有效的绝对 URL。'
  }
  if (parsed.username || parsed.password) return '模型地址不能包含用户名或密码；密钥请保存在凭据中。'
  if (parsed.search || parsed.hash) return '模型地址不能包含查询参数或锚点。'
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname.toLocaleLowerCase('en-US'))
  const allowed = loopback ? ['http:', 'https:'] : ['https:']
  if (!allowed.includes(parsed.protocol)) return '远程模型地址必须使用 HTTPS；HTTP 仅允许 localhost/127.0.0.1。'
  return null
}

/** Endpoint of one user-added provider. */
export const AgentCustomProviderUrlSchema = z.string().trim().min(1).max(2_048).superRefine((value, context) => {
  const issue = customProviderUrlIssue(value)
  if (issue) context.addIssue({ code: 'custom', message: issue })
})

/** One model under a user-added provider. Pi fills `contextWindow` and
 * `maxTokens` with its own defaults when they are omitted, so `null` means
 * "use Pi's default" rather than zero. */
export const AgentCustomProviderModelSchema = z.strictObject({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().max(200).default(''),
  reasoning: z.boolean().default(false),
  contextWindow: z.int().positive().max(10_000_000).nullable().default(null),
  maxTokens: z.int().positive().max(10_000_000).nullable().default(null)
})
export type AgentCustomProviderModel = z.infer<typeof AgentCustomProviderModelSchema>

/**
 * Provider id of a managed custom provider.
 *
 * The id doubles as the Pi provider id and as the `safeStorage` vault key, so
 * one schema is shared by the file entry, the discovery request and the
 * credential write instead of three near-identical rules that could drift.
 */
export const AgentCustomProviderIdSchema = z.string().trim().min(1).max(100).refine((value) => customProviderIdIssue(value) === null, { message: 'Provider id 只能包含小写字母、数字、点、下划线和短横线。' })
export type AgentCustomProviderId = z.infer<typeof AgentCustomProviderIdSchema>

/** One provider entry of the app-owned `models.json`. */
export const AgentCustomProviderSchema = z.strictObject({
  id: AgentCustomProviderIdSchema,
  name: z.string().trim().max(200).default(''),
  baseUrl: AgentCustomProviderUrlSchema,
  api: AgentCustomProviderApiSchema,
  models: z.array(AgentCustomProviderModelSchema).max(200).default([])
})
export type AgentCustomProvider = z.infer<typeof AgentCustomProviderSchema>

/**
 * Snapshot of the app-owned model configuration file.
 *
 * `unmanaged` lists provider ids that the Settings editor will not rewrite:
 * entries carrying fields this app does not model (`headers`, `compat`,
 * `modelOverrides`, a plain-HTTP LAN endpoint, …) or a file that is not valid
 * JSON. They are shown read-only and preserved byte-for-byte on save, so hand
 * edits survive an edit made from the UI.
 */
export const AgentCustomProvidersSchema = z.strictObject({
  /** Absolute path of the file, shown so it can be inspected or hand-edited
   * without guessing where it lives. */
  path: z.string().max(1_024),
  providers: z.array(AgentCustomProviderSchema).max(50).default([]),
  unmanaged: z.array(z.string().max(100)).max(50).default([]),
  /** Pi's own composition/parse error for this file, if any. A broken hand edit
   * is reported here instead of silently yielding an empty catalog. */
  configError: z.string().max(2_000).nullable().default(null)
})
export type AgentCustomProviders = z.infer<typeof AgentCustomProvidersSchema>

/** The editor sends the complete managed set: providers absent from the list
 * are removed from the file, which is what a delete in the UI has to mean. */
export const AgentCustomProvidersSaveInputSchema = z.strictObject({
  providers: z.array(AgentCustomProviderSchema).max(50)
})
export type AgentCustomProvidersSaveInput = z.infer<typeof AgentCustomProvidersSaveInputSchema>

/**
 * One model-discovery probe against a user-added provider.
 *
 * The payload is deliberately credential-free. Electron Main resolves the
 * provider's stored key from `safeStorage` and attaches it to the private
 * credential envelope for exactly one dispatch, so the key never appears in a
 * renderer request, in `models.json`, in SQLite or in a log.
 *
 * `baseUrl` and `api` are carried here instead of being read from the file
 * because the probe must be able to run against *unsaved* editor values: the
 * point of discovery is to learn what an endpoint offers before its model list
 * is committed to disk.
 */
export const AgentModelDiscoveryInputSchema = z.strictObject({
  provider: AgentCustomProviderIdSchema,
  baseUrl: AgentCustomProviderUrlSchema,
  api: AgentCustomProviderApiSchema
})
export type AgentModelDiscoveryInput = z.infer<typeof AgentModelDiscoveryInputSchema>

/**
 * What one endpoint reported, as candidates only.
 *
 * Nothing here is persisted by Core: the renderer holds this list in component
 * state, and a discovered model reaches `models.json` only after the user
 * adopts it and saves. `models` reuses the stored model schema on purpose, so
 * an adopted row carries exactly the fields the file is able to hold.
 */
export const AgentModelDiscoveryResultSchema = z.strictObject({
  provider: AgentCustomProviderIdSchema,
  baseUrl: AgentCustomProviderUrlSchema,
  api: AgentCustomProviderApiSchema,
  models: z.array(AgentCustomProviderModelSchema).max(200).default([]),
  /** Redaction-safe, non-fatal note such as a truncated model list. Never an
   * upstream body, and never a credential. */
  notice: z.string().max(500).nullable().default(null),
  discoveredAt: IsoDateSchema
})
export type AgentModelDiscoveryResult = z.infer<typeof AgentModelDiscoveryResultSchema>

/** One interactive prompt raised while a login is in flight. `promptId` is the
 * correlation token the renderer answers with; the app never re-derives it.
 *
 * A `select` never reaches the renderer while at least one option is offered:
 * the sign-in method is picked in the auth interaction and the choice is
 * reported as an `info` event, because a provider that asks "browser or device
 * code" is asking a question with one answer the user wants (open the page).
 * The renderer keeps the `select` rendering for a prompt with no options. */
export const AgentAuthPromptKindSchema = z.enum(['text', 'secret', 'select', 'manual_code'])
export type AgentAuthPromptKind = z.infer<typeof AgentAuthPromptKindSchema>

export const AgentAuthPromptOptionSchema = z.strictObject({
  value: z.string().max(500),
  label: z.string().max(500),
  description: z.string().max(1_000).nullable().default(null)
})
export type AgentAuthPromptOption = z.infer<typeof AgentAuthPromptOptionSchema>

/**
 * Login progress pushed Core → Main → renderer. It is a discriminated union on
 * `kind` so an unknown future event cannot be mistaken for a prompt. `loginId`
 * is app-generated (never Pi's) and scopes the event to one Settings dialog.
 */
export const AgentAuthEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('started'), loginId: IdSchema, provider: AgentCredentialProviderSchema, authType: AgentAuthTypeSchema }),
  z.strictObject({ kind: z.literal('info'), loginId: IdSchema, message: z.string().max(2_000) }),
  z.strictObject({ kind: z.literal('auth_url'), loginId: IdSchema, url: z.string().max(4_000), instructions: z.string().max(2_000).nullable().default(null) }),
  z.strictObject({ kind: z.literal('device_code'), loginId: IdSchema, userCode: z.string().max(200), verificationUri: z.string().max(4_000), expiresInSeconds: z.int().positive().nullable().default(null) }),
  z.strictObject({ kind: z.literal('progress'), loginId: IdSchema, message: z.string().max(2_000) }),
  z.strictObject({
    kind: z.literal('prompt'), loginId: IdSchema, promptId: IdSchema, promptKind: AgentAuthPromptKindSchema,
    message: z.string().max(2_000), placeholder: z.string().max(2_000).nullable().default(null), options: z.array(AgentAuthPromptOptionSchema).max(50).default([])
  }),
  z.strictObject({ kind: z.literal('done'), loginId: IdSchema, ok: z.boolean(), provider: AgentCredentialProviderSchema, error: z.string().max(2_000).nullable().default(null) })
])
export type AgentAuthEvent = z.infer<typeof AgentAuthEventSchema>

export const AgentAuthLoginStartInputSchema = z.strictObject({ provider: AgentCredentialProviderSchema })
export type AgentAuthLoginStartInput = z.infer<typeof AgentAuthLoginStartInputSchema>

/** The app mints the login id, never Pi: the id scopes pushed events and must
 * survive a Core restart without colliding with an earlier flow. */
export const AgentAuthLoginStartResultSchema = z.strictObject({ loginId: IdSchema })
export type AgentAuthLoginStartResult = z.infer<typeof AgentAuthLoginStartResultSchema>

/** An empty `value` with `promptKind: 'text'` is a legitimate answer (a user
 * clearing an optional field), so the value is not trimmed to a minimum. */
export const AgentAuthLoginAnswerInputSchema = z.strictObject({
  loginId: IdSchema,
  promptId: IdSchema,
  value: z.string().max(20_000)
})
export type AgentAuthLoginAnswerInput = z.infer<typeof AgentAuthLoginAnswerInputSchema>

export const AgentAuthLoginCancelInputSchema = z.strictObject({ loginId: IdSchema })
export type AgentAuthLoginCancelInput = z.infer<typeof AgentAuthLoginCancelInputSchema>

export const AgentAuthLogoutInputSchema = z.strictObject({ provider: AgentCredentialProviderSchema })
export type AgentAuthLogoutInput = z.infer<typeof AgentAuthLogoutInputSchema>

/**
 * The single app-wide Agent default row.
 *
 * These are the values a new conversation or schedule inherits when the caller
 * does not override them, which is what lets the Agent page stop rendering its
 * own model/thinking/permission pickers: the choice is made once, in Settings.
 */
export const AgentSettingsSchema = z.strictObject({
  provider: AgentCredentialProviderSchema.nullable(),
  model: z.string().max(300).nullable(),
  thinking: z.string().max(50).nullable(),
  permissionMode: AgentPermissionModeSchema,
  toolProfile: AgentToolProfileSchema,
  approvalPolicy: AgentApprovalPolicySchema,
  responseLanguage: AgentResponseLanguageSchema,
  updatedAt: IsoDateSchema,
  revision: z.int().nonnegative()
})
export type AgentSettings = z.infer<typeof AgentSettingsSchema>

/**
 * Write input of the app-wide Agent defaults.
 *
 * The model selection is the exact pair (`provider` + `model`), never a fuzzy
 * preference: a bare model id cannot say which endpoint serves it, so a model
 * without a provider is rejected here instead of being resolved later to
 * "whatever the runtime happens to have first". `agentModelSelector` composes
 * the stored pair into the `provider/modelId` selector a runtime call uses.
 */
export const AgentSettingsSaveInputSchema = z.strictObject({
  provider: AgentCredentialProviderSchema.nullable().default(null),
  model: z.string().trim().max(300).nullable().default(null),
  thinking: z.string().trim().max(50).nullable().default(null),
  permissionMode: AgentPermissionModeSchema.default('auto'),
  toolProfile: AgentToolProfileSchema.default('approved-write'),
  approvalPolicy: AgentApprovalPolicySchema.default('never'),
  responseLanguage: AgentResponseLanguageSchema.default('zh-CN'),
  expectedRevision: z.int().nonnegative().nullable().default(null)
}).refine((value) => value.model === null || value.provider !== null, {
  message: '选择默认模型时必须同时指定 Provider：默认选择按 provider/modelId 精确保存，不会回退到其它模型。'
})
export type AgentSettingsSaveInput = z.infer<typeof AgentSettingsSaveInputSchema>

/**
 * The exact `provider/modelId` selector of a stored default, or `null` when the
 * selection is incomplete (or deliberately unspecified).
 *
 * Dependency-free so the Settings form, the runtime dispatch and any future
 * caller compose the selector identically, instead of each inventing its own
 * "first available model" fallback.
 */
export function agentModelSelector(provider: string | null | undefined, model: string | null | undefined): string | null {
  const trimmedProvider = (provider ?? '').trim()
  const trimmedModel = (model ?? '').trim()
  if (!trimmedProvider || !trimmedModel) return null
  return `${trimmedProvider}/${trimmedModel}`
}

/** Proxy endpoints are optional, non-secret runtime metadata. Credentials in
 * proxy URLs are rejected so this configuration can safely live in SQLite. */
export const AgentProxyUrlSchema = z.string().trim().max(2_048).nullable().superRefine((value, context) => {
  if (!value) return
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      context.addIssue({ code: 'custom', message: 'Agent proxy must use HTTP or HTTPS.' })
    }
    if (parsed.username || parsed.password) {
      context.addIssue({ code: 'custom', message: 'Agent proxy URLs must not contain credentials.' })
    }
    if (!parsed.hostname) context.addIssue({ code: 'custom', message: 'Agent proxy must include a host.' })
  } catch {
    context.addIssue({ code: 'custom', message: 'Agent proxy must be a valid HTTP(S) URL.' })
  }
})
export const AgentProxyProfileSchema = z.strictObject({
  id: IdSchema, name: z.string().trim().min(1).max(200), enabled: z.boolean(),
  httpProxy: AgentProxyUrlSchema, httpsProxy: AgentProxyUrlSchema,
  noProxy: z.string().trim().max(2_048).nullable(), createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema, revision: z.int().nonnegative()
})
export type AgentProxyProfile = z.infer<typeof AgentProxyProfileSchema>
export const AgentProxyProfileSaveInputSchema = z.strictObject({
  id: IdSchema.optional(), name: z.string().trim().min(1).max(200), enabled: z.boolean().default(false),
  httpProxy: AgentProxyUrlSchema.default(null), httpsProxy: AgentProxyUrlSchema.default(null),
  noProxy: z.string().trim().max(2_048).nullable().default(null), expectedRevision: z.int().nonnegative().nullable().default(null)
})
export type AgentProxyProfileSaveInput = z.infer<typeof AgentProxyProfileSaveInputSchema>
export const AgentProxyBindingSchema = z.strictObject({ id: IdSchema, profileId: IdSchema, runtime: AgentRuntimeKindSchema, createdAt: IsoDateSchema, updatedAt: IsoDateSchema, revision: z.int().nonnegative() })
export type AgentProxyBinding = z.infer<typeof AgentProxyBindingSchema>
export const AgentProxyBindingSaveInputSchema = z.strictObject({ id: IdSchema.optional(), profileId: IdSchema, runtime: AgentRuntimeKindSchema, expectedRevision: z.int().nonnegative().nullable().default(null) })
export type AgentProxyBindingSaveInput = z.infer<typeof AgentProxyBindingSaveInputSchema>

export const AgentRunStatusSchema = z.enum([
  'planned', 'queued', 'running', 'waiting_confirmation', 'completed',
  'partial', 'failed', 'canceled', 'blocked', 'missed'
])
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>

export const AgentEventKindSchema = z.enum([
  'started', 'heartbeat', 'progress', 'assistant_message', 'tool_call',
  'approval_required', 'artifact_ready', 'completed', 'failed', 'canceled'
])
export type AgentEventKind = z.infer<typeof AgentEventKindSchema>

export const AgentConnectorSchema = z.strictObject({
  id: IdSchema,
  runtime: AgentRuntimeKindSchema,
  /** SDK version of the embedded runtime. `null` before the first probe. */
  version: z.string().max(200).nullable(),
  enabled: z.boolean(),
  available: z.boolean(),
  mcp: z.boolean(),
  structuredOutput: z.boolean(),
  workspaceWrite: z.boolean(),
  message: z.string().max(500),
  /** Volatile status from the installed CLI's own auth check. */
  authReady: z.boolean().optional(),
  /** `app-isolated` means every probe and run used the workbench-owned
   * `agentDir`. The renderer can therefore never show a user's personal
   * `~/.pi` login as an app capability. */
  profileSource: z.enum(['app-isolated', 'unspecified']).optional(),
  /** Redaction-safe profile directory label. */
  profileLabel: z.string().max(500).nullable().optional(),
  /** `app-safeStorage` when an app-owned runtime credential is configured. */
  authSource: z.enum(['app-safeStorage', 'cli-login', 'none']).optional(),
  /** Interactive approval channel of this transport. The embedded runtime runs
   * non-interactively, so a policy of `on-request` cannot prompt. */
  approvalChannel: z.enum(['none', 'interactive']).optional(),
  proxyEnabled: z.boolean(),
  httpProxy: AgentProxyUrlSchema,
  httpsProxy: AgentProxyUrlSchema,
  noProxy: z.string().trim().max(2_048).nullable(),
  /** Ephemeral non-secret defaults detected from the local CLI profile. */
  localDefaultModel: z.string().max(300).nullable().optional(),
  localThinkingLevel: z.string().max(50).nullable().optional(),
  localPermission: z.string().max(100).nullable().optional(),
  modelOptions: z.array(z.string().max(300)).max(200).default([]),
  thinkingOptions: z.array(z.string().max(50)).max(20).default([]),
  // Populated only by a live CLI capability probe.  An empty list means the
  // executable is unavailable or did not advertise permission switches.
  permissionOptions: z.array(AgentPermissionModeSchema).default([]),
  updatedAt: IsoDateSchema,
  revision: z.int().nonnegative()
})
export type AgentConnector = z.infer<typeof AgentConnectorSchema>

export const AgentConnectorSaveInputSchema = z.strictObject({
  id: IdSchema.optional(),
  runtime: AgentRuntimeKindSchema,
  enabled: z.boolean().default(true),
  proxyEnabled: z.boolean().default(false),
  httpProxy: AgentProxyUrlSchema.default(null),
  httpsProxy: AgentProxyUrlSchema.default(null),
  noProxy: z.string().trim().max(2_048).nullable().default(null),
  expectedRevision: z.int().nonnegative().nullable().default(null)
})
export type AgentConnectorSaveInput = z.infer<typeof AgentConnectorSaveInputSchema>

export const AgentBindingSchema = z.strictObject({
  id: IdSchema,
  projectId: ProjectIdSchema.nullable(),
  runtime: AgentRuntimeKindSchema,
  fallbackRuntime: AgentRuntimeKindSchema.nullable(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  revision: z.int().nonnegative()
})
export type AgentBinding = z.infer<typeof AgentBindingSchema>

export const AgentBindingSaveInputSchema = z.strictObject({
  id: IdSchema.optional(),
  projectId: ProjectIdSchema.nullable().default(null),
  runtime: AgentRuntimeKindSchema,
  fallbackRuntime: AgentRuntimeKindSchema.nullable().default(null),
  expectedRevision: z.int().nonnegative().nullable().default(null)
})
export type AgentBindingSaveInput = z.infer<typeof AgentBindingSaveInputSchema>

/** Immutable, redaction-safe description of the skill a run resolved. It is
 * stored on the run so a retry reproduces the original selection instead of
 * re-resolving whatever happens to be installed later. */
export const AgentSkillSnapshotSchema = z.strictObject({
  key: z.string().max(100),
  source: z.enum(['env', 'project', 'packaged']),
  version: z.string().max(100).nullable().default(null),
  commit: z.string().max(100).nullable().default(null),
  /** Redaction-safe label (`%REPO%/…/SKILL.md`), never an absolute path. */
  skillPath: z.string().max(500),
  enginePath: z.string().max(500).nullable().default(null),
  pythonVersion: z.string().max(50).nullable().default(null)
})
export type AgentSkillSnapshot = z.infer<typeof AgentSkillSnapshotSchema>

export const AgentRunRecordSchema = z.strictObject({
  id: IdSchema,
  jobId: IdSchema.nullable(),
  conversationId: IdSchema.nullable(),
  idempotencyKey: z.string().max(512).nullable(),
  runtime: AgentRuntimeKindSchema,
  transport: AgentRunRecordTransportSchema,
  workflowKey: AgentWorkflowKeySchema,
  projectId: ProjectIdSchema.nullable(),
  paperIds: z.array(IdSchema),
  toolProfile: AgentToolProfileSchema,
  permissionMode: AgentPermissionModeSchema.default('auto'),
  approvalPolicy: AgentApprovalPolicySchema.default('never'),
  /** Skill selected for this run. `null` means the workflow prompt only. */
  skillKey: z.string().max(100).nullable().default(null),
  /** Frozen skill identity resolved when the run started; a retry reuses it. */
  skillSnapshot: AgentSkillSnapshotSchema.nullable().default(null),
  /** Where the run's runtime credential came from. `none` is a real, visible
   * state: the run was started without an app-owned credential. */
  credentialSource: z.enum(['app-safeStorage', 'none']).default('none'),
  status: AgentRunStatusSchema,
  input: z.record(z.string(), z.string()),
  output: z.string(),
  artifactId: IdSchema.nullable(),
  error: z.string().nullable(),
  createdAt: IsoDateSchema,
  startedAt: IsoDateSchema.nullable(),
  finishedAt: IsoDateSchema.nullable()
})
export type AgentRunRecord = z.infer<typeof AgentRunRecordSchema>

export const AgentRunStartInputSchema = z.strictObject({
  jobId: IdSchema.nullable().default(null),
  conversationId: IdSchema.nullable().default(null),
  runtime: AgentRuntimeKindSchema.nullable().default(null),
  model: z.string().trim().max(300).nullable().default(null),
  /** Per-run reasoning/thinking override. Null follows the runtime profile. */
  thinking: z.string().trim().max(50).nullable().default(null),
  workflowKey: AgentWorkflowKeySchema,
  /** Optional project-pinned skill. Null means use the workflow prompt only. */
  skillKey: z.string().trim().max(100).nullable().default(null),
  projectId: ProjectIdSchema.nullable().default(null),
  paperIds: z.array(IdSchema).max(500).default([]),
  instructions: z.string().trim().min(1).max(100_000),
  toolProfile: AgentToolProfileSchema.default('approved-write'),
  permissionMode: AgentPermissionModeSchema.default('auto'),
  approvalPolicy: AgentApprovalPolicySchema.default('never'),
  idempotencyKey: z.string().trim().max(512).nullable().default(null),
  /** Set by `retry`: the run whose *stored* skill selection and snapshot this
   * run resumes from. The pinning data therefore always comes from the
   * persisted ledger, never from a client-supplied snapshot. */
  resumeFromRunId: IdSchema.nullable().default(null)
})
export type AgentRunStartInput = z.infer<typeof AgentRunStartInputSchema>

/** A persisted chat session. The shape intentionally mirrors AionUI's
 * conversation selectors while keeping project IDs authoritative in PRW. */
export const AgentConversationStatusSchema = z.enum(['pending', 'running', 'finished', 'archived'])
export type AgentConversationStatus = z.infer<typeof AgentConversationStatusSchema>

export const AgentConversationSchema = z.strictObject({
  id: IdSchema,
  projectId: ProjectIdSchema.nullable(),
  title: z.string().min(1).max(500),
  runtime: AgentRuntimeKindSchema,
  model: z.string().max(300).nullable(),
  assistantKey: z.string().max(300).nullable(),
  toolProfile: AgentToolProfileSchema,
  permissionMode: AgentPermissionModeSchema.default('auto'),
  approvalPolicy: AgentApprovalPolicySchema.default('never'),
  /** Path of the Pi session file this conversation continues. Pi's session
   * JSONL is working state only: SQLite stays authoritative, and a missing or
   * unreadable file degrades to a fresh session instead of failing the run. */
  runtimeSessionId: z.string().max(4_000).nullable().default(null),
  status: AgentConversationStatusSchema,
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  archivedAt: IsoDateSchema.nullable(),
  revision: z.int().nonnegative()
})
export type AgentConversation = z.infer<typeof AgentConversationSchema>

export const AgentConversationCreateInputSchema = z.strictObject({
  projectId: ProjectIdSchema.nullable().default(null),
  title: z.string().trim().min(1).max(500).default('New Chat'),
  runtime: AgentRuntimeKindSchema.default('pi'),
  model: z.string().trim().max(300).nullable().default(null),
  assistantKey: z.string().trim().max(300).nullable().default('researcher'),
  toolProfile: AgentToolProfileSchema.default('approved-write'),
  permissionMode: AgentPermissionModeSchema.default('auto'),
  approvalPolicy: AgentApprovalPolicySchema.default('never')
})
export type AgentConversationCreateInput = z.infer<typeof AgentConversationCreateInputSchema>

export const AgentConversationListInputSchema = z.strictObject({
  projectId: ProjectIdSchema.nullable().optional(),
  includeArchived: z.boolean().default(false),
  limit: z.int().min(1).max(100).default(50)
})
export type AgentConversationListInput = z.infer<typeof AgentConversationListInputSchema>

export const AgentMessageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool'])
export type AgentMessageRole = z.infer<typeof AgentMessageRoleSchema>

export const AgentMessageSchema = z.strictObject({
  id: IdSchema,
  conversationId: IdSchema,
  runId: IdSchema.nullable(),
  role: AgentMessageRoleSchema,
  content: z.string().max(100_000),
  createdAt: IsoDateSchema,
  seq: z.int().nonnegative()
})
export type AgentMessage = z.infer<typeof AgentMessageSchema>

export const AgentConversationMessagesInputSchema = z.strictObject({
  conversationId: IdSchema,
  limit: z.int().min(1).max(500).default(200)
})
export type AgentConversationMessagesInput = z.infer<typeof AgentConversationMessagesInputSchema>

/** A revision-checked conversation archive request.  Archive is the public
 * delete affordance for Agent history; keeping it revision aware prevents a
 * bulk action from silently removing a conversation that changed meanwhile. */
export const AgentConversationArchiveItemSchema = z.strictObject({
  conversationId: IdSchema,
  expectedRevision: z.int().nonnegative()
})
export type AgentConversationArchiveItem = z.infer<typeof AgentConversationArchiveItemSchema>

export const AgentConversationArchiveBulkInputSchema = z.strictObject({
  items: z.array(AgentConversationArchiveItemSchema).min(1).max(100)
}).superRefine((value, context) => {
  const seen = new Set<string>()
  value.items.forEach((item, index) => {
    if (seen.has(item.conversationId)) {
      context.addIssue({ code: 'custom', path: ['items', index, 'conversationId'], message: 'conversationId must be unique' })
    }
    seen.add(item.conversationId)
  })
})
export type AgentConversationArchiveBulkInput = z.infer<typeof AgentConversationArchiveBulkInputSchema>

/** One conversation delete lock for the bulk delete command.
 *
 * The history rail exposes “删除” while the write itself stays a soft archive:
 * the conversation row keeps its runs, events and messages, and only leaves the
 * default list projection. Delete reuses the shared archive lock/receipt
 * vocabulary (`ArchiveBulkInput` / `ArchiveBulkResult`) so the conversation
 * list reports the same succeeded/skipped/conflict/failed outcomes as every
 * other list instead of a second, weaker receipt shape. */
export const AgentConversationRemoveInputSchema = z.strictObject({
  conversationId: IdSchema,
  expectedRevision: z.int().nonnegative()
})
export type AgentConversationRemoveInput = z.infer<typeof AgentConversationRemoveInputSchema>

export const AgentRunListInputSchema = z.strictObject({
  status: AgentRunStatusSchema.optional(),
  projectId: ProjectIdSchema.nullable().optional(),
  page: PageInputSchema.optional()
})
export type AgentRunListInput = z.infer<typeof AgentRunListInputSchema>

export const AgentEventSchema = z.strictObject({
  id: IdSchema,
  runId: IdSchema,
  seq: z.int().nonnegative(),
  kind: AgentEventKindSchema,
  payload: z.unknown(),
  createdAt: IsoDateSchema
})
export type AgentEventRecord = z.infer<typeof AgentEventSchema>

export const AgentRunEventsInputSchema = z.strictObject({
  runId: IdSchema,
  afterSeq: z.int().nonnegative().default(0),
  limit: z.int().min(1).max(500).default(100)
})
export type AgentRunEventsInput = z.infer<typeof AgentRunEventsInputSchema>

/** The normalized run ledger.
 *
 * A run ledger entry is the provider-neutral, auditable projection of one
 * embedded Pi `AgentSessionEvent` (or one of its lifecycle mutations). The
 * renderer's chat view and trajectory view are both pure projections of this
 * ledger, so the mapping from the SDK's event stream to a record happens
 * exactly once, inside `@prw/agent-runtime`, instead of being guessed in the
 * renderer. */
export const AgentRecordKindSchema = z.enum([
  'user', 'assistant', 'reasoning', 'tool', 'subtool', 'system', 'context',
  'diagnostic', 'compacted', 'error', 'turn_end'
])
export type AgentRecordKind = z.infer<typeof AgentRecordKindSchema>

export const AgentRecordStatusSchema = z.enum(['info', 'running', 'completed', 'failed', 'canceled'])
export type AgentRecordStatus = z.infer<typeof AgentRecordStatusSchema>

/** Token accounting as reported by the SDK. Every field stays nullable because
 * providers report different subsets, and this value is never synthesized. */
export const AgentUsageSchema = z.strictObject({
  input: z.int().nonnegative().nullable().default(null),
  output: z.int().nonnegative().nullable().default(null),
  think: z.int().nonnegative().nullable().default(null),
  cacheRead: z.int().nonnegative().nullable().default(null),
  cacheWrite: z.int().nonnegative().nullable().default(null),
  total: z.int().nonnegative().nullable().default(null)
})
export type AgentUsage = z.infer<typeof AgentUsageSchema>

/** `parentId` references the parent record's `recordKey` (not its row id), so a
 * chain of subtool records stays stable across the streamed in-place updates. */
export const AgentRunRecordEntrySchema = z.strictObject({
  id: IdSchema,
  runId: IdSchema,
  seq: z.int().nonnegative(),
  recordKey: z.string().min(1).max(512),
  kind: AgentRecordKindSchema,
  status: AgentRecordStatusSchema,
  turn: z.int().nonnegative(),
  step: z.int().nonnegative(),
  title: z.string().max(500),
  detail: z.string().max(65_536),
  inputText: z.string().max(65_536).nullable(),
  outputText: z.string().max(65_536).nullable(),
  toolName: z.string().max(200).nullable(),
  callId: z.string().max(200).nullable(),
  parentId: z.string().max(512).nullable(),
  startedAt: IsoDateSchema.nullable(),
  finishedAt: IsoDateSchema.nullable(),
  durationMs: z.int().nonnegative().nullable(),
  usage: AgentUsageSchema.nullable(),
  truncated: z.boolean(),
  createdAt: IsoDateSchema
})
export type AgentRunRecordEntry = z.infer<typeof AgentRunRecordEntrySchema>

/** Internal (non-wire) shape an adapter hands to Core for one ledger record.
 * Persistence owns `id`/`runId`/`seq`/`createdAt`, and every optional field means
 * "unspecified": an in-place update keeps the previously stored value instead of
 * clearing it, which is what lets a streamed record grow without losing fields. */
export interface AgentRunRecordDraft {
  /** Adapter-owned stable identity: the ledger upserts by this key, so streamed
   * content grows one record in place instead of appending a row per delta. */
  readonly recordKey: string
  readonly kind: AgentRecordKind
  readonly status?: AgentRecordStatus | undefined
  /** Ledger-owned hierarchy. Omitted means "unspecified": an update keeps the
   * stored value and an insert falls back to `0`. */
  readonly turn?: number | undefined
  readonly step?: number | undefined
  readonly title?: string | undefined
  readonly detail?: string | undefined
  readonly inputText?: string | null | undefined
  readonly outputText?: string | null | undefined
  readonly toolName?: string | null | undefined
  readonly callId?: string | null | undefined
  readonly parentId?: string | null | undefined
  readonly startedAt?: string | null | undefined
  readonly finishedAt?: string | null | undefined
  readonly durationMs?: number | null | undefined
  readonly usage?: AgentUsage | null | undefined
}

/** Trajectory paging. `beforeSeq` walks older rows, `afterSeq` tops up a live
 * run, and omitting both returns the newest `limit` rows. Row `seq` is stable
 * after insert, which is what makes it usable as the trajectory anchor. */
export const AgentRunRecordsPageInputSchema = z.strictObject({
  runId: IdSchema,
  beforeSeq: z.int().nonnegative().nullable().default(null),
  afterSeq: z.int().nonnegative().nullable().default(null),
  limit: z.int().min(1).max(500).default(200)
})
export type AgentRunRecordsPageInput = z.infer<typeof AgentRunRecordsPageInputSchema>

/** Chat projection input. The window is taken from the tail; "load earlier"
 * widens `limit` instead of using a cursor so an insert during streaming can
 * never shift a page boundary. */
export const AgentConversationRecordsInputSchema = z.strictObject({
  conversationId: IdSchema,
  limit: z.int().min(1).max(2_000).default(500)
})
export type AgentConversationRecordsInput = z.infer<typeof AgentConversationRecordsInputSchema>

/** Incremental ledger push (Core -> Main -> renderer). This is the only new
 * send direction in the Agent stack; it is validated with this schema at every
 * hop and is scoped to the runs a renderer explicitly subscribed to. */
export const AgentLedgerPushSchema = z.strictObject({
  runId: IdSchema,
  run: AgentRunRecordSchema,
  records: z.array(AgentRunRecordEntrySchema).max(500)
})
export type AgentLedgerPush = z.infer<typeof AgentLedgerPushSchema>

export const AgentLedgerSubscriptionInputSchema = z.strictObject({
  runId: IdSchema,
  action: z.enum(['subscribe', 'unsubscribe']).default('subscribe')
})
export type AgentLedgerSubscriptionInput = z.infer<typeof AgentLedgerSubscriptionInputSchema>

export const AgentApprovalSchema = z.strictObject({
  id: IdSchema,
  runId: IdSchema,
  operation: z.string().min(1).max(200),
  summary: z.string().max(2_000),
  /** `auto-approved`/`denied` are not user decisions: they record what the
   * non-interactive embedded transport actually did with the requested
   * permission mode, so the ledger never shows an empty approval list as
   * "nothing to approve" when a run silently escalated. */
  status: z.enum(['pending', 'auto-approved', 'denied', 'approved', 'rejected', 'expired']),
  /** Policy that produced this row. */
  policy: AgentApprovalPolicySchema.default('never'),
  /** Machine-readable reason (`cli-non-interactive`, `security-gate`, ...). */
  reason: z.string().max(200).nullable().default(null),
  createdAt: IsoDateSchema,
  decidedAt: IsoDateSchema.nullable()
})
export type AgentApproval = z.infer<typeof AgentApprovalSchema>

export const AgentApprovalDecisionInputSchema = z.strictObject({
  id: IdSchema,
  decision: z.enum(['approve', 'reject'])
})

export type AgentApprovalDecisionInput = z.infer<typeof AgentApprovalDecisionInputSchema>

/**
 * Which external write an Agent run is asking the user to confirm.
 *
 * The Agent may read Zotero and the Obsidian Vault, and may build a preview of a
 * write, but it can never perform the write on its own: an external user's data
 * is not something a model gets to change without a person saying yes. Each kind
 * names the frozen operation, so approving replays exactly the write the user
 * was shown rather than re-deriving it from a later selection.
 */
export const AgentExternalActionKindSchema = z.enum([
  /** A Zotero import, from either route: `zotero.paperToZotero.execute` for
   * selected Papers or `literature.stagingToZotero.execute` for search-staging
   * records. The two routes keep separate preview stores, and the frozen
   * payload records which one produced the row. */
  'zotero-import',
  /** New Obsidian note through `notes.write`. */
  'obsidian-note',
  /** Managed frontmatter of an existing note through `notes.metadata.apply`. */
  'obsidian-metadata'
])
export type AgentExternalActionKind = z.infer<typeof AgentExternalActionKindSchema>

export const AgentExternalActionStatusSchema = z.enum([
  /** Waiting on a user decision in the conversation. */
  'pending',
  /** Decided, write in flight. A crash here leaves a row that must be retried. */
  'approved',
  /** The user declined; nothing was written. */
  'rejected',
  /** The write completed; `receipt` describes what changed. */
  'executed',
  /** Transport/permission failure with no partial write. */
  'failed',
  /** The frozen target changed underneath the preview (external edit/revision). */
  'conflict',
  /** The decision window closed before anyone decided. */
  'expired'
])
export type AgentExternalActionStatus = z.infer<typeof AgentExternalActionStatusSchema>

/**
 * One pending external write.
 *
 * `summary` is the redacted text the confirmation card shows: target, counts and
 * collection/path. It never carries a credential, and for Obsidian never the
 * note body. The frozen execute payload stays in the database (SQLite is the
 * authoritative store) and is not part of this shape.
 */
export const AgentExternalActionSchema = z.strictObject({
  id: IdSchema,
  runId: IdSchema,
  conversationId: IdSchema.nullable(),
  kind: AgentExternalActionKindSchema,
  /** The Zotero profile or Obsidian Vault the write targets. */
  profileId: IdSchema,
  status: AgentExternalActionStatusSchema,
  summary: z.string().max(2_000),
  /** Zotero's own preview id, so the receipt can be traced back to the preview. */
  previewId: IdSchema.nullable(),
  createdAt: IsoDateSchema,
  /** After this instant the action can no longer be approved. */
  expiresAt: IsoDateSchema,
  decidedAt: IsoDateSchema.nullable(),
  /** Per-item outcome of the write; `null` until it ran. */
  receipt: z.record(z.string(), z.unknown()).nullable(),
  /** Redacted failure reason. Never a request body or a response excerpt. */
  error: z.string().max(2_000),
  /** CAS lock, matching the rest of the app's revision style. */
  revision: z.int().nonnegative()
})
export type AgentExternalAction = z.infer<typeof AgentExternalActionSchema>

export const AgentExternalActionsInputSchema = z.strictObject({
  runId: IdSchema.optional(),
  conversationId: IdSchema.optional(),
  status: AgentExternalActionStatusSchema.optional()
})
export type AgentExternalActionsInput = z.infer<typeof AgentExternalActionsInputSchema>

/**
 * The user's decision on one pending external write.
 *
 * An Agent run cannot reach this RPC: the model's only way into the workbench is
 * the MCP tool list, the decision method is registered on the Agent RPC surface
 * only, and no MCP tool forwards it. The decision itself is still locked three
 * ways — pending status, expiry and `expectedRevision` — so a stale card or a
 * double click resolves to a conflict instead of a second write.
 */
export const AgentExternalActionDecideInputSchema = z.strictObject({
  id: IdSchema,
  decision: z.enum(['approve', 'reject']),
  expectedRevision: z.int().nonnegative()
})
export type AgentExternalActionDecideInput = z.infer<typeof AgentExternalActionDecideInputSchema>

/**
 * What an Agent tool gets back after requesting an external write.
 *
 * `message` is part of the contract on purpose: the tool result is the only
 * thing the model is guaranteed to read, so the fact that nothing has been
 * written yet travels with the data instead of relying on the model to infer it
 * from an empty receipt.
 */
export const AgentExternalActionRequestResultSchema = z.strictObject({
  action: AgentExternalActionSchema,
  message: z.string().max(2_000)
})
export type AgentExternalActionRequestResult = z.infer<typeof AgentExternalActionRequestResultSchema>

export const AutomationRuleSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1).max(200),
  workflowKey: AgentWorkflowKeySchema,
  runtime: AgentRuntimeKindSchema.nullable(),
  model: z.string().max(300).nullable(),
  assistantKey: z.string().max(300).nullable(),
  workspacePath: z.string().max(4_000).nullable(),
  frequency: z.enum(['manual', 'hourly', 'daily', 'weekdays', 'weekly', 'custom']),
  executionMode: z.enum(['new_conversation', 'existing']),
  conversationId: IdSchema.nullable(),
  prompt: z.string().max(100_000),
  skillKey: z.string().trim().max(100).nullable().default(null),
  topic: z.string().trim().max(500).default(''),
  sources: AgentSourceListSchema.default([]),
  lookbackDays: AgentLookbackDaysSchema.default(30),
  /** Narrative language of the delivered push; see
   *`AgentResponseLanguageSchema`. */
  responseLanguage: AgentResponseLanguageSchema.default('zh-CN'),
  outputFolder: z.string().trim().max(180).default(DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.outputFolder),
  permissionMode: AgentPermissionModeSchema.default('auto'),
  approvalPolicy: AgentApprovalPolicySchema.default('never'),
  projectId: ProjectIdSchema.nullable(),
  cron: z.string().min(1).max(200),
  timezone: z.string().min(1).max(100),
  enabled: z.boolean(),
  nextRunAt: IsoDateSchema.nullable(),
  lastRunAt: IsoDateSchema.nullable(),
  revision: z.int().nonnegative()
})
export type AutomationRule = z.infer<typeof AutomationRuleSchema>

export const AutomationRuleSaveInputSchema = z.strictObject({
  id: IdSchema.optional(),
  name: z.string().trim().min(1).max(200),
  workflowKey: AgentWorkflowKeySchema,
  runtime: AgentRuntimeKindSchema.nullable().default(null),
  model: z.string().trim().max(300).nullable().default(null),
  assistantKey: z.string().trim().max(300).nullable().default('researcher'),
  workspacePath: z.string().trim().max(4_000).nullable().default(null),
  frequency: z.enum(['manual', 'hourly', 'daily', 'weekdays', 'weekly', 'custom']).default('custom'),
  executionMode: z.enum(['new_conversation', 'existing']).default('new_conversation'),
  conversationId: IdSchema.nullable().default(null),
  prompt: z.string().trim().max(100_000).default(''),
  skillKey: z.string().trim().max(100).nullable().default(null),
  topic: z.string().trim().max(500).default(''),
  sources: AgentSourceListSchema.default([]),
  lookbackDays: AgentLookbackDaysSchema.default(30),
  responseLanguage: AgentResponseLanguageSchema.default('zh-CN'),
  /** Write path is schema-checked: an absolute/traversing/reserved output
   * folder never reaches the coordinator. The read-side `AutomationRuleSchema`
   * stays tolerant so a legacy row cannot make the task list unreadable. */
  outputFolder: AgentOutputFolderSchema.default(DEFAULT_DAILY_PUSH_SCHEDULE_INPUT.outputFolder),
  permissionMode: AgentPermissionModeSchema.default('auto'),
  approvalPolicy: AgentApprovalPolicySchema.default('never'),
  projectId: ProjectIdSchema.nullable().default(null),
  cron: z.string().trim().min(1).max(200),
  timezone: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  expectedRevision: z.int().nonnegative().nullable().default(null)
})
export type AutomationRuleSaveInput = z.infer<typeof AutomationRuleSaveInputSchema>

/**
 * One claimed cron occurrence of a schedule.
 *
 * The row is the durable "run lock" for a time slot: it is written in the same
 * transaction that advances the schedule cursor, so a crash, a shutdown or a
 * policy refusal can never leave "the cursor moved but nothing ever ran"
 * without a visible record. `idempotencyKey` is the same key the run itself is
 * started with, so a duplicate tick, a duplicate “Run now” and the once-per-`
 * start catch-up all collapse onto one row.
 */
export const ScheduleOccurrenceSourceSchema = z.enum(['scheduler', 'catchup', 'manual'])
export type ScheduleOccurrenceSource = z.infer<typeof ScheduleOccurrenceSourceSchema>

export const ScheduleOccurrenceStatusSchema = z.enum([
  'claimed',
  'running',
  'completed',
  'failed',
  'blocked',
  'canceled',
  'missed',
  'skipped'
])
export type ScheduleOccurrenceStatus = z.infer<typeof ScheduleOccurrenceStatusSchema>

export const ScheduleOccurrenceSchema = z.strictObject({
  id: IdSchema,
  scheduleId: IdSchema,
  occurrenceAt: IsoDateSchema,
  /** Local day the occurrence belongs to, in the rule's own timezone. */
  localDateKey: z.string().min(1).max(20),
  idempotencyKey: z.string().min(1).max(512),
  source: ScheduleOccurrenceSourceSchema,
  status: ScheduleOccurrenceStatusSchema,
  runId: IdSchema.nullable(),
  /** Concrete reason for a non-successful occurrence (policy gate, missing
   * credential, interrupted app, capability block). Never a stack trace. */
  reason: z.string().max(1_000).default(''),
  claimedAt: IsoDateSchema,
  settledAt: IsoDateSchema.nullable(),
  revision: z.int().nonnegative()
})
export type ScheduleOccurrence = z.infer<typeof ScheduleOccurrenceSchema>

/**
 * Automation page projection of one scheduled run: the run's terminal status,
 * the occurrence it consumed (including the reason a slot produced nothing) and
 * the delivered artifact / Obsidian outcome.
 *
 * `output` is deliberately not part of this view: the run detail page owns the
 * full body, while the schedule card only needs a bounded reason.
 */
export const AutomationRunHistoryEntrySchema = z.strictObject({
  runId: IdSchema,
  /** CAS token for the RUN HISTORY delete commands, exactly like every other
   * archivable row: a record that changed after it was selected (a run that just
   * finished) reports a revision conflict instead of being removed blindly. */
  revision: z.int().nonnegative(),
  scheduleId: IdSchema,
  status: AgentRunStatusSchema,
  startedAt: IsoDateSchema,
  finishedAt: IsoDateSchema.nullable(),
  occurrenceAt: IsoDateSchema.nullable(),
  occurrenceStatus: ScheduleOccurrenceStatusSchema.nullable(),
  occurrenceSource: ScheduleOccurrenceSourceSchema.nullable(),
  /** Why this slot did not produce a usable push (occurrence reason or run error). */
  blockedReason: z.string().max(1_000).nullable(),
  artifact: z.strictObject({ id: IdSchema, title: z.string().max(500) }).nullable(),
  delivery: z.strictObject({
    status: z.enum(['written', 'skipped']),
    relativePath: z.string().max(500).nullable(),
    reason: z.string().max(100).nullable(),
    message: z.string().max(500).nullable()
  }).nullable()
})
export type AutomationRunHistoryEntry = z.infer<typeof AutomationRunHistoryEntrySchema>

export const AutomationRunHistoryInputSchema = z.strictObject({
  /** `undefined` returns the newest runs of every rule. */
  scheduleId: IdSchema.optional(),
  limit: z.int().min(1).max(20).default(5)
})
export type AutomationRunHistoryInput = z.infer<typeof AutomationRunHistoryInputSchema>

export const AgentInboxItemSchema = z.strictObject({
  id: IdSchema,
  runId: IdSchema.nullable(),
  artifactId: IdSchema.nullable(),
  title: z.string().min(1).max(500),
  body: z.string().max(100_000),
  kind: z.union([ArtifactKindSchema, z.literal('approval'), z.literal('failure')]),
  read: z.boolean(),
  createdAt: IsoDateSchema
})
export type AgentInboxItem = z.infer<typeof AgentInboxItemSchema>

export const AgentRpcMethodPayloadSchemas = {
  'agent.conversations.list': AgentConversationListInputSchema,
  'agent.conversations.create': AgentConversationCreateInputSchema,
  'agent.conversations.get': z.strictObject({ conversationId: IdSchema }),
  'agent.conversations.messages': AgentConversationMessagesInputSchema,
  'agent.conversations.archive': z.strictObject({ conversationId: IdSchema, expectedRevision: z.int().nonnegative() }),
  'agent.conversations.archiveBulk': AgentConversationArchiveBulkInputSchema,
  // CONVERSATION delete: the same CAS-locked soft archive as `archive`, but
  // every record reports its own outcome instead of throwing a single error
  // for the whole command.
  'agent.conversations.remove': AgentConversationRemoveInputSchema,
  'agent.conversations.removeBulk': ArchiveBulkInputSchema,
  'agent.connectors.list': z.null(),
  'agent.connectors.test': z.strictObject({ runtime: AgentRuntimeKindSchema }),
  'agent.connectors.save': AgentConnectorSaveInputSchema,
  'agent.bindings.list': z.null(),
  'agent.credentials.status': z.null(),
  'agent.credentials.save': AgentCredentialSaveInputSchema,
  // Provider/model catalog generated from the embedded Pi SDK. It is
  // credential-free, so it can be cached by the renderer without ever leaking a
  // secret or going stale on a vault write.
  'agent.models.catalog': z.null(),
  // Interactive login (OAuth device code / browser URL / host prompts).
  // `login.start` returns the app-generated `loginId`; every later event is
  // pushed to the renderer and filtered by that id.
  'agent.models.login.start': AgentAuthLoginStartInputSchema,
  'agent.models.login.answer': AgentAuthLoginAnswerInputSchema,
  'agent.models.login.cancel': AgentAuthLoginCancelInputSchema,
  'agent.models.logout': AgentAuthLogoutInputSchema,
  // User-added providers, persisted to the app-owned models.json so the
  // configuration survives a reinstall of the database and can be hand-edited.
  'agent.models.custom.get': z.null(),
  'agent.models.custom.save': AgentCustomProvidersSaveInputSchema,
  // Endpoint probe for one user-added provider. Credential-bearing on the
  // private Main→Core envelope only: the public payload names the provider so
  // Main can resolve its key, and never carries the key itself.
  'agent.models.custom.discover': AgentModelDiscoveryInputSchema,
  // App-wide Agent defaults (default provider/model/thinking, permission mode,
  // tool profile, approval policy, response language).
  'agent.settings.get': z.null(),
  'agent.settings.save': AgentSettingsSaveInputSchema,
  'agent.bindings.save': AgentBindingSaveInputSchema,
  'agent.proxyProfiles.list': z.null(),
  'agent.proxyProfiles.save': AgentProxyProfileSaveInputSchema,
  'agent.proxyBindings.list': z.null(),
  'agent.proxyBindings.save': AgentProxyBindingSaveInputSchema,
  'agent.runs.start': AgentRunStartInputSchema,
  'agent.runs.list': AgentRunListInputSchema,
  'agent.runs.get': z.strictObject({ runId: IdSchema }),
  'agent.runs.eventsPage': AgentRunEventsInputSchema,
  'agent.runs.recordsPage': AgentRunRecordsPageInputSchema,
  'agent.conversations.records': AgentConversationRecordsInputSchema,
  'agent.runs.cancel': z.strictObject({ runId: IdSchema }),
  'agent.runs.retry': z.strictObject({ runId: IdSchema }),
  'agent.approvals.list': z.strictObject({ runId: IdSchema.optional() }),
  'agent.approvals.decide': AgentApprovalDecisionInputSchema,
  // Pending external writes (Zotero/Obsidian). The Agent creates them by
  // freezing a preview; only a user decision may replay that preview, and the
  // decision is not reachable as an MCP tool.
  'agent.externalActions.list': AgentExternalActionsInputSchema,
  'agent.externalActions.decide': AgentExternalActionDecideInputSchema,
  'automation.rules.list': z.null(),
  'automation.skills.list': z.null(),
  'automation.rules.save': AutomationRuleSaveInputSchema,
  'automation.rules.archive': z.strictObject({ id: IdSchema, expectedRevision: z.int().nonnegative() }),
  /** Archive several rules in one transaction. Archiving a rule stops it from
   * running but deliberately keeps its run/occurrence history and delivered
   * artifacts: the receipts below describe rules, never history rows. */
  'automation.rules.bulkArchive': ArchiveBulkInputSchema,
  'automation.rules.runNow': z.strictObject({ id: IdSchema }),
  'automation.runs.list': z.strictObject({ limit: z.int().min(1).max(100).default(50) }),
  'automation.runs.history': AutomationRunHistoryInputSchema,
  // RUN HISTORY record removal: a CAS lock per record, soft archive only.
  'automation.runs.archive': z.strictObject({ runId: IdSchema, expectedRevision: z.int().nonnegative() }),
  'automation.runs.archiveBulk': ArchiveBulkInputSchema,
  'automation.runs.retry': z.strictObject({ runId: IdSchema }),
  'inbox.ai.list': z.strictObject({ unreadOnly: z.boolean().default(false) }),
  'inbox.ai.markRead': z.strictObject({ id: IdSchema }),
  'inbox.ai.archive': z.strictObject({ id: IdSchema })
} as const

export type AgentRpcMethod = keyof typeof AgentRpcMethodPayloadSchemas

const agentRpc = <M extends AgentRpcMethod>(method: M) =>
  z.strictObject({ id: IdSchema, method: z.literal(method), payload: AgentRpcMethodPayloadSchemas[method] })

export const AgentRpcRequestSchema = z.discriminatedUnion('method', [
  ...Object.keys(AgentRpcMethodPayloadSchemas).map((method) => agentRpc(method as AgentRpcMethod))
] as [ReturnType<typeof agentRpc>, ...ReturnType<typeof agentRpc>[]])
export type AgentRpcRequest = z.infer<typeof AgentRpcRequestSchema>

/**
 * Upper bound on credentials in one Main→Core envelope.
 *
 * The bound exists so a malformed or hostile Main payload cannot be unbounded;
 * it is deliberately far above any realistic number of configured providers.
 * A tighter number is a correctness bug rather than a hardening measure: runs
 * and logins are dispatched with every stored credential on purpose, so a user
 * with more providers than the bound would see every model call fail with a
 * schema error that has nothing to do with their configuration.
 */
export const AGENT_CREDENTIAL_ENVELOPE_MAX_ENTRIES = 64

/**
 * Private Main→Core envelope for Agent RPCs that need a credential.
 *
 * Electron Main owns the `safeStorage` vault, so it resolves the credential for
 * the provider the request targets and attaches it for exactly one dispatch.
 * The renderer never sees this envelope, Core never persists it, and the secret
 * is handed to the app-owned `CredentialStore` only for the lifetime of the
 * session that needs it. An empty `credentials` list is a valid, meaningful
 * request: Core then fails closed instead of reaching for the user's personal
 * `~/.pi` login.
 */
export const AgentCredentialEnvelopeSchema = z.strictObject({
  type: z.literal('prw.agent-rpc-with-credential'),
  request: AgentRpcRequestSchema,
  credentials: z.array(z.strictObject({
    provider: AgentCredentialProviderSchema,
    /** Pi's own credential shape, validated by the SDK on read. It is passed
     * through opaquely here because OAuth refresh material is provider-specific
     * and re-declaring it would fork Pi's credential contract. */
    credential: z.record(z.string(), z.unknown())
  })).max(AGENT_CREDENTIAL_ENVELOPE_MAX_ENTRIES).default([])
})
export type AgentCredentialEnvelope = z.infer<typeof AgentCredentialEnvelopeSchema>

export interface WorkbenchAgentApiV1 {
  conversations: {
    list(input?: AgentConversationListInput): Promise<AgentConversation[]>
    create(input?: AgentConversationCreateInput): Promise<AgentConversation>
    get(conversationId: string): Promise<AgentConversation>
    messages(input: AgentConversationMessagesInput): Promise<AgentMessage[]>
    /** Tail window of the conversation's run-ledger records (chat projection). */
    records(input: AgentConversationRecordsInput): Promise<AgentRunRecordEntry[]>
    archive(conversationId: string, expectedRevision: number): Promise<void>
    archiveBulk(items: AgentConversationArchiveItem[]): Promise<void>
    /** Delete one conversation record. Delete is a revision-checked soft archive
     * (the row, its runs, events and messages stay readable) that reports its
     * own outcome instead of a shared all-or-nothing error. */
    remove(conversationId: string, expectedRevision: number): Promise<ArchiveBulkReceipt>
    /** Delete a selected conversation set with one per-record receipt each. A
     * stale lock is a `conflict`, an already-removed conversation is `skipped`,
     * so a bulk delete can never report a row it did not actually remove. */
    removeBulk(items: ReadonlyArray<{ id: string; expectedRevision: number }>): Promise<ArchiveBulkResult>
  }
  connectors: {
    list(): Promise<AgentConnector[]>
    test(runtime: AgentRuntimeKind): Promise<AgentConnector>
    save(input: AgentConnectorSaveInput): Promise<AgentConnector>
  }
  bindings: {
    list(): Promise<AgentBinding[]>
    save(input: AgentBindingSaveInput): Promise<AgentBinding>
  }
  /** Runtime credentials live in Main's safeStorage vault; the renderer only
   * ever sees the non-secret status. */
  credentials: {
    status(): Promise<AgentCredentialStatus[]>
    save(input: AgentCredentialSaveInput): Promise<AgentCredentialStatus[]>
  }
  /** Provider/model catalog and interactive login. Both are backed by the
   * embedded Pi SDK; the renderer never sees a token, only progress events. */
  models: {
    catalog(): Promise<AgentModelCatalogEntry[]>
    loginStart(input: AgentAuthLoginStartInput): Promise<AgentAuthLoginStartResult>
    loginAnswer(input: AgentAuthLoginAnswerInput): Promise<void>
    loginCancel(input: AgentAuthLoginCancelInput): Promise<void>
    logout(input: AgentAuthLogoutInput): Promise<AgentCredentialStatus[]>
    /** Custom provider entries of the app-owned models.json. Reading is safe
     * while the file is being edited by hand: a broken file is reported, not
     * thrown away. */
    customProviders: {
      get(): Promise<AgentCustomProviders>
      save(input: AgentCustomProvidersSaveInput): Promise<AgentCustomProviders>
      /** Ask one endpoint which models it advertises. The key travels beside
       * the payload in Main's private credential envelope; the results are
       * candidates only and are not written anywhere until the user adopts
       * them and saves `models.json`. */
      discover(input: AgentModelDiscoveryInput): Promise<AgentModelDiscoveryResult>
    }
    /** Login progress for every in-flight login. The listener filters by
     * `loginId`; the app tolerates a missed early event by treating the
     * absence of `done` as "still running". */
    onAuthEvent(listener: (event: AgentAuthEvent) => void): () => void
  }
  /** App-wide Agent defaults, edited in Settings and inherited by new
   * conversations and schedules. */
  settings: {
    get(): Promise<AgentSettings>
    save(input: AgentSettingsSaveInput): Promise<AgentSettings>
  }
  proxyProfiles: { list(): Promise<AgentProxyProfile[]>; save(input: AgentProxyProfileSaveInput): Promise<AgentProxyProfile> }
  proxyBindings: { list(): Promise<AgentProxyBinding[]>; save(input: AgentProxyBindingSaveInput): Promise<AgentProxyBinding> }
  runs: {
    start(input: AgentRunStartInput): Promise<AgentRunRecord>
    list(input?: AgentRunListInput): Promise<AgentRunRecord[]>
    get(runId: string): Promise<AgentRunRecord>
    eventsPage(input: AgentRunEventsInput): Promise<AgentEventRecord[]>
    /** Normalized run ledger; the trajectory view's only data source. */
    recordsPage(input: AgentRunRecordsPageInput): Promise<AgentRunRecordEntry[]>
    /** Live ledger deltas. Returns an unsubscribe function; the legacy polling
     * path stays available as a fallback when this channel is unavailable. */
    subscribe(runId: string, handler: (push: AgentLedgerPush) => void): () => void
    cancel(runId: string): Promise<void>
    retry(runId: string): Promise<AgentRunRecord>
  }
  approvals: {
    list(runId?: string): Promise<AgentApproval[]>
    decide(input: AgentApprovalDecisionInput): Promise<AgentApproval>
  }
  /** External writes the Agent prepared; the card in the conversation decides
   * them. Nothing leaves the machine until one is approved. */
  externalActions: {
    list(input?: AgentExternalActionsInput): Promise<AgentExternalAction[]>
    decide(input: AgentExternalActionDecideInput): Promise<AgentExternalAction>
  }
  automation: {
    rules(): Promise<AutomationRule[]>
    /** Selectable skills with their real installed state. A reserved key or a
     * missing `SKILL.md` is reported as not runnable with the blocked reason;
     * the editor shows it as not installed instead of as a usable option. */
    skills(): Promise<AgentScheduleSkillCatalogEntry[]>
    save(input: AutomationRuleSaveInput): Promise<AutomationRule>
    archive(id: string, expectedRevision: number): Promise<void>
    /** Archive the selected rules in one transaction with per-rule receipts;
     * run history, occurrences and delivered artifacts are left intact. */
    bulkArchive(input: ArchiveBulkInput): Promise<ArchiveBulkResult>
    runNow(id: string): Promise<AgentRunRecord>
    runs(limit?: number): Promise<AgentRunRecord[]>
    /** Recent runs of one rule (or of every rule) with the consumed occurrence,
     * the blocked/skipped reason, the artifact and the Obsidian delivery state. */
    history(input?: AutomationRunHistoryInput): Promise<AutomationRunHistoryEntry[]>
    /** Soft-archive one RUN HISTORY record with a CAS revision lock: the audit
     * row stays in the local database, the rule/occurrence cursor, the Artifact,
     * Obsidian output and every credential are untouched. */
    archiveRun(runId: string, expectedRevision: number): Promise<void>
    /** Archive the selected RUN HISTORY records in one transaction with per-run
     * receipts; stale locks report a conflict and are never written. */
    bulkArchiveRuns(input: ArchiveBulkInput): Promise<ArchiveBulkResult>
    /** Safe retry entry: re-runs the owning *schedule*, so the recorded
     * permission/approval policy, the skill selection and the occurrence lock
     * all still apply. It never replays a run with elevated permissions. */
    retryRun(runId: string): Promise<AgentRunRecord>
  }
  inbox: {
    list(unreadOnly?: boolean): Promise<AgentInboxItem[]>
    markRead(id: string): Promise<void>
    archive(id: string): Promise<void>
  }
}
