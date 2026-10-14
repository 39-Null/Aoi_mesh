const fs = require("fs");
const path = require("path");

(async () => {
  const mod = await import("png-to-ico");
  const pngToIco = mod.default ?? mod;
  const src = path.join(__dirname, "assets", "Aoi.png");
  const dst = path.join(__dirname, "assets", "icon.ico");
  const buf = await pngToIco(src);
  fs.writeFileSync(dst, buf);
  console.log(`icon written: ${dst} (${buf.length} bytes)`);
})().catch((err) => {
  console.error("make-icon failed:", err);
  process.exit(1);
});
