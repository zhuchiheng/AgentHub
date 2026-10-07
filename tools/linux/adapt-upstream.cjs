#!/usr/bin/env node
/**
 * AgentHub Linux/容器化适配器 —— 合并上游后一键重新适配
 *
 * ## 为什么需要它
 * AgentHub 是 Windows 优先的桌面应用，移植到 Linux + 容器需要在若干上游文件里
 * 做固定模式的改造。每次合并上游，这些改造要么被覆盖、要么产生冲突。
 * 本脚本把「模式固定、可判定对错」的那部分自动化，把「逻辑复杂、需要判断」的
 * 那部分降级为**检测 + 报告**，绝不盲目改。
 *
 * ## 三层策略（按鲁棒性从高到低）
 *   1. scaffold  —— 新增文件（osdirs / proc / server / tools/linux / Dockerfile …）
 *                   上游没有同名文件，直接落地，**永不冲突**。
 *   2. patch     —— 固定模式的改造（homeDir 收敛、APPDATA 假路径、koffi 惰性加载…）
 *                   发现式扫描 + 幂等应用 + 应用后自校验。
 *   3. verify    —— 结构性改造（sqlcipher 的 .so 支持、isPortable 的 AppImage 分支…）
 *                   只**检测是否已就位**并报告，不自动改：这些改动逻辑复杂，
 *                   上游一变就可能语义漂移，机器判定不了「改得对不对」。
 *
 * ## 用法
 *   node tools/linux/adapt-upstream.cjs            # 检测（默认，只读，不改任何文件）
 *   node tools/linux/adapt-upstream.cjs --apply    # 应用可自动化的部分
 *   node tools/linux/adapt-upstream.cjs --json     # 机器可读输出
 *
 * ## 退出码
 *   0 = 全部就位；1 = 有需要人工处理的项（--apply 后仍有）
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const APPLY = process.argv.includes("--apply");
const JSON_OUT = process.argv.includes("--json");

// ===== 结果收集 =====
const report = { scaffold: [], patch: [], verify: [], warnings: [], ignorable: [], hints: [] };
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join("/");
}
function read(p) {
  return fs.readFileSync(p, "utf8");
}
function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

// ===========================================================================
// 第 1 层：scaffold —— 新增文件（上游无同名，永不冲突）
// ===========================================================================
// 这些文件是本移植独有的：上游没有、也不会与上游改动冲突。
// 合并上游后若被误删（例如 checkout 冲突解决时），这里能补回来。
const SCAFFOLD_FILES = [
  // 平台目录适配层 + 进程工具
  "electron/backend/osdirs.cjs",
  "electron/backend/proxy/proc.cjs",
  // Web 服务端
  "server/index.cjs",
  "server/electron-shim.cjs",
  "server/ipc-registry.cjs",
  "server/container-env.cjs",
  // 容器与构建
  "Dockerfile",
  "docker-compose.yml",
  ".dockerignore",
  // Linux 工具链
  "tools/linux/build-sqlcipher.sh",
  "tools/linux/Dockerfile.smoke",
  "tools/linux/run-headless.sh",
  "tools/linux/run-web-smoke.sh",
  "tools/linux/sched-probe.cjs",
  "tools/linux/gw-auth-check.sh",
  "tools/linux/inspect-sources.cjs",
  "tools/linux/smoke-osdirs.cjs",
  "tools/linux/smoke-sqlcipher.cjs",
  "tools/linux/verify-linux-so.py",
  "tools/linux/verify-win-dll.py",
  // CI
  ".github/workflows/linux-smoke.yml",
  // 文档
  "docs/Linux适配方案.md",
  "docs/Web端方案.md",
  "docs/NAS部署指南.md",
];

// ===========================================================================
// 第 2 层：patch —— 固定模式改造（发现式 + 幂等 + 自校验）
// ===========================================================================
//
// ⚠ 历史教训：初版脚本硬编码了 9 个文件清单，且用 `if "osdirs" not in txt`
//   判断要不要插 require —— 替换函数体后文本里已出现 "osdirs"，于是判断被
//   自己刚写的字符串骗过，**9 个文件全部漏了 require**，应用启动即崩
//   （main.cjs 的 whenReady 抛 ReferenceError，窗口根本没建）。
//   而 vue-tsc / node --check 全绿，只有真跑起来才暴露。
//   所以这里的规则是：**发现式扫描 + 用正则判断 require 是否存在 + 应用后复检**。

/** 需要 osdirs 的平台样板 → 统一收敛。返回被改的文件列表 */
function patchHomeDir() {
  const changed = [];
  const backendDir = path.join(ROOT, "electron", "backend");
  if (!exists(backendDir)) return changed;

  // 发现式：扫描所有 .cjs，不硬编码清单（上游新增 adapter 也能覆盖）
  const targets = fs.readdirSync(backendDir)
    .filter((f) => f.endsWith(".cjs"))
    .map((f) => path.join(backendDir, f));

  // 要收敛的样板（上游可能换写法，这里覆盖已知变体）
  const PATTERNS = [
    /return process\.env\.USERPROFILE \|\| process\.env\.HOME \|\| "\.";/,
    /return process\.env\.HOME \|\| process\.env\.USERPROFILE \|\| "\.";/,
  ];

  for (const file of targets) {
    let txt;
    try { txt = read(file); } catch { continue; }

    const hit = PATTERNS.some((re) => re.test(txt));
    if (!hit) continue;

    if (!APPLY) {
      changed.push(rel(file));
      continue;
    }

    let next = txt;
    for (const re of PATTERNS) {
      next = next.replace(re, "return osdirs.home();");
    }

    // 用正则判断 require 是否真的存在 —— 不能再用子串包含判断（那次崩的根因）
    const hasRequire = /const\s+osdirs\s*=\s*require\(\s*["']\.\/osdirs\.cjs["']\s*\)/.test(next);
    if (!hasRequire) {
      const lines = next.split("\n");
      let lastReq = -1;
      for (let i = 0; i < Math.min(lines.length, 60); i++) {
        if (/^const\s+.*=\s*require\(.*\);\s*$/.test(lines[i])) lastReq = i;
      }
      if (lastReq < 0) {
        report.warnings.push(`${rel(file)}: 未找到 require 区，跳过（需人工处理）`);
        continue;
      }
      lines.splice(lastReq + 1, 0, 'const osdirs = require("./osdirs.cjs");');
      next = lines.join("\n");
    }

    if (next !== txt) {
      fs.writeFileSync(file, next, "utf8");
      changed.push(rel(file));
    }
  }
  return changed;
}

/**
 * APPDATA / LOCALAPPDATA 假路径检测。
 *
 * ⚠ 这是**粗筛提示**，不是判定结论。同一个写法在不同文件里语义完全不同：
 *   · expandPath 里是「展开 %APPDATA% 前缀」→ 真问题，必须按平台映射
 *   · wbClient / raccoonClient 里位于 `process.platform !== "win32"` 提前 return
 *     之后 → 死代码，Linux 上根本执行不到
 *   · 跨行的 `...(platform === "win32" ? [...] : [])` 展开 → 写法正确，但正则
 *     识别不了跨行结构，会误报
 *
 * 与其堆更多正则（越堆越脆、越容易被下一个写法绕过），这里明确只做粗筛：
 * 结果归入「提示」而非「待处理」，不参与退出码，由人看一眼决定。
 *
 * 返回 { file, kind: "real" | "deadcode" | "suspect", lines, note }
 */
function patchAppDataPaths() {
  const found = [];
  const backendDir = path.join(ROOT, "electron", "backend");
  if (!exists(backendDir)) return found;

  const BAD = [
    /process\.env\.APPDATA \|\| path\.join\([^)]*"AppData",\s*"Roaming"\)/,
    /process\.env\.LOCALAPPDATA \|\| path\.join\([^)]*"AppData",\s*"Local"\)/,
  ];

  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".cjs")) continue;
      // 跳过 osdirs.cjs 自己：它就是**定义**平台目录的地方，里面的
      // "AppData"/"Roaming" 是 Windows 分支的正确实现，不是待修的假路径。
      if (e.name === "osdirs.cjs") continue;
      let txt;
      try { txt = read(p); } catch { continue; }

      const lines = txt.split("\n");
      // 找出「非 win32 提前 return」的行号：其后的代码在 Linux 上不可达
      const winOnlyGuard = [];
      for (let i = 0; i < lines.length; i++) {
        if (/if\s*\(\s*process\.platform\s*!==\s*["']win32["']\s*\)\s*return/.test(lines[i])) {
          winOnlyGuard.push(i);
        }
      }

      // 找出「平台三元分支」的行号：形如 `isWin\n ? (...)\n : (...)` 或
      // `process.platform === "win32" ? ... : ...`。这种写法里 Windows 分支出现
      // AppData 是**正确的**（Linux 分支另有其值），不该报警。
      const platformTernary = [];
      for (let i = 0; i < lines.length; i++) {
        const isGuardDecl = /(?:const|let|var)\s+\w*(?:isWin|IsWin|win)\w*\s*=\s*process\.platform\s*===\s*["']win32["']/.test(lines[i]);
        const isInlineTernary = /process\.platform\s*===\s*["']win32["'][^?]*\?/.test(lines[i]);
        if (!isGuardDecl && !isInlineTernary) continue;
        // 三元可能跨多行：把声明后 6 行内都视为该三元的分支体
        for (let j = i; j < Math.min(i + 6, lines.length); j++) platformTernary.push(j);
      }

      const hits = [];
      for (let i = 0; i < lines.length; i++) {
        if (!BAD.some((re) => re.test(lines[i]))) continue;
        // 该行是否处于 win32-only 路径（不可达）
        const inWinOnly = winOnlyGuard.some((g) => i > g && i - g < 200);
        // 该行是否处于「平台三元」的 Windows 分支（写法正确）
        const inPlatformTernary = platformTernary.includes(i);
        hits.push({ line: i + 1, inWinOnly, inPlatformTernary });
      }
      if (!hits.length) continue;

      // 只保留真正的问题行：既不在 win32-only 路径，也不在平台三元分支里
      const realHits = hits.filter((h) => !h.inWinOnly && !h.inPlatformTernary);
      const deadHits = hits.filter((h) => h.inWinOnly);

      if (!realHits.length) {
        if (deadHits.length) {
          found.push({
            file: rel(p),
            kind: "deadcode",
            lines: deadHits.map((h) => h.line),
            note: "位于「非 win32 提前 return」之后，Linux 上不可达（死代码，可忽略）",
          });
        }
        // 仅存在于平台三元分支里的，属于正确写法，完全不上报
        continue;
      }

      found.push({
        file: rel(p),
        kind: "suspect",
        lines: realHits.map((h) => h.line),
        note: "疑似 Windows 优先写法（跨行平台分支会误报，需人工确认一眼）",
      });
    }
  };
  walk(backendDir);
  return found;
}

/** sqlcipher.cjs 的 koffi 是否已惰性加载（顶层 require 会让整个应用起不来） */
function checkKoffiLazy() {
  const f = path.join(ROOT, "electron", "backend", "sqlcipher.cjs");
  if (!exists(f)) return { ok: false, note: "sqlcipher.cjs 不存在" };
  const txt = read(f);
  const topLevelRequire = /^const\s+koffi\s*=\s*require\(["']koffi["']\);/m.test(txt);
  if (topLevelRequire) {
    return { ok: false, note: "koffi 在模块顶层 require —— 该模块被 sync-adapter 加载期整表引用，一处失败会连带整个应用起不来" };
  }
  const lazy = /require\(["']koffi["']\)/.test(txt) && /function\s+ensureLib/.test(txt);
  return { ok: lazy, note: lazy ? "已惰性加载" : "未找到惰性加载结构" };
}

// ===========================================================================
// 第 3 层：verify —— 结构性改造（只检测，不自动改）
// ===========================================================================
//
// 这些改动逻辑复杂、与上游实现细节耦合，机器判定不了「改得对不对」，
// 因此只报告状态，交由人工确认。盲目自动化比不自动化更危险。

function verifyStructural() {
  const items = [];

  // 1) sqlcipher 的 .so 支持
  {
    const f = path.join(ROOT, "electron", "backend", "sqlcipher.cjs");
    const txt = exists(f) ? read(f) : "";
    const hasSo = /libsqlcipher\.so/.test(txt);
    const hasDirNames = /function\s+dirNames/.test(txt);
    items.push({
      name: "sqlcipher 支持 Linux .so",
      ok: hasSo && hasDirNames,
      detail: hasSo && hasDirNames
        ? "已支持（dirNames + libsqlcipher.so）"
        : "缺失：Linux 下找不到原生库，Trae 四源会降级",
      manual: !(hasSo && hasDirNames),
    });
  }

  // 2) isPortable 的 AppImage 分支
  {
    const f = path.join(ROOT, "electron", "backend", "config.cjs");
    const txt = exists(f) ? read(f) : "";
    const hasAppImage = /process\.env\.APPIMAGE/.test(txt);
    items.push({
      name: "isPortable 含 AppImage 分支",
      ok: hasAppImage,
      detail: hasAppImage
        ? "已含（AppImage 按便携版处理：自启会失效、无法原地更新）"
        : "缺失：AppImage 下开机自启会注册失效路径",
      manual: !hasAppImage,
    });
  }

  // 3) 更新清单按平台切换
  {
    const f = path.join(ROOT, "electron", "backend", "updater.cjs");
    const txt = exists(f) ? read(f) : "";
    const hasLinuxYml = /latest-linux\.yml/.test(txt);
    items.push({
      name: "更新清单切 latest-linux.yml",
      ok: hasLinuxYml,
      detail: hasLinuxYml ? "已切换" : "缺失：Linux 客户端会去解析 Windows 的 latest.yml",
      manual: !hasLinuxYml,
    });
  }

  // 4) 前端 Web 模式探测
  {
    const f = path.join(ROOT, "src", "api", "ipc.ts");
    const txt = exists(f) ? read(f) : "";
    const hasProbe = /api\/health/.test(txt) && /isWebServer/.test(txt);
    items.push({
      name: "前端 Web 模式探测（/api/health）",
      ok: hasProbe,
      detail: hasProbe
        ? "已接入（含响应结构校验，避免把 vite 的 index.html 回退当后端）"
        : "缺失：浏览器端会走 mock 而非真实后端",
      manual: !hasProbe,
    });
  }

  // 5) 打包配置的平台分离
  {
    const f = path.join(ROOT, "package.json");
    let ok = false;
    let detail = "package.json 解析失败";
    try {
      const pkg = JSON.parse(read(f));
      const b = pkg.build || {};
      const lin = b.linux || {};
      const hasLinuxTarget = Array.isArray(lin.target) && lin.target.length > 0;
      const hasSoRes = JSON.stringify(lin.extraResources || []).includes("sqlcipher-linux");
      const hasAsarUnpack = Array.isArray(b.asarUnpack);
      ok = hasLinuxTarget && hasSoRes && hasAsarUnpack;
      detail = ok
        ? "linux 目标 + .so extraResources + asarUnpack 均已配置"
        : `缺：${[
          !hasLinuxTarget && "linux.target",
          !hasSoRes && "linux.extraResources(sqlcipher-linux)",
          !hasAsarUnpack && "asarUnpack",
        ].filter(Boolean).join(" / ")}`;
    } catch { /* 解析失败已置 detail */ }
    items.push({ name: "打包配置平台分离", ok, detail, manual: !ok });
  }

  // 6) 容器适配层接线
  {
    const f = path.join(ROOT, "server", "index.cjs");
    const txt = exists(f) ? read(f) : "";
    const wired = /applyContainerEnv/.test(txt);
    items.push({
      name: "容器适配层已接线",
      ok: wired,
      detail: wired ? "已接线" : "缺失：容器里 bind 仍为 127.0.0.1、网关不自启、签到不自动",
      manual: !wired,
    });
  }

  return items;
}

// ===========================================================================
// 主流程
// ===========================================================================
function main() {
  // 第 1 层
  for (const f of SCAFFOLD_FILES) {
    const p = path.join(ROOT, f);
    report.scaffold.push({ file: f, present: exists(p) });
  }

  // 第 2 层
  const homeChanged = patchHomeDir();
  if (APPLY && homeChanged.length) {
    report.patch.push({ name: "homeDir 收敛到 osdirs", files: homeChanged, applied: true });
  } else if (homeChanged.length) {
    report.patch.push({ name: "homeDir 收敛到 osdirs", files: homeChanged, applied: false });
  }

  const appdata = patchAppDataPaths();
  // APPDATA 粗筛结果：不参与退出码（检测精度有限，跨行平台分支会误报），
  // 只作为「提示」列出，由人扫一眼决定是否需要处理。
  for (const d of appdata.filter((x) => x.kind === "deadcode")) {
    report.ignorable.push(`${d.file} L${d.lines.join(",")}：${d.note}`);
  }
  for (const d of appdata.filter((x) => x.kind === "suspect")) {
    report.hints.push(`${d.file} L${d.lines.join(",")}：${d.note}`);
  }

  const koffi = checkKoffiLazy();
  if (!koffi.ok) {
    report.patch.push({ name: "koffi 惰性加载", files: ["electron/backend/sqlcipher.cjs"], applied: false, manual: true, note: koffi.note });
  }

  // 第 3 层
  report.verify = verifyStructural();

  // ---- 自校验：--apply 后必须复检，不能只信"我改过了" ----
  if (APPLY && homeChanged.length) {
    const still = patchHomeDir(); // 再扫一遍，幂等性 + 是否真的改干净
    if (still.length) {
      report.warnings.push(`应用后仍有 ${still.length} 个文件未收敛：${still.join(", ")}`);
    }
    // 语法自检：当年那次崩溃就是语法检查能过、运行才炸，所以这里至少卡语法
    for (const f of homeChanged) {
      try {
        execFileSync(process.execPath, ["--check", path.join(ROOT, f)], { stdio: "pipe" });
      } catch (e) {
        report.warnings.push(`${f}: 语法检查失败 —— ${String(e.stderr || e.message).slice(0, 200)}`);
      }
    }
  }

  // ---- 输出 ----
  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
    return exitCode();
  }

  const missingScaffold = report.scaffold.filter((x) => !x.present);
  log("=== 第 1 层：新增文件（上游无同名，永不冲突）===");
  log(`  已就位 ${report.scaffold.length - missingScaffold.length}/${report.scaffold.length}`);
  if (missingScaffold.length) {
    for (const m of missingScaffold) log(`  ✗ 缺失 ${m.file}`);
    log("  → 这些文件应随分支一起保留；若被误删，从集成分支恢复即可");
  }

  log("\n=== 第 2 层：模式化改造 ===");
  if (!report.patch.length) {
    log("  ✓ 无需处理");
  } else {
    for (const p of report.patch) {
      const tag = p.applied ? "已应用" : p.manual ? "需人工" : "待应用";
      log(`  [${tag}] ${p.name}`);
      for (const f of p.files) log(`         ${f}`);
      if (p.note) log(`         注：${p.note}`);
    }
  }

  log("\n=== 第 3 层：结构性改造（只检测，不自动改）===");
  for (const v of report.verify) {
    log(`  ${v.ok ? "✓" : "✗"} ${v.name}`);
    if (!v.ok) log(`      ${v.detail}`);
  }

  if (report.warnings.length) {
    log("\n=== 警告 ===");
    for (const w of report.warnings) log(`  ! ${w}`);
  }

  if (report.ignorable.length) {
    log("\n=== 可忽略（不影响运行）===");
    for (const w of report.ignorable) log(`  - ${w}`);
  }

  if (report.hints.length) {
    log("\n=== 提示（粗筛结果，需人工扫一眼；跨行平台分支会误报）===");
    for (const h of report.hints) log(`  ? ${h}`);
  }

  const todo = report.verify.filter((v) => !v.ok).length
    + report.patch.filter((p) => !p.applied).length
    + missingScaffold.length;
  log(`\n${todo === 0 ? "✓ 全部就位" : `需处理 ${todo} 项`}${APPLY ? "" : "（加 --apply 应用可自动化部分）"}`);
  return exitCode();
}

function exitCode() {
  const missingScaffold = report.scaffold.filter((x) => !x.present).length;
  // ignorable（死代码等）刻意不计入：它们不影响 Linux 运行，
  // 计进去会让脚本永远返回非 0，久了就没人看这个信号了
  const bad = report.verify.filter((v) => !v.ok).length
    + report.patch.filter((p) => !p.applied).length
    + missingScaffold
    + report.warnings.length;
  return bad === 0 ? 0 : 1;
}

process.exit(main());
