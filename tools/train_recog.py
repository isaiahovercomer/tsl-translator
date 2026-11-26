#!/usr/bin/env python3
"""train_recog.py — 訓練手語單詞辨識模型（骨架 → 詞），跟現在的 DTW 比準確率，匯出 ONNX 給手機用。

輸入跟網頁一模一樣：每段手勢用 core.js 的 seqFeat 變成 16 格 × 86 維（tools/feats.py），
所以網站只要把現在送給 DTW 的那 16 格特徵改送給模型就好。

資料來源：
  dict     辭典單詞示範 corpus/signs/general（每詞約 1 支）
  sent     辭典例句 corpus/sent（tools/align_sent.py 自動切出的詞，比較像真的連續手語）
  collect  收集模式／改正上傳的真人資料（--collect 指到 collect 分支的 collect/ 資料夾）
  none     收集模式「自然動作（不是手語）」→ 類別 _none

切分：例句依句子分（測試句的詞不拿來訓練）；真人資料依「比的人」分（同一個人不會同時在訓練和測試）。
評估：同樣的訓練資料，DTW（網頁現在的做法：粗篩 60 個再 DTW）vs 模型，分「全部詞彙」和三個情境，top-1／top-3。

用法：
  python tools/train_recog.py --epochs 60 --out runs/v1                    # 這裡（CPU）也跑得動
  python tools/train_recog.py --collect /path/collect --epochs 120 --out runs/v2
"""
import argparse
import json
import math
import random
import re
import sys
import time
import zlib
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import feats as F  # noqa: E402

ROOT = F.ROOT
CORPUS = ROOT / 'corpus'
NONE = '_none'


# ---------- 情境詞（解析 js/scenes.js）----------
def scene_sets():
    js = (ROOT / 'js' / 'scenes.js').read_text('utf-8')
    core = set(re.search(r'export const CORE = `([^`]*)`', js).group(1).split())
    out = {}
    for k, name, words in re.findall(r"(\w+): \{ name: '([^']*)', short: '[^']*', words: `([^`]*)`", js):
        out[k] = (name, core | set(words.split()))
    return out


# ---------- 讀資料 ----------
def load_dict():
    ix = json.loads((CORPUS / 'index.json').read_text('utf-8'))
    out = []
    for e in ix['signs']:
        s = json.loads((CORPUS / e['file']).read_text('utf-8'))
        out.append({'fr': F.decode_frames(s['data'], s['frames']), 'word': e['word'], 'syn': e.get('syn', []),
                    'src': 'dict', 'group': 'ccu', 'id': e['id'], 'q': e.get('q', 1)})
    return out


def load_sent(max_d=2.5):
    """例句自動切出的詞：有辭典樣本、距離不太大的才用（太大多半是切錯）。訓練只用 ≤ TRAIN_D 的（split 裡篩）"""
    sx = CORPUS / 'sent' / 'index.json'
    if not sx.exists():
        return []
    out = []
    for e in json.loads(sx.read_text('utf-8'))['sents']:
        if not e.get('seg'):
            continue
        s = json.loads((CORPUS / e['file']).read_text('utf-8'))
        fr = F.decode_frames(s['data'], s['frames'])
        for i, (w, (a, b), d) in enumerate(zip(e['gloss'], e['seg'], e['d'])):
            if d is None or d > max_d:
                continue
            out.append({'fr': fr[a:b], 'word': w, 'src': 'sent', 'group': e['id'], 'id': f"{e['id']}-{i}", 'd': d})
    return out


