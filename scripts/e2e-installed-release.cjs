/* Installed Windows release smoke. Never deletes evidence or launches an old installer. */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const assert = require('node:assert/strict')

const REPO = path.resolve(__dirname, '..')
const APP_ID = 'com.personalworkshop.researchworkbench'
const PRODUCT = 'Personal Research Workbench'
const EXE = 'research-workbench.exe'
const PACKAGE_NAME = 'personal-research-workbench'
const UPDATER_CACHE = `${PACKAGE_NAME}-updater`
const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
const EXPECTED_MIGRATION = 39
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function parseArgs(argv) {
  const result = { dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--dry-run') {
      assert(!result.dryRun, 'Duplicate --dry-run')
      result.dryRun = true
    } else if (flag === '--setup' || flag === '--version') {
      const key = flag.slice(2)
      assert(!Object.hasOwn(result, key), `Duplicate ${flag}`)
      const value = argv[++i]
      assert(value && !value.startsWith('--'), `${flag} requires a value`)
      result[key] = value
    } else if (flag === '--previous-setup') {
      throw new Error('Old installers may auto-launch the default profile; --previous-setup is forbidden. This checks same-version reinstall, not an old-installer upgrade.')
    } else throw new Error(`Unknown/unsafe option: ${flag}`)
  }
  assert(result.setup && result.version, 'Required: --setup <absolute exe> --version <version> [--dry-run]')
  assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(result.version), 'Invalid version')
  assert(path.win32.isAbsolute(result.setup) && /^[A-Za-z]:[\\/]/.test(result.setup), 'Setup must be an absolute local-drive path, not UNC/device/relative')
  assert(!/["\r\n\0%]/.test(result.setup), 'Unsafe setup path')
  assert(path.extname(result.setup).toLowerCase() === '.exe', 'Setup must be an EXE')
  return result
}

function contained(root, target) {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function assertNoLinks(target) {
  const absolute = path.resolve(target)
  let cursor = path.parse(absolute).root
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    if (!fs.existsSync(cursor)) {
      try { fs.lstatSync(cursor) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    }
    const stat = fs.lstatSync(cursor)
    assert(!stat.isSymbolicLink(), `Symlink/junction path refused: ${cursor}`)
    assert.equal(path.resolve(fs.realpathSync.native(cursor)).toLowerCase(), path.resolve(cursor).toLowerCase(), `Redirected path refused: ${cursor}`)
  }
}

function assertFreshOwnedPath(root, target) {
  assert(contained(root, target), 'Target must be strictly inside the unique smoke root')
  assertNoLinks(root)
  assertNoLinks(path.dirname(target))
  assert(!fs.existsSync(target), `Refusing an existing smoke target: ${target}`)
  try { fs.lstatSync(target); throw new Error(`Existing target refused: ${target}`) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  return target
}

function createSandbox() {
  const temp = path.resolve(os.tmpdir())
  assert(/^[A-Za-z]:[\\/]/.test(temp), 'TEMP must be on a local Windows drive')
  assert(!/["\r\n\0%]/.test(temp), 'Unsafe TEMP path')
  assert.notEqual(path.parse(temp).root.toLowerCase(), temp.toLowerCase(), 'TEMP cannot be a drive root')
  assertNoLinks(temp)
  const root = fs.mkdtempSync(path.join(temp, 'prw-installed-smoke-'))
  assertNoLinks(root)
  const locations = { root }
  for (const name of ['install', 'profile', 'logs', 'staging', 'process-temp']) {
    locations[name] = assertFreshOwnedPath(root, path.join(root, name))
    if (name !== 'install') fs.mkdirSync(locations[name])
  }
  fs.writeFileSync(path.join(root, 'owned-smoke-root.json'), JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), pid: process.pid, root }, null, 2), { flag: 'wx' })
  return locations
}

function uuidV5(name, namespace = '50e065bc-3134-11e6-9bab-38c9862bdaf3') {
  const bytes = crypto.createHash('sha1').update(Buffer.from(namespace.replaceAll('-', ''), 'hex')).update(name).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const h = bytes.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function selectPowerShell() {
  const candidates = [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')]
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) candidates.push(path.join(directory, 'pwsh.exe'))
  for (const candidate of candidates) if (fs.existsSync(candidate)) return { executable: candidate, fallback: false }
  const legacy = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  assert(fs.existsSync(legacy), 'No PowerShell available for fail-closed Windows state inspection')
  console.warn('PowerShell 7 is unavailable; Windows PowerShell is used only for read-only state/metadata inspection and exact PID Stop-Process.')
  return { executable: legacy, fallback: true }
}

function powershell(shell, source, input = {}) {
  const prefix = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $c=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PRW_SMOKE_INPUT)) | ConvertFrom-Json); "
  const encoded = Buffer.from(prefix + source, 'utf16le').toString('base64')
  const result = spawnSync(shell.executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PRW_SMOKE_INPUT: Buffer.from(JSON.stringify(input)).toString('base64') }
  })
  assert(!result.error, `Windows state inspection failed: ${result.error?.message}`)
  assert.equal(result.status, 0, `Windows state inspection failed: ${result.stderr}`)
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim())
}

