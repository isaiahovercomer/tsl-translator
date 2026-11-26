// spot-client.js — 主執行緒這邊的「邊比邊找詞」：優先用背景執行緒（recog-worker.js），不支援就在主執行緒跑
// 介面跟 core.js 的 Spotter 一樣：push(f)、flush()、threshold、on、moving；另外 sync() 把語料／情境送過去
// v0.17：setModel('model'|'dtw') 切換辨識方式；model = {state, ms, err}；onWord(cands, frames, info)
import { Spotter } from './core.js';
import { ModelRecognizer, modelStage } from './model.js';
export function makeSpotter(recog, onWord, opt = {}) {
  const onModel = opt.onModel || (() => {});
  // 主執行緒版（背景執行緒開不起來時）
  const local = (mode) => {
    const mr = new ModelRecognizer();
    const stage = modelStage(mr, () => s.mode, (c, f, info) => { onWord(c, f, info); if (info) { s.model.ms = mr.ms; } }, opt.onRest);
    const s = new Spotter(recog, stage.word, { ...opt, onRest: stage.rest });
    s.mode = mode || 'dtw'; s.model = { state: 'off', ms: 0, err: '' };
    s.setModel = m => {
      s.mode = m;
      if (m !== 'model') return;
      s.model.state = 'loading'; onModel(s.model);
      mr.setVocab(recog.items, recog.filter);
      mr.load().then(() => { s.model.state = mr.state; s.model.err = mr.err; onModel(s.model); });
    };
    s.sync = () => mr.setVocab(recog.items, recog.filter);
    return s;
  };
  let w = null;
  try { if (typeof Worker !== 'undefined' && !/noworker/.test(location.hash)) w = new Worker(new URL('./recog-worker.js', import.meta.url), { type: 'module' }); } catch { w = null; }
  if (!w) { const s = local(); s.worker = false; s.stats = { ms: 0 }; return s; }
  let fb = null, sentItems = null, th = opt.threshold || 1.4, mode = 'dtw';
  const p = {
    worker: true, on: false, moving: false, stats: { ms: 0 }, model: { state: 'off', ms: 0, err: '' },
    get mode() { return mode; },
    get threshold() { return th; }, set threshold(v) { th = v; if (fb) fb.threshold = v; else w.postMessage({ t: 'th', v }); },
    push(f) { if (fb) return fb.push(f); w.postMessage({ t: 'f', f }); },
    flush() { if (fb) fb.flush(); else w.postMessage({ t: 'flush' }); },
    setModel(m) { mode = m; if (fb) fb.setModel(m); else w.postMessage({ t: 'model', mode: m }); },
    sync() {   // 語料變了才送整包特徵（幾 MB），情境變了只送詞的集合
      if (fb) return fb.sync();
      if (sentItems !== recog.items) { sentItems = recog.items; w.postMessage({ t: 'items', items: recog.items, filter: recog.filter }); }
      else w.postMessage({ t: 'filter', filter: recog.filter });
    },
  };
  w.onmessage = e => {
    const m = e.data;
    if (m.t === 'word') onWord(m.cands, m.frames, m.info);
    else if (m.t === 'rest') opt.onRest && opt.onRest();
    else if (m.t === 'st') { p.on = m.on; p.moving = m.moving; }
    else if (m.t === 'ms') p.stats.ms = p.stats.ms ? p.stats.ms * 0.8 + m.ms * 0.2 : m.ms;
    else if (m.t === 'model') { const was = p.model.state; Object.assign(p.model, { state: m.state, err: m.err || p.model.err }); if (m.ms) p.model.ms = m.ms; if (was !== m.state) onModel(p.model); }
  };
  // 背景執行緒開不起來（舊瀏覽器不支援 module worker）：改回主執行緒
  w.onerror = e => {
    console.warn('辨識背景執行緒失敗，改用主執行緒', e.message || e);
    try { w.terminate(); } catch {}
    fb = local(mode); fb.threshold = th; p.worker = false; fb.sync();
    if (mode === 'model') fb.setModel(mode);
    p.model = fb.model;
    Object.defineProperty(p, 'on', { get: () => fb.on }); Object.defineProperty(p, 'moving', { get: () => fb.moving });
  };
  p.threshold = th;
  return p;
}
