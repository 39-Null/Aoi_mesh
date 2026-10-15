#!/usr/bin/env node
/**
 * opencode-mesh node-ctl MCP server（stdio, 零依赖）
 * 让主控 opencode 原生拥有“列出节点 / 远程启停节点 opencode”的能力。
 */
const { loadConfig, getNode, agentCall, agentHealth, registryNodes, dispatchToNode } = require("./lib");

const SERVER_INFO = { name: "opencode-mesh-node-ctl", version: "0.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

const NODE_PROP = {
  node: { type: "string", description: "节点名（nodes.json 中 nodes 字段的 key）" },
};

const TOOLS = [
  {
    name: "node_list",
    description: "列出所有协作网络节点：本地配置、注册表在线状态、经隧道的可达性与 opencode 端口。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "node_status",
    description: "查询某个节点的 opencode 运行状态（是否运行、PID），经 Hub 隧道访问该节点的 agent。",
    inputSchema: { type: "object", properties: { ...NODE_PROP }, required: ["node"] },
  },
  {
    name: "node_opencode_start",
    description: "远程启动某个节点上的 opencode 服务器（经 Hub 隧道调用该节点的 agent）。",
    inputSchema: { type: "object", properties: { ...NODE_PROP }, required: ["node"] },
  },
  {
    name: "node_opencode_stop",
    description: "远程停止某个节点上的 opencode 服务器。",
    inputSchema: { type: "object", properties: { ...NODE_PROP }, required: ["node"] },
  },
  {
    name: "node_opencode_restart",
    description: "远程重启某个节点上的 opencode 服务器。",
    inputSchema: { type: "object", properties: { ...NODE_PROP }, required: ["node"] },
  },
  {
    name: "node_dispatch",
    description:
      "向指定节点派发任务（opencode-mesh 信封 + 回执解析，自动复用会话；共享密码经加密存储解封后使用，不走 fleet 的明文 --password）。" +
      "返回：task id、状态（done/partial/failed）、摘要与产物路径。",
    inputSchema: {
      type: "object",
      properties: {
        ...NODE_PROP,
        task: { type: "string", description: "任务正文（自然语言）" },
        mode: { type: "string", enum: ["one-shot", "session"], description: "one-shot=执行完即止（默认）；session=允许继续多轮" },
        newSession: { type: "boolean", description: "true=强制开启新会话（默认复用）" },
      },
      required: ["node", "task"],
    },
  },
];

async function toolNodeList() {
  const { config } = loadConfig();
  const regNodes = await registryNodes(config.registry);
  const regs = regNodes || [];
  const keys = new Set([...Object.keys(config.nodes || {}), ...regs.map((n) => n.id || n.name)]);
  if (!keys.size) return "（配置中没有节点，注册表也查不到）";
  const lines = ["节点 | 注册表 | opencode端口 | agent端口 | 隧道可达性"];
  for (const key of keys) {
    const reg = regs.find((n) => (n.id || n.name) === key) || null;
    const localCfg = config.nodes?.[key] || (reg?.name ? config.nodes?.[reg.name] : null) || null;
    const display = reg?.name || localCfg?.name || key;
    const label = display === key ? key : `${display} (${key})`;
    let reach = "（仅注册表）";
    if (localCfg) {
      const h = await agentHealth(localCfg);
      reach = h.reachable ? `可达 v${h.version || "?"}` : "不可达";
    }
    lines.push(
      `${label} | ${reg ? (reg.online ? "在线" : "离线") : "-"} | ${reg?.opencodeRemotePort ?? "-"} | ${reg?.agentRemotePort ?? "-"} | ${reach}`
    );
  }
  return lines.join("\n");
}

async function toolLifecycle(nodeName, action) {
  const { config } = loadConfig();
  const node = getNode(config, nodeName);
  const endpoint = action === "status" ? "/opencode/status" : `/opencode/${action}`;
  const method = action === "status" ? "GET" : "POST";
  const timeout = action === "restart" ? 90000 : action === "start" ? 60000 : 30000;
  const r = await agentCall(node, method, endpoint, timeout);
  if (r.status === 401) throw new Error(`agent token 不正确（节点 "${nodeName}"）`);
  if (r.status === 0) throw new Error(`无法连接 agent：${r.text}（agentUrl=${node.agentUrl}）`);
  if (!r.json) throw new Error(`非 JSON 响应（${r.status}）：${r.text.slice(0, 200)}`);
  if (action === "status") {
    return `节点 ${nodeName}: opencode ${r.json.running ? `运行中 (PID ${r.json.pid})` : "未运行"}`;
  }
  return `节点 ${nodeName}: ${action} ${r.json.ok ? "成功" : "失败"}，opencode ${r.json.running ? `运行中 (PID ${r.json.pid})` : "未运行"}`;
}

async function callTool(name, args) {
  switch (name) {
    case "node_list":
      return await toolNodeList();
    case "node_status":
      return await toolLifecycle(args.node, "status");
    case "node_opencode_start":
      return await toolLifecycle(args.node, "start");
    case "node_opencode_stop":
      return await toolLifecycle(args.node, "stop");
    case "node_opencode_restart":
      return await toolLifecycle(args.node, "restart");
    case "node_dispatch": {
      const { path: cfgPath, config } = loadConfig();
      const res = await dispatchToNode(cfgPath, config, args.node, String(args.task || ""), {
        newSession: !!args.newSession,
        mode: args.mode || "one-shot",
        timeoutSec: 300,
      });
      const lines = [`任务 ${res.task} → ${args.node}［${res.status}］`, `摘要：${res.summary || "(空)"}`];
      if (res.artifacts) lines.push(`产物：${res.artifacts}`);
      return lines.join("\n");
    }
    default:
      throw new Error(`未知工具：${name}`);
  }
}

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === "notifications/initialized" || method?.startsWith("notifications/")) {
    return;
  }
  if (method === "ping") {
    return reply(id, {});
  }
  if (method === "tools/list") {
    return reply(id, { tools: TOOLS });
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      const text = await callTool(name, args);
      return reply(id, { content: [{ type: "text", text }] });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: `错误：${e.message}` }], isError: true });
    }
  }
  if (id !== undefined && id !== null) {
    return replyError(id, -32601, `Method not found: ${method}`);
  }
}

let buf = "";
let pending = 0;
let stdinEnded = false;

function maybeExit() {
  if (stdinEnded && pending === 0) process.exit(0);
}

process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      console.error(`[node-ctl-mcp] 无法解析消息：${e.message}`);
      continue;
    }
    pending++;
    handleMessage(msg)
      .catch((e) => console.error(`[node-ctl-mcp] 处理失败：${e.stack || e.message}`))
      .finally(() => {
        pending--;
        maybeExit();
      });
  }
});
process.stdin.on("end", () => {
  stdinEnded = true;
  maybeExit();
});
console.error("[node-ctl-mcp] ready (stdio)");
