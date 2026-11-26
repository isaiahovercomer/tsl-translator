// scenes.js — 手語辨識「情境」：只在這個情境常用的詞裡找，候選少、比較準也比較快
// 詞要是語料庫裡有的詞（或同義詞）；沒有的會自動略過。自己錄的本機語料每個情境都會用到。
// 召會生活：另外自動加入分類是「召會生活用語」（cat: church）的所有語料。

// 每個情境都有的基本詞（人稱、是非、疑問、時間、數字…）
const CORE = `我 你 他 她 我們 你們 他們 大家 人 是 不是 好 不好 對 不對 要 不要 有 沒有 會 不會 可以 不可以
知道 不知道 懂 不懂 想 喜歡 不喜歡 什麼 誰 哪裡 為什麼 怎麼辦 幾 多少 現在 今天 明天 昨天 謝謝 請 對不起 沒關係
一起 再 來 去 一 二 三 四 五 六 七 八 九 十`;

export const SCENES = {
  greet: { name: '寒暄常用', short: '寒暄', words: `再見 不客氣 歡迎 認識 高興 歡喜 名字 叫 姓 好久沒有 見面 不好意思 恭喜 拜託
身體 健康 生病 累 忙 快樂 難過 平安 小心 放心 擔心 關心 吃飯 吃 喝 水 早餐 晚餐 好吃 家 住 走 回 坐 等 慢 快
朋友 家人 爸爸 媽媽 哥哥 姊姊 弟弟 妹妹 兒子 女兒 老師 學生 工作 學校 早上 中午 下午 晚上 時間 天氣
電話 手機 聯絡 手語 聽 看 說 寫 字 聾 聽障 聽人 幫忙 幫助 問 回答 請假` },
  meeting: { name: '聚會', short: '聚會', words: `開會 會議 集合 散會 開始 結束 休息 地方 樓 教室 教堂 禮堂 時間 早上 中午 下午 晚上
禮拜天 禮拜六 週日 星期天 下星期 上星期 下禮拜 每週 幾點? 一點鐘 報告 討論 商量 決定 同意 贊成 計畫 準備 安排 參加
主席 負責 小組 組 介紹 問題 沒有問題 注意 記得 忘記 結果 最後 首先 以後 完成 繼續 帶 拿 給 送 點名 排隊 坐 站 等
唱歌 歌 禱告 見面 第一次 一次 幾次 歡迎 邀請 再見 平安 吃飯 家 朋友 交通 分` },
  church: { name: '召會生活', short: '召會', words: `神 主 禱告 祈禱 唱歌 歌 歌曲 感謝 愛 慈愛 疼愛 救 信 相信 姊妹 永遠 天 讀 洗 傳 交通
祝福 話 經歷 經驗 跟隨 心 靈魂 奉獻 禮拜天 週日 星期天 教堂 牧師 基督教 歡喜 快樂 平安 恭喜 幸福 關心 安慰 好心
見面 歡迎 再見 家 朋友 吃飯 一起 開始 結束 每天 早上 晚上 清早 生活 聽 看 說 讀 寫 字 學習 教 明白 喜樂`, church: true },
  all: { name: '全部詞彙（較慢、較不準）', short: '全部', all: true },
};
export const SCENE_ORDER = ['greet', 'meeting', 'church', 'all'];

const split = s => s.split(/\s+/).filter(Boolean);
/** 情境 → 允許的詞集合（null＝全部）。samples：所有語料（含本機），用來加入本機語料與召會分類 */
export function sceneWords(key, samples = []) {
  const sc = SCENES[key] || SCENES.greet;
  if (sc.all) return null;
  const set = new Set([...split(CORE), ...split(sc.words)]);
  for (const s of samples) {
    if (!s.shared || (sc.church && s.cat === 'church')) { set.add(s.word); }
  }
  return set;
}
