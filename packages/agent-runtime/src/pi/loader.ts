import type * as TypeboxModule from 'typebox'
import type * as Pi from '@earendil-works/pi-coding-agent'
import { isolatedRuntimeEnvironment } from '../support.js'

/**
 * The single place in the repository that loads Pi's ESM modules.
 *
 * Three constraints force this to be a dynamic import in one module:
 *
 *  1. `@earendil-works/pi-coding-agent` and `typebox` are ESM-only while the
 *     Core worker is built as CommonJS, so a static import would be rewritten
 *     by Rollup into a `require()` that throws at runtime.
 *  2. Both must stay external (Pi ships wasm through `photon-node`, uses
 *     `import.meta.url` for resource paths and dynamically imports theme JSON),
 *     so bundling them is not an option.
 *  3. `getAgentDir()` reads `PI_CODING_AGENT_DIR` from the environment on every
 *     call, and that variable decides whether the SDK can ever reach `~/.pi`.
 *     Setting it here — immediately before the module is evaluated — keeps the
 *     guard adjacent to the load instead of depending on process startup
 *     ordering somewhere else.
 */
export type PiSdk = typeof Pi
export type Typebox = typeof TypeboxModule

let cached: Promise<PiSdk> | null = null
let cachedTypebox: Promise<Typebox> | null = null

/** Load (once per process) the Pi SDK with the app-owned profile directory
 * installed as the SDK's agent dir. */
export function loadPiSdk(profileDir: string): Promise<PiSdk> {
  for (const [key, value] of Object.entries(isolatedRuntimeEnvironment('pi', profileDir))) {
    process.env[key] = value
  }
  cached ??= import('@earendil-works/pi-coding-agent')
  return cached
}

/**
 * TypeBox is loaded dynamically for the same CommonJS reason as the SDK.
 *
 * It is needed to build tool parameter schemas: Pi validates tool arguments
 * against `Type.Unsafe(schema)`, and the safe alternative is the raw JSON
 * Schema object, which is what a `typebox` build without `Unsafe` would get.
 * Going through this loader means the workbench never emits a `require()`
 * for an ESM-only package.
 */
export function loadTypebox(): Promise<Typebox> {
  cachedTypebox ??= import('typebox')
  return cachedTypebox
}

/** Test seam: drop the memoized modules so a case can assert the guard ran with
 * a different profile directory. Not used in production code paths. */
export function resetPiSdkCache(): void {
  cached = null
  cachedTypebox = null
}
