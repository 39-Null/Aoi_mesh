const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.REGISTRY_PORT || "18080", 10);
const HOST = process.env.REGISTRY_HOST || "127.0.0.1";
const ADMIN_TOKEN = process.env.REGISTRY_ADMIN_TOKEN || "";
const PORT_RANGE_START = parseInt(process.env.REGISTRY_PORT_START || "14100", 10);
const PORT_RANGE_END = parseInt(process.env.REGISTRY_PORT_END || "14199", 10);
const FRPS_ADDR = process.env.REGISTRY_FRPS_ADDR || "127.0.0.1";
const FRPS_PORT = parseInt(process.env.REGISTRY_FRPS_PORT || "17000", 10);
const FRP_TOKEN = process.env.REGISTRY_FRP_TOKEN || "";
const DATA_FILE = process.env.REGISTRY_DATA || path.join(__dirname, "data.json");

if (!ADMIN_TOKEN) {
  console.error("[registry] 拒绝启动：必须设置 REGISTRY_ADMIN_TOKEN");
  process.exit(1);
}

let data = { keys: {}, nodes: {}, frpToken: FRP_TOKEN || crypto.randomBytes(16).toString("hex") };
if (fs.existsSync(DATA_FILE)) {
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (FRP_TOKEN) data.frpToken = FRP_TOKEN;
  } catch (e) {
    console.error("[registry] data.json 解析失败:", e.message);
    process.exit(1);
  }
}

function save() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
if (!fs.existsSync(DATA_FILE)) save();

// 迁移历史数据：为节点补 id（id = 首次注册名，唯一且不可变）；名称（name）为可变显示标签
{
  let migrated = false;
  const byId = {};
  for (const k of Object.keys(data.nodes || {})) {
    const n = data.nodes[k];
    if (!n.id) { n.id = n.name || k; migrated = true; }
    if (!n.name) { n.name = n.id; migrated = true; }
    if (k !== n.id) migrated = true;
    byId[n.id] = n;
  }
  data.nodes = byId;
  if (migrated) save();
}

function usedPorts() {
  const set = new Set();
  for (const n of Object.values(data.nodes)) {
    if (n.opencodeRemotePort) set.add(n.opencodeRemotePort);
    if (n.agentRemotePort) set.add(n.agentRemotePort);
  }
  return set;
}

function allocatePortPair() {
  const used = usedPorts();
  for (let p = PORT_RANGE_START; p + 1 <= PORT_RANGE_END; p += 2) {
    if (!used.has(p) && !used.has(p + 1)) return [p, p + 1];
  }
  return null;
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        resolve(null);
      }
    });
  });
}

function isAdmin(req) {
  return req.headers["x-admin-token"] === ADMIN_TOKEN;
}

/** 平权：任意已注册节点的凭据均视为有效管理凭据（admin 兼容保留） */
function isAnyNodeToken(headers) {
  const t = headers["x-node-token"];
  if (!t) return false;
  return Object.values(data.nodes).some((n) => n.token === t);
}

function canManage(req) {
  return isAdmin(req) || isAnyNodeToken(req.headers);
}

function findNodeByToken(token) {
  if (!token) return null;
  return Object.values(data.nodes).find((n) => n.token === token) || null;
}

/** 名称冲突检查：名称需全网唯一（不含自身 id）；id 与 name 均占用唯一命名空间 */
function nameTaken(name, exceptId) {
  return Object.values(data.nodes).some((n) => n.id !== exceptId && (n.id === name || n.name === name));
}

