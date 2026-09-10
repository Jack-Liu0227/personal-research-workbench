import type { WorkbenchAgentApiV1, WorkbenchApiV2 } from '@prw/contracts'

export function getWorkbenchApi(): WorkbenchApiV2 {
  const api = window.workbench?.v2
  if (!api) {
    throw new Error('工作台服务未就绪，请重启应用。')
  }
  return api
}

export function getWorkbenchAgentApi(): WorkbenchAgentApiV1 {
  const api = (window.workbench as unknown as { agent?: WorkbenchAgentApiV1 })?.agent
  if (!api) {
    throw new Error('Agent 服务未就绪，请重启应用。')
  }
  return api
}
