// app.js — 介面與流程
import { FPS, Recognizer, Segmenter, tokenize, makeSample, sampleFrames, sampleAspect, estimateAspect, decodeFrames, handsActive as handsUp } from './core.js';
import { AvatarPlayer, normalizeSeq, drawAvatar } from './avatar.js';
import { Camera, extractFromFile, drawOverlay } from './vision.js';
import * as store from './store.js';

const VERSION = '0.2.0';
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), ms); }

// ---------- 設定 ----------
const DEF = { threshold: 1.4, avatarSpeed: 1, voice: '', rate: 1, aliases: '您好=你好\n多謝=謝謝\n感謝=謝謝', avatarKind: 'female', avatarUrl: '' };
let S = { ...DEF };
try { S = { ...DEF, ...JSON.parse(localStorage.getItem('tsl-settings') || '{}') }; } catch {}
const aliasMap = () => Object.fromEntries(S.aliases.split('\n').map(l => l.split('=').map(x => x.trim())).filter(a => a.length === 2 && a[0] && a[1]));

// ---------- 分頁 ----------
function route() {
  const v = (location.hash || '#talk').slice(1);
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
async function loadCorpus() {
  index = await store.sharedIndex();
  const [shared, local] = await Promise.all([store.sharedSamples(index), store.localAll()]);
  samples = [...shared, ...local];
  byWord = new Map();
  for (const s of samples) { if (!byWord.has(s.word)) byWord.set(s.word, []); byWord.get(s.word).push(s); }
  recog.setSamples(samples);
  renderCorpus(); renderRaw();
  $('avatarStatus').textContent = `語料庫：${byWord.size} 個詞、${samples.length} 筆樣本`;
}

// ---------- 對話：聽人說話 → 人像 ----------
const player = new AvatarPlayer($('avatar'), { onWord: w => highlightWord(w) });
player.speed = S.avatarSpeed;
// 3D 人像：寫實女性／男性（微軟 Rocketbox，MIT），或自訂 Mixamo／Biped 骨架 .glb；載入失敗就用 2D
const AVATAR_URLS = {
  female: 'avatars/tw-female.glb',
  male: 'avatars/tw-male.glb',
  eva: 'https://resources.gti.upf.edu/3Dcharacters/ReadyEva/ReadyEva.glb',
};
const vAsp = v => v && v.videoWidth && v.videoHeight ? +(v.videoWidth / v.videoHeight).toFixed(3) : undefined;
async function applyAvatar() {
  const url = S.avatarKind === '2d' ? null : S.avatarKind === 'custom' ? S.avatarUrl.trim() || null : AVATAR_URLS[S.avatarKind] || AVATAR_URLS.female;
  if (url) $('avatarStatus').textContent = '3D 人像載入中…';
  try { await Promise.all([player.set3D(url), preview.set3D(url)]); }
  catch (e) { console.warn(e); toast('3D 人像載入失敗，先用 2D 人像：' + e.message, 4000); player.set3D(null); preview.set3D(null); }
  $('avatarStatus').textContent = `語料庫：${byWord.size} 個詞、${samples.length} 筆樣本`;
}
let lastTokens = [];
function playText(text) {
  const toks = tokenize(text, [...byWord.keys()], aliasMap());
  lastTokens = toks;
  $('speechChips').innerHTML = toks.map((t, i) => `<span class="chip ${t.known ? 'known' : ''}" data-i="${i}">${esc(t.text)}${t.known && t.word !== t.text ? `<small>${esc(t.word)}</small>` : ''}</span>`).join('');
  const items = toks.filter(t => t.known).map(t => {
    const list = byWord.get(t.word); const s = list[Math.floor(Math.random() * list.length)];
    return { word: t.word, frames: sampleFrames(s), aspect: sampleAspect(s) };
  });
  if (items.length) player.play(items);
  else if (text.trim()) $('avatarStatus').textContent = '語料庫裡還沒有這些詞，先到「新增語料」錄起來。';
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

// 語音辨識（瀏覽器內建，台灣華語）
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let sr = null, listening = false, pausedForTTS = false;
function startListen() {
  if (!SR) { toast('這個瀏覽器不支援語音辨識，請用 Chrome 或 Safari'); return; }
  sr = new SR(); sr.lang = 'zh-TW'; sr.continuous = true; sr.interimResults = true;
  sr.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) { const t = r[0].transcript.trim(); if (t) { $('speechText').textContent = t; playText(t); } }
      else interim += r[0].transcript;
    }
    if (interim) $('speechText').innerHTML = `<span class="muted">${esc(interim)}…</span>`;
  };
  sr.onerror = e => { if (e.error === 'not-allowed') { toast('請允許使用麥克風'); listening = false; updateListenBtn(); } };
  sr.onend = () => { if (listening && !pausedForTTS) try { sr.start(); } catch {} };
  try { sr.start(); listening = true; } catch (e) { toast('無法啟動麥克風：' + e.message); }
  updateListenBtn();
}
function stopListen() { listening = false; try { sr && sr.stop(); } catch {} updateListenBtn(); }
function updateListenBtn() { $('btnListen').textContent = listening ? '⏹ 停止聆聽' : '🎤 開始聆聽'; $('btnListen').classList.toggle('rec', listening); }
$('btnListen').onclick = () => listening ? stopListen() : startListen();

