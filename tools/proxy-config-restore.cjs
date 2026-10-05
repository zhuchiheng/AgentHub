// config.json 损坏/被覆盖后的 proxy 段恢复工具
//
// 背景（2026-10-05 事故）：config.json 被部分覆盖（14131B→2412B），proxy 段的
// modelReverseAliases / disabledModels / modelCustom 全部丢失，而 config.json.bak
// 保留了完整配置。本工具从指定备份恢复 proxy 段，其余键以当前文件为准。
//
// 安全设计：
//   · 默认 --dry-run，只打印差异，不写盘
//   · 实际恢复前自动对当前 config.json 做时间戳备份
//   · 只替换顶层 proxy 键（深拷贝），不触碰 webdav 凭据等其它段
//
// 用法（Electron 主进程运行时，恢复本身不需要 safeStorage，但保持环境一致）：
//   node_modules\electron\dist\electron.exe tools\proxy-config-restore.cjs [--dry-run] [--from <bak路径>]
//   备份默认取 <userData>\config.json.bak
"use strict";
const path = require("node:path"), fs = require("node:fs");
const { app } = require("electron");
app.setName("AgentHub");
app.setPath("userData", path.join(process.env.APPDATA || "", "agenthub"));

app.whenReady().then(() => {
  // JSON 容错读取：剥 UTF-8 BOM。事故根因即 BOM——应用 loadConfig 的 JSON.parse
  // 遇 BOM 抛错 → 按「损坏」轮转 .bak 并重写默认值，用户配置因此被清空
  const readJsonLoose = (p) => JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
  const args = process.argv.slice(2);
  const dryRun = !args.includes("--apply"); // 默认 dry-run；--apply 才写盘
  const i = args.indexOf("--from");
  const dir = path.join(process.env.APPDATA || "", "agenthub");
  const curPath = path.join(dir, "config.json");
  const bakPath = (i >= 0 && args[i + 1]) ? path.resolve(args[i + 1]) : path.join(dir, "config.json.bak");

  if (!fs.existsSync(curPath)) { console.error("当前配置不存在: " + curPath); app.exit(1); return; }
  if (!fs.existsSync(bakPath)) { console.error("备份不存在: " + bakPath); app.exit(1); return; }

  const cur = readJsonLoose(curPath);
  const bak = readJsonLoose(bakPath);
  if (!bak.proxy || typeof bak.proxy !== "object") { console.error("备份中无 proxy 段，拒绝恢复"); app.exit(1); return; }

  const before = cur.proxy || {};
  const after = bak.proxy;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  console.log("=== proxy 段差异（备份 → 将恢复为） ===");
  for (const k of keys) {
    const b = JSON.stringify(before[k] ?? null);
    const a = JSON.stringify(after[k] ?? null);
    if (b !== a) console.log("  " + k + ": " + (b.length > 80 ? b.slice(0, 80) + "…" : b) + "  →  " + (a.length > 80 ? a.slice(0, 80) + "…" : a));
  }
  const changed = keys.filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
  if (!changed.length) { console.log("\n无差异，无需恢复。"); app.exit(0); return; }

  if (dryRun) {
    console.log("\n[dry-run] 共 " + changed.length + " 项将恢复。确认无误后加 --apply 执行。");
    app.exit(0); return;
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backup = curPath + ".before-restore-" + stamp;
  fs.copyFileSync(curPath, backup);
  cur.proxy = JSON.parse(JSON.stringify(after));
  const tmp = curPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cur, null, 2), "utf8");
  fs.renameSync(tmp, curPath);
  console.log("\n已恢复 proxy 段（" + changed.length + " 项）。原文件备份于: " + backup);
  console.log("提示：重启 AgentHub 主进程后生效（运行中的实例持有旧内存配置，勿在其界面再点保存，否则会以旧值覆盖）。");
  app.exit(0);
}).catch((e) => { console.error("FATAL", e); app.exit(1); });