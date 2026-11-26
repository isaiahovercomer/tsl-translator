// gloss.js — 中文句子 → 台灣手語詞序（Gloss）
// 規則是從中正大學台灣手語線上辭典 546 句例句（手語語序 ↔ 中文）整理出來的：
//   時間詞放最前面；否定（不、沒有）、助動詞（要、會、可以）、疑問詞（什麼、誰、哪裡）放句尾；
//   「喜歡、知道、怕」這類心理動詞移到受詞後面；「很」放在形容詞後面；
//   的、了、是、在、把、被、嗎…等虛詞不比。
// 離線也能用；有網路時 app.js 會先問 AI（/api/gloss），AI 失敗或太慢就用這裡的結果。
import { tokenize } from './core.js';

const S = s => new Set(s.split(' '));
export const DROP = S('的 了 是 在 把 被 得 著 吧 呢 啊 呀 嘛 喔 哦 啦 嗎 就 都 也 地 之 與 和 跟 及 並 而 呢 喲 囉 咧 唷 耶');
export const TIME = S('今天 明天 昨天 前天 後天 剛剛 剛才 現在 以前 以後 之前 之後 早上 晚上 中午 下午 上午 半夜 每天 每週 每年 每月 今年 明年 去年 最近 將來 未來 從前 過去 平常 常常 有時候 星期一 星期二 星期三 星期四 星期五 星期六 星期日 星期天 週末 今晚 明早 剛 那時 這時 當時 主日');
export const QWORD = S('什麼 誰 哪裡 哪 哪個 哪些 幾 多少 為什麼 怎麼 怎麼辦 怎樣 如何 幾點 幾歲 幾天 星期幾 有沒有 是不是 好不好 要不要 可不可以 對不對 會不會 能不能');
export const MODAL = S('要 會 可以 能 能夠 應該 必須 需要 願意 肯 得要 想要');
export const NEG = S('不 沒 沒有 不要 別 不能 不會 不可以 不用 不必 不是 未 從不 不行 不知道 不認識 不懂 不喜歡 不對 不好 不夠 不同 沒關係');
export const PSYCH = S('喜歡 討厭 害怕 怕 知道 認識 懂 記得 忘記 愛 恨 擔心');
export const DEGREE = S('很 非常 太 真 超 蠻 好 十分 特別 最 更 比較');
const NUM = /^([一二三四五六七八九十兩百千萬幾]+|\d+)$/;
const CLF = S('個 本 張 隻 件 條 位 次 支 枝 台 輛 間 家 雙 杯 碗 瓶 塊 顆 頭 匹 把 封 首 句 頁 歲 名 份 層');
// 只有這些詞時才當作「程度」：避免把「好人」「真理」拆開
const DEGREE_ONLY = new Set(['很', '非常', '太', '十分', '超', '蠻']);
const GRAMMAR = [...DROP, ...TIME, ...QWORD, ...MODAL, ...NEG, ...PSYCH, ...DEGREE_ONLY, ...CLF];

const CLAUSE = /[，。！？；、,.!?;\n]+/;

/**
 * @param {string} text 中文句子
 * @param {string[]} vocab 語料庫有的詞（含同義詞）
 * @param {object} aliases 別名 { 您好: '你好' }
 * @returns {{tokens: {text, word, known}[], question: boolean, clauses: string[][]}}
 */
export function toGloss(text, vocab, aliases = {}) {
  const have = new Set(vocab), al = aliases;
  const segVocab = [...new Set([...vocab, ...GRAMMAR])];
  const tokens = [], clauses = []; let question = /[?？嗎]\s*$/.test(text.trim()) || /[什誰哪幾為怎]/.test(text);
  for (const c of text.split(CLAUSE)) {
    if (!c.trim()) continue;
    const raw = tokenize(c, segVocab, al).map(t => ({ ...t, word: t.word || t.text }));
    const out = reorder(raw, c);
    clauses.push(out.map(t => t.word));
    for (const t of out) tokens.push({ text: t.text, word: t.word, known: have.has(t.word) });
  }
  return { tokens, question, clauses };
}

