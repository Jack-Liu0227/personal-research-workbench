import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getSupportedThinkingLevels, type Api, type Credential, type Model } from '@earendil-works/pi-ai'
import type * as Pi from '@earendil-works/pi-coding-agent'
import type { AgentRunRecordDraft, AgentRuntimeKind, AgentRuntimeTransport } from '@prw/contracts'
import type {
  AgentRuntimeAdapter,
  AgentRuntimeCapabilities,
  AgentRuntimeEvent,
  AgentRuntimeHandle,
  AgentRuntimeRequest,
  AgentRuntimeScope,
  AgentWorkspaceToolClient
} from '../index.js'
import { PiLedgerNormalizer } from '../ledger/pi.js'
import type { LedgerStatus } from '../ledger/types.js'
import { EventQueue, labelRuntimeProfileDir } from '../support.js'
import { AppCredentialStore } from './credential-store.js'
import { createWorkspaceExtension } from './extension.js'
import { loadPiSdk, loadTypebox, type PiSdk } from './loader.js'
import { ModelSelectionError, planModelSelection } from './model-selector.js'
import { agentToolLabels, effectivePermissionMode, selectWorkspaceTools, type WorkspaceToolDescriptor } from './tools.js'

/**
 * Built-in tools the embedded Agent never gets.
 *
 * The workbench Agent writes *records*, not files, and it runs inside the
 * user's own app process. Handing it a shell or an editor would turn a research
 * assistant into an unattended remote code execution path over whatever the
 * model provider sends back. The denylist is applied together with
 * `noTools: 'builtin'` so a Pi release that adds a new built-in tool still
 * cannot reach the file system.
 */
const deniedBuiltinTools: readonly string[] = ['bash', 'powershell', 'edit', 'write', 'read', 'grep', 'find', 'ls']

/** Mirrors Pi's `ThinkingLevel` union, which the coding-agent package does not
 * re-export. Declaring it locally keeps `@earendil-works/pi-agent-core` out of
 * this package's dependencies for a string literal union. */
const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
type ThinkingLevel = (typeof thinkingLevels)[number]

export interface PiRuntimeAdapterOptions {
  /** Open the workbench MCP client for exactly one run. The adapter closes it
   * when the run settles, so a run cannot leak a transport. The run id is handed
   * over so every tool call the session makes is attributable to this run. */
  readonly openWorkspaceClient: (context: { readonly runId: string }) => Promise<AgentWorkspaceToolClient>
  /** Persist one provider credential through Electron Main. Resolves only after
   * Main acknowledged the write. */
  readonly persistCredential: (providerId: string, credential: Credential | null) => Promise<void>
  /** Wall-clock ceiling for one run. */
  readonly timeoutMs?: number
}

/**
 * The embedded Pi Agent.
 *
 * The adapter owns everything that used to be a CLI invocation: it creates the
 * session, subscribes to the SDK's event stream, maps those events onto ledger
 * records, and reports the session file so the next turn can continue the same
 * conversation.
 *
 * Three decisions shape the code below.
 *
 * Built-in tools are disabled with `noTools: 'builtin'` rather than filtered
 * with `tools: [...]`. Pi's own SDK documentation is explicit that a `tools`
 * allowlist also narrows extension tools, which would silently strip the
 * workbench record tools this whole step exists to provide. `excludeTools` is
 * the denylist that then removes the built-ins explicitly.
 *
 * The tool list is fetched before the session is created, because a resource
 * loader factory that resolves asynchronously would register tools after the
 * session snapshot was taken.
 *
 * Resource loading is bounded explicitly. Pi receives only a selected,
 * coordinator-validated skill directory and app-owned extension roots; prompt
 * templates and context files stay disabled. It never picks up resources from a
 * user's personal Pi CLI profile.
 */
export class PiInProcessAdapter implements AgentRuntimeAdapter {
  readonly kind: AgentRuntimeKind = 'pi'
  readonly transport: AgentRuntimeTransport = 'inprocess'

