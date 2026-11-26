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

// 一筆語料（sample）
export function makeSample(word, frames, src, extra = {}) {
  return { v: 1, id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    word: word.trim(), fps: FPS, frames: frames.length, P, src, created: new Date().toISOString(),
    data: encodeFrames(frames), ...extra };
}
export const sampleFrames = s => s._frames || (s._frames = decodeFrames(s.data, s.frames));

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
export class Recognizer {
  constructor() { this.items = []; }
  setSamples(samples) {
    this.items = samples.map(s => ({ word: s.word, id: s.id, feat: seqFeat(sampleFrames(s)) }));
  }
  get words() { return [...new Set(this.items.map(i => i.word))]; }
  classify(frames, topN = 3) {
    if (!this.items.length || frames.length < 4) return [];
    const q = seqFeat(frames); const best = new Map();
    for (const it of this.items) {
      const d = dtw(q, it.feat);
      if (!best.has(it.word) || d < best.get(it.word)) best.set(it.word, d);
    }
    return [...best].map(([word, dist]) => ({ word, dist })).sort((a, b) => a.dist - b.dist).slice(0, topN);
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
