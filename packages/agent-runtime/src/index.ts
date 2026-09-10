import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { AgentRuntimeKind, AgentRuntimeTransport, AgentToolProfile } from '@prw/contracts'

export interface AgentRuntimeCapabilities {
  readonly kind: AgentRuntimeKind
  readonly transport: AgentRuntimeTransport
  readonly available: boolean
  readonly version: string | null
  readonly mcp: boolean
  readonly structuredOutput: boolean
  readonly workspaceWrite: boolean
  readonly message: string
  /** Whether the local CLI can currently authenticate with its own profile.
   * This is a status probe only; no token or auth file is read by PRW. */
  readonly authReady?: boolean
  readonly localDefaultModel?: string | null
  readonly localThinkingLevel?: string | null
  readonly localPermission?: string | null
  readonly modelOptions?: string[]
  readonly thinkingOptions?: string[]
  readonly permissionOptions?: Array<'read-only' | 'auto' | 'full-access'>
}

export interface AgentRuntimeRequest {
  readonly prompt: string
  readonly cwd: string
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
}

export interface AgentRuntimeHandle {
  readonly externalRunId: string
  readonly events: AsyncIterable<AgentRuntimeEvent>
  cancel(): Promise<void>
}

export interface AgentRuntimeAdapter {
  readonly kind: AgentRuntimeKind
  readonly transport: AgentRuntimeTransport
  capabilities(executablePath?: string | undefined): Promise<AgentRuntimeCapabilities>
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

  async capabilities(executablePath?: string): Promise<AgentRuntimeCapabilities> {
    const executable = executablePath?.trim() || this.defaultExecutable()
    const localProfile = detectLocalProfile(this.kind)
    const versionProbe = executable
      ? runRuntimeProbe(resolveRuntimeCommand({ executable, args: ['--version'] }), 5_000, this.kind)
      : Promise.resolve(null)
    // These probes are independent. Using async child processes matters here:
    // Promise.all cannot make spawnSync calls concurrent on the Core event loop.
    const modelOptionsPromise = executable
      ? discoverModelOptions(this.kind, executable, localProfile)
      : Promise.resolve(localProfile?.model ? [localProfile.model] : [])
    const authPromise = executable
      ? probeLocalAuthentication(this.kind, executable, localProfile)
      : Promise.resolve({ ready: false, message: 'local CLI authentication was not checked because the executable is unavailable' })
    const permissionPromise = executable
      ? detectPermissionOptions(this.kind, executable)
      : Promise.resolve([] as Array<'read-only' | 'auto' | 'full-access'>)
    const [versionResult, modelOptions, auth, permissionOptions] = await Promise.all([versionProbe, modelOptionsPromise, authPromise, permissionPromise])
    const available = versionResult?.status === 0
    const output = versionResult ? `${versionResult.stdout}\n${versionResult.stderr}` : ''
    const firstLine = output.trim().split(/\r?\n/u)[0]
    const version = firstLine ? firstLine.slice(0, 200) : null
    return {
      kind: this.kind,
      transport: this.transport,
      available,
      version,
      mcp: true,
      structuredOutput: true,
      workspaceWrite: true,
      message: available
        ? `runtime executable is available${localProfile ? ` · ${localProfile.summary}` : ''} · ${auth.message}`
        : 'runtime executable is not available',
      authReady: available ? auth.ready : false,
      localDefaultModel: localProfile?.model ?? null,
      localThinkingLevel: localProfile?.thinking ?? null,
      localPermission: localProfile?.permission ?? null,
      modelOptions,
      thinkingOptions: [...new Set([
        ...(this.kind === 'pi' ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : ['minimal', 'low', 'medium', 'high', 'xhigh']),
        ...(localProfile?.thinking ? [localProfile.thinking] : [])
      ])],
      permissionOptions: available ? permissionOptions : []
    }
  }

