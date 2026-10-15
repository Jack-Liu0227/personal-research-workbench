/* Real Renderer / typed Preload / Core / pinned Pi SDK against loopback HTTP
 * fixtures. No bridge mocks, direct database edits, or real provider keys.
 * Run only after the production build and Electron native ABI are serialized. */
const { _electron: electron } = require('playwright-core')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const main = path.join(root, 'apps/desktop/out/main/index.cjs')
const executablePath = process.env.PRW_ELECTRON || path.join(root, 'node_modules/.pnpm/electron@43.4.1/node_modules/electron/dist/electron.exe')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'prw-agent-resources-e2e-'))
const fixtureToken = 'fixture-not-a-real-mcp-credential'
const errors = []
const evidence = { profile, installedNsis: false, realProviderCalls: false, loopbackSdkFixture: true, workflows: [], screenshots: [], controls: [] }
let app
let page
let acceptDialog = true
let remote
let model

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return server.address().port
}

async function fixtures() {
  // A stateless Streamable HTTP endpoint exercises the actual MCP client.
  const mcp = { available: false, calls: [], authenticated: 0, requireToken: false }
  mcp.server = createServer((request, response) => {
    if (!mcp.available) { response.writeHead(503).end(); return }
    if (request.headers.authorization === `Bearer ${fixtureToken}`) mcp.authenticated++
    else if (mcp.requireToken) { response.writeHead(401).end(); return }
    if (request.method === 'GET') { response.writeHead(405).end(); return }
    if (request.method === 'DELETE') { response.writeHead(204).end(); return }
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      try {
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (message.id === undefined) { response.writeHead(202).end(); return }
        let result
        if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'Local UI fixture', version: '1' } }
        else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Local UI fixture echo, requires explicit human approval', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] }
        else if (message.method === 'tools/call') {
          mcp.calls.push(message.params)
          result = { content: [{ type: 'text', text: `<b data-fixture-result="unsafe">${message.params.arguments.text}</b>` }] }
        } else if (message.method === 'ping') result = {}
        else { response.writeHead(400).end(); return }
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
      } catch { response.writeHead(400).end('Invalid local MCP fixture request') }
    })
  })
  mcp.endpoint = `http://127.0.0.1:${await listen(mcp.server)}/mcp`
  const sdk = { requests: [], holds: new Set() }
  sdk.server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        // Only retain non-secret assertions; never retain headers or key data.
        sdk.requests.push({ model: payload.model, names: (payload.tools || []).map((tool) => tool.function.name), system: payload.messages.find((message) => message.role === 'system')?.content })
        const lastUserIndex = payload.messages.findLastIndex((message) => message.role === 'user')
        const lastUser = JSON.stringify(payload.messages[lastUserIndex]?.content)
        const returnedTool = payload.messages.slice(lastUserIndex + 1).some((message) => message.role === 'tool')
        const tool = (payload.tools || []).find((entry) => entry.function.name.startsWith('mcp_'))
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const chunk = { id: 'local-resource-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model' }
        const send = (delta, finish_reason) => response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
        if (tool && !returnedTool) {
          send({ role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-call', type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ text: 'fixture payload' }) } }] }, null)
          send({}, 'tool_calls')
        } else if (lastUser.includes('fixture-cancel')) {
          // Keep the real SDK turn alive after a pending request so cancellation
          // can invalidate it before a human approval (no model simulation IPC).
          sdk.holds.add(response)
          const timer = setTimeout(() => { if (!response.destroyed) { send({ role: 'assistant', content: 'Fixture hold ended' }, null); send({}, 'stop'); response.end('data: [DONE]\n\n') } }, 30_000)
          response.on('close', () => { clearTimeout(timer); sdk.holds.delete(response) })
          return
        } else { send({ role: 'assistant', content: 'Local fixture finished; remote execution requires human approval.' }, null); send({}, 'stop') }
        response.end('data: [DONE]\n\n')
      } catch { response.destroy() }
    })
  })
  sdk.baseUrl = `http://127.0.0.1:${await listen(sdk.server)}/v1`
  return { mcp, sdk }
}

