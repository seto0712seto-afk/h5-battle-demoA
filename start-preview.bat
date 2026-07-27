@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
set PORT=5173

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo Node.js / npm was not found.
  echo Please install Node.js first, then run this file again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo H5 Demo preview will run at:
echo   Local:   http://127.0.0.1:%PORT%/
echo.
echo Share one of these LAN URLs with testers on the same Wi-Fi/LAN:
set FOUND_IP=0
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /C:"IPv4"') do (
  set IP=%%A
  set IP=!IP: =!
  if not "!IP!"=="" (
    set FOUND_IP=1
    echo   http://!IP!:%PORT%/
  )
)
if "!FOUND_IP!"=="0" (
  echo   No IPv4 address found. Run ipconfig and use your IPv4 address.
)
echo.
echo If other users cannot open it:
echo   1. Make sure they are on the same LAN/Wi-Fi.
echo   2. Allow Node.js through Windows Firewall when prompted.
echo   3. Use http://your-computer-ip:%PORT%/
echo.
echo Keep this window open while testing. Close it to stop the preview.
echo.

call npm.cmd run dev:lan
pause
