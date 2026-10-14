const fs = require("fs");
const path = require("path");

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

function getNode(config, name) {
  const node = config.nodes?.[name];
  if (!node) {
    const names = Object.keys(config.nodes || {});
    throw new Error(`未配置节点 "${name}"。已配置：${names.length ? names.join(", ") : "（无）"}`);
  }
  if (!node.agentUrl) throw new Error(`节点 "${name}" 缺少 agentUrl`);
  return node;
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
  const headers = {};
  if (local.token) headers["X-Node-Token"] = local.token;
  if (reg && reg.adminToken) headers["X-Admin-Token"] = reg.adminToken;
  return { address, port, headers };
}

async function registryNodes(reg) {
  const a = registryAuth(reg);
  if (!a.address) return null;
  try {
    const res = await fetch(`http://${a.address}:${a.port}/nodes`, {
      headers: a.headers,
      signal: AbortSignal.timeout(5000),
    });
    const j = await res.json();
    return j.ok ? j.nodes : null;
  } catch {
    return null;
  }
}

async function registryFrps(reg) {
  const a = registryAuth(reg);
  if (!a.address) return null;
  try {
    const res = await fetch(`http://${a.address}:${a.port}/admin/frps`, {
      headers: a.headers,
      signal: AbortSignal.timeout(5000),
    });
    const j = await res.json();
    return j.ok ? j.frps : null;
  } catch {
    return null;
  }
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

module.exports = { loadConfig, getNode, agentCall, agentHealth, registryNodes, registryFrps };
