import type { AgentRuntimeKind } from '@prw/contracts'

/**
 * Runtime support shared by the adapter, the loader and the composition root.
 *
 * These live apart from the package index so the adapter can use them without a
 * runtime import cycle back through the index (which also re-exports the
 * adapter).
 */

export class EventQueue<T> {
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

/**
 * Point the embedded SDK at the app-owned profile directory.
 *
 * `PI_CODING_AGENT_DIR` is read by `getAgentDir()`, which every default path in
 * the SDK derives from (`auth.json`, `models.json`, `settings.json`, sessions,
 * tools, themes, prompts, the debug log). Setting it before the SDK module is
 * loaded is therefore the single guard that keeps `~/.pi` out of the process.
 */
export function isolatedRuntimeEnvironment(kind: AgentRuntimeKind, profileDir: string): Record<string, string> {
  if (kind !== 'pi') throw new Error(`unsupported agent runtime kind: ${kind}`)
  if (profileDir.trim().length === 0) throw new Error('agent runtime profile directory is required')
  // Pi's OpenAI Codex OAuth provider listens on the callback port using this
  // host, while the redirect URI is `http://localhost:1455/auth/callback`.
  // Binding only to 127.0.0.1 is unreliable on Windows: browsers commonly
  // resolve localhost to ::1 first and the callback page then reports success
  // without ever reaching the waiting login coroutine. Keep the SDK's
  // callback listener and redirect URI on the same localhost resolution.
  return { PI_CODING_AGENT_DIR: profileDir, PI_OAUTH_CALLBACK_HOST: 'localhost' }
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
