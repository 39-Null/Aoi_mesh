/**
 * opencode-mesh 凭据加密存储（被 node-agent / node-app / node-ctl 共用）
 *
 * 为什么不是哈希：agent 需要把明文交给 opencode（OPENCODE_SERVER_PASSWORD），
 * 主控需要用明文做 HTTP Basic 重放——两处都必须"可逆"，所以只能加密存储。
 *
 * 存储格式（字符串前缀区分）：
 *   enc:dpapi:<base64>           Windows DPAPI（当前用户），零原生依赖（经 PowerShell）
 *   enc:secret-tool:<keyId>      Linux 密钥环（secret-tool / Secret Service）
 *   plain:<base64>               回退：无可用密钥环时的高权限文件存储（非加密，仅防肉眼直读）
 *
 * 注意：plain 回退不是加密，仅在所有密钥环方案不可用时使用；
 * 文件权限需另行收紧（调用方已 chmod 600）。
 */
const os = require("os");
const { spawnSync } = require("child_process");

const PLAIN_PREFIX = "plain:";
const DPAPI_PREFIX = "enc:dpapi:";
const SECRET_TOOL_PREFIX = "enc:secret-tool:";

function b64encode(s) {
  return Buffer.from(String(s), "utf8").toString("base64");
}
function b64decode(s) {
  return Buffer.from(String(s), "base64").toString("utf8");
}

/* ---------------- Windows DPAPI（PowerShell，零依赖） ---------------- */

function dpapiAvailable() {
  return process.platform === "win32";
}

function dpapiProtect(plain) {
  const script = [
    "$ErrorActionPreference='Stop';",
    "Add-Type -AssemblyName System.Security;",
    "$s=[Console]::In.ReadToEnd().Trim();",
    "$b=[Convert]::FromBase64String($s);",
    "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
    "[Console]::Out.Write([Convert]::ToBase64String($p))",
  ].join(" ");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: b64encode(plain),
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
  });
  if (r.status !== 0 || !r.stdout) {
    throw new Error(`DPAPI 加密失败（${(r.stderr || "").trim().slice(0, 120) || "exit " + r.status}）`);
  }
  return r.stdout.trim();
}

function dpapiUnprotect(payloadB64) {
  const script = [
    "$ErrorActionPreference='Stop';",
    "Add-Type -AssemblyName System.Security;",
    "$s=[Console]::In.ReadToEnd().Trim();",
    "$b=[Convert]::FromBase64String($s);",
    "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
    "[Console]::Out.Write([Convert]::ToBase64String($p))",
  ].join(" ");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: payloadB64,
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
  });
  if (r.status !== 0 || !r.stdout) {
    throw new Error(`DPAPI 解密失败（可能更换了 Windows 用户/系统）`);
  }
  return b64decode(r.stdout.trim());
}

/* ---------------- Linux secret-tool（Secret Service） ---------------- */

let secretToolChecked = null;
function secretToolAvailable() {
  if (secretToolChecked !== null) return secretToolChecked;
  try {
    const r = spawnSync("secret-tool", ["--version"], { encoding: "utf8", timeout: 8000, windowsHide: true });
    secretToolChecked = r.status === 0 || (r.stdout || "").length > 0 || (r.stderr || "").length > 0;
    // 有些版本 --version 返回非 0 但仍可用；再用 lookup 探测
    if (!secretToolChecked) {
      const l = spawnSync("secret-tool", ["lookup", "service", "opencode-mesh-probe", "key", "probe"], { encoding: "utf8", timeout: 8000, windowsHide: true });
      secretToolChecked = l.error ? false : true;
    }
  } catch {
    secretToolChecked = false;
  }
  return secretToolChecked;
}

function keyringStore(keyId, plain) {
  const r = spawnSync(
    "secret-tool",
    ["store", "--label", "opencode-mesh", "service", "opencode-mesh", "key", keyId],
    { input: String(plain), encoding: "utf8", timeout: 15000, windowsHide: true }
  );
  if (r.status !== 0) throw new Error(`密钥环写入失败（${(r.stderr || "").trim().slice(0, 120) || "exit " + r.status}）`);
}

function keyringLookup(keyId) {
  const r = spawnSync("secret-tool", ["lookup", "service", "opencode-mesh", "key", keyId], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  if (r.status !== 0 || !r.stdout) throw new Error("密钥环中未找到该凭据");
  return r.stdout.replace(/\n$/, "");
}

/* ---------------- 对外接口 ---------------- */

/**
 * 封存明文 → 存储字符串。
 * opts.keyId 用于密钥环条目命名（默认 node-opencode-password）。
 */
function seal(plain, opts = {}) {
  const keyId = opts.keyId || "node-opencode-password";
  if (plain === undefined || plain === null) return "";
  const p = String(plain);
  if (!p) return "";
  if (dpapiAvailable()) {
    return DPAPI_PREFIX + dpapiProtect(p);
  }
  if (process.platform !== "win32" && secretToolAvailable()) {
    try {
      keyringStore(keyId, p);
      return SECRET_TOOL_PREFIX + keyId;
    } catch {
      /* 落回 plain */
    }
  }
  return PLAIN_PREFIX + b64encode(p);
}

/** 解封存储字符串 → 明文。解封失败会抛出（调用方须显式处理，不得静默吞掉）。 */
function unseal(stored, opts = {}) {
  const s = String(stored || "");
  if (!s) return "";
  if (s.startsWith(DPAPI_PREFIX)) {
    return dpapiUnprotect(s.slice(DPAPI_PREFIX.length));
  }
  if (s.startsWith(SECRET_TOOL_PREFIX)) {
    const keyId = s.slice(SECRET_TOOL_PREFIX.length) || opts.keyId || "node-opencode-password";
    return keyringLookup(keyId);
  }
  if (s.startsWith(PLAIN_PREFIX)) {
    return b64decode(s.slice(PLAIN_PREFIX.length));
  }
  // 兼容历史：未带前缀的裸明文（旧配置）——视为明文直接返回
  return s;
}

function isSealed(stored) {
  const s = String(stored || "");
  return s.startsWith(DPAPI_PREFIX) || s.startsWith(SECRET_TOOL_PREFIX) || s.startsWith(PLAIN_PREFIX);
}

/** 是否有真正的加密后端可用（plain 回退不算） */
function backendName() {
  if (dpapiAvailable()) return "dpapi";
  if (process.platform !== "win32" && secretToolAvailable()) return "secret-tool";
  return "plain";
}

module.exports = { seal, unseal, isSealed, backendName, PLAIN_PREFIX, DPAPI_PREFIX, SECRET_TOOL_PREFIX };
