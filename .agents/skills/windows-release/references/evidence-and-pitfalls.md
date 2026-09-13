# Evidence and pitfalls (measured on this repository's Windows machines)

Everything below is observed behaviour, not theory. Where a cause could not be
identified, it says so instead of guessing. The 0.0.2 release is the worked
example; its full write-up is `docs/implementation/21-windows-nsis-0.0.2-release.md`.

## 1. The `.asar` file lock (breaks the default packaging path)

Symptom, from `pnpm package:win`:

```text
EBUSY: resource busy or locked, unlink '...\release\win-unpacked.tmp\resources\default_app.asar'
EPERM: operation not permitted, rename '...\win-unpacked.tmp' -> '...\win-unpacked'
```

Measured behaviour (same machine, minutes apart):

| Probe | Result |
| --- | --- |
| Real Electron `.asar` payload created as `.asar` inside the repo tree | delete fails: `Device or resource busy` |
| Same bytes written as `.foo`, or 1-byte `.asar`, or any `.asar` outside the repo tree | deletes normally |
| Same `.asar` re-tried a few minutes later | deletes normally |
| `Get-MpComputerStatus` → `RealTimeProtectionEnabled` | `False` (so not Defender) |
| Running indexers/sync agents | `Everything`, `OneDrive.Sync.Service`, `SearchIndexer` present; the holder was **not** identified (no `handle.exe`/Process Explorer available) |

So something in the environment opens real `.asar` payloads for a transient
window and holds them without delete sharing. electron-builder hits that window
immediately after extracting Electron, hence the failure.

Workaround (used for 0.0.2): hand-extract the official Electron zip that the
electron-builder/Electron cache already contains, then point the build at it:

```powershell
$zip  = "$env:LOCALAPPDATA\electron\Cache\<hash>\electron-v<ver>-win32-x64.zip"
$7za  = (Get-ChildItem "$env:LOCALAPPDATA\electron-builder\Cache\7zip@*\7zip-win-x64*\bin\7za.exe").FullName
& $7za x -bso0 -bsp0 -o"$repo\release-<version>\electron-dist" $zip
pnpm exec electron-builder --win nsis --x64 `
  -c.electronDist="$repo\release-<version>\electron-dist" `
  -c.directories.output=../../release-<version>/build
```

`release.mjs build` does this automatically when the first attempt fails with
`EBUSY`/`EPERM`/`default_app.asar`. Consequences to disclose:

