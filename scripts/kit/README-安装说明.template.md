# opencode-mesh 便携包 · 安装说明（{{PLATFORM_NAME}}，v{{VERSION}}）

> 免安装：解压即用，不写注册表、不改系统环境变量；卸载 = 删除整个文件夹。

## 这是什么

多设备 opencode 协作网络的节点包：内置桌面应用（`app/`）+ 节点运行时（`opencode-mesh/`，含 node-agent / node-ctl / frpc）。

## 启动

1. 解压到任意目录（含中文/空格的路径亦可）
2. 双击 `{{START_CMD}}`（应用会自动找到同级的 `opencode-mesh/` 运行时目录）
3. 首次启动自动弹出「快速配置」向导：填写 节点名 / Hub 地址 / 加入密钥（启用 TLS 时形如 `密钥.指纹`，整串粘贴）/ opencode 端口与密码 → 「保存并启动节点」

## 作为主控使用（可选）

若这台设备要"指挥"其它设备（如手机 Bot 所在的控制端）：

1. App「主控」页 →「同步节点（自动配置）」
2. App「设置」页 →「控制端」→「MCP 集成」→ 点「写入/更新 MCP 配置」（自动定位、备份、保格式；**纯节点设备无需此步**）
3. 重启本机 opencode 后生效；详细说明见 `opencode-mesh/docs/DEPLOY.md` §5.5

## 更新

- **应用内一键更新（推荐）**：App「设置」页 →「应用」→「版本与更新」→「检查更新」→「立即更新」——从 GitHub 拉取最新源码（运行时 + 界面）覆盖本机，**数据文件不受影响**；完成后自动重启节点并重载界面
- **引导期**（v1.3.0 → v1.4.0）：需手动安装一次本新版包（推荐**同目录覆盖**：把新包的 `app/` 与 `opencode-mesh/` 两个文件夹复制到旧目录；或把旧目录的 `node-agent/node.json`、`node-agent/data/`、`node-ctl/nodes.json` 拷到新目录）。此后版本均可在应用内更新
- **涉及 Electron 壳（`app/`）变更的版本**：按发布说明下载新版 kit，将 `app/` 覆盖到本目录（不会触碰数据文件）

## 准备三样信息（从哪里获取）

| 信息 | 是什么 | 从哪里获取 |
| --- | --- | --- |
| **Hub 地址**（端口默认 18080） | Hub 服务器的公网 IP 或域名 | ① 部署 Hub 的人；② Hub 服务器上执行 `grep REGISTRY_FRPS_ADDR /etc/opencode-mesh/registry.env`；③ 任一已入网设备的 App →「设置」页 →「Hub 连接」 |
| **一次性加入密钥** | 入网凭据；启用 TLS 时形如 `密钥.指纹`，**整串粘贴**；默认 72 小时有效、一拍一用 | ① 在 Hub 上按 `opencode-mesh/docs/DEPLOY.md`「§3 方式 A」的逐条命令生成；② 在任一已入网设备上按同文档「§3 方式 B」生成 |
| **网络统一密码** | 全网各节点一致的 opencode 访问密码（≥8 位；派发任务用它认证） | 全新网络：由你**自定**（向导必填，不会自动生成）；加入既有网络：向管理员/任一设备操作者索取现有密码 |

## 前置条件

- 已安装 **opencode**（参考官方文档：https://opencode.ai/docs/ ），命令行 `opencode` 可用
- 已安装 **Node.js 18+**（node-agent 运行所需）

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

使用分发时随附的 `SHA256SUMS` 校验（Windows：`certutil -hashfile <zip> SHA256`，与对应行比对）。

## 卸载

1. 退出应用（「本机」页「退出」或托盘右键 → 退出应用）——本节点随之离线
2. 如需从网络移除：在任一已入网设备上对 Hub 调用 `/admin/revoke` 吊销本节点
3. 删除本目录即完成卸载（节点注册状态位于 `opencode-mesh/node-agent/data/`，如想保留请先备份）

## 常见问题

- **首次运行 SmartScreen 提示"未知发布者"**：本包未做代码签名，选「仍要运行」即可
- **frpc 已内置**（`opencode-mesh/node-agent/bin/frpc.exe`），无需额外下载
- **多台设备**：重复"解压 → 向导"即可入网；加入密钥一拍一用（生成方式见 `opencode-mesh/docs/DEPLOY.md` §3）
- **开机自启（可选）**：`opencode-mesh/scripts/win/start-bot.vbs` 与 `autostart.ps1`（详见 docs/DEPLOY.md）
