# Linux 适配方案（AppImage / x64）

分支：`linux/port-20261002`（基于 `20261002integration1`）
目标：产出可运行的 Linux 桌面端 AppImage（x64），arm64 留好位置但暂不构建。

---

## 0. 结论先行

| 项目 | 状态 |
|---|---|
| Linux 构建（npm ci → vue-tsc → electron-builder --linux） | ✅ 已在 ubuntu:22.04 容器内跑通 |
| AppImage 产物 | ✅ 已产出 |
| Trae 四源（SQLCipher FFI） | ✅ **解禁**，非降级 |
| Windows 构建 | ✅ 未受影响（本机重新验证过逻辑分支） |
| arm64 | ⏸ 配置位已留，未构建 |

---

## 1. 最大的坑：SQLCipher 原生库

### 问题

`electron/backend/sqlcipher.cjs` 靠 koffi FFI 加载 `resources/sqlcipher/sqlcipher.dll`，
供 Trae / Trae CN / TRAE SOLO / TRAE SOLO CN 四个用量源解密 `database.db`。
Windows 官方仓库只有一套 DLL，Linux 必须有对应的 `.so`。

### 为什么不直接拿发行版包

Debian / Ubuntu 官方仓库的 `libsqlcipher0` 最高只到 **3.4.1**，而 Windows 侧是 **4.6.1**。
SQLCipher 3 与 4 的默认参数不同（`kdf_iter` 64000 vs 256000、HMAC-SHA1 vs SHA512），
raw key 模式下即使密钥正确也会报 `file is not a database`。

### 做法

源码编译 4.6.1，**静态链入 OpenSSL**，脚本见 `tools/linux/build-sqlcipher.sh`：

```bash
docker run --rm -v "$PWD:/work" -w /work ubuntu:22.04 bash tools/linux/build-sqlcipher.sh
```

关键点：
- **不能**指望 `configure` 直接产出「静态链了 libcrypto 的 .so」。`AC_CHECK_LIB` 检测到
  `-lcrypto` 后会塞进 `LIBS`，libtool 优先选动态 `.so`，产物照样依赖 `libcrypto.so.N`。
  （第一次就是这么踩的，`ldd` 里明晃晃挂着 `libcrypto.so.3`。）
  正确做法：`--enable-shared=no` 先出 `.a`，再 `gcc -shared --whole-archive` 手动重链。
- 需要 `tcl`，否则 make 阶段报 `has_tclsh84 Error 1`（amalgamation 靠 tclsh 生成）。
- 基线选 ubuntu:22.04（glibc 2.35）而非 24.04（2.39），兼容性更好。

产物：`resources/sqlcipher-linux-x64/libsqlcipher.so.0`，`ldd` 只剩 `libc` / `libm`。

### 交叉验证（最重要的一步）

不能只验证「自己写的自己能读」——那证明不了和 Windows 侧等价。做了真正的双向交叉：

1. Windows 侧用 ctypes 加载项目自带的 `sqlcipher.dll`，以 Trae 的 raw key 建库写一行
   （`tools/linux/verify-win-dll.py`），顺带打印真实参数：
   ```
   cipher_version  : 4.6.1 community
   cipher          : AES-256-CBC
   kdf_iter        : 256000
   cipher_page_size: 4096
   page_size       : 4096
   ```
2. Linux 容器里用编译出的 `.so` 打开同一个文件并读出该行（`tools/linux/verify-linux-so.py`）。
3. 再走一遍项目真实代码路径（`tools/linux/smoke-sqlcipher.cjs`），
   即 `sqlcipher.cjs` 的 `available → open → queryAll → close`，确认原生库查找逻辑也在 Linux 上成立。

三步全部 PASS。**所以 Trae 四源在 Linux 上是真正可用，不是降级隐藏。**

---

## 2. 平台目录适配层 `electron/backend/osdirs.cjs`

### 问题（静默失效，比崩溃更难查）

仓库里散着 20 多处这样的写法：

```js
process.env.APPDATA || path.join(homeDir(), "AppData", "Roaming")
```

Linux 上这些环境变量不存在，会拼出 `~/AppData/Roaming/...` 这种**必不存在的路径**——
不报错、不崩溃，数据源永远探测不到。

### 做法

新增 `osdirs.cjs`，按平台给出真实路径：

| | Windows | Linux | macOS |
|---|---|---|---|
| `roaming()` 配置类 | `%APPDATA%` | `$XDG_CONFIG_HOME` / `~/.config` | `~/Library/Application Support` |
| `local()` 数据类 | `%LOCALAPPDATA%` | `$XDG_DATA_HOME` / `~/.local/share` | `~/Library/Application Support` |

- `candidateRoots(subdirs)` 用于探测：Linux 上同时覆盖 `.config` 与 `.local/share`
  （Electron 应用落在哪都有可能），**Windows 上只走 roaming，与改造前完全一致**，避免多查一处带来意外匹配。
- 已接入：`adapter-trae-common` / `adapter-codebuddy` / `adapter-opensquilla` /
  `adapter-raccoon` / `adapter-antigravity-legacy` / `config.dataDir` / `memory/verify`，
  以及 9 处 `homeDir()` 样板（经 `tools/linux/migrate-homedir.py` 批量收敛）。

---

## 3. 修掉的「谎报成功」隐患

比崩溃更危险的是「不崩、不报、但功能悄悄错」。

`wbClient.cjs` / `raccoonClient.cjs` 原先对非 Windows 一律短路：

