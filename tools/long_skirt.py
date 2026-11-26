"""把 VRoid 模型的短裙拉長成長裙（直接改 .vrm 檔裡的頂點）
python3 tools/long_skirt.py avatars/vrm-f1.vrm [裙襬高度=0.15]
做法：Bottoms 材質用到的頂點，腰帶（pivot 以上）不動，以下依高度等比例往下拉到指定裙襬高度，下襬稍微外擴避免腳穿出來。"""
import json, struct, sys, numpy as np
path = sys.argv[1]; HEM = float(sys.argv[2]) if len(sys.argv) > 2 else 0.15
b = bytearray(open(path, 'rb').read())
ln = struct.unpack('<I', b[12:16])[0]; j = json.loads(b[20:20 + ln]); binoff = 20 + ln + 8
DT = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}; NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}
def view(i):
    a = j['accessors'][i]; bv = j['bufferViews'][a['bufferView']]; n = NC[a['type']]; dt = DT[a['componentType']]
    assert not bv.get('byteStride') or bv['byteStride'] == np.dtype(dt).itemsize * n
    off = binoff + bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    arr = np.frombuffer(b, dtype=dt, count=a['count'] * n, offset=off)
    return arr.reshape(a['count'], n) if n > 1 else arr
mats = [m['name'] for m in j['materials']]
done = 0
for mesh in j['meshes']:
    for p in mesh['primitives']:
        if 'Bottoms' not in mats[p['material']]: continue
        pa = p['attributes']['POSITION']; pos = view(pa).copy(); idx = np.unique(view(p['indices']))
        others = set()
        for q in mesh['primitives']:
            if q is not p and q['attributes']['POSITION'] == pa: others |= set(np.unique(view(q['indices'])).tolist())
        v = pos[idx]; top, low = v[:, 1].max(), v[:, 1].min()
        pivot = top - (top - low) * 0.25                     # 上面 1/4（腰帶、腰部）不動
        k = (pivot - HEM) / (pivot - low)
        cx, cz = v[:, 0].mean(), v[:, 2].mean()
        for i in idx:
            if i in others: continue                        # 跟身體共用的頂點不動
            x, y, z = pos[i]
            if y >= pivot: continue
            t = (pivot - y) / (pivot - low)                 # 0（pivot）→ 1（原本裙襬）
            pos[i, 1] = pivot - (pivot - y) * k
            f = 1 + 0.22 * t                                # 越下面越外擴一點（最多 22%）
            pos[i, 0] = cx + (x - cx) * f; pos[i, 2] = cz + (z - cz) * f
        a = j['accessors'][pa]; bv = j['bufferViews'][a['bufferView']]
        off = binoff + bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        b[off:off + pos.nbytes] = pos.astype(np.float32).tobytes()
        a['min'] = pos.min(0).tolist(); a['max'] = pos.max(0).tolist()
        print(f'{mesh["name"]}: 裙子 {len(idx)} 個頂點，裙襬 {low:.3f} → {HEM:.3f}（pivot {pivot:.3f}，拉長 {k:.2f} 倍）')
        done += 1
assert done, '找不到 Bottoms 材質'
# 寫回 JSON（長度要 4 的倍數）
js = json.dumps(j, ensure_ascii=False, separators=(',', ':')).encode()
js += b' ' * ((4 - len(js) % 4) % 4)
out = b[:12] + struct.pack('<I', len(js)) + b'JSON' + js + b[20 + ln:]
struct.pack_into('<I', out, 8, len(out))
open(path, 'wb').write(out)
