// app.js — 介面與流程
import { FPS, CATS, catOf, decodeFeat, Recognizer, Segmenter, Spotter, tokenize, makeSample, sampleFrames, sampleAspect, estimateAspect, decodeFrames, handsActive as handsUp } from './core.js';
import { AvatarPlayer, normalizeSeq, drawAvatar } from './avatar.js';
import { Camera, extractFromFile, drawOverlay, preloadLandmarker } from './vision.js';
import { ENV, escapeInApp, permState, permHelpHtml, mediaErr, initGuide, openGuide, guided, canInstall, install, onInstallChange } from './guide.js';
escapeInApp();   // 在 LINE 裡打開：自動改用手機瀏覽器（LINE 內建瀏覽器不能用鏡頭和麥克風）
import * as store from './store.js';
import { toGloss, aiGloss, mapGloss, aiFluent, aiPick } from './gloss.js';
import { SCENES, SCENE_ORDER, sceneWords } from './scenes.js';
import { initCollect } from './collect.js';
import { CloudSTT } from './stt.js';
import { RealPlayer } from './realplayer.js';

const VERSION = '0.14.0';
const $ = id => document.getElementById(id);
const dictUrl = w => 'https://twtsl.ccu.edu.tw/search/manual?keyword=' + encodeURIComponent(w);   // 中正大學台灣手語線上辭典
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), ms); }

// ---------- 設定 ----------
const DEF = { threshold: 1.4, avatarSpeed: 1, voice: '', rate: 1, aliases: '您好=你好\n多謝=謝謝\n感謝=謝謝', avatarKind: 'vrm-f1', avatarUrl: '', prefCat: 'church', addCat: 'general', glossMode: 'ai', playMode: 'queue', speakMode: 'smart', scene: 'greet', sttEngine: 'cloud', f2fSize: 1 };
let S = { ...DEF };
try { S = { ...DEF, ...JSON.parse(localStorage.getItem('tsl-settings') || '{}') }; } catch {}
// v0.5：預設改成 2D 插畫人像（之前選 3D 寫實的，換成同性別的 2D）
if (!S.v5) { S.avatarKind = { female: '2d-f1', male: '2d-m1' }[S.avatarKind] || S.avatarKind; S.v5 = 1; }
// v0.7：預設改成插畫風 3D 手譯員（VRM）
if (!S.v7) { S.avatarKind = { '2d-f1': 'vrm-f1', '2d-f2': 'vrm-f2', '2d-m1': 'vrm-m1', '2d-m2': 'vrm-m2', female: 'vrm-f1', male: 'vrm-m1' }[S.avatarKind] || S.avatarKind; S.v7 = 1; }
// v0.7.3：使用者選定插畫風 A3（扁平色塊）；選單只留 6 位插畫風手譯員＋簡筆＋自訂，其他選項換成同性別的插畫風手譯員
if (S.v7 && !S.v8) { const k = S.avatarKind; if (!/^vrm-[fm][123]$/.test(k) && !['2d', 'custom'].includes(k)) S.avatarKind = /(^|-)m(\d|ale|$)/.test(k) ? 'vrm-m3' : 'vrm-f1'; S.v8 = 1; }   // 男：male、biz-m1、2d-m2、vrm-m3-flat…；female 不算
// v0.7.4：手譯員只留 女（vrm-f1）、男（vrm-m3）
if (S.v8 && !S.v9) { S.avatarKind = { 'vrm-f2': 'vrm-f1', 'vrm-f3': 'vrm-f1', 'vrm-m1': 'vrm-m3', 'vrm-m2': 'vrm-m3' }[S.avatarKind] || S.avatarKind; S.v9 = 1; }
// v0.13：手語→語音預設改成「AI 挑詞」（每段留 3 個候選，AI 挑最通順的句子再唸）；加辨識情境
if (!S.v13) { if (S.speakMode === 'word' || S.speakMode === 'fluent') S.speakMode = 'smart'; S.v13 = 1; }
const saveS = () => { try { localStorage.setItem('tsl-settings', JSON.stringify(S)); } catch {} };
saveS();
const STYLE_KINDS = ['2d-f1', '2d-f2', '2d-m1', '2d-m2'];
const REAL_KINDS = ['real-f1', 'real-f2', 'real-m1', 'real-m2'];   // 寫實手譯員（Colab 產生的影片）
const aliasMap = () => Object.fromEntries(S.aliases.split('\n').map(l => l.split('=').map(x => x.trim())).filter(a => a.length === 2 && a[0] && a[1]));

// ---------- 分頁 ----------
function route() {
  let v = (location.hash || '#talk').slice(1);
  if (v === 'f2f') { if (!f2fOn) { history.replaceState(null, '', '#talk'); } v = 'talk'; }
  const name = ['talk', 'corpus', 'add', 'settings'].includes(v) ? v : 'talk';
  document.querySelectorAll('section.view').forEach(s => s.classList.toggle('on', s.id === 'v-' + name));
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.v === name));
  if (name !== 'add') stopRec();
}
addEventListener('hashchange', route);

// ---------- 語料 ----------
let samples = [], index = { signs: [], raw: [] };
const recog = new Recognizer();
let byWord = new Map();
let featsReady = false;
async function attachFeats() {
  const feats = await store.sharedFeats(); featsReady = true;
  for (const s of samples) if (s.shared && feats[s.id] && !s._feat) s._feat = decodeFeat(feats[s.id]);
  recog.setSamples(samples.filter(s => s._feat || !s.shared)); applyScene();
}
// 情境：只在這個情境常用的詞裡找
function applyScene() {
  recog.setFilter(sceneWords(S.scene, samples));
  const n = recog.words.length, name = (SCENES[S.scene] || SCENES.greet).name;
  $('sceneInfo').textContent = featsReady || n ? `辨識 ${n} 個詞` : '';
  $('f2fScene').textContent = '🏷' + (SCENES[S.scene] || SCENES.greet).short;
}
async function loadCorpus() {
  index = await store.sharedIndex();
  const shared = store.sharedSamples(index), local = await store.localAll();
  samples = [...shared, ...local];
  byWord = new Map();
  const add = (w, s) => { if (!w) return; if (!byWord.has(w)) byWord.set(w, []); byWord.get(w).push(s); };
  for (const s of samples) { add(s.word, s); for (const w of s.syn || []) if (w !== s.word) add(w, s); }   // 同義詞也找得到
  // 辨識：本機語料現算；共用語料用預先算好的特徵（開鏡頭時才載入）
  recog.setSamples([...local, ...shared.filter(s => s._feat)]); applyScene();
  if (featsReady) attachFeats();
  renderCorpus(); renderRaw();
  $('avatarStatus').textContent = `語料庫：${byWord.size} 個詞、${samples.length} 筆樣本`;
}

