# 交接報告：主恢復台灣手語對話翻譯（2026-11-26 晚上，v0.12.0）

## v0.12.1：「聊天」改「交通」

## v0.12.0：改名、圖示、預覽縮圖、上半身特寫、「手譯員」
- 網站名稱改成「主恢復台灣手語對話翻譯」（title、標題列、manifest name；主畫面短名「主恢復手語翻譯」）。
- 新圖示：深藍底＋金色對話框＋🤟（我愛你）手＋聲音弧線（`icons/icon.svg`、`icon-192/512.png`、`apple-touch-icon.png` 180px；manifest 分 any／maskable）。
- 分享預覽縮圖 `icons/og.jpg`（1200×630：圖示、名稱、兩行說明、網址、手譯員張開雙手歡迎的姿勢；綠幕去背）＋ og／twitter meta。產生方式：Playwright 截 f2f 舞台（暫停在手勢中間），PIL 綠幕去背，HTML 排版截圖。
- 「主播」全部改成「手譯員」（「手語主播」→「手譯員」）。
- **上半身特寫＋自動取景**（avatar3d.js `frameCamera()`，每格執行）：平常只拍頭頂到腰（寬度＝肩寬 1.9 倍），手伸開（舉起的手，腰以上）時鏡頭退遠、手比到腰附近往下多留；退遠快（0.3）拉近慢（0.03）。頭頂固定在畫面上方。
- 面對面模式字幕改回主播下面獨立一條（不再疊在畫面上，避免蓋住比到腰的手）；很直的畫面「目前的詞」標籤畫在右上角（avatar.js `drawCaption`）。

## v0.11.0：鏡頭權限、使用說明、安裝到主畫面
- 起因：使用者手機打開後鏡頭開不起來。可能原因：在 LINE 內建瀏覽器裡（不能用鏡頭／麥克風）、權限曾被拒絕、或手勢模型下載太慢（以前要等模型載完畫面才出來，看起來像鏡頭沒開）。
- `js/guide.js`（新）：
  - `escapeInApp()`：UA 有 `Line/` 就自動加 `?openExternalBrowser=1` 重新導向（LINE 會改用手機預設瀏覽器開），只試一次。FB／IG 等內建瀏覽器顯示「用預設瀏覽器開啟」說明。
  - `permState()`（permissions API）、`requestPerms()`（一次要鏡頭＋麥克風，失敗再分開試看是哪個）、`permHelpHtml()`（依 iPhone Safari／iPhone 主畫面 App／Android Chrome／Android 主畫面 App 給打開權限的步驟）、`mediaErr()`（NotAllowed／NotFound／NotReadable／模型載入失敗 → 中文）。
  - 安裝：`beforeinstallprompt`（Android Chrome 直接跳安裝）；iPhone 顯示「分享 → 加入主畫面」說明。
  - 使用說明全螢幕導覽 5 頁（歡迎／手機這樣擺／怎麼用／允許鏡頭和麥克風／安裝到主畫面），可左右滑、略過；第一次打開自動跳出（`localStorage tsl-guided`；`?noguide` 可跳過，測試用 add_init_script 設好）。
- 首頁：「▶ 開始對話」下面加「📲 安裝到主畫面」（已安裝就隱藏）、「📖 使用說明」；權限被拒或在內建瀏覽器時顯示紅色警告＋怎麼打開＋「我改好了，重新整理」；按開始時若權限已被拒絕，直接跳到權限頁。
- `vision.js`：鏡頭畫面先出來再載模型；`preloadLandmarker()` 在允許權限、按開始時先下載模型。模型載入失敗時畫面保留、顯示原因。
- 測試：`tools/test_guide.py` 情境（允許／拒絕／LINE UA）都通過；`tools/test_f2f.py` 通過。

## v0.10.1
- 介面、說明文字的「聾人」全部改成「聽損者」（語料庫裡的手語詞「聾人」是辭典詞條，不改）。
- 女手譯員 vrm-f1 短裙改成及踝長裙：`tools/long_skirt.py avatars/vrm-f1.vrm 0.15`（Bottoms 材質頂點：上 1/4 腰部不動，以下等比例拉到 0.15m、下襬外擴 22%；骨架權重沒改，比手語時裙子跟著動、腳不會穿出來）。模型網址加 `?v=2`，讓已快取舊模型的手機重新下載。原始模型 CC0。

