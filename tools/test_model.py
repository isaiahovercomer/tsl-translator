"""v0.17 測試：網站接上辨識模型（onnxruntime-web）。餵真實語料影格，模型模式／DTW 模式都要認得出、紀錄有 eng 與 dtw。
用法：python3 tools/test_model.py [#noworker]"""
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
FEED = """async (want) => {
  const t = window.__tsl, { sampleFrames } = await import('./js/core.js');
  const seq = [];
  for (const w of want) { const s = t.samples.find(x => x.word === w && x.shared); await t.store.loadSample(s); seq.push(sampleFrames(s)); }
  const rest = new Float32Array(seq[0][0]); for (let k = 15 * 3; k < 57 * 3; k++) rest[k] = NaN;
  const feed = f => t.spot.push(f);
  for (let i = 0; i < 6; i++) feed(rest);
  for (const fr of seq) { for (const f of fr) feed(f); for (let i = 0; i < 8; i++) feed(rest); }
  await new Promise(r => setTimeout(r, 3500));
  const s = await t.showRecStats();
  return { log: t.logLines.at(-1), last: s.logs.at(-1) };
}"""
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-angle=swiftshader', '--ignore-certificate-errors'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}); ctx.add_init_script("try{localStorage.setItem('tsl-guided','1')}catch(e){}")
    ctx.route('**/*', handle); pg = ctx.new_page(); pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: m.type in ('warning', 'error') and print('console:', m.text[:200]))
    pg.goto(BASE + 'index.html' + HASH); pg.wait_for_function('window.__tsl && window.__tsl.samples.length > 0', timeout=60000)
    pg.evaluate("window.__tsl.attachFeats()"); pg.wait_for_function("window.__tsl.recog.items.length > 1000", timeout=60000)
    print('背景執行緒：', pg.evaluate("window.__tsl.spot.worker"))
    pg.evaluate("window.__tsl.useEngine()")
    pg.wait_for_function("['ready','error'].includes(window.__tsl.spot.model.state)", timeout=120000)
    print('模型：', pg.evaluate("JSON.stringify(window.__tsl.spot.model)"), '｜', pg.evaluate("document.getElementById('engInfo').textContent"))
    assert pg.evaluate("window.__tsl.spot.model.state") == 'ready'
    want = ['謝謝', '朋友', '再見']
    r = pg.evaluate(FEED, want)
    print('模型模式：', want, '→', r['log']); print('  紀錄：', json.dumps(r['last'], ensure_ascii=False)[:600])
    assert r['last']['eng'] == 'model-v1' and any('dtw' in s for s in r['last']['slots'])
    print('  模型每次：', pg.evaluate("window.__tsl.spot.model.ms"), 'ms')
    # 切回 DTW
    pg.evaluate("() => { document.getElementById('recogEngine').value = 'dtw'; document.getElementById('saveSettings').click(); }")
    pg.evaluate("window.__tsl.useEngine()")
    r2 = pg.evaluate(FEED, want)
    print('DTW 模式：', want, '→', r2['log']); assert r2['last']['eng'] == 'dtw' and not any('dtw' in s for s in r2['last']['slots'])
    b.close()
print('errors:', errors); assert not errors
print('PASS')
