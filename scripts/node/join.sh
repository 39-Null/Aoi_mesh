#!/usr/bin/env bash
# opencode-mesh 节点加入脚本（Linux）
# 用法示例：
#   bash scripts/node/join.sh --hub 1.2.3.4 --key <JOIN_KEY>
# 可选参数：
#   --hub-port 18080        Hub 注册中心端口
#   --name <显示名>         默认取本机主机名（小写）
#   --oc-port 4096          本机 opencode serve 端口
#   --agent-port 41999      node-agent 受控 API 端口（本机回环）
# frpc 获取（二选一，缺省自动取最新版）：
#   --frp-version v0.61.0   指定 frp 版本
#   --frp-local-zip <path>  使用本地 frp 压缩包（离线/受限网络）
set -euo pipefail

HUB=""; HUB_PORT=18080; KEY=""; NAME="$(hostname)"; OC_PORT=4096; AGENT_PORT=41999
FRP_VERSION="${FRP_VERSION:-}"; FRP_LOCAL_ZIP="${FRP_LOCAL_ZIP:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --hub) HUB="$2"; shift 2;;
    --hub-port) HUB_PORT="$2"; shift 2;;
    --key) KEY="$2"; shift 2;;
    --name) NAME="$2"; shift 2;;
    --oc-port) OC_PORT="$2"; shift 2;;
    --agent-port) AGENT_PORT="$2"; shift 2;;
    --frp-version) FRP_VERSION="$2"; shift 2;;
    --frp-local-zip) FRP_LOCAL_ZIP="$2"; shift 2;;
    -h|--help) sed -n '2,15p' "$0"; exit 0;;
    *) echo "未知参数：$1（用 --help 查看用法）"; exit 1;;
  esac
done

if [ -z "$HUB" ] || [ -z "$KEY" ]; then
  echo "缺少必填参数：--hub <Hub地址> --key <一次性加入密钥>（用 --help 查看用法）"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AGENT_DIR="$REPO_ROOT/node-agent"
BIN_DIR="$AGENT_DIR/bin"
FRPC="$BIN_DIR/frpc"
CONFIG_FILE="$AGENT_DIR/node.json"

[ -d "$AGENT_DIR" ] || { echo "未找到 node-agent 目录：$AGENT_DIR"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "未找到 Node.js（建议 18+）：https://nodejs.org/"; exit 1; }

ensure_frpc() {
  [ -x "$FRPC" ] && return 0
  echo "未找到 frpc，尝试自动获取…"
  mkdir -p "$BIN_DIR"
  local tmp
  tmp="$(mktemp -d)"
  local zip=""
  if [ -n "$FRP_LOCAL_ZIP" ]; then
    zip="$FRP_LOCAL_ZIP"
    [ -f "$zip" ] || { echo "本地压缩包不存在：$zip"; rm -rf "$tmp"; return 1; }
  else
    if [ -z "$FRP_VERSION" ]; then
      FRP_VERSION="$(curl -fsSL --max-time 20 https://api.github.com/repos/fatedier/frp/releases/latest | grep -o '"tag_name": *"[^"]*"' | cut -d'"' -f4 || true)"
    fi
    [ -n "$FRP_VERSION" ] || { echo "无法获取 frp 版本号（网络受限，可稍后用 --frp-local-zip 重跑）"; rm -rf "$tmp"; return 1; }
    local ver_num arch frp_arch
    ver_num="${FRP_VERSION#v}"
    arch="$(uname -m)"
    case "$arch" in
      x86_64) frp_arch=amd64;;
      aarch64|arm64) frp_arch=arm64;;
      *) echo "不支持的架构：$arch"; rm -rf "$tmp"; return 1;;
    esac
    zip="$tmp/frp.tar.gz"
    local url
    url="https://github.com/fatedier/frp/releases/download/${FRP_VERSION}/frp_${ver_num}_linux_${frp_arch}.tar.gz"
    echo "下载 $url"
    curl -fL --max-time 120 -o "$zip" "$url" || { echo "下载失败（网络受限，可手动下载 frp 后将 frpc 放入 $BIN_DIR，或用 --frp-local-zip 重跑）"; rm -rf "$tmp"; return 1; }
  fi
  tar -xf "$zip" -C "$tmp" 2>/dev/null || unzip -o "$zip" -d "$tmp" >/dev/null
  local src
  src="$(find "$tmp" -name frpc -type f | head -1)"
  [ -n "$src" ] || { echo "压缩包中未找到 frpc"; rm -rf "$tmp"; return 1; }
  cp -f "$src" "$FRPC" && chmod +x "$FRPC"
  rm -rf "$tmp"
  echo "已安装 frpc：$FRPC"
}
ensure_frpc || echo "提示：frpc 暂未就绪，agent 启动后补齐 frpc 并重启节点即可建立隧道。"

PASSWORD="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)"
NAME_LC="$(echo "$NAME" | tr '[:upper:]' '[:lower:]')"

# 兼容「密钥.指纹」组合串（TLS 钉扎）：拆分密钥与 64 位 hex 指纹
FP=""
if [[ "$KEY" == *.* ]]; then
  FP_PART="${KEY##*.}"
  KEY="${KEY%%.*}"
  if [[ "$FP_PART" =~ ^[a-fA-F0-9]{64}$ ]]; then
    FP="$(echo "$FP_PART" | tr 'A-F' 'a-f')"
  fi
fi

if [ -n "$FP" ]; then
  cat > "$CONFIG_FILE" <<EOF
{
  "name": "$NAME_LC",
  "hub": { "address": "$HUB", "port": $HUB_PORT, "fingerprint": "$FP" },
  "joinKey": "$KEY",
  "opencode": { "port": $OC_PORT, "password": "$PASSWORD", "autoStart": true },
  "agent": { "port": $AGENT_PORT },
  "frpc": { "binary": "bin/frpc" }
}
EOF
else
  cat > "$CONFIG_FILE" <<EOF
{
  "name": "$NAME_LC",
  "hub": { "address": "$HUB", "port": $HUB_PORT },
  "joinKey": "$KEY",
  "opencode": { "port": $OC_PORT, "password": "$PASSWORD", "autoStart": true },
  "agent": { "port": $AGENT_PORT },
  "frpc": { "binary": "bin/frpc" }
}
EOF
fi
chmod 600 "$CONFIG_FILE" 2>/dev/null || true
if [ -n "$FP" ]; then
  echo "已启用 TLS 指纹钉扎（SHA-256：${FP:0:16}…）"
fi

echo "已写入配置：$CONFIG_FILE"
echo "opencode 访问密码（已被写入本地配置，妥善保存）：$PASSWORD"
echo ""
echo "正在后台启动 agent…（日志：node-agent/data/agent.log）"
mkdir -p "$AGENT_DIR/data"
cd "$AGENT_DIR"
nohup node agent.js >> data/agent.log 2>&1 &
echo "agent PID：$!"
sleep 6
echo "--- agent 日志尾部 ---"
tail -n 12 data/agent.log 2>/dev/null || true
