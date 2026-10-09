/**
 * 行程分享服務（2026-10 產品評審 #4 增長循環）
 *
 * 行程時間線是天然分享素材（分享給同行同伴的真實社交場景）。行程簿
 * 存本機 storage，跨設備可見走雲端中轉（cloudrun/src/trip-share.ts）：
 * 分享時白化上傳換不可枚舉 shareId，同伴打開分享卡按 shareId 拉取。
 *
 * 隱私白名單（第一道，雲端 sanitize 為第二道）：僅上傳展示要素，
 * intent（用戶原話）/ jump（含 copyText 購票小抄）/ planId 一律剝離。
 */

import { postContainer } from './cloud';
import type { CloudResponse } from './cloud';
import type { TripEntry } from '../types/trip';

/** 分享白化形態（與雲端 trip-share.ts SharedTrip 對齊） */
export interface SharedTrip {
  date: string;
  dateLabel: string;
  city: string;
  activity: string;
  timeline: Array<{ timeLabel: string; title: string; status: string }>;
}

/** 本地行程 → 分享白化形態（剝除一切個人欄位） */
export function toShareable(entry: TripEntry): SharedTrip {
  return {
    date: entry.date,
    dateLabel: entry.dateLabel,
    city: entry.city,
    activity: entry.activity,
    timeline: entry.timeline.map((n) => ({
      timeLabel: n.timeLabel,
      title: n.title,
      status: n.status,
    })),
  };
}

/**
 * 上傳分享，返回不可枚舉 shareId
 *
 * @throws 業務失敗（code≠0）拋錯，由頁面以 toast 提示（分享是顯式
 *         用戶動作，失敗需要反饋，與埋點的靜默語義相反）
 */
export async function shareTripToCloud(env: string, entry: TripEntry): Promise<string> {
  const res: CloudResponse<{ shareId: string }> = await postContainer<{ shareId: string }>(
    env,
    '/api/trip/share',
    { trip: toShareable(entry) },
    { retry: false, timeoutMs: 10_000 },
  );
  if (res.code !== 0 || !res.data?.shareId) {
    throw new Error(res.message ?? '分享建立失敗，請稍後再試');
  }
  return res.data.shareId;
}

/**
 * 拉取他人分享的只讀行程（分享卡打開路徑）
 *
 * @returns 失敗 / 不存在返回 null，由頁面展示引導文案
 */
export async function fetchSharedTrip(env: string, shareId: string): Promise<SharedTrip | null> {
  const res: CloudResponse<{ trip: SharedTrip }> = await postContainer<{ trip: SharedTrip }>(
    env,
    '/api/trip/shared',
    { shareId },
    { retry: false, timeoutMs: 10_000 },
  );
  if (res.code !== 0 || !res.data?.trip) return null;
  return res.data.trip;
}
