// Cloudflare Pages Function：/api/fluent — 台灣手語詞序（辨識出來的手勢詞）→ 通順的中文句子，用 Cloudflare Workers AI
// POST {gloss: string[]}  或  GET ?gloss=我/游泳/會   →  {text, model}
// 做法：/api/gloss 的反方向。從中正辭典 546 句例句（gloss ↔ 中文）挑最像的 12 句當範例，請 AI 改寫成口語中文。
// v0.13 候選模式：POST {cands: [[詞1,詞2,詞3], ...], scene?: '聚會'} → {text, pick: [...], model}
//   鏡頭辨識每段留前 3 個候選（第一個最像），AI 從每段挑一個（或略過）組成最通順的句子。
// 綁定：wrangler.toml 的 [ai] binding = "AI"（不用 API 金鑰）。可用環境變數 FLUENT_MODEL 換模型。
const MODELS = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct-fast'];
let EX = null;

const RULES = `你是台灣手語（TSL）翻譯員。使用者給你一串台灣手語的手勢詞（Gloss，用「/」分開，是手語的詞序），請翻成一句自然、通順的台灣華語口語句子，要唸給聽人聽。
規則：
1. 台灣手語常把時間詞放句首、話題／受詞提前、否定詞／助動詞／疑問詞放句尾、「很」放形容詞後、數字放名詞後；翻成中文要改回中文詞序。
2. 疑問詞或「有沒有」在句尾 → 翻成問句（加「嗎」「呢」或改成「有沒有…」），句尾用「？」。
3. 補上需要的虛詞（的、了、是、在、嗎…），但不要加手語沒有的意思，不要猜太多。
4. 重複的詞（例如 他/要/陪伴/他）只是手語的指示，翻譯時合併。
5. 「？」代表沒辨識出來的手勢，直接省略。
6. 用繁體中文，只輸出翻好的一句話，不要解釋、不要加引號。`;

const RULES_C = `你是台灣手語（TSL）翻譯員。鏡頭辨識手語時，每個手勢會給你 1～3 個候選詞（依辨識相似度排序，第一個最像，但常常認錯）。
請從每個位置挑一個候選詞（真的都不合理可以略過那個位置），使整串詞最合理，再翻成一句自然、通順的台灣華語口語句子，要唸給聽人聽。
規則：
1. 台灣手語常把時間詞放句首、話題／受詞提前、否定詞／助動詞／疑問詞放句尾、「很」放形容詞後；翻成中文要改回中文詞序。
2. 疑問詞或「有沒有」在句尾 → 翻成問句。補上需要的虛詞，但不要加候選詞沒有的意思。
3. 沒有特別理由就選第一個候選；第一個讓句子不通、而後面的候選明顯更合理時才換。
4. 只輸出一行 JSON：{"pick":["挑的詞",...],"text":"中文句子"}，pick 依原本順序、略過的位置不放。用繁體中文。`;
// 用辭典例句做候選模式範例：每個詞配 2 個別句的詞當干擾，正確詞大多排第一、偶爾第二
function hash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
function candExample(zh, gl, pool) {
  const ws = gl.split('/'), slots = [];
  ws.forEach((w, i) => {
    const h = hash(zh + i), d1 = pool[h % pool.length], d2 = pool[(h >>> 8) % pool.length];
    const others = [d1, d2].filter(x => x !== w);
    const pos = h % 5 === 0 ? 1 : 0;
    const slot = [...others]; slot.splice(pos, 0, w); slots.push(slot.slice(0, 3));
  });
  return [slots.map(s => s.join('|')).join(' / '), JSON.stringify({ pick: ws, text: zh })];
}
const fmtCands = c => c.map(s => s.join('|')).join(' / ');

