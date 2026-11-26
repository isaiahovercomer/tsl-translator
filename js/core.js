// core.js — 骨架資料格式、特徵、比對（瀏覽器與 Node 都能用）
// 一個「影格」= Float32Array(P*3)，依序是 x,y,z；缺少的點為 NaN。座標是影像正規化座標（0~1，未鏡像）。

export const FPS = 15;
// 身體（MediaPipe Pose 33 點中的 15 點）
export const POSE_IDX = [0, 2, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 23, 24];
// 臉部（Face Mesh 478 點中的 25 點：眉、眼、嘴、鼻尖）
export const FACE_IDX = [70, 63, 105, 66, 107, 336, 296, 334, 293, 300,
  33, 133, 159, 145, 362, 263, 386, 374,
  61, 291, 0, 17, 13, 14, 1];
export const OFF = { pose: 0, lh: 15, rh: 36, face: 57 };
export const P = 82;
export const PI = { nose: 0, lEye: 1, rEye: 2, lEar: 3, rEar: 4, mouthL: 5, mouthR: 6,
  lSh: 7, rSh: 8, lEl: 9, rEl: 10, lWr: 11, rWr: 12, lHip: 13, rHip: 14 };
// 臉部子集合內的位置
export const FI = { lBrow: [0, 1, 2, 3, 4], rBrow: [5, 6, 7, 8, 9],
  lEye: [10, 11, 12, 13], rEye: [14, 15, 16, 17], mouth: [18, 19, 20, 21, 22, 23], noseTip: 24 };

const MISSING = -32768, SCALE = 8000;

export const newFrame = () => new Float32Array(P * 3).fill(NaN);
export const has = (f, i) => !Number.isNaN(f[i * 3]);
export const pt = (f, i) => [f[i * 3], f[i * 3 + 1], f[i * 3 + 2]];
function setPt(f, i, p) { f[i * 3] = p.x; f[i * 3 + 1] = p.y; f[i * 3 + 2] = p.z || 0; }
const d2 = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

// MediaPipe 結果 → 影格。pose: 33 點、lh/rh: 21 點（可為 null）、face: 478 點（可為 null）
// 左右手一律用「離哪個手腕近」來分配，避免不同模型的左右定義不一致。
export function fromLandmarks(pose, handA, handB, face) {
  const f = newFrame();
  if (pose && pose.length >= 25) POSE_IDX.forEach((k, i) => setPt(f, OFF.pose + i, pose[k]));
  const hands = [handA, handB].filter(h => h && h.length === 21);
  if (hands.length && pose) {
    const L = pose[15], R = pose[16];
    const score = h => d2(h[0].x, h[0].y, L.x, L.y) - d2(h[0].x, h[0].y, R.x, R.y); // <0 靠左腕
    if (hands.length === 2) {
      const [a, b] = hands; const aLeft = score(a) < score(b);
      putHand(f, OFF.lh, aLeft ? a : b); putHand(f, OFF.rh, aLeft ? b : a);
    } else putHand(f, score(hands[0]) < 0 ? OFF.lh : OFF.rh, hands[0]);
  }
  if (face && face.length >= 468) FACE_IDX.forEach((k, i) => setPt(f, OFF.face + i, face[k]));
  return f;
}
function putHand(f, off, h) { for (let j = 0; j < 21; j++) setPt(f, off + j, h[j]); }

// ---- 編碼：Int16 → base64 ----
export function encodeFrames(frames) {
  const a = new Int16Array(frames.length * P * 3);
  frames.forEach((f, t) => {
    for (let k = 0; k < P * 3; k++) {
      const v = f[k];
      a[t * P * 3 + k] = Number.isNaN(v) ? MISSING : Math.max(-32000, Math.min(32000, Math.round(v * SCALE)));
    }
  });
  return b64(new Uint8Array(a.buffer));
}
export function decodeFrames(str, n) {
  const u = unb64(str); const a = new Int16Array(u.buffer, u.byteOffset, u.byteLength / 2);
  const count = n || a.length / (P * 3); const out = [];
  for (let t = 0; t < count; t++) {
    const f = new Float32Array(P * 3);
    for (let k = 0; k < P * 3; k++) { const v = a[t * P * 3 + k]; f[k] = v === MISSING ? NaN : v / SCALE; }
    out.push(f);
  }
  return out;
}
function b64(u8) {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
  let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
  const bin = atob(s); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u;
}

