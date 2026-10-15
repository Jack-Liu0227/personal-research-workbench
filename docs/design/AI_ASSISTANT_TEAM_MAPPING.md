# AI Assistant / Team Renderer Mapping

## Scope, authority and sources

The expanded scope is the overall Shell and all eleven real Renderer views,
plus assistants, teams, tools and skills. PRW shared Zod contracts, SQLite
revisions and typed Preload remain authoritative. This is original PRW TSX
based on inspected visual/functional patterns, not wholesale source copying.

Primary reference: actual remote `research-workbench/web/index.html` from
https://github.com/3276166289-code/research-workbench at independently verified
repository commit `420225bb9e98726675c74a0f9fb7141e78d5abb8`; 350632 bytes,
SHA256 `2459c44bf9112ab73b4621327a72f058f0069dd052f382cc2a07a3b0a69a7de6`.
The separately supplied path-history commit
`18701215c4cecbb2b4dbd9429a261427269f60cd` is not substituted for this pin.
The inspected remote Agent is TWO columns, history plus main with internal
conversation/trajectory tabs. PRW's optional third rail is an enhancement,
not copied-source fidelity. No deleted sidecar is restored or started.

Local capability reference is now accessible READ ONLY at
`\\192.168.137.2\科研资产\Study\qitu-zhixue\apps\admin-console\app\(console)\settings`:
`assistants/page.tsx`, `teams/page.tsx`, `tools/page.tsx`, `skills/page.tsx`.
Earlier baseline handoff notes saying it was unavailable are superseded.
Neither source has an established compatible reuse license in this task;
reference-only patterns inform original implementation. No source runtime,
TSX, vendor assets, dependencies, credentials or examples are shipped.
Source localStorage demo identities, fake connection/latency and failed PATCH
that still displays success are explicitly NOT migrated.

See `SOURCE_DESIGN_MAPPING.md` for tokens/chrome and all eleven surfaces.

## Settings navigation and profiles

All sixteen sections remain LEFT vertical navigation: General, Workspace/Data,
Literature, legacy Research Workbench, Proxy, Connectors, RSS, Models/Agent,
Assistants, Teams, Tools/MCP, Skills, Knowledge Engines, MCP Server,
Security/Audit and About/Updates. Desktop has a sticky scrollable sidebar;
below1080px a vertical icon rail expands into a left drawer, never top tabs.
Native buttons expose accessible names, `aria-current="page"`, visible focus,
Home/End/ArrowUp/ArrowDown and Enter; Escape restores drawer toggle focus.

Assistant identity/instructions/model/capabilities and team list/member-role/run
monitor groups retain actual data. Profile panels report dirty state to Settings
and guard unload. Dismissing section/view/reload confirms preserves drafts.
This does not claim all legacy settings forms have unsaved-change guards.

## Matrix semantics

Tools and skills default to resource-by-assistant matrices, with a separate
single-assistant editor. Stable IDs and capability keys are the only identities;
same display names do not merge columns.

- Search capabilities/assistants and filter type; row enable/disable and column
  enable/disable act ONLY on current filtered rows/columns and respect scope.
- Native labeled checkboxes update an in-memory draft, not runtime authority.
  One bounded two-axis table scroller has desktop sticky headers, a focusable
  region and keyboard focus. Narrow first column stops sticking so cells remain
  accessible at320px/200% Electron zoom.
- Bulk save sends only changed assistants, frozen revisions and the supplied
  binding kind. Core checks all CAS and writes in one atomic transaction. Other
  profile fields/binding kinds survive. Failure keeps drafts and real errors,
  never synthesizes persisted success.
- Success synchronously updates matrix query cache before clearing drafts, so
  stale cached revisions cannot flash back. Profile/single-binding saves and
  archive invalidate matrix. Save/refetch/reload lock cells, bulk/filter/save
  controls so async reload cannot silently discard new edits.
