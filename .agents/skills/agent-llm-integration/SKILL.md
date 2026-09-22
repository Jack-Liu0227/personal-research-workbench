---
name: agent-llm-integration
description: This skill should be used when building, porting, auditing, or extending an application-embedded LLM Agent across frontend and backend layers, especially in a TypeScript/Electron app that needs provider/model authentication, typed IPC, an in-process runtime, MCP workspace tools, streaming run records, conversation persistence, scheduling, or safe external writes. It provides a reusable end-to-end architecture, implementation workflow, security rules, and verification checklist based on the Personal Research Workbench integration.
---

# Agent LLM Integration

## Overview

Use this skill to design and implement one coherent LLM Agent slice instead of wiring a chat page, a provider client, and a backend runner independently. Keep the model runtime behind a typed trust boundary, keep credentials in the host process, expose only policy-selected workspace tools, persist normalized run/conversation records, and make every external write previewable and user-confirmed.

Treat the current project as a reference implementation, not as a copy target. Read the bundled references before editing a corresponding layer:

- `references/reference-architecture.md`: end-to-end data flow, process boundaries, and lifecycle.
- `references/current-implementation-map.md`: concrete Personal Research Workbench paths and symbols.
- `references/contract-checklist.md`: DTO, security, persistence, and verification gates.

## When to Use

Trigger this skill for requests to:

- add a chat/Agent page backed by a real model;
- add provider catalogs, API-key/OAuth login, custom endpoints, or model discovery;
- connect an Agent to application data through MCP or another typed tool layer;
- stream assistant/tool progress into a persistent conversation and run ledger;
- add Agent schedules, retries, cancellation, resume, or startup catch-up;
- audit an existing integration for renderer isolation, credential leakage, unsafe tools, or unverified external writes;
- port this Electron/TypeScript pattern to another local-first Agent application.

Do not use it for a prompt-only feature, a one-off API call with no persistence, or a UI mock that does not execute a model run.

## Operating Rules

Apply these rules before writing code:

- Establish one authoritative contract layer. Define Zod (or equivalent) schemas for every renderer-to-host, host-to-core, model, tool, event, credential, and persisted-record boundary. Parse at ingress and return typed errors.
- Keep secrets out of Renderer, SQLite, prompts, logs, ledger records, crash reports, and skill files. Resolve credentials only in Main/host storage, scope them to the selected provider, and hold them in memory for one run.
- Never fall back to a user's global CLI profile (`~/.pi`, `~/.codex`, or equivalent). Use an app-owned, validated profile directory and an explicit runtime configuration.
- Prefer an in-process SDK when packaging makes child-process execution unreliable. If a child process is required, isolate its working directory, environment, permissions, timeout, and output redaction.
- Expose workspace capabilities through one MCP/tool server and one dispatcher. Do not create a second UI-only implementation of domain commands.
- Separate tool policy from tool discovery. Always deny shell/filesystem/destructive tools, select an explicit allowlist by permission mode, and sanitize provider-visible tool names to the target API's grammar while retaining the original MCP name for dispatch and display.
- Bind every tool call to the server-created `runId`; never accept an ownership id supplied by the model.
- Normalize provider events into a stable ledger (`user`, `assistant`, `reasoning`, `tool`, `context`, `diagnostic`, `turn_end`, etc.) before they reach the UI. Persist SQLite rows as the authority and treat runtime session files as resumable cache only.
- Make external writes request-only. The Agent may create a preview/fingerprint action; only an explicit human decision may execute it through the existing connector and revision checks.
- Keep scheduled runs bounded to the app lifetime, carry a stable `jobId`, enforce idempotency, and fail closed when the selected provider has no credential.
- Never report a planned, mocked, or source-reviewed path as complete. Record exact commands, real-provider status, packaging status, and known gaps.

## Implementation Workflow

### 1. Inspect and freeze scope

Read the repository handoff guide, relevant role owner file, module plan, implementation evidence, shared contracts, migrations, and current progress CSV. Run `git status --short` and preserve unrelated changes. State editable paths, non-goals, frozen contracts, and verification commands before consequential edits.

Map the integration as six layers:

```text
Renderer UI
  -> typed Preload API
  -> Main IPC + safeStorage + external browser boundary
  -> Core utility process / service host
  -> Agent adapter (Pi SDK or chosen runtime)
  -> MCP server + workspace dispatcher
  -> SQLite repositories / connectors / scheduler
```

Stop and escalate when a change would require an unowned DTO or migration, expose a secret to Renderer, widen packaged sender trust, bypass the dispatcher, or enable unattended external writes.

### 2. Define contracts before implementations

Create a strict method-to-payload map and derive the request union from it. Cover at least:

- provider/model catalog and selected defaults;
- credential status, save, logout, and login prompts/events;
- conversation create/list/messages/archive/remove;
- run start/list/get/events/records/cancel/retry;
- normalized ledger records and usage;
- tool permissions, approval policy, and external-action decisions;
- schedule rules, occurrences, run history, and skill selection.

Use bounded strings, arrays, pages, timeouts, and envelope sizes. Keep credential-bearing methods on a separate allowlist from ordinary RPC. Use `safeParse` in IPC helpers so malformed requests become typed failures rather than uncaught Main exceptions.

