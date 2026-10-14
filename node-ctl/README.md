# node-ctl（opencode-mesh 节点控制器）

让主控电脑具备「列出节点 / 远程启停其它设备 opencode」的能力。两种形态共用同一份配置：

- **MCP 服务器**：接入主控 opencode，agent 原生调用（推荐）
- **命令行 CLI**：零依赖，任何终端可用

## 工作模式（stcp）

节点服务**不暴露公网端口**。主控侧运行一个常驻 frpc **visitor**，把各节点服务映射到主控本机回环端口（默认 14100/14101…），node-ctl 通过 `127.0.0.1:<端口>` 访问。

```
主控本机 127.0.0.1:14101 ─ visitor(frpc) ─ Hub:17000 ─ stcp 隧道 ─ 节点 agent
主控本机 127.0.0.1:14100 ─ visitor(frpc) ─ Hub:17000 ─ stcp 隧道 ─ 节点 opencode
```

## 配置

复制 `configs/nodes.example.json` 为 `node-ctl/nodes.json`（或任意路径，用 `-c` / `NODECTL_CONFIG` 指定）：

```json
{
  "registry": { "address": "你的Hub地址", "port": 18080, "adminToken": "注册中心管理员密钥" },
  "fleetPassword": "各节点统一的 opencode 密码",
  "nodes": {
    "node-a": {
      "agentUrl": "http://127.0.0.1:14101",
      "agentToken": "该节点的 agent token",
      "opencodeUrl": "http://127.0.0.1:14100"
    }
  }
}
```

**每项从哪来？**

| 字段 | 来源 |
| --- | --- |
| `agentUrl` / `opencodeUrl` | **主控本机回环地址**，端口为 visitor 绑定端口（见 registry `GET /nodes` 的 `agentRemotePort` / `opencodeRemotePort`） |
| `agentToken` | 在该节点上：`node-agent/data/state.json` 中的 `token` |
| `registry.adminToken` | Hub 上 `grep REGISTRY_ADMIN_TOKEN /etc/opencode-mesh/registry.env` |
| `fleetPassword` | 各节点 `node-agent/node.json` 中 `opencode.password`（建议全网统一） |

> stcp 密钥（`stcpSecret`）**不需要手动填写**：`visitors-config` 会经 registry（admin）自动拉取并生成 visitor 配置。

## 使用流程

```bash
# 1) 生成主控侧 visitor 配置（自动从 registry 拉取节点与 stcp 密钥）
node node-ctl/cli.js visitors-config

# 2) 启动 visitor（Windows）
powershell -ExecutionPolicy Bypass -File scripts\master\start-visitors.ps1
#   Linux/macOS: frpc -c node-ctl/visitors.toml

# 3) 日常操作
node node-ctl/cli.js list                # 节点清单 + 在线状态
node node-ctl/cli.js status  node-a      # 查询 opencode 状态
node node-ctl/cli.js start   node-a      # 远程启动
node node-ctl/cli.js stop    node-a      # 远程停止
node node-ctl/cli.js restart node-a      # 远程重启
node node-ctl/cli.js fleet-config        # 生成主控 fleet MCP 配置片段
```

节点增减后重新执行 `visitors-config` 并重启 visitor 即可。

## 接入主控 opencode（MCP）

在主控 `opencode.jsonc` 中加入：

```jsonc
{
  "mcp": {
    "node-ctl": {
      "type": "local",
      "command": ["node", "C:/path/to/opencode-mesh/node-ctl/mcp-server.js"]
    }
  }
}
```

之后主控 agent 即拥有工具：`node_list`、`node_status`、`node_opencode_start`、`node_opencode_stop`、`node_opencode_restart`。

## 安全说明

- `node-ctl` 只调用节点 agent 的**生命周期接口**，不提供任意命令执行
- visitor 仅绑定 `127.0.0.1`，不对外暴露；stcp 内容加密（`useEncryption`）
- `nodes.json` 含敏感凭据：不要提交到版本库（已在 .gitignore 中排除）
