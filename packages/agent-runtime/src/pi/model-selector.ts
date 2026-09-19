/**
 * Classification of one stored model selector, before it is resolved.
 *
 * Kept separate from the adapter because this is the decision that makes a
 * default selection *honest*: the settings UI stores the exact pair
 * (`provider` + `model`, composed by `agentModelSelector` as `provider/modelId`),
 * and that pair must resolve to exactly the model the user picked — or not run
 * at all. The adapter used to fall through to `available[0] ?? models[0]` for
 * any selector it could not match, which silently ran a different model while
 * the UI kept displaying the configured one.
 *
 * Two shapes stay tolerant on purpose:
 *
 *  - a bare model id (a hand-edited database value from before the pair was
 *    stored) is still matched against the catalog by id;
 *  - an `unset` selector keeps the existing "first model the credentials can
 *    call" behavior, because nothing was chosen and there is no claim to break.
 *
 * A slash is only treated as a provider separator when its head is a provider
 * the runtime actually knows. Model ids legitimately contain slashes (OpenRouter
 * style `meta-llama/llama-3-70b`, discovered ids included), so guessing would
 * turn a working hand-edited value into a hard failure.
 */

/** One stored selector, classified. */
export type ModelSelection =
  /** Nothing selected: the runtime may use the first usable model. */
  | { readonly kind: 'unset' }
  /** The exact `provider/modelId` pair named by a known provider. */
  | { readonly kind: 'exact'; readonly provider: string; readonly modelId: string }
  /** A bare model id, matched by id against the whole catalog. */
  | { readonly kind: 'bare'; readonly modelId: string }

/**
 * Classify a stored selector.
 *
 * `knownProviders` is the runtime's provider ids. It decides only whether a
 * slash is a separator; the caller still performs the lookup, so this function
 * stays pure and testable without the SDK.
 */
export function planModelSelection(
  selector: string | null | undefined,
  knownProviders: Iterable<string>
): ModelSelection {
  const trimmed = selector?.trim() ?? ''
  if (trimmed.length === 0) return { kind: 'unset' }
  const slash = trimmed.indexOf('/')
  // A leading or trailing slash names no provider, so the value is not a pair.
  if (slash > 0 && slash < trimmed.length - 1) {
    const provider = trimmed.slice(0, slash)
    if (new Set(knownProviders).has(provider)) {
      return { kind: 'exact', provider, modelId: trimmed.slice(slash + 1) }
    }
  }
  return { kind: 'bare', modelId: trimmed }
}

/**
 * A selection that names a configured provider but a model it does not offer.
 *
 * Thrown instead of falling back, so a run fails visibly rather than running a
 * model the user did not choose. `name` is `VALIDATION_FAILED` for the same
 * reason as `PiModelsFileError`: `normalizeAppError` keeps the real message for
 * that name, and the message is the only thing that tells the user what to fix.
 */
export class ModelSelectionError extends Error {
  readonly provider: string
  readonly modelId: string

  constructor(provider: string, modelId: string) {
    super(
      `模型 "${provider}/${modelId}" 不在当前模型目录中：默认选择按 provider/modelId 精确定位，不会回退到其它模型。请在设置中选择一个已配置的模型，或为该 Provider 重新发现模型。`
    )
    this.name = 'VALIDATION_FAILED'
    this.provider = provider
    this.modelId = modelId
  }
}
