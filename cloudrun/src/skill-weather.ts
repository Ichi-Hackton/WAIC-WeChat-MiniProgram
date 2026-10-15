/**
 * 天氣查詢 SKILL 端點（skill.weather.query）
 *
 * 端點（與小程序端 weather-query SKILL 呼叫路徑逐字對齊）：
 *   POST /api/skill/skill.weather.query/get_weather   body: { lat, lng }（gcj02 座標）
 *
 * 資料鏈路（2026-10-14 修訂：上游由華風愛科切回高德——地理鏈路統一
 * AMAP_KEY 單一金鑰，免除 weathercn 實名認證與額度管理；此前 2026-10
 * 曾高德 → 華風愛科（中國天氣網）→ 高德往返，華風 WEATHERCN_KEY 鏈
 * 隨本次切換整體下線）：
 *   1. 座標 → adcode + 城市資訊（與 /api/geo/reverse 同一 regeo 能力）：
 *      GET https://restapi.amap.com/v3/geocode/regeo?location={lng},{lat}&key=金鑰
 *      （location 經度在前；addressComponent.adcode 為天氣接口查詢鍵；
 *      直轄市 city 形態為空陣列 []，typeof 窄化歸 undefined → 回退
 *      province，與 geo.ts 逆地理鏈語義對齊）
 *   2. adcode → 實況：
 *      GET https://restapi.amap.com/v3/weather/weatherInfo?city={adcode}&extensions=base&key=金鑰
 *      契約要點（官方文檔 lbs.amap.com/api/webservice/reference/weatherinfo，
 *      2026-10-14 實測逐欄位核對）：status '1' 成功（'0' 帶 info，如
 *      INVALID_USER_KEY）；lives[0] 每項 { weather, temperature, humidity,
 *      winddirection, windpower, reporttime, city, province, adcode }——
 *      reporttime 已是 "YYYY-MM-DD HH:mm:ss" 本地形態無需轉換；windpower
 *      為風力等級文案（如「≤3」）；lives 自帶 city 為區級粒度（如「东城区」），
 *      出參 city 以 regeo 市級結果為準（與逆地理鏈同構），lives 值僅作缺失兜底。
 *
 * 配置：AMAP_KEY（與 /api/geo/reverse、search_poi 共用「Web服務」金鑰，
 * 見 .env.local）。
 * 未配置或上游失敗時返回業務失敗 code 503（HTTP 200，不觸發小程序端
 * 網路層重試），小程序端 SKILL 以確定性模擬數據降級（卡片標識
 * 「模擬數據」，不誤導用戶）。
 *
 * 快取（記憶體，實例級；兩級快取使穩態下單次查詢僅 0~1 個上游請求，
 * 個人開發者額度下充裕）：
 *   - 位置鏈：網格座標 → { adcode, city, province }，TTL 24h
 *     （0.05° 網格公式與 geo.ts / 小程序端一致，同城移動高命中）
 *   - 實況鏈：adcode → 實況要素，TTL 10 分鐘（實況更新頻率約
 *     10~30 分鐘，短於此徒增上游配額消耗）
 *   - 兩鏈上限均 1000 條，超限淘汰最早插入條目（防無界增長）
 */

import type { RouteHandler } from './api';
import { ok, fail, badRequest } from './api';

/** 實況天氣快取 TTL：10 分鐘 */
const WEATHER_CACHE_TTL_MS = 10 * 60 * 1000;

/** adcode 位置鏈快取 TTL：24 小時（行政區劃短期不變） */
const LOCATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 記憶體快取條目上限（超限淘汰最早插入者；Map 迭代序為插入序） */
const CACHE_MAX_ENTRIES = 1000;

/** 上游（高德）單次請求超時（與 geo.ts / skill-map.ts 一致） */
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
  /** 風力等級（上游文案，如「≤3」；2026-10-14 華風風速文案隨切回高德復原） */
  windPower: string;
  /** 數據發布時間（"YYYY-MM-DD HH:mm:ss" 本地形態，上游原樣） */
  reportTime: string;
  /** 數據源標識（小程序端卡片以此區分即時 / 模擬） */
  source: 'amap_realtime';
}

