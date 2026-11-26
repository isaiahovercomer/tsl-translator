import pathlib, mimetypes, sys
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parent.parent; BASE = 'https://tsl.test/'
OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/home/claude/ux'); OUT.mkdir(exist_ok=True)
def handle(route):
    u = route.request.url
    if u.startswith(BASE):
        path = u[len(BASE):].split('?')[0].split('#')[0] or 'index.html'
        if path.startswith('api/'): return route.fulfill(status=503, body='{}')
        f = ROOT / path
        if f.is_file(): return route.fulfill(status=200, body=f.read_bytes(), content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
        return route.fulfill(status=404, body='')
    return route.continue_()
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-angle=swiftshader','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
    ctx = b.new_context(viewport={'width':390,'height':844}, device_scale_factor=1, is_mobile=True, has_touch=True, permissions=['camera','microphone'], service_workers='block')
    ctx.add_init_script("try{localStorage.setItem('tsl-guided','1')}catch(e){}")
    ctx.route('**/*', handle); pg = ctx.new_page()
    pg.goto(BASE + 'index.html'); pg.wait_for_function("window.__tsl && window.__tsl.samples.length > 0", timeout=60000); pg.wait_for_timeout(5000)
    for v in ['talk','corpus','add','settings']:
        pg.evaluate(f"location.hash='#{v}'"); pg.wait_for_timeout(1200)
        pg.screenshot(path=str(OUT / f'{v}.png'), full_page=True)
    pg.evaluate("location.hash='#talk'"); pg.wait_for_timeout(500); pg.click('#btnStart'); pg.wait_for_timeout(9000)
    pg.screenshot(path=str(OUT / 'f2f.png'))
    b.close()
