import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AppCredentialStore, type AgentCredentialBridge } from '../src/index.js'
import type { Credential } from '@earendil-works/pi-ai'

test('two assistant credential stores serialize provider refresh and reread the latest Main value', async () => {
  let current: Credential | null = { type: 'api_key', key: 'fixture-v1' }
  const writes: string[] = []
  const reads: string[] = []
  const bridge: AgentCredentialBridge = {
    read: async () => current,
    list: async () => current ? [{ provider: 'fixture-provider', credential: current }] : [],
    persist: async (_provider, next) => {
      await new Promise((resolve) => setTimeout(resolve, 2))
      current = next
      writes.push((next as { key: string } | null)?.key ?? 'deleted')
    }
  }
  const options = { scopeKey: 'fixture-app-owned-profile', readLatest: async () => current }
  const a = new AppCredentialStore(bridge, options)
  const b = new AppCredentialStore(bridge, options)
  await Promise.all([a.read('fixture-provider'), b.read('fixture-provider')])
  await Promise.all([
    a.modify('fixture-provider', async (credential) => {
      reads.push((credential as { key: string }).key)
      await new Promise((resolve) => setTimeout(resolve, 2))
      return { type: 'api_key', key: 'fixture-v2' }
    }),
    b.modify('fixture-provider', async (credential) => {
      reads.push((credential as { key: string }).key)
      return { type: 'api_key', key: 'fixture-v3' }
    })
  ])
  assert.deepEqual(reads, ['fixture-v1', 'fixture-v2'])
  assert.deepEqual(writes, ['fixture-v2', 'fixture-v3'])
})

test('a logout queued across stores is visible to a later refresh, and cancellation prevents persistence', async () => {
  let current: Credential | null = { type: 'api_key', key: 'fixture-v1' }
  let writes = 0
  const bridge: AgentCredentialBridge = {
    read: async () => current,
    list: async () => current ? [{ provider: 'fixture-provider', credential: current }] : [],
    persist: async (_provider, next) => { writes++; current = next }
  }
  const options = { scopeKey: 'fixture-logout-profile', readLatest: async () => current }
  const a = new AppCredentialStore(bridge, options)
  const b = new AppCredentialStore(bridge, options)
  await Promise.all([a.read('fixture-provider'), b.read('fixture-provider')])
  const logout = a.delete('fixture-provider')
  const refresh = b.modify('fixture-provider', async (credential) => {
    assert.equal(credential, undefined)
    return undefined
  })
  await Promise.all([logout, refresh])
  assert.equal(writes, 1)
  const controller = new AbortController()
  await assert.rejects(b.modify('fixture-provider', async () => {
    controller.abort()
    return { type: 'api_key', key: 'fixture-never-written' }
  }, { signal: controller.signal }))
  assert.equal(writes, 1)
})