// 語料分類：一般生活用語、召會生活用語
export const CATS = { general: '一般生活用語', church: '召會生活用語' };
export const catOf = s => (s && CATS[s.cat]) ? s.cat : 'general';

// 一筆語料（sample）
export function makeSample(word, frames, src, extra = {}) {
  return { v: 1, id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    word: word.trim(), cat: 'general', fps: FPS, frames: frames.length, P, src, created: new Date().toISOString(),
    data: encodeFrames(frames), ...extra };
}
export const sampleFrames = s => s._frames || (s._frames = decodeFrames(s.data, s.frames));
// 影片寬高比（寬÷高）。x 以畫面寬、y 以畫面高正規化，3D 人像要用它換回真實比例。
// 新樣本會記在 s.aspect；舊樣本用手的骨長估計。
export const sampleAspect = s => s.aspect || s._aspect || (s._aspect = estimateAspect(sampleFrames(s)));
// 估計寬高比：手指骨長是固定的，找一個比例讓各影格的骨長最一致
export function estimateAspect(frames, fallback = 4 / 3) {
  const SEG = [[0, 5], [0, 17], [5, 17], [0, 9], [5, 6], [9, 10], [13, 14], [1, 2], [2, 3]];
  const hands = [];
  for (const f of frames) for (const off of [OFF.lh, OFF.rh]) if (has(f, off)) hands.push([f, off]);
  if (hands.length < 8) return fallback;
  const costAt = a => {
    let cost = 0;
    for (const [i, j] of SEG) {
      let sum = 0, sq = 0;
      for (const [f, off] of hands) {
        const p = (off + i) * 3, q = (off + j) * 3;
        const L = Math.hypot((f[p] - f[q]) * a, f[p + 1] - f[q + 1], (f[p + 2] - f[q + 2]) * a);
        sum += L; sq += L * L;
      }
      const m = sum / hands.length; cost += Math.sqrt(Math.max(0, sq / hands.length - m * m)) / (m || 1);
    }
    return cost;
  };
  let best = fallback, bestCost = Infinity;
  for (let a = 0.45; a <= 2.4; a *= 1.02) { const c = costAt(a); if (c < bestCost) { bestCost = c; best = a; } }
  // 手幾乎沒轉動時看不出比例：明顯比預設好才採用
  if (!(bestCost < costAt(fallback) * 0.85)) return fallback;
  return Math.round(best * 100) / 100;
}

// ---- 身體基準 ----
export function bodyRef(f) {
  const ls = OFF.pose + PI.lSh, rs = OFF.pose + PI.rSh;
  if (!has(f, ls) || !has(f, rs)) return null;
  const cx = (f[ls * 3] + f[rs * 3]) / 2, cy = (f[ls * 3 + 1] + f[rs * 3 + 1]) / 2;
  const w = d2(f[ls * 3], f[ls * 3 + 1], f[rs * 3], f[rs * 3 + 1]) || 0.2;
  return { cx, cy, w };
}
export function handPresent(f, side) { return has(f, (side === 'l' ? OFF.lh : OFF.rh)); }

// 手是否「舉起來在比」：手有偵測到，且手腕高於肩膀下方 1.3 個肩寬
export function handsActive(f, ref) {
  ref = ref || bodyRef(f); if (!ref) return false;
  for (const off of [OFF.lh, OFF.rh]) {
    if (has(f, off) && f[off * 3 + 1] < ref.cy + 1.3 * ref.w) return true;
  }
  return false;
}

// ---- 特徵：每隻手 = 在場(1) + 手腕相對肩膀中點(2) + 20 個手指點相對手腕(40) ----
export const D = 86;
export function frameFeat(f, ref) {
  ref = ref || bodyRef(f) || { cx: 0.5, cy: 0.4, w: 0.25 };
  const out = new Float32Array(D);
  [OFF.lh, OFF.rh].forEach((off, h) => {
    const o = h * 43;
    if (!has(f, off)) return;
    const wx = f[off * 3], wy = f[off * 3 + 1];
    out[o] = 1.5;
    out[o + 1] = (wx - ref.cx) / ref.w * 1.5; out[o + 2] = (wy - ref.cy) / ref.w * 1.5;
    const hs = d2(wx, wy, f[(off + 9) * 3], f[(off + 9) * 3 + 1]) || 0.05;
    for (let j = 1; j < 21; j++) {
      out[o + 1 + j * 2] = (f[(off + j) * 3] - wx) / hs * 0.5;
      out[o + 2 + j * 2] = (f[(off + j) * 3 + 1] - wy) / hs * 0.5;
    }
  });
  return out;
}

