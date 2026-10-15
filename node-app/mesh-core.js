/**
 * opencode-mesh App 核心模块（被 Electron main 与测试共用）
 * 节点侧：node.json 读写、agent 启停、状态
 * 主控侧：nodes.json、注册中心查询、节点操作、visitor 管理、fleet 配置生成
 * 可移植性：CLI 自动探测、端点从 bot .env 解析、仓库根可覆盖（OPENCODE_MESH_ROOT）
 */
const fs = require("fs");
const path = require("path");
const net = require("net");
const os = require("os");
const http = require("http");
const tls = require("tls");
const crypto = require("crypto");
const { spawn, exec } = require("child_process");

/* ============================ 基础工具 ============================ */

function execCmd(command, timeoutMs = 30000) {
  return new Promise((resolve) => {
    exec(command, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve(String(stdout || "") + String(stderr || ""));
    });
  });
}

function tcpProbe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (!done) {
        done = true;
        sock.destroy();
        resolve(ok);
      }
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, host);
  });
}

async function findPidByPort(port) {
  if (process.platform === "win32") {
    const out = await execCmd("netstat -ano -p tcp", 15000);
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 5 && cols[1].endsWith(`:${port}`) && /LISTENING/i.test(cols[3])) {
        const pid = parseInt(cols[4], 10);
        if (Number.isInteger(pid)) return pid;
      }
    }
    return null;
  }
  const out = await execCmd(`ss -ltnp 2>/dev/null | grep ":${port} "`, 10000);
  const m = out.match(/pid=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

async function killTree(pid) {
  if (!pid) return false;
  if (process.platform === "win32") {
    await execCmd(`taskkill /pid ${pid} /t /f`, 20000);
  } else {
    // detached 派生的进程是独立进程组（组长=pid），负号向整组发信号，避免孤儿
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    await new Promise((r) => setTimeout(r, 1500));
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
  return true;
}

/* ==================== PID 记账（本地进程生命周期直连管理） ====================
 * 原则：App 对自己派生的进程只认 spawn 时记下的 PID（pidfile）+ 存活检测 + 身份校验；
 * 端口只作为服务配置值，不参与发现/停止决策。 */

function pidFilePath(root, which) {
  return which === "agent"
    ? path.join(agentDir(root), "data", "agent.pid")
    : path.join(root, "node-ctl", "visitor.pid");
}

function writePidFile(root, which, pid, marker) {
  try {
    const p = pidFilePath(root, which);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ pid, startedAt: Date.now(), marker: marker || null }));
    return true;
  } catch {
    return false;
  }
}

function readPidFile(root, which) {
  const rec = readJson(pidFilePath(root, which));
  if (rec && Number.isInteger(rec.pid) && rec.pid > 0) return rec;
  return null;
}

function removePidFile(root, which) {
  try {
    fs.unlinkSync(pidFilePath(root, which));
  } catch {}
}

/** 存活检测：kill(pid, 0)；EPERM 表示存在但无权限（视为存活） */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** 身份校验：进程 cmdline 是否含我们的标记（防 PID 复用/误杀第三方） */
async function verifyProcessIdentity(pid, marker) {
  if (!pid || !marker) return false;
  try {
    if (process.platform === "win32") {
      const out = await execCmd(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue).CommandLine"`,
        8000
      );
      return out.includes(marker);
    }
    const cl = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cl.includes(marker);
  } catch {
    return false;
  }
}

