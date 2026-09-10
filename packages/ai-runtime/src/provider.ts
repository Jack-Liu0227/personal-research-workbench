import {
  createModels,
  createProvider,
  type Api,
  type AssistantMessage,
  type Model,
  type ProviderStreams
} from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import type { AgentWorkflowKey, AiApi, AiProviderId, AiProviderProfile, Paper } from '@prw/contracts'

export interface GeneratedCitation {
  readonly label: string
  readonly url: string | null
}

export interface GenerationResult {
  readonly text: string
  readonly citations: GeneratedCitation[]
  readonly usage: {
    readonly inputTokens: number | null
    readonly outputTokens: number | null
  }
}

export interface GenerateRequest {
  readonly workflowKey: AgentWorkflowKey
  readonly systemPrompt: string
  readonly userPrompt: string
  readonly papers: Paper[]
  readonly webSearch?: boolean | undefined
}

export interface ProviderRuntimeOptions {
  readonly profile: AiProviderProfile
  /** Decrypted only for this invocation by the Electron main process. */
  readonly credential?: string | undefined
  readonly fetcher?: typeof fetch | undefined
}

export class ProviderRuntimeError extends Error {
  readonly code: 'AUTH_REQUIRED' | 'INVALID_ENDPOINT' | 'RATE_LIMITED' | 'PROVIDER_ERROR' | 'INVALID_RESPONSE'

  constructor(code: ProviderRuntimeError['code'], message: string) {
    super(message)
    this.name = 'ProviderRuntimeError'
    this.code = code
  }
}

export interface ProviderPreset {
  readonly api: AiApi
  readonly baseUrl: string
  readonly model: string
}

