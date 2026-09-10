# Agent Runtime

## Mission and ownership

Own the first Agent execution module for Codex CLI and Pi CLI. The role maintains the runtime adapter contract, run/event lifecycle, project binding, automation tick and Agent inbox projection. It does not own public DTOs, database migrations, Electron IPC or feature-page shell files; those changes are coordinated with Architecture & Contracts, Database, Desktop Backend and Frontend.

The AionUI compatibility slice adds persisted conversation/message context and
schedule selectors (runtime, model, assistant, frequency and execution mode).
Keep those fields as orchestration metadata only; do not turn them into an
implicit credential, unrestricted workspace path or unattended write channel.
The embedded Agent page presents a persistent conversation-history rail and a
complete ordered message stream; opening prompt suggestions are an empty-state
affordance and must disappear for an opened or already-sent conversation.
Conversation history also supports one confirmed, revision-checked bulk archive
action. Each conversation is mirrored to one app-owned session snapshot for
backup/inspection, while SQLite remains authoritative for reads, revisions and
runtime recovery.
Connector probes may expose non-secret local model/thinking/permission defaults
for Codex and Pi so selectors match the installed CLI profile. They must never
read, copy, or return CLI auth files; the installed CLI may use its normal
profile directory for an existing login, while PRW only consumes a boolean
readiness result from the CLI's auth-status command.

Each connector also owns an optional proxy policy. It is disabled by default;
when enabled, only validated credential-free HTTP(S) `HTTP_PROXY`,
`HTTPS_PROXY` and `NO_PROXY` values are passed to that runtime's child process.
Ambient shell proxy variables stay filtered out. Codex marks only its generated
per-run directory trusted with a command-local config override; it does not
reuse the user's trust database.

## Editable paths

- packages/agent-runtime/src/*
- packages/workspace-service/src/agent-coordinator.ts
- packages/workspace-service/src/agent-dispatcher.ts
- docs/plan/08-Agent运行时.md
- apps/desktop/src/renderer/src/features/agent.tsx (with Frontend review)

Shared files are changed serially by their existing owners:

- contracts: Architecture & Contracts
- schema/migrations/repository: Database
- host and IPC/preload: Desktop Backend
- App shell and route: Shell, Context Menu & Tabs
- MCP server: Workspace Service/MCP owner

## Frozen contracts and safety

- Only Codex and Pi are supported in this wave; another runtime needs a new contract review.
- Read-only is the default and the only unattended tool profile. Approved-write must remain an explicit, previewed and confirmed path.
- Runtime credentials remain owned by the installed CLI profile. V1 does not
  inject raw credentials into child processes, read/copy auth files, write
  secrets to SQLite or log prompts/tokens; it explicitly sets the normal
  `CODEX_HOME`/`PI_CODING_AGENT_DIR` path and invokes the CLI. Auth status is
  reduced to a boolean and runtime output is redacted before persistence.
- Every run has an idempotency key when supplied, append-only events, bounded output and cancel/timeout behavior.
- Runtime processes run in a per-run directory with no unrestricted Renderer access.
- The per-runtime proxy toggle and values are persisted through the shared contract/migration and applied identically to manual and scheduled runs.
- External writes still use IntegrationCoordinator; Zotero never uses zotero.sqlite and Obsidian never uses .obsidian.
- Scheduled `daily_digest` runs carry the schedule id as `jobId`; successful output is written as a unique Markdown note under the enabled Obsidian Vault's `每日文献推送/` folder, and the write/skip progress event remains visible in the embedded Agent run panel.
- Schedules run only while the app is alive; startup catch-up is bounded to one missed daily run.

## Required evidence

- typecheck and build for all consumers;
- migration smoke on an isolated database;
- real runtime version probes reported as available/unavailable;
- manual evidence for start, progress, completion, failure, cancel, retry, inbox and schedule states;
- QA isolated restart/idempotency checks and Review/Security log/permission review before DONE.

## Stop conditions

Stop and hand off if a DTO or migration is needed without owner approval, if a runtime requires credentials outside Main, if a process can escape its run directory, if an external write is not preview/confirmed, or if a packaged Windows sender-trust rule would be widened.

## Receiving role

QA receives the first implementation for cross-layer acceptance. Review/Security receives the credential, process, MCP and external-write gate. Desktop Backend receives packaged lifecycle and IPC findings; Literature/Zotero and Integrations receive context projection proposals.