// ---------- 對話：聽人說話 → 人像 ----------
const player = new AvatarPlayer($('avatar'), { onWord: w => highlightWord(w), onIdle: () => pump() });
player.speed = S.avatarSpeed;
const real = new RealPlayer($('avatar').parentElement, player, { onWord: w => highlightWord(w), onIdle: () => pump() });
real.speed = S.avatarSpeed;
let realOn = false;
const busy = () => player.busy || (realOn && real.busy);
const paused = () => realOn ? real.paused : player.paused;
function stopAll() { if (realOn) real.stop(); else player.stop(); setTimeout(pump, 0); }
// 3D 人像：寫實女性／男性（微軟 Rocketbox，MIT），或自訂 Mixamo／Biped 骨架 .glb；載入失敗就用 2D
const AVATAR_URLS = {
  // 插畫風 3D（VRoid）：#tint=材質名稱:顏色 把衣服／頭髮調成深色，手和臉才清楚
  // 使用者選定的畫法：A3 扁平色塊（look=flat）
  'vrm-f1': 'avatars/vrm-f1.vrm?v=2#look=flat',                      // 黑長髮、深藍背心
  'vrm-f2': 'avatars/vrm-f2.vrm#tint=Tops:4a5a8c&look=flat',       // 短髮、米色毛衣改深藍
  'vrm-f3': 'avatars/vrm-f3.vrm#look=flat',                        // 深色短髮、深藍背心
  'vrm-m1': 'avatars/vrm-m1.vrm#look=flat',                        // 深色短髮、深色外套
  'vrm-m2': 'avatars/vrm-m2.vrm#tint=Hair:5a4640&look=flat',       // 背心領帶、頭髮改深棕
  'vrm-m3': 'avatars/vrm-m3.vrm#tint=Tops:4a5470&look=flat',       // 黑短髮、白帽T改深藍灰
  'toon-f': 'avatars/tw-female.glb#toon', 'toon-m': 'avatars/tw-male.glb#toon',
  // 成熟插畫風：Rocketbox 商務人士（MIT），貼圖做成插畫風＋卡通著色描邊
  'biz-f1': 'avatars/biz-f1.glb#toon', 'biz-f2': 'avatars/biz-f2.glb#toon', 'biz-m1': 'avatars/biz-m1.glb#toon', 'biz-m2': 'avatars/biz-m2.glb#toon',
  // 同一位動漫手譯員換畫法
  'vrm-f1-comic': 'avatars/vrm-f1.vrm#look=comic', 'vrm-f1-soft': 'avatars/vrm-f1.vrm#look=soft', 'vrm-f1-flat': 'avatars/vrm-f1.vrm#look=flat',
  'vrm-m3-comic': 'avatars/vrm-m3.vrm#tint=Tops:4a5470&look=comic', 'vrm-m3-soft': 'avatars/vrm-m3.vrm#tint=Tops:4a5470&look=soft', 'vrm-m3-flat': 'avatars/vrm-m3.vrm#tint=Tops:4a5470&look=flat',
  female: 'avatars/tw-female.glb',
  male: 'avatars/tw-male.glb',
  eva: 'https://resources.gti.upf.edu/3Dcharacters/ReadyEva/ReadyEva.glb',
};
const vAsp = v => v && v.videoWidth && v.videoHeight ? +(v.videoWidth / v.videoHeight).toFixed(3) : undefined;
async function applyAvatar() {
  realOn = REAL_KINDS.includes(S.avatarKind);
  const style = STYLE_KINDS.includes(S.avatarKind) ? S.avatarKind.slice(3) : realOn ? S.avatarKind.slice(5) : null;
  player.style = preview.style = style;
  if (realOn) {
    const n = await real.load(style);
    toast(n ? `寫實手譯員：${n} 個詞有影片，其他詞先用插畫人像` : '這位寫實手譯員還沒有影片（用 Colab 產生），先用插畫人像', 4000);
  } else real.off();
  const url = (S.avatarKind === '2d' || style) ? null : S.avatarKind === 'custom' ? S.avatarUrl.trim() || null : AVATAR_URLS[S.avatarKind] || AVATAR_URLS.female;
  if (url) $('avatarStatus').textContent = '3D 人像載入中…（第一次約 5 MB，之後會記住）';
  // VRM 比較大：語料預覽那格用同性別的 2D 人像，省手機記憶體
  const isVrm = /\.vrm([?#]|$)/i.test(url || "");
  if (isVrm) preview.style = S.avatarKind.startsWith('vrm-m') ? 'm2' : 'f1';
  try { await Promise.all([player.set3D(url), preview.set3D(isVrm ? null : url)]); }
  catch (e) { console.warn(e); toast('3D 人像載入失敗，先用 2D 人像：' + e.message, 4000); player.set3D(null); preview.set3D(null); }
  $('avatarStatus').textContent = `語料庫：${byWord.size} 個詞、${samples.length} 筆樣本`;
}
let lastTokens = [];
// 中文 → 手語詞序：AI（/api/gloss）→ 規則 → 逐詞
let glossSeq = 0;
async function glossTokens(text) {
  const vocab = [...byWord.keys()], al = aliasMap();
  if (S.glossMode === 'word') return { toks: tokenize(text, vocab, al), how: '' };
  const rule = toGloss(text, vocab, al);
  if (S.glossMode === 'ai' && navigator.onLine !== false) {
    const g = await aiGloss(text, rule.tokens.filter(t => t.known).map(t => t.word));
    if (g) return { toks: mapGloss(g, vocab, al), how: 'AI 手語語序：' + g.join('／') };
  }
  return { toks: rule.tokens, how: '規則手語語序：' + rule.tokens.map(t => t.word).join('／') };
}
// 一句 → 準備好要比的資料（詞序、骨架）
async function prepare(text) {
  const { toks, how } = await glossTokens(text);
  const picks = toks.filter(t => t.known).map(t => {
    const all = byWord.get(t.word), pref = all.filter(s => catOf(s) === S.prefCat), list = pref.length ? pref : all;
    // 本機錄的優先（通常比較清楚），其次手部偵測品質好的
    const best = [...list].sort((a, b) => (b.shared ? 0 : 1) - (a.shared ? 0 : 1) || (b.q || 0.5) - (a.q || 0.5));
    return { word: t.word, s: best[0] };
  });
  const loaded = await Promise.all(picks.map(p => store.loadSample(p.s).catch(() => null)));
  const items = picks.filter((p, i) => loaded[i]).map(p => ({ word: p.word, frames: sampleFrames(p.s), aspect: sampleAspect(p.s) }));
  return { text, toks, how, items };
}
function showEntry(r) {
  $('glossInfo').textContent = r.how;
  lastTokens = r.toks;
  $('speechChips').innerHTML = r.toks.map((t, i) => t.known
    ? `<span class="chip known" data-i="${i}">${esc(t.text)}${t.word !== t.text ? `<small>${esc(t.word)}</small>` : ''}</span>`
    : `<a class="chip" data-i="${i}" href="${dictUrl(t.text)}" target="_blank" rel="noopener" title="語料庫還沒有，點一下查台灣手語線上辭典">${esc(t.text)}</a>`).join('');
}

// ---- 播放佇列：連續／即時（只比最新一句）／一句一句（按「下一句」或點人像）----
const Q = []; let lastEntry = null, stepGo = false, pumping = false;
function enqueue(text) {
  if (S.playMode === 'latest') Q.length = 0;     // 落後就丟掉還沒比的舊句子
  Q.push({ text, p: prepare(text).catch(e => (console.warn(e), null)) });
  renderQueue(); pump();
}
async function pump() {
  if (pumping) return; pumping = true;
  try {
    while (Q.length && !busy() && !paused() && (S.playMode !== 'step' || stepGo)) {
      const e = Q.shift(); stepGo = false; renderQueue();
      const r = await e.p;
      if (!r) continue;
      if (!r.items.length) { showEntry(r); $('avatarStatus').textContent = '語料庫裡還沒有這些詞，先到「新增語料」錄起來。'; continue; }
      startEntry(r);
    }
  } finally { pumping = false; renderQueue(); }
}
function startEntry(r) { lastEntry = r; showEntry(r); $('nowText').textContent = r.text; if (realOn) real.play(r.items); else player.play(r.items, false); renderQueue(); }
function renderQueue() {
  const n = Q.length;
  $('queueInfo').textContent = n ? `還有 ${n} 句：${Q[0].text.slice(0, 16)}${Q[0].text.length > 16 ? '…' : ''}` : (S.playMode === 'step' && !busy() ? '等下一句' : '');
  $('btnNext').classList.toggle('primary', S.playMode === 'step' && n > 0 && !busy());
  $('btnPause').textContent = paused() ? '▶ 繼續' : '⏸ 暫停';
}
function nextSentence() { stepGo = true; if (busy()) stopAll(); else pump(); }
// 打字測試：馬上比（插隊）
async function playText(text) {
  if (!text.trim()) return;
  const r = await prepare(text);
  if (!r.items.length) { showEntry(r); $('avatarStatus').textContent = '語料庫裡還沒有這些詞，先到「新增語料」錄起來。'; return; }
  if (realOn) real.stop(); else player.resume();
  startEntry(r);
}
function highlightWord(w) {
  document.querySelectorAll('#speechChips .chip').forEach(c => c.classList.remove('cur'));
  if (!w) return;
  const c = [...document.querySelectorAll('#speechChips .chip.known')].find(c => lastTokens[c.dataset.i].word === w);
  if (c) c.classList.add('cur');
}
$('btnType').onclick = () => playText($('typeText').value);
$('typeText').onkeydown = e => { if (e.key === 'Enter') playText(e.target.value); };
$('btnFlip').onclick = () => $('pAvatar').classList.toggle('flip');
$('btnPause').onclick = () => { const o = realOn ? real : player; if (paused()) { o.resume(); pump(); } else o.pause(); renderQueue(); };
$('btnNext').onclick = nextSentence;
$('btnReplay').onclick = () => { if (lastEntry) { if (realOn) real.stop(); else { player.resume(); player.stop(); } startEntry(lastEntry); } };
$('btnClearQ').onclick = () => { Q.length = 0; stopAll(); renderQueue(); };
$('avatar').onclick = () => { if (S.playMode === 'step') nextSentence(); };   // 一句一句：點人像＝下一句
$('playMode').onchange = e => { S.playMode = e.target.value; saveS(); if (S.playMode === 'latest' && Q.length > 1) Q.splice(0, Q.length - 1); renderQueue(); pump(); };
document.addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || !$('v-talk').offsetParent) return;
  if (e.key === ' ' || e.key === 'ArrowRight') { e.preventDefault(); nextSentence(); }
  else if (e.key === 'p') $('btnPause').click();
  else if (e.key === 'r') $('btnReplay').click();
});

