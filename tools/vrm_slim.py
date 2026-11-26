#!/usr/bin/env python3
"""vrm_slim.py — 把 VRM（glb）的貼圖縮小、重新壓縮，手機才載得動；VRM 的骨頭、表情、MToon 設定原封不動。

用法：python tools/vrm_slim.py 輸入.vrm 輸出.vrm [--max 1024] [--small 512]
  --max   臉、身體、衣服貼圖的最大邊長（預設 1024）
  --small 頭髮、法線、MatCap 等次要貼圖的最大邊長（預設 512）
沒有透明的貼圖改存 JPEG，有透明的維持 PNG（量化成 256 色以內再壓）。
"""
import argparse, io, json, struct
from PIL import Image


def read_glb(path):
    b = open(path, 'rb').read()
    assert b[:4] == b'glTF', '不是 glb／vrm 檔'
    off, js, binc = 12, None, b''
    while off < len(b):
        n, t = struct.unpack('<II', b[off:off + 8]); c = b[off + 8:off + 8 + n]
        if t == 0x4E4F534A: js = json.loads(c)
        elif t == 0x004E4942: binc = c
        off += 8 + n
    return js, binc


def write_glb(path, js, binc):
    j = json.dumps(js, ensure_ascii=False, separators=(',', ':')).encode()
    j += b' ' * (-len(j) % 4); binc += b'\0' * (-len(binc) % 4)
    total = 12 + 8 + len(j) + 8 + len(binc)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(j), 0x4E4F534A)); f.write(j)
        f.write(struct.pack('<II', len(binc), 0x004E4942)); f.write(binc)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('dst')
    ap.add_argument('--max', type=int, default=1024); ap.add_argument('--small', type=int, default=512)
    a = ap.parse_args()
    js, binc = read_glb(a.src)
    views = js['bufferViews']
    # 哪些圖是次要的（頭髮、法線、MatCap、邊緣光）：看材質名稱與用途
    minor = set()
    for m in js.get('materials', []):
        nm = (m.get('name') or '').lower()
        for k in ('normalTexture', 'occlusionTexture', 'emissiveTexture'):
            if k in m: minor.add(js['textures'][m[k]['index']]['source'])
        if 'hair' in nm:
            t = (m.get('pbrMetallicRoughness') or {}).get('baseColorTexture')
            if t: minor.add(js['textures'][t['index']]['source'])
    vrm0 = (js.get('extensions') or {}).get('VRM', {})
    for mp in vrm0.get('materialProperties', []):
        for k, ti in (mp.get('textureProperties') or {}).items():
            if k in ('_BumpMap', '_SphereAdd', '_RimTexture', '_OutlineWidthTexture', '_UvAnimMaskTexture', '_ShadeTexture') or 'hair' in (mp.get('name') or '').lower():
                minor.add(js['textures'][ti]['source'] if ti < len(js['textures']) else ti)
    new_data = {}
    for i, im in enumerate(js.get('images', [])):
        if 'bufferView' not in im: continue
        v = views[im['bufferView']]
        raw = binc[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']]
        img = Image.open(io.BytesIO(raw)); img.load()
        lim = a.small if i in minor else a.max
        if max(img.size) > lim:
            k = lim / max(img.size); img = img.resize((max(1, round(img.width * k)), max(1, round(img.height * k))), Image.LANCZOS)
        has_alpha = img.mode in ('RGBA', 'LA', 'P') and img.convert('RGBA').getchannel('A').getextrema()[0] < 250
        out = io.BytesIO()
        if has_alpha: img.convert('RGBA').save(out, 'PNG', optimize=True); mime = 'image/png'
        else: img.convert('RGB').save(out, 'JPEG', quality=86, optimize=True); mime = 'image/jpeg'
        data = out.getvalue()
        if len(data) < len(raw): new_data[im['bufferView']] = data; im['mimeType'] = mime
    # 重排 BIN：每個 bufferView 4 位元組對齊
    out = bytearray()
    for vi, v in enumerate(views):
        data = new_data.get(vi)
        if data is None:
            data = binc[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']]
        out += b'\0' * (-len(out) % 4)
        v['byteOffset'] = len(out); v['byteLength'] = len(data); out += data
    js['buffers'][0]['byteLength'] = len(out)
    write_glb(a.dst, js, bytes(out))
    import os
    print(f'{a.src}：{os.path.getsize(a.src) / 1e6:.1f} MB → {os.path.getsize(a.dst) / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
