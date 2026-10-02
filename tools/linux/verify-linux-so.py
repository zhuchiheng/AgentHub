# 交叉验证（Linux 侧）：用我们编译的 libsqlcipher.so.0 打开「Windows sqlcipher.dll 写出的」
# 加密库。能读出 note，说明两边的 SQLCipher 版本与默认 cipher 参数完全等价，
# Trae 系数据源可以直接在 Linux 上解禁。
#
# 用法（Linux 容器内）：
#   python3 tools/linux/verify-linux-so.py
import ctypes, os, sys

KEY = "3605f6691095a993f03d5009c918352ef5be31ae31e8f000212b81ff058da773"
BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SO = os.environ.get("SQLCIPHER_SO") or os.path.join(
    BASE, "resources", "sqlcipher-linux-x64", "libsqlcipher.so.0")
DB = os.environ.get("XCHECK_DB") or os.path.join(BASE, "tools", "linux", "xcheck-win-made.db")

lib = ctypes.CDLL(SO)
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

print("so :", SO)
print("db :", DB)

db = ctypes.c_void_p()
rc = lib.sqlite3_open(DB.encode(), ctypes.byref(db))
if rc != 0:
    sys.exit(f"open failed rc={rc}: {lib.sqlite3_errmsg(db).decode(errors='replace')}")


def ex(sql):
    err = ctypes.c_char_p()
    rc = lib.sqlite3_exec(db, sql.encode(), None, None, ctypes.byref(err))
    if rc != 0:
        msg = err.value.decode(errors="replace") if err.value else lib.sqlite3_errmsg(db).decode(errors="replace")
        raise RuntimeError(f"rc={rc}: {msg}")


def one(sql):
    stmt = ctypes.c_void_p()
    rc = lib.sqlite3_prepare_v2(db, sql.encode(), -1, ctypes.byref(stmt), None)
    if rc != 0:
        raise RuntimeError(f"prepare rc={rc}: {lib.sqlite3_errmsg(db).decode(errors='replace')}")
    try:
        if lib.sqlite3_step(stmt) == 100:
            v = lib.sqlite3_column_text(stmt, 0)
            return v.decode(errors="replace") if v else ""
        return ""
    finally:
        lib.sqlite3_finalize(stmt)


ex(f"PRAGMA key = \"x'{KEY}'\"")
print("--- 本库参数（应与 Windows 侧一致）---")
print("sqlite_version   :", one("SELECT sqlite_version()"))
print("cipher_version   :", one("PRAGMA cipher_version"))
for p in ("cipher", "kdf_iter", "cipher_page_size", "page_size"):
    print(f"{p:18}:", one(f"PRAGMA {p}"))

note = one("SELECT note FROM xcheck LIMIT 1")
print("--- 读取 Windows 写入的行 ---")
print("note:", repr(note))
lib.sqlite3_close(db)

if note == "hello-from-windows-dll":
    print("\nPASS: Linux .so 成功解密 Windows DLL 写出的库，raw key 与默认参数等价")
    sys.exit(0)
print("\nFAIL: 解不开或读出内容不符 —— 两侧 SQLCipher 版本/编译参数不一致")
sys.exit(1)
