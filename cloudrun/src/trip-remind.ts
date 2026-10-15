/**
 * 出發提醒端點（trip_remind 域）— 2026-10 第二梯隊·項B（推模式落地）
 *
 * 出發提醒此前僅有授權鏈路（行程頁 tap → subscribedAt 落盤），推送側
 * 缺失：行程存小程序本地 storage，雲端無數據可掃。本模組補上「登記 →
 * 定時掃描 → 前一天推送」一跳（主動性分層的 L2 時間規則）：
 *
 * 端點：
 *   POST /api/trip/remind/register —— 訂閱授權成功後白化登記（openid 鑒權）
 *   POST /api/trip/remind/remove   —— 刪除行程聯動清理（歸屬鑒權，防幽靈提醒）
 *   POST /internal/cron/trip-remind-tick —— 定時掃描（CRON_TOKEN 鑒權）
 *
 * 設計要點：
 * 1. 白化口徑（縱深防禦）：僅登記推送文案所需四要素（tripId / date /
 *    city / activity），intent / timeline / jump 等一律不上雲——比
 *    trip-share 的共享白名單更窄（推送是單人消費，無跨設備展示需求）
 * 2. 登記冪等：orderId 固定 trm_{tripId}，重複登記先刪後建（upsert）；
 *    同步自動展開 wxa_{tripId} 天氣監控（monitors.createWeatherMonitor，
 *    L3 外部事件線——問題由用戶的「訂閱出發提醒」定義，Agent 拆解執行）
 * 3. 推送時機：出發前一天（date === 東八區明天）經 subscribe/send
 *    （TRIP_REMIND_TMPL_ID 配置驅動）；文案附帶目的地天氣（預報查詢
 *    失敗時退化為純行程提醒——核心是提醒，天氣是增強）
 * 4. 一次性額度語義：'ok' / 'not_subscribed'（43101，重試無意義）皆
 *    completeOrder 收斂；'error'（網路 / 配置）保持 pending 下輪重試。
 *    未配置 TRIP_REMIND_TMPL_ID 時不推不收斂（不演），到期過後清理
 * 5. 額度補充入口：行程頁可再次 tap「訂閱出發提醒」重新登記（微信
 *    一次性訂閱可累積額度，register 的 upsert 語義天然支持）
 */

import type { RouteHandler } from './api';
import { ok, badRequest, unauthorized, forbidden, fail } from './api';
import { createOrder, deleteOrder, completeOrder, listAllByDomain } from './db';
import { createWeatherMonitor, removeWeatherMonitor } from './monitors';
import { getForecastByCity, type ForecastCast } from './skill-weather';
import { verifyCronToken, sendSubscribeMessage } from './wx-push';

/** trip_remind payload（db ExternalOrder.payload 的結構契約） */
interface TripRemindPayload {
  tripId: string;
  /** 活動日（YYYY-MM-DD） */
  date: string;
  city: string;
  activity: string;
  createdAt: number;
  /** 上次掃描時間（節流判據；未配置推送模板時避免逐輪重查天氣） */
  lastCheckedAt: number;
  /** 已嘗試推送（推送結果不區分成敗——額度語義在 comment 說明） */
  pushedAt?: number;
}

/** 字串窄化（截斷防濫用） */
function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** 東八區日期（YYYY-MM-DD）：tick 的「今天 / 明天」判定基準 */
function cnDate(offsetDays = 0): string {
  return new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
}

/** tick 單輪最多處理條數（定時觸發器超時保護，與 monitors tick 同款；
 * date 判定為天級粒度，餘量下輪接續無漏推風險） */
const TICK_BATCH_LIMIT = 20;

/** POST /api/trip/remind/register —— 訂閱授權成功後白化登記 */
const handleRegister: RouteHandler = async (body, ctx) => {
  if (!ctx.openid) return unauthorized('缺少調用方身份（x-wx-openid），拒絕登記出發提醒');
  const input = (body ?? {}) as { tripId?: unknown; date?: unknown; city?: unknown; activity?: unknown };
  // tripId 上限 60：派生 orderId（trm_ / wxa_ 前綴 4 字符 + tripId）須收納
  // 於 DB order_id VARCHAR(64)——超限在嚴格模式下觸發 1406 落庫失敗（500）
  const tripId = str(input.tripId, 60);
  const date = str(input.date, 10);
  const city = str(input.city, 24);
  const activity = str(input.activity, 60);
  if (!tripId.startsWith('trip_')) return badRequest('tripId 必須為 trip_ 前綴的本地行程 ID');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return badRequest('date 格式必須為 YYYY-MM-DD');
  if (Date.parse(`${date}T23:59:59+08:00`) < Date.now()) {
    return fail(400, '行程日已過去，無提醒意義');
  }
  if (!city) return badRequest('city 必填（推送文案與天氣查詢的城市）');

  // 冪等 upsert：先刪舊登記（not_found 容忍；forbidden 為他人佔用同 ID，拒絕）
  const old = await deleteOrder(`trm_${tripId}`, ctx.openid).catch(() => 'not_found' as const);
  if (old === 'forbidden') return forbidden('無權登記他人的出發提醒');

  const payload: TripRemindPayload = {
    tripId,
    date,
    city,
    activity: activity || '出行',
    createdAt: Date.now(),
    lastCheckedAt: 0,
  };
  await createOrder({
    orderId: `trm_${tripId}`,
    owner: ctx.openid,
    domain: 'trip_remind',
    status: 'pending_external',
    payload: { ...payload },
    createdAt: Date.now(),
  });
  // 天氣監控自動展開（L3 線；失敗不阻斷登記——主提醒仍有效，行程頁可見差異）
  await createWeatherMonitor(ctx.openid, tripId, city, date).catch((e) => {
    console.error('[trip-remind] 天氣監控創建失敗（不阻斷登記）：', e instanceof Error ? e.message : e);
  });
  return ok({ registered: true, weatherMonitorId: `wxa_${tripId}` });
};