def load_collect(path):
    """collect 分支：collect/<日期>/<代號>-<時間>.json"""
    out = []
    if not path:
        return out
    for f in sorted(Path(path).rglob('*.json')):
        if f.name == 'stats.json':
            continue
        try:
            j = json.loads(f.read_text('utf-8'))
        except Exception:
            continue
        for s in j.get('samples', []):
            if s.get('kind') == 'log' or not s.get('data'):
                continue
            fr = F.decode_frames(s['data'], s['frames'])
            signer = j.get('signer') or '?'
            if s.get('kind') == 'none' or s.get('word') == NONE:
                for k in range(0, max(1, len(fr) - 10), 12):   # 自然動作：切成 1～2 秒的小段
                    out.append({'fr': fr[k:k + random.randint(12, 30)], 'word': NONE, 'src': 'none', 'group': signer, 'id': f"{s.get('id')}-{k}"})
            elif s.get('kind') == 'word':
                out.append({'fr': fr, 'word': s['word'], 'src': 'correct' if s.get('src') == 'correct' else 'collect',
                            'group': signer, 'id': s.get('id'), 'hand': j.get('hand')})
            # kind 'sent'（整句）留給第二階段 CTC
    return out


def h01(s):
    return zlib.crc32(s.encode()) % 1000 / 1000


TRAIN_D = 1.2   # 例句切出的詞：跟辭典示範距離 ≤1.2 才拿來訓練（比較確定切對）；測試放寬，免得只測 DTW 本來就認得的


def split(data, test_frac=0.3):
    """例句依句子、真人依比的人分；辭典示範全部拿來訓練（每詞只有一支）"""
    signers = sorted({d['group'] for d in data if d['src'] in ('collect', 'correct', 'none')})
    test_signers = set(signers[::4]) if len(signers) >= 3 else set()   # 每 4 個人留 1 個測試
    tr, te = [], []
    for d in data:
        if d['src'] == 'dict':
            tr.append(d)
        elif d['src'] == 'sent':
            if h01(d['group']) < test_frac:
                te.append(d)
            elif d['d'] <= TRAIN_D:
                tr.append(d)
        else:
            (te if d['group'] in test_signers else tr).append(d)
    return tr, te


# ---------- 資料增強（在骨架上做，再算特徵）----------
PAIRS = [(1, 2), (3, 4), (5, 6), (7, 8), (9, 10), (11, 12), (13, 14)]