/** 按 cmdline 完整路径（-like 匹配）列出进程 PID——用于对账清扫幽灵进程 */
async function listPidsByCmdlineLike(pattern, nameFilter) {
  try {
    if (process.platform === "win32") {
      const nf = nameFilter ? `$_.Name -eq '${nameFilter}' -and ` : "";
      const out = await execCmd(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ${nf}$_.CommandLine -like '*${pattern}*' } | ForEach-Object { $_.ProcessId }"`,
        10000
      );
      return out.split(/\r?\n/).map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
    }
    const out = await execCmd(`pgrep -f '${pattern}' 2>/dev/null`, 8000);
    return out.split(/\r?\n/).map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** 清扫同配置的历史残留（幽灵）进程：强标记=本仓库配置文件的绝对路径 */
async function killGhostProcesses(root, keepPid, which) {
  const marker = which === "agent"
    ? path.join(agentDir(root), "agent.js")
    : path.join(root, "node-ctl", "visitors.toml");
  const nameFilter = which === "agent" ? "node.exe" : "frpc.exe";
  const pids = await listPidsByCmdlineLike(marker, nameFilter);
  const killed = [];
  for (const pid of pids) {
    if (pid === keepPid || pid === process.pid) continue;
    await killTree(pid);
    killed.push(pid);
  }
  return killed;
}

/** 直报 Hub 离线（不经 agent；用本机 state.token 认证）——在线→离线即时生效 */
async function markNodeOffline(root) {
  const state = readJson(path.join(agentDir(root), "data", "state.json"));
  const cfg = readJson(path.join(agentDir(root), "node.json"));
  const hub = cfg?.hub;
  if (!state?.token || !hub?.address) return { ok: false, error: "未注册或未配置 Hub" };
  const scheme = hub.fingerprint ? "https" : "http";
  const r = await registryHttpJson("POST", `${scheme}://${hub.address}:${hub.port || 18080}/offline`, {}, {
    "X-Node-Token": state.token,
  }, 5000, hub.fingerprint || "");
  return { ok: r.status === 200 && !!r.json?.ok, status: r.status };
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function tailFile(p, maxLines) {
  try {
    const all = fs.readFileSync(p, "utf8").split(/\r?\n/);
    return all
      .slice(Math.max(0, all.length - maxLines))
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

async function httpJson(method, url, body, headers = {}, timeoutMs = 8000) {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
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
async function registryHttpJson(method, url, body, headers = {}, timeoutMs = 8000, fingerprint = "") {
  if (fingerprint && /^https:/i.test(url)) {
    const u = new URL(url);
    return pinnedRequest({
      hostname: u.hostname,
      port: u.port || 443,
      method,
      path: u.pathname + u.search,
      headers,
      body,
      fingerprint,
      timeoutMs,
    });
  }
  return httpJson(method, url, body, headers, timeoutMs);
}

/** 凭据文件权限收紧：Linux chmod 600；Windows 关闭继承并仅授权当前用户（best-effort） */
function hardenFile(p) {
  try {
    if (process.platform === "win32") {
      const user = process.env.USERNAME || "";
      if (user) exec(`icacls "${p}" /inheritance:r /grant:r "${user}:F"`, { windowsHide: true }, () => {});
    } else {
      fs.chmodSync(p, 0o600);
    }
  } catch {}
}

/* ==================== 可移植性：CLI 探测 / 端点解析 ==================== */

let cachedCli = null;

/** 探测 opencode-telegram CLI：环境变量 → PATH → 常见安装位置 */
function resolveBotCli() {
  const envCli = process.env.OPENCODE_TELEGRAM_CLI;
  if (envCli && fs.existsSync(envCli)) return envCli;
  if (cachedCli && fs.existsSync(cachedCli)) return cachedCli;

  const isWin = process.platform === "win32";
  const names = isWin
    ? ["opencode-telegram.cmd", "opencode-telegram.exe", "opencode-telegram"]
    : ["opencode-telegram"];

  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) {
        cachedCli = p;
        return p;
      }
    }
  }

  const candidates = [];
  if (isWin) {
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "npm", "opencode-telegram.cmd"));
    if (process.env.LOCALAPPDATA) {
      const nvmRoot = path.join(process.env.LOCALAPPDATA, "Author Software", "nvm", "installs");
      try {
        const versions = fs.readdirSync(nvmRoot).sort().reverse();
        for (const v of versions) candidates.push(path.join(nvmRoot, v, "opencode-telegram.cmd"));
      } catch {}
      candidates.push(
        path.join(process.env.LOCALAPPDATA, "Programs", "opencode-telegram", "opencode-telegram.cmd")
      );
    }
  } else {
    const home = os.homedir();
    candidates.push(
      "/usr/local/bin/opencode-telegram",
      "/usr/bin/opencode-telegram",
      path.join(home, ".local", "bin", "opencode-telegram")
    );
    try {
      const nvmDir = path.join(home, ".nvm", "versions", "node");
      const versions = fs.readdirSync(nvmDir).sort().reverse();
      for (const v of versions) candidates.push(path.join(nvmDir, v, "bin", "opencode-telegram"));
    } catch {}
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      cachedCli = c;
      return c;
    }
  }
  return "";
}

