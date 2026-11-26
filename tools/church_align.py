#!/usr/bin/env python3
"""church_align.py — 江啟禎弟兄的手語影片：自動切出一個一個詞、對上字幕，做成「召會生活用語」預標。

影片先用 tools/yt_batch.py 匯入成 corpus/raw/church/<影片>.json（整段骨架＋ subs 字幕時間軸，影片不存）。
這支做三件事：

  1. 每句字幕 → 一個「時間窗」（字幕出現前後各留一點，手語通常比字幕慢一點）。
  2. 找詞（跨影片、弱監督）：同一個召會用語（例如「弟兄」）出現在很多句字幕裡，
     手語的那個詞就應該出現在這些句子的時間窗裡、而且彼此很像；沒有這個詞的句子裡不該有。
     → 每個時間窗列出所有可能的片段，找「在有這個詞的句子裡幾乎都找得到相似片段、在沒有的句子裡找不到」的那一段，
       再用它當樣本把每一句的那個詞切出來（DTW 微調切點），排出最像的前幾名。
     辭典已經有的詞用辭典示範直接找（當對照、也幫忙確認切點）。
  3. 輸出預標 corpus/church/：
       index.json             每個詞：幾句字幕有、找到幾段、信心、狀態
       cand/<詞>.json         前 12 名候選片段（骨架已切好、前後多留 6 格），網站「召會語料確認」頁用
     人工確認（網站上按 ✅／❌）之後，`python tools/church_align.py accept <確認檔>` 存成 corpus/signs/church/。

用法：
  python tools/church_align.py run                     # 全部影片、CHURCH_MISSING 的詞
  python tools/church_align.py run --terms 弟兄 召會     # 只做這幾個詞
  python tools/church_align.py test                    # 用辭典例句驗證（把某詞的示範藏起來，看找不找得回來）
  python tools/church_align.py accept labels.json      # 確認結果 → corpus/signs/church/
"""
import argparse
import base64
import json
import re
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import feats as F  # noqa: E402

ROOT = F.ROOT
CORPUS = ROOT / 'corpus'
OUT = CORPUS / 'church'
FPS = 15
PRE, POST = 1.0, 1.8          # 字幕窗：出現前 1 秒到消失後 1.8 秒（手語通常慢一點）
LENS = (8, 10, 12, 15, 18, 22, 26, 30)   # 候選片段長度（格）：0.5～2 秒
STEP = 2                      # 候選片段每 2 格一個
PAD = 12                      # 存候選片段時前後多留幾格（確認頁可以微調切點）
TOPK = 12                     # 每個詞存前幾名候選
MAXPOS, MAXNEG = 60, 60       # 找詞時最多用幾句有這個詞的、幾句沒有的


# ---------- 讀資料 ----------
def church_terms():
    """js/scenes.js 的 CHURCH_MISSING ＋ js/church.js 的 CHURCH_TERMS（照原本順序、去重）"""
    out = []
    for f, name in (('js/scenes.js', 'CHURCH_MISSING'), ('js/church.js', 'CHURCH_TERMS')):
        m = re.search(name + r'\s*=\s*`([^`]*)`', (ROOT / f).read_text('utf-8'))
        for w in (m.group(1).split() if m else []):
            if w not in out:
                out.append(w)
    return out


def load_videos(ids=None):
    """corpus/raw/church/*.json → [{id, title, frames (n,246), subs}]（沒有字幕的略過）"""
    vids = []
    for f in sorted((CORPUS / 'raw' / 'church').glob('*.json')):
        if ids and f.stem not in ids:
            continue
        r = json.loads(f.read_text('utf-8'))
        if not r.get('subs'):
            continue
        vids.append({'id': r['videoId'], 'title': r.get('title', ''), 'url': r.get('url', ''),
                     'frames': F.decode_frames(r['data'], r['frames']), 'subs': r['subs'], 'aspect': r.get('aspect')})
    return vids


def clean_text(t):
    t = re.sub(r'[\s　]', '', t)
    t = re.sub(r'[^一-鿿]', '', t)     # 只留中文字（經節號碼、標點不算）
    return t


