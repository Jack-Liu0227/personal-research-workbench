import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { AgentRunRecordDraft, AgentRuntimeKind, AgentRuntimeTransport, AgentToolProfile } from '@prw/contracts'
import { createLedgerNormalizer } from './ledger/index.js'

export interface AgentRuntimeCapabilities {
  readonly kind: AgentRuntimeKind
  readonly transport: AgentRuntimeTransport
  readonly available: boolean
  readonly version: string | null
  readonly mcp: boolean
  readonly structuredOutput: boolean
  readonly workspaceWrite: boolean
  readonly message: string
  /** Whether this runtime has a usable credential source at all. It is a
   * configuration fact, not a model-call validation: `app-safeStorage` means a
   * credential was fetched from Electron Main's vault for this probe, and
   * `cli-login` means the app-owned profile contains a login the CLI itself
   * created. PRW never opens or copies an auth file to answer this. */
  readonly authReady?: boolean
  readonly authSource?: 'app-safeStorage' | 'cli-login' | 'none'
  /** Where the CLI profile comes from. Always `app-isolated` in the desktop
   * app: `~/.codex` and `~/.pi` are never read, forwarded or reused. */
  readonly profileSource?: 'app-isolated' | 'unspecified'
  /** Redaction-safe label of the profile directory. */
  readonly profileLabel?: string | null
  /** Both supported CLIs execute as non-interactive batch processes, so an
   * `on-request` policy has no channel to prompt on. */
  readonly approvalChannel?: 'none' | 'interactive'
  readonly localDefaultModel?: string | null
  readonly localThinkingLevel?: string | null
  readonly localPermission?: string | null
  readonly modelOptions?: string[]
  readonly thinkingOptions?: string[]
  readonly permissionOptions?: Array<'read-only' | 'auto' | 'full-access'>
}

/**
 * App-owned runtime credential, resolved by Electron Main from `safeStorage`
 * for exactly one probe or one run. It is injected into a single child process
 * environment and is never written to SQLite, the ledger or a log.
 */
export interface AgentRuntimeCredential {
  readonly provider: string
  /** Documented CLI environment variable (see the contract catalog). */
  readonly envVar: string
  readonly secret: string
}

/**
 * Per-invocation runtime scope.
 *
 * `profileDir` is required: it is the app-owned directory passed to the CLI as
 * `CODEX_HOME` / `PI_CODING_AGENT_DIR`. The workbench deliberately does not
 * fall back to the user's personal CLI directories, because doing so would
 * silently reuse login state that lives outside both the app and Main's
 * safeStorage boundary.
 */
export interface AgentRuntimeScope {
  readonly profileDir: string
  readonly credential?: AgentRuntimeCredential | null | undefined
}

export interface AgentRuntimeRequest {
  readonly prompt: string
  readonly cwd: string
  /** App-owned CLI profile directory. Required; there is no ambient default. */
  readonly profileDir: string
  /** Main-owned credential for this single run. */
  readonly credential?: AgentRuntimeCredential | null | undefined
  /** Optional model selector from the persisted Agent conversation. */
  readonly model?: string | null | undefined
  /** Optional per-run reasoning/thinking level. */
  readonly thinking?: string | null | undefined
  readonly executablePath?: string | undefined
  readonly env?: Record<string, string | undefined> | undefined
  readonly mcpConfigPath?: string | undefined
  /** Optional project-pinned skill file. Pi receives this through --skill;
   * Codex is instructed to read it from the prompt without copying secrets. */
  readonly skillPath?: string | undefined
  /** Set when the run executes a project-pinned skill that spawns its own
   * local engine. Skill runs are additionally capped at the workspace-write
   * profile (never `danger-full-access`) because the engine writes evidence
   * into the isolated run directory and needs outbound network access. */
  readonly skillExecution?: { readonly key: string; readonly saveDir: string } | undefined
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
  /** Normalized ledger records for this payload. The adapter parses the CLI's
   * own stream so the renderer never has to guess at provider JSON; an empty or
   * missing list means the payload carried no user-visible record. */
  readonly records?: readonly AgentRunRecordDraft[]
}

export interface AgentRuntimeHandle {
  readonly externalRunId: string
  readonly events: AsyncIterable<AgentRuntimeEvent>
  cancel(): Promise<void>
}

