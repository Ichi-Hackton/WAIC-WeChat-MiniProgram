/**
 * 埋點服務（services 層：fire-and-forget 上報，永不阻斷業務）
 *
 * 職責：漏斗事件本地記錄（storage/metrics）+ 異步批量上報雲端
 * /api/metrics。上報失敗保留本地緩衝，隨下一個事件觸發重試；
 * 任何失敗均靜默——埋點是觀測通道，不是業務依賴。
 */

import { postContainer } from './cloud';
import { appendEvent, markDailyActiveOnce, pendingEvents, removeFront } from '../storage/metrics';
import { METRIC_NAMES } from '../utils/metrics';
import type { MetricName } from '../utils/metrics';
import { formatDate } from '../utils/datetime';

/** 單批上報上限（與雲端 metrics.ts MAX_BATCH 對齊，超出分批） */
const BATCH = 50;

/** 上報進行中標記（併發去重：多事件同 tick 觸發僅跑一輪 flush） */
let flushing = false;

/**
 * 批量上報緩衝（成功移除前綴，失敗保留待重試）
 *
 * 分批串行：每批回應成功才移除該批，避免亂序失敗造成事件丟失。
 */
function flush(env: string): void {
  if (flushing) return;
  flushing = true;
  void (async () => {
    try {
      let pending = pendingEvents();
      while (pending.length > 0) {
        const batch = pending.slice(0, BATCH);
        const res = await postContainer<{ accepted: number }>(
          env,
          '/api/metrics',
          { events: batch },
          { retry: false, timeoutMs: 10_000 },
        );
        // 業務失敗（含開發環境 code:-1 降級）：保留緩衝，隨下次事件重試
        if (res.code !== 0) return;
        removeFront(batch.length);
        pending = pendingEvents();
      }
    } catch {
      /* 網路失敗：緩衝已保留，靜默（埋點永不拋錯） */
    } finally {
      flushing = false;
    }
  })();
}

/** 記錄漏斗事件並觸發異步上報 */
export function recordEvent(env: string, name: MetricName): void {
  appendEvent(name, formatDate(new Date()));
  flush(env);
}

/** 日活打點（App onShow 調用；同日僅記一次） */
export function markDailyActive(env: string): void {
  const today = formatDate(new Date());
  if (!markDailyActiveOnce(today)) return;
  appendEvent(METRIC_NAMES.dailyActive, today);
  flush(env);
}
