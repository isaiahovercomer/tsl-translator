"""v0.15 測試：背景執行緒辨識（餵真實語料影格）、辨識紀錄、改正存進收集資料。"""
import json, mimetypes, pathlib, sys
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parent.parent; BASE = 'https://tsl.test/'
HASH = sys.argv[1] if len(sys.argv) > 1 else ''
def handle(route):
    url = route.request.url
    if url.startswith(BASE):
        path = url[len(BASE):].split('?')[0].split('#')[0] or 'index.html'
        if path == 'api/fluent': return route.fulfill(status=200, content_type='application/json', body=json.dumps({'text': '（AI 句子）', 'pick': [], 'model': 'mock'}))
        if path.startswith('api/'): return route.fulfill(status=503, body='{}')
        f = ROOT / path
        if f.is_file(): return route.fulfill(status=200, body=f.read_bytes(), content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
        return route.fulfill(status=404, body='')
    return route.continue_()
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-angle=swiftshader', '--ignore-certificate-errors'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}); ctx.add_init_script("try{localStorage.setItem('tsl-guided','1')}catch(e){}")
    ctx.route('**/*', handle); pg = ctx.new_page(); pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: m.type == 'warning' and '背景' in m.text and print('console:', m.text))
    pg.goto(BASE + 'index.html' + HASH); pg.wait_for_function('window.__tsl && window.__tsl.samples.length > 0', timeout=60000)
    pg.evaluate("window.__tsl.attachFeats()"); pg.wait_for_function("window.__tsl.recog.items.length > 1000", timeout=60000)
    print('背景執行緒：', pg.evaluate("window.__tsl.spot.worker"))
    # 寒暄情境裡的 3 個詞，用語料影格接成一句（中間手放下）
    got = pg.evaluate("""async () => {
      const t = window.__tsl, { sampleFrames } = await import('./js/core.js');
      const want = ['謝謝', '朋友', '再見'], seq = [];
      for (const w of want) { const s = t.samples.find(x => x.word === w && x.shared); await t.store.loadSample(s); seq.push(sampleFrames(s)); }
      const rest = new Float32Array(seq[0][0]); for (let k = 15 * 3; k < 57 * 3; k++) rest[k] = NaN;
      const feed = f => t.spot.push(f);
      for (let i = 0; i < 6; i++) feed(rest);
      for (const fr of seq) { for (const f of fr) feed(f); for (let i = 0; i < 8; i++) feed(rest); }
      await new Promise(r => setTimeout(r, 3500));
      return { log: t.logLines.map(l => l.g + (l.t ? '｜' + l.t : '')), want };
    }""")
    print('比：', got['want'], '→ 逐字稿：', got['log'])
    st = pg.evaluate("window.__tsl.showRecStats().then(s => ({ sentences: s.sentences, slots: s.slots, last: s.logs.at(-1) }))")
    print('辨識紀錄：', st['sentences'], '句', st['slots'], '個手勢'); print('  最後一句：', json.dumps(st['last'], ensure_ascii=False)[:300])
    assert st['sentences'] >= 1
    print('設定頁統計：', pg.evaluate("document.getElementById('recStats').textContent"))
    # 改正：模擬詞卡改正 → 收集資料多一筆 src=correct
    pg.evaluate("""() => { const t = window.__tsl; t.onSign(window.__fr0 || [], [{ word: '你', dist: 0.5 }, { word: '我', dist: 0.6 }]); }""")
    pg.once('dialog', lambda d: d.accept('我'))
    pg.click('#signChips .chip'); pg.wait_for_timeout(500)
    c = pg.evaluate("window.__tsl.store.collectAll().then(a => a.filter(s => s.src === 'correct').map(s => [s.word, s.was]))")
    print('改正：', c); assert c and c[-1] == ['我', '你']
    b.close()
print('errors:', errors); assert not errors
print('PASS')
