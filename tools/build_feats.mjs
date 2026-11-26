// build_feats.mjs — 預先算好共用語料的辨識特徵（Int8），存成 corpus/feats.json
// 網頁開鏡頭辨識時只要下載這一個檔，不用下載全部骨架。用法：node tools/build_feats.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeFrames, seqFeat, encodeFeat } from '../js/core.js';
const root = new URL('../corpus/', import.meta.url);
const ix = JSON.parse(readFileSync(new URL('index.json', root), 'utf8'));
const out = {};
for (const e of ix.signs) {
  try {
    const s = JSON.parse(readFileSync(new URL(e.file, root), 'utf8'));
    out[e.id] = encodeFeat(seqFeat(decodeFrames(s.data, s.frames)));
  } catch (err) { console.warn('略過', e.id, err.message); }
}
writeFileSync(new URL('feats.json', root), JSON.stringify(out));
console.log(`特徵 ${Object.keys(out).length} 筆`);
