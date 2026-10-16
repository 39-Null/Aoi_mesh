#!/usr/bin/env node
/**
 * opencode-mesh node-ctl MCP server（stdio, 零依赖）
 * 让主控 opencode 原生拥有：列出/健康检查节点、远程生命周期、任务派发（信封+回执）、
 * 会话浏览/中断、权限审批（pending permissions）、会话绑定重置 等能力。
 * 共享密码从加密存储解封（Windows DPAPI / Linux 密钥环），不存在明文 --password。
 */
const {
  loadConfig,
  getNode,
  resolveNodeEntry,
  agentCall,
  agentHealth,
  registryNodes,
  resolveFleetPassword,
  saveConfigFile,
  opencodeApi,
  dispatchToNode,
  sessionUsage,
  compactSession,
  clearSession,
} = require("./lib");

const SERVER_INFO = { name: "opencode-mesh-node-ctl", version: "0.3.0" };
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
  {
    name: "node_health",
    description: "检查某节点 opencode 的 HTTP 健康与版本（含密码校验；401 表示共享密码与该节点不一致）。",
    inputSchema: { type: "object", properties: { ...NODE_PROP }, required: ["node"] },
  },
  {
    name: "node_list_sessions",
    description: "列出某节点 opencode 的会话（按最近更新倒序）。",
    inputSchema: {
      type: "object",
      properties: { ...NODE_PROP, limit: { type: "number", description: "返回条数（默认 10）" } },
      required: ["node"],
    },
  },
  {
    name: "node_session_messages",
    description: "读取某节点会话的最近消息（默认该节点的当前派发会话）。",
    inputSchema: {
      type: "object",
      properties: {
        ...NODE_PROP,
        sessionId: { type: "string", description: "会话 ID（省略则用该节点的当前绑定会话）" },
        limit: { type: "number", description: "返回条数（默认 8）" },
      },
      required: ["node"],
    },
  },
  {
    name: "node_permissions",
    description: "列出某节点 opencode 当前等待处理的权限请求（permission.asked，含 requestId）。",
    inputSchema: { type: "object", properties: { ...NODE_PROP }, required: ["node"] },
  },
  {
    name: "node_reply_permission",
    description: "批准或拒绝某节点的权限请求（配合 node_permissions 使用）。",
    inputSchema: {
      type: "object",
      properties: {
        ...NODE_PROP,
        requestId: { type: "string", description: "权限请求 ID（node_permissions 返回）" },
        reply: { type: "string", enum: ["once", "reject"], description: "once=批准本,reject=拒绝" },
      },
      required: ["node", "requestId", "reply"],
    },
  },
  {
    name: "node_interrupt",
    description: "中断某节点当前运行中的会话任务（abort）。",
    inputSchema: {
      type: "object",
      properties: { ...NODE_PROP, sessionId: { type: "string", description: "会话 ID（省略则用该节点当前绑定会话）" } },
      required: ["node"],
    },
  },
  {
    name: "node_reset",
    description: "清除某节点的会话绑定（本地记录）；下次派发将新建会话。",
    inputSchema: { type: "object", properties: { ...NODE_PROP }, required: ["node"] },
  },
  {
    name: "node_context",
    description: "查看某节点会话的上下文占用：绑定的 opencode 会话末轮 tokens.total 与模型上下文上限（百分比）。",
    inputSchema: { type: "object", properties: { ...NODE_PROP }, required: ["node"] },
  },
  {
    name: "node_compact",
    description:
      "压缩本机与该节点的对话上下文：生成结构化结转摘要（digest：事实/未完成/引用）→ 在目标节点新建会话接续 → 换绑。上下文占用随之回落；旧会话归档保留。",
    inputSchema: { type: "object", properties: { ...NODE_PROP }, required: ["node"] },
  },
  {
    name: "node_clear",
    description: "清空本机与该节点的对话上下文：删除目标节点上的绑定会话并清除绑定（下次派发自动新建）。不可恢复。",
    inputSchema: { type: "object", properties: { ...NODE_PROP }, required: ["node"] },
  },
];

/* ---------------- 通用运行时 ---------------- */