- Unknown persisted keys surface as remove-only. Missing/archived identities,
  new unknown enables and read-only write grants reject in Core. Empty means
  zero tools. Only existing local Workspace MCP; remote MCP unsupported.
- Skills include only actual instruction resolution in installed registry;
  external-engine entries that cannot resolve are not offered. Binding does not
  install/edit/upload skills or execute arbitrary code.

Save affects NEXT run; existing runs retain frozen configurations. Teams are
bounded and read-only, exactly one director and distinct members, using real
child-ledger links. No arbitrary MCP subprocesses, Renderer HTTP/Node or unsafe
external writes are added. Secrets stay in Main/Core safeStorage, not DTOs,
localStorage appearance preferences, logs or screenshots.

## Contract / IPC mapping

| Reference concept | PRW authority | Typed IPC |
| --- | --- | --- |
| Assistant | `id`, `name`, `description`, `enabled`, `systemPrompt` | `v2.assistants.list/save/archive` |
| Model/thinking | `provider`, `model`, `thinking`, no secrets | Existing `agent.models.catalog`; assistant save |
| Scope/tools | `toolProfile`, stable `toolAllowlist` | `v2.agentBindings.catalog`; single assistant save |
| Skills | stable `skillKeys`, resolved instruction catalog | Same catalog and assistant save |
| Matrix snapshot | `AgentBindingMatrix {catalog, assistants}` | `v2.agentBindings.matrix()` |
| Atomic bulk | unique `assistantId`, `expectedRevision`, optional full `toolAllowlist`/`skillKeys` replacement | `v2.agentBindings.saveMatrix()` |
| Cell | `assistantId`, `expectedRevision`, `kind`, `key`, `enabled` | `v2.agentBindings.set()` |
| Team | identity, role/instructions members, `maxSteps` | `v2.agentTeams.list/save/archive` |
| Team start | team/revision/project/instructions/idempotency | `v2.agentTeams.runs.start` |
| Monitor/cancel | `status`, `revision`, `childRunIds`, output/error | Team runs list/get/cancel; existing Agent ledger |

Bulk allows1-100 distinct assistants and at least one binding kind per update;
full replacement ONLY for supplied kinds. Cell API unknown-key rejection is
verified even though UI uses bulk. PRW mints local IDs, not source demo IDs.

## Evidence and limits

Earlier11-workflow/28-screenshot baseline predates overall redesign/matrix and
is NOT expanded acceptance. Expanded `scripts/e2e-agent-profiles.cjs` exercises
actual Renderer/Preload/Core at local `workbench://app` in an isolated profile,
without credentials. Only final Core/UI build evidence counts.

Required expanded checks: tools AND skills across2+assistants, draft-only,
row/column enable/disable, save/restart both enabled/disabled states, stale CAS
and invalid bulk with no partial writes, dirty preserved, unknown-cell reject,
read-only write cells disabled, same-name/distinct-ID columns, keyboard focus
all enabled cells, true200% Electron zoom, all11 views both themes at desktop
and narrow sizes, preset/custom derived-primary screenshots, actual button
contrast>=4.5 and custom appearance persistence, all16 left sections.

Frontend pre-build checks: desktop typecheck, both E2E node syntax checks and
focused git diff check PASS (LF/CRLF notices only). Final executed evidence is
appended after final run. Author evidence is not independent QA/Security
approval. Supervisor records existing full `test:e2e`, including task board and
key-safe model deep-link regression; checks are not skipped or weakened.

Real provider success/live team cancellation NOT RUN: without keys, real child
fails before live cancellation. External writes, installed NSIS, OS scaling
and release approval are not established by screenshots or contracts.

## Historical Renderer evidence (superseded)

The following 24-workflow/116-image run and its separate12-image supplement
are historical, not the current final UI acceptance. Independent review found
a real three-column composer overlap and a720px grid-placement regression
(`prw-agent-profiles-e2e-lgB4Tx`,13 formal captures plus one failure image, FAIL). The limited200% matrix visual
checks passed, but that does not approve the full UI. The corrected complete
run is recorded in the current-evidence section below. Subsequent failures
`prw-agent-profiles-e2e-sCR6pC` (320px clipped composer) and
`prw-agent-profiles-e2e-MteoOt` (125-image partial run, Provider test-selector
timeout) are diagnosis only, not final PASS artifacts.

