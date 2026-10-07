# AgentHub NAS 部署/更新脚本（在 Windows 上运行）
#
# 为什么不直接在 NAS 上构建：
#   1. NAS 是 Celeron N3060，编译一遍很慢
#   2. NAS 拉不到 Docker Hub（registry-1.docker.io 连接被重置）
# 所以走「本机构建 → 导出 → 传输 → NAS 导入」。架构一致（都是 linux/amd64），实测约 10 秒传完。
#
# 传输为什么不用 scp：群晖的 sftp 子系统配置异常（Subsystem sftp internal-sftp -f DAEMON -u 000），
# scp/sftp 都会失败，改用 SSH stdin 字节流。
#
# 认证：走 SSH 密钥免密，首次配置：
#   ssh-copy-id -i ~/.ssh/KEY.pub USER@NAS
# 注意群晖要求 home 权限不能是 777，否则 sshd 的 StrictModes 会拒绝密钥登录：
#   chmod 755 ~ && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys
#
# 关于 sudo：导入镜像需要 docker 权限，脚本会交互式提示 sudo 密码。
# 刻意不配 sudo 免密——那会放宽 NAS 的安全边界，与「容器 SSH 隔离」的初衷相反。
#
# 用法：
#   .\deploy-to-nas.ps1                                    构建并部署
#   .\deploy-to-nas.ps1 -SkipBuild                         跳过构建，推当前镜像
#   .\deploy-to-nas.ps1 -SshPubKey (Get-Content KEY.pub -Raw).Trim()   首次启用容器内 SSH
param(
  [switch]$SkipBuild,
  [string]$SshPubKey = "",
  [string]$NasHost = "192.168.1.172",
  [string]$NasUser = "chihengzhu",
  [string]$SshKey = "$($env:USERPROFILE)\.ssh\quant-nas",
  [string]$NasDir = "/volume1/docker/AgentHub",
  [string]$Image = "agenthub-web:latest",
  [int]$WebPort = 19528,
  [int]$GatewayPort = 19527,
  [int]$SshPort = 12222
)

$ErrorActionPreference = "Stop"

# 免密 SSH：缺少密钥时给出明确指引，而不是回去要密码
if (-not (Test-Path $SshKey)) {
  throw "找不到 SSH 私钥 $SshKey。请先配置免密登录（见脚本头部注释），或传 -SshKey 指定。"
}
# 注意：PowerShell 不允许「数组展开后再跟位置参数」，直接拼 ssh 命令会解析失败，
# 所以统一用一个函数拼参数，避免每处都写一长串。
function Invoke-Remote {
  param([string]$Command, [switch]$Tty)
  $base = @("-i", $SshKey, "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10")
  if (-not $Tty) { $base += @("-o", "BatchMode=yes") } else { $base += "-t" }
  $base += "$NasUser@$NasHost"
  $base += $Command
  return (ssh @base)
}

function Test-Ssh {
  (ssh -i $SshKey -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no "$NasUser@$NasHost" "echo __OK__" 2>$null) -match "__OK__"
}
if (-not (Test-Ssh)) {
  throw "SSH 免密登录失败（$NasUser@$NasHost）。请确认公钥已装到 NAS 且 home 权限为 755。"
}

# 在 NAS 上执行脚本：base64 传输，避开 PowerShell 引号与 CRLF 污染
function Invoke-Nas {
  param([string]$Script)
  $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes(($Script -replace "`r`n", "`n")))
  $out = Invoke-Remote "echo $b64 | base64 -d > /tmp/ah-deploy.sh && bash /tmp/ah-deploy.sh" 2>&1
  return ($out | Where-Object { $_ -notmatch "^Warning: Permanently added" -and $_ -ne "" })
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

# ---- 1) 构建 ----
if (-not $SkipBuild) {
  Write-Host "[1/4] 构建镜像..." -ForegroundColor Cyan
  docker build -t $Image .
  if ($LASTEXITCODE -ne 0) { throw "构建失败" }
  Write-Host "      完成" -ForegroundColor Green
} else {
  Write-Host "[1/4] 跳过构建" -ForegroundColor DarkGray
}

# ---- 2) 导出 ----
Write-Host "[2/4] 导出镜像..." -ForegroundColor Cyan
$tar = "$env:TEMP\ah-deploy.tar"
$gz = "$env:TEMP\ah-deploy.tar.gz"
Remove-Item $tar, $gz -Force -ErrorAction SilentlyContinue
docker save $Image -o $tar
if ($LASTEXITCODE -ne 0) { throw "导出失败" }
& gzip -9 -f $tar 2>$null
if (-not (Test-Path $gz)) { $gz = $tar }
Write-Host "      $([math]::Round((Get-Item $gz).Length / 1MB, 1)) MB" -ForegroundColor Green

