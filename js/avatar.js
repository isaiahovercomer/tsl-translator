// avatar.js — 用骨架資料畫出打手語的人像，並把多個詞接起來播放
import { OFF, PI, FI, P, FPS, has, newFrame, bodyRef } from './core.js';
import { drawCartoon } from './avatar2d.js';

// 標準身形（畫布正規化座標）：肩膀中點、肩寬
const STD = { cx: 0.5, cy: 0.46, w: 0.3 };

// 把一段樣本換到標準身形（用整段平均肩膀定位，不同人的語料就能接在一起）
// aspect = 影片寬÷高：先把 x、z 換成跟 y 一樣的單位，人像才不會變形
export function normalizeSeq(frames, aspect = 1) {
  if (aspect && aspect !== 1) frames = frames.map(f => {
    const g = new Float32Array(f);
    for (let i = 0; i < P; i++) { g[i * 3] *= aspect; g[i * 3 + 2] *= aspect; }
    g.bs = f.bs; return g;   // .bs＝臉部表情係數（有的語料才有）
  });
  const refs = frames.map(bodyRef).filter(Boolean);
  if (!refs.length) return frames;
  const r = { cx: mean(refs.map(x => x.cx)), cy: mean(refs.map(x => x.cy)), w: mean(refs.map(x => x.w)) };
  const k = STD.w / r.w;
  return frames.map(f => {
    const g = new Float32Array(f.length);
    for (let i = 0; i < P; i++) {
      g[i * 3] = (f[i * 3] - r.cx) * k + STD.cx;
      g[i * 3 + 1] = (f[i * 3 + 1] - r.cy) * k + STD.cy;
      g[i * 3 + 2] = f[i * 3 + 2] * k;
    }
    g.bs = f.bs;
    return fillMissing(g);
  });
}
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;

// ---- 休息姿勢 ----
// 手的形狀（相對手腕，手指朝 +y 方向，單位 = 手長）
const HAND_SHAPE = (() => {
  const base = [[0, 0]];
  const fingers = [[-0.35, [[-.2, .25], [-.3, .45], [-.38, .62], [-.43, .76]]],
    [-0.15, [[-.12, .55], [-.14, .78], [-.15, .92], [-.16, 1.03]]],
    [0, [[0, .57], [0, .82], [0, .97], [0, 1.1]]],
    [0.12, [[.12, .55], [.14, .77], [.15, .9], [.16, 1.0]]],
    [0.24, [[.23, .5], [.27, .67], [.29, .78], [.31, .87]]]];
  fingers.forEach(([, pts]) => pts.forEach(p => base.push(p)));
  return base; // 21 點
})();
function placeHand(f, off, wx, wy, dirx, diry, len, mirror) {
  const nx = -diry, ny = dirx;
  HAND_SHAPE.forEach(([a, b], j) => {
    const s = mirror ? -a : a;
    f[(off + j) * 3] = wx + (dirx * b + nx * s) * len;
    f[(off + j) * 3 + 1] = wy + (diry * b + ny * s) * len;
    f[(off + j) * 3 + 2] = 0;
  });
}
export function restFrame() {
  const f = newFrame(); const { cx, cy, w } = STD; const h = w / 2;
  const set = (i, x, y) => { f[(OFF.pose + i) * 3] = x; f[(OFF.pose + i) * 3 + 1] = y; f[(OFF.pose + i) * 3 + 2] = 0; };
  set(PI.nose, cx, cy - 0.62 * w); set(PI.lEye, cx + 0.1 * w, cy - 0.7 * w); set(PI.rEye, cx - 0.1 * w, cy - 0.7 * w);
  set(PI.lEar, cx + 0.22 * w, cy - 0.66 * w); set(PI.rEar, cx - 0.22 * w, cy - 0.66 * w);
  set(PI.mouthL, cx + 0.07 * w, cy - 0.5 * w); set(PI.mouthR, cx - 0.07 * w, cy - 0.5 * w);
  set(PI.lSh, cx + h, cy); set(PI.rSh, cx - h, cy);
  set(PI.lEl, cx + h + 0.08 * w, cy + 0.75 * w); set(PI.rEl, cx - h - 0.08 * w, cy + 0.75 * w);
  set(PI.lWr, cx + h * 0.55, cy + 1.3 * w); set(PI.rWr, cx - h * 0.55, cy + 1.3 * w);
  set(PI.lHip, cx + 0.36 * w, cy + 1.55 * w); set(PI.rHip, cx - 0.36 * w, cy + 1.55 * w);
  placeHand(f, OFF.lh, cx + h * 0.55, cy + 1.3 * w, -0.3, 0.95, 0.3 * w, true);
  placeHand(f, OFF.rh, cx - h * 0.55, cy + 1.3 * w, 0.3, 0.95, 0.3 * w, false);
  return f;
}
const REST = restFrame();

