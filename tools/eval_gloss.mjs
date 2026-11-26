// 用中正辭典 546 句例句檢查「中文 → 手語詞序」規則：比原本逐詞（照中文語序）好多少
// node tools/eval_gloss.mjs [--show 20]
import { readFileSync } from 'node:fs';
import { toGloss, DROP } from '../js/gloss.js';
import { tokenize } from '../js/core.js';
const ix = JSON.parse(readFileSync(new URL('../corpus/index.json', import.meta.url)));
const vocab = [...new Set(ix.signs.flatMap(s => [s.word, ...(s.syn || [])]))];
const meta = JSON.parse(readFileSync(new URL('../corpus/dict/ccu-meta.json', import.meta.url)));
const seen = new Set(), ex = [];
for (const m of meta) for (const s of m.sentences) if (!seen.has(s.clip)) { seen.add(s.clip); ex.push(s); }
const clean = g => g.split('/').map(w => w.replace(/_[A-Z0-9]+$/, '').replace(/\(.*?\)/g, '').trim()).filter(Boolean);
// 兩個序列共同的詞，兩兩比較先後順序有幾成一致
function pairAgree(a, b) {
  const pa = new Map(), pb = new Map();
  a.forEach((w, i) => { if (!pa.has(w)) pa.set(w, i); }); b.forEach((w, i) => { if (!pb.has(w)) pb.set(w, i); });
  const common = [...pa.keys()].filter(w => pb.has(w));
  let ok = 0, n = 0;
  for (let i = 0; i < common.length; i++) for (let j = i + 1; j < common.length; j++) {
    n++; if (Math.sign(pa.get(common[i]) - pa.get(common[j])) === Math.sign(pb.get(common[i]) - pb.get(common[j]))) ok++;
  }
  return [ok, n];
}
const segVocab = [...new Set([...vocab, ...DROP])];
let A = [0, 0], B = [0, 0], dropOk = 0, dropN = 0, extra = 0, nOut = 0, lastOk = 0;
const show = +(process.argv[process.argv.indexOf('--show') + 1] || 0);
ex.forEach((s, k) => {
  const G = clean(s.gloss);
  const ours = toGloss(s.translation, vocab).tokens.map(t => t.word);
  const base = tokenize(s.translation, segVocab).map(t => t.word || t.text);
  const a = pairAgree(ours, G), b = pairAgree(base, G);
  A[0] += a[0]; A[1] += a[1]; B[0] += b[0]; B[1] += b[1];
  const gs = new Set(G);
  for (const w of base) if (DROP.has(w)) { dropN++; if (!gs.has(w)) dropOk++; }
  nOut += ours.length; extra += ours.filter(w => !gs.has(w)).length;
  if (ours.at(-1) === G.at(-1)) lastOk++;
  if (k < show) console.log(s.translation, '\n  手語:', G.join('/'), '\n  規則:', ours.join('/'), '\n  逐詞:', base.join('/'));
});
const pct = x => (100 * x[0] / x[1]).toFixed(1) + '%';
console.log(`例句 ${ex.length} 句`);
console.log(`詞序一致（兩兩比較）：逐詞 ${pct(B)} → 規則 ${pct(A)}`);
console.log(`句尾詞正確：${(100 * lastOk / ex.length).toFixed(1)}%`);
console.log(`虛詞不比（的、了、是…）判斷正確：${(100 * dropOk / dropN).toFixed(1)}%`);
