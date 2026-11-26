// avatar2d.js — 2D 插畫風手語人像（男女各兩款），臉部表情由骨架的臉部點驅動
// 表情：眉毛上揚／下壓、皺眉、眼睛睜大／瞇眼／眨眼、嘴巴張合、嘴角上揚／下垂、頭部傾斜與轉向。
// 數值校正：用語料庫 2 萬多格臉部資料的中位數當「平常臉」，變化量放大一點，手語的臉部語法才看得清楚。
import { OFF, PI, FI, has } from './core.js';

export const STYLES = {
  f1: { name: '女・長髮', skin: '#F6D3BA', shade: '#E2AE92', hair: '#3A2721', hair2: '#563A30', shirt: '#2C7F7B', shirt2: '#22625F', collar: '#FFFFFF', lip: '#D9707A', iris: '#4A2E22', hairStyle: 'long', cuff: '#FFFFFF' },
  f2: { name: '女・短髮', skin: '#F3C8A6', shade: '#DCA584', hair: '#5A3626', hair2: '#764B37', shirt: '#8E3B4A', shirt2: '#702D3A', collar: '#F4E9DF', lip: '#CF5F68', iris: '#3D2A20', hairStyle: 'bob', cuff: '#F4E9DF', earring: true },
  m1: { name: '男・短髮', skin: '#EDC09C', shade: '#D29E7A', hair: '#1F1C1B', hair2: '#36302D', shirt: '#2B3F68', shirt2: '#1F2F50', collar: '#FFFFFF', lip: '#B9675F', iris: '#2E211B', hairStyle: 'short', cuff: '#2B3F68' },
  m2: { name: '男・眼鏡', skin: '#E6B68C', shade: '#C9946C', hair: '#3A2E2B', hair2: '#4F403B', shirt: '#3F5A47', shirt2: '#314737', collar: '#CFE0EE', lip: '#B36458', iris: '#2B1E18', hairStyle: 'side', glasses: true, cuff: '#CFE0EE' },
};
const INK = '#3B2B26';
const F = i => OFF.face + i;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ---- 臉部點 → 表情參數（-1～1 左右），每個畫布各自平滑，避免抖動 ----
const smooth = new WeakMap();
const NEUTRAL = { expr: { brow: 0, browL: 0, browR: 0, furrow: 0, eyeL: 0.85, eyeR: 0.85, mouth: 0, smile: 0, yaw: 0 } };
export function faceExpr(f) {
  if (!has(f, F(FI.noseTip))) return null;
  const x = i => f[F(i) * 3], y = i => f[F(i) * 3 + 1];
  const avgY = a => a.reduce((s, i) => s + y(i), 0) / a.length;
  const [mL, mR, , , iu, il] = FI.mouth;
  const browY = avgY([...FI.lBrow, ...FI.rBrow]);
  const mouthY = (y(mL) + y(mR) + y(iu) + y(il)) / 4;
  const H = mouthY - browY;
  if (!(H > 0)) return null;
  const eyeYL = (y(FI.lEye[0]) + y(FI.lEye[1])) / 2, eyeYR = (y(FI.rEye[0]) + y(FI.rEye[1])) / 2;
  const exL = (x(FI.lEye[0]) + x(FI.lEye[1])) / 2, exR = (x(FI.rEye[0]) + x(FI.rEye[1])) / 2;
  const eyeDist = Math.abs(exL - exR) || 1e-3;
  const bL = (eyeYL - avgY(FI.lBrow)) / H, bR = (eyeYR - avgY(FI.rBrow)) / H;
  const open = e => (y(e[3]) - y(e[2])) / H;
  return {
    browL: clamp((bL - 0.253) / 0.035, -1.2, 1.6), browR: clamp((bR - 0.253) / 0.035, -1.2, 1.6),
    furrow: clamp((0.47 - Math.abs(x(FI.lBrow[4]) - x(FI.rBrow[0])) / eyeDist) / 0.035, 0, 1.3),
    eyeL: clamp(open(FI.lEye) / 0.042, 0, 1.5), eyeR: clamp(open(FI.rEye) / 0.042, 0, 1.5),
    mouth: clamp((y(il) - y(iu)) / H / 0.05, 0, 1.2),
    smile: clamp(((y(iu) + y(il)) / 2 - (y(mL) + y(mR)) / 2) / H / 0.022 + 0.45, -1.2, 1.2),
    yaw: clamp((x(FI.noseTip) - (exL + exR) / 2) / eyeDist / 0.12, -1, 1),
  };
}
function smoothedExpr(ctx, f) {
  const raw = faceExpr(f);
  const st = smooth.get(ctx) || { e: { ...NEUTRAL.expr }, blinkAt: performance.now() + 2500 };
  const tgt = raw || NEUTRAL.expr;
  for (const k in st.e) if (tgt[k] !== undefined) st.e[k] += (tgt[k] - st.e[k]) * (raw ? 0.5 : 0.15);
  st.e.brow = (st.e.browL + st.e.browR) / 2;
  // 待機（沒有臉部資料）時自然眨眼
  const now = performance.now();
  let blink = 1;
  if (!raw) { const d = now - st.blinkAt; if (d > 0 && d < 160) blink = Math.abs(d - 80) / 80; else if (d >= 160) st.blinkAt = now + 2200 + Math.random() * 2500; }
  smooth.set(ctx, st);
  return { ...st.e, blink };
}

