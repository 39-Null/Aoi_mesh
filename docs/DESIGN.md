# OpenCode Mesh · 设计文档

- 版本：v0.3
- 状态：P3 已部署（平权模型）
- 许可：MIT

---

## 0. 修订摘要

- v0.1 → v0.2：技术选型拍板 **frp + opencode-fleet + 自研 node agent / NodeCtl**；统一 App"单代码多角色"；远程启动流程；MCP 自动写入（备份 + 回滚）；确认 Alibaba Cloud Linux / RPM 优先、无域名可用、仓库名 `opencode-mesh`
- v0.2 → v0.2.1：服务暴露改为 **frp stcp（visitor 模式）**——节点服务零公网暴露，仅 frp 控制口与注册中心端口公开；主控侧通过常驻 frpc visitor 以本机回环端口接入
- v0.2.1 → v0.3：**平权管理模型**（任意注册节点可管理/邀请/吊销，所有者密钥兼容保留）；App 信息架构重组（配置归「组网」、操作归「主控」、Hub 连接单点双写）；新增「生成加入密钥」；Linux 便携包与仓库定位增强（findRepoRoot）

## 1. 定位与设计原则

**一句话**：一个自托管、可 fork 的多机 opencode 协作工具箱——脚本为核心（单点真相），Electron App 为可选图形层。

| # | 原则 | 含义 |
| --- | --- | --- |
| R1 | 脚本优先 | 加入网络、起服务、配转发全部由参数化脚本完成；App 只是同一批逻辑的图形包装，fork 者可以完全不用 App |
| R2 | 自托管 | 用户自带服务器（任意云商/家中服务器）；不依赖任何第三方基础设施；**无域名也可用** |
| R3 | 最小依赖 | 节点侧零提权（frp 用户态转发）；主控编排复用 opencode 原生 MCP |
| R4 | 网络可插拔 | `NetworkProvider` 抽象；v1 参考实现 = frp stcp；WireGuard / Headscale / 自定义中继为候选实现 |
| R5 | 安全默认 | stcp 密钥 + useEncryption 内容加密、全链路密码保护、加入密钥可吊销、示例配置全部占位符、密钥不入库 |

## 2. 角色与术语

| 术语 | 定义 |
| --- | --- |
| **Hub** | 中枢服务器：frps + registry API |
| **节点 Node** | 任意装有 opencode 的机器，运行 node agent（脚本或 App） |
| **主控 Master** | 开启 master 开关的节点，负责向其他节点派发任务（可多个） |
| **加入密钥** | 一次性/可吊销密钥，节点凭它注册进网络 |
| **agent token** | 节点控制凭据（独立于加入密钥），用于远程启停本机 opencode |
| **stcp secret** | 注册时发放的每节点隧道密钥（frp stcp），主控凭它建立 visitor |
| **visitor** | 主控侧常驻的 frpc 进程，把节点服务映射到主控本机回环端口 |

## 3. 架构总图

```
[Hub · 用户自有服务器]  ← 公网仅开放: 22(SSH) + 17000(frp) + 18080(registry)
  ├─ frps（stcp 隧道服务端）
  └─ registry API（注册 / 心跳 / 吊销 / stcp 密钥与端口分配）
        ▲
        │ 各节点出站连接（NAT 友好，无需公网 IP）
   ┌────┴──────────────┬──────────────────┐
[主控节点]           [节点B]            [Linux 节点·headless]
 opencode + fleet     opencode           opencode
 frpc visitor ◀─ stcp 隧道 ──▶ 节点B frpc（stcp 代理，服务不暴露公网）
   └─ 本机 127.0.0.1:14100/14101 ……
 NodeCtl ──▶ 本机回环端口 ──▶ 隧道 ──▶ 节点B agent（start/stop/status）
 fleet_send_message ─▶ 本机回环端口 ──▶ 节点B opencode ──▶ 结果回收
```

**远程启动另一台设备的 opencode（核心场景）**：

1. 每台设备唯一必须常驻的是 **node agent**（轻量进程；桌面 = App 托盘，服务器 = headless 脚本）
2. agent 维持到 Hub 的出站隧道（stcp 代理），并暴露受控 API（仅 opencode 生命周期命令）
3. 主控通过 NodeCtl 工具（MCP 或 CLI）→ 本机 visitor 回环端口 → stcp 隧道 → 目标机 agent → `spawn opencode serve` → 健康检查 → 回报 ready
4. 随后 fleet 经同一链路向该节点 opencode 派发任务，结果原路回收

