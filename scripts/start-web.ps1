# One-click Windows start script for the 1H-Agent WebUI.
#
# Builds whatever is stale (frontend web/dist first, then the Rust binary that
# embeds it), starts the server on a free loopback port, waits until it is up,
# and opens the browser. Ctrl+C stops the server.
#
# Idempotent: if a live instance is already running for this mode (the core
# takes an exclusive per-workspace lock), the script detects it and simply
# opens the browser to the running URL - re-running is safe.
#
# Modes:
#   demo   - isolated data under .1h-agent-data/demo; no API key needed to
#            browse the UI / create / fork sessions / use the command palette.
#            Only real model calls fail until OPENAI_API_KEY (or another
#            provider key) is exported.
#   formal - workspace defaults to the repository root (override with
#            -Workspace); data uses the core default location
#            (%LOCALAPPDATA%\1h-agent) and config is read from
#            %APPDATA%\1h-agent\config.toml when present.
#
# Usage:
#   .\scripts\start-web.ps1                # demo mode
#   .\scripts\start-web.ps1 -Mode formal   # formal mode
#   .\scripts\start-web.ps1 -Port 9000     # fixed port
#   .\scripts\start-web.ps1 -Daemon        # background + print PID
#   .\scripts\start-web.ps1 -NoOpen        # do not open the browser
#   .\scripts\start-web.ps1 -SkipBuild     # reuse existing artifacts as-is
#   .\scripts\start-web.ps1 -Workspace D:\work  # formal workspace override

param(
    [ValidateSet("demo", "formal")]
    [string]$Mode = "demo",
    [int]$Port = 7788,
    [switch]$Daemon,
    [switch]$NoOpen,
    [switch]$SkipBuild,
    [string]$Workspace = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Bin = Join-Path $Root "target\debug\1h-agent-web.exe"
$DistHtml = Join-Path $Root "web\dist\index.html"

# ---- mode-specific state / workspace / data dirs ---------------------------
if ($Mode -eq "demo") {
    $StateDir = Join-Path $Root ".1h-agent-data\demo"
    $WorkspaceDir = Join-Path $StateDir "workspace"
    $DataDir = Join-Path $StateDir "data"
    $env:AGENT_DATA_DIR = $DataDir        # isolate demo state
} else {
    $StateDir = Join-Path $Root ".1h-agent-data\formal"
    $WorkspaceDir = if ($Workspace) { $Workspace } else { $Root }
    $DataDir = $null                      # core default: %LOCALAPPDATA%\1h-agent
    # clear a leftover from an earlier -Mode demo run in the same session
    Remove-Item Env:AGENT_DATA_DIR -ErrorAction SilentlyContinue
}
$PidFile = Join-Path $StateDir "server.pid"
$UrlFile = Join-Path $StateDir "server.url"
$LogFile = Join-Path $StateDir "server.log"
$ErrLogFile = Join-Path $StateDir "server.err.log"

# ---- helpers ----------------------------------------------------------------
function Test-LiveApp {
    # True when the URL answers our v2 API (we are not fooled by a random
    # service on that port).
    param([string]$Url)
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "$Url/api/v2/state" -TimeoutSec 3
        return ($r.StatusCode -eq 200 -and $r.Content -match '"protocol_version"\s*:\s*2')
    } catch { return $false }
}

function Test-Stale {
    # True when Target is missing or any Source (file or dir, recursed) is newer.
    param([string]$Target, [string[]]$Sources)
    if (-not (Test-Path $Target)) { return $true }
    $t = (Get-Item $Target).LastWriteTimeUtc
    foreach ($s in $Sources) {
        if (-not (Test-Path $s)) { continue }
        $item = Get-Item $s
        if ($item.PSIsContainer) {
            $newest = Get-ChildItem $s -Recurse -File -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
            if ($newest -and $newest.LastWriteTimeUtc -gt $t) { return $true }
        } elseif ($item.LastWriteTimeUtc -gt $t) { return $true }
    }
    return $false
}

function Get-FreePort {
    param([int]$Start)
    for ($p = $Start; $p -le 65535; $p++) {
        $l = $null
        try {
            $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $p)
            $l.Start()
            return $p
        } catch { }
        finally { if ($l) { $l.Stop() } }
    }
    throw "no free port in $Start..65535"
}

function Get-CurrentUrl {
    # Prefer the recorded URL of a still-live instance; fall back to probing
    # the requested port (which may be a different mode's instance).
    if (Test-Path $PidFile) {
        $oldPid = Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
            if (Test-Path $UrlFile) {
                $oldUrl = Get-Content $UrlFile -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($oldUrl -and (Test-LiveApp $oldUrl)) { return $oldUrl }
            }
        } else {
            # stale records (a previous instance exited); drop them
            Remove-Item $PidFile, $UrlFile -ErrorAction SilentlyContinue
        }
    }
    $probeUrl = "http://127.0.0.1:$Port"
    if (Test-LiveApp $probeUrl) { return $probeUrl }
    return $null
}

