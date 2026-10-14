#!/usr/bin/env node
/**
 * opencode-mesh node agent
 * 常驻进程：注册入网、维护 frp 隧道、管理本机 opencode 生命周期、提供受控 API。
 * 仅生命周期命令，不做任意命令执行。
 */
const http = require("http");
const { spawn, exec } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = __dirname;
const CONFIG_FILE = process.env.AGENT_CONFIG || path.join(ROOT, "node.json");
const DATA_DIR = path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const FRPC_CONFIG = path.join(DATA_DIR, "frpc.toml");
const AGENT_LOG = path.join(DATA_DIR, "agent.log");

const VERSION = "0.1.0";

function log(...args) {
  const raw = args.join(" ").replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
  if (!raw) return;
  const line = `[${new Date().toISOString()}] ${raw}`;
  console.log(line);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(AGENT_LOG, line + "\n");
  } catch {}
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error(`缺少配置文件：${CONFIG_FILE}`);
    console.error("可参考 configs/node.example.json 创建");
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    console.error(`配置文件解析失败（${CONFIG_FILE}）：${e.message}`);
    process.exit(1);
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function httpJson(method, urlStr, body, headers = {}, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const url = new URL(urlStr);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(buf);
          } catch {}
          resolve({ status: res.statusCode, json, text: buf });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, json: null, text: "timeout" });
    });
    req.on("error", (e) => resolve({ status: 0, json: null, text: e.message }));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function execCmd(command, timeoutMs = 15000) {
  return new Promise((resolve) => {
    exec(command, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve(String(stdout || "") + String(stderr || ""));
    });
  });
}

