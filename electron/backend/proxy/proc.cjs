// 反代网关 · 跨平台进程探测与终止
//
// 由来：wbClient.cjs / raccoonClient.cjs 原先对非 Windows 一律短路——
//   procRunning() 直接 `return false`（永远报「未运行」），kill() 直接 `return true`
//   （**谎报成功**）。后者尤其危险：切号流程以为客户端已关，直接改登录文件，
//   结果运行中的客户端一回写就把新账号覆盖成旧账号。
// 这里按 zcodeLocal.cjs 已经验证过的写法抽成公共模块：Windows 走 tasklist/taskkill，
// Unix 走 pgrep/pkill。探测不到就是 false，杀不掉就是 false，绝不假成功。
"use strict";
const { execSync } = require("node:child_process");

/** 200ms 粒度无损休眠（不占 CPU） */
function syncSleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 降级兜底 */ }
  }
}

/**
 * 进程名候选：Windows 保留 .exe 原样；Unix 无扩展名，再补一个小写变体
 * （Linux 上二进制名可能全小写，也可能保留首字母大写的品牌名）。
 */
function procNames(exeName) {
  const names = [exeName];
  if (process.platform !== "win32") {
    const stem = exeName.replace(/\.exe$/i, "");
    names.length = 0;
    names.push(stem, stem.toLowerCase());
  }
  return [...new Set(names)];
}

function quiet() {
  return { encoding: "utf8", windowsHide: true, timeout: 8000, stdio: ["ignore", "ignore", "ignore"] };
}

/** 是否有任一同名进程在运行 */
function running(exeName) {
  if (process.platform === "win32") {
    try {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${exeName}" /NH`, {
        encoding: "utf8",
        windowsHide: true,
        timeout: 8000,
      });
      return /\.exe/i.test(out);
    } catch {
      return false;
    }
  }
  for (const n of procNames(exeName)) {
    try {
      // -x 精确匹配进程名（不做通配，避免误伤他家进程）
      const out = execSync(`pgrep -x ${JSON.stringify(n)}`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 8000 });
      if (String(out || "").trim()) return true;
    } catch { /* pgrep 无匹配返回非 0，继续下一个候选 */ }
  }
  return false;
}

/**
 * 终止进程并等待退出：先优雅关闭（Unix 发 SIGTERM / Windows taskkill 不带 /F，
 * 让编辑器有机会保存与询问），softMs 后仍在跑再强杀。
 * @returns {boolean} 真正确认已退出才 true；杀不掉 / 超时返回 false（**绝不假成功**）
 */
function kill(exeName, timeoutMs = 8000, softMs = 3000) {
  const total = Math.max(1000, timeoutMs);
  if (!running(exeName)) return true;

  if (process.platform === "win32") {
    try { execSync(`taskkill /IM "${exeName}" /T`, quiet()); } catch { /* 可能已退出 */ }
    const softDeadline = Date.now() + Math.min(softMs, total);
    while (Date.now() < softDeadline) {
      if (!running(exeName)) return true;
      syncSleep(200);
    }
    try { execSync(`taskkill /F /IM "${exeName}" /T`, quiet()); } catch { /* 可能已退出 */ }
  } else {
    for (const n of procNames(exeName)) {
      try { execSync(`pkill -x ${JSON.stringify(n)}`, quiet()); } catch { /* 可能已退出 */ }
    }
    const softDeadline = Date.now() + Math.min(softMs, total);
    while (Date.now() < softDeadline) {
      if (!running(exeName)) return true;
      syncSleep(200);
    }
    // 优雅退出未果 → SIGKILL
    for (const n of procNames(exeName)) {
      try { execSync(`pkill -9 -x ${JSON.stringify(n)}`, quiet()); } catch { /* 可能已退出 */ }
    }
  }

  const deadline = Date.now() + total;
  while (Date.now() < deadline) {
    if (!running(exeName)) return true;
    syncSleep(200);
  }
  return !running(exeName);
}

/**
 * 按可执行文件名在 PATH 中定位（Unix 用 which；Windows 由调用方走注册表/候选表，
 * 这里返回空串由调用方降级）。
 */
function whichPath(command) {
  if (process.platform === "win32") return "";
  try {
    const out = execSync(`which ${JSON.stringify(command)}`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 8000 });
    const p = String(out || "").trim().split(/\r?\n/)[0];
    return p || "";
  } catch {
    return "";
  }
}

module.exports = { running, kill, procNames, syncSleep, whichPath };
