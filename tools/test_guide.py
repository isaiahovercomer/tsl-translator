import pathlib, mimetypes
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parent.parent; BASE = 'https://tsl.test/'
def handle(route):
    u = route.request.url
    if u.startswith(BASE):
        path = u[len(BASE):].split('?')[0].split('#')[0] or 'index.html'
        if path.startswith('api/'): return route.fulfill(status=503, body='{}')
        f = ROOT / path
        if f.is_file(): return route.fulfill(status=200, body=f.read_bytes(), content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
        return route.fulfill(status=404, body='')
    return route.continue_()
def run(name, args, perms, ua=None, url='index.html'):
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-angle=swiftshader'] + args)
        kw = dict(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True, service_workers='block', permissions=perms)
        if ua: kw['user_agent'] = ua
        ctx = b.new_context(**kw); ctx.route('**/*', handle); pg = ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        nav = []; pg.on('framenavigated', lambda f: f == pg.main_frame and nav.append(f.url))
        pg.goto(BASE + url); pg.wait_for_timeout(2500)
        if ua: print(name, '網址變成：', nav[-1]); b.close(); return
        print(name, '使用說明出現：', pg.is_visible('#guide'))
        for i in range(3): pg.screenshot(path=f'/tmp/t/g_{name}_{i}.png'); pg.click('#guideNext'); pg.wait_for_timeout(400)
        pg.wait_for_timeout(800)
        if pg.is_visible('#btnPerm'): pg.click('#btnPerm'); pg.wait_for_timeout(2500)
        else: print(name, '已允許，顯示：', pg.inner_text('#permOk'))
        print(name, pg.inner_text('#permCam'), '|', pg.inner_text('#permMic'), '| 說明框顯示：', pg.is_visible('#permHelp'))
        pg.screenshot(path=f'/tmp/t/g_{name}_3.png')
        pg.click('#guideNext'); pg.wait_for_timeout(400); pg.click('#btnInstall2'); pg.wait_for_timeout(300)
        pg.screenshot(path=f'/tmp/t/g_{name}_4.png')
        pg.click('#guideNext'); pg.wait_for_timeout(400)
        print(name, '關掉後：', not pg.is_visible('#guide'), '| 首頁警告：', pg.is_visible('#permWarn'), '| 安裝鈕：', pg.is_visible('#btnInstall'))
        pg.screenshot(path=f'/tmp/t/g_{name}_home.png')
        if name == 'deny':
            pg.click('#btnStart'); pg.wait_for_timeout(800); print(name, '按開始→跳到權限頁：', pg.is_visible('#guide'), pg.is_visible('#btnPerm'))
        pg.reload(); pg.wait_for_timeout(1500); print(name, '第二次打開不再自動跳出：', not pg.is_visible('#guide'))
        print(name, 'errors:', errs[:3]); b.close()
run('allow', ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'], ['camera','microphone'])
run('deny', ['--use-fake-device-for-media-stream','--deny-permission-prompts'], [])
run('line', [], [], ua='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.3.0')
