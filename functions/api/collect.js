// Cloudflare Pages Function：/api/collect — 收集模式上傳的骨架語料 → GitHub repo 的 collect 分支（給 Colab 訓練用）
// POST {signer, hand, consent: true, code?, samples: [{word, kind, data, frames, fps, P, aspect, take, ...} 或 {kind: 'log', log: {...}}]}
//   → 存成 collect/<日期>/<代號>-<時間>.json（commit 訊息帶 [CF-Pages-Skip]，Cloudflare 不會因此重新部署網站）
// GET → {ready: true/false}（有沒有設定好可以上傳）
// 需要在 Cloudflare Pages → 設定 → 變數和密鑰 加：
//   GH_COLLECT_TOKEN：GitHub fine-grained token（只選 tsl-translator，Contents：Read and write）
//   COLLECT_CODE（可不設）：收集碼，設了以後要輸入正確的收集碼才能上傳，避免陌生人亂傳
const REPO = 'isaiahovercomer/tsl-translator', BRANCH = 'collect';
const MAX_BYTES = 4 * 1024 * 1024, MAX_SAMPLES = 400;

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' } });
const gh = (env, path, init = {}) => fetch(`https://api.github.com/repos/${REPO}/${path}`, {
  ...init, headers: { authorization: `Bearer ${env.GH_COLLECT_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'tsl-collect', 'content-type': 'application/json', ...(init.headers || {}) } });

async function ensureBranch(env) {
  const r = await gh(env, `git/ref/heads/${BRANCH}`);
  if (r.ok) return;
  const main = await (await gh(env, 'git/ref/heads/main')).json();
  const c = await gh(env, 'git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: main.object.sha }) });
  if (!c.ok && c.status !== 422) throw new Error('建立 collect 分支失敗：' + c.status);
}
function b64utf8(s) { const u = new TextEncoder().encode(s); let b = ''; for (let i = 0; i < u.length; i += 0x8000) b += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(b); }
const okStr = (s, n) => typeof s === 'string' && s.length > 0 && s.length <= n;

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' } });
  if (request.method === 'GET') return json({ ready: !!env.GH_COLLECT_TOKEN, code: !!env.COLLECT_CODE });
  if (!env.GH_COLLECT_TOKEN) return json({ error: '還沒設定上傳（Cloudflare 變數 GH_COLLECT_TOKEN）' }, 503);
  const len = +request.headers.get('content-length') || 0;
  if (len > MAX_BYTES) return json({ error: '一次上傳太大，請分批' }, 413);
  let b; try { b = await request.json(); } catch { return json({ error: '格式不對' }, 400); }
  if (env.COLLECT_CODE && String(b.code || '').trim() !== env.COLLECT_CODE) return json({ error: '收集碼不對' }, 403);
  if (b.consent !== true) return json({ error: '需要同意授權' }, 400);
  const signer = String(b.signer || '').trim().slice(0, 20);
  if (!signer) return json({ error: '缺少代號' }, 400);
  const samples = Array.isArray(b.samples) ? b.samples.slice(0, MAX_SAMPLES) : [];
  // 一般樣本（收集／改正）：骨架 data；辨識紀錄（kind: 'log'）：只有 log 物件（詞、距離）
  const isLog = s => s && s.kind === 'log' && s.log && typeof s.log === 'object' && JSON.stringify(s.log).length <= 20000;
  const isSmp = s => s && okStr(s.word, 40) && okStr(s.data, 400000) && Number.isInteger(s.frames) && s.frames > 0 && s.frames <= 600;
  const clean = samples.filter(s => isLog(s) || isSmp(s)).map(s => isLog(s)
    ? { id: String(s.id || '').slice(0, 40), kind: 'log', created: String(s.created || '').slice(0, 30), log: s.log }
    : { id: String(s.id || '').slice(0, 40), word: s.word, kind: ['word', 'sent', 'none'].includes(s.kind) ? s.kind : 'word', cat: s.cat === 'church' ? 'church' : 'general',
      src: s.src === 'correct' ? 'correct' : 'collect', was: s.src === 'correct' ? String(s.was || '').slice(0, 40) : undefined,
      take: +s.take || 0, fps: +s.fps || 15, P: +s.P || 82, frames: s.frames, aspect: +s.aspect || undefined, created: String(s.created || '').slice(0, 30), data: s.data });
  if (!clean.length) return json({ error: '沒有可以上傳的資料' }, 400);
  const now = new Date(), day = now.toISOString().slice(0, 10), stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const safe = signer.replace(/[^\w一-鿿-]/g, '_');
  const path = `collect/${day}/${safe}-${stamp}-${Math.random().toString(36).slice(2, 6)}.json`;
  const body = { v: 1, signer, hand: b.hand === 'left' ? 'left' : 'right', uploaded: now.toISOString(), ua: (request.headers.get('user-agent') || '').slice(0, 160), samples: clean };
  try {
    await ensureBranch(env);
    const words = [...new Set(clean.filter(s => s.word).map(s => s.word))], nLog = clean.filter(s => s.kind === 'log').length;
    const r = await gh(env, `contents/${encodeURI(path)}`, { method: 'PUT', body: JSON.stringify({
      message: `[CF-Pages-Skip] 收集：${signer} ${clean.length - nLog} 筆骨架${nLog ? `、${nLog} 句辨識紀錄` : ''}（${words.slice(0, 5).join('、')}${words.length > 5 ? ' 等' : ''}）`,
      branch: BRANCH, content: b64utf8(JSON.stringify(body)) }) });
    if (!r.ok) return json({ error: 'GitHub 寫入失敗', status: r.status, detail: (await r.text()).slice(0, 200) }, 502);
    return json({ ok: true, path, n: clean.length });
  } catch (e) { return json({ error: String(e.message || e) }, 502); }
}
