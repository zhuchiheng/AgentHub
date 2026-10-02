// Linux 冒烟测试：用项目**真实的** sqlcipher.cjs（koffi FFI + libsqlcipher.so.0）
// 打开「Windows sqlcipher.dll 写出的」加密库，走一遍 available → open → queryAll → close。
//
// 这一步比单独验证 .so 更有价值：它同时验证了
//   ① 原生库查找逻辑（dirNames / libDir / 依赖预载）
//   ② koffi 在该平台能否正常 require
//   ③ raw key 与 Windows 侧是否等价
//
// 用法（Linux，需已 npm ci 装好 koffi）：
//   node tools/linux/smoke-sqlcipher.cjs
"use strict";
const path = require("node:path");
const fs = require("node:fs");

const BASE = path.join(__dirname, "..", "..");
const sqlcipher = require(path.join(BASE, "electron", "backend", "sqlcipher.cjs"));
const dbPath = path.join(__dirname, "xcheck-win-made.db");

console.log("platform :", process.platform, process.arch);
console.log("libDir   :", fs.existsSync(path.join(BASE, "resources", `sqlcipher-linux-${process.arch}`))
  ? `resources/sqlcipher-linux-${process.arch}` : "(未找到)");

if (!fs.existsSync(dbPath)) {
  console.error("缺少测试库 xcheck-win-made.db —— 请先在 Windows 上运行 tools/linux/verify-win-dll.py 生成");
  process.exit(2);
}

const ok = sqlcipher.available();
console.log("available:", ok);
if (!ok) {
  console.error("不可用原因:", sqlcipher.unavailableReason());
  process.exit(1);
}

let db = null;
try {
  db = sqlcipher.open(dbPath);
  const rows = sqlcipher.queryAll(db, "SELECT id, note FROM xcheck ORDER BY id");
  console.log("rows     :", JSON.stringify(rows));
  const hit = Array.isArray(rows) && rows.some((r) => r.note === "hello-from-windows-dll");
  console.log(hit ? "\nPASS: Linux 侧完整读通 Windows 写出的加密库" : "\nFAIL: 读出内容不符");
  process.exit(hit ? 0 : 1);
} catch (e) {
  console.error("\nFAIL:", e && e.message);
  process.exit(1);
} finally {
  if (db) sqlcipher.close(db);
}
