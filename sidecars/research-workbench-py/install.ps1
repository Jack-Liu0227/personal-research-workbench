<#
  科研工作 1.0 安装器（Windows）
  ------------------------------------------------------------------
  给别人用（装到 %LOCALAPPDATA%、建桌面快捷方式、直接启动）：
      .\install.ps1 -Source https://<你的发布地址>/ResearchWorkbench.zip

  自己从本地打包目录装（开发时用）：
      .\install.ps1 -Source .\dist\ResearchWorkbench

  重复安装安全：数据目录 data/ 不覆盖，用户库/笔记都在。
  注意：本文件必须存成**带 BOM 的 UTF-8**。Windows PowerShell 5.1 按 GBK 读无 BOM 脚本，
        中文会把脚本解析崩，而且报错行号是假的（现象：复制、建快捷方式都执行了，最后一条才炸）。
#>
param(
    [string]$InstallRoot = "$env:LOCALAPPDATA\Programs\ResearchWorkbench",
    [string]$Source = ""
)
$ErrorActionPreference = "Stop"

# -Source 可以是本地目录，也可以是 zip 的下载地址；不传就报错退出。
# 刻意不设「默认仓库」：安装脚本一旦硬编码某个 GitHub 账号，对方改了 release
# 内容就等于改了你要装的东西（供应链风险）。这里只认调用者显式给的东西。
if (-not $Source) {
    throw "请用 -Source 指定安装包（本地目录或 zip 地址）。例：.\install.ps1 -Source .\dist\ResearchWorkbench"
}
if ($Source -match '^https?://') {
    $url = $Source
    $zip = Join-Path $env:TEMP "ResearchWorkbench.zip"
    $tmp = Join-Path $env:TEMP "rw-unpack"
    Write-Host "下载：$url"
    Invoke-WebRequest $url -OutFile $zip -UseBasicParsing
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive $zip -DestinationPath $tmp -Force
    $inner = Get-ChildItem $tmp -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName "ResearchWorkbench.exe") } |
        Select-Object -First 1
    $Source = if ($inner) { $inner.FullName } else { $tmp }
}

# 必须转成绝对路径：下面用 $Source.Length 截出相对路径，相对路径会把整套文件铺进一层多余目录
$Source = (Resolve-Path -LiteralPath $Source).Path
if (-not (Test-Path (Join-Path $Source "ResearchWorkbench.exe"))) {
    throw "包里没有 ResearchWorkbench.exe：$Source"
}

# 覆盖安装前先关掉旧进程，否则文件被占用
Get-Process ResearchWorkbench -ErrorAction SilentlyContinue | Stop-Process -Force

Write-Progress -Activity "科研工作 1.0 安装" -Status "复制到 $InstallRoot" -PercentComplete 10
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
$files = Get-ChildItem -Path $Source -Recurse -File
for ($i = 0; $i -lt $files.Count; $i++) {
    $relative = $files[$i].FullName.Substring($Source.Length).TrimStart('\')
    $target = Join-Path $InstallRoot $relative
    New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
    Copy-Item -LiteralPath $files[$i].FullName -Destination $target -Force
    Write-Progress -Activity "科研工作 1.0 安装" -Status $relative -PercentComplete (10 + [int](80 * ($i + 1) / $files.Count))
}

Write-Progress -Activity "科研工作 1.0 安装" -Status "创建桌面快捷方式" -PercentComplete 95
$exe = Join-Path $InstallRoot "ResearchWorkbench.exe"
if (-not (Test-Path $exe)) { throw "复制没成功，没找到：$exe" }
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) "科研工作 1.0.lnk"
$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnk)
$sc.TargetPath = $exe
$sc.WorkingDirectory = $InstallRoot
$sc.IconLocation = Join-Path $InstallRoot "build\icon.ico"
$sc.Description = "科研工作 1.0"
$sc.Save()
Write-Progress -Activity "科研工作 1.0 安装" -Completed

Write-Host ""
Write-Host "装好了：      $InstallRoot"
Write-Host "桌面快捷方式：$lnk"
Write-Host "第一次打开，在「模型」页里填自己的 API key。不填也能用界面，但生成类功能都不动。"
Start-Process -FilePath $exe -WorkingDirectory $InstallRoot
