# 待办与已知问题（TODO）

> 更新：2026-10-14（平权模型 + 信息架构重组 + Linux 重打包）

## P1 · Linux 便携包"直接运行二进制"找不到仓库 —— ✅ 已修复（本次重打包合并）

- 修复内容：`mesh-core.findRepoRoot()` 多候选探测（env → 仓库内 → 便携包 resources 布局 → execPath/cwd 向上搜索）；提示升级；`getNodeConfig` 判定收紧
- 本次已随 Linux kit 重打包合并；Deepin 侧仍建议统一用 `./start-app.sh` 启动（双击亦可工作）

## P2 · 跨平台收口点 —— ✅ 已完成

- [x] `.gitignore` 追加 `dist-*/`
- [x] 新增 `.gitattributes`（EOL 护栏）
- [x] 操作文档迁移章节注明"node_modules 不可跨平台拷贝"
- [x] Linux kit 精简（scripts 仅带 `hub/install.sh`）+ `pack-linux.js`：输出改绝对路径（修污染）、打包前临时移出 `icon.ico`（确定性排除）

## P3 · 平权模型（本轮已实施）

- [x] registry：`/nodes`、`/admin/frps`、`/admin/keys`、`/admin/revoke` 接受任意注册节点凭据（admin 兼容）
- [x] App/CLI：无管理密钥时回退本机节点凭据；Hub 地址单点双写（node.json ↔ nodes.json.registry）
- [x] App：「生成加入密钥」按钮（主控页，复制剪贴板）；信息架构重组（配置→组网、操作→主控、控制端可选卡）
- 已部署到 Hub 并验证：本地鉴权 6/6、真实 Hub 纯节点凭据通过、夹具全链路通过、应用内生成密钥+剪贴板通过

## P5 · 仓库与别名

- [x] GitHub Private 仓库 `Aoi_mesh` 建立并完成首次推送（多设备同步用）
- [x] 启动别名 `Aoi_mesh`：Windows 已安装到 PATH（%APPDATA%\npm）；Linux 脚本见 `scripts/aliases/Aoi_mesh.sh`
- [ ] 下次 Linux kit 重打包时：同步密码热重载修复版 App + README 别名说明

## P4 · 待办（用户侧 / 下一步）

- [x] deepin-1 已加入网络（注册表:在线、隧道:可达）
- [x] 远程生命周期验收通过：从本机远程停止 deepin-1 的 opencode（20644→停）并重新启动（新 PID 21087）；dev-node-1 对照正常
- [ ] **统一 opencode 密码**：两台 App「组网」页密码栏填入同一新值 → 保存配置 → 停止/启动节点（当前 dev-node-1=旧测试值、deepin-1=自动随机值，派发鉴权 401）
- [ ] 任务派发验收：`p4-dispatch.js`（自动读取本机统一密码）→ 向 deepin-1 发任务并回收结果
- [ ] 共享密码同步：将「控制端」卡 fleetPassword 设为统一密码 + 重新生成 fleet 片段
- [ ] BotFather `/revoke` 后，用 App「Token 轮换」换新 token