/** Defaults are suggestions only; every non-mock profile may override baseUrl and model. */
export const providerPresets: Record<Exclude<AiProviderId, 'custom'>, ProviderPreset> = {
  mock: { api: 'mock', baseUrl: '', model: 'deterministic' },
  openai: { api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini' },
  anthropic: { api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5' },
  deepseek: { api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
  xai: { api: 'openai-responses', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.6' },
  gemini: { api: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-3.6-flash' },
  ollama: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' }
}

function baseUrlFor(profile: AiProviderProfile): string {
  const fallback = profile.provider === 'custom' ? '' : providerPresets[profile.provider].baseUrl
  const raw = profile.baseUrl.trim() || fallback
  if (!raw) throw new ProviderRuntimeError('INVALID_ENDPOINT', '自定义 Provider 必须填写 Base URL')

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ProviderRuntimeError('INVALID_ENDPOINT', 'Base URL 不是有效 URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ProviderRuntimeError('INVALID_ENDPOINT', 'Base URL 仅支持 HTTP 或 HTTPS')
  }
  if (url.username || url.password) {
    throw new ProviderRuntimeError('INVALID_ENDPOINT', '请勿把凭据写入 Base URL；请使用 API Key 字段')
  }
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function assertEndpointTransport(baseUrl: string): void {
  const url = new URL(baseUrl)
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
  if (url.protocol === 'http:' && !loopback) {
    throw new ProviderRuntimeError(
      'INVALID_ENDPOINT',
      '远程 Provider 必须使用 HTTPS；本机 loopback 地址可使用 HTTP'
    )
  }
}

function streamsFor(api: Exclude<AiApi, 'mock'>): ProviderStreams {
  switch (api) {
    case 'openai-responses': return openAIResponsesApi()
    case 'openai-completions': return openAICompletionsApi()
    case 'anthropic-messages': return anthropicMessagesApi()
    case 'google-generative-ai': return googleGenerativeAIApi()
  }
}

function allowsKeylessOpenAiCompatibility(profile: AiProviderProfile): boolean {
  if (profile.credentialPresent) return false
  if (!['openai-responses', 'openai-completions'].includes(profile.api)) return false
  return profile.provider === 'ollama' || profile.provider === 'custom'
}

function fetchWithoutAuthorization(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request
      ? new Request(input, init)
      : new Request(input, init)
    const headers = new Headers(request.headers)
    headers.delete('authorization')
    return fetcher(new Request(request, { headers }))
  }
}

function modelFor(profile: AiProviderProfile, baseUrl: string): Model<Api> {
  return {
    id: profile.model,
    name: profile.model,
    api: profile.api,
    provider: profile.id,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192
  }
}

function textFrom(message: AssistantMessage): string {
  return message.content
    .flatMap((block) => block.type === 'text' ? [block.text] : [])
    .join('\n')
    .trim()
}

function citationsFrom(text: string, papers: readonly Paper[]): GeneratedCitation[] {
  const citations = new Map<string, GeneratedCitation>()
  for (const paper of papers) {
    const url = paper.url ?? (paper.doi ? `https://doi.org/${paper.doi}` : null)
    if (url) citations.set(url, { label: paper.title, url })
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>()\]]+/gu)) {
    const url = match[0].replace(/[.,;:!?，。；：！？]+$/u, '')
    if (!citations.has(url)) citations.set(url, { label: `模型来源 ${citations.size + 1}`, url })
  }
  return [...citations.values()]
}

function hostedWebSearchPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  const record = payload as Record<string, unknown>
  const tools = Array.isArray(record['tools']) ? record['tools'] : []
  if (tools.some((tool) => tool && typeof tool === 'object' && (tool as Record<string, unknown>)['type'] === 'web_search')) {
    return payload
  }
  return { ...record, tools: [...tools, { type: 'web_search' }] }
}

function mapRuntimeError(error: unknown): ProviderRuntimeError {
  if (error instanceof ProviderRuntimeError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/\b(401|403)\b|api[ _-]?key|unauthori[sz]ed|authentication/iu.test(message)) {
    return new ProviderRuntimeError('AUTH_REQUIRED', `模型服务认证失败：${message}`)
  }
  if (/\b429\b|rate.?limit/iu.test(message)) {
    return new ProviderRuntimeError('RATE_LIMITED', `模型服务达到速率限制：${message}`)
  }
  return new ProviderRuntimeError('PROVIDER_ERROR', `模型服务请求失败：${message}`)
}

async function generateWithPi(
  options: ProviderRuntimeOptions,
  request: GenerateRequest,
  signal?: AbortSignal
): Promise<GenerationResult> {
  if (options.profile.api === 'mock') {
    throw new ProviderRuntimeError('INVALID_ENDPOINT', '真实 Provider 不能使用 mock API')
  }
  const keyless = !options.credential && allowsKeylessOpenAiCompatibility(options.profile)
  if (!options.credential && !keyless) {
    throw new ProviderRuntimeError('AUTH_REQUIRED', `${options.profile.name} 尚未配置 API key`)
  }

  const baseUrl = baseUrlFor(options.profile)
  assertEndpointTransport(baseUrl)
  // Pi's OpenAI-compatible adapter requires an API key before it reaches fetch.
  // A private placeholder satisfies that invariant, while the boundary wrapper
  // removes its Authorization header so deliberately keyless servers stay keyless.
  const runtimeApiKey = options.credential ?? 'prw-keyless-placeholder'
  const runtimeFetcher = keyless
    ? fetchWithoutAuthorization(options.fetcher ?? fetch)
    : options.fetcher
  const model = modelFor(options.profile, baseUrl)
  const runtime = createModels()
  const provider = createProvider({
    id: options.profile.id,
    name: options.profile.name,
    baseUrl,
    auth: {
      apiKey: {
        name: `${options.profile.name} API key`,
        resolve: async () => ({ auth: { apiKey: runtimeApiKey } })
      }
    },
    models: [model],
    api: streamsFor(options.profile.api)
  })
  runtime.setProvider(provider)

  try {
    const response = await runtime.completeSimple(model, {
      systemPrompt: request.systemPrompt,
      messages: [{ role: 'user', content: request.userPrompt, timestamp: Date.now() }]
    }, {
      apiKey: runtimeApiKey,
      ...(runtimeFetcher ? { fetch: runtimeFetcher } : {}),
      ...(signal ? { signal } : {}),
      timeoutMs: 120_000,
      maxRetries: 2,
      maxTokens: model.maxTokens,
      ...(request.webSearch && options.profile.api === 'openai-responses'
        ? { onPayload: hostedWebSearchPayload }
        : {})
    })
    if (response.stopReason === 'error' || response.stopReason === 'aborted') {
      throw new Error(response.errorMessage ?? `模型停止原因：${response.stopReason}`)
    }
    const text = textFrom(response)
    if (!text) throw new ProviderRuntimeError('INVALID_RESPONSE', '模型服务未返回文本')
    return {
      text,
      citations: citationsFrom(text, request.papers),
      usage: {
        inputTokens: response.usage.input,
        outputTokens: response.usage.output
      }
    }
  } catch (error) {
    throw mapRuntimeError(error)
  }
}

function mockResult(request: GenerateRequest): GenerationResult {
  const sourceLines = request.papers.length > 0
    ? request.papers.map((paper, index) => `${index + 1}. ${paper.title}${paper.doi ? `（DOI: ${paper.doi}）` : ''}`).join('\n')
    : '尚未选择文献；以下内容仅为结构化草稿，不构成证据结论。'
  return {
    text: `# ${request.workflowKey.replaceAll('_', ' ')} · Mock 草稿\n\n> 本结果由离线 Mock Provider 生成，用于验证工作流和界面；没有调用真实模型。\n\n## 输入来源\n\n${sourceLines}\n\n## 建议结构\n\n- 明确研究问题与可证伪假设\n- 区分已有证据、推断与待验证猜想\n- 记录方法、局限、替代解释与停止准则\n- 在正式产出前逐条核对引用\n\n## 用户任务\n\n${request.userPrompt.slice(0, 4_000)}`,
    citations: request.papers.map((paper) => ({ label: paper.title, url: paper.url ?? (paper.doi ? `https://doi.org/${paper.doi}` : null) })),
    usage: { inputTokens: null, outputTokens: null }
  }
}

export function generateWithProvider(
  options: ProviderRuntimeOptions,
  request: GenerateRequest,
  signal?: AbortSignal
): Promise<GenerationResult> {
  if ((options.profile.provider === 'mock') !== (options.profile.api === 'mock')) {
    throw new ProviderRuntimeError('INVALID_ENDPOINT', 'Mock Provider 与 Mock API 必须成对使用')
  }
  if (options.profile.provider === 'mock' && options.profile.api === 'mock') {
    return Promise.resolve(mockResult(request))
  }
  return generateWithPi(options, request, signal)
}
