@echo off
cd /d "%~dp0"
if not exist "dist-lan\index.html" (
  echo 局域网版本尚未生成，请先运行“同步到局域网版本.bat”。
  pause
  exit /b 1
)
npm.cmd run lan:serve
pause