export interface AgentRuntimeAdapter {
  readonly kind: AgentRuntimeKind
  readonly transport: AgentRuntimeTransport
  capabilities(executablePath?: string | undefined, scope?: AgentRuntimeScope | undefined): Promise<AgentRuntimeCapabilities>
  start(request: AgentRuntimeRequest): Promise<AgentRuntimeHandle>
}

type RuntimeCommand = {
  readonly executable: string
  readonly args: string[]
}

class EventQueue<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  end(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true })
  }

  async *iterate(): AsyncIterable<T> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift() as T
        continue
      }
      if (this.closed) return
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve))
      if (next.done) return
      yield next.value
    }
  }
}

abstract class CliRuntimeAdapter implements AgentRuntimeAdapter {
  abstract readonly kind: AgentRuntimeKind
  readonly transport: AgentRuntimeTransport = 'cli'

  protected abstract command(request: AgentRuntimeRequest): RuntimeCommand

  async capabilities(executablePath?: string, scope?: AgentRuntimeScope): Promise<AgentRuntimeCapabilities> {
    const executable = executablePath?.trim() || this.defaultExecutable()
    const profileDir = scope?.profileDir?.trim() ?? ''
    // Fail closed: without an app-owned profile directory there is nothing to
    // probe with, and falling back to `~/.pi`/`~/.codex` would reintroduce the
    // credential reuse this boundary exists to prevent.
    if (profileDir.length === 0) {
      return {
        kind: this.kind,
        transport: this.transport,
        available: false,
        version: null,
        mcp: true,
        structuredOutput: true,
        workspaceWrite: true,
        message: '工作台的 runtime 隔离 profile 目录未配置，已按不可用处理。',
        authReady: false,
        authSource: 'none',
        profileSource: 'unspecified',
        profileLabel: null,
        approvalChannel: 'none',
        localDefaultModel: null,
        localThinkingLevel: null,
        localPermission: null,
        modelOptions: [],
        thinkingOptions: [],
        permissionOptions: []
      }
    }
    const credential = scope?.credential ?? null
    const profile = detectIsolatedProfile(this.kind, profileDir)
    const versionProbe = executable
      ? runRuntimeProbe(resolveRuntimeCommand({ executable, args: ['--version'] }), 5_000, this.kind, this.environment(profileDir, credential))
      : Promise.resolve(null)
    // These probes are independent. Using async child processes matters here:
    // Promise.all cannot make spawnSync calls concurrent on the Core event loop.
    const modelOptionsPromise = executable
      ? discoverModelOptions(this.kind, executable, profile, profileDir, credential)
      : Promise.resolve(profile?.model ? [profile.model] : [])
    const authPromise = executable
      ? probeRuntimeAuthentication(this.kind, executable, profile, profileDir, credential)
      : Promise.resolve({ ready: false, source: 'none' as const, message: 'CLI executable is unavailable, so no credential source could be checked' })
    const permissionPromise = executable
      ? detectPermissionOptions(this.kind, executable, this.environment(profileDir, credential))
      : Promise.resolve([] as Array<'read-only' | 'auto' | 'full-access'>)
    const [versionResult, modelOptions, auth, permissionOptions] = await Promise.all([versionProbe, modelOptionsPromise, authPromise, permissionPromise])
    const available = versionResult?.status === 0
    const output = versionResult ? `${versionResult.stdout}\n${versionResult.stderr}` : ''
    const firstLine = output.trim().split(/\r?\n/u)[0]
    const version = firstLine ? firstLine.slice(0, 200) : null
    const authSource = credential ? 'app-safeStorage' : auth.source
    return {
      kind: this.kind,
      transport: this.transport,
      available,
      version,
      mcp: true,
      structuredOutput: true,
      workspaceWrite: true,
      message: available
        ? `runtime executable is available${profile ? ` · ${profile.summary}` : ''} · ${auth.message}`
        : 'runtime executable is not available',
      authReady: available ? (authSource === 'none' ? false : auth.ready || authSource === 'app-safeStorage') : false,
      authSource,
      profileSource: 'app-isolated',
      profileLabel: labelRuntimeProfileDir(profileDir),
      approvalChannel: 'none',
      localDefaultModel: profile?.model ?? null,
      localThinkingLevel: profile?.thinking ?? null,
      localPermission: profile?.permission ?? null,
      modelOptions,
      thinkingOptions: [...new Set([
        ...(this.kind === 'pi' ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : ['minimal', 'low', 'medium', 'high', 'xhigh']),
        ...(profile?.thinking ? [profile.thinking] : [])
      ])],
      permissionOptions: available ? permissionOptions : []
    }
  }

