// Electron API 的最小替身：让 electron/backend 下的模块能在纯 Node（容器）里跑。
//
// 为什么需要它：backend 里有 15 个文件直接 require("electron")。
// 在 Electron 进程外，require("electron") 返回的是可执行文件路径字符串（electron
// npm 包的设计），解构出来的 app / BrowserWindow 全是 undefined，
// 于是 app.getVersion() 这类调用会在启动阶段直接崩。
// server/index.cjs 会把 require("electron") 劫持到本模块。
//
// 设计原则：桌面专属能力在这里**显式降级**而不是假装成功——
// 打不开目录就返回失败，不能加密就如实说不可用，绝不像当初 wbClient 那样谎报。
"use strict";
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const VERSION = (() => {
  try {
    return require(path.join(__dirname, "..", "package.json")).version;
  } catch {
    return "0.0.0";
  }
})();

/** 数据目录：容器里统一落在 AGENTHUB_DATA_DIR，默认 <home>/.agenthub-server */
function dataRoot() {
  return process.env.AGENTHUB_DATA_DIR || path.join(os.homedir(), ".agenthub-server");
}

// ===== 广播总线：backend 通过 BrowserWindow.getAllWindows() 发事件给渲染层，
//      这里把这些事件接到总线上，由 server 经 SSE 推给浏览器 =====
const bus = new EventEmitter();
bus.setMaxListeners(0);

function broadcast(channel, payload) {
  bus.emit("broadcast", { channel, payload });
}

/** 一个假的窗口：webContents.send 直接进广播总线 */
function fakeWindow() {
  return {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => broadcast(channel, payload),
    },
  };
}

const app = {
  // 无窗口时为空数组；backend 遍历它发广播，返回假窗口即可把事件接出来
  getAllWindows: null, // 下面赋值为 BrowserWindow.getAllWindows
  getVersion: () => VERSION,
  getName: () => "AgentHub",
  setName: () => {},
  // 容器里恒为「已打包」语义：backend 有些分支只在 isPackaged 下启用（如自启）
  isPackaged: true,
  quit: () => process.exit(0),
  // 路径：容器里没有 Electron 的 userData 约定，统一给数据根下的子目录
  getPath: (name) => {
    const root = dataRoot();
    const map = {
      userData: root,
      home: os.homedir(),
      temp: os.tmpdir(),
      exe: process.execPath,
      documents: path.join(os.homedir(), "Documents"),
      downloads: path.join(os.homedir(), "Downloads"),
    };
    return map[name] || root;
  },
  // 无头环境无从注册自启，明确返回 false（不谎报成功）
  setLoginItemSettings: () => false,
  getLoginItemSettings: () => ({ openAtLogin: false }),
  requestSingleInstanceLock: () => true,
  whenReady: () => Promise.resolve(),
  on: () => {},
  once: () => {},
};

const BrowserWindow = {
  getAllWindows: () => [fakeWindow()],
  getFocusedWindow: () => null,
};
app.getAllWindows = BrowserWindow.getAllWindows;

// 桌面通知：无头环境无处弹，静默丢弃
class Notification {
  constructor() {}
  show() {}
}
Notification.isSupported = () => false;

const shell = {
  // 打开本地目录/文件：容器内无桌面，明确失败让上层走「复制路径」提示
  openPath: async () => "容器内无法打开系统文件管理器",
  openExternal: async () => {},
  beep: () => {},
};

// 原生对话框：无 GUI，一律按「用户取消」返回，避免上层以为拿到了路径
const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  showMessageBox: async () => ({ response: 0 }),
};

const nativeTheme = {
  themeSource: "system",
  shouldUseDarkColors: false,
  on: () => {},
};

// safeStorage：容器里通常没有 libsecret/gnome-keyring。
// 如实返回不可用 —— 上层会降级为明文存储，这比假装加密安全得多。
const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error("容器环境无系统级密钥链（safeStorage 不可用）");
  },
  decryptString: () => {
    throw new Error("容器环境无系统级密钥链（safeStorage 不可用）");
  },
};

const nativeImage = {
  createFromPath: () => ({ isEmpty: () => true }),
  createEmpty: () => ({ isEmpty: () => true }),
};

const Tray = class Tray {
  constructor() {}
  setToolTip() {}
  setContextMenu() {}
  on() {}
};

const Menu = {
  buildFromTemplate: () => ({}),
};

// ipcMain 由 server 传入（收集 handler）；这里给一个默认的，防止直接引用时报错
const ipcMain = { handle: () => {} };
const ipcRenderer = { invoke: async () => undefined, on: () => {}, removeListener: () => {} };
const contextBridge = { exposeInMainWorld: () => {} };

module.exports = {
  // ===== 供 server 使用的内部件（不属于 Electron 真实 API）=====
  __bus: bus,
  __broadcast: broadcast,
  __dataRoot: dataRoot,
  // ===== Electron API 替身 =====
  app,
  BrowserWindow,
  Notification,
  shell,
  dialog,
  nativeTheme,
  safeStorage,
  nativeImage,
  Tray,
  Menu,
  ipcMain,
  ipcRenderer,
  contextBridge,
  net: require("node:net"),
  session: { defaultSession: { on: () => {}, cookies: { get: async () => [], set: async () => {} } } },
};
