#!/usr/bin/env python3
"""最小 LevelDB log 解析器（只读），用来窥探 Chrome 扩展的本地存储结构。

LevelDB log 文件由 32KB block 组成，block 内是若干 record：
  checksum(4) | length(2) | type(1) | data[length]
type: 1=FULL 2=FIRST 3=MIDDLE 4=LAST
data 是 WriteBatch:
  seq(8) | count(4) | entries
entry: type(1) | varint keylen | key | [varint vallen | value]
"""
import struct
import sys

BLOCK = 32768
FULL, FIRST, MIDDLE, LAST = 1, 2, 3, 4


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
    """按 block 边界切分，返回 [(type, data), ...]"""
    with open(path, 'rb') as f:
        blob = f.read()

    records = []
    partial = b''
    off = 0
    n = len(blob)
    while off + 7 <= n:
        block_off = off % BLOCK
        # block 尾部不足 7 字节是 padding
        if BLOCK - block_off < 7:
            off += BLOCK - block_off
            continue
        crc, length, rtype = struct.unpack_from('<IHB', blob, off)
        off += 7
        if length == 0 and rtype == 0:
            off = (off // BLOCK + 1) * BLOCK
            continue
        if off + length > n:
            break
        data = blob[off:off + length]
        off += length

        if rtype == FULL:
            records.append(data)
        elif rtype == FIRST:
            partial = data
        elif rtype == MIDDLE:
            partial += data
        elif rtype == LAST:
            partial += data
            records.append(partial)
            partial = b''
    return records


def parse_batch(data):
    """WriteBatch → [(key, value_or_None), ...]"""
    if len(data) < 12:
        return []
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
        if etype == 1:
            vlen, i = read_varint(data, i)
            val = data[i:i + vlen]
            i += vlen
            out.append((key, val))
        else:
            out.append((key, None))
    return out


def main():
    path = sys.argv[1]
    pat = sys.argv[2].encode() if len(sys.argv) > 2 else None

    recs = parse_records(path)
    print(f'{path}: {len(recs)} 条 record', file=sys.stderr)

    total = 0
    for r in recs:
        for key, val in parse_batch(r):
            total += 1
            if pat and pat not in key.lower() and (val is None or pat not in val.lower()):
                continue
            ks = key.decode('utf-8', 'replace')
            if val is None:
                print(f'DEL  {ks!r}')
            else:
                try:
                    vs = val.decode('utf-8')
                    if len(vs) > 300:
                        vs = vs[:300] + f'... (+{len(val) - 300}B)'
                except UnicodeDecodeError:
                    vs = f'<{len(val)}B binary>'
                print(f'PUT  {ks!r} = {vs}')
    print(f'共 {total} 个条目', file=sys.stderr)


if __name__ == '__main__':
    main()
