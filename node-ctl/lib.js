const fs = require("fs");
const path = require("path");
const http = require("http");
const tls = require("tls");
const crypto = require("crypto");

function loadConfig(explicit) {
  const candidates = [
    explicit,
    process.env.NODECTL_CONFIG,
    path.join(process.cwd(), "nodes.json"),
    path.join(__dirname, "nodes.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
      return { path: p, config: JSON.parse(raw) };
    }
  }
  throw new Error(`找不到配置文件（尝试过：${candidates.join(", ")}）\n可参考 configs/nodes.example.json 创建 nodes.json`);
}

/** 节点解析：支持注册 id（nodes.json 键）或显示名（entry.name） */
function resolveNodeEntry(config, nameOrId) {
  const nodes = config.nodes || {};
  if (nodes[nameOrId]) return { key: nameOrId, node: nodes[nameOrId] };
  const hit = Object.entries(nodes).find(([, v]) => v?.name === nameOrId);
  if (hit) return { key: hit[0], node: hit[1] };
  return null;
}

function getNode(config, name) {
  const hit = resolveNodeEntry(config, name);
  if (!hit) {
    const names = Object.entries(config.nodes || {}).map(([k, v]) => (v?.name && v.name !== k ? `${k}(${v.name})` : k));
    throw new Error(`未配置节点 "${name}"。已配置：${names.length ? names.join(", ") : "（无）"}`);
  }
  if (!hit.node.agentUrl) throw new Error(`节点 "${name}" 缺少 agentUrl`);
  return hit.node;
}

/* ==================== 平权凭据解析（与本机节点共享） ==================== */