```js
function killWorkbuddy(channel) {
  if (process.platform !== "win32") return true;   // ← 谎报成功
```

后果：切号流程以为客户端已关，直接改登录文件；运行中的客户端一回写就把新账号覆盖成旧账号。
同类问题还有 `procRunning()` 直接 `return false`（永远报「未运行」，于是跳过关闭步骤）。

新增 `electron/backend/proxy/proc.cjs`（照 `zcodeLocal.cjs` 已验证的写法抽公共模块）：
Windows 走 `tasklist`/`taskkill`，Unix 走 `pgrep`/`pkill`；先 SIGTERM 后 SIGKILL。
**探测不到就是 false，杀不掉就是 false。**

---

## 4. 刻意保留的 Windows 伪装（不要「顺手修正」）

`proxy/adapters.cjs` 里的 `platform: "desktop-windows-x64"`、`osVersion "10.0.26200"`、
`deviceName "DESKTOP-XXXXXXX"`，以及 `discovery.cjs` 的 `client_platform: "desktop-windows"`，
**不是漏改的平台判断，是刻意伪装**——上游按这些字段做客户端校验，如实上报
`desktop-linux-x64` 会被判为不受支持的客户端，直接打断链路。

已在代码里加注释锁住。同样地，`rules.cjs` 的 `platform: "win32-x64"` 是 Trae billing 的查询参数默认值。

---

## 5. 开机自启：AppImage 按便携版处理

AppImage 每次运行挂载到 `/tmp/.mount_<随机>/`，写进 `~/.config/autostart/*.desktop` 的
`Exec` 路径下一次开机就指向不存在的目录；且无法原地覆盖更新。

因此 `config.cjs` / `updater.cjs` 的 `isPortable()` 加入了：

```js
if (process.platform === "linux" && process.env.APPIMAGE) return true;
```

UI 上「便携版不支持开机自启 / 请手动下载替换」的说法对 AppImage 同样成立，文案无需另写。

---

## 6. 打包配置（`package.json`）

```jsonc
"asarUnpack": ["**/*.node"],          // Linux 下 dlopen 读不了 asar 内的 .node
"extraResources": [ /* icon / tray / mcp —— 通用 */ ],
"win":   { "extraResources": [{ "from": "resources/sqlcipher", "to": "sqlcipher" }] },
"linux": {
  "target": [{ "target": "AppImage", "arch": ["x64"] }],
  "icon": "build/icon.png",
  "category": "Utility", "executableName": "agenthub",
  "extraResources": [{ "from": "resources/sqlcipher-linux-x64", "to": "sqlcipher-linux-x64" }]
}
```

平台专属的原生库放在平台段，靠 electron-builder「通用项 + 平台项**合并**」的行为生效
（不是覆盖，已由产物 `release/linux-unpacked/resources/sqlcipher-linux-x64` 证实）。
这样 Linux 包里不会再塞三个 Windows PE。

新增脚本：`electron:build:linux` / `electron:pack:linux`。

---

## 7. 其它改动

- `updater.cjs`：更新清单文件名按平台切换 `latest-linux.yml` / `latest-mac.yml` / `latest.yml`
  （否则 Linux 客户端会去解析 Windows 的 yml）。
- `sqlcipher.cjs`：`require("koffi")` 改为**惰性加载**。原先在模块顶层，而该模块被
  `sync-adapter.cjs` 在加载期整表 require，一处失败会连带整个应用起不来；
  现在失败半径收回到 SQLCipher 自身，其余 16 个数据源不受影响。
- `src/styles/global.css`：`--font-ui` 补 Linux CJK 候选（Noto Sans CJK SC / 文泉驿 / 思源），
  否则中文只能靠 fontconfig 兜底，发行版差异很大。
- `ConfigGeneralSection.vue`：自启文案去掉写死的「Windows」。
- `.gitattributes`：`tools/linux/*.sh|py` 强制 LF（CRLF 的 `.sh` 在 Linux 上会报
  `bad interpreter: /bin/bash^M`）。**没有**设全局 `* text=auto`——那会把全仓库重新规范化。
- CI：新增 `build-linux` job（`ubuntu-22.04`，`needs: build`），Windows job 先建 Release/tag、
  Linux job 追加资产；单独校验 `latest-linux.yml`。

---

## 8. 已知限制与后续项

1. **arm64 未构建**：需 `resources/sqlcipher-linux-arm64/`（同一脚本在 arm64 环境跑一遍即可）
   与 arm64 runner（如 `ubuntu-22.04-arm`）。配置位已按 `sqlcipher-linux-${process.arch}` 预留。
2. **safeStorage 降级**：Linux 上 `safeStorage` 依赖 libsecret/gnome-keyring。目标机缺失时
   `isEncryptionAvailable()` 为 false，WebDAV 密码会**降级明文存储**且当前无 UI 提示。
   AppImage 无法声明 deb 依赖，建议在设置页给一次明确提示。
3. **托盘**：Linux 桌面环境碎片化（GNOME 需 AppIndicator 扩展），`tray.png` 仅 32×32，
   深色主题下对比度未验证。真机上需实测。
4. **未做真机 GUI 验证**：容器内无显示环境，只验证了构建与后端路径（osdirs / sqlcipher）。
   首次交付前应在真实桌面环境过一遍启动、托盘、更新检查。
5. `src/api/mock.ts` 里仍有 `C:\...` 路径，仅 web 预览的 mock 数据，不影响打包产物。
