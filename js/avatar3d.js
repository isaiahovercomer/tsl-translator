// avatar3d.js — 3D 手語人像：把 82 點骨架即時套到 Mixamo 骨架的 3D 角色上
// 預設角色：微軟 Rocketbox（MIT）寫實人像，轉成 glb 放在 avatars/；也支援 Mixamo／Ready Player Me／Performs 骨架的 .glb。
// 做法：每一格先把骨頭放回綁定姿勢，再依父→子順序把骨頭轉到骨架點的方向（手掌用三點定方向）。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OFF, PI, FI, has, BS } from './core.js';
import { faceExpr } from './avatar2d.js';

// VRM（VRoid 等插畫風 3D 角色）：humanoid 骨頭名稱 → 這裡用的 Mixamo 名稱
const VRM_MAP = { hips: 'Hips', spine: 'Spine', chest: 'Spine1', upperChest: 'Spine2', neck: 'Neck', head: 'Head' };
for (const [s, S] of [['left', 'Left'], ['right', 'Right']]) {
  Object.assign(VRM_MAP, { [s + 'Shoulder']: S + 'Shoulder', [s + 'UpperArm']: S + 'Arm', [s + 'LowerArm']: S + 'ForeArm', [s + 'Hand']: S + 'Hand' });
  const F = { Thumb: ['Metacarpal', 'Proximal', 'Distal'], Index: ['Proximal', 'Intermediate', 'Distal'], Middle: ['Proximal', 'Intermediate', 'Distal'],
    Ring: ['Proximal', 'Intermediate', 'Distal'], Little: ['Proximal', 'Intermediate', 'Distal'] };
  for (const [fi, segs] of Object.entries(F)) segs.forEach((g, k) => { VRM_MAP[s + fi + g] = S + 'Hand' + (fi === 'Little' ? 'Pinky' : fi) + (k + 1); });
}

// 3ds Max Biped（Rocketbox）骨頭名稱 → Mixamo 名稱
const BIP = { Pelvis: 'Hips', Spine: 'Spine', Spine1: 'Spine1', Spine2: 'Spine2', Neck: 'Neck', Head: 'Head' };
const BIP_SIDE = { Clavicle: 'Shoulder', UpperArm: 'Arm', Forearm: 'ForeArm', Hand: 'Hand' };
const BIP_FINGER = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
function canonical(name) {
  name = name.replace(/^mixamorig[:_]?/, '');
  let m = name.match(/^Bip01[_ ]([A-Za-z0-9]+)$/);
  if (m && BIP[m[1]]) return BIP[m[1]];
  m = name.match(/^Bip01[_ ]([LR])[_ ](Clavicle|UpperArm|Forearm|Hand)$/);
  if (m) return (m[1] === 'L' ? 'Left' : 'Right') + BIP_SIDE[m[2]];
  m = name.match(/^Bip01[_ ]([LR])[_ ]Finger([0-4])([0-9]?)(Nub)?$/);
  if (m) return (m[1] === 'L' ? 'Left' : 'Right') + 'Hand' + BIP_FINGER[+m[2]] + (m[4] ? 4 : (+(m[3] || 0) + 1));
  return name;
}

const ZK_POSE = 0.6;   // 身體點的深度（z）雜訊大，打折使用
const ZK_HAND = 1.0;
const SMOOTH = 0.6;    // 每格往目標靠近的比例（越小越平滑、越慢）

const cache = new Map();
function loadGLTF(url) {
  if (!cache.has(url)) cache.set(url, new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url).catch(e => { cache.delete(url); throw e; }));
  return cache.get(url);
}