def augment(fr, rng):
    fr = fr.copy()
    n = len(fr)
    # 時間：頭尾隨機裁一點、速度 0.7～1.4 倍
    if n > 8:
        a = rng.integers(0, max(1, int(n * 0.15)) + 1); b = n - rng.integers(0, max(1, int(n * 0.15)) + 1)
        fr = fr[a:max(b, a + 6)]
    sp = rng.uniform(0.7, 1.4)
    idx = np.clip(np.round(np.arange(0, len(fr), sp)).astype(int), 0, len(fr) - 1)
    fr = fr[idx]
    pts = fr.reshape(len(fr), F.P, 3)
    # 左右鏡像（慣用左手的人）
    if rng.random() < 0.25:
        pts[:, :, 0] = 1 - pts[:, :, 0]
        lh = pts[:, F.LH:F.LH + 21].copy(); pts[:, F.LH:F.LH + 21] = pts[:, F.RH:F.RH + 21]; pts[:, F.RH:F.RH + 21] = lh
        for i, j in PAIRS:
            t = pts[:, i].copy(); pts[:, i] = pts[:, j]; pts[:, j] = t
    # 整個人：小角度旋轉、縮放、平移（以兩肩中點為中心）
    c = np.nanmean(pts[:, [7, 8], :2].reshape(-1, 2), 0)
    if np.isnan(c).any():
        c = np.array([0.5, 0.45])
    th = rng.uniform(-0.17, 0.17); sc = rng.uniform(0.88, 1.12)
    R = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]]) * sc
    xy = pts[:, :, :2] - c
    pts[:, :, :2] = xy @ R.T + c + rng.normal(0, 0.02, 2)
    # 每隻手：手指相對手腕再轉一點、縮放（手型個人差異）
    for off in (F.LH, F.RH):
        th = rng.uniform(-0.15, 0.15); s = rng.uniform(0.9, 1.1)
        R = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]]) * s
        w = pts[:, off:off + 1, :2]
        pts[:, off:off + 21, :2] = (pts[:, off:off + 21, :2] - w) @ R.T + w
    # 雜訊
    pts[:, :, :2] += rng.normal(0, 0.004, pts[:, :, :2].shape)
    # 遮手：一隻手一小段時間沒偵測到（被切到、模糊）
    if rng.random() < 0.3 and len(pts) > 4:
        off = F.LH if rng.random() < 0.5 else F.RH
        a = rng.integers(0, len(pts)); L = rng.integers(1, max(2, len(pts) // 3))
        pts[a:a + L, off:off + 21] = np.nan
    if rng.random() < 0.3:   # 隨機掉幾格
        keep = rng.random(len(pts)) > 0.1
        if keep.sum() >= 4:
            pts = pts[keep]
    return pts.reshape(len(pts), -1)


def feat(fr):
    return F.seq_feat(fr).astype(np.float32)


# ---------- 模型 ----------
def build_model(n_cls, d=192, layers=2):
    import torch
    import torch.nn as nn

    class Block(nn.Module):
        def __init__(self):
            super().__init__()
            self.dw = nn.Conv1d(d, d, 5, padding=2, groups=d)
            self.n1 = nn.LayerNorm(d)
            self.ff = nn.Sequential(nn.Linear(d, d * 2), nn.GELU(), nn.Dropout(0.1), nn.Linear(d * 2, d))
            self.n2 = nn.LayerNorm(d)

        def forward(self, x):
            x = x + self.dw(self.n1(x).transpose(1, 2)).transpose(1, 2)
            return x + self.ff(self.n2(x))

    class Net(nn.Module):
        """16×86 → 卷積（短時間的手型變化）→ Transformer（整段順序）→ 詞"""
        def __init__(self):
            super().__init__()
            self.inp = nn.Sequential(nn.Linear(F.D, d), nn.LayerNorm(d))
            self.pos = nn.Parameter(torch.zeros(1, F.NSEQ, d))
            self.conv = nn.Sequential(Block(), Block())
            enc = nn.TransformerEncoderLayer(d, 4, d * 2, dropout=0.1, batch_first=True, norm_first=True, activation='gelu')
            self.tf = nn.TransformerEncoder(enc, layers, enable_nested_tensor=False)
            self.drop = nn.Dropout(0.3)
            self.head = nn.Linear(d * 2, n_cls)

        def forward(self, x):                   # x: (B,16,86)
            h = self.inp(x) + self.pos
            h = self.tf(self.conv(h))
            h = torch.cat([h.mean(1), h.amax(1)], -1)
            return self.head(self.drop(h))

    return Net()


# ---------- DTW（網頁現在的做法）----------
def dtw_rank(q, pool_feats, pool_words, allowed=None, pre=60):
    idx = np.arange(len(pool_words)) if allowed is None else np.where(allowed)[0]
    if not len(idx):
        return []
    P = pool_feats[idx]
    if len(idx) > pre * 1.5:                    # 粗篩：7 格的距離
        C = [0, 3, 5, 8, 10, 13, 15]
        co = ((P[:, C] - q[C]) ** 2).sum((1, 2))
        keep = np.argsort(co)[:pre]; idx, P = idx[keep], P[keep]
    d = F.dtw_batch(P, q)
    best = {}
    for i, x in zip(idx, d):
        w = pool_words[i]
        if w not in best or x < best[w]:
            best[w] = x
    return [w for w, _ in sorted(best.items(), key=lambda t: t[1])]


def evaluate(model, labels, tr, te, scenes, syn_of, device='cpu'):
    import torch
    lab = {w: i for i, w in enumerate(labels)}
    pool_feats = np.stack([feat(d['fr']) for d in tr])
    pool_words = [d['word'] for d in tr]
    te = [d for d in te if d['word'] in lab]
    Q = np.stack([feat(d['fr']) for d in te]) if te else np.zeros((0, F.NSEQ, F.D), np.float32)
    model.eval()
    with torch.no_grad():
        logits = torch.cat([model(torch.from_numpy(Q[i:i + 512]).to(device)).cpu() for i in range(0, len(Q), 512)]).numpy() if len(Q) else np.zeros((0, len(labels)))
    # 情境：詞或同義詞在集合裡（同 Recognizer.setFilter）
    def in_set(w, S):
        return w in S or any(x in S for x in syn_of.get(w, []))
    res = {}
    confused = {}
    for key, (name, S) in [('all', ('全部詞彙', None))] + list(scenes.items()):
        sel = [i for i, d in enumerate(te) if S is None or in_set(d['word'], S)]
        if not sel:
            continue
        allowed = None if S is None else np.array([in_set(w, S) for w in pool_words])
        mask = None if S is None else np.array([in_set(w, S) for w in labels])
        r = {'name': name, 'n': len(sel), 'vocab': len(labels) if S is None else int(mask.sum())}
        for who in ('dtw', 'model'):
            t1 = t3 = 0
            for i in sel:
                w = te[i]['word']
                if who == 'dtw':
                    top = dtw_rank(Q[i], pool_feats, pool_words, allowed)[:3]
                else:
                    lg = logits[i].copy()
                    if mask is not None:
                        lg[~mask] = -1e9
                    top = [labels[j] for j in np.argsort(-lg)[:3]]
                    if key == 'all' and top and top[0] != w:
                        confused[(w, top[0])] = confused.get((w, top[0]), 0) + 1
                t1 += bool(top) and top[0] == w; t3 += w in top
            r[who] = {'top1': round(t1 / len(sel), 3), 'top3': round(t3 / len(sel), 3)}
        res[key] = r
    res['confused'] = [[a, b, n] for (a, b), n in sorted(confused.items(), key=lambda t: -t[1])[:30]]
    by_src = {}
    for d in te:
        by_src[d['src']] = by_src.get(d['src'], 0) + 1
    return res, by_src


# ---------- 匯出 ----------
def export(model, labels, out, report):
    import torch
    out.mkdir(parents=True, exist_ok=True)
    model.eval().cpu()
    fp = out / 'tsl-recog.onnx'
    torch.onnx.export(model, torch.zeros(1, F.NSEQ, F.D), str(fp), input_names=['x'], output_names=['logits'],
                      dynamic_axes={'x': {0: 'b'}, 'logits': {0: 'b'}}, opset_version=17, dynamo=False)
    q = out / 'tsl-recog.int8.onnx'
    try:
        from onnxruntime.quantization import QuantType, quantize_dynamic
        quantize_dynamic(str(fp), str(q), weight_type=QuantType.QInt8)
    except Exception as e:
        print('int8 量化失敗（先用 fp32）：', e); q = fp
    # 檢查：onnxruntime 跑出來跟 PyTorch 一樣
    import onnxruntime as ort
    x = np.random.default_rng(0).normal(0, 1, (4, F.NSEQ, F.D)).astype(np.float32)
    a = model(torch.from_numpy(x)).detach().numpy()
    b = ort.InferenceSession(str(q)).run(None, {'x': x})[0]
    agree = float((a.argmax(1) == b.argmax(1)).mean())
    (out / 'labels.json').write_text(json.dumps(labels, ensure_ascii=False), 'utf-8')
    report['onnx'] = {'file': q.name, 'kb': round(q.stat().st_size / 1024), 'fp32_kb': round(fp.stat().st_size / 1024), 'top1_agree': agree}
    (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=1), 'utf-8')
    print(f'匯出 {q.name}（{report["onnx"]["kb"]} KB，跟 PyTorch 同答案 {agree:.0%}）')


def print_report(res, by_src):
    print('測試資料：', '、'.join(f'{k} {v} 筆' for k, v in by_src.items()))
    print(f'{"範圍":<12}{"筆數":>6}{"詞彙":>7}   DTW top1/top3   模型 top1/top3')
    for k, r in res.items():
        if k == 'confused':
            continue
        print(f'{r["name"]:<10}{r["n"]:>6}{r["vocab"]:>7}     {r["dtw"]["top1"]:.1%} / {r["dtw"]["top3"]:.1%}'
              f'     {r["model"]["top1"]:.1%} / {r["model"]["top3"]:.1%}')
    if res.get('confused'):
        print('模型最常認錯（正確 → 認成）：', '、'.join(f'{a}→{b}' + (f'×{n}' if n > 1 else '') for a, b, n in res['confused'][:15]))


# ---------- 主程式 ----------
def main():
    import torch
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='runs/v1')
    ap.add_argument('--collect', default='')
    ap.add_argument('--epochs', type=int, default=60)
    ap.add_argument('--batch', type=int, default=256)
    ap.add_argument('--lr', type=float, default=2e-3)
    ap.add_argument('--dim', type=int, default=192)
    ap.add_argument('--reps', type=int, default=0, help='每個 epoch 每筆資料重複幾次（0＝自動：資料少就多重複）')
    ap.add_argument('--no-sent', action='store_true', help='不用例句切出的詞訓練（比較用）')
    ap.add_argument('--seed', type=int, default=1)
    a = ap.parse_args()
    random.seed(a.seed); np.random.seed(a.seed); torch.manual_seed(a.seed)
    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    t0 = time.time()
    dic = load_dict(); sent = load_sent(); col = load_collect(a.collect)
    syn_of = {}
    for d in dic:
        syn_of.setdefault(d['word'], set()).update(d.get('syn', []))
    data = dic + sent + col
    tr, te = split(data)
    if a.no_sent:
        tr = [d for d in tr if d['src'] != 'sent']
    labels = sorted({d['word'] for d in tr})
    lab = {w: i for i, w in enumerate(labels)}
    print(f'資料：辭典 {len(dic)}、例句切詞 {len(sent)}、真人 {len(col)} → 訓練 {len(tr)}、測試 {len(te)}；{len(labels)} 個詞；{dev}；讀資料 {time.time() - t0:.0f} 秒', flush=True)

    reps = a.reps or max(1, round(12000 / len(tr)))
    model = build_model(len(labels), a.dim).to(dev)
    print(f'模型參數 {sum(p.numel() for p in model.parameters()) / 1e6:.2f}M；每個 epoch 每筆重複 {reps} 次', flush=True)

    class DS(torch.utils.data.Dataset):
        def __len__(self): return len(tr) * reps
        def __getitem__(self, i):
            d = tr[i % len(tr)]
            rng = np.random.default_rng((i * 7919 + int(time.time() * 1e6)) % 2 ** 32)
            return torch.from_numpy(feat(augment(d['fr'], rng))), lab[d['word']]

    dl = torch.utils.data.DataLoader(DS(), batch_size=a.batch, shuffle=True, num_workers=2, drop_last=True, persistent_workers=True)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.05)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, a.lr, total_steps=a.epochs * len(dl), pct_start=0.1)
    lossf = torch.nn.CrossEntropyLoss(label_smoothing=0.1)
    for ep in range(a.epochs):
        model.train(); tot = n = 0; t1 = time.time()
        for x, y in dl:
            x, y = x.to(dev), y.to(dev)
            if torch.rand(()) < 0.5:            # 特徵上再加一點雜訊
                x = x + torch.randn_like(x) * 0.03
            loss = lossf(model(x), y)
            opt.zero_grad(); loss.backward(); torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); opt.step(); sched.step()
            tot += loss.item() * len(y); n += len(y)
        if ep % 10 == 9 or ep == a.epochs - 1:
            print(f'epoch {ep + 1}/{a.epochs} loss {tot / n:.3f}（{time.time() - t1:.0f} 秒/epoch）', flush=True)

    res, by_src = evaluate(model, labels, tr, te, scene_sets(), syn_of, dev)
    print_report(res, by_src)
    report = {'version': Path(a.out).name, 'created': time.strftime('%Y-%m-%d %H:%M'), 'labels': len(labels),
              'train': {s: sum(d['src'] == s for d in tr) for s in ('dict', 'sent', 'collect', 'correct', 'none')},
              'test': by_src, 'eval': res, 'args': vars(a), 'feat': {'nseq': F.NSEQ, 'd': F.D}}
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), out / 'model.pt')
    export(model, labels, out, report)


if __name__ == '__main__':
    main()
