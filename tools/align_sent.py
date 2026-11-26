#!/usr/bin/env python3
"""align_sent.py — 辭典例句（整句手語影片的骨架）照 gloss 詞序自動切出每個詞的位置。

做法（已知詞序的強制對齊）：每個 gloss 詞拿辭典單詞示範當樣本，所有可能的片段 [a, b) 都算 DTW 距離，
動態規劃找「詞照順序、中間可以有短暫過渡」總距離最小的切法。辭典沒有的詞（指示詞、變體）也佔一段，但不算距離。
結果寫回 corpus/sent/index.json 每句的 seg（[開始格, 結束格]）和 d（距離，越小越像；沒樣本＝null）。

用法：
  python tools/align_sent.py                 # 對齊全部例句
  python tools/align_sent.py --test 40       # 用單詞示範接成假句子，量切點誤差（不用真例句）
"""
import argparse
import json
import random
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import feats as F  # noqa: E402

ROOT = F.ROOT
CORPUS = ROOT / 'corpus'
LMIN, LMAX = 4, 40            # 一個詞最短 4 格、最長 40 格（15 格/秒）
GAP, GAP_COST = 15, 0.04      # 詞和詞之間最多 15 格過渡，每格成本
UNKNOWN = 1.25                # 辭典沒有的詞：當作這個距離


def load_templates():
    """變體名稱（我_B）→ 特徵、基本詞（我）→ 特徵列表"""
    ix = json.loads((CORPUS / 'index.json').read_text('utf-8'))
    fj = json.loads((CORPUS / 'feats.json').read_text('utf-8'))
    by_var, by_word = {}, {}
    for e in ix['signs']:
        if e['id'] not in fj or not e['id'].startswith('ccu'):
            continue
        f = F.decode_feat(fj[e['id']])
        by_var.setdefault(e.get('variant') or e['word'], []).append(f)
        for w in [e['word']] + e.get('syn', []):
            by_word.setdefault(w, []).append(f)
    return by_var, by_word


def templates_for(var, word, by_var, by_word):
    return by_var.get(var) or by_word.get(word) or []


def segments(ff, n):
    """所有候選片段 (a, L) 和它們的 16 格特徵"""
    idx, Q = [], []
    for a in range(n):
        for L in range(LMIN, min(LMAX, n - a) + 1):
            idx.append((a, L)); Q.append(F.seq_feat_from_ff(ff[a:a + L]))
    return idx, np.asarray(Q, np.float32)


def seg_costs(Q, T):
    """每個片段對這個詞所有樣本的最小 DTW 距離（分批算，省記憶體）"""
    out = np.full(len(Q), np.inf, np.float32)
    for t in T:
        for s in range(0, len(Q), 400):
            out[s:s + 400] = np.minimum(out[s:s + 400], F.dtw_batch(Q[s:s + 400], t))
    return out


def align(frames, words, tmpls):
    """frames: (n,246)；words: gloss 詞；tmpls: 每個詞的樣本列表（可空）→ (seg, d)"""
    n, k = len(frames), len(words)
    if n < LMIN * k:
        return None, None
    ff = F.frame_feats(frames)
    idx, Q = segments(ff, n)
    A = np.array([a for a, _ in idx]); L = np.array([l for _, l in idx])
    cache = {}
    INF = 1e9
    prev = np.zeros(n + 1)                       # 第 0 個詞之前：開頭空白不算成本
    back = []
    for i, w in enumerate(words):
        key = id(tmpls[i]) if tmpls[i] else None
        if key not in cache:
            cache[key] = seg_costs(Q, tmpls[i]) if tmpls[i] else np.full(len(Q), UNKNOWN, np.float32)
        c = cache[key]
        if i == 0:
            P = prev.copy(); Pfrom = np.arange(n + 1)
        else:                                    # 上一個詞結束在 e，這個詞從 a 開始，中間過渡 a-e 格
            P = np.full(n + 1, INF); Pfrom = np.zeros(n + 1, int)
            for g in range(GAP + 1):
                cand = np.full(n + 1, INF); cand[g:] = prev[:n + 1 - g] + g * GAP_COST
                better = cand < P; P[better] = cand[better]; Pfrom[better] = (np.arange(n + 1) - g)[better]
        S = np.full(n + 1, INF); arg = np.full(n + 1, -1)
        tot = P[A] + c
        for j in np.argsort(tot)[::-1]:          # 依結束位置取最小（反向排序讓小的最後寫入）
            e = A[j] + L[j]
            if tot[j] < S[e]:
                S[e] = tot[j]; arg[e] = j
        back.append((arg, Pfrom, c))
        prev = S
    if not np.isfinite(prev).any() or prev.min() >= INF:
        return None, None
    e = int(np.argmin(prev))                     # 結尾空白不算成本
    seg, d = [], []
    for i in range(k - 1, -1, -1):
        arg, Pfrom, c = back[i]
        j = arg[e]
        a, l = int(A[j]), int(L[j])
        seg.append([a, a + l]); d.append(None if not tmpls[i] else round(float(c[j]), 3))
        e = int(Pfrom[a])
    return seg[::-1], d[::-1]


