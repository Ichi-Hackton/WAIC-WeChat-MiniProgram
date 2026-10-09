/**
 * 逆地理編碼封裝（座標 → 城市名）
 *
 * 規範來源：Agent.md § 7.1（小程序端禁止直連第三方 API，經雲端容器代理）
 *
 * 為什麼需要：wx.getLocation 成功回應不含 city 欄位（官方僅返回
 * latitude / longitude / accuracy 等），userProfile.location.city 須經
 * 雲端 /api/geo/reverse（天地圖 geocoder 代理）補全。
 *
 * 快取（storage/cache.ts，跨會話持久）：
 *   - key 以 0.05° 網格化座標構造（≈5.5km，城市尺度，與雲端一致），
 *     同城移動高命中
 *   - TTL 7 天（座標對應行政區劃短期不變），避免每次會話重複請求
 *
 * 降級語義：任何失敗（網路 / 超時 / 業務碼非 0）一律返回 undefined，
 * 絕不拋錯——城市資訊為可選增強，不得阻斷 AgentContext 構建。
 */

import { callContainer } from './cloud';
import { get as cacheGet, set as cacheSet } from '../storage/cache';
import { warn as logWarn } from '../utils/logger';

/** 逆地理編碼結果（與雲端 geo.ts 出參對齊） */
export interface ReverseGeoInfo {
  city: string;
  province?: string;
}

/** 網格精度（度）：≈5.5km，城市尺度快取粒度（與雲端 geo.ts 一致） */
const GEO_GRID_DEG = 0.05;

/** 持久快取 TTL：7 天（行政區劃隨座標短期不變） */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 單次請求超時：城市補全不應拖慢 context 構建（callContainer 預設 15s 過長） */
const REQUEST_TIMEOUT_MS = 5_000;

/** 座標網格化（與雲端一致公式；僅用於快取 key 構造，不影響請求精度） */
function grid(v: number): number {
  return Math.round(v / GEO_GRID_DEG) * GEO_GRID_DEG;
}

/** 校驗快取 / 響應形態（storage 可能殘留舊結構，防禦性窄化） */
function isReverseGeoInfo(d: unknown): d is ReverseGeoInfo {
  return typeof d === 'object' && d !== null && typeof (d as ReverseGeoInfo).city === 'string' && (d as ReverseGeoInfo).city !== '';
}

/**
 * 逆地理編碼：gcj02 座標 → 城市名（含持久快取）
 *
 * 呼叫鏈：storage 持久快取 → callContainer（retry: false，短超時）
 * → 雲端 /api/geo/reverse（天地圖代理，實例級記憶體快取）。
 *
 * @param env 雲端環境 ID
 * @param lat 緯度（gcj02）
 * @param lng 經度（gcj02）
 * @returns 城市資訊；未命中快取且雲端失敗時返回 undefined（調用方降級）
 */
export async function reverseGeocode(env: string, lat: number, lng: number): Promise<ReverseGeoInfo | undefined> {
  // 快取 key 用網格化座標：同城移動（±數公里）命中同一條目，避免重複請求
  const gridInput = { lat: grid(lat), lng: grid(lng) };
  const cached = cacheGet<ReverseGeoInfo>('geo', 'reverse', gridInput);
  if (isReverseGeoInfo(cached)) {
    return cached;
  }

  // retry: false——城市資訊不值得 3 次重試的延遲；短超時快速降級
  let resp: Awaited<ReturnType<typeof callContainer<ReverseGeoInfo>>>;
  try {
    resp = await callContainer<ReverseGeoInfo>({
      env,
      path: '/api/geo/reverse',
      method: 'POST',
      data: { lat, lng },
      timeoutMs: REQUEST_TIMEOUT_MS,
      retry: false,
    });
  } catch (e) {
    // release 環境雲端不可達時 callContainer 會 reject（CloudNetworkError / 超時）
    logWarn('逆地理編碼請求失敗（降級為無城市）', e);
    return undefined;
  }

  const info = resp.data;
  if (resp.code !== 0 || !isReverseGeoInfo(info)) {
    return undefined;
  }
  cacheSet('geo', 'reverse', gridInput, info, { ttlMs: CACHE_TTL_MS });
  return info;
}