# ---- 0. idempotent relaunch --------------------------------------------------
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
if ($Running = Get-CurrentUrl) {
    Write-Host "== 1H-Agent already running at $Running ($Mode) - reusing =="
    if (-not $NoOpen) { Start-Process $Running }
    Write-Host "== ready: $Running =="
    exit 0
}

# ---- 1. build whatever is stale (frontend, then the embedding binary) --------
if (-not $SkipBuild) {
    if (-not (Test-Path (Join-Path $Root "web\node_modules\.bin"))) {
        Write-Host "== installing frontend deps =="
        Push-Location (Join-Path $Root "web")
        try {
            & pnpm install --frozen-lockfile
            if ($LASTEXITCODE -ne 0) { throw "pnpm install failed (exit $LASTEXITCODE)" }
        } finally { Pop-Location }
    }
    $webSources = @(
        (Join-Path $Root "web\src"),
        (Join-Path $Root "web\ts"),
        (Join-Path $Root "web\package.json"),
        (Join-Path $Root "web\vite.config.ts"),
        (Join-Path $Root "web\tsconfig.app.json")
    )
    if (Test-Stale -Target $DistHtml -Sources $webSources) {
        Write-Host "== rebuilding frontend (web/dist) =="
        Push-Location (Join-Path $Root "web")
        try {
            & pnpm build
            if ($LASTEXITCODE -ne 0) { throw "pnpm build failed (exit $LASTEXITCODE)" }
        } finally { Pop-Location }
    }
    if (-not (Test-Path $Bin) -or (Test-Stale -Target $Bin -Sources @($DistHtml))) {
        Write-Host "== building 1h-agent-web (embeds web/dist) =="
        Push-Location $Root
        try {
            & cargo build -p protium-web
            if ($LASTEXITCODE -ne 0) { throw "cargo build failed (exit $LASTEXITCODE)" }
        } finally { Pop-Location }
    }
}
if (-not (Test-Path $Bin)) {
    throw "no binary at $Bin - run: (cd $Root; cargo build -p protium-web)"
}

# ---- 2. workspace + free port ------------------------------------------------
New-Item -ItemType Directory -Force -Path $WorkspaceDir | Out-Null
if (-not (Test-Path $WorkspaceDir)) { throw "workspace does not exist: $WorkspaceDir" }

$FinalPort = Get-FreePort -Start $Port
if ($FinalPort -ne $Port) { Write-Host "port $Port is busy, using $FinalPort" }
$Url = "http://127.0.0.1:$FinalPort"

# ---- 3. start ----------------------------------------------------------------
$DataLabel = if ($Mode -eq "demo") { $DataDir } else { "(default: %LOCALAPPDATA%\1h-agent)" }
Write-Host "== starting 1H-Agent WebUI ($Mode) =="
Write-Host "   workspace : $WorkspaceDir"
Write-Host "   data dir  : $DataLabel"
Write-Host "   url       : $Url"
if ($Mode -eq "demo") {
    Write-Host "   (demo: no API key needed to browse; set OPENAI_API_KEY for real conversations)"
}

$argList = @("--workspace", "`"$WorkspaceDir`"", "--port", "$FinalPort")

if ($Daemon) {
    # Own console so it survives the launcher window closing. In an interactive
    # desktop session the hidden/extra console window is fine; in a headless
    # (non-interactive) session console creation can fail - use the foreground
    # mode there instead.
    $proc = Start-Process -FilePath $Bin -ArgumentList $argList -PassThru `
        -WindowStyle Hidden -RedirectStandardOutput $LogFile -RedirectStandardError $ErrLogFile
} else {
    # share the launcher console so Ctrl+C reaches the server too
    $proc = Start-Process -FilePath $Bin -ArgumentList $argList -PassThru -NoNewWindow `
        -RedirectStandardOutput $LogFile -RedirectStandardError $ErrLogFile
}
Set-Content -Path $PidFile -Value $proc.Id
Set-Content -Path $UrlFile -Value $Url

# ---- 4. wait for readiness, then open the browser -----------------------------
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    if (Test-LiveApp $Url) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
}
if (-not $ready) {
    Write-Host "ERROR: server did not become ready" -ForegroundColor Red
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    if (Test-Path $ErrLogFile) { Get-Content $ErrLogFile -Tail 20 }
    exit 1
}

Write-Host "== ready: $Url =="
if (-not $NoOpen) { Start-Process $Url }

if ($Daemon) {
    Write-Host "   started in background, pid $($proc.Id)"
    Write-Host "   log  : $LogFile"
    Write-Host "   stop : Stop-Process -Id $($proc.Id)"
} else {
    Write-Host "press Ctrl+C to stop"
    try {
        Wait-Process -Id $proc.Id -ErrorAction SilentlyContinue
    } finally {
        if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    }
}