// 語音辨識：雲端 Whisper（預設，穩、每句晚 1～3 秒）或瀏覽器內建（即時但容易斷、LINE 裡不能用）
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let sr = null, cstt = null, listening = false, pausedForTTS = false;
const hasApi = !/github\.io$/.test(location.hostname);   // GitHub Pages 備用站沒有 /api
// 面對面模式左上角的狀態燈（讓聽損者知道手機有沒有聽到、有沒有看到）
const LIGHT = { mic: { off: '🎤 麥克風關', on: '🎤 聆聽中', hot: '🎤 聽到聲音', busy: '⏳ 辨識中' }, eye: { off: '📷 鏡頭關', on: '📷 請比手語', seen: '📷 看到人', hot: '📷 看到手', warn: '📷 請入鏡' } };
function setLight(id, kind, st) { const el = $(id); if (!el || el.dataset.st === st) return; el.dataset.st = st; el.textContent = LIGHT[kind][st]; el.className = 'light' + (st === 'off' ? '' : ' ' + st); }
const micLight = st => setLight('f2fMic', 'mic', st);
// 上一句留在畫面上（聽損者要看得到），狀態（聽到聲音／辨識中）用小字接在後面
let lastHeard = '';
const showHeard = t => { lastHeard = t; $('speechText').textContent = t; $('f2fHear').textContent = t; };
const showInterim = h => {
  const pre = lastHeard ? esc(lastHeard) + ' ' : '';
  $('speechText').innerHTML = `${pre}<span class="muted">${esc(h)}</span>`; $('f2fHear').innerHTML = `${pre}<span class="interim">${esc(h)}</span>`;
};
async function startCloud() {
  cstt = new CloudSTT({
    onText: t => { showHeard(t); enqueue(t); (window.__heard ||= []).push([Math.round(performance.now()), t]); },
    onState: (st, n) => {
      if (st === 'speech') { showInterim('🎙️ 聽到聲音…'); micLight('hot'); }
      else if (st === 'recognizing' || (st === 'listening' && n > 0)) { showInterim('⏳ 辨識中…'); micLight('busy'); }
      else if (st === 'listening') micLight('on');
    },
    onError: e => {
      if (e.status === 404 || e.status === 405 || e.status === 503) {   // 這個網址沒有雲端辨識 → 改用內建
        toast('雲端語音辨識無法使用，改用瀏覽器內建'); if (cstt) cstt.stop(); cstt = null;
        if (listening) { listening = false; startBrowser(); }
      } else toast('語音辨識失敗：' + (e.message || e));
    },
  });
  try { await cstt.start(); listening = true; showInterim('🎤 請說話…'); }
  catch (e) { cstt = null; const m = mediaErr(e, '麥克風'); toast(m, 5000); f2fStatus(m); if (e.name === 'NotAllowedError') showPermWarn(); }
  updateListenBtn();
}
function startListen() {
  if (S.sttEngine === 'cloud' && hasApi && navigator.mediaDevices?.getUserMedia) return startCloud();
  startBrowser();
}
const pauseRec = () => { if (cstt) cstt.pause(); else try { sr && sr.stop(); } catch {} };
const resumeRec = () => { if (cstt) cstt.resume(); else try { sr && sr.start(); } catch {} };
function startBrowser() {
  if (!SR) { toast('這個瀏覽器不支援內建語音辨識，請到設定改用「雲端 Whisper」'); return; }
  sr = new SR(); sr.lang = 'zh-TW'; sr.continuous = true; sr.interimResults = true;
  sr.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) { const t = r[0].transcript.trim(); if (t) { lastHeard = ''; showHeard(t); enqueue(t); } }
      else interim += r[0].transcript;
    }
    if (interim) { lastHeard = ''; showInterim(interim + '…'); micLight('hot'); } else micLight('on');
  };
  sr.onerror = e => { if (e.error === 'not-allowed') { toast('請允許使用麥克風'); listening = false; updateListenBtn(); } };
  sr.onend = () => { if (listening && !pausedForTTS) try { sr.start(); } catch {} };
  try { sr.start(); listening = true; } catch (e) { toast('無法啟動麥克風：' + e.message); }
  updateListenBtn();
}
function stopListen() { listening = false; try { sr && sr.stop(); } catch {} sr = null; if (cstt) { cstt.stop(); cstt = null; } updateListenBtn(); }
function updateListenBtn() { $('btnListen').textContent = listening ? '⏹ 停止聆聽' : '🎤 開始聆聽'; $('btnListen').classList.toggle('rec', listening); if (typeof f2fUpdate === 'function') f2fUpdate(); }
$('btnListen').onclick = () => listening ? stopListen() : startListen();