  constructor(private readonly options: PiRuntimeAdapterOptions) {}

  async capabilities(scope?: AgentRuntimeScope | undefined): Promise<AgentRuntimeCapabilities> {
    const profileDir = scope?.profileDir ?? process.env['PI_CODING_AGENT_DIR'] ?? ''
    if (profileDir.length === 0) {
      return {
        kind: 'pi',
        transport: 'inprocess',
        available: false,
        version: null,
        mcp: false,
        structuredOutput: false,
        workspaceWrite: false,
        message: 'Agent 运行时尚未初始化：缺少应用自有的 profile 目录。',
        authReady: false,
        authSource: 'none',
        profileSource: 'unspecified',
        profileLabel: null,
        approvalChannel: 'none',
        modelOptions: [],
        thinkingOptions: []
      }
    }
    try {
      const sdk = await loadPiSdk(profileDir)
      const credentials = scope?.credentials ?? []
      const models = await this.describeModels(sdk, credentials)
      return {
        kind: 'pi',
        transport: 'inprocess',
        available: true,
        version: sdk.VERSION,
        mcp: true,
        structuredOutput: true,
        // Whether a *run* may write is a policy decision taken per run; the
        // capability reports what the runtime can do.
        workspaceWrite: true,
        message: `内置 Pi ${sdk.VERSION}，进程内运行；工作台工具通过进程内 MCP 直连，无需子进程。`,
        authReady: credentials.length > 0,
        authSource: credentials.length > 0 ? 'app-safeStorage' : 'none',
        profileSource: 'app-isolated',
        profileLabel: labelRuntimeProfileDir(profileDir),
        approvalChannel: 'none',
        modelOptions: models.map((entry) => entry.id),
        thinkingOptions: models[0]?.thinkingLevels ?? []
      }
    } catch (error) {
      return {
        kind: 'pi',
        transport: 'inprocess',
        available: false,
        version: null,
        mcp: false,
        structuredOutput: false,
        workspaceWrite: false,
        message: `Agent 运行时加载失败：${describeError(error)}`,
        authReady: false,
        authSource: 'none',
        profileSource: 'app-isolated',
        profileLabel: labelRuntimeProfileDir(profileDir),
        approvalChannel: 'none',
        modelOptions: [],
        thinkingOptions: []
      }
    }
  }

