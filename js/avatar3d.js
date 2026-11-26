// avatar3d.js — 3D 手語人像：把 82 點骨架即時套到 Mixamo 骨架的 3D 角色上
// 預設角色：微軟 Rocketbox（MIT）寫實人像，轉成 glb 放在 avatars/；也支援 Mixamo／Ready Player Me／Performs 骨架的 .glb。
// 做法：每一格先把骨頭放回綁定姿勢，再依父→子順序把骨頭轉到骨架點的方向（手掌用三點定方向）。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OFF, PI, FI, has } from './core.js';

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

const FINGERS = [
  ['Thumb', [1, 2, 3, 4]], ['Index', [5, 6, 7, 8]], ['Middle', [9, 10, 11, 12]],
  ['Ring', [13, 14, 15, 16]], ['Pinky', [17, 18, 19, 20]],
];
// 臉部表情 → 各種角色的 blendshape 名稱（ARKit／Ready Player Me、Eva）
const SHAPES = {  // 第一個是 ARKit 名稱（Rocketbox、Ready Player Me）
  jaw: ['jawOpen', 'MouthOpen', 'Jaw_Down'],
  blinkL: ['eyeBlinkLeft', 'Blink_Left'], blinkR: ['eyeBlinkRight', 'Blink_Right'],
  browUpL: ['browOuterUpLeft', 'BrowsUp_Left'], browUpR: ['browOuterUpRight', 'BrowsUp_Right'],
  browIn: ['browInnerUp'],
  browDownL: ['browDownLeft', 'BrowsDown_Left'], browDownR: ['browDownRight', 'BrowsDown_Right'],
  smileL: ['mouthSmileLeft', 'Smile_Left'], smileR: ['mouthSmileRight', 'Smile_Right'],
};

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
    const gltf = await loadGLTF(url);
    const root = cloneSkinned(gltf.scene);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a66, 2.0));
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(0.6, 1.6, 2.2); this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffe8d0, 0.8); fill.position.set(-1.5, 1, 1); this.scene.add(fill);
    this.scene.add(root);
    this.root = root;

    // 骨頭：去掉 mixamorig 前綴
    this.b = {};
    root.traverse(o => {
      if (o.isBone) this.b[canonical(o.name)] = o;
      if (o.isMesh) o.frustumCulled = false;
    });
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

    // 臉部表情
    this.morphs = [];
    root.traverse(o => { if (o.isMesh && o.morphTargetDictionary) this.morphs.push(o); });
    this.shape = {};
    for (const [k, names] of Object.entries(SHAPES)) {
      this.shape[k] = [];
      for (const m of this.morphs) for (const n of names) if (n in m.morphTargetDictionary) { this.shape[k].push([m, m.morphTargetDictionary[n]]); break; }
    }
    this.face = { jaw: 0, blinkL: 0, blinkR: 0, browUpL: 0, browUpR: 0, browIn: 0, browDownL: 0, browDownR: 0, smileL: 0, smileR: 0 };
    this.browBase = null;

    // 鏡頭：框住腰到頭頂（手語空間）
    const box = new THREE.Box3().setFromObject(root, true);
    const top = this.b.HeadTop_End ? this.b.HeadTop_End.getWorldPosition(new THREE.Vector3()).y + 0.1 : box.max.y + 0.06;
    const hips = this.b.Hips.getWorldPosition(new THREE.Vector3()).y;
    const bottom = hips + (top - hips) * 0.02;
    this.frame = { cy: (top + bottom) / 2, h: top - bottom };
    this.camera = new THREE.PerspectiveCamera(26, 1, 0.05, 20);
    this.ready = true;
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
    const cam = this.camera; cam.aspect = w / h;
    // 直的畫面要再退遠一點，手伸開才不會被切掉
    const needH = Math.max(this.frame.h, 1.1 / cam.aspect);
    const dist = needH / 2 / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    cam.position.set(0, this.frame.cy, dist); cam.lookAt(0, this.frame.cy, 0); cam.updateProjectionMatrix();
  }

  // f：已經過 normalizeSeq 的影格（y 往下）
  render(f) {
    if (!this.ready) return;
    this.resize();
    this.pose(f);
    this.renderer.render(this.scene, this.camera);
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
      for (const [name, j] of FINGERS) {
        for (let k = 0; k < 3; k++) {
          const bone = b[side + 'Hand' + name + (k + 1)];
          if (bone) this.aim(bone, null, this.dir(f, off + j[k], off + j[k + 1], ZK_HAND));
        }
      }
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

  // 臉：嘴巴張開、眨眼、眉毛（以眼睛寬度當尺）
  poseFace(f) {
    const F = i => OFF.face + i, tgt = {};
    for (const k in this.face) tgt[k] = 0;
    if (has(f, F(FI.noseTip))) {
      const d = (a, c) => Math.hypot(f[F(a) * 3] - f[F(c) * 3], f[F(a) * 3 + 1] - f[F(c) * 3 + 1]);
      const eyeW = (d(FI.lEye[0], FI.lEye[1]) + d(FI.rEye[0], FI.rEye[1])) / 2 || 1;
      const clamp = x => Math.max(0, Math.min(1, x));
      tgt.jaw = clamp((d(FI.mouth[4], FI.mouth[5]) / eyeW - 0.08) / 0.9);
      tgt.blinkL = clamp(1 - (d(FI.lEye[2], FI.lEye[3]) / eyeW - 0.12) / 0.16);
      tgt.blinkR = clamp(1 - (d(FI.rEye[2], FI.rEye[3]) / eyeW - 0.12) / 0.16);
      // 眉毛高度跟自己平常的高度比（慢慢更新的基準）
      const brow = (br, eye) => { const by = br.reduce((s, i) => s + f[F(i) * 3 + 1], 0) / br.length; const ey = (f[F(eye[0]) * 3 + 1] + f[F(eye[1]) * 3 + 1]) / 2; return (ey - by) / eyeW; };
      const bl = brow(FI.lBrow, FI.lEye), brr = brow(FI.rBrow, FI.rEye);
      if (!this.browBase) this.browBase = [bl, brr];
      this.browBase[0] += (bl - this.browBase[0]) * 0.01; this.browBase[1] += (brr - this.browBase[1]) * 0.01;
      const ul = (bl - this.browBase[0]) / 0.25, ur = (brr - this.browBase[1]) / 0.25;
      tgt.browUpL = clamp(ul); tgt.browUpR = clamp(ur); tgt.browIn = clamp((ul + ur) / 2);
      tgt.browDownL = clamp(-ul); tgt.browDownR = clamp(-ur);
      const mw = d(FI.mouth[0], FI.mouth[1]) / eyeW;
      tgt.smileL = tgt.smileR = clamp((mw - 1.75) / 0.6);
    }
    for (const k in this.face) {
      this.face[k] += (tgt[k] - this.face[k]) * 0.4;
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
