// AgentHub Web 服务端：把桌面端的 backend 原样搬到 HTTP 上，浏览器即可访问与配置。
//
// 核心思路：backend 的 ipc.cjs / sync-ipc.cjs / proxy / memory 都是 register(...) 形式，
// 传一个「只登记不派发」的假 ipcMain 进去，就能把所有 handler 收成一张表，
// 前端沿用同一套命令名走 HTTP，61 个 Vue 组件一行都不用改。
//
// 启动：node server/index.cjs   （端口 AGENTHUB_WEB_PORT，默认 9528）
"use strict";

// ===== 第一步必须在 require 任何 backend 之前：把 electron 换成替身 =====
const Module = require("module");
const shim = require("./electron-shim.cjs");
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return shim;
  return origLoad.apply(this, arguments);
};

const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

const PORT = Number(process.env.AGENTHUB_WEB_PORT || 9528);
const HOST = process.env.AGENTHUB_WEB_HOST || "0.0.0.0";
const TOKEN = String(process.env.AGENTHUB_WEB_TOKEN || "").trim(); // 留空 = 不鉴权（仅内网）
const DIST = path.join(__dirname, "..", "dist");

const { collectIpcMain, fakeEvent } = require("./ipc-registry.cjs");
const { ipcMain, handlers } = collectIpcMain();

// 调用计数：用于冒烟验证「前端真的在通过 HTTP 调后端」，而不是仅页面返回 200
let invokeCount = 0;

// ===== 后端模块注册 =====
const backendRoot = path.join(__dirname, "..", "electron", "backend");
const ipc = require(path.join(backendRoot, "ipc.cjs"));
const syncIpc = require(path.join(backendRoot, "sync-ipc.cjs"));
const proxy = require(path.join(backendRoot, "proxy", "index.cjs"));
const memory = require(path.join(backendRoot, "memory", "index.cjs"));
const usageConfig = require(path.join(backendRoot, "sync-config.cjs"));
const usagedb = require(path.join(backendRoot, "db.cjs"));
const usagesync = require(path.join(backendRoot, "sync.cjs"));

const ctx = { ipcMain, app: shim.app, shell: shim.shell, nativeTheme: shim.nativeTheme };
ipc.register(ctx);
syncIpc.registerSync(ctx);
proxy.register(ipcMain);
memory.register(ipcMain);

console.log(`[web] 已登记 ${handlers.size} 个命令`);

// ===== 后端初始化（对齐 main.cjs 的 whenReady 里与界面无关的部分）=====
async function bootBackend() {
  try {
    usagedb.get();
    const cfg0 = usageConfig.loadConfig();
    const localId = usagesync.ensureLocalDeviceId(cfg0);
    usagedb.upsertDevice(
      localId,
      cfg0.deviceName || "本机",
      usagesync.enabledSourceIds(cfg0).join(","),
      usagedb.getLastSyncAt(localId)
    );
  } catch (e) {
    console.error("[web] 用量库初始化失败（其余功能不受影响）:", e && e.message);
  }
  // 反代网关：容器里这正是核心能力，失败要显式报出来
  try {
    await proxy.boot();
    console.log("[web] 反代网关已启动");
  } catch (e) {
    console.error("[web] 反代网关启动失败:", e && e.message);
  }
  try {
    await memory.boot();
    console.log("[web] 记忆中枢已启动");
  } catch (e) {
    console.error("[web] 记忆中枢启动失败（可在设置中启用）:", e && e.message);
  }
}

// ===== 广播：backend 的 app:event 经 SSE 推给浏览器 =====
const sseClients = new Set();
shim.__bus.on("broadcast", ({ channel, payload }) => {
  const data = JSON.stringify({ channel, payload });
  for (const res of sseClients) {
    try {
      res.write(`data: ${data}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
});

// ===== HTTP =====
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let tooBig = false;
    req.on("data", (c) => {
      raw += c;
      // 导入 JSON 账号、粘贴长文本等场景可能较大，给 20MB 上限防止误传大文件打爆内存
      if (raw.length > 20 * 1024 * 1024) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("end", () => (tooBig ? reject(new Error("请求体过大（上限 20MB）")) : resolve(raw)));
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.join(DIST, rel);
  // 防目录穿越
  if (!file.startsWith(DIST)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  fs.stat(file, (err, st) => {
    // SPA 回退：非静态资源一律给 index.html，交给前端路由
    if (err || !st.isFile()) {
      const idx = path.join(DIST, "index.html");
      if (!fs.existsSync(idx)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        return res.end("未找到前端产物，请先运行 npm run build");
      }
      res.writeHead(200, { "content-type": MIME[".html"] });
      return fs.createReadStream(idx).pipe(res);
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = u.pathname;

  if (p === "/api/health") {
    return json(res, 200, {
      ok: true,
      commands: handlers.size,
      platform: process.platform,
      invokeCount,
      sseClients: sseClients.size,
    });
  }

  // SSE：主进程广播（更新状态 / 同步进度 / 网关事件）
  if (p === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    const keepAlive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* 已断开 */
      }
    }, 25000);
    req.on("close", () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
    return;
  }

  if (p === "/api/invoke" && req.method === "POST") {
    if (TOKEN) {
      const got = String(u.searchParams.get("token") || req.headers["x-agenthub-token"] || "");
      if (got !== TOKEN) return json(res, 401, { ok: false, message: "token 无效" });
    }
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (e) {
      return json(res, 400, { ok: false, message: `请求体解析失败：${e.message}` });
    }
    const cmd = String((payload && payload.cmd) || "").trim();
    const args = payload && payload.args ? payload.args : {};
    const fn = handlers.get(cmd);
    if (!fn) {
      return json(res, 404, { ok: false, message: `未知命令：${cmd}` });
    }
    invokeCount += 1;
    try {
      const out = await fn(fakeEvent(), args);
      return json(res, 200, out === undefined ? { ok: true } : out);
    } catch (e) {
      // 与桌面端一致：失败统一转成 { ok:false, message }，前端 call() 会拦下来抛异常
      return json(res, 200, { ok: false, message: String((e && e.message) || e) });
    }
  }

  if (p.startsWith("/api/")) return json(res, 404, { ok: false, message: `未知接口：${p}` });

  return serveStatic(req, res, p);
});

server.listen(PORT, HOST, () => {
  console.log(`[web] AgentHub Web 已启动: http://localhost:${PORT}`);
  console.log(`[web] 鉴权: ${TOKEN ? "已启用（token）" : "未启用（仅内网可信环境）"}`);
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    console.warn(`[web] 警告：未找到 ${DIST}/index.html，请运行 npm run build`);
  }
  bootBackend().catch((e) => console.error("[web] 后端启动异常:", e && e.message));
});

const stop = () => {
  try {
    proxy.shutdown();
  } catch {}
  try {
    memory.shutdown();
  } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
