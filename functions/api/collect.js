// Cloudflare Pages Function：/api/collect — 收集模式上傳的骨架語料 → GitHub repo 的 collect 分支（給 Colab 訓練用）
// POST {signer, hand, consent: true, code?, samples: [{word, kind, data, frames, fps, P, aspect, take, ...} 或 {kind: 'log', log: {...}}]}
//   → 存成 collect/<日期>/<代號>-<時間>.json（commit 訊息帶 [CF-Pages-Skip]，Cloudflare 不會因此重新部署網站）
// GET → {ready: true/false}（有沒有設定好可以上傳）；GET ?stats=1 → collect/stats.json（每個詞收集了幾次、幾個人）
// 上傳時同一個 commit 順便更新 collect/stats.json（git data API；有人同時上傳就重試）
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
// ---- 統計（tools/collect_stats.py 也是同樣算法，可以從全部檔案重算）----
export const emptyStats = () => ({ v: 1, updated: null, files: 0, samples: 0, logs: 0, signers: {}, words: {}, missing: {} });
export function addStats(st, body) {
  const who = body.signer, day = (body.uploaded || '').slice(0, 10);
  let n = 0;
  for (const s of body.samples) {
    if (s.kind === 'log') {
      // 說話時手譯員比不出來的詞（v0.18）：{miss: {詞: 次數}}
      if (s.log && s.log.miss && typeof s.log.miss === 'object') {
        const m = st.missing || (st.missing = {});
        for (const [w, k] of Object.entries(s.log.miss)) if (typeof w === 'string' && w.length <= 12) m[w] = (m[w] || 0) + Math.min(50, Math.max(0, +k || 0));
      } else st.logs++;
      continue;
    }
    if (s.kind === 'label') {   // 召會語料確認：{詞: {ok, no}}
      const c = st.church || (st.church = {}), t = c[s.term] || (c[s.term] = { ok: 0, no: 0 });
      t[s.ok ? 'ok' : 'no']++; continue;
    }
    if (!s.word) continue;
    n++; st.samples++;
    const w = st.words[s.word] || (st.words[s.word] = { n: 0, s: {} });
    w.n++; w.s[who] = (w.s[who] || 0) + 1;
    if (s.kind && s.kind !== 'word') w.k = s.kind;
    if (s.src === 'correct') w.c = (w.c || 0) + 1;
  }
  const g = st.signers[who] || (st.signers[who] = { n: 0 });
  g.n += n; g.hand = body.hand; g.last = day;
  st.files++; st.updated = body.uploaded;
  return st;
}
function utf8b64(b) { const bin = atob(b.replace(/\s/g, '')); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new TextDecoder().decode(u); }
async function readStats(env, ref) {
  const r = await gh(env, `contents/collect/stats.json?ref=${ref}`);
  if (!r.ok) return emptyStats();
  try { return JSON.parse(utf8b64((await r.json()).content)); } catch { return emptyStats(); }
}
// 一個 commit：新的一批＋更新後的 stats.json。分支被別人先更新（422）就重來
async function commitBatch(env, path, body, message) {
  for (let k = 0; k < 4; k++) {
    const ref = await gh(env, `git/ref/heads/${BRANCH}`); if (!ref.ok) throw new Error('讀分支失敗：' + ref.status);
    const head = (await ref.json()).object.sha;
    const cm = await gh(env, `git/commits/${head}`); if (!cm.ok) throw new Error('讀 commit 失敗：' + cm.status);
    const st = addStats(await readStats(env, head), body);
    const tr = await gh(env, 'git/trees', { method: 'POST', body: JSON.stringify({ base_tree: (await cm.json()).tree.sha, tree: [
      { path, mode: '100644', type: 'blob', content: JSON.stringify(body) },
      { path: 'collect/stats.json', mode: '100644', type: 'blob', content: JSON.stringify(st) }] }) });
    if (!tr.ok) throw new Error('建立檔案失敗：' + tr.status);
    const c = await gh(env, 'git/commits', { method: 'POST', body: JSON.stringify({ message, tree: (await tr.json()).sha, parents: [head] }) });
    if (!c.ok) throw new Error('建立 commit 失敗：' + c.status);
    const u = await gh(env, `git/refs/heads/${BRANCH}`, { method: 'PATCH', body: JSON.stringify({ sha: (await c.json()).sha, force: false }) });
    if (u.ok) return st;
    if (u.status !== 422 && u.status !== 409) throw new Error('更新分支失敗：' + u.status);
    await new Promise(r => setTimeout(r, 300 + Math.random() * 700));
  }
  throw new Error('同時上傳的人太多，請再試一次');
}
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/collect/stats.json`;

function b64utf8(s) { const u = new TextEncoder().encode(s); let b = ''; for (let i = 0; i < u.length; i += 0x8000) b += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(b); }
const okStr = (s, n) => typeof s === 'string' && s.length > 0 && s.length <= n;

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' } });
  if (request.method === 'GET') {
    if (new URL(request.url).searchParams.has('stats')) {
      try {
        const st = env.GH_COLLECT_TOKEN ? await readStats(env, BRANCH) : await (await fetch(RAW)).json();
        return new Response(JSON.stringify(st), { headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60' } });
      } catch { return json(emptyStats()); }
    }
    return json({ ready: !!env.GH_COLLECT_TOKEN, code: !!env.COLLECT_CODE });
  }
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
  // 召會語料確認（v0.20）：{kind: 'label', term, id, ok, a, b}（tools/church_align.py accept 收進語料庫）
  const isLabel = s => s && s.kind === 'label' && okStr(s.term, 20) && okStr(s.id, 60) && Number.isInteger(s.a) && Number.isInteger(s.b) && s.b > s.a;
  const isSmp = s => s && okStr(s.word, 40) && okStr(s.data, 400000) && Number.isInteger(s.frames) && s.frames > 0 && s.frames <= 600;
  const clean = samples.filter(s => isLog(s) || isLabel(s) || isSmp(s)).map(s => isLabel(s)
    ? { kind: 'label', term: s.term, id: s.id, ok: !!s.ok, a: s.a, b: s.b }
    : isLog(s)
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
    const words = [...new Set(clean.filter(s => s.word || s.term).map(s => s.word || s.term))], nLog = clean.filter(s => s.kind === 'log').length, nLab = clean.filter(s => s.kind === 'label').length;
    const message = `[CF-Pages-Skip] 收集：${signer} ${clean.length - nLog - nLab} 筆骨架${nLog ? `、${nLog} 句辨識紀錄` : ''}${nLab ? `、${nLab} 筆召會語料確認` : ''}（${words.slice(0, 5).join('、')}${words.length > 5 ? ' 等' : ''}）`;
    await commitBatch(env, path, body, message);
    return json({ ok: true, path, n: clean.length });
  } catch (e) { return json({ error: String(e.message || e) }, 502); }
}
