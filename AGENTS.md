# Personal Research Workbench Agent Rules

These instructions apply to the whole repository. Read the relevant specification in `docs/` and the assigned role file in `.agents/roles/` before changing code.

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
- AI generation uses pinned `@earendil-works/pi-ai` 0.84.1 (MIT). Provider identity and wire API remain separate; credentials use app-owned `safeStorage`, never Pi CLI or `~/.pi` auth.
- Closed-source-compatible green development: direct dependencies require license review; GPL/AGPL code is reference-only by default.

## Role ownership

| Area | Owner role | Role file |
| --- | --- | --- |
| Product decisions, wave/DAG, CSV and final acceptance | Supervisor | [supervisor.md](.agents/roles/supervisor.md) |
| V2 DTOs, IDs, authority, revisions and ADRs (delegated) | Architecture & Contracts | [architecture-contracts.md](.agents/roles/architecture-contracts.md) |
| Renderer shared queries/components/design/accessibility | Frontend Platform | [frontend.md](.agents/roles/frontend.md) |
| Cross-entity commands, queries and transaction orchestration | Workspace Service | [workspace-service.md](.agents/roles/workspace-service.md) |
| Electron Main/Preload/Core process and packaging | Desktop Backend | [desktop-backend.md](.agents/roles/desktop-backend.md) |
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

Run the narrowest relevant checks during development and the full available gate before handoff:

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

Do not claim a command passed if the script does not exist or the command was not run. Package/release changes additionally require a real Windows x64 NSIS smoke test, not only a build.

## Status and handoff

- Only Supervisor edits persistent roadmap status unless explicitly delegated.
- `DONE` requires executable acceptance plus evidence; use only `BACKLOG/READY/IN_PROGRESS/BLOCKED/IN_REVIEW/DONE`.
- Handoff must state outcome, changed paths/contracts, verification commands/results, risks and the next receiving role.
- Authors cannot approve their own Review/Security gate. Escalate data-loss, credential, external-write, RCE, migration and license risks immediately.

Detailed workflow: [Agent Playbook](docs/operations/AGENT_PLAYBOOK.md).
