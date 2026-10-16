@echo off
rem opencode-mesh 启动（Windows）— Node App 启动别名
setlocal
set "ROOT=%~dp0..\.."
if exist "%ROOT%\node-app\node_modules\electron\dist\electron.exe" (
  start "" "%ROOT%\node-app\node_modules\electron\dist\electron.exe" "%ROOT%\node-app"
) else (
  echo 未找到 Electron：请先在 node-app 目录执行 npm install
  pause
)