  /** The only environment a CLI child process ever sees: the app-owned profile
   * directory plus, for one invocation, the Main-owned credential. */
  protected environment(profileDir: string, credential?: AgentRuntimeCredential | null): Record<string, string> {
    return {
      ...isolatedRuntimeEnvironment(this.kind, profileDir),
      ...(credential ? { [credential.envVar]: credential.secret } : {})
    }
  }

  async start(request: AgentRuntimeRequest): Promise<AgentRuntimeHandle> {
    const externalRunId = randomUUID()
    const profileDir = request.profileDir?.trim() ?? ''
    if (profileDir.length === 0) {
      const error = new Error('This runtime has no app-owned profile directory, so no credential boundary can be enforced.')
      error.name = 'RUNTIME_PROFILE_UNAVAILABLE'
      throw error
    }
    const queue = new EventQueue<AgentRuntimeEvent>()
    const command = resolveRuntimeCommand(this.command(request))
    const timeoutMs = request.timeoutMs ?? 15 * 60_000
    const child = spawn(command.executable, command.args, {
      cwd: request.cwd,
      shell: false,
      windowsHide: true,
      // The app owns the CLI profile and supplies the credential itself. The
      // user's `~/.codex`/`~/.pi` login is neither read nor forwarded, and no
      // ambient API key from Electron's environment reaches this child.
      env: safeChildEnvironment({
        ...request.env,
        ...this.environment(profileDir, request.credential)
      })
    })
    let settled = false
    let authStopping = false
    let diagnostic = ''
    let timeout: ReturnType<typeof setTimeout> | undefined
    const startedAt = new Date().toISOString()
    const ledger = createLedgerNormalizer(this.kind)
    queue.push({ externalRunId, kind: 'started', payload: { command: this.kind }, createdAt: startedAt })

    const finish = (kind: AgentRuntimeEvent['kind'], payload: unknown): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      const createdAt = new Date().toISOString()
      const records = ledger.finish(kind === 'completed' ? 'completed' : kind === 'canceled' ? 'canceled' : 'failed', createdAt)
      queue.push({ externalRunId, kind, payload, createdAt, ...(records.length > 0 ? { records } : {}) })
      queue.end()
    }

    const parseLine = (line: string): void => {
      const isStderr = line.startsWith('[stderr] ')
      const trimmed = line.trim()
      if (!trimmed) return
      let payload: unknown = trimmed
      try { payload = JSON.parse(trimmed) as unknown } catch { /* plain text is valid CLI output */ }
      // Avoid waiting through a CLI's reconnect loop when its isolated run
      // profile has no credential. The raw provider response is deliberately
      // not forwarded to the renderer or persisted as assistant content.
      if (!authStopping && isAuthenticationFailure(payload)) {
        authStopping = true
        void terminateProcess(child).then(() => finish('failed', {
          code: 'AUTH_REQUIRED',
          message: '当前 Agent runtime 尚未配置工作台凭据。请在设置中完成安全凭据配置后重试。'
        }))
        return
      }
      const createdAt = new Date().toISOString()
      // CLI diagnostics (MCP auth notices, skill warnings, reconnect details)
      // never belong to the assistant transcript, but dropping them entirely
      // used to leave a failed run with only a generic message. They are now
      // ledger records (redacted and clipped when persisted) so the trajectory
      // can show the CLI's own reason.
      if (isStderr) {
        diagnostic = `${diagnostic} ${trimmed}`.trim().slice(-2_000)
        const records = ledger.diagnostic(trimmed, createdAt)
        queue.push({ externalRunId, kind: 'progress', payload: { stderr: trimmed }, createdAt, ...(records.length > 0 ? { records } : {}) })
        return
      }
      const records = ledger.accept(payload, createdAt)
      queue.push({
        externalRunId,
        kind: classifyPayload(payload),
        payload,
        createdAt,
        ...(records.length > 0 ? { records } : {})
      })
    }
    createInterface({ input: child.stdout }).on('line', parseLine)
    createInterface({ input: child.stderr }).on('line', (line) => parseLine(`[stderr] ${line}`))
    // Both supported CLIs accept `-`/stdin in non-interactive mode. Keeping
    // the prompt on stdin avoids Windows command-line length limits and shell
    // metacharacter handling while preserving the exact user instructions.
    child.stdin.end(request.prompt)
    child.once('error', (error) => finish('failed', { message: safeError(error) }))
    child.once('close', (code, signal) => {
      if (settled) return
      if (authStopping) finish('failed', {
        code: 'AUTH_REQUIRED',
        message: '当前 Agent runtime 尚未配置工作台凭据。请在设置中完成安全凭据配置后重试。'
      })
      else if (code === 0) finish('completed', { code, signal })
      else finish('failed', { code, signal, message: runtimeFailureMessage(diagnostic) })
    })
    timeout = setTimeout(() => {
      void terminateProcess(child)
      finish('failed', { message: 'runtime timed out' })
    }, timeoutMs)
    timeout.unref()

