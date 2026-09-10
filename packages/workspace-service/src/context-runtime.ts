import {
  ContextCapabilitySchema,
  ContextMenuTargetSchema,
  HardDeleteTaskInputSchema,
  UpdateTaskInputSchema,
  UpdateCalendarEventInputSchema,
  MoveTaskInputSchema,
  type ContextCapability,
  type ContextMenuTarget,
  type ResourceRef
} from '@prw/contracts'
import type { WorkbenchRepository } from '@prw/database'
import { z } from 'zod'

type TargetType = ContextMenuTarget['type']

/**
 * Authoritative right-click routing. The renderer supplies only a type/id;
 * this class re-reads the entity from SQLite and derives a closed capability
 * list. It is intentionally independent from Electron/menu APIs.
 */
export class ContextCoordinator {
  constructor(private readonly repository: WorkbenchRepository) {}

  describe(input: { type: TargetType; id: string }): { target: ContextMenuTarget; capabilities: ContextCapability[] } {
    const id = z.string().min(1).parse(input.id)
    const capabilities = this.capabilities(input.type, id)
    const target = ContextMenuTargetSchema.parse({ type: input.type, id, capabilities })
    return { target, capabilities }
  }

  execute(input: { type: TargetType; id: string; capability: string; payload?: unknown }): unknown {
    const capability = ContextCapabilitySchema.parse(input.capability)
    const described = this.describe({ type: input.type, id: input.id })
    if (!described.capabilities.includes(capability)) {
      const error = new Error(`Capability ${capability} is not available for this target.`)
      error.name = 'PERMISSION_DENIED'
      throw error
    }
    const payload = input.payload
    switch (`${input.type}:${capability}`) {
      case 'task:archive': {
        const value = z.object({ expectedRevision: z.int().nonnegative() }).parse(payload)
        this.repository.archiveTask(input.id, value.expectedRevision)
        return null
      }
      case 'task:restore': {
        const value = z.object({ expectedRevision: z.int().nonnegative() }).parse(payload)
        return this.repository.restoreTask(input.id, value.expectedRevision)
      }
      case 'task:hard-delete': {
        return this.repository.hardDeleteTask(HardDeleteTaskInputSchema.parse({ ...payloadObject(payload), id: input.id }))
      }
      case 'task:move': return this.repository.moveTask(MoveTaskInputSchema.parse({ ...payloadObject(payload), taskId: input.id }))
      case 'task:edit': return this.repository.updateTask(UpdateTaskInputSchema.parse({ ...payloadObject(payload), id: input.id }))
      case 'project:archive': {
        const value = z.object({ expectedRevision: z.int().nonnegative() }).parse(payload)
        this.repository.archiveProject(input.id, value.expectedRevision)
        return null
      }
      case 'calendar-event:delete': {
        const value = z.object({ expectedRevision: z.int().nonnegative() }).parse(payload)
        this.repository.removeCalendarEvent(input.id, value.expectedRevision)
        return null
      }
      case 'calendar-event:edit': return this.repository.updateCalendarEvent(UpdateCalendarEventInputSchema.parse({ ...payloadObject(payload), id: input.id }))
      case 'resource:delete': this.repository.removeResourceLink(input.id); return null
      default:
        // open/copy/refresh/set-filter are renderer/Main operations. The
        // service acknowledges authorization but does not perform UI effects.
        return { type: input.type, id: input.id, capability }
    }
  }

  private capabilities(type: TargetType, id: string): ContextCapability[] {
    switch (type) {
      case 'task': {
        const task = this.repository.listTasks({ view: 'all', includeArchived: true }).find((value) => value.id === id)
        if (!task) throw notFound(type, id)
        return task.status === 'archived'
          ? ['open', 'open-new-tab', 'copy-id', 'restore', 'hard-delete', 'refresh']
          : ['open', 'open-new-tab', 'copy-id', 'edit', 'move', 'associate', 'archive', 'refresh']
      }
      case 'project': {
        const project = this.repository.listProjects().find((value) => value.id === id)
        if (!project) throw notFound(type, id)
        return ['open', 'open-new-tab', 'copy-id', 'edit', 'associate', 'archive', 'refresh']
      }
      case 'paper': {
        if (!this.repository.listPapers({ includeArchived: true }).some((value) => value.id === id)) throw notFound(type, id)
        return ['open', 'open-new-tab', 'copy-id', 'edit', 'associate', 'archive', 'refresh']
      }
      case 'note':
        return ['open', 'open-new-tab', 'copy-id', 'edit', 'refresh']
      case 'calendar-event':
        if (id.startsWith('task:') || id.startsWith('project:')) return ['open', 'copy-id']
        if (!this.repository.listCalendarEvents({ startsAt: '1970-01-01T00:00:00.000Z', endsAt: '9999-12-31T00:00:00.000Z', timezone: 'UTC' }).some((value) => value.id === id)) throw notFound(type, id)
        return ['open', 'open-new-tab', 'copy-id', 'edit', 'delete', 'refresh']
      case 'resource':
        if (!this.repository.listResourceLinks().some((value) => value.id === id)) throw notFound(type, id)
        return ['open', 'copy-id', 'delete', 'refresh']
      case 'zotero-collection':
      case 'zotero-item':
        return ['open', 'copy-id', 'refresh', 'set-import-target']
      case 'tab':
        return ['open', 'open-new-tab', 'copy-id', 'refresh']
    }
  }
}

function payloadObject(payload: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(payload)
}

function notFound(type: string, id: string): Error {
  const error = new Error(`${type} not found`)
  error.name = 'NOT_FOUND'
  void id
  return error
}

export function describeContext(repository: WorkbenchRepository, input: { type: TargetType; id: string }) {
  return new ContextCoordinator(repository).describe(input)
}
