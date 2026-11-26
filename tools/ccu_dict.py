#!/usr/bin/env python3
"""ccu_dict.py — 把中正大學《台灣手語線上辭典》的詞彙影片轉成骨架語料（影片不保存）。

引用：蔡素娟、戴浩一、劉世凱、陳怡君。2026。《台灣手語線上辭典（中文版第五版）》。
      嘉義：國立中正大學手語語言學台灣研究中心。https://twtsl.ccu.edu.tw/

用法（GitHub Actions：.github/workflows/ccu-dict.yml）：
  python tools/ccu_dict.py list                         # 抓詞條清單 → corpus/dict/ccu-list.json
  python tools/ccu_dict.py extract --shard 0 --of 12 --out out/0   # 一部分詞條：下載→抽骨架→刪影片
  python tools/ccu_dict.py merge out/*                  # 合併進 corpus/
  python tools/ccu_dict.py sent --shard 0 --of 6 --out out/0      # 546 句例句影片 → 整句骨架（影片不保存）
  python tools/ccu_dict.py sent-merge out/*             # 合併進 corpus/sent/，再跑 tools/align_sent.py 切出每個詞
"""
import argparse, base64, json, re, shutil, sys, tempfile, time, urllib.parse, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ingest  # noqa: E402
import numpy as np  # noqa: E402

BASE = 'https://twtsl.ccu.edu.tw'
DICT = ingest.CORPUS / 'dict'
UA = {'User-Agent': 'tsl-translator corpus builder (+https://github.com/isaiahovercomer/tsl-translator)'}


def api(path, **q):
    url = f'{BASE}/api/{path}?' + urllib.parse.urlencode(q)
    for k in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return json.load(r)
        except Exception as e:
            if k == 3:
                raise
            print('  重試', url, e, flush=True); time.sleep(3 * (k + 1))


def base_word(name):
    """「會_N」「人_A」→「會」「人」（_N/_S 南北方言、_A/_B 不同打法）"""
    return re.sub(r'_[A-Z]$', '', name.strip())


def cmd_list():
    out = {}
    for st in range(1, 60):
        page = 1
        while True:
            try:
                j = api('pinSearch', field='stroke', value=st, lang='zh', page=page, pageSize=100)
            except Exception:
                break
            for r in j['Record']:
                out[r['id']] = {'id': r['id'], 'name': r['name'], 'video': r['video_url']}
            if page * 100 >= j['Total']:
                break
            page += 1; time.sleep(0.2)
    DICT.mkdir(parents=True, exist_ok=True)
    items = sorted(out.values(), key=lambda r: r['id'])
    (DICT / 'ccu-list.json').write_text(json.dumps(items, ensure_ascii=False, indent=0), 'utf-8')
    print(f'{len(items)} 個詞條')


def cmd_extract(shard, of, out):
    items = json.loads((DICT / 'ccu-list.json').read_text('utf-8'))[shard::of]
    out = Path(out); out.mkdir(parents=True, exist_ok=True)
    ingest.CORPUS = out                       # add_sign 寫到這個分片的資料夾
    ix = {'signs': [], 'raw': []}; meta = []
    tmp = Path(tempfile.mkdtemp())
    for n, it in enumerate(items):
        try:
            q = api('querySearch', id=it['id'], lang='zh')['Record'][0]
            names = [g['name'] for g in api('group', id=it['id'], lang='zh')['Record']]
            sents = api('sentence', id=it['id'], lang='zh')['Record']
            word = base_word(it['name'])
            syn = sorted({base_word(x) for x in names} - {word})
            vp = tmp / 'v.mp4'
            urllib.request.urlretrieve(BASE + it['video'], vp)
            frames = ingest.extract(vp, progress=False)
            vp.unlink(missing_ok=True)       # 影片不保存
            hands = sum(1 for f in frames if f[ingest.OFF_LH * 3] == f[ingest.OFF_LH * 3] or f[ingest.OFF_RH * 3] == f[ingest.OFF_RH * 3])
            s = ingest.add_sign(ix, word, frames, f"ccu:{it['id']}", sid=f"ccu{it['id']}", aspect=ingest.extract.aspect, cat='general')
            if s:
                ix['signs'][-1].update({'syn': syn, 'variant': it['name'], 'q': round(hands / max(1, len(frames)), 2)})
            meta.append({'id': it['id'], 'name': it['name'], 'word': word, 'syn': syn, 'desc': q.get('description'),
                         'video': it['video'], 'hands': round(hands / max(1, len(frames)), 2),
                         'sentences': sents})
            print(f'[{n + 1}/{len(items)}] {it["name"]} 手部 {hands}/{len(frames)} 格', flush=True)
        except Exception as e:
            print(f'[{n + 1}/{len(items)}] {it["name"]} 失敗：{e}', flush=True)
        time.sleep(0.3)
    (out / 'shard.json').write_text(json.dumps({'index': ix, 'meta': meta}, ensure_ascii=False), 'utf-8')
    shutil.rmtree(tmp, ignore_errors=True)


# ---------- 例句（整句手語影片）----------
def encode_bs(bs):
    """每格 52 個表情係數 → 0~254 一個 byte；沒有臉的格第 0 個存 255（同 reextract.py）"""
    a = np.zeros((len(bs), 52), np.uint8)
    for i, b in enumerate(bs):
        if b is None or len(b) < 52:
            a[i, 0] = 255
        else:
            a[i] = np.clip(np.round(np.asarray(b[:52]) * 254), 0, 254)
    return base64.b64encode(a.tobytes()).decode()


