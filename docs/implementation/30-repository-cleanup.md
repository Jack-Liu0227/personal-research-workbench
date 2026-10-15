# Repository Cleanup - 2026-10-15

The user explicitly requested clean source on the remote and allowed removal of
obsolete files. This change records existing, reviewed deletions; it does not run
a broad filesystem cleanup or remove local profiles, installed dependencies or
untracked personal files.

- Remove the retired Python `sidecars/` source and bundled web/vendor payload.
  Main compatibility endpoints are inert errors and the NSIS package no longer
  includes or launches those files. Git history preserves their previous content.
- Remove previously deleted `artifacts/` generated architecture screenshots/HTML
  and old news-radar deployment assets. They are not authoritative product source.
- Remove previously deleted root handoff messages, the research-workbench bundle
  and the old sidecar patch under the root patch directory. No secrets or generated
  binary bundles are added to the clean delivery.
- Ignore only root-level `/pi/`, `/pi-web/` checkouts and `/.playwright-mcp/`
  diagnostics. Do not ignore the real `packages/agent-runtime/src/pi/` directory.
- Register the already tracked, fixed-revision last30days Git link in
  `.gitmodules` so a new checkout can initialize it using `git submodule update
  --init --recursive`. Do not publish the local untracked `PRW-PIN.md`; package
  filters exclude it. Upstream licenses remain intact.

The unrelated local `pnpm-workspace.yaml` placeholder edit is not included in this
delivery; the committed workspace native-build policy remains unchanged. No
`git reset --hard`, `git clean`, global process kill, recursive deletion or
personal-data migration is used. Release evidence and installer outputs remain
outside tracked source.
