// 软错误判据自测（离线，纯函数）
// 跑法：ELECTRON_RUN_AS_NODE=1 "node_modules/electron/dist/electron.exe" tools/proxy-soft-error-selftest.cjs
//
// 背景：上游把业务错误藏在「看起来成功」的响应里是这类渠道的通病（ccLoad 项目称之为
// "soft-error detection"）。各适配器原本各自实现判据，代码重复且覆盖不均——新渠道接入时
// 容易整段漏掉（LobsterAI 实测踩到后补的）。
//
// 本自测覆盖 util.classifySoftError 的判据边界与语义映射，并锁定重构后与旧实现的行为等价性。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "softerr-selftest-"));
process.env.APPDATA = SANDBOX;

const util = require("../electron/backend/proxy/util.cjs");

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

// ===== T1 非软错误：正常响应体必须放行 =====
T("T1 正常响应体不误判（有 choices / 成功哨兵码）", () => {
  // 标准 OpenAI 流式帧
  assert.strictEqual(util.classifySoftError({ choices: [{ delta: { content: "hi" } }] }).isSoftError, false, "正常流式帧");
  // 带成功哨兵 code 的响应（raccoon 用 code:0，部分上游用 200）
  assert.strictEqual(util.classifySoftError({ code: 0, data: {} }).isSoftError, false, "code:0 是成功");
  assert.strictEqual(util.classifySoftError({ code: 200, data: {} }).isSoftError, false, "code:200 是成功");
  assert.strictEqual(util.classifySoftError({ code: 1, data: {} }).isSoftError, false, "code:1 视为成功哨兵");
  // 空对象 / null / 数组 / 裸标量
  assert.strictEqual(util.classifySoftError({}).isSoftError, false, "空对象");
  assert.strictEqual(util.classifySoftError(null).isSoftError, false, "null");
  assert.strictEqual(util.classifySoftError([]).isSoftError, false, "数组");
  assert.strictEqual(util.classifySoftError("abc").isSoftError, false, "裸字符串");
  assert.strictEqual(util.classifySoftError(123).isSoftError, false, "裸数字");
});

// ===== T2 软错误①：200 + error 对象 =====
T("T2 形态①：200 + {error:{code,message}}", () => {
  const r = util.classifySoftError({ error: { code: 500, message: "upstream boom" } });
  assert.strictEqual(r.isSoftError, true, "有 error 对象应判软错误");
  assert.strictEqual(r.code, 500, "应取出业务码");
  assert.strictEqual(r.message, "upstream boom", "应取出消息");
  assert.strictEqual(r.status, 502, "未知码默认 502");
});

// ===== T3 软错误②：200 + 顶层 code 非成功哨兵 =====
T("T3 形态②：200 + 顶层 {code:N≠0, message}", () => {
  const r = util.classifySoftError({ code: 1000007, message: "积分不足" });
  assert.strictEqual(r.isSoftError, true, "顶层非零码应判软错误");
  assert.strictEqual(r.code, 1000007, "应取出码");
  assert.strictEqual(r.planLimit, true, "中文『积分不足』应判 planLimit");
  assert.strictEqual(r.status, 402, "应映射 402");
});

// ===== T4 软错误③：显式失败标志 =====
T("T4 形态③：200 + {success:false} / {ok:false}", () => {
  const r1 = util.classifySoftError({ success: false, message: "failed" });
  assert.strictEqual(r1.isSoftError, true, "success:false 应判软错误");
  const r2 = util.classifySoftError({ ok: false, msg: "bad" });
  assert.strictEqual(r2.isSoftError, true, "ok:false 应判软错误");
  assert.strictEqual(r2.message, "bad", "应兼容 msg 字段");
});

// ===== T5 语义映射：额度耗尽（多渠道码表） =====
T("T5 语义映射：quotaCodes 按渠道传入（raccoon 1000007 / zcode 1005 / trae 1005）", () => {
  // raccoon 的额度码
  const r1 = util.classifySoftError({ code: 1000007 }, { quotaCodes: [1000007] });
  assert.strictEqual(r1.status, 402, "raccoon 额度码 → 402");
  assert.strictEqual(r1.planLimit, true, "应置 planLimit");
  // zcode 的额度码
  const r2 = util.classifySoftError({ code: 1005 }, { quotaCodes: [1005] });
  assert.strictEqual(r2.status, 402, "zcode 额度码 → 402");
  // 未在码表内但文案命中
  const r3 = util.classifySoftError({ code: 9999, message: "Insufficient balance" });
  assert.strictEqual(r3.status, 402, "文案命中 insufficient → 402");
  assert.strictEqual(r3.planLimit, true, "文案命中也应置 planLimit");
  // 中文文案
  const r4 = util.classifySoftError({ code: 8888, message: "账户余额不足，请充值" });
  assert.strictEqual(r4.status, 402, "中文『余额不足』→ 402");
});