### 3. Build the backend runtime boundary

Implement an adapter with a narrow contract similar to:

```ts
interface AgentRuntimeAdapter {
  capabilities(scope?: AgentRuntimeScope): Promise<AgentRuntimeCapabilities>
  start(request: AgentRuntimeRequest): Promise<AgentRuntimeHandle>
}
```

For an in-process Pi implementation:

1. Load the ESM SDK through one controlled dynamic-import module.
2. Set the app-owned runtime profile directory before loading the SDK.
3. Open one workspace MCP session for the run and close it when the run settles.
4. Select the model by provider/model id and supply an app-owned `CredentialStore`.
5. Disable built-in shell/filesystem tools and register only the selected workspace extension tools.
6. Stream SDK events through a bounded queue, normalize them into ledger drafts, and expose cancellation/timeout.
7. Return the runtime session file id only as a resume pointer; keep SQLite authoritative.

Do not let the adapter know how the Renderer is implemented. Keep login prompts, browser opening, credential persistence, and database writes in host-owned bridges.

### 4. Design the MCP/tool surface

Reuse the same server definitions for stdio development and in-process execution. Route every tool call through the workspace dispatcher with a context containing `runId`, actor, and revision data. Separate tools into:

| Class | Policy |
| --- | --- |
| Read | Always available when advertised and schema-valid. |
| Local record write | Available only in an explicit write profile; keep it transactional and revision-aware. |
| External request | Create a preview/fingerprint action only; do not perform the remote write. |
| Destructive / shell / filesystem | Never register for the Agent. |

Sanitize names for provider APIs (`^[A-Za-z0-9_-]{1,64}$`) and retain a reversible label map so UI/ledger details still show the original MCP name.

### 5. Wire Main, Core, and Preload

Keep the Renderer API capability-oriented (`agent.runs.start`, `agent.models.login.start`, and so on), never a generic `ipcRenderer.invoke`. Validate sender origin in Main, validate payloads in Preload/Main/Core, and keep the packaged renderer on the fixed local origin.

Use two credential paths:

- interactive RPC: Main resolves the selected provider credentials from `safeStorage`, places them in a bounded private envelope, and Core consumes them for that request;
- scheduled/startup run: Core asks Main for exactly the selected provider credential through a correlated, timeout-bounded read channel, then fails closed when absent or malformed.

Keep OAuth/browser opening as Core → Main `shell.openExternal` with a clickable Renderer fallback. Return provider status after logout so the UI cannot display stale authentication state.

### 6. Persist and render lifecycle state

Persist conversations, messages, runs, raw events, normalized records, approvals, external actions, and schedule occurrences in one schema/migration owner. Use transactions for multi-entity updates, optimistic revision checks for archive/delete/decision actions, bounded/redacted text, and stable ordering from the backend.

Render the persisted order as `run → turn → record`. Update existing streaming nodes instead of reordering the conversation. Keep local slash-command feedback out of the model ledger when it is a host-only action. Translate backend diagnostics into an actionable settings/auth message without exposing tokens or paths.

### 7. Verify in layers

Run the narrowest checks first, then the project gate:

```powershell
pnpm -r typecheck
pnpm build
pnpm test:agent-runtime-pi
pnpm test:agent-credentials
pnpm test:agent-discovery
pnpm test:agent-custom-providers
pnpm test:workspace-mcp-agent-surface
pnpm test:e2e
```

Add focused tests for schema rejection, renderer isolation, provider scoping, missing credentials, cancellation, idempotency, tool filtering, name sanitization, ledger ordering, migration smoke, and external-action confirmation. Label real provider/OAuth/Vault/Zotero/Obsidian/Windows installer checks as executed, blocked, or not run. A successful build is not a release smoke test.

### 8. Hand off with evidence

Use the repository handoff format: outcome, exact changed paths/contracts, commands and exact results, manual/real-service evidence, remaining risks, receiving role, and one bounded next step. Keep `IN_REVIEW` until independent QA/Security gates pass.

## Current Project Defaults

When extending this repository, preserve these reference decisions unless the user explicitly changes them:

- Windows 10/11 x64, local-first, single-user Electron application.
- Pi SDK `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` pinned to `0.85.1`; Agent runs in the Core utility process.
- Workspace tools use `@modelcontextprotocol/sdk` with a linked in-memory transport; stdio remains an external/development entry point.
- Main owns Electron `safeStorage`; the Renderer never receives a secret and the app never reads personal `~/.pi`/`~/.codex` auth files.
- SQLite is authoritative for runs, conversations, messages, records, profiles, links, schedules, and sync state.
- Obsidian/Zotero writes go through preview/fingerprint → human confirmation → IntegrationCoordinator; attachments remain links.
- Scheduled work runs only while the app is alive and catches up at most one missed daily run.

Load `references/current-implementation-map.md` before touching project code, and load `references/contract-checklist.md` before declaring an Agent slice complete.

## Resources

The bundled references are the primary reusable content. Run `scripts/audit-agent-boundaries.mjs <repo-root>` when auditing a compatible repository; it performs a conservative, read-only check of expected paths and Renderer forbidden imports.