async function launch() {
  const env = { ...process.env }
  delete env.OBSIDIAN_DIR
  delete env.ELECTRON_RENDERER_URL
  delete env.PRW_E2E_USER_DATA
  app = await electron.launch({ executablePath, args: [main, `--prw-user-data-dir=${profile}`], cwd: profile, env, timeout: 90_000 })
  page = await app.firstWindow({ timeout: 90_000 })
  page.setDefaultTimeout(25_000)
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('dialog', async (dialog) => { if (acceptDialog) await dialog.accept(); else await dialog.dismiss() })
  await page.locator('.sidebar .nav-item[title="设置"]').waitFor()
  assert(page.url().startsWith('workbench://app/'))
  assert.deepEqual(await page.evaluate(() => ({ node: typeof process, require: typeof require, ipc: typeof window.ipcRenderer })), { node: 'undefined', require: 'undefined', ipc: 'undefined' })
}

async function nav(label) {
  const item = page.locator(`.sidebar .nav-item[title="${label}"]`).first()
  if (!(await item.isVisible())) await page.locator('button[aria-controls="sidebar-research-nav"]').click()
  await item.click()
}
async function tab(label) {
  const section = page.getByRole('navigation', { name: '设置分区侧边栏', exact: true }).getByRole('button', { name: label, exact: true })
  if (!(await section.isVisible())) await page.getByRole('button', { name: '展开设置分区侧边栏', exact: true }).click()
  await section.click()
}
async function manager(kind) {
  await nav('设置')
  await tab(kind === 'mcp' ? '工具与 MCP 绑定' : '技能绑定')
  await page.getByRole('button', { name: kind === 'mcp' ? 'MCP 服务器' : '管理指令技能', exact: true }).click()
}
async function truth(fn, argument, message = 'Expected persisted state did not arrive') {
  const deadline = Date.now() + 35_000
  while (Date.now() < deadline) {
    const result = await page.evaluate(fn, argument)
    if (result) return result
    await page.waitForTimeout(100)
  }
  throw new Error(message)
}
async function getServer(id) { return page.evaluate(async (id) => (await window.workbench.v2.agentMcpServers.list()).find((entry) => entry.id === id), id) }
async function getSkill(id) { return page.evaluate((id) => window.workbench.v2.agentInstructionSkills.get(id), id) }
async function getAssistant(id) { return page.evaluate(async (id) => (await window.workbench.v2.assistants.list()).find((entry) => entry.id === id), id) }
async function saveServer(id) {
  const previous = id ? await getServer(id) : null
  await page.getByRole('button', { name: '保存 MCP 服务器', exact: true }).click()
  const saved = await truth(async ({ id, revision }) => (await window.workbench.v2.agentMcpServers.list()).find((server) => server.id === id && server.revision > revision), { id: id || await page.getByLabel('MCP 服务器 ID', { exact: true }).inputValue(), revision: previous?.revision ?? -1 })
  await page.getByText('服务器配置已保存；旧凭据与探测已失效，请按需重新保存 Bearer 凭据并探测。', { exact: true }).waitFor()
  return saved
}
async function probeServer(id, expected) {
  await page.getByRole('button', { name: '探测 MCP 服务器', exact: true }).click()
  await page.getByText(expected === 'ok' ? 'MCP 探测通过；工具目录已更新，调用仍需逐次确认。' : 'MCP 探测失败，未标记为已连接。请检查下方诊断。', { exact: true }).waitFor()
  const server = await getServer(id)
  assert.equal(server.lastProbe.status, expected)
  return server
}
async function saveSkill(id) {
  const previous = id ? await getSkill(id) : null
  const identity = id || await page.getByLabel('指令技能 ID', { exact: true }).inputValue()
  await page.getByRole('button', { name: '已审阅，保存指令技能', exact: true }).click()
  const saved = await truth(async ({ id, revision }) => (await window.workbench.v2.agentInstructionSkills.list()).find((skill) => skill.id === id && skill.revision > revision), { id: identity, revision: previous?.revision ?? -1 })
  await page.locator('.agent-resource-manager .form-feedback-success').waitFor()
  return saved
}

