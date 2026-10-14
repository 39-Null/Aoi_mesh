# 部署与运维指南

> 本文面向实际部署：从一台公网服务器到多设备组网、控制端配置与日常运维。
> 架构与设计决策参见 [DESIGN.md](DESIGN.md)；日常操作参见 [USAGE.md](USAGE.md)。

## 1. 前置条件

| 角色 | 要求 |
| --- | --- |
| Hub（公网服务器） | Linux（RPM 系优先，Debian 系亦可）、root/sudo、Node.js 16+（脚本可自动安装） |
| 节点设备 | Windows 或 Linux，能出站访问 Hub；`node-agent` 托管 opencode 时需本机已安装 opencode |
| 控制端 | 任意可访问 Hub 的设备（可与某节点同机）；GUI 需要 Electron 环境，CLI/MCP 仅需 Node.js |

网络要求：**仅需 Hub 放行两个 TCP 端口**（注册中心 `18080`、frp 控制口 `17000`，均可自定义）；节点与控制端**无需任何入站端口**。

## 2. 部署 Hub

在公网服务器上获取本仓库后执行（幂等，可重复运行以升级）：

```bash
sudo bash scripts/hub/install.sh
```

脚本将完成：安装 frps 与注册中心 → 生成配置与随机密钥 → 注册 systemd 服务并启动 → 尝试放行防火墙。

安装后检查：

```bash
systemctl status opencode-mesh-registry opencode-mesh-frps   # 两个服务均应为 active
curl -s http://127.0.0.1:18080/health                        # 返回健康状态 JSON
```

配置文件 `/etc/opencode-mesh/registry.env`（保留已有密钥与数据），关键项：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `REGISTRY_PORT` | 注册中心端口 | `18080` |
| `REGISTRY_ADMIN_TOKEN` | 所有者密钥（自动生成） | 必填 |
| `REGISTRY_FRPS_ADDR` | frps 对外地址，**需改为公网 IP** | 需设置 |
| `REGISTRY_FRPS_PORT` | frp 控制口 | `17000` |
| `REGISTRY_PORT_START/END` | 节点隧道端口分配区间（控制端本地使用） | `14100`–`14199` |

云服务器注意：需在控制台安全组放行 `18080/tcp` 与 `17000/tcp`（firewalld 由脚本自动放行）。

**生成加入密钥**（入网凭据，一次性）：

```bash
grep REGISTRY_ADMIN_TOKEN /etc/opencode-mesh/registry.env
curl -s -X POST http://127.0.0.1:18080/admin/keys \
  -H 'X-Admin-Token: <ADMIN_TOKEN>' -H 'Content-Type: application/json' \
  -d '{"count":1}'
```

返回的 `keys` 数组即为加入密钥，分发给待接入设备。

## 3. 接入节点

### 方式 A：图形界面（推荐）

1. 在节点设备上启动 App（`npm start` 或便携包 `start-app.sh`）
2. 进入「组网」页填写：
   - **节点名**：全网唯一（默认主机名）
   - **Hub 地址 / 端口**：公网 IP 与 `18080`
   - **加入密钥**：粘贴上一步生成的密钥
   - **opencode 端口**：默认 `4096`；**新密码 / 确认密码**：设置该节点 opencode 的访问密码（留空表示不修改已存密码）
   - **agent 端口**：默认 `41999`（本机回环）
3. 点「保存」→ 点「启动节点」；状态应显示 `agent 运行中（PID …）· 已注册（stcp …）`

### 方式 B：脚本（headless / 无图形环境）

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File scripts\node\join.ps1 -HubAddress <公网IP> -JoinKey <KEY>
```

要点：`node-agent\bin\` 下需有对应平台的 `frpc`；脚本参数支持 `-NodeName`、`-OpencodePort`、`-AgentPort`。Linux 便携包解压后按其说明执行 `start-app.sh` 或等效 headless 启动。

验证：Hub 上 `curl -s http://127.0.0.1:18080/nodes` 可见该节点且 `online: true`。

### 接入更多节点

