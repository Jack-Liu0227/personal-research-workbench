import type { AppError } from '@prw/contracts'
import { PromptRenderError, ProviderRuntimeError } from '@prw/ai-runtime'
import { WorkbenchDatabaseError } from '@prw/database'
import { IntegrationRuntimeError } from '@prw/connectors'
import { ZodError } from 'zod'

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

function toJsonValue(value: unknown): JsonValue {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item))
  if (typeof value === 'object') {
    const result: { [key: string]: JsonValue } = {}
    for (const [key, item] of Object.entries(value)) result[key] = toJsonValue(item)
    return result
  }
  return String(value)
}

function toJsonDetails(value: unknown): Record<string, JsonValue> {
  const normalized = toJsonValue(value)
  return normalized !== null && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized
    : { value: normalized }
}

export function normalizeAppError(error: unknown): AppError {
  if (error instanceof WorkbenchDatabaseError) {
    const result: AppError = {
      code: error.code,
      message: error.message,
      retryable: error.retryable
    }
    if (error.details !== undefined) result.details = toJsonDetails(error.details)
    return result
  }

  if (error instanceof ZodError) {
    return {
      code: 'VALIDATION_FAILED',
      message: 'The request did not match the expected shape.',
      retryable: false,
      details: toJsonDetails({ issues: error.issues })
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
  if (details !== undefined) result.details = toJsonDetails(details)
  return result
}
