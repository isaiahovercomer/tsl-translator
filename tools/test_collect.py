"""收集模式測試：假鏡頭開起來後，直接餵語料影格（手放下→比→手放下），看有沒有存起來、換下一個、上傳。"""
import json, mimetypes, pathlib
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parent.parent; BASE = 'https://tsl.test/'
OUT = pathlib.Path('/home/claude/shots'); OUT.mkdir(exist_ok=True)
posts = []
# 假的大家統計：寒暄清單每個詞都達標，只有「朋友」（3 次 1 人）、「再見」（10 次 1 人）不夠 → 最缺的先錄應該是 朋友、再見
import re
js = (ROOT / 'js/scenes.js').read_text('utf-8')
greet = re.search(r'export const CORE = `([^`]*)`', js).group(1).split() + re.search(r"greet: \{[^`]*`([^`]*)`", js).group(1).split()
STATS = {'v': 1, 'updated': '2026-11-26T14:00:00Z', 'files': 9, 'samples': 999, 'logs': 0,
         'signers': {f'p{i}': {'n': 100} for i in range(5)}, 'words': {w: {'n': 20, 's': {f'p{i}': 4 for i in range(5)}} for w in greet}}
STATS['words']['朋友'] = {'n': 3, 's': {'p0': 3}}; STATS['words']['再見'] = {'n': 10, 's': {'p1': 10}}
def handle(route):
    url = route.request.url
    if url.startswith(BASE):
        path = url[len(BASE):].split('?')[0].split('#')[0] or 'index.html'
        if path == 'api/collect':
            if route.request.method == 'GET' and 'stats' in url: return route.fulfill(status=200, content_type='application/json', body=json.dumps(STATS))
            if route.request.method == 'GET': return route.fulfill(status=200, content_type='application/json', body='{"ready":true,"code":false}')
            posts.append(json.loads(route.request.post_data)); return route.fulfill(status=200, content_type='application/json', body='{"ok":true}')
        if path.startswith('api/'): return route.fulfill(status=503, body='{}')
        f = ROOT / path
        if f.is_file(): return route.fulfill(status=200, body=f.read_bytes(), content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
        return route.fulfill(status=404, body='')
    return route.continue_()
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-angle=swiftshader', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, permissions=['camera'])
    ctx.add_init_script("try{localStorage.setItem('tsl-guided','1')}catch(e){}")
    ctx.route('**/*', handle); pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: m.type in ('error', 'warning') and print('console:', m.text[:200]))
    pg.goto(BASE + 'index.html#add'); pg.wait_for_function('window.__tsl && window.__tsl.samples.length > 0', timeout=60000)
    pg.click('#btnCollect'); pg.wait_for_timeout(300)
    pg.fill('#colSigner', '測試-A'); pg.select_option('#colList', 'w:greet'); pg.select_option('#colReps', '2')
    pg.screenshot(path=str(OUT / 'col1_setup.png'))
    pg.click('#colStart')   # 沒勾同意 → 不能開始
    assert pg.is_visible('#colSetup')
    pg.check('#colConsent'); pg.click('#colStart')
    pg.wait_for_function("['wait','ready'].includes(window.__collect.state)", timeout=90000)
    first = pg.inner_text('#colWord'); print('第一個詞：', first, pg.inner_text('#colProg'))
    assert first == '朋友', '最缺的應該排第一個'
    # 用語料「好」（ccu901）的影格當比的動作
    pg.evaluate("""async () => { const t = window.__tsl, s = t.samples.find(x => x.id === 'ccu901'); await t.store.loadSample(s);
      const { sampleFrames } = await import('./js/core.js'); window.__fr = sampleFrames(s); }""")
    for rep in range(2):
        pg.evaluate("""() => { const c = window.__collect, fr = window.__fr, rest = new Float32Array(fr[0]); for (let k = 15 * 3; k < 57 * 3; k++) rest[k] = NaN;   // 手放下（沒有手）
          for (let i = 0; i < 8; i++) c.feed(rest);            // 手放下 → 準備好
          for (const f of fr) c.feed(f);                       // 比
          for (let i = 0; i < 12; i++) c.feed(rest); }""")    # 手放下 → 錄好
        pg.wait_for_timeout(300)
        print(errors[-2:]); print('第', rep + 1, '次後：', pg.evaluate("[window.__collect.state, window.__collect.idx, window.__collect.take]"), pg.inner_text('#colState'))
        if rep == 0: pg.screenshot(path=str(OUT / 'col2_rec.png'))
    pg.wait_for_timeout(1200)
    assert pg.evaluate("window.__collect.idx") == 1, '沒有換下一個詞'
    second = pg.inner_text('#colWord'); print('第二個詞：', second); assert second == '再見'
    n = pg.evaluate("window.__tsl.store.collectAll().then(a => a.length)"); print('存了', n, '次'); assert n == 2
    pg.click('#colEnd'); pg.wait_for_timeout(1500)
    assert posts and len(posts[-1]['samples']) == 2 and posts[-1]['signer'] == '測試-A' and posts[-1]['consent'] is True, posts
    print('上傳：', [(s['word'], s['kind'], s['take'], s['frames']) for s in posts[-1]['samples']])
    pg.screenshot(path=str(OUT / 'col3_after.png'))
    print('pending：', pg.inner_text('#colPending'))
    pg.select_option('#colList', 'w:greet'); pg.click('#colStatsBtn'); pg.wait_for_selector('#colStats table tr')
    txt = pg.inner_text('#colStats'); print(txt[:220].replace('\n', ' | '))
    assert '大家一共錄了 999 次' in txt and '達標' in txt
    rows = pg.eval_on_selector_all('#colStats tr', 'r => r.map(x => x.innerText.replace(/\\s+/g, " "))')
    print('前三列：', rows[:3]); assert rows[0].startswith('再見') and rows[1].startswith('朋友 5 次 2 人 你 2'), '自己剛錄的也要算進去'
    pg.eval_on_selector('#colStats', 'e => e.scrollIntoView()'); pg.wait_for_timeout(200); pg.screenshot(path=str(OUT / 'col4_stats.png'))
    # 關掉「最缺的先錄」→ 照清單順序（第一個是「我」）
    pg.uncheck('#colSmart'); pg.click('#colStart'); pg.wait_for_function("['wait','ready'].includes(window.__collect.state)", timeout=60000)
    w = pg.inner_text('#colWord'); print('照順序第一個：', w); assert w != '朋友'
    pg.click('#colEnd'); pg.wait_for_timeout(500)
    b.close()
print('errors:', errors); assert not errors
print('PASS')
