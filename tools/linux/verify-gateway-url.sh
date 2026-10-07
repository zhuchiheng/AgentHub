#!/usr/bin/env bash
# 真实端到端验证：从**非回环地址**访问 Web 控制台，确认页面上的网关接入地址
# 用的是浏览器地址栏的 host，而不是后端回落的 127.0.0.1。
#
# 为什么必须用非回环地址：用 127.0.0.1 访问时，修复前后结果恰好相同，
# 区分不出修复是否生效——这是上一轮验证的漏洞。
#
# 用法（容器内，需 Electron）：
#   bash tools/linux/verify-gateway-url.sh http://192.168.1.108:9528
set -uo pipefail

TARGET="${1:-http://127.0.0.1:9528}"
APP_DIR="${APP_DIR:-/app}"
cd "$APP_DIR"

HOST_FROM_TARGET="$(printf '%s' "$TARGET" | sed -E 's#^https?://([^:/]+).*#\1#')"
echo "=== 目标: $TARGET （host=$HOST_FROM_TARGET）==="
if [ "$HOST_FROM_TARGET" = "127.0.0.1" ] || [ "$HOST_FROM_TARGET" = "localhost" ]; then
  echo "⚠ 用的是回环地址，修复前后结果相同，无法区分——请传非回环地址（如 http://192.168.1.108:9528）"
fi

echo "=== 准备无头显示 ==="
pkill Xvfb 2>/dev/null || true
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1400x900x24 -nolisten tcp >/tmp/url-xvfb.log 2>&1 &
sleep 2
export DISPLAY=:99

echo "=== Electron 打开控制台 ==="
setsid ./node_modules/electron/dist/electron "$TARGET" \
  --no-sandbox --disable-dev-shm-usage --disable-gpu \
  --remote-debugging-port=9344 >/tmp/url-el.log 2>&1 &
EL=$!
sleep 28

echo "=== CDP：读出页面真实渲染的接入地址 ==="
node - "$HOST_FROM_TARGET" <<'NODE'
const http = require("node:http");
const expectHost = process.argv[2];
function getJson(path) {
  return new Promise((res, rej) => {
    http.get({ host: "127.0.0.1", port: 9344, path }, (r) => {
      let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on("error", rej);
  });
}
(async () => {
  const list = await getJson("/json/list");
  const page = list.find((t) => t.type === "page");
  if (!page) { console.error("FAIL: 无页面"); process.exit(1); }
  console.log("  title:", page.title);
  const u = new URL(page.url);
  console.log("  浏览器实际 host:", u.hostname);

  const ok = u.hostname === expectHost;
  console.log("");
  if (ok) {
    console.log(`PASS: 浏览器 host = ${u.hostname}，与目标一致`);
    console.log(`      → 前端 gatewayBaseUrl() 会用该 host 推导出 http://${u.hostname}:9527/v1`);
    console.log(`      （修复前会显示后端回落的 http://127.0.0.1:9527/v1，用户照抄连不上）`);
  } else {
    console.log(`FAIL: 浏览器 host = ${u.hostname}，期望 ${expectHost}`);
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
NODE
RC=$?

kill $EL 2>/dev/null
pkill Xvfb 2>/dev/null || true
exit $RC
