# 在群晖 NAS 上部署 AgentHub（实测记录）

**实测环境**：群晖 DS216+II（Celeron N3060 / DSM / Docker 20.10.3 / compose 1.28.5）
**部署目录**：`/volume1/docker/AgentHub`（= Windows 的 `Z:\AgentHub`，同一个 SMB 共享）

---

## 一、实际部署方式：本机构建 + 镜像搬运

**不要指望在 NAS 上 `docker compose up -d --build`**，实测两处都走不通：

1. **NAS 拉不到 Docker Hub**：`registry-1.docker.io` 连接被重置，构建第一步
   `FROM ubuntu:22.04` 就失败。
2. **apt 源太慢**：`archive.ubuntu.com` 单次响应实测 **13 秒**，而 `apt-get update`
   要拉几十个索引，叠加起来像卡死（换成阿里云源 0.76 秒，快 17 倍）。

所以采用：**本机 Docker Desktop 构建 → 导出 tar → SSH 字节流传输 → NAS 导入**。
架构一致（都是 linux/amd64），120MB 约 **9-10 秒**传完，MD5 校验一致。

一键脚本：`tools/linux/deploy-to-nas.ps1`（本机跑）

```powershell
.\tools\linux\deploy-to-nas.ps1                        # 构建并部署
.\tools\linux\deploy-to-nas.ps1 -SkipBuild             # 跳过构建，推当前镜像
.\tools\linux\deploy-to-nas.ps1 -SshPubKey "ssh-ed25519 AAAA... you@host"   # 首次启用容器内 SSH
```

脚本会：构建 → 导出 → 传输 → MD5 校验 → NAS 导入 → 重启容器。
导入需要 docker 权限，脚本会**交互式提示 sudo 密码**（刻意不配 sudo 免密，
那会放宽 NAS 安全边界）。

---

## 二、实测踩到的坑（按重要性排序）

### 1. 端口 9526-9529 被群晖 syslog-ng 占用

**这不是误报**。实测 `netstat -tlnp` 显示 PID 3934 的 `syslog-ng` 监听
**9526/9527/9528/9529 一整段**，且连上去只 timeout 不应答。

`/proc/net/tcp` 交叉验证确认真实占用（用 inode 反查持有进程）。

**解法：改用 19527/19528**，内外端口保持一致（这样前端用浏览器地址栏的 host
推导出的网关地址才是对的）。见 `docker-compose.nas.yml`。

### 2. 容器内 `baseUrl` 曾显示不可连接地址

网关的 `baseUrl` 原本直接用监听地址拼。`0.0.0.0` 是**监听**地址（语义「本机所有网卡」），
不是可连接地址——桌面端 `bind=127.0.0.1` 时巧合正确，容器里就生成
`http://0.0.0.0:9527/v1`，用户照抄进 AI 客户端必然失败。

已修：后端 `clientHost()`（`AGENTHUB_PUBLIC_HOST` > 非通配 bind > 127.0.0.1），
前端在 Web 模式下用浏览器地址栏的 host 推导。

### 3. 健康检查曾硬编码端口

原先写死 `http://127.0.0.1:9528/api/health`，换端口后容器一直是 `unhealthy`，
但服务其实完全正常（外部访问 19528 是通的）。已改成从 `AGENTHUB_WEB_PORT` 取。

### 4. 容器 SSH 主机密钥公私钥不匹配

apt 装 `openssh-server` 时自动生成一对主机密钥，而 entrypoint 又从 `/data/ssh`
恢复持久化密钥覆盖私钥——**漏了同步 `.pub`**，于是新私钥配旧公钥，sshd 报
`Public key ... does not match private key`。

已修两处：entrypoint 拷私钥时连 `.pub` 一起拷；Dockerfile 里删掉 apt 预生成的
主机密钥（`rm -f /etc/ssh/ssh_host_*`），让密钥完全由 entrypoint 管理。

### 5. scp / sftp 在群晖不可用

群晖的 sftp 子系统配置异常（`Subsystem sftp internal-sftp -f DAEMON -u 000`），
`scp` 报 `subsystem request failed`。

**解法**：走 SSH stdin 字节流：

```bash
type file.tar.gz | ssh user@nas "cat > /path/file.tar.gz"
```

### 6. 免密登录被群晖 StrictModes 拒绝

