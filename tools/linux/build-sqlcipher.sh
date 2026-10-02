#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 为 Linux 构建 libsqlcipher.so（AgentHub 的 Trae 系数据源经 koffi FFI 加载）
#
# 设计要点：
#   - OpenSSL 静态链进 .so：目标机不必装 libcrypto/libssl，也避免与系统
#     OpenSSL 版本冲突（Windows 侧同样是随包带 libcrypto/libssl DLL）。
#   - 只导出 sqlite3_* 符号：SQLCipher 默认还会带一堆内部符号，这里不额外
#     处理（koffi 只按函数名查找，符号多不影响功能，但会让 .so 稍大）。
#   - 版本锁 4.6.1：与 Windows 侧 resources/sqlcipher/sqlcipher.dll 同版本，
#     保证 raw key 模式下的默认 cipher 参数（kdf_iter/HMAC/page size 等）
#     完全一致，否则会报 "file is not a database"。
#
# 用法（Linux 主机或容器内）：
#   bash tools/linux/build-sqlcipher.sh
# 环境变量：
#   SQLCIPHER_VERSION  默认 4.6.1
#   OUT_DIR            默认 resources/sqlcipher-linux-<uname -m>
# ---------------------------------------------------------------------------
set -euo pipefail

SQLCIPHER_VERSION="${SQLCIPHER_VERSION:-4.6.1}"
# 目录名要跟 Node 的 process.arch 对齐（x64 / arm64），而不是 uname -m 的 x86_64 / aarch64
case "$(uname -m)" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) ARCH="$(uname -m)" ;;
esac
OUT_DIR="${OUT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)/resources/sqlcipher-linux-${ARCH}}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "[1/6] 安装构建依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# tcl 是构建期依赖：SQLCipher 用 tclsh 生成 amalgamation（sqlite3.c），缺了会
# 在 make 阶段报 "has_tclsh84 Error 1"。它不进入最终 .so，仅构建时需要。
apt-get install -y -qq --no-install-recommends \
  build-essential ca-certificates wget pkg-config libssl-dev tcl tcl-dev

echo "[2/6] 下载 SQLCipher ${SQLCIPHER_VERSION} 源码"
cd "$WORK"
SRC_URL="https://github.com/sqlcipher/sqlcipher/archive/refs/tags/v${SQLCIPHER_VERSION}.tar.gz"
wget -q --show-progress --progress=dot:giga -O sqlcipher.tar.gz "$SRC_URL"
tar xzf sqlcipher.tar.gz
cd "sqlcipher-${SQLCIPHER_VERSION}"

LIBDIR="/usr/lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH 2>/dev/null || echo x86_64-linux-gnu)"

echo "[3/5] configure（先出静态库，稍后手动重链成 .so）"
# 注意：不能指望 configure 直接产出「静态链了 libcrypto 的 .so」——
# AC_CHECK_LIB 检测到 -lcrypto 后会把它塞进 LIBS，libtool 优先选动态 .so，
# 结果产物照样依赖 libcrypto.so.N。所以这里先编 .a，再用 gcc 手动重链。
# -fPIC 必需：最终要做可 dlopen 的共享库。
./configure \
  --disable-tcl \
  --enable-tempstore=yes \
  --enable-shared=no \
  --enable-static=yes \
  CFLAGS="-O2 -fPIC -DSQLITE_HAS_CODEC -DSQLITE_ENABLE_JSON1 -DSQLITE_ENABLE_FTS5"

echo "[4/5] make + 手动重链为共享库"
make -j"$(nproc)" >/dev/null

mkdir -p "$OUT_DIR"
# --whole-archive 保证 sqlite3_* 全部导出；libcrypto 用 .a 静态链入，之后不再有外部依赖
gcc -shared -O2 \
  -Wl,--whole-archive .libs/libsqlcipher.a -Wl,--no-whole-archive \
  "${LIBDIR}/libcrypto.a" \
  -lm -ldl -lpthread \
  -Wl,-soname,libsqlcipher.so.0 \
  -o "${OUT_DIR}/libsqlcipher.so.0"
# 只保留带 SONAME 的 .so.0：dlopen 用得上，也是 sqlcipher.cjs 的首选名。
# 不再额外复制一份无版本号的 .so（内容完全相同，白白多 6MB 进仓库）
echo "--- 动态依赖（应只剩 libc/libm，不应有 libcrypto）---"
ldd "${OUT_DIR}/libsqlcipher.so.0" || true
if ldd "${OUT_DIR}/libsqlcipher.so.0" | grep -q "libcrypto"; then
  echo "!! 警告：libcrypto 仍是动态依赖，目标机缺少 OpenSSL 时将无法加载"
fi

echo "[5/5] 自检：确认导出符号可用"
nm -D --defined-only "${OUT_DIR}/libsqlcipher.so.0" | grep -c " T sqlite3_" || true
nm -D --defined-only "${OUT_DIR}/libsqlcipher.so.0" | grep " T sqlcipher_export" || echo "(sqlcipher_export 未导出，见下方说明)"

ls -la "$OUT_DIR"
echo "完成：${OUT_DIR}/libsqlcipher.so.0"
