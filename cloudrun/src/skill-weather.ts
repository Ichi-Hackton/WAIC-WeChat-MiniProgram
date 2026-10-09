/**
 * 天氣查詢 SKILL 端點（skill.weather.query）
 *
 * 端點（與小程序端 weather-query SKILL 呼叫路徑逐字對齊）：
 *   POST /api/skill/skill.weather.query/get_weather   body: { lat, lng }（gcj02 座標）
 *
 * 資料鏈路（2026-10 修訂：上游由高德切換華風愛科「中國天氣網」開放平台——
 * 中國氣象局華風集團與 AccuWeather 合資，REST 契約 AccuWeather 同構）：
 *   1. 座標 → Location Key：
 *      GET /locations/v1/cities/geoposition/search?q={lat},{lng}
 *      q 為「緯度,經度」；平台官方約定中國大陸 GeoPosition 原生支援
 *      GCJ-02，與小程序端座標語義一致無需轉換。城市 / 省份一併從此
 *      響應獲取（City + AdministrativeArea.LocalizedName），原 adcode
 *      依賴鏈（高德 regeo，geo.ts resolveAdcode）隨本次切換整體下線。
 *   2. Location Key → 實況：
 *      GET /currentconditions/v1/{locationKey}.json
 *
 * 配置：WEATHERCN_KEY（platform.weathercn.com 註冊並實名認證後，控制台
 * 創建應用獲取；標準測試 Key 每日 500 次免費額度、5 QPS）。
 * 鑑權：Header X-Gw-API-Key（平台建議方式，避免金鑰出現在 URL 與日誌）。
 * 未配置或上游失敗時返回業務失敗 code 503（HTTP 200，不觸發小程序端
 * 網路層重試），小程序端 SKILL 以確定性模擬數據降級（卡片標識
 * 「模擬數據」，不誤導用戶）。
 *
 * 響應欄位按 AccuWeather 同構結構聲明（WeatherText / Temperature.Metric /
 * RelativeHumidity / Wind.Direction.Localized / Wind.Speed.Metric /
 * LocalObservationDateTime），一律防禦性窄化；若真實 KEY 首次聯調發現
 * 欄位名出入，以日誌打印的上游響應為準校準（文檔頁為 JS 渲染，撰寫時
 * 未能逐欄位核對）。
 *
 * 快取（記憶體，實例級；兩級快取使穩態下單次查詢僅 0~1 個上游請求，
 * 500 次/日額度下充裕）：
 *   - 位置鏈：網格座標 → { locationKey, city, province }，TTL 24h
 *     （0.05° 網格公式與 geo.ts / 小程序端一致，同城移動高命中）
 *   - 實況鏈：locationKey → 實況要素，TTL 10 分鐘（實況更新頻率約
 *     10~30 分鐘，短於此徒增上游配額消耗）
 *   - 兩鏈上限均 1000 條，超限淘汰最早插入條目（防無界增長）
 */

import type { RouteHandler } from './api';
import { ok, fail, badRequest } from './api';

/** 實況天氣快取 TTL：10 分鐘 */
const WEATHER_CACHE_TTL_MS = 10 * 60 * 1000;

/** 位置 Key 快取 TTL：24 小時（行政區劃與站點對應短期不變） */
const LOCATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 記憶體快取條目上限（超限淘汰最早插入者；Map 迭代序為插入序） */
const CACHE_MAX_ENTRIES = 1000;

/** 上游（華風愛科開放平台）單次請求超時（與 geo.ts 一致） */
const UPSTREAM_TIMEOUT_MS = 8_000;

/** 網格精度（度）：≈5.5km，與 geo.ts / 小程序端一致公式，位置快取 key 用 */
const GEO_GRID_DEG = 0.05;

/** 統一出參（與小程序端 weather-query SKILL 的 outputSchema 對齊） */
export interface WeatherInfo {
  city: string;
  province?: string;
  /** 天氣現象（晴 / 多雲 / 小雨…，上游中文文案） */
  weather: string;
  /** 溫度（攝氏度，字串形態） */
  temperature: string;
  /** 濕度（百分比，字串形態） */
  humidity: string;
  windDirection: string;
  /** 風速（上游公制文案，如「12 km/h」；2026-10 由高德風力等級改為風速值） */
  windPower: string;
  /** 數據發布時間（ISO 8601 轉本地展示形態，如 "2026-10-09 14:32:00"） */
  reportTime: string;
  /** 數據源標識（小程序端卡片以此區分即時 / 模擬） */
  source: 'weathercn_realtime';
}

