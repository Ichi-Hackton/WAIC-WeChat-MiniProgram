/**
 * 漏斗埋點事件定義 — 純函數（不得 import wx.*，規範 § 12.1）
 *
 * 2026-10 產品評審 #5 驗證基礎設施：內測期兩個生死數字——
 * 「查票 → 下單完成率」（漏斗：查詢結果 → 購票卡 → 跳轉點擊）與
 * 「7 日複訪率」（日活去重序列）。
 *
 * 數據最小化（規範 § 10）：事件僅含 name + ts + date，不攜帶任何
 * 用戶輸入 / 查詢參數 / 意圖內容。
 *
 * 雙端同步：此處事件名與雲端 cloudrun/src/metrics.ts KNOWN_EVENTS
 * 白名單一一對應（雙包獨立部署無法共享代碼），增刪事件**必須兩端同步**。
 */

/** 漏斗事件名（雲端白名單逐字對齊） */
export const METRIC_NAMES = {
  /** 車次卡渲染（火車漏斗第 1 級） */
  trainResultsView: 'train_results_view',
  /** 購票卡生成（火車漏斗第 2 級） */
  trainBookCard: 'train_book_card',
  /** 航班卡渲染（機票漏斗第 1 級） */
  flightResultsView: 'flight_results_view',
  /** 購票卡生成（機票漏斗第 2 級） */
  flightBookCard: 'flight_book_card',
  /** 跳轉官方渠道點擊（漏斗終點代理：真實成交在渠道側不可見） */
  jumpClicked: 'jump_clicked',
  /** 用戶自證渠道側已支付成交（行程頁「標記已支付」；漏斗最深可觀測點） */
  orderConfirmed: 'order_confirmed',
  /** 日活（onShow 日去重；複訪率分子） */
  dailyActive: 'daily_active',
} as const;

export type MetricName = (typeof METRIC_NAMES)[keyof typeof METRIC_NAMES];

/** 埋點事件（本地緩衝 / 雲端上報共用形態） */
export interface MetricEvent {
  name: MetricName;
  ts: number;
  /** YYYY-MM-DD（複訪率統計鍵） */
  date: string;
}