公钥装好后仍失败——因为 home 目录是 **777**，群晖 sshd 的 `StrictModes` 会拒绝
权限过宽的 home。

```bash
chmod 755 ~ && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys
```

---

## 三、两个端口 / 三条访问途径

| 用途 | 地址 |
|---|---|
| Web 控制台 | `http://192.168.1.172:19528` |
| 反代网关（OpenAI 兼容） | `http://192.168.1.172:19527/v1` |
| 容器 SSH（可选） | `ssh -p 12222 root@192.168.1.172`（仅密钥） |

**提供模型服务**：把 AI 客户端的 `base_url` 指到 `http://<NAS-IP>:19527/v1`，
Key 在控制台「反代网关 → API Keys」生成。

容器 SSH 的设计意图：容器内排查比在 NAS 上走 sudo 安全——容器里的 root 被命名空间
隔离，碰不到 NAS 本体与其它服务。默认不启用，设了 `AGENTHUB_SSH_PUBKEY` 才启动。

---

## 四、启动自检

容器启动会逐项打印，一眼看出哪里不对：

```
[entrypoint] 已从 AGENTHUB_SSH_PUBKEY 写入公钥
[entrypoint] 启动 sshd（端口 22，仅密钥登录）
[web] 容器适配已应用：
       bind = "0.0.0.0"  (容器内需对外提供模型服务)
       restoreOnLaunch = true  (容器重启后自动恢复网关服务)
       checkinAuto = true  (NAS 常驻持续领积分)
       port = 19527  (网关监听端口)
[web] 已登记 262 个命令
[web] 时区: Asia/Shanghai (UTC+8) ✓
[web] 数据目录: /data ✓ 已持久化
[web] 反代网关已启动
[web] 记忆中枢已启动
```

---

## 五、持续领积分（已端到端验证）

AgentHub **自带**定时签到（`checkinAutoTick`，60s tick、当天幂等、带唤醒守卫与
领取窗口延后重试），容器里由 `AGENTHUB_CHECKIN_AUTO=1` 打开。

**验证方法**（自动签到失败路径不写库、不打日志，所以不能用「账号字段变没变」判断）：

```bash
node tools/linux/verify-auto-checkin.cjs http://192.168.1.172:19528 150
```

它订阅 SSE 广播。`checkinBatch` 在 `act !== "status"` 时必然会
`events.emit({type:"credits"})`，这是可靠的观测点。

**实测结果**：容器重启（清空内存态的「今天已跑」标记）后不做任何手动操作，
150 秒内观测到 1 条 `credits` 事件。**自动签到确实在跑。**

> 时区是硬要求：签到按本地时间判定，容器默认 UTC 会让 09:00 变成北京时间 17:00，
> 跨零点还会错判「今天已跑」。已钉 `TZ=Asia/Shanghai` + 挂 `/etc/localtime`。

---

## 六、更新部署

改了代码后，在 Windows 上跑一次部署脚本即可（见第一节）。
数据在 `/volume1/docker/AgentHub/data`，重建容器不会丢。

---

## 七、已知限制

### WebDAV 密码明文存盘

容器里 `libsecret` 库虽然装了，但**没有 keyring 守护进程、也没有 dbus**，
`safeStorage.isEncryptionAvailable()` 返回 false，密码会**明文**存在
`/data/config.json`。

你本机配置里的 `enc:v1:...`（Windows DPAPI）在容器里**解不开**——DPAPI 密钥
绑定在 Windows 用户账户上。所以迁移到容器需要重填一次密码。

如果 NAS 有其他人能访问 `/volume1/docker/AgentHub/data`，这点要留意。

### Docker Desktop 挂 SMB 写入不可靠（本机验证时注意）

在 Windows 上用 Docker Desktop 挂 `Z:\AgentHub\data` 会**写不进去**——容器内
写成功但 Windows 侧看不到（实测对比：本机盘正常、SMB 看不到）。

这只影响 Windows 侧验证；NAS 上挂 `/volume1/docker/AgentHub/data` 是本地文件系统，
没有这个问题。

### 其它

- 桌面专属能力（原生目录框、托盘、开机自启、自动更新）在 Web 端明确失败，不假装成功
- `AGENTHUB_WEB_TOKEN` 默认留空 = 不鉴权；暴露到非可信网络务必设置
