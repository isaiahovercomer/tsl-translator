// 用中正辭典 546 句例句檢查「中文 → 手語詞序」規則：比原本逐詞（照中文語序）好多少
// node tools/eval_gloss.mjs [--show 20]
import { readFileSync } from 'node:fs';
import { toGloss, DROP, mapGloss } from '../js/gloss.js';
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

// --ai N：再用線上 AI（/api/gloss?loo，不拿同一句當範例）評估前 N 句（每 9 句取 1 句）
const ai = process.argv.indexOf('--ai');
if (ai > 0) {
  const N = +process.argv[ai + 1] || 40, base = process.env.GLOSS_URL || 'https://tslinterpreter.pages.dev/api/gloss';
  const pick = ex.filter((_, i) => i % 9 === 0).slice(0, N);
  let C = [0, 0], R = [0, 0], last = 0, n = 0, wa = [0, 0], wr = [0, 0];
  const model = (process.env.GLOSS_MODEL ? '&model=' + encodeURIComponent(process.env.GLOSS_MODEL) : '') + (process.env.GLOSS_Q || '');
  // 實際會比的詞：AI 輸出 → mapGloss 換成語料庫的詞（沒有的詞拆開或丟掉）
  let mh = [0, 0], mp = [0, 0], unk = [0, 0];
  const hitw = (o, G) => { const g = new Set(G); return [o.filter(w => g.has(w)).length, G.length]; };
  for (const s of pick) {
    const G = clean(s.gloss);
    try {
      const r = await (await fetch(base + '?loo' + model + '&text=' + encodeURIComponent(s.translation.trim()))).json();
      if (!r.gloss) { console.log('失敗', s.translation, r); continue; }
      const rw = toGloss(s.translation, vocab).tokens.map(t => t.word), a = pairAgree(r.gloss, G), b = pairAgree(rw, G);
      const h1 = hitw(r.gloss, G), h2 = hitw(rw, G); wa[0] += h1[0]; wa[1] += h1[1]; wr[0] += h2[0]; wr[1] += h2[1];
      const toks = mapGloss(r.gloss, vocab), play = toks.filter(t => t.known).map(t => t.word), g = new Set(G);
      mh[0] += G.filter(w => play.includes(w)).length; mh[1] += G.length;      // 手語詞有比到幾成（召回）
      mp[0] += play.filter(w => g.has(w)).length; mp[1] += play.length;      // 比的詞有幾成是對的（精確）
      unk[0] += toks.filter(t => !t.known).length; unk[1] += toks.length;   // 語料庫沒有、比不出來的
      if (process.env.SHOW) console.log(s.translation, '\n  手語:', G.join('/'), '\n  AI  :', r.gloss.join('/'), '\n  比  :', play.join('/'));
      C[0] += a[0]; C[1] += a[1]; R[0] += b[0]; R[1] += b[1]; n++; if (r.gloss.at(-1) === G.at(-1)) last++;
    } catch (e) { console.log('錯誤', e.message); }
  }
  console.log(`實際比的詞（換成語料庫詞後）：召回 ${pct(mh)}、精確 ${pct(mp)}、比不出來 ${pct(unk)}`);
  console.log(`AI 評估 ${n} 句：詞序一致 規則 ${pct(R)} → AI ${pct(C)}；用對手語詞 規則 ${pct(wr)} → AI ${pct(wa)}；句尾詞正確 ${(100 * last / n).toFixed(1)}%`);
}