## v0.10.0：介面改版（往「手機立著對聽損者、一鍵開始」的目標）
- **首頁**（對話頁最上方 `.hero`）：插圖＋三步驟（手機立起來／聽人說話手譯員比／聽損者比手機唸）＋大按鈕「▶ 開始對話」（`#btnStart`：同一次點擊裡 enterF2F＋開麥克風＋前鏡頭，瀏覽器才給權限和全螢幕）；「只打開畫面，等一下再開始」＝ `#btnF2F`（現在是連結）。原本兩個面板移到下面「分開操作・測試」。
- **面對面模式版面**：舞台佔滿整個畫面、手譯員頭靠上方（avatar3d 很直的畫面寬度需求 0.88）；字幕（聽人說的話＋🤟 手語那句）疊在下方手譯員腳的位置（漸層底），鏡頭小窗移到右下（不擋手）。按鈕列高度用 `--barh` 量。
- **狀態燈**（左上）：🎤 麥克風關／聆聽中／聽到聲音（綠色閃）／⏳ 辨識中；📷 鏡頭關／請比手語／看到人／看到手（綠）／請入鏡（沒拍到人超過 4 秒，紅）。雲端 Whisper 用 CloudSTT 的 onState，瀏覽器內建用 interim 結果。
- **Aa**：字幕大小 1／1.25／1.5 倍循環（`S.f2fSize`，CSS `--fs`）。
- 修好對話頁橫向捲動（`.talk>*{min-width:0}`，原本寬 415px）。
- **語料庫**：一次只畫 150 個詞，「顯示更多」每次加 300（原本 3488 個全畫，頁面 9 萬多 px）；預覽框移到清單上面（點詞會捲過去）。
- **設定**：常用（手譯員、比手語速度、中文語音、語速）＋「進階設定」摺疊（語音辨識、詞序、分類優先、手語辨識嚴格度、同義說法）；使用說明改寫成目前的流程。
- 截圖檢查腳本：`tools/shots_all.py`（各頁手機尺寸截圖），面對面回歸測試 `tools/test_f2f.py` 通過。

## v0.9.0（之前）
## v0.9.0：雲端 Whisper 語音辨識（聽人說話 → 文字）
- 起因：瀏覽器內建辨識（Web Speech API）收音困難、連續聽會斷、LINE 內建瀏覽器不支援。
- `functions/api/stt.js`：POST 16kHz 單聲道 WAV → Workers AI `@cf/openai/whisper-large-v3-turbo`（language zh、vad_filter、召會用語 initial_prompt＋前一句 `x-prompt`、condition_on_previous_text false）。輸出處理：簡轉繁（`_s2t.json`：opencc-js 產生的 2600 字單字表＋常見轉錯詞；「台」不轉「臺」）、全形標點、召會用語同音字更正（招會→召會、小牌→小排…，`FIX`）、過濾 Whisper 幻覺句（訂閱、字幕、Amara…）。`?beam=1` 可試較快解碼（實測沒差，延遲主要是 Cloudflare 排隊，1～4.5 秒）。
- `js/stt.js`（`CloudSTT`）：getUserMedia（回音消除、降噪、自動增益）→ ScriptProcessor（iPhone 也能用）→ 背景音量自動學習的簡單 VAD：連續 2 格（約 0.17 秒）大聲開始、停頓 0.7 秒或滿 12 秒切句、少於 0.35 秒的聲音丟掉 → 16kHz WAV 上傳；同時可多句送出，照說話順序交回。TTS 唸的時候 `pause()`。
- `js/app.js`：設定「語音辨識」選單（`S.sttEngine`：cloud 預設／browser）；GitHub Pages 備用站或 API 回 404/405/503 時自動改用瀏覽器內建。上一句辨識結果留在畫面，狀態（🎙️ 聽到聲音…／⏳ 辨識中…）用小字接在後面。
- 測試：`python3 tools/test_stt.py`（Piper 合成兩句中文、中間停 1.5 秒當假麥克風 `/tmp/t/mic.wav`；網站檔案用本機、/api 走線上）：4 句都正確切開、照順序、沒漏。合成語音腔調生硬，「機車」會聽成「記憶車」，真人聲音要實測。
- 費用：每分鐘音訊約 0.0005 美元；Workers AI 每天免費 10,000 neurons（turbo 每分鐘 46.63 → 約 200 分鐘，和詞序／通順中文共用）。
- 待做：真手機實測（尤其 iPhone Safari：AudioContext 要在按鈕點擊後才啟動，已在按鈕裡呼叫）；若延遲太長可考慮更短的停頓（0.6 秒）或串流式模型。

