// 网关接入地址推导（渲染层）
//
// 背景：后端 gatewayStatus().baseUrl 用的是「可连接 host」，但它有天然局限——
// 主进程不知道用户是从哪个地址访问控制台的。容器部署时尤其明显：
//   NAS IP 是 192.168.1.5，主进程只知道自己监听 0.0.0.0，回落到 127.0.0.1，
//   用户把 http://127.0.0.1:9527/v1 填进客户端仍然连不上。
//
// 而**浏览器地址栏里就写着用户实际能访问的地址**。Web 模式下用它推导，
// 是唯一能给出「用户真能连上」的答案的方式。桌面端没有 location.hostname，行为不变。

/** Web 服务端模式标记：由 api/ipc.ts 探测到 /api/health 后置位（复用同一份探测结果，避免重复请求） */
let webServerMode = false;

/** 供 ipc.ts 在探测成功后调用 */
export function markWebServerMode(on: boolean): void {
  webServerMode = on;
}

/** 是否为 Web 服务端模式 */
export function isWebServerMode(): boolean {
  return webServerMode;
}

/** 不可连接的监听地址（通配地址不能拿去当客户端地址） */
function isUnconnectable(host: string): boolean {
  return !host || host === "0.0.0.0" || host === "::" || host === "[::]" || host === "127.0.0.1" || host === "localhost";
}

/**
 * 推导网关对外接入地址。
 * @param backendBaseUrl 后端给的 baseUrl（已用可连接 host 构造；桌面端直接用）
 * @param gatewayPort    网关端口
 * @returns 形如 `http://<host>:<port>/v1`
 */
export function gatewayBaseUrl(backendBaseUrl: string | undefined, gatewayPort: number): string {
  const port = gatewayPort || 9527;
  const m = backendBaseUrl ? /^https?:\/\/([^/:]+)/.exec(backendBaseUrl) : null;
  const backendHost = m ? m[1] : "";

  // 后端给了真正可连接的 host（非通配、非回环）→ 直接采信
  if (backendBaseUrl && !isUnconnectable(backendHost)) return backendBaseUrl;

  // Web 模式：浏览器能打开控制台，就能用同一个 host 连网关
  if (webServerMode && typeof window !== "undefined" && window.location) {
    const h = window.location.hostname;
    if (h && !isUnconnectable(h)) {
      // 控制台走 https 时网关通常在同一层反代后，跟随协议更稳妥
      const proto = window.location.protocol === "https:" ? "https" : "http";
      return `${proto}://${h}:${port}/v1`;
    }
  }

  return backendBaseUrl || `http://127.0.0.1:${port}/v1`;
}