// ---------- 對話：手語 → 語音 ----------
let cam = null, signWords = [], sentenceTimer = null;
// 邊比邊找詞（Spotter）：一個詞比完就送出前 3 個候選，不用等手放下
const spot = new Spotter(recog, (cands, frames) => onSign(frames, cands), { onRest: () => { if (signWords.length) scheduleSentence(700); } });
spot.threshold = S.threshold;
function onSign(frames, cands) {
  const res = cands && cands.length ? cands : recog.classify(frames, 3);
  if (!res.length) { $('camStatus').textContent = '語料庫是空的，先新增語料'; return; }
  const ok = res[0].dist <= S.threshold;
  // 候選：第一個＋跟第一個差不多像的（距離不超過門檻 1.5 倍）
  const alt = res.filter(r => r.dist <= Math.max(S.threshold * 1.5, res[0].dist * 1.15)).slice(0, 3);   // 前 3 個，太不像（超過門檻 1.5 倍）的不送
  signWords.push({ word: ok ? res[0].word : null, cands: res, alt, frames, keep: res[0].dist <= S.threshold * 1.3 });
  $('camStatus').textContent = '最接近：' + res.map(r => `${r.word}(${r.dist.toFixed(2)})`).join('、');
  if (ok && S.speakMode === 'word') say(res[0].word);   // 比一個詞就唸一個詞，不用等停下來
  if (!ok) showTip(true);   // 沒認出來：提示變紅再出現
  renderSignChips();
  if (signWords.length >= 7) endSentence(); else scheduleSentence();
}
function renderSignChips() {
  const alts = w => w.alt.length > 1 ? `<small>${w.alt.slice(1).map(a => esc(a.word)).join('・')}</small>` : '';
  $('signChips').innerHTML = signWords.map((w, i) => w.word
    ? `<span class="chip known" data-i="${i}">${esc(w.word)}${alts(w)}</span>`
    : `<span class="chip unk" data-i="${i}" title="點一下選正確的詞">？${esc(w.cands[0].word)}${alts(w)}</span>`).join('');
  $('signSentence').textContent = sentence();
  renderLog();
}
// 逐字稿：之前每一句一行，最後一行是正在比的這句（即時更新）
// 每行 {g: 手語詞序, t: AI 轉的通順中文（還沒有／失敗＝null）}
const logLines = [];
const lineHtml = l => l.t ? `${esc(l.t)}<small>${esc(l.g)}</small>` : esc(l.g);
function renderLog() {
  const cur = signWords.map(w => w.word || (w.keep ? w.cands[0].word + '?' : '？')).join('/');
  const el = $('signLog');
  el.innerHTML = logLines.map(l => `<div>${lineHtml(l)}</div>`).join('') + (cur ? `<div class="cur">${esc(cur)}</div>` : '');
  el.hidden = !logLines.length && !cur;
  el.scrollTop = el.scrollHeight;
  // 面對面模式下方字幕：最近兩句＋正在比的
  const f = $('f2fSign');
  f.innerHTML = logLines.slice(cur ? -1 : -2).map(l => `<div>${lineHtml(l)}</div>`).join('') + (cur ? `<div class="cur">${esc(cur)}</div>` : '');
  f.classList.toggle('empty', !f.innerHTML);
}
// 一句結束（停下來 2 秒多）：這句移到逐字稿、清空詞卡；AI 把手語詞序轉成通順中文
async function endSentence() {
  clearTimeout(sentenceTimer);
  const ws = signWords; signWords = [];
  const words = ws.filter(w => w.word).map(w => w.word), s = words.join('');
  if (S.speakMode === 'pause' && s) say(s);
  let line = null;
  if (ws.length) { line = { g: ws.map(w => w.word || '？').join(''), t: null }; logLines.push(line); }
  if (logLines.length > 200) logLines.splice(0, logLines.length - 200);
  renderSignChips();
  if (s) $('signSentence').textContent = s;
  const online = navigator.onLine !== false && hasApi;
  // AI 挑詞：每段前 3 個候選 → AI 挑最通順的句子再唸
  if (S.speakMode === 'smart') {
    const slots = ws.filter(w => w.keep), cands = slots.map(w => w.alt.map(a => a.word));
    if (!cands.length) return;
    const r = online ? await aiPick(cands, { scene: (SCENES[S.scene] || {}).name || '' }) : null;
    const top = slots.map(w => w.alt[0].word);
    if (r) {
      line.g = r.pick.map((p, i) => p || '').filter(Boolean).join('/') || top.join('/'); line.t = r.text;
      // 挑的跟第一候選不一樣、AI 略過的：記下來（之後可拿來改語料）
      line.fix = r.pick.map((p, i) => p && p !== top[i] ? `${top[i]}→${p}` : null).filter(Boolean);
    } else line.g = top.join('/');
    renderLog(); if (!signWords.length) $('signSentence').textContent = line.t || top.join('');
    say(r ? r.text : top.join(''));
    return;
  }
  const t = line && words.length >= 2 && S.glossMode === 'ai' && navigator.onLine !== false ? await aiFluent(words) : null;
  if (t) { line.t = t; renderLog(); if (!signWords.length) $('signSentence').textContent = t; }
  if (S.speakMode === 'fluent' && s) say(t || s);
}
$('signChips').onclick = e => {
  const c = e.target.closest('.chip'); if (!c) return;
  const w = signWords[c.dataset.i];
  const opts = w.cands.map(x => x.word);
  const pick = window.prompt('改成哪個詞？（也可以輸入新詞，會存成新語料）\n候選：' + opts.join('、'), opts[0]);
  if (!pick) return;
  w.word = pick.trim();
  // 改正的結果直接存成本機語料，越用越準
  store.localPut(makeSample(w.word, w.frames, 'correction', { aspect: vAsp($('camVideo')), cat: S.prefCat })).then(loadCorpus);
  renderSignChips();
};
const sentence = () => signWords.filter(w => w.word).map(w => w.word).join('');
// 「比慢一點、詞和詞之間手稍停」提示：開鏡頭時出現 10 秒；沒認出來時變紅再出現 4 秒
function showTip(warn) {
  const t = $('f2fTip'); t.classList.remove('hide'); t.classList.toggle('warn', !!warn);
  clearTimeout(t._h); t._h = setTimeout(() => { t.classList.add('hide'); t.classList.remove('warn'); }, warn ? 4000 : 10000);
}
// 一句結束：手放下 0.7 秒，或 1.8 秒沒有新的詞（手還在動就再等）
function scheduleSentence(ms = 1800) {
  clearTimeout(sentenceTimer);
  sentenceTimer = setTimeout(() => { if (spot.on && spot.moving && signWords.length < 7) scheduleSentence(600); else endSentence(); }, ms);
}
// 唸出來：排隊唸（不打斷前一個詞），唸的時候暫停聆聽，避免把自己唸的話又翻成手語
function say(text, interrupt = false) {
  if (!('speechSynthesis' in window)) { toast('這個瀏覽器不能發出語音'); return; }
  if (interrupt) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text); u.lang = 'zh-TW'; u.rate = S.rate;
  const v = speechSynthesis.getVoices().find(v => v.voiceURI === S.voice) || pickVoice(); if (v) u.voice = v;
  if (listening && !pausedForTTS) { pausedForTTS = true; pauseRec(); }
  u.onend = u.onerror = () => {
    setTimeout(() => {   // 全部唸完才恢復聆聽
      if (pausedForTTS && !speechSynthesis.speaking && !speechSynthesis.pending) { pausedForTTS = false; if (listening) resumeRec(); }
    }, 150);
  };
  speechSynthesis.speak(u);
}
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  return vs.find(v => /zh[-_]TW/i.test(v.lang)) || vs.find(v => /zh/i.test(v.lang) && /Taiwan|臺灣|台灣/.test(v.name)) || vs.find(v => /zh/i.test(v.lang));
}
$('btnSpeak').onclick = () => { const l = logLines[logLines.length - 1]; const s = sentence() || $('signSentence').textContent || (l && (l.t || l.g)); if (s) say(s.replace(/？/g, ''), true); };
$('btnClear').onclick = () => { signWords = []; logLines.length = 0; renderSignChips(); $('signSentence').textContent = ''; };
// 情境選單（鏡頭卡片）＋面對面模式的 🏷 按鈕（點一下換下一個情境）
$('scene').innerHTML = SCENE_ORDER.map(k => `<option value="${k}">${SCENES[k].name}</option>`).join('');
$('scene').value = S.scene;
const setScene = k => { S.scene = k; saveS(); $('scene').value = k; applyScene(); toast('辨識情境：' + SCENES[k].name); };
$('scene').onchange = e => setScene(e.target.value);
$('f2fScene').onclick = () => setScene(SCENE_ORDER[(SCENE_ORDER.indexOf(S.scene) + 1) % SCENE_ORDER.length]);
$('speakMode').value = S.speakMode;
$('speakMode').onchange = e => { S.speakMode = e.target.value; saveS(); };
const camOn = () => !!(cam && cam.running);
function stopCam() { if (cam) cam.stop(); $('btnCam').textContent = '📷 開啟鏡頭'; $('camHint').hidden = false; f2fUpdate(); }
// size：面對面模式用較低解析度（手機同時跑人像＋辨識比較順）
async function startCam(size) {
  $('camStatus').textContent = '載入手勢辨識模型中（第一次約 10–20 秒）…'; $('btnCam').disabled = true; f2fStatus('載入手勢辨識模型中（第一次約 10–20 秒）…');
  attachFeats();
  const ov = $('camOverlay').getContext('2d');
  cam = new Camera($('camVideo'), (f, r) => {
    sizeTo($('camOverlay'), $('camVideo')); drawOverlay(ov, r, false);
    if (f) spot.push(f);
    f2fSeen(!!f, !!(r && ((r.leftHandLandmarks && r.leftHandLandmarks.length) || (r.rightHandLandmarks && r.rightHandLandmarks.length))));
  });
  let ok = false;
  try { await cam.start('user', size); ok = true; showTip(); $('camHint').hidden = true; $('btnCam').textContent = '⏹ 關閉鏡頭'; $('camStatus').textContent = '準備好了，請比手語'; f2fStatus(''); }
  catch (e) {
    const m = mediaErr(e, '鏡頭'); $('camStatus').textContent = m; f2fStatus(m);
    if (e.code === 'MODEL') { $('camHint').hidden = true; $('btnCam').textContent = '⏹ 關閉鏡頭'; }   // 鏡頭畫面有出來，只是辨識模型沒載到
    else if (e.name === 'NotAllowedError') showPermWarn();
  }
  $('btnCam').disabled = false; f2fUpdate();
  return ok;
}
$('btnCam').onclick = () => camOn() ? stopCam() : startCam();

