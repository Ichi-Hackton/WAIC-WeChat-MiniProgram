/**
 * 逆地理編碼端點（天地圖 geocoder 代理）
 *
 * 端點（與小程序端 services/geo.ts 呼叫路徑逐字對齊）：
 *   POST /api/geo/reverse   body: { lat, lng }（gcj02 座標）
 *
 * 為什麼需要此端點：wx.getLocation 成功回應不含 city 欄位（官方僅返回
 * latitude / longitude / accuracy 等），userProfile.location.city 須經逆
 * 地理編碼補全；且規範 §7.1 禁止小程序端直接對接第三方 API，故由雲端代理。
 *
 * 上游（2026-10 修訂：地址獲取由高德切換天地圖；原 adcode 鏈路唯一消費方
 * 天氣已切華風愛科開放平台，高德 regeo / resolveAdcode / AMAP_KEY 隨之下線）：
 *   天地圖 geocoder —— TIANDITU_KEY（console.tianditu.gov.cn 申請「服務端」
 *   類型金鑰）。座標系為 CGCS2000（≈WGS84），上游呼叫前先做 gcj02 逆偏移
 *   轉換（見 gcj02ToWgs84 區塊註釋）
 *
 * 天地圖 API 契約要點（官文檔 lbs.tianditu.gov.cn/server/geocoding.html）：
 *   - GET https://api.tianditu.gov.cn/geocoder?postStr={...}&type=geocode&tk=金鑰
 *     postStr 為 URL 編碼 JSON：{ lon: 經度, lat: 緯度, ver: 1 }（lon 在前）
 *   - 密鑰參數名為 tk（官文檔表格寫 appkey，實際接口用 tk）
 *   - status 為字串 '0' 成功 / '1' 錯誤 / '404' 出錯（msg 帶原因）
 *   - addressComponent.city 為「省+市(+區)」組合串（如「北京市西城區」
 *     「河北省石家莊市」），無獨立 province 欄位——市級城市名由
 *     parseCityComponent 解析（見該函數區塊註釋）
 *
 * 未配置對應金鑰或上游失敗時返回業務失敗 code 503（HTTP 200，不觸發
 * 小程序端網路層重試——城市資訊為可選增強，不值得 3 次重試延遲），
 * 小程序端 city 保持 undefined 降級。
 *
 * 快取（記憶體，實例級；跨會話快取由小程序端 storage/cache.ts 承擔）：
 *   - key 為 0.05° 網格化座標（≈5.5km，城市尺度），同一網格僅請求上游一次
 *   - TTL 24h（座標對應的行政區劃短期不變）
 *   - 上限 1000 條，超限淘汰最早插入條目（防無界增長）
 */

import type { RouteHandler } from './api';
import { ok, fail, badRequest } from './api';

/** 網格精度（度）：≈5.5km，城市尺度快取粒度（與小程序端 services/geo.ts 一致） */
const GEO_GRID_DEG = 0.05;

/** 記憶體快取 TTL：24 小時 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 記憶體快取條目上限（超限淘汰最早插入者；Map 迭代序為插入序） */
const CACHE_MAX_ENTRIES = 1000;

/** 上游（天地圖）單次請求超時 */
const UPSTREAM_TIMEOUT_MS = 8_000;

/** 天地圖地址解析快取條目 */
interface ReverseCacheEntry {
  city: string;
  province?: string;
  expireAt: number;
}

/** 地址鏈路快取（天地圖；容器重啟即清空，可接受——小程序端另有持久快取兜底） */
const reverseCache = new Map<string, ReverseCacheEntry>();

/** 座標網格化（與小程序端一致公式；toFixed(2) 消除浮點誤差後作快取 key） */
function grid(v: number): string {
  return (Math.round(v / GEO_GRID_DEG) * GEO_GRID_DEG).toFixed(2);
}

/*
 * GCJ-02 → WGS-84 逆偏移轉換（天地圖鏈路前置）
 *
 * 設計理由：天地圖採用 CGCS2000 國家大地座標系（與 WGS-84 差異為釐米級，
 * 業界慣例視為等同），而小程序端 wx.getLocation({ type: 'gcj02' }) 全鏈路
 * 傳遞火星座標（GCJ-02），兩者偏移約 50~500 米；不轉換直接查詢時，市界 /
 * 縣界附近的座標會解析到相鄰行政區，污染城市名。此處採用國測局偏移模型的
 * 一階近似逆解（以偏移後座標的偏移量一次相減），誤差約 1~2 米，對城市級
 * 逆地理編碼足夠。轉換封裝於雲端，小程序端座標語義不變（gcj02）。
 */
