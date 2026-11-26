// collect.js — 收集模式：出詞卡 → 對前鏡頭比 N 次 → 只存骨架（不存影像）→ 上傳到 repo 的 collect 分支（給 Colab 訓練辨識模型）
// 舉手自動開始錄、手放下自動結束；每次錄好存在手機（IndexedDB collect），累積夠了自動上傳，沒網路或還沒設定上傳就先留著。
import { FPS, makeSample, handsActive, bodyRef } from './core.js';
import { Camera, drawOverlay } from './vision.js';
import { AvatarPlayer } from './avatar.js';
import * as store from './store.js';
import { SCENES, CORE, CHURCH_MISSING, SENTENCES, NONE_PROMPTS } from './scenes.js';

const $ = id => document.getElementById(id);
const LISTS = {
  'w:greet': '寒暄常用（單詞）', 'w:meeting': '聚會（單詞）', 'w:church': '召會生活（單詞）', 'w:missing': '召會用語（辭典沒有的，最需要！）',
  's:greet': '寒暄短句', 's:meeting': '聚會短句', 's:church': '召會短句', 'none': '自然動作（不是手語）',
};
const SET = (() => { try { return JSON.parse(localStorage.getItem('tsl-collect') || '{}'); } catch { return {}; } })();
const saveSet = () => { try { localStorage.setItem('tsl-collect', JSON.stringify(SET)); } catch {} };

let ctx = null;   // { samplesFor(word) → 語料（看示範用）, toast }
let cam = null, demo = null, items = [], idx = 0, take = 0, reps = 3, kind = 'word', cat = 'general';
// 收集目標（docs/PLAN-colab.md）：單詞每詞 ≥20 次、≥5 人；句子 ≥5 次、≥3 人；自然動作 ≥30 段、≥5 人
const GOAL = { word: [20, 5], sent: [5, 3], none: [30, 5] };
let remote = null, smartOrder = false;   // collect/stats.json（大家上傳的統計）
let state = 'off', buf = [], pre = [], down = 0, up = 0, recStart = 0, noneTimer = null, lastSaved = null;