const SNAPSHOT_PS = String.raw`
$guid=$c.guid; $product=$c.product; $exe=$c.exe
$appData=[Environment]::GetFolderPath('ApplicationData'); $local=[Environment]::GetFolderPath('LocalApplicationData')
$homes=@(
  (Join-Path $appData $product),(Join-Path $appData '@prwdesktop'),
  (Join-Path $appData 'research-workbench'),(Join-Path $appData 'personal-research-workbench'),
  (Join-Path $local ('Programs\'+$product)),(Join-Path $local ('Programs\'+$exe.Replace('.exe',''))),
  (Join-Path $local $c.updaterCache)
)
foreach($base in @($env:ProgramFiles,[Environment]::GetEnvironmentVariable('ProgramFiles(x86)'))) { if($base) { $homes+=Join-Path $base $product } }
$existing=@(); foreach($candidate in ($homes | Select-Object -Unique)) { if(Test-Path -LiteralPath $candidate) { $existing+=@{path=$candidate;attributes=[int](Get-Item -Force -LiteralPath $candidate).Attributes} } }
$registrations=@()
foreach($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)) {
  foreach($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
    $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
    try {
      $keys=@(('Software\'+$guid),('Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$guid))
      $uninst=$base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
      if($uninst) { try { foreach($name in $uninst.GetSubKeyNames()) {
        $key=$uninst.OpenSubKey($name); try { $display=[string]$key.GetValue('DisplayName'); $location=[string]$key.GetValue('InstallLocation'); $icon=[string]$key.GetValue('DisplayIcon')
          if($display -like '*Personal*Research*Workbench*' -or $location -like '*research-workbench*' -or $icon -like '*research-workbench.exe*') { $keys+='Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$name }
        } finally { if($key) {$key.Dispose()} }
      }} finally {$uninst.Dispose()} }
      foreach($name in ($keys | Select-Object -Unique)) {
        $key=$base.OpenSubKey($name)
        if($key) { try { $values=@{}; foreach($value in $key.GetValueNames()) {$values[$value]=[string]$key.GetValue($value)}
          $registrations+=@{hive=[string]$hive;view=[string]$view;key=$name;values=$values}
        } finally {$key.Dispose()} }
      }
    } finally {$base.Dispose()}
  }
}
$shortcuts=@(); $shell=New-Object -ComObject WScript.Shell
try {
  $roots=@([Environment]::GetFolderPath('DesktopDirectory'),[Environment]::GetFolderPath('CommonDesktopDirectory'),[Environment]::GetFolderPath('Programs'),[Environment]::GetFolderPath('CommonPrograms')) | Select-Object -Unique
  foreach($root in $roots) {
    if(-not $root -or -not(Test-Path -LiteralPath $root)) {continue}
    $queue=New-Object 'System.Collections.Generic.Queue[string]'; $queue.Enqueue($root); $visited=0
    while($queue.Count -gt 0) {
      $directory=$queue.Dequeue(); $visited++; if($visited -gt 10000) {throw 'Shortcut inspection bound exceeded'}
      foreach($item in Get-ChildItem -Force -LiteralPath $directory) {
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { if($item.Name -like '*Research*Workbench*') {throw 'Product reparse shortcut path exists'}; continue }
        if($item.PSIsContainer) { $queue.Enqueue($item.FullName); continue }
        if($item.Extension -ne '.lnk') {continue}
        $link=$shell.CreateShortcut($item.FullName); $target=[string]$link.TargetPath
        if($item.Name -like '*Research*Workbench*' -or $target -like '*research-workbench.exe*') { $shortcuts+=@{path=$item.FullName;target=$target} }
      }
    }
  }
} finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
$processes=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq $exe -or $_.Name -like '*Research*Workbench*' } | ForEach-Object { @{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;exe=[string]$_.ExecutablePath;created=$_.CreationDate.ToString('o');command=[string]$_.CommandLine} })
@{existing=$existing;registrations=$registrations;shortcuts=$shortcuts;processes=$processes;appData=$appData;localAppData=$local} | ConvertTo-Json -Depth 8 -Compress
`

function snapshot(shell) {
  return powershell(shell, SNAPSHOT_PS, { guid: uuidV5(APP_ID), product: PRODUCT, exe: EXE, updaterCache: UPDATER_CACHE })
}

