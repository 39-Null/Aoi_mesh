# 待办与已知问题（TODO）

> 更新：2026-10-14（生命周期直连化）

## P10 · 生命周期直连化（2026-10-14）

- [x] PID 记账（`agent.pid`/`visitor.pid`）替代 netstat 端口探测：getNodeConfig / visitorStatus / start / stop 全链路去端口化（端口仅为配置值）
- [x] 停止前 cmdline 身份校验：PID 复用/第三方占用 → 拒杀并清理记录（绝不误杀）
- [x] App 打开：每次强制启动本机节点 + ensure 隧道；App 退出（before-quit，仅主实例）：停隧道 → 停节点 → 直报离线 → 12s 超时兜底
- [x] Hub 新增 `POST /offline`（token 认证，立即置离线）——已随本轮部署
- [x] Linux killTree 进程组回收；agent 自证 pidfile、优雅退出补杀 opencode
- [x] 升级垫片：无 pidfile 的旧版运行中 agent/隧道 → 端口+身份校验一次性接管记账并清扫幽灵进程
- [x] 实测：退出全清+即时离线（零残留、pidfile 清理、端口全关）、重开强制恢复、崩溃对账（孤儿 opencode/frpc 自动清扫）、squatter 拒杀不误伤、旧实例接管（含幽灵 frpc 8064 清除）
- [ ] 下一批：Deepin 同步新版（重打包 kit）

## P9 · 首次配置向导与托盘常驻（2026-10-14）

- [x] 首次使用向导：未配置时自动弹出（节点名/Hub/一次性密钥/opencode 端口与密码/agent 端口；密码留空自动生成；可「仅作为控制端使用」跳过；完成后自动保存并启动节点）
- [x] 托盘常驻：关闭窗口=最小化到系统托盘（首次气泡提示）；托盘菜单 显示主界面/退出应用；双击托盘恢复窗口
- [x] 单实例锁：重复启动自动唤起已有窗口（含托盘最小化状态）
- [x] 「本机」页新增「退出」按钮（彻底退出；agent/隧道为独立进程继续运行）
- [x] 实测：向导显隐/跳过、关窗隐藏（visibilityState=hidden 且应用存活）、app:quit 干净退出零残留、单实例验证
- [ ] 下一批：Deepin 设备同步新版（重打包 kit 或 git pull）

## P8 · id 身份模型与界面改版（2026-10-14）

- [x] registry：节点以不可变注册 id（=首次注册名）为键；名称（name）为可改显示标签（全网唯一）
- [x] `/register`：同密钥恢复并同步显示名；新注册重名 409（修复同名冒领 token 的隐患）；心跳按 token 定位（改名不影响）
- [x] `/rename`：仅更新显示名（id/token/密钥/端口全部保留）
- [x] agent：state.id 固定；frpc 代理名改用 id（改名对隧道零影响）；日志/心跳适配
- [x] 主控/CLI/MCP：节点表按 id 键、显示 name；全部命令支持「id 或显示名」寻址；导入兼容旧格式
- [x] App：组网页新增「注册 id」固定展示（未注册有回退推断）；窗口加宽至 620；主控节点列表改卡片式（名称+徽标+id+端口/隧道+操作）
- [ ] 测试：Hub 实测 + fixture e2e + UI 截图 + 真实节点重启（进行中）
- [ ] 下一批：Deepin 设备同步新版

## P7 · 身份模型与隧道自动化（2026-10-14）

- [x] 身份模型：节点名=可变标签（全网唯一），注册 token=不可变唯一身份
- [x] registry `POST /rename`：token 认证；保留 token / stcpSecret / 端口分配；加入密钥 usedBy 跟随；重名 409；已部署至 Hub 并实测（迁移/保留/冲突/清理全通过）
- [x] agent：启动时以 token 自动迁移/确认名称（幂等；兼容旧状态与旧版 Hub 回退；名称冲突每 30s 重试并提示）
- [x] 隧道全自动：`ensureVisitor` 按需生成/启动/更新；「同步节点」自动刷新重启；App 启动自动拉起；手动停用持久化（`visitorPaused`）
- [x] App UI：隧道卡片收敛为「开关 + 日志」；修复 withBusy 还原文案覆盖刷新文案的问题
- [x] 实测：Hub 一次性节点改名（端口 14104/14105、token 前缀一致）、fixture agent 端到端改名（令牌/端口保留、日志记录、零残留）、App 自动拉起与开关切换
- [ ] 下一批：Deepin 设备同步新版（重打包 kit 或 git pull）→ 用真实改名/隧道验证

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

