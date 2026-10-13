/**
 * Agent 上下文構造器
 *
 * 規範來源：.qoder/rules/Agent.md § 6.3
 *
 * 構造完整 AgentContext，注入：
 *   - sessionId（自動產生）
 *   - userId（從緩存 / 雲端取得）
 *   - 用戶畫像（座標從 wx.getLocation 取得，城市名經雲端逆地理編碼補全）
 *   - 用戶偏好（storage/preferences 白名單域回填 userProfile.preferences）
 *   - 跨會話意圖摘要（storage/session 脫敏摘要回填 userProfile.history）
 *   - globals（雲端環境 ID 等）
 *   - trace（追蹤資訊）
 */

import { genSessionId } from '../utils/idgen';
import { now as _now } from '../utils/datetime';
import { getCachedOpenid } from '../services/identity';
import { reverseGeocode } from '../services/geo';
import { getDefaultAddress, normalizeCityName } from '../storage/address';
import { getHistory, sanitizeIntent } from '../storage/session';
import { getPreferenceSummary } from '../storage/preferences';
import { error as logError, info as logInfo } from '../utils/logger';
import type { AgentContext, LocationAuth, UserLocation } from '../types/context';

export interface BuildContextOptions {
  /** 強制使用固定 sessionId（測試用） */
  sessionId?: string;
  /** 強制 userId（測試 / 已登入用） */
  userId?: string;
  /** 雲端環境 ID（必填） */
  cloudEnv: string;
  /** 是否嘗試取得地理位置，預設 true */
  withLocation?: boolean;
  /** 自訂 globals */
  globals?: Record<string, unknown>;
}

/** 注入 userProfile.history 的單條意圖摘要截斷上限（控制 planner Prompt token） */
const HISTORY_INTENT_MAX = 60;

/** 取座標的成功載荷 */
interface CoordOk {
  ok: true;
  lat: number;
  lng: number;
  rawCity?: string;
}

/** 取座標的失敗載荷（帶授權歸因，供上層區分「拒絕授權」與「定位失敗」） */
interface CoordFail {
  ok: false;
  auth: 'denied' | 'error';
}

/**
 * 透過微信原生 API 取得座標（包裝；基礎庫回應不含 city，見型別註釋）
 *
 * 失敗歸因規則：errMsg 含 auth / deny / denied / permission（如
 * "getLocation:fail auth deny"、"getLocation:fail system permission denied"）
 * 視為授權拒絕；其餘（逾時、定位開關關閉等）歸為 error。拒絕授權的
 * errMsg 形態隨基礎庫版本各異，探測一律大小寫不敏感並取寬鬆交集。
 */
function fetchCoord(): Promise<CoordOk | CoordFail | undefined> {
  return new Promise((resolve) => {
    const wxApi = (globalThis as { wx?: {
      getLocation?: (o: unknown) => Promise<unknown>;
    } }).wx;
    if (!wxApi?.getLocation) {
      resolve(undefined);
      return;
    }
    wxApi
      .getLocation({ type: 'gcj02' })
      .then((res: unknown) => {
        const r = res as { latitude?: number; longitude?: number; city?: string } | undefined;
        if (!r || r.latitude === undefined || r.longitude === undefined) {
          resolve({ ok: false, auth: 'error' });
          return;
        }
        resolve({ ok: true, lat: r.latitude, lng: r.longitude, rawCity: r.city });
      })
      .catch((e: unknown) => {
        const errMsg = (e as { errMsg?: string } | null | undefined)?.errMsg ?? '';
        const denied = /auth|deny|denied|permission/i.test(errMsg);
        logError(`取得位置失敗（${denied ? '授權拒絕' : '非授權原因'}）`, errMsg || e);
        resolve({ ok: false, auth: denied ? 'denied' : 'error' });
      });
  });
}

/**
 * 取得用戶位置（城市 + 座標 + 授權狀態）
 *
 * 城市來源優先級（2026-10 修訂，出發城市取值鏈）：
 *   1. 地址簿默認地址市級（storage/address；歸一化去行政區後綴）
 *   2. 座標經雲端 /api/geo/reverse（天地圖代理，雙層快取）逆地理編碼
 * 座標仍僅來自定位（地址簿無座標）；授權狀態（auth）只反映定位事實，
 * 不被地址簿覆蓋——地址簿可提供城市但天氣等座標依賴能力仍需定位。
 *
 * 授權狀態：定位未授權 / 失敗不再以「location 缺失」一言蔽之——
 * auth 區分「拒絕授權（denied）」與「定位失敗（error）」，供閒聊分類器
 * 如實回答「能不能獲取我的位置」。未嘗試定位（無 wx 環境）時
 * auth 缺失，語義為「未知」。
 */
