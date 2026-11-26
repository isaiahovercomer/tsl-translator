// model.js — 手語辨識模型（v0.17）：onnxruntime-web 跑 Colab 訓練的骨架分類器（tools/train_recog.py）
// 輸入＝core.js 的 seqFeat（16 格×86 維，跟 DTW 用的一樣），輸出＝每個詞的分數（logits）。
// 情境：不在情境裡的詞分數設成 -∞（同 Recognizer.setFilter：詞或同義詞在集合裡就算）。
// 切段（什麼時候一個詞比完）還是用 DTW 的距離決定；模型負責「這一段是哪個詞」→ fuse() 合併。
import { seqFeat, NSEQ, D } from './core.js';

export const MODEL_VER = 'v1';
const ORT_VER = '1.31.1';
const ORT = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/`;
const NONE = '_none';

export class ModelRecognizer {
  constructor(base = new URL(`../models/${MODEL_VER}/`, import.meta.url).href) {
    this.base = base; this.ready = false; this.state = 'off'; this.err = '';
    this.labels = []; this.mask = null; this.labelSet = new Set(); this.ms = 0; this._p = null;
  }
  load() {
    if (this._p) return this._p;
    this.state = 'loading';
    return this._p = (async () => {
      try {
        const ort = await import(/* @vite-ignore */ ORT + 'ort.wasm.min.mjs');
        ort.env.wasm.wasmPaths = ORT; ort.env.wasm.numThreads = 1;   // 沒有跨來源隔離就不能多執行緒
        this.labels = await (await fetch(this.base + 'labels.json')).json();
        this.labelSet = new Set(this.labels);
        this.session = await ort.InferenceSession.create(this.base + 'tsl-recog.int8.onnx', { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
        this.ort = ort; this.ready = true; this.state = 'ready';
        if (this._vocab) this.setVocab(...this._vocab);
      } catch (e) { this.state = 'error'; this.err = String(e && e.message || e); this._p = null; console.warn('辨識模型載入失敗', e); }
      return this.ready;
    })();
  }
  /** items：Recognizer.items（拿同義詞）；filter：Set<詞>｜null（情境） */
  setVocab(items, filter) {
    this._vocab = [items, filter];
    if (!this.labels.length) return;
    if (!filter) { this.mask = null; return; }
    const syn = new Map();
    for (const it of items || []) if (it.syn && it.syn.length) syn.set(it.word, it.syn);
    this.mask = Uint8Array.from(this.labels, w => w !== NONE && (filter.has(w) || (syn.get(w) || []).some(x => filter.has(x))) ? 1 : 0);
  }
  /** feat：seqFeat 的結果（16 個 Float32Array(86)）→ [{word, p}]（p＝情境內的機率）＋ none（不是手語的機率） */
  async rank(feat, topN = 3) {
    if (!this.ready) return null;
    const t0 = performance.now();
    const x = new Float32Array(NSEQ * D);
    feat.forEach((v, i) => x.set(v, i * D));
    const out = await this.session.run({ x: new this.ort.Tensor('float32', x, [1, NSEQ, D]) });
    const lg = out.logits.data, L = this.labels, m = this.mask;
    let mx = -Infinity;
    for (let i = 0; i < lg.length; i++) if ((!m || m[i] || L[i] === NONE) && lg[i] > mx) mx = lg[i];
    let sum = 0; const ex = new Float32Array(lg.length);
    for (let i = 0; i < lg.length; i++) if (!m || m[i] || L[i] === NONE) { ex[i] = Math.exp(lg[i] - mx); sum += ex[i]; }
    const idx = [];
    for (let i = 0; i < lg.length; i++) if (ex[i] > 0 && L[i] !== NONE) idx.push(i);
    idx.sort((a, b) => ex[b] - ex[a]);
    const ni = L.indexOf(NONE);
    this.ms = this.ms ? this.ms * 0.8 + (performance.now() - t0) * 0.2 : performance.now() - t0;
    return { top: idx.slice(0, topN).map(i => ({ word: L[i], p: ex[i] / sum })), none: ni >= 0 ? ex[ni] / sum : 0 };
  }
}

// DTW 候選＋模型候選 → 最後的候選（形狀跟 DTW 一樣 {word, dist}，多 p）
// - 這一段像不像手語（dist）還是用 DTW 的最佳距離，門檻、AI 挑詞的規則都不用改
// - 詞的順序用模型；其他候選的 dist 依機率比例往上加，機率差很多的會被「超過門檻 1.5 倍」濾掉
// - DTW 第一名是模型不認得的詞（自己錄的本機語料）→ 用 DTW 的
export function fuse(dtw, m, labelSet) {
  if (!m || !m.top.length || !dtw || !dtw.length) return dtw;
  if (m.none > 0.5) return null;                         // 模型說不是手語（有 _none 類別才會有）
  if (!labelSet.has(dtw[0].word)) return dtw;
  const d0 = dtw[0].dist, p0 = m.top[0].p;
  // 機率太低的候選不給（AI 挑詞時會被亂選）：至少 2%，且不低於第一名的 1/30
  return m.top.filter((c, i) => !i || c.p >= Math.max(0.02, p0 / 30)).map((c, i) => ({ word: c.word, p: +c.p.toFixed(3), dist: i ? d0 * (1 + 0.2 * Math.log(p0 / Math.max(c.p, 1e-6))) : d0 }));
}

// 把 Spotter 的 onWord／onRest 包起來：模型是非同步的，用佇列保持順序（詞、手放下照原本順序送出）
// getMode()：'model'｜'dtw'
export function modelStage(mr, getMode, onWord, onRest) {
  let q = Promise.resolve();
  return {
    word(cands, frames) {
      q = q.then(async () => {
        let out = cands, info = null;
        if (getMode() === 'model' && mr.ready && cands && cands.length) {
          try {
            const m = await mr.rank(seqFeat(frames), 3);
            out = fuse(cands, m, mr.labelSet);
            info = { eng: 'model', dtw: cands.map(c => [c.word, +c.dist.toFixed(3)]), none: m.none ? +m.none.toFixed(3) : 0 };
          } catch (e) { console.warn('模型辨識失敗，用 DTW', e); out = cands; }
        }
        if (out) onWord(out, frames, info);
      });
    },
    rest() { q = q.then(() => onRest && onRest()); },
  };
}