/** 位置鏈快取條目 */
interface LocationCacheEntry {
  locationKey: string;
  city: string;
  province?: string;
  expireAt: number;
}

/** 實況鏈快取條目 */
interface WeatherCacheEntry {
  data: Omit<WeatherInfo, 'city' | 'province' | 'source'>;
  expireAt: number;
}

/** 位置鏈快取（容器重啟即清空，可接受——上游僅定位輔助） */
const locationCache = new Map<string, LocationCacheEntry>();

/** 實況鏈快取（容器重啟即清空，可接受——上游 TTL 僅 10 分鐘） */
const weatherCache = new Map<string, WeatherCacheEntry>();

/** 座標網格化（與 geo.ts 一致公式；toFixed(2) 消除浮點誤差後作快取 key） */
function grid(v: number): string {
  return (Math.round(v / GEO_GRID_DEG) * GEO_GRID_DEG).toFixed(2);
}

/** 欄位窄化：字串（非空）才返回，否則 undefined（與 geo.ts 同構） */
function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** 華風定位搜索回應（僅聲明消費欄位；AccuWeather 同構） */
interface WeathercnLocationResp {
  /** Location Key（後續天氣接口的查詢鍵） */
  Key?: unknown;
  /** 城市名（中文） */
  City?: unknown;
  AdministrativeArea?: {
    /** 上級行政區（省級，中文） */
    LocalizedName?: unknown;
  };
}

/** 華風實況回應（僅聲明消費欄位；頂層為單物件，AccuWeather 同構） */
interface WeathercnCurrentResp {
  /** 觀測時間（ISO 8601 含時區，如 "2026-10-09T14:32:00+08:00"） */
  LocalObservationDateTime?: unknown;
  /** 天氣現象中文文案（多雲 / 小雨…） */
  WeatherText?: unknown;
  /** 相對濕度（百分比數字） */
  RelativeHumidity?: unknown;
  Temperature?: {
    /** 公制溫度（攝氏度數字） */
    Metric?: { Value?: unknown };
  };
  Wind?: {
    Direction?: {
      /** 風向中文文案（東北 / 西南…） */
      LocalizedName?: unknown;
    };
    Speed?: {
      /** 公制風速（km/h 數字） */
      Metric?: { Value?: unknown };
    };
  };
}

/**
 * 華風愛科開放平台通用請求（GET + Header 金鑰 + 超時中斷）
 *
 * @returns 解析後的 JSON；HTTP 非 2xx / 網路失敗 / 響應非 JSON 時返回 null
 */
