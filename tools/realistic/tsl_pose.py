"""tsl_pose.py — 把語料庫的骨架（82 點，見 js/core.js）轉成 DWPose 格式，給 MimicMotion 畫成姿勢圖。

用法（Colab 筆記本會呼叫）：
    from tsl_pose import load_sample, sign_frames, to_dw, fit_to_ref, rest_like
    frames, aspect = load_sample('corpus/signs/general/ccu1.json')
    seq = sign_frames(frames)                    # 去掉頭尾太長的休息格
    poses = [to_dw(f, aspect) for f in seq]       # 每格一個 DWPose dict（座標：影片高度 = 1）
    poses = fit_to_ref(poses, ref_pose, W, H)     # 依主播圖的身體大小、位置縮放，座標換成 0～1
    img = draw_pose(poses[i], H, W)               # MimicMotion 的 mimicmotion/dwpose/util.py
"""
import base64, json
import numpy as np

P = 82
MISSING, SCALE = -32768, 8000
OFF_POSE, OFF_LH, OFF_RH, OFF_FACE = 0, 15, 36, 57
# 我們的身體點（MediaPipe 子集）：0 鼻 1 左眼 2 右眼 3 左耳 4 右耳 5 左嘴角 6 右嘴角 7 左肩 8 右肩 9 左肘 10 右肘 11 左腕 12 右腕 13 左髖 14 右髖
# OpenPose 18 點：0 鼻 1 頸 2 右肩 3 右肘 4 右腕 5 左肩 6 左肘 7 左腕 8 右髖 9 右膝 10 右踝 11 左髖 12 左膝 13 左踝 14 右眼 15 左眼 16 右耳 17 左耳
OP_FROM = {0: 0, 2: 8, 3: 10, 4: 12, 5: 7, 6: 9, 7: 11, 8: 14, 11: 13, 14: 2, 15: 1, 16: 4, 17: 3}
# 臉部 25 點 → iBUG 68 點：眉 17-21／22-26、眼（外角、內角、上、下）、嘴（左右嘴角、外上、外下、內上、內下）、鼻尖 30
FACE68 = {0: 17, 1: 18, 2: 19, 3: 20, 4: 21, 5: 22, 6: 23, 7: 24, 8: 25, 9: 26,
          10: 36, 11: 39, 12: 37, 13: 41, 14: 42, 15: 45, 16: 44, 17: 46,
          18: 48, 19: 54, 20: 51, 21: 57, 22: 62, 23: 66, 24: 30}
FACE68_EXTRA = {38: (12, None), 40: (13, None), 43: (16, None), 47: (17, None)}  # 上下眼瞼各補一點（複製）
REF_IDS = [0, 1, 2, 5, 14, 15, 16, 17]   # 用來對齊主播圖的點：鼻、頸、肩、眼、耳


def decode(data, n):
    q = np.frombuffer(base64.b64decode(data), dtype='<i2').astype(np.float32)
    q = np.where(q == MISSING, np.nan, q / SCALE)
    return q.reshape(n, P, 3)


def load_sample(path):
    s = json.load(open(path, encoding='utf-8'))
    fr = decode(s['data'], int(s['frames']))
    return fr, float(s.get('aspect') or 4 / 3), s


def hands_up(f, lim):
    return any(not np.isnan(f[OFF_POSE + w, 1]) and f[OFF_POSE + w, 1] < lim for w in (11, 12))


def sign_frames(fr, keep=4):
    """去掉頭尾手放下的格子，但各留 keep 格，讓每段都從休息姿勢開始、結束（接起來比較順）。"""
    sh = np.nanmean(fr[:, OFF_POSE + 7:OFF_POSE + 9, 1])
    hip = np.nanmean(fr[:, OFF_POSE + 13:OFF_POSE + 15, 1])
    lim = sh + (hip - sh) * 0.7 if not np.isnan(hip) else sh + 0.3
    up = [i for i, f in enumerate(fr) if hands_up(f, lim)]
    if not up:
        return fr
    a, b = max(0, up[0] - keep), min(len(fr), up[-1] + keep + 1)
    return fr[a:b]


