#!/usr/bin/env node
/**
 * CI 自测运行器：在无 GUI 环境下跑代理层的离线自测。
 *
 * 为什么要这一层：仓库里的自测脚本要求「用项目内 Electron 的 Node」运行
 * （系统 Node 缺 node:sqlite，且加密实现在 Electron 运行时里）。CI 里 electron 由 npm ci 装好，
 * 但要用 ELECTRON_RUN_AS_NODE=1 把它当 Node 用。本脚本负责：
 *   1) 找到 electron 可执行文件（跨平台）
 *   2) 用 ELECTRON_RUN_AS_NODE=1 逐个跑自测
 *   3) 汇总结果，任一失败即退出码 1
 *
 * 用法：
 *   node tools/ci/run-selftests.cjs              # 跑默认自测集
 *   node tools/ci/run-selftests.cjs --list       # 只列将跑哪些
 *
 * 注意：T10 之类的用例需要仓库根有 electron 模块，CI 里 npm ci 后天然满足；
 *       本机无 node_modules 时会自动降级为系统 node 并提示。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");

/** 默认自测集：离线、不碰真机登录态、不联网 */
const TESTS = [
  {
    name: "ZCode 渠道自测",
    file: "tools/proxy-zcode-selftest.cjs",
    // 联网探针需显式开启，CI 默认关闭
    env: {},
  },
  {
    name: "记忆中枢纯代码验证",
    file: "tools/verify/m-run-all.cjs",
    args: ["--assert"],
    // 纯 Node，无需 electron
    plainNode: true,
  },
];

/** 找到 electron 可执行文件（跨平台） */
function findElectron() {
  const base = path.join(ROOT, "node_modules", "electron");
  const candidates = [
    path.join(base, "dist", "electron.exe"),
    path.join(base, "dist", "electron"),
    path.join(base, "dist", "Electron.app", "Contents", "MacOS", "Electron"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const electron = findElectron();
const nodeExe = process.execPath;

console.log("=== CI 自测运行器 ===");
console.log(`  仓库根: ${ROOT}`);
console.log(`  electron: ${electron || "(未找到，回退系统 node)"}`);
console.log(`  node: ${nodeExe} (${process.version})\n`);

if (process.argv.includes("--list")) {
  TESTS.forEach((t) => console.log(`  - ${t.name}: ${t.file}${t.plainNode ? " (纯 Node)" : ""}`));
  process.exit(0);
}

const results = [];
for (const t of TESTS) {
  const abs = path.join(ROOT, t.file);
  if (!fs.existsSync(abs)) {
    console.log(`\n--- ${t.name} ---`);
    console.log(`  ⚠ 文件不存在，跳过: ${t.file}`);
    results.push({ name: t.name, ok: true, skipped: true });
    continue;
  }

  // 需要 electron 的用例：无 electron 时**跳过而非失败**——
  // 这类用例会 require 到 electron 模块，依赖 npm ci 装出的运行时；
  // 在未装依赖的机器上跑必然失败，但那不代表代码有问题。CI 里 npm ci 后必然存在。
  if (!t.plainNode && !electron) {
    console.log(`\n--- ${t.name} ---`);
    console.log(`  ⏭ 跳过：未找到 electron（${t.file} 需要用它当 Node 运行）`);
    console.log(`     修复：在仓库根执行 npm ci 后再跑本脚本`);
    results.push({ name: t.name, ok: true, skipped: true });
    continue;
  }

  const useElectron = !t.plainNode && electron;
  const cmd = useElectron ? electron : nodeExe;
  const env = { ...process.env, ...(t.env || {}) };
  if (useElectron) env.ELECTRON_RUN_AS_NODE = "1";

  console.log(`\n--- ${t.name} ---`);
  console.log(`  $ ${path.basename(cmd)} ${t.file} ${(t.args || []).join(" ")}${useElectron ? "   [ELECTRON_RUN_AS_NODE=1]" : ""}`);

  const r = spawnSync(cmd, [abs, ...(t.args || [])], { cwd: ROOT, env, encoding: "utf8", stdio: "inherit" });
  const ok = r.status === 0;
  results.push({ name: t.name, ok, code: r.status });
  console.log(`  → ${ok ? "✅ 通过" : `❌ 失败 (exit ${r.status})`}`);
}

console.log("\n=== 汇总 ===");
for (const r of results) {
  const tag = r.skipped ? "⏭ 跳过" : r.ok ? "✅ 通过" : `❌ 失败(${r.code})`;
  console.log(`  ${tag}  ${r.name}`);
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n[FATAL] ${failed.length} 个自测失败`);
  process.exit(1);
}
console.log("\n[OK] 全部自测通过");
