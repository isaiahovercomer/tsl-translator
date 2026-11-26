#!/usr/bin/env python3
"""產生 colab/tsl_recog_train.ipynb（訓練手語單詞辨識模型）。改內容改這支再執行。"""
import json
from pathlib import Path

cells = []
def md(s): cells.append({'cell_type': 'markdown', 'metadata': {}, 'source': s.strip('\n')})
def code(s): cells.append({'cell_type': 'code', 'metadata': {}, 'execution_count': None, 'outputs': [], 'source': s.strip('\n')})

md('''
# 主恢復台灣手語對話翻譯：訓練手語辨識模型（第一版）
用骨架資料訓練「手勢 → 詞」的模型，取代現在網頁用的 DTW 比對，並且**用同樣的資料跟 DTW 比準確率**。

資料（都只有骨架點，沒有影像）：
- 中正大學辭典 **單詞示範**（每個詞約 1 支）＋大量資料增強（快慢、左右手、角度、手指、遮手、雜訊）
- 辭典 **546 句例句** 自動切出來的詞（比較像真的連續手語）
- 收集模式錄的 **真人資料**（collect 分支；人越多越準）

**怎麼用**
1. 「執行階段 → 變更執行階段類型」選 **T4 GPU**（沒有 GPU 也能跑，只是慢）。
2. 左邊 🔑「密鑰」要有 `GITHUB_TOKEN`（之前重抽語料用的同一個），並打開「筆記本存取權」。⑤ 上傳才需要。
3. 從上到下按 ▶。③ 訓練約 5～15 分鐘，最後印出 **DTW 和模型的準確率比較**。
4. 按 ⑤ 把模型上傳到 GitHub 的 `models` 分支（不影響網站），再請 Claude 接到網站上。

真人資料還很少時，模型主要是學辭典，準確率參考就好；收集到 5 個人以上再訓練一次會準很多。
''')
code('''
#@title ① 準備（約 1 分鐘）
import os
from google.colab import drive
drive.mount("/content/drive")
OUT_ROOT = "/content/drive/MyDrive/tsl-models"
os.makedirs(OUT_ROOT, exist_ok=True)
if not os.path.exists("/content/tsl-translator"):
    !git clone -q --depth 1 https://github.com/isaiahovercomer/tsl-translator /content/tsl-translator
else:
    !cd /content/tsl-translator && git pull -q
# 收集模式的真人資料（collect 分支）
!rm -rf /content/collect /content/collect-repo && git clone -q --depth 1 --filter=blob:none --sparse -b collect https://github.com/isaiahovercomer/tsl-translator /content/collect-repo && cd /content/collect-repo && git sparse-checkout set collect && mv collect /content/collect; rm -rf /content/collect-repo
!pip -q install onnx onnxruntime onnxscript
%cd /content/tsl-translator
import torch, json
print("GPU：", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "沒有（會比較慢）")
st = json.load(open("/content/collect/stats.json")) if os.path.exists("/content/collect/stats.json") else {}
print("真人資料：", st.get("samples", 0), "筆，", len([k for k, v in st.get("signers", {}).items() if v.get("n")]), "人")
''')
code('''
#@title ② 設定
VERSION = "v1"  #@param {type:"string"}
EPOCHS = 80  #@param {type:"integer"}
USE_COLLECT = True  #@param {type:"boolean"}
#@markdown VERSION：這次模型的名字（例如 v1、v2-5人）。EPOCHS：越多越久，80 約 10 分鐘（T4）。
OUT = f"{OUT_ROOT}/{VERSION}"
COL = "/content/collect" if USE_COLLECT and os.path.exists("/content/collect") else ""
print("輸出到", OUT)
''')
code('''
#@title ③ 訓練＋跟 DTW 比較
!python tools/train_recog.py --epochs $EPOCHS --out "$OUT" --collect "$COL"
''')
code('''
#@title ④ 看報告
import json
r = json.load(open(f"{OUT}/report.json"))
print("訓練資料：", r["train"], "　測試資料：", r["test"])
print(f'{"範圍":<10}{"筆數":>6}   DTW top1 / top3      模型 top1 / top3')
for k, v in r["eval"].items():
    if k == "confused": continue
    print(f'{v["name"]:<10}{v["n"]:>6}   {v["dtw"]["top1"]:6.1%} / {v["dtw"]["top3"]:6.1%}     {v["model"]["top1"]:6.1%} / {v["model"]["top3"]:6.1%}')
print("\\n最常認錯（正確 → 認成）：")
print("、".join(f"{a}→{b}" for a, b, n in r["eval"].get("confused", [])[:30]))
print("\\nONNX：", r["onnx"])
''')
code('''
#@title ⑤ 上傳到 GitHub 的 models 分支（不影響網站）
import shutil, os
from google.colab import userdata
GH = userdata.get("GITHUB_TOKEN")
assert GH, "請先在左邊 🔑 新增 GITHUB_TOKEN"
os.chdir("/content")
!rm -rf /content/m-push && git clone -q --depth 1 https://x-access-token:{GH}@github.com/isaiahovercomer/tsl-translator /content/m-push
os.chdir("/content/m-push")
!git fetch -q --depth 1 origin models && git checkout -q -B models FETCH_HEAD || git checkout -q -b models
dst = f"models/{VERSION}"
os.makedirs(dst, exist_ok=True)
for f in ("tsl-recog.int8.onnx", "labels.json", "report.json"):
    if os.path.exists(f"{OUT}/{f}"): shutil.copy(f"{OUT}/{f}", dst)
!git config user.email "colab@tsl" && git config user.name "Colab 訓練模型"
!git add models && git commit -q -m "[CF-Pages-Skip] 辨識模型 {VERSION}" && git push -q origin models
print("已上傳到 models 分支：", dst)
''')

nb = {'nbformat': 4, 'nbformat_minor': 0, 'metadata': {'colab': {'provenance': [], 'gpuType': 'T4'}, 'kernelspec': {'name': 'python3', 'display_name': 'Python 3'},
      'language_info': {'name': 'python'}, 'accelerator': 'GPU'}, 'cells': cells}
out = Path(__file__).resolve().parent.parent / 'colab' / 'tsl_recog_train.ipynb'
out.write_text(json.dumps(nb, ensure_ascii=False, indent=1), 'utf-8')
print('寫好', out)
