#!/usr/bin/env python3
"""ingest.py — 把影片（YouTube 網址或本機檔案）轉成手語骨架資料，影片本身不保存。

用法：
  python tools/ingest.py url  <網址> [--seg "0:12-0:14 謝謝" ...]   # 下載→抽骨架→刪影片
  python tools/ingest.py file <影片檔> [--seg ...]                    # 本機影片
  python tools/ingest.py pack <語料檔.json>                           # 匯入網頁匯出的語料檔
  python tools/ingest.py issue                                        # GitHub Actions：依 issue 內容處理

輸出（與網頁 js/core.js 同格式）：
  corpus/raw/<影片id>.json   整段影片的骨架（待標註）
  corpus/signs/<樣本id>.json 已標註的一個詞
  corpus/index.json          清單
"""
import argparse, base64, json, math, os, random, re, string, sys, tempfile, time, urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
CORPUS = ROOT / 'corpus'
MODELS = Path(os.environ.get('TSL_MODELS', Path.home() / '.cache' / 'tsl-models'))
FPS = 15
POSE_IDX = [0, 2, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 23, 24]
FACE_IDX = [70, 63, 105, 66, 107, 336, 296, 334, 293, 300, 33, 133, 159, 145, 362, 263, 386, 374, 61, 291, 0, 17, 13, 14, 1]
OFF_LH, OFF_RH, OFF_FACE = 15, 36, 57
P = 82
MISSING, SCALE = -32768, 8000
MAX_SECONDS = 20 * 60
URLS = {
    'pose': 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
    'hand': 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    'face': 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
}


def model(name):
    MODELS.mkdir(parents=True, exist_ok=True)
    p = MODELS / f'{name}.task'
    if not p.exists():
        print(f'下載模型 {name}…', flush=True)
        urllib.request.urlretrieve(URLS[name], p)
    return str(p)


# ---------- 抽骨架 ----------
def extract(video_path, progress=True):
    import cv2
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision
    V = vision.RunningMode.VIDEO
    pose = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model('pose')), running_mode=V, num_poses=1))
    hand = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model('hand')), running_mode=V, num_hands=2,
        min_hand_detection_confidence=0.4, min_hand_presence_confidence=0.4))
    face = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model('face')), running_mode=V, num_faces=1))
    cap = cv2.VideoCapture(str(video_path))
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    frames, i, next_t = [], 0, 0.0
    while True:
        ok, img = cap.read()
        if not ok:
            break
        t = i / src_fps
        i += 1
        if t + 1e-6 < next_t:
            continue
        next_t += 1 / FPS
        if t > MAX_SECONDS:
            break
        h, w = img.shape[:2]
        if w > 960:
            img = cv2.resize(img, (960, int(h * 960 / w)))
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        mimg = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
        ts = int(t * 1000)
        pr, hr, fr = pose.detect_for_video(mimg, ts), hand.detect_for_video(mimg, ts), face.detect_for_video(mimg, ts)
        frames.append(to_frame(pr.pose_landmarks[0] if pr.pose_landmarks else None, hr.hand_landmarks,
                               fr.face_landmarks[0] if fr.face_landmarks else None))
        if progress and len(frames) % 150 == 0:
            print(f'  {t:.0f} 秒 / {total / src_fps:.0f} 秒', flush=True)
    cap.release()
    for m in (pose, hand, face):
        m.close()
    return frames


def to_frame(pose, hands, face):
    f = np.full(P * 3, np.nan, dtype=np.float32)
    if pose is None:
        return f
    for i, k in enumerate(POSE_IDX):
        f[i * 3:i * 3 + 3] = (pose[k].x, pose[k].y, pose[k].z)
    hands = [h for h in (hands or []) if len(h) == 21][:2]
    L, R = pose[15], pose[16]
    score = lambda h: math.dist((h[0].x, h[0].y), (L.x, L.y)) - math.dist((h[0].x, h[0].y), (R.x, R.y))
    if len(hands) == 2:
        a, b = hands
        lh, rh = (a, b) if score(a) < score(b) else (b, a)
        put_hand(f, OFF_LH, lh); put_hand(f, OFF_RH, rh)
    elif len(hands) == 1:
        put_hand(f, OFF_LH if score(hands[0]) < 0 else OFF_RH, hands[0])
    if face is not None and len(face) >= 468:
        for i, k in enumerate(FACE_IDX):
            f[(OFF_FACE + i) * 3:(OFF_FACE + i) * 3 + 3] = (face[k].x, face[k].y, face[k].z)
    return f