Historical commands after the narrow-intro correction:

- `pnpm build`: PASS (TypeScript plus Main/Core/Preload/Renderer production
  build). Historical Renderer assets are `index-C_AYWD3O.css` and `index-Cjluz5hq.js`.
- `pnpm test:e2e:agent-profiles`: PASS, 24 real workflows, 116 screenshots,
  zero Renderer console/page errors. No mocked provider or real credentials.
- `pnpm --filter @prw/desktop typecheck`: PASS after the final style change.
- `node --check scripts/e2e-agent-profiles.cjs` and
  `node --check scripts/e2e-electron.cjs`: PASS.
- Focused `git diff --check`: PASS; Git LF/CRLF notices are informational.

Exact isolated evidence path:

```text
C:\Users\HK\AppData\Local\Temp\prw-agent-profiles-e2e-SHd3LX\agent-profiles-evidence.json
```

The same directory contains all116 screenshots. The inventory includes:

- All11 actual views, both themes, custom primary, outer1440x900 and720x880.
- Assistants, teams, Agent, tools matrix and skills matrix, both themes, outer
  1440x900/1024x720/720x880/320x720 and large application font.
- All4 primary presets on tools/skills matrices in both themes; custom primary
  persists after restart. Actual computed foreground/background are canvas
  resolved after CSS transitions, not incorrectly parsed intermediate OKLab.
  Minimum measured primary button contrast is4.548691482970604 (dark custom);
  light custom is4.893399313535244; all tested ratios exceed4.5.
- True `webContents.setZoomFactor(2)` for both matrices in both themes, distinct
  from the font preference. All enabled cells receive visible keyboard focus;
  native Space toggles/restores without persisting drafts.
- At320px, extra cell/save-area captures verify the matrix scroll region and
  complete save/reload controls. The intro uses full-width stacked content,
  not a summary-driven single-character column.
- Every capture checks document horizontal overflow and control bounds;
  genuine bounded horizontal scrollers remain exempt only for their contents.

Author visually inspected historical dark320 tools intro/cells and light320 skills
save area. Recommended independent-review images include
`matrix-tools-dark-320.png`, `matrix-tools-dark-320-cells.png`,
`matrix-skills-light-320-save.png`, `matrix-tools-light-zoom200.png`,
`matrix-skills-dark-zoom200.png`, `page-dashboard-light-custom-1440.png`,
`page-calendar-light-custom-720.png` and `settings-sidebar-dark-320.png`.

Intermediate failed runs and the earlier108-screenshot run are diagnosis only.

## Historical pre-palette author evidence

The following132-capture focused PASS predates the general `/help` pointer
regression. The dock scroller clipped the absolute palette; this artifact
remains layout evidence, not current complete UI acceptance. The new popup
candidate and its full focused/general gates are recorded separately below.

The bounded Agent corrections preserve all launch/business semantics:
container-relative dock padding, wrapped toolbar/groups with bounded select
text, explicit main-thread grid column2 when history becomes an overlay, and
a60%-height internally scrollable dock. No contract/runtime/dependency change.

- `pnpm build`: PASS, final Renderer `index-Hh2I7TxR.css` / `index-Bd_sc9Z7.js`.
- `pnpm test:e2e:agent-profiles`: PASS,29 workflows,132 native compositor PNGs,
  `consoleErrors: []`, fresh isolated profile, no mocked successful provider.
- Both E2E `node --check` commands and focused `git diff --check`: PASS.
- Actual general-script negative invocation with a non-test
  `PRW_E2E_USER_DATA` rejects before fixture/profile/Electron startup: PASS.

