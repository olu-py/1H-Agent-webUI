# One-click Windows start script for the 1H-Agent WebUI.
#
# Builds whatever is stale (frontend web/dist first, then the Rust binary that
# embeds it), starts the server on a free loopback port, waits until it is up,
# and opens the browser. Ctrl+C stops the server.
#
# Idempotent: if a live instance is already running for this mode (the core
# takes an exclusive per-workspace lock), the script detects it and simply
# opens the browser to the running URL - re-running is safe. -Restart
# overrides the reuse: it stops that instance and swaps in a freshly built
# one (build first, so a broken build never takes the old one down). On
# Windows a rebuild that must relink the exe cannot replace the running
# process's binary; in that case (and only then) the instance is stopped
# once the build is otherwise complete and the link is retried.
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
#   .\scripts\start-web.ps1 -Restart       # stop a running instance of this
#                                          # mode, rebuild what is stale,
#                                          # start again (same port when
#                                          # possible)
#   .\scripts\start-web.ps1 -Workspace D:\work  # formal workspace override

param(
    [ValidateSet("demo", "formal")]
    [string]$Mode = "demo",
    [int]$Port = 7788,
    [switch]$Daemon,
    [switch]$NoOpen,
    [switch]$SkipBuild,
    [switch]$Restart,
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

function Test-ExeLocked {
    # True when a process still holds the binary image: Windows maps a running
    # exe without write sharing, which is exactly why cargo's link step cannot
    # replace target\debug\1h-agent-web.exe while the server runs (os error 5).
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $false }
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        $fs.Close()
        return $false
    } catch {
        return $true
    }
}

function Get-InstancePids {
    # Pids of a previous instance of THIS mode: the pid recorded in server.pid
    # (only when it really is our binary - pids get reused) plus every
    # 1h-agent-web process whose --workspace argument equals this mode's
    # workspace (covers a lost/stale pid file; the exact-argument match never
    # touches another mode's instance, and works even when the server is hung
    # and no longer answers HTTP).
    $targets = @{}
    if (Test-Path $PidFile) {
        $oldPid = Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($oldPid) {
            $p = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
            if ($p -and $p.ProcessName -eq "1h-agent-web") { $targets[[int]$oldPid] = $true }
        }
    }
    $ws = $WorkspaceDir.TrimEnd('\').ToLowerInvariant()
    foreach ($p in Get-CimInstance Win32_Process -Filter "Name = '1h-agent-web.exe'" -ErrorAction SilentlyContinue) {
        $wsArg = $null
        if ($p.CommandLine -match '--workspace\s+"([^"]+)"') { $wsArg = $Matches[1] }
        elseif ($p.CommandLine -match '--workspace\s+([^\s"]+)') { $wsArg = $Matches[1] }
        if ($wsArg -and $wsArg.TrimEnd('\').ToLowerInvariant() -eq $ws) {
            $targets[[int]$p.ProcessId] = $true
        }
    }
    return @($targets.Keys)
}

function Stop-InstancePids {
    param([int[]]$Ids)
    foreach ($id in $Ids) {
        Write-Host "== stopping previous instance (pid $id) =="
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $id -Timeout 15 -ErrorAction SilentlyContinue
        if (Get-Process -Id $id -ErrorAction SilentlyContinue) {
            throw "previous instance (pid $id) did not stop within 15s - kill it manually, then re-run"
        }
    }
}

function Stop-RunningInstance {
    # Stop a previous instance of THIS mode and return the port recorded in
    # server.url (if any) so the caller can prefer it; the port is returned
    # even when the instance is already gone (e.g. stopped early because it
    # held the exe lock during the build), so the swap keeps the same address.
    $oldPort = $null
    if (Test-Path $UrlFile) {
        $oldUrl = Get-Content $UrlFile -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($oldUrl -and $oldUrl -match ':(\d+)/?\s*$') { $oldPort = [int]$Matches[1] }
    }
    $targets = Get-InstancePids
    Remove-Item $PidFile, $UrlFile -ErrorAction SilentlyContinue
    if ($targets.Count -eq 0) {
        Write-Host "== no previous $Mode instance running - starting fresh =="
        return $oldPort
    }
    Stop-InstancePids $targets
    return $oldPort
}

# ---- 0. idempotent relaunch (or restart) --------------------------------------
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
if ($Restart) {
    # the actual stop happens below, AFTER the build, so a broken build never
    # takes the running instance down
    Write-Host "== restart requested ($Mode): rebuild stale artifacts, then swap the instance =="
} elseif ($Running = Get-CurrentUrl) {
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
            if ($LASTEXITCODE -ne 0 -and $Restart -and (Test-ExeLocked $Bin)) {
                # Windows: the link step replaces target\debug\1h-agent-web.exe,
                # which a still-running previous instance keeps locked
                # ("failed to remove file ... os error 5"). Retry once with the
                # output captured to files so a genuine compile error (which
                # must leave the old instance alone) can be told apart from
                # that lock failure.
                $outLog = Join-Path $StateDir "cargo-build.out.log"
                $errLog = Join-Path $StateDir "cargo-build.err.log"
                $p = Start-Process -FilePath "cargo" -ArgumentList @("build", "-p", "protium-web") `
                        -WorkingDirectory $Root -NoNewWindow -PassThru -Wait `
                        -RedirectStandardOutput $outLog -RedirectStandardError $errLog
                if ($p.ExitCode -ne 0) {
                    $logText = ""
                    foreach ($f in @($outLog, $errLog)) {
                        if (Test-Path $f) { $logText += [System.IO.File]::ReadAllText($f) }
                    }
                    if ($logText.Contains("failed to remove file") -and (Get-InstancePids).Count -gt 0) {
                        Write-Host "== exe is locked by the previous instance - stopping it, then relinking =="
                        Stop-InstancePids (Get-InstancePids)
                        & cargo build -p protium-web
                    }
                    if ($LASTEXITCODE -ne 0) { throw "cargo build failed (exit $LASTEXITCODE)" }
                }
            } elseif ($LASTEXITCODE -ne 0) {
                throw "cargo build failed (exit $LASTEXITCODE)"
            }
        } finally { Pop-Location }
    }
}
if (-not (Test-Path $Bin)) {
    throw "no binary at $Bin - run: (cd $Root; cargo build -p protium-web)"
}

# ---- 1.5 restart: stop the previous instance, prefer its port ------------------
if ($Restart) {
    $oldPort = Stop-RunningInstance
    if ($oldPort -and -not $PSBoundParameters.ContainsKey('Port')) {
        # keep the address the browser already has; the free-port scan below
        # moves on if something else grabbed it in the meantime
        $Port = $oldPort
    }
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
$exited = $false
for ($i = 0; $i -lt 60; $i++) {
    if ($proc.HasExited) { $exited = $true; break }
    if (Test-LiveApp $Url) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
}
if (-not $ready) {
    if ($exited) {
        Write-Host "ERROR: server exited during startup (exit code $($proc.ExitCode))" -ForegroundColor Red
    } else {
        Write-Host "ERROR: server did not become ready" -ForegroundColor Red
        if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    }
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
