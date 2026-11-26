"""v0.18 測試：說話 → 手譯員的缺詞處理（字卡）、常缺的詞記錄、收集清單「說話時手譯員比不出來的詞」。
用法：python3 tools/test_missing.py（截圖存 /tmp/miss_*.png）"""
import json, mimetypes, pathlib
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parent.parent; BASE = 'https://tsl.test/'
def handle(route):
    url = route.request.url
    if url.startswith(BASE):
        path = url[len(BASE):].split('?')[0].split('#')[0] or 'index.html'
        if path.startswith('api/'): return route.fulfill(status=503, body='{}')
        f = ROOT / path
        if f.is_file(): return route.fulfill(status=200, body=f.read_bytes(), content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
        return route.fulfill(status=404, body='')
    if 'raw.githubusercontent.com' in url: return route.fulfill(status=404, body='')
    return route.continue_()
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-angle=swiftshader', '--ignore-certificate-errors'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}); ctx.add_init_script("try{localStorage.setItem('tsl-guided','1');localStorage.setItem('tsl-settings', JSON.stringify({glossMode:'rule'}))}catch(e){}")
    ctx.route('**/*', handle); pg = ctx.new_page(); pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(BASE + 'index.html'); pg.wait_for_function('window.__tsl && window.__tsl.samples.length > 0', timeout=60000)
    # 斷詞＋字卡
    r = pg.evaluate("""async () => {
      const t = window.__tsl, out = {};
      for (const s of ['弟兄姐妹們好', '我們今天晚上去聚會', '你好，歡迎來到召會', '我們一起讀聖經禱告', '耶穌基督是主']) {
        const g = await t.glossTokens(s);
        out[s] = g.toks.map(x => x.card ? '[' + x.text + ']' : x.known ? x.word : '?' + x.text).join('/');
      }
      return out;
    }""")
    for k, v in r.items(): print(k, '→', v)
    assert '[弟兄]' in r['弟兄姐妹們好'] and '姊妹' in r['弟兄姐妹們好'] and '[召會]' in r['你好，歡迎來到召會']
    # 播放：時間軸裡有字卡
    pg.evaluate("window.__tsl.playText('我們今天晚上去聚會')")
    pg.wait_for_function("window.__tsl.player.timeline.some(x => x.card)", timeout=20000)
    tl = pg.evaluate("[...new Set(window.__tsl.player.timeline.map(x => (x.card ? '✍' : '') + (x.word || '')))].filter(Boolean)")
    print('時間軸：', tl); assert '✍聚會' in tl
    chips = pg.evaluate("[...document.querySelectorAll('#speechChips .chip')].map(c => c.className + ':' + c.textContent)")
    print('詞卡：', chips); assert any('card' in c and '聚會' in c for c in chips)
    pg.wait_for_function("window.__tsl.player.lastWord === '聚會'", timeout=20000); pg.evaluate("window.__tsl.player.pause()"); pg.wait_for_timeout(400)
    pg.locator('#avatar').screenshot(path='/tmp/miss_3d.png'); pg.evaluate("window.__tsl.player.stop()")
    miss = pg.evaluate("JSON.parse(localStorage.getItem('tsl-miss'))"); print('缺詞紀錄：', miss); assert miss.get('聚會')
    # 2D 手譯員也畫得出字卡
    pg.evaluate("async () => { await window.__tsl.player.set3D(null); window.__tsl.player.style = 'f1'; }")
    pg.evaluate("window.__tsl.playText('弟兄你好')")
    pg.wait_for_function("window.__tsl.player.lastWord === '弟兄'", timeout=20000); pg.evaluate("window.__tsl.player.pause()"); pg.wait_for_timeout(400)
    pg.locator('#avatar').screenshot(path='/tmp/miss_2d.png'); pg.evaluate("window.__tsl.player.stop()")
    # 收集清單
    pg.evaluate("document.getElementById('btnCollect').click()")
    opts = pg.evaluate("[...document.querySelectorAll('#colList option')].map(o => o.value)"); assert 'w:asked' in opts
    pg.select_option('#colList', 'w:asked'); pg.click('#colStatsBtn'); pg.wait_for_timeout(1500)
    st = pg.evaluate("document.getElementById('colStats').innerText"); print('收集進度：', st[:200].replace('\n', ' ｜ '))
    assert '聚會' in st and '弟兄' in st
    b.close()
print('errors:', errors); assert not errors
print('PASS')
