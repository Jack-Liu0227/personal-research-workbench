import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import type { AgentCredentialBridge } from '../index.js'

const providerChains = new Map<string, Promise<unknown>>()
export interface AppCredentialStoreOptions {
  readonly scopeKey?: string
  readonly readLatest?: (providerId: string) => Promise<Credential | null>
}

/**
 * Pi's `CredentialStore`, backed by Electron Main's `safeStorage` vault.
 *
 * The SDK states the contract this class has to honour, and each clause maps to
 * something the workbench genuinely needs:
 *
 *  - `modify` is the *only* write path, and it is serialized per provider. Pi
 *    runs OAuth refresh inside `modify`, so two concurrent runs sharing a
 *    rotating refresh token cannot both refresh it.
 *  - `read` is for display/status and may return an expired credential.
 *  - `list` must not execute configured API-key commands. Ours only reports
 *    what Main already has, so no command exists to execute.
 *  - `delete` is the logout path and must be serialized against `modify`.
 *
 * Every mutation is written through `AgentCredentialBridge.persist` and only
 * resolves after Main acknowledged it. A rejected write therefore aborts the
 * login or refresh instead of leaving the SDK and the vault disagreeing about
 * which credential is current.
 *
 * Instances are cheap and hold a memoized snapshot, so callers create one per
 * run (or per login dialog) rather than sharing a long-lived cache that would
 * go stale when Settings saves a key from another process.
 */
export class AppCredentialStore implements CredentialStore {
  private readonly credentials = new Map<string, Credential>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private hydrated: Promise<void> | null = null

  constructor(private readonly bridge: AgentCredentialBridge, private readonly options: AppCredentialStoreOptions = {}) {}

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted()
    await this.hydrate()
    return this.credentials.get(providerId)
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted()
    await this.hydrate()
    return [...this.credentials].map(([providerId, credential]) => ({ providerId, type: credential.type }))
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted()
    await this.hydrate()
    return this.enqueue(providerId, async () => {
      options?.signal?.throwIfAborted()
      if (this.options.readLatest) {
        const latest = await this.options.readLatest(providerId)
        options?.signal?.throwIfAborted()
        if (latest) this.credentials.set(providerId, latest)
        else this.credentials.delete(providerId)
      }
      const current = this.credentials.get(providerId)
      const next = await fn(current)
      options?.signal?.throwIfAborted()
      // `undefined` means "leave the entry unchanged" in Pi's contract; an
      // explicit deletion goes through `delete`.
      if (next === undefined) return current
      await this.bridge.persist(providerId, next)
      this.credentials.set(providerId, next)
      return next
    })
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted()
    await this.hydrate()
    await this.enqueue(providerId, async () => {
      options?.signal?.throwIfAborted()
      await this.bridge.persist(providerId, null)
      this.credentials.delete(providerId)
      return undefined
    })
  }

  private hydrate(): Promise<void> {
    this.hydrated ??= (async () => {
      for (const entry of await this.bridge.list()) this.credentials.set(entry.provider, entry.credential)
    })()
    return this.hydrated
  }

  /** Serialize per provider without releasing the chain before active work
   * settles, so a queued refresh always observes the previous write. */
  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const sharedKey = this.options.scopeKey === undefined ? null : `${this.options.scopeKey}\u0000${providerId}`
    const chains = sharedKey === null ? this.chains : providerChains
    const key = sharedKey ?? providerId
    const previous = chains.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    const settled = next.then(() => undefined, () => undefined)
    chains.set(key, settled)
    void settled.then(() => { if (chains.get(key) === settled) chains.delete(key) })
    return next
  }
}