def run_all():
    sx = CORPUS / 'sent' / 'index.json'
    ix = json.loads(sx.read_text('utf-8'))
    by_var, by_word = load_templates()
    ok = 0; ds = []
    for n, e in enumerate(ix['sents']):
        s = json.loads((CORPUS / e['file']).read_text('utf-8'))
        fr = F.decode_frames(s['data'], s['frames'])
        tm = [templates_for(v, w, by_var, by_word) for v, w in zip(e['gv'], e['gloss'])]
        seg, d = align(fr, e['gloss'], tm)
        e['seg'], e['d'] = seg, d
        if seg:
            ok += 1; ds += [x for x in d if x is not None]
        if (n + 1) % 50 == 0:
            print(f'  {n + 1}/{len(ix["sents"])}', flush=True)
    sx.write_text(json.dumps(ix, ensure_ascii=False, indent=0), 'utf-8')
    print(f'對齊 {ok}/{len(ix["sents"])} 句；有樣本的詞距離中位數 {np.median(ds):.2f}' if ds else f'對齊 {ok} 句')


def test(nsent, seed=1):
    """單詞示範接成假句子（中間 0~6 格手放下的過渡），看切點誤差多少格"""
    rnd = random.Random(seed)
    ix = json.loads((CORPUS / 'index.json').read_text('utf-8'))
    by_var, by_word = load_templates()
    pool = [e for e in ix['signs'] if e['id'].startswith('ccu') and e.get('q', 1) >= 0.5]
    errs, exact = [], 0
    for _ in range(nsent):
        es = rnd.sample(pool, rnd.randint(3, 6))
        parts, truth, t = [], [], 0
        for e in es:
            s = json.loads((CORPUS / e['file']).read_text('utf-8'))
            fr = F.decode_frames(s['data'], s['frames'])
            act = np.where((F.frame_feats(fr)[:, [0, 43]] != 0).any(1))[0]
            if len(act) >= 3:
                fr = fr[act[0]:act[-1] + 1]
            sp = rnd.uniform(0.75, 1.3)          # 速度變化
            ii = np.clip(np.round(np.arange(0, len(fr), sp)).astype(int), 0, len(fr) - 1)
            fr = fr[ii]
            g = rnd.randint(0, 6)
            if parts and g:
                parts.append(np.repeat(parts[-1][-1:], g, 0)); t += g
            truth.append([t, t + len(fr)]); parts.append(fr); t += len(fr)
        frames = np.concatenate(parts)
        tm = [templates_for(e.get('variant'), e['word'], by_var, by_word) for e in es]
        seg, _ = align(frames, [e['word'] for e in es], tm)
        if not seg:
            continue
        er = [abs(a - x) + abs(b - y) for (a, b), (x, y) in zip(seg, truth)]
        errs += er; exact += all(x <= 6 for x in er)
    print(f'{nsent} 句：每個詞兩端誤差合計 平均 {np.mean(errs):.1f} 格、中位數 {np.median(errs):.0f} 格；'
          f'整句每個詞都在 6 格內 {exact}/{nsent}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--test', type=int, default=0)
    a = ap.parse_args()
    test(a.test) if a.test else run_all()
