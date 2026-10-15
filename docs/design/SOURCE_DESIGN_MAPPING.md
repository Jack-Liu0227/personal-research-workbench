# Research Workbench Visual Source Mapping

## Decision and provenance

Primary reference: remote `research-workbench/web/index.html` at independently
verified repository commit `420225bb9e98726675c74a0f9fb7141e78d5abb8`,350632
bytes, SHA256 `2459c44bf9112ab73b4621327a72f058f0069dd052f382cc2a07a3b0a69a7de6`.
Visual patterns are absorbed into original PRW code. Source Python/pywebview,
inline scripts, images/vendor assets are not ported. Removed sidecars remain
removed. No new dependency/downloaded font; source license unestablished,
reference-only rather than code reuse.

Owning Renderer files: `App.tsx`, `components/ui.tsx`, `styles.css`,
`features/research/settings.tsx`, `features/research/agent-profiles.tsx`,
`features/agent/index.tsx`. Existing page queries/transaction behavior stays
intact; shared surfaces/chrome reshape all eleven views.

## Tokens / chrome

| Remote source | PRW authority | Adaptation |
| --- | --- | --- |
| `--bg` #f6f8fa/#0b0f14 | `--background` | Same neutral foundations |
| `--panel` white/#111821 | `--surface` | Same main panel hierarchy |
| `--panel2` #f1f4f8/#0e141b | `--muted` | Same secondary surfaces |
| `--fg` #16202b/#e6edf5 | `--foreground` | Same text foundations |
| Text `--muted` | `--muted-foreground` | Light same; dark #9aabc0 stronger contrast |
| `--line` | `--border`, `--input`, `--border-strong` | Stronger input/dark separation |
| `--accent`/`--accent-ink` | `--primary`/`--primary-foreground` | NOT PRW secondary accent |
| Source light ocean #176b87/dark teal #2dd4bf | PRW default ocean #176b87/#79c8e0 | Intentional matched hue/contrast, not byte-exact source dark palette |
| Source primary JS derivation | `applyWorkbenchAccent` and color-mix | Four presets+validated custom #RRGGBB; retain hue, adjust theme luminance to4.5 button text contrast |
| Sidebar232/collapsed64 | Existing232/collapsed68 | Preserve accepted drawer/collapse; literature compact exception retained |
| Topbar46 |48px | Fit existing PRW controls |
| Tabs36/status26 | Same compact heights | Thin neutral borders, truthful status LEDs |
| Profile card | Local personal research workspace card | No source identity/demo localStorage |
| Cards10px/fields7px | Shared ResearchPanel/Button/Input/Field | Quiet neutral surfaces; no generic hover transforms/heavy shadows |
| SegoeUI/YaHei,font13/14/16 | Installed SegoeUI Variable/YaHei UI; existing3-scale preference | No font dependency/second font store |
| Provider `.card.prov` | `agent-provider-card` | Preserve credentials/OAuth/custom-model flow, derived-primary emphasis |
| Agent history236+main with projectiontabs | History+main+optional rail | Third rail1320px+ is PRW enhancement; narrow retains tabs |

SINGLE `:root`/`.dark` theme authority replaces old appended palettes.
Appearance uses existing `workbench-theme`, `workbench-font-scale` plus explicit
validated `workbench-accent`/`workbench-custom-accent`. Only optional appearance
is localStorage; all profiles/bindings/teams/runs are SQLite-authoritative.

## Eleven real views