## 4. 统一 App（单代码库 · 单安装包 · 角色=配置）

- 同一 Electron 程序装在所有设备；行为由 `node.toml` 开关决定：
  `network.enabled` / `opencode`（总是） / `telegram.token`（可选） / `master.enabled`（可选）
- **GUI 壳 + headless 内核**：核心逻辑在共享 CLI 内核，Electron 仅为壳；Linux 服务器跑 headless 模式（同配置格式），fork 者可纯脚本使用
- **MCP 自动写入**：开启 master → 备份 `opencode.jsonc` → 合并注入 fleet + NodeCtl 配置 → 失败自动回滚；设置提供"仅生成片段"切换（默认自动）
- 托盘常驻（桌面设备）；systemd / 启动文件夹（服务器）
- **界面结构**（v1.3）：「组网」页承载**全部配置**（Hub 连接单点双写、本机节点身份、控制端可选配置与导出/导入）；「主控」页为**纯操作台**（节点同步与远程启停、**生成加入密钥**、隧道、fleet 片段）
- **多控制端 + 平权**：无固定主控；任意设备注册后即可管理全网（凭据平权，所有者密钥兼容）；控制端配置可导出/导入一键复制

### 4.1 节点配置文件（node.toml）

```toml
[server]
address = "hub.example.com:18080"  # Hub registry 地址
join_key = ""                      # 一次性加入密钥

[network]
provider = "frp-stcp"              # NetworkProvider 实现

[opencode]
port = 4096                        # 本机 opencode serve 端口
password = ""                      # 自动生成，强密码

[agent]
port = 41999                       # 受控 API 端口（仅生命周期命令）
token = ""                         # 注册时发放

[telegram]                         # 可选
enabled = false
token = ""
proxy = ""                         # 例：http://127.0.0.1:10090

[master]                           # 可选
enabled = false
```

## 5. Hub 设计

- `frps`：token 认证；**stcp 模式**（服务不由 frps 直接暴露端口，仅做加密中继）；有域名后可加 TLS
- **registry API**（Node.js 单进程；JSON 存储）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/register` | 加入密钥 → 校验 → 分配 stcp 密钥与绑定编号 → 返回节点配置 |
| POST | `/heartbeat` | 节点存活/版本上报 |
| GET | `/nodes` | 节点列表（**注册节点凭据**或所有者密钥；含 stcpSecret/token，供控制端生成 visitor） |
| GET | `/admin/frps` | frps 连接信息（注册节点凭据或所有者密钥） |
| POST | `/admin/keys` | 生成一次性加入密钥（注册节点凭据或所有者密钥） |
| POST | `/admin/revoke` | 吊销节点与密钥（注册节点凭据或所有者密钥） |

- 部署：`install.sh`（RPM 优先、DEB 兼容）、systemd 单元；安全组只需放行 **22 + 17000 + 18080**

## 6. 节点 agent 规格

- **agent API**（本机 `127.0.0.1:41999`，经 stcp 隧道 + visitor 供主控访问）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/opencode/start` | 启动 `opencode serve`（绑 127.0.0.1 + 密码） |
| POST | `/opencode/stop` | 停止（按端口找 PID 并终止） |
| POST | `/opencode/restart` | 重启 |
| GET | `/opencode/status` | 运行状态 / PID / 健康 |
| GET | `/health` | agent 自身健康 |

- 鉴权：Header `X-Agent-Token`（注册时发放，可吊销）
- **刻意不做任意命令执行**——agent 是钥匙，不是后门
- 看护：agent 对 opencode 做定期健康检查与自动重启（与现有 auto-restart 同款逻辑）

## 7. 编排层

- **opencode-fleet**（现成 MCP）：
  - `fleet_send_message` 异步派发（fire-and-forget）→ `fleet_get_session_status` 轮询 → `fleet_get_session_messages` 回收结果
  - `fleet_reply_permission` 远程批准/拒绝节点权限请求
- **NodeCtl**（自研小件）：
  - `node_opencode_start / stop / restart / status`、`node_list`
  - 形式：MCP（主控 opencode 原生调用）或 CLI（零依赖）
  - 另含 `visitors-config`：从 registry 拉取节点与 stcp 密钥，生成主控侧 frpc visitor 配置
- 典型手机流程：Telegram → 主控 opencode → NodeCtl 启动节点 → fleet 派发 → 汇总回复