## v0.8.1（之前）
## v0.8.1：詞序 AI 改用語料庫的詞
- `/api/gloss` 給 AI「可用手語詞」清單（`candidates()`：句子裡出現的語料庫詞優先，其次共用字比例 ≥0.6 的詞，最多 120 個），請 AI 把不在語料庫的中文詞換成清單裡意思相同的詞或拆開（住校→住/學校、洞穴→山洞）。輸出再做異體字對應（`fixWord`：宣布→宣佈）；前端 `mapGloss` 也加了異體字。`?v=1` 可用舊做法比較。
- 評估多了「實際比的詞」（AI 輸出 → mapGloss → 會比的詞，對照辭典手語）：`node tools/eval_gloss.mjs --ai 61`（`GLOSS_Q='&v=1'` 跑舊做法，`SHOW=1` 看每句）。
  - 61 句保留測試：召回 57.4% → **60.4%**、精確 63.3% → 63.2%、比不出來 11.1% → **5.1%**；詞序一致 89.7% → 86.7%（可能是波動，之後可再看）。
  - 還會錯的：把一個詞拆成單字（最高→最/高、三百→三/百）、偶爾加句子沒有的詞。下一步可考慮：數字詞（三百、萬）在語料庫補齊或規則合併；辭典例句 gloss 本身有很多「這／那」指示詞，召回上限不會到 100%。

## v0.8.0（之前）
## v0.8.0：面對面模式＋AI 轉通順中文
- **面對面模式**（對話頁最上方「🧑‍🤝‍🧑 面對面模式」，網址 `#f2f`；按返回鍵或 ✕ 離開）：全螢幕（`#f2f` 疊在最上層），把原本的手譯員 `.stage` 和鏡頭 `.stage` 搬進來（離開時放回原位，three.js canvas 不重建）。
  - 直式：上方字幕＝聽人說的話（辨識中灰字）、中間手譯員（頭靠上，avatar3d.js `resize` 在很直的畫面把多出的空間放腳下、寬度需求 1.1→0.95）、右上小視窗＝前鏡頭（外框綠＝有拍到人、紅＝沒入鏡）、下方字幕＝最近兩句手語（AI 通順中文＋灰色小字手語詞序）＋正在比的（紅字）、底部 ▶開始／⏸／⏭／✕。
  - 橫式：手譯員在左、字幕與按鈕在右欄，鏡頭小窗在左上。
  - 「▶ 開始」＝同時開麥克風＋前鏡頭（鏡頭降到 640×480：`Camera.start(facing, size)`）；Wake Lock（回到前景自動重拿）；requestFullscreen＋鎖直向（iPhone Safari 不支援元素全螢幕，會略過）。
  - TTS 唸的時候暫停語音辨識（沿用 pausedForTTS）。
  - **還沒在真手機上測**：Android Chrome／iOS Safari 同時開鏡頭＋語音辨識會不會衝突、MediaPipe＋VRM 同時跑的效能（不夠就把辨識降到 10 fps）。已用 headless Chrome（假鏡頭）測版面、進出、逐字稿：`tools/test_f2f.py`。
- **AI 轉通順中文**：`functions/api/fluent.js`（/api/gloss 反方向，辭典 546 句 gloss→中文挑 12 句當範例，同模型）；前端 `aiFluent()`（gloss.js，4 秒逾時）。每句停下來後把手語詞序轉成通順中文，顯示在逐字稿（原詞序灰色小字）。唸法下拉多一個「整句・AI 通順：停下來後 AI 改成通順中文再唸」。「中文→手語詞序」設定不是 AI 時不轉；GitHub Pages 備用站沒有 API，自動略過。
  - 測：`curl 'https://tslinterpreter.pages.dev/api/fluent?gloss=我/游泳/會'`
- **批次匯入（2026-11-26 16:03 跑）12 支全失敗**：YT_COOKIES 仍失效（Sign in to confirm you’re not a bot／Video unavailable，後者之前下載成功過，也是被擋）。使用者重新匯出 cookies 後再跑。