| Actual route | Surface changes, business preserved |
| --- | --- |
| dashboard | Neutral metrics, restrained state dots, real project/list rows and page hierarchy |
| tasks | Neutral lanes/cards/pill metadata; intentional horizontal board scroll, movement/persistence preserved |
| calendar | Neutral grid/toolbar, subdued agenda, bounded timeline cards; dates/events unchanged |
| project | Compact shared panels, restrained taxonomy-accent border; real aggregation unchanged |
| literature | Paper/focus hierarchy, bounded panes/controls; real result/inspector and focus Shell retained |
| obsidian | Muted tree/main editor surfaces; unsaved guards/safe external IO unchanged |
| zotero | Muted collections/primary results-inspector, consistent gap; local/web capabilities unchanged |
| agent | Neutral history/main/trajectory, assistant/team selectors, real child run monitor and ledger |
| automation | Restrained schedule cards/derived icon tiles; no unattended external-write change |
| intel-daily | Consistent panel padding/rhythm/10px sections; truthful state/error/empty content |
| settings | ALL16 left sections, Provider cards, assistant/team editors and real tool/skill matrices; no top navigation |

Real Electron screenshots await actual `data-workbench-view`; no mocked HTML
showcase or demo cards inserted to resemble source. Admin-console read-only
assistants/teams/tools/skills inform lists/editors/member roles/search/filter
and resource-assistant matrices. Original PRW TSX uses typed v2 IPC, revisions,
stable IDs, truthful failures. REST, arbitrary MCP launches, fake latency,
localStorage assistant authority, skill install/editor/upload and swallowed
failed saves are not migrated. See AI_ASSISTANT_TEAM_MAPPING.md.

## Verification meaning

Inventory requires all11 routes, light/dark, desktop/narrow, all4presets plus
custom-primary derivation and real200% Electron zoom. Existing full test:e2e
business checks (taskboard/calendar/literature/key-safe models/etc) remain
intact. Screenshots are author evidence, not independent QA/license approval,
not installed Windows NSIS or OS-display scaling acceptance.

## Historical evidence (superseded)

The116-image baseline and separate12-image supplement are history only.
Independent review requests changes for the three-column Agent composer and
the720px main-thread grid placement (`prw-agent-profiles-e2e-lgB4Tx`,13 formal captures plus one failure image,
FAIL). Limited200% matrix visual approval is not complete UI acceptance.
The corrected production build and full focused rerun are recorded below.

Historical `pnpm build` and `pnpm test:e2e:agent-profiles` PASS before final review:
24 real workflows,116 screenshots, zero Renderer errors. All11 routes appear
in both themes at outer1440/720 with custom primary; tools/skills matrices also
cover all4 primary presets,320px/1024px, real200% Electron zoom, keyboard focus,
atomic save/error/draft/restart behavior and extra320 cell/save-area captures.
Actual primary button text contrast minimum4.548691482970604 (>=4.5).

```text
C:\Users\HK\AppData\Local\Temp\prw-agent-profiles-e2e-SHd3LX\agent-profiles-evidence.json
```

See `AI_ASSISTANT_TEAM_MAPPING.md` for exact executed commands, image inventory,
author visual checks and remaining real-provider/NSIS acceptance limits.

## Historical pre-palette author evidence

The following132-capture focused PASS predates the general `/help` pointer
regression. The dock scroller clipped the absolute palette; this artifact
remains layout evidence, not current complete UI acceptance. The new popup
candidate and its full focused/general gates are recorded separately below.

`pnpm build` PASS: Renderer `index-Hh2I7TxR.css` / `index-Bd_sc9Z7.js`.
`pnpm test:e2e:agent-profiles` PASS:29 workflows,132 native compositor screenshots,
zero Renderer errors. All11 real views,16 left settings sections, both matrices,
all4 presets, custom/restart/CAS/draft/identity behavior remain covered.

```text
C:\Users\HK\AppData\Local\Temp\prw-agent-profiles-e2e-Vaubwe\agent-profiles-evidence.json
SHA256 9FF3B313147A532D7F71EB4EFFA79CE3435F3619A6E4D78F9EA3110E0E5B17A8
```

The bounded composer fixes are container-relative padding, wrapping groups,
bounded select text, explicit main grid column2 and a60%-height dock scroller.
12 layout records prove default/named selectors do not overlap and each actual
control reaches viewport/main/thread/dock clip bounds after real scroll/focus.
Four720/320 history-overlay records verify stable main placement through real
open/collapse. Both Provider captures show40 real catalog cards and no loader.
412 strict200% matrix-control visibility/focus/hit tests and enabled save-area
captures are included in the same final artifact, not appended mock visuals.
132 PNG dimensions match the actual physical Electron viewport; CDP zoom
clipping no longer substitutes for a full user-viewport capture. Actual primary
contrast minimum4.548691482970604 remains >=4.5.

