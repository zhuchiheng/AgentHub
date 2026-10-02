// 探查本机用量数据源：逐个调用 adapter.detect()，列出哪些源真的有数据、数据在哪。
// 只读，不修改任何东西。用于回答「用量数据到底从哪来」。
"use strict";
const path = require("node:path");
const BASE = path.join(__dirname, "..", "..");
const { sources } = require(path.join(BASE, "electron", "backend", "sync-adapter.cjs"));

console.log("本机平台:", process.platform, process.arch);
console.log("共注册数据源:", sources.length);
console.log("");

const rows = [];
for (const s of sources) {
  let root = null;
  let err = "";
  try {
    root = s.detect();
  } catch (e) {
    err = String((e && e.message) || e).slice(0, 80);
  }
  rows.push({ id: s.id, name: s.name, root, err });
}

const hit = rows.filter((r) => r.root);
const miss = rows.filter((r) => !r.root);

console.log(`=== 有数据（${hit.length}）===`);
for (const r of hit) console.log(`  ${r.id.padEnd(20)} ${r.name.padEnd(14)} ${r.root}`);
console.log("");
console.log(`=== 本机没找到（${miss.length}）===`);
for (const r of miss) {
  console.log(`  ${r.id.padEnd(20)} ${r.name.padEnd(14)} ${r.err ? "错误: " + r.err : "未安装/无数据"}`);
}