function itemsFor(key) {
  const [t, k] = key.split(':');
  if (key === 'none') return NONE_PROMPTS.map(p => ({ word: '_none', prompt: p }));
  if (t === 's') return SENTENCES[k].map(g => ({ word: g, prompt: g.replace(/\//g, ' ／ ') }));
  if (k === 'missing') return CHURCH_MISSING.map(w => ({ word: w, prompt: w }));
  // 寒暄＝基本詞＋寒暄詞；聚會、召會只列自己的詞（基本詞在寒暄錄過了）
  const sp = x => x.split(/\s+/).filter(Boolean);
  const ws = [...new Set([...(k === 'greet' ? sp(CORE) : []), ...sp(SCENES[k].words)])];
  return ws.map(w => ({ word: w, prompt: w }));
}

export function initCollect(c) {
  ctx = c;
  $('colList').innerHTML = Object.entries(LISTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('colSigner').value = SET.signer || ''; $('colHand').value = SET.hand || 'right'; $('colList').value = SET.list || 'w:missing';
  $('colReps').value = SET.reps || 3; $('colCode').value = SET.code || ''; $('colConsent').checked = !!SET.consent;
  $('btnCollect').onclick = open;
  $('colClose').onclick = close;
  $('colStart').onclick = start;
  $('colEnd').onclick = endSession;
  $('colSkip').onclick = () => next(true);
  $('colRedo').onclick = redo;
  $('colDemoBtn').onclick = playDemo;
  $('colUpload').onclick = () => upload(true);
  $('colSmart').checked = SET.smart !== false;
  $('colStatsBtn').onclick = toggleStats;
  $('colList').onchange = () => { if (!$('colStats').hidden) renderStats(); };
  $('colDownload').onclick = async () => { const all = await store.collectAll(); if (!all.length) return ctx.toast('還沒有錄任何資料'); store.download(`手語收集-${SET.signer || ''}-${new Date().toISOString().slice(0, 10)}.json`, { kind: 'tsl-collect', signer: SET.signer, hand: SET.hand, samples: all }); };
  fetch('api/collect').then(r => r.ok ? r.json() : null).then(j => { ctx.ready = !!(j && j.ready); $('colCodeRow').hidden = !(j && j.code); refreshPending(); }).catch(() => refreshPending());
}

async function refreshPending() {
  const all = await store.collectAll(), p = all.filter(s => !s.up).length;
  $('colPending').textContent = `這支手機已經錄了 ${all.length} 次` + (p ? `，還有 ${p} 次沒上傳` : '，都上傳了') + (ctx.ready === false ? '（上傳功能還沒設定好，資料先存在手機裡，可按「下載備份」）' : '');
  $('colUpload').hidden = !p;
}

function open() { $('collect').hidden = false; $('colSetup').hidden = false; $('colRec').hidden = true; document.body.classList.add('f2f-on'); refreshPending(); }
function close() { stopCam(); $('collect').hidden = true; document.body.classList.remove('f2f-on'); }

async function start() {
  const signer = $('colSigner').value.trim();
  if (!signer) { $('colSigner').focus(); return ctx.toast('請填代號（不用真名）'); }
  if (!$('colConsent').checked) return ctx.toast('請先勾選同意');
  Object.assign(SET, { signer, hand: $('colHand').value, list: $('colList').value, reps: +$('colReps').value, code: $('colCode').value.trim(), consent: true, smart: $('colSmart').checked }); saveSet();
  items = itemsFor(SET.list); reps = SET.reps; take = 0;
  kind = SET.list === 'none' ? 'none' : SET.list.startsWith('s:') ? 'sent' : 'word';
  if (SET.smart && kind !== 'none') {           // 最缺的先錄：每次開始都重新排（自己錄滿的放最後），從第一個開始
    await loadStats();
    items = orderByNeed(items, await counts(), kind); idx = 0; smartOrder = true;
  } else { idx = SET.pos && SET.pos[SET.list] || 0; smartOrder = false; }
  if (idx >= items.length) idx = 0;
  cat = /church|missing/.test(SET.list) ? 'church' : 'general';
  $('colSetup').hidden = true; $('colRec').hidden = false;
  if (!demo) { demo = new AvatarPlayer($('colDemo'), {}); demo.style = 'f1'; }
  showItem();
  setState('load', '載入手勢模型中（第一次約 10～20 秒）…');
  const ov = $('colOverlay').getContext('2d');
  cam = new Camera($('colVideo'), (f, r) => {
    const v = $('colVideo'), cv = $('colOverlay');
    if (v.videoWidth && cv.width !== v.videoWidth) { cv.width = v.videoWidth; cv.height = v.videoHeight; }
    drawOverlay(ov, r, false);
    onFrame(f);
  });
  try { await cam.start('user', { width: 640, height: 480 }); setState('wait'); }
  catch (e) { setState('err', '鏡頭打不開：' + (e.message || e)); }
}
function stopCam() { if (cam) cam.stop(); cam = null; clearTimeout(noneTimer); state = 'off'; }

function showItem() {
  const it = items[idx];
  if (!it) return finish();
  const c = it.need;
  $('colProg').textContent = `${LISTS[SET.list]}・第 ${idx + 1}／${items.length} 個` + (smartOrder && c ? `（大家已錄 ${c.n} 次、${c.p} 人）` : '');
  $('colWord').textContent = it.prompt;
  $('colWord').classList.toggle('long', it.prompt.length > 8);
  $('colTake').innerHTML = kind === 'none' ? '照著做 15 秒（自然就好）' : Array.from({ length: reps }, (_, i) => `<span class="${i < take ? 'done' : ''}">${i < take ? '✓' : i + 1}</span>`).join('');
  const has = kind === 'word' && ctx.samplesFor(it.word).length;
  $('colDemoBtn').hidden = !has; $('colDemo').hidden = !has;
  $('colNoDemo').hidden = kind !== 'word' || !!has;
  if (has && take === 0) playDemo();
}
async function playDemo() {
  const it = items[idx]; const list = ctx.samplesFor(it.word); if (!list.length) return;
  try { const s = await store.loadSample(list[0]); demo.play([{ word: it.word, frames: ctx.frames(s), aspect: ctx.aspect(s) }], false); } catch {}
}

const MSG = {
  wait: '先把手放下', ready: kind => kind === 'sent' ? '準備好了：舉手開始比這一句，比完手放下' : '準備好了：舉手開始比，比完手放下',
  rec: '● 錄影中…比完手放下', ok: '✓ 錄好了', short: '太短了，再比一次', none: '● 錄自然動作中…',
};
function setState(s, text) {
  state = s;
  const el = $('colState'); el.className = 'col-state ' + s;
  el.textContent = text || (typeof MSG[s] === 'function' ? MSG[s](kind) : MSG[s] || '');
}

function onFrame(f) {
  if (state === 'off' || state === 'load' || state === 'err' || state === 'done') return;
  if (kind === 'none') return noneFrame(f);
  const act = !!f && handsActive(f, bodyRef(f));
  if (state === 'wait' || state === 'ok' || state === 'short') {
    if (!act) { if (++down >= 5) setState('ready'); } else down = 0;
    return;
  }
  if (state === 'ready') {
    if (f) { pre.push(f); if (pre.length > 5) pre.shift(); }
    if (act && ++up >= 2) { buf = [...pre]; pre = []; up = 0; down = 0; recStart = performance.now(); setState('rec'); }
    else if (!act) up = 0;
    return;
  }
  if (state === 'rec') {
    if (f) buf.push(f);
    const endAfter = kind === 'sent' ? 12 : 8;   // 手放下多久算比完（句子中間可能短暫放下）
    if (!act) down++; else down = 0;
    const max = (kind === 'sent' ? 20 : 8) * FPS;
    if (down >= endAfter || buf.length >= max) saveTake(buf.slice(0, Math.max(0, buf.length - down + 2)));
  }
}
function noneFrame(f) {
  if (state === 'ready' || state === 'wait') { buf = []; setState('none'); recStart = performance.now(); clearTimeout(noneTimer); noneTimer = setTimeout(() => saveTake(buf), 15000); }
  if (state === 'none' && f) buf.push(f);
  if (state === 'none') $('colState').textContent = `● 錄自然動作中…${Math.max(0, 15 - Math.floor((performance.now() - recStart) / 1000))} 秒`;
}

async function saveTake(frames) {
  down = 0; buf = [];
  const it = items[idx];
  if (frames.length < (kind === 'none' ? 30 : 8)) { setState('short'); return; }
  const v = $('colVideo');
  const s = makeSample(it.word, frames, 'collect', { kind, cat, take: take + 1, signer: SET.signer, hand: SET.hand,
    aspect: v.videoWidth ? +(v.videoWidth / v.videoHeight).toFixed(3) : undefined, prompt: it.prompt, up: 0 });
  await store.collectPut(s); lastSaved = s;
  take++;
  if (kind === 'none' || take >= reps) { setState('ok', '✓ 這個完成了，下一個'); setTimeout(() => next(false), 900); }
  else { setState('ok', `✓ 第 ${take} 次錄好了，再比一次`); showItem(); }
}
async function redo() {
  if (lastSaved && lastSaved.word === items[idx]?.word && take > 0) { await store.collectDel(lastSaved.id); take--; lastSaved = null; showItem(); ctx.toast('上一次刪掉了，請重比'); }
  else if (lastSaved && take === 0 && idx > 0) { await store.collectDel(lastSaved.id); idx--; take = reps - 1; lastSaved = null; showItem(); ctx.toast('上一次刪掉了，請重比'); }
  setState('wait');
}
function next(skipped) {
  idx++; take = 0; lastSaved = skipped ? lastSaved : null;
  if (!smartOrder) { SET.pos = { ...(SET.pos || {}), [SET.list]: idx }; saveSet(); }
  if (idx % 10 === 0) upload(false);
  if (idx >= items.length) return finish();
  showItem(); if (kind === 'none') { clearTimeout(noneTimer); setState('wait'); } else setState('wait');
}
function finish() {
  setState('done', '🎉 這個清單錄完了，謝謝！'); SET.pos = { ...(SET.pos || {}), [SET.list]: 0 }; saveSet();
  upload(false); setTimeout(endSession, 2500);
}
async function endSession() { stopCam(); await upload(false); $('colRec').hidden = true; $('colSetup').hidden = false; refreshPending(); }

// ---------- 收集進度（v0.16）----------
const RAW = 'https://raw.githubusercontent.com/isaiahovercomer/tsl-translator/collect/collect/stats.json';
export async function loadStats(force) {
  if (remote && !force) return remote;
  for (const u of ['api/collect?stats=1', RAW]) {
    try { const r = await fetch(u, { cache: force ? 'no-store' : 'default' }); if (r.ok) { const j = await r.json(); if (j && j.words) return (remote = j); } } catch {}
  }
  return remote;
}
// 每個詞：大家上傳的（stats.json）＋這支手機還沒上傳的 → {n 次, p 人, me 我錄了幾次}
async function counts() {
  const st = remote || { words: {} }, me = SET.signer, out = {};
  for (const [w, x] of Object.entries(st.words || {})) out[w] = { n: x.n, ppl: new Set(Object.keys(x.s || {})), me: (x.s || {})[me] || 0 };
  let local = [];
  try { local = await store.collectAll(); } catch {}
  for (const s of local) {
    if (s.kind === 'log' || !s.word) continue;
    const who = s.signer || me;
    const o = out[s.word] || (out[s.word] = { n: 0, ppl: new Set(), me: 0 });
    // 還沒上傳的、或上傳了但比統計的更新時間晚（統計還沒算到）→ 加進去
    if (!s.up || !remote || !remote.updated || (s.created || '') > remote.updated) { o.n++; o.ppl.add(who); if (who === me) o.me++; }
  }
  for (const o of Object.values(out)) o.p = o.ppl.size;
  return out;
}
// 缺多少：次數不夠的差額＋人數不夠的差額（人數比較重要：換人才學得到不同比法）
function needScore(c, k) {
  const [N, Pp] = GOAL[k] || GOAL.word;
  return Math.max(0, N - c.n) / N + 1.5 * Math.max(0, Pp - c.p) / Pp;
}
function orderByNeed(list, cnt, k) {
  const z = { n: 0, p: 0, me: 0 };
  return list.map((it, i) => {
    const c = cnt[it.word] || z;
    return { ...it, need: { n: c.n, p: c.p, me: c.me }, _done: c.me >= reps ? 1 : 0, _s: needScore(c, k), _i: i };
  }).sort((a, b) => a._done - b._done || b._s - a._s || a._i - b._i);
}
async function toggleStats() {
  const el = $('colStats');
  if (!el.hidden) { el.hidden = true; return; }
  el.hidden = false; el.innerHTML = '讀取中…';
  const sg = $('colSigner').value.trim(); if (sg) SET.signer = sg;
  await loadStats(true); renderStats();
}
async function renderStats() {
  const el = $('colStats'), key = $('colList').value;
  const k = key === 'none' ? 'none' : key.startsWith('s:') ? 'sent' : 'word';
  const [N, Pp] = GOAL[k], cnt = await counts(), st = remote;
  const list = itemsFor(key);
  const uniq = [...new Map(list.map(it => [it.word, it])).values()];
  const rows = uniq.map(it => ({ it, c: cnt[it.word] || { n: 0, p: 0, me: 0 } })).sort((a, b) => needScore(b.c, k) - needScore(a.c, k));
  const done = rows.filter(r => r.c.n >= N && r.c.p >= Pp).length;
  const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const ppl = st ? Object.keys(st.signers || {}).filter(x => (st.signers[x].n || 0) > 0).length : 0;
  const head = st ? `<div class="cs-sum">大家一共錄了 <b>${st.samples}</b> 次、<b>${ppl}</b> 人${st.updated ? `<span class="muted">（更新 ${new Date(st.updated).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）</span>` : ''}</div>`
    : '<div class="cs-sum muted">讀不到大家的統計（沒網路？），下面只算這支手機錄的</div>';
  el.innerHTML = head +
    `<div class="cs-sum">「${esc(LISTS[key])}」目標每個 ${N} 次、${Pp} 人：達標 <b>${done}</b>／${rows.length}` +
    (rows.length - done ? `；最缺：${rows.filter(r => !(r.c.n >= N && r.c.p >= Pp)).slice(0, 5).map(r => esc(r.it.prompt)).join('、')}` : ' 🎉') + '</div>' +
    '<table>' + rows.map(({ it, c }) => {
      const f = Math.min(1, (Math.min(1, c.n / N) + Math.min(1, c.p / Pp)) / 2), cls = f >= 1 ? 'ok' : f >= 0.5 ? 'mid' : '';
      return `<tr><td class="w">${esc(it.prompt)}</td><td><div class="bar"><i class="${cls}" style="width:${Math.max(4, f * 100)}%"></i></div></td><td>${c.n} 次</td><td>${c.p} 人</td><td class="me">${c.me ? '你 ' + c.me : ''}</td></tr>`;
    }).join('') + '</table>';
}

// 上傳：沒上傳的分批送（每批 ≤ 60 筆、≤ 3 MB）
let uploading = false;
export async function upload(loud) {
  if (uploading) return; uploading = true;
  try {
    // 收集模式錄的：要勾過收集同意；辨識紀錄／改正：要打開「幫忙改進辨識」
    const allowed = s => (s.kind === 'log' || s.src === 'correct') ? SET.help : SET.consent;
    const pend = (await store.collectAll()).filter(s => !s.up && allowed(s));
    if (!pend.length) { if (loud) ctx.toast(SET.consent || SET.help ? '都上傳了' : '要先在收集模式勾同意，或在設定打開「幫忙改進辨識」'); return; }
    if (!SET.signer) SET.signer = anon(), saveSet();
    let sent = 0;
    while (pend.length) {
      const batch = []; let size = 0;
      while (pend.length && batch.length < 60 && size < 3e6) { const s = pend.shift(); batch.push(s); size += (s.data ? s.data.length : JSON.stringify(s.log || {}).length) + 300; }
      const r = await fetch('api/collect', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signer: SET.signer, hand: SET.hand, code: SET.code, consent: true, samples: batch }) });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        if (loud || r.status !== 503) ctx.toast('上傳失敗：' + (j.error || r.status) + '（資料還在手機裡）', 5000);
        if (r.status === 503) ctx.ready = false;
        break;
      }
      for (const s of batch) await store.collectPut({ ...s, up: 1 });
      sent += batch.length;
    }
    if (sent) { ctx.toast(`已上傳 ${sent} 次，謝謝！`); remote = null; }
  } catch (e) { if (loud) ctx.toast('上傳失敗（網路？）資料還在手機裡'); }
  finally { uploading = false; refreshPending(); }
}
// ---------- 平常使用的辨識紀錄、改正（v0.15）----------
const anon = () => '匿名-' + Math.random().toString(36).slice(2, 6);
let sinceUp = 0;
// 一句的辨識過程：{scene, mode, th, slots:[{alt:[[詞,距離]…], keep, n, fixed}], ai, said, fps, ms}
export async function addLog(log) {
  const id = 'log-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  try { await store.collectPut({ id, kind: 'log', word: '_log', log, created: new Date().toISOString(), up: 0 }); } catch { return; }
  if (SET.help && ++sinceUp >= 20 && navigator.onLine !== false) { sinceUp = 0; upload(false); }
}
// 使用者把詞卡改正：骨架＋正確的詞（原本認成 was）
export async function addCorrection(sample, was) {
  try { await store.collectPut({ ...sample, id: 'c' + sample.id, src: 'correct', kind: 'word', was: was || null, take: 0, signer: SET.signer || null, hand: SET.hand || null, up: 0 }); } catch {}
}
export function enableHelp(on) {
  SET.help = !!on; if (on && !SET.signer) SET.signer = anon(); saveSet();
  if (on) upload(false);
}
export const helpOn = () => !!SET.help;
// 統計：幾句、幾個手勢、AI 換掉第一候選的比例、使用者改正的比例、第一候選距離中位數
export async function recStats() {
  const logs = (await store.collectAll()).filter(s => s.kind === 'log').map(s => s.log);
  let slots = 0, changed = 0, fixed = 0, dropped = 0; const d = [];
  for (const l of logs) {
    const kept = l.slots.filter(x => x.keep || x.fixed);
    slots += l.slots.length; dropped += l.slots.length - kept.length;
    for (const [i, x] of kept.entries()) {
      if (x.fixed) fixed++;
      if (l.ai && l.ai.pick && l.ai.pick[i] && x.alt[0] && l.ai.pick[i] !== x.alt[0][0]) changed++;
      if (x.alt[0]) d.push(x.alt[0][1]);
    }
  }
  d.sort((a, b) => a - b);
  return { sentences: logs.length, slots, changed, fixed, dropped, medDist: d.length ? d[d.length >> 1] : null, logs };
}

// 測試用（tools/test_collect.py）：直接餵影格
if (typeof window !== 'undefined') window.__collect = { feed: f => onFrame(f), get state() { return state; }, get idx() { return idx; }, get take() { return take; }, get items() { return items; }, upload, loadStats };
