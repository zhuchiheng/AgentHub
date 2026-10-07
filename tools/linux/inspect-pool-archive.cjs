"use strict";
const https = require("node:https");
const fs = require("node:fs");
const crypto = require("node:crypto");
const zip = require("/app/electron/backend/zip.cjs");
const KDF_SALT = "agenthub-proxy-pool-v1";
const ZIP_ENTRY = "accounts.json";
const cfg = JSON.parse(fs.readFileSync("/data/config.json", "utf8"));
const w = cfg.webdavShared || {};
if (!w.endpoint || !w.password) { console.log("credential incomplete"); process.exit(0); }
const u = new URL(w.endpoint);
const auth = "Basic " + Buffer.from(w.username + ":" + w.password).toString("base64");
function davGet(sub) {
  return new Promise(function (resolve, reject) {
    const p = u.pathname.replace(/\/+$/, "") + sub;
    https.get({ host: u.hostname, path: p, headers: { Authorization: auth } }, function (res) {
      const chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () { res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error("HTTP " + res.statusCode)); });
    }).on("error", reject);
  });
}
function decode(buf, password) {
  const entries = zip.readZip(buf);
  const entry = entries.find(function (e) { return e.name === ZIP_ENTRY; });
  if (!entry) throw new Error("no accounts.json in zip");
  const d = entry.data;
  if (d.subarray(0, 8).toString("latin1") !== "AHPPOOL1") throw new Error("bad envelope");
  const key = crypto.scryptSync(String(password || ""), KDF_SALT, 32);
  const dec = crypto.createDecipheriv("aes-256-gcm", key, d.subarray(8, 20));
  dec.setAuthTag(d.subarray(20, 36));
  const plain = Buffer.concat([dec.update(d.subarray(36)), dec.final()]);
  return JSON.parse(plain.toString("utf8"));
}
(async function () {
  const devs = process.argv.slice(2);
  for (const dev of devs) {
    console.log("=== " + dev + " ===");
    let buf;
    try { buf = await davGet("/agenthub-proxy/pool/archives/" + dev + ".zip"); }
    catch (e) { console.log("  download failed: " + e.message); continue; }
    console.log("  zip size: " + buf.length + " bytes");
    let snap;
    try { snap = decode(buf, w.password); }
    catch (e) { console.log("  decode failed: " + e.message); continue; }
    console.log("  device: " + snap.deviceName + "  exportedAt: " + new Date(snap.exportedAt).toISOString());
    console.log("  total accounts: " + snap.accounts.length);
    const byCh = {};
    for (const a of snap.accounts) { const k = a.channel; if (!byCh[k]) byCh[k] = []; byCh[k].push((a.name || a.uid || "?") + (a.token ? "" : "[no-token]")); }
    for (const ch of Object.keys(byCh).sort()) console.log("    " + ch + " (" + byCh[ch].length + "): " + byCh[ch].join(", "));
  }
})();