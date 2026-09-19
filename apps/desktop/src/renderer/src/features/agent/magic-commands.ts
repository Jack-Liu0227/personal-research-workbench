import type { AgentCustomProviderApi } from '@prw/contracts'

export type AgentMagicCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'provider-list' }
  | { readonly kind: 'provider-add'; readonly id: string; readonly api: AgentCustomProviderApi; readonly baseUrl: string }
  | { readonly kind: 'provider-remove'; readonly id: string }
  | { readonly kind: 'provider-discover'; readonly id: string }
  | { readonly kind: 'model-list'; readonly provider: string | null }
  | { readonly kind: 'model-use'; readonly selector: string }
  | { readonly kind: 'key'; readonly provider: string }
  | { readonly kind: 'login'; readonly provider: string }
  | { readonly kind: 'logout'; readonly provider: string }
  | { readonly kind: 'settings' }

const APIs = new Set<AgentCustomProviderApi>([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai'
])

export function parseAgentMagicCommand(value: string): AgentMagicCommand | null | { readonly error: string } {
  const tokens = tokenize(value.trim())
  const first = tokens[0]
  if (first === undefined || !first.startsWith('/')) return null
  const command = first.slice(1).toLocaleLowerCase('en-US')
  const args = tokens.slice(1)
  if (command === 'help') return { kind: 'help' }
  if (command === 'agent' && args[0] === 'settings') return { kind: 'settings' }
  if (command === 'provider') {
    if (args[0] === 'list' && args.length === 1) return { kind: 'provider-list' }
    if (args[0] === 'remove' && args.length === 2 && args[1]) return { kind: 'provider-remove', id: args[1] }
    if (args[0] === 'discover' && args.length === 2 && args[1]) return { kind: 'provider-discover', id: args[1] }
    if (args[0] === 'add' && args.length === 4 && args[1] && APIs.has(args[2] as AgentCustomProviderApi) && args[3]) {
      return { kind: 'provider-add', id: args[1], api: args[2] as AgentCustomProviderApi, baseUrl: args[3] }
    }
    return { error: '用法：/provider list；/provider add <id> <api> <baseUrl>；/provider discover <id>；/provider remove <id>' }
  }
  if (command === 'model') {
    if (args[0] === 'list' && args.length <= 2) return { kind: 'model-list', provider: args[1] ?? null }
    if (args[0] === 'use' && args.length === 2 && args[1]) return { kind: 'model-use', selector: args[1] }
    return { error: '用法：/model list [provider]；/model use <provider>/<modelId>' }
  }
  if (command === 'key' && args.length === 1 && args[0]) return { kind: 'key', provider: args[0] }
  if (command === 'login' && args.length === 1 && args[0]) return { kind: 'login', provider: args[0] }
  if (command === 'logout' && args.length === 1 && args[0]) return { kind: 'logout', provider: args[0] }
  return { error: `未知或格式错误的命令：${tokens[0]}。输入 /help 查看支持的命令。` }
}

export const AGENT_MAGIC_SUGGESTIONS: readonly AgentMagicSuggestion[] = [
  { command: '/help', summary: '列出全部本地命令' },
  { command: '/model list', summary: '/model list [provider]：列出已配置的模型' },
  { command: '/model use ', summary: '/model use <provider>/<modelId>：设为默认模型' },
  { command: '/key ', summary: '/key <provider>：在设置中安全输入 API Key' },
  { command: '/login ', summary: '/login <provider>：用系统浏览器完成 OAuth 授权' },
  { command: '/agent settings', summary: '打开「模型与 Agent」设置' },
  { command: '/provider list', summary: '列出内嵌 Pi 的 Provider 与来源' },
  { command: '/provider add ', summary: '/provider add <id> <api> <baseUrl>：写入 models.json' },
  { command: '/provider discover ', summary: '/provider discover <id>：按协议探测模型列表' },
  { command: '/provider remove ', summary: '/provider remove <id>：从 models.json 移除（保留 Key）' },
  { command: '/logout ', summary: '/logout <provider>：清除本机凭据' }
]

/**
 * Suggestions matching what has been typed so far. Matching is a plain prefix
 * test against the command text so that partial words work (`/mo`), and a fully
 * typed command stays in the list because that is the form Enter accepts.
 */
export function filterAgentMagicSuggestions(value: string): readonly AgentMagicSuggestion[] {
  const trimmed = value.trimStart()
  if (!trimmed.startsWith('/')) return []
  const needle = trimmed.toLocaleLowerCase('en-US')
  return AGENT_MAGIC_SUGGESTIONS.filter((suggestion) => suggestion.command.toLocaleLowerCase('en-US').startsWith(needle))
}

function tokenize(value: string): string[] {
  const tokens: string[] = []
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/gu
  for (const match of value.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? match[3] ?? '')
  return tokens
}

export const AGENT_MAGIC_HELP = '/provider list | /provider add <id> <api> <baseUrl> | /provider discover <id> | /provider remove <id> | /model list [provider] | /model use <provider>/<modelId> | /key <provider> | /login <provider> | /logout <provider> | /agent settings'

/** One completable command, as offered by the composer's `/` palette. */
export interface AgentMagicSuggestion {
  /** Text inserted when the suggestion is accepted. A trailing space means the
   * command still needs an argument, which the `summary` states. */
  readonly command: string
  readonly summary: string
}
