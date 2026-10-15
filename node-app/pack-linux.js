const path = require("path");
const fs = require("fs");

(async () => {
  const mod = await import("@electron/packager");
  const packager = mod.packager ?? mod.default;

  // 确定性排除 Windows 图标：打包前移出 node-app 目录（放到仓库根），结束后恢复
  const ico = path.join(__dirname, "assets", "icon.ico");
  const icoBak = path.join(__dirname, "..", "icon.ico.packhold");
  let renamed = false;
  if (fs.existsSync(ico)) {
    fs.renameSync(ico, icoBak);
    renamed = true;
  }
  try {
    const appPaths = await packager({
    dir: __dirname,
    name: "opencode-mesh",
    platform: "linux",
    arch: "x64",
    out: path.join(__dirname, "dist-linux"),
    overwrite: true,
    icon: path.join(__dirname, "assets", "Aoi.png"),
    ignore: [
      /^\/dist-linux($|\/)/,
      /^\/dist-win($|\/)/,
      /icon\.ico$/,
      /^\/make-icon\.js$/,
      /^\/pack-linux\.js$/,
      /^\/pack-win\.js$/,
      /^\/autostart\.ps1$/,
      /^\/start-bot\.cmd$/,
      /^\/start-bot\.vbs$/,
    ],
    prune: true,
    });
    console.log("packaged:", appPaths.join(", "));
  } finally {
    if (renamed) fs.renameSync(icoBak, ico);
  }
})().catch((e) => {
  console.error("pack failed:", e);
  process.exit(1);
});
