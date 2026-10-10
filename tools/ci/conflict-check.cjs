#!/usr/bin/env node
/**
 * CI 冲突检测：检查当前 HEAD 与「上游 main」以及「其它开放 PR」是否存在合并冲突。
 *
 * ⚠️ 核心陷阱：`git merge-tree --write-tree A B` 在【无冲突】时只输出一行 tree OID；
 *   在【有冲突】时输出里会出现 `CONFLICT` 行。**必须匹配 CONFLICT 关键字**——
 *   若按「输出是否多行」判断，会把所有冲突误判为可合并。
 *
 * 为什么必须查「其它开放 PR」：只查 vs 上游 main 抓不到真正的风险——
 * 基于 main 的分支彼此之间不冲突，但**两个 PR 改到同一处**时会冲突，
 * 这要等维护者合并时才暴露（我们踩过：3 对 PR 间冲突就是这么发现的）。
 *
 * 用法：
 *   node tools/ci/conflict-check.cjs                       # 查 上游 main + 所有开放 PR
 *   node tools/ci/conflict-check.cjs --no-prs              # 只查上游 main（无 token 时的降级）
 *   UPSTREAM=owner/repo UPSTREAM_REF=main node tools/ci/conflict-check.cjs
 *
 * 环境变量：
 *   GITHUB_TOKEN / GH_TOKEN  查开放 PR 需要（CI 里是 secrets.GITHUB_TOKEN，只读足够）
 *
 * 退出码：0 = 无冲突；1 = 检出冲突；2 = 环境问题（拿不到上游等）
 */
"use strict";

const { execFileSync } = require("node:child_process");

const UPSTREAM = process.env.UPSTREAM || "HUIdada1/AgentHub";
const UPSTREAM_REF = process.env.UPSTREAM_REF || "upstream/main";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const NO_PRS = process.argv.includes("--no-prs");

function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    // git 非 0 退出是常态（merge-tree 有冲突时），把输出带回来由调用方判定
    return (e.stdout || "") + (e.stderr || "");
  }
}

