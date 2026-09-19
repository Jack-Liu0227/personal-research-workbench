import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { PiModelCatalog, type AgentAuthChannel, type AgentAuthEvent, type AgentCredentialBridge } from '../src/index.js'

/**
 * Real-SDK coverage for the interactive login half of the contract.
 *
 * The question these cases answer is "does Pi actually produce the event the
 * Main process turns into `shell.openExternal`?", which a stubbed runtime cannot
 * answer. Every flow is cancelled as soon as its destination is observed, so no
 * code exchange and no real credential are ever produced.
 *
 * Two outcomes are accepted per provider, and both are deliberate:
 *
 *  - the flow hands out a browser/device destination, which is what the
 *    automatic `shell.openExternal` depends on; or
 *  - the flow fails with a transport error, which providers that must register a
 *    device code server-side legitimately do on a machine without egress.
 *
 * What is never accepted is silence: a provider that neither announces a page
 * nor reports a failure would park a login dialog forever, which is exactly the
 * "clicked login, nothing happened" state this suite exists to prevent.
 */

const roots: string[] = []

function temporaryProfile(): string {
  const root = mkdtempSync(join(tmpdir(), 'prw-login-'))
  roots.push(root)
  const profileDir = join(root, 'pi')
  mkdirSync(profileDir, { recursive: true })
  return profileDir
}

const emptyBridge: AgentCredentialBridge = {
  read: () => null as ReturnType<AgentCredentialBridge['read']>,
  list: () => [],
  persist: async () => undefined
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('interactive login through the embedded SDK', () => {
  it('announces a destination or a real failure for every OAuth provider', async () => {
    const catalog = new PiModelCatalog(temporaryProfile(), emptyBridge)
    const oauthProviders = (await catalog.list()).filter((entry) => entry.authTypes.includes('oauth'))
    assert.ok(oauthProviders.length > 0, 'the catalog must expose at least one OAuth provider')

    let announced = 0
    // A select that reaches the channel is the bug this suite now guards: the
    // interaction is supposed to pick the method itself so no second dialog
    // stands between the click and the browser.
    const promptsSeen: string[] = []
    let autoAnswered = 0
    for (const entry of oauthProviders) {
      const events: AgentAuthEvent[] = []
      const abort = new AbortController()
      const channel: AgentAuthChannel = {
        push: (event) => {
          events.push(event)
          if (event.kind === 'info' && event.message.includes('已自动选择')) autoAnswered += 1
          // The flow is only interesting up to the point where the user is told
          // where to go; continuing would attempt a real code exchange.
          if (event.kind === 'auth_url' || event.kind === 'device_code') abort.abort()
        },
        // A real user answers these. Keeping the answers permissive means a
        // prompt that should not exist shows up in `promptsSeen` instead of
        // failing the login for an unrelated reason.
        prompt: (request) => {
          promptsSeen.push(`${entry.provider}:${request.kind}`)
          if (request.kind === 'secret') {
            abort.abort()
            return Promise.reject(new Error('no secret is available in this test'))
          }
          return Promise.resolve(request.options[0]?.value ?? '')
        }
      }
      const outcome = await Promise.race([
        catalog.login(entry.provider, 'oauth', channel, 'test-login', abort.signal)
          .then(() => 'done', (error: unknown) => `failed:${error instanceof Error ? error.message : String(error)}`),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20_000).unref())
      ])
      assert.notEqual(outcome, 'timeout', `${entry.provider} neither reported a destination nor unwound`)

      const destination = events.find((event) => event.kind === 'auth_url' || event.kind === 'device_code')
      if (!destination) {
        assert.match(outcome, /^failed:/u, `${entry.provider} produced no destination and no failure`)
        continue
      }
      announced += 1
      if (destination.kind === 'auth_url') {
        assert.match(destination.url, /^https:\/\//u, `${entry.provider} must hand out an https destination`)
      } else {
        assert.match(destination.verificationUri, /^https:\/\//u, `${entry.provider} must hand out an https verification page`)
        assert.ok(destination.userCode.length > 0, `${entry.provider} must hand out a device code`)
      }
    }
    assert.ok(announced > 0, 'no OAuth provider announced a destination, so the automatic browser open can never fire')
    assert.deepEqual(
      promptsSeen.filter((entry) => entry.endsWith(':select')),
      [],
      'a sign-in method select must be answered inside the interaction, not in the renderer'
    )
    assert.ok(autoAnswered > 0, 'no OAuth provider reported which sign-in method was chosen')
  })

  it('reports an api-key provider through a prompt instead of a URL', async () => {
    const catalog = new PiModelCatalog(temporaryProfile(), emptyBridge)
    const apiKeyProviders = (await catalog.list()).filter((entry) => entry.authTypes.includes('api_key') && !entry.authTypes.includes('oauth'))
    assert.ok(apiKeyProviders.length > 0, 'the catalog must expose at least one api-key-only provider')

    const events: AgentAuthEvent[] = []
    const prompts: string[] = []
    const abort = new AbortController()
    const channel: AgentAuthChannel = {
      push: (event) => { events.push(event) },
      prompt: (request) => {
        prompts.push(request.kind)
        abort.abort()
        return Promise.reject(new Error('cancelled by test'))
      }
    }
    await catalog.login(apiKeyProviders[0]!.provider, 'api_key', channel, 'test-login', abort.signal).catch(() => undefined)

    assert.equal(events.some((event) => event.kind === 'auth_url' || event.kind === 'device_code'), false)
    assert.ok(prompts.length > 0, 'an interactive api-key flow must ask through a prompt')
  })
})