const PROTECTED_PS = String.raw`
$results=@()
foreach($target in $c.targets) {
  $absolute=[IO.Path]::GetFullPath([string]$target.path)
  $root=[IO.Path]::GetPathRoot($absolute)
  if($root -notmatch '^[A-Za-z]:\\$' -or $absolute.TrimEnd('\') -eq $root.TrimEnd('\')) {throw 'Protected root must be a non-root local-drive path'}
  $cursor=$absolute
  while($cursor) {
    if(Test-Path -LiteralPath $cursor) {
      $ancestor=Get-Item -Force -LiteralPath $cursor
      if($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'Protected root/ancestor is a reparse point'}
    }
    $parent=Split-Path -Parent $cursor
    if($parent -eq $cursor) {break}; $cursor=$parent
  }
  if(-not(Test-Path -LiteralPath $absolute)) {$results+=@{label=$target.label;present=$false};continue}
  if(-not(Get-Item -Force -LiteralPath $absolute).PSIsContainer) {throw 'Protected root is not a directory'}
  $queue=New-Object 'System.Collections.Generic.Queue[string]'; $queue.Enqueue($absolute)
  $entries=0; $files=0; $directories=0; [long]$bytes=0; $records=New-Object 'System.Collections.Generic.List[string]'
  while($queue.Count -gt 0) {
    $current=$queue.Dequeue(); $entries++; if($entries -gt [int]$c.maxEntries) {throw 'Protected tree entry bound exceeded'}
    $item=Get-Item -Force -LiteralPath $current
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'Protected tree contains a reparse point'}
    $relative=$item.FullName.Substring($absolute.Length)
    if($item.PSIsContainer) {
      $directories++
      $records.Add((@($relative,'directory',[int]$item.Attributes,$item.CreationTimeUtc.Ticks,$item.LastWriteTimeUtc.Ticks)|ConvertTo-Json -Compress))
      foreach($child in Get-ChildItem -Force -LiteralPath $current) {
        if($entries+$queue.Count+1 -gt [int]$c.maxEntries) {throw 'Protected tree entry bound exceeded'}
        if($child.Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'Protected tree contains a reparse point'}
        $queue.Enqueue($child.FullName)
      }
    } else {
      $files++; $bytes+=$item.Length; if($bytes -gt [long]$c.maxBytes) {throw 'Protected tree byte bound exceeded'}
      $length=$item.Length; $created=$item.CreationTimeUtc.Ticks; $modified=$item.LastWriteTimeUtc.Ticks; $attributes=[int]$item.Attributes
      $stream=[IO.File]::Open($current,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
      $hash=[Security.Cryptography.SHA256]::Create()
      try {$digest=([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-','').ToLowerInvariant()} finally {$hash.Dispose();$stream.Dispose()}
      $item.Refresh()
      if($length -ne $item.Length -or $created -ne $item.CreationTimeUtc.Ticks -or $modified -ne $item.LastWriteTimeUtc.Ticks -or $attributes -ne [int]$item.Attributes) {throw 'Protected file changed during read-only fingerprint'}
      $records.Add((@($relative,'file',$attributes,$created,$modified,$length,$digest)|ConvertTo-Json -Compress))
    }
  }
  $records.Sort([StringComparer]::Ordinal)
  $hash=[Security.Cryptography.SHA256]::Create()
  try {$digest=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes(($records -join "\n"))))).Replace('-','').ToLowerInvariant()} finally {$hash.Dispose()}
  $results+=@{label=$target.label;present=$true;entries=$entries;files=$files;directories=$directories;bytes=$bytes;sha256=$digest}
}
@{trees=@($results)} | ConvertTo-Json -Depth 5 -Compress
`

function fingerprintTrees(shell, targets, { maxEntries = 20_000, maxBytes = 2 * 1024 ** 3 } = {}) {
  assert(Number.isInteger(maxEntries) && maxEntries > 0 && maxEntries <= 20_000, 'Unsafe fingerprint entry bound')
  assert(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 2 * 1024 ** 3, 'Unsafe fingerprint byte bound')
  for (const target of targets) {
    assert(typeof target.label === 'string' && /^[a-z0-9-]+$/.test(target.label), 'Unsafe protected label')
    assert(path.win32.isAbsolute(target.path) && /^[A-Za-z]:[\\/]/.test(target.path), 'Protected tree must be a local-drive path')
    assertNoLinks(target.path)
  }
  return powershell(shell, PROTECTED_PS, { targets, maxEntries, maxBytes }).trees
}

function fingerprintProtected(shell, state) {
  return fingerprintTrees(shell, [
    { label: 'legacy-scoped-updater', path: path.join(state.localAppData, '@prwdesktop-updater') },
    { label: 'legacy-development-profile', path: path.join(state.appData, '@prw', 'desktop') }
  ])
}

function assertProtectedUnchanged(before, after) {
  assert.deepEqual(after, before, 'Protected pre-existing cache/development profile changed; stop without modifying or restoring it')
}

function assertBaseline(state) {
  for (const key of ['existing', 'registrations', 'shortcuts', 'processes']) {
    assert(Array.isArray(state[key]), `Missing Windows baseline ${key}`)
    assert.equal(state[key].length, 0, `Pre-existing product ${key}; smoke refused without changing it`)
  }
}

function assertInstalledState(state, install) {
  assert.equal(state.processes.length, 0, 'Unexpected product process before install/uninstall')
  assert(state.existing.every((entry) => entry.path.toLowerCase() === path.join(state.localAppData, UPDATER_CACHE).toLowerCase()), 'A default profile or default installation appeared')
  assert(state.registrations.length > 0, 'Installed registration missing')
  const guid = uuidV5(APP_ID)
  for (const entry of state.registrations) {
    assert.equal(entry.hive, 'CurrentUser', 'Unexpected all-users registration')
    assert([`Software\\${guid}`, `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`].includes(entry.key), 'Unexpected product registration key')
    if (entry.values.InstallLocation) assert.equal(path.resolve(entry.values.InstallLocation).toLowerCase(), install.toLowerCase(), 'Registration points outside owned install')
    if (entry.values.UninstallString) assert(entry.values.UninstallString.toLowerCase().includes(install.toLowerCase()), 'Uninstaller registration points elsewhere')
  }
  assert(state.shortcuts.length > 0, 'Installed Start menu shortcut missing')
  for (const shortcut of state.shortcuts) assert.equal(path.resolve(shortcut.target).toLowerCase(), path.join(install, EXE).toLowerCase(), 'Shortcut points outside owned install')
}

