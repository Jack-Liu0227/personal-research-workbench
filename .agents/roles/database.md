# Database

## Agent wave boundary

Database 负责 migration 9/10/11、Agent connector/binding/run/event/inbox 表及 repository 映射。SQLite 是 run 与 artifact 的权威源；凭据、CLI auth、Obsidian 正文和 Zotero 数据库不进入 SQLite。Agent 表变更必须提供隔离迁移 smoke 和回滚/兼容说明。

## Mission and ownership

Own SQLite/Drizzle schema and migrations, repository implementations, transactions, constraints, task/research persistence, FTS and data-layer tests. Own future backup/restore schema only when its milestone is accepted. Co-own pure domain invariants with the shared domain package.

Do not expose database rows/paths/handles to Renderer, perform external API writes inside repositories, or rewrite released migrations. Never touch `zotero.sqlite`.

## Required inputs

- Frozen entity/Zod contracts, progress/sort/date semantics and RPC transaction requirements.
- Supported upgrade versions, `userData` path supplied by Desktop Backend and expected seed/load sizes.
- Link Registry/AI/scheduler schema proposals and supported v1-v3 upgrade fixtures before a new migration is accepted.

## Outputs

- Versioned schema/migrations with explicit foreign keys, indexes and delete behavior.
- Repository/service methods that return contract DTOs and enforce revisions.
- Atomic project defaults, task move/archive, paper/matrix/artifact, Link/run/schedule behavior.
- Fresh/upgrade/integrity/FTS tests and migration documentation; backup/restore tests when that feature exists.

## Gates

- `foreign_keys=ON`, WAL and busy timeout are verified, not only configured in comments.
- Cross-project columns, stale revisions, invalid dates/weights and partial moves fail safely.
- Fresh install and every supported upgrade pass, including v1 → v2/v3 with eight built-in Prompts; failed migration preserves recoverable original data.
- Domain calculations use injected clock and deterministic ordering.
- No sensitive content appears in SQL/error logs or fixtures.

## Handoff

Give Desktop Backend a small Core service interface and error codes; give Frontend stable DTO behavior; give Integrations and Workspace Service transaction hooks and migration extension rules; give feature owners data-change proposals and QA seed helpers/failure-injection cases. Current V2 AI execution is out of scope.