// ===== T6 语义映射：凭证失效 =====
T("T6 语义映射：authCodes（401 / 200003 / 1006 / 3012）与文案", () => {
  for (const code of [401, 200003, 1006, 3012]) {
    const r = util.classifySoftError({ code }, { authCodes: [401, 200003, 1006, 3012] });
    assert.strictEqual(r.status, 401, `码 ${code} 应映射 401`);
  }
  const r2 = util.classifySoftError({ code: 7777, message: "token is not active" });
  assert.strictEqual(r2.status, 401, "文案『token is not active』→ 401");
  const r3 = util.classifySoftError({ code: 7777, message: "登录态已过期，请重新登录" });
  assert.strictEqual(r3.status, 401, "中文登录态文案 → 401");
});

// ===== T7 语义映射：限流 =====
T("T7 语义映射：rateCodes（4008 / 429）与文案", () => {
  const r1 = util.classifySoftError({ code: 4008 }, { rateCodes: [4008] });
  assert.strictEqual(r1.status, 429, "4008 → 429");
  const r2 = util.classifySoftError({ code: 429 });
  assert.strictEqual(r2.status, 429, "429 → 429");
  const r3 = util.classifySoftError({ code: 6666, message: "too many requests" });
  assert.strictEqual(r3.status, 429, "文案命中限流 → 429");
  const r4 = util.classifySoftError({ code: 6666, message: "请求过于频繁" });
  assert.strictEqual(r4.status, 429, "中文限流文案 → 429");
});

// ===== T8 优先级：额度 > 凭证 > 限流 > 默认 =====
T("T8 语义优先级：quota 优先于 auth/rate（同一码多义时以额度为准）", () => {
  // 若某渠道的额度码恰好也是通用错误码，quotaCodes 应优先
  const r = util.classifySoftError({ code: 1005 }, { quotaCodes: [1005], rateCodes: [1005] });
  assert.strictEqual(r.status, 402, "额度语义应优先于限流");
  // 文案同时含额度与限流时，额度优先（额度是更明确的终局信号）
  const r2 = util.classifySoftError({ code: 1, message: "rate limit and insufficient balance" });
  // code:1 是成功哨兵且无 error 对象 → 不判软错误（这是有意的：正常帧不该因文案被判错）
  assert.strictEqual(r2.isSoftError, false, "成功哨兵码不应因文案被判软错误");
});

// ===== T9 非 2xx 不判定（由 fetch 层处理，避免双重判定） =====
T("T9 非 2xx 状态不在此判定（避免与 fetch 层双重处理）", () => {
  for (const st of [400, 401, 402, 429, 500, 502, 503]) {
    const r = util.classifySoftError({ error: { code: 1, message: "x" } }, { httpStatus: st });
    assert.strictEqual(r.isSoftError, false, `HTTP ${st} 不应在软错误层判定`);
  }
  // 2xx 才判定
  const ok = util.classifySoftError({ error: { code: 1, message: "x" } }, { httpStatus: 200 });
  assert.strictEqual(ok.isSoftError, true, "HTTP 200 应判定");
});

// ===== T10 带 choices 的响应：仅在有 error 对象时才算软错误 =====
T("T10 带 choices 的正常帧不误判（code 非哨兵时也不误判）", () => {
  // 正常流式帧常带 choices，且 code 可能是任意值（如 usage 里的计数）
  const r = util.classifySoftError({ choices: [{ delta: { content: "x" } }], code: 12345 });
  assert.strictEqual(r.isSoftError, false, "带 choices 且无 error 对象时不应误判（避免把正常帧当错误）");
  // 但若同时带 error 对象，仍应判错
  const r2 = util.classifySoftError({ choices: [{ delta: {} }], error: { code: 402, message: "quota" } });
  assert.strictEqual(r2.isSoftError, true, "带 choices 但同时有 error 对象应判错");
});

// ===== T11 defaultStatus 可配 =====
T("T11 defaultStatus 可配（默认 502，可按渠道覆盖）", () => {
  const r1 = util.classifySoftError({ error: { code: 999, message: "unknown" } });
  assert.strictEqual(r1.status, 502, "默认 502");
  const r2 = util.classifySoftError({ error: { code: 999, message: "unknown" } }, { defaultStatus: 500 });
  assert.strictEqual(r2.status, 500, "可覆盖为 500");
});

// ===== T12 空消息有兜底 =====
T("T12 空消息有兜底文案（不会返回空串）", () => {
  const r = util.classifySoftError({ error: { code: 42 } });
  assert.strictEqual(r.isSoftError, true, "应判软错误");
  assert.ok(r.message && r.message.length > 0, `消息不应为空，实际 "${r.message}"`);
  assert.ok(/42/.test(r.message), "兜底文案应含业务码");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail ? 1 : 0);