// ---------- 面對面模式：手機立著，螢幕＋前鏡頭都對著聽損者 ----------
// 手譯員全螢幕、右上角小視窗＝前鏡頭、上方字幕＝聽人說的話、下方字幕＝辨識出的手語中文
let f2fOn = false, wakeLock = null, f2fHome = null;
async function lockWake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch {}
}
document.addEventListener('visibilitychange', () => { if (f2fOn && document.visibilityState === 'visible' && !wakeLock) lockWake(); });
function f2fStatus(t) { $('f2fStatus').textContent = t; $('f2fStatus').hidden = !t; }
let seenT = 0;
function f2fSeen(yes, hands) {   // 小視窗外框：綠＝有拍到人，紅＝沒入鏡
  if (!f2fOn) return; const now = performance.now(); if (now - seenT < 300) return; seenT = now;
  $('f2fPip').classList.toggle('seen', yes); $('f2fPip').classList.toggle('lost', !yes);
  if (yes) { lostSince = 0; setLight('f2fEye', 'eye', hands ? 'hot' : 'seen'); }
  else { if (!lostSince) lostSince = now; setLight('f2fEye', 'eye', now - lostSince > 4000 ? 'warn' : 'on'); }   // 沒拍到人超過 4 秒才提醒入鏡
}
let lostSince = 0;
function f2fUpdate() {
  const on = listening || camOn();
  $('f2fGo').textContent = on ? '⏹ 停止' : '▶ 開始'; $('f2fGo').classList.toggle('rec', on); $('f2fGo').classList.toggle('primary', !on);
  $('f2fPip').classList.toggle('off', !camOn());
  $('f2fPause').textContent = paused() ? '▶' : '⏸';
  if (!listening) micLight('off'); else if ($('f2fMic').dataset.st === 'off' || !$('f2fMic').dataset.st) micLight('on');
  if (!camOn()) setLight('f2fEye', 'eye', 'off');
}
// 字幕放在按鈕列上面：量按鈕列高度
function f2fLayout() { if (!f2fOn) return; $('f2f').style.setProperty('--barh', ($('f2f').querySelector('.f2f-bar').offsetHeight + $('f2fVer').offsetHeight) + 'px'); }
addEventListener('resize', () => setTimeout(f2fLayout, 50));
const SIZES = [1, 1.25, 1.5];
function f2fSize(next) { if (next) { S.f2fSize = SIZES[(SIZES.indexOf(S.f2fSize) + 1) % SIZES.length] || 1; saveS(); } $('f2f').style.setProperty('--fs', S.f2fSize || 1); }
function enterF2F() {
  if (f2fOn) return; f2fOn = true;
  const avStage = $('avatar').parentElement, camStage = $('camVideo').parentElement;
  f2fHome = [[avStage, avStage.parentElement, avStage.nextSibling], [camStage, camStage.parentElement, camStage.nextSibling]];
  $('f2fStage').appendChild(avStage); $('f2fPip').appendChild(camStage);
  $('f2f').hidden = false; document.body.classList.add('f2f-on');
  const el = $('f2f');
  if (el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).then(() => screen.orientation?.lock?.('portrait')).catch(() => {});
  else if (el.webkitRequestFullscreen) try { el.webkitRequestFullscreen(); } catch {}
  lockWake(); f2fSize(); f2fUpdate(); renderLog(); requestAnimationFrame(f2fLayout);
  if (!$('f2fHear').textContent) $('f2fHear').innerHTML = '<span class="interim">按「▶ 開始」：手機會一面聽人說話、一面看你比手語</span>';
  if (location.hash !== '#f2f') history.pushState({ f2f: 1 }, '', '#f2f');
}
function exitF2F(fromPop) {
  if (!f2fOn) return; f2fOn = false;
  for (const [n, parent, next] of f2fHome) parent.insertBefore(n, next);
  $('f2f').hidden = true; document.body.classList.remove('f2f-on');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  if (!fromPop && location.hash === '#f2f') history.back();
}
// 一個按鈕同時開麥克風＋前鏡頭
async function f2fToggle() {
  if (listening || camOn()) { stopListen(); stopCam(); f2fUpdate(); return; }
  startListen();
  await startCam({ width: 640, height: 480 });
  f2fUpdate();
}
$('btnF2F').onclick = e => { e.preventDefault(); enterF2F(); };
// 首頁大按鈕：打開面對面畫面，同時開麥克風和鏡頭（要在同一次點擊裡，瀏覽器才肯給權限、全螢幕）
$('btnStart').onclick = async () => {
  // 權限已經被拒絕（或在 LINE 裡）：先教怎麼打開，不然進去也開不了
  const st = await permState();
  if (ENV.inApp || st.cam === 'denied' || st.mic === 'denied' || st.cam === 'unsupported') { showPermWarn(st); openGuide('perm'); return; }
  preloadLandmarker();
  enterF2F(); if (!(listening || camOn())) f2fToggle();
};
// ---------- 使用說明、權限提示、安裝到主畫面 ----------
async function showPermWarn(st) {
  st = st || await permState();
  const bad = ENV.inApp || ['denied', 'unsupported'].includes(st.cam) || ['denied', 'unsupported'].includes(st.mic);
  $('permWarn').hidden = !bad;
  if (bad) $('permWarn').innerHTML = `⚠️ 鏡頭或麥克風不能用，沒辦法開始。<br>${permHelpHtml()}<br><button id="permRetry">我改好了，重新整理</button>`;
  const r = $('permRetry'); if (r) r.onclick = () => location.reload();
}
initGuide({ onPermGranted: () => { preloadLandmarker(); showPermWarn(); } });
$('btnGuide').onclick = () => openGuide(0);
function updInstall() { $('btnInstall').hidden = !canInstall(); }
onInstallChange(updInstall); updInstall();
$('btnInstall').onclick = async () => { const r = await install(); if (r === 'manual') openGuide('install'); updInstall(); };
showPermWarn();
// 第一次打開：自動跳出使用說明（最後一頁問權限、教安裝）
if (!guided() && !new URLSearchParams(location.search).has('noguide')) openGuide(0);
$('f2fSize').onclick = () => f2fSize(true);
$('f2fExit').onclick = () => exitF2F();
$('f2fGo').onclick = f2fToggle;
$('f2fPause').onclick = () => { $('btnPause').click(); f2fUpdate(); };
$('f2fNext').onclick = () => $('btnNext').click();
addEventListener('popstate', () => { if (f2fOn && location.hash !== '#f2f') exitF2F(true); });
function sizeTo(canvas, video) {
  if (video.videoWidth && canvas.width !== video.videoWidth) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; }
}