## v0.7.5（之前）
## v0.7.5：手語 → 語音改成連續
- 下拉選單 `speakMode`：連續（比一個詞就唸一個詞，預設）／整句（停下來 2.2 秒唸整句，原本的）／手動。`say()` 排隊唸、不打斷；全部唸完才恢復語音辨識。
- 逐字稿 `#signLog`：每句一行，正在比的這句即時顯示（紅字），停下來就換行；最多 200 行；「清除」一起清。
- ✅ v0.8.0 已加：AI 把手語詞序轉成通順中文。
- `window.__tsl.onSign / attachFeats` 給測試用。

## v0.7.4：使用者選定手譯員 **女＝vrm-f1（黑長髮 Shino）、男＝vrm-m3（黑短髮 HairSample_Male，帽T調深藍灰）**，都用 A3 扁平色塊
- 選單只剩：插畫風手譯員 女／男、簡筆、自訂。其他手譯員選項刪掉（舊設定自動換成同性別：S.v9）。avatars/ 裡其他 vrm、glb 檔還在（沒刪），之後可清掉。
- 下一步：面對面模式（見「使用者目標」）。

## v0.7.3：使用者選定畫風 **A3 扁平色塊**
- 6 位 VRoid 手譯員全部套 `look=flat`（app.js AVATAR_URLS），預設 vrm-f1。選單只留 6 位插畫風手譯員＋簡筆＋自訂；其他舊選項（3D 寫實、商務手譯員、2D 卡通、Colab 寫實影片、其他畫法）程式還在但不在選單，舊設定自動換成同性別插畫風手譯員（S.v8）。
- 待使用者選：女生、男生各要哪一位當主要手譯員（比較圖 gallery_a3）。之後：面對面模式（見下方「使用者目標」）。

## v0.7.2（使用者問「不能有其他畫風嗎」→ 做 A 換畫法＋B 成熟大人）
- A：VRM 換畫法 `#look=comic|soft|flat`（avatar3d.js `applyLook`，改 MToon 參數）；差異不大。
- B：成熟插畫風手譯員 biz-f1/f2/m1/m2（Rocketbox 商務人士 MIT，見 avatars/README.md 的做法與 tools/ 三支工具）；每個約 0.4 MB、18 個 ARKit 表情、手指齊全。biz-f2 米色西裝接近膚色（整張貼圖含手，不能只調衣服）。
- 比較圖：gallery_a（A 三種畫法）、gallery_b（B 四位）。等使用者選。

## v0.7.1（使用者選 A 動漫風方向，要求手勢與表情最清楚）
- 6 位 VRoid 手譯員（女：黑長髮 Shino、短髮 AvatarSample_A 毛衣調深藍、深色短髮 Shibu；男：深色外套 AvatarSample_C、背心領帶 Fumiriya 頭髮調深棕、黑短髮 HairSample_Male 帽T調深藍灰），網址 `#tint=材質:色` 調色。
- 清楚化（avatar3d.js `clarify`）：瀏海修剪（臉前、眉毛以下、兩眼外角之間的頭髮用 4 個裁切平面去掉，跟著頭動）、眉毛與眼線不做深度測試畫在頭髮前、但用 stencil 避開手和身體；身體描邊加粗；表情加強；手譯員背景改冷色漸層（原本米色接近膚色）。
- 使用者還沒選定要哪幾位；VRoid Studio 是桌面軟體，這裡不能跑，只能改現成模型的顏色與畫法，臉型、髮型、服裝要使用者自己捏。
- 版本號顯示在每頁最下面（使用者規則）。

## ★ 使用者目標（2026-11-26 確認）與下一步
**目標**：每個人用手機打開網頁就能用。手機立著、螢幕和前鏡頭都對著聽損者：
- 手機一面收聽聽人說話 → 螢幕上的手譯員即時比出手語（加中文字幕）。
- 前鏡頭同時拍聽損者打手語 → 辨識 → 手機用台灣口音唸給聽人聽。
→ 一定要**即時、在手機上跑**：不能靠事先算好的影片（講到沒算過的詞就沒有）。Colab 寫實影片（v0.6.0）降為「固定內容的高畫質版」備用。

