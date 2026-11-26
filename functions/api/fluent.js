// Cloudflare Pages Function：/api/fluent — 台灣手語詞序（辨識出來的手勢詞）→ 通順的中文句子，用 Cloudflare Workers AI
// POST {gloss: string[]}  或  GET ?gloss=我/游泳/會   →  {text, model}
// 做法：/api/gloss 的反方向。從中正辭典 546 句例句（gloss ↔ 中文）挑最像的 12 句當範例，請 AI 改寫成口語中文。
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
  let words = [];
  if (request.method === 'POST') { try { const b = await request.json(); words = Array.isArray(b.gloss) ? b.gloss : String(b.gloss || '').split(/[\/／]/); } catch {} }
  else words = (url.searchParams.get('gloss') || '').split(/[\/／]/);
  words = words.map(w => String(w).trim()).filter(w => w && w !== '？' && w.length <= 8).slice(0, 40);
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
