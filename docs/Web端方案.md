# Web 端方案（浏览器访问与配置容器中的 AgentHub）

分支：`linux/port-20261002`。目标是从浏览器访问、配置跑在 Docker 里的 AgentHub。

---

## 1. 核心思路：IPC over HTTP，前端零重写

桌面端是 `src/api/ipc.ts` → preload → `ipcMain.handle`。搬上 Web 的关键发现是
**后端所有注册入口都是依赖注入形式**：

```js
ipc.register({ ipcMain, nativeTheme })        // electron/backend/ipc.cjs
syncIpc.registerSync({ ipcMain, app, shell }) // electron/backend/sync-ipc.cjs
proxy.register(ipcMain)                       // electron/backend/proxy/index.cjs
memory.register(ipcMain)                      // electron/backend/memory/index.cjs
```

所以传一个「只登记不派发」的假 `ipcMain` 进去，就能把全部 handler 收成一张 Map，
再暴露成 `POST /api/invoke`（body: `{cmd, args}`）。
**前端沿用同一套命令名，61 个 Vue 组件一行都不用改。** 实测登记 261 个命令。

---

## 2. server/ 三个文件

| 文件 | 作用 |
|---|---|
| `electron-shim.cjs` | electron API 替身（下面详述） |
| `ipc-registry.cjs` | 收集 handler 的假 ipcMain |
| `index.cjs` | `/api/invoke`、`/api/events`(SSE)、`/api/health`、静态托管 dist |

### electron-shim 是必需的，不是可选优化

15 个 backend 文件直接 `require("electron")`。在 Electron 进程外，
`require("electron")` 返回的是**可执行文件路径字符串**（electron npm 包的设计），
解构出的 `app` / `BrowserWindow` 全是 `undefined`，于是 `app.getVersion()`
这类调用会在启动阶段直接崩。`server/index.cjs` 劫持 `Module._load` 把
`require("electron")` 指到 shim。

**降级原则：显式失败，绝不谎报成功。** 打不开目录就返回失败，
不能加密就如实说不可用——参照 `wbClient` 那个「非 Windows 直接 return true」的坑。
`BrowserWindow` 的假窗口把 `webContents.send` 接到事件总线，后端广播由此经 SSE 下发。

---

## 3. 前端改造的两个坑

### 坑一：不能只看 fetch 成功来判断有没有后端

浏览器里有两种非 Electron 场景必须分开：

- `npm run dev:web` — vite 预览 UI，**没有后端**，只能走 mock
- `server/index.cjs` — 真正的 Web 服务端

而 **vite dev server 对未知路径会回退 index.html 并返回 200**——
只判断 `res.ok` 会把「拿着 HTML 当 JSON」误判成有后端。
所以探测 `/api/health` 时必须校验响应体确实含 `{ok:true, commands:<number>}`。

### 坑二：SSE 回调语义要与 Electron 对齐

后端广播的是 `{channel, payload}`，但 Electron 侧 `onUpdateEvent` 回调收到的只有
`payload`。Web 侧要保持同样语义（事件名在 `payload.event` 里），
否则所有消费方都得改。

---

## 4. 用量数据：容器里到底能拿到什么

这是最容易踩空的一节，结论基于实测。

### 远端接口只有额度，没有明细

已实现的 14 个远端接口（Trae / ZCode / WorkBuddy / 商汤）无一例外都是额度类：

| 接口 | 返回 |
|---|---|
| `/trae/api/v1\|v2/pay/ide_user_ent_usage` | `credits_limit` / `credits_amount` |
| `/billing/meter/get-user-resource` | `Accounts[]` 各套餐包剩余 |
| `/billing/meter/get-enterprise-user-usage` | `limit_num` / `used_num` |
| `/billing/balance`、`/current`、`/preview` | 余额、可用模型 |

`get-enterprise-user-usage` 名字带 usage，但它是「用了多少额度」，不是
「每次请求消耗多少 token」——请求体是 `{ProductCode:"p_tcaca", PageSize, 有效期区间}`，
查的是套餐包列表；解析函数也只取 `limit_num - used_num`。