function readFuses(file) {
  const buffer = fs.readFileSync(file)
  const offset = buffer.indexOf(SENTINEL)
  assert(offset >= 0 && offset === buffer.lastIndexOf(SENTINEL), 'Missing/ambiguous Windows Electron fuse wire')
  const position = offset + SENTINEL.length
  assert.equal(buffer[position], 1, 'Unsupported Electron fuse version')
  assert(buffer[position + 1] >= 8, 'Incomplete Electron fuse wire')
  const values = [...buffer.subarray(position + 2, position + 10)].map((value) => String.fromCharCode(value))
  const required = { 0: '0', 1: '1', 2: '0', 3: '0', 4: '1', 5: '1', 7: '0' }
  for (const [index, value] of Object.entries(required)) assert.equal(values[index], value, `Release security fuse ${index} differs`)
  return values
}

function verifyAttestation(setup, version, repo = REPO) {
  assertNoLinks(setup)
  assert(fs.statSync(setup).isFile(), 'Setup is not a regular file')
  const file = path.join(path.dirname(setup), 'installed-smoke-attestation.json')
  assertNoLinks(file)
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(data.schemaVersion, 1, 'Missing release safety attestation')
  assert.equal(data.version, version)
  assert.equal(data.appId, APP_ID)
  assert.equal(data.runAfterFinish, false, 'Installer auto-launch is not disabled')
  assert.equal(data.packageName, PACKAGE_NAME, 'Actual ASAR package name has not been verified')
  assert.equal(data.updaterCacheDirName, UPDATER_CACHE, 'Actual app-update.yml cache has not been verified')
  assert.equal(data.nsisInstallerCacheDirName, UPDATER_CACHE, 'Actual generated NSIS cache has not been verified')
  assert.equal(data.setupSha256, sha(setup), 'Attestation does not match actual Setup bytes')
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, 'apps', 'desktop', 'package.json'), 'utf8')).version, version, 'Requested version is not this checkout version')
  assert.equal(path.basename(setup), `Personal-Research-Workbench-${version}-Setup.exe`, 'Unexpected Setup artifact identity')
  return data
}

function installerArgs(install) {
  assert(!/["\r\n\0%]/.test(install), 'Unsafe NSIS target')
  // NSIS requires /D to be the final, unquoted command-line tail, even with spaces.
  return ['/S', '/currentuser', '--no-desktop-shortcut', `/D=${install}`]
}

function stopExactTree(shell, owned, allowedRoot) {
  return powershell(shell, String.raw`
$all=@(Get-CimInstance Win32_Process); $root=$all | Where-Object {$_.ProcessId -eq [int]$c.pid}
if(-not $root){@{stopped=@()}|ConvertTo-Json -Compress;exit}
if($root.ExecutablePath -ine $c.exe -or $root.CreationDate.ToString('o') -ne $c.created){throw 'Owned PID identity changed'}
$ids=New-Object 'System.Collections.Generic.List[int]'; $ids.Add([int]$root.ProcessId)
for($i=0;$i -lt $ids.Count;$i++){foreach($p in $all){if($p.ParentProcessId -eq $ids[$i] -and -not $ids.Contains([int]$p.ProcessId)){$ids.Add([int]$p.ProcessId)}}}
$stopped=@(); for($i=$ids.Count-1;$i -ge 0;$i--){$p=$all|Where-Object{$_.ProcessId -eq $ids[$i]}; $now=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ids[$i]); if(-not $now){continue}
  $prefix=$c.allowedRoot.TrimEnd('\')+'\'
  if($now.CreationDate.ToString('o') -ne $p.CreationDate.ToString('o') -or (-not $now.ExecutablePath) -or ($now.ExecutablePath -ine $c.exe -and -not $now.ExecutablePath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase))){throw 'Owned process tree path/identity changed'}
  Stop-Process -Id $ids[$i] -Force -ErrorAction Stop; $stopped+=$ids[$i]
}; @{stopped=$stopped}|ConvertTo-Json -Compress`, { ...owned, allowedRoot })
}

async function runExe(shell, file, args, locations, label, verbatim = false) {
  assertNoLinks(file)
  const stdout = fs.openSync(path.join(locations.logs, `${label}.stdout.log`), 'wx')
  const stderr = fs.openSync(path.join(locations.logs, `${label}.stderr.log`), 'wx')
  const child = spawn(file, args, { shell: false, windowsHide: true, windowsVerbatimArguments: verbatim, cwd: locations.root,
    env: cleanEnv(locations), stdio: ['ignore', stdout, stderr] })
  fs.closeSync(stdout); fs.closeSync(stderr)
  let owned
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try {
        if (owned) stopExactTree(shell, owned, locations.root)
        reject(new Error(`${label} timed out; exact owned PID tree stopped when identity was provable; evidence retained`))
      } catch (error) { reject(new Error(`${label} timeout cleanup refused unsafe PID: ${error.message}`)) }
    }, 240_000)
    child.once('spawn', () => {
      try {
        owned = processInfo(shell, child.pid)
        if (owned) assert.equal(path.resolve(owned.exe).toLowerCase(), path.resolve(file).toLowerCase(), 'NSIS spawned executable mismatch')
      } catch (error) { clearTimeout(timeout); child.kill(); reject(error) }
    })
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, pid: child.pid }) })
  })
  assert.equal(result.code, 0, `${label} failed: ${JSON.stringify(result)}`)
  return result
}

