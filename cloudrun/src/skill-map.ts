/**
 * 地圖 POI 搜尋 SKILL 端點（skill.map.tianditu）
 *
 * 端點（與小程序端 map-tianditu SKILL 呼叫路徑逐字對齊）：
 *   POST /api/skill/skill.map.tianditu/search_poi
 *   body: { keyword, lat, lng, radiusM?, limit? }（lat/lng 為 gcj02 座標）
 *
 * 雙上游可切換（2026-10-13 修訂：澳門 / 境外網絡訪問不了天地圖控制台，
 * 無法申請管理金鑰，故騰訊優先、天地圖兜底；兩把金鑰誰配了用誰）：
 *
 *   上游 A（優先）騰訊位置服務 WebServiceAPI（TENCENT_LBS_KEY）——
 *     GET https://apis.map.qq.com/ws/place/v1/search
 *       ?keyword=…&boundary=nearby(lat,lng,1000,auto_extend=1)&page_size=20&key=…
 *     契約要點（官方文檔 + 2026-10-13 實測）：status 0 成功（非 0 帶
 *     message，如 199「此key未開啟WebserviceAPI功能」、311 key 格式錯誤）；
 *     data[] 每項 { title, address, tel?, location: {lat,lng}, _distance? }；
 *     座標系原生 gcj02（與小程序全鏈路一致，零轉換）；boundary=nearby
 *     半徑上限 1000 米為上游約束，auto_extend=1 允許自動擴大召回——
 *     「附近」語義仍由本端 haversine 按 radiusM 後置把關，不依賴上游。
 *     優勢：微信生態同源（map 組件底層即騰訊位置服務）、控制台境外可達
 *     （lbs.qq.com）、個人開發者地點搜索免費額度約 1 萬次 / 日。
 *
 *   上游 B（兜底）天地圖「地名搜索 2.0」（TIANDITU_KEY，與 /api/geo/reverse
 *     共用「服務端」金鑰；v1 /search 已下線）——
 *     GET https://api.tianditu.gov.cn/v2/search?postStr={…}&type=query&tk=…
 *     契約要點（2026-10-13 實測逐欄位核對）：status 為物件 { cndesc,
 *     infocode }（1000=正常，與 v1 字串形態不同，兩態防禦窄化）；pois[].
 *     lonlat 為 "lng,lat" 字串；無 distance 欄位；mapBound 語義為「優先」
 *     而非硬過濾（實測泛詞返回全國熱詞）；CGCS2000(≈WGS84) 座標系，
 *     入參 gcj02 先轉 wgs84 再查，上游 POI 座標再轉回 gcj02 出參（對稱）。
 *
 * 不論上游：距離語義全部由本端 haversine 後置計算（過濾 radiusM 內 + 升序
 * + 截取 limit），正確性不依賴任何上游過濾行為，兩條上游出參同構。
 *
 * 兩把金鑰均未配置或上游失敗時返回業務失敗 code 503（HTTP 200，不觸發
 * 小程序端網路層重試），小程序端 SKILL 以確定性模擬數據降級（卡片標識
 * 「模擬數據」，與天氣 SKILL 同構）。
 *
 * 快取（記憶體，實例級；key = 0.02° 網格座標 + 關鍵詞，TTL 10 分鐘——
 * POI 變動低頻，同位置同詞短期重複查詢高命中；上限 1000 條防無界增長；
 * 條目記錄回源上游，命中時透傳 source）。
 */

import type { RouteHandler } from './api';
import { ok, fail, badRequest } from './api';
import { gcj02ToWgs84, wgs84ToGcj02 } from './geo';

/** POI 快取 TTL：10 分鐘（門店級數據變動低頻） */
const POI_CACHE_TTL_MS = 10 * 60 * 1000;

/** 記憶體快取條目上限（超限淘汰最早插入者；Map 迭代序為插入序） */
const CACHE_MAX_ENTRIES = 1000;

/** 上游（天地圖）單次請求超時（與 geo.ts / skill-weather.ts 一致） */
const UPSTREAM_TIMEOUT_MS = 8_000;

