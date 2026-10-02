# 一次性迁移脚本：把各适配器里 Windows 优先的 homeDir() 样板收敛到 osdirs.home()。
# 用法：python tools/linux/migrate-homedir.py   （已在 linux/port-20261002 分支执行过，保留供复盘）
import re, subprocess, sys, os

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FILES = [
    "electron/backend/adapter-antigravity-common.cjs",
    "electron/backend/adapter-codex.cjs",
    "electron/backend/adapter-dsh.cjs",
    "electron/backend/adapter-grok.cjs",
    "electron/backend/adapter-mimo.cjs",
    "electron/backend/adapter-qoder-common.cjs",
    "electron/backend/adapter-reasonix.cjs",
    "electron/backend/adapter-workbuddy-common.cjs",
    "electron/backend/adapter-zcode.cjs",
]
OLD = 'return process.env.USERPROFILE || process.env.HOME || ".";'
NEW = "return osdirs.home();"
REQ = 'const osdirs = require("./osdirs.cjs");'

for rel in FILES:
    p = os.path.join(BASE, rel)
    txt = open(p, encoding="utf-8").read()
    if OLD not in txt:
        print(f"skip (已迁移或无此模式): {rel}")
        continue
    txt = txt.replace(OLD, NEW)
    if "osdirs" not in txt:
        # 插到最后一个顶层 require 之后，保持 import 区集中
        lines = txt.split("\n")
        last = -1
        for i, ln in enumerate(lines[:60]):
            if re.match(r'^const .*= require\(.*\);\s*$', ln):
                last = i
        if last < 0:
            print(f"!! 未找到 require 区，跳过：{rel}")
            continue
        lines.insert(last + 1, REQ)
        txt = "\n".join(lines)
    open(p, "w", encoding="utf-8", newline="").write(txt)
    print(f"ok: {rel}")

# 语法校验
bad = []
for rel in FILES:
    p = os.path.join(BASE, rel)
    r = subprocess.run(["node", "--check", p], capture_output=True, text=True)
    if r.returncode != 0:
        bad.append(rel)
        print(f"!! 语法错误 {rel}: {r.stderr[:200]}")
print("语法校验:", "全部通过" if not bad else f"失败 {bad}")
sys.exit(1 if bad else 0)
