import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createAuthInteraction, preferredSelectAnswer, toAgentAuthEvent } from '../src/pi/auth-flow.js'
import type { AgentAuthChannel, AgentAuthPromptRequest } from '../src/index.js'
import type { AgentAuthEvent } from '@prw/contracts'
import type { AuthEvent } from '@earendil-works/pi-ai'

describe('Pi auth event bridge', () => {
  it('preserves browser and device-code destinations for the host opener', () => {
    const authUrl = toAgentAuthEvent('login-1', { type: 'auth_url', url: 'https://auth.example.com/start', instructions: 'Open in browser' } as AuthEvent)
    assert.deepEqual(authUrl, { kind: 'auth_url', loginId: 'login-1', url: 'https://auth.example.com/start', instructions: 'Open in browser' })
    const device = toAgentAuthEvent('login-1', { type: 'device_code', userCode: 'ABCD', verificationUri: 'https://auth.example.com/device', expiresInSeconds: 600 } as AuthEvent)
    assert.deepEqual(device, { kind: 'device_code', loginId: 'login-1', userCode: 'ABCD', verificationUri: 'https://auth.example.com/device', expiresInSeconds: 600 })
  })
})

describe('sign-in method selection', () => {
  const options = [
    { id: 'device_code', label: 'Device code login (headless)' },
    { id: 'browser', label: 'Browser login (default)' }
  ]

  it('prefers the browser flow when a provider offers both', () => {
    assert.equal(preferredSelectAnswer(options)?.id, 'browser')
  })

  it('prefers a default or recommended label over mere position', () => {
    assert.equal(preferredSelectAnswer([
      { id: 'device_code', label: 'Device code' },
      { id: 'api_paste', label: 'Paste a token (recommended)' }
    ])?.id, 'api_paste')
    assert.equal(preferredSelectAnswer([{ id: 'device_code', label: 'Device code (default)' }])?.id, 'device_code')
  })

  it('falls back to the first usable option', () => {
    assert.equal(preferredSelectAnswer([{ id: 'first', label: 'First' }, { id: 'second', label: 'Second' }])?.id, 'first')
  })

  it('returns nothing when no option can be answered', () => {
    assert.equal(preferredSelectAnswer([]), null)
    assert.equal(preferredSelectAnswer([{ id: '  ', label: 'blank id' }]), null)
  })

  it('answers a select in code so the renderer never shows a second dialog', async () => {
    const pushed: AgentAuthEvent[] = []
    const asked: AgentAuthPromptRequest[] = []
    const channel: AgentAuthChannel = {
      push: (event) => { pushed.push(event) },
      prompt: async (request) => { asked.push(request); return 'renderer-answer' }
    }
    const interaction = createAuthInteraction(channel, 'login-1', new AbortController().signal)
    const answer = await interaction.prompt({ type: 'select', message: 'How do you want to sign in?', options })
    assert.equal(answer, 'browser')
    assert.equal(asked.length, 0, 'a select with options must not be sent to the renderer')
    assert.equal(pushed.length, 1)
    assert.equal(pushed[0]?.kind, 'info')
    assert.match((pushed[0] as { message: string }).message, /Browser login/)
  })

  it('still asks the renderer when a select has no usable option', async () => {
    const pushed: AgentAuthEvent[] = []
    const asked: AgentAuthPromptRequest[] = []
    const channel: AgentAuthChannel = {
      push: (event) => { pushed.push(event) },
      prompt: async (request) => { asked.push(request); return 'renderer-answer' }
    }
    const interaction = createAuthInteraction(channel, 'login-1', new AbortController().signal)
    const answer = await interaction.prompt({ type: 'select', message: 'Pick', options: [] })
    assert.equal(answer, 'renderer-answer')
    assert.equal(pushed.length, 0, 'an unanswerable select is not announced as an automatic choice')
    assert.equal(asked.length, 1)
    assert.equal(asked[0]?.kind, 'select')
    assert.deepEqual(asked[0]?.options, [])
  })

  it('sends text and secret prompts to the renderer unchanged', async () => {
    const asked: AgentAuthPromptRequest[] = []
    const channel: AgentAuthChannel = {
      push: () => undefined,
      prompt: async (request) => { asked.push(request); return 'typed' }
    }
    const interaction = createAuthInteraction(channel, 'login-1', new AbortController().signal)
    assert.equal(await interaction.prompt({ type: 'secret', message: 'API key' }), 'typed')
    assert.equal(asked[0]?.kind, 'secret')
    assert.deepEqual(asked[0]?.options, [])
  })
})
