export type DatabaseErrorCode =
  | 'DATABASE_ERROR'
  | 'VALIDATION_FAILED'
  | 'INVALID_PLACEMENT'
  | 'NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'CONFIRMATION_REQUIRED'
  | 'CONFIRMATION_INVALID'

export class WorkbenchDatabaseError extends Error {
  readonly code: DatabaseErrorCode
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(
    code: DatabaseErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {}
  ) {
    super(message)
    this.name = 'WorkbenchDatabaseError'
    this.code = code
    this.retryable = options.retryable ?? false
    if (options.details !== undefined) {
      this.details = options.details
    }
  }
}

export function notFound(entity: 'project' | 'task' | 'board column' | 'calendar event' | 'calendar marker', id: string): never {
  throw new WorkbenchDatabaseError('NOT_FOUND', `${entity} not found`, {
    details: { entity, id }
  })
}

export function assertExpectedRevision(
  entity: 'project' | 'task' | 'calendar event' | 'calendar marker',
  id: string,
  actual: number,
  expected: number
): void {
  if (actual !== expected) {
    throw new WorkbenchDatabaseError(
      'REVISION_CONFLICT',
      `${entity} was changed by another operation`,
      {
        retryable: true,
        details: { entity, id, expectedRevision: expected, actualRevision: actual }
      }
    )
  }
}