  async start(request: AgentRuntimeRequest): Promise<AgentRuntimeHandle> {
    const sdk = await loadPiSdk(request.profileDir)
    sdk.initTheme()
    const typebox = await loadTypebox()
    const externalRunId = randomUUID()
    const queue = new EventQueue<AgentRuntimeEvent>()
    // Replaced once the tool list is known, so early diagnostics still work.
    let normalizer = new PiLedgerNormalizer()
    const startedAt = Date.now()

    const cwd = request.cwd
    const sessionDir = join(request.profileDir, 'sessions')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(request.profileDir, { recursive: true })
    mkdirSync(sessionDir, { recursive: true })

    const client = await this.options.openWorkspaceClient({ runId: request.runId })
    const closeClient = async (): Promise<void> => {
      try {
        await client.close()
      } catch {
        // A transport that already failed to close must not mask the run result.
      }
    }

    const emit = (
      payload: unknown,
      createdAt: string,
      kind: AgentRuntimeEvent['kind'],
      records: readonly AgentRunRecordDraft[]
    ): void => {
      queue.push({ externalRunId, kind, payload, createdAt, records })
    }
    const diagnose = (text: string): void => {
      const createdAt = new Date().toISOString()
      emit({ message: text }, createdAt, 'progress', normalizer.diagnostic(text, createdAt))
    }

    let cancelRequested = false
    let settled = false

    try {
      const { tools, blocked } = await this.workspaceTools(client, request)
      normalizer = new PiLedgerNormalizer({ toolLabels: agentToolLabels(tools.map((tool) => tool.name)) })
      const sessionManager = this.createSessionManager(sdk, request, sessionDir, cwd)
      const settingsManager = sdk.SettingsManager.create(cwd, request.profileDir, { projectTrusted: true })
      const modelRuntime = await sdk.ModelRuntime.create({
        credentials: new AppCredentialStore({
          read: async (providerId) => this.seedCredential(request, providerId),
          list: async () =>
            (request.credentials ?? []).map((entry) => ({ provider: entry.provider, credential: entry.credential })),
          persist: (providerId, credential) => this.options.persistCredential(providerId, credential)
        }),
        // The profile directory is app-owned and starts empty, so there is no
        // cached catalog to restore and no reason to hit the network while
        // creating a runtime for a single run.
        refreshOnCreate: false
      })
      const model = await this.resolveModel(modelRuntime, request)

      const resourcePaths = controlledPiResourcePaths()
      const selectedSkillPath = request.skillPath?.trim() ?? ''
      const selectedSkillRoot = selectedSkillPath.length > 0 && existsSync(selectedSkillPath) ? dirname(selectedSkillPath) : null
      const skillPaths = selectedSkillRoot === null ? [] : [selectedSkillRoot]
      const services = await sdk.createAgentSessionServices({
        cwd,
        agentDir: request.profileDir,
        settingsManager,
        modelRuntime,
        resourceLoaderOptions: {
          // Pi's default loader must not walk the user's ~/.pi or arbitrary
          // cwd ancestors. These explicit roots are app-owned: checkout skills
          // in development, and the electron-builder mirror in packaged mode.
          ...(skillPaths.length > 0 ? { additionalSkillPaths: skillPaths } : {}),
          ...(resourcePaths.extensionPaths.length > 0 ? { additionalExtensionPaths: [...resourcePaths.extensionPaths] } : {}),
          // Avoid scanning every app skill on ordinary chat runs. A selected
          // skill is passed explicitly by the coordinator and loaded from its
          // validated directory only.
          noSkills: skillPaths.length === 0,
          noExtensions: resourcePaths.extensionPaths.length === 0,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          extensionFactories: [
            createWorkspaceExtension({
              typebox,
              client,
              tools,
              onToolError: (toolName, message) => diagnose(`工具 ${toolName} 调用失败：${message}`)
            })
          ],
          ...(request.systemPromptAppend ? { appendSystemPrompt: [request.systemPromptAppend] } : {})
        }
      })

      const { session } = await sdk.createAgentSessionFromServices({
        services,
        sessionManager,
        noTools: 'builtin',
        excludeTools: [...deniedBuiltinTools, ...blocked],
        ...(model ? { model } : {}),
        ...(thinkingLevel(request.thinking) ? { thinkingLevel: thinkingLevel(request.thinking) as ThinkingLevel } : {})
      })

      for (const diagnostic of services.diagnostics) {
        diagnose(`[${diagnostic.type}] ${diagnostic.message}`)
      }
      if (!session.model) {
        diagnose('没有可用的模型：请先在设置中配置模型凭据，然后重新发送。')
      }

      const unsubscribe = session.subscribe((event) => {
        const createdAt = new Date().toISOString()
        emit(event, createdAt, eventKind(event), normalizer.accept(event, createdAt))
      })

      const timeout = setTimeout(() => {
        cancelRequested = true
        diagnose(`运行超过 ${formatMinutes(request.timeoutMs ?? this.options.timeoutMs ?? defaultTimeoutMs)}，已请求取消。`)
        void session.abort()
      }, request.timeoutMs ?? this.options.timeoutMs ?? defaultTimeoutMs)

      const finish = async (status: LedgerStatus, errorMessage?: string): Promise<void> => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        unsubscribe()
        const createdAt = new Date().toISOString()
        if (errorMessage) emit({ message: errorMessage }, createdAt, 'progress', normalizer.diagnostic(errorMessage, createdAt))
        const remaining = normalizer.finish(status, createdAt)
        const kind: AgentRuntimeEvent['kind'] =
          status === 'completed' ? 'completed' : status === 'canceled' ? 'canceled' : 'failed'
        emit({ status, durationMs: Date.now() - startedAt }, createdAt, kind, remaining)
        await closeClient()
        queue.end()
      }

      // `prompt()` resolves when the run reaches a resting state, so it is the
      // terminal signal for the run rather than one more event to forward.
      void session.prompt(request.prompt).then(
        async () => {
          if (cancelRequested) {
            await finish('canceled')
            return
          }
          const failure = lastAssistantError(session.messages)
          if (failure) await finish('failed', failure)
          else await finish('completed')
        },
        async (error: unknown) => {
          await finish(cancelRequested ? 'canceled' : 'failed', describeError(error))
        }
      )

      return {
        externalRunId,
        runtimeSessionId: session.sessionFile ?? null,
        events: queue.iterate(),
        cancel: async (): Promise<void> => {
          cancelRequested = true
          await session.abort()
          await finish('canceled')
        }
      }
    } catch (error) {
      await closeClient()
      queue.end()
      throw error
    }
  }

  private seedCredential(request: AgentRuntimeRequest, providerId: string): Promise<Credential | null> {
    const match = (request.credentials ?? []).find((entry) => entry.provider === providerId)
    return Promise.resolve(match ? match.credential : null)
  }

  private createSessionManager(sdk: PiSdk, request: AgentRuntimeRequest, sessionDir: string, cwd: string): Pi.SessionManager {
    const previous = request.runtimeSessionId
    if (previous && previous.trim().length > 0) {
      try {
        return sdk.SessionManager.open(previous, sessionDir, cwd)
      } catch {
        // A transcript that was pruned or written by an older layout must not
        // fail the run. The conversation itself lives in SQLite, so the new turn
        // simply starts a fresh transcript file.
      }
    }
    return sdk.SessionManager.create(cwd, sessionDir)
  }

  /**
   * Resolve the model this run must use.
   *
   * A selector the settings UI stored names an exact `provider/modelId` pair,
   * and it is resolved as exactly that: when the provider is configured but does
   * not offer the model, the run fails with `ModelSelectionError` instead of
   * quietly streaming from a different model. Silently substituting a model is
   * the worse failure — the run looks successful and the answer comes from
   * something the user never chose.
   *
   * Two cases keep the tolerant path: a bare model id (a hand-edited value from
   * before the pair was stored) is matched by id against the catalog, and no
   * selector at all means nothing was chosen, so the first model the
   * credentials can actually call is the right answer.
   */
  private async resolveModel(modelRuntime: Pi.ModelRuntime, request: AgentRuntimeRequest): Promise<Model<Api> | undefined> {
    const selection = planModelSelection(
      request.model,
      modelRuntime.getProviders().map((entry) => entry.id)
    )
    if (selection.kind === 'exact') {
      const exact = modelRuntime.getModel(selection.provider, selection.modelId)
      if (exact) return exact as Model<Api>
      throw new ModelSelectionError(selection.provider, selection.modelId)
    }
    if (selection.kind === 'bare') {
      const bare = modelRuntime.getModels().find((candidate) => candidate.id === selection.modelId)
      if (bare) return bare as Model<Api>
    }
    const available = await modelRuntime.getAvailable()
    return available[0] ?? modelRuntime.getModels()[0]
  }

  private async describeModels(
    sdk: PiSdk,
    credentials: readonly { provider: string }[]
  ): Promise<Array<{ id: string; thinkingLevels: string[] }>> {
    if (credentials.length === 0) return []
    const configured = new Set(credentials.map((entry) => entry.provider))
    try {
      const runtime = await sdk.ModelRuntime.create({ refreshOnCreate: false })
      return runtime
        .getModels()
        .filter((model) => configured.has(model.provider))
        .map((model) => ({ id: `${model.provider}/${model.id}`, thinkingLevels: [...getSupportedThinkingLevels(model)] }))
    } catch {
      return []
    }
  }

  /** Fetch the workbench tool list once and decide what this run may call. */
  private async workspaceTools(
    client: AgentWorkspaceToolClient,
    request: AgentRuntimeRequest
  ): Promise<{ tools: WorkspaceToolDescriptor[]; blocked: string[] }> {
    const policy = { permissionMode: effectivePermissionMode(request), toolProfile: request.toolProfile }
    const listed = await client.listTools()
    const advertised: WorkspaceToolDescriptor[] = listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
    const tools = selectWorkspaceTools(advertised, policy)
    const allowed = new Set(tools.map((tool) => tool.name))
    // The rejected names go into `excludeTools` as well: an extension tool that
    // is never registered cannot be called, and naming it twice means a future
    // server cannot widen the Agent's reach by adding a tool the policy did not
    // approve.
    return { tools, blocked: advertised.map((tool) => tool.name).filter((name) => !allowed.has(name)) }
  }
}

