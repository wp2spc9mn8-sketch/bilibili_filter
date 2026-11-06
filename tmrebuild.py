#!/usr/bin/env python3
"""重建 Tampermonkey 的扩展存储，只保留一个 userscript 的最新版本。

背景：Chrome 的 LevelDB 会把旧 log 合并进 SSTable，之后往旧 log 追加的
任何数据都不会被重放；直接把整个 MANIFEST 改掉又会被 Chrome 重写成空。
既然这个库里只有同一个脚本的 8 个键，最干净的做法就是整体重建：
一个 MANIFEST + 一个 log，把所有键按最新值重新写一遍。

用法（Chrome 必须已退出）:
    python3 tmrebuild.py <目标目录> <备份目录> <userscript>
"""
import sys
import os
import json
import struct
import shutil
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "ldb_dump", Path(__file__).parent / "ldb-dump.py")
_m = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_m)
parse_records = _m.parse_records
parse_batch = _m.parse_batch

BLOCK = 32768
TYPE_FULL = 1
TYPE_VALUE = 1
COMPARATOR = b"leveldb.BytewiseComparator"
SEQ = 100000

_TABLE = []
_POLY = 0x82F63B78
for _i in range(256):
    _c = _i
    for _ in range(8):
        _c = (_c >> 1) ^ (_POLY if _c & 1 else 0)
    _TABLE.append(_c)


def crc32c(data):
    crc = 0xFFFFFFFF
    for b in data:
        crc = _TABLE[(crc ^ b) & 0xFF] ^ (crc >> 8)
    return crc ^ 0xFFFFFFFF


def mask_crc(crc):
    return (((crc >> 15) | (crc << 17)) & 0xFFFFFFFF) + 0xA282EAD8 & 0xFFFFFFFF


def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def make_record(data):
    crc = mask_crc(crc32c(bytes([TYPE_FULL]) + data))
    return struct.pack("<IHB", crc, len(data), TYPE_FULL) + data


def make_batch(seq, pairs):
    body = bytearray()
    body += struct.pack("<I", len(pairs))
    for key, val in pairs:
        body += bytes([TYPE_VALUE])
        body += varint(len(key))
        body += key
        body += varint(len(val))
        body += val
    return struct.pack("<Q", seq) + bytes(body)


def make_manifest(seq):
    body = bytearray()
    body += varint(1) + varint(len(COMPARATOR)) + COMPARATOR   # comparator
    body += varint(2) + varint(0)                              # log number
    body += varint(3) + varint(2)                              # next file number
    body += varint(4) + varint(seq)                            # last sequence
    body += varint(0)                                          # end
    return bytes(body)


def main():
    if len(sys.argv) < 4:
        raise SystemExit("用法: tmrebuild.py <目标目录> <备份目录> <userscript>")
    target, backup_dir, userscript = sys.argv[1], sys.argv[2], sys.argv[3]

    src = open(userscript, encoding="utf-8").read()
    new_ver = [l.split()[-1] for l in src.split("\n")
               if l.strip().startswith("// @version")][0]

    # ---- 取备份里的全部键（后写覆盖前写）----
    latest = {}
    for f in sorted(Path(backup_dir).glob("*.log")):
        try:
            for r in parse_records(str(f)):
                for k, v in parse_batch(r):
                    if v is not None:
                        latest[k] = v
        except Exception as e:  # noqa: BLE001
            print("  跳过 %s: %s" % (f.name, e))

    meta_key = next((k for k in latest if b"@meta#" in k), None)
    src_key = next((k for k in latest if b"@source#" in k), None)
    if not meta_key or not src_key:
        raise SystemExit("备份里找不到 meta/source")

    meta = json.loads(latest[meta_key])
    old_ver = meta["value"].get("version") or "?"

    header_lines = []
    for line in src.split("\n"):
        header_lines.append(line)
        if line.strip() == "// ==/UserScript==":
            break
    meta["value"]["header"] = "\n".join(header_lines)
    meta["value"]["version"] = new_ver
    for line in header_lines:
        if line.strip().startswith("// @description"):
            meta["value"]["description"] = line.split(None, 2)[-1].strip()
            break

    latest[meta_key] = json.dumps(meta, ensure_ascii=False,
                                  separators=(",", ":")).encode()
    latest[src_key] = json.dumps({"origin": "normal", "value": src},
                                 ensure_ascii=False,
                                 separators=(",", ":")).encode()

    # 保留目标库里现有的全局设置（#schema / #version / #begging ...）。
    # 缺了 #schema，Tampermonkey 会把整库当成旧版做迁移，顺手丢掉脚本。
    try:
        for f in Path(target).glob("*.log"):
            for r in parse_records(str(f)):
                for k, v in parse_batch(r):
                    if v is None:
                        continue
                    if k.startswith(b"!extdb.@") or k.startswith(b"!misc.global"):
                        continue
                    if k not in latest:
                        latest[k] = v
    except Exception as e:  # noqa: BLE001
        print("  警告：读取全局设置失败:", e)

    pairs = sorted(latest.items(), key=lambda kv: kv[0])

    # ---- 重建 ----
    os.makedirs(target, exist_ok=True)
    for f in Path(target).iterdir():
        if f.is_file():
            f.unlink()
        elif f.is_dir():
            shutil.rmtree(f)

    log_path = os.path.join(target, "000001.log")
    with open(log_path, "wb") as f:
        f.write(make_record(make_batch(SEQ, pairs)))

    man_path = os.path.join(target, "MANIFEST-000001")
    with open(man_path, "wb") as f:
        f.write(make_record(make_manifest(SEQ)))

    with open(os.path.join(target, "CURRENT"), "w") as f:
        f.write("MANIFEST-000001\n")

    print("  重建目录: %s" % target)
    print("  版本    : %s → %s" % (old_ver, new_ver))
    print("  键数    : %d" % len(pairs))
    for k, v in pairs:
        print("    %-58s %6d B" % (k.decode("utf-8", "replace")[:58], len(v)))
    kept = [k.decode("utf-8", "replace") for k in latest if not k.startswith(b"!extdb.@")]
    print("  保留全局键: %s" % (", ".join(kept) or "无"))
    print("  MANIFEST: log=0 next=2 seq=%d" % SEQ)


if __name__ == "__main__":
    main()
