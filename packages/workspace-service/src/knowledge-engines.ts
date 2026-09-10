import {
  KnowledgeEngineConfigSchema,
  KnowledgeEngineKindSchema,
  KnowledgeEngineSaveInputSchema,
  KnowledgeEngineTestInputSchema,
  KnowledgeEngineTestResultSchema,
  type KnowledgeEngineConfig,
  type KnowledgeEngineKind,
  type KnowledgeEngineSaveInput,
  type KnowledgeEngineTestResult
} from '@prw/contracts'
import type { WorkbenchRepository } from '@prw/database'

type FetchLike = typeof fetch

/**
 * Small, read-only health bridge for optional local knowledge engines.  The
 * workbench never shells out to either service and never sends an external
 * request from Renderer.  API keys are supplied by Main at call time and are
 * used only for the probe.
 */
export class KnowledgeEngineCoordinator {
  constructor(
    private readonly repository: WorkbenchRepository,
    private readonly fetcher: FetchLike = fetch
  ) {}

  list(): KnowledgeEngineConfig[] {
    return this.repository.listKnowledgeEngineConfigs().map((item) => KnowledgeEngineConfigSchema.parse(item))
  }

  save(inputValue: KnowledgeEngineSaveInput, secret: string | null = null): KnowledgeEngineConfig {
    const input = KnowledgeEngineSaveInputSchema.parse(inputValue)
    return this.repository.saveKnowledgeEngineConfig(input, secret !== null && secret.trim().length > 0)
  }

  async test(inputValue: { kind: KnowledgeEngineKind; secret?: string | null }): Promise<KnowledgeEngineTestResult> {
    const kind = KnowledgeEngineKindSchema.parse(inputValue.kind)
    const checkedAt = new Date().toISOString()
    const config = this.repository.getKnowledgeEngineConfig(kind)
    const secret = inputValue.secret?.trim() || null
    if (!config.enabled) return this.finish(kind, 'disconnected', '该知识引擎已停用。', checkedAt)
    if (!config.baseUrl.trim()) return this.finish(kind, 'not_configured', '请先填写服务地址。', checkedAt)

    let base: URL
    try {
      base = validatedBaseUrl(config.baseUrl)
    } catch {
      return this.finish(kind, 'error', '服务地址格式不正确；远程地址必须使用 HTTPS。', checkedAt)
    }

    const headers = new Headers({ Accept: 'application/json, text/plain;q=0.8' })
    if (secret) {
      headers.set('Authorization', `Bearer ${secret}`)
      headers.set('X-API-Key', secret)
    }
    let sawUnauthorized = false
    let sawServer = false
    for (const path of healthPaths(kind)) {
      const url = new URL(path, base)
      try {
        const response = await this.fetcher(url, { headers, signal: AbortSignal.timeout(8_000) })
        if (response.status === 401 || response.status === 403) {
          sawUnauthorized = true
          continue
        }
        if (response.status >= 500) {
          sawServer = true
          continue
        }
        if (response.ok) return this.finish(kind, 'connected', `${engineLabel(kind)} 已连接。`, checkedAt)
      } catch {
        // Try the next conventional health endpoint. The final message is
        // intentionally generic and never includes the configured URL.
      }
    }
    if (sawUnauthorized) return this.finish(kind, 'error', '服务已响应，但凭据无效或权限不足。', checkedAt)
    if (sawServer) return this.finish(kind, 'error', '服务已找到，但当前返回服务端错误。', checkedAt)
    return this.finish(kind, 'disconnected', `无法连接 ${engineLabel(kind)}；请确认服务已启动。`, checkedAt)
  }

  private finish(kind: KnowledgeEngineKind, status: 'connected' | 'disconnected' | 'not_configured' | 'error', message: string, checkedAt: string): KnowledgeEngineTestResult {
    this.repository.updateKnowledgeEngineStatus({ kind, status, message: status === 'connected' || status === 'not_configured' ? null : message, checkedAt })
    return KnowledgeEngineTestResultSchema.parse({ kind, ok: status === 'connected', status, message, checkedAt })
  }
}

function engineLabel(kind: KnowledgeEngineKind): string {
  return kind === 'anythingllm' ? 'AnythingLLM' : 'LLMWiki'
}

function healthPaths(kind: KnowledgeEngineKind): readonly string[] {
  return kind === 'anythingllm'
    ? ['/api/ping', '/api/system/ping', '/health', '/api/health', '/']
    : ['/health', '/api/health', '/api/ping', '/']
}

function validatedBaseUrl(value: string): URL {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash) throw new Error('unsafe url')
  const host = url.hostname.toLocaleLowerCase('en-US')
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)
  if ((!loopback && url.protocol !== 'https:') || (loopback && !['http:', 'https:'].includes(url.protocol))) throw new Error('unsafe protocol')
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

