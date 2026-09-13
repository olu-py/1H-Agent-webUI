@echo off
rem One-click formal start for the 1H-Agent WebUI.
rem Default data dir, workspace = repository root (override with -Workspace "...").
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-web.ps1" -Mode formal %*
if errorlevel 1 (
  echo.
  echo Startup failed - see the messages above.
  pause
)
