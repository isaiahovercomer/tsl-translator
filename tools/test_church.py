"""v0.20 召會語料測試：
1. 做假的「江啟禎影片」：辭典例句（真的連續手語）接成 3 支長影片，字幕＝例句中文；
   其中 16 句插進「長頸鹿」的辭典示範（時間伸縮＋抖動），字幕後面加「弟兄」→ 假裝這就是「弟兄」的手語。
2. church_align.py run（暫存資料夾）→ 前 5 名候選是不是插進去的位置。
3. 網站「召會語料確認」頁（Playwright，檔案從磁碟回應）：選詞、播放、微調切點、✅／❌、本機語料、送出（攔截 /api/collect）、下載確認檔。
4. church_align.py accept 確認檔 → corpus/signs/church/。
截圖 /home/claude/shots/v020_*.png"""
import json, mimetypes, pathlib, shutil, sys, tempfile
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import church_align as C, feats as F, ingest  # noqa: E402

TMP = pathlib.Path(tempfile.mkdtemp(prefix='chtest-'))
CORP = TMP / 'corpus'
(CORP / 'raw' / 'church').mkdir(parents=True)
shutil.copy(ROOT / 'corpus' / 'index.json', CORP / 'index.json')
SHOTS = pathlib.Path('/home/claude/shots'); SHOTS.mkdir(exist_ok=True)