export interface ControlledPiResourcePaths {
  readonly skillPaths: readonly string[]
  readonly extensionPaths: readonly string[]
}

export interface ControlledPiResourcePathInput {
  readonly projectRoot?: string | undefined
  readonly packagedApp?: boolean | undefined
  readonly resourcesPath?: string | undefined
  readonly exists?: ((path: string) => boolean) | undefined
}

/**
 * Return only Workbench-owned Pi resource roots. The default Pi loader is
 * intentionally not used for this lookup: reading ~/.pi would reuse a user's
 * personal skills/extensions and would make packaged profile isolation false.
 */
export function controlledPiResourcePaths(input: ControlledPiResourcePathInput = {}): ControlledPiResourcePaths {
  const packaged = input.packagedApp ?? process.env['PRW_PACKAGED_APP'] === '1'
  const projectRoot = input.projectRoot?.trim() ?? process.env['PRW_PROJECT_ROOT']?.trim() ?? ''
  const resourcesPath = input.resourcesPath?.trim() ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath?.trim() ?? ''
  const exists = input.exists ?? existsSync
  const roots = packaged
    ? (resourcesPath.length > 0 ? [join(resourcesPath, 'skills')] : [])
    : (projectRoot.length > 0 ? [join(projectRoot, '.agents', 'skills')] : [])
  const extensionRoots = packaged
    ? (resourcesPath.length > 0 ? [join(resourcesPath, 'extensions')] : [])
    : (projectRoot.length > 0 ? [join(projectRoot, '.pi', 'extensions')] : [])
  return {
    skillPaths: roots.filter((path) => exists(path)),
    extensionPaths: extensionRoots.filter((path) => exists(path))
  }
}