async function fetchLocation(
  cloudEnv: string,
): Promise<{ location?: UserLocation; auth?: LocationAuth }> {
  // 出發城市第一優先級：地址簿默認地址市級（含歸一化；空簿為 null）
  const addrCity = getDefaultAddress()?.city;
  const addrCityNorm = addrCity ? normalizeCityName(addrCity) : undefined;

  const coord = await fetchCoord();
  if (coord === undefined) {
    // 無 wx 環境：僅地址簿城市可用（有城市無座標形態）
    return addrCityNorm ? { location: { city: addrCityNorm, citySource: 'address_book' } } : {};
  }
  if (!coord.ok) {
    // 定位失敗 / 拒絕授權：地址簿城市仍可作為出發城市（座標缺失）
    return {
      ...(addrCityNorm ? { location: { city: addrCityNorm, citySource: 'address_book' } } : {}),
      auth: coord.auth,
    };
  }
  if (coord.rawCity) {
    // 基礎庫未來若擴展返回 city，定位城市優於逆地理、但仍讓位於地址簿
    const geoCity = normalizeCityName(coord.rawCity);
    const city = addrCityNorm ?? geoCity;
    return {
      location: {
        lat: coord.lat,
        lng: coord.lng,
        ...(city ? { city, citySource: addrCityNorm ? 'address_book' : 'native' } : {}),
      },
      auth: 'granted' as const,
    };
  }
  const geo = await reverseGeocode(cloudEnv, coord.lat, coord.lng);
  const geoCity = geo?.city ? normalizeCityName(geo.city) : undefined;
  const city = addrCityNorm ?? geoCity;
  return {
    location: {
      lat: coord.lat,
      lng: coord.lng,
      ...(city ? { city, citySource: addrCityNorm ? 'address_book' : 'geocode' } : {}),
    },
    auth: 'granted' as const,
  };
}

/** 構造 AgentContext */
export async function buildContext(opts: BuildContextOptions): Promise<AgentContext> {
  const sessionId = opts.sessionId ?? genSessionId();
  let userId = opts.userId ?? getCachedOpenid() ?? 'anonymous';
  // 若 userId 是匿名但有 cloudEnv 與本地 code，嘗試一次身份獲取（可選）
  if (userId === 'anonymous') {
    logInfo('尚無 userId，使用匿名身份（MVP 階段）');
  }

  const { location, auth } =
    opts.withLocation !== false ? await fetchLocation(opts.cloudEnv) : {};

  // 跨會話意圖摘要回填（§ 10 紅線合規）：僅讀 storage/session 的脫敏意圖
  // 摘要（getHistory → wx.getStorageSync，同步 API，微秒級不阻塞事件循環），
  // 不回讀 session:messages 原始消息；每條截斷為摘要形態後注入
  // userProfile.history，使 planner「最近意圖」分支生效。窄化防禦 storage
  // 中 JSON 畸形條目（版本遷移 / 手改），並丟棄 planId / state 保持最小注
  // 入面。注入前再過 sanitizeIntent：防住寫入側脫敏上線前已落盤的明文舊
  // 數據；順序必須先脫敏後截斷（截斷會把 18 位證號切成脫離正則的短串）。
  // 同步讀取不改 buildContext 簽名，呼叫方無需適配。
  const intentHistory = getHistory()
    .filter((e) => typeof e?.intent === 'string' && typeof e?.timestamp === 'number')
    .map((e) => ({ intent: sanitizeIntent(e.intent).slice(0, HISTORY_INTENT_MAX), timestamp: e.timestamp }));

  // userProfile.preferences 回填：用戶偏好長期記憶（storage/preferences
  // 白名單域純鍵值摘要，同步讀取與上方 history 同構）；值已於寫入側
  // 過白名單 + 脫敏 + 截斷，摘要讀取再做一層窄化防禦。空摘要保持空
  // 對象（planner「用戶偏好」分支自然跳過）
  const ctx: AgentContext = {
    sessionId,
    userId,
    userProfile: {
      ...(location ? { location } : {}),
      ...(auth ? { locationAuth: auth } : {}),
      preferences: getPreferenceSummary(),
      history: intentHistory,
    },
    globals: {
      cloudEnv: opts.cloudEnv,
      ...(opts.globals ?? {}),
    },
    messages: [],
    trace: {
      llmCalls: 0,
      skillCalls: 0,
      totalTokens: 0,
      startTime: _now(),
    },
  };
  return ctx;
}

/** 把用戶訊息追加到 ctx.messages（不持久化，僅記憶） */
export function pushMessage(
  ctx: AgentContext,
  msg: Parameters<AgentContext['messages']['push']>[0],
): void {
  ctx.messages.push(msg);
  // 防止記憶體爆掉，僅保留最近 20 條
  if (ctx.messages.length > 20) {
    ctx.messages.splice(0, ctx.messages.length - 20);
  }
}