"""手譯員手指檢查：比指定的詞，停在中間某一格，截手譯員＋同一格骨架資料的手（右邊小圖）。
python3 tools/shot_hands.py 三 五 八 好 [--tag before] → /home/claude/shots/hand_<詞>_<tag>.png"""
import sys, mimetypes, pathlib
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parent.parent; BASE = 'https://tsl.test/'
OUT = pathlib.Path('/home/claude/shots'); OUT.mkdir(exist_ok=True)
args = sys.argv[1:]; tag = 'x'
if '--tag' in args: i = args.index('--tag'); tag = args[i + 1]; args = args[:i] + args[i + 2:]
words = args or ['三', '五', '八', '好']
def handle(route):
    url = route.request.url
    if url.startswith(BASE):
        path = url[len(BASE):].split('?')[0].split('#')[0] or 'index.html'
        f = ROOT / path
        if path.startswith('api/'): return route.fulfill(status=503, body='{}')
        if f.is_file(): return route.fulfill(status=200, body=f.read_bytes(), content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
        return route.fulfill(status=404, body='')
    return route.continue_()
DRAW = """([pos]) => { const t = window.__tsl, p = t.player; p.pause();
  const tl = p.timeline; const idx = tl.map((x, i) => [x, i]).filter(([x]) => x.word);
  const [x, i] = idx[Math.floor(idx.length * pos)]; p.t0 = p.pausedAt - i / 15 / p.speed * 1000;
  // 右下角畫這一格的手（資料）
  let c = document.getElementById('dbg'); if (!c) { c = document.createElement('canvas'); c.id = 'dbg'; c.width = 360; c.height = 360; c.style.cssText = 'position:fixed;right:0;top:130px;z-index:2147483647;background:#fff;border:2px solid #333;width:160px;height:160px'; (document.getElementById('f2f') || document.body).appendChild(c); }
  const g = c.getContext('2d'); g.clearRect(0, 0, 360, 360); const f = x.f;
  const CH = [[0,1,2,3,4],[0,5,6,7,8],[5,9,10,11,12],[9,13,14,15,16],[13,17,18,19,20],[0,17]];
  for (const [off, col, ox] of [[15, '#1976d2', 260], [36, '#e64a19', 130]]) { if (Number.isNaN(f[off*3])) continue;
    const wx = f[off*3], wy = f[off*3+1]; g.strokeStyle = col; g.lineWidth = 3;
    for (const ch of CH) { g.beginPath(); ch.forEach((j, k) => { const X = ox - (f[(off+j)*3] - wx) * 1500, Y = 300 + (f[(off+j)*3+1] - wy) * 1500; k ? g.lineTo(X, Y) : g.moveTo(X, Y); }); g.stroke(); } }
  return x.word; }"""
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-angle=swiftshader', '--ignore-certificate-errors'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    ctx.add_init_script("try{localStorage.setItem('tsl-guided','1')}catch(e){}")
    ctx.route('**/*', handle); pg = ctx.new_page()
    pg.goto(BASE + 'index.html'); pg.wait_for_function('window.__tsl && window.__tsl.samples.length > 0', timeout=60000)
    pg.click('#btnF2F'); pg.wait_for_timeout(9000)
    for w in words:
        pg.evaluate("w => window.__tsl.playText(w)", w)
        pg.wait_for_function("window.__tsl.player.timeline.some(x => x.word)", timeout=30000); pg.evaluate("window.__tsl.player.pause()")
        for pos in (0.45, 0.75):
            pg.evaluate(DRAW, [pos]); pg.wait_for_timeout(1200)
            pg.screenshot(path=str(OUT / f'hand_{w}_{int(pos*100)}_{tag}.png'), clip={'x': 0, 'y': 120, 'width': 390, 'height': 300})
        pg.evaluate("window.__tsl.player.stop(); window.__tsl.player.resume()")
    b.close()
print('ok')