/** 位置鏈快取條目 */
interface AdcodeCacheEntry {
  adcode: string;
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
const adcodeCache = new Map<string, AdcodeCacheEntry>();

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

/** 高德 regeo 回應（僅聲明消費欄位；直轄市 city 為空陣列 [] 形態） */
interface AmapRegeoResp {
  status?: string;
  info?: string;
  regeocode?: {
    addressComponent?: {
      adcode?: unknown;
      city?: unknown;
      province?: unknown;
    };
  };
}

/** 高德天氣實況回應（僅聲明消費欄位；extensions=base 時 lives 為單元素陣列） */
interface AmapWeatherResp {
  status?: string;
  info?: string;
  count?: string;
  lives?: unknown;
}

/**
 * 高德通用 GET 請求（超時中斷）
 *
 * @returns 解析後的 JSON；HTTP 非 2xx / 網路失敗 / 響應非 JSON 時返回 null
 */
async function callAmap<T>(path: string, key: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const resp = await fetch(`https://restapi.amap.com${path}`, { signal: controller.signal });
    if (!resp.ok) {
      console.error(`[weather] 高德服務回應 HTTP ${resp.status}（${path.split('?')[0]}）`);
      return null;
    }
    return (await resp.json().catch(() => null)) as T | null;
  } catch (e) {
    console.error('[weather] 高德服務不可達：', e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 座標 → adcode + 城市資訊（快取查詢 + 未命中回源）
 *
 * @returns 位置資訊；上游失敗 / 響應缺 adcode 時返回 null
 */
async function lookupAdcode(lat: number, lng: number, key: string): Promise<AdcodeCacheEntry | null> {
  // 命中快取直接返回（過期條目視為未命中，下次成功後覆寫）
  const cacheKey = `${grid(lat)},${grid(lng)}`;
  const hit = adcodeCache.get(cacheKey);
  if (hit && Date.now() < hit.expireAt) {
    return hit;
  }

  // location 經度在前（與 geo.ts callAmapRegeo 同構）
  const body = await callAmap<AmapRegeoResp>(
    `/v3/geocode/regeo?location=${lng.toFixed(6)},${lat.toFixed(6)}&key=${key}`,
    key,
  );
  if (!body || body.status !== '1') {
    console.error(`[weather] regeo 業務失敗：status=${body?.status} ${body?.info ?? ''}`);
    return null;
  }
  const comp = body.regeocode?.addressComponent;
  const adcode = strOrUndef(comp?.adcode);
  if (!adcode) {
    console.error('[weather] regeo 解析結果缺少 adcode（邊緣座標或境外）');
    return null;
  }
  const province = strOrUndef(comp?.province);
  const city = strOrUndef(comp?.city); // 直轄市 [] → undefined
  if (!city && !province) {
    console.error('[weather] regeo 解析結果缺少 city / province');
    return null;
  }

  const entry: AdcodeCacheEntry = {
    adcode,
    // city 缺失但 province 存在（上方已排除兩者皆空）：直轄市回退語義，與 geo.ts 對齊
    city: city ?? province!,
    province,
    expireAt: Date.now() + LOCATION_CACHE_TTL_MS,
  };
  adcodeCache.set(cacheKey, entry);
  if (adcodeCache.size > CACHE_MAX_ENTRIES) {
    const oldest = adcodeCache.keys().next().value;
    if (oldest !== undefined) adcodeCache.delete(oldest);
  }
  return entry;
}

/**
 * 高德實況回應 → 統一出參要素映射
 *
 * @returns 實況要素；weather / temperature（卡片渲染剛需）缺失時返回 null
 */
function mapLive(body: AmapWeatherResp): Omit<WeatherInfo, 'city' | 'province' | 'source'> | null {
  if (!Array.isArray(body.lives) || body.lives.length === 0) {
    console.error('[weather] 實況數據缺少 lives（業務正常但無觀測，罕見）');
    return null;
  }
  const raw = body.lives[0];
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const weather = strOrUndef(p.weather);
  const temperature = strOrUndef(p.temperature);
  if (!weather || !temperature) {
    console.error('[weather] 實況數據缺少 weather / temperature');
    return null;
  }
  return {
    weather,
    temperature,
    humidity: strOrUndef(p.humidity) ?? '—',
    windDirection: strOrUndef(p.winddirection) ?? '—',
    windPower: strOrUndef(p.windpower) ?? '—',
    // reporttime 上游已為 "YYYY-MM-DD HH:mm:ss" 本地形態，原樣透傳
    reportTime: strOrUndef(p.reporttime) ?? '',
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
  const key = process.env.AMAP_KEY;
  if (!key) {
    return fail(503, '未配置 AMAP_KEY，天氣查詢不可用');
  }

  // 1. 座標 → adcode + 城市資訊（網格快取，24h）
  const loc = await lookupAdcode(lat, lng, key);
  if (!loc) {
    return fail(503, '天氣定位上游失敗（regeo 不可達或座標無對應行政區）');
  }

  // 2. 實況快取命中直接返回（過期條目視為未命中，下次成功後覆寫）
  const hit = weatherCache.get(loc.adcode);
  if (hit && Date.now() < hit.expireAt) {
    return ok({
      city: loc.city,
      province: loc.province,
      ...hit.data,
      source: 'amap_realtime',
    });
  }

  // 3. 未命中回源實況接口（extensions=base 實況；adcode 為 6 位數字無需編碼）
  const current = await callAmap<AmapWeatherResp>(
    `/v3/weather/weatherInfo?city=${loc.adcode}&extensions=base&key=${key}`,
    key,
  );
  if (!current || current.status !== '1') {
    console.error(`[weather] 天氣實況業務失敗：status=${current?.status} ${current?.info ?? ''}`);
    return fail(503, '天氣查詢上游失敗（服務不可達或無實況數據）');
  }
  const live = mapLive(current);
  if (!live) {
    return fail(503, '天氣查詢上游失敗（實況要素不完整）');
  }

  weatherCache.set(loc.adcode, { data: live, expireAt: Date.now() + WEATHER_CACHE_TTL_MS });
  if (weatherCache.size > CACHE_MAX_ENTRIES) {
    const oldest = weatherCache.keys().next().value;
    if (oldest !== undefined) weatherCache.delete(oldest);
  }
  return ok({
    city: loc.city,
    province: loc.province,
    ...live,
    source: 'amap_realtime',
  });
};

export const weatherRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/skill/skill.weather.query/get_weather', handleGetWeather],
];

/* ============ 預報查詢（2026-10 第二梯隊·項B：條件監控 / 出發提醒消費） ============ */

/** 城市名 → adcode 快取條目 */
interface CityAdcodeEntry {
  adcode: string;
  city: string;
  expireAt: number;
}

/** 城市名快取（行程城市多爲市級名，命中率高；鍵為小寫化城市名） */
const cityAdcodeCache = new Map<string, CityAdcodeEntry>();

/** 高德地理編碼回應（僅聲明消費欄位） */
interface AmapGeoResp {
  status?: string;
  info?: string;
  geocodes?: unknown;
}

/** 高德預報回應（extensions=all；forecasts[0].casts 爲未來 3~4 天陣列） */
interface AmapForecastResp {
  status?: string;
  info?: string;
  forecasts?: unknown;
}

/** 單日預報（展示 / 命中判定消費的欄位子集） */
export interface ForecastCast {
  /** 預報日（YYYY-MM-DD） */
  date: string;
  dayweather: string;
  nightweather: string;
  /** 白天最高溫（攝氏度，字串形態） */
  daytemp: string;
  /** 夜間最低溫 */
  nighttemp: string;
}

/** 窄化：預報 casts 陣列單條 → ForecastCast（date 缺失返回 null） */
function toCast(raw: unknown): ForecastCast | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const date = strOrUndef(p.date);
  const dayweather = strOrUndef(p.dayweather);
  const nightweather = strOrUndef(p.nightweather);
  if (!date || !dayweather || !nightweather) return null;
  return {
    date,
    dayweather,
    nightweather,
    daytemp: strOrUndef(p.daytemp) ?? '',
    nighttemp: strOrUndef(p.nighttemp) ?? '',
  };
}

/** 快取淘汰（上限與實況鏈一致） */
function evictOldest(cache: Map<string, { expireAt: number }>): void {
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) cache.delete(oldest);
}

/**
 * 城市名 → adcode（地理編碼 + 24h 快取）
 *
 * @returns null：未配置金鑰 / 上游失敗 / 城市無對應行政區
 */
export async function lookupCityAdcode(city: string): Promise<CityAdcodeEntry | null> {
  const key = process.env.AMAP_KEY;
  if (!key) return null;
  const cacheKey = city.trim().toLowerCase();
  const hit = cityAdcodeCache.get(cacheKey);
  if (hit && Date.now() < hit.expireAt) return hit;

  const body = await callAmap<AmapGeoResp>(`/v3/geocode/geo?address=${encodeURIComponent(city)}&key=${key}`, key);
  if (!body || body.status !== '1' || !Array.isArray(body.geocodes) || body.geocodes.length === 0) {
    console.error(`[weather] 城市地理編碼失敗：${city}（status=${body?.status} ${body?.info ?? ''}）`);
    return null;
  }
  const first = body.geocodes[0] as Record<string, unknown>;
  const adcode = strOrUndef(first.adcode);
  if (!adcode) {
    console.error(`[weather] 城市地理編碼結果缺少 adcode：${city}`);
    return null;
  }
  const entry: CityAdcodeEntry = {
    adcode,
    city: strOrUndef(first.city) ?? city.slice(0, 24),
    expireAt: Date.now() + LOCATION_CACHE_TTL_MS,
  };
  cityAdcodeCache.set(cacheKey, entry);
  evictOldest(cityAdcodeCache);
  return entry;
}

/** 預報快取（adcode → { casts, expireAt }；預報更新頻率低於實況，TTL 30 分鐘） */
const forecastCache = new Map<string, { casts: ForecastCast[]; expireAt: number }>();

const FORECAST_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * 城市名 → 未來數日預報（監控掃描 / 出發提醒文案消費）
 *
 * 高德預報窗口僅 3~4 天：目標日在窗口外時返回空陣列（如實「窗口未覆蓋」，
 * 由調用方記錄等待臨近，不虚報無異常）。
 *
 * @returns null：配置缺失 / 上游失敗（與「窗口外」的空陣列語義分流）
 */
export async function getForecastByCity(city: string, date: string): Promise<ForecastCast[] | null> {
  const key = process.env.AMAP_KEY;
  if (!key) return null;
  const loc = await lookupCityAdcode(city);
  if (!loc) return null;

  const cached = forecastCache.get(loc.adcode);
  if (cached && Date.now() < cached.expireAt) {
    return cached.casts.filter((c) => c.date === date);
  }

  const body = await callAmap<AmapForecastResp>(
    `/v3/weather/weatherInfo?city=${loc.adcode}&extensions=all&key=${key}`,
    key,
  );
  if (!body || body.status !== '1' || !Array.isArray(body.forecasts) || body.forecasts.length === 0) {
    console.error(`[weather] 預報查詢業務失敗：status=${body?.status} ${body?.info ?? ''}`);
    return null;
  }
  const rawCasts = (body.forecasts[0] as Record<string, unknown>).casts;
  const casts = (Array.isArray(rawCasts) ? rawCasts : [])
    .map(toCast)
    .filter((c): c is ForecastCast => c !== null);
  forecastCache.set(loc.adcode, { casts, expireAt: Date.now() + FORECAST_CACHE_TTL_MS });
  evictOldest(forecastCache);
  return casts.filter((c) => c.date === date);
}