// 手指關節限制（實驗，預設關閉）：[最小彎曲, 最大彎曲, 最大側擺]（弧度）。網址加 #fingerlimit 打開，或 #flim=9 個數字自訂。
// tools/eval_fingers.py 量過：跟骨架資料比，加限制反而差（平均 18.6° → 24.9°），因為誤差主要來自資料本身（MediaPipe 手指深度），
// 不是套到骨頭的換算。要更準得換更好的手部模型重新抽骨架（見 docs/PLAN-colab.md）。
let FLIM = null;
if (typeof location !== 'undefined' && /fingerlimit/.test(location.hash)) FLIM = [[-0.35, 1.6, 0.35], [0, 1.9, 0], [0, 1.4, 0]];
if (typeof location !== 'undefined') { const m = location.hash.match(/flim=([\d.,-]+)/); if (m) { const v = m[1].split(',').map(Number); FLIM = [[v[0], v[1], v[2]], [v[3], v[4], v[5]], [v[6], v[7], v[8]]]; } }
const PALM_SIGN = typeof location !== 'undefined' && /flip/.test(location.hash) ? -1 : 1;
const FINGERS = [
  ['Thumb', [1, 2, 3, 4]], ['Index', [5, 6, 7, 8]], ['Middle', [9, 10, 11, 12]],
  ['Ring', [13, 14, 15, 16]], ['Pinky', [17, 18, 19, 20]],
];
// 臉部表情 → 各種角色的 blendshape 名稱（ARKit／Ready Player Me、Eva）
const SHAPES = {  // 第一個是 ARKit 名稱（Rocketbox、Ready Player Me）
  // Fcl_ 開頭是 VRoid 的臉部形狀（名稱前面還有 Face.M_F00_000_00_ 之類，用結尾比對）
  jaw: ['jawOpen', 'MouthOpen', 'Jaw_Down', 'Fcl_MTH_A'],
  blinkL: ['eyeBlinkLeft', 'Blink_Left', 'Fcl_EYE_Close_L'], blinkR: ['eyeBlinkRight', 'Blink_Right', 'Fcl_EYE_Close_R'],
  browUpL: ['browOuterUpLeft', 'BrowsUp_Left', 'Fcl_BRW_Surprised'], browUpR: ['browOuterUpRight', 'BrowsUp_Right'],
  browIn: ['browInnerUp'],
  browDownL: ['browDownLeft', 'BrowsDown_Left', 'Fcl_BRW_Angry'], browDownR: ['browDownRight', 'BrowsDown_Right'],
  smileL: ['mouthSmileLeft', 'Smile_Left', 'Fcl_MTH_Fun'], smileR: ['mouthSmileRight', 'Smile_Right'],
  eyeWide: ['eyeWideLeft', 'Fcl_EYE_Surprised'], eyeWideR: ['eyeWideRight'],
  sad: ['mouthFrownLeft', 'Fcl_MTH_Sorrow'], sadR: ['mouthFrownRight'],
};
const findMorph = (dict, n) => n.startsWith('Fcl_') ? Object.keys(dict).find(k => k === n || k.endsWith('_' + n)) : (n in dict ? n : null);

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _m0 = new THREE.Matrix4(), _m1 = new THREE.Matrix4();

export class Avatar3D {
  constructor(overCanvas) {
    // 3D 畫在另一張 canvas，放在原本 2D canvas 的下面（2D 那張只畫字幕）
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'avatar3d';
    overCanvas.parentNode.insertBefore(this.canvas, overCanvas);
    this.ready = false;
  }