async function mcpCrud() {
  await manager('mcp')
  await page.getByRole('button', { name: '添加 MCP 服务器', exact: true }).click()
  const id = await page.getByLabel('MCP 服务器 ID', { exact: true }).inputValue()
  await page.getByLabel('MCP 服务器名称', { exact: true }).fill('Loopback UI MCP')
  await page.getByLabel('MCP HTTP 端点', { exact: true }).fill('file:///not-an-endpoint')
  await page.getByRole('button', { name: '保存 MCP 服务器', exact: true }).click()
  await page.locator('.agent-resource-manager [role="alert"]').waitFor()
  assert.equal(await getServer(id), undefined, 'Invalid transport crossed the real IPC boundary')
  await page.getByLabel('MCP HTTP 端点', { exact: true }).fill(remote.endpoint)
  let server = await saveServer()
  assert.equal(server.lastProbe, null)
  assert.deepEqual(server.tools, [])
  await probeServer(id, 'failed')
  remote.available = true
  server = await probeServer(id, 'ok')
  assert.equal(server.tools[0].name, 'echo')
  assert.equal(server.tools.length, 1)
  assert.equal(remote.calls.length, 0, 'Probe executed the tool')
  const revisionBeforeCredential = server.revision
  const token = page.getByLabel('MCP Bearer Token', { exact: true })
  assert.equal(await token.getAttribute('type'), 'password')
  await token.fill(fixtureToken)
  await page.getByRole('button', { name: '保存 MCP 凭据', exact: true }).click()
  await truth(async (id) => (await window.workbench.v2.agentMcpServers.list()).find((entry) => entry.id === id)?.credentialPresent, id)
  await page.getByText('凭据状态已更新；请重新探测，输入已清空且不会回显。', { exact: true }).waitFor()
  assert.equal(await token.inputValue(), '')
  assert(!(await page.locator('body').innerText()).includes(fixtureToken), 'Credential was echoed into text')
  server = await getServer(id)
  assert(server.revision > revisionBeforeCredential && server.lastProbe === null && server.tools.length === 0)
  assert(!JSON.stringify(server).includes(fixtureToken), 'Credential leaked through read DTO')
  remote.requireToken = true
  await probeServer(id, 'ok')
  assert(remote.authenticated > 0, 'Probe did not use the separately stored bearer')
  await page.getByRole('button', { name: '清除 MCP 凭据', exact: true }).click()
  await truth(async (id) => !(await window.workbench.v2.agentMcpServers.list()).find((entry) => entry.id === id).credentialPresent, id)
  await page.getByText('凭据状态已更新；请重新探测，输入已清空且不会回显。', { exact: true }).waitFor()
  await probeServer(id, 'failed')
  remote.requireToken = false
  await probeServer(id, 'ok')

  await page.getByLabel('MCP 服务器名称', { exact: true }).fill('Uncommitted MCP draft')
  acceptDialog = false
  await page.getByRole('button', { name: '重新载入服务器', exact: true }).click()
  assert.equal(await page.getByLabel('MCP 服务器名称', { exact: true }).inputValue(), 'Uncommitted MCP draft')
  await page.getByRole('button', { name: '跨助手矩阵', exact: true }).click()
  assert.equal(await page.getByLabel('MCP 服务器名称', { exact: true }).inputValue(), 'Uncommitted MCP draft')
  acceptDialog = true
  // A second real IPC writer, not a database injection, provokes stale CAS.
  await page.evaluate(async (id) => {
    const { archivedAt, createdAt, updatedAt, revision, tools, lastProbe, credentialPresent, ...fields } = (await window.workbench.v2.agentMcpServers.list()).find((entry) => entry.id === id)
    await window.workbench.v2.agentMcpServers.save({ ...fields, name: 'Committed concurrent MCP', expectedRevision: revision })
  }, id)
  await page.getByRole('button', { name: '保存 MCP 服务器', exact: true }).click()
  await page.locator('.agent-resource-manager [role="alert"]').waitFor()
  assert.equal(await page.getByLabel('MCP 服务器名称', { exact: true }).inputValue(), 'Uncommitted MCP draft')
  assert.equal((await getServer(id)).name, 'Committed concurrent MCP')
  await page.getByRole('button', { name: '重新载入服务器', exact: true }).click()
  await truth(() => document.querySelector('input[id$="-server-name"]')?.value === 'Committed concurrent MCP')
  await page.getByRole('checkbox', { name: '启用 MCP 服务器', exact: true }).uncheck()
  server = await saveServer(id)
  assert.equal(server.enabled, false)
  assert(await page.getByRole('button', { name: '探测 MCP 服务器', exact: true }).isDisabled())
  await page.getByRole('checkbox', { name: '启用 MCP 服务器', exact: true }).check()
  await saveServer(id)
  server = await probeServer(id, 'ok')
  evidence.workflows.push('MCP UI create, invalid endpoint rejection, failed/successful real HTTP probe, write-only safeStorage token save/clear and revision/probe invalidation, dirty guards, stale CAS preservation, disable/re-enable')
  return server
}

