// 隔离验证服务端 SSE 条目清理：连上、断开、看计数是否回落。
//
// 为什么要单独验：容器重启后观测到 sseClients 停在 6 不降，
// 需要判断是「服务端没清理断开的连接」（真泄漏）还是「有客户端一直连着」（正常）。
// 在本地起一个干净的 server，不受任何浏览器干扰，结论才可信。
//
// 用法（容器内）：node tools/linux/verify-sse-cleanup.cjs
"use strict";
const http = require("node:http");

const PORT = Number(process.env.AGENTHUB_WEB_PORT || 9528);

function health() {
  return new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: PORT, path: "/api/health" }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(d).sseClients);
        } catch {
          resolve(-1);
        }
      });
    }).on("error", () => resolve(-1));
  });
}

function openSSE() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: "/api/events" }, (res) => {
      res.on("data", () => {});
      resolve(req);
    });
    req.on("error", () => resolve(null));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let pass = 0, fail = 0;
  const check = (name, actual, expected) => {
    const ok = expected === null ? actual === 0 : actual === expected;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}（期望 ${expected === null ? 0 : expected}，实际 ${actual}）`);
    ok ? pass++ : fail++;
  };

  const base = await health();
  console.log(`基线 sseClients = ${base}`);
  if (base !== 0) console.log("  ⚠ 基线不是 0，说明已有客户端连着；下面的判定按增量看");

  console.log("\n=== T1: 开 3 条 SSE 连接 ===");
  const conns = [];
  for (let i = 0; i < 3; i++) {
    conns.push(await openSSE());
    await sleep(150);
  }
  await sleep(800);
  const afterOpen = await health();
  check("开 3 条后计数应 +3", afterOpen, base + 3);

  console.log("\n=== T2: 主动断开全部连接 ===");
  for (const c of conns) {
    try {
      c.destroy();
    } catch {
      /* 已断 */
    }
  }
  await sleep(1500);
  const afterClose = await health();
  check("断开后计数应回落到基线", afterClose, base === 0 ? null : base);

  console.log("\n=== T3: 客户端被强杀（模拟容器/页面被干掉）===");
  // 起一个子进程连 SSE，然后直接 kill，模拟「连接没有优雅关闭」
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, ["-e", `
    const http=require('node:http');
    for(let i=0;i<2;i++){
      const r=http.get({host:'127.0.0.1',port:${PORT},path:'/api/events'},res=>res.on('data',()=>{}));
      r.on('error',()=>{});
    }
    setTimeout(()=>{},600000);
  `], { stdio: "ignore" });
  await sleep(2500);
  const duringChild = await health();
  check("子进程连 2 条后计数应 +2", duringChild, base + 2);
  child.kill("SIGKILL");
  await sleep(2500);
  const afterKill = await health();
  check("子进程被强杀后计数应回落（服务端清理生效）", afterKill, base === 0 ? null : base);

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(fail === 0
    ? "结论：服务端会正确清理断开的 SSE 条目，之前的 6 是真实客户端连接"
    : "结论：服务端存在 SSE 条目泄漏，需要改用 res.on('close') 清理");
  process.exit(fail === 0 ? 0 : 1);
})();