#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { loadConfig, getNode, agentCall, agentHealth, registryNodes, registryFrps } = require("./lib");

const USAGE = `opencode-mesh node-ctl

用法：
  node-ctl list                        列出节点（本地配置 + 注册表在线状态）
  node-ctl status <node>               查询节点 opencode 状态
  node-ctl start <node>                远程启动节点 opencode
  node-ctl stop <node>                 远程停止节点 opencode
  node-ctl restart <node>              远程重启节点 opencode
  node-ctl fleet-config                输出主控 opencode 的 fleet MCP 配置片段
  node-ctl visitors-config [--out p]   生成主控侧 frpc visitors 配置（stcp 接入）

选项：
  -c, --config <path>   指定 nodes.json（默认 ./nodes.json 或 node-ctl/nodes.json）
  -h, --help            显示帮助
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-c" || a === "--config") args.config = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "-h" || a === "--help") args.help = true;
    else args._.push(a);
  }
  return args;
}

async function cmdList(config) {
  const regNodes = await registryNodes(config.registry);
  const local = Object.keys(config.nodes || {});
  const all = new Set([...local, ...(regNodes || []).map((n) => n.name)]);
  if (!all.size) {
    console.log("（配置中没有节点，注册表也查不到）");
    return;
  }
  console.log("节点            在线      绑定端口(open/agent)  说明");
  for (const name of all) {
    const reg = (regNodes || []).find((n) => n.name === name);
    const localCfg = config.nodes?.[name];
    let reach = "";
    if (localCfg) {
      const h = await agentHealth(localCfg);
      reach = h.reachable ? `可达 v${h.version || "?"}` : "不可达";
    } else {
      reach = "（仅注册表）";
    }
    console.log(
      `${name.padEnd(15)} ${(reg ? (reg.online ? "在线" : "离线") : "-").padEnd(8)} ${String((reg?.opencodeRemotePort ?? "-") + "/" + (reg?.agentRemotePort ?? "-")).padEnd(21)} ${reach}`
    );
  }
}

async function cmdLifecycle(config, action, nodeName) {
  const node = getNode(config, nodeName);
  const endpoint = action === "status" ? "/opencode/status" : `/opencode/${action}`;
  const method = action === "status" ? "GET" : "POST";
  const timeout = action === "restart" ? 90000 : action === "start" ? 60000 : 30000;
  const r = await agentCall(node, method, endpoint, timeout);
  if (r.status === 401) {
    console.error(`失败：agent token 不正确（节点 "${nodeName}"）`);
    process.exitCode = 1;
    return;
  }
  if (r.status === 0) {
    console.error(`失败：无法连接 agent（${r.text}）\n提示：确认节点在线、visitor 已启动（agentUrl=${node.agentUrl}）`);
    process.exitCode = 1;
    return;
  }
  if (!r.json) {
    console.error(`失败：非 JSON 响应（${r.status}）：${r.text.slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }
  if (action === "status") {
    console.log(`节点 ${nodeName}: opencode ${r.json.running ? `运行中 (PID ${r.json.pid})` : "未运行"}`);
  } else {
    console.log(`节点 ${nodeName}: ${action} ${r.json.ok ? "成功" : "失败"}，opencode ${r.json.running ? `运行中 (PID ${r.json.pid})` : "未运行"}`);
    if (!r.json.ok) process.exitCode = 1;
  }
}

async function cmdFleetConfig(config) {
  const names = Object.keys(config.nodes || {});
  if (!names.length) {
    console.error("配置中没有节点");
    process.exitCode = 1;
    return;
  }
  const regNodes = await registryNodes(config.registry);
  const nodeArgs = names.map((name) => {
    if (config.nodes[name].opencodeUrl) return `"--node", "${name}=${config.nodes[name].opencodeUrl}"`;
    const reg = (regNodes || []).find((n) => n.name === name);
    if (reg) return `"--node", "${name}=http://127.0.0.1:${reg.opencodeRemotePort}"`;
    return null;
  });
  if (nodeArgs.includes(null)) {
    console.error("无法确定部分节点的 opencode URL：请在 nodes.json 为节点配置 opencodeUrl，或配置 registry 以便推导");
    process.exitCode = 1;
    return;
  }
  const password = config.fleetPassword || "REPLACE_WITH_SHARED_OPENCODE_PASSWORD";
  console.log(`将下面片段合并进主控 opencode.jsonc 的 "mcp" 字段（URL 为主控本机 visitor 推荐地址，需先启动 visitor）：

    "fleet": {
      "type": "local",
      "command": [
        "npx", "-y", "opencode-fleet",
        ${nodeArgs.join(",\n        ")},
        "--password", "${password}",
        "--timeout", "600"
      ]
    }

说明：
- 各节点 opencode 密码需一致（fleet 使用同一个 --password）
- stcp 模式下节点 URL 应使用主控本机 127.0.0.1:<绑定端口>（由 visitors-config 生成并启动）`);
}

