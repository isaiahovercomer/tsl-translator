// offline.js — 離線準備（v0.18）：先把常用的東西下載進快取（sw.js 會存起來），沒網路也能用
// - 情境詞（寒暄／聚會／召會＋基本詞）的手語骨架：聽人說話 → 手譯員比
// - 辨識特徵 feats.json、辨識模型（onnxruntime＋models/）、MediaPipe 手勢模型：手語 → 中文
// 沒網路時：語音辨識用不了（雲端／瀏覽器內建都要網路），AI 挑詞改唸第一候選、詞序改用規則（app.js 本來就會）。
const KEY = 'tsl-offline';
export const offlineInfo = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };

/** urls：要下載的網址；onProgress(done, total, bytes)；同時 6 個；回傳 {ok, fail, bytes} */
export async function prefetch(urls, onProgress = () => {}, { conc = 6, signal } = {}) {
  let i = 0, done = 0, ok = 0, fail = 0, bytes = 0;
  const one = async () => {
    while (i < urls.length) {
      if (signal && signal.aborted) return;
      const u = urls[i++];
      try { const r = await fetch(u); if (r.ok) { const b = await r.arrayBuffer(); bytes += b.byteLength; ok++; } else fail++; }
      catch { fail++; }
      onProgress(++done, urls.length, bytes);
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, urls.length) }, one));
  return { ok, fail, bytes };
}
export function markOffline(ver, words, bytes) {
  try { localStorage.setItem(KEY, JSON.stringify({ ver, words, mb: +(bytes / 1048576).toFixed(1), at: new Date().toISOString() })); } catch {}
}
// 可以自動下載嗎：確定是 Wi-Fi／有線、沒開省數據
export function onWifi() {
  const c = navigator.connection;
  return !!(c && !c.saveData && (c.type === 'wifi' || c.type === 'ethernet'));
}