## 8. 安全设计

| 威胁 | 对策 |
| --- | --- |
| 公网端口扫描 | **stcp：节点服务零公网暴露**；公网仅 frp 控制口（token）与 registry（admin/join 密钥） |
| 隧道窃听 | stcp secretKey + `transport.useEncryption` 内容加密（双向一致） |
| 加入密钥泄露 | 一次性密钥 + 可吊销 + 注册留痕 |
| 节点被越权操作 | agent 仅生命周期命令 + agent token；opencode `permission` 模板（deny 默认；ask → 主控远程批） |
| 主控侧访问 | visitor 仅绑定 127.0.0.1（不回环外暴露）；stcp 密钥仅存节点本地与 registry（admin 可见） |
| 开源泄露 | 示例全部占位符；`.gitignore` 覆盖 `.env`/密钥/`nodes.json`/`state.json`；真实配置只存本地 |
| 管理权限模型 | **平权**（v0.3）：任意注册节点可管理/邀请/吊销；所有者密钥兼容保留，可按需收紧 |

## 9. 网络后端抽象（为 fork 者预留）

```
NetworkProvider 接口：
  join(key) / leave()
  status() -> {online, latency}
  exposeLocal(port) -> remoteEndpoint
  connectRemote(nodeKey) -> localPort
```

- v1 实现：**frp stcp**（零提权；服务零暴露；自动重连）
- 候选实现（文档路线）：WireGuard 自管（通用 IP 层）、Headscale（P2P + ACL）、SSH 反向隧道、自定义 WS 中继

## 10. 部署与验收

- **Hub**：Alibaba Cloud Linux / CentOS 优先（RPM），Ubuntu / Debian 兼容；`install.sh` 幂等可重跑
- **节点**：Windows（启动文件夹 / 计划任务）、Linux（systemd）；无域名、无公网 IP、家庭 NAT 均可加入
- **安全组**：仅 22 / 17000 / 18080 三个端口
- **验收标准**：全新机器从零到"节点在线且可被派发任务" ≤ 10 分钟

## 11. 路线图

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 设计冻结（本文档）+ 仓库重构为 opencode-mesh | ✅ |
| P1 | node-app v1.1：本机管理面板（诊断 / 日志 / Token 轮换 / 图标 / 设备卡片布局） | ✅ |
| P2 | frp PoC + node agent + NodeCtl（CLI/MCP，本地端到端验证） | ✅ |
| P3 | Hub 安装脚本 + 阿里云实机部署 + stcp 零暴露改造（公网全链路验证） | ✅ |
| P4 | 编排集成（fleet）+ 第二节点 join 验收（手机全链路） | ⏳ |
| P5 | Linux 节点支持 + 开源化（README / LICENSE / CI） | ⏳ |

## 12. 开放问题

- LICENSE 文件在 P5 补齐（MIT）
- Hub 的 Docker 部署作为 P5 可选交付
- 多主控场景的冲突策略（同一节点被两个主控派发）在 P4 讨论
- 主控侧 visitor 进程的常驻管理（自动启动/看护）随 P4 的 App 化一并处理

---

## 附录 A · 参考部署环境

> 供运维参考，不含任何密钥。

- 参考 Hub：Alibaba Cloud Linux 3，frps(17000) + registry(18080)，systemd 单元 `opencode-mesh-frps` / `opencode-mesh-registry`
- 节点 App 位置：`node-app/`（Electron 44.7.1，Node.js 22.23.2）
- 节点 agent：`node-agent/`（配置 `node.json`，状态 `data/state.json`，日志 `data/agent.log`）
- bot 配置与日志目录：`%APPDATA%\opencode-telegram-bot\`（`.env`、`logs/`、`settings.json`）
- 开机自启：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\opencode-telegram-bot.vbs`
- 桌面快捷方式：`opencode-mesh 节点.lnk`
- opencode serve 端口：`4096`（本机回环）

## 附录 B · 术语对照（中英）

| 中文 | 英文 | 说明 |
| --- | --- | --- |
| 中枢 | Hub | 用户自托管服务器 |
| 节点 | Node | 装入网络的设备 |
| 主控 | Master | 派发任务的节点 |
| 加入密钥 | Join Key | 节点注册凭据 |
| 节点代理 | node agent | 常驻的节点管理进程 |
| 访客端 | visitor | 主控侧的 stcp 接入进程 |
