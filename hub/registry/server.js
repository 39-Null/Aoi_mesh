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

function isNode(headers, name) {
  const node = data.nodes[name];
  return node && headers["x-node-token"] === node.token;
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
      if (keyRec.usedBy && keyRec.usedBy !== name && data.nodes[keyRec.usedBy]) {
        return json(res, 403, { ok: false, error: "join key already used by " + keyRec.usedBy });
      }
      let node = data.nodes[name];
      if (!node) {
        const pair = allocatePortPair();
        if (!pair) return json(res, 507, { ok: false, error: "no free port pair in range" });
        node = {
          name,
          createdAt: new Date().toISOString(),
          token: crypto.randomBytes(24).toString("hex"),
          stcpSecret: crypto.randomBytes(16).toString("hex"),
          opencodeRemotePort: pair[0],
          agentRemotePort: pair[1],
        };
        data.nodes[name] = node;
      }
      if (!node.stcpSecret) node.stcpSecret = crypto.randomBytes(16).toString("hex");
      node.lastSeen = new Date().toISOString();
      keyRec.usedBy = name;
      save();
      return json(res, 200, {
        ok: true,
        node: {
          name: node.name,
          token: node.token,
          stcpSecret: node.stcpSecret,
          opencodeRemotePort: node.opencodeRemotePort,
          agentRemotePort: node.agentRemotePort,
        },
        frps: { addr: FRPS_ADDR, port: FRPS_PORT, token: data.frpToken },
        heartbeatIntervalSec: 60,
      });
    }

    if (route === "POST /heartbeat") {
      const body = await readBody(req);
      if (body === null) return json(res, 400, { ok: false, error: "bad json" });
      if (!body.name || !isNode(req.headers, body.name)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }
      data.nodes[body.name].lastSeen = new Date().toISOString();
      if (body.version) data.nodes[body.name].version = body.version;
      save();
      return json(res, 200, { ok: true });
    }

    if (route === "GET /nodes") {
      if (!canManage(req)) return json(res, 401, { ok: false, error: "unauthorized" });
      const list = Object.values(data.nodes).map((n) => ({
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
      if (body.name && data.nodes[body.name]) {
        delete data.nodes[body.name];
        for (const k of Object.keys(data.keys)) {
          if (data.keys[k].usedBy === body.name) delete data.keys[k];
        }
        save();
        return json(res, 200, { ok: true, revoked: body.name });
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