function readEnvFileValue(envFile, key) {
  try {
    const text = fs.readFileSync(envFile, "utf8");
    const m = text.match(new RegExp(`^${key}=(.*)$`, "m"));
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

/** 解析 "http://host:port" / "socks5://host:port" / "host:port" */
function parseEndpoint(raw, defHost, defPort) {
  if (!raw) return { host: defHost, port: defPort, raw: "" };
  try {
    const u = new URL(raw.includes("://") ? raw : `http://${raw}`);
    const port = u.port
      ? parseInt(u.port, 10)
      : u.protocol === "https:"
        ? 443
        : u.protocol === "socks5:" || u.protocol === "socks5h:" || u.protocol === "socks4:"
          ? defPort
          : 80;
    return { host: u.hostname || defHost, port: port || defPort, raw };
  } catch {
    return { host: defHost, port: defPort, raw: "" };
  }
}

/** 从 bot .env 的某个 URL 变量解析端点（找不到则用默认值） */
function envEndpoint(envFile, key, defHost, defPort) {
  const raw = readEnvFileValue(envFile, key);
  return parseEndpoint(raw, defHost, defPort);
}

/** 解析运行 agent 的 Node 运行时：优先真实 node（PATH），否则回退 electron（RUN_AS_NODE） */
function resolveNodeRuntime() {
  if (process.env.OPENCODE_MESH_NODE && fs.existsSync(process.env.OPENCODE_MESH_NODE)) {
    return { exe: process.env.OPENCODE_MESH_NODE, env: {} };
  }
  const isWin = process.platform === "win32";
  const names = isWin ? ["node.exe"] : ["node"];
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        if (fs.existsSync(p)) return { exe: p, env: {} };
      } catch {}
    }
  }
  return { exe: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/* ==================== 仓库根保护 ==================== */

let cachedRepoRoot = null;

/** 解析仓库根目录：环境变量 → 开发/仓库内布局 → 便携包布局 → 从可执行文件/工作目录向上搜索 */
function findRepoRoot() {
  if (cachedRepoRoot) return cachedRepoRoot;
  const isRepo = (p) => {
    try {
      return !!p && fs.existsSync(path.join(p, "node-agent", "agent.js"));
    } catch {
      return false;
    }
  };
  const candidates = [];
  if (process.env.OPENCODE_MESH_ROOT) candidates.push(process.env.OPENCODE_MESH_ROOT);
  candidates.push(path.join(__dirname, "..")); // 开发场景：node-app 的上一级即仓库根
  if (process.resourcesPath) {
    // 打包（便携包）布局：<kit>/app/resources → <kit>/opencode-mesh
    candidates.push(path.join(process.resourcesPath, "..", "..", "opencode-mesh"));
    candidates.push(path.join(process.resourcesPath, "..", ".."));
  }
  for (const base of [path.dirname(process.execPath || ""), process.cwd()]) {
    if (!base) continue;
    let p = path.resolve(base);
    for (let i = 0; i < 6; i++) {
      candidates.push(p);
      candidates.push(path.join(p, "opencode-mesh"));
      const parent = path.dirname(p);
      if (parent === p) break;
      p = parent;
    }
  }
  for (const c of candidates) {
    if (isRepo(c)) {
      cachedRepoRoot = path.resolve(c);
      return cachedRepoRoot;
    }
  }
  return path.resolve(process.env.OPENCODE_MESH_ROOT || path.join(__dirname, ".."));
}

function ensureRepoRoot(root) {
  if (!root || !fs.existsSync(path.join(root, "node-agent", "agent.js"))) {
    throw new Error(
      `未找到仓库内容（${path.join(root || "?", "node-agent")} 不完整）。` +
        `便携包请通过 start-app.sh 启动，或设置环境变量 OPENCODE_MESH_ROOT 指向仓库根目录；` +
        `开发场景请把 App 放在仓库 node-app/ 目录内运行`
    );
  }
}

/* ============================ 节点侧 ============================ */

function agentDir(root) {
  return path.join(root, "node-agent");
}

function validateNodeCfg(cfg) {
  if (!cfg || typeof cfg !== "object") throw new Error("配置为空");
  if (!/^[a-z0-9_-]{2,32}$/.test(cfg.name || "")) {
    throw new Error("节点名不合法（2-32 位小写字母/数字/下划线/中划线）");
  }
  if (!cfg.hub || !cfg.hub.address) throw new Error("缺少 Hub 地址");
  const hp = parseInt(cfg.hub.port, 10);
  if (!Number.isInteger(hp) || hp < 1 || hp > 65535) throw new Error("Hub 端口不合法");
  const op = cfg.opencode ? parseInt(cfg.opencode.port, 10) : NaN;
  if (!Number.isInteger(op) || op < 1 || op > 65535) throw new Error("opencode 端口不合法");
  const ap = cfg.agent ? parseInt(cfg.agent.port, 10) : NaN;
  if (!Number.isInteger(ap) || ap < 1 || ap > 65535) throw new Error("agent 端口不合法");
  return true;
}

async function getNodeConfig(root) {
  const dir = agentDir(root);
  const rootFound = fs.existsSync(path.join(dir, "agent.js"));
  const cfg = readJson(path.join(dir, "node.json"));
  const state = readJson(path.join(dir, "data", "state.json"));
  let agentRunning = false;
  let agentPid = null;
  const recorded = readPidFile(root, "agent");
  if (recorded && isPidAlive(recorded.pid)) {
    agentRunning = true;
    agentPid = recorded.pid;
  } else if (recorded) {
    removePidFile(root, "agent");
  }
  const renamed = !!(state?.name && cfg?.name && state.name !== cfg.name);
  let registeredId = state?.id || null;
  if (!registeredId && state?.token) {
    const mcfg = getMasterConfig(root);
    for (const [k, v] of Object.entries(mcfg?.nodes || {})) {
      if (v?.agentToken === state.token) { registeredId = k; break; }
    }
  }
  return { cfg, state, agentRunning, agentPid, agentDir: dir, rootFound, renamed, registeredId };
}

/** 加入密钥兼容「密钥.指纹」组合串：拆分并落盘 hub.fingerprint（指纹须为 64 位 hex） */
function normalizeJoinFields(cfg) {
  if (!cfg || typeof cfg !== "object") return cfg;
  if (typeof cfg.joinKey === "string" && cfg.joinKey.includes(".")) {
    const [key, fp] = cfg.joinKey.split(".");
    cfg.joinKey = key;
    if (fp && /^[a-fA-F0-9]{64}$/.test(fp)) {
      cfg.hub = { ...(cfg.hub || {}), fingerprint: fp.toLowerCase() };
    }
  }
  return cfg;
}

function saveNodeConfig(root, cfg) {
  ensureRepoRoot(root);
  normalizeJoinFields(cfg);
  validateNodeCfg(cfg);
  const nodePath = path.join(agentDir(root), "node.json");
  writeJson(nodePath, cfg);
  hardenFile(nodePath);
  // Hub 单点：同步写入控制端配置（如存在），保证两处一致
  const master = getMasterConfig(root);
  if (master && cfg.hub?.address) {
    master.registry = {
      ...(master.registry || {}),
      address: cfg.hub.address,
      port: cfg.hub.port || 18080,
      ...(cfg.hub.fingerprint ? { fingerprint: cfg.hub.fingerprint } : {}),
    };
    saveMasterConfig(root, master);
  }
}

async function startAgent(root) {
  ensureRepoRoot(root);
  const dir = agentDir(root);
  const scriptPath = path.join(dir, "agent.js");
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, error: `未找到 ${scriptPath}` };
  }
  const recorded = readPidFile(root, "agent");
  if (recorded && isPidAlive(recorded.pid)) {
    await killGhostProcesses(root, recorded.pid, "agent");
    return { ok: false, error: "agent 已在运行", running: true, pid: recorded.pid };
  }
  if (recorded) removePidFile(root, "agent");
  // 迁移垫片（升级场景一次性）：无 PID 记录但端口被本机旧版 agent 占用 → 身份校验后认领
  const cfg = readJson(path.join(dir, "node.json"));
  const port = cfg?.agent?.port || 41999;
  const legacyPid = await findPidByPort(port);
  if (legacyPid) {
    if (await verifyProcessIdentity(legacyPid, "agent.js")) {
      writePidFile(root, "agent", legacyPid, "agent.js");
      await killGhostProcesses(root, legacyPid, "agent");
      return { ok: false, error: "agent 已在运行（已接管旧实例）", running: true, pid: legacyPid };
    }
    return { ok: false, error: `agent 端口 ${port} 被其他进程占用（PID ${legacyPid}），未启动` };
  }
  await killGhostProcesses(root, null, "agent");
  // 崩溃残留清扫：上一代 agent 被强杀时遗留的节点侧 frpc / opencode（按配置路径与配置端口识别）
  for (const pid of await listPidsByCmdlineLike(path.join(dir, "data", "frpc.toml"), "frpc.exe")) {
    await killTree(pid);
  }
  if (cfg?.opencode?.port) {
    for (const pid of await listPidsByCmdlineLike(`serve --port ${cfg.opencode.port}`, "opencode.exe")) {
      await killTree(pid);
    }
  }
  const logPath = path.join(dir, "data", "agent.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const out = fs.openSync(logPath, "a");
  const rt = resolveNodeRuntime();
  const child = spawn(rt.exe, [scriptPath], {
    cwd: dir,
    detached: true,
    windowsHide: true,
    env: { ...process.env, ...rt.env },
    // stdout 丢弃（agent 自身 log() 已写文件，避免双写）；stderr 保留供启动失败排障
    stdio: ["ignore", "ignore", out],
  });
  child.unref();
  writePidFile(root, "agent", child.pid, scriptPath);
  await new Promise((r) => setTimeout(r, 800));
  if (!isPidAlive(child.pid)) {
    removePidFile(root, "agent");
    const tail = agentLogTail(root, 6).join("\n");
    return { ok: false, error: "agent 启动后立即退出（检查端口占用或配置）。日志尾部：\n" + tail };
  }
  return { ok: true, pid: child.pid, runtime: rt.exe };
}

