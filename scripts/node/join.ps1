# opencode-mesh 节点加入脚本（Windows）
# 用法示例：
#   powershell -ExecutionPolicy Bypass -File join.ps1 -HubAddress 47.122.107.87 -JoinKey <KEY>
param(
  [Parameter(Mandatory = $true)][string]$HubAddress,
  [int]$HubPort = 18080,
  [Parameter(Mandatory = $true)][string]$JoinKey,
  [string]$NodeName = $env:COMPUTERNAME,
  [int]$OpencodePort = 4096,
  [int]$AgentPort = 41999
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$agentDir = Join-Path $repoRoot "node-agent"
$configFile = Join-Path $agentDir "node.json"
$frpcPath = Join-Path $agentDir "bin\frpc.exe"

if (-not (Test-Path $agentDir)) {
  Write-Error "未找到 node-agent 目录：$agentDir"
  exit 1
}
if (-not (Test-Path $frpcPath)) {
  Write-Warning "未找到 $frpcPath —— 请先下载 frp 二进制（frpc.exe）放入 node-agent\bin\"
}

$password = -join ((1..24) | ForEach-Object { [char]((65..90) + (97..122) + (48..57) | Get-Random) })

$config = @{
  name     = $NodeName.ToLower()
  hub      = @{ address = $HubAddress; port = $HubPort }
  joinKey  = $JoinKey
  opencode = @{ port = $OpencodePort; password = $password; autoStart = $true }
  agent    = @{ port = $AgentPort }
  frpc     = @{ binary = $frpcPath }
}
$config | ConvertTo-Json -Depth 5 | ForEach-Object { [System.IO.File]::WriteAllText($configFile, $_, (New-Object System.Text.UTF8Encoding($false))) }

Write-Output "已写入配置：$configFile"
Write-Output "opencode 访问密码（已被写入本地配置，妥善保存）：$password"
Write-Output ""
Write-Output "正在后台启动 agent…（日志：node-agent\data\agent.log）"
Start-Process -FilePath "node" -ArgumentList "`"$agentDir\agent.js`"" -WorkingDirectory $agentDir -WindowStyle Hidden

Start-Sleep -Seconds 8
$logFile = Join-Path $agentDir "data\agent.log"
if (Test-Path $logFile) {
  Write-Output "--- agent 日志尾部 ---"
  Get-Content $logFile -Tail 12
}
