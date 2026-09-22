# Agent Integration Contract Checklist

Use this checklist before implementation, review, and handoff.

## Contract design

- [ ] Define one strict payload schema per RPC/tool/event.
- [ ] Derive the RPC request union from a method-to-schema map.
- [ ] Bound IDs, strings, arrays, pages, timeouts, envelopes, event payloads, and persisted text.
- [ ] Separate public payloads from private credential envelopes.
- [ ] Keep runtime identity, provider identity, wire API, and model id distinct.
- [ ] Add revision/expectedRevision to archive, decision, and external-write operations.

## Security boundary

- [ ] Renderer exposes capability methods, not generic IPC.
- [ ] Main validates the sender origin and packaged origin remains fixed.
- [ ] `safeStorage` is reachable only from Main/host-owned code.
- [ ] No key/token enters SQLite, prompts, logs, ledger, screenshots, test fixtures, or skill files.
- [ ] Credentials are keyed by provider and scoped to one run/request.
- [ ] Scheduled runs read exactly the selected provider credential and fail closed when unavailable.
- [ ] Runtime profile is app-owned and validated; no personal CLI auth/profile fallback.
- [ ] Child processes, if any, receive only bounded environment/config and isolated working paths.

## Runtime and tools

- [ ] Adapter exposes capabilities/start/cancel with no Renderer dependency.
- [ ] MCP tool definitions are shared by embedded and stdio paths.
- [ ] Tool policy explicitly separates read, local-write, external-request, and blocked classes.
- [ ] Shell/filesystem/destructive tools are never registered.
- [ ] Provider-visible tool names satisfy the provider grammar and map back to original MCP names.
- [ ] Every tool call carries a server-created `runId` and passes through the dispatcher.
- [ ] Tool results and diagnostics are redacted and bounded before persistence.
- [ ] External writes stop at preview/fingerprint until a human decision.

## Persistence and UI

- [ ] SQLite migrations are additive/immutable and tested on an isolated database.
- [ ] Conversation, message, event, record, approval, action, schedule, and run writes use the owner repository/service.
- [ ] Backend defines stable ordering; Renderer does not heuristically reorder streams.
- [ ] Streaming updates merge by stable record key and preserve run order.
- [ ] Missing-credential, timeout, cancel, conflict, and blocked states render actionable text.
- [ ] Host-only commands do not masquerade as model messages.

## Verification

- [ ] `pnpm -r typecheck`
- [ ] `pnpm build`
- [ ] Focused runtime/credential/discovery/MCP tests
- [ ] Renderer isolation and malformed-RPC tests
- [ ] Cancellation, timeout, retry, idempotency, and restart persistence checks
- [ ] Real provider/OAuth/external service status explicitly marked executed, blocked, or not run
- [ ] Windows package/install/restart/profile/uninstall smoke run for release work
- [ ] Independent QA and Review/Security gates recorded before `DONE`
