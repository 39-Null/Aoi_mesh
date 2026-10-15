#!/usr/bin/env bash
# opencode-mesh Hub 安装脚本
# 目标系统：Alibaba Cloud Linux / CentOS / 其他 RPM 系（Debian 系亦可，依赖需自行满足）
# 幂等：可重复执行（会覆盖服务定义，保留数据文件与密钥）
#
# 可选环境变量：
#   ENABLE_TLS=0            禁用自签 TLS（默认 1，需要 openssl；禁用则 registry 以 HTTP 运行）
#   REGISTRY_PORT/FRPS_PORT 端口（默认 18080/17000）
#   FRP_VERSION / FRP_LOCAL_ZIP / FRP_URL_OVERRIDE  frp 获取方式
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/opencode-mesh}"
CONF_DIR="${CONF_DIR:-/etc/opencode-mesh}"
DATA_DIR="${DATA_DIR:-/var/lib/opencode-mesh}"
LOG_DIR="${LOG_DIR:-/var/log/opencode-mesh}"
TLS_DIR="${TLS_DIR:-$CONF_DIR/tls}"
REGISTRY_PORT="${REGISTRY_PORT:-18080}"
FRPS_PORT="${FRPS_PORT:-17000}"
FRP_VERSION="${FRP_VERSION:-}"
FRP_URL_OVERRIDE="${FRP_URL_OVERRIDE:-}"
FRP_LOCAL_ZIP="${FRP_LOCAL_ZIP:-}"
ENABLE_TLS="${ENABLE_TLS:-1}"
SERVICE_USER="${SERVICE_USER:-opencode-mesh}"

if [ "$(id -u)" != "0" ]; then
  echo "请以 root 运行（sudo bash install.sh）"
  exit 1
fi

echo "==> 准备目录"
mkdir -p "$INSTALL_DIR/registry" "$CONF_DIR" "$DATA_DIR" "$LOG_DIR"

echo "==> 检查 Node.js（registry 仅依赖标准库，Node 16+ 即可）"
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 node，尝试通过包管理器安装…"
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y nodejs
  elif command -v yum >/dev/null 2>&1; then
    yum install -y nodejs
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update && apt-get install -y nodejs
  else
    echo "请手动安装 Node.js 后重试"; exit 1
  fi
fi
node -v

echo "==> 安装 registry"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp -f "$SCRIPT_DIR/../../hub/registry/server.js" "$INSTALL_DIR/registry/server.js"

echo "==> 安装 frps"
if [ -n "$FRP_LOCAL_ZIP" ]; then
  echo "使用本地 frp 压缩包：$FRP_LOCAL_ZIP"
  TMP=$(mktemp -d)
  tar -xf "$FRP_LOCAL_ZIP" -C "$TMP" 2>/dev/null || unzip -o "$FRP_LOCAL_ZIP" -d "$TMP"
  cp -f "$(find "$TMP" -name frps -type f | head -1)" "$INSTALL_DIR/frps"
  cp -f "$(find "$TMP" -name frpc -type f | head -1)" "$INSTALL_DIR/frpc"
  rm -rf "$TMP"
else
  if [ -z "$FRP_VERSION" ]; then
    echo "未指定 FRP_VERSION，尝试从 GitHub 获取最新版本号…"
    FRP_VERSION=$(curl -fsSL --max-time 20 https://api.github.com/repos/fatedier/frp/releases/latest | grep -o '"tag_name": *"[^"]*"' | cut -d'"' -f4 || true)
    if [ -z "$FRP_VERSION" ]; then
      echo "无法访问 GitHub（国内服务器常见）。请设置 FRP_LOCAL_ZIP 指向本地已下载的 frp linux 压缩包后重试。"
      exit 1
    fi
  fi
  VER_NUM="${FRP_VERSION#v}"
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64) FRP_ARCH="amd64" ;;
    aarch64) FRP_ARCH="arm64" ;;
    *) echo "不支持的架构：$ARCH"; exit 1 ;;
  esac
  URL="${FRP_URL_OVERRIDE:-https://github.com/fatedier/frp/releases/download/${FRP_VERSION}/frp_${VER_NUM}_linux_${FRP_ARCH}.tar.gz}"
  echo "下载 frp：$URL"
  TMP=$(mktemp -d)
  curl -fL --max-time 120 -o "$TMP/frp.tar.gz" "$URL" || {
    echo "下载失败。可改用 FRP_LOCAL_ZIP=/path/to/frp_linux_amd64.tar.gz 重试"; exit 1;
  }
  tar -xzf "$TMP/frp.tar.gz" -C "$TMP"
  cp -f "$(find "$TMP" -name frps -type f | head -1)" "$INSTALL_DIR/frps"
  cp -f "$(find "$TMP" -name frpc -type f | head -1)" "$INSTALL_DIR/frpc"
  rm -rf "$TMP"
