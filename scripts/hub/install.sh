#!/usr/bin/env bash
# opencode-mesh Hub 安装脚本
# 目标系统：Alibaba Cloud Linux / CentOS / 其他 RPM 系（Debian 系亦可，依赖需自行满足）
# 幂等：可重复执行（会覆盖服务定义，保留数据文件与密钥）
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/opencode-mesh}"
CONF_DIR="${CONF_DIR:-/etc/opencode-mesh}"
DATA_DIR="${DATA_DIR:-/var/lib/opencode-mesh}"
LOG_DIR="${LOG_DIR:-/var/log/opencode-mesh}"
REGISTRY_PORT="${REGISTRY_PORT:-18080}"
FRPS_PORT="${FRPS_PORT:-17000}"
FRP_VERSION="${FRP_VERSION:-}"
FRP_URL_OVERRIDE="${FRP_URL_OVERRIDE:-}"
FRP_LOCAL_ZIP="${FRP_LOCAL_ZIP:-}"

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
EOF
  echo "已生成 $CONF_DIR/registry.env"
else
  echo "保留已有 $CONF_DIR/registry.env"
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

echo "==> 安装 systemd 服务"
cat > /etc/systemd/system/opencode-mesh-registry.service <<EOF
[Unit]
Description=opencode-mesh registry
After=network.target

[Service]
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
ExecStart=$INSTALL_DIR/frps -c $CONF_DIR/frps.toml
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now opencode-mesh-registry.service opencode-mesh-frps.service

echo "==> 放行防火墙端口（firewalld，如启用）"
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active firewalld >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=${FRPS_PORT}/tcp
  firewall-cmd --permanent --add-port=14100-19998/tcp
  firewall-cmd --reload
fi

echo
echo "=============================================="
echo "Hub 安装完成！"
echo "- registry: http://0.0.0.0:$REGISTRY_PORT"
echo "- frps: 0.0.0.0:$FRPS_PORT"
echo "- 管理端口段: $(grep '^REGISTRY_PORT_START=' "$CONF_DIR/registry.env" | cut -d= -f2)-$(grep '^REGISTRY_PORT_END=' "$CONF_DIR/registry.env" | cut -d= -f2)（阿里云控制台安全组也需放行）"
echo
echo "查看管理员密钥（生成加入密钥时使用）："
echo "  grep REGISTRY_ADMIN_TOKEN $CONF_DIR/registry.env"
echo
echo "生成加入密钥："
echo "  curl -s -X POST http://127.0.0.1:$REGISTRY_PORT/admin/keys -H 'X-Admin-Token: <ADMIN_TOKEN>' -H 'Content-Type: application/json' -d '{\"count\":1}'"
echo "=============================================="