def make_windows(vids):
    """每句字幕一個時間窗；同一句字幕連續出現（OCR 斷掉）會合併。"""
    W = []
    for vi, v in enumerate(vids):
        n = len(v['frames'])
        ref = F.seq_ref(v['frames'])                         # 整支影片一個身體基準（同一位示範者、同一個鏡位）
        ff = F.frame_feats(v['frames'], ref)
        for s0, s1, txt in v['subs']:
            txt = clean_text(txt)
            if len(txt) < 2:
                continue
            a, b = max(0, int((s0 - PRE) * FPS)), min(n, int((s1 + POST) * FPS))
            if b - a < 12:
                continue
            if W and W[-1]['vid'] == vi and W[-1]['text'] == txt and a - W[-1]['b'] < FPS:
                W[-1]['b'] = b; continue
            W.append({'vid': vi, 'a': a, 'b': b, 'text': txt, 'sub': [s0, s1]})
        v['ff'] = ff
    return W


# ---------- 候選片段 ----------
def active(ff):
    """有手、而且手腕在胸口附近以上（垂在腰下的手不算在比）"""
    lh = (ff[:, 0] != 0) & (ff[:, 2] < 1.6)
    rh = (ff[:, 43] != 0) & (ff[:, 45] < 1.6)
    return lh | rh


def candidates(ff, a, b, lens=LENS, step=STEP):
    """時間窗 [a,b) 裡所有片段 → (位置 [(開始,長度)], 特徵 (k,16,86))；手沒在比的片段不要"""
    act = active(ff)
    idx, Q = [], []
    for L in lens:
        for s in range(a, b - L + 1, step):
            if act[s:s + L].mean() < 0.7:
                continue
            idx.append((s, L)); Q.append(F.seq_feat_from_ff(ff[s:s + L]))
    if not Q:
        return [], np.zeros((0, F.NSEQ, F.D), np.float32)
    return idx, np.asarray(Q, np.float32)


def flat(Q):
    return Q.reshape(len(Q), -1) / np.sqrt(F.NSEQ)          # 歐氏距離 ≈ 每格平均距離（跟 DTW 同一個尺度）


def min_to_windows(X, groups):
    """X: (k,d) 候選；groups: 每個窗的候選 (m_j,d) → (k, 窗數) 每個候選到每個窗最近的距離"""
    out = np.full((len(X), len(groups)), np.inf, np.float32)
    x2 = (X ** 2).sum(1)
    for j, G in enumerate(groups):
        if not len(G):
            continue
        d2 = x2[:, None] + (G ** 2).sum(1)[None] - 2 * X @ G.T
        out[:, j] = np.sqrt(np.maximum(d2.min(1), 0))
    return out


def robust(M, frac):
    """每列取最小的 frac 比例的平均（有些句子示範者可能沒比這個詞、或比法不同）"""
    k = max(1, int(round(M.shape[1] * frac)))
    return np.sort(M, 1)[:, :k].mean(1)


