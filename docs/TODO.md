# 待办与已知问题（TODO）

> 更新：2026-10-15（MCP 集成一等化）

## P18 · MCP 集成一等化（2026-10-15）

- [x] node-ctl MCP 补齐为 **13 工具**（新增：node_health / node_list_sessions / node_session_messages / node_permissions / node_reply_permission / node_interrupt / node_reset；密码经加密存储解封）
- [x] App「主控」页新增 **MCP 集成卡片**：状态检测（已配置/路径失效/未配置/未找到）、一键写入/更新（jsonc-parser 保注释保格式）、**手动路径兜底**（记忆路径）、路径漂移一键修复、移除、写入前自动备份（`*.mesh-bak-*`）+ 校验回滚
- [x] 默认仅写 node-ctl，**自动移除 fleet 明文条目**；「保留 fleet 写入」为高级选项（fleet 剔除论证见 DEPLOY §5.5）
- [x] 本机实机切换完成：fleet 明文条目已移除（备份 `opencode.jsonc.mesh-bak-2026-10-15T11-03-19`）
- [x] 单测 16 项全过（保注释/迁移清理/幂等/漂移检测修复/移除/状态机）
- [x] **重启 opencode 验证完成**（2026-10-15 本机重启后实测）：工具集仅剩 `node-*` 13 个（fleet_* 已退出）；`node_health` 双节点健康 v1.19.0；`node_dispatch` → dev-node-1 `done`（回执 "mesh-e2e-ok"）；`node_list` 正常（含新注册设备 desktop-1，当前离线）
- [x] kit v1.3.0 重新打包（含 jsonc-parser 依赖打包修正与 MCP 卡片；桌面 zip 已更新，sha256 `957f4550…61db`）
- [ ] （后置）ELECTRON_RUN_AS_NODE：纯控制端免系统 Node 依赖
- [ ] （后置）DEPLOY 补充"合并链覆盖（项目级/托管配置）"的排查指引

## P17 · Windows 便携发行包（2026-10-15）