```text
C:\Users\HK\AppData\Local\Temp\prw-agent-profiles-e2e-Vaubwe\agent-profiles-evidence.json
SHA256 9FF3B313147A532D7F71EB4EFFA79CE3435F3619A6E4D78F9EA3110E0E5B17A8
Renderer CSS SHA256 FBFA6363C5D4CAF187616F3178F1A23F6CB52E7B9C9F400E7281D5F8F1768674
Renderer JS SHA256 16C3B77EAA919BBF97C679E1C1B8F6296CB647A620FE039CB6D2D97AE154E50A
Core SHA256 7129AAFC28CC55717DC9DE06766182349BAC2FA32C079C7FF94198493CE23934
```

This final artifact retains all24 original workflows and11 actual routes plus:

-132/132 screenshots use `webContents.capturePage()`, double animation-frame
  settling, physical PNG dimensions versus `innerWidth * devicePixelRatio`,
  and document/control overflow checks. CDP-only zoom clipping is not accepted
  as user-viewport evidence. At200%, native images are2139x1295 while the actual
  CSS viewport is713x431 with devicePixelRatio3.
-412 matrix-control checks: both themes,180 tools /18 skills enabled cells
  each, actual main bounds, center hit-test and visible keyboard focus, plus
  enabled Save/Reload bounds. Native Space creates then restores local drafts;
  visual captures do not persist those temporary changes.
-12 composer-layout records:320/720 default assistant in both themes, plus
  wide three-column default and named assistants at standard14px
  (`comfortable`) and large16px. The default path includes project, Provider,
  model, run mode and assistant, not merely the reduced named-assistant path.
  Pairwise control boxes never overlap; each textarea/selector/context/send
  is actually scrolled/focused into the intersection of viewport, main,
  thread and dock clip bounds. Enabled controls also pass center hit-test.
-4 narrow-history records:720/320, both themes, real expand/collapse actions
  leave the main thread in column2 with stable position/width; no forced clicks.
- Loaded Provider capture records contain40 real catalog cards per theme,
  `loading: false`, and a mounted defaults form; no loading screenshot is used.
- Canvas-resolved primary contrast remains minimum4.548691482970604 (>=4.5),
  light custom4.893399313535244. All4 presets and custom restart are retained.

Author inspected both themes' `agent-*-conversation-three-columns.png`,
`providers-*-cards.png`, `agent-*-320-default-composer.png`, tools light200%
save and skills dark200% cells.320 captures show the dock scrolled to reachable
controls; they do not imply the entire tall toolbar is visible simultaneously.
Actual provider success/live cancellation, real Zotero/BBT, installed NSIS and
OS display-scaling acceptance remain NOT RUN by this frontend pass.

The general `scripts/e2e-electron.cjs` uses a fresh temporary profile only,
rejects arbitrary profile overrides, and an explicitly labeled random-port
loopback read-only HTTP fixture. Real integration CAS/adapter/IPC/UI exercise
unavailable503 then readable/write-false states. Unknown routes and all writes
are rejected/recorded; existing library/project/import/delete assertions stay.
Supervisor executes and records the full general gate separately. This is not
real Zotero validation, and author evidence is not independent security or
release approval. Receiving roles: QA and Review/Security.

## Current popup-corrected author evidence

The general pointer regression was the palette living inside the60%-height
dock scroller. The bounded correction mounts it as an absolute main-thread
sibling, measuring the actual composer anchor and available thread/viewport.
ResizeObserver and capture scroll/window resize track layout; highlighted
keyboard options scroll within the popup. Actual mouse movement does not
allow stationary-hover repaint to reset ArrowDown/Tab. Narrow grid tracks and
code ellipsis keep options within the popup. The320px dock scroll and earlier
layout fixes remain. No public contract, runtime policy or dependency changes.

- `pnpm --filter @prw/desktop typecheck`: PASS before production builds.
- `pnpm build`: PASS, `index-9XHUjMbI.css` / `index-BupRxgEE.js`.
- `node --check scripts/e2e-agent-profiles.cjs` and
  `node --check scripts/e2e-electron.cjs`: PASS.