// ---------- 語料庫畫面 ----------
let selWord = null;
const preview = new AvatarPlayer($('previewCanvas'), {});
function renderCorpus() {
  const q = $('corpusSearch').value.trim(), cat = $('corpusCat').value;
  const local = samples.filter(s => !s.shared).length;
  const nCat = c => new Set(samples.filter(s => catOf(s) === c).map(s => s.word)).size;
  $('corpusStats').textContent = `${byWord.size} 個詞、${samples.length} 筆樣本（共用 ${samples.length - local}、本機 ${local}）・一般生活用語 ${nCat('general')} 詞、召會生活用語 ${nCat('church')} 詞`;
  const inCat = w => !cat || byWord.get(w).some(s => catOf(s) === cat);
  const words = [...byWord.keys()].filter(w => (!q || w.includes(q)) && inCat(w)).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  const isChurch = w => byWord.get(w).some(s => catOf(s) === 'church');
  const more = words.length - wordLimit;
  $('btnMoreWords').hidden = more <= 0; if (more > 0) $('btnMoreWords').textContent = `顯示更多（還有 ${more} 個詞）`;
  $('wordList').innerHTML = words.slice(0, wordLimit).map(w => `<button class="word ${w === selWord ? 'sel' : ''}" data-w="${esc(w)}"><b>${esc(w)}</b><span class="muted">${isChurch(w) ? '⛪ ' : ''}${byWord.get(w).length} 筆</span></button>`).join('')
    || '<span class="muted">還沒有語料。到「新增語料」開始建立。</span>';
  renderSamples();
}
let wordLimit = 150;   // 一次只畫 150 個詞（全部 3000 多個在手機上會卡）
$('corpusSearch').oninput = () => { wordLimit = 150; renderCorpus(); };
$('corpusCat').onchange = () => { wordLimit = 150; renderCorpus(); };
$('btnMoreWords').onclick = () => { wordLimit += 300; renderCorpus(); };
$('wordList').onclick = e => {
  const b = e.target.closest('.word'); if (!b) return; selWord = b.dataset.w; renderCorpus(); playSample(byWord.get(selWord)[0]);
  $('previewBox').scrollIntoView({ behavior: 'smooth', block: 'center' });
};
function renderSamples() {
  const list = selWord && byWord.get(selWord);
  $('previewBox').hidden = !list;
  $('wordTitle').innerHTML = list ? `「${esc(selWord)}」 <a class="muted" style="font-size:14px" href="${dictUrl(selWord)}" target="_blank" rel="noopener">📖 對照辭典</a>` : '選一個詞預覽';
  $('sampleList').innerHTML = list ? list.map((s, i) => `<div><span class="tag ${s.shared ? '' : 'local'}">${s.shared ? '共用' : '本機'}</span>
    ${s.shared ? `<span class="tag ${catOf(s)}">${CATS[catOf(s)]}</span>` : `<button class="tag ${catOf(s)}" data-cat="${i}" title="點一下切換分類">${CATS[catOf(s)]}</button>`}
    <span class="grow">${s.frames ? (s.frames / (s.fps || FPS)).toFixed(1) + ' 秒・' : ''}${esc(srcLabel(s.src))}${s.variant && s.variant !== s.word ? '（' + esc(s.variant) + '）' : ''}</span>
    <button data-play="${i}">▶</button>${s.shared ? '' : `<button data-del="${i}">刪除</button>`}</div>`).join('') : '';
}
const srcLabel = s => !s ? '' : s.startsWith('ccu:') ? '台灣手語線上辭典' : s.startsWith('youtube') ? 'YouTube' : s === 'camera' ? '鏡頭錄製' : s === 'upload' ? '上傳影片' : s === 'correction' ? '對話中改正' : s;
$('sampleList').onclick = async e => {
  const list = byWord.get(selWord); if (!list) return;
  if (e.target.dataset.play) playSample(list[e.target.dataset.play]);
  if (e.target.dataset.cat) {
    const s = list[e.target.dataset.cat]; s.cat = catOf(s) === 'church' ? 'general' : 'church';
    await store.localPut(s); toast('已改成' + CATS[s.cat]); renderCorpus(); return;
  }
  if (e.target.dataset.del) { await store.localDel(list[e.target.dataset.del].id); toast('已刪除'); await loadCorpus(); }
};
async function playSample(s) { await store.loadSample(s); preview.play([{ word: s.word, frames: sampleFrames(s), aspect: sampleAspect(s) }], false); }
$('btnExport').onclick = async () => {
  const local = await store.localAll();
  if (!local.length) return toast('本機沒有語料');
  store.download(`台灣手語語料-${new Date().toISOString().slice(0, 10)}.json`, store.packFile(local));
};
$('importFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try { const list = await store.readPack(f); for (const s of list) await store.localPut(s); toast(`匯入 ${list.length} 筆`); await loadCorpus(); }
  catch (err) { toast('檔案格式不對：' + err.message); }
  e.target.value = '';
};
$('btnShare').onclick = async () => {
  const local = await store.localAll();
  if (!local.length) return toast('本機沒有語料可以上傳');
  const words = [...new Set(local.map(s => s.word))];
  const nc = local.filter(s => catOf(s) === 'church').length;
  const name = `台灣手語語料-${Date.now()}.json`;
  store.download(name, store.packFile(local));
  const body = `請把剛剛下載的檔案「${name}」拖到這個框框裡，再按 Submit。\n\n內容：${local.length} 筆（一般生活用語 ${local.length - nc}、召會生活用語 ${nc}），詞彙：${words.slice(0, 40).join('、')}`;
  window.open(store.issueUrl(`[語料] ${words.slice(0, 5).join('、')}${words.length > 5 ? ' 等' : ''}（${local.length} 筆）`, body, 'corpus'), '_blank');
};