function nodeRuntime(nodeName) {
  const loaded = loadConfig();
  const hit = resolveNodeEntry(loaded.config, nodeName);
  if (!hit?.node?.opencodeUrl) throw new Error(`节点 "${nodeName}" 缺少 opencodeUrl（先在 App「主控」页同步节点）`);
  const pw = resolveFleetPassword(loaded.config);
  if (!pw) throw new Error("缺少统一密码（请在 App「设置」页配置本机节点密码，或从其他控制端导入配置）");
  return { cfgPath: loaded.path, config: loaded.config, key: hit.key, node: hit.node, nodeCfg: { ...hit.node, opencodePassword: pw } };
}

async function oc(nodeCfg, method, p, body, timeoutMs = 15000) {
  const r = await opencodeApi(nodeCfg, method, p, body, timeoutMs);
  if (r.status === 401) throw new Error("密码校验失败（401）：该节点 opencode 密码与网络统一密码不一致（请在各节点「设置」页 ⚙ 修改密码保持一致）");
  if (r.status === 0) throw new Error(`无法连接节点 opencode：${r.text}（确认隧道已启动且节点在线）`);
  return r;
}

function safeTime(t) {
  try {
    const ts = typeof t === "number" ? t : Date.parse(t);
    return Number.isFinite(ts) ? new Date(ts).toLocaleString("zh-CN", { hour12: false }) : "";
  } catch {
    return "";
  }
}

/* ---------------- 既有工具 ---------------- */

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

/* ---------------- 新增工具 ---------------- */

async function toolNodeHealth(nodeName) {
  const { nodeCfg } = nodeRuntime(nodeName);
  const r = await oc(nodeCfg, "GET", "/global/health", undefined, 8000);
  const ok = r.status === 200 && r.json?.healthy === true;
  return ok
    ? `节点 ${nodeName}：opencode 健康 ✓（v${r.json.version || "?"}）`
    : `节点 ${nodeName}：opencode 不健康（HTTP ${r.status} ${String(r.text || "").slice(0, 80)}）`;
}

async function toolListSessions(nodeName, limit) {
  const { nodeCfg } = nodeRuntime(nodeName);
  const r = await oc(nodeCfg, "GET", "/session", undefined, 15000);
  const list = Array.isArray(r.json) ? r.json : [];
  if (!list.length) return `节点 ${nodeName}：暂无会话`;
  const n = Math.max(1, Math.min(parseInt(limit, 10) || 10, 50));
  const sorted = list
    .slice()
    .sort((a, b) => (b?.time?.updated || b?.time?.created || 0) - (a?.time?.updated || a?.time?.created || 0))
    .slice(0, n);
  const lines = [`节点 ${nodeName} 会话（${sorted.length}/${list.length}）：`];
  for (const s of sorted) {
    lines.push(`- ${s.title || "(无标题)"} | ${s.id} | 更新 ${safeTime(s?.time?.updated || s?.time?.created) || "?"}`);
  }
  return lines.join("\n");
}

function extractText(parts) {
  return (Array.isArray(parts) ? parts : [])
    .filter((p) => p && p.type === "text" && p.text)
    .map((p) => p.text)
    .join("\n");
}

async function toolSessionMessages(nodeName, sessionId, limit) {
  const { node, nodeCfg } = nodeRuntime(nodeName);
  const sid = String(sessionId || node.sessionId || "");
  if (!sid) throw new Error(`节点 "${nodeName}" 尚无绑定会话（先 node_dispatch，或显式提供 sessionId）`);
  const r = await oc(nodeCfg, "GET", `/session/${sid}/message`, undefined, 20000);
  const list = Array.isArray(r.json) ? r.json : [];
  if (!list.length) return `节点 ${nodeName} 会话 ${sid}：暂无消息`;
  const n = Math.max(1, Math.min(parseInt(limit, 10) || 8, 50));
  const lines = [`节点 ${nodeName} 会话 ${sid} 消息（最近 ${Math.min(n, list.length)}/${list.length}）：`];
  for (const m of list.slice(-n)) {
    const role = m?.info?.role || m?.role || "?";
    const text = (extractText(m?.parts) || String(m?.text || "")).trim().slice(0, 220);
    lines.push(`[${role}] ${text || "(非文本消息)"}`);
  }
  return lines.join("\n");
}

