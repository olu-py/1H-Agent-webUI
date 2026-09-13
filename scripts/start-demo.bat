@echo off
rem One-click demo start for the 1H-Agent WebUI.
rem Isolated demo data (no API key needed to browse / create sessions).
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-web.ps1" -Mode demo %*
if errorlevel 1 (
  echo.
  echo Startup failed - see the messages above.
  pause
)