// 沒偵測到的手：放在手腕，指向手肘→手腕的延長方向；沒偵測到的臉：不畫細節
export function fillMissing(f) {
  for (const [off, wr, el, mir] of [[OFF.lh, PI.lWr, PI.lEl, true], [OFF.rh, PI.rWr, PI.rEl, false]]) {
    if (has(f, off)) continue;
    const W = OFF.pose + wr, E = OFF.pose + el;
    if (!has(f, W)) { for (let j = 0; j < 21; j++) for (let c = 0; c < 3; c++) f[(off + j) * 3 + c] = REST[(off + j) * 3 + c]; continue; }
    const wx = f[W * 3], wy = f[W * 3 + 1];
    let dx = 0, dy = 1;
    if (has(f, E)) { dx = wx - f[E * 3]; dy = wy - f[E * 3 + 1]; const n = Math.hypot(dx, dy) || 1; dx /= n; dy /= n; }
    placeHand(f, off, wx, wy, dx, dy, STD.w * 0.3, mir);
  }
  return f;
}

export function lerpFrame(a, b, t) {
  const g = new Float32Array(a.length);
  for (let k = 0; k < a.length; k++) {
    const x = a[k], y = b[k];
    g[k] = Number.isNaN(x) ? y : Number.isNaN(y) ? x : x + (y - x) * t;
  }
  if (a.bs || b.bs) {   // 一邊沒有表情係數（例如回到休息姿勢）：當作平常臉，慢慢淡掉
    const A = a.bs, B = b.bs; g.bs = new Float32Array(52);
    for (let k = 0; k < 52; k++) g.bs[k] = (A ? A[k] : 0) * (1 - t) + (B ? B[k] : 0) * t;
  }
  return g;
}

