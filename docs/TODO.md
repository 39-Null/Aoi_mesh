# 待办与已知问题（TODO）

> 更新：2026-10-14（协议 v1 + 界面/同步修复 + 文档规范化）

## P6 · 界面与同步修复 + 文档规范化（2026-10-14）

- [x] 移除「生成加入密钥」按钮（改由脚本/接口手动处理；registry 端点保留兼容）
- [x] 节点 opencode 密码修改改为两次输入校验（仅前端逻辑，不一致不保存）
- [x] 全部可展开内容支持折叠：诊断结果、日志尾部、agent 日志、visitor 日志、fleet 配置片段（均带「收起」）
- [x] 改名自动适配：agent 记录注册时的名称，启动时检测不一致自动以新名称重新注册并输出指引；App 节点状态显示黄色警示（重置身份 + 新密钥流程）
- [x] 「同步节点」增强：自动清理注册表中已失效节点、自动更新隧道配置、隧道运行中自动重启；结果提示新增/清理数量
- [x] 文档规范化：README 重写（中性命名）；新增 docs/DEPLOY.md（部署与运维）、docs/USAGE.md（使用手册）；DESIGN 修订至 v0.4
- [ ] 下一批：Deepin 设备同步新版 App（重打包 kit 或 git pull + npm install）
- [ ] 手机 Telegram 实测："让 deepin-1 执行 xxx 并汇报"（沿用 P4 遗留）

## P1 · Linux 便携包"直接运行二进制"找不到仓库 —— ✅ 已修复（重打包合并）

- 修复内容：`mesh-core.findRepoRoot()` 多候选探测（env → 仓库内 → 便携包 resources 布局 → execPath/cwd 向上搜索）；提示升级；`getNodeConfig` 判定收紧
- 已随 Linux kit 重打包合并；Deepin 侧仍建议统一用 `./start-app.sh` 启动（双击亦可工作）

## P2 · 跨平台收口点 —— ✅ 已完成

- [x] `.gitignore` 追加 `dist-*/`
- [x] 新增 `.gitattributes`（EOL 护栏）
- [x] 操作文档迁移章节注明"node_modules 不可跨平台拷贝"
- [x] Linux kit 精简（scripts 仅带 `hub/install.sh`）+ `pack-linux.js`：输出改绝对路径（修污染）、打包前临时移出 `icon.ico`（确定性排除）

## P3 · 平权模型 —— ✅ 已部署到 Hub 并验证

- [x] registry：`/nodes`、`/admin/frps`、`/admin/keys`、`/admin/revoke` 接受任意注册节点凭据（admin 兼容）
- [x] App/CLI：无管理密钥时回退本机节点凭据；Hub 地址单点双写（node.json ↔ nodes.json.registry）
- [x] 信息架构重组（配置→组网、操作→主控、控制端可选卡）
- （注：原「生成加入密钥」按钮已于 P6 移除，改由脚本/接口手动处理）

## P5 · 仓库与别名

- [x] GitHub Private 仓库 `Aoi_mesh` 建立并完成首次推送（多设备同步用）
- [x] 启动别名 `Aoi_mesh`：Windows 已安装到 PATH（%APPDATA%\npm）；Linux 脚本见 `scripts/aliases/Aoi_mesh.sh`
- [x] 密码保存竞态修复 + agent 配置热重载 + 「本机 opencode 即刻重启」IPC（密码变更 1 秒热生效）
- [x] Linux kit 已随全部修复重新打包（隔离/无污染，asar 6 项干净）

## P4 · 跨设备验收 —— ✅ 全部通过（2026-10-14）

- [x] deepin-1 加入网络（注册表:在线、隧道:可达）
- [x] 远程生命周期：本机远程停止/启动 deepin-1 的 opencode ✓
- [x] 统一密码 `20060210bai` 对齐（修复保存竞态 + agent 配置热重载后两端生效）
- [x] 任务派发与回收：向 deepin-1 派发 `uname -a`，3.5s 回收真实输出（bzw-PC / Deepin 内核信息）✓
- [x] fleet 编排集成：主控 4096 注入 fleet + NodeCtl MCP；`fleet_list_nodes` 双节点在线（173/227ms）、`fleet_node_health` 正常 ✓
- [ ] （建议）手机 Telegram 实测："让 deepin-1 执行 xxx 并汇报"
- [ ] BotFather `/revoke` 后，用 App「Token 轮换」换新 token

