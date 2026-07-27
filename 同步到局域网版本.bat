@echo off
cd /d "%~dp0"
echo 正在将当前本地代码发布到独立局域网版本……
npm.cmd run lan:sync
if errorlevel 1 (
  echo 同步失败，原局域网版本不会被完整替换，请查看上方错误。
  pause
  exit /b 1
)
echo 同步完成。已打开的局域网页面不会强制刷新，重新加载页面后进入新版本。
pause