function cleanEnv(locations) {
  const env = { ...process.env, TEMP: locations['process-temp'], TMP: locations['process-temp'] }
  for (const key of Object.keys(env)) if (/^(PRW_|ELECTRON_|NODE_OPTIONS$|OBSIDIAN_|ZOTERO_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|FEISHU_)/i.test(key)) delete env[key]
  // A packaged build must ignore this invalid development-only URL.
  env.ELECTRON_RENDERER_URL = 'https://127.0.0.1:1/must-not-load'
  return env
}

function checkReparseTree(shell, target) {
  powershell(shell, String.raw`
if(-not(Test-Path -LiteralPath $c.path)) {throw 'Owned path missing'}
$queue=New-Object 'System.Collections.Generic.Queue[string]'; $queue.Enqueue($c.path); $n=0
while($queue.Count -gt 0) {$dir=$queue.Dequeue(); $n++; if($n -gt 100000){throw 'Path inspection bound exceeded'}
  $entry=Get-Item -Force -LiteralPath $dir; if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Owned path is a reparse point'}
  if($entry.PSIsContainer) {foreach($item in Get-ChildItem -Force -LiteralPath $dir) {if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Owned tree contains a reparse point'}; if($item.PSIsContainer){$queue.Enqueue($item.FullName)}}}
}; @{checked=$n} | ConvertTo-Json -Compress`, { path: target })
}

function processInfo(shell, pid) {
  return powershell(shell, String.raw`$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$c.pid); if($p){@{pid=[int]$p.ProcessId;exe=[string]$p.ExecutablePath;created=$p.CreationDate.ToString('o');command=[string]$p.CommandLine}|ConvertTo-Json -Compress}else{'null'}`, { pid })
}

async function stopOwned(shell, owned, browser, evidence) {
  if (!owned) return
  try {
    if (browser) {
      try {
        const session = await browser.newBrowserCDPSession()
        await session.send('Browser.close')
      } catch { /* An unavailable CDP endpoint must not skip exact owned-PID cleanup. */ }
      await browser.close().catch(() => {})
    }
    for (let i = 0; i < 100 && processInfo(shell, owned.pid); i++) await sleep(100)
    const current = processInfo(shell, owned.pid)
    if (current) {
      assert.equal(current.exe.toLowerCase(), owned.exe.toLowerCase(), 'PID reused by another executable; refusing stop')
      assert.equal(current.created, owned.created, 'PID creation identity changed; refusing stop')
      powershell(shell, String.raw`
$all=@(Get-CimInstance Win32_Process); $root=$all | Where-Object {$_.ProcessId -eq [int]$c.pid}
if(-not $root){@{stopped=@()}|ConvertTo-Json -Compress;exit}
if($root.ExecutablePath -ine $c.exe -or $root.CreationDate.ToString('o') -ne $c.created){throw 'PID identity changed'}
$ids=New-Object 'System.Collections.Generic.List[int]'; $ids.Add([int]$root.ProcessId)
for($i=0;$i -lt $ids.Count;$i++){foreach($p in $all){if($p.ParentProcessId -eq $ids[$i] -and -not $ids.Contains([int]$p.ProcessId)){$ids.Add([int]$p.ProcessId)}}}
$stopped=@(); for($i=$ids.Count-1;$i -ge 0;$i--){$p=$all|Where-Object{$_.ProcessId -eq $ids[$i]}; $now=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ids[$i]); if(-not $now){continue}
  if($now.CreationDate.ToString('o') -ne $p.CreationDate.ToString('o') -or $now.ExecutablePath -ine $c.exe){throw 'Owned tree PID identity/path changed'}
  Stop-Process -Id $ids[$i] -Force -ErrorAction Stop; $stopped+=$ids[$i]
}; @{stopped=$stopped}|ConvertTo-Json -Compress`, owned)
      evidence.forcedOwnedPidStop = true
    }
    for (let i = 0; i < 100 && processInfo(shell, owned.pid); i++) await sleep(100)
    assert.equal(processInfo(shell, owned.pid), null, 'Owned process did not exit')
    assert.equal(snapshot(shell).processes.length, 0, 'Product child process remains after owned close')
  } finally { if (browser) await browser.close().catch(() => {}) }
}

