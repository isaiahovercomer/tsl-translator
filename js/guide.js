// guide.js — 第一次使用說明、鏡頭／麥克風權限、安裝到主畫面、LINE 內建瀏覽器外開
const $ = id => document.getElementById(id);
const UA = navigator.userAgent;
export const ENV = {
  ios: /iPhone|iPad|iPod/i.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  android: /Android/i.test(UA),
  line: /\bLine\//i.test(UA),
  inApp: /\bLine\/|FBAN|FBAV|FB_IAB|Instagram|MicroMessenger|Messenger/i.test(UA),
  standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
};

// LINE 內建瀏覽器不能用鏡頭／麥克風：自動改用手機的預設瀏覽器打開（LINE 支援 openExternalBrowser=1）
export function escapeInApp() {
  if (!ENV.line) return false;
  const u = new URL(location.href);
  if (u.searchParams.get('openExternalBrowser') === '1') return false;   // 已經試過，還在 LINE 裡就別再跳
  u.searchParams.set('openExternalBrowser', '1');
  location.replace(u.toString());
  return true;
}

// ---------- 權限 ----------
async function query(name) { try { return (await navigator.permissions.query({ name })).state; } catch { return 'unknown'; } }
export async function permState() {
  if (!navigator.mediaDevices?.getUserMedia) return { cam: 'unsupported', mic: 'unsupported' };
  const [cam, mic] = await Promise.all([query('camera'), query('microphone')]);
  return { cam, mic };
}
// 怎麼把被拒絕的權限打開（依瀏覽器）
export function permHelpHtml() {
  if (ENV.inApp) return `你現在是在 <b>${ENV.line ? 'LINE' : 'App'} 內建的瀏覽器</b>裡，不能用鏡頭和麥克風。請點右上角「⋯」或「⋮」，選<b>「用預設瀏覽器開啟」</b>（${ENV.ios ? 'Safari' : 'Chrome'}）。`;
  if (!navigator.mediaDevices?.getUserMedia) return '這個瀏覽器不支援鏡頭和麥克風。請用 <b>Chrome</b>（Android）或 <b>Safari</b>（iPhone）打開。';
  if (ENV.ios) return ENV.standalone
    ? '請打開 iPhone 的<b>「設定」→ 往下找到這個 App（或 Safari）→ 相機、麥克風</b>改成「允許」，再回來重新打開。'
    : '請點網址列左邊的 <b>「ᴀA」</b>（或「⋯」）→ <b>網站設定</b> → <b>相機、麥克風</b>都改成「允許」，再重新整理頁面。<br>如果沒有這個選項：iPhone「設定」→ Safari → 相機／麥克風 → 允許。';
  if (ENV.android) return ENV.standalone
    ? '請長按主畫面上的 App 圖示 → <b>應用程式資訊 → 權限</b> → 打開<b>相機、麥克風</b>，再回來重新打開。'
    : '請點網址列左邊的 <b>🔒 或 ⓘ</b> → <b>權限</b>（或「網站設定」）→ 打開<b>相機、麥克風</b>，再重新整理頁面。';
  return '請點網址列左邊的 🔒 圖示 → 網站設定 → 相機、麥克風改成「允許」，再重新整理頁面。';
}
// 錯誤 → 看得懂的話
export function mediaErr(e, what = '鏡頭') {
  const n = e && e.name;
  if (e && e.code === 'MODEL') return e.message;
  if (n === 'NotAllowedError' || n === 'SecurityError') return `${what}權限被拒絕了。按「使用說明」看怎麼打開。`;
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return `找不到${what}。`;
  if (n === 'NotReadableError' || n === 'AbortError') return `${what}被其他 App 佔用中（例如視訊通話、相機），請先關掉再試。`;
  if (!navigator.mediaDevices?.getUserMedia) return `這個瀏覽器不能用${what}，請用 Chrome 或 Safari 打開。`;
  return `${what}無法開啟：` + ((e && e.message) || e);
}
// 一次問鏡頭＋麥克風（只跳一次詢問視窗），問完就關掉
export async function requestPerms() {
  if (!navigator.mediaDevices?.getUserMedia) return { cam: 'unsupported', mic: 'unsupported', error: new Error('unsupported') };
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: 'user' } });
    s.getTracks().forEach(t => t.stop());
    return { cam: 'granted', mic: 'granted' };
  } catch (e) {
    // 一起要失敗：分開再試，看是哪一個
    const one = async c => { try { const s = await navigator.mediaDevices.getUserMedia(c); s.getTracks().forEach(t => t.stop()); return 'granted'; } catch (x) { return x.name === 'NotAllowedError' ? 'denied' : 'error'; } };
    const cam = await one({ video: { facingMode: 'user' } }), mic = await one({ audio: true });
    return { cam, mic, error: e };
  }
}

