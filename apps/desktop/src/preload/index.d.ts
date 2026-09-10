import type { WorkbenchAgentApiV1, WorkbenchApiV2 } from '@prw/contracts'

declare global {
  interface Window {
    readonly workbench: {
      readonly v2: WorkbenchApiV2
      readonly agent: WorkbenchAgentApiV1
    }
  }
}

export {}
