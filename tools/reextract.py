#!/usr/bin/env python3
"""reextract.py — 用更準的模型重抽中正辭典語料（Colab GPU 跑；筆記本 colab/tsl_reextract.ipynb）。

改進（跟 GitHub Actions 的 ingest.py 比）：
  - 手：WiLoR（3D 手部模型，WiLoR-mini 套件）取代 MediaPipe 的手——握拳、手指互擋、手指朝鏡頭時深度準很多。
        格式不變（21 點 x, y, z；x、y 是畫面正規化座標，z 是相對手腕、跟 x 同單位），網站和辨識都不用改。
        WiLoR 沒找到的手保留 MediaPipe 的。
  - 臉：MediaPipe FaceLandmarker 的 52 個表情係數（ARKit blendshapes）存成 `fbs`，手譯員直接用來做表情。

用法：
  python tools/reextract.py run --out /content/drive/MyDrive/tsl-reextract [--limit 50] [--ids ccu1,ccu15] [--no-wilor]
  python tools/reextract.py compare --out ... --ids ccu2224   # 印出 MediaPipe vs WiLoR 每根手指彎曲角度
  python tools/reextract.py merge --out ...                   # 把結果複製進 corpus/（之後跑 node tools/build_feats.mjs）
順序：先做 js/scenes.js 情境詞（寒暄／聚會／召會）＋同義詞，再做其他詞。已經做過的（out 裡有檔案）自動跳過，可以分好幾次跑。
"""
import argparse, base64, json, math, re, shutil, sys, tempfile, time, urllib.request
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ingest  # noqa: E402
import ccu_dict  # noqa: E402

ROOT = ingest.ROOT
VER = 'wilor1'


# ---------- 順序：情境詞優先 ----------
def scene_words():
    js = (ROOT / 'js' / 'scenes.js').read_text('utf-8')
    words = set()
    for m in re.finditer(r'`([^`]*)`', js):
        words |= set(m.group(1).split())
    return words


def ordered_items(ids=None):
    items = json.loads((ccu_dict.DICT / 'ccu-list.json').read_text('utf-8'))
    ix = {e['id']: e for e in ingest.load_index()['signs']}
    if ids:
        want = set(ids)
        return [it for it in items if f"ccu{it['id']}" in want]
    sw = scene_words()
    def pri(it):
        e = ix.get(f"ccu{it['id']}", {})
        ws = {e.get('word', ccu_dict.base_word(it['name']))} | set(e.get('syn', []))
        return (0 if ws & sw else 1, it['id'])
    return sorted(items, key=pri)


# ---------- WiLoR ----------
class _P:
    __slots__ = ('x', 'y', 'z')
    def __init__(self, x, y, z): self.x, self.y, self.z = float(x), float(y), float(z)


def make_wilor():
    import torch
    from wilor_mini.pipelines.wilor_hand_pose3d_estimation_pipeline import WiLorHandPose3dEstimationPipeline
    dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    dt = torch.float16 if dev.type == 'cuda' else torch.float32
    try:
        pipe = WiLorHandPose3dEstimationPipeline(device=dev, dtype=dt, verbose=False)
    except TypeError:
        pipe = WiLorHandPose3dEstimationPipeline(device=dev, dtype=dt)

    def arr(x):
        if hasattr(x, 'detach'):
            x = x.detach().float().cpu().numpy()
        return np.asarray(x, dtype=np.float64)

    def run(rgb):
        H, W = rgb.shape[:2]
        hands = []
        for o in pipe.predict(rgb):
            p = o.get('wilor_preds', o)
            k3 = arr(p['pred_keypoints_3d']).reshape(-1, 21, 3)[0]
            t = arr(p['pred_cam_t_full']).reshape(-1, 3)[0]
            fl = float(arr(p['scaled_focal_length']).reshape(-1)[0])
            box = arr(o.get('hand_bbox', [0, 0, W, H])).reshape(-1)[:4]
            k2 = pick_2d(p, k3, t, fl, W, H, box)
            if k2 is None:
                continue
            Z = k3[:, 2] + t[2]
            z = (Z - Z[0]) * fl / max(Z[0], 1e-6) / W      # 相對手腕的深度，換成跟 x 一樣的單位（MediaPipe 的慣例）
            hands.append([_P(k2[j, 0] / W, k2[j, 1] / H, z[j]) for j in range(21)])
        return hands
    return run


