param(
    [Parameter(Mandatory = $true)][string]$PresentMonPath,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9A-Fa-f]{64}$')][string]$ExpectedSha256,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [ValidateSet('msedge', 'WindowsTerminal')][string]$TargetProcess = 'msedge',
    [ValidateRange(0, 2147483647)][int]$TargetProcessId = 0,
    [int]$DurationSeconds = 60
)

$ErrorActionPreference = 'Stop'
$resolvedTool = (Resolve-Path -LiteralPath $PresentMonPath).Path
$toolHash = (Get-FileHash -LiteralPath $resolvedTool -Algorithm SHA256).Hash
if ($toolHash -ne $ExpectedSha256.ToUpperInvariant()) { throw "PresentMon SHA-256 mismatch: expected $ExpectedSha256, got $toolHash" }
$sessionId = (Get-Process -Id $PID).SessionId
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class ConsoleSession { [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId(); }'
$consoleSessionId = [ConsoleSession]::WTSGetActiveConsoleSessionId()
if ($sessionId -eq 0) { throw 'Run this collector from the signed-in interactive desktop session, not session 0.' }

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $OutputDirectory "$TargetProcess-$stamp"
New-Item -ItemType Directory -Path $out | Out-Null
$helpPath = Join-Path $out 'presentmon-help.txt'
$ErrorActionPreference = 'Continue'
try { & $resolvedTool --help *> $helpPath } finally { $ErrorActionPreference = 'Stop' }
$helpExitCode = $LASTEXITCODE
$helpText = [System.IO.File]::ReadAllText($helpPath)
if (-not $helpText.Contains($ExpectedVersion)) { throw "PresentMon version/help did not contain pinned version '$ExpectedVersion'; see $helpPath" }
if ($helpExitCode -notin @(0, 1) -or -not $helpText.Contains('--qpc_time')) { throw "PresentMon help was invalid (exit $helpExitCode)." }

$displaySource = @'
using System;
using System.Runtime.InteropServices;
public static class ActiveDisplayPaths {
  [StructLayout(LayoutKind.Sequential)] public struct Luid { public uint LowPart; public int HighPart; public override string ToString() { return HighPart.ToString("X8") + ":" + LowPart.ToString("X8"); } }
  [StructLayout(LayoutKind.Sequential)] public struct Header { public uint Type; public uint Size; public Luid AdapterId; public uint Id; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct SourceName { public Header header; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string name; }
  [StructLayout(LayoutKind.Sequential)] public struct Rational { public uint Numerator; public uint Denominator; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] public struct Region { public uint cx; public uint cy; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct TargetName { public Header header; public uint flags; public uint outputTechnology; public ushort edidManufactureId; public ushort edidProductCodeId; public uint connectorInstance; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string friendly; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string path; }
  [StructLayout(LayoutKind.Sequential)] public struct SourceInfo { public Luid adapter; public uint id; public uint mode; public uint status; }
  [StructLayout(LayoutKind.Sequential)] public struct TargetInfo { public Luid adapter; public uint id; public uint mode; public uint output; public uint rotation; public uint scaling; public Rational refresh; public uint scanline; public int available; public uint status; }
  [StructLayout(LayoutKind.Sequential)] public struct PathInfo { public SourceInfo source; public TargetInfo target; public uint flags; }
  [StructLayout(LayoutKind.Explicit, Size=48)] public struct ModeUnion { [FieldOffset(0)] public byte data; }
  [StructLayout(LayoutKind.Sequential)] public struct ModeInfo { public uint type; public uint id; public Luid adapter; public ModeUnion data; }
  [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint paths, out uint modes);
  [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint paths, [Out] PathInfo[] pathInfo, ref uint modes, [Out] ModeInfo[] modeInfo, IntPtr topology);
  [DllImport("user32.dll", EntryPoint="DisplayConfigGetDeviceInfo")] static extern int GetDeviceInfo(ref SourceName request);
  [DllImport("user32.dll", EntryPoint="DisplayConfigGetDeviceInfo")] static extern int GetDeviceInfo(ref TargetName request);
  public static object[] Read() {
    if(Marshal.SizeOf(typeof(TargetName))!=420 || Marshal.SizeOf(typeof(PathInfo))!=72 || Marshal.SizeOf(typeof(ModeInfo))!=64) throw new InvalidOperationException("DisplayConfig native ABI size mismatch.");
    uint pathCount, modeCount; int status=GetDisplayConfigBufferSizes(2, out pathCount, out modeCount); if(status!=0) throw new System.ComponentModel.Win32Exception(status);
    for(int attempt=0;attempt<3;attempt++) {
      var paths=new PathInfo[pathCount]; var modes=new ModeInfo[modeCount]; status=QueryDisplayConfig(2, ref pathCount, paths, ref modeCount, modes, IntPtr.Zero);
      if(status==122) { status=GetDisplayConfigBufferSizes(2,out pathCount,out modeCount); if(status!=0) throw new System.ComponentModel.Win32Exception(status); continue; }
      if(status!=0) throw new System.ComponentModel.Win32Exception(status);
      var output=new System.Collections.Generic.List<object>();
      for(int i=0;i<pathCount;i++) {
        var p=paths[i]; var s=new SourceName(); s.header.Type=1; s.header.Size=(uint)Marshal.SizeOf(typeof(SourceName)); s.header.AdapterId=p.source.adapter; s.header.Id=p.source.id;
        var t=new TargetName(); t.header.Type=2; t.header.Size=(uint)Marshal.SizeOf(typeof(TargetName)); t.header.AdapterId=p.target.adapter; t.header.Id=p.target.id;
        status=GetDeviceInfo(ref s); if(status!=0) throw new System.ComponentModel.Win32Exception(status); status=GetDeviceInfo(ref t); if(status!=0) throw new System.ComponentModel.Win32Exception(status);
        output.Add(new { source=s.name, target=t.friendly, devicePath=t.path, adapterLuid=p.target.adapter.ToString(), targetId=p.target.id, refreshNumerator=p.target.refresh.Numerator, refreshDenominator=p.target.refresh.Denominator, refreshHz=p.target.refresh.Denominator==0?0:(double)p.target.refresh.Numerator/p.target.refresh.Denominator, outputTechnology=p.target.output, rotation=p.target.rotation, scaling=p.target.scaling });
      }
      return output.ToArray();
    }
    throw new InvalidOperationException("Active display configuration kept changing during QueryDisplayConfig.");
  }
}
'@
Add-Type -TypeDefinition $displaySource
$display = [ActiveDisplayPaths]::Read()
[pscustomobject]@{
    capturedAt = (Get-Date).ToString('o')
    sessionId = $sessionId
    consoleSessionId = $consoleSessionId
    user = [Environment]::UserName
    computer = $env:COMPUTERNAME
    targetProcess = $TargetProcess
    targetProcessId = $TargetProcessId
    qpcFrequency = [Diagnostics.Stopwatch]::Frequency
    environmentQpc = [Diagnostics.Stopwatch]::GetTimestamp()
    durationSeconds = $DurationSeconds
    presentMonPath = $resolvedTool
    expectedPresentMonVersion = $ExpectedVersion
    expectedPresentMonSha256 = $ExpectedSha256.ToUpperInvariant()
    presentMonSha256 = $toolHash
    activeDisplayPaths = $display
    note = 'The display path identifies the active output and adapter LUID. Frame-to-content revision correlation still needs the browser/TUI marker calibration and must be explicitly recorded.'
} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $out 'environment.json') -Encoding utf8

$processes = Get-Process -Name $TargetProcess -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, SessionId, MainWindowTitle, MainWindowHandle, StartTime
$processes | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $out 'target-processes.json') -Encoding utf8
if (-not $processes) { throw "No $TargetProcess process is visible in the current desktop session." }
if ($TargetProcessId -ne 0 -and -not ($processes | Where-Object { $_.Id -eq $TargetProcessId -and $_.SessionId -eq $sessionId })) {
    throw "Target PID $TargetProcessId is not a $TargetProcess process in this desktop session."
}

$csv = Join-Path $out 'presentmon.csv'
$targetArguments = if ($TargetProcessId -ne 0) { @('--process_id', "$TargetProcessId") } else { @('--process_name', "$TargetProcess.exe") }
$arguments = $targetArguments + @('--session_name', "Protium-$stamp-$PID", '--output_file', $csv, '--timed', "$DurationSeconds", '--terminate_after_timed', '--no_console_stats', '--qpc_time', '--write_display_metadata')
"PresentMon arguments: $($arguments -join ' ')`r`nTool SHA-256: $toolHash`r`nRun the exact options against the saved --help output if this release uses different switch names." | Set-Content -LiteralPath (Join-Path $out 'capture-command.txt') -Encoding utf8
& $resolvedTool @arguments
$exitCode = $LASTEXITCODE
[pscustomobject]@{ exitCode = $exitCode; csvExists = (Test-Path -LiteralPath $csv); csvBytes = if (Test-Path -LiteralPath $csv) { (Get-Item -LiteralPath $csv).Length } else { 0 }; finishedAt = (Get-Date).ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'capture-result.json') -Encoding utf8
if ($exitCode -ne 0) { throw "PresentMon exited with code $exitCode; evidence retained in $out" }
if (-not (Test-Path -LiteralPath $csv)) { throw "PresentMon produced no frame CSV; the capture is not a valid measurement. Evidence: $out" }
Write-Output "Capture package: $out"
