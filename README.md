# 台灣手語對話翻譯器（PWA）

聽人和聾人面對面坐著，一個畫面雙向翻譯，以**台灣手語（自然手語）**為主：

- **聽人說話 → 手語人像**：瀏覽器語音辨識（zh-TW）→ 用語料庫的詞做最長比對 → 把每個詞的骨架動作接起來，由人像即時比出來。
- **聾人比手語 → 台灣中文語音**：鏡頭 → MediaPipe Holistic 抓骨架 → 手舉起／放下自動切詞 → DTW 比對語料庫 → 停下來後用 zh-TW 語音唸出整句。

## 語料：只存骨架，不存影片
每個詞存成 15 fps、82 個點（身體 15＋左右手各 21＋臉 25）的 Int16 資料，約 20–30 KB。

| 來源 | 在哪裡處理 |
|---|---|
| 鏡頭錄製 | 裝置上 |
| 上傳影片檔 | 裝置上（影片讀完就丟） |
| YouTube：邊播邊擷取 | 電腦版 Chrome／Edge，擷取分頁畫面即時抽骨架 |
| YouTube：送雲端 | GitHub Actions（`tools/ingest.py`），需 repo secret `YT_COOKIES`，否則會被 YouTube 擋 |

本機語料存在 IndexedDB；「上傳到共用語料庫」會下載語料檔並開 GitHub issue（標題 `[語料]`），把檔案拖進去送出，Actions 自動寫進 `corpus/`。

## 檔案
- `index.html`、`js/app.js`：介面與流程
- `js/core.js`：資料格式、特徵、DTW 辨識、切段、斷詞
- `js/avatar.js`：2D 人像繪製與播放
- `js/vision.js`：MediaPipe（鏡頭、影片檔、擷取分頁）
- `js/store.js`：本機與共用語料
- `tools/ingest.py`、`.github/workflows/ingest.yml`：雲端抽骨架
- `sw.js`、`manifest.webmanifest`：PWA

## 下一步
1. 3D 人像：骨架 → 3D 角色（參考 upf-gti/Performs、Animics，MIT）
2. 用 AI 把中文句子轉成台灣手語詞序（現在是逐詞）
3. 語料多了以後，把 DTW 換成 Transformer 分類模型
