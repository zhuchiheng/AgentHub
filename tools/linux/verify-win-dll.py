# 交叉验证（Windows 侧）：用 ctypes 直接加载项目自带的 sqlcipher.dll，
# 以 Trae 的 raw key 创建一个加密库，供 Linux 侧 libsqlcipher.so 打开验证。
#
# 这一步是移植里最关键的风险点：两边 SQLCipher 版本/编译参数若不一致，
# 会出现「密钥明明正确却报 file is not a database」。交叉解密能一次证伪。
import ctypes, ctypes.util, os, sys

# 脚本位于 tools/linux/ → 上溯三级才是仓库根
BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DLL_DIR = os.path.join(BASE, "resources", "sqlcipher")
KEY = "3605f6691095a993f03d5009c918352ef5be31ae31e8f000212b81ff058da773"
OUT = os.path.join(BASE, "tools", "linux", "xcheck-win-made.db")

for dep in ("libcrypto-1_1-x64.dll", "libssl-1_1-x64.dll"):
    p = os.path.join(DLL_DIR, dep)
    if os.path.exists(p):
        ctypes.CDLL(p)
lib = ctypes.CDLL(os.path.join(DLL_DIR, "sqlcipher.dll"))

lib.sqlite3_open.restype = ctypes.c_int
lib.sqlite3_open.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
lib.sqlite3_exec.restype = ctypes.c_int
lib.sqlite3_exec.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_void_p,
                             ctypes.POINTER(ctypes.c_char_p)]
lib.sqlite3_close.restype = ctypes.c_int
lib.sqlite3_close.argtypes = [ctypes.c_void_p]
lib.sqlite3_errmsg.restype = ctypes.c_char_p
lib.sqlite3_errmsg.argtypes = [ctypes.c_void_p]
lib.sqlite3_prepare_v2.restype = ctypes.c_int
lib.sqlite3_prepare_v2.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int,
                                   ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_char_p)]
lib.sqlite3_step.restype = ctypes.c_int
lib.sqlite3_step.argtypes = [ctypes.c_void_p]
lib.sqlite3_finalize.restype = ctypes.c_int
lib.sqlite3_finalize.argtypes = [ctypes.c_void_p]
lib.sqlite3_column_text.restype = ctypes.c_char_p
lib.sqlite3_column_text.argtypes = [ctypes.c_void_p, ctypes.c_int]

if os.path.exists(OUT):
    os.remove(OUT)

db = ctypes.c_void_p()
rc = lib.sqlite3_open(OUT.encode(), ctypes.byref(db))
assert rc == 0, f"open failed rc={rc}"
print("opened:", OUT)


def ex(sql):
    err = ctypes.c_char_p()
    rc = lib.sqlite3_exec(db, sql.encode(), None, None, ctypes.byref(err))
    if rc != 0:
        msg = err.value.decode() if err.value else lib.sqlite3_errmsg(db).decode()
        raise RuntimeError(f"exec failed rc={rc}: {msg}")


ex(f"PRAGMA key = \"x'{KEY}'\"")


def one(sql):
    stmt = ctypes.c_void_p()
    rc = lib.sqlite3_prepare_v2(db, sql.encode(), -1, ctypes.byref(stmt), None)
    if rc != 0:
        raise RuntimeError(f"prepare rc={rc}: {lib.sqlite3_errmsg(db).decode()}")
    try:
        if lib.sqlite3_step(stmt) == 100:
            v = lib.sqlite3_column_text(stmt, 0)
            return v.decode() if v else ""
        return ""
    finally:
        lib.sqlite3_finalize(stmt)


print("sqlite_version   :", one("SELECT sqlite_version()"))
print("cipher_version   :", one("PRAGMA cipher_version"))
for p in ("cipher", "kdf_iter", "cipher_page_size", "kdf_algorithm", "hmac_algorithm",
          "plaintext_header_size", "page_size"):
    try:
        print(f"{p:18}:", one(f"PRAGMA {p}"))
    except Exception as e:
        print(f"{p:18}: (err {e})")

ex("CREATE TABLE xcheck (id INTEGER PRIMARY KEY, note TEXT)")
ex("INSERT INTO xcheck (note) VALUES ('hello-from-windows-dll')")
lib.sqlite3_close(db)
print("size:", os.path.getsize(OUT))
print("OK: 已用 Windows sqlcipher.dll 写出加密库")