    return {
      externalRunId,
      events: queue.iterate(),
      cancel: async () => {
        if (settled) return
        await terminateProcess(child)
        finish('canceled', { message: 'runtime canceled' })
      }
    }
  }

  protected abstract defaultExecutable(): string | undefined
}

type RuntimeProbeResult = { status: number | null; stdout: string; stderr: string }

function runRuntimeProbe(
  command: RuntimeCommand,
  timeoutMs: number,
  kind: AgentRuntimeKind,
  environment: Record<string, string> = {}
): Promise<RuntimeProbeResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: RuntimeProbeResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    try {
      const child = spawn(command.executable, command.args, {
        windowsHide: true,
        shell: false,
        env: safeChildEnvironment(environment)
      })
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8').slice(0, 50_000 - stdout.length) })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8').slice(0, 50_000 - stderr.length) })
      child.once('error', () => finish({ status: null, stdout, stderr }))
      child.once('close', (status) => finish({ status, stdout, stderr }))
      timer = setTimeout(() => {
        child.kill()
        finish({ status: null, stdout, stderr: `${stderr}\nprobe timed out` })
      }, timeoutMs)
      timer.unref()
    } catch {
      finish({ status: null, stdout, stderr })
    }
  })
}

async function detectPermissionOptions(
  kind: AgentRuntimeKind,
  executable: string,
  environment: Record<string, string> = {}
): Promise<Array<'read-only' | 'auto' | 'full-access'>> {
  try {
    const result = await runRuntimeProbe(resolveRuntimeCommand({ executable, args: ['--help'] }), 5_000, kind, environment)
    if (result.status !== 0) return []
    const help = `${result.stdout}\n${result.stderr}`.toLocaleLowerCase()
    const options: Array<'read-only' | 'auto' | 'full-access'> = ['read-only']
    if (kind === 'codex') {
      if (/approve|approval|full-auto|auto[- ]?approve/iu.test(help)) options.push('auto')
      if (/dangerously-bypass|full-access|sandbox/iu.test(help)) options.push('full-access')
    } else if (/approve|approval|yolo|trust-all-tools|allow-all/iu.test(help)) {
      options.push('auto')
      if (/yolo|trust-all-tools|allow-all/iu.test(help)) options.push('full-access')
    }
    return [...new Set(options)]
  } catch {
    return []
  }
}

function runtimeFailureMessage(diagnostic: string): string {
  const value = diagnostic.toLocaleLowerCase()
  if (/unexpected argument|unknown argument|invalid argument/iu.test(value)) return 'Agent runtime 拒绝了当前 CLI 参数，请在设置中重新探测 runtime。'
  if (/config|toml|override/iu.test(value)) return 'Agent runtime 配置无效，请检查 CLI 配置文件后重试。'
  if (/trusted directory|trust/iu.test(value)) return 'Agent runtime 工作目录未被信任，请重新探测或选择有效工作目录。'
  if (/not found|enoent|cannot spawn/iu.test(value)) return 'Agent runtime 可执行文件不可用，请在设置中检查路径。'
  return 'Agent runtime 执行失败，请检查设置中的 runtime 配置。'
}

/** Read only the non-secret defaults of the *app-owned* CLI profile. The
 * user's `~/.pi`/`~/.codex` files are intentionally never opened: the workbench
 * does not manage those profiles and must not reuse their login state.
 */
type LocalRuntimeProfile = {
  summary: string
  model: string | null
  thinking: string | null
  permission: string | null
  provider: string | null
  rawModel: string | null
}