// ---------- 新增語料：鏡頭錄製 ----------
let recCam = null, recFrames = null, recState = 'idle';
async function startRec() {
  const word = $('recWord').value.trim(); if (!word) { $('recWord').focus(); return toast('先輸入這個手語的中文意思'); }
  $('btnRec').disabled = true; $('recHint').textContent = '載入模型中…';
  const ov = $('recOverlay').getContext('2d');
  let wasActive = false, idle = 0;
  recCam = new Camera($('recVideo'), (f, r) => {
    sizeTo($('recOverlay'), $('recVideo')); drawOverlay(ov, r, false);
    if (recState !== 'rec' || !f) return;
    recFrames.push(f);
    const act = handsUp(f);
    if (act) { wasActive = true; idle = 0; } else if (wasActive && ++idle > 10) finishRec();
    if (recFrames.length > FPS * 10) finishRec();
  });
  try { await recCam.start(); } catch (e) { $('recHint').textContent = '鏡頭無法開啟：' + e.message; $('btnRec').disabled = false; return; }
  $('recHint').hidden = true; $('btnRecStop').disabled = false;
  for (const n of [3, 2, 1]) { $('recCount').textContent = n; await new Promise(r => setTimeout(r, 800)); }
  $('recCount').textContent = ''; recFrames = []; recState = 'rec';
  $('btnRec').textContent = '● 錄製中…';
}
function finishRec() {
  if (recState !== 'rec') return; recState = 'idle';
  const frames = recFrames, asp = vAsp($('recVideo')); stopRec();
  if (frames.length < 6) return toast('太短了，再錄一次');
  openEditor(frames, 'camera', $('recWord').value.trim(), `鏡頭錄製：${$('recWord').value.trim()}`, asp);
}
function stopRec() {
  if (recCam) { recCam.stop(); recCam = null; }
  recState = 'idle'; $('btnRec').disabled = false; $('btnRec').textContent = '● 開始錄'; $('btnRecStop').disabled = true;
  $('recHint').hidden = false; $('recHint').textContent = '按「開始錄」，倒數 3 秒後比一次；手放下會自動停止';
  const c = $('recOverlay'); c.getContext('2d').clearRect(0, 0, c.width, c.height);
}
$('btnRec').onclick = startRec;
$('btnDict').onclick = () => { const w = $('recWord').value.trim(); window.open(w ? dictUrl(w) : 'https://twtsl.ccu.edu.tw/', '_blank'); };
$('btnRecStop').onclick = () => recState === 'rec' ? finishRec() : stopRec();

// ---------- 新增語料：上傳影片 ----------
$('videoFile').onchange = async e => {
  const file = e.target.files[0]; if (!file) return; e.target.value = '';
  $('extractProg').hidden = false; $('extractStatus').textContent = '分析中（只取骨架，影片不保存）…';
  try {
    const { frames, duration, aspect } = await extractFromFile(file, p => { $('extractProg').value = p; });
    $('extractStatus').textContent = `完成：${duration.toFixed(1)} 秒、${frames.length} 格骨架資料。影片已丟棄。`;
    openEditor(frames, 'upload', '', file.name, aspect);
  } catch (err) { $('extractStatus').textContent = '失敗：' + err.message; }
  $('extractProg').hidden = true;
};

// ---------- 新增語料：網址匯入（方法一：擷取分頁，邊播邊抽骨架） ----------
let cap = null, capFrames = [];
const ytId = u => { const m = String(u).match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{6,})/); return m ? m[1] : null; };
$('btnOpenUrl').onclick = () => {
  const url = $('importUrl').value.trim();
  if (!/^https?:\/\//.test(url)) return toast('請貼上完整網址');
  window.open(url, '_blank');
};
$('btnCapture').onclick = async () => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return toast('這個裝置不支援擷取分頁，請用電腦版 Chrome 或 Edge');
  let stream;
  try { stream = await Camera.pickTab(); } catch { return toast('沒有選分頁'); }
  capFrames = []; $('capStage').hidden = false; $('btnCapStop').disabled = false; $('btnCapture').disabled = true;
  $('capStatus').textContent = '載入模型中…';
  const ov = $('capOverlay').getContext('2d');
  cap = new Camera($('capVideo'), (f, r) => {
    sizeTo($('capOverlay'), $('capVideo')); drawOverlay(ov, r, false);
    capFrames.push(f || new Float32Array(82 * 3).fill(NaN));
    if (capFrames.length % 15 === 0) $('capStatus').textContent = `擷取中：${(capFrames.length / FPS).toFixed(0)} 秒（有偵測到人的 ${capFrames.filter(x => x[21] === x[21]).length} 格）`;
  });
  cap.onEnded = finishCapture;
  try { await cap.startStream(stream); $('capStatus').textContent = '擷取中…請到影片分頁按播放'; }
  catch (e) { $('capStatus').textContent = '擷取失敗：' + e.message; finishCapture(); }
};
function finishCapture() {
  if (!cap) return; const asp = vAsp($('capVideo')); cap.stop(); cap = null;
  $('btnCapStop').disabled = true; $('btnCapture').disabled = false; $('capStage').hidden = true;
  // 去掉頭尾沒有人的部分
  let a = capFrames.findIndex(f => f[21] === f[21]), b = capFrames.length - 1;
  while (b > a && capFrames[b][21] !== capFrames[b][21]) b--;
  if (a < 0 || b - a < 6) { $('capStatus').textContent = '沒有擷取到人像，請確認選對分頁，並在擷取時播放影片'; return; }
  const frames = capFrames.slice(a, b + 1); capFrames = [];
  const url = $('importUrl').value.trim(), id = ytId(url);
  $('capStatus').textContent = `完成：${(frames.length / FPS).toFixed(0)} 秒骨架。請在下方切段標註。`;
  openEditor(frames, id ? 'youtube:' + id : (url || 'capture'), '', url || '擷取的影片', asp);
}
$('btnCapStop').onclick = finishCapture;

