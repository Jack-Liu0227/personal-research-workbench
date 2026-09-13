---
name: windows-release
description: >
  Automate the Personal Research Workbench Windows release pipeline end to end:
  run the verification gate, set one version across every package and the MCP
  server identity, build the x64 NSIS installer (including the machine-local
  `.asar` fallback that substitutes `-c.electronDist`), verify the artifact
  (size, SHA-256, Authenticode status, packaged skills/sidecars), smoke-test
  silent install, first launch, isolated `--prw-user-data-dir` profile and
  uninstall on real Windows, then tag and publish the GitHub release with notes
  from `docs/changelog`. Use when the user says 发布 release / 发版 / 打包
  Windows 安装包 / 出一个新版本 / bump the version and publish / create a
  GitHub release / build a Windows installer for the workbench. Dev-only
  project skill: it is excluded from the installer's skill mirror.
---

# Windows release playbook

One skill for "cut a version, build the installer, prove it runs, publish it".
Every command below has a scripted form in [`scripts/release.mjs`](scripts/release.mjs)
and a manual form, so a partially scripted release is still possible.

Scope: `Personal Research Workbench` (Windows 10/11 x64, NSIS, Electron).
Not in scope: macOS/Linux packaging, auto-update wiring, and any external
service acceptance (Zotero/Vault/cron/model) — those keep their own BLOCKED
status and must never be implied by a release.

## Hard rules

1. **Never claim an unrun step.** `pnpm test` is an intentional no-op in this
   repository; it is never evidence. Smoke steps that were skipped are reported
   as skipped.
2. **One version, everywhere.** The version lives in 11 `package.json` files plus
   the MCP server identity in `packages/workspace-mcp/src/server.ts`. A release
   whose `Setup.exe` name, `app.getVersion()`, tag and title disagree is a defect.
   `release.mjs version` finds these files dynamically and fails if any file
   still carries a different version.
3. **Disclose the version direction.** Look at the published releases first
   (`release.mjs status`): if a higher version is already published — as with
   the `v0.1.0` pre-release next to the `v0.0.2` release in this repository —
   say so in the notes and in the final report, and state why the lower number
   is still self-consistent (no tag of that number, private packages,
   `workspace:*` dependencies). A future release should simply continue above
   the highest published version.
4. **Never touch the user's data or credentials.** No `zotero.sqlite`,
   `.obsidian/`, `.env`, `~/.pi`, no installed-app profiles outside an explicit
   isolated directory, no system settings (do not disable Defender or add
   antivirus exclusions to work around a build lock).
5. **No destructive git.** Tag and push only. Do not reset, clean, force-push,
   or rewrite existing commits, and never stage another writer's in-flight
   changes: stage the release paths explicitly.
6. **Do not publish without explicit human consent.** `publish` refuses without
   `--yes`, requires a clean tree (or `--allow-dirty` with a printed warning),
   and requires the changelog file to exist first.
7. **Keep unverified work `IN_REVIEW`.** Code signing, auto-update, external
   service round-trips and packaged-app UI regression stay listed as not done.

## Prerequisites

- Clean (or intentionally dirty) working tree on the branch to release.
- `pnpm typecheck` green; `gh auth status` logged in with `repo` scope.
- Release notes at `docs/changelog/v<version>.md`. `docs/releases/` is
  **ignored** by the root `.gitignore` rule `release*/`, so notes must not live
  there.
- Free disk: the NSIS output plus a pre-extracted Electron dist is ~1 GB.

## Fast path

```powershell
# 0. What is the current state? (read-only)
node .agents/skills/windows-release/scripts/release.mjs status

# 1. Write docs/changelog/v0.0.3.md, then set the version everywhere
node .agents/skills/windows-release/scripts/release.mjs version 0.0.3

# 2. Gate + build (auto-falls back to -c.electronDist when the .asar lock hits)
node .agents/skills/windows-release/scripts/release.mjs build

# 3. Artifact identity + packaged payload
node .agents/skills/windows-release/scripts/release.mjs verify

# 4. Real install / launch / isolated profile / uninstall smoke
node .agents/skills/windows-release/scripts/release.mjs smoke

# 5. Commit, then tag + push + publish the GitHub release
git add -A docs package.json apps/desktop/package.json packages apps/desktop/electron-builder.yml
git commit -m "chore(release): bump workbench version to 0.0.3"
git push origin master
node .agents/skills/windows-release/scripts/release.mjs publish --version 0.0.3 --yes
```