async function findPidByPort(port) {
  if (process.platform === "win32") {
    const out = await execCmd("netstat -ano -p tcp");
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 5 && cols[1].endsWith(`:${port}`) && /LISTENING/i.test(cols[3])) {
        const pid = parseInt(cols[4], 10);
        if (Number.isInteger(pid)) return pid;
      }
    }
    return null;
  }
  const out = await execCmd(`ss -ltnp 2>/dev/null | grep ":${port} "`);
  const m = out.match(/pid=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

async function killPid(pid) {
  if (!pid) return false;
  if (process.platform === "win32") {
    await execCmd(`taskkill /pid ${pid} /t /f`);
  } else {
    await execCmd(`kill -TERM ${pid}`);
    await new Promise((r) => setTimeout(r, 1500));
    await execCmd(`kill -KILL ${pid} 2>/dev/null`);
  }
  return true;
}

async function opencodeHealthy(port, password) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/global/health",
        method: "GET",
        headers: password
          ? { Authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") }
          : {},
        timeout: 2500,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(buf);
            resolve(j.healthy === true);
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

class Agent {
  constructor(config) {
    this.config = config;
    this.state = loadState();
    this.opencodeChild = null;
    this.frpcChild = null;
    this.stopRequested = false;
  }

  get hubBase() {
    const { address, port } = this.config.hub;
    return `http://${address}:${port}`;
  }

  async register() {
    const res = await httpJson("POST", `${this.hubBase}/register`, {
      name: this.config.name,
      joinKey: this.config.joinKey,
      version: VERSION,
    });
    if (res.status === 200 && res.json?.ok) {
      this.state = {
        token: res.json.node.token,
        stcpSecret: res.json.node.stcpSecret,
        opencodeRemotePort: res.json.node.opencodeRemotePort,
        agentRemotePort: res.json.node.agentRemotePort,
        frps: res.json.frps,
      };
      saveState(this.state);
      log(`注册成功：node=${this.config.name}（stcp 模式；主控绑定端口 ${this.state.opencodeRemotePort}/${this.state.agentRemotePort}）`);
      return true;
    }
    log(`注册失败（${res.status}）：${res.json?.error || res.text}`);
    return false;
  }

  async ensureRegistered() {
    if (this.state?.token && this.state?.stcpSecret) return true;
    if (this.state?.token && !this.state?.stcpSecret) {
      log("本地状态缺少 stcpSecret（旧版 tcp 状态），尝试用现有 joinKey 重新注册…");
    }
    while (!this.stopRequested) {
      if (await this.register()) return true;
      log("30 秒后重试注册…");
      await new Promise((r) => setTimeout(r, 30000));
    }
    return false;
  }

  writeFrpcConfig() {
    const { frps, stcpSecret } = this.state;
    const opencodePort = this.config.opencode.port;
    const agentPort = this.config.agent.port;
    const toml = `serverAddr = "${frps.addr}"
serverPort = ${frps.port}
auth.method = "token"
auth.token = "${frps.token}"

# stcp：服务不暴露公网端口，主控侧用 visitor + secretKey 接入
[[proxies]]
name = "${this.config.name}_opencode"
type = "stcp"
secretKey = "${stcpSecret}"
localIP = "127.0.0.1"
localPort = ${opencodePort}
transport.useEncryption = true

[[proxies]]
name = "${this.config.name}_agent"
type = "stcp"
secretKey = "${stcpSecret}"
localIP = "127.0.0.1"
localPort = ${agentPort}
transport.useEncryption = true
`;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FRPC_CONFIG, toml);
  }

  startFrpc() {
    let binary = this.config.frpc?.binary || "frpc";
    if (!path.isAbsolute(binary)) {
      const rootRel = path.join(ROOT, binary);
      if (fs.existsSync(rootRel)) binary = rootRel;
    }
    this.writeFrpcConfig();
    const args = ["-c", FRPC_CONFIG];
    const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.frpcChild = child;
    child.stdout.on("data", (d) => log(`[frpc] ${String(d).trim()}`));
    child.stderr.on("data", (d) => log(`[frpc] ${String(d).trim()}`));
    child.on("exit", (code) => {
      this.frpcChild = null;
      if (this.stopRequested) return;
      log(`frpc 退出（code=${code}），5 秒后重启`);
      setTimeout(() => !this.stopRequested && this.startFrpc(), 5000);
    });
    log(`frpc 已启动（${binary}）`);
  }

  /** 重读磁盘配置：让 opencode 密码/端口等变更无需重启 agent 即可生效 */
  reloadRuntimeConfig() {
    try {
      const fresh = loadConfig();
      if (fresh.opencode) this.config.opencode = { ...this.config.opencode, ...fresh.opencode };
      if (fresh.agent?.port) this.config.agent.port = fresh.agent.port;
      if (fresh.frpc) this.config.frpc = { ...(this.config.frpc || {}), ...fresh.frpc };
    } catch (e) {
      log("重读配置失败（沿用内存配置）：" + (e.message || e));
    }
  }

  async startOpencode() {
    this.reloadRuntimeConfig();
    const port = this.config.opencode.port;
    if (await opencodeHealthy(port, this.config.opencode.password)) {
      log("opencode 已在运行，跳过启动");
      return true;
    }
    const busyPid = await findPidByPort(port);
    if (busyPid) {
      log(`端口 ${port} 已被 PID ${busyPid} 占用，但健康检查未通过（密码不匹配或其他程序占用）。请在 node.json 更换 opencode.port 后重启 agent`);
      return false;
    }
    const password = this.config.opencode.password || "";
    const env = { ...process.env };
    if (password) env.OPENCODE_SERVER_PASSWORD = password;
    const cmd = `opencode serve --port ${port}`;
    const child = spawn(cmd, { shell: true, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
    this.opencodeChild = child;
    child.stdout.on("data", (d) => log(`[opencode] ${String(d).trim()}`));
    child.stderr.on("data", (d) => log(`[opencode] ${String(d).trim()}`));
    child.on("exit", (code) => {
      log(`opencode 进程退出（code=${code}）`);
      this.opencodeChild = null;
    });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await opencodeHealthy(port, password)) {
        log("opencode 已就绪");
        return true;
      }
    }
    log("opencode 启动超时（20s 内未就绪）");
    return false;
  }

  async stopOpencode() {
    this.reloadRuntimeConfig();
    const port = this.config.opencode.port;
    const pid = await findPidByPort(port);
    if (!pid) {
      log("stop opencode：未找到监听进程");
      return false;
    }
    await killPid(pid);
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 700));
      if (!(await opencodeHealthy(port, this.config.opencode.password))) {
        log("opencode 已停止");
        return true;
      }
    }
    log("opencode 停止超时");
    return false;
  }

  async statusOpencode() {
    this.reloadRuntimeConfig();
    const port = this.config.opencode.port;
    const healthy = await opencodeHealthy(port, this.config.opencode.password);
    const pid = await findPidByPort(port);
    return { running: healthy, pid };
  }

  startControlServer() {
    const token = this.state.token;
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      const route = `${req.method} ${url.pathname}`;
      const reply = (code, body) => {
        res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
      };
      if (route === "GET /health") {
        return reply(200, { ok: true, name: this.config.name, version: VERSION });
      }
      if (req.headers["x-agent-token"] !== token) {
        return reply(401, { ok: false, error: "unauthorized" });
      }
      try {
        if (route === "GET /opencode/status") {
          return reply(200, { ok: true, ...(await this.statusOpencode()) });
        }
        if (route === "POST /opencode/start") {
          const ok = await this.startOpencode();
          return reply(200, { ok, ...(await this.statusOpencode()) });
        }
        if (route === "POST /opencode/stop") {
          const ok = await this.stopOpencode();
          return reply(200, { ok, ...(await this.statusOpencode()) });
        }
        if (route === "POST /opencode/restart") {
          await this.stopOpencode();
          const ok = await this.startOpencode();
          return reply(200, { ok, ...(await this.statusOpencode()) });
        }
        return reply(404, { ok: false, error: "not found" });
      } catch (e) {
        return reply(500, { ok: false, error: e.message });
      }
    });
    const port = this.config.agent.port;
    server.listen(port, "127.0.0.1", () => log(`控制 API 监听 127.0.0.1:${port}`));
  }

  startHeartbeat() {
    const send = async () => {
      const res = await httpJson(
        "POST",
        `${this.hubBase}/heartbeat`,
        { name: this.config.name, version: VERSION },
        { "X-Node-Token": this.state.token }
      );
      if (res.status === 401) log("心跳被拒绝（可能已被吊销）");
    };
    send();
    setInterval(send, 60_000);
  }

  async run() {
    log(`opencode-mesh node agent v${VERSION} 启动（node=${this.config.name}）`);
    if (!(await this.ensureRegistered())) return;
    this.writeFrpcConfig();
    this.startFrpc();
    this.startControlServer();
    if (this.config.opencode.autoStart !== false) {
      await this.startOpencode();
    }
    this.startHeartbeat();
    log("agent 就绪");
  }

  shutdown() {
    this.stopRequested = true;
    log("正在退出：清理 frpc…");
    if (this.frpcChild) this.frpcChild.kill();
    setTimeout(() => process.exit(0), 1000);
  }
}

const config = loadConfig();
config.name = config.name || os.hostname();
config.opencode = config.opencode || { port: 4096, password: "", autoStart: true };
config.agent = config.agent || { port: 41999 };
const agent = new Agent(config);
process.on("SIGINT", () => agent.shutdown());
process.on("SIGTERM", () => agent.shutdown());
agent.run().catch((e) => {
  log(`agent 异常：${e.stack || e.message}`);
  process.exit(1);
});
