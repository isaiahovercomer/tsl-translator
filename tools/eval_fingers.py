"""手指準確度：手譯員每根手指彎曲角度（手腕→指根 vs 指根→第三節）跟骨架資料比，算平均誤差（度）。
python3 tools/eval_fingers.py [詞...]   # 預設比較：目前做法 vs #fingerlimit；也可給 '名稱=#網址參數;…'"""
import sys, mimetypes, pathlib, json
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parent.parent; BASE = 'https://tsl.test/'
words = [w for w in sys.argv[1:] if '=' not in w] or ['三', '五', '八', '四', '好', '七', '九', '六', '謝謝', '我', '你', '什麼', '喜歡', '朋友']
def handle(route):
    url = route.request.url
    if url.startswith(BASE):
        path = url[len(BASE):].split('?')[0].split('#')[0] or 'index.html'
        f = ROOT / path
        if path.startswith('api/'): return route.fulfill(status=503, body='{}')
        if f.is_file(): return route.fulfill(status=200, body=f.read_bytes(), content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
        return route.fulfill(status=404, body='')
    return route.continue_()
MEASURE = """([pos]) => { const t = window.__tsl, p = t.player, r = p.r3d, b = r.b;
  const tl = p.timeline, idx = tl.map((x, i) => [x, i]).filter(([x]) => x.word); if (!idx.length) return null;
  const [x, i] = idx[Math.floor(idx.length * pos)]; p.t0 = p.pausedAt - i / 15 / p.speed * 1000;
  return x.f ? Array.from(x.f) : null; }"""
AV = """() => { const r = window.__tsl.player.r3d, b = r.b, out = {}; const W = o => { const v = o.getWorldPosition(new o.position.constructor()); return [v.x, v.y, v.z]; };
  for (const side of ['Left', 'Right']) { const h = b[side + 'Hand']; if (!h) continue; const w = W(h);
    out[side] = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'].map(n => { const m = b[side + 'Hand' + n + '1'], d = b[side + 'Hand' + n + '3']; if (!m || !d) return null;
      const M = W(m), D = W(d), u = M.map((v, k) => v - w[k]), v = D.map((q, k) => q - M[k]);
      const c = u.reduce((s, q, k) => s + q * v[k], 0) / Math.hypot(...u) / Math.hypot(...v); return Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI; }); }
  return out; }"""
def data_angles(f, off):
    import math
    if f[off * 3] != f[off * 3]: return None
    P = lambda j: [f[(off + j) * 3], f[(off + j) * 3 + 1], f[(off + j) * 3 + 2]]
    res = []
    for m, d in [(1, 3), (5, 7), (9, 11), (13, 15), (17, 19)]:
        u = [a - b for a, b in zip(P(m), P(0))]; v = [a - b for a, b in zip(P(d), P(m))]
        c = sum(a * b for a, b in zip(u, v)) / (math.hypot(*u) * math.hypot(*v) + 1e-9)
        res.append(math.degrees(math.acos(max(-1, min(1, c)))))
    return res
def run(hashpart):
    errs = []
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-angle=swiftshader', '--ignore-certificate-errors'])
        ctx = b.new_context(viewport={'width': 390, 'height': 844}); ctx.add_init_script("try{localStorage.setItem('tsl-guided','1')}catch(e){}")
        ctx.route('**/*', handle); pg = ctx.new_page(); pg.goto(BASE + 'index.html' + hashpart)
        pg.wait_for_function('window.__tsl && window.__tsl.samples.length > 0 && window.__tsl.player.r3d && window.__tsl.player.r3d.ready', timeout=90000)
        for w in words:
            pg.evaluate("w => window.__tsl.playText(w)", w)
            try: pg.wait_for_function("window.__tsl.player.timeline.some(x => x.word)", timeout=20000)
            except Exception: continue
            pg.evaluate("window.__tsl.player.pause()")
            for pos in (0.3, 0.5, 0.7):
                f = pg.evaluate(MEASURE, [pos]);
                if not f: continue
                pg.wait_for_timeout(700)   # 平滑收斂
                av = pg.evaluate(AV)
                for side, off in (('Left', 15), ('Right', 36)):
                    da = data_angles(f, off)
                    if not da or side not in av: continue
                    for k in range(1, 5): errs.append(abs(av[side][k] - da[k]))
            pg.evaluate("window.__tsl.player.stop(); window.__tsl.player.resume()")
        b.close()
    return errs
for name, h in [x.split('=', 1) for x in (sys.argv[1] if len(sys.argv) > 1 and '=' in sys.argv[1] else '目前（沒有關節限制）=;關節限制=#fingerlimit').split(';')]:
    e = run(h); e.sort()
    print(f'{name}: {len(e)} 個手指，平均誤差 {sum(e)/len(e):.1f}°，中位數 {e[len(e)//2]:.1f}°，>30° 的 {100*sum(x>30 for x in e)/len(e):.0f}%')