  async load(url) {
    this.url = url;
    // 網址後面的設定：#toon 改成插畫風；#tint=Tops:3a4a7a,Hair:4a3a36 依材質名稱調色（VRM）
    const hash = (url.split('#')[1] || ''); url = url.split('#')[0];
    const toon = /(^|&)toon($|&)/.test(hash); this.toon = toon;
    this.look = (hash.match(/look=(\w+)/) || [, ''])[1];   // VRM 畫法：comic 粗描邊漫畫、soft 柔和上色、flat 扁平色塊
    const tints = Object.fromEntries((hash.match(/tint=([^&]+)/) || [, ''])[1].split(',').filter(Boolean).map(x => x.split(':')));
    let root, vrm = null;
    if (/\.vrm(\?|$)/i.test(url)) {
      // VRM：每個畫面各自載入（VRM 物件綁在場景上，不能共用複製）
      const { VRMLoaderPlugin, VRMUtils } = await import('@pixiv/three-vrm');
      const gltf = await new GLTFLoader().register(p => new VRMLoaderPlugin(p, { autoUpdateHumanBones: false })).loadAsync(url);
      vrm = gltf.userData.vrm; root = vrm.scene;
      // VRoid 舊版（VRM0）把臉部形狀名稱放在 primitives[].extras.targetNames，three.js 沒讀：自己補上名稱
      const json = gltf.parser.json;
      root.traverse(o => {
        if (!o.isMesh || !o.morphTargetInfluences) return;
        const as = gltf.parser.associations.get(o); if (!as || as.meshes === undefined) return;
        const m = json.meshes[as.meshes], prim = m.primitives[as.primitives || 0] || m.primitives[0];
        const names = (m.extras && m.extras.targetNames) || (prim.extras && prim.extras.targetNames);
        if (names) o.morphTargetDictionary = Object.fromEntries(names.map((n, i) => [n, i]));
      });
      if (VRMUtils.removeUnnecessaryVertices) VRMUtils.removeUnnecessaryVertices(root);
    } else {
      const gltf = await loadGLTF(url);
      root = cloneSkinned(gltf.scene);
    }
    this.vrm = vrm;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, stencil: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a66, 2.0));
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(0.6, 1.6, 2.2); this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffe8d0, 0.8); fill.position.set(-1.5, 1, 1); this.scene.add(fill);
    this.scene.add(root);
    this.root = root;

    if (toon) {
      // 三階明暗的卡通著色，加上黑色描邊：寫實比例的成人角色看起來像插畫
      const g = new Uint8Array([90, 170, 255]);
      const grad = new THREE.DataTexture(g, 3, 1, THREE.RedFormat); grad.minFilter = grad.magFilter = THREE.NearestFilter; grad.needsUpdate = true;
      root.traverse(o => {
        if (!o.isMesh) return;
        const conv = m => { const t = new THREE.MeshToonMaterial({ color: m.color, map: m.map, gradientMap: grad, transparent: m.transparent, alphaTest: m.alphaTest, side: m.side });
          t.name = m.name; return t; };
        o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material);
      });
      const { OutlineEffect } = await import('three/addons/effects/OutlineEffect.js');
      this.outline = new OutlineEffect(this.renderer, { defaultThickness: 0.0035, defaultColor: [0.12, 0.1, 0.1] });
    }

    // 骨頭：去掉 mixamorig 前綴
    this.b = {};
    root.traverse(o => {
      if (o.isBone && !vrm) this.b[canonical(o.name)] = o;
      if (o.isMesh) o.frustumCulled = false;
    });
    if (vrm) {
      for (const [vn, cn] of Object.entries(VRM_MAP)) { const n = vrm.humanoid.getRawBoneNode(vn); if (n) this.b[cn] = n; }
      if (!this.b.Spine2) this.b.Spine2 = this.b.Spine1 || this.b.Spine;
    }
    for (const k of ['Hips', 'Spine2', 'Neck', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand'])
      if (!this.b[k]) throw new Error('這個 3D 角色不是 Mixamo 骨架（找不到 ' + k + '）');
    this.bind = new Map();
    for (const bone of Object.values(this.b)) this.bind.set(bone, bone.quaternion.clone());
    // 每根骨頭在自己座標裡「指向下一節」的方向（最後一節沒有子骨頭：沿用上一節的方向）
    this.axis = new Map();
    for (const bone of Object.values(this.b)) {
      const kid = bone.children.find(c => c.isBone && c.position.lengthSq() > 1e-12);
      const v = kid ? kid.position.clone() : bone.position.clone().applyQuaternion(bone.quaternion.clone().invert());
      this.axis.set(bone, v.normalize());
    }
    root.updateMatrixWorld(true);

    // 角色面向 +z、左手在 +x（Mixamo 慣例）；若左手在 -x 就轉 180 度
    const lx = this.b.LeftArm.getWorldPosition(_v1).x, rx = this.b.RightArm.getWorldPosition(_v2).x;
    if (lx < rx) { root.rotation.y += Math.PI; root.updateMatrixWorld(true); }
    this.headBindWorld = this.b.Head.getWorldQuaternion(new THREE.Quaternion());
    if (vrm) this.clarify(root, tints, vrm);

    // 臉部表情
    this.morphs = [];
    root.traverse(o => { if (o.isMesh && o.morphTargetDictionary) this.morphs.push(o); });
    this.shape = {};
    for (const [k, names] of Object.entries(SHAPES)) {
      this.shape[k] = [];
      for (const m of this.morphs) for (const n of names) { const key = findMorph(m.morphTargetDictionary, n); if (key) { this.shape[k].push([m, m.morphTargetDictionary[key]]); break; } }
    }
    this.face = { jaw: 0, blinkL: 0, blinkR: 0, browUpL: 0, browUpR: 0, browIn: 0, browDownL: 0, browDownR: 0, smileL: 0, smileR: 0, eyeWide: 0, eyeWideR: 0, sad: 0, sadR: 0 };
    this.t = performance.now();
    this.browBase = null;

    // 鏡頭：框住腰到頭頂（手語空間）
    const box = new THREE.Box3().setFromObject(root, true);
    const top = this.b.HeadTop_End ? this.b.HeadTop_End.getWorldPosition(new THREE.Vector3()).y + 0.1 : box.max.y + 0.06;
    const hips = this.b.Hips.getWorldPosition(new THREE.Vector3()).y;
    const bottom = hips + (top - hips) * 0.02;
    this.frame = { cy: (top + bottom) / 2, h: top - bottom };
    // 自動取景：平常只拍上半身（頭頂到腰），臉和手最大；手伸開時鏡頭退遠，收回再慢慢拉近
    const la = this.b.LeftArm.getWorldPosition(new THREE.Vector3()), ra = this.b.RightArm.getWorldPosition(new THREE.Vector3());
    this.cx = (la.x + ra.x) / 2; this.hipsY = hips;
    this.minW = Math.abs(la.x - ra.x) * 1.9;   // 肩寬的 1.9 倍
    this.camH = 0;
    this.camera = new THREE.PerspectiveCamera(26, 1, 0.05, 20);
    this.ready = true;
  }

  // 手語要看得清楚：眉毛、眼線畫在瀏海前面（但手擋到臉時仍被手遮住）、衣服調成跟膚色差很多的深色、描邊加粗
  clarify(root, tints, vrm) {
    // 瀏海修剪：臉前面、眉毛以下、兩眼外角之間的頭髮不畫（眉毛和眼睛露出來）。四個平面取交集，跟著頭轉
    const head = this.b.Head, le = vrm.humanoid.getRawBoneNode('leftEye'), re = vrm.humanoid.getRawBoneNode('rightEye');
    this.hairClip = null;
    if (le && re) {
      const eyeW = le.getWorldPosition(new THREE.Vector3()).add(re.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
      const hq = head.getWorldQuaternion(new THREE.Quaternion()).invert();
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(hq), fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(hq), side = new THREE.Vector3(1, 0, 0).applyQuaternion(hq);
      const eye = head.worldToLocal(eyeW.clone());
      const at = (n, p) => new THREE.Plane().setFromNormalAndCoplanarPoint(n, p);
      const local = [
        at(up, eye.clone().addScaledVector(up, 0.038)),                       // 眉毛上緣以下
        at(fwd.clone().negate(), eye.clone().addScaledVector(fwd, 0.004)),    // 眼球中心前面一點
        at(side.clone().negate(), eye.clone().addScaledVector(side, -0.062)), // 兩眼外角之間
        at(side.clone(), eye.clone().addScaledVector(side, 0.062)),
      ];
      this.hairClip = { local, world: local.map(p => p.clone()) };
      this.renderer.localClippingEnabled = true;
    }
    const isOver = n => /FaceBrow|FaceEyeline|FaceEyelash/.test(n);
    const isBody = n => /Body_\d+_SKIN|_CLOTH/.test(n);
    const done = new Set();
    root.traverse(o => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        const n = m.name || '';
        if (isOver(n)) o.renderOrder = 10;
        if (done.has(m)) continue; done.add(m);
        for (const [pat, hex] of Object.entries(tints)) if (n.includes(pat)) {
          const c = new THREE.Color('#' + hex);
          if (m.color) m.color.multiply(c);
          if (m.shadeColorFactor) m.shadeColorFactor.multiply(c).multiplyScalar(0.85);
        }
        if (isBody(n)) {   // 身體、手、衣服：在 stencil 寫 1（眉毛不能畫到這些上面）
          Object.assign(m, { stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp });
          if ('outlineWidthFactor' in m) m.outlineWidthFactor *= 1.6;
        }
        if (this.hairClip && /_HAIR/.test(n) && !/HairBack/.test(n)) Object.assign(m, { clipping: true, clippingPlanes: this.hairClip.world, clipIntersection: true });
        if (this.look && 'shadingToonyFactor' in m) this.applyLook(m, n);
        if (isOver(n)) {   // 眉毛、眼線：不做深度測試（蓋過瀏海），但 stencil=1 的地方（手、身體）不畫
          Object.assign(m, { depthTest: false, stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc,
            stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp });
          o.renderOrder = 10;
        }
      }
    });
  }

  // 同一個 VRM 換不同畫法（MToon 參數）
  applyLook(m, n) {
    const L = this.look;
    if (L === 'comic') {          // 美式漫畫：硬陰影、粗黑描邊、陰影偏深
      m.shadingToonyFactor = 1; m.shadingShiftFactor = -0.15;
      m.shadeColorFactor.copy(m.color).multiplyScalar(0.62);
      m.outlineWidthFactor = Math.max(m.outlineWidthFactor, 0.0012) * 2.4; m.outlineColorFactor.setRGB(0.05, 0.04, 0.04); m.outlineLightingMixFactor = 0;
    } else if (L === 'soft') {    // 柔和上色：漸層陰影、幾乎沒有描邊、淡淡邊緣光
      m.shadingToonyFactor = 0.25; m.shadingShiftFactor = 0.1;
      m.shadeColorFactor.copy(m.color).multiplyScalar(0.82);
      m.outlineWidthFactor *= 0.25;
      m.parametricRimColorFactor.setRGB(0.35, 0.33, 0.32); m.parametricRimFresnelPowerFactor = 4; m.rimLightingMixFactor = 0.6;
    } else if (L === 'flat') {    // 扁平色塊：沒有明暗、細描邊（像向量插畫）
      m.shadeColorFactor.copy(m.color); m.shadingToonyFactor = 1;
      m.outlineWidthFactor = Math.max(m.outlineWidthFactor, 0.001) * 1.3; m.outlineColorFactor.setRGB(0.15, 0.12, 0.12); m.outlineLightingMixFactor = 0;
      m.parametricRimColorFactor.setRGB(0, 0, 0);
    }
  }

  dispose() {
    this.ready = false;
    if (this.renderer) this.renderer.dispose();
    this.canvas.remove();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (this._w === w && this._h === h) return;
    this._w = w; this._h = h;
    this.renderer.setSize(w, h, false);
    const cam = this.camera; cam.aspect = w / h; cam.updateProjectionMatrix();
    this.camH = 0;   // 畫面大小變了：馬上重新取景
  }
  // 每一格：看手在哪裡決定鏡頭遠近（頭頂固定在畫面上方）
  frameCamera() {
    const cam = this.camera, F = this.frame, v = this._v || (this._v = new THREE.Vector3());
    let spread = 0, low = Infinity;
    for (const k of ['LeftHand', 'RightHand', 'LeftHandMiddle1', 'RightHandMiddle1', 'LeftForeArm', 'RightForeArm']) {
      const bn = this.b[k]; if (!bn) continue; bn.getWorldPosition(v);
      if (v.y < this.hipsY - 0.12) continue;            // 垂在身體兩側的手不算（不然平常就會退很遠）
      spread = Math.max(spread, Math.abs(v.x - this.cx) + (k.includes('Middle') ? 0.1 : 0));   // 指尖再往外約 10 公分
      if (k.includes('Middle') && v.y > this.hipsY + 0.02) low = Math.min(low, v.y);   // 只有舉起來比到腰附近的手才往下多留
    }
    const W = Math.max(this.minW, 2 * (spread + 0.08));
    const top = F.cy + F.h / 2;
    const need = Math.max(F.h, W / cam.aspect, low < Infinity ? top - (low - 0.13) : 0);   // 手比到腰附近：往下多留一點
    this.camH = !this.camH ? need : this.camH + (need - this.camH) * (need > this.camH ? 0.3 : 0.03);   // 退遠快、拉近慢
    const cy = top - this.camH / 2;
    const dist = this.camH / 2 / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    cam.position.set(this.cx, cy, dist); cam.lookAt(this.cx, cy, 0);
  }

  // f：已經過 normalizeSeq 的影格（y 往下）
  render(f) {
    if (!this.ready) return;
    this.resize();
    this.pose(f);
    this.frameCamera();
    if (this.hairClip) { this.b.Head.updateMatrixWorld(true); this.hairClip.local.forEach((p, i) => this.hairClip.world[i].copy(p).applyMatrix4(this.b.Head.matrixWorld)); }
    if (this.vrm && this.vrm.springBoneManager) {   // 頭髮、衣服自然擺動
      const now = performance.now(); this.vrm.springBoneManager.update(Math.min(0.05, (now - this.t) / 1000)); this.t = now;
    }
    (this.outline || this.renderer).render(this.scene, this.camera);
  }

  // ---------- 套骨架 ----------
  V(f, i, zk) { return new THREE.Vector3(f[i * 3], -f[i * 3 + 1], -f[i * 3 + 2] * zk); }
  dir(f, a, b, zk) { return has(f, a) && has(f, b) ? this.V(f, b, zk).sub(this.V(f, a, zk)) : null; }

  // 把骨頭放回綁定姿勢；回傳舊的角度（等一下平滑用）
  reset(bone) { const prev = bone.quaternion.clone(); bone.quaternion.copy(this.bind.get(bone)); bone.updateMatrixWorld(true); return prev; }
  // 設定骨頭的世界旋轉（換算成區域旋轉），再跟上一格做平滑
  setWorld(bone, wq, prev, k = SMOOTH) {
    bone.parent.getWorldQuaternion(_q1).invert();
    const local = _q1.multiply(wq);
    if (prev) bone.quaternion.copy(prev).slerp(local, k); else bone.quaternion.copy(local);
    bone.updateMatrixWorld(true);
  }
  // 骨頭目前在世界中指的方向
  boneDir(bone) { return this.axis.get(bone).clone().applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion())).normalize(); }
  // 讓骨頭（指向下一節的方向）轉到世界方向 d
  aim(bone, child, d, k = SMOOTH, prev = null) {
    if (!prev) prev = this.reset(bone);
    if (!d || d.lengthSq() < 1e-10) { this.setWorld(bone, bone.getWorldQuaternion(_q2), prev, k); return; }
    const u = this.boneDir(bone);
    const swing = new THREE.Quaternion().setFromUnitVectors(u, d.clone().normalize());
    const wq = swing.multiply(bone.getWorldQuaternion(new THREE.Quaternion()));
    this.setWorld(bone, wq, prev, k);
  }

  pose(f) {
    const b = this.b, P = i => OFF.pose + i;
    // 身體：讓兩肩連線對齊（轉身、側傾），只用一半
    const sh = this.dir(f, P(PI.rSh), P(PI.lSh), ZK_POSE);
    if (sh) {
      const prev = this.reset(b.Spine2);
      const cur = b.LeftArm.getWorldPosition(new THREE.Vector3()).sub(b.RightArm.getWorldPosition(new THREE.Vector3())).normalize();
      const swing = new THREE.Quaternion().setFromUnitVectors(cur, sh.normalize());
      swing.slerp(new THREE.Quaternion(), 0.5);
      this.setWorld(b.Spine2, swing.multiply(b.Spine2.getWorldQuaternion(new THREE.Quaternion())), prev);
    }
    this.poseHead(f);
    for (const side of ['Left', 'Right']) this.poseArm(f, side);
    this.poseFace(f);
  }

  poseHead(f) {
    const b = this.b, P = i => OFF.pose + i;
    const ids = [PI.lEye, PI.rEye, PI.mouthL, PI.mouthR];
    const prev = this.reset(b.Head);
    if (!ids.every(i => has(f, P(i)))) { this.setWorld(b.Head, b.Head.getWorldQuaternion(_q2), prev, 0.2); return; }
    const side = this.dir(f, P(PI.rEye), P(PI.lEye), ZK_POSE);
    const eyes = this.V(f, P(PI.lEye), ZK_POSE).add(this.V(f, P(PI.rEye), ZK_POSE)).multiplyScalar(0.5);
    const mouth = this.V(f, P(PI.mouthL), ZK_POSE).add(this.V(f, P(PI.mouthR), ZK_POSE)).multiplyScalar(0.5);
    const up = eyes.sub(mouth);
    // 綁定姿勢下臉朝 +z：side=+x、up=+y
    const R = basisRot(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), side, up, 'xy');
    R.slerp(new THREE.Quaternion(), 0.25);   // 只轉 75%，避免雜訊讓頭亂晃
    this.setWorld(b.Head, R.multiply(this.headBindWorld.clone()), prev, 0.35);
  }

  poseArm(f, side) {
    const b = this.b, L = side === 'Left';
    const sh = OFF.pose + (L ? PI.lSh : PI.rSh), el = OFF.pose + (L ? PI.lEl : PI.rEl), wr = OFF.pose + (L ? PI.lWr : PI.rWr);
    const off = L ? OFF.lh : OFF.rh;
    const arm = b[side + 'Arm'], fore = b[side + 'ForeArm'], hand = b[side + 'Hand'];
    this.aim(arm, fore, this.dir(f, sh, el, ZK_POSE));
    this.aim(fore, hand, this.dir(f, el, wr, ZK_POSE));

    const handPrev = this.reset(hand);
    const real = has(f, off) && !(f[(off + 5) * 3 + 2] === 0 && f[(off + 17) * 3 + 2] === 0 && f[(off + 8) * 3 + 2] === 0);
    const mid = b[side + 'HandMiddle1'], idx = b[side + 'HandIndex1'], pin = b[side + 'HandPinky1'];
    if (real && mid && idx && pin) {
      // 手掌方向：手腕→中指根、小指根→食指根
      const fwd = this.dir(f, off, off + 9, ZK_HAND), across = this.dir(f, off + 17, off + 5, ZK_HAND);
      const hp = hand.getWorldPosition(new THREE.Vector3());
      const fwd0 = mid.getWorldPosition(new THREE.Vector3()).sub(hp);
      const across0 = idx.getWorldPosition(new THREE.Vector3()).sub(pin.getWorldPosition(new THREE.Vector3()));
      const R = basisRot(fwd0, across0, fwd, across, 'xy');
      const target = R.multiply(hand.getWorldQuaternion(new THREE.Quaternion()));
      // 前臂分擔一半的扭轉，手腕才不會像擰毛巾
      const foreW = fore.getWorldQuaternion(new THREE.Quaternion());
      const delta = foreW.clone().invert().multiply(target).multiply(this.bind.get(hand).clone().invert());
      const axis = hand.position.clone().normalize();
      const tw = twist(delta, axis);
      fore.quaternion.multiply(new THREE.Quaternion().slerp(tw, 0.5)); fore.updateMatrixWorld(true);
      this.setWorld(hand, target, handPrev);
      this.poseFingers(f, side, off, hand, mid, idx, pin);
    } else {
      // 沒有手的資料：手跟著前臂、手指自然微彎
      this.setWorld(hand, hand.getWorldQuaternion(_q2), handPrev, 0.3);
      if (!(mid && idx && pin)) return;
      const hp = hand.getWorldPosition(new THREE.Vector3());
      const fwd = mid.getWorldPosition(new THREE.Vector3()).sub(hp).normalize();
      const across = idx.getWorldPosition(new THREE.Vector3()).sub(pin.getWorldPosition(new THREE.Vector3())).normalize();
      const palm = new THREE.Vector3().crossVectors(fwd, across).multiplyScalar(L ? 1 : -1).normalize();
      for (const [name] of FINGERS) {
        const curl = name === 'Thumb' ? [0.1, 0.15, 0.15] : [0.25, 0.35, 0.25];
        for (let k = 0; k < 3; k++) {
          const bone = b[side + 'Hand' + name + (k + 1)];
          if (!bone) continue;
          const prev = this.reset(bone);
          const d = this.boneDir(bone);
          const t = curl[k] * (k + 1);
          this.aim(bone, null, d.multiplyScalar(Math.cos(t)).add(palm.clone().multiplyScalar(Math.sin(t))), 0.3, prev);
        }
      }
    }
  }

  // 手指（v0.13）：照骨架方向，但加上關節限制——手指只能往掌心彎、第二三節不能側彎或往後折。
  // MediaPipe 手指的深度（z）不準，彎進掌心的手指常被看成「朝鏡頭伸直」或往手背翻；限制後彎曲的手指才會像握起來。
  poseFingers(f, side, off, hand, mid, idx, pin) {
    const b = this.b, L = side === 'Left';
    const hp = hand.getWorldPosition(new THREE.Vector3());
    const fwdA = mid.getWorldPosition(new THREE.Vector3()).sub(hp).normalize();
    const acrossA = idx.getWorldPosition(new THREE.Vector3()).sub(pin.getWorldPosition(new THREE.Vector3())).normalize();
    const palmN = new THREE.Vector3().crossVectors(fwdA, acrossA).multiplyScalar((L ? 1 : -1) * PALM_SIGN).normalize();   // 往掌心（手指彎的方向）
    for (const [name, j] of FINGERS) {
      let p = null, h = null, sgn = 1, pipFlex = 0;
      for (let k = 0; k < 3; k++) {
        const bone = b[side + 'Hand' + name + (k + 1)];
        if (!bone) continue;
        const prev = this.reset(bone);
        const d0 = this.dir(f, off + j[k], off + j[k + 1], ZK_HAND);
        if (!d0 || d0.lengthSq() < 1e-12 || name === 'Thumb' || !FLIM) { this.aim(bone, null, d0, SMOOTH, prev); continue; }
        const d = d0.normalize();
        if (k === 0) {
          p = this.boneDir(bone);
          h = acrossA.clone().addScaledVector(p, -acrossA.dot(p)).normalize();
          const m0 = palmN.clone().addScaledVector(p, -palmN.dot(p)).addScaledVector(h, -palmN.dot(h)).normalize();
          sgn = new THREE.Vector3().crossVectors(h, p).dot(m0) >= 0 ? 1 : -1;
        }
        const m = new THREE.Vector3().crossVectors(h, p).multiplyScalar(sgn).normalize();
        const dp = d.dot(p), dm = d.dot(m), da = d.dot(h);
        const [f0, f1, a1] = FLIM[k];
        let raw = Math.atan2(dm, dp);
        if (raw < -Math.PI / 2) raw += Math.PI * 2;   // 往後超過 90°＝其實是彎過頭（握拳），不是往手背折
        let flex = Math.min(f1, Math.max(f0, raw));
        if (k === 1) pipFlex = flex;
        if (k === 2) flex = Math.min(f1, Math.max(f0, flex * 0.5 + pipFlex * 0.7 * 0.5));   // 第三節大約跟著第二節彎（比較穩）
        const abd = Math.min(a1, Math.max(-a1, Math.atan2(da, Math.hypot(dp, dm))));
        const t = p.clone().multiplyScalar(Math.cos(flex)).addScaledVector(m, Math.sin(flex)).multiplyScalar(Math.cos(abd)).addScaledVector(h, Math.sin(abd));
        this.aim(bone, null, t, SMOOTH, prev);
        p = t.normalize();
      }
    }
  }

  // 臉：用 avatar2d.js 校正過的表情參數（眉毛上揚／皺眉、眼睛開合、張嘴、嘴角）
  poseFace(f) {
    const tgt = {}; for (const k in this.face) tgt[k] = 0;
    const e = f.bs ? null : faceExpr(f);
    if (f.bs) {
      // Colab 重抽的語料：直接用 52 個表情係數（ARKit 名稱）。VRoid 表情較少，對到最接近的，再稍微放大讓表情看得清楚
      const b = f.bs, c = x => Math.max(0, Math.min(1, x)), g = n => b[BS[n]];
      tgt.jaw = c(g('jawOpen') * 1.2);
      tgt.blinkL = c((g('eyeBlinkLeft') - 0.38) * 1.7); tgt.blinkR = c((g('eyeBlinkRight') - 0.38) * 1.7);   // 平常臉 eyeBlink 約 0.38（辭典例句中位數）
      tgt.browUpL = c((g('browOuterUpLeft') + g('browInnerUp') * 0.5) * 1.3); tgt.browUpR = c((g('browOuterUpRight') + g('browInnerUp') * 0.5) * 1.3);
      tgt.browIn = c(g('browInnerUp') * 1.3);
      tgt.browDownL = c(g('browDownLeft') * 1.5); tgt.browDownR = c(g('browDownRight') * 1.5);
      tgt.smileL = c(g('mouthSmileLeft') * 1.3); tgt.smileR = c(g('mouthSmileRight') * 1.3);
      tgt.sad = c(g('mouthFrownLeft') * 1.5); tgt.sadR = c(g('mouthFrownRight') * 1.5);
      tgt.eyeWide = c(g('eyeWideLeft') * 1.5); tgt.eyeWideR = c(g('eyeWideRight') * 1.5);
    } else if (e) {
      const c = x => Math.max(0, Math.min(1, x));
      tgt.jaw = c(e.mouth * 0.9);
      tgt.blinkL = c((0.45 - e.eyeL) / 0.35); tgt.blinkR = c((0.45 - e.eyeR) / 0.35);
      tgt.browUpL = c(e.browL * 1.1); tgt.browUpR = c(e.browR * 1.1); tgt.browIn = c((e.browL + e.browR) * 0.5);
      tgt.browDownL = tgt.browDownR = c(-(e.browL + e.browR) * 0.45 + e.furrow * 0.9);
      tgt.smileL = tgt.smileR = c(e.smile * 1.0);
      tgt.sad = tgt.sadR = c(-e.smile * 0.6);
      tgt.eyeWide = tgt.eyeWideR = c((e.browL + e.browR) * 0.25 + (Math.min(e.eyeL, e.eyeR) - 1.1) * 1.5);
    } else {   // 沒有臉部資料：偶爾眨眼
      const ph = (performance.now() % 4200) / 4200; tgt.blinkL = tgt.blinkR = ph > 0.97 ? 1 : 0;
    }
    for (const k in this.face) {
      this.face[k] += (tgt[k] - this.face[k]) * 0.45;
      for (const [m, i] of this.shape[k]) m.morphTargetInfluences[i] = this.face[k];
    }
  }
}

// 把「(a0 主軸, b0 副軸)」那組方向轉到「(a1, b1)」的旋轉
function basisRot(a0, b0, a1, b1) {
  const m0 = frameOf(a0, b0, _m0), m1 = frameOf(a1, b1, _m1);
  const r = new THREE.Matrix4().multiplyMatrices(m1, m0.clone().transpose());
  return new THREE.Quaternion().setFromRotationMatrix(r);
}
function frameOf(a, b, out) {
  const x = a.clone().normalize();
  const z = new THREE.Vector3().crossVectors(x, b).normalize();
  if (z.lengthSq() < 1e-8) z.set(0, 0, 1);
  const y = new THREE.Vector3().crossVectors(z, x);
  return out.makeBasis(x, y, z);
}
// 取出旋轉 q 繞著 axis 的扭轉部分
function twist(q, axis) {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  const t = new THREE.Quaternion(axis.x * d, axis.y * d, axis.z * d, q.w);
  return t.lengthSq() < 1e-10 ? new THREE.Quaternion() : t.normalize();
}