async function stopAgent(root) {
  const recorded = readPidFile(root, "agent");
  let pid = recorded?.pid || null;
  if (pid && !isPidAlive(pid)) {
    removePidFile(root, "agent");
    pid = null;
  }
  if (!pid) return { ok: false, error: "agent 未在运行（无有效 PID 记录）" };
  if (!isPidAlive(pid)) {
    removePidFile(root, "agent");
    return { ok: true, pid, note: "进程已退出" };
  }
  const marker = recorded?.marker || path.join(agentDir(root), "agent.js");
  if (!(await verifyProcessIdentity(pid, marker))) {
    removePidFile(root, "agent");
    return { ok: false, error: `PID ${pid} 不是本机 agent（可能已被系统复用），未执行停止；记录已清理` };
  }
  await killTree(pid);
  removePidFile(root, "agent");
  const off = await markNodeOffline(root);
  return { ok: true, pid, offline: off.ok };
}

/** 重置节点身份：删除已注册状态与隧道配置（换设备/换节点名时使用） */
function resetNodeState(root) {
  ensureRepoRoot(root);
  const dir = path.join(agentDir(root), "data");
  const removed = [];
  for (const f of ["state.json", "frpc.toml"]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      removed.push(f);
    }
  }
  return { ok: true, removed };
}

function agentLogTail(root, maxLines = 120) {
  return tailFile(path.join(agentDir(root), "data", "agent.log"), maxLines);
}

/* ============================ 主控侧 ============================ */

function nodesCfgPath(root) {
  return path.join(root, "node-ctl", "nodes.json");
}

function getMasterConfig(root) {
  return readJson(nodesCfgPath(root));
}

function saveMasterConfig(root, cfg) {
  ensureRepoRoot(root);
  if (!cfg || typeof cfg !== "object") throw new Error("配置为空");
  const masterPath = nodesCfgPath(root);
  writeJson(masterPath, cfg);
  hardenFile(masterPath);
  // Hub 单点：同步回写本机节点配置（如存在），保证两处一致
  const nodeCfg = readJson(path.join(agentDir(root), "node.json"));
  if (nodeCfg && cfg.registry?.address) {
    nodeCfg.hub = {
      ...(nodeCfg.hub || {}),
      address: cfg.registry.address,
      port: cfg.registry.port || 18080,
      ...(cfg.registry.fingerprint ? { fingerprint: cfg.registry.fingerprint } : {}),
    };
    const nodePath = path.join(agentDir(root), "node.json");
    writeJson(nodePath, nodeCfg);
    hardenFile(nodePath);
  }
}

function localNodeInfo(root) {
  const cfg = readJson(path.join(agentDir(root), "node.json"));
  const state = readJson(path.join(agentDir(root), "data", "state.json"));
  return { hub: cfg?.hub || null, token: state?.token || "" };
}

/** 构建 registry 请求：平权优先本机节点凭据（admin 兼容）；地址回退本机 node.json 的 Hub */
function registryRequest(root, reg) {
  const local = localNodeInfo(root);
  const address = (reg && reg.address) || local.hub?.address || "";
  const port = (reg && reg.port) || local.hub?.port || 18080;
  const fingerprint = (reg && reg.fingerprint) || local.hub?.fingerprint || "";
  const headers = {};
  if (local.token) headers["X-Node-Token"] = local.token;
  if (reg && reg.adminToken) headers["X-Admin-Token"] = reg.adminToken;
  return { address, port, headers, fingerprint };
}

async function registryNodes(root, reg) {
  const rq = registryRequest(root, reg);
  if (!rq.address) return null;
  const scheme = rq.fingerprint ? "https" : "http";
  const r = await registryHttpJson("GET", `${scheme}://${rq.address}:${rq.port}/nodes`, undefined, rq.headers, 5000, rq.fingerprint);
  return r.status === 200 && r.json?.ok ? r.json.nodes : null;
}

