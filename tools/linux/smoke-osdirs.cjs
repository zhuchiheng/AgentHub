// Linux 冒烟：验证 osdirs 适配层给出的目录符合 XDG 规范，
// 且不再出现 ~/AppData/Roaming 这种 Windows 假路径。
"use strict";
const path = require("node:path");
const osdirs = require(path.join(__dirname, "..", "..", "electron", "backend", "osdirs.cjs"));

console.log("platform:", process.platform);
console.log("home    :", osdirs.home());
console.log("roaming :", osdirs.roaming());
console.log("local   :", osdirs.local());
console.log("cands   :", osdirs.candidateRoots(["Trae"]).join("  |  "));

const all = [osdirs.home(), osdirs.roaming(), osdirs.local(), ...osdirs.candidateRoots(["Trae"])];
const bad = all.filter((p) => /AppData/i.test(p));
if (bad.length) {
  console.error("\nFAIL: 仍在拼 Windows 假路径 ——", bad.join(", "));
  process.exit(1);
}
if (!osdirs.roaming().startsWith("/")) {
  console.error("\nFAIL: roaming 不是绝对路径");
  process.exit(1);
}
console.log("\nPASS: 目录解析符合 Linux/XDG，无 AppData 残留");