function publicNode(n) {
  return {
    id: n.id,
    name: n.name,
    token: n.token,
    stcpSecret: n.stcpSecret,
    opencodeRemotePort: n.opencodeRemotePort,
    agentRemotePort: n.agentRemotePort,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === "GET /health") {
      return json(res, 200, { ok: true, nodes: Object.keys(data.nodes).length });
    }

    if (route === "POST /admin/keys") {
      if (!canManage(req)) return json(res, 401, { ok: false, error: "unauthorized" });
      const body = await readBody(req);
      if (body === null) return json(res, 400, { ok: false, error: "bad json" });
      const count = Math.min(Math.max(parseInt(body.count || 1, 10), 1), 20);
      const keys = [];
      for (let i = 0; i < count; i++) {
        const key = crypto.randomBytes(24).toString("hex");
        data.keys[key] = { createdAt: new Date().toISOString(), usedBy: null };
        keys.push(key);
      }
      save();
      return json(res, 200, { ok: true, keys });
    }

    if (route === "GET /admin/frps") {
      if (!canManage(req)) return json(res, 401, { ok: false, error: "unauthorized" });
      return json(res, 200, {
        ok: true,
        frps: { addr: FRPS_ADDR, port: FRPS_PORT, token: data.frpToken },
      });
    }

    if (route === "POST /register") {
      const body = await readBody(req);
      if (body === null) return json(res, 400, { ok: false, error: "bad json" });
      const { name, joinKey } = body;
      if (!name || !/^[a-zA-Z0-9_-]{2,32}$/.test(name)) {
        return json(res, 400, { ok: false, error: "invalid name" });
      }
      const keyRec = data.keys[joinKey];
      if (!keyRec) return json(res, 403, { ok: false, error: "invalid join key" });
      // 已绑定：沿用原身份（凭同一密钥重装/恢复；可同步更新显示名）
      if (keyRec.usedBy && data.nodes[keyRec.usedBy]) {
        const entry = data.nodes[keyRec.usedBy];
        if (name !== entry.name && !nameTaken(name, entry.id)) entry.name = name;
        entry.lastSeen = new Date().toISOString();
        save();
        return json(res, 200, {
          ok: true,
          restored: true,
          node: publicNode(entry),
          frps: { addr: FRPS_ADDR, port: FRPS_PORT, token: data.frpToken },
          heartbeatIntervalSec: 60,
        });
      }
      // 新注册：id = 首次注册名（不可变）；名称/ID 全网唯一，防冒名（不得复用他人身份）
      if (data.nodes[name] || nameTaken(name, null)) {
        return json(res, 409, { ok: false, error: "name already registered (id taken); choose another name" });
      }
      const pair = allocatePortPair();
      if (!pair) return json(res, 507, { ok: false, error: "no free port pair in range" });
      const entry = {
        id: name,
        name,
        createdAt: new Date().toISOString(),
        token: crypto.randomBytes(24).toString("hex"),
        stcpSecret: crypto.randomBytes(16).toString("hex"),
        opencodeRemotePort: pair[0],
        agentRemotePort: pair[1],
        lastSeen: new Date().toISOString(),
      };
      data.nodes[entry.id] = entry;
      keyRec.usedBy = entry.id;
      save();
      return json(res, 200, {
        ok: true,
        node: publicNode(entry),
        frps: { addr: FRPS_ADDR, port: FRPS_PORT, token: data.frpToken },
        heartbeatIntervalSec: 60,
      });
    }

    if (route === "POST /rename") {
      const body = await readBody(req);
      if (body === null) return json(res, 400, { ok: false, error: "bad json" });
      const { name, token } = body;
      if (!name || !/^[a-zA-Z0-9_-]{2,32}$/.test(name)) {
        return json(res, 400, { ok: false, error: "invalid name" });
      }
      const entry = findNodeByToken(token);
      if (!entry) return json(res, 401, { ok: false, error: "invalid token" });
      const oldName = entry.name;
      if (name !== entry.name) {
        if (nameTaken(name, entry.id)) {
          return json(res, 409, { ok: false, error: "name already used by another node" });
        }
        entry.name = name;
      }
      entry.lastSeen = new Date().toISOString();
      save();
      return json(res, 200, {
        ok: true,
        renamedFrom: oldName !== entry.name ? oldName : null,
        node: publicNode(entry),
        frps: { addr: FRPS_ADDR, port: FRPS_PORT, token: data.frpToken },
        heartbeatIntervalSec: 60,
      });
    }

    if (route === "POST /heartbeat") {
      const body = await readBody(req);
      if (body === null) return json(res, 400, { ok: false, error: "bad json" });
      const entry = findNodeByToken(req.headers["x-node-token"]);
      if (!entry) return json(res, 401, { ok: false, error: "unauthorized" });
      entry.lastSeen = new Date().toISOString();
      if (body.version) entry.version = body.version;
      save();
      return json(res, 200, { ok: true });
    }

    if (route === "POST /offline") {
      const entry = findNodeByToken(req.headers["x-node-token"]);
      if (!entry) return json(res, 401, { ok: false, error: "unauthorized" });
      entry.lastSeen = new Date(Date.now() - 200_000).toISOString();
      save();
      return json(res, 200, { ok: true });
    }

    if (route === "GET /nodes") {
      if (!canManage(req)) return json(res, 401, { ok: false, error: "unauthorized" });
      const list = Object.values(data.nodes).map((n) => ({
        id: n.id,
        name: n.name,
        lastSeen: n.lastSeen || null,
        online: n.lastSeen ? Date.now() - new Date(n.lastSeen).getTime() < 150_000 : false,
        opencodeRemotePort: n.opencodeRemotePort,
        agentRemotePort: n.agentRemotePort,
        stcpSecret: n.stcpSecret || null,
        token: n.token || null,
        version: n.version || null,
      }));
      return json(res, 200, { ok: true, nodes: list });
    }

    if (route === "POST /admin/revoke") {
      if (!canManage(req)) return json(res, 401, { ok: false, error: "unauthorized" });
      const body = await readBody(req);
      if (body === null) return json(res, 400, { ok: false, error: "bad json" });
      const target = body.id || body.name;
      const entry = data.nodes[target] || Object.values(data.nodes).find((n) => n.name === target) || null;
      if (entry) {
        delete data.nodes[entry.id];
        for (const k of Object.keys(data.keys)) {
          if (data.keys[k].usedBy === entry.id) delete data.keys[k];
        }
        save();
        return json(res, 200, { ok: true, revoked: entry.id });
      }
      return json(res, 404, { ok: false, error: "node not found" });
    }

    return json(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[registry] listening on http://${HOST}:${PORT}`);
  console.log(`[registry] port range ${PORT_RANGE_START}-${PORT_RANGE_END}, frps ${FRPS_ADDR}:${FRPS_PORT}`);
  console.log(`[registry] data file: ${DATA_FILE}`);
});
