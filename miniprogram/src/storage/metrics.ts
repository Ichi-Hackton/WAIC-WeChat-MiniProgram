/**
 * 埋點本地緩衝（storage/ 業務持久化）
 *
 * fire-and-forget 上報的前置緩衝：事件先落本機，上報成功移除前綴、
 * 失敗保留待下次事件觸發時重試——弱網 / 雲端抖動不丟內測數據。
 *
 * 規範來源：.qoder/rules/Agent.md § 4（storage/ 業務持久化）、
 * § 10（數據最小化：僅事件名 + 時間，不含任何用戶輸入）。
 */

import { getItem, setItem } from '../services/storage';
import type { MetricEvent, MetricName } from '../utils/metrics';

/** 待上報事件緩衝鍵（實際落盤 micromate:metrics:events） */
const KEY = 'metrics:events';

/** 日活去重鍵（最近一次記錄日活的日子） */
const DAU_KEY = 'metrics:last-active-date';

/** 緩衝容量上限（防無限膨脹；超出丟棄最舊） */
const CAP = 200;

/** 追加事件並返回當前緩衝（容量超限時保留最新 CAP 條） */
export function appendEvent(name: MetricName, date: string): void {
  const events = getItem<MetricEvent[]>(KEY, []) ?? [];
  events.push({ name, ts: Date.now(), date });
  if (events.length > CAP) events.splice(0, events.length - CAP);
  setItem(KEY, events);
}

/**
 * 日活去重：今日尚未記錄則記錄並返回 true（呼叫方補記 daily_active 事件）
 *
 * 純去重鍵不攜事件——避免同日多次 onShow 產生重複日活事件。
 */
export function markDailyActiveOnce(date: string): boolean {
  const last = getItem<string>(DAU_KEY, '') ?? '';
  if (last === date) return false;
  setItem(DAU_KEY, date);
  return true;
}

/** 當前待上報事件（只讀；上報成功後由 removeFront 移除前綴） */
export function pendingEvents(): MetricEvent[] {
  return getItem<MetricEvent[]>(KEY, []) ?? [];
}

/** 移除已上報前綴（失敗批次之後的內容保留） */
export function removeFront(n: number): void {
  if (n <= 0) return;
  const events = getItem<MetricEvent[]>(KEY, []) ?? [];
  setItem(KEY, events.slice(n));
}

/** 本地事件計數摘要（調試 / 自查看；鍵為事件名） */
export function localSummary(): Record<string, number> {
  const sum: Record<string, number> = {};
  for (const e of pendingEvents()) sum[e.name] = (sum[e.name] ?? 0) + 1;
  return sum;
}
