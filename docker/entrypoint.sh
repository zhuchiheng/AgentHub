#!/bin/bash
# 容器入口：按需拉起 sshd，再把 node 服务作为主进程（承接信号）。
#
# 为什么要这个：容器内排查问题时，SSH 进去操作比在 NAS 上走 sudo 安全得多——
# 容器里的 root 是被命名空间限制的，碰不到 NAS 本体与其它服务；
# 而 NAS 上的 sudo 是真正的高权限。
#
# SSH 是**可选能力**：只有提供了公钥才会启动，没提供就静默跳过。
# 公钥来源（按优先级）：
#   1. 环境变量 AGENTHUB_SSH_PUBKEY —— 首次部署最方便
#   2. /data/ssh/authorized_keys   —— 已持久化的（挂载在数据卷上，容器重建不丢）
set -u

SSH_STATE=/data/ssh
AUTH=/root/.ssh/authorized_keys

mkdir -p /run/sshd /root/.ssh "$SSH_STATE"
chmod 700 /root/.ssh
chmod 700 "$SSH_STATE" 2>/dev/null || true

# 1) 环境变量给的公钥：写盘，并留一份到数据目录做持久化
if [ -n "${AGENTHUB_SSH_PUBKEY:-}" ]; then
  printf '%s\n' "$AGENTHUB_SSH_PUBKEY" > "$SSH_STATE/authorized_keys"
  chmod 600 "$SSH_STATE/authorized_keys"
  echo "[entrypoint] 已从 AGENTHUB_SSH_PUBKEY 写入公钥"
fi

# 2) 数据目录里的公钥：落到实际生效位置
if [ -s "$SSH_STATE/authorized_keys" ]; then
  cp -f "$SSH_STATE/authorized_keys" "$AUTH"
  chmod 600 "$AUTH"
fi

# 3) 主机密钥持久化：不持久化的话每次重建容器指纹都变，客户端会刷「主机密钥已更改」告警
#    注意必须连 .pub 一起拷：镜像里预生成了主机密钥对，若只覆盖私钥、
#    留着旧的公钥，sshd 会报 "Public key ... does not match private key"。
if [ ! -f "$SSH_STATE/ssh_host_ed25519_key" ]; then
  echo "[entrypoint] 生成 SSH 主机密钥（首次）"
  ssh-keygen -q -t ed25519 -f "$SSH_STATE/ssh_host_ed25519_key" -N "" || true
  ssh-keygen -q -t rsa -b 3072 -f "$SSH_STATE/ssh_host_rsa_key" -N "" || true
fi
for k in "$SSH_STATE"/ssh_host_*_key; do
  [ -f "$k" ] || continue
  cp -f "$k" /etc/ssh/ 2>/dev/null || true
  chmod 600 "/etc/ssh/$(basename "$k")" 2>/dev/null || true
  # 公钥同步覆盖：漏了它就会与私钥不配对，sshd 启动时报密钥不匹配
  if [ -f "${k}.pub" ]; then
    cp -f "${k}.pub" /etc/ssh/ 2>/dev/null || true
    chmod 644 "/etc/ssh/$(basename "$k").pub" 2>/dev/null || true
  fi
done

# 4) 启动 sshd（仅在确实有公钥时）
if [ -s "$AUTH" ]; then
  echo "[entrypoint] 启动 sshd（端口 22，仅密钥登录）"
  /usr/sbin/sshd -e
else
  echo "[entrypoint] 未提供 SSH 公钥，跳过 sshd（设 AGENTHUB_SSH_PUBKEY 可启用）"
fi

# 5) node 服务作为主进程：容器信号（SIGTERM 等）由它承接，停止时 sshd 一并退出
exec node server/index.cjs