// ---- 主繪圖 ----
export function drawCartoon(ctx, f, style, opt = {}) {
  const st = STYLES[style] || STYLES.f1;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const S = Math.min(W, H * 0.9);
  const ox = (W - S) / 2, oy = (H - S) / 2 + S * 0.02;
  const X = i => ox + f[i * 3] * S, Y = i => oy + f[i * 3 + 1] * S;
  const p = i => OFF.pose + i;
  const lSh = [X(p(PI.lSh)), Y(p(PI.lSh))], rSh = [X(p(PI.rSh)), Y(p(PI.rSh))];
  const sw = Math.hypot(lSh[0] - rSh[0], lSh[1] - rSh[1]);
  const midSh = [(lSh[0] + rSh[0]) / 2, (lSh[1] + rSh[1]) / 2];
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  // 頭的位置、大小、傾斜：跟真實骨架一致，手碰臉的手勢才對得上
  const hasEars = has(f, p(PI.lEar)) && has(f, p(PI.rEar));
  const earD = hasEars ? Math.hypot(X(p(PI.lEar)) - X(p(PI.rEar)), Y(p(PI.lEar)) - Y(p(PI.rEar))) : sw * 0.4;
  const U = clamp(earD * 1.45, sw * 0.56, sw * 0.7);   // 頭寬（插畫風：頭稍大，表情才看得清楚）
  const hx0 = hasEars ? (X(p(PI.lEar)) + X(p(PI.rEar))) / 2 * 0.5 + X(p(PI.nose)) * 0.5 : X(p(PI.nose));
  // 頭不要離肩膀太遠（脖子才不會被拉長或歪掉）
  const hx = clamp(hx0, midSh[0] - sw * 0.18, midSh[0] + sw * 0.18);
  const hy = clamp(Y(p(PI.nose)) - U * 0.1, midSh[1] - sw * 0.82, midSh[1] - sw * 0.6);
  let roll = hasEars ? Math.atan2(Y(p(PI.lEar)) - Y(p(PI.rEar)), X(p(PI.lEar)) - X(p(PI.rEar))) : 0;
  if (roll > Math.PI / 2) roll -= Math.PI; if (roll < -Math.PI / 2) roll += Math.PI;
  roll = clamp(roll, -0.35, 0.35);
  const ex = smoothedExpr(ctx, f);

  // 1. 後面的頭髮
  withHead(ctx, hx, hy, roll, U, () => backHair(ctx, st));
  // 2. 脖子、身體
  const neckTop = [hx, hy + U * 0.5];
  ctx.fillStyle = st.skin; ctx.strokeStyle = st.shade; ctx.lineWidth = Math.max(1, U * 0.02);
  roundedQuad(ctx, [neckTop[0] - U * 0.17, neckTop[1]], [neckTop[0] + U * 0.17, neckTop[1]], [midSh[0] + U * 0.2, midSh[1] - sw * 0.02], [midSh[0] - U * 0.2, midSh[1] - sw * 0.02]); ctx.fill();
  ctx.fillStyle = st.shade; ctx.globalAlpha = 0.45; ctx.beginPath(); ctx.ellipse(neckTop[0], neckTop[1] + U * 0.06, U * 0.15, U * 0.07, 0, 0, Math.PI); ctx.fill(); ctx.globalAlpha = 1;
  torso(ctx, st, lSh, rSh, midSh, sw, U, H);
  // 3. 頭與臉
  withHead(ctx, hx, hy, roll, U, () => head(ctx, st, ex));
  // 4. 手臂與手（後面那隻先畫）
  const arms = [[PI.lSh, PI.lEl, PI.lWr, OFF.lh], [PI.rSh, PI.rEl, PI.rWr, OFF.rh]]
    .sort((a, b) => (f[b[3] * 3 + 2] || 0) - (f[a[3] * 3 + 2] || 0));
  for (const [s, e, w, h] of arms) arm(ctx, f, st, X, Y, p(s), p(e), p(w), h, sw);
  if (opt.caption) caption(ctx, opt.caption, W, H, S);
}