async function registryFrps(root, reg) {
  const rq = registryRequest(root, reg);
  if (!rq.address) return null;
  const scheme = rq.fingerprint ? "https" : "http";
  const r = await registryHttpJson("GET", `${scheme}://${rq.address}:${rq.port}/admin/frps`, undefined, rq.headers, 5000, rq.fingerprint);
  return r.status === 200 && r.json?.ok ? r.json.frps : null;
}

async function syncMasterNodes(root) {
  const cfg = getMasterConfig(root) || {};
  const rq = registryRequest(root, cfg.registry);
  if (!rq.address) return { ok: false, error: "尚未配置 Hub（请先在「组网」页填写 Hub 连接）" };
  const nodes = await registryNodes(root, cfg.registry);
  if (!nodes) return { ok: false, error: "无法获取节点列表（检查 Hub 连通性与本机节点凭据）" };
  const map = cfg.nodes || {};
  const prevNames = new Set(Object.keys(map));
  const pending = new Set(nodes.map((n) => n.id || n.name));
  for (const n of nodes) {
    const key = n.id || n.name;
    const prev = map[key] || (n.name && n.name !== key ? map[n.name] : null) || {};
    if (n.name && n.name !== key && map[n.name] && !map[key]) delete map[n.name];
    map[key] = {
      ...prev,
      name: n.name || key,
      agentUrl: prev.agentUrl || `http://127.0.0.1:${n.agentRemotePort}`,
      opencodeUrl: prev.opencodeUrl || `http://127.0.0.1:${n.opencodeRemotePort}`,
      agentToken: n.token || prev.agentToken || "",
    };
  }
  const removed = Object.keys(map).filter((k) => !pending.has(k));
  for (const k of removed) delete map[k];
  cfg.registry = {
    address: rq.address,
    port: rq.port,
    adminToken: cfg.registry?.adminToken || "",
    ...(rq.fingerprint ? { fingerprint: rq.fingerprint } : {}),
  };
  cfg.nodes = map;
  saveMasterConfig(root, cfg);
  const added = [...pending].filter((k) => !prevNames.has(k));
  return { ok: true, count: nodes.length, added, removed };
}

/** 让本机 agent 重启 opencode（用于密码变更后立即生效；走本机回环，无需隧道） */
async function restartLocalOpencode(root) {
  const cfg = readJson(path.join(agentDir(root), "node.json"));
  const state = readJson(path.join(agentDir(root), "data", "state.json"));
  const agentPort = cfg?.agent?.port || 41999;
  if (!state?.token) return { ok: false, error: "agent 尚未注册（请先启动节点）" };
  const r = await httpJson("POST", `http://127.0.0.1:${agentPort}/opencode/restart`, undefined, {
    "X-Agent-Token": state.token,
  }, 90000);
  if (r.status !== 200 || !r.json) return { ok: false, error: r.text || `HTTP ${r.status}` };
  return { ok: r.json.ok !== false, ...r.json };
}

/**
 * 修改本机 opencode 密码（「组网」页齿轮入口）：
 * 1) 先验证原密码——与 node.json 现值比对（网络共用密码 = 本机节点密码；
 *    Hub 不存密码/指纹，验证在节点本机完成）
 * 2) 写入新密码；agent 运行中则经本机回环立即重启 opencode 生效
 */
async function changeNodePassword(root, opts = {}) {
  ensureRepoRoot(root);
  const file = path.join(agentDir(root), "node.json");
  const cfg = readJson(file);
  if (!cfg) return { ok: false, error: "节点尚未配置（请先在向导或「组网」页完成配置）" };
  const current = cfg.opencode?.password || "";
  if (!current) return { ok: false, error: "当前未设置 opencode 密码" };
  const oldPassword = String(opts.oldPassword || "");
  const newPassword = String(opts.newPassword || "").trim();
  if (!newPassword) return { ok: false, error: "新密码不能为空" };
  if (newPassword.length < 8) return { ok: false, error: "新密码过短（至少 8 位）" };
  if (newPassword === current) return { ok: false, error: "新密码与当前密码相同" };
  if (oldPassword !== current) return { ok: false, error: "原密码不正确（请输入当前网络共用密码）" };

  cfg.opencode = { ...cfg.opencode, password: newPassword };
  validateNodeCfg(cfg);
  writeJson(file, cfg);

  const recorded = readPidFile(root, "agent");
  if (recorded && isPidAlive(recorded.pid)) {
    const rr = await restartLocalOpencode(root);
    if (!rr.ok) return { ok: true, restarted: false, restartError: rr.error || "重启失败" };
    return { ok: true, restarted: true };
  }
  return { ok: true, restarted: false };
}

/** 清理本地配置中已被吊销（注册表不存在）的节点 */
async function pruneMasterNodes(root) {
  const cfg = getMasterConfig(root) || {};
  const reg = await registryNodes(root, cfg.registry);
  if (!reg) return { ok: false, error: "无法获取注册表节点（检查 Hub 连接）" };
  const alive = new Set(reg.map((n) => n.id || n.name));
  const removed = [];
  for (const k of Object.keys(cfg.nodes || {})) {
    if (!alive.has(k)) {
      delete cfg.nodes[k];
      removed.push(k);
    }
  }
  if (removed.length) saveMasterConfig(root, cfg);
  return { ok: true, removed };
}