# ---------- 找詞（跨句子的共同片段） ----------
def discover(pos, neg, frac=0.6, seed_per_win=40, log=None):
    """pos / neg：[(idx, Q)] 每個時間窗的候選。回傳 (樣本 16×86, 每個 pos 窗的 (片段索引, 距離), 分數)。"""
    PF = [flat(Q) for _, Q in pos]
    NF = [flat(Q) for _, Q in neg]
    # 每個窗先挑 seed_per_win 個「跟其他有這個詞的句子最像」的候選當種子（省時間）
    seeds = []
    for i, X in enumerate(PF):
        if not len(X):
            continue
        others = [G for j, G in enumerate(PF) if j != i]
        M = min_to_windows(X, others)
        s = robust(M, frac)
        for k in np.argsort(s)[:seed_per_win]:
            seeds.append((i, int(k), float(s[k])))
    if not seeds:
        return None
    S = np.stack([PF[i][k] for i, k, _ in seeds])
    pos_s = np.array([s for *_, s in seeds])
    neg_s = robust(min_to_windows(S, NF), frac) if NF else np.ones(len(S))
    # 分數：在有的句子很近、在沒有的句子很遠（比值越小越好）
    score = pos_s / np.maximum(neg_s, 1e-3)
    best = int(np.argmin(score))
    bi, bk, _ = seeds[best]
    tmpl = pos[bi][1][bk]
    if log:
        log(f'    種子 {len(seeds)} 個；最佳 窗{bi} 片段{bk}：有的句子 {pos_s[best]:.2f}、沒有的 {neg_s[best]:.2f}、比值 {score[best]:.2f}')
    # 用樣本在每個窗找最像的（DTW），再取前幾名的中位樣本重找一次（比較穩）
    for it in range(2):
        hits = []
        for idx, Q in pos:
            if not len(Q):
                hits.append((None, np.inf)); continue
            d0 = np.sqrt(((flat(Q) - tmpl.reshape(-1) / np.sqrt(F.NSEQ)) ** 2).sum(1))
            top = np.argsort(d0)[:20]
            dd = F.dtw_batch(Q[top], tmpl)
            j = int(top[np.argmin(dd)])
            hits.append((j, float(dd.min())))
        if it == 1:
            break
        good = sorted([(d, i, j) for i, (j, d) in enumerate(hits) if j is not None])[:max(3, len(hits) // 3)]
        G = np.stack([pos[i][1][j] for _, i, j in good])
        # medoid：跟其他好片段 DTW 距離總和最小的那個
        sums = [F.dtw_batch(G, g).sum() for g in G]
        tmpl = G[int(np.argmin(sums))]
    return tmpl, hits, float(score[best]), float(pos_s[best]), float(neg_s[best])


def grow(inst, vids, log=None, top=8, step=0.25, fmax=2.5, tol=1.2, add=0.08):
    """找到的常常只是詞的一小段（短片段到處都像）。把前幾名一起往前、往後延長（照各自長度的比例），
    只要它們彼此還一樣像（平均距離沒變差超過 tol 倍）就繼續延長 → 切點比較接近整個詞。
    inst: [[窗, 開始, 結束, 距離]]，會直接改切點和距離；回傳新的樣本（16×86）。"""
    best = sorted(inst, key=lambda x: x[3])[:top]
    if len(best) < 3:
        return None

    def segs(fa, fb, group):
        out = []
        for w, s, e, _ in group:
            L = e - s
            a, b = max(w['a'], int(round(s - fa * L))), min(w['b'], int(round(e + fb * L)))
            out.append((a, b))
        return out

    def cost(fa, fb):
        Q = np.stack([F.seq_feat_from_ff(vids[w['vid']]['ff'][a:b]) for (w, *_), (a, b) in zip(best, segs(fa, fb, best))])
        X = flat(Q)
        D = np.sqrt(np.maximum((X ** 2).sum(1)[:, None] + (X ** 2).sum(1)[None] - 2 * X @ X.T, 0))
        return D[np.triu_indices(len(X), 1)].mean()

    base = cost(0, 0)
    fa = fb = 0.0
    while True:
        opts = [(cost(fa + step, fb), fa + step, fb)] if fa < fmax else []
        opts += [(cost(fa, fb + step), fa, fb + step)] if fb < fmax else []
        if not opts:
            break
        c, na, nb = min(opts)
        if c > max(base * tol, base + add):
            break
        fa, fb = na, nb
    if log:
        log(f'    延長：前 {fa:.2f}、後 {fb:.2f} 倍長度（彼此距離 {base:.2f} → {cost(fa, fb):.2f}）')
    for x, (a, b) in zip(inst, segs(fa, fb, inst)):
        x[1], x[2] = a, b
    G = np.stack([F.seq_feat_from_ff(vids[w['vid']]['ff'][s:e]) for w, s, e, _ in best])
    sums = [F.dtw_batch(G, g).sum() for g in G]
    tmpl = G[int(np.argmin(sums))]
    Q = np.stack([F.seq_feat_from_ff(vids[w['vid']]['ff'][s:e]) for w, s, e, _ in inst])
    for x, d in zip(inst, F.dtw_batch(Q, tmpl)):
        x[3] = float(d)
    return tmpl


def has_term(text, term):
    return term in text


def neg_ok(text, term):
    """沒有這個詞、也沒有可能是同一個手語的詞（弟兄 vs 兄弟、主耶穌 vs 耶穌）"""
    return not any(c in text for c in set(term)) if len(term) <= 2 else term not in text


def find_term(term, W, vids, rnd, log=print, cache=None):
    pos = [w for w in W if has_term(w['text'], term)]
    neg = [w for w in W if neg_ok(w['text'], term)]
    if len(pos) < 3:
        return {'term': term, 'n': len(pos), 'found': 0, 'status': 'few'}
    if len(pos) > MAXPOS:
        pos = [pos[i] for i in sorted(rnd.choice(len(pos), MAXPOS, replace=False))]
    if len(neg) > MAXNEG:
        neg = [neg[i] for i in sorted(rnd.choice(len(neg), MAXNEG, replace=False))]

    def cands(w):
        key = (w['vid'], w['a'], w['b'])
        if cache is not None and key in cache:
            return cache[key]
        c = candidates(vids[w['vid']]['ff'], w['a'], w['b'])
        if cache is not None:
            cache[key] = c
        return c
    P = [cands(w) for w in pos]
    N = [cands(w) for w in neg]
    r = discover(P, N, log=log)
    if not r:
        return {'term': term, 'n': len(pos), 'found': 0, 'status': 'none'}
    tmpl, hits, score, ps, ns = r
    inst = []
    for w, (idx, _), (j, d) in zip(pos, P, hits):
        if j is not None:
            s, L = idx[j]
            inst.append([w, s, s + L, d])
    tmpl = grow(inst, vids, log) if len(inst) >= 3 else tmpl
    out = []
    for w, s, e, d in inst:
        out.append({'vid': vids[w['vid']]['id'], 'a': s, 'b': e, 'd': round(d, 3), 'text': w['text'],
                    't': [round(x, 2) for x in w['sub']]})
    out.sort(key=lambda x: x['d'])
    # 信心：比值越小越好；前幾名距離越小越好
    top_d = float(np.median([x['d'] for x in out[:5]])) if out else 9
    conf = 'high' if score < 0.6 and top_d < 1.1 else 'mid' if score < 0.8 else 'low'
    return {'term': term, 'n': len(pos), 'found': len(out), 'score': round(score, 3), 'pos': round(ps, 3),
            'neg': round(ns, 3), 'topd': round(top_d, 3), 'conf': conf, 'status': 'pending',
            'tmpl': F.encode_feat(tmpl), 'cands': out}


# ---------- 輸出 ----------
def clip(v, a, b):
    """影片骨架 [a-PAD, b+PAD) → 同語料格式的 base64（Int16）"""
    n = len(v['frames'])
    s, e = max(0, a - PAD), min(n, b + PAD)
    fr = v['frames'][s:e]
    q = np.where(np.isnan(fr), F.MISSING, np.clip(np.round(fr * F.SCALE), -32767, 32767)).astype('<i2')
    return base64.b64encode(q.tobytes()).decode(), s, e


def write_out(results, vids, terms_done):
    (OUT / 'cand').mkdir(parents=True, exist_ok=True)
    byid = {v['id']: v for v in vids}
    ixf = OUT / 'index.json'
    ix = json.loads(ixf.read_text('utf-8')) if ixf.exists() else {'v': 1, 'terms': {}}
    for r in results:
        t = r['term']
        old = ix['terms'].get(t, {})
        meta = {k: v for k, v in r.items() if k not in ('cands', 'tmpl', 'term')}
        if old.get('status') in ('done', 'partial'):
            meta['status'] = old['status']; meta['ok'] = old.get('ok', 0)   # 已經確認過的不要蓋掉狀態
        if r.get('cands'):
            cl = []
            for c in r['cands'][:TOPK]:
                v = byid[c['vid']]
                data, s, e = clip(v, c['a'], c['b'])
                cl.append({**c, 'id': f"{c['vid']}_{c['a']}", 'title': v['title'], 's': s, 'e': e, 'frames': e - s,
                           'data': data, 'aspect': v.get('aspect')})
            (OUT / 'cand' / f'{t}.json').write_text(json.dumps({'term': t, 'tmpl': r['tmpl'], 'fps': FPS, 'P': F.P,
                                                                  'cands': cl}, ensure_ascii=False), 'utf-8')
            meta['file'] = f'church/cand/{t}.json'
        ix['terms'][t] = meta
    ix['videos'] = sorted({*ix.get('videos', []), *(v['id'] for v in vids)})
    ix['made'] = time.strftime('%Y-%m-%dT%H:%M:%S')
    ixf.write_text(json.dumps(ix, ensure_ascii=False, indent=1), 'utf-8')
    return ix


def cmd_run(a):
    vids = load_videos(set(a.videos) if a.videos else None)
    if not vids:
        print('沒有有字幕的影片（corpus/raw/church/*.json 要有 subs）。先跑「批次匯入 YouTube 頻道」。'); return
    W = make_windows(vids)
    print(f'{len(vids)} 支影片、{len(W)} 句字幕')
    terms = a.terms or church_terms()
    counts = {t: sum(has_term(w['text'], t) for w in W) for t in terms}
    print('字幕出現次數：' + '、'.join(f'{t} {n}' for t, n in sorted(counts.items(), key=lambda x: -x[1])))
    rnd = np.random.default_rng(0)
    cache, res = {}, []
    for t in terms:
        t0 = time.time()
        r = find_term(t, W, vids, rnd, cache=cache)
        res.append(r)
        print(f"  {t}：{r['n']} 句、找到 {r['found']} 段" + (f"，比值 {r['score']}、前5中位距離 {r['topd']}（{r['conf']}）" if r.get('score') else '')
              + f'  {time.time() - t0:.0f}s', flush=True)
    ix = write_out(res, vids, terms)
    print(f"寫好 corpus/church/index.json（{len(ix['terms'])} 個詞）")


# ---------- 確認 → 語料 ----------
def cmd_accept(a):
    """labels.json：[{term, id, ok, a?, b?, by?}]（網站確認頁下載的、或 collect 分支收到的）→ corpus/signs/church/"""
    sys.path.insert(0, str(ROOT / 'tools'))
    import ingest
    files = []
    for f in a.files:                      # 檔案或資料夾（collect 分支的 collect/ 整個丟進來也可以）
        p = Path(f)
        files += sorted(p.rglob('*.json')) if p.is_dir() else [p]
    got = []
    for f in files:
        try:
            x = json.loads(f.read_text('utf-8'))
        except Exception:
            continue
        if isinstance(x, list):
            ls, when = x, ''
        elif x.get('kind') == 'tsl-church-labels':
            ls, when = x.get('labels', []), x.get('made', '')
        else:                              # collect 分支上傳的一批：只要 kind=label
            ls, when = [s for s in x.get('samples', []) if s.get('kind') == 'label'], x.get('uploaded', '')
        got += [(when, l) for l in ls if l.get('term') and l.get('id')]
    last = {}
    for when, l in sorted(got, key=lambda z: z[0]):   # 同一段改過，最後一次為準
        last[(l['term'], l['id'])] = l
    labels = list(last.values())
    if not labels:
        print('沒有確認結果'); return
    ix = ingest.load_index()
    cix = json.loads((OUT / 'index.json').read_text('utf-8'))
    dest = CORPUS / 'signs' / 'church'
    dest.mkdir(parents=True, exist_ok=True)
    added = 0
    by_term = {}
    for l in labels:
        by_term.setdefault(l['term'], []).append(l)
    for term, ls in by_term.items():
        cf = OUT / 'cand' / f'{term}.json'
        if not cf.exists():
            continue
        cand = {c['id']: c for c in json.loads(cf.read_text('utf-8'))['cands']}
        ok = 0
        for l in ls:
            c = cand.get(l['id'])
            if not c:
                continue
            c['label'] = 'ok' if l.get('ok') else 'no'
            sid = f"jcz_{c['id']}"
            if not l.get('ok'):            # 改成「不是」：之前收進去的拿掉
                (dest / f'{sid}.json').unlink(missing_ok=True)
                ix['signs'] = [e for e in ix['signs'] if e['id'] != sid]
                continue
            fr = F.decode_frames(c['data'])
            a0 = int(l.get('a', c['a'])) - c['s']; b0 = int(l.get('b', c['b'])) - c['s']
            fr = fr[max(0, a0):max(a0 + 4, b0)]
            q = np.where(np.isnan(fr), F.MISSING, np.round(fr * F.SCALE)).astype('<i2')
            sample = {'v': 1, 'id': sid, 'word': term, 'cat': 'church', 'fps': FPS, 'frames': len(fr), 'P': F.P,
                      'src': f"yt:{c['vid']}@{c['a'] / FPS:.1f}", 'created': ingest.now(),
                      'data': base64.b64encode(q.tobytes()).decode()}
            if c.get('aspect'):
                sample['aspect'] = c['aspect']
            (dest / f'{sid}.json').write_text(json.dumps(sample, ensure_ascii=False), 'utf-8')
            ix['signs'] = [e for e in ix['signs'] if e['id'] != sid]
            ix['signs'].append({'id': sid, 'word': term, 'cat': 'church', 'file': f'signs/church/{sid}.json',
                                'src': sample['src'], 'syn': [], 'q': 0.8})
            ok += 1; added += 1
        cf.write_text(json.dumps({**json.loads(cf.read_text('utf-8')), 'cands': list(cand.values())}, ensure_ascii=False), 'utf-8')
        t = cix['terms'].setdefault(term, {})
        t['ok'] = sum(1 for c in cand.values() if c.get('label') == 'ok')
        t['status'] = 'done' if t['ok'] >= 3 else 'partial' if t['ok'] else t.get('status', 'pending')
    ingest.save_index(ix)
    (OUT / 'index.json').write_text(json.dumps(cix, ensure_ascii=False, indent=1), 'utf-8')
    print(f'存了 {added} 個召會用語樣本到 corpus/signs/church/；記得跑 node tools/build_feats.mjs')


# ---------- 驗證：辭典例句 ----------
def cmd_test(a):
    """辭典例句當「字幕＋影片」：例句的中文當字幕、整句骨架當時間窗。
    對每個在 ≥8 句出現的詞，不給它的辭典示範，看找出來的片段跟 align_sent（用示範對齊）切的位置重疊多少。"""
    sx = json.loads((CORPUS / 'sent' / 'index.json').read_text('utf-8'))['sents']
    vids, W = [], []
    for e in sx:
        s = json.loads((CORPUS / e['file']).read_text('utf-8'))
        fr = F.decode_frames(s['data'], s['frames'])
        ff = F.frame_feats(fr)
        vids.append({'id': e['id'], 'title': e['text'], 'frames': fr, 'ff': ff, 'e': e})
        W.append({'vid': len(vids) - 1, 'a': 0, 'b': len(fr), 'text': clean_text(e['text']), 'sub': [0, len(fr) / FPS]})
    from collections import Counter
    c = Counter()
    for e in sx:
        for w in set(e['gloss']):
            if len(w) >= 2 and w in e['text']:
                c[w] += 1
    words = a.terms or [w for w, n in c.most_common() if n >= 8]
    rnd = np.random.default_rng(0)
    cache, tot, hit, hit_top = {}, 0, 0, 0
    for w in words:
        r = find_term(w, W, vids, rnd, log=lambda *_: None, cache=cache)
        gts, ok, okt = 0, 0, 0
        for rank, cd in enumerate(r.get('cands', [])):
            e = vids[[v['id'] for v in vids].index(cd['vid'])]['e']
            if w not in e['gloss'] or not e.get('seg'):
                continue
            i = e['gloss'].index(w)
            if e['d'][i] is None or e['d'][i] > 1.4:      # 對齊本身不可靠的句子不算
                continue
            g0, g1 = e['seg'][i]
            inter = max(0, min(g1, cd['b']) - max(g0, cd['a']))
            good = inter >= 0.5 * min(g1 - g0, cd['b'] - cd['a'])
            gts += 1; ok += good
            okt += good and rank < 5
        tot += gts; hit += ok
        print(f"  {w}：{r['n']} 句，可評估 {gts}，切對 {ok}（{ok / max(gts, 1):.0%}）；比值 {r.get('score')}、信心 {r.get('conf')}")
    print(f'全部：{hit}/{tot} = {hit / max(tot, 1):.0%}')


def _jitter(fr, rnd):
    """一段單詞示範：時間伸縮、整段平移縮放、加一點雜訊（讓每次插進去的不完全一樣）"""
    act = np.where(active(F.frame_feats(fr)))[0]        # 去掉舉手、放下（連續手語不會每個詞都放下手）
    if len(act) >= 3:
        fr = fr[act[0]:act[-1] + 1]
    sp = rnd.uniform(1.1, 1.8)                          # 連續手語比辭典示範快
    ii = np.clip(np.round(np.arange(0, len(fr), sp)).astype(int), 0, len(fr) - 1)
    fr = fr[ii].copy().reshape(len(ii), F.P, 3)
    s = rnd.uniform(0.93, 1.07)
    c = np.nanmean(fr[:, :, :2], (0, 1))
    fr[:, :, :2] = (fr[:, :, :2] - c) * s + c + rnd.uniform(-0.02, 0.02, 2)
    fr[:, :, :2] += rnd.normal(0, 0.004, fr[:, :, :2].shape)
    return fr.reshape(len(ii), -1).astype(np.float32)


def cmd_synth(a):
    """比較接近真實的驗證：真的辭典例句（連續手語）當背景，把目標詞的辭典示範（時間伸縮＋抖動）插進其中 15 句當「字幕有這個詞」，
    另外 3 句字幕有詞但沒插（示範者沒比）、40 句沒有。答案（插在哪）已知，看找出來的片段切得對不對。"""
    rnd = np.random.default_rng(a.seed)
    sx = json.loads((CORPUS / 'sent' / 'index.json').read_text('utf-8'))['sents']
    sents = []
    for e in sx:
        s = json.loads((CORPUS / e['file']).read_text('utf-8'))
        sents.append((e, F.decode_frames(s['data'], s['frames'])))
    ix = json.loads((CORPUS / 'index.json').read_text('utf-8'))
    byw = {}
    for e in ix['signs']:
        if e['id'].startswith('ccu') and e.get('q', 0) >= 0.5 and len(e['word']) >= 2 and re.fullmatch(r'[一-鿿]+', e['word']):
            byw.setdefault(e['word'], []).append(e)
    words = a.terms or [w for w in sorted(byw) if len(byw[w]) >= 2]
    if not a.terms:
        words = [words[i] for i in rnd.choice(len(words), a.n, replace=False)]
    tot_ok = tot = top_ok = top_n = 0
    ious = []
    for w in words:
        samples = [F.decode_frames(json.loads((CORPUS / e['file']).read_text('utf-8'))['data']) for e in byw[w]]
        order = rnd.permutation(len(sents))
        vids, W, truth = [], [], {}
        for k, si in enumerate(order[:58]):
            e, fr = sents[si]
            if w in e['text']:
                continue
            if k < 15:            # 插進去
                clipf = _jitter(samples[k % len(samples)], rnd)
                cut = int(rnd.integers(0, len(fr) + 1))
                g1, g2 = int(rnd.integers(0, 4)), int(rnd.integers(0, 4))
                parts = [fr[:cut]] + ([np.repeat(fr[cut - 1:cut], g1, 0)] if cut and g1 else []) + [clipf] + \
                        ([np.repeat(fr[cut:cut + 1], g2, 0)] if cut < len(fr) and g2 else []) + [fr[cut:]]
                fr2 = np.concatenate(parts)
                t0 = cut + (g1 if cut else 0)
                truth[len(vids)] = (t0, t0 + len(clipf))
                txt = e['text'] + w
            elif k < 18:          # 字幕有、但沒比
                fr2, txt = fr, e['text'] + w
            else:
                fr2, txt = fr, e['text']
            vids.append({'id': f's{len(vids)}', 'title': txt, 'frames': fr2, 'ff': F.frame_feats(fr2)})
            W.append({'vid': len(vids) - 1, 'a': 0, 'b': len(fr2), 'text': clean_text(txt), 'sub': [0, 1]})
        r = find_term(w, W, vids, rnd, log=lambda *_: None, cache={})
        ok = n = tk = 0
        for rank, cd in enumerate(r.get('cands', [])):
            vi = int(cd['vid'][1:])
            if vi not in truth:
                continue
            g0, g1_ = truth[vi]
            inter = max(0, min(g1_, cd['b']) - max(g0, cd['a']))
            good = inter >= 0.5 * min(g1_ - g0, cd['b'] - cd['a'])
            ious.append(inter / (max(g1_, cd['b']) - min(g0, cd['a'])))
            n += 1; ok += good
            if rank < 5:
                top_n += 1; top_ok += good
        tot += n; tot_ok += ok
        print(f"  {w}：切對 {ok}/{n}；比值 {r.get('score')}、前5距離 {r.get('topd')}、信心 {r.get('conf')}", flush=True)
    print(f'全部：{tot_ok}/{tot} = {tot_ok / max(tot, 1):.0%}；排前 5 名的 {top_ok}/{top_n} = {top_ok / max(top_n, 1):.0%}；'
          f'切點重疊率（IoU）中位數 {np.median(ious):.2f}')


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest='cmd', required=True)
    p = sp.add_parser('run'); p.add_argument('--terms', nargs='*'); p.add_argument('--videos', nargs='*')
    p = sp.add_parser('test'); p.add_argument('--terms', nargs='*')
    p = sp.add_parser('synth'); p.add_argument('--terms', nargs='*'); p.add_argument('--n', type=int, default=12)
    p.add_argument('--seed', type=int, default=1)
    p = sp.add_parser('accept'); p.add_argument('files', nargs='+')
    a = ap.parse_args()
    {'run': cmd_run, 'test': cmd_test, 'synth': cmd_synth, 'accept': cmd_accept}[a.cmd](a)


if __name__ == '__main__':
    main()
