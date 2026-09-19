import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { RpcResponse } from '@prw/contracts'
import { PaperReadStatusSchema } from '@prw/contracts'
import { z } from 'zod'
import type { WorkspaceToolBackend } from './backend.js'
import { WorkspaceServiceClient } from './client.js'

const serverVersion = '0.0.3'

/**
 * The workbench tool surface.
 *
 * Two audiences share this server: external MCP clients over stdio, and the
 * embedded Agent over an in-memory linked transport. Both therefore see the
 * same names, the same validation and the same behaviour.
 *
 * Write tools are local records only — a task, a calendar event, a marker.
 * They take effect immediately and are not gated behind a confirmation
 * parameter: the user's decision on this step is that the Agent may write the
 * workbench without a prompt, the same way it writes a message into the
 * conversation. Anything that leaves the machine (Notion, Zotero, Obsidian,
 * mail) stays behind the existing preview-and-revision contract and is not
 * registered here. Hard deletes are absent for the same reason: an Agent that
 * can only create, update and move can always be undone by the user.
 */
export function createWorkspaceMcpServer(client: WorkspaceToolBackend): McpServer {
  const server = new McpServer({ name: 'personal-research-workbench', version: serverVersion })

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
    description: '按标题或备注查找未归档任务。返回每条任务的 id、状态、截止时间与 revision，可用作 tasks.update / tasks.move 的入参。',
    inputSchema: {
      query: z.string().max(200).default(''),
      view: z.enum(['all', 'inbox', 'today', 'upcoming', 'overdue', 'completed']).default('all'),
      limit: z.number().int().min(1).max(200).default(50)
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ query, view, limit }) => {
    const tasks = await data(client.request('tasks.list', { view, includeArchived: false })) as Array<{
      id: string
      title: string
      notes: string
      status: string
      priority: string
      dueAt: string | null
      revision: number
      columnId: string | null
    }>
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    return textResult(tasks
      .filter((task) => !needle || `${task.title}\n${task.notes}`.toLocaleLowerCase('zh-CN').includes(needle))
      .slice(0, limit)
      .map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        dueAt: task.dueAt,
        columnId: task.columnId,
        revision: task.revision
      })))
  })

  server.registerTool('tasks.create', {
    title: 'Create task',
    description: '创建任务并立即写入工作台（本地记录，无需审批）。返回新任务的 id。',
    inputSchema: {
      title: z.string().trim().min(1).max(240),
      notes: z.string().max(20_000).default(''),
      projectId: z.string().nullable().default(null),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
      dueAt: z.string().nullable().default(null),
      estimateMinutes: z.number().int().positive().max(100_000).nullable().default(null),
      tags: z.array(z.string().trim().min(1).max(100)).default([])
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async (input) => textResult(await data(client.request('tasks.create', {
    title: input.title,
    notes: input.notes,
    projectId: blankToUndefined(input.projectId) ?? null,
    columnId: null,
    priority: input.priority,
    estimateMinutes: input.estimateMinutes,
    dueAt: input.dueAt,
    tags: input.tags
  }))))

  server.registerTool('todos.capture', {
    title: 'Capture inbox todo',
    description: '把一句话快速记入收件箱（不归属任何项目），立即生效。适合"我刚刚做完了 X"这类随手记录。返回任务 id。',
    inputSchema: {
      title: z.string().trim().min(1).max(240),
      notes: z.string().max(20_000).default('')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ title, notes }) => textResult(await data(client.request('todos.capture', {
    title,
    notes,
    projectId: null,
    columnId: null,
    priority: 'normal',
    estimateMinutes: null,
    dueAt: null,
    tags: []
  }))))

  server.registerTool('tasks.update', {
    title: 'Update task',
    description: '更新任务字段并立即写入。只需传要改的字段；未传 expectedRevision 时工具会先读取当前 revision 再写入。返回更新后的任务。',
    inputSchema: {
      id: z.string().min(1),
      title: z.string().trim().min(1).max(240).optional(),
      notes: z.string().max(20_000).optional(),
      projectId: z.string().nullable().optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      dueAt: z.string().nullable().optional(),
      estimateMinutes: z.number().int().positive().max(100_000).nullable().optional(),
      tags: z.array(z.string().trim().min(1).max(100)).optional(),
      expectedRevision: z.number().int().nonnegative().optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id, expectedRevision, ...patch }) => {
    const revision = expectedRevision ?? await currentTaskRevision(client, id)
    return textResult(await data(client.request('tasks.update', { id, ...patch, expectedRevision: revision })))
  })

  server.registerTool('tasks.move', {
    title: 'Move task',
    description: '把任务移动到看板列或某个状态（planned / in_progress / blocked / done），立即生效。返回移动后的任务。',
    inputSchema: {
      id: z.string().min(1),
      status: z.enum(['planned', 'in_progress', 'blocked', 'done']).optional(),
      columnId: z.string().optional(),
      targetIndex: z.number().int().nonnegative().default(0),
      expectedRevision: z.number().int().nonnegative().optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ id, status, columnId, targetIndex, expectedRevision }) => {
    const column = blankToUndefined(columnId)
    if (!status && column === undefined) return textResult({ error: 'missing_target', message: '需要 status 或 columnId 之一。' }, true)
    const revision = expectedRevision ?? await currentTaskRevision(client, id)
    return textResult(await data(client.request('tasks.move', {
      taskId: id,
      columnId: column ?? `status:${status}`,
      targetIndex,
      expectedRevision: revision
    })))
  })

  server.registerTool('calendar.list', {
    title: 'List calendar events',
    description: '读取时间范围内的日历事件（含任务与每日推送投影）。默认范围是今天起七天。返回每条事件的 id 与 revision。',
    inputSchema: {
      startsAt: z.string().optional(),
      endsAt: z.string().optional(),
      timezone: z.string().optional(),
      projectId: z.string().nullable().optional()
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ startsAt, endsAt, timezone, projectId }) => {
    const range = resolveRange(startsAt, endsAt)
    const project = blankToUndefined(projectId)
    return textResult(await data(client.request('calendar.list', {
      startsAt: range.startsAt,
      endsAt: range.endsAt,
      timezone: blankToUndefined(timezone) ?? defaultTimezone(),
      ...(project === undefined ? {} : { projectId: project })
    })))
  })

  server.registerTool('calendar.create', {
    title: 'Create calendar event',
    description: '创建日历事件并立即写入工作台（本地记录，无需审批）。缺少 endsAt 时按 durationMinutes（默认 60 分钟）推算。返回新事件的 id。',
    inputSchema: {
      title: z.string().trim().min(1).max(240),
      startsAt: z.string(),
      endsAt: z.string().optional(),
      durationMinutes: z.number().int().positive().max(10_080).optional(),
      timezone: z.string().optional(),
      description: z.string().max(20_000).default(''),
      allDay: z.boolean().default(false),
      projectId: z.string().nullable().default(null)
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ title, startsAt, endsAt, durationMinutes, timezone, description, allDay, projectId }) => textResult(await data(client.request('calendar.create', {
    title,
    startsAt,
    endsAt: endsAt ?? addMinutes(startsAt, durationMinutes ?? 60),
    description,
    allDay,
    projectId: blankToUndefined(projectId) ?? null,
    timezone: blankToUndefined(timezone) ?? defaultTimezone()
  }))))

  server.registerTool('calendar.update', {
    title: 'Update calendar event',
    description: '更新日历事件并立即写入。只传要改的字段；工具会先读取当前 revision。返回更新后的事件。',
    inputSchema: {
      id: z.string().min(1),
      title: z.string().trim().min(1).max(240).optional(),
      startsAt: z.string().optional(),
      endsAt: z.string().optional(),
      description: z.string().max(20_000).optional(),
      allDay: z.boolean().optional(),
      projectId: z.string().nullable().optional(),
      expectedRevision: z.number().int().nonnegative().optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id, expectedRevision, projectId, ...patch }) => {
    const revision = expectedRevision ?? await currentEventRevision(client, id)
    const project = projectId === null ? null : blankToUndefined(projectId)
    return textResult(await data(client.request('calendar.update', {
      id,
      ...patch,
      ...(project === undefined ? {} : { projectId: project }),
      expectedRevision: revision
    })))
  })

  server.registerTool('calendar.markers.list', {
    title: 'List calendar markers',
    description: '读取时间范围内的日历标记（提醒、里程碑、截止日期等）。默认范围是今天起七天。',
    inputSchema: {
      startsAt: z.string().optional(),
      endsAt: z.string().optional(),
      timezone: z.string().optional(),
      projectId: z.string().nullable().optional()
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ startsAt, endsAt, timezone, projectId }) => {
    const range = resolveRange(startsAt, endsAt)
    const project = blankToUndefined(projectId)
    return textResult(await data(client.request('calendar.markers.list', {
      startsAt: range.startsAt,
      endsAt: range.endsAt,
      timezone: blankToUndefined(timezone) ?? defaultTimezone(),
      ...(project === undefined ? {} : { projectId: project })
    })))
  })

  server.registerTool('calendar.markers.create', {
    title: 'Create calendar marker',
    description: '创建日历标记并立即写入：type=reminder 表示提醒，milestone 表示里程碑，deadline 表示截止日期，note 表示笔记。默认全天，endsAt 缺省等于 startsAt。返回新标记的 id。',
    inputSchema: {
      title: z.string().trim().min(1).max(240),
      startsAt: z.string(),
      endsAt: z.string().optional(),
      type: z.enum(['note', 'reminder', 'milestone', 'reading', 'deadline']).default('reminder'),
      note: z.string().max(20_000).default(''),
      timezone: z.string().optional(),
      allDay: z.boolean().default(true),
      projectId: z.string().nullable().default(null),
      color: z.string().regex(/^#[0-9a-f]{6}$/iu).default('#3b82f6')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ title, startsAt, endsAt, type, note, timezone, allDay, projectId, color }) => textResult(await data(client.request('calendar.markers.create', {
    title,
    startsAt,
    endsAt: endsAt ?? startsAt,
    type,
    note,
    allDay,
    projectId: blankToUndefined(projectId) ?? null,
    color,
    timezone: blankToUndefined(timezone) ?? defaultTimezone()
  }))))

  server.registerTool('calendar.markers.update', {
    title: 'Update calendar marker',
    description: '更新日历标记并立即写入。只传要改的字段；工具会先读取当前 revision。返回更新后的标记。',
    inputSchema: {
      id: z.string().min(1),
      title: z.string().trim().min(1).max(240).optional(),
      startsAt: z.string().optional(),
      endsAt: z.string().optional(),
      note: z.string().max(20_000).optional(),
      allDay: z.boolean().optional(),
      color: z.string().regex(/^#[0-9a-f]{6}$/iu).optional(),
      expectedRevision: z.number().int().nonnegative().optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id, expectedRevision, ...patch }) => {
    const revision = expectedRevision ?? await currentMarkerRevision(client, id)
    return textResult(await data(client.request('calendar.markers.update', { id, ...patch, expectedRevision: revision })))
  })

  server.registerTool('literature.search', {
    title: 'Search literature',
    description: '调用 Workbench LiteratureCoordinator 搜索 Crossref、OpenAlex、PubMed、arXiv、本地库等。返回可核验的 session、结果和 partial 状态，不在 Agent runtime 重实现检索。',
    inputSchema: {
      query: z.string().trim().min(1).max(500),
      source: z.enum(['all', 'local', 'crossref', 'openalex', 'pubmed', 'arxiv', 'semantic_scholar', 'google_scholar']).default('all'),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(50),
      sort: z.enum(['relevance', 'year-asc', 'year-desc', 'impact-asc', 'impact-desc', 'metric-asc', 'metric-desc']).default('relevance')
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async ({ query, source, page, pageSize, sort }) => textResult(await data(client.request('literature.search', {
    query, source, page, pageSize, filters: {}, sort
  }))))

  server.registerTool('literature.sessions', {
    title: 'List literature sessions',
    description: '读取当前工作台保留的文献搜索 session 摘要。',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => textResult(await data(client.request('literature.sessions', null))))

  server.registerTool('literature.results', {
    title: 'Read literature results',
    description: '读取指定搜索 session 的结果页，保留 DOI、URL、来源、摘要和 partial 状态。',
    inputSchema: {
      sessionId: z.string().min(1),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(50)
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ sessionId, page, pageSize }) => textResult(await data(client.request('literature.resultsPage', { sessionId, page: { limit: pageSize, cursor: page > 1 ? String(page - 1) : null } }))))

  server.registerTool('papers.list', {
    title: 'List saved papers',
    description: '读取工作台已保存的 Paper 投影，可按项目、状态、标签或标题检索。',
    inputSchema: {
      projectId: z.string().nullable().optional(),
      status: PaperReadStatusSchema.optional(),
      tag: z.string().min(1).optional(),
      query: z.string().max(500).default(''),
      includeArchived: z.boolean().default(false)
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async (input) => {
    const projectId = blankToUndefined(input.projectId)
    return textResult(await data(client.request('papers.list', {
      projectId: projectId ?? null,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.tag === undefined ? {} : { tag: input.tag }),
      query: input.query,
      includeArchived: input.includeArchived
    })))
  })

  server.registerTool('notes.list', {
    title: 'List Obsidian notes',
    description: '读取已授权 Obsidian Vault 的 Markdown 索引；只返回相对路径、标题、标签、fingerprint 等安全投影。',
    inputSchema: { vaultId: z.string().min(1), query: z.string().max(500).default('') },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ vaultId, query }) => textResult(await data(client.request('notes.list', { vaultId, query }))))

  server.registerTool('notes.read', {
    title: 'Read Obsidian note',
    description: '读取已授权 Vault 内的一篇 Markdown。路径由服务端校验，禁止 .obsidian、.git、越界和符号链接越界。',
    inputSchema: { vaultId: z.string().min(1), relativePath: z.string().min(1).max(4_000) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ vaultId, relativePath }) => textResult(await data(client.request('notes.read', { vaultId, relativePath }))))

  server.registerTool('notes.metadata.preview', {
    title: 'Preview Obsidian metadata change',
    description: '生成 Obsidian managed frontmatter 的差异预览。该工具只读，不写文件；执行仍需用户确认、fingerprint 和现有 Service 合同。',
    inputSchema: {
      vaultId: z.string().min(1),
      relativePath: z.string().min(1).max(4_000),
      patch: z.record(z.string(), z.unknown())
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ vaultId, relativePath, patch }) => textResult(await data(client.request('notes.metadata.preview', { vaultId, relativePath, patch }))))

  server.registerTool('zotero.paperToZotero.preview', {
    title: 'Preview Paper to Zotero',
    description: '生成 Paper → Zotero 的重复、collection、revision 和 capability 预览；不会写入远端。确认执行必须经过现有外部写入流程。',
    inputSchema: {
      profileId: z.string().min(1),
      paperIds: z.array(z.string().min(1)).min(1).max(500),
      targetCollectionKey: z.string().nullable().default(null),
      format: z.enum(['ris', 'bibtex']).default('ris'),
      projectId: z.string().nullable().optional(),
      tags: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
      transport: z.enum(['api', 'save-file', 'mailto-draft', 'external-bridge']).optional()
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async (input) => textResult(await data(client.request('zotero.paperToZotero.preview', input))))

  server.registerTool('literature.stagingToZotero.preview', {
    title: 'Preview staged literature to Zotero',
    description: '生成文献 staging → Zotero 的逐条重复和 revision 预览；不会写入远端。',
    inputSchema: {
      profileId: z.string().min(1),
      stagingIds: z.array(z.string().min(1)).min(1).max(500),
      targetCollectionKey: z.string().nullable().default(null),
      format: z.enum(['ris', 'bibtex']).default('ris'),
      projectId: z.string().nullable().optional(),
      tags: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
      transport: z.enum(['api', 'save-file', 'mailto-draft', 'external-bridge']).optional()
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async (input) => textResult(await data(client.request('literature.stagingToZotero.preview', input))))

  // Requesting an external write is a separate step from previewing one: these
  // tools run the preview and then park the result behind a user decision. The
  // description says so explicitly because the model reads the description, not
  // the implementation, and "preview + request confirmation" must never be
  // reported to the user as "written".
  server.registerTool('zotero.paperToZotero.request', {
    title: 'Request Paper to Zotero write',
    description: '生成 Paper → Zotero 预览并创建待用户确认的外部写入请求。该工具不会写入 Zotero：'
      + '返回 actionId 与 message，必须在回答里说明需要用户在对话中确认，不得声称已写入。',
    inputSchema: {
      profileId: z.string().min(1),
      paperIds: z.array(z.string().min(1)).min(1).max(500),
      targetCollectionKey: z.string().nullable().default(null),
      format: z.enum(['ris', 'bibtex']).default('ris'),
      projectId: z.string().nullable().optional(),
      tags: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
      transport: z.enum(['api', 'save-file', 'mailto-draft', 'external-bridge']).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async (input) => textResult(await data(client.request('zotero.paperToZotero.request', input))))

  server.registerTool('literature.stagingToZotero.request', {
    title: 'Request staged literature to Zotero write',
    description: '生成文献 staging → Zotero 预览并创建待用户确认的外部写入请求。不会写入 Zotero；'
      + '必须在回答里说明需要用户确认。',
    inputSchema: {
      profileId: z.string().min(1),
      stagingIds: z.array(z.string().min(1)).min(1).max(500),
      targetCollectionKey: z.string().nullable().default(null),
      format: z.enum(['ris', 'bibtex']).default('ris'),
      projectId: z.string().nullable().optional(),
      tags: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
      transport: z.enum(['api', 'save-file', 'mailto-draft', 'external-bridge']).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async (input) => textResult(await data(client.request('literature.stagingToZotero.request', input))))

  server.registerTool('notes.write.request', {
    title: 'Request Obsidian note write',
    description: '创建待用户确认的 Obsidian 笔记写入请求，并冻结当前文件 fingerprint。'
      + '不会写文件；执行需要用户在对话中确认；外部改动会返回冲突而不是覆盖。',
    inputSchema: {
      vaultId: z.string().min(1),
      relativePath: z.string().min(1).max(4_000),
      content: z.string().max(2_000_000),
      expectedFingerprint: z.string().min(1).nullable().default(null)
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async (input) => textResult(await data(client.request('notes.write.request', input))))

  server.registerTool('notes.metadata.request', {
    title: 'Request Obsidian metadata write',
    description: '创建待用户确认的 Obsidian managed frontmatter 写入请求，并冻结 fingerprint。'
      + '不会写文件；执行需要用户确认。',
    inputSchema: {
      vaultId: z.string().min(1),
      relativePath: z.string().min(1).max(4_000),
      patch: z.record(z.string(), z.unknown())
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async (input) => textResult(await data(client.request('notes.metadata.request', input))))

  server.registerTool('zotero.capability', {
    title: 'Probe Zotero capability',
    description: '读取一个已配置 Zotero profile 的真实 capability 状态；不会修改远端库。',
    inputSchema: { profileId: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async ({ profileId }) => textResult(await data(client.request('zotero.capability', { profileId }))))

  server.registerTool('zotero.collections', {
    title: 'List Zotero collections',
    description: '读取 Zotero collection 分页，供 Agent 选择目标 collection；不会写入。',
    inputSchema: { profileId: z.string().min(1), cursor: z.string().nullable().optional() },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async ({ profileId, cursor }) => textResult(await data(client.request('zotero.collectionsPage', { profileId, cursor: cursor ?? null }))))

  server.registerTool('zotero.items', {
    title: 'List Zotero items',
    description: '读取 Zotero 条目和版本号，用于检索、重复判断和后续 preview；不会写入。',
    inputSchema: {
      profileId: z.string().min(1),
      collectionKey: z.string().optional(),
      query: z.string().max(500).optional(),
      cursor: z.string().nullable().optional(),
      pageSize: z.number().int().min(1).max(100).default(50)
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async ({ profileId, collectionKey, query, cursor, pageSize }) => {
    const key = blankToUndefined(collectionKey)
    const text = blankToUndefined(query)
    return textResult(await data(client.request('zotero.itemsPage', {
      profileId,
      ...(key === undefined ? {} : { collectionKey: key }),
      ...(text === undefined ? {} : { query: text }),
      cursor: cursor ?? null,
      pageSize
    })))
  })
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

  server.registerTool('automation.rules.list', {
    title: 'List scheduled Agent rules',
    description: 'Read the configured scheduled Agent rules, including frequency, timezone, prompt, skill, sources, lookback window, permission mode and enabled state. This is read-only and never starts a run.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => textResult(await data(client.requestAgent('automation.rules.list', null))))

  server.registerTool('automation.runs.list', {
    title: 'List automation runs',
    description: 'List Agent runs created by scheduled automation.',
    inputSchema: { limit: z.number().int().min(1).max(100).default(50) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ limit }) => textResult(await data(client.requestAgent('automation.runs.list', { limit }))))

  server.registerTool('agent.settings.get', {
    title: 'Read Agent parameters',
    description: 'Read the current non-secret Agent defaults: provider, model, thinking, permission mode, tool profile, approval policy and response language. Never returns API keys or OAuth tokens.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => textResult(await data(client.requestAgent('agent.settings.get', null))))

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

async function currentTaskRevision(client: WorkspaceToolBackend, id: string): Promise<number> {
  const tasks = await data(client.request('tasks.list', { view: 'all', includeArchived: true })) as Array<{ id: string; revision: number }>
  const task = tasks.find((candidate) => candidate.id === id)
  if (!task) throw new Error(`task not found: ${id}`)
  return task.revision
}

async function currentEventRevision(client: WorkspaceToolBackend, id: string): Promise<number> {
  const events = await data(client.request('calendar.list', { ...lookupRange(), timezone: defaultTimezone() })) as Array<{ id: string; revision: number }>
  const event = events.find((candidate) => candidate.id === id)
  if (!event) throw new Error(`calendar event not found: ${id}`)
  return event.revision
}

async function currentMarkerRevision(client: WorkspaceToolBackend, id: string): Promise<number> {
  const markers = await data(client.request('calendar.markers.list', { ...lookupRange(), timezone: defaultTimezone() })) as Array<{ id: string; revision: number }>
  const marker = markers.find((candidate) => candidate.id === id)
  if (!marker) throw new Error(`calendar marker not found: ${id}`)
  return marker.revision
}

/**
 * Window used when a tool has to read a record before writing it.
 *
 * It is a year either side of today rather than the seven-day display default,
 * because an update names an id the caller already knows: failing to find a
 * record that exists would be worse than reading a slightly larger range once.
 */
function lookupRange(): { startsAt: string; endsAt: string } {
  const now = Date.now()
  const window = 365 * 24 * 60 * 60_000
  return { startsAt: new Date(now - window).toISOString(), endsAt: new Date(now + window).toISOString() }
}

/** Default window for calendar reads: today (local midnight) plus seven days. */
function resolveRange(startsAt?: string, endsAt?: string): { startsAt: string; endsAt: string } {
  const start = startsAt ?? localDayStart()
  const end = endsAt ?? new Date(Date.parse(start) + 7 * 24 * 60 * 60_000).toISOString()
  if (Date.parse(end) <= Date.parse(start)) throw new Error('endsAt must be later than startsAt')
  return { startsAt: start, endsAt: end }
}

function localDayStart(): string {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
}

function addMinutes(instant: string, minutes: number): string {
  const timestamp = Date.parse(instant)
  if (Number.isNaN(timestamp)) throw new Error(`invalid ISO instant: ${instant}`)
  return new Date(timestamp + minutes * 60_000).toISOString()
}

/**
 * The Core process runs on the user's machine, so its own timezone is the right
 * default for a record the Agent creates on their behalf. A model cannot be
 * relied on to know the zone, and a wrong zone would move a reminder by hours.
 */
function defaultTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return zone.length > 0 && zone.length <= 100 ? zone : 'UTC'
  } catch {
    return 'UTC'
  }
}

async function data(request: Promise<RpcResponse>): Promise<unknown> {
  const response = await request
  if (response.ok) return response.data
  // A rejected payload names its fields in `details.issues`; without them the
  // model only sees "the request did not match the expected shape" and cannot
  // correct the call. Only issue paths and messages are forwarded, never the
  // payload itself.
  const issues = (response.error as { details?: { issues?: unknown } }).details?.issues
  const detail = Array.isArray(issues)
    ? issues
      .slice(0, 5)
      .map((issue) => {
        const entry = issue as { path?: unknown; message?: unknown }
        const path = Array.isArray(entry.path) ? entry.path.join('.') : ''
        return path === '' ? String(entry.message ?? '') : `${path}: ${String(entry.message ?? '')}`
      })
      .filter((text) => text.trim() !== '')
      .join('; ')
    : ''
  throw new Error(detail === '' ? response.error.message : `${response.error.message} (${detail})`)
}

/**
 * A blank optional identifier from a model means "not set".
 *
 * Service contracts type ids, keys and enum-like fields as `min(1)`, so a `''`
 * that reaches them fails the whole call instead of meaning the obvious "no
 * filter". Free text is left alone: an empty string there can be deliberate.
 */
function blankToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? undefined : trimmed
}

function textResult(value: unknown, isError = false): { content: [{ type: 'text'; text: string }]; isError?: true } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true as const } : {}) }
}