async function toolPermissions(nodeName) {
  const { nodeCfg } = nodeRuntime(nodeName);
  const r = await oc(nodeCfg, "GET", "/permission", undefined, 15000);
  const list = Array.isArray(r.json) ? r.json : [];
  if (!list.length) return `节点 ${nodeName}：没有待处理的权限请求`;
  const lines = [`节点 ${nodeName} 待处理权限请求（${list.length}）：`];
  for (const p of list) {
    lines.push(`- [${p.id}] ${p.permission || "?"} patterns=${JSON.stringify(p.patterns || [])} session=${p.sessionID || "?"}`);
  }
  return lines.join("\n");
}

async function toolReplyPermission(nodeName, requestId, reply) {
  const { nodeCfg } = nodeRuntime(nodeName);
  const r = await oc(nodeCfg, "POST", `/permission/${encodeURIComponent(requestId)}/reply`, { reply }, 15000);
  const okText = r.text.trim() === "true" || r.json === true;
  if (r.status !== 200 || !okText) {
    throw new Error(`回复失败（HTTP ${r.status}）：${String(r.text || "").slice(0, 160)}（请求可能已过期/已处理）`);
  }
  return `节点 ${nodeName}：已${reply === "reject" ? "拒绝" : "批准"}请求 ${requestId}`;
}

async function toolInterrupt(nodeName, sessionId) {
  const { node, nodeCfg } = nodeRuntime(nodeName);
  const sid = String(sessionId || node.sessionId || "");
  if (!sid) throw new Error(`节点 "${nodeName}" 尚无绑定会话（先 node_dispatch，或显式提供 sessionId）`);
  const r = await oc(nodeCfg, "POST", `/session/${sid}/abort`, undefined, 15000);
  const okText = r.text.trim() === "true" || r.json === true;
  return okText ? `节点 ${nodeName}：已发送中断（会话 ${sid}）` : `节点 ${nodeName}：中断返回 HTTP ${r.status} ${String(r.text || "").slice(0, 120)}`;
}

async function toolReset(nodeName) {
  const { cfgPath, config, key } = nodeRuntime(nodeName);
  if (config.nodes[key]) delete config.nodes[key].sessionId;
  saveConfigFile(cfgPath, config);
  return `节点 ${nodeName}：已清除会话绑定；下次 node_dispatch 将新建会话`;
}

/* ---------------- 调度 ---------------- */

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
    case "node_health":
      return await toolNodeHealth(args.node);
    case "node_list_sessions":
      return await toolListSessions(args.node, args.limit);
    case "node_session_messages":
      return await toolSessionMessages(args.node, args.sessionId, args.limit);
    case "node_permissions":
      return await toolPermissions(args.node);
    case "node_reply_permission": {
      const reply = args.reply === "reject" ? "reject" : "once";
      return await toolReplyPermission(args.node, String(args.requestId || ""), reply);
    }
    case "node_interrupt":
      return await toolInterrupt(args.node, args.sessionId);
    case "node_reset":
      return await toolReset(args.node);
    case "node_context": {
      const { config } = loadConfig();
      const hit = resolveNodeEntry(config, args.node);
      if (!hit?.node) throw new Error(`未配置节点 "${args.node}"`);
      const nodeCfg = { ...hit.node, opencodePassword: resolveFleetPassword(config) };
      const u = await sessionUsage(nodeCfg, hit.node.sessionId);
      if (!u.ok) throw new Error(u.error);
      if (!u.sessionId) return `节点 ${args.node} 无绑定会话（先派发一次任务）`;
      if (u.stale) return `节点 ${args.node} 的绑定会话不存在（可能已被清理）；下次派发将自动重建`;
      const limitPart = u.limit > 0 ? `/${u.limit}（${u.percent}%）` : "（上限未知）";
      return `节点 ${args.node} 会话占用：${u.used}${limitPart}；模型 ${u.modelID || "?"}`;
    }
    case "node_compact": {
      const { path: cfgPath, config } = loadConfig();
      const r = await compactSession(cfgPath, config, args.node, {});
      if (!r.ok) throw new Error(r.error);
      return `已压缩：gen ${r.gen}，事实 ${r.facts} 条；会话 ${r.oldSessionId} → ${r.newSessionId}（确认：${r.ack}）`;
    }
    case "node_clear": {
      const { path: cfgPath, config } = loadConfig();
      const r = await clearSession(cfgPath, config, args.node);
      return r.deletedSessionId ? `已清空：删除会话 ${r.deletedSessionId}（下次派发将新建）` : "无绑定会话（已清空绑定）";
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
