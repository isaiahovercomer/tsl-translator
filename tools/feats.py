"""feats.py — 辨識特徵（Python 版，跟 js/core.js 的 frameFeat／seqFeat／dtw 一模一樣）。

訓練模型、例句對齊都用這支，網頁在手機上算的特徵才會跟訓練時相同。
只需要 numpy。驗證：python tools/feats.py check（跟 corpus/feats.json 比）。
"""
import base64
import json
import sys
from pathlib import Path

import numpy as np

P, D, NSEQ, FQ = 82, 86, 16, 40
LH, RH = 15, 36
LSH, RSH = 7, 8
MISSING, SCALE = -32768, 8000
ROOT = Path(__file__).resolve().parent.parent


def decode_frames(data, n=None):
    """base64 Int16 → (n, 82*3) float32，缺的點是 NaN"""
    q = np.frombuffer(base64.b64decode(data), dtype='<i2').astype(np.float32)
    a = np.where(q == MISSING, np.nan, q / SCALE).astype(np.float32)
    return a.reshape(-1, P * 3)[:n] if n else a.reshape(-1, P * 3)


def body_refs(fr):
    """每格的身體基準 (cx, cy, w)；沒有肩膀的格是 NaN"""
    ls, rs = fr[:, LSH * 3:LSH * 3 + 2], fr[:, RSH * 3:RSH * 3 + 2]
    c = (ls + rs) / 2
    w = np.hypot(*(ls - rs).T)
    w = np.where(w > 0, w, 0.2)
    return np.c_[c, w]


def seq_ref(fr):
    r = body_refs(fr)
    ok = ~np.isnan(r[:, 0])
    return r[ok].mean(0) if ok.any() else np.array([0.5, 0.4, 0.25], np.float32)


def frame_feats(fr, ref=None):
    """(n, 246) 影格 → (n, 86) 特徵。ref=None 時用整段平均（同 seqFeat）。"""
    fr = np.asarray(fr, np.float32)
    if ref is None:
        ref = seq_ref(fr)
    cx, cy, w = ref
    out = np.zeros((len(fr), D), np.float32)
    for h, off in enumerate((LH, RH)):
        o = h * 43
        hand = fr[:, off * 3:(off + 21) * 3].reshape(-1, 21, 3)[:, :, :2]
        ok = ~np.isnan(hand[:, 0, 0])
        if not ok.any():
            continue
        wr = hand[:, 0]
        hs = np.hypot(*(hand[:, 9] - wr).T)
        hs = np.where(hs > 0, hs, 0.05)
        v = np.zeros((len(fr), 43), np.float32)
        v[:, 0] = 1.5
        v[:, 1] = (wr[:, 0] - cx) / w * 1.5
        v[:, 2] = (wr[:, 1] - cy) / w * 1.5
        v[:, 3:] = ((hand[:, 1:] - wr[:, None]) / hs[:, None, None] * 0.5).reshape(-1, 40)
        v = np.nan_to_num(v)
        out[ok, o:o + 43] = v[ok]
    return out


def resample(src, n=NSEQ):
    x = np.arange(n) * (len(src) - 1) / (n - 1)
    a = np.floor(x).astype(int)
    b = np.minimum(len(src) - 1, a + 1)
    t = (x - a)[:, None]
    return src[a] * (1 - t) + src[b] * t


def seq_feat_from_ff(ff):
    """已經算好的每格特徵 → 只留有手的格 → 16 格"""
    act = ff[(ff[:, 0] != 0) | (ff[:, 43] != 0)]
    return resample(act if len(act) >= 3 else ff)


def seq_feat(fr):
    return seq_feat_from_ff(frame_feats(fr))


def encode_feat(seq):
    return base64.b64encode(np.clip(np.round(seq * FQ), -127, 127).astype(np.int8).tobytes()).decode()


def decode_feat(s):
    return np.frombuffer(base64.b64decode(s), np.int8).astype(np.float32).reshape(NSEQ, D) / FQ


def dtw(A, B, band=4):
    """同 core.js dtw：歐氏距離、帶寬 4、除以 (n+m)"""
    n, m = len(A), len(B)
    C = np.sqrt(((A[:, None] - B[None]) ** 2).sum(-1))
    M = np.full((n + 1, m + 1), 1e9); M[0, 0] = 0
    for i in range(1, n + 1):
        for j in range(max(1, i - band), min(m, i + band) + 1):
            M[i, j] = C[i - 1, j - 1] + min(M[i - 1, j], M[i, j - 1], M[i - 1, j - 1])
    return M[n, m] / (n + m)


def dtw_batch(Q, T, band=4):
    """Q: (k,16,86) 多段、T: (16,86) 一個樣本 → (k,) 距離。向量化，對齊例句用。"""
    n = Q.shape[1]
    C = np.sqrt(((Q[:, :, None] - T[None, None]) ** 2).sum(-1))       # (k,n,n)
    M = np.full((len(Q), n + 1, n + 1), 1e9); M[:, 0, 0] = 0
    for i in range(1, n + 1):
        for j in range(max(1, i - band), min(n, i + band) + 1):
            M[:, i, j] = C[:, i - 1, j - 1] + np.minimum(np.minimum(M[:, i - 1, j], M[:, i, j - 1]), M[:, i - 1, j - 1])
    return M[:, n, n] / (2 * n)


def dtw_many(q, feats, band=4):
    """一段 (16,86) 對很多樣本 (k,16,86) → (k,) 距離（評估 DTW 用）"""
    return dtw_batch(feats, q, band)


def check(k=40):
    """跟 build_feats.mjs 算的 corpus/feats.json 比，確定 Python 版一樣"""
    ix = json.loads((ROOT / 'corpus/index.json').read_text('utf-8'))
    js = json.loads((ROOT / 'corpus/feats.json').read_text('utf-8'))
    bad = 0
    for e in ix['signs'][:k]:
        s = json.loads((ROOT / 'corpus' / e['file']).read_text('utf-8'))
        mine = encode_feat(seq_feat(decode_frames(s['data'], s['frames'])))
        a = np.frombuffer(base64.b64decode(mine), np.int8).astype(int)
        b = np.frombuffer(base64.b64decode(js[e['id']]), np.int8).astype(int)
        if np.abs(a - b).max() > 1:
            bad += 1; print('不同', e['id'], np.abs(a - b).max())
    q = decode_feat(js[ix['signs'][0]['id']])
    print(f'{k} 筆，不一樣 {bad} 筆；dtw 自己={dtw(q, q):.3f}，batch={dtw_batch(q[None], q)[0]:.3f}')


if __name__ == '__main__':
    if sys.argv[1:] == ['check']:
        check()