// 方法二：送到雲端（GitHub Actions）
$('btnUrl').onclick = () => {
  const url = $('importUrl').value.trim();
  if (!/^https?:\/\//.test(url)) return toast('請貼上完整網址');
  const segs = $('importSegs').value.trim();
  const body = ['```', `url: ${url}`, `category: ${$('addCat').value}`, 'segments:', ...segs.split('\n').filter(Boolean).map(l => '  ' + l.trim()), '```',
    '', '送出後雲端會自動下載影片、抽出骨架、刪除影片，完成後會在這裡留言。'].join('\n');
  window.open(store.issueUrl(`[匯入] ${url}`, body, 'ingest'), '_blank');
  toast('請在 GitHub 頁面按 Submit 送出');
};
function renderRaw() {
  const raw = index.raw || [];
  $('rawList').innerHTML = raw.length ? raw.map((r, i) => `<div><span class="tag ${catOf(r)}">${CATS[catOf(r)]}</span><span class="grow">${esc(r.title || r.url)}<br><span class="muted">${(r.frames / FPS).toFixed(0)} 秒・已標 ${r.labeled || 0} 段</span></span><button data-raw="${i}">開啟切段</button></div>`).join('')
    : '<span class="muted">還沒有。貼 YouTube 網址送出後，會出現在這裡。</span>';
}
$('rawList').onclick = async e => {
  const i = e.target.dataset.raw; if (i === undefined) return;
  const entry = index.raw[i];
  try { const t = await store.rawTrack(entry); openEditor(decodeFrames(t.data, t.frames), 'youtube:' + (t.videoId || entry.id), '', entry.title || entry.url, t.aspect, t.cat || entry.cat); }
  catch (err) { toast(err.message); }
};

// ---------- 切段編輯器 ----------
let ed = null;
function openEditor(frames, src, word, title, aspect, cat) {
  aspect = aspect || estimateAspect(frames);
  $('edCat').value = CATS[cat] ? cat : $('addCat').value;
  ed = { frames, aspect, norm: normalizeSeq(frames, aspect), src, a: 0, b: frames.length - 1, pos: 0, playing: 0 };
  $('editor').hidden = false; $('edTitle').textContent = '切段與標註：' + title;
  $('edWord').value = word || ''; $('edPos').max = frames.length - 1; $('edPos').value = 0;
  // 鏡頭錄的：自動去掉頭尾手放下的部分
  if (src === 'camera') autoTrim();
  $('edSegs').innerHTML = ''; edDraw(); edRange();
  $('editor').scrollIntoView({ behavior: 'smooth' });
  if (frames.length > FPS * 8) autoSegments();
}
function autoTrim() {
  const up = ed.frames.map(f => handsUp(f));
  let a = up.indexOf(true), b = up.lastIndexOf(true);
  if (a >= 0) { ed.a = Math.max(0, a - 2); ed.b = Math.min(ed.frames.length - 1, b + 2); }
}
function edDraw() {
  const c = $('edCanvas'); const r = c.getBoundingClientRect(); const d = Math.min(2, devicePixelRatio || 1);
  if (c.width !== Math.round(r.width * d)) { c.width = Math.round(r.width * d); c.height = Math.round(r.height * d); }
  drawAvatar(c.getContext('2d'), ed.norm[ed.pos], { style: player.style, caption: (ed.pos >= ed.a && ed.pos <= ed.b) ? '選取中' : '' });
  $('edTime').textContent = `${(ed.pos / FPS).toFixed(1)} 秒 / ${(ed.frames.length / FPS).toFixed(1)} 秒`;
}
const edRange = () => { $('edRange').textContent = `${(ed.a / FPS).toFixed(1)} – ${(ed.b / FPS).toFixed(1)} 秒（${ed.b - ed.a + 1} 格）`; };
$('edPos').oninput = e => { ed.pos = +e.target.value; edDraw(); };
$('edIn').onclick = () => { ed.a = ed.pos; if (ed.b < ed.a) ed.b = ed.frames.length - 1; edRange(); };
$('edOut').onclick = () => { ed.b = ed.pos; if (ed.a > ed.b) ed.a = 0; edRange(); };
$('edPlay').onclick = () => {
  cancelAnimationFrame(ed.playing); const t0 = performance.now();
  const step = ts => {
    ed.pos = Math.min(ed.b, ed.a + Math.floor((ts - t0) / 1000 * FPS)); $('edPos').value = ed.pos; edDraw();
    if (ed.pos < ed.b) ed.playing = requestAnimationFrame(step);
  };
  ed.playing = requestAnimationFrame(step);
};
$('edClose').onclick = () => { $('editor').hidden = true; ed = null; };
$('edAdd').onclick = async () => {
  const w = $('edWord').value.trim(); if (!w) return toast('請輸入這段的中文意思');
  if (ed.b - ed.a < 5) return toast('選取太短');
  await store.localPut(makeSample(w, ed.frames.slice(ed.a, ed.b + 1), ed.src, { t: [ed.a / FPS, ed.b / FPS], aspect: ed.aspect, cat: $('edCat').value }));
  toast(`已加入「${w}」`); $('edWord').value = ''; await loadCorpus();
};
async function autoSegments() {
  if (!featsReady) await attachFeats();
  const out = []; const sg = new Segmenter(fr => out.push(fr));
  // 用索引記錄每段位置
  ed.frames.forEach((f, i) => { f._i = i; sg.push(f); }); sg.flush();
  const segs = out.map(fr => [fr[0]._i, fr[fr.length - 1]._i]);
  $('edSegs').innerHTML = segs.length ? segs.map(([a, b], i) => {
    const guess = recog.classify(ed.frames.slice(a, b + 1), 1, true)[0];
    return `<div class="seg" data-a="${a}" data-b="${b}"><span>${(a / FPS).toFixed(1)}–${(b / FPS).toFixed(1)} 秒</span>
      <button data-go="1">看</button><input type="text" placeholder="中文意思" value="${guess && guess.dist <= S.threshold ? esc(guess.word) : ''}"><button data-add="1">＋</button></div>`;
  }).join('') : '<span class="muted">沒有偵測到手語動作</span>';
}
$('edAuto').onclick = autoSegments;
$('edSegs').onclick = async e => {
  const row = e.target.closest('.seg'); if (!row) return;
  const a = +row.dataset.a, b = +row.dataset.b;
  if (e.target.dataset.go) { ed.a = a; ed.b = b; ed.pos = a; $('edPos').value = a; edRange(); $('edPlay').click(); }
  if (e.target.dataset.add) {
    const w = row.querySelector('input').value.trim(); if (!w) return toast('請輸入中文意思');
    await store.localPut(makeSample(w, ed.frames.slice(a, b + 1), ed.src, { t: [a / FPS, b / FPS], aspect: ed.aspect, cat: $('edCat').value }));
    row.style.opacity = .5; e.target.disabled = true; toast(`已加入「${w}」`); await loadCorpus();
  }
};

// ---------- 設定 ----------
function fillSettings() {
  $('threshold').value = S.threshold; $('thVal').textContent = S.threshold;
  $('avatarSpeed').value = S.avatarSpeed; $('spVal').textContent = S.avatarSpeed + '×';
  $('rate').value = S.rate; $('rtVal').textContent = S.rate + '×'; $('aliases').value = S.aliases;
  if (!['vrm-f1', 'vrm-m3', '2d', 'custom'].includes(S.avatarKind)) S.avatarKind = /(^|-)m(\d|ale|$)/.test(S.avatarKind) ? 'vrm-m3' : 'vrm-f1';
  $('playMode').value = S.playMode;
  $('prefCat').value = S.prefCat; $('addCat').value = S.addCat; $('glossMode').value = S.glossMode; $('sttEngine').value = S.sttEngine;
  $('avatarKind').value = S.avatarKind; $('avatarUrl').value = S.avatarUrl; $('avatarUrl').hidden = S.avatarKind !== 'custom';
  const vs = ('speechSynthesis' in window) ? speechSynthesis.getVoices().filter(v => /zh/i.test(v.lang)) : [];
  $('voice').innerHTML = '<option value="">自動（台灣華語優先）</option>' + vs.map(v => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === S.voice ? 'selected' : ''}>${esc(v.name)}（${esc(v.lang)}）</option>`).join('');
}
for (const [id, out, suf] of [['threshold', 'thVal', ''], ['avatarSpeed', 'spVal', '×'], ['rate', 'rtVal', '×']]) $(id).oninput = e => { $(out).textContent = e.target.value + suf; };
$('saveSettings').onclick = () => {
  const old = S.avatarKind + S.avatarUrl;
  S = { ...S, threshold: +$('threshold').value, avatarSpeed: +$('avatarSpeed').value, voice: $('voice').value, rate: +$('rate').value, aliases: $('aliases').value,
    avatarKind: $('avatarKind').value, avatarUrl: $('avatarUrl').value.trim(), prefCat: $('prefCat').value, addCat: $('addCat').value, glossMode: $('glossMode').value, sttEngine: $('sttEngine').value };
  saveS();
  player.speed = real.speed = S.avatarSpeed; spot.threshold = S.threshold; toast('已儲存');
  if (S.avatarKind + S.avatarUrl !== old) applyAvatar();
};
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = fillSettings;
fillSettings();
$('addCat').onchange = e => { S.addCat = e.target.value; try { localStorage.setItem('tsl-settings', JSON.stringify(S)); } catch {} };
$('avatarKind').onchange = e => { $('avatarUrl').hidden = e.target.value !== 'custom'; };
$('verInfo').textContent = '版本 ' + VERSION; $('verFoot').textContent = $('f2fVer').textContent = '主恢復台灣手語對話翻譯・版本 ' + VERSION;

// ---------- PWA ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

route();
loadCorpus().then(applyAvatar);
// 收集模式（新增語料頁）
initCollect({ samplesFor: w => (byWord.get(w) || []).filter(s => s.shared), frames: s => sampleFrames(s), aspect: s => sampleAspect(s), toast });
window.__tsl = { spot, applyScene, enterF2F, exitF2F, endSentence, get logLines() { return logLines; }, onSign, attachFeats, glossTokens, enqueue, real, recog, store, get samples() { return samples; }, playText, loadCorpus, openEditor, player, preview };