async function cmdVisitorsConfig(config, outPath) {
  const regNodes = await registryNodes(config.registry);
  if (!regNodes) {
    console.error("无法从 registry 获取节点列表（检查 registry 配置与 adminToken）");
    process.exitCode = 1;
    return;
  }
  const frps = await registryFrps(config.registry);
  if (!frps) {
    console.error("无法从 registry 获取 frps 信息（需要 registry.adminToken）");
    process.exitCode = 1;
    return;
  }
  const wanted = Object.keys(config.nodes || {});
  const nodes = regNodes.filter((n) => (wanted.length ? wanted.includes(n.name) : true));
  if (!nodes.length) {
    console.error("没有可用节点（注册表中无节点，或本地配置未包含任何注册表节点）");
    process.exitCode = 1;
    return;
  }
  const sections = [];
  for (const n of nodes) {
    if (!n.stcpSecret) {
      console.error(`节点 ${n.name} 缺少 stcpSecret（需要在节点上重新注册：删除 node-agent/data/state.json 后重启 agent）`);
      process.exitCode = 1;
      return;
    }
    sections.push(`[[visitors]]
name = "${n.name}_opencode-visitor"
type = "stcp"
serverName = "${n.name}_opencode"
secretKey = "${n.stcpSecret}"
bindAddr = "127.0.0.1"
bindPort = ${n.opencodeRemotePort}
transport.useEncryption = true

[[visitors]]
name = "${n.name}_agent-visitor"
type = "stcp"
serverName = "${n.name}_agent"
secretKey = "${n.stcpSecret}"
bindAddr = "127.0.0.1"
bindPort = ${n.agentRemotePort}
transport.useEncryption = true`);
  }
  const toml = `# 由 opencode-mesh node-ctl visitors-config 生成
# 启动：frpc -c visitors.toml
serverAddr = "${frps.addr}"
serverPort = ${frps.port}
auth.method = "token"
auth.token = "${frps.token}"

${sections.join("\n\n")}
`;
  const target = outPath || path.join(__dirname, "visitors.toml");
  fs.writeFileSync(target, toml);
  console.log(`已生成 ${target}`);
  console.log("");
  for (const n of nodes) {
    console.log(`- ${n.name}: opencode → 127.0.0.1:${n.opencodeRemotePort}；agent → 127.0.0.1:${n.agentRemotePort}`);
  }
  console.log("");
  console.log("启动 visitor（示例）：");
  console.log(`  frpc -c "${target}"`);
  console.log("Windows 可用：", "scripts\\master\\start-visitors.ps1");
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args._.length) {
    console.log(USAGE);
    return;
  }
  const command = args._[0];
  try {
    const { config } = loadConfig(args.config);
    if (command === "list") return await cmdList(config);
    if (["status", "start", "stop", "restart"].includes(command)) {
      if (!args._[1]) {
        console.error(`${command} 需要节点名。用法： node-ctl ${command} <node>`);
        process.exitCode = 1;
        return;
      }
      return await cmdLifecycle(config, command, args._[1]);
    }
    if (command === "fleet-config") return await cmdFleetConfig(config);
    if (command === "visitors-config") return await cmdVisitorsConfig(config, args.out);
    console.error(`未知命令：${command}\n\n${USAGE}`);
    process.exitCode = 1;
  } catch (e) {
    console.error(`错误：${e.message}`);
    process.exitCode = 1;
  }
})();