  async start(request: AgentRuntimeRequest): Promise<AgentRuntimeHandle> {
    const externalRunId = randomUUID()
    const queue = new EventQueue<AgentRuntimeEvent>()
    const command = resolveRuntimeCommand(this.command(request))
    const timeoutMs = request.timeoutMs ?? 15 * 60_000
    const child = spawn(command.executable, command.args, {
      cwd: request.cwd,
      shell: false,
      windowsHide: true,
      // The app delegates authentication to the installed CLI. It never
      // opens, copies, or forwards a token; setting the CLI's own profile
      // directory is enough for Codex/Pi to reuse the user's existing login.
      env: safeChildEnvironment({
        ...request.env,
        ...localRuntimeEnvironment(this.kind)
      })
    })
    let settled = false
    let authStopping = false
    let diagnostic = ''
    let timeout: ReturnType<typeof setTimeout> | undefined
    const startedAt = new Date().toISOString()
    queue.push({ externalRunId, kind: 'started', payload: { command: this.kind }, createdAt: startedAt })

    const finish = (kind: AgentRuntimeEvent['kind'], payload: unknown): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      queue.push({ externalRunId, kind, payload, createdAt: new Date().toISOString() })
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
      // CLI diagnostics (MCP auth notices, skill warnings, reconnect details)
      // belong to the runtime log, never to the assistant transcript. The
      // service intentionally drops them from the event stream so paths and
      // provider details cannot leak into the user-facing conversation. A
      // non-zero process exit is reported separately as a generic failure.
      if (isStderr) {
        diagnostic = `${diagnostic} ${trimmed}`.trim().slice(-2_000)
        return
      }
      const kind = classifyPayload(payload)
      queue.push({ externalRunId, kind, payload, createdAt: new Date().toISOString() })
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

function runRuntimeProbe(command: RuntimeCommand, timeoutMs: number, kind: AgentRuntimeKind): Promise<RuntimeProbeResult> {
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
        env: safeChildEnvironment(localRuntimeEnvironment(kind))
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

async function detectPermissionOptions(kind: AgentRuntimeKind, executable: string): Promise<Array<'read-only' | 'auto' | 'full-access'>> {
  try {
    const result = await runRuntimeProbe(resolveRuntimeCommand({ executable, args: ['--help'] }), 5_000, kind)
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

/** Read only the non-secret defaults that explain the local CLI selector.
 * Authentication files and tokens are intentionally never opened or returned.
 */
type LocalRuntimeProfile = {
  summary: string
  model: string | null
  thinking: string | null
  permission: string | null
  provider: string | null
  rawModel: string | null
}

function detectLocalProfile(kind: AgentRuntimeKind): LocalRuntimeProfile | null {
  if (kind === 'pi') {
    const piHome = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')
    const settingsPath = join(piHome, 'settings.json')
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
      const provider = typeof settings.defaultProvider === 'string' ? settings.defaultProvider : null
      const model = typeof settings.defaultModel === 'string' ? settings.defaultModel : null
      const thinking = typeof settings.defaultThinkingLevel === 'string' ? settings.defaultThinkingLevel : null
      const trust = typeof settings.defaultProjectTrust === 'string' ? settings.defaultProjectTrust : null
      const summary = [provider ? `provider ${provider}` : null, model ? `model ${model}` : null, thinking ? `thinking ${thinking}` : null].filter((value): value is string => Boolean(value)).join(', ')
      // Pi's CLI selector is provider-qualified. Keep the provider prefix in
      // the ephemeral model hint so a run uses the same model as local Pi
      // even when another provider exposes an identically named model.
      const selectedModel = provider && model ? `${provider}/${model}` : model
      return {
        summary: summary ? `local defaults: ${summary}` : 'model/thinking follow Pi local defaults',
        model: selectedModel,
        thinking,
        permission: trust,
        provider,
        rawModel: model
      }
    } catch {
      return existsSync(join(homedir(), '.pi'))
        ? { summary: 'model/thinking follow Pi local configuration', model: null, thinking: null, permission: null, provider: null, rawModel: null }
        : { summary: 'model/thinking follow Pi local defaults', model: null, thinking: null, permission: null, provider: null, rawModel: null }
    }
  }
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  const configPath = join(codexHome, 'config.toml')
  try {
    const config = readFileSync(configPath, 'utf8')
    const model = config.match(/^\s*model\s*=\s*"([^"]+)"/mu)?.[1]
    const reasoning = config.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/mu)?.[1]
    const permission = config.match(/^\s*approvals_reviewer\s*=\s*"([^"]+)"/mu)?.[1]
    const values = [model ? `model ${model}` : null, reasoning ? `reasoning ${reasoning}` : null, permission ? 'permission local CLI' : null].filter((value): value is string => Boolean(value))
    return {
      summary: values.length > 0 ? `local defaults: ${values.join(', ')}` : 'model/permission follow local Codex configuration',
      model: model ?? null,
      thinking: reasoning ?? null,
      permission: permission ?? null,
      provider: null,
      rawModel: model ?? null
    }
  } catch {
    return { summary: 'model/permission follow local Codex configuration', model: null, thinking: null, permission: null, provider: null, rawModel: null }
  }
}

type AuthenticationProbe = { ready: boolean; message: string }

/**
 * Ask the installed CLI whether its existing login is usable. The output is
 * reduced to a boolean/status phrase; credentials and auth-file contents never
 * enter the workbench process or its database.
 */
async function probeLocalAuthentication(
  kind: AgentRuntimeKind,
  executable: string,
  profile: LocalRuntimeProfile | null
): Promise<AuthenticationProbe> {
  const args = kind === 'codex'
    ? ['login', 'status']
    : [
        'auth', 'check', '--json', '--no-refresh',
        ...(profile?.provider ? ['--provider', profile.provider] : []),
        ...(profile?.rawModel ? ['--model', profile.rawModel] : [])
      ]
  try {
    const probe = resolveRuntimeCommand({ executable, args })
    const result = await runRuntimeProbe(probe, 8_000, kind)
    const output = `${result.stdout}\n${result.stderr}`.toLocaleLowerCase()
    const ready = result.status === 0 && kind === 'codex'
      ? !/not logged|not authenticated|login required|no credentials|logged out/iu.test(output)
      : result.status === 0 && /"status"\s*:\s*"ready"|\bready\b/iu.test(output)
    return { ready, message: ready ? 'local CLI login ready' : 'local CLI login required' }
  } catch {
    return { ready: false, message: 'local CLI login status unavailable' }
  }
}

/** Explicitly point the child CLI at the user's normal profile directory.
 * These are paths, not credentials. A configured path is honored, otherwise
 * the platform default is used. */
function localRuntimeEnvironment(kind: AgentRuntimeKind): Record<string, string> {
  if (kind === 'codex') {
    return { CODEX_HOME: process.env.CODEX_HOME?.trim() || join(homedir(), '.codex') }
  }
  return { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent') }
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
    const permissionMode = request.permissionMode ?? (request.toolProfile === 'approved-write' ? 'auto' : 'read-only')
    const sandbox = permissionMode === 'full-access' ? 'danger-full-access' : permissionMode === 'auto' ? 'workspace-write' : 'read-only'
    args.push('--sandbox', sandbox)
    // Codex 0.151 removed --ask-for-approval. Read-only runs need no
    // approval flag; workspace-write uses the CLI's current auto-review flag.
    if (permissionMode === 'auto') args.push('--approve-for-me')
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
    const permissionMode = request.permissionMode ?? (request.toolProfile === 'approved-write' ? 'auto' : 'read-only')
    if (permissionMode === 'read-only') args.push('--approve', '--tools', 'read,grep,find,ls')
    else if (permissionMode === 'auto') args.push('--approve')
    else if (request.approvalPolicy === 'never') args.push('--approve')
    return { executable, args }
  }
}

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

async function discoverModelOptions(kind: AgentRuntimeKind, executable: string, profile: LocalRuntimeProfile | null): Promise<string[]> {
  const discoveredFromProfile = profile?.model ? [profile.model] : []
  if (kind === 'codex') {
    const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
    try {
      const cache = JSON.parse(readFileSync(join(codexHome, 'models_cache.json'), 'utf8')) as { models?: Array<{ slug?: unknown }> }
      const cached = (cache.models ?? []).flatMap((entry) => typeof entry.slug === 'string' ? [entry.slug] : [])
      if (cached.length > 0) return [...new Set([...discoveredFromProfile, ...cached])].slice(0, 200)
    } catch { /* the CLI may not have fetched its model catalog yet */ }
  }
  if (kind === 'pi') {
    try {
      const probe = resolveRuntimeCommand({ executable, args: ['--list-models'] })
      const result = await runRuntimeProbe(probe, 5_000, kind)
      const discovered = `${result.stdout}\n${result.stderr}`
        .split(/\r?\n/u)
        .flatMap((line) => {
          // Pi has emitted both a columnar `provider model ...` table and a
          // compact `provider/model ...` listing across releases. Accept both
          // forms, while ignoring the header and descriptive columns.
          const qualified = line.match(/\b([A-Za-z0-9._-]+)\/([A-Za-z0-9._:@-]+)\b/u)
          if (qualified) return [`${qualified[1]}/${qualified[2]}`]
          const columns = /^\s*([A-Za-z0-9._-]+)\s+([A-Za-z0-9._:@-]+)(?:\s|$)/u.exec(line)
          return columns && columns[1] !== 'provider' ? [`${columns[1]}/${columns[2]}`] : []
        })
      if (discovered.length > 0) return [...new Set([...discoveredFromProfile, ...discovered])].slice(0, 200)
    } catch { /* one failed Pi catalog probe falls back to the local default */ }
  }
  return discoveredFromProfile
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
function safeChildEnvironment(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv {
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
