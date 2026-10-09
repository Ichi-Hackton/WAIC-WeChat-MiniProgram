/**
 * 入參鍵 → 中文標籤（純數據）
 *
 * 規範來源：.qoder/rules/Agent.md § 12.3（utils 純函數約束）
 *
 * 消費方：skills/adapter（INVALID_INPUT 錯誤文案脱敏——欄位名 / path
 * 屬代碼級數據，禁止透出給 EndUser）。與 interaction/checkpoint 的
 * INPUT_LABELS 刻意不合併：後者是確認彈窗的白名單展示語義（未映射鍵
 * 一律略過），本表是錯誤翻譯語義（未映射鍵由調用方回退通用文案），
 * 兩處鍵集允許不同。utils 為最底層，各層皆可引用（依賴方向 § 12.3）
 */

/** 下單 / 查詢常用入參鍵 → 用戶可讀中文標籤 */
const FIELD_LABELS: Record<string, string> = {
  // 實名信息（出行域下單任務的必填欄位，缺失高頻）
  passengerName: '乘車人姓名',
  passengerIdNo: '乘車人證件號',
  // 出行查詢 / 下單
  from: '出發地',
  to: '到達地',
  date: '出行日期',
  trainNo: '車次',
  flightNo: '航班號',
  cabin: '艙位',
  seatType: '座位類型',
  // 通用查詢
  city: '城市',
  keyword: '關鍵詞',
};

/**
 * 取入參鍵的中文標籤
 *
 * @param key 入參鍵名（支援點號路徑，取首段比對——validator 錯誤的
 *   path 對巢狀結構形如 "a.b"，首段即頂層欄位名）
 * @returns 中文標籤；未映射返回 undefined（調用方回退通用文案）
 */
export function fieldLabel(key: string): string | undefined {
  return FIELD_LABELS[key.split('.')[0]];
}

/**
 * 分 → 展示金額字串（如 123456 → "¥1234.56"）
 *
 * 原位於 services/payment（微信支付封裝）；2026-10 技能收斂後支付
 * 域下架，該封裝成為死代碼，唯一仍被消費的此純函數遷至 utils。
 */
export function formatCents(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}