function withHead(ctx, hx, hy, roll, U, fn) { ctx.save(); ctx.translate(hx, hy); ctx.rotate(roll); ctx.scale(U, U); fn(); ctx.restore(); }

function roundedQuad(ctx, a, b, c, d) { ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.lineTo(...c); ctx.lineTo(...d); ctx.closePath(); }

function torso(ctx, st, lSh, rSh, mid, sw, U, H) {
  const L = lSh[0] > rSh[0] ? lSh : rSh, R = lSh[0] > rSh[0] ? rSh : lSh;   // 畫面右、左
  const bottom = H + 20, padX = sw * 0.12;
  ctx.fillStyle = st.shirt; ctx.strokeStyle = st.shirt2; ctx.lineWidth = Math.max(1.5, sw * 0.015);
  ctx.beginPath();
  ctx.moveTo(R[0] - padX * 0.2, R[1] + sw * 0.02);
  ctx.quadraticCurveTo(R[0] - padX, R[1] + sw * 0.05, R[0] - padX * 0.9, R[1] + sw * 0.35);
  ctx.lineTo(R[0] - padX * 0.6, bottom); ctx.lineTo(L[0] + padX * 0.6, bottom);
  ctx.lineTo(L[0] + padX * 0.9, L[1] + sw * 0.35);
  ctx.quadraticCurveTo(L[0] + padX, L[1] + sw * 0.05, L[0] + padX * 0.2, L[1] + sw * 0.02);
  ctx.quadraticCurveTo(mid[0], mid[1] - sw * 0.1, R[0] - padX * 0.2, R[1] + sw * 0.02);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  // 領口
  const cy = mid[1] - sw * 0.05, cw = U * 0.24;
  ctx.fillStyle = st.collar; ctx.strokeStyle = 'rgba(0,0,0,.15)'; ctx.lineWidth = Math.max(1, sw * 0.008);
  if (st.hairStyle === 'long' || st.hairStyle === 'bob') {   // 女：圓領／小翻領
    ctx.beginPath(); ctx.moveTo(mid[0] - cw, cy); ctx.quadraticCurveTo(mid[0], cy + U * 0.32, mid[0] + cw, cy);
    ctx.lineTo(mid[0] + cw * 0.75, cy - U * 0.02); ctx.quadraticCurveTo(mid[0], cy + U * 0.2, mid[0] - cw * 0.75, cy - U * 0.02); ctx.closePath(); ctx.fill(); ctx.stroke();
  } else {                                                    // 男：襯衫領（V 字）
    for (const s of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(mid[0] + s * cw * 0.25, cy - U * 0.02); ctx.lineTo(mid[0] + s * cw * 1.15, cy + U * 0.02);
      ctx.lineTo(mid[0] + s * cw * 0.55, cy + U * 0.28); ctx.lineTo(mid[0], cy + U * 0.16); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    if (st.hairStyle === 'side') {   // 毛衣 V 領
      ctx.strokeStyle = st.shirt2; ctx.lineWidth = Math.max(2, sw * 0.02);
      ctx.beginPath(); ctx.moveTo(mid[0] - cw * 1.1, cy + U * 0.06); ctx.lineTo(mid[0], cy + U * 0.55); ctx.lineTo(mid[0] + cw * 1.1, cy + U * 0.06); ctx.stroke();
    }
  }
}

// ---- 頭（座標：頭寬 = 1，原點在臉中心，y 向下）----
const FACE = ctx => {
  ctx.beginPath();
  ctx.moveTo(0, -0.62);
  ctx.bezierCurveTo(0.34, -0.62, 0.5, -0.4, 0.5, -0.08);
  ctx.bezierCurveTo(0.5, 0.26, 0.34, 0.5, 0.12, 0.6);
  ctx.quadraticCurveTo(0, 0.65, -0.12, 0.6);
  ctx.bezierCurveTo(-0.34, 0.5, -0.5, 0.26, -0.5, -0.08);
  ctx.bezierCurveTo(-0.5, -0.4, -0.34, -0.62, 0, -0.62);
  ctx.closePath();
};

function backHair(ctx, st) {
  ctx.fillStyle = st.hair;
  if (st.hairStyle === 'long') {
    ctx.beginPath(); ctx.moveTo(-0.58, -0.2);
    ctx.bezierCurveTo(-0.66, -0.85, 0.66, -0.85, 0.58, -0.2);
    ctx.bezierCurveTo(0.62, 0.35, 0.66, 0.85, 0.72, 1.2); ctx.quadraticCurveTo(0, 1.32, -0.72, 1.2);
    ctx.bezierCurveTo(-0.66, 0.85, -0.62, 0.35, -0.58, -0.2); ctx.fill();
  } else if (st.hairStyle === 'bob') {
    ctx.beginPath(); ctx.moveTo(-0.6, -0.2);
    ctx.bezierCurveTo(-0.68, -0.88, 0.68, -0.88, 0.6, -0.2);
    ctx.bezierCurveTo(0.62, 0.2, 0.64, 0.45, 0.6, 0.58); ctx.quadraticCurveTo(0.35, 0.66, 0.2, 0.58);
    ctx.lineTo(-0.2, 0.58); ctx.quadraticCurveTo(-0.35, 0.66, -0.6, 0.58);
    ctx.bezierCurveTo(-0.64, 0.45, -0.62, 0.2, -0.6, -0.2); ctx.fill();
  }
}

function head(ctx, st, e) {
  const lw = 0.022;
  // 耳朵
  ctx.fillStyle = st.skin; ctx.strokeStyle = st.shade; ctx.lineWidth = lw;
  for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(s * 0.5, 0.02, 0.07, 0.11, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  if (st.earring) { ctx.fillStyle = '#E8C15A'; for (const s of [-1, 1]) { ctx.beginPath(); ctx.arc(s * 0.52, 0.14, 0.025, 0, Math.PI * 2); ctx.fill(); } }
  // 臉
  ctx.fillStyle = st.skin; FACE(ctx); ctx.fill(); ctx.strokeStyle = st.shade; ctx.lineWidth = lw; ctx.stroke();
  // 腮紅
  ctx.fillStyle = '#F29C9C'; ctx.globalAlpha = 0.28 + Math.max(0, e.smile) * 0.12;
  for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(s * 0.3, 0.24, 0.09, 0.05, 0, 0, Math.PI * 2); ctx.fill(); }
  ctx.globalAlpha = 1;

  // 轉頭：五官往轉的方向移，遠的那邊縮一點
  const yaw = e.yaw * 0.08;
  ctx.save(); ctx.translate(yaw, 0);
  eyes(ctx, st, e);
  brows(ctx, st, e);
  // 鼻子
  ctx.strokeStyle = st.shade; ctx.lineWidth = 0.025;
  ctx.beginPath(); ctx.moveTo(0.015, 0.12); ctx.quadraticCurveTo(0.05, 0.22, 0, 0.24); ctx.stroke();
  mouth(ctx, st, e);
  if (st.glasses) glasses(ctx);
  ctx.restore();
  frontHair(ctx, st);
}

function eyes(ctx, st, e) {
  for (const [s, o] of [[-1, e.eyeR], [1, e.eyeL]]) {   // 畫面左＝人像右眼
    const cx = s * 0.19, cy = 0.04 - e.brow * 0.008;
    const open = clamp(o * e.blink, 0, 1.5);
    const w = 0.085, h = 0.075 * Math.min(1.25, open) + 0.004;
    if (open < 0.28) {   // 閉眼：笑的時候是彎月，不然是一條線
      ctx.strokeStyle = INK; ctx.lineWidth = 0.028; ctx.beginPath();
      if (e.smile > 0.4) ctx.arc(cx, cy + 0.025, w * 0.9, Math.PI * 1.15, Math.PI * 1.85);
      else { ctx.moveTo(cx - w, cy); ctx.quadraticCurveTo(cx, cy + 0.02, cx + w, cy); }
      ctx.stroke(); continue;
    }
    ctx.save();
    ctx.beginPath(); ctx.ellipse(cx, cy, w, h, 0, 0, Math.PI * 2); ctx.fillStyle = '#FFFFFF'; ctx.fill(); ctx.clip();
    ctx.fillStyle = st.iris; ctx.beginPath(); ctx.arc(cx, cy + 0.006, 0.058, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#120C0A'; ctx.beginPath(); ctx.arc(cx, cy + 0.006, 0.03, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#FFFFFF'; ctx.beginPath(); ctx.arc(cx + 0.02, cy - 0.016, 0.016, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // 上眼皮（睫毛線）
    ctx.strokeStyle = INK; ctx.lineWidth = 0.03;
    ctx.beginPath(); ctx.ellipse(cx, cy, w * 1.02, h * 1.02, 0, Math.PI * 1.08, Math.PI * 1.92); ctx.stroke();
    if (st.hairStyle === 'long' || st.hairStyle === 'bob') {   // 女：外眼角睫毛
      ctx.beginPath(); ctx.moveTo(cx + s * w * 0.95, cy - h * 0.35); ctx.lineTo(cx + s * w * 1.25, cy - h * 0.62); ctx.stroke();
    }
    // 下眼瞼：笑的時候往上推（笑眼）
    if (e.smile > 0.3) { ctx.strokeStyle = st.shade; ctx.lineWidth = 0.018; ctx.beginPath(); ctx.arc(cx, cy + h + 0.04, w * 0.8, Math.PI * 1.2, Math.PI * 1.8); ctx.stroke(); }
  }
}

function brows(ctx, st, e) {
  ctx.strokeStyle = st.hair2; ctx.lineWidth = 0.04; ctx.lineCap = 'round';
  for (const [s, b] of [[-1, e.browR], [1, e.browL]]) {
    const up = b * 0.055, fur = e.furrow;
    const ix = s * (0.075 - fur * 0.02), iy = -0.1 - up + fur * 0.035;      // 眉頭
    const ox = s * 0.3, oy = -0.1 - up * 0.7 - fur * 0.01;                   // 眉尾
    const mx = s * 0.19, my = Math.min(iy, oy) - 0.03 - Math.max(0, up) * 0.4;
    ctx.beginPath(); ctx.moveTo(ix, iy); ctx.quadraticCurveTo(mx, my, ox, oy); ctx.stroke();
  }
  if (e.furrow > 0.6) {   // 皺眉紋
    ctx.strokeStyle = st.shade; ctx.lineWidth = 0.014;
    ctx.beginPath(); ctx.moveTo(-0.02, -0.12); ctx.lineTo(-0.025, -0.06); ctx.moveTo(0.02, -0.12); ctx.lineTo(0.025, -0.06); ctx.stroke();
  }
}

function mouth(ctx, st, e) {
  const cy = 0.37, w = 0.12 + Math.max(0, e.smile) * 0.03, corner = -e.smile * 0.045, open = e.mouth;
  if (open < 0.15) {
    ctx.strokeStyle = st.lip; ctx.lineWidth = 0.03;
    ctx.beginPath(); ctx.moveTo(-w, cy + corner); ctx.quadraticCurveTo(0, cy + 0.02 + e.smile * 0.04, w, cy + corner); ctx.stroke();
    return;
  }
  const h = 0.03 + open * 0.13;
  ctx.fillStyle = '#7A2E2E'; ctx.strokeStyle = st.lip; ctx.lineWidth = 0.022;
  ctx.beginPath(); ctx.moveTo(-w, cy + corner);
  ctx.quadraticCurveTo(0, cy - 0.015 + e.smile * 0.01, w, cy + corner);
  ctx.quadraticCurveTo(w * 0.7, cy + h, 0, cy + h + 0.01);
  ctx.quadraticCurveTo(-w * 0.7, cy + h, -w, cy + corner);
  ctx.closePath(); ctx.fill();
  ctx.save(); ctx.clip();
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(-w, cy - 0.04, w * 2, 0.04 + Math.min(0.025, h * 0.3));   // 上排牙齒
  ctx.fillStyle = '#E07B7B'; ctx.beginPath(); ctx.ellipse(0, cy + h + 0.01, w * 0.6, h * 0.45, 0, 0, Math.PI * 2); ctx.fill();   // 舌頭
  ctx.restore();
  ctx.beginPath(); ctx.moveTo(-w, cy + corner); ctx.quadraticCurveTo(0, cy - 0.015 + e.smile * 0.01, w, cy + corner);
  ctx.quadraticCurveTo(w * 0.7, cy + h, 0, cy + h + 0.01); ctx.quadraticCurveTo(-w * 0.7, cy + h, -w, cy + corner); ctx.stroke();
}

function glasses(ctx) {
  ctx.strokeStyle = '#2D2523'; ctx.lineWidth = 0.022;
  for (const s of [-1, 1]) { ctx.beginPath(); roundRect(ctx, s * 0.19 - 0.12, -0.04, 0.24, 0.17, 0.05); ctx.stroke(); }
  ctx.beginPath(); ctx.moveTo(-0.07, 0.01); ctx.quadraticCurveTo(0, -0.02, 0.07, 0.01); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-0.31, 0); ctx.lineTo(-0.48, -0.02); ctx.moveTo(0.31, 0); ctx.lineTo(0.48, -0.02); ctx.stroke();
}
function roundRect(ctx, x, y, w, h, r) { ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

function frontHair(ctx, st) {
  ctx.fillStyle = st.hair;
  const h = st.hairStyle;
  ctx.beginPath();
  if (h === 'long') {          // 側分斜瀏海
    ctx.moveTo(-0.55, -0.05);
    ctx.bezierCurveTo(-0.62, -0.8, 0.62, -0.8, 0.55, -0.05);
    ctx.bezierCurveTo(0.5, -0.3, 0.4, -0.4, 0.2, -0.44);
    ctx.bezierCurveTo(0.05, -0.3, -0.25, -0.22, -0.42, -0.22);
    ctx.quadraticCurveTo(-0.5, -0.15, -0.55, -0.05);
  } else if (h === 'bob') {    // 齊瀏海
    ctx.moveTo(-0.56, 0.05);
    ctx.bezierCurveTo(-0.64, -0.82, 0.64, -0.82, 0.56, 0.05);
    ctx.quadraticCurveTo(0.5, -0.2, 0.42, -0.24);
    ctx.quadraticCurveTo(0, -0.17, -0.42, -0.24);
    ctx.quadraticCurveTo(-0.5, -0.2, -0.56, 0.05);
  } else if (h === 'short') {  // 短髮
    ctx.moveTo(-0.52, -0.12);
    ctx.bezierCurveTo(-0.6, -0.78, 0.6, -0.82, 0.52, -0.12);
    ctx.quadraticCurveTo(0.48, -0.34, 0.36, -0.38);
    ctx.lineTo(0.22, -0.33); ctx.lineTo(0.12, -0.4); ctx.lineTo(0, -0.34); ctx.lineTo(-0.14, -0.4); ctx.lineTo(-0.26, -0.33);
    ctx.quadraticCurveTo(-0.46, -0.34, -0.52, -0.12);
  } else {                     // 旁分油頭
    ctx.moveTo(-0.52, -0.1);
    ctx.bezierCurveTo(-0.6, -0.82, 0.6, -0.84, 0.53, -0.1);
    ctx.quadraticCurveTo(0.5, -0.36, 0.3, -0.42);
    ctx.bezierCurveTo(0.05, -0.36, -0.2, -0.46, -0.3, -0.4);
    ctx.quadraticCurveTo(-0.47, -0.32, -0.52, -0.1);
  }
  ctx.fill();
  // 頭髮光澤
  ctx.strokeStyle = st.hair2; ctx.lineWidth = 0.03; ctx.globalAlpha = 0.8;
  ctx.beginPath(); ctx.arc(0, -0.2, 0.42, Math.PI * 1.3, Math.PI * 1.55); ctx.stroke(); ctx.globalAlpha = 1;
  if (h === 'side') { ctx.strokeStyle = st.hair2; ctx.lineWidth = 0.02; ctx.beginPath(); ctx.moveTo(-0.2, -0.62); ctx.quadraticCurveTo(-0.22, -0.5, -0.3, -0.42); ctx.stroke(); }
}

// ---- 手臂與手：外框先畫（深色、較粗），再填色，看起來像插畫 ----
function arm(ctx, f, st, X, Y, s, e, w, h, sw) {
  const handOn = has(f, h);
  const wx = handOn ? X(h) : X(w), wy = handOn ? Y(h) : Y(w);
  const S0 = [X(s), Y(s)], E0 = [X(e), Y(e)], W0 = [wx, wy];
  const t1 = sw * 0.22, t2 = sw * 0.17, o = Math.max(3, sw * 0.04);
  const seg = (a, b, t, col) => { ctx.strokeStyle = col; ctx.lineWidth = t; ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke(); };
  seg(S0, E0, t1 + o, st.shirt2); seg(E0, W0, t2 + o, st.shirt2);
  seg(S0, E0, t1, st.shirt); seg(E0, W0, t2, st.shirt);
  ctx.globalAlpha = 0.12; seg(S0, E0, t1 * 0.35, '#FFFFFF'); seg(E0, W0, t2 * 0.3, '#FFFFFF'); ctx.globalAlpha = 1;   // 袖子亮面
  // 袖口
  const dx = W0[0] - E0[0], dy = W0[1] - E0[1], n = Math.hypot(dx, dy) || 1;
  const C = [W0[0] - dx / n * sw * 0.06, W0[1] - dy / n * sw * 0.06];
  seg(C, [W0[0] - dx / n * sw * 0.01, W0[1] - dy / n * sw * 0.01], t2 * 1.02, st.cuff);
  if (handOn) hand(ctx, f, h, X, Y, sw, st);
}

const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
function hand(ctx, f, off, X, Y, sw, st) {
  const P = j => [X(off + j), Y(off + j)];
  const hl = Math.hypot(P(9)[0] - P(0)[0], P(9)[1] - P(0)[1]) || sw * 0.15;   // 手掌長
  const ft = clamp(hl * 0.3, sw * 0.035, sw * 0.08), o = Math.max(1.5, ft * 0.22);
  const palm = [0, 1, 5, 9, 13, 17].map(P);
  const paths = () => {
    ctx.beginPath(); palm.forEach((q, k) => k ? ctx.lineTo(...q) : ctx.moveTo(...q)); ctx.closePath();
  };
  // 外框
  ctx.strokeStyle = st.shade; ctx.fillStyle = st.shade;
  ctx.lineWidth = ft * 1.25 + o * 2; paths(); ctx.fill(); ctx.stroke();
  FINGERS.forEach((c, k) => { ctx.lineWidth = (k ? ft : ft * 1.12) + o * 2; ctx.beginPath(); [k ? 0 : 0, ...c].forEach((j, i) => { if (k && i === 0) return; const q = P(j); (i === 0 || (k && i === 1)) ? ctx.moveTo(...q) : ctx.lineTo(...q); }); ctx.stroke(); });
  // 填色
  ctx.strokeStyle = st.skin; ctx.fillStyle = st.skin;
  ctx.lineWidth = ft * 1.25; paths(); ctx.fill(); ctx.stroke();
  FINGERS.forEach((c, k) => { ctx.lineWidth = k ? ft : ft * 1.12; ctx.beginPath(); [0, ...c].forEach((j, i) => { if (k && i === 0) return; const q = P(j); (i === 0 || (k && i === 1)) ? ctx.moveTo(...q) : ctx.lineTo(...q); }); ctx.stroke(); });
  // 指甲（指尖淡色）
  ctx.fillStyle = 'rgba(255,255,255,.45)';
  for (const c of FINGERS.slice(1)) { const q = P(c[3]); ctx.beginPath(); ctx.arc(q[0], q[1], ft * 0.22, 0, Math.PI * 2); ctx.fill(); }
}

function caption(ctx, text, W, H, S) {
  ctx.font = `bold ${Math.round(S * 0.07)}px system-ui, "Noto Sans TC", sans-serif`;
  ctx.textAlign = 'center';
  const tw = ctx.measureText(text).width + S * 0.08, bh = S * 0.095, x = W / 2 - tw / 2, y = H - S * 0.12;
  ctx.fillStyle = 'rgba(30,34,48,.82)'; ctx.beginPath(); roundRect(ctx, x, y, tw, bh, bh / 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.fillText(text, W / 2, y + bh * 0.72);
}
