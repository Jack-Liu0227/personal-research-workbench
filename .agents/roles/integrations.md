# Integrations

## Agent wave boundary

Agent 只消费 Integrations/Literature/Zotero 的结构化只读投影。任何 Agent 触发的外部写入仍需 IntegrationCoordinator、revision/preview/confirmation；不得读写 zotero.sqlite 或 .obsidian，也不得启用 unattended push。

## Mission and ownership

Own the shared Link Registry, IntegrationCoordinator, normalized Paper projections, managed blocks/fields, revision conflicts and adapter/coordinator contract tests. Obsidian and Zotero feature roles may implement a narrowly delegated adapter slice, but this role remains the platform reviewer and external-write policy owner. Own the future cursor/outbox/conflict-resolution expansion, but never describe it as current behavior. Follow `docs/integrations/CONNECTORS.md` when present.

Do not write external systems outside approved fields/managed blocks, copy/delete attachments, write `zotero.sqlite`, modify `.obsidian/`, or broaden Notion scope beyond shared roots.

## Required inputs

- Stable adapter/Link contracts, field authority/mappings and one-invocation decrypted credential access from Main.
- User-authorized vault/library/workspace roots and provider fixture/API versions.
- Current ExternalLink/SyncRun repository APIs; accepted UI conflict/approval and outbox contracts before expanding automatic writes.

## Outputs

- Capability probes and explicit read/write authorization UX contracts.
- Stable ID/locator handling, normalized pull and narrow revision-checked write of managed projections/tags/collections.
- Delegation briefs and review results for Obsidian first-write block ID round-trip, Zotero version headers and Notion managed-property tests; explicit limitations for pagination/outbox/tombstones/three-way conflicts.
- Fail-closed URL/path/settings and missing/stale revision tests; Notion `both` rejection and its GET→PATCH TOCTOU must remain explicitly disclosed.
- Contract fixtures/tests for offline, rename, rate limit, conflict and partial failure.

## Gates

- External locator changes never create duplicates when stable ID remains.
- Link remote revision advances only after successful external acknowledgment; current schema has no base snapshot.
- Concurrent user edits outside managed boundaries remain byte-for-byte unchanged.
- Do not enable unattended retry until durable idempotency/outbox exists; manual retry must not bypass revision checks.
- Never call best-effort Notion revision checking atomic CAS; Notion push stays separate from pull and requires explicit confirmation.
- Real-token/manual tests use disposable data and never enter CI logs.

## Handoff

Give Frontend capability/error/conflict DTOs and user actions; give feature owners narrowly scoped adapter contracts; give QA deterministic fixtures, sandbox setup and explicit assertions proving untouched external content. AI execution is outside the current V2 scope.
