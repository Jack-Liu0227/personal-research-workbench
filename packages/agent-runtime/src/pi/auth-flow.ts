import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai'
import type { AgentAuthEvent } from '@prw/contracts'
import type { AgentAuthChannel, AgentAuthPromptRequest } from '../index.js'

/**
 * Adapter from Pi's login callbacks to the workbench's IPC event channel.
 *
 * Pi deliberately leaves login orchestration to the host: `AuthInteraction` is
 * a plain callback contract, and the host decides where prompts are rendered
 * and how a browser is opened. The workbench is a desktop app with a renderer
 * that already has an event channel, so the mapping is:
 *
 *  - `notify(event)` becomes a push over IPC. Nothing here may throw, because
 *    the SDK calls it from inside its own login coroutine and an exception
 *    would surface as a failed login for an unrelated reason.
 *  - `prompt(prompt)` publishes a request the renderer answers, and resolves
 *    with the string Pi expects (`select` resolves to the option id). A `select`
 *    is answered here instead (see `preferredSelectAnswer`) because the app has
 *    a policy for it and a second dialog in front of the browser is not wanted.
 *
 * A `manual_code` prompt races a callback server in some providers, and Pi
 * aborts the losing prompt through `AuthPrompt.signal`. That signal is honoured
 * here, so a prompt that lost the race rejects and is discarded instead of
 * staying on screen.
 */
export function createAuthInteraction(channel: AgentAuthChannel, loginId: string, signal: AbortSignal): AuthInteraction {
  return {
    signal,
    async prompt(prompt: AuthPrompt): Promise<string> {
      if (prompt.type === 'select') {
        const preferred = preferredSelectAnswer(prompt.options)
        if (preferred) {
          try {
            channel.push({ kind: 'info', loginId, message: `已自动选择「${preferred.label}」，授权页面将在浏览器中打开。` })
          } catch {
            // Reporting the choice must not be able to fail the login.
          }
          return preferred.id
        }
      }
      const request: AgentAuthPromptRequest = {
        loginId,
        kind: prompt.type,
        message: prompt.message,
        placeholder: 'placeholder' in prompt ? (prompt.placeholder ?? null) : null,
        options:
          prompt.type === 'select'
            ? prompt.options.map((option) => ({
                value: option.id,
                label: option.label,
                description: option.description ?? null
              }))
            : []
      }
      const answer = channel.prompt(request)
      // Pi signals per-prompt cancellation (a callback server won the race) on
      // the prompt itself, not on the interaction.
      const cancelled = prompt.signal
      if (!cancelled) return answer
      return new Promise<string>((resolve, reject) => {
        const onAbort = (): void => reject(new Error('agent login prompt cancelled'))
        if (cancelled.aborted) { onAbort(); return }
        cancelled.addEventListener('abort', onAbort, { once: true })
        answer.then(resolve, reject).finally(() => cancelled.removeEventListener('abort', onAbort))
      })
    },
    notify(event: AuthEvent): void {
      try {
        channel.push(toAgentAuthEvent(loginId, event))
      } catch {
        // A listener on the other side of IPC must never break the login flow.
      }
    }
  }
}

/** One option Pi offers for a `select` prompt. Pi identifies an option by `id`,
 * which is also the answer string it compares against. */
export interface LoginMethodOption {
  readonly id: string
  readonly label: string
  readonly description?: string | undefined
}

/**
 * The sign-in method the app picks instead of asking the user.
 *
 * Pi asks "browser or device code?" for a provider with more than one flow, and
 * both answers end in a page the app opens through `shell.openExternal`. The
 * question is therefore not worth a dialog: the user already asked to log in,
 * and a dialog that gets dismissed answers with an empty string, which Pi
 * rejects as an unknown method. Order of preference:
 *
 *  1. an option naming a browser, which is the flow with a loopback callback
 *     and nothing to copy out of the address bar;
 *  2. an option the provider labels as the default or recommended flow;
 *  3. the first option, which is where a provider puts its preferred flow.
 *
 * `null` means there was nothing to choose from. The prompt then goes to the
 * renderer, because an option list with no usable entry is exactly the case the
 * renderer must still be able to show.
 */
export function preferredSelectAnswer(options: readonly LoginMethodOption[]): LoginMethodOption | null {
  const offered = options.filter((option) => option.id.trim().length > 0)
  if (offered.length === 0) return null
  const named = (pattern: RegExp): LoginMethodOption | undefined =>
    offered.find((option) => pattern.test(`${option.id} ${option.label}`))
  return named(/\bbrowser\b/iu) ?? named(/\bdefault\b|\brecommended\b|推荐/iu) ?? offered[0]!
}

/**
 * Map one Pi auth event onto the renderer contract.
 *
 * `AuthInfoLink` has no counterpart in the contract, so links are folded into
 * the message text. Dropping them would hide the only actionable part of some
 * provider messages.
 */
export function toAgentAuthEvent(loginId: string, event: AuthEvent): AgentAuthEvent {
  switch (event.type) {
    case 'info': {
      const links = event.links ?? []
      const suffix = links.map((link) => (link.label ? `${link.label}: ${link.url}` : link.url)).join(' ')
      return { kind: 'info', loginId, message: suffix.length > 0 ? `${event.message} ${suffix}` : event.message }
    }
    case 'auth_url':
      return {
        kind: 'auth_url',
        loginId,
        url: event.url,
        instructions: event.instructions ?? null
      }
    case 'device_code':
      return {
        kind: 'device_code',
        loginId,
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        expiresInSeconds: event.expiresInSeconds ?? null
      }
    case 'progress':
      return { kind: 'progress', loginId, message: event.message }
    default:
      return { kind: 'info', loginId, message: 'unknown authentication event' }
  }
}
