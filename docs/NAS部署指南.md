# AgentHub NAS 容器部署

面向：把 AgentHub 常驻跑在 NAS 上，**持续领积分**并**对外提供模型服务**。

> 合并上游后要重新适配？直接跑 `node tools/linux/adapt-upstream.cjs`，
> 见文末「§8 合并上游后的一键适配」。

---

## 0. 这套东西解决了什么

AgentHub 是桌面应用，直接塞进容器会踩三个坑——不是能不能跑的问题，是**跑起来但核心能力悄悄失效**：

| 桌面默认值 | 容器里的后果 | 本方案的处理 |
|---|---|---|
| `proxy.bind = 127.0.0.1` | 只监听回环，宿主机/局域网**根本连不上**，「提供模型服务」不成立 | `AGENTHUB_PROXY_BIND=0.0.0.0` |
| `proxy.restoreOnLaunch = false`（语义是「上次退出时网关开关状态」） | 容器重启后网关**不会自动起来**，服务中断 | `AGENTHUB_PROXY_AUTOSTART=1` |
| `proxy.checkinAuto = false` | 不会自动签到，「持续领积分」无从谈起 | `AGENTHUB_CHECKIN_AUTO=1` |
| 容器默认 UTC | 签到按**本地时间**判定，`09:00` 变成北京时间 17:00；跨零点还会错判「今天已跑」 | `TZ=Asia/Shanghai` + 挂 `/etc/localtime` |

这些覆盖由 `server/container-env.cjs` 在启动时应用，**只改被环境变量指定的项**，桌面端行为完全不变。

---

## 1. 部署

NAS 上的路径：`/volume1/docker/AgentHub`（对应 Windows 的 `Z:\AgentHub`，同一块 SMB 共享）。

```bash
# 在 NAS 上
cd /volume1/docker/AgentHub        # 或 Z:\AgentHub
mkdir -p data
docker compose up -d --build
docker compose logs -f
```

启动日志会逐项自检，一眼能看出哪里不对：

```
[web] 容器适配已应用：
       bind = "0.0.0.0"  (容器内需对外提供模型服务)
       restoreOnLaunch = true  (容器重启后自动恢复网关服务)
       checkinAuto = true  (NAS 常驻持续领积分)
[web] 已登记 262 个命令
[web] 时区: Asia/Shanghai (UTC+8) ✓
[web] 数据目录: /data ✓ 已持久化
[web] 反代网关已启动
[web] 记忆中枢已启动
```

访问 `http://<NAS-IP>:9528`。

---

## 2. 两个端口

| 端口 | 用途 |
|---|---|
| `9528` | Web 控制台（浏览器访问与配置） |
| `9527` | 反代网关（OpenAI 兼容） |

**提供模型服务**：把 AI 客户端的 `base_url` 指到 `http://<NAS-IP>:9527/v1`，Key 在 Web 控制台的「反代网关 → API Keys」里生成。

```bash
# 自测
curl http://<NAS-IP>:9527/v1/models
curl -X POST http://<NAS-IP>:9527/v1/chat/completions \
  -H "Authorization: Bearer sk-你的Key" -H "content-type: application/json" \
  -d '{"model":"...","messages":[{"role":"user","content":"hi"}]}'
```

> 鉴权范围（上游设计如此，与 OpenAI 一致）：`/v1/chat/completions` 校验 Key；
> `/v1/models`、`/healthz` 公开。模型列表本身不敏感，不必担心。

---

## 3. 持续领积分

AgentHub **自带**定时签到（`proxy/index.cjs` 的 `checkinAutoTick`，60s tick、动态读配置、当天幂等、带唤醒守卫与领取窗口延后重试），本方案只是把它在容器里打开。

- 签到时刻：`AGENTHUB_CHECKIN_TIME`（默认 `09:00`，按 `TZ` 的本地时间）
- 支持渠道：Trae 签到、WorkBuddy 双区 daily-checkin、国际版 trial 加油包、Qoder 每日重置窗口
- 领取窗口未开时**不会**标记当天完成，会自动延后重试——不会因错过时刻而丢掉一整天

