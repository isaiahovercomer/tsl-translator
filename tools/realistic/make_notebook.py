"""產生 colab/tsl_realistic.ipynb（寫實 2D 手語主播：骨架 → MimicMotion 影片）。改筆記本內容就改這裡再執行一次。"""
import json
from pathlib import Path

cells = []
def md(s): cells.append({'cell_type': 'markdown', 'metadata': {}, 'source': s.strip('\n')})
def code(s, form=False):
    cells.append({'cell_type': 'code', 'metadata': {'cellView': 'form'} if form else {}, 'execution_count': None, 'outputs': [], 'source': s.strip('\n')})

md(r"""
# 台灣手語：寫實 2D 主播影片產生器
把語料庫裡每個詞的**骨架動作**，交給 AI（騰訊 MimicMotion，用 Stable Video Diffusion）畫成**寫實插畫風主播**打手語的影片。
做好的影片放到網站上，對話時就用寫實主播來比。

**第一次使用前（只要做一次）**
1. 上方選單「執行階段 → 變更執行階段類型」選 **GPU**（T4 可以跑，L4／A100 快很多）。
2. 到 https://huggingface.co/stabilityai/stable-video-diffusion-img2vid-xt-1-1 登入後按 **Agree** 同意授權。
3. 到 https://huggingface.co/settings/tokens 建一個 **Read** 權杖。
4. 左邊 🔑「密鑰（Secrets）」新增 `HF_TOKEN` = 剛剛的權杖，並打開「筆記本存取權」。
5. （要自動上傳到網站才需要）新增 `GITHUB_TOKEN`：GitHub → Settings → Developer settings → Fine-grained token，只選 `tsl-translator`，Contents 設 Read and write。

**之後每次**：從上到下按 ▶ 執行。做好的影片存在 Google 雲端硬碟 `tsl-realistic/`，斷線重跑會從沒做完的詞接著做。
""")

code(r"""
#@title ① 設定
PRESENTER = "f1"  #@param ["f1", "f2", "m1", "m2"]
#@markdown f1 女・長髮、f2 女・短髮、m1 男・短髮、m2 男・眼鏡（主播長相在第 ③ 格產生或上傳）
N_WORDS = 30  #@param {type:"integer"}
#@markdown 這次要做幾個詞（常用的先做；T4 一個詞約 2～4 分鐘，L4 約 1 分鐘）
RESOLUTION = 384  #@param [384, 576] {type:"raw"}
#@markdown 影片寬度：384（384×640，較快）或 576（576×1024，較清楚、要 L4／A100）
STEPS = 20  #@param {type:"integer"}
EXTRA_WORDS = ""  #@param {type:"string"}
#@markdown 一定要做的詞，用頓號或空白分開，例如：弟兄、禱告、聖經
SEED = 42
DRIVE_DIR = "/content/drive/MyDrive/tsl-realistic"
""", form=True)

code(r"""
#@title ② 安裝（約 5 分鐘）
import os, subprocess, sys
from pathlib import Path
gpu = subprocess.run("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader", shell=True, capture_output=True, text=True).stdout.strip()
print("GPU：", gpu or "沒有！請到「執行階段 → 變更執行階段類型」選 GPU")
assert gpu, "需要 GPU"
from google.colab import drive, userdata
drive.mount("/content/drive")
Path(DRIVE_DIR, PRESENTER).mkdir(parents=True, exist_ok=True)
try:
    HF_TOKEN = userdata.get("HF_TOKEN")
except Exception:
    HF_TOKEN = None
assert HF_TOKEN, "請先在左邊 🔑 新增 HF_TOKEN（見最上面說明）"
os.environ["HF_TOKEN"] = HF_TOKEN
os.chdir("/content")
if not Path("tsl-translator").exists():
    !git clone -q --depth 1 https://github.com/isaiahovercomer/tsl-translator.git
else:
    !cd tsl-translator && git pull -q
if not Path("MimicMotion").exists():
    !git clone -q --depth 1 https://github.com/Tencent/MimicMotion.git
!pip install -q "diffusers==0.27.2" "transformers==4.41.2" "huggingface_hub==0.25.2" accelerate omegaconf einops onnxruntime-gpu imageio-ffmpeg
os.chdir("/content/MimicMotion")
# 新版 PyTorch 的 safe_globals 用法不同，MimicMotion 原本的寫法會出錯：改成直接載入
!sed -i 's/with torch.serialization.safe_globals(\*allowed_modules):/if True:/' mimicmotion/utils/loader.py
!mkdir -p models/DWPose
if not Path("models/DWPose/yolox_l.onnx").exists():
    !wget -q https://huggingface.co/yzd-v/DWPose/resolve/main/yolox_l.onnx -O models/DWPose/yolox_l.onnx
    !wget -q https://huggingface.co/yzd-v/DWPose/resolve/main/dw-ll_ucoco_384.onnx -O models/DWPose/dw-ll_ucoco_384.onnx
if not Path("models/MimicMotion_1-1.pth").exists():
    !wget -q https://huggingface.co/tencent/MimicMotion/resolve/main/MimicMotion_1-1.pth -O models/MimicMotion_1-1.pth
from huggingface_hub import snapshot_download
SVD = snapshot_download("stabilityai/stable-video-diffusion-img2vid-xt-1-1", token=HF_TOKEN,
    allow_patterns=["unet/config.json", "vae/*fp16*", "vae/config.json", "image_encoder/*fp16*", "image_encoder/config.json",
                    "scheduler/*", "feature_extractor/*", "model_index.json"])
sys.path.insert(0, "/content/MimicMotion"); sys.path.insert(0, "/content/tsl-translator/tools/realistic")
print("安裝完成 ✅")
""", form=True)

