#!/usr/bin/env python3
"""yt_batch.py — 整個 YouTube 頻道／播放清單批次匯入（影片＋字幕 → 骨架＋字幕時間軸，影片不保存）。

給 GitHub Actions「批次匯入 YouTube 頻道」用，分三步：
  python tools/yt_batch.py list    <頻道或清單網址> --match 晨興聖言 --max 20 --out list.json
  python tools/yt_batch.py extract --list list.json --shard 0 --of 6 --cat church --out out/0
  python tools/yt_batch.py merge   out/*

需要環境變數 YT_COOKIES（Netscape cookies.txt 內容），否則 YouTube 會擋雲端主機。
每支影片存成 corpus/raw/<cat>/<影片id>.json（整段骨架＋ subs: [[開始秒, 結束秒, 字幕], ...]），
之後用字幕和手勢段落做弱監督對齊，切出一個個詞。
"""
import argparse, json, os, re, shutil, sys, tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ingest  # noqa: E402

SUB_LANGS = ['zh-TW', 'zh-Hant', 'zh', 'zh-HK', 'zh-Hans', 'zh-CN']
MAX_SECONDS = 90 * 60


def ydl_opts(tmp, **kw):
    o = {'quiet': True, 'noprogress': True, 'ignoreerrors': False}
    if os.environ.get('YT_COOKIES'):
        ck = Path(tmp) / 'cookies.txt'
        ck.write_text(os.environ['YT_COOKIES'], 'utf-8')
        o['cookiefile'] = str(ck)
    o.update(kw)
    return o


# ---------- 1. 列出影片 ----------
def cmd_list(a):
    import yt_dlp
    ix = ingest.load_index()
    done = {r['id'] for r in ix.get('raw', [])}
    with tempfile.TemporaryDirectory() as tmp, yt_dlp.YoutubeDL(ydl_opts(tmp, extract_flat='in_playlist')) as y:
        info = y.extract_info(a.url, download=False)
    entries = []

    def walk(e):   # 頻道首頁會有「影片／直播／Shorts」幾層
        for x in e.get('entries') or []:
            if not x:
                continue
            if x.get('_type') == 'playlist' or (x.get('entries') is not None):
                walk(x)
            elif x.get('id'):
                entries.append(x)
    walk(info)
    pat = re.compile(a.match) if a.match else None
    seen, out = set(), []
    for e in entries:
        vid = re.sub(r'[^\w-]', '_', e['id'])
        title = e.get('title') or ''
        if vid in seen or (pat and not pat.search(title)):
            continue
        seen.add(vid)
        if vid in done and not a.redo:
            continue
        out.append({'id': e['id'], 'title': title, 'url': e.get('url') or f"https://www.youtube.com/watch?v={e['id']}",
                    'duration': e.get('duration')})
    if a.oldest_first:
        out.reverse()
    out = out[:a.max]
    Path(a.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), 'utf-8')
    print(f'頻道共 {len(entries)} 支、符合且尚未匯入 {len(out)} 支：')
    for e in out:
        print(' -', e['title'])


# ---------- 字幕 ----------
def _ts(x):
    h, m, s = (['0'] + x.replace(',', '.').split(':'))[-3:]
    return int(h) * 3600 + int(m) * 60 + float(s)


def parse_vtt(text):
    """WebVTT → [[開始, 結束, 文字]]；自動字幕會一行一行滾動重複，去掉重複。"""
    cues, out = re.split(r'\n\s*\n', text.replace('\r', '')), []
    for c in cues:
        m = re.search(r'([\d:.,]+)\s+-->\s+([\d:.,]+)', c)
        if not m:
            continue
        body = c[m.end():].split('\n', 1)[1] if '\n' in c[m.end():] else ''
        lines = [re.sub(r'<[^>]+>', '', l).strip() for l in body.split('\n')]
        lines = [l for l in lines if l]
        if not lines:
            continue
        a, b = round(_ts(m.group(1)), 2), round(_ts(m.group(2)), 2)
        t = lines[-1]
        if out and t == out[-1][2]:
            out[-1][1] = b   # 同一句延長
            continue
        if b - a < 0.05:
            continue
        out.append([a, b, t])
    return out


def pick_subs(tmp, vid):
    files = list(Path(tmp).glob(f'{vid}.*.vtt'))
    if not files:
        return None, []
    def rank(p):
        lang = p.name[len(vid) + 1:-4]
        auto = 1 if '-orig' in lang or lang.endswith('auto') else 0
        base = next((i for i, l in enumerate(SUB_LANGS) if lang.split('-orig')[0] == l), len(SUB_LANGS))
        return (auto, base)
    best = sorted(files, key=rank)[0]
    return best.name[len(vid) + 1:-4], parse_vtt(best.read_text('utf-8', errors='ignore'))