# ---- 3) 传输（SSH stdin 字节流，scp 在群晖不可用）----
Write-Host "[3/4] 传输到 NAS..." -ForegroundColor Cyan
$remotePath = "$NasDir/ah-deploy.tar.gz"
cmd /c "type `"$gz`" | ssh -i `"$SshKey`" -o BatchMode=yes -o StrictHostKeyChecking=no $NasUser@$NasHost `"cat > $remotePath`"" 2>&1 | Out-Null

$localHash = (Get-FileHash $gz -Algorithm MD5).Hash.ToLower()
$remoteHash = ((Invoke-Nas "md5sum $remotePath | awk '{print `$1}'") -join "").Trim().ToLower()
if ($remoteHash -ne $localHash) { throw "传输校验失败：本机 $localHash / NAS $remoteHash" }
Write-Host "      MD5 校验一致" -ForegroundColor Green

# ---- 4) NAS 上导入并重启 ----
Write-Host "[4/4] 导入并重启容器..." -ForegroundColor Cyan
$pubkeyLine = if ($SshPubKey) { $SshPubKey } else {
  # 未显式传公钥时，沿用 NAS 上 compose 里已有的（避免把它清空）
  (Invoke-Nas "grep -oP '(?<=AGENTHUB_SSH_PUBKEY: `")[^`"]+' $NasDir/docker-compose.nas.yml 2>/dev/null | head -n 1") -join ""
}
if (-not $pubkeyLine) {
  Write-Warning "未能确定容器 SSH 公钥；容器内 SSH 将不可用。用 -SshPubKey 指定即可启用。"
}

# compose 文件在 NAS 上生成（端口按参数，避开群晖 syslog-ng 占用的 9526-9529）
$compose = Get-Content "$PSScriptRoot\..\..\docker-compose.yml" -Raw -Encoding UTF8
$compose = $compose -replace '"9528:9528"', "`"$WebPort`:$WebPort`""
$compose = $compose -replace '"9527:9527"', "`"$GatewayPort`:$GatewayPort`""
$compose = $compose -replace 'AGENTHUB_WEB_PORT: "9528"', "AGENTHUB_WEB_PORT: `"$WebPort`""
$compose = $compose -replace 'AGENTHUB_PROXY_PORT: "9527"', "AGENTHUB_PROXY_PORT: `"$GatewayPort`""
if ($pubkeyLine) {
  $compose = $compose -replace '# AGENTHUB_SSH_PUBKEY: "ssh-ed25519 AAAA\.\.\. you@host"', "AGENTHUB_SSH_PUBKEY: `"$pubkeyLine`""
}
$b64compose = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($compose))
Invoke-Nas "cd $NasDir && echo '$b64compose' | base64 -d > docker-compose.nas.yml && echo 'compose 已更新'" | ForEach-Object { Write-Host "      $_" }

# 导入与重启需要 docker 权限；这里刻意交互式要 sudo 密码，不配免密
Write-Host "      需要 sudo 权限导入镜像，请按提示输入 NAS 的 sudo 密码：" -ForegroundColor Yellow
$script = @"
set -e
cd $NasDir
D=/var/packages/Docker/target/usr/bin/docker
DC=/var/packages/Docker/target/usr/bin/docker-compose
run() { sudo "$@"; }

# 先解压到临时文件再 load：sudo 默认会关闭继承的 fd，
# 用进程替换 <(gunzip ...) 会把 /dev/fd/NN 关掉导致 load 读到空。
gunzip -c ah-deploy.tar.gz > /tmp/ah-img.tar
run `$D load -i /tmp/ah-img.tar 2>&1 | tail -n 2
rm -f /tmp/ah-img.tar

run `$DC -f docker-compose.nas.yml up -d --no-build --force-recreate 2>&1 | tail -n 4
sleep 10
run `$D ps --filter name=agenthub --format '{{.Names}} | {{.Status}} | {{.Ports}}'
"@
# -Tty 分配终端，让 sudo 能交互式读密码（刻意不配 sudo 免密：那会放宽 NAS 安全边界）
$b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes(($script -replace "`r`n", "`n")))
Invoke-Remote "echo $b64 | base64 -d > /tmp/ah-deploy.sh && bash /tmp/ah-deploy.sh" -Tty

$sw.Stop()
Write-Host ""
Write-Host "部署完成，耗时 $([math]::Round($sw.Elapsed.TotalSeconds,0)) 秒" -ForegroundColor Green
Write-Host "  Web 控制台: http://${NasHost}:${WebPort}" -ForegroundColor Yellow
Write-Host "  反代网关  : http://${NasHost}:${GatewayPort}/v1" -ForegroundColor Yellow
$sshHint = if ($pubkeyLine) { "ssh -p $SshPort root@${NasHost}  （免密）" } else { "（未启用，用 -SshPubKey 开启）" }
Write-Host "  容器 SSH  : $sshHint" -ForegroundColor Yellow
