// Cloudflare Pages Function：/api/stt — 一段錄音（16kHz 單聲道 WAV）→ 繁體中文文字，用 Workers AI 的 Whisper
// POST body = WAV 檔（audio/wav），header x-prompt（可選，encodeURIComponent）＝前一句，讓辨識接得上文意
// 回傳 {text, model}；聽不到話時 text = ''
// 綁定：wrangler.toml 的 [ai] binding = "AI"（不用 API 金鑰）。可用環境變數 STT_MODEL 換模型。
import S2T from './_s2t.json';

const MODELS = ['@cf/openai/whisper-large-v3-turbo', '@cf/openai/whisper'];
// 召會用語提示：Whisper 會偏向用這些寫法（也讓它輸出繁體）
const TERMS = '以下是台灣華語的對話，用繁體中文。召會、聚會、主日、小排、晨興、禱告、讀經、弟兄、姊妹、恢復本、主耶穌、神、基督、聖靈、經歷、享受、生命讀經、職事、傳福音、開展、受浸、擘餅、唱詩、申言、阿們、哈利路亞。';

// 簡轉繁：先轉單字轉錯的詞（干净→乾淨），再逐字轉
// 用 Array.from 逐「字」讀：表裡有 4 位元組的字（𣈶），用字串索引會整個錯位（v0.18 以前 來→杨、機→杀、歡→欤）
const CH = new Map(); { const cs = Array.from(S2T.c); for (let i = 0; i + 1 < cs.length; i += 2) CH.set(cs[i], cs[i + 1]); }
const PH = Object.entries(S2T.p);
function toTrad(s) {
  for (const [a, b] of PH) if (s.includes(a)) s = s.split(a).join('\u0000' + b + '\u0001');
  let out = '', keep = false;
  for (const c of s) { if (c === '\u0000') { keep = true; continue; } if (c === '\u0001') { keep = false; continue; } out += keep ? c : (CH.get(c) || c); }
  return out;
}
// Whisper 在安靜或雜音時常見的幻覺句（影片字幕的結尾語、歌曲的工作人員名單）
const JUNK = /(字幕|訂閱|订阅|點贊|点赞|點讚|按讚|轉發|打賞|感謝(您的)?(觀看|收看|收聽)|谢谢观看|謝謝(大家)?的?(觀看|收看|收聽)|請不吝|明鏡|Amara|subtitle|MING PAO|優優獨播|小鈴鐺|欄目|本(期|集)節目|下(期|集)(見|再見)|本視頻|本影片|by\s)/i;
// 歌曲片頭片尾：作詞／作曲／編曲…（雜音、音樂時最常跑出來；正常交通很少這樣說，短句才擋）
const CREDITS = /(作詞|作曲|編曲|填詞|詞曲|監製|混音|製作人|和聲|演唱|原唱|配樂|錄音|母帶)\s*[:：／/]?/;
const credits = t => CREDITS.test(t) && (t.length <= 30 || (t.match(new RegExp(CREDITS.source, 'g')) || []).length >= 2);
// 把提示詞（召會用語清單）吐回來：「召會、聚會、主日、小排…」這種一串用頓號接起來的詞
const TERM_SET = new Set(TERMS.replace(/^.*?。/, '').replace(/。$/, '').split('、'));
function promptEcho(t) {
  if (/台灣華語的對話|用繁體中文|繁體中文/.test(t)) return true;
  const parts = t.split(/[、，,。\s]+/).filter(Boolean);
  const hit = parts.filter(p => TERM_SET.has(p)), len = parts.join('').length;
  return hit.length >= 3 && hit.join('').length >= len * 0.6;
}
// 一串提示詞後面接著真正的話（少見）：把前面那一串去掉
const stripEcho = t => t.replace(new RegExp('^((' + [...TERM_SET].join('|') + ')[、，,]\\s*){3,}(' + [...TERM_SET].join('|') + ')?[。，、]?'), '').trim();
// 召會用語常被聽成的同音字
const FIX = [['招會', '召會'], ['照會裡', '召會裡'], ['小牌', '小排'], ['晨星聖言', '晨興聖言'], ['晨性', '晨興'], ['陳興', '晨興'], ['生命獨經', '生命讀經'], ['恢復版', '恢復本'], ['受進', '受浸'], ['阿門', '阿們'], ['姐妹', '姊妹'], ['哈里路亞', '哈利路亞']];
const PUNC = { ',': '，', '?': '？', '!': '！', ':': '：', ';': '；' };
function clean(t, prev = '') {
  t = toTrad(String(t || '').replace(/\s+/g, ' ').trim());
  t = t.replace(/[,?!:;]/g, c => PUNC[c]).replace(/\.$/, '。');
  for (const [a, b] of FIX) if (t.includes(a)) t = t.split(a).join(b);
  if (!t || JUNK.test(t) || credits(t)) return '';
  if (t === TERMS || t.startsWith('以下是台灣華語') || promptEcho(t)) return '';          // 把提示詞吐回來
  t = stripEcho(t); if (!t) return '';
  // 雜音時把前一句（x-prompt）原樣吐回來
  const p = String(prev || '').replace(/[\s，。！？、,.!?]/g, ''), q = t.replace(/[\s，。！？、,.!?]/g, '');
  if (p && q.length >= 4 && p.endsWith(q)) return '';
  if (/^[\p{P}\s。，、！？…]+$/u.test(t)) return '';
  if (/(.{2,8})\1{3,}/.test(t)) t = t.replace(/(.{2,8})\1{3,}/g, '$1');   // 同一段一直重複
  return t;
}

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' } });
function b64(buf) {
  const u = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-prompt', 'access-control-allow-methods': 'POST' } });
  if (request.method !== 'POST') return json({ error: '請用 POST 送 WAV 錄音' }, 405);
  if (!env.AI) return json({ error: 'Workers AI 尚未綁定（wrangler.toml [ai] binding = "AI"）' }, 503);
  const buf = await request.arrayBuffer();
  if (buf.byteLength < 8000) return json({ text: '', model: 'none' });              // 不到 0.25 秒
  if (buf.byteLength > 4 * 1024 * 1024) return json({ error: '錄音太長（最多約 2 分鐘）' }, 413);
  let prev = ''; try { prev = decodeURIComponent(request.headers.get('x-prompt') || '').slice(-60); } catch {}
  const audio = b64(buf);
  const beam = Math.min(5, Math.max(1, +new URL(request.url).searchParams.get('beam') || 5));   // 評估用：?beam=1 較快
  const models = env.STT_MODEL ? [env.STT_MODEL, ...MODELS] : MODELS;
  let lastErr = '';
  for (const model of models) {
    try {
      const input = model.includes('turbo')
        ? { audio, language: 'zh', task: 'transcribe', vad_filter: true, beam_size: beam, initial_prompt: TERMS + (prev ? prev : ''), condition_on_previous_text: false, no_speech_threshold: 0.6, hallucination_silence_threshold: 1 }
        : { audio: [...new Uint8Array(buf)] };
      const r = await env.AI.run(model, input);
      const raw = r?.text ?? r?.transcription_info?.text ?? (Array.isArray(r?.segments) ? r.segments.map(s => s.text).join('') : '');
      return json({ text: clean(raw, prev), model });
    } catch (e) { lastErr = String(e?.message || e); }
  }
  return json({ error: '語音辨識沒有回應', detail: lastErr }, 502);
}