async function launchInstalled(shell, locations, evidence, label, create, fixture) {
  const executable = path.join(locations.install, EXE)
  assertNoLinks(executable); checkReparseTree(shell, locations.profile)
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve) })
  const port = server.address().port
  const endpoint = `http://127.0.0.1:${port}`
  await new Promise((resolve) => server.close(resolve))
  const out = fs.openSync(path.join(locations.logs, `${label}.stdout.log`), 'wx')
  const err = fs.openSync(path.join(locations.logs, `${label}.stderr.log`), 'wx')
  const child = spawn(executable, [`--prw-user-data-dir=${locations.profile}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`], {
    shell: false, windowsHide: true, cwd: locations.profile, env: cleanEnv(locations), stdio: ['ignore', out, err]
  })
  fs.closeSync(out); fs.closeSync(err)
  let startupError
  child.on('error', (error) => { startupError = error })
  let owned
  let browser
  try {
    for (let i = 0; i < 100 && !owned; i++) { if (startupError) throw startupError; owned = processInfo(shell, child.pid); if (!owned) await sleep(100) }
    assert(owned, 'Installed executable did not start')
    assert.equal(path.resolve(owned.exe).toLowerCase(), executable.toLowerCase(), 'Launched process is not the installed executable')
    assert(owned.command.includes(`--prw-user-data-dir=${locations.profile}`), 'Owned process lacks explicit isolated profile')
    // Verify Windows owns this loopback listener with the exact process; reject port races.
    let listening = false
    for (let i = 0; i < 120 && !listening; i++) {
      if (startupError) throw startupError
      assert(processInfo(shell, child.pid), 'Installed process exited during CDP startup')
      listening = powershell(shell, String.raw`$found=@(Get-NetTCPConnection -State Listen -LocalPort ([int]$c.port) -ErrorAction SilentlyContinue); if($found.Count){foreach($entry in $found){if($entry.OwningProcess -ne [int]$c.pid -or $entry.LocalAddress -ne '127.0.0.1'){throw 'CDP listener ownership/address mismatch'}}}; @{ready=($found.Count -gt 0)}|ConvertTo-Json -Compress`, { pid: child.pid, port }).ready
      if (!listening) await sleep(250)
    }
    assert(listening, 'Installed release did not expose its owned loopback Renderer CDP endpoint')
    const { chromium } = require('playwright-core')
    browser = await chromium.connectOverCDP(endpoint, { timeout: 30_000 })
    const context = browser.contexts()[0]
    assert(context, 'Installed Renderer browser context missing')
    let page
    for (let i = 0; i < 120 && !page; i++) { page = context.pages().find((item) => item.url().startsWith('workbench://app/')); if (!page) await sleep(250) }
    assert(page, 'Installed app did not load workbench://app')
    page.setDefaultTimeout(30_000)
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.waitForFunction(() => Boolean(window.workbench?.v2?.system?.health))
    const identity = await page.evaluate(async () => ({
      origin: location.origin, url: location.href,
      isolation: { process: typeof process, require: typeof require, ipc: typeof window.ipcRenderer, electron: typeof window.electron },
      health: await window.workbench.v2.system.health(), updates: await window.workbench.v2.updates.state(), status: await window.workbench.v2.workspace.status()
    }))
    assert.equal(identity.origin, 'workbench://app')
    assert.deepEqual(identity.isolation, { process: 'undefined', require: 'undefined', ipc: 'undefined', electron: 'undefined' })
    assert.equal(identity.health.version, evidence.version)
    assert.equal(identity.updates.currentVersion, evidence.version)
    assert.equal(identity.status.version, evidence.version)
    assert.equal(identity.status.database, 'ready')
    if (create) {
      fixture = await page.evaluate(async () => {
        const project = await window.workbench.v2.projects.create({ name: 'Installed smoke project', description: 'Synthetic release smoke only' })
        const task = await window.workbench.v2.tasks.create({ title: 'Installed smoke persisted task', projectId: project.id })
        const moved = await window.workbench.v2.tasks.move({ taskId: task.id, columnId: 'status:in_progress', targetIndex: 0, expectedRevision: task.revision })
        return { project, task: moved }
      })
      assert.equal(fixture.task.status, 'in_progress')
    } else {
      const persisted = await page.evaluate(async (fixture) => ({
        project: (await window.workbench.v2.projects.list()).find((item) => item.id === fixture.project.id),
        task: (await window.workbench.v2.tasks.list({ projectId: fixture.project.id })).find((item) => item.id === fixture.task.id)
      }), fixture)
      assert.deepEqual(persisted.project, fixture.project, 'Project changed/lost across restart/reinstall')
      assert.deepEqual(persisted.task, fixture.task, 'Task changed/lost across restart/reinstall')
    }
    await page.screenshot({ path: path.join(locations.logs, `${label}.png`) })
    assert.deepEqual(pageErrors, [], 'Installed Renderer errors')
    evidence.launches.push({ label, pid: owned.pid, executable, identity, cdp: { host: '127.0.0.1', port, ownerVerified: true } })
    return fixture
  } finally { await stopOwned(shell, owned, browser, evidence) }
}