const KRASOVSKY_A = 6378245; // 克拉索夫斯基橢球長半軸（國測局偏移模型基準）
const KRASOVSKY_EE = 0.00669342162296594323; // 第一偏心率平方

/** 國測局偏移模型：緯度方向偏移分量 */
function transformLat(x: number, y: number): number {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  ret += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return ret;
}

/** 國測局偏移模型：經度方向偏移分量 */
function transformLng(x: number, y: number): number {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  ret += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return ret;
}

/** gcj02（火星座標）→ wgs84 / cgcs2000（天地圖座標系）；一階近似誤差 1~2 米 */
function gcj02ToWgs84(lat: number, lng: number): { lat: number; lng: number } {
  const dLat = transformLat(lng - 105, lat - 35);
  const dLng = transformLng(lng - 105, lat - 35);
  const radLat = (lat / 180) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - KRASOVSKY_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  const dLatDeg = (dLat * 180) / (((KRASOVSKY_A * (1 - KRASOVSKY_EE)) / (magic * sqrtMagic)) * Math.PI);
  const dLngDeg = (dLng * 180) / ((KRASOVSKY_A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: lat - dLatDeg, lng: lng - dLngDeg };
}

/*
 * 天地圖 addressComponent.city 組合串解析（省+市[+區] → 市級城市名）
 *
 * 設計理由：天地圖 geocoder 的 city 欄位是行政區層級拼接串，無獨立的
 * province / city 分欄（與高德不同）。消費方（Planner「附近」推理、天氣
 * 卡片城市名）期望市級粒度，且直轄市語義須與高德版對齊（city=「北京市」
 * 而非「北京市西城區」），否則出參契約漂移會污染下游提示詞與快取。
 * 匹配常量一律用簡體——上游響應為簡體，繁體匹配必失敗。
 *
 * 已知形態（按優先級匹配）：
 *   - 直轄市：「北京市西城區」→ province = city =「北京市」
 *   - 特別行政區：「香港特別行政區」→ province=原串、city=去後綴
 *   - 省：「河北省石家莊市[橋西區]」→ province=「河北省」、city=「石家莊市」
 *   - 自治區：「廣西壯族自治區南寧市[青秀區]」→ province=「廣西壯族自治區」、city=「南寧市」
 *   - 解析不出市級（海上 / 邊界 / 上游改版）：city=原串、province=undefined
 *     ——保證「有總比沒有強」的降級語義，而非整體失敗
 */
const MUNICIPALITIES = ['北京市', '上海市', '天津市', '重庆市'];
const SPECIAL_ADMIN_REGIONS = ['香港特别行政区', '澳门特别行政区'];

/** 組合串 → { 市級城市名, 省級名 }（見上方區塊註釋） */
function parseCityComponent(raw: string): { city: string; province?: string } {
  const s = raw.trim();
  for (const m of MUNICIPALITIES) {
    if (s.startsWith(m)) return { city: m, province: m };
  }
  for (const r of SPECIAL_ADMIN_REGIONS) {
    if (s.startsWith(r)) return { city: r.replace('特别行政区', ''), province: r };
  }
  // 省 / 自治區前綴：第一個「省|自治区」為省級界，其後第一個「市」為市級
  const mProv = s.match(/^(.*?(?:省|自治区))/);
  if (mProv) {
    const province = mProv[1];
    const rest = s.slice(province.length);
    const mCity = rest.match(/^(.*?市)/);
    const city = mCity ? mCity[1] : rest;
    if (city) return { city, province };
  }
  return { city: s };
}

/** 欄位窄化：字串（非空）才返回，否則 undefined（缺失 / 空值統一歸 undefined） */
function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** 天地圖 geocoder 回應（僅聲明消費欄位） */
interface TdtGeocoderResp {
  status?: string;
  msg?: string;
  result?: {
    addressComponent?: {
      city?: unknown;
      /** 部分版本 / 形態會返回獨立 province，存在時優先於組合串解析 */
      province?: unknown;
    };
  };
}

/**
 * 呼叫天地圖逆地理編碼（geocoder, type=geocode）
 *
 * GET https://api.tianditu.gov.cn/geocoder?postStr={lon,lat,ver}&type=geocode&tk=金鑰
 *   - postStr 為 URL 編碼 JSON，lon（經度）在前
 *   - status='0' 成功；'1' / '404' 為上游業務失敗（msg 帶原因）
 *   - 座標系 CGCS2000：呼叫前先 gcj02 → wgs84 逆偏移（見模組頭註釋）
 *
 * @returns 市級城市資訊；金鑰未配置 / 網路失敗 / 業務失敗 / 城市不可解析時返回 null
 */
async function callTiandituGeocoder(
  lat: number,
  lng: number,
): Promise<{ city: string; province?: string } | null> {
  const tk = process.env.TIANDITU_KEY;
  if (!tk) return null; // 金鑰未配置：由 handler 統一翻譯為業務 503

  const wgs = gcj02ToWgs84(lat, lng);
  const postStr = JSON.stringify({ lon: wgs.lng.toFixed(6), lat: wgs.lat.toFixed(6), ver: 1 });
  const url = `https://api.tianditu.gov.cn/geocoder?postStr=${encodeURIComponent(postStr)}&type=geocode&tk=${tk}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      console.error(`[geo] 天地圖服務回應 HTTP ${resp.status}`);
      return null;
    }
    const body = (await resp.json().catch(() => null)) as TdtGeocoderResp | null;
    if (!body || body.status !== '0') {
      console.error(`[geo] 天地圖服務業務失敗：status=${body?.status} ${body?.msg ?? ''}`);
      return null;
    }
    const comp = body.result?.addressComponent;
    const rawCity = strOrUndef(comp?.city);
    const province = strOrUndef(comp?.province);
    if (!rawCity && !province) {
      console.error('[geo] 天地圖解析結果缺少 city / province（邊緣座標或境外）');
      return null;
    }
    if (!rawCity) {
      // city 缺失但 province 存在（上方已排除兩者皆空）：直轄市回退語義（與高德版同構）
      return province ? { city: province, province } : null;
    }
    // 常規路徑：組合串解析市級；獨立 province 欄位存在時優先
    const parsed = parseCityComponent(rawCity);
    return { city: parsed.city, province: province ?? parsed.province };
  } catch (e) {
    console.error('[geo] 天地圖服務不可達：', e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 地址鏈路快取查詢 + 未命中回源天地圖（handleReverse 專用）
 *
 * @returns 快取或上游解析結果；金鑰未配置 / 上游失敗時返回 null（503 語義由呼叫方翻譯）
 */
async function lookupReverse(lat: number, lng: number): Promise<ReverseCacheEntry | null> {
  // 命中快取直接返回（過期條目視為未命中，下次成功後覆寫）
  const cacheKey = `${grid(lat)},${grid(lng)}`;
  const hit = reverseCache.get(cacheKey);
  if (hit && Date.now() < hit.expireAt) {
    return hit;
  }

  // 未命中：以原始座標（非網格中心）請求上游，保證解析精度
  const resolved = await callTiandituGeocoder(lat, lng);
  if (!resolved) {
    return null;
  }

  reverseCache.set(cacheKey, { ...resolved, expireAt: Date.now() + CACHE_TTL_MS });
  if (reverseCache.size > CACHE_MAX_ENTRIES) {
    const oldest = reverseCache.keys().next().value;
    if (oldest !== undefined) reverseCache.delete(oldest);
  }
  return reverseCache.get(cacheKey) ?? null;
}

/** 逆地理編碼入參 */
interface ReverseInput {
  lat?: unknown;
  lng?: unknown;
}

const handleReverse: RouteHandler = async (body) => {
  const input = (body ?? {}) as ReverseInput;
  const { lat, lng } = input;
  if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) {
    return badRequest('lat / lng 必填且為數字');
  }
  // gcj02 僅定義於中國大陸境內（粗邊界），超界座標必解析失敗，提前拒絕省上游配額
  if (lat < 3 || lat > 54 || lng < 73 || lng > 136) {
    return badRequest('座標超出 gcj02 覆蓋範圍（中國大陸）');
  }

  const entry = await lookupReverse(lat, lng);
  if (!entry) {
    // 金鑰未配置與上游失敗共用業務 503：呼叫方一律降級為無城市
    if (!process.env.TIANDITU_KEY) {
      return fail(503, '未配置 TIANDITU_KEY，逆地理編碼不可用');
    }
    return fail(503, '逆地理編碼上游失敗（座標無法解析或服務不可達）');
  }

  return ok({ city: entry.city, province: entry.province });
};

export const geoRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/geo/reverse', handleReverse],
];
