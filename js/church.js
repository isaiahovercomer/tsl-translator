// church.js — 召會用語：AI 手語詞序不可以換成意思不同的詞（v0.19）
// 例：弟兄 ≠ 兄弟（親兄弟）、聚會 ≠ 會（會不會的會）／會議、召會 ≠ 教會。
// 語料庫還沒有這些詞時，保留原詞 → 手譯員打「字卡」，不要比出別的意思。
// 瀏覽器（js/gloss.js）和雲端（functions/api/gloss.js）共用這一份。

// 只放「被換掉就變成別的意思」的召會用語；一個字的詞（主、神）不放，免得「主要」也被當成「主」。
export const CHURCH_TERMS = `弟兄 姊妹 召會 聚會 小排 主日 晨興 讀經 禱讀 詩歌 唱詩 擘餅 受浸 阿們 哈利路亞
聖靈 聖徒 恢復本 職事 申言 開展 配搭 服事 長老 恩典 福音 耶穌 基督 聖經 十字架 禱告`.split(/\s+/).filter(Boolean);
const SET = new Set(CHURCH_TERMS);
export const isChurchTerm = w => SET.has(w);

// AI 常見的錯換（不在這裡的也會用「字都在原詞裡」的規則抓）
const SUB = {
  弟兄: ['兄弟', '哥哥', '弟弟'], 姊妹: ['姐妹', '姊姊', '妹妹'], 聚會: ['會', '會議', '開會', '集合', '見面'],
  召會: ['教會', '教堂', '會', '集會'], 主日: ['禮拜天', '星期天', '星期日', '週日', '禮拜'], 小排: ['小組', '排'],
  詩歌: ['歌', '歌曲', '唱歌'], 唱詩: ['唱歌', '唱'], 禱告: ['祈禱'], 受浸: ['洗', '洗禮', '受洗'],
  擘餅: ['餅', '麵包'], 聖經: ['書', '經'], 職事: ['工作', '職務'], 申言: ['說', '預言'], 服事: ['服務', '幫忙'],
};

const sorted = s => [...s].sort().join('');

/** 句子裡出現的召會用語（長的優先、不重疊） */
export function churchTermsIn(text) {
  const out = []; let rest = text;
  for (const t of [...CHURCH_TERMS].sort((a, b) => b.length - a.length)) {
    let i = rest.indexOf(t);
    while (i >= 0) { out.push([t, i]); rest = rest.slice(0, i) + '\u0000'.repeat(t.length) + rest.slice(i + t.length); i = rest.indexOf(t); }
  }
  return { terms: out.sort((a, b) => a[1] - b[1]), rest };
}

/**
 * AI 給的 gloss（詞的陣列）→ 把被換掉或拆開的召會用語改回原詞。
 * text＝原本的中文句子。回傳新的陣列（不改原陣列）。
 */
export function keepChurch(text, gloss) {
  if (!text || !gloss || !gloss.length) return gloss || [];
  const { terms, rest } = churchTermsIn(text);
  if (!terms.length) return gloss.slice();
  const g = gloss.slice(), fixed = new Set();
  const free = w => !rest.includes(w);   // 這個詞在原句裡「召會用語以外」的地方沒出現 → 是換來的
  // ⓪ 一個詞換掉好幾個召會用語（弟兄姊妹 → 兄弟姊妹）：拆回原句的那幾個詞
  for (let i = 0; i < g.length; i++) {
    const w = g[i]; if (isChurchTerm(w) || w.length < 3 || text.includes(w)) continue;
    const inW = terms.map(x => x[0]).filter(t => [...t].every(c => w.includes(c)));
    if (inW.length >= 2 && sorted(inW.join('')) === sorted(w)) { g.splice(i, 1, ...inW); i += inW.length - 1; }
  }
  for (const [t, pos] of terms) {
    const have = g.findIndex((w, i) => w === t && !fixed.has(i));
    if (have >= 0) { fixed.add(have); continue; }
    let done = false;
    // ① 被拆開（弟/兄、聚/會）或字序顛倒（兄弟）：連續幾個詞的字剛好是這個詞的字
    for (let i = 0; i < g.length && !done; i++) {
      let s = '';
      for (let j = i; j < g.length && s.length < t.length; j++) {
        s += g[j];
        if (s.length === t.length && sorted(s) === sorted(t) && (j > i || s !== t)) {
          // 拆成的每一段都是召會用語（例：主耶穌 → 主/耶穌）就不算拆錯
          if (j > i && g.slice(i, j + 1).every(isChurchTerm)) break;
          g.splice(i, j - i + 1, t); fixed.add(i); done = true; break;
        }
      }
    }
    if (done) continue;
    // ② 換成別的詞：已知的錯換，或字都在原詞裡（聚會 → 會）
    const k = g.findIndex((w, i) => !fixed.has(i) && w !== t && !isChurchTerm(w) && free(w) &&
      ((SUB[t] || []).includes(w) || (w.length < t.length && [...w].every(c => t.includes(c)))));
    if (k >= 0) { g[k] = t; fixed.add(k); continue; }
    // ③ AI 整個漏掉：照原句位置補回去（已經在別的詞裡，例如原句就說「兄弟姊妹」→ 不補）
    if (g.some(w => w.includes(t))) continue;
    let at = g.length;
    for (let i = 0; i < g.length; i++) { const p = text.indexOf(g[i]); if (p > pos) { at = i; break; } }
    g.splice(at, 0, t);
    for (const i of [...fixed].filter(i => i >= at)) { fixed.delete(i); fixed.add(i + 1); }
    fixed.add(at);
  }
  return g;
}