export const NSEQ = 16;
// 特徵壓縮成 Int8（共用語料預先算好放 corpus/feats.json，免得一次下載全部骨架）
const FQ = 40;
export function encodeFeat(seq) {
  const a = new Int8Array(NSEQ * D);
  seq.forEach((v, i) => { for (let k = 0; k < D; k++) a[i * D + k] = Math.max(-127, Math.min(127, Math.round(v[k] * FQ))); });
  return b64(new Uint8Array(a.buffer));
}
export function decodeFeat(str) {
  const u = unb64(str), a = new Int8Array(u.buffer, u.byteOffset, u.byteLength);
  return Array.from({ length: NSEQ }, (_, i) => Float32Array.from(a.subarray(i * D, (i + 1) * D), x => x / FQ));
}
// 一段影格 → 固定 16 格的特徵序列（以整段平均身體基準正規化）
export function seqFeat(frames) {
  const refs = frames.map(bodyRef).filter(Boolean);
  const ref = refs.length ? { cx: avg(refs, 'cx'), cy: avg(refs, 'cy'), w: avg(refs, 'w') } : null;
  const feats = frames.map(f => frameFeat(f, ref));
  // 只保留有手的影格
  const act = feats.filter(v => v[0] || v[43]);
  const src = act.length >= 3 ? act : feats;
  const out = [];
  for (let i = 0; i < NSEQ; i++) {
    const x = i * (src.length - 1) / (NSEQ - 1), a = Math.floor(x), b = Math.min(src.length - 1, a + 1), t = x - a;
    const v = new Float32Array(D);
    for (let k = 0; k < D; k++) v[k] = src[a][k] * (1 - t) + src[b][k] * t;
    out.push(v);
  }
  return out;
}
const avg = (arr, k) => arr.reduce((s, r) => s + r[k], 0) / arr.length;

function vdist(a, b) { let s = 0; for (let k = 0; k < D; k++) { const d = a[k] - b[k]; s += d * d; } return Math.sqrt(s); }
export function dtw(A, B, band = 4) {
  const n = A.length, m = B.length, INF = 1e9;
  const M = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(INF)); M[0][0] = 0;
  for (let i = 1; i <= n; i++)
    for (let j = Math.max(1, i - band); j <= Math.min(m, i + band); j++)
      M[i][j] = vdist(A[i - 1], B[j - 1]) + Math.min(M[i - 1][j], M[i][j - 1], M[i - 1][j - 1]);
  return M[n][m] / (n + m);
}

// ---- 辨識器：每個詞取最近的樣本（k 近鄰） ----
// 情境（setFilter）：只在指定的詞裡找（詞或同義詞在集合裡就算）。詞多時先用粗略距離挑 PRE 個樣本，再算 DTW。
const PRE = 60, COARSE = [0, 3, 5, 8, 10, 13, 15];
function coarse(A, B) { let s = 0; for (const i of COARSE) { const a = A[i], b = B[i]; for (let k = 0; k < D; k++) { const d = a[k] - b[k]; s += d * d; } } return s; }
export class Recognizer {
  constructor() { this.items = []; this.filter = null; this.pool = []; }
  // 有 _feat（預先算好的特徵，共用語料）就直接用；本機語料現算
  setSamples(samples) {
    this.items = samples.filter(s => s._feat || s.data).map(s => ({ word: s.word, syn: s.syn || [], id: s.id, feat: s._feat || seqFeat(sampleFrames(s)) }));
    this.setFilter(this.filter);
  }
  /** set: Set<詞>，null＝全部 */
  setFilter(set) {
    this.filter = set && set.size ? set : null;
    this.pool = this.filter ? this.items.filter(it => this.filter.has(it.word) || it.syn.some(w => this.filter.has(w))) : this.items;
  }
  get words() { return [...new Set(this.pool.map(i => i.word))]; }
  // all=true：不管情境，全部詞彙都找（錄製／切段頁用）
  classify(frames, topN = 3, all = false) {
    if (!(all ? this.items : this.pool).length || frames.length < 4) return [];
    return this.classifyFeat(seqFeat(frames), topN, all);
  }
  classifyFeat(q, topN = 3, all = false) {
    let pool = all ? this.items : this.pool;
    if (pool.length > PRE * 1.5) pool = pool.map(it => [coarse(q, it.feat), it]).sort((a, b) => a[0] - b[0]).slice(0, PRE).map(x => x[1]);
    const best = new Map();
    for (const it of pool) {
      const d = dtw(q, it.feat);
      if (!best.has(it.word) || d < best.get(it.word)) best.set(it.word, d);
    }
    return [...best].map(([word, dist]) => ({ word, dist })).sort((a, b) => a.dist - b.dist).slice(0, topN);
  }
}

