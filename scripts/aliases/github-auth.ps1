# GitHub 推送密钥快速加载（每次重启电脑后跑一次即可，口令输入一次）
# 密钥：~/.ssh/id_ed25519（在 GitHub 账户中登记过公钥即可，密钥文件名可按需调整）
$ErrorActionPreference = "Continue"
$svc = Get-Service ssh-agent -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -ne "Running") {
  try { Start-Service ssh-agent -ErrorAction Stop }
  catch {
    Write-Host "ssh-agent 未能启动。请用管理员 PowerShell 执行一次：" -ForegroundColor Yellow
    Write-Host "  Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent" -ForegroundColor Yellow
  }
}
Write-Host "请输入密钥口令（输入时不可见）："
ssh-add "$env:USERPROFILE\.ssh\id_ed25519"
Write-Host ""
Write-Host "看到 Identity added 即成功；随后 git push/pull 无需再输口令。" -ForegroundColor Green
