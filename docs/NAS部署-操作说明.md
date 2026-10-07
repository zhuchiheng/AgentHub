# 在群晖 NAS 上部署 AgentHub

**部署目录**：`/volume1/docker/AgentHub`（= Windows 的 `Z:\AgentHub`，同一个 SMB 共享）

这里的文件已经准备好，可以直接构建。

---

## 一、启动

用 SSH 登录 NAS，或 DSM → Container Manager → 项目 → 新增，选这个目录。

SSH 方式：

```bash
cd /volume1/docker/AgentHub
docker compose up -d --build
docker compose logs -f
```

> 群晖的 docker 命令可能不在 PATH：用完整路径
> `/usr/local/bin/docker`，或在 DSM 的 Container Manager 里操作。

启动日志会逐项自检，一眼看出哪里不对：

```
[web] 容器适配已应用：
       bind = "0.0.0.0"  (容器内需对外提供模型服务)
       restoreOnLaunch = true  (容器重启后自动恢复网关服务)
       checkinAuto = true  (NAS 常驻持续领积分)
[web] 时区: Asia/Shanghai (UTC+8) ✓
[web] 数据目录: /data ✓ 已持久化
[web] 反代网关已启动
[web] 记忆中枢已启动
```

访问 `http://<NAS-IP>:9528`。

---

## 二、如果容器起不来

按出现频率排序：

### 1. `/etc/localtime` 挂载失败

群晖的时区文件是 `/etc/TZ` 而非 `/etc/localtime`，挂一个不存在的路径会让容器**直接起不来**。

改 `docker-compose.yml` 的 volumes：

```yaml
- /etc/TZ:/etc/TZ:ro          # 群晖改成这行
# - /etc/localtime:/etc/localtime:ro   # 原本这行删掉
```

或者干脆删掉这一行——镜像里已经用 `TZ` 环境变量 + tzdata 设好时区，这行只是双保险。

### 2. 端口被占

```bash
sudo netstat -tlnp | grep -E '9527|9528'
```

改 compose 里的宿主机端口（左边那个数字）：

```yaml
- "19528:9528"
- "19527:9527"
```

### 3. SMB 写入的数据文件权限

如果 `./data` 下出现 root 属主的文件、DSM 里看不到，在 compose 里指定运行用户：

```yaml
user: "1026:100"   # 1026 通常是群晖第一个普通用户的 uid，按实际改
```

---

## 三、这两个端口是干什么的

| 端口 | 用途 |
|---|---|
| `9528` | Web 控制台（浏览器访问、配置） |
| `9527` | 反代网关（OpenAI 兼容），填进 AI 客户端 |

**提供模型服务**：把 AI 客户端的 `base_url` 指到 `http://<NAS-IP>:9527/v1`，
Key 在控制台的「反代网关 → API Keys」里生成。

---

## 四、持续领积分

AgentHub **自带**定时签到，容器里已由 `AGENTHUB_CHECKIN_AUTO=1` 打开。

- 签到时刻：`AGENTHUB_CHECKIN_TIME`（默认 `09:00`）
- **按本地时间判定**，所以设了 `TZ=Asia/Shanghai`

> 时区是这里唯一的硬要求。TZ 不对，签到会整体偏移，甚至跨零点错判「今天已跑」。

---

## 五、更新部署

改了代码或拉了新版本后：

```bash
cd /volume1/docker/AgentHub
docker compose up -d --build
```

数据在 `./data`，重建容器不会丢。

---

## 六、必读：Docker Desktop 挂 SMB 写入不可靠（本机验证注意）

**如果你在 Windows 上用 Docker Desktop 挂 `Z:\AgentHub\data` 验证，会发现数据文件在
Windows 侧看不到**——容器内写成功了，但没同步到 NAS。

这是 Docker Desktop 的已知限制：它不支持把网络驱动器（UNC/SMB）作为 bind mount 的
可靠后端。实测对比：

| 挂载源 | 容器内写 | 宿主机可见 |
|---|---|---|
| 本机本地盘 | ✅ | ✅ 正常 |
| `Z:\...`（SMB） | ✅ | ❌ 看不到 |

**这不影响 NAS 部署**——NAS 上 docker 直接挂 `/volume1/docker/AgentHub/data`，
是本地文件系统，没有这个问题。

在 Windows 上验证功能时，用本机盘做数据目录即可。

---

## 七、安全提醒

`AGENTHUB_WEB_TOKEN` 默认留空 = **不鉴权**。仅限内网可信环境。
如果 9528 端口映射到了公网，务必在 compose 里设置：

```yaml
AGENTHUB_WEB_TOKEN: "换成一个长随机串"
```

然后访问 `http://<NAS-IP>:9528/?token=你的口令`。

另外容器内通常没有 libsecret/gnome-keyring，`safeStorage` 不可用，
**WebDAV 密码会降级明文存储**在 `./data` 里，依赖 NAS 自身的访问控制保护。