function detectIsolatedProfile(kind: AgentRuntimeKind, profileDir: string): LocalRuntimeProfile | null {
  if (kind === 'pi') {
    const settingsPath = join(profileDir, 'settings.json')
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
      const provider = typeof settings.defaultProvider === 'string' ? settings.defaultProvider : null
      const model = typeof settings.defaultModel === 'string' ? settings.defaultModel : null
      const thinking = typeof settings.defaultThinkingLevel === 'string' ? settings.defaultThinkingLevel : null
      const trust = typeof settings.defaultProjectTrust === 'string' ? settings.defaultProjectTrust : null
      const summary = [provider ? `provider ${provider}` : null, model ? `model ${model}` : null, thinking ? `thinking ${thinking}` : null].filter((value): value is string => Boolean(value)).join(', ')
      // Pi's CLI selector is provider-qualified. Keep the provider prefix in
      // the ephemeral model hint so a run uses the same model as the app-owned
      // profile even when another provider exposes an identically named model.
      const selectedModel = provider && model ? `${provider}/${model}` : model
      return {
        summary: summary ? `app profile defaults: ${summary}` : 'model/thinking follow the app-owned Pi profile',
        model: selectedModel,
        thinking,
        permission: trust,
        provider,
        rawModel: model
      }
    } catch {
      return null
    }
  }
  const configPath = join(profileDir, 'config.toml')
  try {
    const config = readFileSync(configPath, 'utf8')
    const model = config.match(/^\s*model\s*=\s*"([^"]+)"/mu)?.[1]
    const reasoning = config.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/mu)?.[1]
    const permission = config.match(/^\s*approvals_reviewer\s*=\s*"([^"]+)"/mu)?.[1]
    return {
      summary: 'model/permission follow the app-owned Codex profile',
      model: model ?? null,
      thinking: reasoning ?? null,
      permission: permission ?? null,
      provider: null,
      rawModel: model ?? null
    }
  } catch {
    return null
  }
}

type AuthenticationProbe = { ready: boolean; source: 'app-safeStorage' | 'cli-login' | 'none'; message: string }

/**
 * Ask the installed CLI whether a credential is usable *inside the app-owned
 * profile*. An app-owned credential is checked by the CLI in the same
 * environment a run would use; when only a profile login exists, the CLI's own
 * `auth check`/`login status` answers with a boolean phrase. Raw tokens and
 * auth files never enter the workbench process or its database.
 */
async function probeRuntimeAuthentication(
  kind: AgentRuntimeKind,
  executable: string,
  profile: LocalRuntimeProfile | null,
  profileDir: string,
  credential: AgentRuntimeCredential | null
): Promise<AuthenticationProbe> {
  const environment = {
    ...isolatedRuntimeEnvironment(kind, profileDir),
    ...(credential ? { [credential.envVar]: credential.secret } : {})
  }
  const credentialHint: AuthenticationProbe = {
    ready: true,
    source: 'app-safeStorage',
    message: `凭据已由 Main safeStorage 配置（通过 ${credential?.envVar ?? ''} 注入本次进程）`
  }
  const args = kind === 'codex'
    ? ['login', 'status']
    : [
        'auth', 'check', '--json', '--no-refresh',
        ...(profile?.provider ? ['--provider', profile.provider] : []),
        ...(profile?.rawModel ? ['--model', profile.rawModel] : [])
      ]
  try {
    const probe = resolveRuntimeCommand({ executable, args })
    const result = await runRuntimeProbe(probe, 8_000, kind, environment)
    const output = `${result.stdout}\n${result.stderr}`.toLocaleLowerCase()
    const ready = result.status === 0 && kind === 'codex'
      ? !/not logged|not authenticated|login required|no credentials|logged out/iu.test(output)
      : result.status === 0 && /"status"\s*:\s*"ready"|\bready\b/iu.test(output)
    if (ready) return { ready: true, source: 'cli-login', message: 'app-owned CLI profile login ready' }
    // A CLI that stores logins on disk cannot report an API key that only
    // exists for one invocation, so an app credential reports its configured
    // source instead of claiming a verified model call.
    if (credential) return credentialHint
    return { ready: false, source: 'none', message: '应用内未配置凭据，也未在应用自有 profile 中登录' }
  } catch {
    if (credential) return credentialHint
    return { ready: false, source: 'none', message: 'runtime 凭据状态不可用' }
  }
}