code(r"""
#@title ③ 主播長相：產生候選圖（或上傳自己的圖）
#@markdown 想用自己準備的圖：把 `UPLOAD` 打勾再執行，選一張**正面、上半身到腰、雙手自然放下、背景單純**的直式圖。
UPLOAD = False  #@param {type:"boolean"}
N_CANDIDATES = 4  #@param {type:"integer"}
import torch, gc
from PIL import Image
from IPython.display import display
ref_path = Path(DRIVE_DIR, PRESENTER, "presenter.png")
LOOKS = {
  "f1": "young Taiwanese woman, long straight black hair with side-swept bangs, gentle smile, navy blue blazer over white t-shirt",
  "f2": "young Taiwanese woman, short black bob haircut with bangs, friendly smile, dark burgundy blouse",
  "m1": "young Taiwanese man, short neat black hair, friendly smile, navy blue blazer over white shirt",
  "m2": "Taiwanese man in his thirties, side-parted dark hair, thin black glasses, warm smile, dark green sweater over light blue collared shirt",
}
STYLE = ("semi-realistic anime illustration, korean webtoon style, soft cel shading, clean lineart, sign language news presenter, "
         "front view, looking at viewer, upper body from waist up, both arms relaxed down at sides, hands visible, plain light blue studio background, centered")
NEG = "photo, 3d render, deformed hands, extra fingers, extra arms, crossed arms, hands in pockets, side view, cropped head, text, watermark, busy background"
if UPLOAD:
    from google.colab import files
    up = files.upload()
    Image.open(next(iter(up))).convert("RGB").save(ref_path)
    display(Image.open(ref_path).resize((288, 512)))
else:
    from diffusers import StableDiffusionXLPipeline
    sd = StableDiffusionXLPipeline.from_pretrained("stabilityai/stable-diffusion-xl-base-1.0", torch_dtype=torch.float16, variant="fp16", use_safetensors=True).to("cuda")
    cands = []
    for k in range(N_CANDIDATES):
        g = torch.Generator("cuda").manual_seed(1000 + k)
        im = sd(prompt=f"{LOOKS[PRESENTER]}, {STYLE}", negative_prompt=NEG, width=768, height=1344, num_inference_steps=30, guidance_scale=6.5, generator=g).images[0]
        p = Path(DRIVE_DIR, PRESENTER, f"candidate_{k}.png"); im.save(p); cands.append(p)
    del sd; gc.collect(); torch.cuda.empty_cache()
    grid = Image.new("RGB", (288 * len(cands), 512), "white")
    for k, p in enumerate(cands): grid.paste(Image.open(p).resize((288, 512)), (288 * k, 0))
    display(grid); print("由左到右是 0、1、2…，在下一格填你要的編號")
""", form=True)

