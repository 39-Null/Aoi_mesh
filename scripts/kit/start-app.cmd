@echo off
rem opencode-mesh 便携包启动入口（Windows）
rem 免安装：本文件所在目录即 kit 根；数据与配置均保存在本目录内
setlocal
set "ROOT=%~dp0"
set "OPENCODE_MESH_ROOT=%ROOT%opencode-mesh"
start "" "%ROOT%app\opencode-mesh.exe"
