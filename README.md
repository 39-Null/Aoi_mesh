# Aoi_mesh（opencode-mesh）

多设备 opencode 协作网络工具箱：把多台装有 [opencode](https://opencode.ai) 的机器组成一个可远程调度、互相协作的网络。

> **别名**：项目功能名为 `opencode-mesh`，个性化别名为 **`Aoi_mesh`**（启动命令/桌面图标/窗口标题均使用此名）。

- **脚本优先**：加入网络、维护隧道、启停服务全部由参数化脚本完成，Electron App 只是可选图形层
- **自托管**：只需一台有公网 IP 的服务器做中继，无第三方依赖，无域名也可用
- **可移植**：Windows / Linux，桌面 GUI 与 headless 模式共用同一内核与配置格式
- **平权组网**：任意设备注册入网后即可管理/邀请其他设备（无需管理员密钥）；节点服务零公网暴露（frp stcp）

## 仓库结构

```
opencode-mesh/
├─ docs/            # 设计与部署文档（DESIGN.md、TODO.md）
├─ node-app/        # 节点桌面应用（Electron）：本机诊断、组网、主控
├─ node-agent/      # 节点常驻代理：入网注册、frp 隧道、opencode 生命周期、受控 API
├─ node-ctl/        # 主控工具：CLI + MCP（远程启停节点 opencode / 生成隧道与 fleet 配置）
├─ hub/registry/    # 注册中心：加入密钥、注册、心跳、节点列表、吊销
├─ scripts/         # hub 安装、节点加入、启动别名（aliases/）
└─ configs/         # 示例配置（真实配置均被 .gitignore 排除）
```

## 快速开始（开发运行）

```bash
git clone <本仓库地址> && cd opencode-mesh
cd node-app && npm install        # 各设备按自己的平台安装依赖（node_modules 不跨平台复用）
npm start
```

- Windows：直接 `npm start`（或使用别名，见下）
- Linux：`npm start`（无显示环境下请用 node-agent headless / 便携包）
- 便携包（Deepin 等）：使用 `opencode-mesh-linux-kit`（含打包好的 App + `start-app.sh`）

## 启动别名 Aoi_mesh

**Windows**（安装到 PATH，任意终端可用）：

```powershell
copy scripts\aliases\Aoi_mesh.cmd "$env:APPDATA\npm\Aoi_mesh.cmd"
# 之后任意终端输入：Aoi_mesh
```

**Linux**：

```bash
chmod +x scripts/aliases/Aoi_mesh.sh
ln -s "$PWD/scripts/aliases/Aoi_mesh.sh" ~/.local/bin/Aoi_mesh
# 之后终端输入：Aoi_mesh（确保 ~/.local/bin 在 PATH）
```

桌面启动器（Linux）：编辑便携包内 `opencode-mesh.desktop.template`（Name 已为 Aoi_mesh）后复制到 `~/.local/share/applications/`。

## 多设备同步（Git 工作流）

1. 设备 A：`git add -A && git commit -m "..." && git push`
2. 设备 B：`git pull`（拉取后按需在 `node-app` 重新 `npm install`）
3. **注意**：`node_modules/`、`dist-*/`、运行时状态与全部密钥（`node.json`/`state.json`/`nodes.json` 等）均已被 `.gitignore` 排除——代码同步不等于配置同步，组网配置请在各自设备上通过 App 的「导出/导入」迁移

**Windows 认证**（密钥 id_ed25519，账户 39-Null；重启后跑一次）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\aliases\github-auth.ps1
```

**Linux 设备首次克隆**（Private 仓库需先加密钥；如 22 端口受限走 443）：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" -C "aoi-linux"
cat ~/.ssh/id_ed25519.pub    # 添加到 https://github.com/settings/keys
mkdir -p ~/.ssh && cat >> ~/.ssh/config <<'EOF'
Host github.com
  HostName ssh.github.com
  Port 443
  User git
EOF
git clone git@github.com:39-Null/Aoi_mesh.git
```

## 路线图

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 设计冻结 + 仓库重构 | ✅ |
| P1 | App v1.1 本机管理面板（诊断/日志/Token/图标）+ 组网与主控页 | ✅ |
| P2 | frp PoC + 节点 agent + NodeCtl（本地端到端已验证） | ✅ |
| P3 | Hub 安装脚本（RPM 优先）+ 实机部署验证 + stcp 零暴露 + 平权模型 | ✅ |
| P4 | 编排集成（opencode-fleet）+ 第二节点 join 验收 | 🚧 第二节点已入网，派发验收进行中 |
| P5 | Linux 便携包 + 开源化（文档/许可/CI） | 🚧 便携包已交付，CI 待补 |

## 文档

- [设计文档](docs/DESIGN.md) · [待办与已知问题](docs/TODO.md)

## 许可证

[MIT](LICENSE)