/** 快取網格精度（度）：≈2.2km——POI 鄰域語義比城市級（geo.ts 0.05°）細 */
const POI_GRID_DEG = 0.02;

/** 預設搜尋半徑（米） */
const DEFAULT_RADIUS_M = 5_000;

/** 半徑允許區間（米）：過小召回不足，過大失「附近」語義 */
const MIN_RADIUS_M = 300;
const MAX_RADIUS_M = 20_000;

/** 預設返回條數與上限 */
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

/** 上游單次拉取條數：> limit 上限，過濾半徑後仍留足餘量 */
const UPSTREAM_COUNT = 30;

/** 地球平均半徑（米）——haversine 公式用 */
const EARTH_R_M = 6_371_000;

/** 緯度 1 度 ≈ 111320 米（經度隨緯度縮放，見 buildMapBound） */
const M_PER_DEG_LAT = 111_320;

/** 統一出參：單個 POI（與小程序端 map-tianditu SKILL 的 outputSchema 對齊） */
export interface PoiItem {
  name: string;
  address: string;
  phone?: string;
  /** gcj02 座標（已由上游 wgs84 轉回，供將來導航 / 地圖標點消費） */
  lat: number;
  lng: number;
  /** 距查詢中心直線距離（米，haversine 後置計算——上游無此欄位） */
  distanceM: number;
}

/** 回源上游標識（出參透傳，小程序端卡片以 source !== 'mock' 區分真實 / 模擬） */
export type PoiSource = 'tencent_lbs' | 'tianditu';

/** POI 快取條目（統一出參主體；keyword / radiusM 由入參回顯不參與快取） */
interface PoiCacheEntry {
  pois: PoiItem[];
  /** 回源時記錄的上游，命中時透傳（避免上游切換後快取條目源頭不明） */
  source: PoiSource;
  expireAt: number;
}

/** POI 快取（容器重啟即清空，可接受——上游僅查詢輔助） */
const poiCache = new Map<string, PoiCacheEntry>();

/** 座標網格化（與 geo.ts 同構公式；0.02° 粒度理由見 POI_GRID_DEG） */
function grid(v: number): string {
  return (Math.round(v / POI_GRID_DEG) * POI_GRID_DEG).toFixed(2);
}

/** 欄位窄化：字串（非空）才返回，否則 undefined（與 geo.ts 同構） */
function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * haversine 直線距離（米）
 *
 * 上游不返回 distance（實測無此欄位），「附近」的排序與過濾語義全部由
 * 此函數後置支撐——見檔頭契約要點第三條。
 */
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (deg: number): number => (deg / 180) * Math.PI;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 以中心座標 + 半徑構造上游 mapBound（"minLng,minLat,maxLng,maxLat"） */
function buildMapBound(lat: number, lng: number, radiusM: number): string {
  const dLat = radiusM / M_PER_DEG_LAT;
  const dLng = radiusM / (M_PER_DEG_LAT * Math.max(0.2, Math.cos((lat / 180) * Math.PI)));
  return [
    (lng - dLng).toFixed(6),
    (lat - dLat).toFixed(6),
    (lng + dLng).toFixed(6),
    (lat + dLat).toFixed(6),
  ].join(',');
}

/** 天地圖 v2 搜索回應（僅聲明消費欄位；status 兩態見檔頭契約要點） */
interface TdtSearchResp {
  status?: unknown;
  /** v2 形態：status 為物件 */
  pois?: unknown;
}

/** status 兩態窄化：v2 物件（infocode === 1000）或 v1 相容字串（'0'）皆成功 */
function isUpstreamOk(body: TdtSearchResp | null): boolean {
  const s = body?.status;
  if (s && typeof s === 'object' && 'infocode' in s) {
    return (s as { infocode?: unknown }).infocode === 1000;
  }
  return s === '0';
}

