// 跨平台用户目录适配层
//
// 由来：仓库里散落着 20 多处 `process.env.APPDATA || path.join(home, "AppData", "Roaming")`
//   这类写法。在 Windows 上没问题，但 Linux 上这些环境变量不存在，会静默拼出
//   `~/AppData/Roaming/...` 这种必不存在的路径 —— 不报错、不崩溃，数据源永远
//   探测不到，排查成本极高。这里收敛成一处，按平台给出真实候选。
//
// 约定（与既有 electron/backend/proxy/discovery.cjs:38-47 的写法保持一致）：
//   roaming()  「配置类」目录：win %APPDATA% / linux $XDG_CONFIG_HOME||~/.config / mac ~/Library/Application Support
//   local()    「数据类」目录：win %LOCALAPPDATA% / linux $XDG_DATA_HOME||~/.local/share / mac ~/Library/Application Support
//
// 返回值：roaming()/local() 返回**首选**单个路径；roamingDirs()/localDirs()
//   返回候选数组（Linux 上同一应用可能落在 .config 或 .local/share，需都找一遍）。
// Windows 行为与改造前完全一致，不会引入回归。
"use strict";
const os = require("node:os");
const path = require("node:path");

/** 用户主目录：Linux/macOS 用 HOME，Windows 用 USERPROFILE（Electron 下两者通常都有） */
function home() {
  if (process.platform === "win32") {
    return process.env.USERPROFILE || os.homedir();
  }
  return process.env.HOME || os.homedir();
}

/** 配置类目录（Windows 的 Roaming / macOS 的 Application Support / Linux 的 XDG_CONFIG_HOME） */
function roamingDirs() {
  if (process.platform === "win32") {
    return [process.env.APPDATA || path.join(home(), "AppData", "Roaming")];
  }
  if (process.platform === "darwin") {
    return [path.join(home(), "Library", "Application Support")];
  }
  // Linux：XDG_CONFIG_HOME 优先，其次 ~/.config
  return [process.env.XDG_CONFIG_HOME || path.join(home(), ".config")];
}

/** 数据类目录（Windows 的 Local / macOS 的 Application Support / Linux 的 XDG_DATA_HOME） */
function localDirs() {
  if (process.platform === "win32") {
    return [process.env.LOCALAPPDATA || path.join(home(), "AppData", "Local")];
  }
  if (process.platform === "darwin") {
    return [path.join(home(), "Library", "Application Support")];
  }
  // Linux：XDG_DATA_HOME 优先，其次 ~/.local/share
  return [process.env.XDG_DATA_HOME || path.join(home(), ".local", "share")];
}

/** 首选配置目录（单值，用于「写入」场景；探测场景请用 roamingDirs） */
function roaming() {
  return roamingDirs()[0];
}

/** 首选数据目录（单值，用于「写入」场景；探测场景请用 localDirs） */
function local() {
  return localDirs()[0];
}

/**
 * 探测期候选根：把「配置类」与「数据类」候选各拼上 subdir，去重保序。
 * Linux 上天然覆盖 ~/.config/<subdir> 与 ~/.local/share/<subdir> 两处；
 * Windows/macOS 上两类目录通常重合，去重后只剩一条，与改造前行为一致。
 * @param {string[]} subdirs 应用目录名（如 ["Trae", "TRAE SOLO"]）
 * @returns {string[]}
 */
function candidateRoots(subdirs) {
  const out = [];
  // Windows 上「配置类」与「数据类」语义分明，应用数据固定落在 Roaming，
  // 只按 roaming 命中即可（与改造前完全一致，避免多查一处带来意外匹配）；
  // Linux 上同一应用可能落在 .config 或 .local/share，必须都找一遍。
  const bases = process.platform === "win32" ? roamingDirs() : [...roamingDirs(), ...localDirs()];
  for (const base of bases) {
    for (const sub of subdirs) {
      out.push(path.join(base, sub));
    }
  }
  return [...new Set(out)];
}

module.exports = { home, roaming, local, roamingDirs, localDirs, candidateRoots };
