import { randomUUID } from 'node:crypto'
import {
  PiModelCatalog,
  discoverProviderModels,
  type AgentAuthChannel,
  type AgentCredentialBridge,
  type AgentRuntimeCredential
} from '@prw/agent-runtime'
import { AgentModelDiscoveryInputSchema, AgentModelDiscoveryResultSchema } from '@prw/contracts'
import type {
  AgentAuthEvent,
  AgentAuthLoginAnswerInput,
  AgentAuthLoginCancelInput,
  AgentAuthLoginStartInput,
  AgentAuthLogoutInput,
  AgentAuthType,
  AgentCustomProviders,
  AgentCustomProvidersSaveInput,
  AgentModelCatalogEntry,
  AgentModelDiscoveryInput,
  AgentModelDiscoveryResult,
  AgentSettings,
  AgentSettingsSaveInput
} from '@prw/contracts'
import type { WorkbenchRepository } from '@prw/database'

/**
 * Model catalog, interactive login and the app-wide Agent defaults.
 *
 * This class is the *host* half of Pi's `AuthInteraction` contract. Pi owns the
 * login coroutine and the credential shape; it deliberately leaves prompt
 * rendering and browser launching to the app, so the correlation state — which
 * login is waiting, which prompt is unanswered — has to live on the app side.
 * It lives here, because this is the only object that can see both an incoming
 * `agent.models.login.answer` RPC and the promise Pi is awaiting.
 *
 * Two invariants keep the handshake honest:
 *
 *  - every prompt gets an app-minted `promptId`, and only a matching answer
 *    resolves it, so a late answer for a finished login is ignored instead of
 *    being delivered to the next one;
 *  - cancelling (or closing the dialog) rejects the pending prompts, which
 *    unwinds Pi's coroutine instead of leaving it parked forever.
 */
export class AgentModelCoordinator {
  private readonly logins = new Map<string, ActiveLogin>()

  constructor(
    private readonly repository: WorkbenchRepository,
    private readonly options: AgentModelCoordinatorOptions
  ) {}

  async catalog(): Promise<AgentModelCatalogEntry[]> {
    return this.catalogInstance([]).list()
  }

  /** Custom providers of the app-owned models.json, including why Pi cannot use
   * them when the file is broken. */
  async customProviders(): Promise<AgentCustomProviders> {
    return this.catalogInstance([]).customProviders()
  }

  /**
   * Replace the custom providers and return the resulting snapshot.
   *
   * The credential vault is untouched on purpose: removing a provider from
   * models.json hides its models but keeps the stored key, so re-adding the same
   * id does not force the user to paste the key again. Explicit logout remains
   * the only way to delete a secret.
   */
  async saveCustomProviders(input: AgentCustomProvidersSaveInput): Promise<AgentCustomProviders> {
    return this.catalogInstance([]).saveCustomProviders(input.providers)
  }

  /**
   * Pay the one-time embedded-SDK cost before a user is waiting for it.
   *
   * The Pi bundle is large: the first `import()` plus the first `ModelRuntime`
   * construction take seconds, and they block this process' event loop while the
   * module graph compiles. Running that lazily inside `agent.models.catalog`
   * would make the first visit to Settings look like a hung page, so the Core
   * starts it right after boot instead. The result is discarded on purpose — the
   * only product of this call is a warm module cache — and a failure is swallowed
   * because the real call, when it comes, reports it through the normal path.
   */
  async warmup(): Promise<void> {
    try {
      await this.catalogInstance([]).list()
    } catch {
      // Best effort only.
    }
  }

  /**
   * Start one login and return immediately.
   *
   * The renderer needs a `loginId` before it can render anything, so the flow
   * runs detached and reports through `AgentAuthEvent`. A failure reaches the
   * UI as a `done` event with `ok: false` rather than as an RPC rejection, so a
   * slow network failure cannot look like a broken Settings page.
   */
  loginStart(input: AgentAuthLoginStartInput, credentials: readonly AgentRuntimeCredential[]): { loginId: string } {
    const loginId = randomUUID()
    const login: ActiveLogin = { abort: new AbortController(), pending: new Map() }
    this.logins.set(loginId, login)
    void this.runLogin(loginId, login, input.provider, credentials)
    return { loginId }
  }

