@echo off
rem One-click demo restart for the 1H-Agent WebUI.
rem Stops the running demo instance (if any), rebuilds whatever is stale and
rem starts it again - preferring the previous port, so an open browser tab
rem just needs a refresh. A failed build never stops the running instance.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-web.ps1" -Mode demo -Restart %*
if errorlevel 1 (
  echo.
  echo Restart failed - see the messages above.
  pause
)
