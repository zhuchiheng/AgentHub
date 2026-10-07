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

# apt 源换成国内镜像：实测 archive.ubuntu.com 单次响应要 13 秒，
# 阿里云 0.76 秒（快 17 倍）。apt-get update 要拉几十个索引，用官方源会卡到超时。
# 构建参数留了开关：海外环境可 --build-arg APT_MIRROR=archive.ubuntu.com 换回官方源。
ARG APT_MIRROR=mirrors.aliyun.com
RUN set -eux; \
    if [ "$APT_MIRROR" != "archive.ubuntu.com" ]; then \
      sed -i "s|http://archive.ubuntu.com/ubuntu|http://${APT_MIRROR}/ubuntu|g; s|http://security.ubuntu.com/ubuntu|http://${APT_MIRROR}/ubuntu|g" /etc/apt/sources.list; \
    fi

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
    AGENTHUB_WEB_HOST=0.0.0.0 \
    AGENTHUB_DATA_DIR=/data \
    AGENTHUB_DATA_MOUNT=/data \
    TZ=Asia/Shanghai

# 同阶段 1：走国内镜像源（实测官方源单次响应 13s，阿里云 0.76s）
ARG APT_MIRROR=mirrors.aliyun.com
RUN set -eux; \
    if [ "$APT_MIRROR" != "archive.ubuntu.com" ]; then \
      sed -i "s|http://archive.ubuntu.com/ubuntu|http://${APT_MIRROR}/ubuntu|g; s|http://security.ubuntu.com/ubuntu|http://${APT_MIRROR}/ubuntu|g" /etc/apt/sources.list; \
    fi

# tzdata 让 TZ 生效；libsecret 对应 safeStorage（缺了 WebDAV 密码会降级明文存储）；
# openssh-server 供容器内排查用（可选启用，见 docker/entrypoint.sh）
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      curl ca-certificates libsecret-1-0 tzdata openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone \
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && mkdir -p /run/sshd
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
COPY docker ./docker
COPY package.json ./
RUN chmod +x docker/entrypoint.sh

# 9528 Web 控制台 / 9527 反代网关 / 22 SSH（可选）
EXPOSE 9528 9527 22

# 数据（配置 / 用量库 / 号池 / 记忆仓库 / 网关统计）全量落这里，由 compose 挂到 NAS
VOLUME /data

ENTRYPOINT ["/bin/bash", "/app/docker/entrypoint.sh"]
