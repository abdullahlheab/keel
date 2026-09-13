@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm.cmd install
)
echo.
echo Starting Company Tracker at http://localhost:3000
echo Keep this window open while you use it. Press Ctrl+C to stop.
echo.
call npm.cmd start
pause
