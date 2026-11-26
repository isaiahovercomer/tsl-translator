# 交接報告：台灣手語對話翻譯器（2026-11-26 下午，v0.4.0）

## 這次完成（v0.4.0）
1. **AI 調整手語詞序**（設定 →「中文 → 手語詞序」：AI／規則／逐詞，預設 AI）
   - `js/gloss.js` 規則版（離線可用）：時間詞放前、否定／助動詞／疑問詞放句尾、話題提前（「你喜歡吃漢堡嗎」→ 漢堡／吃／你／喜歡）、「很」放形容詞後、數字放名詞後、虛詞不比。
   - `functions/api/gloss.js`：Cloudflare Pages Function＋Workers AI（`wrangler.toml` 的 `[ai] binding = "AI"`，已在線上運作，不用金鑰）。從 `corpus/dict/gloss-examples.json`（辭典 546 句）挑最像的 16 句當範例；模型 `@cf/meta/llama-3.3-70b-instruct-fp8-fast`（Qwen3-30B 已於 2026-11-20 下架）。AI 失敗／超過 3.5 秒／離線／GitHub Pages 備用站 → 用規則。
   - 評估 `node tools/eval_gloss.mjs [--ai 40]`：詞序一致（兩兩比較）逐詞 78.6% → 規則 82.5%；40 句保留測試 規則 85.8% → **AI 89.2%**，句尾詞正確 AI 47.5%。
   - 播放時畫面顯示「AI 手語語序：…」。
2. **批次匯入 YouTube 頻道**（`tools/yt_batch.py`＋Actions「批次匯入 YouTube 頻道」）：YT_COOKIES 已設好、可下載。列清單 → 6 份平行下載影片＋字幕 → 抽骨架（影片即刪）→ `corpus/raw/church/<id>.json`（含 `subs: [[開始, 結束, 文字]]`）。
   - yt-dlp 需要 `yt-dlp[default]`＋`remote_components: ejs:github`（解 YouTube JS 驗證），否則只抓得到縮圖。
   - 江啟禎影片**沒有 CC 字幕**（字幕燒在畫面上）→ 加了 OCR（rapidocr，每 0.5 秒、去掉一直在的標題）。
   - 頻道共 1249 支；「晨興聖言」系列每支約 4.5 分鐘、骨架約 2.8 MB。

## 待辦（依優先）
1. **字幕↔手勢對齊切詞**：用 `subs`（OCR）＋骨架的手勢段落（core.js `Segmenter` 同邏輯）做弱監督對齊：每句字幕的候選詞 → 跨影片統計同一詞的手勢段落 → 相似度分群 → 人工在網站確認後存成 `cat: church` 語料。先檢查 OCR 品質（看 `corpus/raw/church/*.json` 的 subs）。
2. 召會詞優先：弟兄、耶穌、聖經、召會、喜樂、唱詩、聚會、晨興、禱告、主…（辭典缺）。
3. 詞序：可再加 AI 用語料庫詞彙做同義替換（現在 AI 選對手語詞 50%，例如 家庭→家）；手語語料庫（文化部委託中正）申請到後當更多範例。
4. 手型修正工具、辭典低品質詞（q<0.2）用自己錄的補。

---
## 先前（v0.3.0）

## 網址與 repo
- 網站：https://tslinterpreter.pages.dev/（Cloudflare Pages，已接 GitHub，push 後約 30 秒自動更新）
- 備用：https://isaiahovercomer.github.io/tsl-translator/
- Repo：isaiahovercomer/tsl-translator（main），版本 0.4.0

## 這次完成
1. **3D 寫實人像**（`js/avatar3d.js`）：three.js 0.170（CDN importmap），82 點骨架 → Mixamo／Biped 骨頭（手臂、手掌三點定方向、手指、頭、13 個 ARKit 表情）。
   - 人像：微軟 Rocketbox（MIT）`avatars/tw-female.glb`（Female_Adult_03）、`tw-male.glb`（Male_Adult_09），各約 1.3 MB（只留 13 個表情、WebP 1024、meshopt）。
   - 設定可選：3D 女／男、Eva（Performs 卡通）、自訂 glb、2D 簡筆。播放器 `js/avatar.js` 的 `set3D(url)`；2D canvas 疊在上面只畫字幕。