// ---- 邊比邊找詞（v0.13）：不用等手放下 ----
// 手舉起來就開始累積；每 STEP 格試一次「從上一個切點到現在」這段（也試略過開頭 3、6 格的過渡動作）。
// 一段的最佳距離到了最低點、之後越比越不像（代表這個詞比完了）→ 在最低點切開送出前 3 個候選。
// 手停住 STILL 格（詞和詞之間稍停）或手放下 → 也切。onWord(cands, frames)；onRest() = 手放下。
export class Spotter {
  constructor(recog, onWord, opt = {}) {
    this.recog = recog; this.onWord = onWord; this.onRest = opt.onRest || (() => {});
    this.threshold = opt.threshold || 1.4;
    // 可調參數（tools/test_spotter.mjs 調過）：稍停幾格就切、最低點要多像、之後變差多少、等幾格
    this.P = { still: 5, stillMax: 10, stillBest: 0.8, best: 0.6, rise: 1.5, after: 9, min: 12, ...(opt.params || {}) };
    this.buf = []; this.pre = []; this.on = false; this.idle = 0; this.still = 0; this.n = 0; this.best = null;
    this.moving = false;
  }
  reset() { this.buf = []; this.best = null; this.n = 0; this.still = 0; }
  push(f) {
    const ref = bodyRef(f); const act = handsActive(f, ref);
    if (!this.on) {
      this.pre.push(f); if (this.pre.length > 3) this.pre.shift();
      if (act) { this.on = true; this.buf = [...this.pre]; this.idle = 0; this.still = 0; this.best = null; this.n = 0; }
      return;
    }
    this.buf.push(f); this.n++; this.frameNo = (this.frameNo || 0) + 1;
    const prev = this.buf[this.buf.length - 2];
    const mv = prev ? motion(prev, f, ref) : 1;
    this.moving = mv >= 0.012;
    this.still = this.moving ? 0 : this.still + 1;
    this.idle = act ? 0 : this.idle + 1;
    if (this.still === 0) this.held = false;
    if (this.held && this.idle < 5) { if (this.buf.length > 4) this.buf = this.buf.slice(-4); return; }   // 切完還舉著不動：不累積
    if (this.idle >= 5) {                       // 手放下：剩下的送出
      this.cut(this.buf.length - 4); this.on = false; this.pre = []; this.held = false; this.onRest(); return;
    }
    // 詞和詞之間稍停：這段像一個完整的詞才切（手語詞本身也常有停頓）；停更久（stillMax）就一定切
    if (this.buf.length >= 10 && (this.still === this.P.still || this.still === this.P.stillMax)) {
      const fr = this.buf.slice(0, -3), c = this.still === this.P.stillMax ? null : this.recog.classify(fr, 1);
      const lim = this.threshold * this.P.stillBest * (fr.length < 12 ? 0.5 : 1);   // 很短的一段（多半是手舉起來的過渡動作）要更像才算
      if (!c || (c[0] && c[0].dist <= lim)) { this.cut(this.buf.length - 3); this.held = true; return; }
    }
    if (this.buf.length > FPS * 5) { this.cut(this.buf.length); return; }                    // 太長：硬切
    if (this.P.rise && this.n % 3 === 0 && this.buf.length >= this.P.min && this.still < 3) this.probe();
  }
  // 試現在這段；記住最低點；最低點之後連續變差 → 切在最低點
  probe() {
    const L = this.buf.length; let cur = null;
    for (const s of [0, 3, 6]) {
      if (L - s < this.P.min - 1) continue;
      const fr = this.buf.slice(s); if (!fr.some(f => has(f, OFF.lh) || has(f, OFF.rh))) continue;
      const c = this.recog.classify(fr, 3);
      if (c.length && (!cur || c[0].dist < cur.cands[0].dist)) cur = { cands: c, s, e: L };
    }
    if (!cur) return;
    const th = this.threshold;
    if (!this.best || cur.cands[0].dist <= this.best.cands[0].dist) { this.best = cur; return; }
    // 比完一個詞：最低點夠像、之後至少 6 格（0.4 秒）都比最低點差 12% 以上
    if (this.best.cands[0].dist <= th * this.P.best && L - this.best.e >= this.P.after && cur.cands[0].dist > this.best.cands[0].dist * this.P.rise) {
      const b = this.best;
      this.emit(b.cands, this.buf.slice(b.s, b.e));
      this.buf = this.buf.slice(Math.max(0, b.e - 2)); this.best = null; this.n = 0;
    }
  }
  // 切在 end：之前比過最低點且還沒送出 → 用它；不然整段辨識
  cut(end) {
    const fr = this.buf.slice(0, Math.max(0, end));
    this.buf = this.buf.slice(Math.max(0, end - 2)); this.n = 0;
    const b = this.best; this.best = null;
    if (fr.length < 6 || !fr.some(f => has(f, OFF.lh) || has(f, OFF.rh))) return;
    const c = this.recog.classify(fr, 3);
    const pick = b && b.e <= fr.length + 2 && b.cands[0].dist < (c[0] ? c[0].dist : 9) ? b : { cands: c, s: 0, e: fr.length };
    if (pick.cands.length) this.emit(pick.cands, fr.slice(pick.s, pick.e));
  }
  flush() { if (this.on) { this.cut(this.buf.length); this.on = false; } }
  // 同一個詞連續比兩次（手語常重複動作）→ 只算一次
  emit(cands, frames) {
    if (frames.length < 6) return;
    this.t = (this.t || 0) + 1;
    if (this.last && this.last.word === cands[0].word && this.frameNo - this.last.at < 30) { this.last.at = this.frameNo; return; }
    this.last = { word: cands[0].word, at: this.frameNo };
    this.onWord(cands, frames);
  }
}

