// store.js — 語料儲存：本機（IndexedDB）＋共用語料庫（repo 裡的 corpus/）
export const REPO = 'isaiahovercomer/tsl-translator';

let dbp = null;
function idb() {
  return dbp || (dbp = new Promise((ok, bad) => {
    const r = indexedDB.open('tsl-corpus', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('samples', { keyPath: 'id' });
    r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
  }));
}
async function tx(mode, fn) {
  const db = await idb();
  return new Promise((ok, bad) => {
    const t = db.transaction('samples', mode); const st = t.objectStore('samples');
    const res = fn(st); t.oncomplete = () => ok(res && res.result !== undefined ? res.result : res); t.onerror = () => bad(t.error);
  });
}
const clean = s => { const o = { ...s }; delete o._frames; delete o.shared; return o; };
export const localAll = () => tx('readonly', st => st.getAll()).catch(() => []);
export const localPut = s => tx('readwrite', st => st.put(clean(s)));
export const localDel = id => tx('readwrite', st => st.delete(id));

// 共用語料庫：corpus/index.json = { signs:[{id,word,file,src}], raw:[{id,title,url,file,frames}] }
export async function sharedIndex() {
  try { const r = await fetch('corpus/index.json', { cache: 'no-cache' }); return r.ok ? await r.json() : { signs: [], raw: [] }; }
  catch { return { signs: [], raw: [] }; }
}
export async function sharedSamples(index) {
  const out = [];
  await Promise.all((index.signs || []).map(async e => {
    try { const r = await fetch('corpus/' + e.file); if (r.ok) out.push({ ...(await r.json()), shared: true }); } catch {}
  }));
  return out;
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
