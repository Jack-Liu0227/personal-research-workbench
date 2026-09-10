import { loadServiceClient } from './client.js'
import { runWorkspaceMcp } from './server.js'

const infoPath = argument('--service-file') ?? process.env['PRW_SERVICE_INFO']
if (!infoPath) {
  process.stderr.write('workspace-mcp requires --service-file <path> or PRW_SERVICE_INFO.\n')
  process.exitCode = 2
} else {
  try {
    await runWorkspaceMcp(await loadServiceClient(infoPath))
  } catch (error) {
    process.stderr.write(`workspace-mcp failed: ${error instanceof Error ? error.message : 'unknown error'}\n`)
    process.exitCode = 1
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : undefined
}