// ---------- 安裝到主畫面 ----------
let deferred = null;
const installListeners = new Set();
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; installListeners.forEach(f => f()); });
addEventListener('appinstalled', () => { ENV.standalone = true; deferred = null; installListeners.forEach(f => f()); });
export const onInstallChange = f => installListeners.add(f);
export const canInstall = () => !ENV.standalone;
export async function install() {
  if (deferred) { deferred.prompt(); const r = await deferred.userChoice.catch(() => null); deferred = null; return r && r.outcome === 'accepted' ? 'ok' : 'cancel'; }
  return 'manual';
}
export function installHelpHtml() {
  if (ENV.inApp) return '請先用 Safari 或 Chrome 打開這個網頁，再安裝。';
  if (ENV.ios) return 'iPhone：點下面的 <b>分享按鈕（□↑）</b> → 往下滑選 <b>「加入主畫面」</b> → 右上角「加入」。';
  if (ENV.android) return 'Android：點右上角 <b>⋮</b> → <b>「安裝應用程式」</b>或<b>「加到主畫面」</b>。';
  return '電腦版 Chrome／Edge：點網址列右邊的 <b>安裝圖示（⊕）</b>，或選單 → 「安裝」。';
}

// ---------- 使用說明（全螢幕導覽） ----------
let page = 0, pages = [], onFinish = null;
function show(i) {
  page = Math.max(0, Math.min(pages.length - 1, i));
  pages.forEach((p, k) => p.hidden = k !== page);
  $('guideDots').innerHTML = pages.map((_, k) => `<i class="${k === page ? 'on' : ''}"></i>`).join('');
  $('guideBack').style.visibility = page ? 'visible' : 'hidden';
  $('guideNext').textContent = page === pages.length - 1 ? '開始使用 ✓' : '下一步 ›';
  if (pages[page].dataset.p === 'perm') refreshPerm();
  if (pages[page].dataset.p === 'install') refreshInstall();
}
export function openGuide(at = 0, done) {
  pages = [...document.querySelectorAll('#guide .gpage')];
  onFinish = done || null;
  const i = typeof at === 'string' ? pages.findIndex(p => p.dataset.p === at) : at;
  $('guide').hidden = false; document.body.classList.add('guide-on');
  show(Math.max(0, i));
}
function closeGuide() {
  $('guide').hidden = true; document.body.classList.remove('guide-on');
  try { localStorage.setItem('tsl-guided', '1'); } catch {}
  const f = onFinish; onFinish = null; if (f) f();
}
const label = st => ({ granted: '✅ 已允許', denied: '❌ 被拒絕', prompt: '尚未允許', unknown: '尚未確認', unsupported: '⚠️ 不支援', error: '⚠️ 無法使用' }[st] || st);
async function refreshPerm(res) {
  const st = res || await permState();
  $('permCam').textContent = '📷 鏡頭：' + label(st.cam);
  $('permMic').textContent = '🎤 麥克風：' + label(st.mic);
  const ok = st.cam === 'granted' && st.mic === 'granted';
  const bad = ['denied', 'unsupported', 'error'].includes(st.cam) || ['denied', 'unsupported', 'error'].includes(st.mic) || ENV.inApp;
  $('btnPerm').hidden = ok; $('permOk').hidden = !ok;
  $('permHelp').hidden = !bad; if (bad) $('permHelp').innerHTML = permHelpHtml();
  return ok;
}
function refreshInstall() {
  const done = ENV.standalone;
  $('btnInstall2').hidden = done; $('installDone').hidden = !done;
  $('installHelp').hidden = true;
}
export function initGuide({ onPermGranted } = {}) {
  $('guideNext').onclick = () => page === pages.length - 1 ? closeGuide() : show(page + 1);
  $('guideBack').onclick = () => show(page - 1);
  $('guideSkip').onclick = closeGuide;
  $('btnPerm').onclick = async () => {
    $('btnPerm').disabled = true; $('btnPerm').textContent = '請在跳出的視窗按「允許」…';
    const r = await requestPerms();
    $('btnPerm').disabled = false; $('btnPerm').textContent = '允許鏡頭和麥克風';
    const ok = await refreshPerm(r);
    if (ok && onPermGranted) onPermGranted();
  };
  $('btnInstall2').onclick = async () => {
    const r = await install();
    if (r === 'manual') { $('installHelp').hidden = false; $('installHelp').innerHTML = installHelpHtml(); }
    refreshInstall(); if (r === 'manual') $('installHelp').hidden = false;
  };
  // 左右滑動換頁
  let x0 = null;
  $('guide').addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
  $('guide').addEventListener('touchend', e => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null; if (Math.abs(dx) > 60) show(page + (dx < 0 ? 1 : -1)); });
}
export const guided = () => { try { return localStorage.getItem('tsl-guided') === '1'; } catch { return true; } };