function bigrams(s) { const b = new Set(); for (let i = 0; i + 1 < s.length; i++) b.add(s.slice(i, i + 2)); for (const c of s) b.add(c); return b; }
function topExamples(q0, k = 12, loo = false) {
  const q = bigrams(q0.replace(/\//g, ''));
  return EX.filter(e => !loo || e[1] !== q0).map(e => { let n = 0; for (const g of bigrams(e[1].replace(/\//g, ''))) if (q.has(g)) n++; return [n / Math.sqrt(e[1].length + 1), e]; })
    .sort((a, b) => b[0] - a[0]).slice(0, k).map(x => x[1]).reverse();
}

async function run(env, model, messages) {
  const r = await env.AI.run(model, { messages, max_tokens: 120, temperature: 0.1 });
  let s = typeof r === 'string' ? r : r?.response ?? r?.choices?.[0]?.message?.content ?? '';
  if (typeof s !== 'string') s = JSON.stringify(s);
  return s.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
const parse = s => (s.split('\n').map(l => l.trim()).find(Boolean) || '')
  .replace(/^(中文|翻譯|輸出|答)\s*[:：]\s*/, '').replace(/^[「"'`]+|[」"'`]+$/g, '').trim().slice(0, 120);

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' } });

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' } });
  if (!env.AI) return json({ error: 'Workers AI 尚未綁定（wrangler.toml [ai] binding = "AI"）' }, 503);
  const url = new URL(request.url);
  let words = [], cands = null, scene = '';
  const clean = a => a.map(w => String(w).trim()).filter(w => w && w !== '？' && w.length <= 8);
  if (request.method === 'POST') {
    try {
      const b = await request.json();
      if (Array.isArray(b.cands)) cands = b.cands.map(x => clean(Array.isArray(x) ? x : [x]).slice(0, 3)).filter(x => x.length).slice(0, 30);
      else words = Array.isArray(b.gloss) ? b.gloss : String(b.gloss || '').split(/[\/／]/);
      scene = String(b.scene || '').slice(0, 20);
    } catch {}
  }
  else {
    words = (url.searchParams.get('gloss') || '').split(/[\/／]/);
    const c = url.searchParams.get('cands');   // 測試用：?cands=我|你/游泳|跑/會|要
    if (c) cands = c.split(/[\/／]/).map(x => clean(x.split('|')).slice(0, 3)).filter(x => x.length);
    scene = url.searchParams.get('scene') || '';
  }
  if (cands) {
    if (!cands.length) return json({ error: '缺少 cands' }, 400);
    if (cands.every(x => x.length === 1)) words = cands.map(x => x[0]);   // 都只有一個候選：一般模式
    else return candMode(request, env, cands, scene, url.searchParams.has('loo'));
  }
  words = clean(words).slice(0, 40);
  if (!words.length) return json({ error: '缺少 gloss' }, 400);
  const g = words.join('/');
  if (words.length === 1) return json({ text: words[0], model: 'none' });   // 一個詞不用 AI
  const loo = url.searchParams.has('loo');   // 評估用：不拿同一句當範例

  const cache = caches.default, key = new Request(new URL('/api/fluent?c=' + encodeURIComponent(g + (loo ? '|loo' : '')), request.url).toString());
  const hit = loo ? null : await cache.match(key); if (hit) return hit;

  if (!EX) EX = await (await env.ASSETS.fetch(new URL('/corpus/dict/gloss-examples.json', request.url))).json();
  const messages = [{ role: 'system', content: RULES }];
  for (const [zh, gl] of topExamples(g, 12, loo)) { messages.push({ role: 'user', content: gl }); messages.push({ role: 'assistant', content: zh }); }
  messages.push({ role: 'user', content: g });

  const models = env.FLUENT_MODEL ? [env.FLUENT_MODEL, ...MODELS] : MODELS;
  let lastErr = '';
  for (const model of models) {
    try {
      const text = parse(await run(env, model, messages));
      if (text) {
        const res = json({ text, model });
        res.headers.set('cache-control', 'public, max-age=86400');
        if (!loo) await cache.put(key, res.clone());
        return res;
      }
    } catch (e) { lastErr = String(e?.message || e); }
  }
  return json({ error: 'AI 沒有回應', detail: lastErr }, 502);
}

async function candMode(request, env, cands, scene, loo) {
  const g = fmtCands(cands);
  const cache = caches.default, key = new Request(new URL('/api/fluent?cc=' + encodeURIComponent(scene + '|' + g), request.url).toString());
  const hit = loo ? null : await cache.match(key); if (hit) return hit;
  if (!EX) EX = await (await env.ASSETS.fetch(new URL('/corpus/dict/gloss-examples.json', request.url))).json();
  const pool = [...new Set(EX.slice(0, 300).flatMap(e => e[1].split('/')))];
  const messages = [{ role: 'system', content: RULES_C + (scene ? `\n情境：${scene}（優先選這個情境常說的話）。` : '') }];
  for (const [zh, gl] of topExamples(cands.map(c => c[0]).join('/'), 8, loo)) {
    const [u, a] = candExample(zh, gl, pool); messages.push({ role: 'user', content: u }); messages.push({ role: 'assistant', content: a });
  }
  messages.push({ role: 'user', content: g });
  const models = env.FLUENT_MODEL ? [env.FLUENT_MODEL, ...MODELS] : MODELS;
  let lastErr = '';
  for (const model of models) {
    try {
      const raw = await run(env, model, messages);
      const out = parseCand(raw, cands);
      if (out) {
        const res = json({ ...out, model });
        res.headers.set('cache-control', 'public, max-age=86400');
        if (!loo) await cache.put(key, res.clone());
        return res;
      }
    } catch (e) { lastErr = String(e?.message || e); }
  }
  return json({ error: 'AI 沒有回應', detail: lastErr }, 502);
}
// AI 回的 JSON → {text, pick}；pick 只收候選裡有的詞（照順序對齊），亂寫就用第一個候選
function parseCand(raw, cands) {
  let o = null; const m = raw.match(/\{[\s\S]*\}/);
  if (m) try { o = JSON.parse(m[0]); } catch {}
  let text = o && typeof o.text === 'string' ? o.text.trim() : parse(raw.replace(/\{[\s\S]*\}/, ''));
  if (!text) return null;
  const want = o && Array.isArray(o.pick) ? o.pick.map(String) : [];
  if (!want.length) return { text: text.slice(0, 120), pick: cands.map(c => c[0]) };
  const pick = []; let j = 0;
  for (const c of cands) {   // 依序對齊：這個位置的候選有 AI 挑的詞就用它；沒有＝AI 略過這個位置
    let k = j; while (k < want.length && k < j + 2 && !c.includes(want[k])) k++;
    if (k < want.length && c.includes(want[k])) { pick.push(want[k]); j = k + 1; } else pick.push(null);
  }
  return { text: text.slice(0, 120), pick };
}