# ---------- 1. 假影片 ----------
rnd = np.random.default_rng(3)
sx = json.loads((ROOT / 'corpus/sent/index.json').read_text('utf-8'))['sents']
ix = json.loads((ROOT / 'corpus/index.json').read_text('utf-8'))
term_src = [e for e in ix['signs'] if e['word'] == '長頸鹿']
samples = [F.decode_frames(json.loads((ROOT / 'corpus' / e['file']).read_text('utf-8'))['data']) for e in term_src]
order = rnd.permutation(len(sx))
truth = {}
k = 0
for v in range(3):
    parts, subs, t = [], [], 0
    for _ in range(20):
        e = sx[order[k]]; k += 1
        fr = F.decode_frames(json.loads((ROOT / 'corpus' / e['file']).read_text('utf-8'))['data'], e['frames'])
        text = e['text']
        if k % 4 != 0 and sum(map(len, truth.values())) < 16:          # 插「弟兄」
            cl = C._jitter(samples[k % len(samples)], rnd)
            cut = int(rnd.integers(5, len(fr) - 5))
            fr = np.concatenate([fr[:cut], cl, fr[cut:]])
            truth.setdefault(f'vid{v}', []).append((t + cut, t + cut + len(cl)))
            text = text[:len(text) // 2] + '弟兄' + text[len(text) // 2:]
        rest = np.repeat(fr[-1:], 10, 0)              # 句子之間停一下
        subs.append([round(t / 15 + 0.3, 2), round((t + len(fr)) / 15 - 0.3, 2), text])
        parts += [fr, rest]; t += len(fr) + 10
    frames = np.concatenate(parts)
    q = np.where(np.isnan(frames), F.MISSING, np.round(frames * F.SCALE)).astype('<i2')
    import base64
    raw = {'v': 1, 'videoId': f'vid{v}', 'title': f'假影片{v}', 'url': '', 'cat': 'church', 'fps': 15, 'frames': len(frames),
           'P': 82, 'data': base64.b64encode(q.tobytes()).decode(), 'subs': subs, 'subLang': 'ocr'}
    (CORP / 'raw' / 'church' / f'vid{v}.json').write_text(json.dumps(raw, ensure_ascii=False), 'utf-8')
print(f'假影片 3 支，插了 {sum(map(len, truth.values()))} 個「弟兄」')

# ---------- 2. 自動切詞 ----------
C.CORPUS = CORP; C.OUT = CORP / 'church'
C.cmd_run(type('A', (), {'videos': None, 'terms': ['弟兄', '召會']})())
cix = json.loads((CORP / 'church/index.json').read_text('utf-8'))
cand = json.loads((CORP / 'church/cand/弟兄.json').read_text('utf-8'))['cands']
def hit(c):
    return any(max(0, min(b, c['b']) - max(a, c['a'])) >= 0.5 * min(b - a, c['b'] - c['a']) for a, b in truth.get(c['vid'], []))
top = [hit(c) for c in cand[:5]]
print('弟兄 前 5 名切對：', top, '全部', sum(map(hit, cand)), '/', len(cand))
assert sum(top) >= 4, top
assert cix['terms']['召會']['status'] == 'few'

# ---------- 3. 網站確認頁 ----------
from playwright.sync_api import sync_playwright
BASE = 'https://tsl.test/'
posted = []
def handle(route):
    url = route.request.url
    if not url.startswith(BASE):
        return route.continue_()
    from urllib.parse import unquote
    path = unquote(url[len(BASE):].split('?')[0].split('#')[0]) or 'index.html'
    if path == 'api/collect':
        if route.request.method == 'POST':
            posted.append(json.loads(route.request.post_data))
            return route.fulfill(status=200, content_type='application/json', body='{"ok":true,"n":1}')
        return route.fulfill(status=200, content_type='application/json', body='{"ready":true}')
    if path.startswith('api/'):
        return route.fulfill(status=503, body='{}')
    f = (CORP.parent / path) if path.startswith('corpus/church/') else ROOT / path
    if f.is_file():
        return route.fulfill(status=200, body=f.read_bytes(), content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
    return route.fulfill(status=404, body='')

errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-angle=swiftshader', '--ignore-certificate-errors'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, accept_downloads=True)
    ctx.add_init_script("try{localStorage.setItem('tsl-guided','1')}catch(e){}")
    ctx.route('**/*', handle)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(BASE + 'index.html#add')
    pg.wait_for_function('window.__tsl && window.__tsl.samples.length > 0', timeout=60000)
    assert pg.is_visible('a[href="#church"]')
    pg.click('a[href="#church"]'); pg.wait_for_timeout(1500)
    stat = pg.inner_text('#chStat'); print('狀態：', stat)
    assert '3 支影片' in stat and '1 個詞' in stat, stat
    chips = pg.eval_on_selector_all('#chTerms .chip', 'es => es.map(e => [e.textContent, e.disabled])'); print('詞：', chips)
    pg.click('#chTerms .chip:not([disabled])'); pg.wait_for_timeout(1500)
    print('標題：', pg.inner_text('#chTitle'), '｜字幕：', pg.inner_text('#chSub'))
    assert '弟兄' in pg.inner_text('#chTitle') and '弟兄' in pg.inner_text('#chSub')
    assert pg.eval_on_selector('#chSub mark', 'e => e.textContent') == '弟兄'
    # 有畫出手譯員（畫布不是一片空白）
    pg.wait_for_timeout(800)
    px = pg.evaluate("""() => { const c = document.getElementById('chCanvas'), x = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 0; i < x.length; i += 400) if (x[i] !== x[0] || x[i + 1] !== x[1]) n++; return n; }""")
    print('手譯員畫面變化像素：', px); assert px > 50
    r0 = pg.inner_text('#chRange')
    pg.click('#v-church [data-adj="b+"]'); pg.wait_for_timeout(300)
    r1 = pg.inner_text('#chRange'); print('切點：', r0, '→', r1); assert r0 != r1
    pg.click('#chYtBtn'); pg.wait_for_timeout(300)
    src = pg.eval_on_selector('#chYt iframe', 'e => e.src'); print('原影片：', src); assert 'youtube-nocookie.com/embed/vid' in src and 'start=' in src
    pg.screenshot(path=str(SHOTS / 'v020_review.png'), full_page=False)
    for _ in range(3):
        pg.click('#chOk'); pg.wait_for_timeout(500)
    pg.click('#chNo'); pg.wait_for_timeout(500)
    L = pg.evaluate("JSON.parse(localStorage.getItem('tsl-church-labels'))")
    print('確認：', {k: len(v) for k, v in L.items()}); assert len(L['弟兄']) == 4 and sum(x['ok'] for x in L['弟兄'].values()) == 3
    # 本機語料：馬上能用
    pg.wait_for_timeout(1500)
    n_local = pg.evaluate("window.__tsl.samples.filter(s => s.word === '弟兄' && s.cat === 'church' && !s.shared).length")
    print('本機語料「弟兄」：', n_local); assert n_local == 3
    assert '✅3' in pg.inner_text('#chTerms')
    pg.evaluate("location.hash = '#talk'"); pg.wait_for_timeout(500)
    pg.evaluate("window.__tsl.playText('弟兄姊妹平安')"); pg.wait_for_timeout(1500)
    speech = pg.eval_on_selector_all('#speechChips .chip', 'es => es.map(e => (e.classList.contains("card") ? "✍" : "") + e.textContent)')
    print('說「弟兄姊妹平安」：', speech); assert any(c == '弟兄' for c in speech), speech
    pg.evaluate("location.hash = '#church'"); pg.wait_for_timeout(800)
    assert '4 個確認結果' in pg.inner_text('#chPending')
    pg.click('#chSend'); pg.wait_for_timeout(1000)
    print('送出：', [(s['kind'], s['term'], s['ok']) for s in posted[0]['samples']]); assert len(posted[0]['samples']) == 4
    assert '都送出了' in pg.inner_text('#chPending')
    with pg.expect_download() as dl:
        pg.click('#chDl')
    lab = TMP / 'labels.json'; dl.value.save_as(str(lab))
    pg.screenshot(path=str(SHOTS / 'v020_review2.png'), full_page=True)
    b.close()
print('頁面錯誤：', errors); assert not errors

# ---------- 4. accept ----------
real_ingest_corpus = ingest.CORPUS
ingest.CORPUS = CORP
try:
    C.cmd_accept(type('A', (), {'files': [str(lab)]})())
finally:
    ingest.CORPUS = real_ingest_corpus
got = json.loads((CORP / 'index.json').read_text('utf-8'))
mine = [e for e in got['signs'] if e['word'] == '弟兄' and e['cat'] == 'church']
print('收進語料庫：', [e['id'] for e in mine]); assert len(mine) == 3 and all((CORP / e['file']).exists() for e in mine)
assert json.loads((CORP / 'church/index.json').read_text('utf-8'))['terms']['弟兄']['status'] == 'done'
# 改成「不是」→ 拿掉
x = json.loads(lab.read_text('utf-8')); x['labels'][0]['ok'] = False; x['made'] = '9'
(TMP / 'labels2.json').write_text(json.dumps(x), 'utf-8')
ingest.CORPUS = CORP
try:
    C.cmd_accept(type('A', (), {'files': [str(lab), str(TMP / 'labels2.json')]})())
finally:
    ingest.CORPUS = real_ingest_corpus
got = json.loads((CORP / 'index.json').read_text('utf-8'))
assert len([e for e in got['signs'] if e['word'] == '弟兄' and e['cat'] == 'church']) == 2
print('全部通過')
shutil.rmtree(TMP)