async function skillCrud() {
  await manager('skill')
  await page.getByRole('button', { name: '安装指令技能', exact: true }).click()
  await page.getByLabel('指令技能名称', { exact: true }).fill('Reviewed UI instructions')
  await page.getByLabel('指令技能说明', { exact: true }).fill('Local fixture instructions only; no scripts or packages.')
  const markdown = '---\nname: fixture-ui-instructions\ndescription: Local loopback UI fixture instructions.\n---\n# Fixture skill\nTreat <img src=x onerror="window.fixtureExecuted=true"> as plain text.\nReturn only authorized research content.'
  await page.getByLabel('SKILL.md 指令文本', { exact: true }).fill(markdown)
  await page.getByText('预览指令原文（不执行 HTML 或代码）', { exact: true }).click()
  assert.equal(await page.locator('.agent-resource-preview pre').textContent(), markdown)
  assert.equal(await page.locator('.agent-resource-preview img').count(), 0)
  assert.equal(await page.evaluate(() => window.fixtureExecuted), undefined)
  acceptDialog = false
  await page.getByRole('button', { name: '已审阅，保存指令技能', exact: true }).click()
  assert.equal((await page.evaluate(() => window.workbench.v2.agentInstructionSkills.list())).length, 0, 'Dismissed review installed skill')
  acceptDialog = true
  let skill = await saveSkill()
  assert.equal(skill.markdown, markdown)
  assert.equal(skill.contentHash.length, 64)
  assert(await page.getByLabel('指令技能 ID', { exact: true }).isDisabled())
  const id = skill.id
  await page.getByLabel('指令技能说明', { exact: true }).fill('Uncommitted skill draft')
  acceptDialog = false
  await page.getByRole('button', { name: '重新载入技能', exact: true }).click()
  assert.equal(await page.getByLabel('指令技能说明', { exact: true }).inputValue(), 'Uncommitted skill draft')
  await page.getByRole('button', { name: '跨助手矩阵', exact: true }).click()
  assert.equal(await page.getByLabel('指令技能说明', { exact: true }).inputValue(), 'Uncommitted skill draft')
  acceptDialog = true
  await page.evaluate(async (id) => {
    const { archivedAt, createdAt, updatedAt, revision, contentHash, ...fields } = await window.workbench.v2.agentInstructionSkills.get(id)
    await window.workbench.v2.agentInstructionSkills.save({ ...fields, name: 'Concurrent reviewed skill', expectedRevision: revision, confirmed: true })
  }, id)
  await page.getByRole('button', { name: '已审阅，保存指令技能', exact: true }).click()
  await page.locator('.agent-resource-manager [role="alert"]').waitFor()
  assert.equal(await page.getByLabel('指令技能说明', { exact: true }).inputValue(), 'Uncommitted skill draft')
  assert.equal((await getSkill(id)).name, 'Concurrent reviewed skill')
  await page.getByRole('button', { name: '重新载入技能', exact: true }).click()
  await truth(() => document.querySelector('input[id$="-skill-name"]')?.value === 'Concurrent reviewed skill')
  skill = await getSkill(id)
  evidence.workflows.push('Skill UI install with dismissible explicit content review, literal inert HTML preview, SQLite content hash, stable identity, dirty guards and stale CAS draft preservation')
  return skill
}