async function listNodesMerged(root) {
  const cfg = getMasterConfig(root) || {};
  const regNodes = await registryNodes(root, cfg.registry);
  const local = cfg.nodes || {};
  const regs = regNodes || [];
  const keys = new Set([...Object.keys(local), ...regs.map((n) => n.id || n.name)]);
  const out = [];
  for (const key of keys) {
    const reg = regs.find((n) => (n.id || n.name) === key) || null;
    const loc = local[key] || (reg?.name ? local[reg.name] : null) || null;
    let reach = null;
    let opencode = null;
    if (loc?.agentUrl) {
      const r = await httpJson("GET", loc.agentUrl.replace(/\/+$/, "") + "/health", undefined, {}, 4000);
      reach = r.status === 200 && r.json?.ok ? { ok: true, version: r.json.version } : { ok: false };
      if (reach.ok) {
        const st = await httpJson("GET", loc.agentUrl.replace(/\/+$/, "") + "/opencode/status", undefined, {
          "X-Agent-Token": loc.agentToken || "",
        }, 4000);
        if (st.status === 200 && st.json) opencode = { running: !!st.json.running, pid: st.json.pid || null };
      }
    }
    out.push({
      id: key,
      name: reg?.name || loc?.name || key,
      online: reg ? reg.online : null,
      opencodePort: reg?.opencodeRemotePort ?? null,
      agentPort: reg?.agentRemotePort ?? null,
      local: !!loc,
      reachable: reach,
      opencode,
    });
  }
  return { ok: true, nodes: out, registryOk: regNodes !== null };
}

/** 全自动隧道：未运行则按需生成配置并启动；用户手动停用（visitorPaused）则跳过。
 *  opts.refresh=true：即使已在运行也重建配置并重启（节点列表变更后）。 */
async function ensureVisitor(root, opts = {}) {
  const cfg = getMasterConfig(root) || {};
  const st = await visitorStatus(root);
  if (cfg.visitorPaused) {
    return { ok: true, skipped: true, reason: "paused", error: "隧道已被手动停用", running: st.running };
  }
  if (!Object.keys(cfg.nodes || {}).length) {
    return { ok: true, skipped: true, reason: "no-nodes", error: "节点列表为空（先同步节点）", running: st.running };
  }
  if (st.running && !opts.refresh) return { ok: true, already: true, port: st.port, pid: st.pid };
  const gen = await generateVisitors(root);
  if (!gen.ok) return { ok: false, error: gen.error };
  const started = await startVisitor(root);
  return started.ok
    ? { ok: true, started: true, refreshed: !!opts.refresh, port: started.port }
    : { ok: false, error: started.error };
}

/** 一键启动节点：启动 agent + 自动确保隧道在线（本机为主控时） */
async function startNodeFull(root) {
  const steps = [];
  const existing = await getNodeConfig(root);
  if (existing.agentRunning) {
    return { ok: false, running: true, error: "agent 已在运行", steps };
  }
  const agent = await startAgent(root);
  if (!agent.ok) return { ok: false, error: agent.error, steps };
  steps.push(`节点 agent 已启动（PID ${agent.pid}）`);
  const visitor = await ensureVisitor(root);
  if (visitor.already) steps.push(`隧道已在运行（127.0.0.1:${visitor.port}）`);
  else if (visitor.ok) steps.push(`隧道已启动（127.0.0.1:${visitor.port}）`);
  else if (visitor.skipped) steps.push(`未启动隧道：${visitor.error}`);
  else steps.push(`隧道启动失败：${visitor.error}`);
  return { ok: true, steps, agent, visitor };
}

async function nodeAction(root, name, action) {
  const cfg = getMasterConfig(root) || {};
  const nodes = cfg.nodes || {};
  let loc = nodes[name];
  if (!loc) {
    const hit = Object.entries(nodes).find(([, v]) => v?.name === name);
    if (hit) loc = hit[1];
  }
  if (!loc?.agentUrl) return { ok: false, error: `节点 "${name}" 未在 nodes.json 配置` };
  const endpoint = action === "status" ? "/opencode/status" : `/opencode/${action}`;
  const method = action === "status" ? "GET" : "POST";
  const timeout = action === "restart" ? 90000 : action === "start" ? 60000 : 30000;

  const doCall = () =>
    httpJson(method, loc.agentUrl.replace(/\/+$/, "") + endpoint, undefined, {
      "X-Agent-Token": loc.agentToken || "",
    }, timeout);

  let r = await doCall();
  if (r.status === 0) {
    // 隧道未运行时自动拉起后重试一次（而不是直接报错）
    const st = await visitorStatus(root);
    if (!st.running) {
      const ens = await ensureVisitor(root);
      if (ens.ok) r = await doCall();
    }
  }
  if (r.status === 401) return { ok: false, error: "agent token 不正确" };
  if (r.status === 0) {
    return {
      ok: false,
      error: `无法连接（${r.text}）——请确认该节点的 agent 已启动（节点本机的「组网」页），以及主控隧道可用`,
    };
  }
  if (!r.json) return { ok: false, error: `非 JSON 响应（${r.status}）` };
  return { ok: r.json.ok !== false, ...r.json };
}

