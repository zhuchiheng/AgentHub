// 每日免费额度 → 模型可用 token 换算分析器
//
// 功能：
//   ① 读取用户配置的 modelReverseAliases（统一请求名 → 各渠道实际模型名）
//   ② 调各渠道 checkinStatus 实测「每人每日可领积分」
//   ③ 受控计费探针：大输入小输出 + 小输入定长输出，用上游 usage.credit（优先）
//      与即时余额前后差双口径，解出 输入/输出 单价（credits/token）
//   ④ 换算：纯输入 / 纯输出 / 4:1（典型 Coding）三种口径的每日可用 token
//
// 运行前提（两个都必须，否则会误判「所有账号无凭据」）：
//   · Electron 主进程运行时：凭据是 DPAPI 信封，解密依赖 safeStorage
//     （ELECTRON_RUN_AS_NODE 下 safeStorage 不可用，解密返回空串）
//   · userData 指向 agenthub：脚本已自动 app.setName + setPath
//
// 用法：
//   node_modules\electron\dist\electron.exe tools\proxy-token-analyzer.cjs [--models a,b] [--out file]
//   产出 JSON 明细默认写 %TEMP%\daily-token-calc.json
//
// 已知局限（2026-10-05 实测）：
//   · raccoon 结算延迟（探针窗口内余额不动），其系数需用多日历史回归，本工具输出的
//     raccoon in/out 系数仅供参考
//   · qoder / workbuddy_ai 的部分目标模型实测零扣费（免费窗口或 rate=0），换算结果为
//     「不限量」，受官方限流约束
//   · 无缓存口径为保守下界；真实负载缓存命中高时实际可跑量显著更大
//   · 分支不含某渠道适配器时（如 lobster），对应行自动跳过并注明
"use strict";
const path = require("node:path"), fs = require("node:fs");
const { app } = require("electron");
app.setName("AgentHub");
app.setPath("userData", path.join(process.env.APPDATA || "", "agenthub"));
const hardTimeout = (ms, label) => new Promise((_, rej) => setTimeout(() => rej(new Error(label + " timeout " + ms + "ms")), ms));

// ---- 参数 ----
const args = process.argv.slice(2);
const argOf = (k, dflt) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const MODEL_FILTER = argOf("--models", "").split(",").map((s) => s.trim()).filter(Boolean);
const OUT_FILE = argOf("--out", path.join(process.env.TEMP || ".", "daily-token-calc.json"));
// 每请求硬超时（ms）：防止个别上游挂起拖死整轮
const T_CHAT = 25000, T_BAL = 15000, T_CHK = 15000;

