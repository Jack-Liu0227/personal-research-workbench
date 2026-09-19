import {
  agentModelSelector,
  customProviderIdIssue,
  customProviderUrlIssue,
  type AgentCustomProvider,
  type AgentCustomProviderModel,
  type AgentModelCatalogEntry,
  type AgentModelDiscoveryResult
} from '@prw/contracts'

/**
 * Renderer-side rules for model discovery and for the app-wide default model.
 *
 * Both decisions have to be the same everywhere they are made — in the custom
 * provider editor, in the default-model form and in the tests — so they live
 * here instead of inside JSX. Nothing in this module performs IO: it decides,
 * and the components act.
 *
 * The theme of the whole file is the same: a model selection is either exact or
 * absent, never "close enough". Discovery results are candidates until the user
 * adopts them, and a default is only saved when the exact `provider/modelId`
 * pair it names exists in the catalog.
 */

/** Which discovery probe a row may start, and why not when it may not. */
export function discoveryRequestIssue(provider: AgentCustomProvider, keyStored: boolean): string | null {
  if (customProviderIdIssue(provider.id) !== null) return '先填写合法的 Provider id，再发现模型。'
  const urlIssue = customProviderUrlIssue(provider.baseUrl)
  if (urlIssue !== null) return urlIssue
  if (!keyStored && !isLoopbackEndpoint(provider.baseUrl)) {
    // Stated before the request rather than discovered as a 401: a remote
    // endpoint is only probed with the key the user saved for this provider.
    return '远程端点需要该 Provider 的 API Key：先保存密钥，再发现模型。'
  }
  return null
}

/** Loopback endpoints are the only ones a keyless probe may touch. */
export function isLoopbackEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl.trim()).hostname.toLocaleLowerCase('en-US')
    return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

/**
 * A discovery result only describes the endpoint it came from.
 *
 * After the user edits the id, endpoint or protocol, the stored list is a
 * statement about something else, and adopting from it would write model ids
 * that were never advertised by the configuration in front of them.
 */
export function isDiscoveryStale(result: AgentModelDiscoveryResult, provider: AgentCustomProvider): boolean {
  return result.provider !== provider.id.trim() || result.baseUrl !== provider.baseUrl.trim() || result.api !== provider.api
}

/** Discovered models this provider does not already contain, in endpoint order. */
export function pendingDiscoveredModels(
  provider: AgentCustomProvider,
  result: AgentModelDiscoveryResult
): AgentCustomProviderModel[] {
  const existing = new Set(provider.models.map((model) => model.id.trim()))
  return result.models.filter((model) => !existing.has(model.id))
}

/**
 * Adopt the selected discovered models into one provider row.
 *
 * Explicit and additive: it only ever appends, it never rewrites a name the user
 * typed, and it reports how many rows it added so the form can say what
 * happened. The returned provider is draft state — `models.json` changes only
 * when the user saves.
 */
export function adoptDiscoveredModels(
  provider: AgentCustomProvider,
  result: AgentModelDiscoveryResult,
  selectedIds: readonly string[]
): { readonly provider: AgentCustomProvider; readonly added: number } {
  const wanted = new Set(selectedIds)
  const existing = new Set(provider.models.map((model) => model.id.trim()))
  const added: AgentCustomProviderModel[] = []
  for (const model of result.models) {
    if (!wanted.has(model.id) || existing.has(model.id)) continue
    existing.add(model.id)
    added.push({ ...model })
  }
  return {
    provider: added.length === 0 ? provider : { ...provider, models: [...provider.models, ...added] },
    added: added.length
  }
}

/**
 * Why the current default selection cannot be saved, or `null` when it can.
 *
 * The stored default is the exact pair (`provider` + `model`), which
 * `agentModelSelector` composes into the `provider/modelId` selector a run uses.
 * A model that is not in the catalog is therefore not a preference to be worked
 * around at run time — it is a selection that does not exist, and saving it
 * would only defer the failure to the next run. "No model chosen" stays valid:
 * nothing was claimed, so nothing can break.
 */
export function defaultSelectionIssue(
  provider: string | null,
  model: string | null,
  catalog: readonly Pick<AgentModelCatalogEntry, 'provider' | 'models'>[]
): string | null {
  const wantedProvider = (provider ?? '').trim()
  const wantedModel = (model ?? '').trim()
  if (wantedModel.length === 0) return null
  if (wantedProvider.length === 0) return '选择默认模型时必须同时指定 Provider：默认选择按 provider/modelId 精确保存。'
  const entry = catalog.find((item) => item.provider === wantedProvider)
  if (entry === undefined) {
    return `Provider "${wantedProvider}" 不在当前模型目录中：请先保存该 Provider，或改选一个目录里的 Provider。`
  }
  if (!entry.models.some((item) => item.id === wantedModel)) {
    return `模型 "${wantedProvider}/${wantedModel}" 不在当前目录中：默认选择按 provider/modelId 精确定位，不会回退到其它模型。请重新选择一个模型，或先保存模型列表。`
  }
  return null
}

/**
 * The exact selector a run will use for the current default selection, plus the
 * sentence that explains it. Shown in the form so the stored pair and the value
 * the runtime receives are visibly the same thing.
 */
export function defaultSelectionSummary(provider: string | null, model: string | null): string {
  const selector = agentModelSelector(provider, model)
  if (selector === null) return '未指定默认模型：运行时使用第一个已配置凭据可用的模型。'
  return `运行时使用精确选择 ${selector}；该模型不在目录中时运行会失败，而不是改用其它模型。`
}
