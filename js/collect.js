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
  Object.assign(SET, { signer, hand: $('colHand').value, list: $('colList').value, reps: +$('colReps').value, code: $('colCode').value.trim(), consent: true }); saveSet();
  items = itemsFor(SET.list); reps = SET.reps; idx = SET.pos && SET.pos[SET.list] || 0; take = 0;
  if (idx >= items.length) idx = 0;
  kind = SET.list === 'none' ? 'none' : SET.list.startsWith('s:') ? 'sent' : 'word';
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
  $('colProg').textContent = `${LISTS[SET.list]}・第 ${idx + 1}／${items.length} 個`;
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
  SET.pos = { ...(SET.pos || {}), [SET.list]: idx }; saveSet();
  if (idx % 10 === 0) upload(false);
  if (idx >= items.length) return finish();
  showItem(); if (kind === 'none') { clearTimeout(noneTimer); setState('wait'); } else setState('wait');
}
function finish() {
  setState('done', '🎉 這個清單錄完了，謝謝！'); SET.pos = { ...(SET.pos || {}), [SET.list]: 0 }; saveSet();
  upload(false); setTimeout(endSession, 2500);
}
async function endSession() { stopCam(); await upload(false); $('colRec').hidden = true; $('colSetup').hidden = false; refreshPending(); }

// 上傳：沒上傳的分批送（每批 ≤ 60 筆、≤ 3 MB）
let uploading = false;
export async function upload(loud) {
  if (uploading) return; uploading = true;
  try {
    const pend = (await store.collectAll()).filter(s => !s.up);
    if (!pend.length) { if (loud) ctx.toast('都上傳了'); return; }
    let sent = 0;
    while (pend.length) {
      const batch = []; let size = 0;
      while (pend.length && batch.length < 60 && size < 3e6) { const s = pend.shift(); batch.push(s); size += s.data.length + 300; }
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
    if (sent) ctx.toast(`已上傳 ${sent} 次，謝謝！`);
  } catch (e) { if (loud) ctx.toast('上傳失敗（網路？）資料還在手機裡'); }
  finally { uploading = false; refreshPending(); }
}
// 測試用（tools/test_collect.py）：直接餵影格
if (typeof window !== 'undefined') window.__collect = { feed: f => onFrame(f), get state() { return state; }, get idx() { return idx; }, get take() { return take; }, upload };