/*
 * 上游鑑權的雙跳策略（2026-10-13 實測）：天地圖金鑰分「服務端 / 瀏覽器端」
 * 類型，上游按 User-Agent 判定訪問來源——瀏覽器端 key 以 Node 預設 UA
 * （undici）訪問會被 403（code 301012「權限類型錯誤」），帶瀏覽器 UA 則放行。
 * 本服務的正式金鑰為「服務端」類型（見 .env.local 註釋），首跳以服務端身份
 * （預設 UA）請求；403 時以瀏覽器 UA 重試一次——兩類金鑰環境均可用，
 * 且不把瀏覽器 UA 常設（服務端 key 的正規調用姿態優先）。
 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 騰訊位置服務地點搜索回應（僅聲明消費欄位） */
interface TencentSearchResp {
  /** 0 成功；非 0 帶 message（199 / 311 / 110 等，見檔頭上游 A 契約要點） */
  status?: unknown;
  message?: unknown;
  data?: unknown;
}

/**
 * 呼叫騰訊位置服務地點搜索（座標原生 gcj02，零轉換——上游 A，見檔頭）
 *
 * boundary=nearby 半徑上限 1000 米為上游約束，固定 auto_extend=1 讓上游
 * 自動擴大召回；嚴格半徑語義由 lookupPois 的 haversine 後置過濾把關。
 * page_size 上限 20，與天地圖 UPSTREAM_COUNT=30 同量級。
 *
 * @returns 全部原始 POI（未過濾未排序，distanceM 佔位）；上游失敗返回 null
 */
