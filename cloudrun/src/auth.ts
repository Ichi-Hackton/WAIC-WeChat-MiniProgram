/**
 * 身份認證端點（微信登入）
 *
 * 端點（與小程序端 services/identity.ts 呼叫路徑逐字對齊）：
 *   POST /api/auth/identity   body: { code }
 *
 * 雲托管模式下的身份事實來源是微信網關注入的 x-wx-openid
 * （server.ts 萃取進 ctx.openid，客戶端無法偽造——本地直連時
 * 由 services/cloud.ts localRunRequest 注入開發佔位身份）。
 * wx.login 的 code 僅作調用痕跡記錄（server.ts 統一日誌），保留
 * 給將來自建 code2Session 鏈路擴展，本端點不做兌換。
 */

import type { RouteHandler } from './api';
import { ok, unauthorized } from './api';

/** 回應業務資料形態（與小程序端 UserIdentity 對齊；sessionId 回顯可選） */
interface IdentityPayload {
  openid: string;
  sessionId?: string;
}

/** POST /api/auth/identity：回傳雲托管網關注入的調用方 openid */
const handleIdentity: RouteHandler = async (_body, ctx) => {
  // 缺少 openid 意味著請求未經微信雲托管網關（如裸 curl 直連容器），
  // 按「寫操作 / 身份紅線」語義拒絕，不做匿名降級
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（需經微信雲托管網關調用）');
  }
  const payload: IdentityPayload = { openid: ctx.openid };
  if (ctx.sessionId) payload.sessionId = ctx.sessionId;
  return ok(payload);
};

export const authRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/auth/identity', handleIdentity],
];