2. **影片寬高比** `aspect`：新語料都記；舊語料用手骨長估計（`estimateAspect`）。
3. **語料分類**：`cat` = `general`（一般生活用語）／`church`（召會生活用語）。共用語料分資料夾 `corpus/signs/{cat}/`；新增頁選分類、切段可改；語料庫可篩選；對話時同詞優先用設定的分類（預設召會）。
4. **中正大學台灣手語線上辭典已匯入**（使用者表示已與中正溝通同意）：
   - `tools/ccu_dict.py` + Actions「匯入台灣手語線上辭典」（12 份平行，影片抽完即刪）。
   - 結果：3488 筆、2844 詞＋1139 同義詞（`syn`，例如 祈禱／禱告）、546 句例句（手語語序 gloss ↔ 中文，在 `corpus/dict/ccu-meta.json`），可拿來教 AI 詞序。
   - 品質欄位 `q`（手部偵測比例）：≥0.4 的佔 92%，<0.2 有 76 個。
   - 辭典 API：`/api/pinSearch?field=stroke&value=N&page=&pageSize<=100`、`/api/querySearch?id=`、`/api/group?id=`、`/api/sentence?id=`。
5. **抽骨架改良**（`tools/ingest.py`）：人像小時以肩膀為中心裁切放大再找手、手短暫遺失 ≤8 格內插補上。
6. **共用語料改成用到才下載**：先載 `corpus/index.json`，播放時才抓骨架；辨識特徵預先算好放 `corpus/feats.json`（`tools/build_feats.mjs`，Int8，6.4 MB，開鏡頭才載）。
7. 網站內「📖 查辭典」連結（沒收錄的字、語料庫詞條、錄製頁）。
8. Service worker：3D 人像與骨架快取優先（只下載一次）。

## 待辦（依優先）
1. **召會生活用語**：辭典缺 弟兄、耶穌、聖經、教會、喜樂、唱詩、聚會…（「弟兄」目前被拆成弟／兄）。來源：江啟禎頻道 https://www.youtube.com/@江啟禎（「2026秋長老訓練手語晨興聖言」系列等，有字幕）。
   - 雲端直接 yt-dlp 會被 YouTube 擋（已實測：清單抓得到、影片要求登入）。
   - 方案 A（推薦）：請江啟禎弟兄提供原始影片（Google Drive 資料夾）＋字幕檔。
   - 方案 B：設定 repo secret `YT_COOKIES`（Get cookies.txt LOCALLY 匯出，建議備用帳號）。
   - Box（Simular）點數已用完，要加值才能用。
   - 匯入時 `--cat church`（雲端 issue 帶 `category: church`）；字幕整句 ↔ 手勢段落要做弱監督對齊（候選詞→跨影片統計→人工確認）。
2. **AI 調整手語詞序**：用 546 句辭典例句（gloss）＋江啟禎字幕影片當範例，參考工研院做法（文字→Gloss→骨架）。
3. 手型修正工具（手指朝鏡頭時 MediaPipe 看不準）、辭典低品質詞（q<0.2）用自己錄的補。
4. 授權信草稿（給中正大學）已在對話中，使用者表示已溝通過，可不寄。

## 測試方法（給下一個工作階段）
- 本機不能常駐 http.server 時：用 Playwright `context.route` 直接從磁碟回應檔案（見本次做法）。
- 詞序 API：`curl 'https://tslinterpreter.pages.dev/api/gloss?text=你喜歡吃漢堡嗎'`；`?loo` 評估用（不拿同句當範例、不用快取）。
- 批次匯入：`gh api -X POST repos/isaiahovercomer/tsl-translator/actions/workflows/yt-batch.yml/dispatches -f ref=main -f 'inputs[max]=12'`
- 本機：`python3 -m http.server 8765`（在 /home/claude 下）＋ Playwright（/usr/bin/google-chrome，`--use-angle=swiftshader`）開 `/tsl-translator/index.html`，`window.__tsl`（player、preview、playText、loadCorpus、store）。
- 辭典重新匯入：Actions → 匯入台灣手語線上辭典 → Run workflow（或 `gh api -X POST repos/isaiahovercomer/tsl-translator/actions/workflows/ccu-dict.yml/dispatches -f ref=main -f 'inputs[shards]=12'`）。