function readDatabase(database, fixture) {
  assertNoLinks(database)
  assert(fs.existsSync(database), 'Installed profile database missing')
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const migration = db.prepare('SELECT MAX(id) AS id, COUNT(*) AS count FROM _prw_migrations').get()
    assert.equal(migration.id, EXPECTED_MIGRATION, 'Unexpected installed migration version')
    assert.equal(migration.count, EXPECTED_MIGRATION, 'Missing installed migrations')
    const integrity = db.prepare('PRAGMA integrity_check').all()
    assert.deepEqual(integrity.map((row) => row.integrity_check), ['ok'])
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    const project = db.prepare('SELECT id,name,revision FROM projects WHERE id=?').get(fixture.project.id)
    const task = db.prepare('SELECT id,title,status,revision FROM tasks WHERE id=?').get(fixture.task.id)
    assert.equal(project.name, fixture.project.name)
    assert.equal(task.title, fixture.task.title)
    assert.equal(task.status, 'in_progress')
    assert.equal(task.revision, fixture.task.revision)
    for (const table of ['agent_mcp_servers', 'agent_instruction_skills', 'agent_mcp_calls']) assert(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), `Missing migration39 table: ${table}`)
    return { migration: { ...migration }, integrity: 'ok', foreignKeys: 'ok', project: { ...project }, task: { ...task } }
  } finally { db.close() }
}

