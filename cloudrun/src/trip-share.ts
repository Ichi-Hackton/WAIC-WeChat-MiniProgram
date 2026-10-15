/**
 * 行程分享端點（trip 域，2026-10 產品評審 #4 增長循環）
 *
 * 行程時間線是天然分享素材（分享給同行同伴的真實社交場景）。行程簿
 * 存於用戶本機 storage，跨設備可見需雲端中轉：分享時白化落庫
 * （domain='trip'），同伴經不可枚舉 shareId 拉取只讀展示。
 *
 * 端點：
 *   POST /api/trip/share   —— 白化落庫，返回 shareId（發起方需 openid）
 *   POST /api/trip/shared  —— 按 shareId 拉取只讀行程（同伴，公開讀）
 *
 * 為何用 POST 取數：server.ts 路由分發丟棄 query string（url.split('?')[0]），
 * GET 請求又無 body，故取數沿用 POST 帶 body 的既有模式。
 *
 * 隱私白名單（縱深防禦：小程序端剝一次，本端點再濾一次）：
 * 僅接受 date / dateLabel / city / activity / timeline[{timeLabel,
 * title, status}]；intent（用戶原話）、jump（含 copyText 購票小抄）、
 * taskId / planId / remindedAt 一律不落庫不透出。status 僅復用訂單
 * 枚舉（分享內容定稿，無外部渠道語義）。
 */

import type { RouteHandler } from './api';
import { ok, badRequest, unauthorized, forbidden, fail } from './api';
import { createOrder, getOrder, deleteOrder } from './db';

/** 白化時間線節點（僅展示三要素） */
interface SharedNode {
  timeLabel: string;
  title: string;
  status: string;
}

/** 白化行程載荷（與小程序端 services/trip-share.ts SharedTrip 對齊） */
interface SharedTrip {
  date: string;
  dateLabel: string;
  city: string;
  activity: string;
  timeline: SharedNode[];
}

/** 字串欄位窄化（截斷防濫用；缺省上限 200 字元） */
function str(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/**
 * 白化：任意輸入 → SharedTrip 白名單形態
 *
 * @returns date / city 缺失（或輸入非物件）時返回 null，由呼叫方回 400
 */
function sanitize(input: unknown): SharedTrip | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  if (!str(raw.date, 10) || !str(raw.city, 24)) return null;
  const tl = Array.isArray(raw.timeline) ? raw.timeline : [];
  const timeline = tl.slice(0, 20).map((n) => {
    const node = (n ?? {}) as Record<string, unknown>;
    return {
      timeLabel: str(node.timeLabel, 32),
      title: str(node.title),
      status: str(node.status, 24),
    };
  });
  return {
    date: str(raw.date, 10),
    dateLabel: str(raw.dateLabel, 16),
    city: str(raw.city, 24),
    activity: str(raw.activity, 60),
    timeline,
  };
}

/** 分享有效期（毫秒）：行程分享的真實社交窗口以「天」計，超期即 404。
 * 白化數據雖已剝敏，無限期駐留仍是不必要的暴露面（2026-10 審計 P3：
 * 分享無過期 / 無撤銷；撤銷端點涉及前端交互改造另行排期，先以 TTL 收斂） */
const SHARE_TTL_MS = 30 * 24 * 3600 * 1000;

/** POST /api/trip/share —— 白化落庫，返回不可枚舉 shareId */
const handleShare: RouteHandler = async (body, ctx) => {
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕建立分享');
  }
  const input = (body ?? {}) as { trip?: unknown };
  const trip = sanitize(input.trip);
  if (!trip) {
    return badRequest('trip 載荷不合法（date / city 必填）');
  }
  const shareId = `shr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  await createOrder({
    orderId: shareId,
    owner: ctx.openid,
    domain: 'trip',
    status: 'completed',
    payload: { trip },
    createdAt: Date.now(),
  });
  return ok({ shareId });
};

/** POST /api/trip/share/revoke —— 發起方撤銷分享（2026-10 審計 P3 遺留項：
 *  分享無撤銷。歸屬鑒權防 IDOR，刪除後同伴側立即 404——TTL 之外的顯式收回） */
const handleRevoke: RouteHandler = async (body, ctx) => {
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕撤銷分享');
  }
  const input = (body ?? {}) as { shareId?: unknown };
  const shareId = typeof input.shareId === 'string' ? input.shareId.trim().slice(0, 64) : '';
  if (!shareId) return badRequest('shareId 必填');
  const order = await getOrder(shareId);
  if (!order || order.domain !== 'trip') {
    return fail(404, '分享不存在或已失效');
  }
  // 歸屬前置鑒權（防 IDOR）：撤銷是破壞性操作，僅發起方可觸達自己的分享
  if (order.owner !== ctx.openid) {
    return forbidden('無權撤銷他人的分享');
  }
  const result = await deleteOrder(shareId, ctx.openid);
  if (result === 'not_found') return fail(404, '分享不存在或已失效');
  if (result === 'forbidden') return forbidden('無權撤銷他人的分享');
  return ok({ ok: true, shareId });
};

/** POST /api/trip/shared —— 按 shareId 拉取只讀行程（同伴打開分享卡） */
const handleFetch: RouteHandler = async (body) => {
  const input = (body ?? {}) as { shareId?: unknown };
  const shareId = typeof input.shareId === 'string' ? input.shareId.trim().slice(0, 64) : '';
  if (!shareId) return badRequest('shareId 必填');
  const order = await getOrder(shareId);
  if (!order || order.domain !== 'trip') {
    return fail(404, '分享不存在或已失效');
  }
  // TTL 檢查：超期分享視同失效（發起方重新分享即可獲取新 shareId）
  if (Date.now() - order.createdAt > SHARE_TTL_MS) {
    return fail(404, '分享已過期（有效期 30 天），請讓發起方重新分享');
  }
  const trip = sanitize(order.payload.trip);
  if (!trip) {
    return fail(404, '分享不存在或已失效');
  }
  return ok({ shareId, trip });
};

export const tripShareRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/trip/share', handleShare],
  ['POST /api/trip/share/revoke', handleRevoke],
  ['POST /api/trip/shared', handleFetch],
];
