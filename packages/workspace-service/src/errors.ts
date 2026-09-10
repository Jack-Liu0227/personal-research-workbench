import type { AppError, ExternalWriteError, IntegrationProvider } from '@prw/contracts'
import { PromptRenderError, ProviderRuntimeError } from '@prw/ai-runtime'
import { WorkbenchDatabaseError } from '@prw/database'
import { IntegrationRuntimeError } from '@prw/connectors'
import { ZodError } from 'zod'

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** Convert boundary details to the JSON value shape used by RpcResponse. */
function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((entry) => toJsonValue(entry))
  if (typeof value === 'object') {
    const result: { [key: string]: JsonValue } = {}
    for (const [key, entry] of Object.entries(value)) result[key] = toJsonValue(entry)
    return result
  }
  return String(value)
}

function toJsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {}
  for (const [key, entry] of Object.entries(value)) result[key] = toJsonValue(entry)
  return result
}

export class RedactedExternalError extends Error {
  readonly code: ExternalWriteError['code']
  readonly provider: IntegrationProvider
  readonly entityKind: ExternalWriteError['entityKind']
  readonly entityId: string
  readonly externalId: string | null
  readonly remoteRevision: string | null
  readonly retryable: boolean
  readonly requiresConfirmation: boolean
  readonly partial: boolean

  constructor(input: Omit<ExternalWriteError, 'message'> & { message: string }) {
    super(input.message)
    this.name = 'RedactedExternalError'
    this.code = input.code
    this.provider = input.provider
    this.entityKind = input.entityKind
    this.entityId = input.entityId
    this.externalId = input.externalId
    this.remoteRevision = input.remoteRevision
    this.retryable = input.retryable
    this.requiresConfirmation = input.requiresConfirmation
    this.partial = input.partial
  }
}

export function normalizeAppError(error: unknown): AppError {
  if (error instanceof WorkbenchDatabaseError) {
    const result: AppError = {
      code: error.code,
      message: error.message,
      retryable: error.retryable
    }
    if (error.details !== undefined) result.details = toJsonRecord(error.details)
    return result
  }

  if (error instanceof RedactedExternalError) {
    return {
      code: error.code,
      provider: error.provider,
      entityKind: error.entityKind,
      entityId: error.entityId,
      externalId: error.externalId,
      remoteRevision: error.remoteRevision,
      retryable: error.retryable,
      requiresConfirmation: error.requiresConfirmation,
      partial: error.partial,
      message: error.message
    }
  }

  if (error instanceof ZodError) {
    return {
      code: 'VALIDATION_FAILED',
      message: 'The request did not match the expected shape.',
      retryable: false,
      details: {
        issues: error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.map((segment): string | number => typeof segment === 'string' || typeof segment === 'number' ? segment : String(segment)),
          message: issue.message
        }))
      }
    }
  }

  if (error instanceof IntegrationRuntimeError) {
    return {
      code: `INTEGRATION_${error.code}`,
      message: error.message,
      retryable: ['RATE_LIMITED', 'TEMPORARILY_UNAVAILABLE'].includes(error.code)
    }
  }

  if (error instanceof ProviderRuntimeError) {
    return {
      code: `AI_${error.code}`,
      message: safeProviderMessage(error.code),
      retryable: ['RATE_LIMITED', 'PROVIDER_ERROR'].includes(error.code)
    }
  }

  if (error instanceof PromptRenderError) {
    return {
      code: 'PROMPT_RENDER_FAILED',
      message: error.message,
      retryable: false
    }
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return {
      code: 'OPERATION_CANCELED',
      message: 'The operation was canceled.',
      retryable: false
    }
  }

  if (error instanceof Error && (error.name === 'PERMISSION_DENIED' || error.name === 'READ_ONLY_PROJECTION' || error.name === 'FEATURE_DISABLED' || error.name === 'NOT_FOUND' || error.name === 'VALIDATION_FAILED')) {
    return { code: error.name, message: error.message, retryable: false }
  }
  if (error instanceof Error && (error.name === 'CONFIRMATION_REQUIRED' || error.name === 'CONFIRMATION_INVALID')) {
    return { code: error.name, message: error.message, retryable: false }
  }

  return {
    code: 'INTERNAL_ERROR',
    message: 'The workbench could not complete this operation.',
    retryable: false
  }
}

function safeProviderMessage(code: ProviderRuntimeError['code']): string {
  switch (code) {
    case 'AUTH_REQUIRED': return 'The selected provider requires a valid credential.'
    case 'INVALID_ENDPOINT': return 'The selected provider endpoint is invalid.'
    case 'RATE_LIMITED': return 'The selected provider is rate limited. Try again later.'
    case 'INVALID_RESPONSE': return 'The selected provider returned an invalid response.'
    case 'PROVIDER_ERROR': return 'The selected provider could not complete the request.'
  }
}

export function appError(
  code: string,
  message: string,
  retryable = false,
  details?: Record<string, unknown>
): AppError {
  const result: AppError = { code, message, retryable }
  if (details !== undefined) result.details = toJsonRecord(details)
  return result
}
