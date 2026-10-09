/**
 * 行程（Trip）型別定義
 *
 * 「行程規劃工作流」核心概念：用戶一句話「什麼時候去什麼地方幹什麼」
 * 對應三要素槽位（date / city / activity），由規劃層從對話歷史純函數
 * 提取（utils/trip.ts），齊全後展開為跨 SKILL 行程 DAG。
 *
 * 分工：
 *   - TripMeta：規劃期槽位（Plan.trip 攜帶，隨 Plan 流轉，不落盤）
 *   - TripEntry：持久化形態（storage/trip.ts 行程簿，供「我的行程」
 *     頁面與到點提醒消費）
 */

import type { JumpPackage } from './skill';

/** 行程三要素（規劃期槽位） */
export interface TripMeta {
  /** 活動日（YYYY-MM-DD，已從口語解析） */
  date: string;
  /** 口語日期標籤（如「周六」「下週三」，時間線展示用） */
  dateLabel: string;
  /** 目標城市（如「上海」） */
  city: string;
  /** 活動描述（如「看周杰倫演唱會」；不解析演示目錄，僅作展示與檢索詞） */
  activity: string;
}

/** 行程時間線節點（Plan 任務的行程視圖投影） */
export interface TripTimelineItem {
  /** 關聯任務 ID（task_NNN） */
  taskId: string;
  /** 時間標籤（如「10-11 周六」，與 Task.timeLabel 同源） */
  timeLabel: string;
  /** 節點標題（任務中文摘要） */
  title: string;
  /** 任務狀態（TaskStatus 字串形態） */
  status: string;
  /**
   * 跳轉下單包（2026-10 跳轉模式）：寫任務成功且 result.data 攜帶 jump 時
   * 隨節點落盤，行程頁「去下單」重跳轉入口消費（真實交易在渠道側完成）
   */
  jump?: JumpPackage;
  /** 渠道跳轉訂單號（trn_ / flg_ 前綴；成交確認端點入參） */
  orderId?: string;
  /** 下單 SKILL ID（如 skill.train.12306；成交確認路由拼徑用） */
  skillId?: string;
  /** 下單 capability（如 book_ticket；成交確認路由拼徑用） */
  action?: string;
  /** 成交確認時間（epoch ms；用戶在渠道側支付完成後自證標記） */
  paidAt?: number;
}

/** 行程簿條目（本地持久化） */
export interface TripEntry {
  /** 全域唯一 ID：trip_{timestamp}_{rand} */
  id: string;
  /** 關聯 Plan ID */
  planId: string;
  /** 活動日（YYYY-MM-DD） */
  date: string;
  /** 口語日期標籤 */
  dateLabel: string;
  /** 目標城市 */
  city: string;
  /** 活動描述 */
  activity: string;
  /** 生成行程時的用戶原始意圖 */
  intent: string;
  /** 時間線（任務執行前後兩次同步：確認後建立、結束後更新狀態） */
  timeline: TripTimelineItem[];
  /** 行程狀態：planned=已計劃 / done=全部任務成功 / partial=部分成功 */
  status: 'planned' | 'done' | 'partial';
  /** 最近一次到點提醒時間（epoch ms；同日同行程僅提醒一次） */
  remindedAt?: number;
  /** 訂閱出發提醒授權時間（epoch ms；訂閱消息模板 ID 配置後有效） */
  subscribedAt?: number;
  createdAt: number;
}
