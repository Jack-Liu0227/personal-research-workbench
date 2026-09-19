# Windows 0.0.4 release evidence

## Scope

Personal Research Workbench `v0.0.4`, Windows 10/11 x64 NSIS. This release packages the in-process Pi Agent/provider/research workflow and the associated UI/documentation changes already present on `master`.

## Version and packaging

- `release.mjs version 0.0.4 --check`: PASS
- All 11 package manifests and `packages/workspace-mcp/src/in-process.ts`: `0.0.4`
- Build path: default electron-builder path; no `electronDist` fallback
- Installer: `Personal-Research-Workbench-0.0.4-Setup.exe`
- Size: `140,324,737` bytes
- SHA-256: `951D46776809F955CFA7FC1A8670CD272E5C0AF7B3C114CF962F5733B36C5C69`
- ProductVersion: `0.0.4`
- Authenticode: `NotSigned` / no signer
- Blockmap: `148,968` bytes
- Packaged payload includes the expected skill mirror and `requirements.txt`/`scholar.py` sidecars; the dev-only `windows-release` skill is excluded.

## Windows smoke

`release.mjs smoke` ran on the real Windows host:

1. Silent NSIS install into `C:\Users\HK\AppData\Local\Temp\prw-smoke-0.0.4`.
2. Launch with isolated `C:\Users\HK\AppData\Local\Temp\prw-profile-0.0.4`.
3. First-run evidence: SQLite format 3, 43 tables, 32 migrations, three enabled seeded schedules, empty tasks/papers/projects.
4. Stop all `research-workbench.exe` processes.
5. Silent uninstall exit code `0`.
6. Isolated profile was cleared. The install directory retained nine transient entries after uninstall and the script reported an `EPERM` cleanup warning; this was not suppressed or described as a clean directory.

## Gate

- `pnpm typecheck`: PASS through release build gate
- `pnpm build`: PASS through release build gate
- `release.mjs verify`: PASS
- `release.mjs smoke`: PASS with the cleanup warning above

Previously completed repository validation remains recorded separately: recursive typecheck, E2E, Agent runtime tests, external-action tests and 10/10 live Agent check.

## Not run / not claimed

- Real OAuth browser callback round-trip
- Disposable Zotero/Obsidian external write round-trip
- Code signing
- Clean-machine Windows install/uninstall
- Packaged-app UI regression
- Auto-update release wiring

Next owners: QA for packaged UI and disposable external-service validation; Review/Security for signing, credential and license gates; Supervisor for persistent roadmap status.
