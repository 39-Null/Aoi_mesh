# opencode-mesh 节点加入脚本（Windows）
# 用法示例：
#   powershell -ExecutionPolicy Bypass -File scripts\node\join.ps1 -HubAddress 1.2.3.4 -JoinKey <KEY>
# 可选参数：
#   -HubPort 18080          Hub 注册中心端口
#   -NodeName <显示名>      默认取本机主机名（小写）
#   -OpencodePort 4096      本机 opencode serve 端口
#   -AgentPort 41999        node-agent 受控 API 端口（本机回环）
# frpc 获取（二选一，缺省自动取最新版）：
#   -FrpVersion v0.61.0     指定 frp 版本
#   -FrpLocalZip <path>     使用本地 frp 压缩包（离线/受限网络）
param(
  [Parameter(Mandatory = $true)][string]$HubAddress,
  [int]$HubPort = 18080,
  [Parameter(Mandatory = $true)][string]$JoinKey,
  [string]$NodeName = $env:COMPUTERNAME,
  [int]$OpencodePort = 4096,
  [int]$AgentPort = 41999,
  [string]$FrpVersion = "",
  [string]$FrpLocalZip = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$agentDir = Join-Path $repoRoot "node-agent"
$configFile = Join-Path $agentDir "node.json"
$binDir = Join-Path $agentDir "bin"
$frpcPath = Join-Path $binDir "frpc.exe"

if (-not (Test-Path $agentDir)) {
  Write-Error "未找到 node-agent 目录：$agentDir"
  exit 1
}

function Ensure-Frpc {
  if (Test-Path $frpcPath) { return }
  Write-Output "未找到 frpc.exe，尝试自动获取…"
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $tmp = Join-Path $env:TEMP ("opencode-mesh-frp-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    if ($FrpLocalZip) {
      if (-not (Test-Path $FrpLocalZip)) { throw "本地压缩包不存在：$FrpLocalZip" }
      $zip = $FrpLocalZip
    } else {
      if (-not $FrpVersion) {
        $rel = Invoke-RestMethod -UseBasicParsing -TimeoutSec 20 "https://api.github.com/repos/fatedier/frp/releases/latest"
        $FrpVersion = $rel.tag_name
      }
      if (-not $FrpVersion) { throw "无法获取 frp 版本号" }
      $verNum = $FrpVersion.TrimStart("v")
      $zip = Join-Path $tmp "frp.zip"
      $url = "https://github.com/fatedier/frp/releases/download/$FrpVersion/frp_${verNum}_windows_amd64.zip"
      Write-Output "下载 $url"
      Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri $url -OutFile $zip
    }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $exe = Get-ChildItem $tmp -Recurse -Filter frpc.exe | Select-Object -First 1
    if (-not $exe) { throw "压缩包中未找到 frpc.exe" }
    Copy-Item $exe.FullName $frpcPath -Force
    Write-Output "已安装 frpc：$frpcPath"
  } catch {
    Write-Warning "自动获取 frpc 失败：$($_.Exception.Message)"
    Write-Warning "请手动下载 frp（https://github.com/fatedier/frp/releases），将 windows_amd64 包中的 frpc.exe 放入 $binDir 后重跑，或使用 -FrpLocalZip 指定本地包。"
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Ensure-Frpc

$password = -join ((1..24) | ForEach-Object { [char]((65..90) + (97..122) + (48..57) | Get-Random) })

# 兼容「密钥.指纹」组合串（TLS 钉扎）：拆分密钥与 64 位 hex 指纹
$fp = ""
if ($JoinKey.Contains(".")) {
  $parts = $JoinKey.Split(".")
  $JoinKey = $parts[0]
  if ($parts.Count -ge 2 -and $parts[1] -match '^[a-fA-F0-9]{64}$') {
    $fp = $parts[1].ToLower()
  }
}

$config = @{
  name     = $NodeName.ToLower()
  hub      = @{ address = $HubAddress; port = $HubPort; fingerprint = $fp }
  joinKey  = $JoinKey
  opencode = @{ port = $OpencodePort; password = $password; autoStart = $true }
  agent    = @{ port = $AgentPort }
  frpc     = @{ binary = $frpcPath }
}
$config | ConvertTo-Json -Depth 5 | ForEach-Object { [System.IO.File]::WriteAllText($configFile, $_, (New-Object System.Text.UTF8Encoding($false))) }
try {
  icacls $configFile /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
} catch {}

if ($fp) {
  Write-Output "已启用 TLS 指纹钉扎（SHA-256：$($fp.Substring(0,16))…）"
}

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