function makeV38Fixture(database, locations) {
  const { DatabaseSync } = require('node:sqlite')
  const copy = assertFreshOwnedPath(locations.root, path.join(locations.staging, 'before-v38-reconstruction.sqlite3'))
  fs.copyFileSync(database, copy, fs.constants.COPYFILE_EXCL)
  const db = new DatabaseSync(database)
  try {
    assert.equal(db.prepare('SELECT MAX(id) AS id FROM _prw_migrations').get().id, EXPECTED_MIGRATION)
    for (const table of ['agent_mcp_servers', 'agent_instruction_skills', 'agent_mcp_calls']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, 'Migration fixture may remove only empty new tables')
    db.exec('BEGIN IMMEDIATE; DROP TABLE agent_mcp_calls; DROP TABLE agent_mcp_servers; DROP TABLE agent_instruction_skills; DELETE FROM _prw_migrations WHERE id=39; COMMIT;')
    assert.equal(db.prepare('SELECT MAX(id) AS id FROM _prw_migrations').get().id, 38)
    assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check), ['ok'])
  } finally { db.close() }
  return { kind: 'Synthetic reconstruction of v38 schema from this isolated empty-resource profile; NOT a previous-version installer upgrade', backupSha256: sha(copy), maxMigrationBefore: 38 }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  assert.equal(process.platform, 'win32', 'Installed NSIS smoke is Windows-only')
  assert.equal(process.arch, 'x64', 'Installed NSIS smoke requires Windows x64 Node')
  for (const key of ['PRW_E2E_USER_DATA', 'PRW_RELEASE_INSTALL_DIR', 'PRW_RELEASE_PROFILE']) assert(!process.env[key], `Unsafe external path override: ${key}`)
  const attestation = verifyAttestation(options.setup, options.version)
  const shell = selectPowerShell()
  const before = snapshot(shell)
  assertBaseline(before)
  const protectedBefore = fingerprintProtected(shell, before)
  const metadata = powershell(shell, String.raw`$item=Get-Item -LiteralPath $c.path; $s=Get-AuthenticodeSignature -LiteralPath $c.path; @{productVersion=$item.VersionInfo.ProductVersion;signature=[string]$s.Status;signer=if($s.SignerCertificate){$s.SignerCertificate.Subject}else{$null};size=$item.Length}|ConvertTo-Json -Compress`, { path: options.setup })
  assert.equal(metadata.productVersion, options.version, 'Setup ProductVersion mismatch')
  const locations = createSandbox()
  const evidence = { schemaVersion: 1, status: 'RUNNING', version: options.version, startedAt: new Date().toISOString(), locations, attestation, metadata, before, protectedBefore, protectedChecks: [], launches: [], gates: {},
    scope: 'Actual unmodified NSIS install + Renderer CDP smoke, restart, same-version reinstall, synthetic v38-to-v39 DB migration, uninstall. Not an old-installer upgrade or clean-VM/signing approval.',
    packagedProof: 'Combination: exact installed PE path/fuses, app.asar, trusted workbench://app, typed Main updates.currentVersion (app.getVersion), Core health/version and isolated SQLite. Main app.isPackaged is not directly inspected because release Main inspector is disabled.' }
  const evidenceFile = path.join(locations.logs, 'installed-release-evidence.json')
  const persist = () => fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2))
  const protect = (stage) => {
    const fingerprints = fingerprintProtected(shell, before)
    evidence.protectedChecks.push({ stage, fingerprints })
    assertProtectedUnchanged(protectedBefore, fingerprints)
    persist()
  }
  persist()
  console.log(`Evidence retained: ${evidenceFile}`)
  try {
    checkReparseTree(shell, locations.root)
    if (options.dryRun) {
      protect('dry-run')
      evidence.status = 'DRY_RUN_ONLY'
      evidence.gates.preflight = 'PASS; no installer/application executed'
      console.log('Installed smoke preflight PASS; no install/restart/uninstall acceptance claimed')
      return
    }
    // Re-check immediately before invoking NSIS; never reuse a stale clean baseline.
    assertBaseline(snapshot(shell))
    protect('before-install')
    assertFreshOwnedPath(locations.root, locations.install)
    evidence.gates.install = await runExe(shell, options.setup, installerArgs(locations.install), locations, 'install', true)
    protect('after-install')
    checkReparseTree(shell, locations.install)
    const executable = path.join(locations.install, EXE)
    assert(fs.statSync(executable).isFile(), 'Installed executable missing')
    assert(fs.statSync(path.join(locations.install, 'resources', 'app.asar')).isFile(), 'Installed app.asar missing')
    evidence.fuses = readFuses(executable)
    assertInstalledState(snapshot(shell), locations.install)
    const fixture = await launchInstalled(shell, locations, evidence, 'first-start', true)
    protect('after-first-start')
    evidence.fixture = fixture
    const database = path.join(locations.profile, 'data', 'workspace.sqlite3')
    evidence.gates.firstDatabase = readDatabase(database, fixture)
    await launchInstalled(shell, locations, evidence, 'restart', false, fixture)
    protect('after-restart')
    evidence.gates.restartDatabase = readDatabase(database, fixture)
    assertInstalledState(snapshot(shell), locations.install)
    checkReparseTree(shell, locations.install)
    checkReparseTree(shell, locations.profile)
    const beforeReinstall = sha(database)
    protect('before-reinstall')
    evidence.gates.sameVersionReinstall = await runExe(shell, options.setup, installerArgs(locations.install), locations, 'same-version-reinstall', true)
    protect('after-reinstall')
    assert.equal(sha(database), beforeReinstall, 'Same-version reinstall changed profile database bytes')
    checkReparseTree(shell, locations.install)
    evidence.reinstalledFuses = readFuses(executable)
    assertInstalledState(snapshot(shell), locations.install)
    await launchInstalled(shell, locations, evidence, 'after-reinstall', false, fixture)
    protect('after-reinstalled-start')
    evidence.gates.reinstallDatabase = readDatabase(database, fixture)
    checkReparseTree(shell, locations.profile)
    evidence.gates.migration38to39 = makeV38Fixture(database, locations)
    protect('after-synthetic-migration-fixture')
    await launchInstalled(shell, locations, evidence, 'v38-fixture-migration', false, fixture)
    protect('after-migration-start')
    evidence.gates.migration38to39.after = readDatabase(database, fixture)
    assertInstalledState(snapshot(shell), locations.install)
    checkReparseTree(shell, locations.install)
    const uninstallers = fs.readdirSync(locations.install).filter((name) => /^Uninstall .*\.exe$/i.test(name))
    assert.equal(uninstallers.length, 1, 'Expected one owned uninstaller')
    const uninstaller = path.join(locations.install, uninstallers[0])
    protect('before-uninstall')
    evidence.gates.uninstall = await runExe(shell, uninstaller, ['/S', '/currentuser', `_?=${locations.install}`], locations, 'uninstall', true)
    protect('after-uninstall')
    for (let i = 0; i < 100 && fs.existsSync(executable); i++) await sleep(100)
    assert(!fs.existsSync(executable), 'Uninstall left the installed executable')
    const after = snapshot(shell)
    evidence.after = after
    assert.equal(after.processes.length, 0, 'Uninstall left a product process')
    assert.deepEqual(after.registrations, before.registrations, 'Uninstall failed to restore product registration baseline')
    assert.deepEqual(after.shortcuts, before.shortcuts, 'Uninstall failed to restore shortcut baseline')
    const cache = path.join(before.localAppData, UPDATER_CACHE).toLowerCase()
    assert(after.existing.every((entry) => entry.path.toLowerCase() === cache), 'A default profile/default install appeared')
    evidence.retainedOwnInstallerCaches = after.existing
    evidence.gates.retainedProfile = readDatabase(database, fixture)
    evidence.remainingInstallEntries = fs.existsSync(locations.install) ? fs.readdirSync(locations.install) : []
    evidence.status = 'PASS'
    console.log('Installed release smoke PASS: install, trusted isolated start, restart, same-version reinstall, synthetic migration39, uninstall; all evidence retained')
  } catch (error) {
    evidence.status = 'FAIL'
    evidence.error = error.stack || String(error)
    try { evidence.stateAtFailure = snapshot(shell) } catch (inspectionError) { evidence.stateInspectionError = inspectionError.message }
    try { protect('failure') } catch (inspectionError) { evidence.protectedInspectionError = inspectionError.message }
    throw error
  } finally {
    try { protect('final') } catch (error) {
      evidence.status = 'FAIL'
      evidence.protectedInspectionError = error.message
      throw error
    } finally {
      evidence.finishedAt = new Date().toISOString()
      persist()
    }
  }
}

module.exports = { parseArgs, contained, assertNoLinks, assertFreshOwnedPath, assertBaseline, assertInstalledState, verifyAttestation, installerArgs, readFuses, uuidV5, SNAPSHOT_PS, PROTECTED_PS, selectPowerShell, powershell, snapshot, fingerprintTrees, fingerprintProtected, assertProtectedUnchanged, main }
if (require.main === module) main().catch((error) => { console.error(error.stack || error); process.exitCode = 1 })