**订阅制产品普遍不开放 per-request 明细 API**，服务端只有扣减流水。

### per-request 明细只有两个来源

1. 本机客户端文件（现状 10 个数据源）
2. **反代网关自己记** —— `usage_requests` 表：

```
ts · key_id · channel · account_id · model
prompt_tokens · completion_tokens · cache_read_tokens · cache_creation_tokens
ttft_ms · latency_ms · status · error
```

比厂商 API 还细（多了首字延迟与错误率），且**完全在容器内自洽，不挂载任何目录**。

### 因此：哪些功能需要挂载？

| 功能 | 需要挂载 | 说明 |
|---|---|---|
| 反代网关管理 | 否 | 容器内自洽 |
| 记忆中枢 | 否 | 数据在 AgentHub 自己的目录 |
| 额度/余额查询 | 否 | 直接调源站接口 |
| 用量明细 | **取决于客户端走不走网关** | 走网关→网关记账；不走→只有本机文件有 |
| 技能仓库 | **是** | 挂载技能 = 写进 `~/.claude/skills` 这类客户端目录，是它的功能本质 |
| 本机历史用量明细 | **是** | 数据只在本机文件里 |

**服务器上真正成立的是：反代网关 + 记忆中枢 + 远端额度 + 网关记账的用量统计**，
这四项都不用挂载。而「本机采集 + 技能挂载」天然属于工作机。

推荐形态：**服务器跑 Web 版（网关/记忆/额度看板），工作机跑桌面版（采集/技能）**，
用已有的 WebDAV 同步通道打通。

---

## 5. 部署

```bash
docker compose up -d     # 或 docker build -t agenthub-web . && docker run ...
```

- `9528` Web 控制台，`9527` 反代网关（OpenAI 兼容，供 AI 客户端接入）
- 数据全部在 `./data`（容器内 `/root/.agenthub-server`）
- Dockerfile 多阶段：构建阶段装 cmake 编 koffi，运行阶段只带运行时依赖

**运行镜像不含 Electron 二进制，也不需要 Xvfb** —— server 用 shim 让 backend
跑在纯 Node 上，桌面栈只在无头冒烟测试里用到。

### 鉴权

`AGENTHUB_WEB_TOKEN` 留空 = 不鉴权（默认，仅内网可信环境）。
设置后：无 token / 错 token → 401，正确 token → 200，`/api/health` 不拦（探活需要）。
**部署到非可信网络时务必设置。**

---

## 6. 验证结果

容器内（`tools/linux/run-web-smoke.sh`）：

```
{"ok":true,"commands":261,"platform":"linux","invokeCount":12,"sseClients":2}
PASS: 前端已通过 HTTP 调用后端 12 次
  title: 'AgentHub · Agent中控台' | url: http://127.0.0.1:9528/
PASS: 页面已渲染
```

用 **Electron 当浏览器**访问（不注入 preload，`window.agenthub` 不存在，
与真实浏览器等价），`invokeCount=12` 证明前端确实切到了 HTTP 而非 mock。

生产镜像 `docker run` 后健康检查与页面均正常；token 鉴权四种情形行为符合预期。

---

## 7. 已知限制

1. **桌面专属能力在 Web 上不可用**：原生目录选择框（`browse_dir`）按「用户取消」返回；
   打开本地文件夹（`open_data_dir` 等）返回失败提示；托盘、开机自启、自动更新无意义。
2. **safeStorage 降级**：容器里通常没有 libsecret/gnome-keyring，
   `isEncryptionAvailable()` 为 false 时 WebDAV 密码**明文存储**，且目前无 UI 提示。
3. **未做真实浏览器回归**：验证用 Electron 模拟浏览器环境（无 preload），
   与 Chrome/Firefox 的 EventSource、fetch 行为基本一致，但建议在真浏览器过一遍。
4. **无鉴权默认开放**：便捷但有风险，非内网务必设 token。
