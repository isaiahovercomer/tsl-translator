// 測試「邊比邊找詞」：把語料庫的詞接成一句（時間伸縮＋抖動），比較舊的 Segmenter 和新的 Spotter
// node tools/test_spotter.mjs [scene=greet] [n=40]
import fs from 'fs';
import { Recognizer, Segmenter, Spotter, decodeFeat, decodeFrames, bodyRef, handsActive, P, FPS } from '../js/core.js';
import { sceneWords } from '../js/scenes.js';
const scene = process.argv[2] || 'greet', N = +(process.argv[3] || 40), PARAMS = JSON.parse(process.argv[4] || '{}');
const idx = JSON.parse(fs.readFileSync('corpus/index.json')), feats = JSON.parse(fs.readFileSync('corpus/feats.json'));
const samples = idx.signs.map(s => ({ ...s, shared: true, _feat: feats[s.id] && decodeFeat(feats[s.id]) })).filter(s => s._feat);
const R = new Recognizer(); R.setSamples(samples); R.setFilter(sceneWords(scene, samples));
// 測試詞：第 5 個參數指定從哪個情境挑詞（例如 greet 的詞用「全部詞彙」辨識，看情境有沒有幫助）
const PR = new Recognizer(); PR.setSamples(samples); PR.setFilter(sceneWords(process.argv[5] || scene, samples));
const pool = samples.filter(s => PR.pool.some(p => p.id === s.id) && (s.q || 0) >= 0.5);
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const framesOf = s => decodeFrames(JSON.parse(fs.readFileSync('corpus/' + s.file)).data);
function active(fr) { const a = fr.map(f => handsActive(f, bodyRef(f))); const i = a.indexOf(true), j = a.lastIndexOf(true); return i < 0 ? fr : fr.slice(Math.max(0, i - 1), j + 2); }
function warp(fr, k) { const n = Math.max(6, Math.round(fr.length * k)), out = []; for (let i = 0; i < n; i++) { const f = Float32Array.from(fr[Math.min(fr.length - 1, Math.round(i / k))]); for (let q = 0; q < P * 3; q++) if (!Number.isNaN(f[q])) f[q] += (rnd() - .5) * 0.004; out.push(f); } return out; }
function sentence(words, pause) {
  let out = []; const first = framesOf(words[0]);
  const rest = first.find(f => !handsActive(f, bodyRef(f))) || first[0];
  for (let i = 0; i < 6; i++) out.push(rest);
  words.forEach((w, i) => { const a = warp(active(framesOf(w)), 0.85 + rnd() * 0.4); out.push(...a); if (pause && i < words.length - 1) for (let k = 0; k < pause; k++) out.push(a[a.length - 1]); });
  for (let i = 0; i < 12; i++) out.push(rest);
  return out;
}
function run(mode, fr) {
  const got = [];
  if (mode === 'old') { const sg = new Segmenter(x => { const c = R.classify(x, 3); if (c.length) got.push(c); }); fr.forEach(f => sg.push(f)); sg.flush(); }
  else { const sp = new Spotter(R, c => got.push(c), { threshold: 1.4, params: PARAMS }); fr.forEach(f => sp.push(f)); sp.flush(); }
  return got;
}
// 編輯距離對齊：top1 正確／top3 內有
function score(truth, got, k) {
  const n = truth.length, m = got.length, D = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => i + j));
  const hit = (i, j) => got[j].slice(0, k).some(c => c.word === truth[i]);
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (hit(i - 1, j - 1) ? 0 : 1));
  return D[n][m];
}
console.log(`情境 ${scene}：${R.words.length} 個詞，測試池 ${pool.length} 筆`);
for (const pause of [5, 0]) {
  const tot = { old: [0, 0, 0, 0], new: [0, 0, 0, 0] }; let words = 0; const t0 = Date.now();
  for (let t = 0; t < N; t++) {
    const ws = Array.from({ length: 3 + Math.floor(rnd() * 3) }, () => pool[Math.floor(rnd() * pool.length)]);
    const fr = sentence(ws, pause), truth = ws.map(w => w.word); words += truth.length;
    for (const mode of ['old', 'new']) { const g = run(mode, fr); tot[mode][0] += score(truth, g, 1); tot[mode][1] += score(truth, g, 3); tot[mode][2] += g.length; }
  }
  console.log(`詞間停 ${pause} 格（${(pause / FPS).toFixed(2)} 秒）：${N} 句 ${words} 詞`);
  for (const mode of ['old', 'new']) { const [e1, e3, ng] = tot[mode]; console.log(`  ${mode === 'old' ? '舊 Segmenter' : '新 Spotter  '}  切出 ${ng} 段  錯誤率 top1 ${(100 * e1 / words).toFixed(1)}%  top3 ${(100 * e3 / words).toFixed(1)}%`); }
  console.log(`  （${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
}
if (process.env.SHOW) { seed = 11; for (let t = 0; t < 8; t++) {
  const ws = Array.from({ length: 4 }, () => pool[Math.floor(rnd() * pool.length)]);
  const fr = sentence(ws, +process.env.SHOW);
  const log = []; const sp = new Spotter(R, (c, f) => log.push(`${c[0].word}(${c[0].dist.toFixed(2)},${f.length})`), { threshold: 1.4, params: PARAMS }); fr.forEach(f => sp.push(f)); sp.flush();
  const old = run('old', fr).map(c => c[0].word);
  console.log(ws.map(w => w.word).join(' '), '|', log.join(' '), '| 舊:', old.join(' '));
} }
