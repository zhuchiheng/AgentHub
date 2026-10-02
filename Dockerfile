# AgentHub Web 版（容器部署）
#
# 注意：运行阶段**不需要 Electron 二进制，也不需要 Xvfb** ——
# server/ 通过 electron-shim 让 backend 跑在纯 Node 上，只有无头冒烟测试才用得到 Electron。
# 所以生产镜像只有运行时依赖，不带桌面栈。
#
# 构建：docker build -t agenthub-web .
# 运行：docker run -p 9528:9528 -p 9527:9527 -v agenthub-data:/root/.agenthub-server agenthub-web
#   9528 = Web 控制台；9527 = 反代网关（OpenAI 兼容接口，供 AI 客户端接入）
# 鉴权：设置 AGENTHUB_WEB_TOKEN 即启用（留空 = 不鉴权，仅内网可信环境）

# 基线用 ubuntu:22.04（glibc 2.35）而非 node 官方镜像：
# 一是与 SQLCipher 编译基线保持一致，二是部分网络环境拉不到 docker.io 的 library/node。
# 若你的环境能正常拉取 node:22-bookworm-slim，换成它可让镜像更小。

# ===== 阶段 1：装依赖 + 构建前端 =====
FROM ubuntu:22.04 AS build
WORKDIR /app
ENV DEBIAN_FRONTEND=noninteractive

# cmake/g++：koffi 无预编译包时需要本地编译（Trae 系数据源的 SQLCipher FFI 依赖它）
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      curl ca-certificates cmake g++ make python3 \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y -qq nodejs \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build
# 运行阶段只要运行时依赖：devDeps（vite/vue-tsc/electron-builder）全部裁掉
RUN npm prune --omit=dev

# ===== 阶段 2：运行 =====
FROM ubuntu:22.04
WORKDIR /app
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    AGENTHUB_WEB_PORT=9528 \
    AGENTHUB_WEB_HOST=0.0.0.0

# libsecret 对应 safeStorage：容器里没有密钥链时 WebDAV 密码会降级明文存储，
# 装上它（配合挂载的 gnome-keyring）能避免降级
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      curl ca-certificates libsecret-1-0 \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y -qq nodejs \
    && rm -rf /var/lib/apt/lists/*

# node_modules 直接复用构建阶段的产物（含已编译好的 koffi）
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY electron ./electron
COPY server ./server
COPY tools ./tools
COPY resources ./resources
COPY package.json ./

# 9528 Web 控制台 / 9527 反代网关
EXPOSE 9528 9527

VOLUME /root/.agenthub-server

CMD ["node", "server/index.cjs"]
