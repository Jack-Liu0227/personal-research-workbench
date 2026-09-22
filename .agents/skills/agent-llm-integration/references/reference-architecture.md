# Reference Architecture

Use this document to keep the frontend and backend of an embedded LLM Agent as one slice.

## Runtime topology

```text
React Renderer
  │ typed window.workbench.agent API
  ▼
Preload
  │ Zod parse + channel allowlist
  ▼
Electron Main
  ├─ safeStorage credential vault
  ├─ sender/origin validation
  ├─ shell.openExternal for OAuth/browser flows
  └─ Core RPC client / ledger fan-out
  ▼
Core utility process / Workspace Service host
  ├─ Agent coordinator (run lifecycle, conversation, schedules)
  ├─ Pi in-process adapter (session, model, events, cancellation)
  ├─ app-owned credential bridge
  └─ in-process MCP client/server pair
  ▼
Workspace MCP + dispatcher
  ├─ strict tool schemas
  ├─ run-bound context
  ├─ domain services/repositories
  └─ IntegrationCoordinator for external systems
```

Keep the database and connector layer authoritative. Runtime session JSONL, provider model catalogs, and UI query caches are projections or caches, never the source of truth for business records.

## Run lifecycle

1. Renderer creates/selects a conversation and submits a typed run request.
2. Main validates the sender and, for credential-bearing methods, resolves only app-owned safeStorage entries.
3. Core creates or resumes a run, binds a server-generated `runId`, selects a model, and opens a workspace MCP session.
4. Adapter loads the SDK with an app-owned profile directory, installs the selected tool policy, and starts the session.
5. SDK events enter a bounded queue. The ledger normalizer emits append-only normalized records and redacted diagnostics.
6. Core writes messages/events/records transactionally and publishes validated ledger pushes to subscribers whose `runId` matches.
7. Completion, failure, cancellation, or timeout closes the MCP session and records the terminal state. The runtime session id may be saved for resume.

## Credential lifecycle

```text
Renderer asks to save/login
  → typed IPC
  → Main safeStorage
  → Core credential bridge / Pi CredentialStore
  → one-run in-memory use
  → no SQLite/log/ledger persistence
```

For scheduled runs, use a correlated Core → Main read request scoped to the selected provider. Reject cross-provider lookups, malformed results, expired requests, and missing readers. Never “helpfully” use a global CLI login.

## Tool lifecycle

1. Fetch the MCP server tool list.
2. Apply a policy allowlist for read-only, local-write, and external-request classes.
3. Remove blocked/destructive names even if the server advertises them.
4. Convert JSON Schema to the runtime's parameter schema.
5. Sanitize provider-visible names and retain an original-name map.
6. Dispatch with `{ runId, actor: 'agent', ... }` and validate the result before returning it to the model.

External writes stop after preview/fingerprint. Store the proposed action and revision in a durable action row; wait for a human decision; re-check revision at execution; return `created`, `updated`, `skipped`, `conflict`, or `failed` without overwriting user content.

## Frontend state model

Keep separate query/mutation concerns:

- catalog/defaults/auth status in Settings;
- conversations/messages in the history rail;
- records/events in the active run view;
- local slash-command feedback in ephemeral component state;
- external-action decisions in explicit confirmation cards.

Render records in backend order as `run → turn → record`. Stream into existing nodes by stable `recordKey`; do not sort by `turn` alone because turn numbers restart for every run.
