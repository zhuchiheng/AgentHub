#!/usr/bin/env bash
# 容器内网关鉴权验证：确认 chat/completions 走 Key 校验，而 /v1/models 与 /healthz 公开。
# 用法（容器内）：bash /tmp/gw-auth-check.sh
set -u
BASE="${BASE:-http://127.0.0.1:9527}"
BODY='{"model":"Doubao-Seed-Evolving","messages":[{"role":"user","content":"hi"}]}'

code() { curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$@"; }

echo "=== 无 Key 调 chat/completions（期望 401）==="
echo "HTTP $(code -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' --data "$BODY")"

echo "=== 错误 Key（期望 401）==="
echo "HTTP $(code -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' -H 'Authorization: Bearer sk-invalid' --data "$BODY")"

echo "=== /v1/models（公开，期望 200）==="
echo "HTTP $(code "$BASE/v1/models")"

echo "=== /healthz（公开，期望 200）==="
echo "HTTP $(code "$BASE/healthz")"

echo "=== 响应体样例（无 Key）==="
curl -s --max-time 10 -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' --data "$BODY" | head -c 300
echo ""
