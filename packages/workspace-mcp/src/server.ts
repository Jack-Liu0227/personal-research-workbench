import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { RpcResponse, Task } from '@prw/contracts'
import { z } from 'zod'
import { WorkspaceServiceClient } from './client.js'

export function createWorkspaceMcpServer(client: WorkspaceServiceClient): McpServer {
  const server = new McpServer({ name: 'personal-research-workbench', version: '0.0.2' })

  server.registerResource('workspace-projects', 'workspace://projects', {
    title: 'Workspace projects',
    description: '项目摘要；不包含凭据和外部全文。',
    mimeType: 'application/json'
  }, async () => ({ contents: [{ uri: 'workspace://projects', text: JSON.stringify(await data(client.request('projects.list', null))) }] }))

  server.registerResource('workspace-tasks', 'workspace://tasks', {
    title: 'Workspace tasks',
    description: '任务列表；仅返回工作台任务字段。',
    mimeType: 'application/json'
  }, async () => ({ contents: [{ uri: 'workspace://tasks', text: JSON.stringify(await data(client.request('tasks.list', { view: 'all', includeArchived: false }))) }] }))

  server.registerTool('projects.search', {
    title: 'Search projects',
    description: '按名称或说明查找项目。',
    inputSchema: { query: z.string().max(200).default('') },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ query }) => {
    const projects = await data(client.request('projects.list', null)) as Array<{ name: string; description: string }>
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    return textResult(projects.filter((project) => !needle || `${project.name}\n${project.description}`.toLocaleLowerCase('zh-CN').includes(needle)))
  })

  server.registerTool('tasks.search', {
    title: 'Search tasks',
    description: '按标题或备注查找未归档任务。',
    inputSchema: { query: z.string().max(200).default('') },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ query }) => {
    const tasks = await data(client.request('tasks.list', { view: 'all', includeArchived: false })) as Task[]
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    return textResult(tasks.filter((task) => !needle || `${task.title}\n${task.notes}`.toLocaleLowerCase('zh-CN').includes(needle)))
  })

  server.registerTool('tasks.create', {
    title: 'Create task',
    description: '创建任务。必须由调用方显式传入 confirmed=true；创建会记录为 MCP 来源。',
    inputSchema: {
      title: z.string().min(1).max(240),
      notes: z.string().max(20_000).default(''),
      projectId: z.string().nullable().default(null),
      confirmed: z.boolean().default(false)
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ title, notes, projectId, confirmed }) => {
    if (!confirmed) return textResult({ error: 'confirmation_required', message: '请在 MCP 调用中显式传入 confirmed=true。' }, true)
    const task = await data(client.request('tasks.create', {
      title, notes, projectId, columnId: null, priority: 'normal', estimateMinutes: null, dueAt: null
    }))
    return textResult(task)
  })

  server.registerTool('agent.connectors.list', {
    title: 'List Agent runtimes',
    description: 'List Codex and Pi runtime availability and capability probes.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => textResult(await data(client.requestAgent('agent.connectors.list', null))))

  server.registerTool('agent.conversations.list', {
    title: 'List Agent conversations',
    description: 'List persisted Agent chat sessions, optionally scoped to a research project.',
    inputSchema: {
      projectId: z.string().nullable().optional(),
      includeArchived: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(50)
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ projectId, includeArchived, limit }) => textResult(await data(client.requestAgent('agent.conversations.list', {
    ...(projectId === undefined ? {} : { projectId }), includeArchived, limit
  }))))

  server.registerTool('agent.conversations.messages', {
    title: 'Read Agent conversation',
    description: 'Read the persisted user/assistant message history for one Agent conversation.',
    inputSchema: { conversationId: z.string().min(1), limit: z.number().int().min(1).max(500).default(200) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ conversationId, limit }) => textResult(await data(client.requestAgent('agent.conversations.messages', { conversationId, limit }))))

  server.registerTool('agent.runs.list', {
    title: 'List Agent runs',
    description: 'List persisted Agent runs and their current status.',
    inputSchema: {
      status: z.enum(['planned', 'queued', 'running', 'waiting_confirmation', 'completed', 'partial', 'failed', 'canceled', 'blocked', 'missed']).optional(),
      projectId: z.string().nullable().optional(),
      limit: z.number().int().min(1).max(100).default(50)
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ status, projectId, limit }) => textResult(await data(client.requestAgent('agent.runs.list', {
    ...(status === undefined ? {} : { status }),
    ...(projectId === undefined ? {} : { projectId }),
    page: { limit }
  }))))

  server.registerTool('agent.runs.get', {
    title: 'Get Agent run',
    description: 'Read one Agent run record.',
    inputSchema: { runId: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ runId }) => textResult(await data(client.requestAgent('agent.runs.get', { runId }))))

  server.registerTool('agent.runs.events', {
    title: 'Read Agent events',
    description: 'Read the append-only event stream for an Agent run.',
    inputSchema: {
      runId: z.string().min(1),
      afterSeq: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(500).default(100)
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ runId, afterSeq, limit }) => textResult(await data(client.requestAgent('agent.runs.eventsPage', { runId, afterSeq, limit }))))

  server.registerTool('automation.runs.list', {
    title: 'List automation runs',
    description: 'List Agent runs created by scheduled automation.',
    inputSchema: { limit: z.number().int().min(1).max(100).default(50) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ limit }) => textResult(await data(client.requestAgent('automation.runs.list', { limit }))))

  server.registerTool('inbox.ai.list', {
    title: 'List Agent inbox',
    description: 'List generated artifacts and Agent notifications.',
    inputSchema: { unreadOnly: z.boolean().default(false) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ unreadOnly }) => textResult(await data(client.requestAgent('inbox.ai.list', { unreadOnly }))))

  server.registerPrompt('daily-research-plan', {
    title: 'Daily research plan',
    description: '生成一份基于当前工作台任务和项目的计划提示。'
  }, async () => ({
    messages: [{ role: 'user', content: { type: 'text', text: '请先读取 workspace://projects 和 workspace://tasks，只根据返回数据生成今日科研计划；不要虚构论文、截止日期或运行状态。' } }]
  }))

  return server
}

export async function runWorkspaceMcp(client: WorkspaceServiceClient): Promise<void> {
  const server = createWorkspaceMcpServer(client)
  await server.connect(new StdioServerTransport())
}

async function data(request: Promise<RpcResponse>): Promise<unknown> {
  const response = await request
  if (!response.ok) throw new Error(response.error.message)
  return response.data
}

function textResult(value: unknown, isError = false): { content: [{ type: 'text'; text: string }]; isError?: true } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true as const } : {}) }
}