async function callWeathercn<T>(path: string, key: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const resp = await fetch(`https://openapi.weathercn.com${path}`, {
      headers: { 'X-Gw-API-Key': key },
      signal: controller.signal,
    });
    if (!resp.ok) {
      console.error(`[weather] 華風愛科回應 HTTP ${resp.status}（${path.split('?')[0]}）`);
      return null;
    }
    return (await resp.json().catch(() => null)) as T | null;
  } catch (e) {
    console.error('[weather] 華風愛科不可達：', e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 座標 → Location Key + 城市資訊（快取查詢 + 未命中回源）
 *
 * @returns 位置資訊；上游失敗 / 響應缺 Key 時返回 null
 */
async function lookupLocation(lat: number, lng: number, key: string): Promise<LocationCacheEntry | null> {
  // 命中快取直接返回（過期條目視為未命中，下次成功後覆寫）
  const cacheKey = `${grid(lat)},${grid(lng)}`;
  const hit = locationCache.get(cacheKey);
  if (hit && Date.now() < hit.expireAt) {
    return hit;
  }

  // q 為「緯度,經度」（AccuWeather 慣例，lat 在前）；中國大陸原生支援 gcj02
  const body = await callWeathercn<WeathercnLocationResp>(
    `/locations/v1/cities/geoposition/search?q=${lat.toFixed(4)},${lng.toFixed(4)}`,
    key,
  );
  const locationKey = strOrUndef(body?.Key);
  const city = strOrUndef(body?.City);
  if (!locationKey || !city) {
    console.error('[weather] 定位搜索失敗（響應缺 Key / City，座標可能無對應站點）');
    return null;
  }

  const entry: LocationCacheEntry = {
    locationKey,
    city,
    province: strOrUndef(body?.AdministrativeArea?.LocalizedName),
    expireAt: Date.now() + LOCATION_CACHE_TTL_MS,
  };
  locationCache.set(cacheKey, entry);
  if (locationCache.size > CACHE_MAX_ENTRIES) {
    const oldest = locationCache.keys().next().value;
    if (oldest !== undefined) locationCache.delete(oldest);
  }
  return entry;
}

/** ISO 8601 觀測時間 → 本地展示形態（"2026-10-09T14:32:00+08:00" → "2026-10-09 14:32:00"） */
function formatReportTime(raw: string): string {
  return raw.replace('T', ' ').replace(/\+08:00$/, '').replace(/Z$/, '');
}

/**
 * 華風實況回應 → 統一出參要素映射
 *
 * @returns 實況要素；weather / temperature（卡片渲染剛需）缺失時返回 null
 */
function mapCurrent(body: WeathercnCurrentResp): Omit<WeatherInfo, 'city' | 'province' | 'source'> | null {
  const weather = strOrUndef(body.WeatherText);
  const tempVal = body.Temperature?.Metric?.Value;
  if (!weather || typeof tempVal !== 'number' || Number.isNaN(tempVal)) {
    console.error('[weather] 實況數據缺少 WeatherText / Temperature.Metric.Value');
    return null;
  }
  const humidityVal = body.RelativeHumidity;
  const windSpeedVal = body.Wind?.Speed?.Metric?.Value;
  const reportTimeRaw = strOrUndef(body.LocalObservationDateTime);
  return {
    weather,
    temperature: String(tempVal),
    humidity: typeof humidityVal === 'number' && !Number.isNaN(humidityVal) ? String(humidityVal) : '—',
    windDirection: strOrUndef(body.Wind?.Direction?.LocalizedName) ?? '—',
    windPower: typeof windSpeedVal === 'number' && !Number.isNaN(windSpeedVal) ? `${Math.round(windSpeedVal)} km/h` : '—',
    reportTime: reportTimeRaw ? formatReportTime(reportTimeRaw) : '',
  };
}

/** 天氣查詢入參 */
interface WeatherInput {
  lat?: unknown;
  lng?: unknown;
}

const handleGetWeather: RouteHandler = async (body) => {
  const input = (body ?? {}) as WeatherInput;
  const { lat, lng } = input;
  if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) {
    return badRequest('lat / lng 必填且為數字');
  }
  // 座標語義為 gcj02（僅定義於中國大陸境內，粗邊界校驗與 /api/geo/reverse 一致）
  if (lat < 3 || lat > 54 || lng < 73 || lng > 136) {
    return badRequest('座標超出 gcj02 覆蓋範圍（中國大陸）');
  }
  const key = process.env.WEATHERCN_KEY;
  if (!key) {
    return fail(503, '未配置 WEATHERCN_KEY，天氣查詢不可用');
  }

  // 1. 座標 → Location Key + 城市資訊（網格快取，24h）
  const loc = await lookupLocation(lat, lng, key);
  if (!loc) {
    return fail(503, '定位搜索上游失敗（座標無對應站點或服務不可達）');
  }

  // 2. 實況快取命中直接返回（過期條目視為未命中，下次成功後覆寫）
  const hit = weatherCache.get(loc.locationKey);
  if (hit && Date.now() < hit.expireAt) {
    return ok({
      city: loc.city,
      province: loc.province,
      ...hit.data,
      source: 'weathercn_realtime',
    });
  }

  // 3. 未命中回源實況接口
  const current = await callWeathercn<WeathercnCurrentResp>(
    `/currentconditions/v1/${encodeURIComponent(loc.locationKey)}.json`,
    key,
  );
  if (!current) {
    return fail(503, '天氣查詢上游失敗（服務不可達或無實況數據）');
  }
  const live = mapCurrent(current);
  if (!live) {
    return fail(503, '天氣查詢上游失敗（實況要素不完整）');
  }

  weatherCache.set(loc.locationKey, { data: live, expireAt: Date.now() + WEATHER_CACHE_TTL_MS });
  if (weatherCache.size > CACHE_MAX_ENTRIES) {
    const oldest = weatherCache.keys().next().value;
    if (oldest !== undefined) weatherCache.delete(oldest);
  }
  return ok({
    city: loc.city,
    province: loc.province,
    ...live,
    source: 'weathercn_realtime',
  });
};

export const weatherRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/skill/skill.weather.query/get_weather', handleGetWeather],
];