- Focused `git diff --check`: PASS (Git line-ending notices only).
- `node scripts/e2e-agent-profiles.cjs --palette-only`: PASS,4 workflows,
  4 native captures in a fresh profile; not a replacement for the full gate.
- `pnpm test:e2e:agent-profiles`: PASS,33 workflows,136 native captures,
  `consoleErrors: []`; Electron closes before the serial general gate.

```text
Sanity: C:\Users\HK\AppData\Local\Temp\prw-agent-profiles-e2e-tkrtOM\agent-palette-evidence.json
Full: C:\Users\HK\AppData\Local\Temp\prw-agent-profiles-e2e-WnnxDm\agent-profiles-evidence.json
Full JSON SHA256 FE988979EB2A0D5094AEF834A33CC730CCDC2200C29521B5F8169938DDDDFEB2
Renderer CSS SHA256 B70C78A50E6AEBC83A89725DE702A687FCA6476C2D4AA2D0609CAFA5B7B2E7E0
Renderer JS SHA256 B28A274133D66D0C5228F4163B0F2AAFAFB099FD833C434CA6DE10BF92F923B8
Core SHA256 7129AAFC28CC55717DC9DE06766182349BAC2FA32C079C7FF94198493CE23934
```

The original29 workflows/132 captures remain, with4 palette workflows/captures
in both themes at outer1440/320.12 strict option records assert absolute
positioning, actual above-composer anchoring, thread/viewport bounds, no dock
clip and real center hit. Tests perform actual `/help` mouse click/local
execution, ArrowDown/Tab, last-option ArrowUp scroll/hit, Enter completion and
Escape, then compare real IPC conversation/run IDs unchanged. General retains
its original absolute/above-composer/compact-input and actual mouse/local
no-conversation assertions; only the explicit DOM owner lookup changes to the
owning thread. No forced mouse actions or weakened assertions.

Full evidence retains12 composer layouts/88 reachable controls,4 narrow
history records,412 matrix-control checks at200%,40 loaded cards/theme and18
actual contrast measurements (minimum4.548691482970604).136/136 PNGs match
physical Electron viewport dimensions. Author inspects native palette,
three-column/default320 composer, Provider and zoomed matrix captures; this
does not grant independent acceptance. Earlier `elXdlv` keyboard and `LVTOoQ`
narrow min-content failures remain diagnosis-only FAIL artifacts.

Supervisor records the serial same-build general E2E and independent review in
implementation evidence. Real provider/live team cancellation, real Zotero/
BBT/OAuth, installed NSIS and OS scaling remain NOT RUN by this frontend pass.
Authors cannot approve their own security/license/release gate.

Supervisor subsequently executes the serial same-build `pnpm test:e2e`:
PASS, exit0, fresh profile `prw-workbench-e2e-fX6J28`, Electron/fixture closed.
The frontend author independently reads, but does not execute, its log:
`C:\Users\HK\AppData\Local\Temp\prw-general-e2e-final-20261015-015458.log`.
The original actual palette mouse/local response, Provider/model, task,
schedule, responsive1440/1080/720/320 and scroll assertions all pass. The
Zotero path explicitly uses a mocked read-only random-loopback-port HTTP
fixture; `zotero-fixture-evidence.json` contains15GETs and `violations: []`,
not real Zotero/BBT validation. UI/scripts freeze after this gate; independent
acceptance and release status remain Supervisor/Review-owned.

## 0.0.6 follow-up

Implementation29 supersedes earlier missing remote-resource capabilities: reviewed SQLite instruction skills and explicitly probed Streamable HTTP MCP now have typed management, binding, revocation and human approval. Fresh0.0.6 profiles E2E:33 workflows/136 native screenshots; resources:6/18; general E2E PASS. Actual online services/installer publication remain separate evidence. Python sidecars are retired; original source designs remain reference-only.
