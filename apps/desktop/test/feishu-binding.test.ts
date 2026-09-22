import { createServer as createNetServer } from 'node:net'
import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FeishuBindingController } from '../src/main/feishu-binding.js'

/**
 * Feishu binding controller unit tests. The controller is dependency-injected
 * (vault / openExternal / fetchImpl / port / now) so the whole OAuth state
 * machine runs against a recording double in plain node — no Electron, no real
 * Feishu API.
 */

class MemoryVault {
  readonly map = new Map<string, string>()

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response
}

interface ApiCall {
  url: string
  init?: RequestInit
}

function mockFeishuApi(overrides: { sendCode?: number; sendMsg?: string } = {}) {
  const calls: ApiCall[] = []
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init })
    if (url.includes('/auth/v3/tenant_access_token/internal')) {
      return jsonResponse(200, { code: 0, msg: 'ok', tenant_access_token: 'tt-test' })
    }
    if (url.includes('/authen/v1/oidc/access_token')) {
      return jsonResponse(200, {
        code: 0,
        msg: 'ok',
        data: { access_token: 'uat-test', refresh_token: 'urt-test', expires_in: 7200, refresh_expires_in: 2_592_000, scope: 'contact:user.base:readonly' }
      })
    }
    if (url.includes('/authen/v1/user_info')) {
      return jsonResponse(200, { code: 0, msg: 'ok', data: { open_id: 'ou_test_user', name: '测试用户' } })
    }
    if (url.includes('/im/v1/messages')) {
      return jsonResponse(200, { code: overrides.sendCode ?? 0, msg: overrides.sendMsg ?? 'success' })
    }
    return jsonResponse(404, { code: -1, msg: `unexpected url ${url}` })
  }
  return { calls, fetchImpl }
}

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function createController() {
  const vault = new MemoryVault()
  const opened: string[] = []
  const api = mockFeishuApi()
  const port = await freePort()
  const controller = new FeishuBindingController({
    vault,
    port,
    openExternal: async (url) => { opened.push(url) },
    fetchImpl: api.fetchImpl,
    now: () => new Date('2026-09-20T08:00:00.000Z')
  })
  return { vault, opened, api, port, controller }
}

