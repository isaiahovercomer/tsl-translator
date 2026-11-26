// store.js — 語料儲存：本機（IndexedDB）＋共用語料庫（repo 裡的 corpus/）
export const REPO = 'isaiahovercomer/tsl-translator';

let dbp = null;
function idb() {
  return dbp || (dbp = new Promise((ok, bad) => {
    const r = indexedDB.open('tsl-corpus', 2);   // v2：多一個 collect（收集模式錄的，等上傳）
    r.onupgradeneeded = () => { for (const n of ['samples', 'collect']) if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n, { keyPath: 'id' }); };
    r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
  }));
}
async function tx(mode, fn, name = 'samples') {
  const db = await idb();
  return new Promise((ok, bad) => {
    const t = db.transaction(name, mode); const st = t.objectStore(name);
    const res = fn(st); t.oncomplete = () => ok(res && res.result !== undefined ? res.result : res); t.onerror = () => bad(t.error);
  });
}
const clean = s => { const o = { ...s }; delete o._frames; delete o.shared; return o; };
export const localAll = () => tx('readonly', st => st.getAll()).catch(() => []);
export const localPut = s => tx('readwrite', st => st.put(clean(s)));
export const localDel = id => tx('readwrite', st => st.delete(id));
// 收集模式：{...sample, up: 0/1}
export const collectAll = () => tx('readonly', st => st.getAll(), 'collect').catch(() => []);
export const collectPut = s => tx('readwrite', st => st.put(clean(s)), 'collect');
export const collectDel = id => tx('readwrite', st => st.delete(id), 'collect');

// 共用語料庫：corpus/index.json = { signs:[{id,word,cat,file,src}], raw:[{id,title,url,cat,file,frames}] }
// 檔案依分類分資料夾：corpus/signs/general/、corpus/signs/church/（raw 同理）
export async function sharedIndex() {
  try { const r = await fetch('corpus/index.json', { cache: 'no-cache' }); return r.ok ? await r.json() : { signs: [], raw: [] }; }
  catch { return { signs: [], raw: [] }; }
}
// 共用語料很多（辭典 3500 詞）：先只用清單，骨架用到才下載（loadSample）
export function sharedSamples(index) {
  return (index.signs || []).map(e => ({ ...e, cat: e.cat || 'general', shared: true, stub: true }));
}
const loading = new Map();
export function loadSample(s) {
  if (s.data) return Promise.resolve(s);
  // 用 id 快取下載結果；重新載入語料清單後是新的物件，所以每次都把資料補到這個物件上
  if (!loading.has(s.id)) loading.set(s.id, fetch('corpus/' + s.file).then(r => { if (!r.ok) throw new Error('讀不到語料 ' + s.word); return r.json(); })
    .catch(e => { loading.delete(s.id); throw e; }));
  return loading.get(s.id).then(j => Object.assign(s, j, { shared: true, stub: false, cat: s.cat }));
}
// 共用語料的辨識特徵（預先算好）：開鏡頭辨識時才下載
let featsP = null;
export function sharedFeats() {
  return featsP || (featsP = fetch('corpus/feats.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : {}).catch(() => ({})));
}
export async function rawTrack(entry) {
  const r = await fetch('corpus/' + entry.file); if (!r.ok) throw new Error('讀不到這段影片的骨架資料'); return r.json();
}

// 匯出成檔案（PWA 裡可以直接下載）
export function download(name, obj) {
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
export function packFile(samples) {
  return { kind: 'tsl-corpus', v: 1, exported: new Date().toISOString(), samples: samples.map(clean) };
}
export async function readPack(file) {
  const j = JSON.parse(await file.text());
  const list = Array.isArray(j) ? j : j.samples || (j.data ? [j] : []);
  return list.filter(s => s && s.word && s.data && s.frames);
}

// 開 GitHub 新 issue（不用金鑰：使用者用自己的 GitHub 帳號送出，Actions 自動處理）
export function issueUrl(title, body, labels) {
  const q = new URLSearchParams({ title, body, labels });
  return `https://github.com/${REPO}/issues/new?${q}`;
}
