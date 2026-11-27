// 雲端語音辨識（/api/stt，Cloudflare Workers AI 的 Whisper）
// 麥克風 → 偵測有人說話 → 停頓約 0.7 秒就把這一句錄音（16kHz WAV）送上去辨識 → 照順序回傳文字
// 每句會晚 1～3 秒，但比瀏覽器內建辨識穩，iPhone、LINE 內建瀏覽器都能用。
export class CloudSTT {
  constructor({ endpoint = 'api/stt', onText, onState, onError, onEmpty, onTimeout } = {}) {
    Object.assign(this, { endpoint, onText, onState, onError, onEmpty, onTimeout });
    this.running = false; this.paused = false; this.prev = ''; this.chain = Promise.resolve(); this.inflight = 0;
  }
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false });
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    this.rate = this.ctx.sampleRate;
    const src = this.ctx.createMediaStreamSource(this.stream);
    const mute = this.ctx.createGain(); mute.gain.value = 0;   // 輸出接一個音量 0 的節點（不然有些瀏覽器不會跑）
    // v0.20.1：優先用 AudioWorklet（在聲音執行緒收音）。面對面模式鏡頭辨識＋3D 手譯員讓主執行緒很忙時，
    // 舊的 ScriptProcessor（在主執行緒）會掉聲音 → 錄到斷斷續續的聲音，Whisper 辨識成亂碼或空白，畫面一直停在「聽到聲音…」。
    try {
      if (!this.ctx.audioWorklet) throw 0;
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(url); URL.revokeObjectURL(url);
      this.proc = new AudioWorkletNode(this.ctx, 'tsl-cap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      this.proc.port.onmessage = e => this.feed(e.data);
      this.worklet = true;
    } catch {
      // 舊瀏覽器：ScriptProcessor（iPhone Safari 舊版也能用）
      this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
      this.proc.onaudioprocess = e => this.feed(e.inputBuffer.getChannelData(0));
      this.worklet = false;
    }
    src.connect(this.proc); this.proc.connect(mute); mute.connect(this.ctx.destination);
    this.frameSec = 4096 / this.rate;
    this.noise = 0.01; this.seg = null; this.pre = []; this.hot = 0; this.quiet = 0;
    this.running = true; this.state('listening');
  }
  stop() {
    this.running = false; this.seg = null;
    try { if (this.proc) { this.proc.onaudioprocess = null; if (this.proc.port) this.proc.port.onmessage = null; this.proc.disconnect(); } } catch {}
    try { this.ctx && this.ctx.close(); } catch {}
    try { this.stream && this.stream.getTracks().forEach(t => t.stop()); } catch {}
    this.state('off');
  }
  pause() { this.paused = true; this.seg = null; this.hot = 0; }   // 自己在唸的時候不要聽
  resume() { this.paused = false; this.pre = []; }
  state(s) { this._st = s; this.onState && this.onState(s, this.inflight); }

  feed(x) {
    if (!this.running || this.paused) return;
    let sum = 0; for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
    const rms = Math.sqrt(sum / x.length), buf = new Float32Array(x);
    const th = Math.max(0.012, this.noise * 2.6), loud = rms > th;
    if (!this.seg) {
      if (!loud) this.noise = this.noise * 0.95 + Math.min(rms, this.noise * 2) * 0.05;   // 慢慢學背景音量
      this.pre.push(buf); if (this.pre.length > 4) this.pre.shift();                       // 開口前 0.3 秒也留著
      this.hot = loud ? this.hot + 1 : 0;
      if (this.hot >= 2) { this.seg = [...this.pre]; this.speech = this.hot; this.quiet = 0; this.pre = []; this.state('speech'); }
      return;
    }
    this.seg.push(buf);
    if (loud) { this.speech++; this.quiet = 0; } else this.quiet++;
    const len = this.seg.length * this.frameSec;
    if (this.quiet * this.frameSec >= 0.7 || len >= 12) {      // 停頓 0.7 秒，或一句太長（12 秒）就切
      const seg = this.seg; this.seg = null; this.hot = 0;
      if (this.speech * this.frameSec >= 0.35) this.send(seg); else this.state('listening');
    }
  }
  send(frames) {
    const wav = encodeWav(frames, this.rate, 16000);
    this.inflight++; this.state('recognizing');
    // v0.20.1：最多等 15 秒（手機網路卡住時，不要讓後面每一句都排在它後面等）
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 15000);
    const p = fetch(this.endpoint, { method: 'POST', headers: { 'content-type': 'audio/wav', 'x-prompt': encodeURIComponent(this.prev) }, body: wav, signal: ctl.signal })
      .then(async r => {
        if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
        return (await r.json()).text || '';
      })
      .catch(e => { if (e.name === 'AbortError') { this.onTimeout && this.onTimeout(); return ''; } throw e; })
      .finally(() => clearTimeout(tm));
    // 照說話順序交出結果（後面那句先辨識完也要等前面的）
    this.chain = this.chain.then(() => p).then(t => {
      if (t) { this.prev = t; this.empty = 0; this.onText && this.onText(t); }
      else { this.empty = (this.empty || 0) + 1; this.onEmpty && this.onEmpty(this.empty); }   // 連續聽不出字：提醒靠近一點
    }).catch(e => { this.onError && this.onError(e); })
      .finally(() => { this.inflight--; if (this.running) this.state(this.seg ? 'speech' : 'listening'); });
  }
}

// AudioWorklet：每 4096 個取樣送一包到主執行緒（跟 ScriptProcessor 一樣大小，feed() 不用改）
const WORKLET = `class C extends AudioWorkletProcessor {
  constructor() { super(); this.b = new Float32Array(4096); this.n = 0; }
  process(inp) {
    const x = inp[0] && inp[0][0];
    if (x) for (let i = 0; i < x.length; i++) { this.b[this.n++] = x[i]; if (this.n === 4096) { this.port.postMessage(this.b, [this.b.buffer]); this.b = new Float32Array(4096); this.n = 0; } }
    return true;
  }
}
registerProcessor('tsl-cap', C);`;

// Float32 片段（原本取樣率）→ 16kHz 單聲道 16-bit WAV
function encodeWav(frames, from, to) {
  let n = 0; for (const f of frames) n += f.length;
  const src = new Float32Array(n); let o = 0; for (const f of frames) { src.set(f, o); o += f.length; }
  const ratio = from / to, m = Math.floor(n / ratio), pcm = new Int16Array(m);
  for (let i = 0; i < m; i++) {   // 取區間平均（簡單的抗混疊）
    const a = Math.floor(i * ratio), b = Math.min(n, Math.floor((i + 1) * ratio)); let s = 0;
    for (let j = a; j < b; j++) s += src[j];
    const v = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf);
  const w = (p, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(p + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, to, true);
  dv.setUint32(28, to * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}
export { encodeWav };