/** Explicitly point a child CLI at the app-owned profile directory. These are
 * paths, not credentials, and they are never the user's `~/.codex`/`~/.pi`. */
export function isolatedRuntimeEnvironment(kind: AgentRuntimeKind, profileDir: string): Record<string, string> {
  return kind === 'codex'
    ? { CODEX_HOME: profileDir }
    : { PI_CODING_AGENT_DIR: profileDir }
}

/** Render an app-owned profile directory label without leaking a user name. */
export function labelRuntimeProfileDir(profileDir: string): string {
  const roots: Array<[string | undefined, string]> = [
    [process.env['APPDATA'], '%APPDATA%'],
    [process.env['LOCALAPPDATA'], '%LOCALAPPDATA%'],
    [process.env['USERPROFILE'], '%USERPROFILE%'],
    [process.env['TEMP'], '%TEMP%'],
    [process.env['HOME'], '%HOME%']
  ]
  for (const [root, label] of roots) {
    if (!root || root.trim().length === 0) continue
    const normalizedRoot = root.replace(/[\\/]+$/u, '')
    if (profileDir.toLowerCase().startsWith(normalizedRoot.toLowerCase())) {
      return `${label}${profileDir.slice(normalizedRoot.length)}`
    }
  }
  return profileDir
}

export class CodexRuntimeAdapter extends CliRuntimeAdapter {
  readonly kind: AgentRuntimeKind = 'codex'

  protected defaultExecutable(): string | undefined { return 'codex' }

  protected command(request: AgentRuntimeRequest): RuntimeCommand {
    const executable = request.executablePath ?? this.defaultExecutable()!
    const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--cd', request.cwd]
    if (request.model?.trim()) args.push('--model', request.model.trim())
    if (request.thinking?.trim()) args.push('--config', `model_reasoning_effort="${request.thinking.trim().replace(/"/gu, '')}"`)
    // The service deliberately runs in a fresh per-run directory. The
    // explicit skip-git check keeps Codex non-interactive without injecting a
    // path-shaped TOML override that newer Codex versions reject.
    const requestedPermissionMode = request.permissionMode ?? (request.toolProfile === 'approved-write' ? 'auto' : 'read-only')
    // A pinned skill needs to spawn its engine inside the isolated run
    // directory, so a read-only request is honored as workspace-write for that
    // run. The requested mode is still what the run ledger records; the
    // effective profile is reported as a run diagnostic by the coordinator.
    const permissionMode = request.skillExecution ? 'auto' : requestedPermissionMode
    const sandbox = permissionMode === 'full-access' ? 'danger-full-access' : permissionMode === 'auto' ? 'workspace-write' : 'read-only'
    if (permissionMode === 'auto') {
      // Codex 0.154 rejects `--sandbox` together with `--approve-for-me`
      // ("cannot be used with"); the flag itself selects workspace-write.
      args.push('--approve-for-me')
    } else {
      args.push('--sandbox', sandbox)
    }
    if (request.skillExecution) {
      // workspace-write blocks outbound network by default, and the pinned
      // last30days engine needs it for every keyless source.
      args.push('--config', 'sandbox_workspace_write.network_access=true')
    }
    if (permissionMode === 'full-access' && request.approvalPolicy === 'never') {
      args.push('--dangerously-bypass-approvals-and-sandbox')
    }
    // Codex exec reads stdin when no positional prompt is supplied. Passing a
    // literal '-' is rejected by Codex 0.151 as an unexpected argument.
    return { executable, args }
  }
}

export class PiRuntimeAdapter extends CliRuntimeAdapter {
  readonly kind: AgentRuntimeKind = 'pi'

  protected defaultExecutable(): string | undefined { return 'pi' }

  protected command(request: AgentRuntimeRequest): RuntimeCommand {
    const executable = request.executablePath ?? this.defaultExecutable()!
    const args = ['-p', '--mode', 'json', '--no-session']
    if (request.model?.trim()) args.push('--model', request.model.trim())
    if (request.thinking?.trim()) args.push('--thinking', request.thinking.trim())
    if (request.skillPath?.trim()) args.push('--skill', request.skillPath.trim())
    if (request.mcpConfigPath) args.push('--mcp-config', request.mcpConfigPath)
    const requestedPermissionMode = request.permissionMode ?? (request.toolProfile === 'approved-write' ? 'auto' : 'read-only')
    const permissionMode = request.skillExecution ? 'auto' : requestedPermissionMode
    if (permissionMode === 'read-only') args.push('--approve', '--tools', 'read,grep,find,ls')
    else if (request.skillExecution) args.push('--approve', '--tools', skillRunToolAllowlist)
    else if (permissionMode === 'auto') args.push('--approve')
    else if (request.approvalPolicy === 'never') args.push('--approve')
    return { executable, args }
  }
}

