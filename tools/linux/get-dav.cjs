"use strict";
const https = require("node:https");
const fs = require("node:fs");
const sub = process.argv[2];
if (!sub) { console.log("usage: node get-dav.cjs <path>"); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync("/data/config.json", "utf8"));
const w = cfg.webdavShared || {};
if (!w.endpoint || !w.password) { console.log("credential incomplete"); process.exit(0); }
const u = new URL(w.endpoint);
const p = u.pathname.replace(/\/+$/, "") + sub;
const auth = "Basic " + Buffer.from(w.username + ":" + w.password).toString("base64");
https.get({ host: u.hostname, path: p, headers: { Authorization: auth } }, (res) => {
  let d = "";
  res.on("data", (c) => (d += c));
  res.on("end", () => {
    console.log("GET " + sub + " -> HTTP " + res.statusCode);
    if (res.statusCode >= 400) { console.log("resp: " + d.slice(0, 200)); return; }
    try {
      const j = JSON.parse(d);
      console.log("(JSON) 条数: " + Object.keys(j).length);
      for (const k of Object.keys(j)) {
        const v = j[k];
        console.log("   " + k + "  ->  " + (typeof v === "number" && v > 1e12 ? new Date(v).toISOString() : String(v)));
      }
    } catch { console.log("(非 JSON) " + d.slice(0, 500)); }
  });
}).on("error", (e) => console.log("failed: " + e.message));