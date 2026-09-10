import type { WorkbenchAgentApiV1, WorkbenchApiV2 } from '@prw/contracts'

declare global {
  interface Window {
    workbench: {
      v2: WorkbenchApiV2
      agent: WorkbenchAgentApiV1
    }
  }
}

export {}
