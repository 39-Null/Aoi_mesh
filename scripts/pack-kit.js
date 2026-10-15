#!/usr/bin/env node
/**
 * opencode-mesh 便携包组装脚本（跨平台）
 *
 * 用法：
 *   node scripts/pack-kit.js --platform win   --app node-app/dist-win/opencode-mesh-win32-x64
 *   node scripts/pack-kit.js --platform linux --app node-app/dist-linux/opencode-mesh-linux-x64
 *
 * 产出（默认输出到 dist-kits/）：
 *   opencode-mesh-<platform>-v<version>/(组装目录)
 *   opencode-mesh-<platform>-v<version>.zip 或 .tar.gz
 *   SHA256SUMS
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const REPO = path.join(__dirname, "..");

function parseArgs(argv) {
  const out = { platform: "win", out: path.join(REPO, "dist-kits"), version: "", app: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--platform") out.platform = argv[++i];
    else if (a === "--app") out.app = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--version") out.version = argv[++i];
  }
  return out;
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyFile(rel, dst) {
  const src = path.join(REPO, rel);
  if (!fs.existsSync(src)) throw new Error(`缺少源文件：${rel}`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyTree(rel, dst) {
  const src = path.join(REPO, rel);
  if (!fs.existsSync(src)) throw new Error(`缺少源目录：${rel}`);
  fs.cpSync(src, dst, { recursive: true });
}

function copyAppDir(appDir, dst) {
  const resolved = path.resolve(appDir || "");
  if (!appDir || !fs.existsSync(resolved)) throw new Error(`app 目录不存在：${appDir}（先运行 npm run pack:win）`);
  fs.cpSync(resolved, dst, { recursive: true });
}

function sha256(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

function makeArchive(platform, outDir, kitName) {
  if (platform === "linux") {
    const tgz = path.join(outDir, `${kitName}.tar.gz`);
    rmrf(tgz);
    execFileSync("tar", ["-czf", tgz, "-C", outDir, kitName], { stdio: "inherit" });
    return tgz;
  }
  const zip = path.join(outDir, `${kitName}.zip`);
  rmrf(zip);
  try {
    execFileSync("tar", ["-a", "-c", "-f", zip, "-C", outDir, kitName], { stdio: "inherit" });
  } catch {
    console.warn("tar 打包失败，改用 PowerShell Compress-Archive…");
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `Compress-Archive -Path '${path.join(outDir, kitName)}' -DestinationPath '${zip}' -Force`],
      { stdio: "inherit" }
    );
  }
  return zip;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const platform = args.platform;
  if (!["win", "linux"].includes(platform)) throw new Error(`不支持的平台：${platform}`);

  const appPkg = JSON.parse(fs.readFileSync(path.join(REPO, "node-app", "package.json"), "utf8"));
  const version = (args.version || appPkg.version || "0.0.0").replace(/^v/, "");
  const kitName = `opencode-mesh-${platform}-v${version}`;
  const outDir = path.resolve(args.out);
  const kitDir = path.join(outDir, kitName);
  rmrf(kitDir);
  fs.mkdirSync(kitDir, { recursive: true });

  console.log(`==> 组装 ${kitName}`);

  // 1) Electron 应用 → app/
  copyAppDir(args.app, path.join(kitDir, "app"));

  // 2) 仓库运行时快照 → opencode-mesh/（白名单复制：只带源码/文档/示例，绝不带任何本地运行时与凭据文件）
  const snap = path.join(kitDir, "opencode-mesh");
  copyFile("LICENSE", path.join(snap, "LICENSE"));
  copyFile("README.md", path.join(snap, "README.md"));
  for (const f of fs.readdirSync(path.join(REPO, "docs"))) {
    if (f.endsWith(".md")) copyFile(path.join("docs", f), path.join(snap, "docs", f));
  }
  for (const f of ["agent-mesh-instructions.md", "frps.example.toml", "node.example.json", "nodes.example.json"]) {
    copyFile(path.join("configs", f), path.join(snap, "configs", f));
  }
  copyTree("scripts", path.join(snap, "scripts"));
  rmrf(path.join(snap, "scripts", "kit"));
  rmrf(path.join(snap, "scripts", "pack-kit.js"));
  for (const f of ["lib.js", "cli.js", "mcp-server.js", "package.json", "README.md"]) {
    copyFile(path.join("node-ctl", f), path.join(snap, "node-ctl", f));
  }
  for (const f of ["agent.js", "secret-store.js", "package.json"]) {
    copyFile(path.join("node-agent", f), path.join(snap, "node-agent", f));
  }
  const frpcName = platform === "win" ? "frpc.exe" : "frpc";
  copyFile(path.join("node-agent", "bin", frpcName), path.join(snap, "node-agent", "bin", frpcName));
  if (platform === "win") {
    copyFile(path.join("node-app", "start-bot.vbs"), path.join(snap, "scripts", "win", "start-bot.vbs"));
    copyFile(path.join("node-app", "autostart.ps1"), path.join(snap, "scripts", "win", "autostart.ps1"));
  }

  // 3) 启动入口 + 版本 + 安装说明
  const startCmd = platform === "win" ? "start-app.cmd" : "start-app.sh";
  if (platform === "win") {
    copyFile(path.join("scripts", "kit", "start-app.cmd"), path.join(kitDir, "start-app.cmd"));
  } else {
    const sh = `#!/usr/bin/env sh
# opencode-mesh 便携包启动入口（Linux）
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
export OPENCODE_MESH_ROOT="$DIR/opencode-mesh"
exec "$DIR/app/opencode-mesh" --no-sandbox "$@"
`;
    fs.writeFileSync(path.join(kitDir, "start-app.sh"), sh);
    fs.chmodSync(path.join(kitDir, "start-app.sh"), 0o755);
  }
  fs.writeFileSync(path.join(kitDir, "VERSION"), version + "\n");
  const tpl = fs.readFileSync(path.join(REPO, "scripts", "kit", "README-安装说明.template.md"), "utf8");
  fs.writeFileSync(
    path.join(kitDir, "README-安装说明.md"),
    tpl
      .replaceAll("{{VERSION}}", version)
      .replaceAll("{{PLATFORM_NAME}}", platform === "win" ? "Windows x64" : "Linux x64")
      .replaceAll("{{START_CMD}}", startCmd)
  );

  // 4) 压缩 + 校验和
  console.log("==> 压缩…");
  const archive = makeArchive(platform, outDir, kitName);
  const hash = sha256(archive);
  const sumsPath = path.join(outDir, "SHA256SUMS");
  const base = path.basename(archive);
  const prev = fs.existsSync(sumsPath)
    ? fs.readFileSync(sumsPath, "utf8").split(/\r?\n/).filter((l) => l && !l.endsWith("  " + base))
    : [];
  fs.writeFileSync(sumsPath, [...prev, `${hash}  ${base}`].join("\n") + "\n");
  console.log(`==> 完成：${archive}`);
  console.log(`    SHA256：${hash}`);
})().catch((e) => {
  console.error("pack-kit 失败：" + (e.message || e));
  process.exit(1);
});