  /**
   * Deliver one answer and forget the prompt.
   *
   * An unknown `promptId` is ignored rather than rejected: a user who double
   * submits, or a dialog that closes as the answer arrives, would otherwise see
   * a spurious failure for an operation that already succeeded.
   */
  loginAnswer(input: AgentAuthLoginAnswerInput): void {
    const login = this.logins.get(input.loginId)
    const pending = login?.pending.get(input.promptId)
    if (!login || !pending) return
    login.pending.delete(input.promptId)
    pending.resolve(input.value)
  }

  /** Cancel one login. Pending prompts reject, which unwinds Pi's coroutine and
   * is what makes the Settings dialog's cancel button actually stop the flow. */
  loginCancel(input: AgentAuthLoginCancelInput): void {
    const login = this.logins.get(input.loginId)
    if (!login) return
    this.logins.delete(input.loginId)
    login.abort.abort()
    rejectPending(login, new Error('agent login cancelled'))
  }

  /**
   * Forget one provider's credential.
   *
   * In-flight logins for the provider are cancelled first: letting one finish
   * *after* a logout would silently restore the credential the user just
   * removed.
   */
  async logout(input: AgentAuthLogoutInput, credentials: readonly AgentRuntimeCredential[]): Promise<void> {
    for (const [loginId, login] of this.logins) {
      if (login.provider === input.provider) this.loginCancel({ loginId })
    }
    await this.catalogInstance(credentials).logout(input.provider)
  }

  /**
   * Ask one user-added endpoint which models it advertises.
   *
   * A read: the result is returned to the caller and is written nowhere — not to
   * `models.json`, not to SQLite, not to the ledger — so a probe cannot change
   * what the app is willing to run. Adopting a discovered model stays an
   * explicit edit of the provider list in Settings.
   *
   * The key is taken from the credential envelope of *this* RPC and only for the
   * provider being probed. Sending the whole vault would be wrong twice over:
   * the envelope carries a bounded but generous entry count, and a probe must never carry one
   * provider's key to another provider's host.
   */
  async discoverModels(input: AgentModelDiscoveryInput, credentials: readonly AgentRuntimeCredential[]): Promise<AgentModelDiscoveryResult> {
    const parsed = AgentModelDiscoveryInputSchema.parse(input)
    const credential = credentials.find((entry) => entry.provider === parsed.provider)
    const outcome = await discoverProviderModels({
      provider: parsed.provider,
      baseUrl: parsed.baseUrl,
      api: parsed.api,
      apiKey: apiKeyOf(credential)
    })
    return AgentModelDiscoveryResultSchema.parse({
      provider: parsed.provider,
      baseUrl: parsed.baseUrl,
      api: parsed.api,
      models: [...outcome.models],
      notice: outcome.notice,
      discoveredAt: outcome.discoveredAt
    })
  }

  getSettings(): AgentSettings {
    return this.repository.getAgentSettings()
  }

  saveSettings(input: AgentSettingsSaveInput): AgentSettings {
    return this.repository.saveAgentSettings(input)
  }

  private async runLogin(
    loginId: string,
    login: ActiveLogin,
    provider: string,
    credentials: readonly AgentRuntimeCredential[]
  ): Promise<void> {
    login.provider = provider
    try {
      // The provider's own auth methods decide the flow, so they are read from
      // the catalog rather than guessed from a local list of provider ids.
      const authType = authTypeFor(await this.catalogInstance(credentials).list(), provider)
      if (!authType) {
        throw new Error(`模型提供方 "${provider}" 没有可用的交互式登录方式。`)
      }
      this.options.publishAuthEvent({ kind: 'started', loginId, provider, authType })
      await this.catalogInstance(credentials).login(provider, authType, this.createChannel(loginId, login), loginId, login.abort.signal)
      this.options.publishAuthEvent({ kind: 'done', loginId, ok: true, provider, error: null })
    } catch (error) {
      this.options.publishAuthEvent({
        kind: 'done',
        loginId,
        ok: false,
        provider,
        error: error instanceof Error ? error.message : '登录失败'
      })
    } finally {
      this.logins.delete(loginId)
      rejectPending(login, new Error('agent login finished'))
    }
  }

