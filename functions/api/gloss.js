// Cloudflare Pages Function：/api/gloss — 中文句子 → 台灣手語詞序（Gloss），用 Cloudflare Workers AI
// POST {text, hint?: string[]}  或  GET ?text=…   →  {gloss: string[], model}
// 做法（參考工研院：文字 → Gloss → 骨架）：從中正辭典 546 句例句挑最像的 10 句當範例，請 AI 照樣改寫。
// 綁定：wrangler.toml 的 [ai] binding = "AI"（不用 API 金鑰）。可用環境變數 GLOSS_MODEL 換模型。
const MODELS = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/qwen/qwen3-30b-a3b-fp8', '@cf/meta/llama-3.1-8b-instruct-fast'];
let EX = null;
const DROP = new Set('的 了 是 嗎 呢 吧 啊 呀 嘛 喔 啦 得 著 把 被'.split(' '));

const RULES = `你是台灣手語（TSL，自然手語）翻譯員。把中文句子改寫成台灣手語的詞序（Gloss），用「/」分開每個手勢詞。
台灣手語語法重點：
1. 時間詞（今天、昨天、剛剛、以前…）放句首。
2. 話題／受詞常提前：「你喜歡吃漢堡嗎」→ 漢堡/吃/你/喜歡。
3. 否定（不、沒有）、助動詞（要、會、可以）、疑問詞（什麼、誰、哪裡、幾、為什麼、有沒有）放句尾。
4. 「很」放在形容詞後面：「很危險」→ 危險/很。
5. 不比虛詞：的、了、是、在、把、被、嗎、呢、吧、得、著。
6. 數字放名詞後面：「三本書」→ 書/三。
7. 盡量用簡單常用的詞；「提示詞」裡有的詞優先照抄。
只輸出 Gloss 一行，不要解釋。`;

function bigrams(s) { const b = new Set(); for (let i = 0; i + 1 < s.length; i++) b.add(s.slice(i, i + 2)); for (const c of s) b.add(c); return b; }
function topExamples(text, k = 10, loo = false) {
  const q = bigrams(text);
  return EX.filter(e => !loo || e[0] !== text).map(e => { let n = 0; for (const g of bigrams(e[0])) if (q.has(g)) n++; return [n / Math.sqrt(e[0].length + 1), e]; })
    .sort((a, b) => b[0] - a[0]).slice(0, k).map(x => x[1]).reverse();
}

async function run(env, model, messages) {
  const r = await env.AI.run(model, { messages, max_tokens: 120, temperature: 0.1 });
  let s = typeof r === 'string' ? r : r?.response ?? r?.choices?.[0]?.message?.content ?? '';
  if (typeof s !== 'string') s = JSON.stringify(s);
  return s.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function parse(s) {
  const line = s.split('\n').map(l => l.trim()).find(l => l.includes('/')) || s.trim().split('\n')[0] || '';
  return line.replace(/^(gloss|手語|台灣手語|輸出)\s*[:：]\s*/i, '').replace(/[「」"'`。．]/g, '')
    .split(/[\/／]/).map(w => w.replace(/_[A-Z0-9]+$/, '').trim()).filter(w => w && w.length <= 8 && !DROP.has(w)).slice(0, 40);
}

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' } });

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' } });
  if (!env.AI) return json({ error: 'Workers AI 尚未綁定（wrangler.toml [ai] binding = "AI"）' }, 503);
  let text = '', hint = [];
  const loo = new URL(request.url).searchParams.has('loo');   // 評估用：不拿同一句當範例
  if (request.method === 'POST') { try { const b = await request.json(); text = String(b.text || ''); hint = Array.isArray(b.hint) ? b.hint.map(String).slice(0, 40) : []; } catch {} }
  else text = new URL(request.url).searchParams.get('text') || '';
  text = text.trim().slice(0, 200);
  if (!text) return json({ error: '缺少 text' }, 400);

  const cache = caches.default, key = new Request(new URL('/api/gloss?c=' + encodeURIComponent(text + '|' + hint.join('/') + (loo ? '|loo' : '')), request.url).toString());
  const hit = await cache.match(key); if (hit) return hit;

  if (!EX) EX = await (await env.ASSETS.fetch(new URL('/corpus/dict/gloss-examples.json', request.url))).json();
  const messages = [{ role: 'system', content: RULES }];
  for (const [zh, g] of topExamples(text, 10, loo)) { messages.push({ role: 'user', content: zh }); messages.push({ role: 'assistant', content: g }); }
  messages.push({ role: 'user', content: text + (hint.length ? `\n（提示詞：${hint.join('、')}）` : '') });

  const models = env.GLOSS_MODEL ? [env.GLOSS_MODEL, ...MODELS] : MODELS;
  let lastErr = '';
  for (const model of models) {
    try {
      const gloss = parse(await run(env, model, messages));
      if (gloss.length) {
        const res = json({ gloss, model });
        res.headers.set('cache-control', 'public, max-age=86400');
        await cache.put(key, res.clone());
        return res;
      }
    } catch (e) { lastErr = String(e?.message || e); }
  }
  return json({ error: 'AI 沒有回應', detail: lastErr }, 502);
}
