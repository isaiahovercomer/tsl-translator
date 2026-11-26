// recog-worker.js — 邊比邊找詞放到背景執行緒（v0.15）：比對（DTW）很吃 CPU，放主執行緒會讓鏡頭掉格、手機發熱
// v0.17：切出來的每一段再用辨識模型（model.js）決定是哪個詞
// 收：{t:'items', items, filter} {t:'filter', filter} {t:'th', v} {t:'f', f} {t:'flush'} {t:'model', mode}
// 送：{t:'ready'} {t:'word', cands, frames, info} {t:'rest'} {t:'st', on, moving} {t:'ms', ms}（每次比對花幾毫秒）
//     {t:'model', state, err, ms}（模型狀態：loading／ready／error；ms＝模型每次幾毫秒）
import { Recognizer, Spotter } from './core.js';
import { ModelRecognizer, modelStage } from './model.js';
const recog = new Recognizer();
const mr = new ModelRecognizer();
let st = { on: false, moving: false }, mode = 'dtw';
const post = (m) => self.postMessage(m);
const stage = modelStage(mr, () => mode, (cands, frames, info) => { post({ t: 'word', cands, frames, info }); if (info) post({ t: 'model', state: mr.state, ms: mr.ms }); }, () => post({ t: 'rest' }));
const spot = new Spotter(recog, stage.word, { onRest: stage.rest });
self.onmessage = e => {
  const m = e.data;
  if (m.t === 'f') {
    const t0 = performance.now();
    spot.push(m.f);
    const ms = performance.now() - t0;
    if (ms > 1) post({ t: 'ms', ms });
    if (spot.on !== st.on || spot.moving !== st.moving) { st = { on: spot.on, moving: spot.moving }; post({ t: 'st', ...st }); }
  }
  else if (m.t === 'items') { recog.items = m.items; recog.setFilter(m.filter || null); mr.setVocab(recog.items, recog.filter); }
  else if (m.t === 'filter') { recog.setFilter(m.filter || null); mr.setVocab(recog.items, recog.filter); }
  else if (m.t === 'th') spot.threshold = m.v;
  else if (m.t === 'flush') spot.flush();
  else if (m.t === 'model') {
    mode = m.mode;
    if (mode === 'model') { post({ t: 'model', state: 'loading' }); mr.load().then(() => post({ t: 'model', state: mr.state, err: mr.err })); }
  }
};
post({ t: 'ready' });
