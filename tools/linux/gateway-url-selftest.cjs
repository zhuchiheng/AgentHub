// 网关接入地址推导的单元测试
//
// 为什么需要它：这个 bug（容器里显示 http://0.0.0.0:9527/v1 或 127.0.0.1）
// 在桌面端**永远不会出现**（bind 恰好是 127.0.0.1），只在容器部署时暴露。
// 靠浏览器手动验证太脆弱（生产镜像不带 Electron），所以把推导逻辑钉在单测里。
//
// 用法：node tools/linux/gateway-url-selftest.cjs
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert");

// 直接读 TS 源里的推导逻辑做等价实现 —— 避免为一个纯函数引入构建链。
// 一旦 src/utils/gateway-url.ts 改了判定条件，这里必须同步，故在末尾校验关键特征串。
const SRC = path.join(__dirname, "..", "..", "src", "utils", "gateway-url.ts");
const src = fs.readFileSync(SRC, "utf8");

// 特征校验：确保源文件的核心逻辑没被改掉（改了就提示同步本测试）
const FEATURES = [
  ["通配地址判定", /0\.0\.0\.0/],
  ["回环地址判定", /127\.0\.0\.1/],
  ["浏览器 host 推导", /window\.location\.hostname/],
  ["协议跟随", /protocol === "https:"/],
  ["Web 模式开关", /webServerMode/],
];
for (const [name, re] of FEATURES) {
  assert.ok(re.test(src), `gateway-url.ts 缺少特征「${name}」——推导逻辑已变，请同步本测试`);
}

// ===== 与 src/utils/gateway-url.ts 等价的实现 =====
function isUnconnectable(host) {
  return !host || host === "0.0.0.0" || host === "::" || host === "[::]" || host === "127.0.0.1" || host === "localhost";
}
function gatewayBaseUrl(backendBaseUrl, gatewayPort, webMode, locHost, locProto) {
  const port = gatewayPort || 9527;
  const m = backendBaseUrl ? /^https?:\/\/([^/:]+)/.exec(backendBaseUrl) : null;
  const backendHost = m ? m[1] : "";
  if (backendBaseUrl && !isUnconnectable(backendHost)) return backendBaseUrl;
  if (webMode && locHost && !isUnconnectable(locHost)) {
    const proto = locProto === "https:" ? "https" : "http";
    return `${proto}://${locHost}:${port}/v1`;
  }
  return backendBaseUrl || `http://127.0.0.1:${port}/v1`;
}

let pass = 0, fail = 0;
function t(name, actual, expected) {
  try {
    assert.strictEqual(actual, expected);
    console.log(`  ok  ${name}`);
    pass++;
  } catch {
    console.log(`  FAIL ${name}\n       实际: ${actual}\n       期望: ${expected}`);
    fail++;
  }
}

console.log("=== 网关接入地址推导 ===");

// 核心回归：容器里 bind=0.0.0.0 时，绝不能把通配地址给客户端
t("通配监听地址不进入 baseUrl（后端已修）",
  gatewayBaseUrl("http://127.0.0.1:9527/v1", 9527, false, "", ""),
  "http://127.0.0.1:9527/v1");

t("桌面端行为不变（Electron 无 location）",
  gatewayBaseUrl("http://127.0.0.1:9527/v1", 9527, false, "", ""),
  "http://127.0.0.1:9527/v1");

// 主修复目标：Web 模式下用浏览器地址栏的 host
t("Web + NAS IP：用浏览器 host 替换回环",
  gatewayBaseUrl("http://127.0.0.1:9527/v1", 9527, true, "192.168.1.5", "http:"),
  "http://192.168.1.5:9527/v1");

t("Web + 域名",
  gatewayBaseUrl("http://127.0.0.1:9527/v1", 9527, true, "nas.example.com", "http:"),
  "http://nas.example.com:9527/v1");

t("Web + https 跟随协议",
  gatewayBaseUrl("http://127.0.0.1:9527/v1", 9527, true, "nas.example.com", "https:"),
  "https://nas.example.com:9527/v1");

// 显式指定优先于一切推导
t("AGENTHUB_PUBLIC_HOST 生效时不被浏览器 host 覆盖",
  gatewayBaseUrl("http://192.168.1.172:9527/v1", 9527, true, "10.0.0.9", "http:"),
  "http://192.168.1.172:9527/v1");

// 边界：浏览器 host 也是回环时，不应产生无意义替换（保持后端值）
t("浏览器 host 为回环时保持后端值",
  gatewayBaseUrl("http://127.0.0.1:9527/v1", 9527, true, "127.0.0.1", "http:"),
  "http://127.0.0.1:9527/v1");

t("浏览器 host 为 localhost 时保持后端值",
  gatewayBaseUrl("http://127.0.0.1:9527/v1", 9527, true, "localhost", "http:"),
  "http://127.0.0.1:9527/v1");

// dev:web（无后端、无 location）
t("dev:web 无后端时回落",
  gatewayBaseUrl(undefined, 9527, false, "", ""),
  "http://127.0.0.1:9527/v1");

// 端口缺省
t("端口缺省时用 9527",
  gatewayBaseUrl(undefined, 0, true, "192.168.1.5", "http:"),
  "http://192.168.1.5:9527/v1");

// 通配后端 + Web：必须被浏览器 host 救回来
t("后端为通配地址时由浏览器 host 兜底",
  gatewayBaseUrl("http://0.0.0.0:9527/v1", 9527, true, "192.168.1.5", "http:"),
  "http://192.168.1.5:9527/v1");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
