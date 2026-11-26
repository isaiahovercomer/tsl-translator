// 召會語料確認（v0.20）：江啟禎弟兄的手語影片自動切出的召會用語片段（tools/church_align.py → corpus/church/），
// 人工看一看：✅ 是這個詞／❌ 不是，切點可以微調。
//  - 確認的片段馬上存成這支手機的本機語料（召會生活用語），手譯員立刻用得到；
//  - 「送出」→ /api/collect（kind: 'label'）存到 collect 分支，Actions「召會語料」每天把大家確認的收進共用語料庫；
//  - 也可以下載確認檔，給 `python tools/church_align.py accept 確認檔.json`。
import { AvatarPlayer } from './avatar.js';
import { decodeFrames, makeSample, estimateAspect, FPS } from './core.js';
import * as store from './store.js';

const $ = id => document.getElementById(id);
const KEY = 'tsl-church-labels';
const L = (() => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } })();   // {詞: {片段id: {ok, a, b, sent}}}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(L)); } catch {} };
let ctx, player, ytBtn, index = null, term = null, cands = [], cur = 0, adj = { a: 0, b: 0 };

export function initChurchReview(c) {
  ctx = c;
  player = new AvatarPlayer($('chCanvas'), { style: 'f1' });
  $('chOk').onclick = () => mark(true);
  $('chNo').onclick = () => mark(false);
  $('chSkip').onclick = () => show(cur + 1);
  $('chReplay').onclick = () => playCur();
  ytBtn = $('chYtBtn'); ytBtn.onclick = () => showYt();
  document.querySelectorAll('#v-church [data-adj]').forEach(b => b.onclick = () => {
    const [k, d] = [b.dataset.adj[0], b.dataset.adj[1] === '+' ? 2 : -2];
    const c0 = cands[cur]; if (!c0) return;
    const na = c0.a + adj.a + (k === 'a' ? d : 0), nb = c0.b + adj.b + (k === 'b' ? d : 0);
    if (na < c0.s || nb > c0.e || nb - na < 4) return;
    adj[k] += d; playCur();
  });
  $('chSend').onclick = send;
  $('chDl').onclick = () => { const l = pending(true); if (!l.length) return ctx.toast('還沒有確認任何片段'); store.download(`召會語料確認-${new Date().toISOString().slice(0, 10)}.json`, { kind: 'tsl-church-labels', labels: l }); };
  addEventListener('keydown', e => {
    if (!$('v-church').classList.contains('on') || !term || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === 'y' || e.key === 'Enter') mark(true); else if (e.key === 'n') mark(false); else if (e.key === 'ArrowRight') show(cur + 1); else if (e.key === 'r') playCur();
  });
}

export async function openChurchReview() {
  if (!index) {
    $('chStat').textContent = '載入中…';
    try { index = await (await fetch('corpus/church/index.json', { cache: 'no-cache' })).json(); }
    catch { index = null; $('chStat').textContent = '還沒有自動切好的召會語料（要先匯入江啟禎弟兄的影片、跑 tools/church_align.py）。'; return; }
  }
  renderTerms(); updatePending();
}

const CONF = { high: '信心高', mid: '信心中', low: '信心低' };
function renderTerms() {
  const T = Object.entries(index.terms || {});
  const ready = T.filter(([, t]) => t.file);
  const done = ready.filter(([w]) => okCount(w) >= 3 || index.terms[w].status === 'done').length;
  $('chStat').textContent = `${(index.videos || []).length} 支影片切出 ${ready.length} 個詞的候選片段；你已確認好 ${done} 個詞。` + (index.made ? `（${index.made.slice(0, 10)} 更新）` : '');
  const box = $('chTerms'); box.innerHTML = '';
  // 還沒確認、信心高的排前面
  const rank = ([w, t]) => (!t.file ? 9 : 0) + (okCount(w) >= 3 || t.status === 'done' ? 5 : 0) + ({ high: 0, mid: 1, low: 2 }[t.conf] ?? 3);
  for (const [w, t] of T.sort((x, y) => rank(x) - rank(y))) {
    const b = document.createElement('button');
    const k = okCount(w);
    b.className = 'chip' + (k >= 3 || t.status === 'done' ? ' known' : '') + (w === term ? ' cur' : '');
    b.disabled = !t.file;
    b.textContent = w + (t.file ? ` ${k ? '✅' + k : ''}` : '（字幕太少）');
    b.title = t.file ? `${t.n} 句字幕有這個詞、找到 ${t.found} 段，${CONF[t.conf] || ''}` : `只有 ${t.n || 0} 句字幕有，還不能找`;
    if (t.file) b.onclick = () => openTerm(w);
    box.appendChild(b);
  }
}

const okCount = w => Object.values(L[w] || {}).filter(x => x.ok).length;

