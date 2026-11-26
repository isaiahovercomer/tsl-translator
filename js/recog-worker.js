// recog-worker.js — 邊比邊找詞放到背景執行緒（v0.15）：比對（DTW）很吃 CPU，放主執行緒會讓鏡頭掉格、手機發熱
// 收：{t:'items', items, filter} {t:'filter', filter} {t:'th', v} {t:'f', f} {t:'flush'}
// 送：{t:'ready'} {t:'word', cands, frames} {t:'rest'} {t:'st', on, moving} {t:'ms', ms}（每次比對花幾毫秒）
import { Recognizer, Spotter } from './core.js';
const recog = new Recognizer();
let st = { on: false, moving: false };
const spot = new Spotter(recog, (cands, frames) => self.postMessage({ t: 'word', cands, frames }), { onRest: () => self.postMessage({ t: 'rest' }) });
self.onmessage = e => {
  const m = e.data;
  if (m.t === 'f') {
    const t0 = performance.now();
    spot.push(m.f);
    const ms = performance.now() - t0;
    if (ms > 1) self.postMessage({ t: 'ms', ms });
    if (spot.on !== st.on || spot.moving !== st.moving) { st = { on: spot.on, moving: spot.moving }; self.postMessage({ t: 'st', ...st }); }
  }
  else if (m.t === 'items') { recog.items = m.items; recog.setFilter(m.filter || null); }
  else if (m.t === 'filter') recog.setFilter(m.filter || null);
  else if (m.t === 'th') spot.threshold = m.v;
  else if (m.t === 'flush') spot.flush();
};
self.postMessage({ t: 'ready' });
