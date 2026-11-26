// rocketbox_build.mjs — Rocketbox 角色（FBX2glTF 轉出的 glb）整理成網站用的 glb
// 補上臉部表情名稱、只留手語用得到的表情、換上處理過的貼圖（插畫風）、meshopt 壓縮。
// 用法：node tools/rocketbox_build.mjs raw.glb names.json body.jpg head.jpg opacity.png out.glb [頭髮顏色 r,g,b]
// （需要 npm 套件：@gltf-transform/core @gltf-transform/extensions @gltf-transform/functions meshoptimizer）
import { readFileSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';

const [raw, namesFile, bodyTex, headTex, opTex, out, hairRGB] = process.argv.slice(2);
const hair = (hairRGB || '0.12,0.09,0.08').split(',').map(Number);
const KEEP = ['jawOpen', 'eyeBlinkLeft', 'eyeBlinkRight', 'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'mouthSmileLeft', 'mouthSmileRight', 'eyeWideLeft', 'eyeWideRight', 'mouthFrownLeft', 'mouthFrownRight', 'cheekSquintLeft', 'cheekSquintRight',
  'mouthFunnel', 'mouthPucker'];
// AK_25_JawOpen → jawOpen
const arkit = n => { const m = n.match(/^AK_\d+_(\w+)$/); return m ? m[1][0].toLowerCase() + m[1].slice(1) : n; };

await MeshoptEncoder.ready; await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(raw);
const root = doc.getRoot();
const names = JSON.parse(readFileSync(namesFile, 'utf8')).map(arkit);

for (const mesh of root.listMeshes()) {
  const n = mesh.listPrimitives()[0].listTargets().length;
  if (!n) continue;
  if (n !== names.length) throw new Error(`表情數量不符：glb ${n}、FBX ${names.length}`);
  const keepIdx = names.map((nm, i) => KEEP.includes(nm) ? i : -1).filter(i => i >= 0);
  for (const prim of mesh.listPrimitives()) {
    const ts = prim.listTargets();
    ts.forEach((t, i) => { if (!keepIdx.includes(i)) prim.removeTarget(t); });
  }
  mesh.setWeights(keepIdx.map(() => 0));
  mesh.setExtras({ ...mesh.getExtras(), targetNames: keepIdx.map(i => names[i]) });
  console.log('表情：', keepIdx.map(i => names[i]).join(', '));
}

// 貼圖：全部換掉（FBX 裡的路徑是原作者電腦的 D:\，轉檔時讀不到）
for (const t of root.listTextures()) t.dispose();
const tex = (file, mime) => doc.createTexture(file).setImage(readFileSync(file)).setMimeType(mime);
for (const m of root.listMaterials()) {
  m.setNormalTexture(null).setMetallicFactor(0).setRoughnessFactor(0.85);
  const n = m.getName();
  if (/_body$/.test(n)) m.setBaseColorTexture(tex(bodyTex, 'image/jpeg')).setBaseColorFactor([1, 1, 1, 1]);
  else if (/_head$/.test(n)) m.setBaseColorTexture(tex(headTex, 'image/jpeg')).setBaseColorFactor([1, 1, 1, 1]);
  else if (/_opacity$/.test(n)) m.setBaseColorTexture(tex(opTex, 'image/png')).setBaseColorFactor([...hair, 1]).setAlphaMode('BLEND').setDoubleSided(true);
}
await doc.transform(prune(), dedup(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
await io.write(out, doc);
console.log('寫入', out);
