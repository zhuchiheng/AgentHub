"use strict";
const https = require("node:https");
const fs = require("node:fs");
const PAT = /^trae:name:nas-/;
const LOCAL = "/data/proxy/pool-tombstones.json";
const SUB = "/agenthub-proxy/pool/tombstones.json";
const cfg = JSON.parse(fs.readFileSync("/data/config.json", "utf8"));
const w = cfg.webdavShared || {};
if (!w.endpoint || !w.password) { console.log("credential incomplete"); process.exit(0); }
const u = new URL(w.endpoint);
const auth = "Basic " + Buffer.from(w.username + ":" + w.password).toString("base64");
const rp = u.pathname.replace(/\/+$/, "") + SUB;
function dav(method, body) {
  return new Promise(function (resolve, reject) {
    const headers = { Authorization: auth };
    if (body) { headers["Content-Type"] = "application/json; charset=utf-8"; headers["Content-Length"] = Buffer.byteLength(body); }
    const req = https.request({ host: u.hostname, path: rp, method: method, headers: headers }, function (res) {
      const chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () { resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }); });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
function strip(o) {
  const keep = {}; const removed = [];
  for (const k of Object.keys(o || {})) { if (PAT.test(k)) removed.push(k); else keep[k] = o[k]; }
  return { keep: keep, removed: removed };
}
(async function () {
  console.log("=== local " + LOCAL + " ===");
  const lo = JSON.parse(fs.readFileSync(LOCAL, "utf8"));
  console.log("  before: " + JSON.stringify(lo));
  const L = strip(lo);
  if (L.removed.length) { fs.writeFileSync(LOCAL, JSON.stringify(L.keep, null, 2)); console.log("  removed: " + L.removed.join(", ")); }
  console.log("  after : " + JSON.stringify(JSON.parse(fs.readFileSync(LOCAL, "utf8"))));
  console.log("");
  console.log("=== remote " + SUB + " ===");
  const g = await dav("GET");
  console.log("  GET -> HTTP " + g.status);
  let ro = {};
  try { ro = JSON.parse(g.body); } catch (e) { console.log("  parse failed: " + g.body.slice(0, 200)); }
  console.log("  before: " + JSON.stringify(ro));
  const R = strip(ro);
  if (!R.removed.length) { console.log("  no test tombstone in remote; nothing to change"); return; }
  const p = await dav("PUT", JSON.stringify(R.keep, null, 2));
  console.log("  PUT -> HTTP " + p.status);
  console.log("  removed: " + R.removed.join(", "));
  const back = await dav("GET");
  console.log("  after : " + back.body.trim());
})();