async function generateVisitors(root) {
  ensureRepoRoot(root);
  const cfg = getMasterConfig(root) || {};
  const rq = registryRequest(root, cfg.registry);
  if (!rq.address) return { ok: false, error: "尚未配置 Hub（请先在「组网」页填写 Hub 连接）" };
  const nodes = await registryNodes(root, cfg.registry);
  if (!nodes) return { ok: false, error: "无法获取节点列表（检查 Hub 连通性与本机节点凭据）" };
  const frps = await registryFrps(root, cfg.registry);
  if (!frps) return { ok: false, error: "无法获取 frps 信息" };
  const wanted = Object.keys(cfg.nodes || {});
  const list = nodes.filter((n) => (wanted.length ? wanted.includes(n.id || n.name) : true));
  if (!list.length) return { ok: false, error: "注册表中没有可用节点" };
  const sections = [];
  for (const n of list) {
    const key = n.id || n.name;
    if (!n.stcpSecret) {
      return { ok: false, error: `节点 ${n.name} 缺少 stcp 密钥（需在该节点重新注册）` };
    }
    sections.push(`[[visitors]]
name = "${key}_opencode-visitor"
type = "stcp"
serverName = "${key}_opencode"
secretKey = "${n.stcpSecret}"
bindAddr = "127.0.0.1"
bindPort = ${n.opencodeRemotePort}
transport.useEncryption = true

[[visitors]]
name = "${key}_agent-visitor"
type = "stcp"
serverName = "${key}_agent"
secretKey = "${n.stcpSecret}"
bindAddr = "127.0.0.1"
bindPort = ${n.agentRemotePort}
transport.useEncryption = true`);
  }
  const toml = `# 由 opencode-mesh App 生成
serverAddr = "${frps.addr}"
serverPort = ${frps.port}
auth.method = "token"
auth.token = "${frps.token}"

${sections.join("\n\n")}
`;
  const target = path.join(root, "node-ctl", "visitors.toml");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, toml);
  hardenFile(target);
    return {
      ok: true,
      target,
      mapping: list.map((n) => ({ id: n.id || n.name, name: n.name, opencode: n.opencodeRemotePort, agent: n.agentRemotePort })),
    };
}

function firstBindPort(root) {
  const conf = path.join(root, "node-ctl", "visitors.toml");
  try {
    const text = fs.readFileSync(conf, "utf8");
    const m = text.match(/bindPort\s*=\s*(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

async function visitorStatus(root) {
  const conf = path.join(root, "node-ctl", "visitors.toml");
  const paused = !!getMasterConfig(root)?.visitorPaused;
  const recorded = readPidFile(root, "visitor");
  let running = false;
  let pid = null;
  if (recorded && isPidAlive(recorded.pid)) {
    running = true;
    pid = recorded.pid;
  } else if (recorded) {
    removePidFile(root, "visitor");
  }
  const port = firstBindPort(root);
  return { configured: fs.existsSync(conf), running, pid, port, paused };
}

async function stopVisitor(root) {
  const conf = path.join(root, "node-ctl", "visitors.toml");
  const recorded = readPidFile(root, "visitor");
  let pid = recorded?.pid || null;
  if (pid && !isPidAlive(pid)) {
    removePidFile(root, "visitor");
    pid = null;
  }
  if (!pid) return { ok: false, error: "隧道未在运行（无有效 PID 记录）" };
  if (!isPidAlive(pid)) {
    removePidFile(root, "visitor");
    return { ok: true, pid, note: "进程已退出" };
  }
  const marker = recorded?.marker || conf;
  if (!(await verifyProcessIdentity(pid, marker))) {
    removePidFile(root, "visitor");
    return { ok: false, error: `PID ${pid} 不是本机隧道进程（可能已被系统复用），未执行停止；记录已清理` };
  }
  await killTree(pid);
  removePidFile(root, "visitor");
  return { ok: true, pid };
}

async function startVisitor(root) {
  const conf = path.join(root, "node-ctl", "visitors.toml");
  if (!fs.existsSync(conf)) return { ok: false, error: "请先生成隧道配置" };
  // 迁移垫片（升级场景一次性）：无 PID 记录但端口被本机旧版隧道占用 → 身份校验后认领
  if (!readPidFile(root, "visitor")) {
    const legacyPort = firstBindPort(root);
    const legacyPid = legacyPort ? await findPidByPort(legacyPort) : null;
    if (legacyPid) {
      if (await verifyProcessIdentity(legacyPid, conf)) {
        writePidFile(root, "visitor", legacyPid, conf);
        await killGhostProcesses(root, legacyPid, "visitor");
        return { ok: true, port: legacyPort, adopted: true };
      }
      return { ok: false, error: `隧道端口 ${legacyPort} 被其他进程占用（PID ${legacyPid}），未启动` };
    }
  }
  await stopVisitor(root);
  await killGhostProcesses(root, null, "visitor");
  const isWin = process.platform === "win32";
  let frpc = path.join(root, "node-agent", "bin", isWin ? "frpc.exe" : "frpc");
  if (!fs.existsSync(frpc)) frpc = "frpc";
  const logPath = path.join(root, "node-ctl", "visitor.log");
  const out = fs.openSync(logPath, "a");
  const child = spawn(frpc, ["-c", conf], { detached: true, windowsHide: true, stdio: ["ignore", out, out] });
  child.unref();
  writePidFile(root, "visitor", child.pid, conf);
  const port = firstBindPort(root);
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!isPidAlive(child.pid)) {
      removePidFile(root, "visitor");
      return { ok: false, error: "隧道进程启动后立即退出（查看 visitor 日志）" };
    }
    if (port && (await tcpProbe("127.0.0.1", port))) return { ok: true, port };
  }
  return { ok: false, error: "隧道未能在 10 秒内监听（查看 visitor 日志）" };
}

function visitorLogTail(root, maxLines = 120) {
  return tailFile(path.join(root, "node-ctl", "visitor.log"), maxLines);
}

/** App 退出流程：停隧道 → 停本机节点（整树）→ 直报离线（注册记录保留；其他节点不受影响） */
async function shutdownAll(root) {
  const steps = [];
  if (readPidFile(root, "visitor")) {
    const vis = await stopVisitor(root);
    steps.push(vis.ok ? `隧道已停止（PID ${vis.pid}）` : `隧道：${vis.error}`);
  }
  if (readPidFile(root, "agent")) {
    const agt = await stopAgent(root);
    steps.push(agt.ok ? `节点已停止（PID ${agt.pid}${agt.offline ? "，已标记离线" : ""}）` : `节点：${agt.error}`);
  } else {
    const off = await markNodeOffline(root);
    if (off.ok) steps.push("已标记离线");
  }
  return { ok: true, steps };
}

/** 隧道开关（停用状态持久化）：启用=自动重建并启动；停用=停止进程 */
async function setVisitorEnabled(root, enabled) {
  if (enabled) {
    const cfg = getMasterConfig(root) || {};
    cfg.visitorPaused = false;
    saveMasterConfig(root, cfg);
    return ensureVisitor(root);
  }
  const cfg = getMasterConfig(root) || {};
  cfg.visitorPaused = true;
  saveMasterConfig(root, cfg);
  const st = await visitorStatus(root);
  if (!st.running) return { ok: true, already: true, running: false };
  const r = await stopVisitor(root);
  return { ok: r.ok, running: false, pid: r.pid, error: r.error };
}

/** 打包主控配置（多控制端一键迁移用；含管理密钥，属密码级敏感信息） */
function buildMasterExport(root) {
  const cfg = getMasterConfig(root);
  if (!cfg?.registry?.address || !cfg.registry.adminToken) {
    throw new Error("主控配置不完整（缺少 Hub 地址或管理密钥），无法导出");
  }
  return {
    app: "opencode-mesh",
    kind: "master-config",
    version: 1,
    exportedAt: new Date().toISOString(),
    registry: cfg.registry,
    fleetPassword: cfg.fleetPassword || "",
    nodes: cfg.nodes || {},
  };
}

/** 应用导入的主控配置：校验格式 → 合并保存（节点表以导入值为准） */
function applyMasterImport(root, raw) {
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw.replace(/^\uFEFF/, "").trim());
    } catch {
      throw new Error("剪贴板内容不是有效 JSON");
    }
  }
  if (!data || data.app !== "opencode-mesh" || data.kind !== "master-config") {
    throw new Error("剪贴板内容不是 Aoi mesh 主控配置（缺少标识）");
  }
  if (!data.registry?.address || !data.registry?.adminToken) {
    throw new Error("导入配置缺少 Hub 地址或管理密钥");
  }
  const cfg = getMasterConfig(root) || {};
  const mergedNodes = { ...(cfg.nodes || {}), ...(data.nodes || {}) };
  for (const [k, v] of Object.entries(mergedNodes)) {
    if (v && typeof v === "object" && !v.name) v.name = k;
  }
  const merged = {
    registry: {
      address: String(data.registry.address),
      port: parseInt(data.registry.port, 10) || 18080,
      adminToken: String(data.registry.adminToken),
      fingerprint: String(data.registry.fingerprint || cfg.registry?.fingerprint || ""),
    },
    fleetPassword: data.fleetPassword || cfg.fleetPassword || "",
    nodes: mergedNodes,
  };
  saveMasterConfig(root, merged);
  return {
    ok: true,
    registry: merged.registry,
    fleetPassword: !!merged.fleetPassword,
    nodes: Object.keys(merged.nodes).length,
  };
}