**下一步（新工作階段做）**
1. ✅（v0.8.0 已完成第一版，待真手機實測）**面對面模式**（一個畫面）：手譯員全螢幕（直式）、右上角小視窗＝前鏡頭畫面（看自己有沒有入鏡）、上方字幕＝聽人說的話、下方字幕＝辨識出的手語中文；一個按鈕同時開麥克風＋前鏡頭；全螢幕、螢幕不休眠（Wake Lock）。手機語音辨識和 TTS 互相干擾：TTS 唸的時候暫停辨識（已有 pausedForTTS）。要實測：Android Chrome、iOS Safari 同時開鏡頭＋語音辨識是否衝突；MediaPipe＋人像同時跑的效能（必要時辨識降到 10～15 fps、人像畫面降解析度）。
2. ✅ **（v0.7.0 已完成第一版）手譯員外觀改 VRM 插畫風 3D**：預設 `vrm-f1`。四位 VRoid 官方範例（見 `avatars/VRM-CREDITS.md`：Shino、AvatarSample_A/C 、Fumiriya），`tools/vrm_slim.py` 把 12–19 MB 縮到 5–6 MB。avatar3d.js：VRM humanoid → Mixamo 名稱（VRM_MAP）、VRoid 臉部形狀名稱要從 primitives[].extras.targetNames 自己補（three.js 沒讀）、表情改用 avatar2d.js 的 faceExpr 校正值（Fcl_BRW_Surprised／Angry、EYE_Close_L/R、EYE_Surprised、MTH_A／Fun／Sorrow）、頭髮衣服 springBone 擺動；語料預覽格用 2D 省記憶體。importmap 加 @pixiv/three-vrm 3.6.0。已在 headless Chrome 測過女・長髮、男・短髮比「我想知道」「謝謝你」。待改：衣服是學生制服風，之後使用者可用 VRoid Studio 自己捏手譯員換掉；手機實測效能。
   （原規劃）**手譯員外觀改 VRM 插畫風 3D**（three-vrm、卡通著色 MToon，看起來像新竹那種韓漫插畫風；手指、臉部表情 blendshape 齊全，手機可即時跑）。avatar3d.js 目前對應 Mixamo／Biped 骨頭，要加 VRM humanoid 骨頭對應＋VRM 表情（happy、angry、surprised、blink、aa/ih/ou…，配合 avatar2d.js 已校正的臉部參數）。手譯員來源待使用者決定：VRoid Studio 自己捏（Windows 免費）匯出 .vrm，或先找授權允許使用的免費 VRM。
3. 寫實影片 Colab（下方 v0.6.0）保留，不是優先。

## v0.6.0：寫實 2D 手譯員（新竹 AI 手語風格）— 進行中
- 使用者給的截圖：半寫實插畫風（韓漫／webtoon 感）女手譯員、深藍西裝外套＋白上衣、城市背景；手有 AI 生成的模糊殘影 → 確定是「骨架帶動的 AI 影片生成」。
- 使用者決定**用自己的 Google Colab 額度**跑。
- `colab/tsl_realistic.ipynb`（由 `tools/realistic/make_notebook.py` 產生，改內容改這支再執行）：
  ① 設定（手譯員 f1/f2/m1/m2、詞數、解析度 384×640 或 576×1024、步數、指定詞）② 安裝（MimicMotion 1.1＋DWPose＋SVD xt 1.1 只下載 vae／image_encoder fp16 等；需 Colab 密鑰 `HF_TOKEN` 並在 HF 同意 SVD 授權；sed 修掉 loader 的 `safe_globals(*allowed_modules)`，新版 torch 會出錯；diffusers 0.27.2／transformers 4.41.2／huggingface_hub 0.25.2）③ SDXL 產生 4 張手譯員候選圖（或上傳）④ 選定、DWPose 偵測手譯員骨架 ⑤ 挑詞（指定詞＋基本詞＋辭典例句常用詞，召會用語優先）⑥ 產生（每詞一段，存雲端硬碟 `tsl-realistic/<手譯員>/`，manifest.json 可續跑）⑦ 預覽 ⑧ 用 `GITHUB_TOKEN` 推到 repo `realistic/<手譯員>/`。
  - **尚未在 GPU 上實際跑過**，第一次很可能要除錯；請使用者截圖錯誤。