// ---------- 對話：手語 → 語音 ----------
let cam = null, signWords = [], sentenceTimer = null;
const seg = new Segmenter(frames => onSign(frames));
function onSign(frames) {
  const res = recog.classify(frames, 4);
  if (!res.length) { $('camStatus').textContent = '語料庫是空的，先新增語料'; return; }
  const ok = res[0].dist <= S.threshold;
  signWords.push({ word: ok ? res[0].word : null, cands: res, frames });
  $('camStatus').textContent = '最接近：' + res.map(r => `${r.word}(${r.dist.toFixed(2)})`).join('、');
  renderSignChips(); scheduleSentence();
}
function renderSignChips() {
  $('signChips').innerHTML = signWords.map((w, i) => w.word
    ? `<span class="chip known" data-i="${i}">${esc(w.word)}</span>`
    : `<span class="chip unk" data-i="${i}" title="點一下選正確的詞">？${esc(w.cands[0].word)}</span>`).join('');
  $('signSentence').textContent = sentence();
}
$('signChips').onclick = e => {
  const c = e.target.closest('.chip'); if (!c) return;
  const w = signWords[c.dataset.i];
  const opts = w.cands.map(x => x.word);
  const pick = window.prompt('改成哪個詞？（也可以輸入新詞，會存成新語料）\n候選：' + opts.join('、'), opts[0]);
  if (!pick) return;
  w.word = pick.trim();
  // 改正的結果直接存成本機語料，越用越準
  store.localPut(makeSample(w.word, w.frames, 'correction', { aspect: vAsp($('camVideo')) })).then(loadCorpus);
  renderSignChips();
};
const sentence = () => signWords.filter(w => w.word).map(w => w.word).join('');
function scheduleSentence() {
  clearTimeout(sentenceTimer);
  sentenceTimer = setTimeout(() => { if ($('autoSpeak').checked && sentence()) speak(sentence()); }, 2200);
}
function speak(text) {
  if (!('speechSynthesis' in window)) { toast('這個瀏覽器不能發出語音'); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text); u.lang = 'zh-TW'; u.rate = S.rate;
  const v = speechSynthesis.getVoices().find(v => v.voiceURI === S.voice) || pickVoice(); if (v) u.voice = v;
  // 唸的時候暫停聆聽，避免把自己唸的話又翻成手語
  if (listening) { pausedForTTS = true; try { sr.stop(); } catch {} }
  u.onend = u.onerror = () => { if (pausedForTTS) { pausedForTTS = false; if (listening) try { sr.start(); } catch {} } };
  speechSynthesis.speak(u);
  signWords = []; setTimeout(() => { $('signChips').innerHTML = ''; }, 300);
  $('signSentence').textContent = text;
}
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  return vs.find(v => /zh[-_]TW/i.test(v.lang)) || vs.find(v => /zh/i.test(v.lang) && /Taiwan|臺灣|台灣/.test(v.name)) || vs.find(v => /zh/i.test(v.lang));
}
$('btnSpeak').onclick = () => { const s = sentence() || $('signSentence').textContent; if (s) speak(s); };
$('btnClear').onclick = () => { signWords = []; renderSignChips(); $('signSentence').textContent = ''; };
$('btnCam').onclick = async () => {
  if (cam && cam.running) { cam.stop(); $('btnCam').textContent = '📷 開啟鏡頭'; $('camHint').hidden = false; return; }
  $('camStatus').textContent = '載入手勢辨識模型中（第一次約 10–20 秒）…'; $('btnCam').disabled = true;
  const ov = $('camOverlay').getContext('2d');
  cam = new Camera($('camVideo'), (f, r) => {
    sizeTo($('camOverlay'), $('camVideo')); drawOverlay(ov, r, false);
    if (f) seg.push(f);
  });
  try { await cam.start(); $('camHint').hidden = true; $('btnCam').textContent = '⏹ 關閉鏡頭'; $('camStatus').textContent = '準備好了，請比手語'; }
  catch (e) { $('camStatus').textContent = '鏡頭無法開啟：' + e.message; }
  $('btnCam').disabled = false;
};
function sizeTo(canvas, video) {
  if (video.videoWidth && canvas.width !== video.videoWidth) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; }
}