def to_dw(f, aspect):
    """一格 → DWPose dict；座標單位：x 乘上寬高比，跟 y 同單位（影片高度 = 1）。"""
    xy = f[:, :2].copy()
    xy[:, 0] *= aspect
    body = np.full((18, 2), -1.0, np.float32)
    score = np.zeros((1, 18), np.float32)
    for op, ours in OP_FROM.items():
        p = xy[OFF_POSE + ours]
        if not np.isnan(p).any():
            body[op] = p; score[0, op] = 1
    ls, rs = xy[OFF_POSE + 7], xy[OFF_POSE + 8]
    if not (np.isnan(ls).any() or np.isnan(rs).any()):
        body[1] = (ls + rs) / 2; score[0, 1] = 1
    subset = np.array([[j if score[0, j] > 0 else -1 for j in range(18)]], np.float32)
    hands = np.full((2, 21, 2), -1.0, np.float32); hs = np.zeros((2, 21), np.float32)
    for k, off in enumerate((OFF_RH, OFF_LH)):
        h = xy[off:off + 21]
        if not np.isnan(h).any():
            hands[k] = h; hs[k] = 1
    face = np.full((1, 68, 2), -1.0, np.float32); fs = np.zeros((1, 68), np.float32)
    for ours, i68 in FACE68.items():
        p = xy[OFF_FACE + ours]
        if not np.isnan(p).any():
            face[0, i68] = p; fs[0, i68] = 1
    for i68, (src, _) in FACE68_EXTRA.items():
        if fs[0, FACE68[src]] > 0:
            face[0, i68] = face[0, FACE68[src]]; fs[0, i68] = 1
    return {'bodies': {'candidate': body, 'subset': subset, 'score': score},
            'hands': hands, 'hands_score': hs, 'faces': face, 'faces_score': fs}


def _ref_points(ref_pose, W, H):
    """主播圖 DWPose 結果 → {OpenPose 點: (像素 x, 像素 y)}"""
    b = ref_pose['bodies']; out = {}
    if len(b['subset']) == 0:
        return out
    for j in REF_IDS:
        k = int(b['subset'][0][j])
        if k >= 0:
            x, y = b['candidate'][k]
            out[j] = (x * W, y * H)
    return out


def fit_to_ref(poses, ref_pose, W, H):
    """整段一起算一個縮放＋平移（不會每格亂跳），讓手語者的身體跟主播圖對齊；回傳座標 0～1。"""
    ref = _ref_points(ref_pose, W, H)
    src, dst = [], []
    for p in poses:
        bd, sc = p['bodies']['candidate'], p['bodies']['score'][0]
        for j, q in ref.items():
            if sc[j] > 0:
                src.append(bd[j]); dst.append(q)
    if len(src) < 4:
        raise ValueError('主播圖沒偵測到上半身（鼻子、肩膀），請換一張正面、上半身清楚的圖')
    src, dst = np.array(src), np.array(dst)
    # dst = a * src + b（x、y 同一個縮放 a，人才不會變形）
    ms, md = src.mean(0), dst.mean(0)
    a = float(np.sum((src - ms) * (dst - md)) / max(np.sum((src - ms) ** 2), 1e-9))
    b = md - a * ms
    out = []
    for p in poses:
        q = {'bodies': {}, 'hands_score': p['hands_score'], 'faces_score': p['faces_score']}
        def tr(arr, valid):
            r = arr * a + b
            r = r / np.array([W, H])
            return np.where(valid[..., None] > 0, r, -1.0).astype(np.float32)
        q['bodies']['candidate'] = tr(p['bodies']['candidate'], p['bodies']['score'][0])
        q['bodies']['subset'] = p['bodies']['subset']; q['bodies']['score'] = p['bodies']['score']
        q['hands'] = tr(p['hands'], p['hands_score'])
        q['faces'] = tr(p['faces'], p['faces_score'])
        out.append(q)
    return out


def blend_from_ref(poses, ref_pose, n=4):
    """開頭補 n 格：從主播圖的姿勢慢慢過渡到第一格（只有身體與手，臉直接用第一格）。"""
    if not poses or len(ref_pose['bodies']['subset']) == 0:
        return poses
    rb = ref_pose['bodies']; first = poses[0]
    rbody = np.full((18, 2), -1.0, np.float32)
    for j in range(18):
        k = int(rb['subset'][0][j])
        if k >= 0:
            rbody[j] = rb['candidate'][k]
    pre = []
    for i in range(1, n + 1):
        t = i / (n + 1); t = t * t * (3 - 2 * t)
        fb = first['bodies']['candidate']
        both = (rbody[:, 0] >= 0) & (fb[:, 0] >= 0)
        body = np.where(both[:, None], rbody + (fb - rbody) * t, fb)
        pre.append({'bodies': {'candidate': body.astype(np.float32), 'subset': first['bodies']['subset'], 'score': first['bodies']['score']},
                    'hands': first['hands'], 'hands_score': first['hands_score'] * t,
                    'faces': first['faces'], 'faces_score': first['faces_score']})
    return pre + poses
