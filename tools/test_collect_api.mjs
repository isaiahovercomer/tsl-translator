// test_collect_api.mjs — 用假的 GitHub API 測 functions/api/collect.js：上傳一批 → 同一個 commit 寫入資料檔＋更新 stats.json；
// 兩個人同時上傳（分支被搶先更新）→ 重試後兩批都算到；GET ?stats=1 讀得到。用法：node tools/test_collect_api.mjs
import { onRequest } from '../functions/api/collect.js';

const files = { main: {}, collect: {} };            // 分支 → {路徑: 內容}
const commits = {}; let seq = 0, head = { main: 'c0', collect: 'c0' }; commits.c0 = { tree: 't0', files: {} };
const trees = { t0: {} };
let raceOnce = false, patches = 0;
const enc = s => Buffer.from(s, 'utf8').toString('base64');
const R = (o, status = 200) => new Response(typeof o === 'string' ? o : JSON.stringify(o), { status });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url), p = u.pathname.replace('/repos/isaiahovercomer/tsl-translator/', ''), m = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
  if (m === 'GET' && p.startsWith('git/ref/heads/')) { const b = p.split('/').pop(); return head[b] ? R({ object: { sha: head[b] } }) : R({}, 404); }
  if (m === 'GET' && p.startsWith('git/commits/')) { const c = commits[p.split('/').pop()]; return R({ tree: { sha: c.tree } }); }
  if (m === 'GET' && p.startsWith('contents/')) {
    const path = decodeURIComponent(p.slice(9)), ref = u.searchParams.get('ref');
    const sha = head[ref] || ref, f = trees[commits[sha].tree][path];
    return f == null ? R({}, 404) : R({ content: enc(f).replace(/(.{60})/g, '$1\n') });
  }
  if (m === 'POST' && p === 'git/trees') { const t = 't' + (++seq); trees[t] = { ...trees[commits[Object.keys(commits).find(k => commits[k].tree === body.base_tree)].tree] }; for (const e of body.tree) trees[t][e.path] = e.content; return R({ sha: t }); }
  if (m === 'POST' && p === 'git/commits') { const c = 'c' + (++seq); commits[c] = { tree: body.tree, parent: body.parents[0], message: body.message }; return R({ sha: c }); }
  if (m === 'PATCH' && p.startsWith('git/refs/heads/')) {
    patches++;
    const b = p.split('/').pop(), c = commits[body.sha];
    if (raceOnce) {                                     // 模擬：別人剛好先上傳了一批
      raceOnce = false;
      const t = 't' + (++seq); trees[t] = { ...trees[commits[head[b]].tree], 'collect/x/other.json': '{}',
        'collect/stats.json': JSON.stringify({ v: 1, files: 1, samples: 2, logs: 0, signers: { 別人: { n: 2 } }, words: { 謝謝: { n: 2, s: { 別人: 2 } } } }) };
      const oc = 'c' + (++seq); commits[oc] = { tree: t, parent: head[b] }; head[b] = oc;
    }
    if (c.parent !== head[b]) return R({ message: 'not fast forward' }, 422);
    head[b] = body.sha; return R({ ok: 1 });
  }
  if (m === 'POST' && p === 'git/refs') { head.collect = body.sha; return R({}, 201); }
  throw new Error('沒模擬到 ' + m + ' ' + p);
};
const env = { GH_COLLECT_TOKEN: 'x' };
const smp = w => ({ word: w, kind: 'word', data: 'AAAA', frames: 3, fps: 15, P: 82 });
const post = (signer, samples) => onRequest({ env, request: new Request('https://x/api/collect', { method: 'POST', body: JSON.stringify({ signer, hand: 'right', consent: true, samples }) }) });
let ok = true; const check = (c, msg) => { console.log((c ? '✓ ' : '✗ ') + msg); ok &&= !!c; };

let r = await (await post('小明', [smp('謝謝'), smp('謝謝'), smp('弟兄'), { kind: 'log', log: { slots: [] } }])).json();
check(r.ok && r.n === 4, '第一批上傳成功');
const tr = () => trees[commits[head.collect].tree];
let st = JSON.parse(tr()['collect/stats.json']);
check(st.samples === 3 && st.logs === 1 && st.words['謝謝'].n === 2 && st.words['弟兄'].s['小明'] === 1, 'stats.json 同一個 commit 更新');
check(Object.keys(tr()).some(k => k.startsWith('collect/') && k.includes('小明')), '資料檔寫進去了');
raceOnce = true; const before = patches;
r = await (await post('小華', [smp('謝謝'), { ...smp('_none'), kind: 'none' }])).json();
st = JSON.parse(tr()['collect/stats.json']);
check(r.ok && patches - before === 2, '分支被別人先更新 → 重試一次成功');
check(st.words['謝謝'].n === 3 && st.words['謝謝'].s['小華'] === 1 && st.words['_none'].k === 'none' && st.signers['別人'], '重試時用最新的 stats 累加（別人的也保留）');
const g = await (await onRequest({ env, request: new Request('https://x/api/collect?stats=1') })).json();
check(g.words && g.words['謝謝'].n === 3, 'GET ?stats=1 讀得到');
console.log(ok ? '全部通過' : '有失敗'); process.exit(ok ? 0 : 1);
