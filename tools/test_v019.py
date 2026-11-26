"""v0.19 體驗修正測試（Playwright 直接從磁碟回應網站檔案）：
1. AI 詞序：召會用語被換掉（弟兄→兄弟、聚會→會）改回原詞＋字卡（攔截 /api/gloss 回「錯」的詞序）
2. 面對面字幕點詞 → 3 個候選 → 改正（逐字稿、改正資料）
3. 字幕放大／轉手機：畫布像素跟顯示大小一致（字幕不被裁掉）；底部按鈕有文字、長按有說明
4. 語料庫搜尋沒結果：清掉舊預覽、三個按鈕
截圖存 /home/claude/shots/v019_*.png"""
import json, mimetypes, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = 'https://tsl.test/'
OUT = pathlib.Path('/home/claude/shots'); OUT.mkdir(exist_ok=True)
GLOSS = {'今天晚上去聚會': ['今天', '晚上', '去', '會'], '弟兄姊妹平安': ['兄弟', '姊妹', '平安']}

def handle(route):
    url = route.request.url
    if url.startswith(BASE):
        path = url[len(BASE):].split('?')[0].split('#')[0] or 'index.html'
        if path == 'api/gloss':
            text = json.loads(route.request.post_data or '{}').get('text', '')
            g = GLOSS.get(text)
            return route.fulfill(status=200 if g else 503, content_type='application/json', body=json.dumps({'gloss': g, 'model': 'mock'} if g else {}))
        if path == 'api/fluent':
            body = json.loads(route.request.post_data or '{}')
            if 'cands' in body:
                return route.fulfill(status=200, content_type='application/json', body=json.dumps({'text': '我會游泳', 'pick': [c[0] for c in body['cands']], 'model': 'mock'}))
            return route.fulfill(status=200, content_type='application/json', body=json.dumps({'text': '（改正後）' + ''.join(body.get('gloss', [])), 'model': 'mock'}))
        if path.startswith('api/'): return route.fulfill(status=503, body='{}')
        f = ROOT / path
        if f.is_file():
            return route.fulfill(status=200, body=f.read_bytes(), content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
        return route.fulfill(status=404, body='')
    return route.continue_()

CANVAS_OK = """() => [...document.querySelectorAll('#f2fStage canvas')].map(c => { const r = c.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
  return [c.className || c.id, c.width, c.height, Math.round(r.width * d), Math.round(r.height * d)]; })"""

errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-angle=swiftshader', '--ignore-certificate-errors'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    ctx.add_init_script("try{localStorage.setItem('tsl-guided','1')}catch(e){}")
    ctx.route('**/*', handle)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(BASE + 'index.html')
    pg.wait_for_function('window.__tsl && window.__tsl.samples.length > 0', timeout=60000)
    pg.wait_for_timeout(6000)

    # ---- 1. AI 詞序：召會用語 ----
    for text, want in [('今天晚上去聚會', '聚會'), ('弟兄姊妹平安', '弟兄')]:
        pg.evaluate(f"window.__tsl.playText({json.dumps(text)})"); pg.wait_for_timeout(1200)
        info = pg.inner_text('#glossInfo'); chips = pg.eval_on_selector_all('#speechChips .chip', 'es => es.map(e => (e.classList.contains("card") ? "✍" : "") + e.textContent)')
        print(text, '→', info, chips)
        assert want in info and ('兄弟' not in info) and ('／會' not in info.replace('聚會', '')), info
        assert any(c.startswith('✍') and want in c for c in chips), chips
        pg.evaluate("window.__tsl.player.stop()")

    # ---- 2. 面對面：字幕點詞改正 ----
    pg.click('#btnF2F'); pg.wait_for_timeout(1200)
    labels = pg.eval_on_selector_all('.f2f-bar button', 'bs => bs.map(b => b.innerText.replace(/\\s+/g, " ").trim())')
    print('按鈕：', labels)
    assert any('離開' in l for l in labels) and any('開始' in l for l in labels) and any('下一句' in l for l in labels)
    pg.evaluate("""() => { const t = window.__tsl; const q = [[['我',.5],['你',.6],['他',.9]], [['跑步',.5],['游泳',.55],['走',1.2]], [['會',.4],['要',.8]]];
      for (const c of q) t.onSign([], c.map(([word, dist]) => ({ word, dist }))); }""")
    pg.wait_for_timeout(200)
    fws = pg.eval_on_selector_all('#f2fSign .fw', 'es => es.map(e => e.textContent)'); print('正在比：', fws)
    assert fws[:2] == ['我', '跑步'], fws
    pg.click('#f2fSign .fw >> nth=1'); pg.wait_for_timeout(200)
    assert pg.is_visible('#wordPick')
    opts = pg.eval_on_selector_all('#wpWords button', 'bs => bs.map(b => b.textContent)'); print('候選：', opts)
    assert opts == ['跑步', '游泳', '走'], opts
    pg.screenshot(path=str(OUT / 'v019_pick.png'))
    pg.click('#wpWords button[data-w="游泳"]'); pg.wait_for_timeout(300)
    assert not pg.is_visible('#wordPick')
    assert '游泳' in pg.inner_text('#f2fSign'), pg.inner_text('#f2fSign')
    # 說完這句 → 改已經說完那句的詞 → 重新轉通順中文
    pg.evaluate("window.__tsl.endSentence && window.__tsl.endSentence()") if pg.evaluate("!!window.__tsl.endSentence") else pg.wait_for_timeout(2500)
    pg.wait_for_timeout(800)
    print('說完：', pg.inner_text('#f2fSign').replace('\n', '｜'))
    pg.click('#f2fSign .fw >> nth=0'); pg.wait_for_timeout(200)
    pg.click('#wpWords button[data-w="你"]'); pg.wait_for_timeout(800)
    after = pg.inner_text('#f2fSign').replace('\n', '｜'); print('改正後：', after)
    assert '（改正後）你游泳會' in after, after
    c = pg.evaluate("window.__tsl.store.collectAll().then(a => a.filter(s => s.src === 'correct').map(s => [s.word, s.was]))")
    print('改正資料：', c); assert ['游泳', '跑步'] in c and ['你', '我'] in c

    # ---- 3. 字幕放大、轉手機：畫布不裁切 ----
    pg.evaluate("document.getElementById('f2fHear').textContent = '弟兄姊妹們好，今天晚上我們一起去聚會，聚會結束以後一起吃飯好不好，謝謝大家'")
    pg.evaluate("window.__tsl.playText('謝謝 朋友 再見')")
    for i in range(2): pg.click('#f2fSize'); pg.wait_for_timeout(300)
    pg.wait_for_timeout(600)
    cv = pg.evaluate(CANVAS_OK); print('放大後畫布：', cv)
    assert all(abs(w - cw) <= 2 and abs(h - ch) <= 2 for _, w, h, cw, ch in cv), cv
    pg.screenshot(path=str(OUT / 'v019_big_portrait.png'))
    pg.set_viewport_size({'width': 844, 'height': 390}); pg.wait_for_timeout(1200)
    pg.evaluate("window.__tsl.playText('謝謝 朋友')"); pg.wait_for_timeout(700)
    cv = pg.evaluate(CANVAS_OK); print('橫的：', cv)
    assert all(abs(w - cw) <= 2 and abs(h - ch) <= 2 for _, w, h, cw, ch in cv), cv
    # 橫的：右邊字幕最新一行看得到（沒被切到底下）
    vis = pg.evaluate("""() => { const c = document.querySelector('.f2f-caps').getBoundingClientRect(), h = document.getElementById('f2fHear').getBoundingClientRect();
      return [Math.round(h.bottom), Math.round(c.bottom)]; }""")
    print('橫的字幕底：', vis); assert vis[0] <= vis[1] + 1
    pg.screenshot(path=str(OUT / 'v019_big_landscape.png'))
    pg.set_viewport_size({'width': 390, 'height': 844}); pg.wait_for_timeout(1200)
    pg.evaluate("window.__tsl.playText('謝謝 朋友')"); pg.wait_for_timeout(700)
    cv = pg.evaluate(CANVAS_OK); print('轉回直的：', cv)
    assert all(abs(w - cw) <= 2 and abs(h - ch) <= 2 for _, w, h, cw, ch in cv), cv
    pg.screenshot(path=str(OUT / 'v019_back_portrait.png'))
    # 長按「✕」→ 說明
    box = pg.locator('#f2fExit').bounding_box()
    pg.mouse.move(box['x'] + 10, box['y'] + 10); pg.mouse.down(); pg.wait_for_timeout(800)
    tip = pg.inner_text('#toast'); pg.mouse.up(); print('長按說明：', tip)
    assert '離開' in tip and pg.is_visible('#f2f'), '長按不應該離開'
    pg.screenshot(path=str(OUT / 'v019_longpress.png'))
    pg.click('#f2fExit'); pg.wait_for_timeout(500)
    assert not pg.is_visible('#f2f')

    # ---- 4. 語料庫搜尋沒結果 ----
    pg.goto(BASE + 'index.html#corpus'); pg.wait_for_function('window.__tsl && window.__tsl.samples.length > 0', timeout=60000); pg.wait_for_timeout(1500)
    pg.fill('#corpusSearch', '謝謝'); pg.wait_for_timeout(300)
    pg.click('#wordList .word >> nth=0'); pg.wait_for_timeout(500)
    assert pg.is_visible('#previewBox')
    pg.fill('#corpusSearch', '哈利路亞'); pg.wait_for_timeout(300)
    assert not pg.is_visible('#previewBox'), '舊預覽沒清掉'
    assert pg.is_visible('#qRec') and pg.is_visible('#qWish') and pg.is_visible('.qempty a.btn')
    pg.screenshot(path=str(OUT / 'v019_corpus_empty.png'))
    pg.click('#qWish'); pg.wait_for_timeout(200)
    miss = pg.evaluate("JSON.parse(localStorage.getItem('tsl-miss') || '{}')"); print('收集清單：', miss); assert miss.get('哈利路亞', 0) >= 5
    pg.click('#qRec'); pg.wait_for_timeout(600)
    assert pg.evaluate("location.hash") == '#add' and pg.input_value('#recWord') == '哈利路亞'
    b.close()
print('errors:', errors); assert not errors
print('PASS')