// ---------- 語料庫畫面 ----------
let selWord = null;
const preview = new AvatarPlayer($('previewCanvas'), {});
function renderCorpus() {
  const q = $('corpusSearch').value.trim();
  const local = samples.filter(s => !s.shared).length;
  $('corpusStats').textContent = `${byWord.size} 個詞、${samples.length} 筆樣本（共用 ${samples.length - local}、本機 ${local}）`;
  const words = [...byWord.keys()].filter(w => !q || w.includes(q)).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  $('wordList').innerHTML = words.map(w => `<button class="word ${w === selWord ? 'sel' : ''}" data-w="${esc(w)}"><b>${esc(w)}</b><span class="muted">${byWord.get(w).length} 筆</span></button>`).join('')
    || '<span class="muted">還沒有語料。到「新增語料」開始建立。</span>';
  renderSamples();
}
$('corpusSearch').oninput = renderCorpus;
$('wordList').onclick = e => { const b = e.target.closest('.word'); if (!b) return; selWord = b.dataset.w; renderCorpus(); playSample(byWord.get(selWord)[0]); };
function renderSamples() {
  const list = selWord && byWord.get(selWord);
  $('wordTitle').textContent = list ? `「${selWord}」` : '選一個詞預覽';
  $('sampleList').innerHTML = list ? list.map((s, i) => `<div><span class="tag ${s.shared ? '' : 'local'}">${s.shared ? '共用' : '本機'}</span>
    <span class="grow">${(s.frames / (s.fps || FPS)).toFixed(1)} 秒・${esc(srcLabel(s.src))}</span>
    <button data-play="${i}">▶</button>${s.shared ? '' : `<button data-del="${i}">刪除</button>`}</div>`).join('') : '';
}
const srcLabel = s => !s ? '' : s.startsWith('youtube') ? 'YouTube' : s === 'camera' ? '鏡頭錄製' : s === 'upload' ? '上傳影片' : s === 'correction' ? '對話中改正' : s;
$('sampleList').onclick = async e => {
  const list = byWord.get(selWord); if (!list) return;
  if (e.target.dataset.play) playSample(list[e.target.dataset.play]);
  if (e.target.dataset.del) { await store.localDel(list[e.target.dataset.del].id); toast('已刪除'); await loadCorpus(); }
};
function playSample(s) { preview.play([{ word: s.word, frames: sampleFrames(s), aspect: sampleAspect(s) }], false); }
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
  const name = `台灣手語語料-${Date.now()}.json`;
  store.download(name, store.packFile(local));
  const body = `請把剛剛下載的檔案「${name}」拖到這個框框裡，再按 Submit。\n\n內容：${local.length} 筆，詞彙：${words.slice(0, 40).join('、')}`;
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
  const body = ['```', `url: ${url}`, 'segments:', ...segs.split('\n').filter(Boolean).map(l => '  ' + l.trim()), '```',
    '', '送出後雲端會自動下載影片、抽出骨架、刪除影片，完成後會在這裡留言。'].join('\n');
  window.open(store.issueUrl(`[匯入] ${url}`, body, 'ingest'), '_blank');
  toast('請在 GitHub 頁面按 Submit 送出');
};
function renderRaw() {
  const raw = index.raw || [];
  $('rawList').innerHTML = raw.length ? raw.map((r, i) => `<div><span class="grow">${esc(r.title || r.url)}<br><span class="muted">${(r.frames / FPS).toFixed(0)} 秒・已標 ${r.labeled || 0} 段</span></span><button data-raw="${i}">開啟切段</button></div>`).join('')
    : '<span class="muted">還沒有。貼 YouTube 網址送出後，會出現在這裡。</span>';
}
$('rawList').onclick = async e => {
  const i = e.target.dataset.raw; if (i === undefined) return;
  const entry = index.raw[i];
  try { const t = await store.rawTrack(entry); openEditor(decodeFrames(t.data, t.frames), 'youtube:' + (t.videoId || entry.id), '', entry.title || entry.url, t.aspect); }
  catch (err) { toast(err.message); }
};