  /** The channel Pi's login coroutine talks to. `push` must never throw, because
   * the SDK calls it from inside its own coroutine. */
  private createChannel(loginId: string, login: ActiveLogin): AgentAuthChannel {
    return {
      push: (event: AgentAuthEvent): void => {
        try {
          if (login.abort.signal.aborted) return
          this.options.publishAuthEvent(event)
        } catch {
          // A transport failure must not become a failed login.
        }
      },
      prompt: (request): Promise<string> =>
        new Promise<string>((resolve, reject) => {
          if (login.abort.signal.aborted) {
            reject(new Error('agent login cancelled'))
            return
          }
          const promptId = randomUUID()
          login.pending.set(promptId, { resolve, reject })
          this.options.publishAuthEvent({
            kind: 'prompt',
            loginId,
            promptId,
            promptKind: request.kind,
            message: request.message,
            placeholder: request.placeholder,
            options: request.options.map((option) => ({
              value: option.value,
              label: option.label,
              description: option.description
            }))
          })
        })
    }
  }

  private catalogInstance(credentials: readonly AgentRuntimeCredential[]): PiModelCatalog {
    return new PiModelCatalog(this.options.profileDir, this.createBridge(credentials))
  }

  /** Credentials travel as typed values from Main, so the bridge only hands
   * back what this RPC carried and forwards every write to Main. */
  private createBridge(credentials: readonly AgentRuntimeCredential[]): AgentCredentialBridge {
    return {
      read: async (providerId) => credentials.find((entry) => entry.provider === providerId)?.credential ?? null,
      list: async () => credentials.map((entry) => ({ provider: entry.provider, credential: entry.credential })),
      persist: (providerId, credential) => this.options.persistCredential(providerId, credential)
    }
  }
}

export interface AgentModelCoordinatorOptions {
  /** App-owned Pi profile directory. No credential is stored here; it is the
   * SDK's `agentDir`, so the personal `~/.pi` is never consulted. */
  readonly profileDir: string
  /** Push one login progress event toward the renderer. */
  readonly publishAuthEvent: (event: AgentAuthEvent) => void
  /** Persist one credential through Electron Main and resolve only after Main
   * acknowledged it. */
  readonly persistCredential: AgentCredentialBridge['persist']
}

interface ActiveLogin {
  readonly abort: AbortController
  readonly pending: Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>
  provider?: string
}

/** Preferred interactive method of a provider. OAuth wins when a provider
 * offers both, because it is the flow with a browser or device code and no
 * long-lived secret to paste. */function authTypeFor(entries: readonly AgentModelCatalogEntry[], provider: string): AgentAuthType | null {
  const authTypes = entries.find((entry) => entry.provider === provider)?.authTypes ?? []
  if (authTypes.includes('oauth')) return 'oauth'
  return authTypes.includes('api_key') ? 'api_key' : null
}

/**
 * The plain API key of one credential, or `null` when there is none to send.
 *
 * Only the API-key form is usable for a discovery probe: an OAuth credential's
 * material is provider-specific and is spent through Pi's own auth path, not
 * pasted into a listing request. A key-less credential (an `env`-resolved one)
 * is equally unusable, and reporting it as "no key" is the honest answer.
 */
function apiKeyOf(credential: AgentRuntimeCredential | undefined): string | null {
  const value = credential?.credential
  if (value === undefined || value.type !== 'api_key') return null
  const key = value.key?.trim() ?? ''
  return key.length === 0 ? null : key
}

function rejectPending(login: ActiveLogin, error: Error): void {
  for (const [, pending] of login.pending) pending.reject(error)
  login.pending.clear()
}