fi
chmod +x "$INSTALL_DIR/frps" "$INSTALL_DIR/frpc"

echo "==> 生成自签 TLS 证书（registry HTTPS，客户端按指纹钉扎）"
TLS_READY=0
if [ "$ENABLE_TLS" = "1" ]; then
  if [ ! -f "$TLS_DIR/cert.pem" ] || [ ! -f "$TLS_DIR/key.pem" ]; then
    if command -v openssl >/dev/null 2>&1; then
      mkdir -p "$TLS_DIR"
      PUBIP="$(curl -fsSL --max-time 5 ifconfig.me 2>/dev/null || true)"
      SAN="DNS:localhost,IP:127.0.0.1"
      [ -n "$PUBIP" ] && SAN="$SAN,IP:$PUBIP"
      openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -sha256 -days 3650 -nodes \
        -keyout "$TLS_DIR/key.pem" -out "$TLS_DIR/cert.pem" -subj "/CN=opencode-mesh-hub" \
        -addext "subjectAltName=$SAN" >/dev/null 2>&1 \
      || openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
        -keyout "$TLS_DIR/key.pem" -out "$TLS_DIR/cert.pem" -subj "/CN=opencode-mesh-hub" >/dev/null 2>&1 \
      || rm -f "$TLS_DIR/key.pem" "$TLS_DIR/cert.pem"
      chmod 600 "$TLS_DIR/key.pem" 2>/dev/null || true
      chmod 644 "$TLS_DIR/cert.pem" 2>/dev/null || true
      [ -f "$TLS_DIR/cert.pem" ] && echo "已生成：$TLS_DIR/cert.pem"
    else
      echo "警告：未找到 openssl，跳过证书生成（registry 将以 HTTP 运行；安装 openssl 后可重跑本脚本启用 TLS）"
    fi
  else
    echo "保留已有证书：$TLS_DIR/cert.pem"
  fi
  [ -f "$TLS_DIR/cert.pem" ] && [ -f "$TLS_DIR/key.pem" ] && TLS_READY=1
else
  echo "ENABLE_TLS=0：跳过 TLS（registry 以 HTTP 运行）"
fi
FINGERPRINT=""
if [ "$TLS_READY" = "1" ]; then
  FINGERPRINT="$(openssl x509 -in "$TLS_DIR/cert.pem" -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2 | tr -d ':' | tr 'A-F' 'a-f' || true)"
fi

echo "==> 生成配置（保留已有的密钥/数据）"
if [ ! -f "$CONF_DIR/registry.env" ]; then
  ADMIN_TOKEN=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  FRP_TOKEN=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
  cat > "$CONF_DIR/registry.env" <<EOF
REGISTRY_PORT=$REGISTRY_PORT
REGISTRY_HOST=0.0.0.0
REGISTRY_ADMIN_TOKEN=$ADMIN_TOKEN
REGISTRY_PORT_START=14100
REGISTRY_PORT_END=19998
REGISTRY_FRPS_ADDR=$(curl -fsSL --max-time 5 ifconfig.me 2>/dev/null || echo "PLEASE_SET_HUB_PUBLIC_IP")
REGISTRY_FRPS_PORT=$FRPS_PORT
REGISTRY_FRP_TOKEN=$FRP_TOKEN
REGISTRY_DATA=$DATA_DIR/data.json
REGISTRY_AUDIT_LOG=$LOG_DIR/audit.log
REGISTRY_JOIN_KEY_TTL_HOURS=72
EOF
  echo "已生成 $CONF_DIR/registry.env"
else
  echo "保留已有 $CONF_DIR/registry.env"
fi
ensure_env() {
  grep -q "^$1=" "$CONF_DIR/registry.env" || echo "$1=$2" >> "$CONF_DIR/registry.env"
}
ensure_env REGISTRY_AUDIT_LOG "$LOG_DIR/audit.log"
ensure_env REGISTRY_JOIN_KEY_TTL_HOURS 72
if [ "$TLS_READY" = "1" ]; then
  ensure_env REGISTRY_TLS_CERT "$TLS_DIR/cert.pem"
  ensure_env REGISTRY_TLS_KEY "$TLS_DIR/key.pem"
