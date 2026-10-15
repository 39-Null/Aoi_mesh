' opencode-mesh 开机自启入口（Windows）—— 拉起 Telegram Bot 与远程连接
' 放置方式（二选一）：
'   1) 保持在本仓库 node-app\ 下，在启动文件夹创建快捷方式指向本文件
'   2) 复制到启动文件夹（命名为 opencode-telegram-bot.vbs），
'      并先执行 setx OPENCODE_MESH_ROOT "<仓库根绝对路径>" 以定位 autostart.ps1
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
ps1 = fso.GetParentFolderName(WScript.ScriptFullName) & "\autostart.ps1"
If Not fso.FileExists(ps1) Then
  root = sh.Environment("PROCESS")("OPENCODE_MESH_ROOT")
  If root <> "" Then ps1 = root & "\node-app\autostart.ps1"
End If
If fso.FileExists(ps1) Then
  sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False
Else
  MsgBox "未找到 autostart.ps1：请先设置环境变量 OPENCODE_MESH_ROOT 指向仓库根目录（setx OPENCODE_MESH_ROOT ""<路径>""）", 48, "opencode-mesh"
End If