const defaultTimeoutMs = 15 * 60_000

function thinkingLevel(value: string | null | undefined): ThinkingLevel | null {
  const normalized = value?.trim().toLowerCase() ?? ''
  const match = thinkingLevels.find((level) => level === normalized)
  return match ?? null
}

function lastAssistantError(messages: readonly unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === null || typeof message !== 'object') continue
    const candidate = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown }
    if (candidate.role !== 'assistant') continue
    if (candidate.stopReason === 'error') {
      return typeof candidate.errorMessage === 'string' ? candidate.errorMessage : '模型返回错误，本次运行未完成。'
    }
    return null
  }
  return null
}

/** Map an SDK event onto the transport-level event kind. The ledger records
 * carry everything the UI shows; this kind exists so a caller can follow run
 * progress without understanding Pi's event union. */
function eventKind(event: Pi.AgentSessionEvent): AgentRuntimeEvent['kind'] {
  switch (event.type) {
    case 'agent_start':
      return 'started'
    case 'tool_execution_start':
    case 'tool_execution_end':
      return 'tool_call'
    case 'message_end':
      return 'assistant_message'
    case 'agent_end':
    case 'agent_settled':
      return 'progress'
    case 'turn_start':
    case 'turn_end':
    case 'message_start':
    case 'message_update':
    case 'tool_execution_update':
      return 'progress'
    default:
      return 'heartbeat'
  }
}

function formatMinutes(milliseconds: number): string {
  return `${Math.round(milliseconds / 60_000)} 分钟`
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : JSON.stringify(error)
}
