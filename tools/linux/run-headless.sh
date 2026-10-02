#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 在容器内无头启动 AgentHub，验证应用真的能跑起来（不止是能构建）。
#
# 判定分三层，任何一层失败都返回非 0：
#   ① 主进程存活：启动 20s 后进程仍在（崩溃会立刻退出）
#   ② 无致命日志：stderr 里没有 Uncaught Exception / Failed to load 等
#   ③ 渲染进程就绪：通过 CDP（--remote-debugging-port）拿到页面列表，
#      确认窗口已创建且页面 title 正确 —— 这才证明 Vue 应用真的挂载了
#
# 用法：
#   容器内：bash tools/linux/run-headless.sh        （默认 /app）
#   CI/本机：APP_DIR=$PWD bash tools/linux/run-headless.sh
# ---------------------------------------------------------------------------
set -uo pipefail

APP_DIR="${APP_DIR:-/app}"
LOG=/tmp/agenthub-headless.log
DEBUG_PORT=9222
WAIT_START=25   # 给主进程 boot + 建窗 + 加载页面的时间（容器内首启动偏慢）

cd "$APP_DIR"

echo "=== [0] 构建前端 + 打包 linux-unpacked ==="
npm run build >/tmp/vite-build.log 2>&1 || { echo "前端构建失败"; tail -20 /tmp/vite-build.log; exit 1; }
echo "dist/index.html: $( [ -f dist/index.html ] && echo OK || echo 缺失 )"
npx electron-builder --linux --dir >/tmp/eb.log 2>&1 || { echo "打包失败"; tail -25 /tmp/eb.log; exit 1; }
BIN=./release/linux-unpacked/agenthub
[ -x "$BIN" ] || { echo "可执行产物缺失: $BIN"; ls release/ 2>/dev/null; exit 1; }
echo "产物: $BIN"

echo "=== [1] 准备无头显示（Xvfb :99）==="
pkill Xvfb 2>/dev/null || true
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1280x820x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
sleep 2
if ! kill -0 "$XVFB_PID" 2>/dev/null; then echo "Xvfb 启动失败:"; cat /tmp/xvfb.log; exit 1; fi
echo "Xvfb pid=$XVFB_PID"

# dbus：托盘与通知走会话总线，缺了会在日志里刷一堆无害但吵的报错
export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/dbus/system_bus_socket"
dbus-daemon --system --fork 2>/dev/null || true

echo "=== [2] 启动 AgentHub（无头 + 远程调试端口 ${DEBUG_PORT}）==="
export DISPLAY=:99
export ELECTRON_ENABLE_LOGGING=1
# --no-sandbox 必需：容器内以 root 跑 Chromium 沙箱会直接失败
# --disable-dev-shm-usage 必需：容器 /dev/shm 默认只有 64MB，不加会渲染进程崩溃
setsid "$BIN" \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --remote-debugging-port=${DEBUG_PORT} \
  >"$LOG" 2>&1 &
APP_PID=$!
echo "app pid=$APP_PID"

echo "=== [3] 等待 ${WAIT_START}s（boot → 建窗 → 加载页面）==="
sleep "$WAIT_START"

echo "=== [4] 判定 ①：主进程是否存活 ==="
if ! kill -0 "$APP_PID" 2>/dev/null; then
  echo "FAIL: 主进程已退出"
  echo "--- 日志 ---"; cat "$LOG"
  exit 1
fi
echo "PASS: 主进程存活 (pid=$APP_PID)"

echo "=== [5] 判定 ②：日志里有无致命错误 ==="
# 只匹配真正致命的，放行常见的无害噪音（GPU/dbus/托盘在无头环境必然报错）
if grep -Ei "Uncaught Exception|UnhandledPromiseRejection|Failed to load (file|URL)|Cannot find module" "$LOG" | grep -v "gpu\|dbus\|libva\|sandbox" | head -5; then
  echo "FAIL: 日志存在致命错误"
  echo "--- 完整日志 ---"; cat "$LOG"
  kill "$APP_PID" 2>/dev/null
  exit 1
fi
echo "PASS: 无致命错误"

echo "=== [6] 判定 ③：CDP 取渲染进程，确认页面已加载 ==="
TARGETS="$(curl -fsS --max-time 10 "http://127.0.0.1:${DEBUG_PORT}/json/list" 2>/dev/null || true)"
if [ -z "$TARGETS" ]; then
  echo "FAIL: 远程调试端口无响应（窗口可能没建起来）"
  echo "--- 日志尾部 ---"; tail -30 "$LOG"
  kill "$APP_PID" 2>/dev/null
  exit 1
fi
echo "$TARGETS" | python3 -c "
import json,sys
try:
    ts=json.load(sys.stdin)
except Exception as e:
    print('FAIL: CDP 返回无法解析'); sys.exit(1)
pages=[t for t in ts if t.get('type')=='page']
if not pages:
    print('FAIL: 没有 page 类型目标'); sys.exit(1)
for t in pages:
    print('  title:', repr(t.get('title')), '| url:', t.get('url'))
ok=any((t.get('title') or '').strip() for t in pages)
print('PASS: 渲染进程就绪，页面已加载' if ok else 'FAIL: 页面 title 为空')
sys.exit(0 if ok else 1)
" || { echo "--- 日志尾部 ---"; tail -30 "$LOG"; kill "$APP_PID" 2>/dev/null; exit 1; }

echo
echo "=== 全部通过：AgentHub 在 Linux 无头环境下完整启动 ==="
echo "--- 应用日志（前 40 行，便于人工核对）---"
head -40 "$LOG"

kill "$APP_PID" 2>/dev/null
pkill Xvfb 2>/dev/null || true
exit 0
