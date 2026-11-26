# 雲端語音辨識測試：網站檔案從磁碟（本機修改版），/api/* 走線上；假麥克風播 /tmp/t/mic.wav（兩句、中間停 1.5 秒，循環）
from playwright.sync_api import sync_playwright
import time, pathlib, mimetypes
ROOT = pathlib.Path(__file__).resolve().parent.parent; BASE = 'https://tslinterpreter.pages.dev/'
def handle(route):
    u = route.request.url
    if u.startswith(BASE) and '/api/' not in u:
        path = u[len(BASE):].split('?')[0].split('#')[0] or 'index.html'; f = ROOT / path
        if f.is_file(): return route.fulfill(status=200, body=f.read_bytes(), content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
    return route.continue_()
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-angle=swiftshader','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture=/tmp/t/mic.wav','--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width':390,'height':844}, permissions=['microphone','camera'], service_workers='block')
    ctx.route('**/*', handle)
    pg = ctx.new_page(); errs=[]; t0=[None]
    pg.on('pageerror', lambda e: errs.append(str(e)))
    lat=[]; pend={}
    pg.on('request', lambda r: '/api/stt' in r.url and pend.__setitem__(r, time.time()))
    pg.on('requestfinished', lambda r: r in pend and lat.append(round(time.time()-pend[r],2)))
    pg.goto(BASE + 'index.html')
    pg.wait_for_function("window.__tsl && window.__tsl.samples.length > 0", timeout=60000)
    pg.wait_for_timeout(2000)
    pg.click('#btnListen'); start=pg.evaluate('performance.now()')
    pg.wait_for_timeout(33000)
    pg.click('#btnListen')
    for ms, t in pg.evaluate('window.__heard || []'): print(f'{(ms-start)/1000:5.1f}s  {t}')
    print('畫面：', pg.inner_text('#speechText'))
    print('每次辨識耗時（秒）：', lat)
    print('errors:', errs[:5])
    b.close()
