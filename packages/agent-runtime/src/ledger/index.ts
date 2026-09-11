import type { AgentRuntimeKind } from '@prw/contracts'
import { CodexLedgerNormalizer } from './codex.js'
import { PiLedgerNormalizer } from './pi.js'
import type { LedgerNormalizer } from './types.js'

export { CodexLedgerNormalizer } from './codex.js'
export { PiLedgerNormalizer } from './pi.js'
export { BaseLedgerNormalizer, ledgerUsage } from './types.js'
export type { LedgerNormalizer, LedgerStatus } from './types.js'

/** One normalizer per run: it holds the turn/step counters and the open
 * records for that run, so it must never be shared between runs. */
export function createLedgerNormalizer(kind: AgentRuntimeKind): LedgerNormalizer {
  return kind === 'codex' ? new CodexLedgerNormalizer() : new PiLedgerNormalizer()
}