# ---------- 2. 抽骨架（一份） ----------
def cmd_extract(a):
    import yt_dlp
    items = json.loads(Path(a.list).read_text('utf-8'))[a.shard::a.of]
    out = Path(a.out)
    (out / 'raw').mkdir(parents=True, exist_ok=True)
    report = []
    for e in items:
        vid = re.sub(r'[^\w-]', '_', e['id'])
        try:
            with tempfile.TemporaryDirectory() as tmp:
                base = dict(format='bv*[height<=720][ext=mp4]/bv*[height<=720]/b[height<=720]/bv*/b', outtmpl=f'{tmp}/%(id)s.%(ext)s',
                            writesubtitles=True, writeautomaticsub=True, subtitleslangs=SUB_LANGS + ['zh.*'], subtitlesformat='vtt',
                            match_filter=yt_dlp.utils.match_filter_func(f'duration < {MAX_SECONDS}'))
                with yt_dlp.YoutubeDL(ydl_opts(tmp, **base)) as y:
                    info = y.extract_info(e['url'], download=True)
                lang, subs = pick_subs(tmp, info['id'])
                path = next(p for p in Path(tmp).glob(f"{info['id']}.*") if p.suffix not in ('.txt', '.vtt'))
                print(f"[{a.shard}] {info.get('title')}：字幕 {lang or '無'}（{len(subs)} 句），抽骨架…", flush=True)
                frames = ingest.extract(path)
            raw = {'v': 1, 'videoId': vid, 'title': info.get('title') or e['title'], 'url': e['url'], 'cat': a.cat, 'fps': ingest.FPS,
                   'frames': len(frames), 'P': ingest.P, 'created': ingest.now(), 'data': ingest.encode(frames)}
            if ingest.extract.aspect:
                raw['aspect'] = ingest.extract.aspect
            if subs:
                raw['subs'] = subs
                raw['subLang'] = lang
            (out / 'raw' / f'{vid}.json').write_text(json.dumps(raw, ensure_ascii=False), 'utf-8')
            report.append({'id': vid, 'title': raw['title'], 'ok': True, 'frames': len(frames), 'subs': len(subs), 'subLang': lang})
        except Exception as ex:
            print(f'[{a.shard}] 失敗 {e["title"]}：{ex}', flush=True)
            report.append({'id': vid, 'title': e['title'], 'ok': False, 'error': str(ex)[:300]})
    (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=1), 'utf-8')


# ---------- 3. 合併 ----------
def cmd_merge(a):
    ix = ingest.load_index()
    ix.setdefault('raw', [])
    lines = []
    for d in a.dirs:
        d = Path(d)
        for f in sorted((d / 'raw').glob('*.json')):
            raw = json.loads(f.read_text('utf-8'))
            cat = ingest.cat_of(raw.get('cat'))
            dest = ingest.CORPUS / 'raw' / cat
            dest.mkdir(parents=True, exist_ok=True)
            shutil.copy(f, dest / f.name)
            vid = raw['videoId']
            ix['raw'] = [r for r in ix['raw'] if r['id'] != vid]
            ix['raw'].append({'id': vid, 'title': raw['title'], 'url': raw['url'], 'cat': cat, 'file': f'raw/{cat}/{f.name}',
                              'frames': raw['frames'], 'subs': len(raw.get('subs') or []), 'labeled': 0})
        rp = d / 'report.json'
        for r in (json.loads(rp.read_text('utf-8')) if rp.exists() else []):
            lines.append(f"- {'✅' if r['ok'] else '❌'} {r['title']}" +
                         (f"：{r['frames'] / ingest.FPS:.0f} 秒、字幕 {r['subs']} 句（{r.get('subLang') or '無'}）" if r['ok'] else f"：{r.get('error')}"))
    ingest.save_index(ix)
    msg = '\n'.join(lines) or '沒有處理任何影片'
    print(msg)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as fh:
            fh.write('## 批次匯入結果\n' + msg + '\n')


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest='cmd', required=True)
    p = sp.add_parser('list'); p.add_argument('url'); p.add_argument('--match', default='')
    p.add_argument('--max', type=int, default=20); p.add_argument('--out', default='list.json')
    p.add_argument('--redo', action='store_true'); p.add_argument('--oldest-first', action='store_true')
    p = sp.add_parser('extract'); p.add_argument('--list', required=True); p.add_argument('--shard', type=int, default=0)
    p.add_argument('--of', type=int, default=1); p.add_argument('--cat', default='church', choices=ingest.CATS); p.add_argument('--out', required=True)
    p = sp.add_parser('merge'); p.add_argument('dirs', nargs='+')
    a = ap.parse_args()
    {'list': cmd_list, 'extract': cmd_extract, 'merge': cmd_merge}[a.cmd](a)


if __name__ == '__main__':
    main()