async function createAssistant(name, approved) {
  await nav('设置')
  await tab('AI 助手')
  await page.getByRole('button', { name: '新建助手', exact: true }).click()
  await page.getByLabel('助手名称', { exact: true }).fill(name)
  await page.getByLabel('用途说明', { exact: true }).fill('Loopback SDK fixture only')
  await page.getByLabel('系统指令', { exact: true }).fill('Use only the explicitly bound local fixture tool once per user turn.')
  await page.getByLabel('Provider', { exact: true }).selectOption('resource-fixture')
  await page.getByLabel('模型', { exact: true }).selectOption('fixture-model')
  await page.getByLabel('工具范围', { exact: true }).selectOption(approved ? 'approved-write' : 'read-only')
  await page.getByRole('button', { name: '保存助手', exact: true }).click()
  await page.getByText('助手已保存；下一次启动使用此版本。', { exact: true }).waitFor()
  return page.evaluate(async (name) => (await window.workbench.v2.assistants.list()).find((entry) => entry.name === name), name)
}
async function bind(kind, key, assistant, enabled) {
  await nav('设置')
  await tab(kind === 'tool' ? '工具与 MCP 绑定' : '技能绑定')
  await page.getByRole('button', { name: '跨助手矩阵', exact: true }).click()
  await page.getByLabel('查找绑定能力', { exact: true }).fill(key)
  const cell = page.getByRole('checkbox', { name: `绑定 ${assistant.id} ${key}`, exact: true })
  if (enabled) await cell.check(); else await cell.uncheck()
  await page.getByRole('button', { name: '保存矩阵', exact: true }).click()
  await page.getByText('矩阵已原子保存；下次运行使用新绑定，已有运行保持冻结快照。', { exact: true }).waitFor()
  const committed = await getAssistant(assistant.id)
  assert.equal(committed[kind === 'tool' ? 'toolAllowlist' : 'skillKeys'].includes(key), enabled)
  return committed
}

async function skillReauthorization(skill, assistant) {
  await bind('skill', skill.id, assistant, true)
  const bound = await getAssistant(assistant.id)
  await manager('skill')
  await page.getByLabel('选择指令技能', { exact: true }).selectOption(skill.id)
  await page.getByLabel('SKILL.md 指令文本', { exact: true }).fill(`${skill.markdown}\nNew reviewed instruction requires explicit reauthorization.`)
  const changed = await saveSkill(skill.id)
  assert.notEqual(changed.contentHash, skill.contentHash)
  const unbound = await getAssistant(assistant.id)
  assert(!unbound.skillKeys.includes(skill.id) && unbound.revision > bound.revision, 'Content update did not atomically revoke old assistant authorization')
  await page.getByRole('checkbox', { name: '启用指令技能', exact: true }).uncheck()
  await saveSkill(skill.id)
  const disabledCatalog = await page.evaluate(() => window.workbench.v2.agentBindings.catalog())
  assert(!disabledCatalog.skills.some((entry) => entry.key === skill.id))
  await page.getByRole('checkbox', { name: '启用指令技能', exact: true }).check()
  const enabled = await saveSkill(skill.id)
  assert(!(await getAssistant(assistant.id)).skillKeys.includes(skill.id), 'Enable silently rebound revoked skill')
  await bind('skill', skill.id, assistant, true)
  evidence.workflows.push('Skill content update atomically revokes assistant binding/revision; disable removes catalog availability; enable never silently rebinds; UI matrix explicit reauthorization persists')
  return enabled
}

async function turn(assistant, instruction, complete = true) {
  await nav('Agent')
  await page.getByLabel('Agent 运行方式', { exact: true }).selectOption('assistant')
  await page.getByLabel('助手', { exact: true }).selectOption(assistant.id)
  await page.getByLabel('发送给 Agent 的消息', { exact: true }).fill(instruction)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const run = await truth(async (instruction) => (await window.workbench.agent.runs.list({ page: { limit: 100 } })).find((entry) => entry.input.instructions === instruction), instruction)
  if (complete) await truth(async (id) => {
    const run = await window.workbench.agent.runs.get(id)
    if (['failed', 'blocked', 'canceled'].includes(run.status)) throw new Error(`Local SDK fixture run ${run.status}: ${run.error}`)
    return run.status === 'completed'
  }, run.id)
  const call = await truth(async (id) => (await window.workbench.v2.agentMcpCalls.list({ runId: id, limit: 100 })).find((entry) => entry.status === 'pending'), run.id)
  const card = page.locator(`[data-call-id="${call.id}"]`)
  await card.waitFor()
  assert.equal(await card.getByLabel('MCP 冻结参数', { exact: true }).textContent(), '{"text":"fixture payload"}')
  assert((await card.innerText()).includes(remote.endpoint))
  return { run, call, card }
}