def put_hand(f, off, h):
    for j in range(21):
        f[(off + j) * 3:(off + j) * 3 + 3] = (h[j].x, h[j].y, h[j].z)


def encode(frames):
    a = np.array(frames, dtype=np.float32).reshape(-1)
    q = np.where(np.isnan(a), MISSING, np.clip(np.round(a * SCALE), -32000, 32000)).astype('<i2')
    return base64.b64encode(q.tobytes()).decode()


def decode(data, n):
    q = np.frombuffer(base64.b64decode(data), dtype='<i2').astype(np.float32)
    q = np.where(q == MISSING, np.nan, q / SCALE)
    return list(q.reshape(n, P * 3))


# ---------- 語料檔與清單 ----------
def new_id():
    return 's' + format(int(time.time() * 1000), 'x') + ''.join(random.choices(string.ascii_lowercase + string.digits, k=4))


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def load_index():
    p = CORPUS / 'index.json'
    return json.loads(p.read_text('utf-8')) if p.exists() else {'signs': [], 'raw': []}


def save_index(ix):
    (CORPUS / 'index.json').write_text(json.dumps(ix, ensure_ascii=False, indent=1), 'utf-8')


def add_sign(ix, word, frames, src, t=None, sid=None, created=None):
    word = word.strip()
    if not word or len(frames) < 4:
        return None
    s = {'v': 1, 'id': sid or new_id(), 'word': word, 'fps': FPS, 'frames': len(frames), 'P': P, 'src': src,
         'created': created or now(), 'data': encode(frames)}
    if t:
        s['t'] = t
    if any(e['id'] == s['id'] for e in ix['signs']):
        return None
    (CORPUS / 'signs').mkdir(parents=True, exist_ok=True)
    (CORPUS / 'signs' / f"{s['id']}.json").write_text(json.dumps(s, ensure_ascii=False), 'utf-8')
    ix['signs'].append({'id': s['id'], 'word': word, 'file': f"signs/{s['id']}.json", 'src': src})
    return s


def parse_time(x):
    parts = [float(p) for p in x.strip().split(':')]
    sec = 0.0
    for p in parts:
        sec = sec * 60 + p
    return sec


def parse_segments(lines):
    out = []
    for line in lines:
        m = re.match(r'\s*([\d:.]+)\s*[-–~～]\s*([\d:.]+)\s+(.+?)\s*$', line)
        if m:
            out.append((parse_time(m.group(1)), parse_time(m.group(2)), m.group(3)))
    return out


def ingest_frames(frames, vid, title, url, segs):
    ix = load_index()
    (CORPUS / 'raw').mkdir(parents=True, exist_ok=True)
    raw = {'v': 1, 'videoId': vid, 'title': title, 'url': url, 'fps': FPS, 'frames': len(frames), 'P': P,
           'created': now(), 'data': encode(frames)}
    (CORPUS / 'raw' / f'{vid}.json').write_text(json.dumps(raw, ensure_ascii=False), 'utf-8')
    ix['raw'] = [r for r in ix['raw'] if r['id'] != vid]
    added = []
    for a, b, word in segs:
        s = add_sign(ix, word, frames[int(a * FPS):int(b * FPS) + 1], f'youtube:{vid}', [a, b])
        if s:
            added.append(word)
    ix['raw'].append({'id': vid, 'title': title, 'url': url, 'file': f'raw/{vid}.json', 'frames': len(frames),
                      'labeled': sum(1 for e in ix['signs'] if e['src'] == f'youtube:{vid}')})
    save_index(ix)
    return f'「{title}」{len(frames) / FPS:.0f} 秒骨架已存入待標註清單' + (f'；已加入 {len(added)} 個詞：{"、".join(added)}' if added else '')