**时区是这里唯一的硬要求**。`TZ` 不对，签到会整体偏移，甚至跨零点错判「今天已跑」。
compose 里已设 `TZ: Asia/Shanghai` 并挂载 `/etc/localtime` 双保险。

### 关于容器被 NAS 暂停/迁移

唤醒守卫的 B 判据是「tick 间隔 > max(90s, 预期+60s) 即判为刚唤醒」，
容器被暂停后恢复可能触发它，导致本轮置静默窗（15s）并要求「连续唤醒 ≥30s」。
影响可控：签到是 60s tick，下轮会自然重试，不会丢当天的签到。

---

## 4. 数据

全部落在 `./data`（容器内 `/data`）：

```
data/
├── config.json          框架配置（含 proxy 各项）
├── proxy/
│   ├── stats.db         网关用量明细（每次请求的 token/延迟/状态）
│   └── rules/           渠道规则
├── memory-*.json        记忆中枢配置与同步状态
└── ...                  号池凭据、用量库等
```

**这是 bind mount 到 NAS 的，容器重建不丢数据。**

### 关于「要不要挂载工作机目录」

| 功能 | 需要挂载 | 说明 |
|---|---|---|
| 反代网关 / 模型服务 | 否 | 容器内自洽 |
| 定时签到 / 领积分 | 否 | 容器内自洽 |
| 记忆中枢 | 否 | 数据在自己目录 |
| 额度/余额查询 | 否 | 直接调源站接口 |
| **用量明细** | **否** | 走网关的请求由网关自己记账，粒度比厂商 API 还细 |
| 技能仓库 | 是 | 挂载技能 = 写进客户端 `~/.claude/skills` 这类目录，是它的功能本质 |
| 本机历史用量 | 是 | 数据只在工作机文件里 |

> 厂商远端接口只提供**额度/余额**，不提供 per-request 明细（订阅制产品普遍如此）。
> 所以容器里拿到明细的正解是**让客户端走网关**，而不是抓厂商 API——这样数据由我们自己产生。

---

## 5. 安全

- **`AGENTHUB_WEB_TOKEN` 默认留空 = 不鉴权**。仅限内网可信环境。
  暴露到非可信网络时务必设置，然后访问 `http://<NAS-IP>:9528/?token=你的口令`。
- 网关侧 `9527` 的 Key 校验默认生效（无 Key/错 Key → 401）。
- 容器内通常没有 libsecret/gnome-keyring，`safeStorage` 不可用，
  **WebDAV 密码会降级明文存储**（存于 `/data`，依赖 NAS 自身的访问控制）。

---

## 6. 环境变量速查

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENTHUB_WEB_PORT` | `9528` | Web 控制台端口 |
| `AGENTHUB_WEB_TOKEN` | 空 | 留空不鉴权 |
| `AGENTHUB_DATA_DIR` | `/data` | 数据目录 |
| `TZ` | `Asia/Shanghai` | **务必与作息一致**（签到按本地时间） |
| `AGENTHUB_PROXY_BIND` | `0.0.0.0` | 网关监听地址 |
| `AGENTHUB_PROXY_AUTOSTART` | `1` | 容器重启自动起网关 |
| `AGENTHUB_CHECKIN_AUTO` | `1` | 定时签到 |
| `AGENTHUB_CHECKIN_TIME` | `09:00` | 签到时刻 |
| `AGENTHUB_CREDITS_REFRESH_MIN` | `30` | 额度刷新间隔（分钟） |
| `AGENTHUB_PUBLIC_HOST` | 空 | 网关接入地址里的 host（见 §4.1） |

设 `0` 可关闭对应行为（如 `AGENTHUB_CHECKIN_AUTO=0`）。

### 4.1 网关接入地址是怎么定的

反代总览页上那个「接入地址」是要**填进 AI 客户端**的，必须真能连上。
但容器里监听地址是 `0.0.0.0`——它是「本机所有网卡」的意思，**不是可连接地址**，
直接拼出来会得到 `http://0.0.0.0:9527/v1`，谁填谁连不上。

解析优先级：

