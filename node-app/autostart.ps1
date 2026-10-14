# opencode Telegram bot autostart (run at logon by scheduled task "opencode-telegram-bot")
# 可移植：自动探测 opencode-telegram 命令位置，不依赖固定用户名/路径
$logDir = "$env:APPDATA\opencode-telegram-bot\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "autostart.log"

function Write-Log($msg) {
  "$(Get-Date -Format s) $msg" | Out-File $log -Append -Encoding utf8
}

Write-Log "waiting for proxy ..."
# 等代理端口就绪（从 bot .env 读取 TELEGRAM_PROXY_URL，默认 127.0.0.1:10090）
$proxyHost = "127.0.0.1"; $proxyPort = 10090
$envFile = "$env:APPDATA\opencode-telegram-bot\.env"
if (Test-Path $envFile) {
  $line = Select-String -Path $envFile -Pattern '^TELEGRAM_PROXY_URL=(.+)$' | Select-Object -First 1
  if ($line) {
    try {
      $u = [Uri]($line.Matches[0].Groups[1].Value.Trim())
      if ($u.Host) { $proxyHost = $u.Host }
      if ($u.Port -gt 0) { $proxyPort = $u.Port }
    } catch {}
  }
}
$ok = $false
foreach ($i in 1..45) {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $t = $c.ConnectAsync($proxyHost, $proxyPort)
    if ($t.Wait(1000) -and $c.Connected) { $ok = $true; $c.Close(); break }
  } catch {}
  Start-Sleep -Seconds 2
}
Write-Log "proxy ready=$ok; locating opencode-telegram ..."

# 探测 CLI：环境变量 → PATH（Get-Command）→ 常见位置
$cli = $null
if ($env:OPENCODE_TELEGRAM_CLI -and (Test-Path $env:OPENCODE_TELEGRAM_CLI)) {
  $cli = $env:OPENCODE_TELEGRAM_CLI
}
if (-not $cli) {
  $cmd = Get-Command opencode-telegram -ErrorAction SilentlyContinue
  if ($cmd) { $cli = $cmd.Source }
}
if (-not $cli) {
  $candidates = @(
    "$env:APPDATA\npm\opencode-telegram.cmd"
  )
  $nvmRoot = "$env:LOCALAPPDATA\Author Software\nvm\installs"
  if (Test-Path $nvmRoot) {
    Get-ChildItem "$nvmRoot\*\opencode-telegram.cmd" -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending | ForEach-Object { $candidates += $_.FullName }
  }
  foreach ($cand in $candidates) {
    if ($cand -and (Test-Path $cand)) { $cli = $cand; break }
  }
}
if (-not $cli) {
  Write-Log "未找到 opencode-telegram（已尝试 PATH 与常见位置）。请安装 bot 或设置环境变量 OPENCODE_TELEGRAM_CLI"
  exit 0
}

Write-Log "using cli: $cli; starting bot daemon"
& $cli start --daemon *>> $log
Write-Log "done (exit=$LASTEXITCODE)"
