#!/usr/bin/env bash
# 验证「全页面共用一个 SSE 连接」的修复。
#
# 背景：Chrome 对同源 HTTP/1.1 只给 6 个并发连接。修复前每个 onUpdateEvent
# 订阅者各开一条 SSE，而这个应用用 v-show 保活视图，浏览几个页面就把 6 个连接位
# 占满，之后任何 fetch 都排不上队（现象：页面显示正常，点按钮全 45s 超时）。
#
# 判定：加载页面后服务端 sseClients 应为 1。
# 修复前会有多条（App 全局 + 侧栏 + 当前视图各一条）。
#
# 用法（容器内，需 Electron）：
#   bash tools/linux/verify-sse-single.sh
set -uo pipefail

APP_DIR="${APP_DIR:-/app}"
PORT=9528
cd "$APP_DIR"

echo "=== [1] 构建前端 ==="
npm run build >/tmp/sse-build.log 2>&1 || { echo "构建失败"; tail -20 /tmp/sse-build.log; exit 1; }

echo "=== [2] 启动 Web 服务端 ==="
AGENTHUB_WEB_PORT=$PORT AGENTHUB_DATA_DIR=/tmp/ah-sse-data node server/index.cjs >/tmp/sse-web.log 2>&1 &
SRV=$!
sleep 7
curl -fsS "http://127.0.0.1:$PORT/api/health" || { echo "服务端未起来"; cat /tmp/sse-web.log; exit 1; }
echo ""

echo "=== [3] 无头显示 + Electron 打开页面 ==="
pkill Xvfb 2>/dev/null || true
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1400x900x24 -nolisten tcp >/tmp/sse-xvfb.log 2>&1 &
sleep 2
export DISPLAY=:99
setsid ./node_modules/electron/dist/electron "http://127.0.0.1:$PORT" \
  --no-sandbox --disable-dev-shm-usage --disable-gpu \
  --remote-debugging-port=9355 >/tmp/sse-el.log 2>&1 &
EL=$!

echo "等待页面加载（探测后端 → 渲染各组件 → 各自订阅广播）..."
sleep 30

echo "=== [4] 读取服务端 sseClients ==="
HEALTH="$(curl -fsS "http://127.0.0.1:$PORT/api/health")"
echo "$HEALTH"
COUNT="$(echo "$HEALTH" | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{console.log(JSON.parse(s).sseClients)}catch{console.log(-1)}})")"
echo ""
echo "sseClients = $COUNT"

kill $SRV $EL 2>/dev/null
pkill Xvfb 2>/dev/null || true

if [ "$COUNT" = "1" ]; then
  echo "PASS: 整页只占 1 个 SSE 连接（修复生效）"
  exit 0
fi
if [ "$COUNT" -gt 1 ] 2>/dev/null; then
  echo "FAIL: 占了 $COUNT 个连接 —— 单例没生效，浏览几个页面就会耗尽浏览器连接池"
  exit 1
fi
echo "FAIL: 拿不到 sseClients"
exit 1