/** POST /api/trip/remind/remove —— 刪除行程聯動清理（歸屬鑒權） */
const handleRemove: RouteHandler = async (body, ctx) => {
  if (!ctx.openid) return unauthorized('缺少調用方身份（x-wx-openid）');
  const input = (body ?? {}) as { tripId?: unknown };
  const tripId = str(input.tripId, 60); // 上限 60：與 register 對齊（orderId 列寬，見上方說明）
  if (!tripId.startsWith('trip_')) return badRequest('tripId 必須為 trip_ 前綴的本地行程 ID');

  const res = await deleteOrder(`trm_${tripId}`, ctx.openid);
  if (res === 'forbidden') return forbidden('無權清理他人的出發提醒');
  // 天氣監控同步清理（wxa_ 前綴；not_found 容忍——可能從未展開成功）
  await removeWeatherMonitor(ctx.openid, tripId).catch(() => undefined);
  return ok({ removed: true });
};

/** 天氣 → 出行建議詞（推送文案尾部；預報缺失回空串） */
function weatherAdvice(cast: ForecastCast | undefined): string {
  if (!cast) return '';
  const weather = `${cast.dayweather}${cast.nightweather}`;
  if (/雨|雪/.test(weather)) return '，記得帶傘';
  const daytemp = parseInt(cast.daytemp, 10);
  if (!Number.isNaN(daytemp) && daytemp >= 35) return '，注意防暑';
  if (!Number.isNaN(daytemp) && daytemp <= -5) return '，注意保暖';
  return '';
}

/** 單條出發提醒處理：到期推送 / 過期清理 / 未到期跳過 */
async function processRemind(
  orderId: string,
  owner: string,
  p: Partial<TripRemindPayload>,
): Promise<'pushed' | 'skipped' | 'cleaned'> {
  const now = Date.now();
  const date = String(p.date ?? '');
  const today = cnDate(0);
  const tomorrow = cnDate(1);

  // 過期清理（防積壓；本地行程簿 TRIP_LIMIT 淘汰後雲端殘留的唯一收斂路徑）
  if (date && date < today) {
    await completeOrder(orderId, owner).catch(() => undefined);
    return 'cleaned';
  }
  if (date !== tomorrow) return 'skipped';

  // 明天出發：嘗試推送（TRIP_REMIND_TMPL_ID 配置驅動；未配置時保持
  // pending 由過期清理收斂——本地 remindDueTrips 當天仍有拉模式提醒）
  const tmplId = process.env.TRIP_REMIND_TMPL_ID;
  if (!tmplId) return 'skipped';

  const city = String(p.city ?? '');
  const activity = String(p.activity ?? '出行');
  const casts = await getForecastByCity(city, date).catch(() => null);
  const cast = casts && casts.length > 0 ? casts[0] : undefined;
  const weatherPart = cast
    ? `。天氣${cast.dayweather}（${cast.nighttemp}~${cast.daytemp}°C）${weatherAdvice(cast)}`
    : '';
  const res = await sendSubscribeMessage(owner, tmplId, 'pages/trips/index', {
    thing1: { value: `明天${city}出行`.slice(0, 20) },
    thing2: { value: `${activity}${weatherPart}`.slice(0, 20) },
  });
  if (res === 'error') return 'skipped'; // 配置 / 網路問題：下輪重試
  // 'ok' 已推送；'not_subscribed' 額度耗盡（重試無意義）——皆收斂終態
  await completeOrder(orderId, owner).catch(() => undefined);
  console.log(`[trip-remind] 出發提醒已處理（${orderId}，${res}）`);
  return 'pushed';
}

/**
 * 定時掃描 tick（雲托管定時觸發器調用；CRON_TOKEN 鑒權，fail-closed）
 *
 * 響應體：{ scanned, pushed, cleaned }——觸發器日誌可觀測（scanned 為本
 * 輪實際處理條數，截斷餘量下輪接續）。單條異常不中斷整輪。掃描頻率無需
 * 節流（date 判定為純本地計算，天氣查詢僅在到期條目發生且有 30 分鐘預報
 * 快取兜底）。
 */
const handleTick: RouteHandler = async (body) => {
  const denied = verifyCronToken(body);
  if (denied) return denied;

  const all = await listAllByDomain('trip_remind', ['pending_external']);
  // 批次截斷（2026-10 審計 P5）：到期條目含天氣查詢 + 微信推送（串行），
  // 規模增長會超出定時觸發器時限；「明天出發」判定窗口為整天，餘量下輪
  // 接續無漏推風險
  const batch = all.slice(0, TICK_BATCH_LIMIT);
  let pushed = 0;
  let cleaned = 0;
  for (const o of batch) {
    try {
      const p = (o.payload ?? {}) as Partial<TripRemindPayload>;
      const res = await processRemind(o.orderId, o.owner, p);
      if (res === 'pushed') pushed++;
      if (res === 'cleaned') cleaned++;
    } catch (e) {
      console.error(`[trip-remind] 單條掃描異常（${o.orderId}）：`, e instanceof Error ? e.message : e);
    }
  }
  return ok({ scanned: batch.length, pushed, cleaned });
};

export const tripRemindRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/trip/remind/register', handleRegister],
  ['POST /api/trip/remind/remove', handleRemove],
  ['POST /internal/cron/trip-remind-tick', handleTick],
];
