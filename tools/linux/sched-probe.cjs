// 容器内调度探活：确认「持续领积分 + 提供模型服务」依赖的配置真的生效。
//
// 为什么不用「读进程内 timer」：新起的 node 进程拿不到主进程的定时器。
// 这里改查可观测的配置与状态，任一项不对就说明容器适配没生效。
//
// 用法（容器内）：node tools/linux/sched-probe.cjs
"use strict";
const http = require("node:http");

function invoke(cmd, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ cmd, args: args || {} });
    const req = http.request(
      {
        host: "127.0.0.1",
        port: Number(process.env.AGENTHUB_WEB_PORT || 9528),
        path: "/api/invoke",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  const cfg = await invoke("load_config");
  const p = cfg.proxy || {};
  console.log("=== 容器内调度配置 ===");
  console.log("  checkinAuto        :", p.checkinAuto, "(持续领积分)");
  console.log("  checkinAutoTime    :", p.checkinAutoTime);
  console.log("  creditsRefreshMin  :", p.creditsRefreshMin, "(额度刷新间隔)");
  console.log("  restoreOnLaunch    :", p.restoreOnLaunch, "(网关自启)");
  console.log("  bind               :", p.bind, "(0.0.0.0 才能对外提供服务)");

  const gw = await invoke("proxy_status");
  console.log("=== 网关 ===");
  console.log("  running            :", gw.running);
  console.log("  port               :", gw.port);

  const ci = await invoke("proxy_checkin_status", { channel: "" });
  console.log("=== 签到 ===");
  console.log("  total              :", ci.total, ci.total === 0 ? "（号池为空属预期，接入本身正常）" : "");
  console.log("  okCount            :", ci.okCount);

  const ok = p.checkinAuto === true && p.restoreOnLaunch === true && gw.running === true && p.bind === "0.0.0.0";
  console.log(ok ? "\nPASS: 容器内调度配置全部就位" : "\nFAIL: 调度配置未完全生效");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("探测失败:", e && e.message);
  process.exit(1);
});