`--dry-run` works on `version`, `build`, `smoke` and `publish`; use it first when
you are unsure what a step would touch.

## Subcommands

| Command | Effect | Leaves behind |
| --- | --- | --- |
| `status` | versions per package, latest tag, latest `gh` release, artifacts on disk | nothing (read-only) |
| `version <x.y.z>` | rewrites the 11 `package.json` versions + the `McpServer` identity, preserving byte layout; `--check` prints mismatches | edited source files (uncommitted) |
| `build` | `pnpm typecheck` + `pnpm build`, then electron-builder NSIS x64; writes a build log | `release-<version>/build/**`, `release-<version>/electron-dist/**` (both gitignored) |
| `verify` | size, SHA-256, `NotSigned`/signer, `ProductVersion`, packaged `skills/`, `sidecars/`, `app.asar` | nothing |
| `smoke` | silent install to `%TEMP%\prw-smoke-<version>`, launch with an isolated profile, read the SQLite first-run evidence, kill, silent uninstall, report leftovers | temp install + profile dirs |
| `publish` | `git tag -a`, push tag, `gh release create` with the installer + `.blockmap` and the changelog body, then re-reads the release | tag, release, uploaded assets |

Flags worth knowing:

- `build --out <dir>` / `--electron-dist <dir>` / `--force-electron-dist`
  (`--out` defaults to `release-<version>/build`).
- `build --skip-gate` only when the gate already passed on this exact tree.
- `smoke --setup <exe>` to smoke an artifact that is not the current build,
  `--install <dir>` / `--profile <dir>` to relocate the temp dirs (no spaces
  allowed), `--keep` to leave the installation in place.
- `publish --notes-file <path>` to override the changelog source.

## Evidence the release must carry

`verify` and `smoke` print a copy-pasteable block. Record it in
`docs/implementation/<n>-...release.md`, add a row to
`docs/development-progress.csv`, and paste the artifact identity into the
release notes:

- installer name, byte size, SHA-256, `ProductVersion`, Authenticode status;
- whether the default electron-builder path or the `electronDist` fallback was
  used, and any resulting package deviation;
- install directory contents (exe, uninstaller, `resources/skills`, `sidecars`);
- first-run database evidence (migrations applied, seeded schedules, empty user
  tables) and the isolated-profile directory;
- uninstaller exit code, what was removed, what was left;
- the explicit list of steps that were **not** run.

## Failure modes and pitfalls

Read [`references/evidence-and-pitfalls.md`](references/evidence-and-pitfalls.md)
before debugging a failed build, a failed uninstall, or a suspicious artifact.
It records the measured behaviour of this machine's `.asar` file lock, the NSIS
command-line quoting rules, the temp-directory requirement, and the exact
evidence templates used by the 0.0.2 release.

## Self-checks that do not build anything

```powershell
node --check .agents/skills/windows-release/scripts/release.mjs   # syntax
node .agents/skills/windows-release/scripts/release.mjs status    # read-only state
node .agents/skills/windows-release/scripts/release.mjs version 0.0.2 --check
```

The packaging filter that keeps this dev-only skill out of the installer can
be verified against electron-builder's real matcher without building anything:

- recommended: `apps/desktop/electron-builder.yml` → `extraResources[0].filter`
  contains `"!**/windows-release/**"`;
- `FileMatcher.createFilter()` from the installed `app-builder-lib` must return
  `false` for `windows-release/SKILL.md` and `true` for
  `literature-matrix/SKILL.md` once that pattern is present;
- `release.mjs verify` warns whenever `win-unpacked/resources/skills` still
  contains `windows-release`, so a missing filter cannot pass unnoticed.

`references/evidence-and-pitfalls.md` §4 has the exact check to run. If the
filter is absent, the skill only costs ~20 KB in the installer: the runtime
resolves an explicit catalog of skill keys, so an unknown directory is never
listed or injected into an agent session.

## Handoff

Report: version published (and whether it is a downgrade), artifact identity,
which smoke steps ran with what result, which steps were skipped and why, and
the next role that owns the remaining items (QA for packaged-app regression,
Review Security for signing/licence, Supervisor for CSV status).
