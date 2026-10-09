/**
 * 埋點上報端點（metrics 域，2026-10 產品評審 #5 驗證基礎設施）
 *
 * 內測驗證兩個生死數字——「查票 → 下單完成率」與「7 日複訪率」——
 * 的數據通道。小程序端漏斗事件批量上報，按 owner（openid）落庫
 * （domain='metrics'），每批一條記錄。
 *
 * 數據最小化（規範 § 10 隱私紅線）：僅收事件名 + 時間戳 + 日期字串，
 * 不收意圖內容 / 查詢參數 / 任何用戶輸入。事件名走白名單（KNOWN_EVENTS），
 * 未知事件靜默丟棄——上報端點不可被當作任意數據傾倒場。
 *
 * 查詢側：MySQL 部署後以 SQL 聚合（SELECT payload->>'$.events' ...）
 * 或運維腳本離線統計；無身份（openid 缺失）時靜默丟棄不報錯——
 * 埋點失敗永不阻斷業務（客戶端 fire-and-forget，見 services/metrics.ts）。
 */

import type { RouteHandler } from './api';
import { ok } from './api';
import { createOrder } from './db';

/** 事件名白名單（與小程序端 utils/metrics.ts METRIC_NAMES 對齊，雙端同步維護） */
const KNOWN_EVENTS = new Set([
  'train_results_view', // 車次卡渲染（漏斗第 1 級）
  'train_book_card', // 購票卡生成（漏斗第 2 級）
  'flight_results_view',
  'flight_book_card',
  'jump_clicked', // 跳轉官方渠道點擊（漏斗終點代理）
  'order_confirmed', // 用戶自證渠道側已成交（跳轉模式下漏斗最深可觀測點）
  'daily_active', // 日活（onShow 日去重，複訪率分子）
]);

/** 單批事件數上限（客戶端本地緩衝上限 200 同量級） */
const MAX_BATCH = 50;

/** 單條事件窄化：{name, ts, date}（name 過白名單，其餘鍵丟棄） */
function toEvent(raw: unknown): { name: string; ts: number; date: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.slice(0, 32) : '';
  if (!KNOWN_EVENTS.has(name)) return null;
  const ts = typeof r.ts === 'number' && r.ts > 0 ? Math.floor(r.ts) : Date.now();
  const date = typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : '';
  return { name, ts, date };
}

/** POST /api/metrics —— 批量埋點落庫（每批一條 domain='metrics' 記錄） */
const handleMetrics: RouteHandler = async (body, ctx) => {
  // 無身份（遊客 / 本地直連未帶 openid 極端態）：靜默丟棄，不回 4xx——
  // 埋點通道失敗不應在客戶端產生重試噪音
  if (!ctx.openid) return ok({ accepted: 0 });
  const input = (body ?? {}) as { events?: unknown };
  const rawList = Array.isArray(input.events) ? input.events : [];
  const events = rawList
    .slice(0, MAX_BATCH)
    .map(toEvent)
    .filter((e): e is { name: string; ts: number; date: string } => e !== null);
  if (events.length > 0) {
    await createOrder({
      orderId: `mtr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      owner: ctx.openid,
      domain: 'metrics',
      status: 'completed',
      payload: { events },
      createdAt: Date.now(),
    });
  }
  return ok({ accepted: events.length });
};

export const metricsRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/metrics', handleMetrics],
];