/** Tool allowlist for a pinned-skill run: it must be able to read the skill,
 * spawn the engine (`bash`) and write evidence inside the run directory, but
 * `edit` stays out so a skill run cannot rewrite repository sources. */
const skillRunToolAllowlist = 'read,grep,find,ls,bash,write'

function classifyPayload(payload: unknown): AgentRuntimeEvent['kind'] {
  if (typeof payload === 'string') return 'progress'
  if (!payload || typeof payload !== 'object') return 'progress'
  const value = payload as Record<string, unknown>
  const type = typeof value['type'] === 'string' ? value['type'] : ''
  const nestedTypes = ['item', 'message', 'data', 'result']
    .map((key) => value[key])
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
    .map((entry) => typeof entry.type === 'string' ? entry.type : '')
  const allTypes = [type, ...nestedTypes].filter(Boolean).join(' ')
  if (/tool|function|command_execution|mcp_tool|tool_use/iu.test(allTypes)) return 'tool_call'
  if (/assistant|message|text|agent_message/iu.test(allTypes)) return 'assistant_message'
  return 'progress'
}

async function discoverModelOptions(
  kind: AgentRuntimeKind,
  executable: string,
  profile: LocalRuntimeProfile | null,
  profileDir: string,
  credential: AgentRuntimeCredential | null
): Promise<string[]> {
  const environment = {
    ...isolatedRuntimeEnvironment(kind, profileDir),
    ...(credential ? { [credential.envVar]: credential.secret } : {})
  }
  const discoveredFromProfile = profile?.model ? [profile.model] : []
  if (kind === 'codex') {
    try {
      // Only the app-owned profile cache is read; it is a model catalog, not a
      // credential store.
      const cache = JSON.parse(readFileSync(join(profileDir, 'models_cache.json'), 'utf8')) as { models?: Array<{ slug?: unknown }> }
      const cached = (cache.models ?? []).flatMap((entry) => typeof entry.slug === 'string' ? [entry.slug] : [])
      if (cached.length > 0) return [...new Set([...cached, ...discoveredFromProfile])]
    } catch {
      // fall through to the CLI probe
    }
  } else {
    try {
      const probe = resolveRuntimeCommand({ executable, args: ['models', 'list', '--json'] })
      const result = await runRuntimeProbe(probe, 5_000, kind, environment)
      const parsed = JSON.parse(result.stdout) as unknown
      const entries = Array.isArray(parsed)
        ? parsed
        : (typeof parsed === 'object' && parsed !== null ? (parsed as { models?: unknown }).models : undefined)
      const models = (Array.isArray(entries) ? entries : []).flatMap((entry) => {
        if (typeof entry === 'string') return [entry]
        if (typeof entry === 'object' && entry !== null) {
          const record = entry as { id?: unknown; model?: unknown; name?: unknown; provider?: unknown }
          const id = typeof record.id === 'string' ? record.id : (typeof record.model === 'string' ? record.model : (typeof record.name === 'string' ? record.name : null))
          if (!id) return []
          const provider = typeof record.provider === 'string' ? record.provider : null
          return provider && !id.includes('/') ? [`${provider}/${id}`] : [id]
        }
        return []
      })
      if (models.length > 0) return [...new Set([...models, ...discoveredFromProfile])]
    } catch {
      // fall through to the curated fallback
    }
  }
  return [...new Set([...discoveredFromProfile, ...(kind === 'codex' ? [] : [])])]
}

function isAuthenticationFailure(payload: unknown): boolean {
  const text = textFromRuntimePayload(payload).toLocaleLowerCase()
  return /no api key|missing bearer|401 unauthorized|authentication required|not authenticated|api key found/iu.test(text)
}

function textFromRuntimePayload(payload: unknown, depth = 0): string {
  if (typeof payload === 'string') return payload
  if (!payload || typeof payload !== 'object' || depth > 4) return ''
  const values = Array.isArray(payload) ? payload.slice(0, 20) : Object.values(payload as Record<string, unknown>).slice(0, 20)
  return values.map((value) => textFromRuntimePayload(value, depth + 1)).filter(Boolean).join(' ')
}