async function callTencentSearch(
  keyword: string,
  lat: number,
  lng: number,
  key: string,
): Promise<PoiItem[] | null> {
  const url =
    `https://apis.map.qq.com/ws/place/v1/search?keyword=${encodeURIComponent(keyword)}` +
    `&boundary=nearby(${lat.toFixed(6)},${lng.toFixed(6)},1000,auto_extend=1)` +
    `&page_size=20&key=${key}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      console.error(`[map] 騰訊位置服務回應 HTTP ${resp.status}`);
      return null;
    }
    const body = (await resp.json().catch(() => null)) as TencentSearchResp | null;
    if (!body || body.status !== 0) {
      const msg = typeof body?.message === 'string' ? body.message : '';
      console.error(`[map] 騰訊位置服務業務失敗：status=${body?.status} ${msg}`);
      return null;
    }
    if (!Array.isArray(body.data)) return []; // 業務正常但零結果：空陣列語義
    // 防禦性逐項窄化：location 座標或 title 缺失的髒數據直接丟棄
    const items: PoiItem[] = [];
    for (const raw of body.data) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      const title = strOrUndef(p.title);
      const loc = p.location as { lat?: unknown; lng?: unknown } | undefined;
      if (!title || !loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
        continue;
      }
      items.push({
        name: title,
        address: strOrUndef(p.address) ?? '',
        phone: strOrUndef(p.tel),
        // 原生 gcj02，無需座標轉換（與天地圖鏈路的雙道轉換對比見檔頭）
        lat: Number(loc.lat.toFixed(6)),
        lng: Number(loc.lng.toFixed(6)),
        distanceM: 0, // 佔位，lookupPois 按中心統一 haversine 計算
      });
    }
    return items;
  } catch (e) {
    console.error('[map] 騰訊位置服務不可達：', e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 呼叫天地圖 v2 搜索（queryCenter 座標為 wgs84）
 *
 * @returns 全部原始 pois（未過濾未排序）；上游失敗返回 null
 */
async function callTiandituSearch(
  keyWord: string,
  lat: number,
  lng: number,
  radiusM: number,
  tk: string,
): Promise<PoiItem[] | null> {
  const postStr = JSON.stringify({
    keyWord,
    level: '18',
    mapBound: buildMapBound(lat, lng, radiusM),
    queryType: '1',
    start: '0',
    count: String(UPSTREAM_COUNT),
  });
  const url = `https://api.tianditu.gov.cn/v2/search?postStr=${encodeURIComponent(postStr)}&type=query&tk=${tk}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  /** 單次上游請求：headers 區分服務端 / 瀏覽器端姿態（雙跳策略見 BROWSER_UA 註釋） */
  const doFetch = async (headers: Record<string, string>): Promise<TdtSearchResp | null> => {
    const resp = await fetch(url, { headers, signal: controller.signal });
    if (!resp.ok) {
      console.error(`[map] 天地圖搜索回應 HTTP ${resp.status}`);
      return null;
    }
    return (await resp.json().catch(() => null)) as TdtSearchResp | null;
  };
  try {
    // 首跳：服務端身份（正式「服務端」金鑰的正規姿態）；403 時以瀏覽器 UA
    // 重試（兼容「瀏覽器端」金鑰，雙跳策略見 BROWSER_UA 區塊註釋）
    let body = await doFetch({});
    if (!body) {
      body = await doFetch({ 'User-Agent': BROWSER_UA });
    }
    if (!body || !isUpstreamOk(body)) {
      console.error('[map] 天地圖搜索業務失敗（status 非 1000 / 非 \'0\'）');
      return null;
    }
    if (!Array.isArray(body.pois)) return []; // 業務正常但零結果：空陣列語義
    // 防禦性逐項窄化：lonlat "lng,lat" 缺失或 name 缺失的髒數據直接丟棄
    const items: PoiItem[] = [];
    for (const raw of body.pois) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      const name = strOrUndef(p.name);
      const lonlat = strOrUndef(p.lonlat);
      if (!name || !lonlat) continue;
      const [lngStr, latStr] = lonlat.split(',');
      const poiLng = Number(lngStr);
      const poiLat = Number(latStr);
      if (Number.isNaN(poiLat) || Number.isNaN(poiLng)) continue;
      // 上游 wgs84 → gcj02（出參座標語義與入參對稱，見檔頭契約要點）
      const gcj = wgs84ToGcj02(poiLat, poiLng);
      items.push({
        name,
        address: strOrUndef(p.address) ?? '',
        phone: strOrUndef(p.phone),
        lat: Number(gcj.lat.toFixed(6)),
        lng: Number(gcj.lng.toFixed(6)),
        distanceM: 0, // 佔位，下方按中心（gcj02 原始入參）統一計算
      });
    }
    return items;
  } catch (e) {
    console.error('[map] 天地圖搜索不可達：', e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 快取查詢 + 未命中回源（含距離計算 / 半徑過濾 / 排序 / 截取）
 *
 * 快取粒度：條目存「按 MAX_RADIUS_M 預過濾的全量排序結果」而非當次
 * radiusM 過濾後的子集——否則先查 5km 再查 20km 會命中不完整數據
 * （範圍外條目已在首次寫入時被丟棄）；radiusM 不入快取 key，命中後
 * 按當次半徑現場過濾（上游 mapBound 語義為「優先」而非硬過濾，
 * 見檔頭契約要點，跨半徑復用同一份召回可接受）。
 *
 * @returns 按 distanceM 升序的 POI 列表；上游失敗返回 null（503 語義由呼叫方翻譯）
 */
async function lookupPois(
  keyword: string,
  lat: number,
  lng: number,
  radiusM: number,
  limit: number,
): Promise<{ pois: PoiItem[]; source: PoiSource } | null> {
  const cacheKey = `${grid(lat)},${grid(lng)},${keyword}`;
  const hit = poiCache.get(cacheKey);
  if (hit && Date.now() < hit.expireAt) {
    // 快取命中也重算距離：中心在網格內移動時距離值不同於快取時的計算基準
    return {
      source: hit.source,
      pois: hit.pois
        .map((p) => ({ ...p, distanceM: Math.round(haversineM(lat, lng, p.lat, p.lng)) }))
        .filter((p) => p.distanceM <= radiusM)
        .sort((a, b) => a.distanceM - b.distanceM)
        .slice(0, limit),
    };
  }

  // 雙上游選擇（見檔頭）：騰訊優先；騰訊未配置或調用失敗時若天地圖
  // 金鑰在則回落天地圖——「失敗」僅指請求 / 業務錯（null），零結果（[]）
  // 為正常語義不觸發回落。兩把金鑰皆無則交由 handler 統一翻譯為業務 503
  const tencentKey = process.env.TENCENT_LBS_KEY;
  const tdtKey = process.env.TIANDITU_KEY;
  if (!tencentKey && !tdtKey) return null;

  let source: PoiSource = 'tianditu';
  let raw: PoiItem[] | null = null;
  if (tencentKey) {
    raw = await callTencentSearch(keyword, lat, lng, tencentKey);
    if (raw) source = 'tencent_lbs';
  }
  if (!raw && tdtKey) {
    // 入參 gcj02 → wgs84（天地圖座標系，見檔頭上游 B 契約要點）
    const wgs = gcj02ToWgs84(lat, lng);
    raw = await callTiandituSearch(keyword, wgs.lat, wgs.lng, radiusM, tdtKey);
  }
  if (!raw) return null;

  // 快取條目按 MAX_RADIUS_M 預過濾（超過最大允許半徑的永遠用不到），
  // 不按當次 radiusM 截斷（快取粒度理由見本函數 JSDoc）
  const all = raw
    .map((p) => ({ ...p, distanceM: Math.round(haversineM(lat, lng, p.lat, p.lng)) }))
    .filter((p) => p.distanceM <= MAX_RADIUS_M)
    .sort((a, b) => a.distanceM - b.distanceM);

  poiCache.set(cacheKey, { pois: all, source, expireAt: Date.now() + POI_CACHE_TTL_MS });
  if (poiCache.size > CACHE_MAX_ENTRIES) {
    const oldest = poiCache.keys().next().value;
    if (oldest !== undefined) poiCache.delete(oldest);
  }
  return { source, pois: all.filter((p) => p.distanceM <= radiusM).slice(0, limit) };
}

/** POI 搜尋入參 */
interface PoiInput {
  keyword?: unknown;
  lat?: unknown;
  lng?: unknown;
  radiusM?: unknown;
  limit?: unknown;
}

const handleSearchPoi: RouteHandler = async (body) => {
  const input = (body ?? {}) as PoiInput;
  const { keyword } = input;
  if (typeof keyword !== 'string' || !keyword.trim() || keyword.trim().length > 20) {
    return badRequest('keyword 必填（非空，≤ 20 字）');
  }
  const { lat, lng } = input;
  if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) {
    return badRequest('lat / lng 必填且為數字');
  }
  // gcj02 僅定義於中國大陸境內（粗邊界），與 /api/geo/reverse 一致
  if (lat < 3 || lat > 54 || lng < 73 || lng > 136) {
    return badRequest('座標超出 gcj02 覆蓋範圍（中國大陸）');
  }
  const radiusRaw = input.radiusM;
  const radiusM =
    typeof radiusRaw === 'number' && !Number.isNaN(radiusRaw) ? radiusRaw : DEFAULT_RADIUS_M;
  if (radiusM < MIN_RADIUS_M || radiusM > MAX_RADIUS_M) {
    return badRequest(`radiusM 需在 ${MIN_RADIUS_M}~${MAX_RADIUS_M} 米之間`);
  }
  const limitRaw = input.limit;
  const limit = typeof limitRaw === 'number' && !Number.isNaN(limitRaw) ? limitRaw : DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return badRequest(`limit 需為 1~${MAX_LIMIT} 的整數`);
  }

  const result = await lookupPois(keyword.trim(), lat, lng, radiusM, limit);
  if (!result) {
    if (!process.env.TENCENT_LBS_KEY && !process.env.TIANDITU_KEY) {
      return fail(503, '未配置 TENCENT_LBS_KEY / TIANDITU_KEY，POI 搜尋不可用');
    }
    return fail(503, 'POI 搜尋上游失敗（服務不可達或業務錯誤）');
  }

  return ok({
    keyword: keyword.trim(),
    radiusM,
    pois: result.pois,
    source: result.source,
  });
};

export const mapRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/skill/skill.map.tianditu/search_poi', handleSearchPoi],
];
