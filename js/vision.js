// vision.js — MediaPipe Holistic：鏡頭即時抓骨架、影片檔逐格抽骨架（影片本身不保存）
import { fromLandmarks, FPS } from './core.js';

const VER = '0.10.21';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task';

async function create(delegate) {
  const { FilesetResolver, HolisticLandmarker } = await import(`${CDN}/vision_bundle.mjs`);
  const fs = await FilesetResolver.forVisionTasks(`${CDN}/wasm`);
  return HolisticLandmarker.createFromOptions(fs, {
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO',
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5,
    minHandLandmarksConfidence: 0.4, minFaceDetectionConfidence: 0.4,
  });
}
// 每個用途各一個實例（VIDEO 模式的時間戳必須遞增）
export async function getLandmarker() {
  try { return await create('GPU'); } catch (e) { console.warn('GPU 失敗，改用 CPU', e); return create('CPU'); }
}

export function toFrame(r) {
  const pose = r.poseLandmarks && r.poseLandmarks[0];
  if (!pose) return null;
  return fromLandmarks(pose, r.leftHandLandmarks && r.leftHandLandmarks[0],
    r.rightHandLandmarks && r.rightHandLandmarks[0], r.faceLandmarks && r.faceLandmarks[0]);
}

// 鏡頭：每 1/15 秒取一格，回呼 (frame, rawResult)
export class Camera {
  constructor(video, onFrame) { this.video = video; this.onFrame = onFrame; this.running = false; }
  async start(facing = 'user') {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 960 }, height: { ideal: 720 } }, audio: false });
    return this.startStream(stream);
  }
  // 擷取其他分頁（例如正在播的 YouTube）：getDisplayMedia 必須在按鈕點擊裡呼叫
  static async pickTab() {
    return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false, preferCurrentTab: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'include' });
  }
  async startStream(stream) {
    this.stream = stream;
    stream.getVideoTracks()[0].addEventListener('ended', () => this.onEnded && this.onEnded());
    this.lm = this.lm || await getLandmarker();
    this.video.srcObject = this.stream; this.video.muted = true; this.video.playsInline = true;
    await this.video.play();
    this.running = true; this.last = 0; this.lastTs = 0;
    const step = () => {
      if (!this.running) return;
      const now = performance.now();
      if (now - this.last >= 1000 / FPS && this.video.readyState >= 2) {
        this.last = now;
        const ts = Math.max(this.lastTs + 1, Math.round(now)); this.lastTs = ts;
        try { const r = this.lm.detectForVideo(this.video, ts); this.onFrame(toFrame(r), r); } catch (e) { console.warn(e); }
      }
      this.raf = requestAnimationFrame(step);
    };
    step();
  }
  stop() {
    this.running = false; cancelAnimationFrame(this.raf);
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.video.srcObject = null;
  }
}

// 影片檔 → 骨架影格（每秒 15 格）。onProgress(0~1)。回傳 { frames, duration }
export async function extractFromFile(file, onProgress = () => {}, signal) {
  const lm = await getLandmarker();
  const url = URL.createObjectURL(file);
  const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  try {
    await new Promise((ok, bad) => { v.onloadedmetadata = ok; v.onerror = () => bad(new Error('無法讀取這個影片格式')); });
    const dur = v.duration; const n = Math.floor(dur * FPS); const frames = [];
    let empty = null;
    for (let i = 0; i < n; i++) {
      if (signal && signal.aborted) throw new Error('已取消');
      v.currentTime = i / FPS;
      await new Promise(ok => { v.onseeked = ok; });
      const r = lm.detectForVideo(v, Math.round(i * 1000 / FPS) + 1);
      const f = toFrame(r);
      frames.push(f || empty || (empty = new Float32Array(82 * 3).fill(NaN)));
      if (i % 5 === 0) onProgress(i / n);
    }
    onProgress(1);
    return { frames, duration: dur };
  } finally {
    v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url);   // 影片不留
    lm.close && lm.close();
  }
}

// 在影片上疊骨架（鏡頭預覽用）
export function drawOverlay(ctx, r, mirror) {
  const W = ctx.canvas.width, H = ctx.canvas.height; ctx.clearRect(0, 0, W, H);
  if (!r) return;
  const X = p => (mirror ? 1 - p.x : p.x) * W, Y = p => p.y * H;
  const dot = (p, c, s) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(X(p), Y(p), s, 0, 7); ctx.fill(); };
  const pose = r.poseLandmarks && r.poseLandmarks[0];
  if (pose) {
    ctx.strokeStyle = 'rgba(196,147,86,.9)'; ctx.lineWidth = 3;
    for (const [a, b] of [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24]]) {
      ctx.beginPath(); ctx.moveTo(X(pose[a]), Y(pose[a])); ctx.lineTo(X(pose[b]), Y(pose[b])); ctx.stroke();
    }
  }
  for (const [hand, c] of [[r.leftHandLandmarks && r.leftHandLandmarks[0], '#4FC3F7'], [r.rightHandLandmarks && r.rightHandLandmarks[0], '#FF8A65']]) {
    if (!hand) continue;
    ctx.strokeStyle = c; ctx.lineWidth = 2;
    for (const ch of [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [5, 9, 10, 11, 12], [9, 13, 14, 15, 16], [13, 17, 18, 19, 20], [0, 17]]) {
      ctx.beginPath(); ch.forEach((j, k) => k ? ctx.lineTo(X(hand[j]), Y(hand[j])) : ctx.moveTo(X(hand[j]), Y(hand[j]))); ctx.stroke();
    }
    hand.forEach(p => dot(p, c, 2.5));
  }
}