// ---------- 切段編輯器 ----------
let ed = null;
function openEditor(frames, src, word, title, aspect) {
  aspect = aspect || estimateAspect(frames);
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
  drawAvatar(c.getContext('2d'), ed.norm[ed.pos], { caption: (ed.pos >= ed.a && ed.pos <= ed.b) ? '選取中' : '' });
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
  await store.localPut(makeSample(w, ed.frames.slice(ed.a, ed.b + 1), ed.src, { t: [ed.a / FPS, ed.b / FPS], aspect: ed.aspect }));
  toast(`已加入「${w}」`); $('edWord').value = ''; await loadCorpus();
};
function autoSegments() {
  const out = []; const sg = new Segmenter(fr => out.push(fr));
  // 用索引記錄每段位置
  ed.frames.forEach((f, i) => { f._i = i; sg.push(f); }); sg.flush();
  const segs = out.map(fr => [fr[0]._i, fr[fr.length - 1]._i]);
  $('edSegs').innerHTML = segs.length ? segs.map(([a, b], i) => {
    const guess = recog.classify(ed.frames.slice(a, b + 1), 1)[0];
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
    await store.localPut(makeSample(w, ed.frames.slice(a, b + 1), ed.src, { t: [a / FPS, b / FPS], aspect: ed.aspect }));
    row.style.opacity = .5; e.target.disabled = true; toast(`已加入「${w}」`); await loadCorpus();
  }
};

// ---------- 設定 ----------
function fillSettings() {
  $('threshold').value = S.threshold; $('thVal').textContent = S.threshold;
  $('avatarSpeed').value = S.avatarSpeed; $('spVal').textContent = S.avatarSpeed + '×';
  $('rate').value = S.rate; $('rtVal').textContent = S.rate + '×'; $('aliases').value = S.aliases;
  if (!AVATAR_URLS[S.avatarKind] && !['2d', 'custom'].includes(S.avatarKind)) S.avatarKind = 'female';
  $('avatarKind').value = S.avatarKind; $('avatarUrl').value = S.avatarUrl; $('avatarUrl').hidden = S.avatarKind !== 'custom';
  const vs = ('speechSynthesis' in window) ? speechSynthesis.getVoices().filter(v => /zh/i.test(v.lang)) : [];
  $('voice').innerHTML = '<option value="">自動（台灣華語優先）</option>' + vs.map(v => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === S.voice ? 'selected' : ''}>${esc(v.name)}（${esc(v.lang)}）</option>`).join('');
}
for (const [id, out, suf] of [['threshold', 'thVal', ''], ['avatarSpeed', 'spVal', '×'], ['rate', 'rtVal', '×']]) $(id).oninput = e => { $(out).textContent = e.target.value + suf; };
$('saveSettings').onclick = () => {
  const old = S.avatarKind + S.avatarUrl;
  S = { threshold: +$('threshold').value, avatarSpeed: +$('avatarSpeed').value, voice: $('voice').value, rate: +$('rate').value, aliases: $('aliases').value,
    avatarKind: $('avatarKind').value, avatarUrl: $('avatarUrl').value.trim() };
  try { localStorage.setItem('tsl-settings', JSON.stringify(S)); } catch {}
  player.speed = S.avatarSpeed; toast('已儲存');
  if (S.avatarKind + S.avatarUrl !== old) applyAvatar();
};
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = fillSettings;
fillSettings();
$('avatarKind').onchange = e => { $('avatarUrl').hidden = e.target.value !== 'custom'; };
$('verInfo').textContent = '版本 ' + VERSION;

// ---------- PWA ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

route();
loadCorpus().then(applyAvatar);
window.__tsl = { recog, store, get samples() { return samples; }, playText, loadCorpus, openEditor, player, preview };