1. `AGENTHUB_PUBLIC_HOST` 显式指定 —— **CLI / 脚本场景建议设**（它们拿不到浏览器地址栏）
2. 浏览器访问控制台时，**用地址栏的 host 推导** —— 你能打开控制台，就能用同一个 host 连网关
3. 都没命中时回落 `127.0.0.1`（本机自用）

所以浏览器里看是对的、但 `curl` 调 API 拿到 `127.0.0.1` 时，就是该设 `AGENTHUB_PUBLIC_HOST` 了。

---

## 7. 已知限制

1. **桌面专属能力在 Web 上不可用**：原生目录选择框、打开本地文件夹、托盘、开机自启、自动更新。
   容器里这些入口会明确失败或返回「用户取消」，不会假装成功。
2. **safeStorage 降级**：见上，WebDAV 密码明文存盘。
3. **本机采集类功能需要挂载**：技能挂载、本机历史用量在 NAS 上没有对象可操作，
   这类功能属于工作机上的桌面版。推荐形态是**服务器跑 Web 版、工作机跑桌面版**，
   用已有的 WebDAV 同步通道打通。

---

## 8. 合并上游后的一键适配

这套移植改了约 28 个上游文件，每次合并上游都可能被覆盖或冲突。
`tools/linux/adapt-upstream.cjs` 把可判定的部分自动化：

```bash
node tools/linux/adapt-upstream.cjs          # 只检测（默认，不改任何文件）
node tools/linux/adapt-upstream.cjs --apply  # 应用可自动化的部分
```

退出码 0/1，可直接用作 CI 门禁。

### 它按鲁棒性分三层

| 层 | 内容 | 处理方式 |
|---|---|---|
| 1 scaffold | 24 个新增文件（osdirs / proc / server / Dockerfile / tools/linux …） | 上游无同名，**永不冲突**，只检测是否在位 |
| 2 patch | 固定模式改造（homeDir 收敛到 osdirs、koffi 惰性加载） | 发现式扫描 + 幂等应用 + **应用后自校验** |
| 3 verify | 结构性改造（sqlcipher .so、isPortable 的 AppImage、latest-linux.yml、前端探测、打包配置、容器适配接线） | **只检测报告，不自动改** |

### 为什么第 3 层不自动改

这些改动逻辑复杂、与上游实现细节耦合，机器判定不了「改得对不对」。
盲目自动化比不自动化更危险——所以只报状态，由人确认。

### 它诚实地标注自己的精度边界

- **win32-only 死代码**（位于 `process.platform !== "win32"` 提前 return 之后）→
  归入「可忽略」，不计入退出码
- **APPDATA 粗筛**识别不了跨行平台三元分支（`...(win32 ? [...] : [])`），会误报 →
  归入「提示」，不计入退出码

与其堆更多正则（越堆越脆、越容易被下一个写法绕过），不如承认边界。

### 实测过的能力

- **发现式**而非硬编码清单：模拟上游新增一个带老样板的 adapter，
  脚本自动发现并修复（含 `require` 注入到正确位置）
- 幂等：重复跑 `--apply` 无副作用
- 自校验：应用后复扫一遍 + 逐文件 `node --check`

> 教训入档：初版脚本用 `if "osdirs" not in txt` 判断要不要插 require，
> 而替换函数体后文本里已出现 "osdirs"，判断被自己刚写的字符串骗过，
> **9 个文件全部漏了 require**，应用启动即崩（窗口根本没建）。
> 而 `node --check` / `vue-tsc` 全绿——语法合法，运行时才炸。
> 现在改用正则判断 require，并在应用后复检。

### 配套验证脚本

| 脚本 | 用途 |
|---|---|
| `tools/linux/adapt-upstream.cjs` | 合并上游后的适配与自检 |
| `tools/linux/gateway-url-selftest.cjs` | 网关接入地址推导的 11 个场景单测 |
| `tools/linux/verify-gateway-url.sh` | 从**非回环地址**真实访问验证（回环访问区分不出修复） |
| `tools/linux/sched-probe.cjs` | 容器内调度配置探活（签到/自启/监听地址） |
| `tools/linux/gw-auth-check.sh` | 网关鉴权行为验证 |
| `tools/linux/build-sqlcipher.sh` | 编译 Linux 版 libsqlcipher.so |