describe('FeishuBindingController', () => {
  let ctx: Awaited<ReturnType<typeof createController>> | null = null

  beforeEach(async () => {
    ctx = await createController()
  })

  afterEach(async () => {
    // Close the local callback server between tests so ports are released.
    if (ctx) await ctx.controller.unbind().catch(() => undefined)
    ctx = null
  })

  test('unconfigured status explains the next step', async () => {
    const status = await ctx!.controller.getStatus()
    assert.equal(status.bound, false)
    assert.equal(status.appId, null)
    assert.match(status.message, /未配置/)
  })

  test('saveApp stores credentials and never echoes the secret', async () => {
    const status = await ctx!.controller.saveApp({ appId: 'cli_test', appSecret: 's3cret' })
    assert.equal(status.bound, false)
    assert.equal(status.appId, 'cli_test')
    assert.doesNotMatch(JSON.stringify(status), /s3cret/)
    assert.match(status.message, /已保存应用凭据/)
    const raw = ctx!.vault.map.get('v2:integration:feishu.app_secret')
    assert.equal(raw, 's3cret')
  })

  test('beginBind without credentials fails with a helpful message', async () => {
    const result = await ctx!.controller.beginBind()
    assert.equal(result.ok, false)
    assert.match(result.message, /App ID/)
  })

  test('beginBind opens the authorize URL with state and redirect', async () => {
    await ctx!.controller.saveApp({ appId: 'cli_test', appSecret: 's3cret' })
    const result = await ctx!.controller.beginBind()
    assert.equal(result.ok, true)
    assert.equal(ctx!.opened.length, 1)
    const url = new URL(ctx!.opened[0])
    assert.equal(url.hostname, 'open.feishu.cn')
    assert.equal(url.searchParams.get('app_id'), 'cli_test')
    assert.equal(url.searchParams.get('redirect_uri'), `http://127.0.0.1:${ctx!.port}/feishu/callback`)
    assert.equal(url.searchParams.get('scope'), 'contact:user.base:readonly')
    assert.ok(url.searchParams.get('state'))
    // Concurrent binds are rejected.
    const second = await ctx!.controller.beginBind()
    assert.equal(second.ok, false)
  })

  test('full callback flow binds the user and stores tokens in the vault', async () => {
    await ctx!.controller.saveApp({ appId: 'cli_test', appSecret: 's3cret' })
    await ctx!.controller.beginBind()
    const state = new URL(ctx!.opened[0]).searchParams.get('state')!
    const response = await fetch(`http://127.0.0.1:${ctx!.port}/feishu/callback?code=the-code&state=${state}`)
    const html = await response.text()
    assert.match(html, /绑定成功/)
    assert.match(html, /测试用户/)

    const status = await ctx!.controller.getStatus()
    assert.equal(status.bound, true)
    assert.equal(status.boundUserOpenId, 'ou_test_user')
    assert.equal(status.boundUserName, '测试用户')
    assert.ok(status.expiresAt)
    // Token pair landed in the vault, profile too.
    assert.ok(ctx!.vault.map.get('v2:integration:feishu.user_tokens')?.includes('uat-test'))
    assert.ok(ctx!.vault.map.get('v2:integration:feishu.profile')?.includes('ou_test_user'))
  })

  test('callback with a wrong state is rejected', async () => {
    await ctx!.controller.saveApp({ appId: 'cli_test', appSecret: 's3cret' })
    await ctx!.controller.beginBind()
    const response = await fetch(`http://127.0.0.1:${ctx!.port}/feishu/callback?code=the-code&state=forged-state`)
    const html = await response.text()
    assert.match(html, /绑定失败/)
    assert.match(html, /state/)
    const status = await ctx!.controller.getStatus()
    assert.equal(status.bound, false)
  })

  test('sendTest delivers a message to the bound open_id', async () => {
    await ctx!.controller.saveApp({ appId: 'cli_test', appSecret: 's3cret' })
    await ctx!.controller.beginBind()
    const state = new URL(ctx!.opened[0]).searchParams.get('state')!
    await fetch(`http://127.0.0.1:${ctx!.port}/feishu/callback?code=the-code&state=${state}`)

    const result = await ctx!.controller.sendTest()
    assert.equal(result.ok, true)
    assert.match(result.message, /已发送给 测试用户/)

    const messageCall = ctx!.api.calls.find((call) => call.url.includes('/im/v1/messages'))
    assert.ok(messageCall, 'expected an im/v1/messages call')
    const body = JSON.parse(String(messageCall!.init?.body)) as { receive_id: string; msg_type: string; content: string }
    assert.equal(body.receive_id, 'ou_test_user')
    assert.equal(body.msg_type, 'text')
    assert.match(JSON.parse(body.content).text, /绑定成功/)
  })

  test('sendTest surfaces a structured Feishu API error', async () => {
    ctx = await createControllerWithSendError()
    await ctx.controller.saveApp({ appId: 'cli_test', appSecret: 's3cret' })
    await ctx.controller.beginBind()
    const state = new URL(ctx.opened[0]).searchParams.get('state')!
    await fetch(`http://127.0.0.1:${ctx.port}/feishu/callback?code=the-code&state=${state}`)

    const result = await ctx.controller.sendTest()
    assert.equal(result.ok, false)
    assert.match(result.message, /code 1/)
    assert.match(result.message, /权限/)
  })

  test('unbind clears vault and stops the server', async () => {
    await ctx!.controller.saveApp({ appId: 'cli_test', appSecret: 's3cret' })
    await ctx!.controller.beginBind()
    const state = new URL(ctx!.opened[0]).searchParams.get('state')!
    await fetch(`http://127.0.0.1:${ctx!.port}/feishu/callback?code=the-code&state=${state}`)
    assert.equal((await ctx!.controller.getStatus()).bound, true)

    const status = await ctx!.controller.unbind()
    assert.equal(status.bound, false)
    assert.equal(ctx!.vault.map.size, 0)
    assert.match(status.message, /未配置/)
  })
})

async function createControllerWithSendError() {
  const vault = new MemoryVault()
  const opened: string[] = []
  const api = mockFeishuApi({ sendCode: 1, sendMsg: 'permission denied' })
  const port = await freePort()
  const controller = new FeishuBindingController({
    vault,
    port,
    openExternal: async (url) => { opened.push(url) },
    fetchImpl: api.fetchImpl,
    now: () => new Date('2026-09-20T08:00:00.000Z')
  })
  return { vault, opened, api, port, controller }
}
