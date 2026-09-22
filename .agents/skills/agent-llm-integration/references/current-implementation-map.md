# Personal Research Workbench Implementation Map

Use this map when modifying the current repository. Read the owning role file before editing shared or cross-layer paths.

## Backend and runtime

| Concern | Primary paths | Key responsibility |
| --- | --- | --- |
| Runtime contract/export | `packages/agent-runtime/src/index.ts` | Adapter, scope, request, event, handle, credential bridge types |
| Pi adapter | `packages/agent-runtime/src/pi/adapter.ts` | In-process `AgentSession`, model selection, session directory, event queue, cancellation |
| Pi SDK loading | `packages/agent-runtime/src/pi/loader.ts` | Controlled dynamic import and isolated runtime environment |
| Credential store | `packages/agent-runtime/src/pi/credential-store.ts`, `credentials.ts` | In-memory provider-scoped credentials and envelope parsing |
| Tool policy | `packages/agent-runtime/src/pi/tools.ts`, `extension.ts` | Tool classes, denylist, name sanitization, MCP → Pi bridge |
| Event normalization | `packages/agent-runtime/src/ledger/pi.ts`, `ledger/types.ts` | Provider events → stable ledger records |
| Provider discovery/models | `packages/agent-runtime/src/pi/discovery.ts`, `models.ts`, `models-file.ts` | Catalog, custom providers, bounded `/models` probes |
| Service host | `packages/workspace-service/src/host.ts` | Core wiring, credential read/write, in-process MCP session, schedule tick |
| Agent orchestration | `packages/workspace-service/src/agent-coordinator.ts`, `agent-dispatcher.ts` | Run/conversation/schedule lifecycle and RPC dispatch |
| MCP server | `packages/workspace-mcp/src/server.ts`, `in-process.ts` | Shared tool definitions and linked in-memory transport |
| Core bridge | `apps/desktop/src/core/agent-runtime.ts`, `client.ts`, `worker.ts` | Utility process boundary, typed messages, ledger/auth/credential channels |

## Contracts, persistence, and host security

| Concern | Primary paths |
| --- | --- |
| Public Agent DTOs/RPC | `packages/contracts/src/agent.ts` and `packages/contracts/src/index.ts` |
| Schema/migrations | `packages/database/src/migrations.ts` |
| Repository/transactions/redaction | `packages/database/src/repository.ts` |
| Main safeStorage | `apps/desktop/src/main/credentials.ts`, `agent-credentials.ts` |
| Main IPC and external browser | `apps/desktop/src/main/ipc.ts`, `index.ts` |
| Preload API | `apps/desktop/src/preload/index.ts`, `index.d.ts` |
| Renderer trust | `apps/desktop/src/main/renderer-trust.ts` |

## Renderer

| Concern | Primary paths |
| --- | --- |
| Agent page/composer/history | `apps/desktop/src/renderer/src/features/agent/index.tsx` |
| Conversation rendering | `features/agent/conversation-view.tsx` |
| Streaming ledger | `features/agent/ledger.ts`, `progress.tsx`, `trajectory-view.tsx` |
| External action cards | `features/agent/external-actions.tsx` |
| Auth/model settings | `features/research/settings.tsx`, related custom-provider/shared files |
| Shared query bridge | `apps/desktop/src/renderer/src/features/queries.ts` |

## Current reference decisions

- Pi `0.85.1` is embedded in Core; Codex CLI integration has been removed from the active path.
- `workspace-mcp` uses `InMemoryTransport.createLinkedPair()` for the embedded Agent and keeps stdio for external clients/development.
- Pi built-ins `bash`, `powershell`, `edit`, `write`, `read`, `grep`, `find`, and `ls` are excluded.
- MCP names such as `tasks.search` are sanitized only at the provider boundary; internal dispatch and ledger labels retain the original name.
- `agent.models.custom.discover` receives one provider's credential only; query-string API keys are forbidden.
- Renderer sees credential status, never credential material. Logout returns refreshed status.
- External Zotero/Obsidian operations expose `.request` tools that create confirmation actions; they do not execute writes.

## Evidence already recorded

Read `docs/implementation/24-pi-inprocess-agent-backend.md` and `25-agent-conversation-ui-and-settings.md` for the detailed design and known gaps. Current evidence includes typecheck/build/E2E and focused unit checks; a real provider network run and real OAuth callback remain separate validation work unless explicitly executed.
