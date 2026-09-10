import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Shared renderer copy for states and actions. Feature pages should consume
 * these labels instead of inventing English fallbacks or exposing raw errors. */
export const uiCopy = {
  action: {
    cancel: '取消',
    close: '关闭',
    retry: '重试',
    refresh: '刷新',
    save: '保存'
  },
  state: {
    loading: '正在整理工作台…',
    loadingData: '正在读取数据…',
    readError: '读取失败',
    operationError: '操作未能完成，请重试。',
    unavailable: '该功能在当前版本暂不可用。',
    noData: '暂无数据'
  }
} as const

/** A typed, local-only error used when a legacy route is intentionally absent
 * from WorkbenchApiV2. It must never be confused with an empty successful
 * response: callers can render an explicit unavailable state. */
export class FeatureUnavailableError extends Error {
  readonly code = 'FEATURE_UNAVAILABLE' as const
  readonly feature: string

  constructor(feature: string) {
    super(`${featureLabel(feature)}${uiCopy.state.unavailable}`)
    this.name = 'FeatureUnavailableError'
    this.feature = feature
  }
}

function featureLabel(feature: string): string {
  switch (feature) {
    case 'prompt-templates': return '提示词模板'
    case 'ai-providers': return 'AI Provider 配置'
    case 'agent-runs': return 'Agent 运行'
    case 'schedules': return '自动化排程'
    default: return '该功能'
  }
}

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function formatDate(value: string | null): string {
  if (!value) return '未设定'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '日期无效'
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(date)
}

export function formatDateTime(value: string | null): string {
  if (!value) return '尚无记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '日期无效'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(date)
}

export function toEndOfDayIso(value: string): string | null {
  if (!value) return null
  // Preserve minute precision from datetime-local. Date-only values remain
  // supported for legacy callers and are interpreted as end-of-day.
  const date = new Date(value.includes('T') ? value : `${value}T23:59:59`)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof FeatureUnavailableError) return error.message

  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown }
    if (typeof candidate.code === 'string') {
      const mapped = errorCodeCopy[candidate.code]
      if (mapped) return mapped
    }
    if (typeof candidate.message === 'string') {
      // Zod errors thrown by a legacy preload stringify as an issues array.
      // Never surface that implementation detail in the Agent UI.
      if (/^\s*\[\s*\{\s*"expected"\s*:/u.test(candidate.message)) return errorCodeCopy.VALIDATION_FAILED ?? uiCopy.state.operationError
      if (isSafeUserMessage(candidate.message)) return candidate.message
    }
  }
  if (error instanceof Error) {
    if (/^\s*\[\s*\{\s*"expected"\s*:/u.test(error.message)) return errorCodeCopy.VALIDATION_FAILED ?? uiCopy.state.operationError
    if (isSafeUserMessage(error.message)) return error.message
  }
  return uiCopy.state.operationError
}

const errorCodeCopy: Record<string, string> = {
  FEATURE_UNAVAILABLE: uiCopy.state.unavailable,
  VALIDATION_FAILED: '输入内容不符合要求，请检查后重试。',
  NOT_FOUND: '目标记录不存在，可能已被删除。',
  REVISION_CONFLICT: '记录已被其他操作更新，请刷新后重试。',
  PERMISSION_DENIED: '当前操作未获授权。',
  CONFIRMATION_REQUIRED: '请先确认此操作后再继续。',
  CONFIRMATION_INVALID: '确认已失效，请重新发起操作。',
  EXTERNAL_NOT_CONFIGURED: '该连接尚未配置。',
  EXTERNAL_UNAVAILABLE: '外部服务暂不可用，请稍后重试。',
  EXTERNAL_UNAUTHORIZED: '外部连接未获授权，请检查配置。',
  EXTERNAL_RATE_LIMITED: '外部服务请求过于频繁，请稍后重试。',
  EXTERNAL_CONFLICT: '外部记录已发生冲突，请刷新后处理。',
  EXTERNAL_UNSUPPORTED: '当前连接不支持此操作。',
  EXTERNAL_VALIDATION: '外部服务拒绝了此内容，请检查后重试。',
  EXTERNAL_IO: '外部文件操作失败，请重试。',
  OPERATION_CANCELED: '操作已取消。',
  INTERNAL_ERROR: uiCopy.state.operationError
}

function isSafeUserMessage(message: string): boolean {
  return message.length > 0 && message.length <= 500 && !/([A-Za-z]:[\\/]|\\\\|Bearer\s|token=|api[_-]?key|password=|secret=)/i.test(message)
}
