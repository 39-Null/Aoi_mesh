# opencode-mesh 便携包 · 安装说明（{{PLATFORM_NAME}}，v{{VERSION}}）

> 免安装：解压即用，不写注册表、不改系统环境变量；卸载 = 删除整个文件夹。

## 这是什么

多设备 opencode 协作网络的节点包：内置桌面应用（`app/`）+ 节点运行时（`opencode-mesh/`，含 node-agent / node-ctl / frpc）。

## 启动

1. 解压到任意目录（含中文/空格的路径亦可）
2. 双击 `{{START_CMD}}`（应用会自动找到同级的 `opencode-mesh/` 运行时目录）
3. 首次启动自动弹出「快速配置」向导：填写 节点名 / Hub 地址 / 加入密钥（启用 TLS 时形如 `密钥.指纹`，整串粘贴）/ opencode 端口与密码 → 「保存并启动节点」

## 前置条件

- 已安装 **opencode**（参考官方文档：https://opencode.ai/docs/ ），命令行 `opencode` 可用
- 已安装 **Node.js 18+**（node-agent 运行所需）
- 已获得：Hub 地址（公网 IP）、Hub 端口（默认 `18080`）、一次性加入密钥

## 目录结构

```
app/                  桌面应用（Electron 产物）
opencode-mesh/        节点运行时（仓库快照）
  ├─ node-agent/      ● 节点常驻代理（agent.js；bin/frpc.exe 已内置）
  ├─ node-ctl/        ● 控制端 CLI + MCP
  ├─ configs/         协作约定与示例配置
  ├─ scripts/         接入与运维脚本（join.ps1 等）
  └─ docs/            文档（部署 / 使用 / 协议 / 设计）
VERSION               版本号
{{START_CMD}}         启动入口
README-安装说明.md    本文件
```

## 完整性校验（可选）

使用发布页随附的 `SHA256SUMS` 校验（Windows：`certutil -hashfile <zip> SHA256`）。

## 卸载

1. 退出应用（「本机」页「退出」或托盘右键 → 退出应用）——本节点随之离线
2. 如需从网络移除：在任一已入网设备上对 Hub 调用 `/admin/revoke` 吊销本节点
3. 删除本目录即完成卸载（节点注册状态位于 `opencode-mesh/node-agent/data/`，如想保留请先备份）

## 常见问题

- **首次运行 SmartScreen 提示"未知发布者"**：本包未做代码签名，选「仍要运行」即可
- **frpc 已内置**（`opencode-mesh/node-agent/bin/frpc.exe`），无需额外下载
- **多台设备**：重复"解压 → 向导"即可入网；加入密钥一拍一用（在任一已入网设备的 App「主控」页生成）
- **开机自启（可选）**：`opencode-mesh/scripts/win/start-bot.vbs` 与 `autostart.ps1`（详见 docs/DEPLOY.md）