def from_url(url, segs):
    import yt_dlp
    with tempfile.TemporaryDirectory() as tmp:
        opts = {'format': 'bv*[height<=720][ext=mp4]/bv*[height<=720]/b[height<=720]/bv*/b', 'outtmpl': f'{tmp}/%(id)s.%(ext)s',
                'quiet': True, 'noprogress': True, 'match_filter': yt_dlp.utils.match_filter_func(f'duration < {MAX_SECONDS}')}
        if os.environ.get('YT_COOKIES'):   # YouTube 會擋雲端主機：用 repo secret 提供登入 cookies（Netscape 格式）
            ck = Path(tmp) / 'cookies.txt'; ck.write_text(os.environ['YT_COOKIES'], 'utf-8'); opts['cookiefile'] = str(ck)
        with yt_dlp.YoutubeDL(opts) as y:
            info = y.extract_info(url, download=True)
        path = next(p for p in Path(tmp).glob(f"{info['id']}.*") if p.suffix != '.txt')
        print(f"下載完成：{info.get('title')}，開始抽骨架…", flush=True)
        frames = extract(path)
    # 離開 with 區塊時暫存影片已刪除
    return ingest_frames(frames, re.sub(r'[^\w-]', '_', info['id']), info.get('title') or url, url, segs)


def from_file(path, segs):
    frames = extract(path)
    vid = re.sub(r'[^\w-]', '_', Path(path).stem)[:40]
    return ingest_frames(frames, vid, Path(path).name, '', segs)


def from_pack(path_or_obj):
    j = json.loads(Path(path_or_obj).read_text('utf-8')) if isinstance(path_or_obj, (str, Path)) else path_or_obj
    items = j if isinstance(j, list) else j.get('samples') or ([j] if 'data' in j else [])
    ix = load_index(); added = []
    for s in items:
        try:
            n = int(s['frames']); fr = decode(s['data'], n)
            if int(s.get('P', P)) != P or not 4 <= n <= FPS * 20:
                continue
            sid = re.sub(r'[^\w]', '', str(s.get('id') or ''))[:40] or None
            r = add_sign(ix, str(s['word'])[:30], fr, str(s.get('src') or 'upload')[:60], s.get('t'), sid, s.get('created'))
            if r:
                added.append(r['word'])
        except Exception as e:  # 壞掉的樣本略過
            print('略過一筆：', e)
    save_index(ix)
    words = sorted(set(added))
    return f'加入 {len(added)} 筆語料' + (f'：{"、".join(words[:50])}' if words else '（沒有新的）')


# ---------- GitHub Actions：處理 issue ----------
def from_issue():
    ev = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text('utf-8'))
    issue = ev['issue']; title = issue['title']; body = issue.get('body') or ''
    if title.startswith('[匯入]'):
        m = re.search(r'url:\s*(\S+)', body) or re.search(r'(https?://\S+)', title)
        if not m:
            return '找不到網址'
        segs = parse_segments(body.split('segments:', 1)[1].split('```')[0].splitlines()) if 'segments:' in body else []
        return from_url(m.group(1), segs)
    if title.startswith('[語料]'):
        links = re.findall(r'https://github\.com/[^\s)\]]+/files/[^\s)\]]+', body)
        if not links:
            return '沒有找到附加的語料檔，請把下載的 .json 檔拖進留言再送一次'
        msgs = []
        for u in links:
            req = urllib.request.Request(u, headers={'Authorization': f"token {os.environ.get('GH_TOKEN', '')}"})
            with urllib.request.urlopen(req) as r:
                msgs.append(from_pack(json.loads(r.read().decode('utf-8'))))
        return '；'.join(msgs)
    return '標題要以 [匯入] 或 [語料] 開頭'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['url', 'file', 'pack', 'issue'])
    ap.add_argument('target', nargs='?')
    ap.add_argument('--seg', action='append', default=[], help='"0:12-0:14 謝謝"')
    a = ap.parse_args()
    try:
        segs = parse_segments(a.seg)
        msg = {'url': lambda: from_url(a.target, segs), 'file': lambda: from_file(a.target, segs),
               'pack': lambda: from_pack(a.target), 'issue': from_issue}[a.cmd]()
        ok = True
    except Exception as e:
        msg, ok = f'處理失敗：{e}', False
    print(msg)
    out = os.environ.get('TSL_RESULT')
    if out:
        Path(out).write_text(msg, 'utf-8')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
