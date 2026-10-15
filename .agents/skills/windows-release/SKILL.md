---
name: windows-release
description: Safely build, verify and publish the Personal Research Workbench Windows NSIS release.
---

# Windows Release

Read AGENTS.md and the Desktop Backend, QA and Review/Security roles first.
Use explicit user authorization to publish; never force-push or rewrite a tag.
Preserve unrelated dirty files. Stage only the bounded delivery paths.

## Pipeline

1. `node .agents/skills/windows-release/scripts/release.mjs status`
2. Read actual remote releases, choose an unused increasing version, write
   `docs/changelog/v<version>.md`, then run `release.mjs version <version>`.
3. Run named Node suites, `pnpm typecheck`, `pnpm build`, and isolated Electron
   regression. `pnpm test` is intentionally a no-op and is not acceptance.
4. Commit all required source before publishing artifacts. If unrelated dirty
   work remains, prove packaged inputs match the committed tree and exclude
   untracked/private files. Never silently publish uncommitted implementation.
5. `release.mjs build` builds NSIS x64 with `--publish=never`.
   `release.mjs verify` checks identity, required payload and retired-sidecar absence.
6. `release.mjs smoke` delegates to `scripts/e2e-installed-release.cjs`.
   Use only a new unique TEMP sandbox. Custom install/profile targets are forbidden.
   This gate must fail on missing DB evidence, wrong version/origin, failed restart,
   lost data or failed uninstall. Preserve all evidence; never recursively delete.
7. Obtain independent QA/Security acceptance. Push the branch without force,
   then `release.mjs publish --yes`. It uploads Setup.exe, blockmap and latest.yml.
   Re-read remote tag, commit, assets, sizes and hashes.

## Safety

- Never kill by image name or touch another application instance. Only close
  the exact launched app/PID tree. Do not disable Defender or change exclusions.
- Reject existing installs/profiles/processes/reparse targets before smoke.
  A normal NSIS installer necessarily creates its own temporary registration and
  cache. Require a clean baseline and verify uninstall restores that baseline;
  never remove pre-existing registry values, shortcuts or user data.
- `nsis.runAfterFinish:false` prevents installer auto-launch into the default
  profile. Never execute an older installer that auto-launches; an extracted old
  executable is a different test, not an old-installer upgrade.
- Packaged user data is per-user AppData by default. Only explicit validated
  `--prw-user-data-dir=<absolute non-root path>` isolates test profiles.
- Retired Python sidecars are not shipped or executable capabilities.
- Secrets stay in Main safeStorage. No real credentials in fixtures, logs or assets.
- New third-party services tested through loopback fixtures are NOT real provider,
  OAuth, Zotero, external MCP or external-write acceptance.

## Evidence

Record exact commands, exit codes, version/commit/tag, installer byte size/SHA256,
ProductVersion, signature status, package deviations, install/restart/reinstall/
uninstall results, migration/integrity checks, remaining files and all unrun gates.
A same-version reinstall is not a previous-version upgrade. A database migration
fixture is not an installer upgrade. Unsigned binaries must be clearly disclosed.

Read `references/evidence-and-pitfalls.md` for the controlled electronDist fallback.
The author cannot approve their own security/release gate.
