# Release 0.0.6 License Evidence

- Source: `pnpm licenses list --prod --json` (UTF-8 or UTF-16LE supported).
- 288 grouped package rows, 294 exact installed name/version pairs.
- Mechanical gate: **PASS_WITH_DISCLOSED_EXCEPTIONS**; unresolved gaps: **4**.
- `production-dependencies.json`: path-redacted name/version/license/repository inventory.
- `THIRD_PARTY_NOTICES.txt`: verbatim license/notice texts, including fixed-revision skills.
- `source-evidence.json`: npm version metadata, exact official revision and retrieval evidence for packages missing LICENSE.
- `license-texts/`: content-addressed originals; hashes checked without network.
- `release-gate.json`: explicit gaps and remaining scope limits.
- `license-exceptions.json`: four exact npm MIT declarations, bounded URL/status/response-hash searches and clearly marked SPDX template exceptions; not approval.
- `native-clipboard-evidence.json`: 121 checksum-verified locked crate archives, selected original license-body evidence, zero Windows/build closure gaps and 15 separately disclosed other-target gaps. Not a macOS approval or exact binary SBOM.
- `native-clipboard/`: exact upstream source/provenance and retained originals; no native execution.

## Reproduce

`node scripts/generate-release-notices.mjs --version 0.0.6 --input <pnpm-json> --fetch-missing`

`node scripts/generate-release-notices.mjs --version 0.0.6 --input <pnpm-json> --fetch-native --fetch-exception-evidence`

`node scripts/generate-release-notices.mjs --version 0.0.6 --input <pnpm-json> --check`

The check is read-only, offline and rejects stale/missing/changed evidence. No package
installation, native module load, build, or application launch is performed. Network
retrieval is opt-in and limited to official npm/GitHub/crates.io HTTPS sources;
GitHub exact-revision GETs may use the installed gh CLI with credentials owned by gh.
The script never reads or prints those credentials. No latest-branch
license is silently substituted for an exact version. Unknown/unreviewed licenses
and missing license bodies block this mechanical gate. This does not replace
independent legal review or verification of the actual packaged payload.

Keep Electron's LICENSE and LICENSES.chromium.html, this directory in resources/legal/0.0.6,
and the skill registry/upstream license files. The production inventory is a
conservative superset, not a claim that build-only packages are shipped.
