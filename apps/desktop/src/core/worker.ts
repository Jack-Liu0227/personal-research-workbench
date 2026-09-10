import { startWorkspaceService, type ServiceParentPort } from '@prw/workspace-service'

const parentPort = (process as NodeJS.Process & { parentPort?: ServiceParentPort }).parentPort
if (!parentPort) {
  throw new Error('The workspace service must be started as an Electron utility process.')
}

const databasePath = process.env['PRW_DATABASE_PATH']
if (!databasePath) {
  throw new Error('PRW_DATABASE_PATH is required.')
}

startWorkspaceService({
  parentPort,
  databasePath,
  version: process.env['PRW_APP_VERSION'] ?? '0.0.0',
  ...(process.env['PRW_SERVICE_PIPE'] ? { pipePath: process.env['PRW_SERVICE_PIPE'] } : {}),
  ...(process.env['PRW_SERVICE_TOKEN'] ? { handshakeToken: process.env['PRW_SERVICE_TOKEN'] } : {}),
  ...(process.env['PRW_SERVICE_INFO'] ? { serviceInfoPath: process.env['PRW_SERVICE_INFO'] } : {}),
  exit: () => process.exit(0)
})