async function openTerm(w) {
  const t = index.terms[w];
  try { const j = await (await fetch('corpus/' + t.file)).json(); cands = j.cands || []; }
  catch (e) { return ctx.toast('讀不到候選片段：' + e.message); }
  term = w; $('chWork').hidden = false; $('chTitle').textContent = `「${w}」：${cands.length} 段候選`;
  $('chOk').textContent = `✅ 是「${w}」`;
  renderTerms();
  const first = cands.findIndex(c => !(L[w] || {})[c.id]);
  show(first < 0 ? 0 : first);
  $('chWork').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function show(i) {
  if (!cands.length) return;
  cur = ((i % cands.length) + cands.length) % cands.length;
  const c = cands[cur], l = (L[term] || {})[c.id];
  adj = l ? { a: l.a - c.a, b: l.b - c.b } : { a: 0, b: 0 };
  const sub = esc(c.text).split(esc(term)).join(`<mark>${esc(term)}</mark>`);
  $('chSub').innerHTML = `<b>字幕</b>：${sub}<br><span class="muted">${esc(c.title || '')}・${fmt(c.t?.[0] ?? c.a / FPS)}　相似距離 ${c.d}</span>`;
  $('chYt').replaceChildren(ytBtn); ytBtn.hidden = false;
  renderCands(); playCur();
}

function playCur() {
  const c = cands[cur]; if (!c) return;
  const all = c._fr || (c._fr = decodeFrames(c.data, c.frames));
  const a = c.a + adj.a - c.s, b = c.b + adj.b - c.s;
  const fr = all.slice(Math.max(0, a), Math.min(all.length, b));
  const asp = c.aspect || c._asp || (c._asp = estimateAspect(all));
  $('chRange').textContent = `${((b - a) / FPS).toFixed(1)} 秒（${fmt((c.a + adj.a) / FPS)}～${fmt((c.b + adj.b) / FPS)}）`;
  player.play([{ word: term, frames: fr, aspect: asp }], false);
}

function showYt() {
  const c = cands[cur]; if (!c) return;
  const s = Math.max(0, Math.floor((c.a + adj.a) / FPS - 1)), e = Math.ceil((c.b + adj.b) / FPS + 1);
  const f = document.createElement('iframe');
  f.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(c.vid)}?start=${s}&end=${e}&autoplay=1&mute=1&playsinline=1&rel=0`;
  f.allow = 'autoplay; encrypted-media'; f.title = '原影片'; f.loading = 'lazy';
  ytBtn.hidden = true; $('chYt').appendChild(f);
}

function renderCands() {
  const box = $('chCands'); box.innerHTML = '';
  cands.forEach((c, i) => {
    const l = (L[term] || {})[c.id], b = document.createElement('button');
    b.className = 'chip' + (i === cur ? ' cur' : '') + (l?.ok ? ' known' : '') + (l && !l.ok ? ' unk' : '');
    b.textContent = `${i + 1}${l ? (l.ok ? ' ✅' : ' ❌') : ''}`;
    b.onclick = () => show(i); box.appendChild(b);
  });
}

async function mark(ok) {
  const c = cands[cur]; if (!c) return;
  const a = c.a + adj.a, b = c.b + adj.b;
  (L[term] || (L[term] = {}))[c.id] = { ok, a, b, sent: false };
  save();
  const sid = 'jcz_' + c.id;
  try {
    if (ok) {   // 這支手機馬上用得到
      const all = c._fr || (c._fr = decodeFrames(c.data, c.frames));
      const fr = all.slice(a - c.s, b - c.s);
      await store.localPut({ ...makeSample(term, fr, `yt:${c.vid}@${(a / FPS).toFixed(1)}`, { cat: 'church', aspect: c.aspect || estimateAspect(all) }), id: sid });
    } else await store.localDel(sid);
    ctx.onLocalChange && ctx.onLocalChange();
  } catch (e) { console.warn(e); }
  ctx.toast(ok ? `✅ 存好了（這支手機已經可以用）` : '❌ 不是', 1200);
  updatePending(); renderTerms();
  const next = cands.findIndex((x, i) => i > cur && !(L[term] || {})[x.id]);
  show(next >= 0 ? next : cur + 1);
}

function pending(all = false) {
  const out = [];
  for (const [w, m] of Object.entries(L)) for (const [id, l] of Object.entries(m)) if (all || !l.sent) out.push({ term: w, id, ok: l.ok, a: l.a, b: l.b });
  return out;
}
function updatePending() {
  const n = pending().length;
  $('chPending').textContent = n ? `有 ${n} 個確認結果還沒送出。送出後，每天會自動收進共用語料庫，大家的手譯員都會用到。` : '確認結果都送出了。';
  $('chSend').disabled = !n;
}

async function send() {
  const l = pending(); if (!l.length) return;
  let set = {}; try { set = JSON.parse(localStorage.getItem('tsl-collect') || '{}'); } catch {}
  if (!set.signer) { set.signer = '確認-' + Math.random().toString(36).slice(2, 6); try { localStorage.setItem('tsl-collect', JSON.stringify(set)); } catch {} }
  $('chSend').disabled = true; $('chSend').textContent = '送出中…';
  try {
    const r = await fetch('/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signer: set.signer, hand: set.hand || 'right', consent: true, code: set.code || '', samples: l.map(x => ({ kind: 'label', ...x })) }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || r.status);
    for (const x of l) L[x.term][x.id].sent = true;
    save(); ctx.toast(`☁ 送出 ${l.length} 筆，謝謝！`);
  } catch (e) { ctx.toast('送出失敗：' + e.message + '（可以先按「下載確認檔」）', 4000); }
  $('chSend').textContent = '☁ 送出確認結果'; updatePending();
}

const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
