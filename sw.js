// sw.js — 離線快取：程式本身先存起來；模型與語料用到才快取
const V = 'tsl-v0.8.1';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'js/app.js', 'js/core.js', 'js/avatar.js', 'js/avatar2d.js', 'js/realplayer.js', 'js/avatar3d.js', 'js/vision.js', 'js/store.js', 'js/gloss.js', 'icons/icon.svg', 'icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && k !== 'tsl-models').map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // MediaPipe 模型與 wasm、three.js、3D 人像：快取優先（檔案大、版本固定）
  if (/cdn\.jsdelivr\.net|storage\.googleapis\.com|resources\.gti\.upf\.edu/.test(u.host)) {
    e.respondWith(caches.open('tsl-models').then(async c => (await c.match(e.request)) || fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; })));
    return;
  }
  if (u.origin !== location.origin) return;
  // 3D 人像檔與已下載的語料骨架：不會改，快取優先（只下載一次）
  if (/\.mp4$/.test(u.pathname)) return;   // 影片交給瀏覽器（要支援分段讀取）
  if (/\/avatars\/|\/corpus\/signs\/|\/realistic\/.+\.png$/.test(u.pathname)) {
    e.respondWith(caches.open('tsl-models').then(async c => (await c.match(e.request)) || fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; })));
    return;
  }
  // 自己的檔案與語料：網路優先，離線時用快取
  e.respondWith(fetch(e.request).then(r => { if (r.ok) caches.open(V).then(c => c.put(e.request, r.clone())); return r; }).catch(() => caches.match(e.request)));
});
