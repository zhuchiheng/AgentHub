#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Web 端冒烟：验证「浏览器 → HTTP → backend」这条链路真的通。
#
# 关键点：不能只看页面返回 200——那只证明静态文件在。真正要验证的是
# 前端在没有 window.agenthub 的情况下会自动切到 /api/invoke 并成功拿到数据。
# 所以这里用 Electron **当作普通浏览器**去访问页面（不注入 preload，
# 因此 window.agenthub 不存在，走的就是 Web 路径），再看服务端调用计数。
#
# 用法（容器内）：bash tools/linux/run-web-smoke.sh
# ---------------------------------------------------------------------------
set -uo pipefail

APP_DIR="${APP_DIR:-/app}"
PORT="${PORT:-9528}"
LOG=/tmp/agenthub-web.log
WAIT=25

cd "$APP_DIR"

echo "=== [1] 构建前端 ==="
npm run build >/tmp/web-vite.log 2>&1 || { echo "前端构建失败"; tail -20 /tmp/web-vite.log; exit 1; }

echo "=== [2] 启动 Web 服务端（端口 ${PORT}）==="
AGENTHUB_WEB_PORT="$PORT" node server/index.cjs >"$LOG" 2>&1 &
SRV_PID=$!
sleep 6
if ! kill -0 "$SRV_PID" 2>/dev/null; then
  echo "FAIL: 服务端启动即退出"; cat "$LOG"; exit 1
fi
echo "server pid=$SRV_PID"

echo "=== [3] 准备无头显示 ==="
pkill Xvfb 2>/dev/null || true
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1280x820x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
sleep 2
export DISPLAY=:99

echo "=== [4] 用 Electron 当浏览器访问 http://127.0.0.1:${PORT} ==="
# 注意：这里不给 --app / 不注入 preload，window.agenthub 不存在，
# 前端必须自己识别出 Web 模式并走 /api/invoke —— 与真实浏览器完全一致
setsid ./node_modules/electron/dist/electron \
  "http://127.0.0.1:${PORT}" \
  --no-sandbox --disable-dev-shm-usage --disable-gpu \
  --remote-debugging-port=9333 \
  >/tmp/electron-web.log 2>&1 &
BROWSER_PID=$!
echo "browser pid=$BROWSER_PID"

echo "=== [5] 等待 ${WAIT}s（页面加载 → 探测 /api/health → 拉取配置）==="
sleep "$WAIT"

echo "=== [6] 判定 ①：前端是否真的通过 HTTP 调了后端 ==="
HEALTH="$(curl -fsS --max-time 10 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || echo "")"
if [ -z "$HEALTH" ]; then
  echo "FAIL: 服务端无响应"; cat "$LOG"; kill $SRV_PID $BROWSER_PID 2>/dev/null; exit 1
fi
echo "$HEALTH"
COUNT="$(echo "$HEALTH" | python3 -c "import json,sys; print(json.load(sys.stdin).get('invokeCount',0))" 2>/dev/null || echo 0)"
if [ "${COUNT:-0}" -le 0 ]; then
  echo "FAIL: invokeCount = 0 —— 页面加载了但没调到后端（前端可能仍在走 mock）"
  echo "--- 浏览器日志 ---"; tail -25 /tmp/electron-web.log
  kill $SRV_PID $BROWSER_PID 2>/dev/null
  exit 1
fi
echo "PASS: 前端已通过 HTTP 调用后端 ${COUNT} 次"

echo "=== [7] 判定 ②：页面是否真的渲染（CDP 取 title）==="
curl -fsS --max-time 10 "http://127.0.0.1:9333/json/list" 2>/dev/null | python3 -c "
import json,sys
try:
    ts=json.load(sys.stdin)
except Exception:
    print('FAIL: CDP 无响应'); sys.exit(1)
pages=[t for t in ts if t.get('type')=='page']
if not pages:
    print('FAIL: 无页面'); sys.exit(1)
for t in pages:
    print('  title:', repr(t.get('title')), '| url:', t.get('url'))
ok=any((t.get('title') or '').strip() for t in pages)
print('PASS: 页面已渲染' if ok else 'FAIL: title 为空')
sys.exit(0 if ok else 1)
" || { tail -20 /tmp/electron-web.log; kill $SRV_PID $BROWSER_PID 2>/dev/null; exit 1; }

echo
echo "=== 全部通过：Web 端链路（浏览器 → HTTP → backend）已跑通 ==="
echo "--- 服务端日志 ---"
head -20 "$LOG"

kill $SRV_PID $BROWSER_PID 2>/dev/null
pkill Xvfb 2>/dev/null || true
exit 0