code(r"""
#@title ④ 選定主播
PICK = 0  #@param {type:"integer"}
#@markdown 上一格候選圖的編號（上傳自己的圖就不用改）
if not UPLOAD:
    Image.open(Path(DRIVE_DIR, PRESENTER, f"candidate_{PICK}.png")).save(ref_path)
import math, numpy as np
from torchvision.transforms.functional import pil_to_tensor, resize, center_crop
W_T = RESOLUTION; H_T = int(RESOLUTION / (9 / 16) // 64) * 64
img = pil_to_tensor(Image.open(ref_path).convert("RGB"))
h, w = img.shape[-2:]
if h / w < H_T / W_T: hr, wr = H_T, math.ceil(H_T * w / h)
else: hr, wr = math.ceil(W_T * h / w), W_T
ref_pixels = center_crop(resize(img, [hr, wr], antialias=True), [H_T, W_T]).permute(1, 2, 0).numpy()
from mimicmotion.dwpose.dwpose_detector import dwpose_detector
from mimicmotion.dwpose.util import draw_pose
ref_pose = dwpose_detector(ref_pixels)
assert len(ref_pose["bodies"]["subset"]) > 0, "這張圖偵測不到人，請換一張"
ref_pose_img = draw_pose(ref_pose, H_T, W_T)
display(Image.fromarray(np.concatenate([ref_pixels, ref_pose_img.transpose(1, 2, 0)], 1)).resize((W_T, H_T // 2)))
print(f"主播 {PRESENTER}：{W_T}×{H_T}，右邊是偵測到的骨架（鼻子、肩膀要對）")
""", form=True)

code(r"""
#@title ⑤ 挑要做的詞（常用詞優先）
import json, re, collections
TSL = Path("/content/tsl-translator")
ix = json.load(open(TSL / "corpus/index.json", encoding="utf-8"))
by_word = collections.defaultdict(list)
for s in ix["signs"]:
    by_word[s["word"]].append(s)
ex = json.load(open(TSL / "corpus/dict/gloss-examples.json", encoding="utf-8"))
freq = collections.Counter(w for _, g in ex for w in g.split("/"))
BASIC = "你好 謝謝 對不起 再見 我 你 他 我們 你們 他們 是 不 不是 要 不要 會 不會 有 沒有 好 可以 喜歡 知道 不知道 想 去 來 吃 看 說 做 今天 明天 昨天 現在 什麼 誰 哪裡 為什麼 怎麼 幾 家 朋友 愛 幫忙 請 名字 時間 聚會 禱告 讀 書 學習 工作 快樂 平安 主 神 耶穌 聖經 教會 弟兄 姊妹".split()
extra = [w for w in re.split(r"[、，,\s]+", EXTRA_WORDS) if w]
order = []
for w in extra + BASIC + [w for w, _ in freq.most_common()]:
    if w in by_word and w not in order: order.append(w)
def best(w):   # 召會生活用語優先，其次手部偵測品質
    return sorted(by_word[w], key=lambda s: (s.get("cat") != "church", -(s.get("q") or 0.5)))[0]
out_dir = Path(DRIVE_DIR, PRESENTER)
manifest_p = out_dir / "manifest.json"
manifest = json.load(open(manifest_p)) if manifest_p.exists() else {}
todo = [w for w in order if w not in manifest][:N_WORDS]
print(f"已完成 {len(manifest)} 個；這次做 {len(todo)} 個：", "、".join(todo))
""", form=True)