async function approvals(assistant, skill) {
  const first = await turn(assistant, 'fixture-approve')
  assert.equal(remote.calls.length, 0, 'Pinned SDK executed external tool before approval')
  assert(model.requests.some((entry) => String(entry.system).includes(skill.markdown)), 'Reviewed bound skill did not reach actual SDK model request')
  const modelCount = model.requests.length
  acceptDialog = false
  await first.card.getByRole('button', { name: '批准 MCP 调用', exact: true }).click()
  assert.equal(remote.calls.length, 0, 'Dismissed approval executed remote call')
  acceptDialog = true
  await first.card.getByRole('button', { name: '批准 MCP 调用', exact: true }).click()
  await first.card.getByLabel('MCP 调用结果', { exact: true }).waitFor()
  assert.equal(remote.calls.length, 1)
  assert.deepEqual(remote.calls[0], { name: 'echo', arguments: { text: 'fixture payload' } })
  assert((await first.card.getByLabel('MCP 调用结果', { exact: true }).textContent()).includes('<b data-fixture-result="unsafe">fixture payload</b>'))
  assert.equal(await first.card.locator('b[data-fixture-result]').count(), 0, 'Remote HTML was executed as markup')
  assert.equal(model.requests.length, modelCount, 'Human approval silently launched another model turn')
  const repeated = await page.evaluate(async (call) => {
    try { await window.workbench.v2.agentMcpCalls.decide({ id: call.id, expectedRevision: call.revision, decision: 'approve', confirmed: true }); return 'unexpected-success' }
    catch { return 'rejected' }
  }, first.call)
  assert.equal(repeated, 'rejected')
  assert.equal(remote.calls.length, 1, 'Stale repeated approval replayed remote write')
  const rejected = await turn(assistant, 'fixture-reject')
  await rejected.card.getByRole('button', { name: '拒绝 MCP 调用', exact: true }).click()
  await truth(async (id) => (await window.workbench.v2.agentMcpCalls.list({ limit: 100 })).find((entry) => entry.id === id)?.status === 'rejected', rejected.call.id)
  assert.equal(remote.calls.length, 1)
  const canceled = await turn(assistant, 'fixture-cancel', false)
  await page.getByRole('button', { name: '停止 Agent 运行', exact: true }).click()
  await truth(async (id) => (await window.workbench.agent.runs.get(id)).status === 'canceled', canceled.run.id)
  await truth(async (id) => (await window.workbench.v2.agentMcpCalls.list({ limit: 100 })).find((entry) => entry.id === id)?.status === 'invalidated', canceled.call.id)
  assert.equal(remote.calls.length, 1, 'Cancel sent a pending request')
  evidence.workflows.push('Real loopback Pi SDK submits pending only; completed-run approve/dismiss/reject; frozen args, pure-text result; once-only CAS; no extra model call; live local SDK cancellation invalidates pending without executing')
  return { first, rejected, canceled }
}

