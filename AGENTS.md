# Personal Research Workbench — Agent Handoff Guide

These instructions apply to the whole repository. This file is both the project policy and the minimum handoff guide for a new AI agent.

## Start here when taking over

1. Read this file completely.
2. Inspect the working tree with `git status --short`; preserve unrelated dirty files and never reset/clean them.
3. Read [`docs/README.md`](docs/README.md), [`docs/QUICK_START.md`](docs/QUICK_START.md), and the relevant module plan in `docs/plan/`.
4. Read the owning role file in `.agents/roles/` before editing that area. Use `.agents/roles/README.md` to resolve ownership.
5. Check [`docs/development-progress.csv`](docs/development-progress.csv) and the relevant `docs/implementation/` entry for current evidence and open validation gaps.
6. Inspect shared contracts and migrations before changing behavior: `packages/contracts` and `packages/database/src/migrations.ts`.
7. State the intended scope, non-goals, owner, and verification commands before making consequential edits.

Do not infer completion from UI presence, a generated artifact, a mocked provider, or an unrun command. Reconcile implementation, documentation, tests, and progress evidence before reporting status.

## Source of truth

1. User request and accepted product decisions.
2. Shared Zod contracts and versioned database migrations.
3. `docs/` specifications.
4. `docs/development-progress.csv` for persistent status and evidence.

Documentation distinguishes implemented MVP behavior from remaining release work. Never report a planned feature, an unrun command, an intermediate package artifact, or a mocked external service as complete.

## Fixed product decisions

- Windows 10/11 x64 Electron app; local-first, single-user, TypeScript core.
- SQLite workbench database is authoritative for tasks, paper indexes/matrices, AI artifacts, profiles, links, runs, schedules and sync state; secrets remain outside SQLite.
- The first vertical slice (project → Todo/task → board movement → progress → restart persistence) is implemented; current work is research-MVP validation and Windows release hardening.
- Renderer has no Node, database, credential or unrestricted IPC access.
- Packaged Renderer always uses the local `workbench://app` origin; `ELECTRON_RENDERER_URL` is development-only and must never expand packaged IPC sender trust.
- Packaged profile isolation uses only an explicit validated `--prw-user-data-dir=<absolute non-root path>`; packaged code ignores `PRW_E2E_USER_DATA`.
- Integrations use stable external IDs, managed blocks/fields and remote revisions; attachments are links only. The current manual-sync MVP has link conflict states but no durable outbox or three-way conflict UI.
- Notion has no atomic compare-and-swap API: Core rejects `both`, and push remains a separately confirmed best-effort GET-then-PATCH operation. Never describe it as atomic or enable it unattended.
- Never write `zotero.sqlite` or Obsidian `.obsidian/`; never silently overwrite external user text.
- Scheduled work runs only while the app is alive; startup catches up at most one missed daily run.
- AI generation uses pinned `@earendil-works/pi-ai` 0.85.1 (MIT), and the Agent is the pinned `@earendil-works/pi-coding-agent` 0.85.1 `AgentSession` embedded in the Core utility process — never a spawned CLI. Provider identity and wire API remain separate; credentials use app-owned `safeStorage`, never Pi CLI or `~/.pi` auth. User-defined providers are stored in Pi's own `<userData>/agent-runtime/pi/models.json` (endpoints and model ids only, never keys); entries the app cannot represent are preserved verbatim and never rewritten.
- Closed-source-compatible green development: direct dependencies require license review; GPL/AGPL code is reference-only by default.

## Repository map

- `apps/desktop`: Electron Main, Preload, Core utility process, and React Renderer.
- `packages/contracts`: shared Zod DTOs and trust-boundary schemas; public contract owner coordinates changes.
- `packages/domain`: pure domain rules and injected time/IO logic.
- `packages/database`: SQLite schema, versioned migrations, repositories, and transactions.
- `packages/connectors`: Obsidian, Zotero, and other external-system adapters.
- `packages/workspace-service`: cross-entity commands, queries, dispatch, integrations, and scheduling orchestration.
- `packages/agent-runtime`: in-process pinned Pi Agent integration, credentials boundary, model discovery, tools, and run ledger normalization.
- `packages/ai-runtime`: provider/prompt/workflow abstractions and scheduler support; do not confuse provider identity with wire API.
- `packages/workspace-mcp`: local stdio MCP server and its token/allowlist boundary.
- `docs/plan`: active module specifications; `docs/implementation`: implementation evidence and release notes.
- `.agents/skills`: project-local skills. Treat skill code as executable and load only trusted project content.

## Current project reality

- The first vertical slice (project → Todo/task → board movement → progress → restart persistence) is implemented.
- The current work is research-MVP validation and Windows release hardening. Many roadmap rows remain `IN_REVIEW`; do not promote them to `DONE` without executable and independent evidence.
- The app is local-first and single-user. Tasks, projects, literature indexes/matrices, AI artifacts, profiles, links, runs, schedules, and sync state belong in the authoritative SQLite database.
- External services and real credentials are optional validation dependencies, not acceptable substitutes for local contract tests. Explicitly label blocked or untested real-service paths.
- Version values must be read from the relevant `package.json` files and release docs; do not hard-code a version in handoff text.

## Role ownership

