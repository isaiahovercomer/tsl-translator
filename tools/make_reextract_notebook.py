#!/usr/bin/env python3
"""產生 colab/tsl_reextract.ipynb（用 WiLoR＋表情係數重抽辭典語料）。改內容改這支再執行。"""
import json
from pathlib import Path

cells = []
def md(s): cells.append({'cell_type': 'markdown', 'metadata': {}, 'source': s.strip('\n')})
def code(s): cells.append({'cell_type': 'code', 'metadata': {}, 'execution_count': None, 'outputs': [], 'source': s.strip('\n')})

md('''
# 主恢復台灣手語對話翻譯：重抽語料（WiLoR 3D 手＋臉部表情係數）
把中正大學台灣手語線上辭典 3488 個詞條重新抽骨架：
- **手指**：WiLoR（3D 手部模型）取代 MediaPipe——握拳、手指互擋、手指朝鏡頭時準很多。
- **表情**：每格多存 52 個臉部表情係數（眉毛、眨眼、嘴型…），手譯員表情直接照這個做。

**怎麼用**
1. 上方選單「執行階段 → 變更執行階段類型」選 **T4 GPU**。
2. 左邊 🔑「密鑰」新增 `GITHUB_TOKEN`（之前寫實手譯員用的同一個；GitHub fine-grained token，只選 `tsl-translator`，Contents：Read and write），並打開「筆記本存取權」。
3. 從上到下按 ▶。② 會先試 2 個詞、印出 MediaPipe 和 WiLoR 的手指角度比較。
4. ④ 會一直跑（先做寒暄／聚會／召會情境的詞），結果存在雲端硬碟 `tsl-reextract/`；**斷線了重新執行 ①→④ 會接著做**。
5. 隨時可以按 ⑤ 把做好的上傳到 GitHub 的 `reextract` 分支（不影響網站），再請 Claude 檢查、合併。

（影片只在記憶體裡處理，處理完就刪，只留骨架點和表情係數。）
''')
code('''
#@title ① 安裝（約 3～5 分鐘）
LIMIT = 0  #@param {type:"integer"}
#@markdown LIMIT：這次最多做幾個詞（0＝做到斷線或做完）
import os, subprocess, sys
from google.colab import drive, userdata
drive.mount("/content/drive")
OUT = "/content/drive/MyDrive/tsl-reextract"
os.makedirs(OUT, exist_ok=True)
if not os.path.exists("/content/tsl-translator"):
    !git clone -q --depth 1 https://github.com/isaiahovercomer/tsl-translator /content/tsl-translator
else:
    !cd /content/tsl-translator && git pull -q
!pip -q install mediapipe==0.10.32 opencv-python-headless
!pip -q install git+https://github.com/warmshao/WiLoR-mini
%cd /content/tsl-translator
import torch; print("GPU：", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "沒有（請改 T4 GPU）")
''')
code('''
#@title ② 試跑 2 個詞（三、好），比較手指角度
!rm -rf /content/rx-test
!python tools/reextract.py run --out /content/rx-test --ids ccu2224,ccu901
!python tools/reextract.py compare --out /content/rx-test --ids ccu2224,ccu901
#@markdown 看「WiLoR 手」的格數是否接近總格數；彎的手指（例如「好」的四指）WiLoR 的角度應該比 MediaPipe 大（比較彎）。
#@markdown 第一次用 WiLoR 可能會出錯：請截圖錯誤訊息給 Claude。
''')
code('''
#@title ③ 看一格（MediaPipe 綠、WiLoR 紅）
import json, base64, numpy as np, matplotlib.pyplot as plt
def dec(s):
    a = np.frombuffer(base64.b64decode(s["data"]), "<i2").astype(np.float32).reshape(s["frames"], 82, 3)
    a[a == -32768] = np.nan; return a / 8000
CH = [[0,1,2,3,4],[0,5,6,7,8],[5,9,10,11,12],[9,13,14,15,16],[13,17,18,19,20],[0,17]]
fig, ax = plt.subplots(1, 2, figsize=(8, 4))
for k, sid in enumerate(["ccu2224", "ccu901"]):
    a = dec(json.load(open(f"corpus/signs/general/{sid}.json"))); b = dec(json.load(open(f"/content/rx-test/signs/general/{sid}.json")))
    t = len(b) // 2
    for arr, c in ((a, "g"), (b, "r")):
        h = arr[min(t, len(arr) - 1), 36:57]
        if np.isnan(h[0, 0]): continue
        for ch in CH: ax[k].plot(h[ch, 0], -h[ch, 1], c)
    ax[k].set_title(sid); ax[k].axis("equal")
plt.show()
''')
code('''
#@title ④ 全部重抽（可續跑；先做情境詞）
!python tools/reextract.py run --out "$OUT" --limit $LIMIT
''')
code('''
#@title ⑤ 上傳到 GitHub 的 reextract 分支（不影響網站；Claude 檢查後再合併）
import shutil, glob, os
GH = userdata.get("GITHUB_TOKEN")
assert GH, "請先在左邊 🔑 新增 GITHUB_TOKEN"
os.chdir("/content")
!rm -rf /content/rx-push && git clone -q --depth 1 https://x-access-token:{GH}@github.com/isaiahovercomer/tsl-translator /content/rx-push
os.chdir("/content/rx-push")
!git fetch -q --depth 1 origin reextract && git checkout -q -B reextract FETCH_HEAD || git checkout -q -b reextract
os.makedirs("reextract/signs/general", exist_ok=True)
n = 0
for f in glob.glob(f"{OUT}/signs/general/*.json"):
    shutil.copy(f, "reextract/signs/general/"); n += 1
shutil.copy(f"{OUT}/log.jsonl", "reextract/log.jsonl")
!git config user.email "colab@tsl" && git config user.name "Colab 重抽語料"
!git add reextract && git commit -q -m "重抽語料（WiLoR＋表情係數）：{n} 個詞" && git push -q origin reextract
print(f"已上傳 {n} 個詞到 reextract 分支")
''')

nb = {'nbformat': 4, 'nbformat_minor': 0, 'metadata': {'colab': {'provenance': [], 'gpuType': 'T4'}, 'kernelspec': {'name': 'python3', 'display_name': 'Python 3'},
      'language_info': {'name': 'python'}, 'accelerator': 'GPU'}, 'cells': cells}
out = Path(__file__).resolve().parent.parent / 'colab' / 'tsl_reextract.ipynb'
out.write_text(json.dumps(nb, ensure_ascii=False, indent=1), 'utf-8')
print('寫好', out)