fi
grep -q "^REGISTRY_FRPS_ADDR=PLEASE_SET" "$CONF_DIR/registry.env" && {
  echo "注意：请在 $CONF_DIR/registry.env 中把 REGISTRY_FRPS_ADDR 改为本机公网 IP。"
}

if [ ! -f "$CONF_DIR/frps.toml" ]; then
  FRP_TOKEN=$(grep '^REGISTRY_FRP_TOKEN=' "$CONF_DIR/registry.env" | cut -d= -f2)
  cat > "$CONF_DIR/frps.toml" <<EOF
bindAddr = "0.0.0.0"
bindPort = $FRPS_PORT
auth.method = "token"
auth.token = "$FRP_TOKEN"
log.to = "$LOG_DIR/frps.log"
log.level = "info"
EOF
  echo "已生成 $CONF_DIR/frps.toml"
else
  echo "保留已有 $CONF_DIR/frps.toml"
fi

echo "==> 服务运行用户（最小权限）"
RUN_AS="root"
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  RUN_AS="$SERVICE_USER"
elif useradd -r -s /sbin/nologin "$SERVICE_USER" 2>/dev/null || useradd -r "$SERVICE_USER" 2>/dev/null; then
  RUN_AS="$SERVICE_USER"
else
  echo "警告：无法创建服务用户 $SERVICE_USER，服务将以 root 运行"
fi
if [ "$RUN_AS" != "root" ]; then
  chown -R "$RUN_AS" "$DATA_DIR" "$LOG_DIR" 2>/dev/null || true
  [ -d "$TLS_DIR" ] && chown -R "$RUN_AS" "$TLS_DIR" 2>/dev/null || true
  echo "registry / frps 将以 $RUN_AS 运行"
fi

echo "==> 安装 systemd 服务"
cat > /etc/systemd/system/opencode-mesh-registry.service <<EOF
[Unit]
Description=opencode-mesh registry
After=network.target

[Service]
User=$RUN_AS
EnvironmentFile=$CONF_DIR/registry.env
ExecStart=$(command -v node) $INSTALL_DIR/registry/server.js
Restart=always
RestartSec=3
WorkingDirectory=$INSTALL_DIR/registry

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/opencode-mesh-frps.service <<EOF
[Unit]
Description=opencode-mesh frps
After=network.target

[Service]
User=$RUN_AS
ExecStart=$INSTALL_DIR/frps -c $CONF_DIR/frps.toml
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable opencode-mesh-registry.service opencode-mesh-frps.service
# 显式重启：确保升级场景（服务已在运行）也能应用新代码/新单元
systemctl restart opencode-mesh-registry.service opencode-mesh-frps.service

echo "==> 放行防火墙端口（firewalld，如启用）"
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active firewalld >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=${FRPS_PORT}/tcp
  firewall-cmd --permanent --add-port=${REGISTRY_PORT}/tcp
  firewall-cmd --reload
fi

echo
echo "=============================================="
echo "Hub 安装完成！"
SCHEME="http"; [ "$TLS_READY" = "1" ] && SCHEME="https"
echo "- registry: $SCHEME://0.0.0.0:$REGISTRY_PORT"
echo "- frps: 0.0.0.0:$FRPS_PORT"
echo "- 公网入向只需放行以上两个端口（stcp 模式下节点服务零暴露，无需端口段）"
echo "  云服务器请在控制台安全组放行 ${FRPS_PORT}/tcp 与 $REGISTRY_PORT/tcp"
echo
if [ -n "$FINGERPRINT" ]; then
  echo "TLS 指纹（SHA-256）：$FINGERPRINT"
  echo "  生成的加入密钥将形如 <密钥>.$FINGERPRINT —— 节点/控制端粘贴完整串即可（自动拆分并钉扎指纹）"
  echo "  各节点需同步更新到新版客户端后重启（旧客户端不支持 TLS）"
  echo
fi
echo "查看管理员密钥（生成加入密钥时使用）："
echo "  grep REGISTRY_ADMIN_TOKEN $CONF_DIR/registry.env"
echo
echo "生成加入密钥："
echo "  curl -sk -X POST https://127.0.0.1:$REGISTRY_PORT/admin/keys -H 'X-Admin-Token: <ADMIN_TOKEN>' -H 'Content-Type: application/json' -d '{\"count\":1}'"
echo "（HTTP 模式把 -k https 换回 http，下同）"
echo "=============================================="