// ---- 即時切段：手舉起來開始，放下（或停住）結束 ----
export class Segmenter {
  constructor(onSegment) { this.onSegment = onSegment; this.buf = []; this.pre = []; this.on = false; this.idle = 0; this.still = 0; }
  push(f) {
    const ref = bodyRef(f); const act = handsActive(f, ref);
    if (!this.on) {
      this.pre.push(f); if (this.pre.length > 3) this.pre.shift();
      if (act) { this.on = true; this.buf = [...this.pre]; this.idle = 0; this.still = 0; }
      return;
    }
    this.buf.push(f);
    // 停住偵測：連續 0.7 秒手幾乎不動 → 切成一個詞（讓連續比的詞也能分開）
    const prev = this.buf[this.buf.length - 2];
    const mv = prev ? motion(prev, f, ref) : 1;
    this.still = mv < 0.012 ? this.still + 1 : 0;
    this.idle = act ? 0 : this.idle + 1;
    if (this.idle >= 6) { this.emit(this.buf.slice(0, -5)); this.on = false; this.pre = []; }
    else if (this.still >= 10 && this.buf.length > 14) { this.emit(this.buf.slice(0, -8)); this.buf = this.buf.slice(-2); this.still = 0; }
    else if (this.buf.length > FPS * 6) { this.emit(this.buf); this.buf = []; }
  }
  flush() { if (this.on) { this.emit(this.buf); this.on = false; this.buf = []; } }
  emit(frames) { if (frames.length >= 6) this.onSegment(frames); }
}
function motion(a, b, ref) {
  let s = 0, n = 0;
  for (const off of [OFF.lh, OFF.rh]) for (const j of [0, 4, 8, 12, 16, 20]) {
    const i = off + j; if (!has(a, i) || !has(b, i)) continue;
    s += d2(a[i * 3], a[i * 3 + 1], b[i * 3], b[i * 3 + 1]); n++;
  }
  return n ? s / n / ((ref && ref.w) || 0.25) : 0;
}

// ---- 文字 → 詞：用語料庫裡有的詞做「最長比對」 ----
export function tokenize(text, vocab, aliases = {}) {
  const words = [...new Set([...vocab, ...Object.keys(aliases)])].sort((a, b) => b.length - a.length);
  const out = []; let i = 0; const s = text.replace(/[\s，。、！？,.!?；;：:「」『』（）()]/g, ' ');
  while (i < s.length) {
    if (s[i] === ' ') { i++; continue; }
    const w = words.find(w => s.startsWith(w, i));
    if (w) { out.push({ word: aliases[w] || w, text: w, known: true }); i += w.length; }
    else {
      const last = out[out.length - 1];
      if (last && !last.known) last.text += s[i]; else out.push({ text: s[i], known: false });
      i++;
    }
  }
  return out;
}
