import { ProjectIdSchema, WorkspaceTabStateSchema, type WorkspaceTabState, type WorkspaceTab, type ResourceRef } from '@prw/contracts'
import type { WorkbenchRepository } from '@prw/database'

export type ProjectSpaceSection = 'project' | 'progress' | 'tasks' | 'papers' | 'matrix' | 'calendar' | 'notes' | 'links' | 'artifacts'

type ProjectSpaceRepository = WorkbenchRepository & {
  readonly listNoteIndex?: (profileId?: string) => unknown[]
}

/** Single-snapshot-ish project read facade. Child mutations remain routed to
 * their task/paper/calendar/note commands; this class never writes files. */
export class ProjectSpaceCoordinator {
  constructor(private readonly repository: ProjectSpaceRepository) {}

  get(input: { projectId: string; sections?: ProjectSpaceSection[] }): Record<string, unknown> {
    const projectId = ProjectIdSchema.parse(input.projectId)
    const project = this.repository.listProjects().find((value) => value.id === projectId)
    if (!project) throw notFound('project', projectId)
    const sections = new Set(input.sections ?? ['project', 'progress', 'tasks', 'papers', 'matrix', 'calendar', 'notes', 'links', 'artifacts'])
    const aggregate: Record<string, unknown> = { projectId }
    if (sections.has('project')) aggregate.project = project
    if (sections.has('progress')) aggregate.progress = this.repository.getProjectProgress(projectId)
    if (sections.has('tasks')) aggregate.tasks = this.repository.listTasks({ projectId, view: 'all', includeArchived: false })
    if (sections.has('papers')) aggregate.papers = this.repository.listPapers({ projectId, includeArchived: false })
    if (sections.has('matrix')) aggregate.matrix = this.repository.listLiteratureMatrix(projectId)
    if (sections.has('calendar')) aggregate.calendar = this.repository.listCalendarEvents({ startsAt: '1970-01-01T00:00:00.000Z', endsAt: '9999-12-31T23:59:59.999Z', timezone: 'UTC', projectId })
    if (sections.has('links')) {
      const resource: ResourceRef = { kind: 'project', id: projectId }
      aggregate.links = this.repository.listResourceLinks(resource)
    }
    if (sections.has('artifacts')) aggregate.artifacts = this.repository.listResearchArtifacts({ projectId })
    if (sections.has('notes')) {
      aggregate.notes = this.repository.listNoteIndex?.() ?? []
    }
    return aggregate
  }
}

/** Validate renderer localStorage tab state and drop stale entity contexts. */
export class WorkspaceTabCoordinator {
  constructor(private readonly repository: WorkbenchRepository) {}

  validate(input: unknown): WorkspaceTabState {
    const parsed = WorkspaceTabStateSchema.safeParse(input)
    if (!parsed.success) return { version: 1, tabs: [] }
    const tabs = parsed.data.tabs.filter((tab) => this.contextExists(tab))
    return { version: 1, tabs }
  }

  private contextExists(tab: WorkspaceTab): boolean {
    if (tab.context.projectId !== null && !this.repository.listProjects().some((project) => project.id === tab.context.projectId)) return false
    const resource = tab.context.resource
    return resource === null || this.resourceExists(resource)
  }

  private resourceExists(resource: ResourceRef): boolean {
    switch (resource.kind) {
      case 'project': return this.repository.listProjects().some((value) => value.id === resource.id)
      case 'task': return this.repository.listTasks({ view: 'all', includeArchived: true }).some((value) => value.id === resource.id)
      case 'paper': return this.repository.listPapers({ includeArchived: true }).some((value) => value.id === resource.id)
      case 'calendar-event': return this.repository.listCalendarEvents({ startsAt: '1970-01-01T00:00:00.000Z', endsAt: '9999-12-31T23:59:59.999Z', timezone: 'UTC' }).some((value) => value.id === resource.id)
      case 'artifact': return this.repository.listResearchArtifacts({}).some((value) => value.id === resource.id)
      case 'note': return true // note index may be connector-owned and unavailable offline
    }
  }
}

function notFound(kind: string, id: string): Error {
  const error = new Error(`${kind} not found`)
  error.name = 'NOT_FOUND'
  void id
  return error
}
