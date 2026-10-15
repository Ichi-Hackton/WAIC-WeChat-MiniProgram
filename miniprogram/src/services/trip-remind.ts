/**
 * 出發提醒雲端調用薄封裝（2026-10 第二梯隊·項B：推模式落地）
 *
 * 訂閱授權成功後白化登記（register），雲托管定時觸發器掃描到期行程
 * 經 subscribeMessage.send 前一天推送（部署側配 TRIP_REMIND_TMPL_ID）；
 * 刪除行程時聯動清理（remove，防幽靈提醒）。
 */

import { postContainer, type CloudResponse } from './cloud';

/** 登記入參（與雲端 handleRegister 契約對齊，兩份副本維護） */
export interface TripRemindRegisterInput {
  tripId: string;
  /** 活動日（YYYY-MM-DD） */
  date: string;
  /** 目的地城市（推送文案與天氣查詢用） */
  city: string;
  activity: string;
}

/** 訂閱授權成功後登記（冪等 upsert；雲端同步展開 wxa_ 天氣監控） */
export function registerTripRemind(
  env: string,
  input: TripRemindRegisterInput,
): Promise<CloudResponse<{ registered: boolean; weatherMonitorId: string }>> {
  return postContainer(env, '/api/trip/remind/register', input);
}

/** 刪除行程聯動清理（歸屬鑒權雲端內建；天氣監控同步清理） */
export function removeTripRemind(
  env: string,
  tripId: string,
): Promise<CloudResponse<{ removed: boolean }>> {
  return postContainer(env, '/api/trip/remind/remove', { tripId });
}
