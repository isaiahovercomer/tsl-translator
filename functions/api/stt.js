// Cloudflare Pages Function：/api/stt — 一段錄音（16kHz 單聲道 WAV）→ 繁體中文文字，用 Workers AI 的 Whisper
// POST body = WAV 檔（audio/wav），header x-prompt（可選，encodeURIComponent）＝前一句，讓辨識接得上文意
// 回傳 {text, model}；聽不到話時 text = ''
// 綁定：wrangler.toml 的 [ai] binding = "AI"（不用 API 金鑰）。可用環境變數 STT_MODEL 換模型。
import S2T from './_s2t.json';

const MODELS = ['@cf/openai/whisper-large-v3-turbo', '@cf/openai/whisper'];
// 召會用語提示：Whisper 會偏向用這些寫法（也讓它輸出繁體）
const TERMS = '以下是台灣華語的對話，用繁體中文。召會、聚會、主日、小排、晨興、禱告、讀經、弟兄、姊妹、恢復本、主耶穌、神、基督、聖靈、經歷、享受、生命讀經、職事、傳福音、開展、受浸、擘餅、唱詩、申言、阿們、哈利路亞。';

// 簡轉繁：先轉單字轉錯的詞（干净→乾淨），再逐字轉
const CH = new Map(); for (let i = 0; i < S2T.c.length; i += 2) CH.set(S2T.c[i], S2T.c[i + 1]);
const PH = Object.entries(S2T.p);
function toTrad(s) {
  for (const [a, b] of PH) if (s.includes(a)) s = s.split(a).join('\u0000' + b + '\u0001');
  let out = '', keep = false;
  for (const c of s) { if (c === '\u0000') { keep = true; continue; } if (c === '\u0001') { keep = false; continue; } out += keep ? c : (CH.get(c) || c); }
  return out;
}
// Whisper 在安靜或雜音時常見的幻覺句（影片字幕的結尾語）
const JUNK = /(字幕|訂閱|订阅|點贊|点赞|點讚|按讚|轉發|打賞|感謝(您的)?(觀看|收看)|谢谢观看|請不吝|明鏡|Amara|subtitle|MING PAO|優優獨播|小鈴鐺|欄目|by\s)/i;
function clean(t) {
  t = toTrad(String(t || '').replace(/\s+/g, ' ').trim());
  if (!t || JUNK.test(t)) return '';
  if (t === TERMS || t.startsWith('以下是台灣華語')) return '';          // 把提示詞原樣吐回來
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
  const models = env.STT_MODEL ? [env.STT_MODEL, ...MODELS] : MODELS;
  let lastErr = '';
  for (const model of models) {
    try {
      const input = model.includes('turbo')
        ? { audio, language: 'zh', task: 'transcribe', vad_filter: true, initial_prompt: TERMS + (prev ? prev : ''), condition_on_previous_text: false, no_speech_threshold: 0.6, hallucination_silence_threshold: 1 }
        : { audio: [...new Uint8Array(buf)] };
      const r = await env.AI.run(model, input);
      const raw = r?.text ?? r?.transcription_info?.text ?? (Array.isArray(r?.segments) ? r.segments.map(s => s.text).join('') : '');
      return json({ text: clean(raw), model });
    } catch (e) { lastErr = String(e?.message || e); }
  }
  return json({ error: '語音辨識沒有回應', detail: lastErr }, 502);
}
