#!/usr/bin/env python3
"""fbx_blendshape_names.py — 從二進位 FBX 讀出臉部表情（BlendShapeChannel）名稱，依 FBX2glTF 輸出的順序。

FBX2glTF 轉出的 glb 有 morph targets 但沒有名稱；用這支補上：
  python tools/fbx_blendshape_names.py 角色.fbx  → 印出 JSON 名稱清單
"""
import json, struct, sys, zlib


def read_nodes(b, off, end, v64):
    nodes = []
    while off < end:
        if v64:
            eo, np_, pl = struct.unpack('<QQQ', b[off:off + 24]); off += 24
        else:
            eo, np_, pl = struct.unpack('<III', b[off:off + 12]); off += 12
        nl = b[off]; off += 1
        if eo == 0:
            break
        name = b[off:off + nl].decode('latin1'); off += nl
        props, p = [], off
        for _ in range(np_):
            t = chr(b[p]); p += 1
            if t in 'SR':
                n = struct.unpack('<I', b[p:p + 4])[0]; p += 4; props.append(b[p:p + n]); p += n
            elif t in 'fdlib':
                n, enc, cl = struct.unpack('<III', b[p:p + 12]); p += 12
                data = b[p:p + cl]; p += cl
                props.append(('arr', t, n, enc, data))
            else:
                sz = {'Y': 2, 'C': 1, 'I': 4, 'F': 4, 'D': 8, 'L': 8}[t]
                fmt = {'Y': '<h', 'C': '<?', 'I': '<i', 'F': '<f', 'D': '<d', 'L': '<q'}[t]
                props.append(struct.unpack(fmt, b[p:p + sz])[0]); p += sz
        off += pl
        kids = read_nodes(b, off, eo, v64) if off < eo else []
        nodes.append((name, props, kids))
        off = eo
    return nodes


def names(path):
    b = open(path, 'rb').read()
    assert b[:20] == b'Kaydara FBX Binary  ', '只支援二進位 FBX'
    ver = struct.unpack('<I', b[23:27])[0]
    top = read_nodes(b, 27, len(b), ver >= 7500)
    get = lambda n: next((x for x in top if x[0] == n), None)
    objs, conns = get('Objects'), get('Connections')
    nm = lambda s: s.split(b'\x00\x01')[0].decode('utf-8', 'replace')
    kind = {}
    for name, props, _ in objs[2]:
        if name in ('Deformer', 'Geometry', 'Model') and len(props) >= 3:
            kind[props[0]] = (name, nm(props[1]), props[2].decode('latin1') if isinstance(props[2], bytes) else props[2])
    out = []
    # BlendShape 底下的 BlendShapeChannel，依連結順序（FBX SDK 的 GetBlendShapeChannel(i) 也是這個順序）
    for name, props, _ in conns[2]:
        if name == 'C' and props[0] == b'OO':
            child, parent = props[1], props[2]
            if kind.get(child, ('',))[0] == 'Deformer' and kind[child][2] == 'BlendShapeChannel' and kind.get(parent, ('', '', ''))[2] == 'BlendShape':
                n = kind[child][1]
                out.append(n.split('.')[-1] if '.' in n else n)
    return out


if __name__ == '__main__':
    print(json.dumps(names(sys.argv[1]), ensure_ascii=False))