def sentence_list():
    seen = {}
    for m in json.loads((DICT / 'ccu-meta.json').read_text('utf-8')):
        for s in m['sentences']:
            seen.setdefault(s['id'], s)
    return [seen[k] for k in sorted(seen)]


def split_gloss(g):
    """「我_B/游泳_A/會_N」→ 變體 [我_B, 游泳_A, 會_N]、詞 [我, 游泳, 會]"""
    gv = [x.strip() for x in g.split('/') if x.strip()]
    return gv, [base_word(x) for x in gv]


def cmd_sent(shard, of, out):
    items = sentence_list()[shard::of]
    out = Path(out); (out / 'sent' / 'ccu').mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp()); rows = []
    for n, it in enumerate(items):
        try:
            vp = tmp / 'v.mp4'
            urllib.request.urlretrieve(BASE + it['video_url'], vp)
            frames = ingest.extract(vp, progress=False, blendshapes=True)
            bs = ingest.extract.blendshapes
            vp.unlink(missing_ok=True)       # 影片不保存
            gv, words = split_gloss(it['gloss'])
            hands = sum(1 for f in frames if f[ingest.OFF_LH * 3] == f[ingest.OFF_LH * 3] or f[ingest.OFF_RH * 3] == f[ingest.OFF_RH * 3])
            sid = f"ccuS{it['id']}"
            s = {'v': 1, 'id': sid, 'gloss': words, 'gv': gv, 'text': it['translation'], 'fps': ingest.FPS,
                 'frames': len(frames), 'P': ingest.P, 'src': f"ccu-sent:{it['id']}", 'aspect': ingest.extract.aspect,
                 'q': round(hands / max(1, len(frames)), 2), 'created': ingest.now(),
                 'data': ingest.encode(frames), 'fbs': encode_bs(bs)}
            (out / 'sent' / 'ccu' / f'{sid}.json').write_text(json.dumps(s, ensure_ascii=False), 'utf-8')
            rows.append({k: s[k] for k in ('id', 'gloss', 'gv', 'text', 'frames', 'q', 'src')} | {'file': f'sent/ccu/{sid}.json'})
            print(f'[{n + 1}/{len(items)}] {it["translation"]}（{len(words)} 詞、{len(frames)} 格、手部 {s["q"]}）', flush=True)
        except Exception as e:
            print(f'[{n + 1}/{len(items)}] {it.get("translation")} 失敗：{e}', flush=True)
        time.sleep(0.3)
    (out / 'sent.json').write_text(json.dumps(rows, ensure_ascii=False), 'utf-8')
    shutil.rmtree(tmp, ignore_errors=True)


def cmd_sent_merge(dirs):
    sx = ingest.CORPUS / 'sent' / 'index.json'
    ix = json.loads(sx.read_text('utf-8')) if sx.exists() else {'sents': []}
    by = {e['id']: e for e in ix['sents']}
    for d in map(Path, dirs):
        f = d / 'sent.json'
        if not f.exists():
            continue
        for e in json.loads(f.read_text('utf-8')):
            dst = ingest.CORPUS / e['file']; dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(d / e['file'], dst)
            by[e['id']] = e
    ix['sents'] = sorted(by.values(), key=lambda e: int(e['id'][4:]))
    sx.parent.mkdir(parents=True, exist_ok=True)
    sx.write_text(json.dumps(ix, ensure_ascii=False, indent=0), 'utf-8')
    print(f'例句 {len(ix["sents"])} 句')


def cmd_merge(dirs):
    ix = ingest.load_index(); have = {e['id'] for e in ix['signs']}
    meta = []
    for d in map(Path, dirs):
        f = d / 'shard.json'
        if not f.exists():
            continue
        j = json.loads(f.read_text('utf-8'))
        meta += j['meta']
        for e in j['index']['signs']:
            src = d / e['file']; dst = ingest.CORPUS / e['file']
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
            if e['id'] not in have:
                ix['signs'].append(e); have.add(e['id'])
            else:
                ix['signs'] = [e if x['id'] == e['id'] else x for x in ix['signs']]
    ingest.save_index(ix)
    DICT.mkdir(parents=True, exist_ok=True)
    meta.sort(key=lambda m: m['id'])
    (DICT / 'ccu-meta.json').write_text(json.dumps(meta, ensure_ascii=False), 'utf-8')
    # 例句：上行手語語序、下行中文翻譯 → 之後給 AI 學手語詞序
    print(f'合併 {len(meta)} 個詞條，例句 {sum(len(m["sentences"]) for m in meta)} 句')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['list', 'extract', 'merge', 'sent', 'sent-merge'])
    ap.add_argument('dirs', nargs='*')
    ap.add_argument('--shard', type=int, default=0)
    ap.add_argument('--of', type=int, default=1)
    ap.add_argument('--out', default='out/0')
    a = ap.parse_args()
    if a.cmd == 'list':
        cmd_list()
    elif a.cmd == 'extract':
        cmd_extract(a.shard, a.of, a.out)
    elif a.cmd == 'sent':
        cmd_sent(a.shard, a.of, a.out)
    elif a.cmd == 'sent-merge':
        cmd_sent_merge(a.dirs)
    else:
        cmd_merge(a.dirs)