app.whenReady().then(async () => {
  const root = path.join(__dirname, "..");
  const store = require(path.join(root, "electron", "backend", "proxy", "store.cjs"));
  const rules = require(path.join(root, "electron", "backend", "proxy", "rules.cjs"));
  const ads = require(path.join(root, "electron", "backend", "proxy", "adapters.cjs"));
  rules.init(); store.open();

  const cfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, "agenthub", "config.json"), "utf8")).proxy || {};
  const rev = cfg.modelReverseAliases || {};
  const MAPS = {
    "glm-5.3-flash": { ...(rev["glm-5.3-flash"] || {}) },
    "deepseek-v4.1-flash": { ...(rev["deepseek-v4.1-flash"] || {}) },
  };
  const UNIFIED = (MODEL_FILTER.length ? MODEL_FILTER : Object.keys(MAPS)).filter((u) => MAPS[u]);
  if (!UNIFIED.length) { console.log("无可用统一模型（检查 --models 或 config.json 的 modelReverseAliases）"); app.exit(2); return; }

  const firstAcc = (ch) => {
    const a = store.listAccounts(ch).find((x) => { const s = store.accountSecrets(store.getAccount(x.id)); return s && s.token && s.token.length > 10; });
    return a ? { a, sec: store.accountSecrets(store.getAccount(a.id)) } : null;
  };
  const bal = async (ch, a, sec) => {
    const ad = ads.get(ch);
    if (!ad) return null;
    const r = await Promise.race([ad.queryCredits(a, sec), hardTimeout(T_BAL, ch + ":bal")]).catch((e) => ({ error: String(e.message || e) }));
    return (r && Number.isFinite(Number(r.credits))) ? Number(r.credits) : null;
  };
  const chat1 = async (ch, actual, a, sec, messages, maxTok) => {
    const ad = ads.get(ch);
    if (!ad || typeof ad.chat !== "function") return { ok: false, usage: null, error: "本分支无该渠道适配器" };
    const body = { model: actual, stream: true, messages, max_completion_tokens: maxTok, max_tokens: maxTok };
    let txt = "", err = null, usage = null;
    const t0 = Date.now();
    const work = ad.chat({ account: a, secrets: sec, model: actual, body, emit: (ev) => {
      if (ev.type === "delta" && ev.delta && typeof ev.delta.content === "string") txt += ev.delta.content;
      else if (ev.type === "usage") usage = ev.usage;
      else if (ev.type === "error") err = ev;
    }});
    try { await Promise.race([work, hardTimeout(T_CHAT, ch + ":" + actual)]); } catch (e) { err = { message: e.message }; }
    return { ok: !err, usage, text: txt, error: err ? String(err.message || err) : "", ms: Date.now() - t0 };
  };
  const rndWord = () => Math.random().toString(36).slice(2, 8);
  const bigPrompt = (nWords) => Array.from({ length: nWords }, rndWord).join(" ");

  const out = [];
  console.log("=== A. 每人每日可领积分（checkinStatus 实测） ===");
  for (const ch of [...new Set(UNIFIED.flatMap((u) => Object.keys(MAPS[u])))]) {
    const ad = ads.get(ch); const acc = firstAcc(ch);
    if (!ad || !acc) { out.push({ channel: ch, daily: null, src: ad ? "无凭据" : "本分支无适配器" }); continue; }
    let d = null, src = "接口不可用";
    try {
      const s = await Promise.race([ad.checkinStatus(acc.a, acc.sec), hardTimeout(T_CHK, ch + ":chk")]).catch((e) => ({ error: String(e.message || e) }));
      if (s) {
        const cand = [s.reward, s.rewardCredits, s.dailyCredit, s.creditsEarnedToday, s.credits, (s.plans && s.plans.length ? s.plans[0].priority : null)]
          .map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0);
        if (cand.length) { d = Math.max(...cand); src = "checkinStatus"; }
        else if (s.message) src = "msg:" + String(s.message).slice(0, 40);
      }
    } catch (e) { src = "ERR:" + String(e.message || e).slice(0, 40); }
    out.push({ channel: ch, daily: d, src });
    console.log("  " + ch.padEnd(14) + (d != null ? (d + " /日（" + src + "）") : src));
  }

  console.log("\n=== B. 受控计费探针（usage.credit 优先，余额差兜底） ===");
  for (const u of UNIFIED) {
    console.log("\n── " + u + " ──");
    for (const [ch, actual] of Object.entries(MAPS[u])) {
      const acc = firstAcc(ch);
      if (!acc) { console.log("  " + ch.padEnd(14) + actual.padEnd(24) + "❌ 无凭据"); continue; }
      const { a, sec } = acc;
      const b0 = await bal(ch, a, sec);
      const r1 = await chat1(ch, actual, a, sec,
        [{ role: "user", content: "忽略以下填充内容。只回复两个字：收到\n" + bigPrompt(2600) }], 8);
      const b1 = await bal(ch, a, sec);
      const r2 = await chat1(ch, actual, a, sec,
        [{ role: "user", content: "从 1 数到 60，用顿号分隔，不要其他内容。" }], 300);
      const b2 = await bal(ch, a, sec);

      const U1 = r1.usage || {}, U2 = r2.usage || {};
      const credit1 = Number(U1.credit ?? U1.total_credit ?? 0) || 0;
      const credit2 = Number(U2.credit ?? U2.total_credit ?? 0) || 0;
      const pin = Number(U1.prompt_tokens) || 0, cread = Number(U1.cache_read_tokens ?? ((U1.prompt_tokens_details || {}).cached_tokens)) || 0;
      const pout2 = Number(U2.completion_tokens) || 0;
      const pin2 = Number(U2.prompt_tokens) || 0, cread2 = Number(U2.cache_read_tokens ?? ((U2.prompt_tokens_details || {}).cached_tokens)) || 0;
      const freshIn = Math.max(pin - cread, 0);
      const cost1 = credit1 > 0 ? credit1 : (Number.isFinite(b0) && Number.isFinite(b1) ? b0 - b1 : null);
      const cost2 = credit2 > 0 ? credit2 : (Number.isFinite(b1) && Number.isFinite(b2) ? b1 - b2 : null);
      const inCost = (cost1 != null && freshIn > 0) ? cost1 / freshIn : null;
      const outCostRaw = (cost2 != null && pout2 > 0) ? cost2 / pout2 : null;
      const outCost = (outCostRaw != null && inCost != null) ? (cost2 - inCost * Math.max(pin2 - cread2, 0)) / pout2 : outCostRaw;
      out.push({ unified: u, channel: ch, actual, uid: a.uid, b0, b1, b2,
        p1: { pin, cache_read: cread, out: Number(U1.completion_tokens) || 0, credit: credit1 || null, ok: r1.ok, err: r1.error.slice(0, 60) },
        p2: { pin: pin2, cache_read: cread2, out: pout2, credit: credit2 || null, ok: r2.ok, err: r2.error.slice(0, 60) },
        inCostPerTok: inCost, outCostPerTok: outCost });
      const f = (x) => (x == null ? "—" : (Math.abs(x) < 1e-6 ? "≈0" : x.toExponential(4)));
      console.log("  " + ch.padEnd(14) + actual.padEnd(22) + "in=" + f(inCost) + " out=" + f(outCost)
        + "  [P1 ok=" + r1.ok + " | P2 ok=" + r2.ok + " out=" + pout2 + "]");
    }
  }

  console.log("\n=== C. 每日免费额度 → token（单账号，无缓存口径） ===");
  const daily = Object.fromEntries(out.filter((x) => x.channel && x.daily != null).map((x) => [x.channel, x.daily]));
  for (const u of UNIFIED) {
    console.log("\n── " + u + " ──");
    for (const [ch] of Object.entries(MAPS[u])) {
      const rec = out.find((x) => x.unified === u && x.channel === ch);
      if (!rec || rec.inCostPerTok == null) { console.log("  " + ch.padEnd(14) + "无法换算（无有效计费样本）"); continue; }
      const D = daily[ch];
      if (D == null) { console.log("  " + ch.padEnd(14) + "每日额度未知（系数已测）"); continue; }
      const inT = D / rec.inCostPerTok;
      const outT = rec.outCostPerTok ? D / rec.outCostPerTok : null;
      const mix = rec.outCostPerTok ? D / (0.8 * rec.inCostPerTok + 0.2 * rec.outCostPerTok) : null;
      const k = (x) => (x == null ? "—" : Math.round(x).toLocaleString("en-US"));
      console.log("  " + ch.padEnd(14) + "日领 " + D + " → 纯输入 " + k(inT) + " | 纯输出 " + k(outT) + " | 4:1 " + k(mix) + " tok");
    }
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), "utf8");
  console.log("\n明细已存 " + OUT_FILE);
  app.exit(0);
}).catch((e) => { console.error("FATAL", e); try { app.exit(1); } catch { process.exit(1); } });