- [x] `node-app/pack-win.js`（Electron win32-x64 打包）+ `scripts/pack-kit.js` 统一组装（**白名单快照**：只带源码/文档/示例，绝不携带 node.json/nodes.json/visitors.toml/*.local.md/日志等本地运行时与凭据文件）
- [x] 产物：`opencode-mesh-win-v1.2.1.zip`（含 app/、opencode-mesh/ 运行时快照、内置 frpc.exe、start-app.cmd、README-安装说明、VERSION）+ `SHA256SUMS`；免安装（解压即用，无需环境变量/注册表）
- [x] 向导严谨化：密码**必填**（≥8 位，取消静默自动生成）；「组网」页凭据缺失时拦截并引导回向导；字段增加端口说明 tooltip
- [x] join.ps1 / join.sh 新增 `-OpencodePassword / --oc-password`（加入既有网络须统一；省略时生成随机并告警）
- [x] 操作文档重构（通用性）：DEPLOY §3 两条密钥获取路径逐条命令、§4.1 三样信息（Hub 地址/密钥/密码）逐步获取、§6.5 端口默认值来历与理由；USAGE 与 kit README 同步
- [x] 版本统一：App v1.3.0 / agent v0.2.0（agent 版本号随下次重启生效）
- [x] 打 tag `v1.3.0` 并推送（2026-10-15）
- [ ] GitHub Release 发布（web 端）：附件上传桌面 `opencode-mesh-win-v1.3.0.zip` 与 `SHA256SUMS`
- [ ] CI（GitHub Actions：tag 触发 win/linux 双平台构建）
- [ ] Linux kit 用 `scripts/pack-kit.js` 重新组装（替换现有手工拼装流程）

## P16 · 凭据加密存储与全网密码轮换（2026-10-15）

- [x] 新增 `node-agent/secret-store.js`：seal/unseal（Windows DPAPI 经 PowerShell 零依赖；Linux secret-tool 密钥环；无密钥环时 600 权限 `plain:` 回退并显式告警）
- [x] agent 启动自动迁移：node.json 明文 `opencode.password` → `passwordEnc`（dev-node-1 实测 `backend=dpapi` 迁移成功，文件无明文）
- [x] agent 内置改密接口 `POST /opencode/password`（token 鉴权；恒时比较旧密码；加密持久化；内部重启 opencode；解封失败时允许凭据恢复路径）
- [x] App 不再读取密码值：`changeNodePassword` 改走 agent 接口；`saveNodeConfig/saveMasterConfig` 落盘即封存；导出解封/导入封存；`getNodeConfig` 仅暴露 `hasPassword`
- [x] node-ctl：dispatch 从加密存储解封密码；新增 `node_dispatch` MCP 工具（信封+回执，替代 fleet 明文 --password 路径）
- [x] 全网统一密码轮换为 `20181123`（不落文档）：dev-node-1（agent 接口链路）、deepin-1（随更新写入）、nodes.json（密文）、主控 opencode.jsonc（fleet --password）
- [x] deepin-1 更新与恢复在线：固定 commit `65d55e0` + sha256 校验通过 → 覆盖代码 → 写指纹/密码 → 重启 agent（旧实例带旧密码被新 agent 拒绝接管，重启 opencode 完成切换）→ TLS 心跳恢复"在线"
- [x] E2E：node-ctl dispatch（加密存储解封 → Basic → 信封 → 回执）全链路到 deepin-1 成功
- [x] 发现并处置：旧版 App（11:50 启动，早于本次改造）的「保存/同步」会用输入框残留旧密码明文覆盖 nodes.json（15:43 发生一次）→ 已修复为密文 + 记录根因
- [ ] 用户操作：**重启桌面 App**（加载新版前端；旧版保存会污染配置，重启前勿点保存/同步）；重启主控 opencode（使 fleet 读取新密码与 node_dispatch 生效）
- [ ] （可选）git 历史中的旧密码 `20060210bai`（已失效）与公开仓库历史：如需彻底清除可做历史重写（breaking，需全设备重新克隆）

## P14 · 统一安全加固批次（2026-10-15）

- [x] `/register` 原型链绕过修复：keys/nodes 改无原型对象 + `hasOwnProperty` 校验 + 密钥格式白名单（hex）——E2E 已验证 `__proto__/constructor/toString` 等全部 403
- [x] registry TLS：install.sh 自签证书生成、`/health` 上报指纹、`/admin/keys` 返回 `密钥.指纹` 组合串
- [x] 客户端指纹钉扎：agent / node-ctl / App 三端 `pinnedRequest`（握手完成、发送数据前校验 SHA-256；错误指纹立即拒绝）——TLS E2E 通过
- [x] 加入密钥 TTL（默认 72h，`REGISTRY_JOIN_KEY_TTL_HOURS`，旧密钥无 expiresAt 兼容；恢复注册不受限）——E2E 通过
- [x] 审计日志（注册/改名/离线/密钥签发/吊销/鉴权失败；0600 权限）
- [x] Hub 降权：registry/frps 专用非 root 服务用户（chown 数据/日志/证书目录）
- [x] agent 加固：token 恒时比较；opencode 显式 `--hostname 127.0.0.1`
- [x] 敏感文件权限收紧：node.json/state.json/nodes.json/visitors.toml/frpc.toml/data.json（chmod 600 / icacls）
- [x] 组合串解析：App 组网/向导、join.ps1、join.sh（`密钥.指纹` → joinKey 拆出 + hub.fingerprint 落盘）
- [x] 文档同步：DEPLOY（TLS/迁移顺序/字段/FAQ）、USAGE、DESIGN v0.11
- [x] 实机部署（2026-10-15）：Hub 升级完成（TLS 指纹 `f07238a5…10b4b`；registry/frps 降权为 opencode-mesh 用户；证书保留重跑）
- [x] dev-node-1 切换钉扎：node.json / nodes.json 写入指纹 + agent 重启 → 注册/心跳经钉扎 HTTPS、visitor 数据面握手（open/agent 均 200）、node-ctl list 正常、审计零 auth_fail
- [x] install.sh 修复：`enable --now` 不会重启运行中的服务（升级场景失效）→ 改为显式 `systemctl restart`
- [x] 公网暴露核对：firewalld 未启用；外部探测仅 17000/18080 可达，14100+ 段全部丢包（安全组已阻断）
- [x] deepin-1 更新并恢复在线（2026-10-15，见 P16：固定 commit + 哈希校验 → 覆盖代码 → 指纹/密码 → 重启；心跳恢复"在线"）
- [ ] 重启桌面 App 加载新版前端（齿轮改密、组合密钥、加密存储保留逻辑）与主控 opencode（fleet 新密码）
- [ ] （缓做）frps 控制口 TLS；SSH 一次性加固核对清单

## P13 · 密码修改流程重构（2026-10-15）

- [x] 「组网」页移除内联「新密码 / 确认密码」输入；「opencode」行新增 **⚙ 修改密码** 齿轮入口（弹窗）
- [x] 验证确认：修改需输入**原密码（网络共用密码）**——与本机 node.json 现值比对（Hub 不存密码/指纹，验证在节点本机完成）
- [x] 校验规则：新密码 ≥8 位、两次一致、不得与原密码相同；错误均有明确提示
- [x] mesh-core 新增 `changeNodePassword`（主进程内验证与写入）+ IPC `mesh:node:changePassword`
- [x] 通过后 agent 运行中经本机回环立即重启 opencode 生效（复用 restartLocalOpencode）
- [x] 功能自测：错原密码 / 短新密码 / 同密码三拒绝 + 正常修改落盘 `restarted:false`（无 agent 场景）
- [x] 文档同步：USAGE（入口步骤 + FAQ 两行）、DEPLOY §6 字段表、DESIGN v0.10 修订
- [ ] 实测：真实设备齿轮改密 → 重启 opencode 生效 → 主控派发用新密码验证；双节点统一密码逐台对齐

## P12 · 命名统一与可移植性文档重构（2026-10-15）

- [x] 协议标记更名 opencode-mesh（信封/回执/澄清块；node-ctl 解析兼容旧 aoi-mesh 标记）
- [x] 协作约定更新（configs/agent-mesh-instructions.md：新标记 + 旧标记过渡兼容说明）
- [x] 文档命名统一：功能性名称 opencode-mesh；界面展示名保留 Aoi mesh（窗口标题/托盘/向导/导入提示）
- [x] DEPLOY.md 重构：架构与网络流/数据流、一键化速查、App 安装/卸载引导、配置字段逐项教学、opencode 官方文档外链
- [x] DESIGN 增补 §3.1 数据流与网络流（三条链路时序图）；README 快速开始改为三角色最短路径
- [x] 新增 Linux 节点接入脚本 scripts/node/join.sh；join.ps1 支持 frpc 自动获取（-FrpVersion / -FrpLocalZip）
- [x] start-bot.vbs 相对路径化（不再硬编码绝对路径；支持 OPENCODE_MESH_ROOT 回退）
- [x] install.sh 防火墙修正：stcp 模式不再放行 14100-19998（公网入向仅 17000/18080）
- [ ] 各节点同步新版协作约定（git pull + 重启节点 opencode 会话）
- [ ] 桌面 issue（opencode-mesh-未来发展方向企划）已同步命名，待抄送为 GitHub Issue

## P11 · 主控状态自动化（2026-10-14）

- [x] 主控节点卡片新增 opencode 运行状态徽标（在「在线」之后：`opencode 运行中 PID x` / `opencode 已停止` / `状态未知`），自动刷新（8s 原位更新 + 操作后立即刷新）
- [x] 移除「状态」手动查询按钮（由自动刷新替代）
- [x] 窗口初始宽度 620→580（minWidth 520）
- [x] 实测：徽标渲染、停止/启动按钮联动徽标即时更新（PID 变化可见）、无重建闪烁（原位更新）
- [ ] 下一批：Deepin 同步新版（重打包 kit 或 git pull）

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
- [x] 统一密码对齐（修复保存竞态 + agent 配置热重载后两端生效；真实密码不落文档）
- [x] 任务派发与回收：向 deepin-1 派发 `uname -a`，3.5s 回收真实输出（bzw-PC / Deepin 内核信息）✓
- [x] fleet 编排集成：主控 4096 写入 fleet + NodeCtl MCP 配置；`fleet_list_nodes` 双节点在线（173/227ms）、`fleet_node_health` 正常 ✓
- [ ] （建议）手机 Telegram 实测："让 deepin-1 执行 xxx 并汇报"
- [ ] BotFather `/revoke` 后，用 App「Token 轮换」换新 token