- `electronDist` skips `cleanupAfterUnpack`, so the package keeps
  `resources/default_app.asar` (~111 KB, Electron's fallback app). Inert while
  `resources/app.asar` and the `onlyLoadAppFromAsar` fuse are intact, but it is
  **not** standard electron-builder output.
- The same lock makes the **uninstaller** leave `resources/app.asar` and
  `resources/default_app.asar` behind, so `$INSTDIR\resources` survives
  uninstall. Everything else, the shortcuts, and the `HKCU\...\Uninstall` entry
  are removed normally (measured: 40 entries → 1 on a silent uninstall).
  Retry `Remove-Item $INSTDIR\resources -Recurse -Force` later, when the lock
  has expired.

## 2. Command-line quoting

- NSIS: `/S` and `/D=` are position-sensitive. `/D=` must be **last** and its
  value must **not** be quoted; a quoted value can be parsed as multiple
  arguments. Because of that, keep smoke directories space-free — the script
  defaults to `%TEMP%\prw-smoke-<version>` (`C:\Users\<u>\AppData\Local\Temp`,
  which never contains a space) and rejects paths that do.
- Running the uninstaller: `cmd /c "Uninstall research-workbench.exe /S"` fails
  with `'Uninstall' is not recognized ...`, because cmd resolves the first token
  as a program name. Invoke the file directly
  (`Start-Process -FilePath '.\Uninstall research-workbench.exe' -ArgumentList '/S' -Wait`,
  or `spawnSync(uninstallerPath, ['/S'])`), which quotes correctly.
- Killing a running instance before uninstall: `taskkill /IM research-workbench.exe /F`.
  A packaged instance spawns several processes; kill by image name, not by the
  PID you happened to launch.
- The `bash` tool's `timeout` parameter is **seconds** (max 2147483.647); do not
  pass milliseconds, and do not prefix commands with the shell `timeout`.

## 3. Version self-consistency

The version string lives in:

- `package.json` (root),
- `apps/desktop/package.json`,
- `packages/{agent-runtime,ai-runtime,connectors,contracts,database,domain,workspace-core,workspace-mcp,workspace-service}/package.json`,
- `packages/workspace-mcp/src/server.ts` → `new McpServer({ name: 'personal-research-workbench', version: '<x.y.z>' })`.

`release.mjs version` discovers `package.json` files by scanning the root,
`apps/*`, `packages/*`, and then looks for the MCP identity by scanning
`packages/*/src` for the current version literal, so a renamed package or a new
workspace still gets rewritten. After writing, it re-scans and fails if any
target still carries the old version.

Rewrite JSON with a targeted regex (first `"version"` field) rather than a full
JSON re-serialise, so key order, indentation and the trailing newline survive; a
careless rewrite is what produced a spurious "last line changed" diff once.

## 4. Release notes, publishing and repository layout

- `docs/releases/` is ignored: the root `.gitignore` rule `release*/` matches the
  directory `releases`. Keep notes in `docs/changelog/v<version>.md`.
- The release page cannot resolve relative repository links; use a full
  `https://github.com/<owner>/<repo>/blob/<branch>/...` URL inside the notes.
- Check `apps/desktop/electron-builder.yml` for a `publish:` section before
  claiming anything about automatic publishing. Without it there is no
  `latest.yml`, so `gh release create` is the only publishing step and `gh`
  needs the `repo` scope. With it, electron-builder also emits `latest.yml` and
  an auto-updater (if the app embeds `electron-updater`) can install updates —
  then the release must be published by exactly one of the two paths, never both.
- Build outputs (`release*/`) are gitignored; they must never be committed, and
  they are the only thing a release cleanup may delete.
- Before tagging, compare against what is already published: this repository has
  both a `v0.1.0` pre-release (2026-09-11) and the later `v0.0.2` release, so
  "no releases exist" is a claim that must be re-checked, not assumed.

### Keeping this dev-only skill out of the installer

`extraResources[0]` copies `.agents/skills` into `resources/skills`. Add the
narrow exclusion so the release playbook does not ship:

```yaml
    filter:
      - "**/*"
      - "!**/.git/**"
      - "!**/__pycache__/**"
      - "!**/*.pyc"
      - "!**/last30days/assets/**"
      - "!**/windows-release/**"
```

Verify with the packaged checker (no build required):

```powershell
node .agents/skills/windows-release/scripts/verify-packaging-filter.mjs
```

It reads the `filter:` list from `apps/desktop/electron-builder.yml`, feeds it to
`FileMatcher.createFilter()` from the installed `app-builder-lib` (the same code
path `copyDir` uses) and asserts:

| path | required |
| --- | --- |
| `windows-release/SKILL.md`, `windows-release/scripts/release.mjs` | not allowed |
| `literature-matrix/SKILL.md`, `literature-review-push/SKILL.md`, `last30days/skills/last30days/SKILL.md` | allowed |
| `last30days/assets/demo.mp4` (when that pattern is present) | not allowed |

Measured with `app-builder-lib@26.15.3` on 2026-09-13: with the extra pattern the
matcher rejects both files of this skill and keeps every other skill, leaving the
existing `!**/last30days/assets/**` behaviour unchanged. While the pattern is
absent the checker prints the exact line to add and exits 1 — in this repository
that was still the case on 2026-09-13, because `electron-builder.yml` carried an
unrelated uncommitted `publish:` change from another writer and was left alone.

Directory entries themselves are always passed through (`excludePatterns` never
filters a directory), so an empty `windows-release/` folder may survive in
`win-unpacked` — harmless, but do not report "the skill is not packaged" based on
the directory alone; check the files.

## 5. Smoke expectations

A passing smoke records, at minimum:

```text
install     -> <install>\research-workbench.exe, Uninstall research-workbench.exe,
               resources\app.asar, resources\skills\{grilling,last30days,
               literature-matrix,literature-review-push,ponytail,ui-ux-pro-max},
               resources\sidecars\{requirements.txt,scholar.py}
first run   -> <profile>\data\workspace.sqlite3 with header "SQLite format 3",
               _prw_migrations row count == migration count in
               packages/database/src/migrations.ts, seeded builtin schedules
               (last30days / literature-matrix / literature-review-push, enabled),
               0 rows in tasks/papers/projects
isolation   -> --prw-user-data-dir=<dir> creates data/, config/, workbench/ there
               and nothing new in the install directory
uninstall   -> exit code 0, shortcuts and HKCU uninstall entry gone, remaining
               entries listed explicitly
```

Packaged builds put `app.getPath('userData')` next to the executable
(`apps/desktop/src/main/index.ts`, packaged branch), which is why the first run
inside the install directory writes `data/`, `config/` and `workbench/` there.
That is intended portable behaviour, not a leak.

## 6. Reading the packaged database from the repo

`better-sqlite3` is only reachable through pnpm's store:

```js
const dir = fs.readdirSync('node_modules/.pnpm').find((n) => n.startsWith('better-sqlite3@'))
const Database = require(`./node_modules/.pnpm/${dir}/node_modules/better-sqlite3`)
const db = new Database(dbPath, { readonly: true, fileMustExist: true })
```

Open it **after** the app has been killed, and only `readonly`.

## 7. Verification honesty checklist

Before reporting a release as done:

- [ ] `pnpm typecheck` and `pnpm build` ran on the committed tree.
- [ ] Installer identity (size + SHA-256 + signature status) came from the actual
      file, not from the build log.
- [ ] Every smoke step that is claimed has its command and observed output.
- [ ] Skipped steps (signing, auto-update, packaged-app UI regression, external
      services) are listed as not done.
- [ ] `docs/development-progress.csv` and the implementation doc were updated in
      the same release round.
- [ ] The tag, `Setup.exe` name, `app.getVersion()` and release title all show
      the same version.