code(r"""
#@title ⑥ 產生影片（可以中斷，重跑會接著做）
import time, imageio
from omegaconf import OmegaConf
from mimicmotion.utils.geglu_patch import patch_geglu_inplace
patch_geglu_inplace()
from mimicmotion.utils.loader import create_pipeline
from tsl_pose import load_sample, sign_frames, to_dw, fit_to_ref, blend_from_ref
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "max_split_size_mb:256"
torch.set_default_dtype(torch.float16)
if "pipe" not in globals():
    pipe = create_pipeline(OmegaConf.create({"base_model_path": SVD, "ckpt_path": "models/MimicMotion_1-1.pth"}), torch.device("cuda"))
ref_t = torch.from_numpy(ref_pixels.transpose(2, 0, 1)[None].copy()).float() / 127.5 - 1
ref_pil = Image.fromarray(ref_pixels)
def safe(w): return re.sub(r"[^\w]", "_", w)
t_all = time.time()
for n, w in enumerate(todo):
    t0 = time.time(); s = best(w)
    fr, asp, meta = load_sample(TSL / "corpus" / s["file"])
    poses = blend_from_ref(fit_to_ref([to_dw(f, asp) for f in sign_frames(fr)], ref_pose, W_T, H_T), ref_pose)
    pose_imgs = np.stack([ref_pose_img] + [draw_pose(p, H_T, W_T) for p in poses])
    pose_t = torch.from_numpy(pose_imgs.copy()).float() / 127.5 - 1
    g = torch.Generator(device="cuda").manual_seed(SEED)
    with torch.no_grad():
        frames = pipe([ref_pil], image_pose=pose_t, num_frames=pose_t.size(0), tile_size=min(72, pose_t.size(0)), tile_overlap=6,
                      height=H_T, width=W_T, fps=7, noise_aug_strength=0, num_inference_steps=STEPS, generator=g,
                      min_guidance_scale=2.0, max_guidance_scale=2.0, decode_chunk_size=4, output_type="pt", device="cuda").frames.cpu()
    vid = (frames[0, 1:] * 255).clamp(0, 255).to(torch.uint8).permute(0, 2, 3, 1).numpy()   # 第一格是主播圖本身，不要
    fn = f"{safe(w)}__{s['id']}.mp4"
    imageio.mimwrite(out_dir / fn, vid, fps=15, codec="libx264", quality=None, output_params=["-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart"])
    manifest[w] = {"file": fn, "frames": int(len(vid)), "src": s["id"], "cat": s.get("cat", "general")}
    json.dump(manifest, open(manifest_p, "w"), ensure_ascii=False, indent=1)
    el = time.time() - t0; left = (time.time() - t_all) / (n + 1) * (len(todo) - n - 1)
    print(f"[{n + 1}/{len(todo)}] {w}：{len(vid)} 格，{el:.0f} 秒；預計還要 {left / 60:.0f} 分鐘", flush=True)
    torch.cuda.empty_cache()
print("全部完成 ✅  影片在雲端硬碟", out_dir)
""", form=True)

code(r"""
#@title ⑦ 看看成果
from IPython.display import HTML
from base64 import b64encode
show = list(manifest)[-3:]
html = "".join(f"<div style='display:inline-block;margin:4px;text-align:center'><video src='data:video/mp4;base64,{b64encode(open(out_dir / manifest[w]['file'], 'rb').read()).decode()}' width=240 autoplay loop muted playsinline></video><br>{w}</div>" for w in show)
HTML(html)
""", form=True)

code(r"""
#@title ⑧ 上傳到網站（需要 GITHUB_TOKEN；沒有的話把雲端硬碟 tsl-realistic 資料夾的檔案傳給 Claude）
import shutil
GH = userdata.get("GITHUB_TOKEN")
assert GH, "請先在左邊 🔑 新增 GITHUB_TOKEN"
os.chdir("/content")
if not Path("tsl-push").exists():
    !git clone -q --depth 1 --filter=blob:none --sparse https://x-access-token:{GH}@github.com/isaiahovercomer/tsl-translator.git tsl-push
    !cd tsl-push && git sparse-checkout set realistic
dst = Path("/content/tsl-push/realistic", PRESENTER); dst.mkdir(parents=True, exist_ok=True)
shutil.copy(ref_path, dst / "presenter.png")
for w, m in manifest.items():
    if not (dst / m["file"]).exists(): shutil.copy(out_dir / m["file"], dst / m["file"])
json.dump(manifest, open(dst / "manifest.json", "w"), ensure_ascii=False, indent=1)
os.chdir("/content/tsl-push")
!git config user.name "tsl-colab" && git config user.email "colab@users.noreply.github.com"
!git add realistic && git commit -q -m "寫實主播影片：{PRESENTER}（{len(manifest)} 個詞）" && git pull -q --rebase && git push -q
os.chdir("/content/MimicMotion")
print(f"已上傳 {len(manifest)} 個詞 ✅  約 1 分鐘後網站更新")
""", form=True)

nb = {'nbformat': 4, 'nbformat_minor': 0, 'metadata': {'colab': {'provenance': [], 'gpuType': 'T4'}, 'kernelspec': {'name': 'python3', 'display_name': 'Python 3'},
      'language_info': {'name': 'python'}, 'accelerator': 'GPU'}, 'cells': cells}
out = Path(__file__).resolve().parents[2] / 'colab' / 'tsl_realistic.ipynb'
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(nb, ensure_ascii=False, indent=1), 'utf-8')
print('寫入', out)
