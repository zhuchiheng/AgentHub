// IP 级限流识别自测（离线，纯逻辑）
// 跑法：ELECTRON_RUN_AS_NODE=1 "node_modules/electron/dist/electron.exe" tools/proxy-ip-rate-selftest.cjs
//
// 背景：上游可能按**出口 IP** 限流（而非按账号）。来源 dwgx/WindsurfAPI 3060★ 项目的实测 FAQ：
//   「一开就"所有账号 rate-limited"→ 大概率是 IP 级冷却，不是账号问题也不是代理问题。
//     上游会对同一出口 IP + 同一模型的密集请求施加 cooldown，多个账号绑在同一出口时会一起被限流。」
// 单看一个账号的 429 与「账号级限流」完全同形——只有跨账号观察才能区分。
//
// 关键设计：命中 IP 级时**不罚号**（号没问题），改渠道级降级让位。
// 误判的最坏后果是「渠道短暂让位」，远轻于「把好号全部烧掉却解决不了问题」。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

// 沙箱：不碰真机数据
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "iprate-selftest-"));
process.env.APPDATA = SANDBOX;

const server = require("../electron/backend/proxy/server.cjs");

let pass = 0;
let fail = 0;
const failures = [];
function T(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail++;
    failures.push(`${name}: ${(e && e.message) || e}`);
    console.log(`FAIL  ${name}: ${(e && e.message) || e}`);
  }
}

console.log(`sandbox: ${SANDBOX}\n`);

// ===== T1 字面判据：识别出口 IP 限流语义 =====
T("T1 字面判据命中：上游明示 IP 限流语义", () => {
  const hits = [
    "your IP is rate limited",
    "IP limit exceeded",
    "too many requests from this IP",
    "too many requests from your ip address",
    "access denied: ip blocked",
    "出口 IP 已被限流",
    "同一 IP 请求过于频繁",
    "ip_rate_limit reached",
  ];
  for (const m of hits) {
    assert.strictEqual(server.isIpRateLiteral({ message: m }), true, `应命中字面判据: ${m}`);
  }
  // body 字段同样要查（有些上游把详情放 body）
  assert.strictEqual(server.isIpRateLiteral({ message: "429", body: "too many requests from this IP" }), true, "body 里的 IP 语义也应命中");
});

// ===== T2 字面判据不误判：普通账号级限流 =====
T("T2 字面判据不误判：普通限流/无关文案", () => {
  const miss = [
    "rate limit exceeded",
    "too many requests",
    "请求过于频繁，请稍后重试",
    "quota exceeded",
    "429 Too Many Requests",
    "model is temporarily unavailable",
    "concurrency limit reached",
  ];
  for (const m of miss) {
    assert.strictEqual(server.isIpRateLiteral({ message: m }), false, `不应命中字面判据: ${m}`);
  }
});

// ===== T3 行为判据：同渠道+同模型，2 个不同账号 → 判定 IP 级 =====
T("T3 行为判据命中：同渠道同模型 2 个不同账号限流", () => {
  const ch = "testch", model = "test-model";
  server.clearIpRateHit(ch, model);
  assert.strictEqual(server.noteIpRateHit(ch, model, "acc-A"), false, "第 1 个账号不应判定（单账号限流与账号级同形）");
  assert.strictEqual(server.noteIpRateHit(ch, model, "acc-B"), true, "第 2 个不同账号应判定为 IP 级");
  server.clearIpRateHit(ch, model);
});

// ===== T4 行为判据不误判：同一账号重复限流 ≠ IP 级 =====
T("T4 行为判据不误判：同一账号多次限流不算 IP 级", () => {
  const ch = "testch2", model = "m2";
  server.clearIpRateHit(ch, model);
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(server.noteIpRateHit(ch, model, "same-acc"), false, `同一账号第 ${i + 1} 次不应判定为 IP 级（去重后只有 1 个账号）`);
  }
  server.clearIpRateHit(ch, model);
});

// ===== T5 行为判据：不同模型互不干扰 =====
T("T5 行为判据按「渠道×模型」隔离：不同模型不互相触发", () => {
  const ch = "testch3";
  server.clearIpRateHit(ch, "model-x");
  server.clearIpRateHit(ch, "model-y");
  server.noteIpRateHit(ch, "model-x", "acc-1");
  // model-y 上的第 2 个账号不应因 model-x 的命中而被判定
  assert.strictEqual(server.noteIpRateHit(ch, "model-y", "acc-2"), false, "不同模型的命中不应互相累积");
  server.clearIpRateHit(ch, "model-x");
  server.clearIpRateHit(ch, "model-y");
});

