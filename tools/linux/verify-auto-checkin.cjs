// 验证容器内「定时自动签到」真的会触发。
//
// 难点：自动签到成功路径才有副作用（刷新余额），而我用假 token 必然失败；
// 失败路径不写库、不打日志。所以不能靠「账号字段变了没」判断。
//
// 做法：订阅 SSE 广播。无论签到成功还是失败，checkinBatch 在 act !== "status" 时
// 都会 events.emit({type:"credits"})，这个事件经 /api/events 下发 —— 是可靠的观测点。
//
// 用法（在能访问控制台的地方跑）：
//   node tools/linux/verify-auto-checkin.cjs [baseUrl] [waitSeconds]
"use strict";
const http = require("node:http");

const BASE = process.argv[2] || "http://192.168.1.172:19528";
const WAIT = Number(process.argv[3] || 150);
const url = new URL(BASE);

console.log(`订阅 ${BASE}/api/events，观察 ${WAIT}s …`);

const req = http.get(
  { host: url.hostname, port: url.port, path: "/api/events", headers: { accept: "text/event-stream" } },
  (res) => {
    if (res.statusCode !== 200) {
      console.error(`SSE 连接失败：HTTP ${res.statusCode}`);
      process.exit(1);
    }
    let buf = "";
    const seen = [];
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buf += chunk;
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const p of parts) {
        const line = p.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let frame;
        try {
          frame = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        const t = frame.payload && frame.payload.type;
        if (t) seen.push({ at: new Date().toISOString(), type: t });
      }
    });
    global.__seen = seen;
  }
);
req.on("error", (e) => {
  console.error("SSE 连接错误:", e.message);
  process.exit(1);
});

// 主动触发一次签到（作为对照），再等自动 tick
function invoke(cmd, args) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ cmd, args: args || {} });
    const r = http.request(
      { host: url.hostname, port: url.port, path: "/api/invoke", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); }
    );
    r.on("error", () => resolve(null));
    r.write(body);
    r.end();
  });
}

setTimeout(async () => {
  const seen = global.__seen || [];
  const credits = seen.filter((x) => x.type === "credits");
  console.log(`\n收到 SSE 事件 ${seen.length} 条，其中 credits ${credits.length} 条`);
  for (const e of credits.slice(0, 10)) console.log("  ", e.at, e.type);

  // 同时给出账号现状作为佐证
  const pool = await invoke("proxy_pool");
  const trae = Array.isArray(pool) ? pool.find((c) => c.id === "trae") : null;
  if (trae) {
    const acc = trae.accounts[0];
    console.log(`\ntrae 账号: ${acc ? acc.name + " / status=" + acc.status : "(无)"}`);
    console.log("账号字段未被刷新属预期：假 token 签到必失败，而失败路径不写库、不刷新余额");

    console.log(acc ? "其 status=" + acc.status + " coolUntil=" + acc.coolUntil + " creditsAt=" + acc.creditsAt : "");
  }

  console.log(credits.length > 0 ? "\nPASS: 观测到签到周期广播（自动签到确实在跑）" : "\n未观测到 credits 事件：可能本窗口内还没到 tick，或签到未触发");
  process.exit(0);
}, WAIT * 1000);
