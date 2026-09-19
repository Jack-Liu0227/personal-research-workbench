import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Credential } from '@earendil-works/pi-ai'
import type {
  AgentAuthEvent,
  AgentAuthPromptKind,
  AgentAuthPromptOption,
  AgentRunRecordDraft,
  AgentRuntimeKind,
  AgentRuntimeTransport,
  AgentToolProfile
} from '@prw/contracts'

/**
 * The Agent runtime is embedded in the Core utility process.
 *
 * Earlier revisions spawned a Codex or Pi CLI and parsed its stdout. That
 * design could not see the workbench at all: the spawned process had no MCP
 * server, no credential channel and no way to write a task row, which is why
 * the Agent could only ever produce prose. Everything below describes the
 * in-process contract instead.
 *
 * The boundaries that survived the rewrite and are still enforced here:
 *
 *  - the runtime only ever sees an app-owned profile directory, so `~/.pi` is
 *    never read, written or reused;
 *  - credentials arrive as typed values from Electron Main's `safeStorage`
 *    vault and are held in memory for exactly one run;
 *  - the runtime reaches the workbench only through an MCP client the caller
 *    opens for that run, so the tool surface is a caller decision.
 */

export interface AgentRuntimeCapabilities {
  readonly kind: AgentRuntimeKind
  readonly transport: AgentRuntimeTransport
  readonly available: boolean
  readonly version: string | null
  readonly mcp: boolean
  readonly structuredOutput: boolean
  readonly workspaceWrite: boolean
  readonly message: string
  /** Configuration fact, not a model-call validation: `app-safeStorage` means
   * Main has a credential for the configured provider, `none` means a run
   * would fail with `AUTH_REQUIRED`. */
  readonly authReady?: boolean
  readonly authSource?: 'app-safeStorage' | 'none'
  /** Where the runtime profile comes from. Always `app-isolated`: the
   * workbench never falls back to a user's own Pi directory. */
  readonly profileSource?: 'app-isolated' | 'unspecified'
  /** Redaction-safe label of the profile directory. */
  readonly profileLabel?: string | null
  /** The embedded session reuses Pi's own approval surface instead of a
   * terminal prompt, so there is no external approval channel to report. */
  readonly approvalChannel?: 'none' | 'interactive'
  readonly localDefaultModel?: string | null
  readonly localThinkingLevel?: string | null
  readonly localPermission?: string | null
  readonly modelOptions?: string[]
  readonly thinkingOptions?: string[]
  readonly permissionOptions?: Array<'read-only' | 'auto' | 'full-access'>
}

/**
 * One app-owned credential, resolved by Electron Main from `safeStorage` for
 * exactly one run. It is held in memory, handed to Pi's `CredentialStore`, and
 * never written to SQLite, the ledger or a log.
 */
export interface AgentRuntimeCredential {
  /** Pi's own provider id, for example `anthropic`. */
  readonly provider: string
  /** Pi's credential shape. Passed through opaquely because OAuth refresh
   * material is provider-specific and re-declaring it would fork Pi's
   * contract. */
  readonly credential: Credential
}

/**
 * Per-invocation runtime scope.
 *
 * `profileDir` is required: it is the app-owned directory handed to Pi as
 * `agentDir` (via `PI_CODING_AGENT_DIR`). The workbench deliberately has no
 * ambient fallback, because doing so would silently reuse login state that
 * lives outside both the app and Main's safeStorage boundary.
 */
export interface AgentRuntimeScope {
  readonly profileDir: string
  readonly credentials?: readonly AgentRuntimeCredential[] | undefined
}

/**
 * The workspace MCP client surface the runtime uses.
 *
 * It is a structural subset of `@modelcontextprotocol/sdk`'s `Client`, so the
 * composition root passes the real client and tests pass a fake without a
 * transport.
 */
export type AgentWorkspaceToolClient = Pick<Client, 'listTools' | 'callTool' | 'close'>

export interface AgentRuntimeRequest {
  readonly prompt: string
  readonly cwd: string
  /** App-owned Pi profile directory. Required; there is no ambient default. */
  readonly profileDir: string
  /** Main-owned credentials for this single run, keyed by Pi provider id. Since
   * the vault is the only source, a run with no credentials can still start and
   * fails later with `AUTH_REQUIRED` instead of silently using `~/.pi`. */
  readonly credentials?: readonly AgentRuntimeCredential[] | undefined
  /** Optional model selector, as `provider/modelId` or a bare model id. */
  readonly model?: string | null | undefined
  /** Optional per-run reasoning/thinking level. */
  readonly thinking?: string | null | undefined
  /** Skill contract text to append to the session's system prompt when the run
   * was launched from a research skill. */
  readonly skillPath?: string | null | undefined
  /** Appended to the session's system prompt. Skill contract text and the
   * workbench tool instructions travel here instead of through Pi's skill
   * loader, so the Agent page keeps owning what the Agent is told. */
  readonly systemPromptAppend?: string | undefined
  /** Pi session JSONL to resume. `null` starts a new session. */
  readonly runtimeSessionId?: string | null | undefined
  /** The Workbench run this request belongs to.
   *
   * Core binds it so a tool call can be attributed to a run without letting the
   * model name one: an external write has to belong to the run that requested
   * it, and a model-supplied owner would be forgeable. */
  readonly runId: string
  readonly toolProfile: AgentToolProfile
  readonly permissionMode?: 'read-only' | 'auto' | 'full-access'
  readonly approvalPolicy?: 'on-request' | 'never'
  readonly timeoutMs?: number | undefined
}

