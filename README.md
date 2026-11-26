# 台灣手語對話翻譯器（PWA）

網站：https://tslinterpreter.pages.dev/ （Cloudflare Pages）・備用：https://isaiahovercomer.github.io/tsl-translator/

聽人和聾人面對面坐著，一個畫面雙向翻譯，以**台灣手語（自然手語）**為主：

- **聽人說話 → 手語人像**：瀏覽器語音辨識（zh-TW）→ 用語料庫的詞做最長比對 → 把每個詞的骨架動作接起來，由 3D 寫實人像即時比出來（手臂、手掌方向、每根手指、臉部表情）。
- **聾人比手語 → 台灣中文語音**：鏡頭 → MediaPipe Holistic 抓骨架 → 手舉起／放下自動切詞 → DTW 比對語料庫 → 停下來後用 zh-TW 語音唸出整句。

## 語料：只存骨架，不存影片
每個詞存成 15 fps、82 個點（身體 15＋左右手各 21＋臉 25）的 Int16 資料，約 20–30 KB。另記 `aspect`（影片寬÷高），3D 人像換算真實比例用；舊資料沒有時用手的骨長估計。

| 來源 | 在哪裡處理 |
|---|---|
| 鏡頭錄製 | 裝置上 |
| 上傳影片檔 | 裝置上（影片讀完就丟） |
| YouTube：邊播邊擷取 | 電腦版 Chrome／Edge，擷取分頁畫面即時抽骨架 |
| YouTube：送雲端 | GitHub Actions（`tools/ingest.py`），需 repo secret `YT_COOKIES`，否則會被 YouTube 擋 |

共用語料只先下載清單（`corpus/index.json`），骨架用到才下載；辨識特徵預先算好放 `corpus/feats.json`（`tools/build_feats.mjs`），開鏡頭時才載入。本機語料存在 IndexedDB；「上傳到共用語料庫」會下載語料檔並開 GitHub issue（標題 `[語料]`），把檔案拖進去送出，Actions 自動寫進 `corpus/`。

## 語料分類
- **一般生活用語**（`general`）、**召會生活用語**（`cat: church`，例如江啟禎弟兄的主恢復手語影片）。
- 每筆語料記 `cat`；共用語料庫依分類分資料夾：`corpus/signs/general/`、`corpus/signs/church/`（`raw/` 同理）。
- 對話時同一個詞兩類都有，依設定優先用其中一類（預設召會生活用語）。

## 參考資源（站在前人的基礎上）
- [台灣手語線上辭典](https://twtsl.ccu.edu.tw/)（中正大學，第五版 4600 詞、560 例句）：已溝通同意使用。`tools/ccu_dict.py` + Actions「匯入台灣手語線上辭典」把 3500 個詞條影片轉成骨架（影片不保存），同義詞放 `syn`、例句（手語語序↔中文）放 `corpus/dict/ccu-meta.json`。
  引用：蔡素娟、戴浩一、劉世凱、陳怡君。2026。《台灣手語線上辭典（中文版第五版）》。嘉義：國立中正大學手語語言學台灣研究中心。
- 台灣手語語料庫（文化部委託中正大學，132 支影片、約 2 萬詞，有 Gloss 對照）：AI 詞序的訓練資料來源，需申請。
- 工研院＋公視 AI 手語氣象主播、新竹市 AI 手語翻譯（2026/11）：文字 → 手語詞序（Gloss，LLM）→ 骨架 → 人像，同樣架構。

## 檔案
- `index.html`、`js/app.js`：介面與流程
- `js/core.js`：資料格式、特徵、DTW 辨識、切段、斷詞
- `js/avatar.js`：播放（詞與詞平滑接起來）與 2D 簡筆人像
- `js/avatar3d.js`：3D 人像（three.js）：骨架點 → Mixamo／Biped 骨頭旋轉、臉部表情
- `avatars/`：3D 人像檔（微軟 Rocketbox，MIT）
- `js/vision.js`：MediaPipe（鏡頭、影片檔、擷取分頁）
- `js/store.js`：本機與共用語料
- `tools/ingest.py`、`.github/workflows/ingest.yml`：雲端抽骨架
- `sw.js`、`manifest.webmanifest`：PWA

## 下一步
1. 用 AI 把中文句子轉成台灣手語詞序（現在是逐詞）
2. 語料多了以後，把 DTW 換成 Transformer 分類模型