// ---- 繪圖 ----
const HAND_BONES = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [0, 17, 18, 19, 20], [5, 9, 13, 17]];
export function drawAvatar(ctx, f, opt = {}) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const S = Math.min(W, H * 0.9);                 // 正規化座標 → 畫素
  const ox = (W - S) / 2, oy = (H - S) / 2 + S * 0.02;
  const X = i => ox + f[i * 3] * S, Y = i => oy + f[i * 3 + 1] * S;
  const p = i => OFF.pose + i;
  const skin = opt.skin || '#F2C9A5', shirt = opt.shirt || '#2F3343', line = '#3a2a22';
  ctx.clearRect(0, 0, W, H);
  if (opt.captionOnly) return drawCaption(ctx, opt.caption, W, H, S);
  if (opt.bg) { ctx.fillStyle = opt.bg; ctx.fillRect(0, 0, W, H); }
  if (opt.style) return drawCartoon(ctx, f, opt.style, opt);   // 2D 插畫人像（男女各兩款）
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const sw = Math.hypot(X(p(PI.lSh)) - X(p(PI.rSh)), Y(p(PI.lSh)) - Y(p(PI.rSh)));

  // 軀幹
  const hipY = Math.max(Y(p(PI.lHip)), Y(p(PI.rSh)) + sw * 1.6);
  ctx.fillStyle = shirt; ctx.beginPath();
  ctx.moveTo(X(p(PI.rSh)) - sw * 0.08, Y(p(PI.rSh)));
  ctx.quadraticCurveTo((X(p(PI.rSh)) + X(p(PI.lSh))) / 2, Y(p(PI.rSh)) - sw * 0.12, X(p(PI.lSh)) + sw * 0.08, Y(p(PI.lSh)));
  ctx.lineTo(X(p(PI.lSh)) + sw * 0.02, H + 10); ctx.lineTo(X(p(PI.rSh)) - sw * 0.02, H + 10); ctx.closePath(); ctx.fill();
  // 脖子與頭
  const hx = (X(p(PI.lEar)) + X(p(PI.rEar))) / 2 || X(p(PI.nose)), hy = Y(p(PI.nose)) - sw * 0.06;
  const headR = Math.max(sw * 0.3, Math.hypot(X(p(PI.lEar)) - X(p(PI.rEar)), Y(p(PI.lEar)) - Y(p(PI.rEar))) * 0.62);
  ctx.strokeStyle = skin; ctx.lineWidth = sw * 0.22;
  line2(ctx, hx, hy + headR * 0.6, (X(p(PI.lSh)) + X(p(PI.rSh))) / 2, (Y(p(PI.lSh)) + Y(p(PI.rSh))) / 2 - sw * 0.05);
  ctx.fillStyle = skin; ctx.beginPath(); ctx.ellipse(hx, hy, headR * 0.86, headR * 1.05, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#2b211c'; ctx.beginPath(); ctx.ellipse(hx, hy - headR * 0.45, headR * 0.9, headR * 0.62, 0, Math.PI, Math.PI * 2); ctx.fill();
  drawFace(ctx, f, X, Y, hx, hy, headR, sw, line);

  // 手臂（後面那隻先畫：z 比較大的）
  const arms = [[PI.lSh, PI.lEl, PI.lWr, OFF.lh], [PI.rSh, PI.rEl, PI.rWr, OFF.rh]]
    .sort((a, b) => (f[(b[3]) * 3 + 2] || 0) - (f[(a[3]) * 3 + 2] || 0));
  for (const [s, e, w, h] of arms) {
    const hx0 = has(f, h) ? X(h) : X(p(w)), hy0 = has(f, h) ? Y(h) : Y(p(w));
    ctx.strokeStyle = shirt; ctx.lineWidth = sw * 0.2;
    ctx.beginPath(); ctx.moveTo(X(p(s)), Y(p(s))); ctx.lineTo(X(p(e)), Y(p(e))); ctx.stroke();
    ctx.strokeStyle = '#3d4256'; ctx.lineWidth = sw * 0.17;
    ctx.beginPath(); ctx.moveTo(X(p(e)), Y(p(e))); ctx.lineTo(hx0, hy0); ctx.stroke();
    drawHand(ctx, f, h, X, Y, sw, skin, line);
  }
  drawCaption(ctx, opt.caption, W, H, S);
}
function drawCaption(ctx, caption, W, H, S) {
  if (caption) {
    ctx.font = `bold ${Math.round(S * 0.07)}px system-ui, "Noto Sans TC", sans-serif`;
    ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(47,51,67,.85)';
    const tw = ctx.measureText(caption).width + S * 0.06;
    // 很直的畫面（面對面模式、上半身特寫）：詞放右上角，不要蓋住比到腰附近的手
    const tall = H > W * 1.1, cx = tall ? W - tw / 2 - S * 0.03 : W / 2, y0 = tall ? S * 0.03 : H - S * 0.11;
    ctx.fillRect(cx - tw / 2, y0, tw, S * 0.09);
    ctx.fillStyle = '#fff'; ctx.fillText(caption, cx, y0 + S * 0.07);
  }
}
// 字卡：語料庫沒有的詞，大字打在手譯員胸前（手是放下的，不會擋到）
export function drawCard(ctx, text) {
  const W = ctx.canvas.width, H = ctx.canvas.height, S = Math.min(W, H);
  let fs = Math.round(S * 0.12);
  ctx.font = `bold ${fs}px system-ui, "Noto Sans TC", sans-serif`;
  const maxW = W * 0.86;
  while (fs > 12 && ctx.measureText(text).width > maxW - fs * 0.8) { fs = Math.round(fs * 0.9); ctx.font = `bold ${fs}px system-ui, "Noto Sans TC", sans-serif`; }
  const tw = ctx.measureText(text).width, bw = Math.max(tw + fs * 0.8, S * 0.36), bh = fs * 1.75, cx = W / 2, cy = H * 0.62;
  ctx.fillStyle = 'rgba(255,255,255,.94)'; ctx.strokeStyle = '#d4a017'; ctx.lineWidth = Math.max(2, fs * 0.06);
  const x = cx - bw / 2, y = cy - bh / 2, r = fs * 0.25;
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + bw, y, x + bw, y + bh, r); ctx.arcTo(x + bw, y + bh, x, y + bh, r); ctx.arcTo(x, y + bh, x, y, r); ctx.arcTo(x, y, x + bw, y, r); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#1f2533'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, cx, cy - fs * 0.1);
  // 小字說明放在框裡下方（放框外會蓋到臉）
  const sf = Math.max(10, Math.round(Math.min(fs * 0.26, S * 0.035)));
  ctx.font = `${sf}px system-ui, "Noto Sans TC", sans-serif`; ctx.fillStyle = '#8a6d0b';
  ctx.fillText('✍ 手語還沒收錄', cx, y + bh - sf * 0.75); ctx.textBaseline = 'alphabetic';
}
function line2(ctx, a, b, c, d) { ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke(); }
function drawHand(ctx, f, off, X, Y, sw, skin, line) {
  ctx.fillStyle = skin; ctx.beginPath();
  [0, 1, 5, 9, 13, 17].forEach((j, k) => k ? ctx.lineTo(X(off + j), Y(off + j)) : ctx.moveTo(X(off + j), Y(off + j)));
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = skin; ctx.lineWidth = sw * 0.055;
  for (const chain of HAND_BONES) {
    ctx.beginPath(); chain.forEach((j, k) => k ? ctx.lineTo(X(off + j), Y(off + j)) : ctx.moveTo(X(off + j), Y(off + j))); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(58,42,34,.35)'; ctx.lineWidth = Math.max(1, sw * 0.008);
  for (const chain of HAND_BONES.slice(0, 5)) {
    ctx.beginPath(); chain.forEach((j, k) => k ? ctx.lineTo(X(off + j), Y(off + j)) : ctx.moveTo(X(off + j), Y(off + j))); ctx.stroke();
  }
}
function drawFace(ctx, f, X, Y, hx, hy, r, sw, line) {
  const F = i => OFF.face + i;
  ctx.strokeStyle = line; ctx.fillStyle = line; ctx.lineWidth = Math.max(1.5, sw * 0.022);
  if (has(f, F(FI.noseTip))) {
    // 用真實臉部點：先把臉部點移到頭像中心（偵測的臉可能跟身體估計略有偏差）
    const fx = X(F(FI.noseTip)), fy = Y(F(FI.noseTip));
    const dx = hx - fx, dy = hy + r * 0.12 - fy;
    const q = i => [X(F(i)) + dx, Y(F(i)) + dy];
    for (const brow of [FI.lBrow, FI.rBrow]) { ctx.beginPath(); brow.forEach((i, k) => { const [x, y] = q(i); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); }
    for (const eye of [FI.lEye, FI.rEye]) {
      const [ax, ay] = q(eye[0]), [bx, by] = q(eye[1]), [tx, ty] = q(eye[2]), [ux, uy] = q(eye[3]);
      const open = Math.max(0.8, Math.abs(uy - ty) / 2);
      ctx.beginPath(); ctx.ellipse((ax + bx) / 2, (ay + by) / 2, Math.max(2, Math.abs(bx - ax) / 3), open, 0, 0, Math.PI * 2); ctx.fill();
    }
    const [mlx, mly] = q(FI.mouth[0]), [mrx, mry] = q(FI.mouth[1]), [itx, ity] = q(FI.mouth[4]), [ibx, iby] = q(FI.mouth[5]);
    const open = Math.abs(iby - ity);
    ctx.fillStyle = '#8a3b33'; ctx.beginPath();
    ctx.moveTo(mlx, mly); ctx.quadraticCurveTo((mlx + mrx) / 2, ity - open * 0.3, mrx, mry);
    ctx.quadraticCurveTo((mlx + mrx) / 2, iby + open * 0.3 + 1, mlx, mly); ctx.fill(); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.arc(hx - r * 0.3, hy, r * 0.07, 0, Math.PI * 2); ctx.arc(hx + r * 0.3, hy, r * 0.07, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(hx - r * 0.45, hy - r * 0.22); ctx.lineTo(hx - r * 0.15, hy - r * 0.25);
    ctx.moveTo(hx + r * 0.15, hy - r * 0.25); ctx.lineTo(hx + r * 0.45, hy - r * 0.22); ctx.stroke();
    ctx.beginPath(); ctx.arc(hx, hy + r * 0.35, r * 0.2, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  }
}

// ---- 播放器：把一串詞接起來，詞跟詞之間平滑過渡 ----
export class AvatarPlayer {
  constructor(canvas, opt = {}) {
    this.c = canvas; this.ctx = canvas.getContext('2d'); this.opt = opt;
    this.timeline = []; this.t0 = 0; this.cur = REST; this.idleSince = 0; this.onWord = opt.onWord || (() => {});
    this.speed = 1; this.lastWord = null; this.style = opt.style || null; this.pausedAt = 0;
    const loop = (ts) => { try { this.tick(ts); } catch (e) { console.warn(e); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  resize() {
    const r = this.c.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1);
    this.c.width = Math.round(r.width * d); this.c.height = Math.round(r.height * d);
  }
  // 3D 人像：給 glb 網址就換成 3D；給空值回到 2D。載入失敗會丟出錯誤（仍維持 2D）
  async set3D(url) {
    if (!url) { if (this.r3d) this.r3d.dispose(); this.r3d = null; return; }
    if (this.r3d && this.r3d.url === url) return;
    const { Avatar3D } = await import('./avatar3d.js');
    const r = new Avatar3D(this.c);
    try { await r.load(url); } catch (e) { r.dispose(); throw e; }
    if (this.r3d) this.r3d.dispose();
    this.r3d = r;
  }
  // items: [{word, frames, aspect}]，frames 是原始影格；{word, card: true}＝語料庫沒有的詞：手放下、把字打在畫面上（v0.18）
  play(items, append = true) {
    const now = performance.now();
    let start = this.cur;
    if (!append || !this.timeline.length) { this.timeline = []; this.t0 = now; }
    else start = this.timeline[this.timeline.length - 1].f;
    const push = (f, word, card) => this.timeline.push({ f, word, card });
    for (const it of items) {
      if (it.card) {
        const n = Math.round(FPS * Math.min(3, 0.7 + 0.3 * [...it.word].length));   // 一個字約 0.3 秒，最長 3 秒
        for (let i = 1; i <= 5; i++) push(lerpFrame(start, REST, ease(i / 6)), it.word, it.word);
        for (let i = 0; i < n; i++) push(REST, it.word, it.word);
        start = REST; continue;
      }
      const fr = normalizeSeq(it.frames, it.aspect);
      const trimmed = trimRest(fr);
      for (let i = 1; i <= 5; i++) push(lerpFrame(start, trimmed[0], ease(i / 6)), it.word);
      trimmed.forEach(f => push(f, it.word));
      start = trimmed[trimmed.length - 1];
    }
    for (let i = 1; i <= 8; i++) push(lerpFrame(start, REST, ease(i / 9)), null);
  }
  get busy() { return this.timeline.length > 0; }
  get paused() { return this.pausedAt > 0; }
  pause() { if (!this.pausedAt) this.pausedAt = performance.now(); }
  resume() { if (this.pausedAt) { this.t0 += performance.now() - this.pausedAt; this.pausedAt = 0; } }
  stop() { const was = this.timeline.length; this.timeline = []; this.pausedAt = 0; if (was) this.idle(); }
  idle() { setTimeout(() => this.opt.onIdle && this.opt.onIdle(), 0); }
  tick(ts) {
    if (this.c.width !== Math.round(this.c.getBoundingClientRect().width * Math.min(2, window.devicePixelRatio || 1))) this.resize();
    let f = this.cur, word = null, card = null;
    if (this.timeline.length) {
      const x = Math.max(0, ((this.pausedAt || ts) - this.t0) / 1000 * FPS * this.speed);
      const i = Math.floor(x);
      if (i >= this.timeline.length - 1) { f = this.timeline[this.timeline.length - 1].f; this.timeline = []; this.idle(); }
      else { f = lerpFrame(this.timeline[i].f, this.timeline[i + 1].f, x - i); word = this.timeline[i].word; card = this.timeline[i].card || null; }
    } else {
      // 待機時輕微呼吸
      const b = Math.sin(ts / 900) * 0.002;
      f = new Float32Array(REST); for (let k = 1; k < f.length; k += 3) f[k] += b;
    }
    this.cur = f;
    if (word !== this.lastWord) { this.lastWord = word; this.onWord(word); }
    if (!this.c.offsetParent) return;          // 分頁沒顯示就不畫，省電
    const caption = card ? '' : word || this.opt.idleCaption || '';
    if (this.r3d && this.r3d.ready) { this.r3d.render(f); drawAvatar(this.ctx, f, { caption, captionOnly: true }); }
    else drawAvatar(this.ctx, f, { ...this.opt, style: this.style, caption: this.pausedAt ? '⏸ ' + caption : caption });
    if (card) drawCard(this.ctx, card);
  }
}
const ease = t => t * t * (3 - 2 * t);
// 去掉樣本頭尾手放下的影格，讓詞跟詞接得緊
function trimRest(fr) {
  const lim = STD.cy + 1.1 * STD.w;
  const up = f => [OFF.pose + PI.lWr, OFF.pose + PI.rWr].some(i => has(f, i) && f[i * 3 + 1] < lim);
  let a = 0, b = fr.length - 1;
  while (a < b && !up(fr[a])) a++;
  while (b > a && !up(fr[b])) b--;
  return b - a >= 3 ? fr.slice(Math.max(0, a - 1), b + 2) : fr;
}