/**
 * Keep runtime processes useful on Windows without forwarding API keys,
 * bearer tokens, cookies, or other ambient credentials from Electron. The
 * installed Codex/Pi CLI owns authentication in its normal profile directory;
 * this allowlist forwards only the explicit profile path and proxy settings.
 */
export function safeChildEnvironment(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const allowed = new Set([
    'Path', 'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA',
    'PROGRAMDATA', 'COMSPEC', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM'
  ])
  const environment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key) && value !== undefined) environment[key] = value
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete environment[key]
    else environment[key] = value
  }
  return environment
}

/** Resolve npm's Windows PowerShell shim without invoking a shell. Node's
 * spawn cannot execute a `.ps1` shim directly, while `shell: true` would make
 * the user prompt part of a shell command. PowerShell receives the remaining
 * arguments as data after `-File`, so prompt metacharacters are not evaluated.
 */
function resolveRuntimeCommand(command: RuntimeCommand): RuntimeCommand {
  if (process.platform !== 'win32') return command
  const executable = command.executable
  const lower = executable.toLowerCase()
  const direct = resolveKnownNpmShim(executable, command.args)
  if (direct) return direct
  if (lower.endsWith('.ps1')) {
    return {
      executable: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', executable, ...command.args]
    }
  }
  if (lower.endsWith('.exe')) return command
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const powershellShim = executable.replace(/\.(?:cmd|bat)$/iu, '.ps1')
    if (existsSync(powershellShim)) {
      return {
        executable: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', powershellShim, ...command.args]
      }
    }
    return command
  }
  const candidates = [executable + '.ps1', executable + '.cmd', executable + '.bat']
  const where = spawnSync('where.exe', [executable], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 2_000,
    env: safeChildEnvironment()
  })
  if (where.status === 0) {
    for (const line of String(where.stdout ?? '').split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)) {
      const direct = resolveKnownNpmShim(line, command.args)
      if (direct) return direct
      const lineLower = line.toLowerCase()
      if (lineLower.endsWith('.cmd') || lineLower.endsWith('.bat')) {
        candidates.push(line.replace(/\.(?:cmd|bat)$/iu, '.ps1'), line)
      } else if (lineLower.endsWith('.exe') || lineLower.endsWith('.ps1')) {
        candidates.push(line)
      } else {
        candidates.push(line + '.ps1', line + '.cmd', line + '.bat')
      }
    }
  }
  const powershellShim = candidates.find((candidate) => candidate.toLowerCase().endsWith('.ps1') && existsSync(candidate))
  if (powershellShim) {
    return {
      executable: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', powershellShim, ...command.args]
    }
  }
  return command
}

/**
 * npm installs Codex and Pi as PowerShell/cmd shims on Windows. Invoking the
 * PowerShell shim with `-File` breaks when an argument is `-` (stdin prompt)
 * because PowerShell binds the forwarded CLI flags to the shim's own parser.
 * Resolve the shim to its adjacent Node entry point instead; this keeps
 * `shell:false`, preserves stdin, and avoids command-line metacharacters.
 */
function resolveKnownNpmShim(executable: string, args: string[]): RuntimeCommand | null {
  const fileName = basename(executable).toLowerCase().replace(/\.(?:cmd|ps1)$/u, '')
  const packagePath = fileName === 'codex'
    ? ['node_modules', '@openai', 'codex', 'bin', 'codex.js']
    : fileName === 'pi'
      ? ['node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js']
      : null
  if (!packagePath) return null
  const directory = dirname(executable)
  const entry = join(directory, ...packagePath)
  if (!existsSync(entry)) return null
  const node = join(directory, 'node.exe')
  return { executable: existsSync(node) ? node : 'node', args: [entry, ...args] }
}

async function terminateProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1_000)
    child.once('close', () => { clearTimeout(timer); resolve() })
  })
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'runtime process failed'
}

export function createDefaultAgentRuntimeAdapters(): ReadonlyMap<AgentRuntimeKind, AgentRuntimeAdapter> {
  return new Map<AgentRuntimeKind, AgentRuntimeAdapter>([
    ['codex', new CodexRuntimeAdapter()],
    ['pi', new PiRuntimeAdapter()]
  ])
}