平权模型：任意已入网节点均可凭自己的节点 token（或所有者密钥）生成新加入密钥、引入新设备；每个密钥建议一拍一用。所有节点服务均经 frp `stcp` 接入，**不向公网暴露任何节点端口**。

## 4. 配置控制端

控制端是发起操作的设备（手机经 Telegram Bot 或直接使用主控 App / CLI / opencode agent）。

### 4.1 主控 App

1. 「组网」页填一次 Hub 连接（会与「主控」页双写同步）
2. 「主控」页 →「同步节点（自动配置）」：从注册中心拉取节点列表并自动生成隧道配置
3. 隧道**全自动运行**：同步节点或启动 App 时按需自动生成/更新/启动，无需手动操作；如需临时断开可「停用隧道」（状态持久化，直到手动启用）；本机回环端口按分配结果（起始 `14100`/`14101`）经 `127.0.0.1:<端口>` 访问各节点 opencode / agent

### 4.2 CLI（node-ctl）

```bash
node node-ctl/cli.js list                 # 节点列表与在线状态
node node-ctl/cli.js visitors-config      # 生成主控侧 frpc visitors 配置
node node-ctl/cli.js start|stop|restart <node>
node node-ctl/cli.js dispatch <node> "任务内容"
```

控制端配置文件为 `node-ctl/nodes.json`（含 Hub 连接与各节点 token），可用 App「导出控制端配置」从其他设备迁移。

### 4.3 opencode agent 集成（MCP / fleet）

- 将 `node --help` 所示 `node-ctl` 的 MCP 配置片段写入控制端 opencode 的 `mcp` 字段（App「编排」页可生成 fleet 片段）
- 推荐由控制端 opencode 通过 MCP 工具（fleet/node-ctl）完成跨设备编排；设备间任务遵循 [消息协议 v1](PROTOCOL.md)

### 4.4 Telegram（可选）

Bot 配置位于 `%APPDATA%\opencode-telegram-bot\`（Windows 控制端）。如 token 曾外露，请通过 BotFather `/revoke` 轮换，并用 App「Token 轮换」更新。

## 5. 升级

| 组件 | 操作 |
| --- | --- |
| Hub | `git pull` 后重跑 `sudo bash scripts/hub/install.sh`（幂等，密钥/数据保留） |
| 节点 | 更新代码/便携包 → App 中「停止节点」→「启动节点」（agent 自动使用新版本） |
| 控制端 | `git pull`；如依赖有变重跑 `npm install`；重启 App 或 CLI |

## 6. 卸载

```bash
# Hub
systemctl disable --now opencode-mesh-registry opencode-mesh-frps
rm -rf /opt/opencode-mesh /etc/opencode-mesh          # 数据与密钥，按需保留
```

节点：App 停止节点后，删除 `node-agent/data/`（注册状态）即完成退网；如需从注册表移除，可在任一已入网设备对 Hub 调用 `/admin/revoke`。

## 7. 故障排查

| 现象 | 排查顺序 |
| --- | --- |
| 节点注册失败 401/403 | 加入密钥是否有效/已被使用/已吊销 |
| 注册返回 409 | 该名称/ID 已被占用（全网唯一，防止冒名）：换个节点名，或先吊销占用方 |
| 改名后如何生效 | 保存后重启节点即自动同步显示名（注册 id 不变、无需新密钥）；控制端「同步节点」刷新列表 |
| 节点`在线`但不可达 | agent 是否运行 → agent 日志（组网页）→ frpc 是否拉起；Hub 的 frps 是否 active |
| 修改 opencode 密码未生效 | 保存时按其提示重启本机 opencode；远程节点到主控页重启对应节点 |
| 控制端同步后端口不通 | 重新「同步节点」（自动清理并更新隧道），必要时手动「启动隧道」；检查端口占用 |
| Hub 更换地址后节点失联 | 各节点在「组网」页更新 Hub 地址并重启节点；控制端重新同步 |
| 手机端无响应 | 确认 Telegram Bot 所在控制端的 opencode（如 `4096`）在运行、Bot 进程存活 |
| `findRepoRoot` 报找不到仓库 | 用便携包的 `start-app.sh` 启动，或设置环境变量 `OPENCODE_MESH_ROOT` 指向仓库根目录 |