export interface AgentRuntimeEvent {
  readonly externalRunId: string
  readonly kind: 'started' | 'heartbeat' | 'progress' | 'assistant_message' | 'tool_call' | 'completed' | 'failed' | 'canceled'
  readonly payload: unknown
  readonly createdAt: string
  /** Normalized ledger records for this payload. The adapter maps the SDK's
   * own event stream so the renderer never has to guess at provider JSON; an
   * empty or missing list means the payload carried no user-visible record. */
  readonly records?: readonly AgentRunRecordDraft[]
}

export interface AgentRuntimeHandle {
  readonly externalRunId: string
  /** Pi session JSONL this run wrote, so the conversation can continue it. */
  readonly runtimeSessionId: string | null
  readonly events: AsyncIterable<AgentRuntimeEvent>
  cancel(): Promise<void>
}

export interface AgentRuntimeAdapter {
  readonly kind: AgentRuntimeKind
  readonly transport: AgentRuntimeTransport
  capabilities(scope?: AgentRuntimeScope | undefined): Promise<AgentRuntimeCapabilities>
  start(request: AgentRuntimeRequest): Promise<AgentRuntimeHandle>
}

/** One question the login flow needs the user to answer. The host owns prompt
 * correlation ids, which is why the id is minted by the channel rather than
 * here. */
export interface AgentAuthPromptRequest {
  readonly loginId: string
  readonly kind: AgentAuthPromptKind
  readonly message: string
  readonly placeholder: string | null
  readonly options: readonly AgentAuthPromptOption[]
}

/** The login dialog's two directions. `push` is fire-and-forget and must never
 * throw into the SDK's login coroutine; `prompt` publishes a question and
 * resolves with the answer, rejecting when the user cancels the login. */
export interface AgentAuthChannel {
  readonly push: (event: AgentAuthEvent) => void
  readonly prompt: (request: AgentAuthPromptRequest) => Promise<string>
}

/** The write-back half of the credential boundary: Pi talks to a
 * `CredentialStore`, and every mutation is persisted by Electron Main. */
export interface AgentCredentialBridge {
  read(providerId: string): Promise<Credential | null>
  list(): Promise<ReadonlyArray<{ readonly provider: string; readonly credential: Credential }>>
  /** Persist one provider credential. `null` deletes it. Resolves only after
   * Main acknowledged the write, so a run never continues on a credential the
   * vault did not accept. */
  persist(providerId: string, credential: Credential | null): Promise<void>
}

export { EventQueue, isolatedRuntimeEnvironment, labelRuntimeProfileDir } from './support.js'
export { controlledPiResourcePaths, PiInProcessAdapter, type ControlledPiResourcePathInput, type ControlledPiResourcePaths, type PiRuntimeAdapterOptions } from './pi/adapter.js'
export { AppCredentialStore } from './pi/credential-store.js'
export { parseCredential, parseRuntimeCredentials, type CredentialEnvelopeEntry } from './pi/credentials.js'
export {
  PROVIDER_DISCOVERY_MAX_MODELS,
  PROVIDER_DISCOVERY_TIMEOUT_MS,
  ProviderDiscoveryError,
  discoverProviderModels,
  discoveryEndpoint,
  discoveryHeaders,
  type ProviderDiscoveryCode,
  type ProviderDiscoveryOutcome,
  type ProviderDiscoveryRequest
} from './pi/discovery.js'
export {
  ModelSelectionError,
  planModelSelection,
  type ModelSelection
} from './pi/model-selector.js'
export { PiModelCatalog } from './pi/models.js'
export {
  PiModelsFileError,
  piModelsFilePath,
  readPiModelsFile,
  writePiModelsFile,
  type PiModelsFileSnapshot
} from './pi/models-file.js'
export {
  createAuthInteraction,
  preferredSelectAnswer,
  toAgentAuthEvent,
  type LoginMethodOption
} from './pi/auth-flow.js'
export { PiLedgerNormalizer, type PiLedgerNormalizerOptions } from './ledger/pi.js'
export { BaseLedgerNormalizer, ledgerUsage } from './ledger/types.js'
export type { LedgerNormalizer, LedgerStatus } from './ledger/types.js'
export {
  agentToolLabels,
  agentToolName,
  agentToolNamePattern,
  agentToolNames,
  allowsWorkspaceWrites,
  effectivePermissionMode,
  isBlockedWorkspaceTool,
  normalizeToolParametersSchema,
  promptSnippet,
  selectWorkspaceTools,
  toToolParameters,
  workspaceBlockedToolPatterns,
  workspaceExternalRequestTools,
  workspaceReadTools,
  workspaceToolAllowlist,
  workspaceWriteTools,
  type WorkspaceToolDescriptor,
  type WorkspaceToolPolicyInput
} from './pi/tools.js'