- `tools/realistic/tsl_pose.py`：82 點骨架 → DWPose dict（OpenPose 18 身體、手 21×2、臉 25→iBUG 68 子集），整段一次縮放平移對齊手譯員圖（`fit_to_ref`），開頭從手譯員姿勢過渡 4 格（`blend_from_ref`）；已用 MimicMotion 的 `draw_pose` 在本機驗證。
- 網站 `js/realplayer.js`：設定選「寫實手譯員」→ 讀 `realistic/<手譯員>/manifest.json`，每個詞播一段影片（兩個 video 淡入淡出、預載下一段），沒有影片的詞用同性別插畫人像頂替；跟播放佇列（暫停／下一句／重播）整合；畫面改直式 3:4。sw.js 不快取 mp4（分段讀取）。已用假影片在 headless Chrome 測過。
- 下一步：使用者跑通 Colab → 看品質（手、臉）→ 調 STEPS／解析度／手譯員圖 → 擴大詞數、做其他手譯員；寫實影片多了再把預設人像改成寫實手譯員。

## v0.5.0
1. **2D 插畫人像**（`js/avatar2d.js`，預設）：女・長髮、女・短髮、男・短髮、男・眼鏡（設定 → 手語人像；3D 仍可選）。舊設定 3D 女／男自動換成 2D 女・長髮／男・短髮（`S.v5`）。
   - 表情由臉部點驅動：眉毛上揚／下壓（是非問句）、皺眉＋皺眉紋（疑問詞問句）、眼睛睜大／瞇眼／閉眼（笑時彎月眼）、嘴巴張合（牙齒、舌頭）、嘴角上揚／下垂、頭部傾斜與轉向；待機自動眨眼。
   - 校正：語料庫 21080 格臉部資料的中位數當平常臉（眉眼距 0.253、皺眉 0.47、張嘴 0.05、嘴角 0.022 個臉高）。
   - 頭大小、位置跟真實骨架一致（手碰臉的手勢對得上），但限制離肩膀的距離，避免脖子被拉長。
   - 使用者說要「比照新竹 AI 手語」風格：搜尋找不到該人像圖片，做的是原創扁平插畫風；使用者可傳截圖再調。
2. **播放佇列**（對話頁人像下方）：連續（照順序）／即時（落後跳最新一句）／一句一句（按「下一句」、點人像、空白鍵或 →）；⏸ 暫停（P）、🔁 重播（R）、🧹 清除；顯示「還有 N 句」。打字測試＝插隊馬上比。
   - `AvatarPlayer`：`busy`、`paused`、`pause()`、`resume()`、`stop()`、`opt.onIdle`。
3. 語音辨識不需要下載模型（用瀏覽器內建 Web Speech）；使用者看到的 700 多 MB 提示應是瀏覽器或 Windows 的語言包，待使用者給截圖確認。


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
0. **YT_COOKIES 被 YouTube 作廢**（第一次 3 支成功，第二次 12 支中 10 支「Sign in to confirm you’re not a bot」、2 支影片不存在）。請使用者用無痕視窗重新匯出 cookies（登入 → 開 youtube.com/robots.txt → 匯出 → 立刻關閉無痕視窗），覆蓋 secret 後再跑（已改成預設 2 份平行＋每支間隔 8–20 秒）。已匯入的 3 支沒有字幕，下次會自動重做（redo_nosubs）。
1. **字幕↔手勢對齊切詞**：用 `subs`（OCR）＋骨架的手勢段落（core.js `Segmenter` 同邏輯）做弱監督對齊：每句字幕的候選詞 → 跨影片統計同一詞的手勢段落 → 相似度分群 → 人工在網站確認後存成 `cat: church` 語料。先檢查 OCR 品質（看 `corpus/raw/church/*.json` 的 subs）。
2. 召會詞優先：弟兄、耶穌、聖經、召會、喜樂、唱詩、聚會、晨興、禱告、主…（辭典缺）。
3. 詞序：可再加 AI 用語料庫詞彙做同義替換（現在 AI 選對手語詞 50%，例如 家庭→家）；手語語料庫（文化部委託中正）申請到後當更多範例。
4. 手型修正工具、辭典低品質詞（q<0.2）用自己錄的補。

---
## 先前（v0.3.0）

## 網址與 repo
- 網站：https://tslinterpreter.pages.dev/（Cloudflare Pages，已接 GitHub，push 後約 30 秒自動更新）
- 備用：https://isaiahovercomer.github.io/tsl-translator/
- Repo：isaiahovercomer/tsl-translator（main），版本 0.12.1

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
