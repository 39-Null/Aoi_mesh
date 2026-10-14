@echo off
rem Aoi_mesh 启动别名（Windows）— opencode-mesh Node App
setlocal
set "ROOT=%~dp0..\.."
if exist "%ROOT%\node-app\node_modules\electron\dist\electron.exe" (
  start "" "%ROOT%\node-app\node_modules\electron\dist\electron.exe" "%ROOT%\node-app"
) else (
  echo 未找到 Electron：请先在 node-app 目录执行 npm install
  pause
)
