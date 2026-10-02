// 把 Electron 的 ipcMain.handle 收集成一张表，供 HTTP 路由调用。
//
// backend 的 ipc.cjs / sync-ipc.cjs 都是 register(ctx) 形式（依赖注入），
// 传一个假 ipcMain 进去就能把所有 handler 收下来，无需改动 backend 一行代码。
"use strict";

/**
 * 造一个只负责「登记」的 ipcMain。
 * @returns {{ ipcMain: object, handlers: Map<string, Function> }}
 */
function collectIpcMain() {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => {
      handlers.set(channel, fn);
    },
    on: () => {},
    once: () => {},
    removeHandler: (channel) => handlers.delete(channel),
  };
  return { ipcMain, handlers };
}

/** 假 IPC event：backend handler 的第一参数，这里只需要 sender 可写 */
function fakeEvent() {
  return { sender: { send: () => {} }, preventDefault: () => {} };
}

module.exports = { collectIpcMain, fakeEvent };