/** 静默探测 ref 是否存在（避免 rev-parse 失败时往 stderr 喷 "Needed a single revision"） */
function refExists(ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/** 静默 fetch（不把 git 的进度/错误直接喷到 CI 日志） */
function fetchQuiet(url, refspec) {
  try {
    execFileSync("git", ["fetch", "--no-tags", url, refspec, "--force"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/** 关键：只认 CONFLICT 关键字 */
function hasConflict(out) {
  return /^CONFLICT \(/m.test(out);
}

function conflictFiles(out) {
  // 冲突行形如：`CONFLICT (content): Merge conflict in <path>`
  // 必须从 "in " 之后取路径——用 `.*: ` 贪婪替换会把路径本身吃掉
  return [...new Set(
    (out.match(/^CONFLICT \([^)]*\): Merge conflict in (.+)$/gm) || [])
      .map((s) => s.replace(/^CONFLICT \([^)]*\): Merge conflict in /, "").trim()),
  )];
}

function checkPair(labelA, refA, labelB, refB) {
  const out = git("merge-tree", "--write-tree", refA, refB);
  if (!hasConflict(out)) {
    console.log(`  ✅ ${labelA} × ${labelB}`);
    return null;
  }
  const files = conflictFiles(out);
  console.log(`  ❌ ${labelA} × ${labelB}`);
  files.forEach((f) => console.log(`       ${f}`));
  return { a: labelA, b: labelB, files };
}

/** 确保某个 ref 可用，必要时 fetch（全程静默探测） */
function ensureRef(ref, fetchSpec) {
  if (refExists(ref)) return git("rev-parse", "--short", ref).trim();
  git("remote", "add", "upstream", `https://github.com/${UPSTREAM}.git`);
  if (fetchSpec) fetchQuiet(`https://github.com/${UPSTREAM}.git`, fetchSpec);
  return refExists(ref) ? git("rev-parse", "--short", ref).trim() : null;
}

(async () => {
  console.log(`=== CI 冲突检测 ===`);
  console.log(`  仓库: ${process.cwd()}`);
  console.log(`  上游: ${UPSTREAM} (${UPSTREAM_REF})`);

  const head = git("rev-parse", "--short", "HEAD").trim();
  const upSha = ensureRef(UPSTREAM_REF, `main:refs/remotes/${UPSTREAM_REF}`);
  if (!upSha) {
    console.error(`  [FATAL] 无法获取 ${UPSTREAM_REF}`);
    process.exit(2);
  }
  console.log(`  HEAD=${head}  ${UPSTREAM_REF}=${upSha}\n`);

  const conflicts = [];

  // 1) 与上游 main
  console.log("--- 与上游 main ---");
  const c1 = checkPair("HEAD", "HEAD", UPSTREAM_REF, UPSTREAM_REF);
  if (c1) conflicts.push(c1);

  // 2) 与其它开放 PR（这才是 PR 间冲突的关键检查）
  if (NO_PRS) {
    console.log("\n--- 与其它开放 PR ---\n  ⏭ 已用 --no-prs 跳过");
  } else {
    console.log("\n--- 与其它开放 PR ---");
    if (!TOKEN) {
      console.log("  ⚠ 无 GITHUB_TOKEN，跳过（只查了上游 main）");
      console.log("    提示：PR 间冲突不会在这步暴露，本地可设 GITHUB_TOKEN 后重跑");
    } else {
      let prs = [];
      try {
        const r = await fetch(`https://api.github.com/repos/${UPSTREAM}/pulls?state=open&per_page=100`, {
          headers: { "User-Agent": "agenthub-ci", Accept: "application/vnd.github+json", Authorization: `token ${TOKEN}` },
        });
        prs = await r.json();
        if (!Array.isArray(prs)) {
          console.log(`  ⚠ 查询失败：${JSON.stringify(prs).slice(0, 160)}`);
          prs = [];
        }
      } catch (e) {
        console.log(`  ⚠ 查询开放 PR 异常：${e.message}`);
      }

      let checked = 0, skipped = 0;
      for (const pr of prs) {
        const label = `PR #${pr.number} (${pr.user.login})`;
        // 跳过自己（当前 HEAD 就是本 PR 的分支时）
        const ownSha = git("rev-parse", "--short", "HEAD").trim();
        if (pr.head.sha && pr.head.sha.startsWith(ownSha)) { console.log(`  ⏭ ${label}: 就是当前 HEAD，跳过`); continue; }

        // 优先复用本地已有的 fork 分支（同仓分支直接可用），否则从 fork 拉取到 refs/remotes/pr/<n>
        const ref = `refs/remotes/pr/${pr.number}`;
        if (!refExists(ref)) {
          const url = pr.head.repo ? pr.head.repo.clone_url : null;
          if (!url) { console.log(`  ⚠ ${label}: head 仓库已删除，跳过`); skipped++; continue; }
          if (!fetchQuiet(url, `${pr.head.ref}:${ref}`)) {
            console.log(`  ⚠ ${label}: fetch 失败，跳过`);
            skipped++;
            continue;
          }
        }
        const c = checkPair("HEAD", "HEAD", label, ref);
        if (c) conflicts.push(c);
        checked++;
      }
      console.log(`  已比对 ${checked} 个开放 PR${skipped ? `，跳过 ${skipped} 个` : ""}`);
    }
  }

  console.log(`\n=== 结论 ===`);
  if (!conflicts.length) {
    console.log("  ✅ 无合并冲突");
    process.exit(0);
  }
  console.log(`  ❌ 存在 ${conflicts.length} 处合并冲突：`);
  for (const c of conflicts) console.log(`     ${c.a} × ${c.b} → ${c.files.join(", ")}`);
  console.log("\n  提示：多数「同一行追加」型冲突（两侧都往导出/用例列表尾部加东西）取并集即可；");
  console.log("       真逻辑冲突需人工裁决。本地可用 `git merge-file -p ours base theirs` 看冲突块。");
  process.exit(1);
})();