def pick_2d(p, k3, t, fl, W, H, box):
    """WiLoR 的 2D 點：用 pred_keypoints_2d（整張畫面像素）；格式不對就自己投影（左手 x 可能要翻），挑落在手框裡的。"""
    bx0, by0, bx1, by1 = box; bw, bh = bx1 - bx0, by1 - by0
    def inside(k):
        return np.mean((k[:, 0] > bx0 - bw * .3) & (k[:, 0] < bx1 + bw * .3) & (k[:, 1] > by0 - bh * .3) & (k[:, 1] < by1 + bh * .3))
    cands = []
    if 'pred_keypoints_2d' in p:
        k = np.asarray(p['pred_keypoints_2d'].detach().float().cpu().numpy() if hasattr(p['pred_keypoints_2d'], 'detach') else p['pred_keypoints_2d'], dtype=np.float64).reshape(-1, 21, 2)[0]
        cands.append(k)
    for sx in (1, -1):
        X, Y, Z = k3[:, 0] * sx + t[0], k3[:, 1] + t[1], k3[:, 2] + t[2]
        cands.append(np.stack([fl * X / Z + W / 2, fl * Y / Z + H / 2], 1))
    best = max(cands, key=inside)
    return best if inside(best) >= 0.6 else None


def put_hands(f, pose_f, hands):
    """WiLoR 的手依「離哪個手腕近」放到左／右手（跟 ingest.to_frame 一樣）；沒找到的那隻保留原本的。"""
    L = (f[(ingest.POSE_IDX.index(15)) * 3], f[(ingest.POSE_IDX.index(15)) * 3 + 1])
    R = (f[(ingest.POSE_IDX.index(16)) * 3], f[(ingest.POSE_IDX.index(16)) * 3 + 1])
    if np.isnan(L[0]) or np.isnan(R[0]) or not hands:
        return 0
    score = lambda h: math.dist((h[0].x, h[0].y), L) - math.dist((h[0].x, h[0].y), R)
    hands = hands[:2]
    if len(hands) == 2:
        a, b = hands
        lh, rh = (a, b) if score(a) < score(b) else (b, a)
        ingest.put_hand(f, ingest.OFF_LH, lh); ingest.put_hand(f, ingest.OFF_RH, rh)
    else:
        ingest.put_hand(f, ingest.OFF_LH if score(hands[0]) < 0 else ingest.OFF_RH, hands[0])
    return len(hands)


def encode_bs(bs):
    """每格 52 個係數 → 0~255 一個 byte；沒有臉的格第 0 個（_neutral）存 255 當記號。"""
    n = 52; a = np.zeros((len(bs), n), np.uint8)
    for i, b in enumerate(bs):
        if b is None or len(b) < n:
            a[i, 0] = 255
        else:
            a[i] = np.clip(np.round(np.asarray(b[:n]) * 254), 0, 254)
    return base64.b64encode(a.tobytes()).decode()


# ---------- 一個詞條 ----------
def one(it, wilor, tmp):
    vp = tmp / 'v.mp4'
    urllib.request.urlretrieve(ccu_dict.BASE + it['video'], vp)
    found = {}
    def hook(rgb, k):
        if wilor:
            found[k] = wilor(rgb)
    frames = ingest.extract(vp, progress=False, on_image=hook, blendshapes=True, raw=True)
    bs = ingest.extract.blendshapes; aspect = ingest.extract.aspect
    vp.unlink(missing_ok=True)       # 影片不保存
    mp_hands = sum(1 for f in frames if not np.isnan(f[ingest.OFF_LH * 3]) or not np.isnan(f[ingest.OFF_RH * 3]))
    wl = 0
    for k, hs in found.items():
        wl += 1 if put_hands(frames[k], None, hs) else 0
    frames = ingest.fill_gaps(frames)
    hands = sum(1 for f in frames if not np.isnan(f[ingest.OFF_LH * 3]) or not np.isnan(f[ingest.OFF_RH * 3]))
    return frames, bs, aspect, {'mp': mp_hands, 'wilor': wl, 'hands': hands, 'n': len(frames)}


