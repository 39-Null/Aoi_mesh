# 启动主控侧 frpc visitor（读取 node-ctl/visitors.toml）
# 前置：node node-ctl/cli.js visitors-config
$mesh = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$frpc = Join-Path $mesh "node-agent\bin\frpc.exe"
$conf = Join-Path $mesh "node-ctl\visitors.toml"
$log = Join-Path $mesh "node-ctl\visitor.log"

if (-not (Test-Path $conf)) {
  Write-Error "缺少 $conf —— 请先运行： node node-ctl/cli.js visitors-config"
  exit 1
}
if (-not (Test-Path $frpc)) { $frpc = "frpc" }

# 停掉旧的 visitor 进程（按命令行匹配 visitors.toml，避免误杀节点自身的 frpc）
Get-CimInstance Win32_Process -Filter "Name='frpc.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'visitors\.toml' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

Start-Process -FilePath $frpc -ArgumentList "-c", $conf -WindowStyle Hidden `
  -RedirectStandardOutput $log -RedirectStandardError "$log.err"

# 读取配置中的第一个 bindPort，以"端口已监听"为成功标准
$m = Select-String -Path $conf -Pattern 'bindPort\s*=\s*(\d+)' | Select-Object -First 1
$port = if ($m) { $m.Matches[0].Groups[1].Value } else { "14100" }

$ok = $false
foreach ($i in 1..10) {
  Start-Sleep -Seconds 1
  if (netstat -ano | Select-String ":$port\s" | Select-String "LISTENING") { $ok = $true; break }
}

if ($ok) {
  $p = Get-CimInstance Win32_Process -Filter "Name='frpc.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'visitors\.toml' }
  Write-Output "visitor 已启动并监听 127.0.0.1:$port（PID $($p.ProcessId -join ', ')）"
  Write-Output "日志：$log"
} else {
  Write-Error "visitor 未能在 10 秒内监听端口 $port，日志如下："
  Get-Content $log -Tail 15 -ErrorAction SilentlyContinue
  Get-Content "$log.err" -Tail 5 -ErrorAction SilentlyContinue
  exit 1
}
