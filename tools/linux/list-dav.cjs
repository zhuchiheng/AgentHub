"use strict";
const https = require("node:https");
const fs = require("node:fs");
const sub = process.argv[2] || "/agenthub-proxy";
const cfg = JSON.parse(fs.readFileSync("/data/config.json", "utf8"));
const w = cfg.webdavShared || {};
if (!w.endpoint || !w.password) { console.log("credential incomplete"); process.exit(0); }
const u = new URL(w.endpoint);
const base = u.pathname.replace(/\/+$/, "");
const davPath = base + sub.replace(/\/+$/, "") + "/";
const auth = "Basic " + Buffer.from(w.username + ":" + w.password).toString("base64");
const body = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>';
const req = https.request({ host: u.hostname, path: davPath, method: "PROPFIND",
  headers: { Authorization: auth, Depth: "1", "Content-Type": "application/xml; charset=utf-8", "Content-Length": Buffer.byteLength(body) } },
  (res) => {
    let d = "";
    res.on("data", (c) => (d += c));
    res.on("end", () => {
      console.log("PROPFIND " + davPath + " -> HTTP " + res.statusCode);
      if (res.statusCode === 404) { console.log("  (not created yet)"); return; }
      if (res.statusCode >= 400) { console.log("  " + d.slice(0, 200)); return; }
      const blocks = d.split(/<d:response>/i).slice(1);
      const self = davPath.replace(/\/$/, "");
      let n = 0;
      for (const b of blocks) {
        const href = (b.match(/<d:href>([^<]+)<\/d:href>/i) || [])[1] || "";
        const size = (b.match(/<d:getcontentlength>([^<]*)<\/d:getcontentlength>/i) || [])[1] || "";
        const mod = (b.match(/<d:getlastmodified>([^<]*)<\/d:getlastmodified>/i) || [])[1] || "";
        const isDir = /<d:collection\s*\/>/i.test(b);
        const name = decodeURIComponent(href).replace(/\/$/, "");
        if (name === self || !name) continue;
        n++;
        console.log("  " + (isDir ? "[dir]" : "     ") + " " + name + (size ? "  (" + size + " bytes, " + mod + ")" : ""));
      }
      if (!n) console.log("  (empty)");
    });
  });
req.on("error", (e) => console.log("request failed: " + e.message));
req.write(body);
req.end();