def cmd_run(out, limit, ids, use_wilor):
    out = Path(out); (out / 'signs' / 'general').mkdir(parents=True, exist_ok=True)
    log = out / 'log.jsonl'
    wilor = make_wilor() if use_wilor else None
    tmp = Path(tempfile.mkdtemp()); done = 0; t0 = time.time()
    items = ordered_items(ids)
    todo = [it for it in items if ids or not (out / 'signs' / 'general' / f"ccu{it['id']}.json").exists()]
    print(f'共 {len(items)} 個詞條，還沒做 {len(todo)} 個', flush=True)
    for it in todo:
        if limit and done >= limit:
            break
        sid = f"ccu{it['id']}"
        old_f = ingest.CORPUS / 'signs' / 'general' / f'{sid}.json'
        try:
            frames, bs, aspect, st = one(it, wilor, tmp)
            old = json.loads(old_f.read_text('utf-8')) if old_f.exists() else {
                'v': 1, 'id': sid, 'word': ccu_dict.base_word(it['name']), 'cat': 'general', 'src': f"ccu:{it['id']}"}
            s = {**old, 'fps': ingest.FPS, 'frames': len(frames), 'P': ingest.P, 'data': ingest.encode(frames),
                 'aspect': aspect, 'fbs': encode_bs(bs), 'x': VER if wilor else 'mp-fbs', 'reextracted': ingest.now()}
            (out / 'signs' / 'general' / f'{sid}.json').write_text(json.dumps(s, ensure_ascii=False), 'utf-8')
            st.update(id=sid, name=it['name'], q=round(st['hands'] / max(1, st['n']), 2))
            with log.open('a', encoding='utf-8') as fh:
                fh.write(json.dumps(st, ensure_ascii=False) + '\n')
            done += 1
            el = time.time() - t0
            print(f"[{done}] {it['name']}  {st['n']} 格：MediaPipe 手 {st['mp']}、WiLoR 手 {st['wilor']}  （平均 {el / done:.1f} 秒/詞）", flush=True)
        except Exception as e:
            print(f"{it['name']} 失敗：{e}", flush=True)
    shutil.rmtree(tmp, ignore_errors=True)
    print(f'這次完成 {done} 個', flush=True)


# ---------- 比較：每根手指彎曲角度 ----------
def finger_angles(f, off):
    if np.isnan(f[off * 3]):
        return None
    P = lambda j: np.array(f[(off + j) * 3:(off + j) * 3 + 3], dtype=np.float64)
    out = []
    for m, tip in ((1, 4), (5, 8), (9, 12), (13, 16), (17, 20)):
        u, v = P(m) - P(0), P(tip) - P(m)
        out.append(round(math.degrees(math.acos(np.clip(u @ v / (np.linalg.norm(u) * np.linalg.norm(v) + 1e-9), -1, 1)))))
    return out


def cmd_compare(out, ids):
    for sid in ids:
        a = json.loads((ingest.CORPUS / 'signs' / 'general' / f'{sid}.json').read_text('utf-8'))
        b = json.loads((Path(out) / 'signs' / 'general' / f'{sid}.json').read_text('utf-8'))
        fa, fb = ingest.decode(a['data'], a['frames']), ingest.decode(b['data'], b['frames'])
        print(f"{a['word']}（{sid}）每根手指彎曲角度 拇/食/中/無名/小，右手；MediaPipe → WiLoR")
        for k in range(0, min(len(fa), len(fb)), 3):
            x, y = finger_angles(fa[k], ingest.OFF_RH), finger_angles(fb[k], ingest.OFF_RH)
            if x or y:
                print(f'  格 {k:3d}: {x}  →  {y}')


def cmd_merge(out):
    src = Path(out) / 'signs' / 'general'
    ix = ingest.load_index(); by = {e['id']: e for e in ix['signs']}
    stats = {}
    for line in (Path(out) / 'log.jsonl').read_text('utf-8').splitlines():
        try:
            d = json.loads(line); stats[d['id']] = d
        except Exception:
            pass
    n = 0
    for f in sorted(src.glob('*.json')):
        dst = ingest.CORPUS / 'signs' / 'general' / f.name
        shutil.copyfile(f, dst); n += 1
        e = by.get(f.stem)
        if e and f.stem in stats:
            e['q'] = stats[f.stem]['q']
    ingest.save_index(ix)
    print(f'合併 {n} 個；接著跑 node tools/build_feats.mjs 重算辨識特徵')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['run', 'compare', 'merge'])
    ap.add_argument('--out', required=True)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--ids', default='')
    ap.add_argument('--no-wilor', action='store_true')
    a = ap.parse_args()
    ids = [x.strip() for x in a.ids.split(',') if x.strip()]
    if a.cmd == 'run':
        cmd_run(a.out, a.limit, ids, not a.no_wilor)
    elif a.cmd == 'compare':
        cmd_compare(a.out, ids)
    else:
        cmd_merge(a.out)