| Area | Owner role | Role file |
| --- | --- | --- |
| Product decisions, wave/DAG, CSV and final acceptance | Supervisor | [supervisor.md](.agents/roles/supervisor.md) |
| V2 DTOs, IDs, authority, revisions and ADRs (delegated) | Architecture & Contracts | [architecture-contracts.md](.agents/roles/architecture-contracts.md) |
| Renderer shared queries/components/design/accessibility | Frontend Platform | [frontend.md](.agents/roles/frontend.md) |
| Cross-entity commands, queries and transaction orchestration | Workspace Service | [workspace-service.md](.agents/roles/workspace-service.md) |
| Electron Main/Preload/Core process and packaging | Desktop Backend | [desktop-backend.md](.agents/roles/desktop-backend.md) |
| Agent runtime, credentials, Pi integration, tools and automation | Agent Runtime | [agent-runtime.md](.agents/roles/agent-runtime.md) |
| Schema, migrations, repositories and transactions | Database | [database.md](.agents/roles/database.md) |
| Link Registry, IntegrationCoordinator and adapter baseline | Integrations Platform | [integrations.md](.agents/roles/integrations.md) |
| Task board and Inbox Todo vertical slice | Task Board & Todo | [task-board-todo.md](.agents/roles/task-board-todo.md) |
| Obsidian Vault connection and safe Markdown I/O | Obsidian Connection | [obsidian-connection.md](.agents/roles/obsidian-connection.md) |
| Project-space aggregation | Project Space | [project-space.md](.agents/roles/project-space.md) |
| Literature batch operations and Zotero import UX | Literature & Zotero Import | [literature-zotero-import.md](.agents/roles/literature-zotero-import.md) |
| Obsidian project taxonomy and initialization | Obsidian Project Layout | [obsidian-project-layout.md](.agents/roles/obsidian-project-layout.md) |
| Zotero Local/Web capability and Paper projection | Zotero Local | [zotero-local.md](.agents/roles/zotero-local.md) |
| Calendar grid and event semantics | Calendar | [calendar.md](.agents/roles/calendar.md) |
| Shell, tabs and global context menu | Shell, Context Menu & Tabs | [shell-context-tabs.md](.agents/roles/shell-context-tabs.md) |
| Cross-layer acceptance and Windows release smoke | QA | [qa.md](.agents/roles/qa.md) |
| Independent security, privacy and license gate | Review Security | [review-security.md](.agents/roles/review-security.md) |

Public contracts have one coordinated owner at a time. Other roles propose changes to Supervisor; do not create duplicate DTOs or silently fork semantics.

## Change discipline

- Inspect with `rg`/`rg --files` first. Preserve dirty and unrelated user/agent work.
- Use small, reviewable patches; do not format or rewrite unrelated files.
- Never use destructive reset/clean operations. Do not delete or move broad/computed paths.
- Validate data at every trust boundary with shared Zod schemas. Do not expose generic `ipcRenderer` methods.
- Keep domain rules pure and inject time/IO. Put multi-entity writes in one database transaction.
- External writes go through `IntegrationCoordinator` and adapter revision checks; no direct UI SDK calls. Do not enable unattended writes until durable outbox, idempotency, preview/approval and conflict resolution are implemented.
- Secrets stay in Main/Core and are encrypted with `safeStorage`; redact paths, content and tokens from logs/tests.
- New dependencies require exact version, purpose, official source, license, native/ASAR impact and alternative analysis.
- Update the corresponding docs when changing public APIs, schema, authority, sync, scheduling, security or release behavior.

## Verification

Use the narrowest relevant checks during development, then the full available gate before handoff. From a PowerShell terminal at the repository root:

```powershell
pnpm install
pnpm typecheck              # equivalent to pnpm -r typecheck
pnpm build
pnpm test:e2e               # isolated Electron smoke; not an installed NSIS smoke
pnpm package:win            # only for release/package work
```

Named checks live in the root `package.json`, for example `pnpm test:agent-runtime-pi`, `pnpm test:agent-live`, `pnpm test:literature-skills`, and the Zotero/Obsidian focused checks. Run only checks relevant to the change and record exact results. **`pnpm test` is intentionally a no-op and is not a full test gate.**

Real provider, OAuth, Zotero, Obsidian, network, and Windows installer checks must be clearly labeled as executed, blocked, or not run. Packaging changes require a real Windows x64 NSIS install/start/restart/profile/uninstall smoke; a successful build alone is insufficient. Never put real keys or personal data in commands, fixtures, logs, screenshots, or handoff notes.

## Status and handoff

- Only Supervisor edits persistent roadmap status unless explicitly delegated.
- `DONE` requires executable acceptance plus evidence; use only `BACKLOG/READY/IN_PROGRESS/BLOCKED/IN_REVIEW/DONE`.
- Handoff must state outcome, changed paths/contracts, verification commands/results, risks and the next receiving role.
- Authors cannot approve their own Review/Security gate. Escalate data-loss, credential, external-write, RCE, migration and license risks immediately.

### Handoff template

```text
Outcome: <what is implemented or investigated>
Changed paths/contracts: <exact files, schemas, migrations, APIs>
Evidence: <exact commands and results; include blocked/not-run checks>
Remaining risks: <security, data loss, external service, packaging, UX or release gaps>
Next receiving role: <role file / owner>
Suggested next step: <one bounded action>
```

For detailed product usage, read [`docs/QUICK_START.md`](docs/QUICK_START.md) and [`docs/AGENT_USER_GUIDE.md`](docs/AGENT_USER_GUIDE.md). For module ownership, read [`.agents/roles/README.md`](.agents/roles/README.md); do not rely on the removed/nonexistent `docs/operations/AGENT_PLAYBOOK.md` path.
