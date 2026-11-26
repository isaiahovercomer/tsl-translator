// realplayer.js — 寫實主播：每個詞一段事先算好的影片（Colab：colab/tsl_realistic.ipynb 產生，放在 realistic/<主播>/）
// 兩個 <video> 交替播放、淡入淡出接起來；沒有影片的詞交給原本的骨架人像（AvatarPlayer）比。
export class RealPlayer {
  constructor(stage, avatarPlayer, { onWord = () => {}, onIdle = () => {} } = {}) {
    this.stage = stage; this.ap = avatarPlayer; this.onWord = onWord; this.onIdle = onIdle;
    this.manifest = {}; this.base = ''; this.speed = 1; this.busy = false; this.paused = false; this.run = 0;
    this.v = [0, 1].map(() => {
      const v = document.createElement('video');
      Object.assign(v, { muted: true, playsInline: true, preload: 'auto' });
      v.className = 'real'; v.style.opacity = 0;
      stage.appendChild(v); return v;
    });
    this.cap = document.createElement('div'); this.cap.className = 'realcap'; stage.appendChild(this.cap);
    this.cur = 0;
  }
  // 載入某位主播的影片清單；沒有就回傳 0
  async load(presenter) {
    this.presenter = presenter; this.base = `realistic/${presenter}/`; this.manifest = {};
    try { const r = await fetch(this.base + 'manifest.json', { cache: 'no-cache' }); if (r.ok) this.manifest = await r.json(); } catch {}
    this.stage.classList.toggle('realmode', true);
    this.poster(); return Object.keys(this.manifest).length;
  }
  off() { this.stop(); this.stage.classList.remove('realmode'); this.v.forEach(v => { v.style.opacity = 0; v.removeAttribute('src'); v.load(); }); this.cap.textContent = ''; }
  has(word) { return !!this.manifest[word]; }
  // 待機：顯示主播圖
  poster() { const v = this.v[this.cur]; v.poster = this.base + 'presenter.png'; if (!v.src) v.style.opacity = 1; }
  url(word) { return this.base + this.manifest[word].file; }
  // items: [{word, frames, aspect}]（沒有影片的詞用骨架）
  async play(items) {
    const my = ++this.run; this.busy = true; this.paused = false;
    try {
      for (let i = 0; i < items.length; i++) {
        if (my !== this.run) return;
        const it = items[i];
        this.onWord(it.word); this.cap.textContent = it.word;
        if (this.has(it.word)) await this.clip(it.word, items[i + 1], my);
        else await this.skeleton(it, my);
      }
    } finally {
      if (my === this.run) { this.busy = false; this.onWord(null); this.cap.textContent = ''; this.onIdle(); }
    }
  }
  async clip(word, next, my) {
    const a = this.v[this.cur], b = this.v[1 - this.cur];
    if (a.dataset.word !== word) { a.src = this.url(word); a.dataset.word = word; }
    a.playbackRate = this.speed; a.currentTime = 0;
    this.stage.classList.remove('skel');
    await a.play().catch(() => {});
    a.style.opacity = 1; b.style.opacity = 0;
    if (next && this.has(next.word)) { b.src = this.url(next.word); b.dataset.word = next.word; b.load(); }   // 先載下一段
    await new Promise(res => {
      const done = () => { a.removeEventListener('ended', done); clearInterval(t); res(); };
      a.addEventListener('ended', done);
      const t = setInterval(() => { if (my !== this.run) done(); }, 100);
    });
    this.cur = 1 - this.cur;
  }
  async skeleton(it, my) {
    this.stage.classList.add('skel');           // 沒有寫實影片：先用畫的人像
    this.v.forEach(v => { v.style.opacity = 0; });
    this.ap.play([it], false);
    await new Promise(res => { const t = setInterval(() => { if (!this.ap.busy || my !== this.run) { clearInterval(t); res(); } }, 60); });
    this.stage.classList.remove('skel');
    this.v[this.cur].style.opacity = 1;
  }
  pause() { this.paused = true; this.v.forEach(v => v.pause()); this.ap.pause(); }
  resume() { this.paused = false; const v = this.v[this.cur]; if (this.busy && v.src && !v.ended && this.stage.classList.contains('skel') === false) v.play().catch(() => {}); this.ap.resume(); }
  stop() { this.run++; this.busy = false; this.paused = false; this.v.forEach(v => v.pause()); this.ap.stop(); this.cap.textContent = ''; }
}