Historical116/12, `lgB4Tx`13-formal-plus-failure-image run, `sCR6pC`320px failure and `MteoOt`
125-image partial selector failure are not current acceptance. Supervisor
records the separate full general gate; its isolated HTTP Zotero fixture is
explicitly not real Zotero/BBT validation. Author evidence does not grant
independent QA/security/license or installed Windows NSIS approval.

## Current popup-corrected author evidence

The palette is an absolute main-thread sibling of the scrollable dock.
Measured composer coordinates, ResizeObserver and capture-phase scroll updates
keep it above the input and within the actual thread/viewport. The narrow dock
still scrolls; no force-click or z-index-only workaround is used. Bounded grid
tracks prevent narrow option overflow; actual mouse movement selects without
stationary-hover repaint resetting keyboard selection.

- `pnpm build`: PASS, Renderer `index-9XHUjMbI.css` / `index-BupRxgEE.js`.
- `node scripts/e2e-agent-profiles.cjs --palette-only`: PASS,4 workflows and
  4 native captures in a fresh profile; sanity only, not full acceptance.
- `pnpm test:e2e:agent-profiles`: PASS,33 workflows,136 native captures,
  `consoleErrors: []`, same production assets as the sanity check.

```text
C:\Users\HK\AppData\Local\Temp\prw-agent-profiles-e2e-WnnxDm\agent-profiles-evidence.json
SHA256 FE988979EB2A0D5094AEF834A33CC730CCDC2200C29521B5F8169938DDDDFEB2
Renderer CSS SHA256 B70C78A50E6AEBC83A89725DE702A687FCA6476C2D4AA2D0609CAFA5B7B2E7E0
Renderer JS SHA256 B28A274133D66D0C5228F4163B0F2AAFAFB099FD833C434CA6DE10BF92F923B8
Core SHA256 7129AAFC28CC55717DC9DE06766182349BAC2FA32C079C7FF94198493CE23934
```

All earlier132 captures remain. Added4 palette captures/12 strict option
records cover light/dark at outer1440/320: actual `/help` pointer click and
local response, ArrowDown/Tab, last-option ArrowUp scroll/center-hit, Enter
completion and Escape. Commands create neither conversation nor run. The12
composer layouts/88 reachable controls,4 history-overlay records,412 matrix
control checks,40 loaded Provider cards per theme and18 actual contrast
measurements (minimum4.548691482970604) still pass.

Supervisor records the serial general E2E and independent acceptance separately.
Author focused PASS is not installed NSIS, real-provider, Zotero/BBT, OAuth,
OS-display-scaling, security or license release approval. Narrow palette text
is ellipsized visually while the full accessible option text remains present.

Supervisor subsequently executes `pnpm test:e2e` on these same assets: PASS,
exit0, fresh profile `prw-workbench-e2e-fX6J28`; frontend author reads the log
`C:\Users\HK\AppData\Local\Temp\prw-general-e2e-final-20261015-015458.log`
and fixture evidence rather than claiming own execution. The original actual
palette mouse/local-command, Provider/model, task/schedule,320px and scroll
assertions pass. Zotero is an explicitly mocked read-only loopback HTTP
fixture, not real Zotero/BBT; fixture evidence has `violations: []`.

## 0.0.6 follow-up

Implementation29 supersedes earlier missing remote-resource capabilities: reviewed SQLite instruction skills and explicitly probed Streamable HTTP MCP now have typed management, binding, revocation and human approval. Fresh0.0.6 profiles E2E:33 workflows/136 native screenshots; resources:6/18; general E2E PASS. Actual online services/installer publication remain separate evidence. Python sidecars are retired; original source designs remain reference-only.
