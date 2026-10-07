// 容器环境适配层：把「桌面端假设」在容器里补齐，且**不改桌面端默认行为**。
//
// 为什么单独一层：AgentHub 是桌面应用，有几处默认值在 NAS/容器里会直接让核心能力失效，
// 但那些默认值对桌面用户是正确的，不能动。这里统一用环境变量在容器内覆盖。
//
// 必须在 require backend 之前调用 applyContainerEnv()，因为配置在 boot 时就会被读取。
"use strict";
const fs = require("node:fs");
const path = require("node:path");

/** 是否运行在容器化/服务端模式（server/index.cjs 会置位） */
function isServerMode() {
  return process.env.AGENTHUB_SERVER_MODE === "1";
}

/**
 * 把环境变量映射成配置覆盖。
 *
 * 三个必须覆盖的点（都是桌面默认值在容器里会失效的地方）：
 *   1. proxy.bind     默认 127.0.0.1 —— 容器里只监听回环，外部根本连不上，
 *                     「提供模型服务」直接不成立。
 *   2. proxy.restoreOnLaunch 默认 false（语义是「上次退出时网关是开是关」）——
 *                     容器重启后网关不会自动起来，服务中断。
 *   3. proxy.checkinAuto 默认 false —— 「持续领积分」要求它常开。
 *                     注意签到的到点判定用本地时间，容器默认 UTC 会让 09:00
 *                     变成北京时间 17:00，必须同时保证 TZ 正确（见下方检查）。
 *
 * @param {object} config backend/config.cjs 模块
 */
function applyContainerEnv(config) {
  if (!isServerMode()) return { applied: [] };
  const applied = [];

  let cfg;
  try {
    cfg = config.loadConfig();
  } catch (e) {
    return { applied, error: String((e && e.message) || e) };
  }
  cfg.proxy = cfg.proxy || {};

  const set = (key, value, why) => {
    if (cfg.proxy[key] === value) return;
    cfg.proxy[key] = value;
    applied.push(`${key} = ${JSON.stringify(value)}  (${why})`);
  };

  // 1) 监听地址：容器内必须 0.0.0.0，否则宿主机/其它容器连不上
  const bind = String(process.env.AGENTHUB_PROXY_BIND || "0.0.0.0").trim();
  set("bind", bind, "容器内需对外提供模型服务");

  // 2) 网关开机自启：容器重启后服务要能自动恢复
  if (String(process.env.AGENTHUB_PROXY_AUTOSTART || "1") !== "0") {
    set("restoreOnLaunch", true, "容器重启后自动恢复网关服务");
  }

  // 3) 定时签到：持续领积分
  if (String(process.env.AGENTHUB_CHECKIN_AUTO || "1") !== "0") {
    set("checkinAuto", true, "NAS 常驻持续领积分");
    const t = String(process.env.AGENTHUB_CHECKIN_TIME || "").trim();
    if (t && /^\d{1,2}:\d{2}$/.test(t)) set("checkinAutoTime", t, "签到时刻（本地时区）");
  }

  // 4) 定时额度刷新：NAS 常驻时保持额度新鲜（默认 30 分钟，可调）
  const cr = Number(process.env.AGENTHUB_CREDITS_REFRESH_MIN || 0);
  if (cr > 0) set("creditsRefreshMin", cr, "额度刷新间隔（分钟）");

  try {
    config.saveConfig(cfg);
  } catch (e) {
    return { applied, error: `保存失败：${String((e && e.message) || e)}` };
  }
  return { applied };
}

/**
 * 时区自检：签到按本地时间判定「今天是否已跑」。
 * 容器默认 UTC 时，北京时间 09:00 会被当成 UTC 01:00，签到时刻整体偏移 8 小时，
 * 更糟的是跨零点时可能把「当天已跑」算到错误的日期上。
 */
function checkTimezone() {
  const tz = process.env.TZ || "";
  const offsetMin = -new Date().getTimezoneOffset();
  const offsetH = offsetMin / 60;
  const looksCst = offsetH === 8;
  return {
    TZ: tz || "(未设置，默认 UTC)",
    offset: `UTC${offsetH >= 0 ? "+" : ""}${offsetH}`,
    ok: looksCst,
    hint: looksCst
      ? ""
      : "签到按本地时间判定，当前偏移非 UTC+8。请在 compose 里设置 TZ=Asia/Shanghai 并挂载 /etc/localtime",
  };
}

/** 数据目录自检：确认落在挂载卷上，否则容器重建会丢数据 */
function checkDataDir(dataDir, mountPoint) {
  const mp = mountPoint || "/data";
  let onVolume = false;
  try {
    // 挂载点存在且数据目录在其下，视为已持久化
    onVolume = fs.existsSync(mp) && path.resolve(dataDir).startsWith(path.resolve(mp));
  } catch { /* 判定失败按未持久化处理 */ }
  return { dataDir, mountPoint: mp, onVolume };
}

module.exports = { isServerMode, applyContainerEnv, checkTimezone, checkDataDir };
