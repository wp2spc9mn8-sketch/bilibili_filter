#!/usr/bin/env python3
"""把 userscript 新版本写进 Tampermonkey 的 Chrome 扩展存储（LevelDB）。

无界面操作：直接修改 chrome-extension Local Extension Settings 的 log 文件。
必须在 Chrome 退出后运行（Chrome 会锁住 LevelDB）。

用法:
    python3 tmupsert.py <log文件> <userscript文件>
"""
import sys
import json
import glob
import struct
import shutil
import os

BLOCK = 32768
TYPE_FULL = 1
TYPE_VALUE = 1

# ---------- CRC32C (Castagnoli)，LevelDB 用的多项式 ----------
_TABLE = []
_POLY = 0x82F63B78


def _mk_table():
    for i in range(256):
        c = i
        for _ in range(8):
            c = (c >> 1) ^ (_POLY if c & 1 else 0)
        _TABLE.append(c)


_mk_table()


def crc32c(data):
    crc = 0xFFFFFFFF
    for b in data:
        crc = _TABLE[(crc ^ b) & 0xFF] ^ (crc >> 8)
    return crc ^ 0xFFFFFFFF


def mask_crc(crc):
    return (((crc >> 15) | (crc << 17)) & 0xFFFFFFFF) + 0xA282EAD8 & 0xFFFFFFFF


# ---------- 读现有数据 ----------
def read_varint(buf, i):
    result = shift = 0
    while True:
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, i
        shift += 7