function repoRoot() {
  return path.join(__dirname, "..");
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function localNode(repo) {
  const cfg = readJson(path.join(repo, "node-agent", "node.json"));
  const state = readJson(path.join(repo, "node-agent", "data", "state.json"));
  return { hub: cfg?.hub || null, token: state?.token || "" };
}

/** 构建 registry 请求：平权优先本机节点凭据（admin 兼容）；地址回退本机 node.json 的 Hub */
function registryAuth(reg, repo) {
  const local = localNode(repo || repoRoot());
  const address = (reg && reg.address) || local.hub?.address || "";
  const port = (reg && reg.port) || local.hub?.port || 18080;
  const fingerprint = (reg && reg.fingerprint) || local.hub?.fingerprint || "";
  const headers = {};
  if (local.token) headers["X-Node-Token"] = local.token;
  if (reg && reg.adminToken) headers["X-Admin-Token"] = reg.adminToken;
  return { address, port, headers, fingerprint };
}

/** 指纹钉扎 HTTPS 请求：自签证书场景跳过 CA 链校验，但在握手完成后、发送任何数据之前校验 SHA-256 指纹 */
function pinnedRequest({ hostname, port, method = "GET", path: reqPath = "/", headers = {}, body, fingerprint, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    const expected = String(fingerprint || "").replace(/:/g, "").toLowerCase();
    let done = false;
    const settle = (v) => { if (!done) { done = true; resolve(v); } };
    const socket = tls.connect({ host: hostname, port, rejectUnauthorized: false, minVersion: "TLSv1.2" });
    socket.setTimeout(timeoutMs, () => { socket.destroy(); settle({ status: 0, json: null, text: "timeout" }); });
    socket.once("error", (e) => settle({ status: 0, json: null, text: e.message }));
    socket.once("secureConnect", () => {
      let fp = "";
      try {
        const cert = socket.getPeerCertificate(true);
        if (cert && cert.raw) fp = crypto.createHash("sha256").update(cert.raw).digest("hex");
      } catch {}
      if (!fp || fp !== expected) {
        socket.destroy();
        settle({ status: 0, json: null, text: "certificate fingerprint mismatch（证书指纹不匹配，可能遭遇中间人）" });
        return;
      }
      const req = http.request(
        {
          createConnection: () => socket,
          hostname, port, method, path: reqPath,
          headers: { "Content-Type": "application/json", ...headers },
          timeout: timeoutMs,
        },
        (res) => {
          let buf = "";
          res.on("data", (c) => (buf += c));
          res.on("end", () => {
            let json = null;
            try { json = JSON.parse(buf); } catch {}
            settle({ status: res.statusCode, json, text: buf });
          });
        }
      );
      req.on("timeout", () => { req.destroy(); settle({ status: 0, json: null, text: "timeout" }); });
      req.on("error", (e) => settle({ status: 0, json: null, text: e.message }));
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

/** registry 请求：配置了指纹走钉扎 HTTPS；否则维持原有 HTTP（未启用 TLS 的旧 Hub 兼容） */
async function registryFetch(a, method, p, body, timeoutMs = 8000) {
  if (a.fingerprint) {
    return pinnedRequest({ hostname: a.address, port: a.port, method, path: p, headers: a.headers, body, fingerprint: a.fingerprint, timeoutMs });
  }
  try {
    const res = await fetch(`http://${a.address}:${a.port}${p}`, {
      method,
      headers: { "Content-Type": "application/json", ...a.headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: e.message };
  }
}

async function registryNodes(reg) {
  const a = registryAuth(reg);
  if (!a.address) return null;
  const r = await registryFetch(a, "GET", "/nodes", undefined, 5000);
  return r.status === 200 && r.json?.ok ? r.json.nodes : null;
}

async function registryFrps(reg) {
  const a = registryAuth(reg);
  if (!a.address) return null;
  const r = await registryFetch(a, "GET", "/admin/frps", undefined, 5000);
  return r.status === 200 && r.json?.ok ? r.json.frps : null;
}

async function agentCall(nodeCfg, method, endpoint, timeoutMs) {
  const url = nodeCfg.agentUrl.replace(/\/+$/, "") + endpoint;
  try {
    const res = await fetch(url, {
      method,
      headers: { "X-Agent-Token": nodeCfg.agentToken || "" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: e.message };
  }
}

async function agentHealth(nodeCfg) {
  const url = nodeCfg.agentUrl.replace(/\/+$/, "") + "/health";
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const j = await res.json();
    return { reachable: res.ok, name: j.name, version: j.version };
  } catch {
    return { reachable: false };
  }
}

/* ==================== 共享密码解析（加密存储解封） ==================== */

let _secretStore = null;
function loadSecretStore() {
  if (_secretStore !== null) return _secretStore;
  try {
    _secretStore = require(path.join(repoRoot(), "node-agent", "secret-store.js"));
  } catch {
    _secretStore = false;
  }
  return _secretStore;
}

/** 解析共享密码：fleetPasswordEnc（DPAPI/密钥环）→ 解封；兼容旧明文字段 fleetPassword；回退本机节点密码（统一密码网络自动派生） */
function resolveFleetPassword(config) {
  if (!config) return "";
  if (config.fleetPasswordEnc) {
    const store = loadSecretStore();
    if (!store) throw new Error("无法解封共享密码：缺少 node-agent/secret-store.js（请更新仓库）");
    try {
      return store.unseal(config.fleetPasswordEnc);
    } catch (e) {
      throw new Error("共享密码解密失败：" + (e.message || e) + "（换机/换用户后请重新设置共享密码）");
    }
  }
  if (config.fleetPassword) return config.fleetPassword;
  const nodeCfg = readJson(path.join(repoRoot(), "node-agent", "node.json"));
  const oc = nodeCfg?.opencode || {};
  try {
    const store = loadSecretStore();
    if (oc.passwordEnc && store) return store.unseal(oc.passwordEnc);
    if (oc.password) return oc.password;
  } catch {}
  return "";
}

/* ==================== opencode-mesh 协议 v1（信封 / 回执 / 派发） ==================== */

function saveConfigFile(filePath, cfg) {
  fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2));
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function newTaskId(prefix = "t") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
}

function wrapEnvelope({ from, task, mode = "one-shot", body }) {
  return [
    "[opencode-mesh v1]",
    `from: ${from}`,
    `task: ${task}`,
    `mode: ${mode}`,
    "reply: result-block",
    "---",
    body,
  ].join("\n");
}

function parseResultBlock(text) {
  const s = String(text || "");
  let body = null;
  // 优先新标记；兼容旧标记 [aoi-mesh-result v1]（历史名称，含混用开闭标签）
  const strict = /\[(?:opencode|aoi)-mesh-result v1\]([\s\S]*?)\[\/(?:opencode|aoi)-mesh-result\]/i.exec(s);
  if (strict) {
    body = strict[1];
  } else {
    // 宽松回退：容忍接收端漏写标签（未加载 instructions）但给出 status 行的情况
    const loose = /(?:^|\n)\s*status\s*:\s*(done|partial|failed)\s*(?:\n([\s\S]*))?/i.exec(s);
    if (loose) body = `status: ${loose[1]}\n${loose[2] || ""}`;
  }
  if (!body) return null;
  const fields = {};
  for (const line of body.split(/\r?\n/)) {
    const mm = /^(\w+)\s*:\s*(.+)$/.exec(line.trim());
    if (mm) fields[mm[1].toLowerCase()] = mm[2].trim();
  }
  if (fields.status && !fields.summary) {
    const rest = body
      .replace(/^[\s\S]*?status\s*:\s*\w+\s*/i, "")
      .replace(/^-{2,}\s*$/gm, "")
      .replace(/^result-block\s*$/gim, "")
      .trim();
    if (rest) fields.summary = rest.slice(0, 800);
  }
  return fields;
}

async function opencodeApi(nodeCfg, method, endpoint, body, timeoutMs = 30000) {
  const base = (nodeCfg.opencodeUrl || "").replace(/\/+$/, "");
  if (!base) return { status: 0, json: null, text: "缺少 opencodeUrl" };
  const auth = "Basic " + Buffer.from(`opencode:${nodeCfg.opencodePassword || ""}`).toString("base64");
  try {
    const res = await fetch(base + endpoint, {
      method,
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: e.message };
  }
}

/** 按 opencode-mesh 协议派发任务（复用节点会话；解析回执块） */
async function dispatchToNode(configPath, config, nodeName, body, opts = {}) {
  const hit = resolveNodeEntry(config, nodeName);
  if (!hit?.node?.opencodeUrl) throw new Error(`节点 "${nodeName}" 缺少 opencodeUrl（先在 App「主控」页同步节点）`);
  const nodeKey = hit.key;
  const node = hit.node;
  const nodeCfg = { ...node, opencodePassword: resolveFleetPassword(config) };
  if (!nodeCfg.opencodePassword) throw new Error("缺少统一密码（请在 App「设置」页配置本机节点密码，或从其他控制端导入配置）");

  const from = opts.from || "master";
  const task = opts.task || newTaskId("t");
  const mode = opts.mode || "one-shot";

  let sessionId = opts.newSession ? null : node.sessionId || null;
  if (sessionId) {
    const probe = await opencodeApi(nodeCfg, "GET", `/session/${sessionId}`, undefined, 8000);
    if (probe.status !== 200) sessionId = null;
  }
  if (!sessionId) {
    const created = await opencodeApi(nodeCfg, "POST", "/session", { title: `opencode-mesh ${from}` }, 15000);
    if (created.status !== 200 || !created.json?.id) {
      throw new Error(`创建会话失败: HTTP ${created.status} ${String(created.text).slice(0, 120)}`);
    }
    sessionId = created.json.id;
  }

  const envelope = wrapEnvelope({ from, task, mode, body });
  const timeoutMs = (opts.timeoutSec || 300) * 1000;
  const res = await opencodeApi(nodeCfg, "POST", `/session/${sessionId}/message`, {
    parts: [{ type: "text", text: envelope }],
  }, timeoutMs);
  if (res.status !== 200 || !res.json) {
    throw new Error(`派发失败: HTTP ${res.status} ${String(res.text).slice(0, 160)}`);
  }

  const texts = (res.json.parts || [])
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  const parsed = parseResultBlock(texts);

  if (configPath) {
    config.nodes[nodeKey] = { ...node, sessionId };
    try {
      saveConfigFile(configPath, config);
    } catch {}
  }

  return {
    ok: true,
    task,
    sessionId,
    status: parsed?.status || (texts ? "no-result-block" : "empty"),
    summary: parsed?.summary || texts.slice(0, 800),
    artifacts: parsed?.artifacts || "",
    raw: texts,
  };
}

module.exports = {
  loadConfig,
  getNode,
  resolveNodeEntry,
  agentCall,
  agentHealth,
  registryNodes,
  registryFrps,
  registryAuth,
  registryFetch,
  pinnedRequest,
  resolveFleetPassword,
  saveConfigFile,
  newTaskId,
  wrapEnvelope,
  parseResultBlock,
  opencodeApi,
  dispatchToNode,
};

