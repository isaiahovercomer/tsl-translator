// spot-client.js — 主執行緒這邊的「邊比邊找詞」：優先用背景執行緒（recog-worker.js），不支援就在主執行緒跑
// 介面跟 core.js 的 Spotter 一樣：push(f)、flush()、threshold、on、moving；另外 sync() 把語料／情境送過去
import { Spotter } from './core.js';
export function makeSpotter(recog, onWord, opt = {}) {
  const local = () => new Spotter(recog, onWord, opt);
  let w = null;
  try { if (typeof Worker !== 'undefined' && !/noworker/.test(location.hash)) w = new Worker(new URL('./recog-worker.js', import.meta.url), { type: 'module' }); } catch { w = null; }
  if (!w) { const s = local(); s.sync = () => {}; s.worker = false; s.stats = { ms: 0 }; return s; }
  let fb = null, sentItems = null, th = opt.threshold || 1.4;
  const p = {
    worker: true, on: false, moving: false, stats: { ms: 0 },
    get threshold() { return th; }, set threshold(v) { th = v; if (fb) fb.threshold = v; else w.postMessage({ t: 'th', v }); },
    push(f) { if (fb) return fb.push(f); w.postMessage({ t: 'f', f }); },
    flush() { if (fb) fb.flush(); else w.postMessage({ t: 'flush' }); },
    sync() {   // 語料變了才送整包特徵（幾 MB），情境變了只送詞的集合
      if (fb) return;
      if (sentItems !== recog.items) { sentItems = recog.items; w.postMessage({ t: 'items', items: recog.items, filter: recog.filter }); }
      else w.postMessage({ t: 'filter', filter: recog.filter });
    },
  };
  w.onmessage = e => {
    const m = e.data;
    if (m.t === 'word') onWord(m.cands, m.frames);
    else if (m.t === 'rest') opt.onRest && opt.onRest();
    else if (m.t === 'st') { p.on = m.on; p.moving = m.moving; }
    else if (m.t === 'ms') p.stats.ms = p.stats.ms ? p.stats.ms * 0.8 + m.ms * 0.2 : m.ms;
  };
  // 背景執行緒開不起來（舊瀏覽器不支援 module worker）：改回主執行緒
  w.onerror = e => {
    console.warn('辨識背景執行緒失敗，改用主執行緒', e.message || e);
    try { w.terminate(); } catch {}
    fb = local(); fb.threshold = th; p.worker = false;
    Object.defineProperty(p, 'on', { get: () => fb.on }); Object.defineProperty(p, 'moving', { get: () => fb.moving });
  };
  p.threshold = th;
  return p;
}