async function fleetSnippet(root) {
  const cfg = getMasterConfig(root);
  if (!cfg) return { ok: false, error: "请先配置主控" };
  const regNodes = await registryNodes(root, cfg.registry);
  const names = Object.keys(cfg.nodes || {});
  if (!names.length) return { ok: false, error: "没有节点" };
  const nodeArgs = names.map((key) => {
    const loc = cfg.nodes[key];
    const display = loc.name || key;
    if (loc.opencodeUrl) return `"--node", "${display}=${loc.opencodeUrl}"`;
    const reg = (regNodes || []).find((n) => (n.id || n.name) === key || n.name === display);
    if (reg) return `"--node", "${display}=http://127.0.0.1:${reg.opencodeRemotePort}"`;
    return null;
  });
  if (nodeArgs.includes(null)) return { ok: false, error: "无法确定部分节点地址（配置 registry 或 opencodeUrl）" };
  let password = cfg.fleetPassword || "";
  if (!password) {
    const nodeCfg = readJson(path.join(agentDir(root), "node.json"));
    password = nodeCfg?.opencode?.password || "";
  }
  if (!password) {
    return { ok: false, error: "未设置共享 opencode 密码：请在「主控」页填写，或在「组网」页配置本机节点密码" };
  }
  const snippet = `"fleet": {
  "type": "local",
  "command": [
    "npx", "-y", "opencode-fleet@0.2.0",
    ${nodeArgs.join(",\n    ")},
    "--password", "${password}",
    "--timeout", "600"
  ]
}`;
  return { ok: true, snippet };
}

module.exports = {
  resolveBotCli,
  resolveNodeRuntime,
  findRepoRoot,
  registryRequest,
  registryHttpJson,
  pinnedRequest,
  hardenFile,
  restartLocalOpencode,
  buildMasterExport,
  applyMasterImport,
  readEnvFileValue,
  parseEndpoint,
  envEndpoint,
  ensureRepoRoot,
  syncMasterNodes,
  pruneMasterNodes,
  resetNodeState,
  startNodeFull,
  ensureVisitor,
  setVisitorEnabled,
  shutdownAll,
  markNodeOffline,
  tcpProbe,
  findPidByPort,
  getNodeConfig,
  saveNodeConfig,
  changeNodePassword,
  startAgent,
  stopAgent,
  agentLogTail,
  getMasterConfig,
  saveMasterConfig,
  registryNodes,
  registryFrps,
  listNodesMerged,
  nodeAction,
  generateVisitors,
  visitorStatus,
  startVisitor,
  stopVisitor,
  visitorLogTail,
  fleetSnippet,
};
