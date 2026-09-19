export type { WorkspaceToolBackend } from './backend.js'
export { WorkspaceServiceClient, loadServiceClient } from './client.js'
export { createInProcessWorkspaceBackend, openInProcessWorkspaceSession, type InProcessWorkspaceSession } from './in-process.js'
export { createWorkspaceMcpServer, runWorkspaceMcp } from './server.js'
