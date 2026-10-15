# Windows Release Evidence And Pitfalls

## Safe installation smoke

Only `scripts/e2e-installed-release.cjs` owns the installed smoke. It creates a
unique TEMP root and preserves evidence. The old fixed-directory cleanup and
image-name process-kill instructions are retired and must never be used.
No arbitrary recursive deletion, existing profile reuse, default-profile launch,
security-product changes, or global application termination is allowed.

Normal NSIS installation creates its own uninstall registration/cache and may
create shortcuts. Detect existing product state first, refuse to overwrite it,
and compare post-uninstall state with the baseline. Keep residual installer-owned
files as evidence rather than deleting broad resources/registry trees.

`runAfterFinish:false` is required in production NSIS config. Never run an old
installer with automatic application launch. Installed restart and same-version
reinstall prove only those actions; report previous-version upgrade separately.

## Controlled Electron dist fallback

On this machine prior electron-builder output encountered EBUSY/EPERM on
`default_app.asar` or `win-unpacked.tmp`. The holder was not identified; do not
assume Defender is responsible and do not alter system protection.

Use a fresh output directory. If the same lock recurs, extract the cached official
Electron zip with the cached electron-builder 7za and use `-c.electronDist=<dir>`.
The release helper supports that bounded fallback; it must not delete previous
output trees or kill unrelated processes. Disclose that the fallback can retain
an inert `resources/default_app.asar` alongside app.asar. Fuses and app.asar must
remain intact. Uninstall leftovers are observations, not automatic success.

## Identity and publication

Discover versions in all workspace package.json files and the MCP identity,
currently `packages/workspace-mcp/src/in-process.ts`; never assume their count.
Use exact versions from manifests, not this document. Read GitHub releases before
choosing the next unused version. Do not rewrite existing tags.

Notes live in `docs/changelog/`, not ignored `docs/releases/`. Publish Setup.exe,
its blockmap, and `latest.yml` exactly once with `gh`. Production packaging uses
`--publish=never`, so building alone cannot publish. Verify uploaded hashes and
sizes against local artifacts and ensure the tag points at the tested source.

## Verification truth

`pnpm test` is a deliberate no-op. Named Node tests, full typecheck/build,
real Renderer/Preload/Core Electron regression and actual NSIS install/restart/
uninstall are distinct gates. Local Provider/MCP fixtures exercise SDK and trust
boundaries but do not constitute real online service acceptance. A generated EXE
is not an installed smoke, and a successful typecheck is not UI acceptance.
