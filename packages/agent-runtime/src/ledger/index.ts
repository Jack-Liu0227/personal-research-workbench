import { PiLedgerNormalizer } from './pi.js'
import type { LedgerNormalizer } from './types.js'

export { PiLedgerNormalizer } from './pi.js'
export { BaseLedgerNormalizer, ledgerUsage } from './types.js'
export type { LedgerNormalizer, LedgerStatus } from './types.js'

/**
 * The workbench has exactly one Agent runtime, so the factory exists only to
 * keep the coordinator's call site explicit about what it is creating.
 *
 * One normalizer per run: it holds the turn/step counters and the open records
 * for that run, so it must never be shared between runs.
 */
export function createLedgerNormalizer(): LedgerNormalizer {
  return new PiLedgerNormalizer()
}