async function setSize(width, height) {
  await app.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(320, 400); window.setSize(size.width, size.height) }, { width, height })
  await page.waitForTimeout(150)
}
async function capture(name, scope) {
  await page.keyboard.press('Tab')
  const controls = scope.locator('button,input,select,textarea,summary')
  for (let index = 0; index < await controls.count(); index++) {
    const node = controls.nth(index)
    if (!(await node.isVisible()) || !(await node.isEnabled())) continue
    await node.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }))
    await node.focus()
    const actual = await node.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return { label: element.getAttribute('aria-label') || element.id || element.textContent?.slice(0, 60), focused: document.activeElement === element, hit: hit === element || element.contains(hit), inside: rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.bottom <= innerHeight + 1, outline: getComputedStyle(element).outlineStyle, shadow: getComputedStyle(element).boxShadow }
    })
    assert(actual.focused && actual.hit && actual.inside && (actual.outline !== 'none' || actual.shadow !== 'none'), `${name}: enabled control unreachable ${JSON.stringify(actual)}`)
    evidence.controls.push({ context: name, ...actual })
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name}: horizontal document overflow`)
  const png = Buffer.from(await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')), 'base64')
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }))
  const imageSize = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
  assert(Math.abs(imageSize.width - viewport.width * viewport.dpr) <= 3 && Math.abs(imageSize.height - viewport.height * viewport.dpr) <= 3, 'Native screenshot clipped actual viewport')
  fs.writeFileSync(path.join(profile, `${name}.png`), png)
  evidence.screenshots.push({ name, viewport, imageSize })
}
async function layouts(server, skill, layoutRequest) {
  assert(layoutRequest.run.conversationId, 'Layout run must belong to a real conversation')
  const conversation = await page.evaluate((id) => window.workbench.agent.conversations.get(id), layoutRequest.run.conversationId)
  assert.equal(conversation.id, layoutRequest.run.conversationId)
  for (const theme of ['dark', 'light']) {
    await nav('设置'); await tab('通用')
    const themeSelect = page.locator('select#general-theme')
    await themeSelect.selectOption(theme)
    assert.equal(await themeSelect.inputValue(), theme)
    await page.waitForFunction((expected) => document.documentElement.classList.contains('dark') === (expected === 'dark') && localStorage.getItem('workbench-theme') === expected, theme)
    for (const [width, zoom] of [[1440, 1], [320, 1], [1440, 2]]) {
      await setSize(width, 900)
      await app.evaluate(({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom), zoom)
      for (const kind of ['mcp', 'skill']) {
        await manager(kind)
        await page.getByLabel(kind === 'mcp' ? '选择 MCP 服务器' : '选择指令技能', { exact: true }).selectOption(kind === 'mcp' ? server.id : skill.id)
        // Ensure at least one consequential action is genuinely enabled during
        // keyboard/hit checks rather than declaring disabled controls usable.
        const label = kind === 'mcp' ? 'MCP 服务器名称' : '指令技能名称'
        const input = page.getByLabel(label, { exact: true })
        const original = await input.inputValue()
        await input.fill(`${original} layout draft`)
        await capture(`${theme}-${width}-zoom${zoom}-${kind}`, page.locator('.agent-resource-manager'))
        await input.fill(original)
      }
      await nav('Agent')
      const expand = page.getByRole('button', { name: '展开对话历史', exact: true })
      if (await expand.isVisible()) await expand.click()
      const historyItem = page.locator('.agent-history-item').filter({ has: page.locator('strong').getByText(conversation.title, { exact: true }) })
      assert.equal(await historyItem.count(), 1, 'Real layout conversation must have one matching history item')
      await historyItem.click()
      assert.equal(await historyItem.getAttribute('aria-current'), 'page')
      const collapse = page.getByRole('button', { name: '折叠对话历史', exact: true })
      if (await collapse.isVisible()) await collapse.click()
      const card = page.locator(`[data-call-id="${layoutRequest.call.id}"]`)
      await card.waitFor()
      assert(await card.getByRole('button', { name: '批准 MCP 调用', exact: true }).isEnabled(), 'Approval layout evidence must contain a genuinely usable pending decision')
      await capture(`${theme}-${width}-zoom${zoom}-pending-call`, card)
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await setSize(1440, 900)
  evidence.workflows.push('Both themes at 1440px, 320px and actual Electron 200% zoom: enabled-control keyboard focus, unobscured center hit, no horizontal document overflow, native full-viewport captures')
}

async function restartAndRemove(server, skill, assistant, pendingCall) {
  const expectedAssistant = await getAssistant(assistant.id)
  await app.close(); app = null
  await launch()
  const restoredServer = await getServer(server.id)
  assert.equal(restoredServer.endpoint, remote.endpoint)
  assert.equal(restoredServer.lastProbe.status, 'ok')
  assert.equal(restoredServer.tools[0].key, server.tools[0].key)
  assert.equal((await getSkill(skill.id)).contentHash, skill.contentHash)
  assert.deepEqual((await getAssistant(assistant.id)).toolAllowlist, expectedAssistant.toolAllowlist)
  assert.deepEqual((await getAssistant(assistant.id)).skillKeys, expectedAssistant.skillKeys)
  const historical = await page.evaluate(() => window.workbench.v2.agentMcpCalls.list({ limit: 100 }))
  assert(historical.some((entry) => entry.status === 'completed') && historical.some((entry) => entry.status === 'rejected') && historical.some((entry) => entry.status === 'invalidated'))
  assert.equal(historical.find((entry) => entry.id === pendingCall.id)?.status, 'invalidated', 'Restart left an old pending call executable')
  assert.equal(remote.calls.length, 1, 'Restart replayed an old pending request')
  await manager('mcp')
  await page.getByLabel('选择 MCP 服务器', { exact: true }).selectOption(server.id)
  await page.getByRole('button', { name: '删除 MCP 服务器', exact: true }).click()
  await truth(async (id) => !(await window.workbench.v2.agentMcpServers.list()).some((entry) => entry.id === id), server.id)
  await manager('skill')
  await page.getByLabel('选择指令技能', { exact: true }).selectOption(skill.id)
  await page.getByRole('button', { name: '删除指令技能', exact: true }).click()
  await truth(async (id) => !(await window.workbench.v2.agentInstructionSkills.list()).some((entry) => entry.id === id), skill.id)
  assert((await page.evaluate(() => window.workbench.v2.agentMcpCalls.list({ limit: 100 }))).some((entry) => entry.status === 'completed'), 'Removing server erased historical receipts')
  evidence.workflows.push('Fresh-profile restart preserves servers/probed keys/skill hashes/assistant bindings and actual call receipts; UI confirmed deletes remove availability without erasing history')
}

async function mainTest() {
  assert(fs.existsSync(main), 'Build production output first')
  const fixturesResult = await fixtures(); remote = fixturesResult.mcp; model = fixturesResult.sdk
  try {
    await launch()
    const server = await mcpCrud()
    let skill = await skillCrud()
    // Setup uses only public typed IPC, never writes models.json directly.
    await page.evaluate(async (baseUrl) => {
      await window.workbench.agent.models.customProviders.save({ providers: [{ id: 'resource-fixture', name: 'Local resource fixture', baseUrl, api: 'openai-completions', models: [{ id: 'fixture-model', name: 'Fixture model', reasoning: false, contextWindow: 64000, maxTokens: 256 }] }] })
      await window.workbench.agent.credentials.save({ provider: 'resource-fixture', apiKey: 'fixture-not-a-real-provider-key' })
    }, model.baseUrl)
    const assistant = await createAssistant('Approved loopback assistant', true)
    const readOnly = await createAssistant('Read-only loopback assistant', false)
    await bind('tool', server.tools[0].key, assistant, true)
    assert(await page.getByRole('checkbox', { name: `绑定 ${readOnly.id} ${server.tools[0].key}`, exact: true }).isDisabled(), 'Read-only assistant can grant remote tool')
    skill = await skillReauthorization(skill, assistant)
    await approvals(assistant, skill)
    const layoutCall = await turn(assistant, 'fixture-layout')
    await layouts(server, skill, layoutCall)
    await restartAndRemove(server, skill, assistant, layoutCall.call)
    assert.deepEqual(errors, [], 'Renderer console/page errors')
    evidence.status = 'PASS'
    console.log(`Agent resources E2E PASS: ${evidence.workflows.length} workflows, ${evidence.screenshots.length} native screenshots`)
    console.log(`Evidence: ${path.join(profile, 'agent-resources-evidence.json')}`)
  } finally {
    if (app) await app.close()
    for (const fixture of [remote, model]) if (fixture) {
      fixture.server.closeAllConnections()
      await new Promise((resolve) => fixture.server.close(resolve))
    }
    evidence.errors = errors
    fs.writeFileSync(path.join(profile, 'agent-resources-evidence.json'), JSON.stringify(evidence, null, 2))
  }
}
mainTest().catch((error) => { console.error(error.stack); process.exitCode = 1 })
