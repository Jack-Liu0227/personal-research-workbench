import { getSupportedThinkingLevels, type Api, type AuthType, type Model, type Provider } from '@earendil-works/pi-ai'
import type { AgentAuthType, AgentCustomProvider, AgentCustomProviders, AgentModelCatalogEntry, AgentModelOption } from '@prw/contracts'
import type { AgentAuthChannel, AgentCredentialBridge } from '../index.js'
import { createAuthInteraction } from './auth-flow.js'
import { AppCredentialStore } from './credential-store.js'
import { loadPiSdk } from './loader.js'
import { readPiModelsFile, writePiModelsFile } from './models-file.js'

/**
 * Provider/model catalog and login, backed by the embedded Pi SDK.
 *
 * This lives next to the adapter rather than in the workspace service because
 * everything it touches is Pi's: the provider catalog, the credential store
 * contract, and the login coroutine. The service layer only decides *where* a
 * prompt is rendered, so it passes an `AgentAuthChannel` in and stays ignorant
 * of the SDK.
 *
 * Each call creates its own `ModelRuntime`. That is deliberate: a runtime holds
 * a credential snapshot, and Settings can save a key between two calls from a
 * different process, so a long-lived instance would answer with stale auth
 * state. Construction is a local file read when `refreshOnCreate` is false.
 */
export class PiModelCatalog {
  constructor(
    private readonly profileDir: string,
    private readonly bridge: AgentCredentialBridge
  ) {}

  /**
   * Enumerate every provider the SDK knows about, with the thinking levels each
   * model actually supports.
   *
   * No credential material is read beyond what Main already attached, so this
   * is safe to call while the Settings page is open: an unconfigured provider
   * still lists its models, and the renderer decides what to enable. Thinking
   * levels come from the SDK rather than a hard-coded list, so a model that
   * rejects `xhigh` never offers it.
   */
  async list(): Promise<AgentModelCatalogEntry[]> {
    const sdk = await loadPiSdk(this.profileDir)
    const runtime = await sdk.ModelRuntime.create({
      credentials: new AppCredentialStore(this.bridge),
      refreshOnCreate: false
    })
    // A provider that appears in models.json is user-defined even when it
    // shadows a built-in id, because that is exactly what Pi's own composition
    // does with it: the file entry is an override, not an addition.
    const custom = new Set(readPiModelsFile(this.profileDir).providers.map((provider) => provider.id))
    return runtime.getProviders().map((provider) => ({
      provider: provider.id,
      name: provider.name,
      authTypes: authTypesOf(provider),
      models: runtime.getModels(provider.id).map(toModelOption),
      source: custom.has(provider.id) ? 'custom' : 'builtin'
    }))
  }

  /**
   * Custom providers as stored in models.json, plus the reason the catalog
   * cannot use them when there is one.
   *
   * Two error sources are merged because both look identical from the UI: the
   * file itself (invalid JSON, a provider this app will not rewrite) and Pi's
   * own composition of the file (a model without an `api`, a rejected schema).
   * Pi reports the second one from the runtime, so it can only be read after a
   * runtime exists.
   */
  async customProviders(): Promise<AgentCustomProviders> {
    const file = readPiModelsFile(this.profileDir)
    const sdk = await loadPiSdk(this.profileDir)
    const runtime = await sdk.ModelRuntime.create({
      credentials: new AppCredentialStore(this.bridge),
      refreshOnCreate: false
    })
    const runtimeError = runtime.getError()
    return {
      path: file.path,
      providers: [...file.providers],
      unmanaged: [...file.unmanaged],
      configError: truncate(file.error ?? runtimeError ?? null, 2_000)
    }
  }

  /**
   * Replace the managed providers and return the resulting snapshot.
   *
   * The write is deliberately not cached: the caller gets what Pi will read on
   * the next catalog call, including a composition error introduced by the
   * value it just saved.
   */
  async saveCustomProviders(providers: readonly AgentCustomProvider[]): Promise<AgentCustomProviders> {
    writePiModelsFile(this.profileDir, providers)
    return this.customProviders()
  }

  /**
   * Run one provider login to completion.
   *
   * `login` is Pi's own orchestration: it decides whether a pasted key, a
   * browser redirect or a device code is needed, and reports progress through
   * the interaction. The store passed here is what makes the resulting
   * credential reach Main's vault instead of Pi's own `auth.json`.
   */
  async login(provider: string, authType: AgentAuthType, channel: AgentAuthChannel, loginId: string, signal: AbortSignal): Promise<void> {
    const sdk = await loadPiSdk(this.profileDir)
    const runtime = await sdk.ModelRuntime.create({
      credentials: new AppCredentialStore(this.bridge),
      refreshOnCreate: false
    })
    await runtime.login(provider, authType as AuthType, createAuthInteraction(channel, loginId, signal))
  }

  /**
   * Forget one provider's credential.
   *
   * `Models.logout` is used instead of deleting from the store directly: it
   * also drops the runtime's in-memory auth, so a login dialog that runs right
   * after a logout cannot be answered from a cached token that the vault no
   * longer holds.
   */
  async logout(provider: string): Promise<void> {
    const sdk = await loadPiSdk(this.profileDir)
    const runtime = await sdk.ModelRuntime.create({
      credentials: new AppCredentialStore(this.bridge),
      refreshOnCreate: false
    })
    await runtime.logout(provider)
  }
}

/** Auth methods a provider documents. A provider with ambient credentials (an
 * environment variable or `~/.aws/credentials`) still reports `api_key`,
 * because that is the only method through which a key can be supplied. */
function authTypesOf(provider: Provider<Api>): AgentAuthType[] {
  const types: AgentAuthType[] = []
  if (provider.auth.apiKey) types.push('api_key')
  if (provider.auth.oauth) types.push('oauth')
  return types
}

function toModelOption(model: Model<Api>): AgentModelOption {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    thinkingLevels: [...getSupportedThinkingLevels(model)],
    // Reported per model, not per provider: one provider can mix wire APIs, and
    // a run must be able to say which protocol it actually used.
    api: model.api ?? null
  }
}

function truncate(value: string | null, limit: number): string | null {
  if (value === null) return null
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}