function reorder(toks, clause) {
  const ynq = /嗎\s*$/.test(clause);
  const isQ = ynq || /[?？]/.test(clause);
  let t = toks.filter(x => !(x.known && DROP.has(x.word)));
  if (!t.length) return [];
  // 數字＋量詞＋名詞 → 名詞＋數字
  for (let i = 0; i + 1 < t.length; i++) {
    if (NUM.test(t[i].word)) {
      let j = i + 1;
      if (t[j] && CLF.has(t[j].word)) t.splice(j, 1);
      if (t[j] && !isGrammar(t[j].word)) { const n = t[i]; t[i] = t[j]; t[j] = n; i = j; }
    }
  }
  // 這／那＋量詞 → 這／那（「這件事」→ 這／事）
  t = t.filter((x, i) => !(CLF.has(x.word) && i > 0 && /^[這那哪每]$/.test(t[i - 1].word)));
  // 話題提前：「我不知道這件事」「你喜歡吃漢堡」→ 受詞先比，再比「誰＋知道／喜歡」
  const pv = t.findIndex(x => (PSYCH.has(x.word) || (NEG.has(x.word) && x.word.length > 1 && !['沒有', '不要', '不能', '不會', '不可以', '不用', '不是'].includes(x.word))));
  if (pv >= 0 && pv < t.length - 1) {
    const obj = t.slice(pv + 1).filter(x => !QWORD.has(x.word));
    if (obj.length && obj.length <= 4) t = [...obj, ...t.slice(0, pv + 1), ...t.slice(pv + 1).filter(x => QWORD.has(x.word))];
  }
  // 「很」＋形容詞 → 形容詞＋很
  for (let i = 0; i + 1 < t.length; i++) {
    if (DEGREE_ONLY.has(t[i].word) && !isGrammar(t[i + 1].word)) { const d = t[i]; t[i] = t[i + 1]; t[i + 1] = d; i++; }
  }
  const front = [], mid = [], psych = [], neg = [], modal = [], q = [];
  let hasYou = false;
  for (let i = 0; i < t.length; i++) {
    const w = t[i].word;
    if (TIME.has(w)) front.push(t[i]);
    else if (QWORD.has(w)) q.push(t[i]);
    else if (NEG.has(w)) neg.push(t[i]);
    else if (MODAL.has(w)) modal.push(t[i]);
    else if (PSYCH.has(w)) psych.push(t[i]);
    else { if (w === '有' && ynq) { hasYou = true; continue; } mid.push(t[i]); }
  }
  // 否定＋助動詞合成一個手勢（不會、不要、不能、不可以）
  if (neg.length && modal.length) {
    const f = neg[0].word + modal[0].word;
    if (['不會', '不要', '不能', '不可以', '不用'].includes(f)) { neg.splice(0, 1, { text: neg[0].text + modal[0].text, word: f, known: true }); modal.shift(); }
  }
  const end = [...psych, ...neg, ...modal];
  if (hasYou) q.push({ text: '有', word: '有沒有', known: true });
  return [...front, ...mid, ...end, ...q];
}

const isGrammar = w => DROP.has(w) || QWORD.has(w) || MODAL.has(w) || NEG.has(w) || TIME.has(w) || CLF.has(w) || DEGREE_ONLY.has(w);

// ---- AI 詞序（Cloudflare Pages Function /api/gloss），失敗或逾時回傳 null ----
export async function aiGloss(text, hint, { timeout = 3500, endpoint = 'api/gloss' } = {}) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, hint }), signal: ctl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j.gloss) && j.gloss.length ? j.gloss.map(String) : null;
  } catch { return null; } finally { clearTimeout(tm); }
}

// ---- 手語詞序 → 通順中文（/api/fluent），失敗或逾時回傳 null ----
export async function aiFluent(words, { timeout = 4000, endpoint = 'api/fluent' } = {}) {
  const ws = words.filter(w => w && w !== '？');
  if (ws.length < 2) return ws[0] || null;
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gloss: ws }), signal: ctl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j.text === 'string' && j.text.trim() ? j.text.trim() : null;
  } catch { return null; } finally { clearTimeout(tm); }
}

// ---- 候選詞 → AI 挑最通順的句子（/api/fluent cands 模式）→ {text, pick} 或 null ----
// cands: [[詞1,詞2,詞3], ...]（每段依相似度排序）
export async function aiPick(cands, { scene = '', timeout = 5000, endpoint = 'api/fluent' } = {}) {
  const cs = cands.map(c => c.filter(w => w && w !== '？')).filter(c => c.length);
  if (!cs.length) return null;
  if (cs.length === 1 && cs[0].length === 1) return { text: cs[0][0], pick: [cs[0][0]] };
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cands: cs, scene }), signal: ctl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    if (typeof j.text !== 'string' || !j.text.trim()) return null;
    return { text: j.text.trim(), pick: Array.isArray(j.pick) ? j.pick : cs.map(c => c[0]) };
  } catch { return null; } finally { clearTimeout(tm); }
}

const VAR = Object.fromEntries('布佈 台臺 裡裏 著着 群羣 線綫 秘祕 嘆歎 汙污 峰峯 姊姐 啟啓 床牀 鉤鈎 痺痹'.split(' ').flatMap(p => [[p[0], p[1]], [p[1], p[0]]]));
const variants = w => [...w].map((c, i) => VAR[c] ? w.slice(0, i) + VAR[c] + w.slice(i + 1) : null).filter(Boolean);
/** AI 給的 gloss 詞 → 語料庫的詞（沒有的詞再用最長比對拆開） */
export function mapGloss(gloss, vocab, aliases = {}) {
  const have = new Set(vocab), out = [];
  for (const g0 of gloss) {
    const g = g0.replace(/_[A-Z0-9]+$/, '').trim();
    if (!g || DROP.has(g)) continue;
    let w = aliases[g] || g;
    if (!have.has(w)) w = variants(w).find(v => have.has(v)) || w;   // 異體字：宣布→宣佈
    if (have.has(w)) { out.push({ text: g, word: w, known: true }); continue; }
    for (const t of tokenize(g, vocab, aliases)) out.push({ text: t.text, word: t.word || t.text, known: !!t.known });
  }
  return out;
}