def parse_records(path):
    with open(path, 'rb') as f:
        blob = f.read()
    records = []
    partial = b''
    off = 0
    n = len(blob)
    while off + 7 <= n:
        block_off = off % BLOCK
        if BLOCK - block_off < 7:
            off += BLOCK - block_off
            continue
        _crc, length, rtype = struct.unpack_from('<IHB', blob, off)
        off += 7
        if length == 0 and rtype == 0:
            off = (off // BLOCK + 1) * BLOCK
            continue
        if off + length > n:
            break
        data = blob[off:off + length]
        off += length
        if rtype == TYPE_FULL:
            records.append(data)
        elif rtype == 2:
            partial = data
        elif rtype == 3:
            partial += data
        elif rtype == 4:
            partial += data
            records.append(partial)
            partial = b''
    return records


def parse_batch(data):
    if len(data) < 12:
        return 0, []
    seq = struct.unpack_from('<Q', data, 0)[0]
    count = struct.unpack_from('<I', data, 8)[0]
    i = 12
    out = []
    for _ in range(count):
        if i >= len(data):
            break
        etype = data[i]
        i += 1
        klen, i = read_varint(data, i)
        key = data[i:i + klen]
        i += klen
        if etype == TYPE_VALUE:
            vlen, i = read_varint(data, i)
            out.append((key, data[i:i + vlen]))
            i += vlen
        else:
            out.append((key, None))
    return seq, out


# ---------- 写 ----------
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


def make_batch(seq, entries):
    body = bytearray()
    body += struct.pack('<I', len(entries))
    for key, val in entries:
        body += bytes([TYPE_VALUE])
        body += varint(len(key))
        body += key
        body += varint(len(val))
        body += val
    return struct.pack('<Q', seq) + bytes(body)


def make_record(data):
    crc = mask_crc(crc32c(bytes([TYPE_FULL]) + data))
    return struct.pack('<IHB', crc, len(data), TYPE_FULL) + data


def main():
    target, userscript = sys.argv[1], sys.argv[2]

    src = open(userscript, encoding='utf-8').read()

    # target 可以是目录（扫描所有 .log/.ldb）或单个 log 文件
    if os.path.isdir(target):
        files = sorted(glob.glob(os.path.join(target, '*.ldb'))) + \
                sorted(glob.glob(os.path.join(target, '*.log')))
    else:
        files = [target]
    records = []
    for f in files:
        try:
            records.extend(parse_records(f))
        except Exception as e:
            print(f'  跳过 {os.path.basename(f)}: {e}')
    latest = {}
    maxseq = 0
    for r in records:
        seq, entries = parse_batch(r)
        maxseq = max(maxseq, seq)
        for k, v in entries:
            if v is not None:
                latest[k] = v

    uuid = None
    for k in latest:
        ks = k.decode('utf-8', 'replace')
        if '@source#' in ks:
            uuid = ks.split('@source#')[1]
            break
    if not uuid:
        raise SystemExit('没找到脚本 uuid')

    meta_key = f'!extdb.@meta#{uuid}'.encode()
    src_key = f'!extdb.@source#{uuid}'.encode()
    if meta_key not in latest or src_key not in latest:
        raise SystemExit('meta 或 source 记录缺失')

    meta = json.loads(latest[meta_key])
    old_ver = meta['value'].get('version') or '?'
    new_ver = [l.split()[-1] for l in src.split('\n') if l.strip().startswith('// @version')][0]

    # 更新 meta：版本、header、描述、时间戳
    header_lines = []
    for line in src.split('\n'):
        header_lines.append(line)
        if line.strip() == '// ==/UserScript==':
            break
    meta['value']['header'] = '\n'.join(header_lines)
    meta['value']['version'] = new_ver
    desc = [l.split(None, 2)[-1].strip() for l in header_lines if l.strip().startswith('// @description')]
    if desc:
        meta['value']['description'] = desc[0]
    meta['value']['lastModified'] = 1793500000000.0

    entries = [
        (meta_key, json.dumps(meta, ensure_ascii=False, separators=(',', ':')).encode()),
        (src_key, json.dumps({'origin': 'normal', 'value': src},
                             ensure_ascii=False, separators=(',', ':')).encode()),
    ]

    # 写入目标 log：目录模式下取编号最大的 .log，没有就新建
    if os.path.isdir(target):
        logs = sorted(glob.glob(os.path.join(target, '*.log')))
        if logs:
            logpath = logs[-1]
        else:
            logpath = os.path.join(target, '000001.log')
            open(logpath, 'wb').close()
    else:
        logpath = target
    print(f'  写入文件: {os.path.basename(logpath)}')

    # seq 必须比库里所有已有记录都大，否则会被 SSTable 里的旧版本盖住。
    # MANIFEST 记着全局 last_sequence，以它为准。
    man_seq = 0
    try:
        cur_name = open(os.path.join(target, 'CURRENT'), encoding='utf-8').read().strip() if os.path.isdir(target) else None
        if cur_name:
            import importlib.util as _iu
            from pathlib import Path as _P
            spec = _iu.spec_from_file_location('ta', _P(__file__).parent / 'tmappend.py')
            ta = _iu.module_from_spec(spec)
            sys.argv[0] = sys.argv[0]
            spec.loader.exec_module(ta)
            log_n, next_n, man_seq = ta.parse_manifest(os.path.join(target, cur_name))
    except Exception as e:
        print('  警告：读 MANIFEST 失败，用文件内最大 seq:', e)

    # Tampermonkey 启动时可能把自己内存里的旧版本写回，序号比 MANIFEST 记的更大。
    # 直接跳到一个远高于历史的值，确保这次写入胜出。
    use_seq = max(maxseq, man_seq) + 100000
    batch = make_batch(use_seq, entries)
    rec = make_record(batch)

    # 对齐到下一个 block 起点，保证整条 record 落在单个 block 内
    size = os.path.getsize(logpath)
    rem = size % BLOCK
    pad = 0
    if rem and rem + len(rec) > BLOCK:
        pad = BLOCK - rem
    with open(logpath, 'ab') as f:
        if pad:
            f.write(b'\x00' * pad)
        f.write(rec)

    print(f'  uuid   : {uuid}')
    print(f'  版本   : {old_ver} → {new_ver}')
    print(f'  meta   : {len(entries[0][1])} B')
    print(f'  source : {len(entries[1][1])} B')
    print(f'  写入   : {len(rec)} B (seq={use_seq}, manifest_seq={man_seq}, 前补 {pad} B)')


if __name__ == '__main__':
    main()
