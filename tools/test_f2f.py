"""面對面模式測試：Playwright 直接從磁碟回應網站檔案（不開本機伺服器）。
假鏡頭（Chrome fake device）、語音辨識不測；測版面、進出模式、逐字稿、AI 通順（攔截 /api/fluent）。"""
import json, mimetypes, pathlib, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = 'https://tsl.test/'
OUT = pathlib.Path('/home/claude/shots'); OUT.mkdir(exist_ok=True)

def handle(route):
    url = route.request.url
    if url.startswith(BASE):
        path = url[len(BASE):].split('?')[0].split('#')[0] or 'index.html'
        if path == 'api/fluent':
            body = json.loads(route.request.post_data or '{}')
            g = body.get('gloss', [])
            return route.fulfill(status=200, content_type='application/json', body=json.dumps({'text': '我會游泳' if g == ['我', '游泳', '會'] else '（AI）' + ''.join(g), 'model': 'mock'}))
        if path == 'api/gloss':
            return route.fulfill(status=503, body='{}')
        f = ROOT / path
        if f.is_file():
            return route.fulfill(status=200, body=f.read_bytes(), content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
        return route.fulfill(status=404, body='')
    return route.continue_()

errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-angle=swiftshader', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, permissions=['camera', 'microphone'])
    ctx.add_init_script("try{localStorage.setItem('tsl-guided','1')}catch(e){}")
    ctx.route('**/*', handle)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: m.type == 'error' and errors.append('console: ' + m.text))
    pg.on('response', lambda r: r.status == 404 and errors.append('404: ' + r.url))
    pg.goto(BASE + 'index.html')
    pg.wait_for_function('window.__tsl && window.__tsl.samples.length > 0', timeout=60000)
    pg.wait_for_timeout(6000)   # 3D 主播載入
    pg.screenshot(path=str(OUT / '1_talk.png'))
    pg.click('#btnF2F')
    pg.wait_for_timeout(1500)
    assert pg.is_visible('#f2f'), 'f2f 沒出現'
    assert pg.evaluate("document.querySelector('#f2fStage canvas#avatar') !== null"), '主播沒移進面對面畫面'
    assert pg.evaluate("document.querySelector('#f2fPip video#camVideo') !== null"), '鏡頭沒移進小視窗'
    assert pg.evaluate("location.hash") == '#f2f'
    # 比一句
    pg.evaluate("window.__tsl.playText('你好 謝謝')")
    pg.evaluate("document.getElementById('f2fHear').textContent = '你好，謝謝'")
    pg.wait_for_timeout(1200)
    pg.screenshot(path=str(OUT / '2_f2f_signing.png'))
    # 手語 → 逐字稿＋AI 通順（模擬辨識出三個詞）
    pg.evaluate("""() => { const t = window.__tsl; t.recog.classify = (() => { const q = ['我','游泳','會']; let i = 0; return () => [{ word: q[i++ % 3], dist: 0.5 }]; })();
      for (let k = 0; k < 3; k++) t.onSign([]); }""")
    pg.wait_for_timeout(300)
    cur = pg.inner_text('#f2fSign')
    assert '我游泳會' in cur, cur
    pg.evaluate("window.__tsl.endSentence()")
    pg.wait_for_timeout(500)
    sign = pg.inner_text('#f2fSign')
    assert '我會游泳' in sign, sign
    assert pg.evaluate("window.__tsl.logLines.at(-1).t") == '我會游泳'
    pg.screenshot(path=str(OUT / '3_f2f_sign_fluent.png'))
    # 開始（假鏡頭）
    pg.click('#f2fGo')
    pg.wait_for_timeout(15000)
    pg.screenshot(path=str(OUT / '4_f2f_running.png'))
    st = pg.inner_text('#f2fGo'); print('go button:', st, '| status:', pg.inner_text('#f2fStatus'))
    # 離開
    pg.click('#f2fExit')
    pg.wait_for_timeout(800)
    assert not pg.is_visible('#f2f')
    assert pg.evaluate("document.querySelector('#pAvatar canvas#avatar') !== null"), '主播沒放回原處'
    assert pg.evaluate("document.getElementById('camVideo').closest('.card') !== null"), '鏡頭沒放回原處'
    print('hash after exit:', pg.evaluate('location.hash'))
    # 橫向
    pg.set_viewport_size({'width': 844, 'height': 390}); pg.click('#btnF2F'); pg.wait_for_timeout(1000)
    pg.screenshot(path=str(OUT / '5_f2f_landscape.png'))
    print('version:', pg.inner_text('#f2fVer'))
    b.close()
print('errors:', [e for e in errors if 'speech' not in e.lower()][:10])
print('PASS')