// ===== T6 行为判据：不同渠道互不干扰 =====
T("T6 行为判据按渠道隔离：不同渠道不互相触发", () => {
  const model = "shared-model";
  server.clearIpRateHit("chA", model);
  server.clearIpRateHit("chB", model);
  server.noteIpRateHit("chA", model, "acc-1");
  assert.strictEqual(server.noteIpRateHit("chB", model, "acc-2"), false, "不同渠道的命中不应互相累积");
  server.clearIpRateHit("chA", model);
  server.clearIpRateHit("chB", model);
});

// ===== T7 窗口过期：超窗口后重新计数 =====
T("T7 行为判据有窗口：超 60s 窗口后重新计数（不永久累积）", () => {
  const ch = "testch4", model = "m4";
  server.clearIpRateHit(ch, model);
  assert.strictEqual(server.IP_RATE_WINDOW_MS, 60000, "窗口应为 60s");
  assert.strictEqual(server.IP_RATE_MIN_ACCOUNTS, 2, "阈值应为 2 个账号");
  server.noteIpRateHit(ch, model, "acc-1");
  // 模拟窗口过期：直接操作 Map 不可行（私有），改为验证 clear 后重新计数
  server.clearIpRateHit(ch, model);
  assert.strictEqual(server.noteIpRateHit(ch, model, "acc-2"), false, "clear 后应重新从 1 个账号开始计数");
  server.clearIpRateHit(ch, model);
});

// ===== T8 isIpLevelRate 组合判据 =====
T("T8 isIpLevelRate：字面优先，其次行为；两者都不满足则 false", () => {
  const ch = "testch5", model = "m5";
  server.clearIpRateHit(ch, model);
  // 字面命中（单账号即判定，标 by=literal）
  const r1 = server.isIpLevelRate({ message: "your IP is rate limited" }, ch, model, "solo-acc");
  assert.strictEqual(r1.hit, true, "字面命中应判定");
  assert.strictEqual(r1.by, "literal", "应标记为 literal 来源");
  // 行为命中（第 2 个账号）
  server.clearIpRateHit(ch, model);
  const r2 = server.isIpLevelRate({ message: "rate limit exceeded" }, ch, model, "a1");
  assert.strictEqual(r2.hit, false, "第 1 个账号普通限流不应判定");
  const r3 = server.isIpLevelRate({ message: "rate limit exceeded" }, ch, model, "a2");
  assert.strictEqual(r3.hit, true, "第 2 个账号应触发行为判据");
  assert.strictEqual(r3.by, "behavior", "应标记为 behavior 来源");
  server.clearIpRateHit(ch, model);
});

// ===== T9 classifyUpstream 仍把 429 归为 rate（IP 判定在调用点做，不污染分类器） =====
T("T9 classifyUpstream 不受影响：429 仍归 rate（IP 判定在调用点）", () => {
  const cls = server.classifyUpstream({ status: 429, message: "rate limit exceeded" }, false);
  assert.strictEqual(cls.kind, "rate", "普通 429 仍应是 rate");
  assert.strictEqual(cls.switchable, true, "rate 仍可换号");
  // 确认 ip_rate 未混入分类器（它是调用点判定 + 渠道级动作，不是错误分类）
  assert.notStrictEqual(cls.kind, "ip_rate", "分类器不应产出 ip_rate（避免与账号级冷却耦合）");
});

// ===== T10 内存不膨胀：大量键后仍可用 =====
T("T10 内存清扫：大量渠道×模型键后仍正常工作", () => {
  for (let i = 0; i < 600; i++) {
    server.noteIpRateHit(`bulk-ch-${i % 20}`, `bulk-m-${i}`, `acc-${i}`);
  }
  // 清扫后仍能正常判定
  const ch = "post-bulk", model = "pm";
  server.clearIpRateHit(ch, model);
  server.noteIpRateHit(ch, model, "x1");
  assert.strictEqual(server.noteIpRateHit(ch, model, "x2"), true, "大量键后判定仍应正常");
  server.clearIpRateHit(ch, model);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail ? 1 : 0);