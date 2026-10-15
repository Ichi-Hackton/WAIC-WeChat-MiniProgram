/**
 * 地圖 POI 搜尋 SKILL（skill.map.tianditu）
 *
 * 規範來源：.qoder/rules/Agent.md § 7.1
 *
 * 提供能力：
 *   - search_poi：按關鍵詞搜尋附近地點（便利店 / 藥店 / 列印店…；
 *     idempotent, no confirm, NOT reversible）
 *
 * 查詢中心雙模式（2026-10-14 擴展）：
 *   - 定位座標：規劃器從 ctx.userProfile.location 寫入 lat/lng（字面值）——
 *     與天氣 SKILL 同構，定位缺失時規劃器直接追問 / 引導授權，不生成任務
 *   - 家地址（address 文本）：「我家附近」語義由規劃器取地址簿默認收貨地址
 *     （ctx.userProfile.homeAddress）寫入 address，雲端先正向編碼成座標再查；
 *     地址模式失敗如實報錯（POI_SEARCH_FAILED），不做 mock 降級——
 *     用戶指定了明確位置，假數據會誤導
 *
 * 與雲端 skill-map.ts 的端點路徑逐字對齊（雲端雙上游：高德優先、天地圖
 * 兜底，出參 source 標識實際回源方）；座標模式下雲端不可用（負數碼 = 雲
 * 基礎設施錯誤）或兩把地圖金鑰（AMAP_KEY / TIANDITU_KEY）均未配置 /
 * 上游全部失敗（業務 503）時，以確定性模擬數據降級（djb2 雜湊 seed =
 * 關鍵詞 + 網格座標，同詞同位置演示數據穩定），卡片以 source='mock'
 * 標識「模擬數據」，不誤導用戶。
 */

import type { AgentContext } from '../../../types/context';
import type { SkillInstance, SkillResult, SkillMeta } from '../../../types/skill';
import { postContainer } from '../../../services/cloud';
import type { CloudResponse } from '../../../services/cloud';

export interface SearchPoiInput {
  /** 搜尋關鍵詞（如「便利店」；規劃器從意圖抽取寫入） */
  keyword: string;
  /** 緯度（gcj02，定位座標模式；規劃器從 ctx.userProfile.location 寫入） */
  lat?: number;
  /** 經度（gcj02，定位座標模式） */
  lng?: number;
  /** 查詢中心文本地址（家地址模式；規劃器從 ctx.userProfile.homeAddress.full
   *  寫入，雲端正向編碼解析座標；與 lat/lng 至少提供其一，兼有時座標優先） */
  address?: string;
  /** 搜尋半徑（米，可選；雲端預設 5000） */
  radiusM?: number;
  /** 返回條數（可選；雲端預設 5） */
  limit?: number;
}

export interface PoiItem {
  name: string;
  address: string;
  phone?: string;
  /** gcj02 座標（與入參座標語義對稱，供將來導航消費） */
  lat: number;
  lng: number;
  /** 距查詢中心直線距離（米） */
  distanceM: number;
}

export interface PoiSearchInfo {
  /** 回顯關鍵詞 */
  keyword: string;
  /** 搜尋半徑（米） */
  radiusM: number;
  /** 按距離升序的結果列表（半徑內無結果時為空陣列） */
  pois: PoiItem[];
  /** 數據源標識（amap / tianditu / mock），卡片以此區分即時 / 模擬 */
  source: 'amap' | 'tianditu' | 'mock';
}

export const meta = {
  id: 'skill.map.tianditu',
  name: '附近地點搜尋',
  description:
    '【能做】按關鍵詞搜尋指定中心附近的地點（search_poi：便利店、藥店、銀行、列印店、地鐵站等任意品類，返回名稱 / 地址 / 距離，按距離由近到遠）。查詢中心默認為當前定位座標（lat/lng，僅說「附近 / 周邊」時）；用戶明確提到地點時改用 address 文本：「我家 / 家附近 / 我的收貨地址」取上下文「家地址」行字面值，口述具體地址（如「XX路 / XX小區附近」）取意圖原文地址。' +
    '【不能做】不能查指定城市全域的地點（僅支援定位 / 家地址 / 指定地址周邊）、不能提供路線規劃與導航。' +
    '【觸發時機】用戶提到「附近 / 周邊 / 最近 / XX附近」+ 地點品類（如「附近有便利店嗎」「哪裡有打印店」「我家附近的藥店」「科技園南路附近的便利店」），且非星巴克 / 商城 / 預約等專屬域詞時。',
  version: '1.0.0',
  owner: 'wx-map-tianditu',
  tags: ['地圖', '生活'],
  capabilities: [
    {
      action: 'search_poi',
      description: '按查詢中心 + 關鍵詞搜尋附近地點（按距離升序；中心 = 定位座標或家地址二選一）',
      inputSchema: {
        type: 'object',
        required: ['keyword'],
        properties: {
          keyword: { type: 'string', description: '地點品類關鍵詞（如「便利店」）' },
          lat: { type: 'number', description: '緯度（gcj02，僅「附近」無地點限定時從用戶定位寫入）' },
          lng: { type: 'number', description: '經度（gcj02，與 lat 成對）' },
          address: { type: 'string', description: '查詢中心文本地址：「我家附近」取上下文「家地址」行字面值；用戶口述具體地址（「XX路 / XX小區附近」）取意圖原文地址；此時不填 lat/lng' },
          radiusM: { type: 'number', description: '搜尋半徑（米，預設 5000）' },
          limit: { type: 'number', description: '返回條數（預設 5）' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['keyword', 'pois'],
        properties: {
          keyword: { type: 'string', description: '回顯關鍵詞' },
          radiusM: { type: 'number', description: '搜尋半徑（米）' },
          pois: {
            type: 'array',
            description: '結果列表（按距離升序）',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '地點名稱' },
                address: { type: 'string', description: '地址' },
                phone: { type: 'string', description: '電話（可能缺失）' },
                lat: { type: 'number', description: '緯度（gcj02）' },
                lng: { type: 'number', description: '經度（gcj02）' },
                distanceM: { type: 'number', description: '距離（米）' },
              },
            },
          },
          source: { type: 'string', description: 'amap / tianditu / mock' },
        },
      },
      idempotent: true,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 2500,
    },
  ],
} as unknown as SkillMeta;

/** 模擬門市街道池（與城市名拼接構造演示地址） */
const MOCK_STREETS = ['中山路', '人民路', '建國路', '幸福大街', '科學園路'] as const;

/** 座標網格化粒度（度）：mock seed 用，微移座標不改變演示數據 */
const MOCK_GRID_DEG = 0.02;

/** djb2 雜湊（與天氣 / booking SKILL 共用同一算法約定，保證 mock 可復現） */
function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** 網格化座標（僅供 mock seed 構造） */
function grid(v: number): number {
  return Math.round(v / MOCK_GRID_DEG) * MOCK_GRID_DEG;
}

/**
 * 模擬 POI 搜索（確定性：seed = 關鍵詞 + 網格座標，同詞同位置穩定）
 *
 * 生成 3 家演示門店：距離 200~800 米（卡片標識「模擬數據」明示降級）。
 * 城市名取 ctx（可能缺失——缺失時地址以「當前位置」開頭）。
 * 僅座標模式調用（見 invokeSearchPoi 降級條件），入參型別收窄座標必在。
 */
function mockPoiSearch(input: SearchPoiInput & { lat: number; lng: number }, ctx: AgentContext): PoiSearchInfo {
  const city = ctx.userProfile.location?.city ?? '當前位置';
  const seed = hashStr(`${input.keyword}|${grid(input.lat)},${grid(input.lng)}`);
  const pois: PoiItem[] = [0, 1, 2].map((i) => {
    const s = seed + i * 97;
    return {
      name: `${input.keyword}（${['旗艦店', '便利店', '分店'][i % 3]}${i + 1}號）`,
      address: `${city}${MOCK_STREETS[s % MOCK_STREETS.length]}${10 + (s % 90)}號`,
      lat: Number((input.lat + ((s % 60) - 30) / 1000).toFixed(6)),
      lng: Number((input.lng + ((s % 80) - 40) / 1000).toFixed(6)),
      distanceM: 200 + ((s >>> 4) % 600),
    };
  });
  return { keyword: input.keyword, radiusM: input.radiusM ?? 5000, pois, source: 'mock' };
}

export const instance: SkillInstance = {
  meta,
  async invoke(action, input, ctx): Promise<SkillResult> {
    if (action !== 'search_poi') {
      return {
        success: false,
        error: { code: 'CAPABILITY_NOT_FOUND', message: `${action} 不支援`, retryable: false },
      };
    }
    // 防禦性窄化：入參已過 adapter schema 校驗（required keyword），此處兜底
    // 查詢中心雙模式：座標（lat+lng 成對）或地址（address 非空）至少其一
    const typed = input as Partial<SearchPoiInput>;
    const hasCoord =
      typeof typed.lat === 'number' &&
      !Number.isNaN(typed.lat) &&
      typeof typed.lng === 'number' &&
      !Number.isNaN(typed.lng);
    const addr = typeof typed.address === 'string' ? typed.address.trim() : '';
    if (typeof typed.keyword !== 'string' || !typed.keyword.trim() || (!hasCoord && !addr)) {
      return {
        success: false,
        error: {
          code: 'INVALID_LOCATION',
          message: '缺少關鍵詞或查詢中心（定位座標 / 家地址），請開啟定位或填寫收貨地址後重試',
          retryable: false,
        },
      };
    }
    return invokeSearchPoi(
      ctx.globals.cloudEnv as string,
      {
        keyword: typed.keyword.trim(),
        ...(hasCoord ? { lat: typed.lat, lng: typed.lng } : {}),
        ...(addr ? { address: addr } : {}),
        ...(typed.radiusM !== undefined ? { radiusM: typed.radiusM } : {}),
        ...(typed.limit !== undefined ? { limit: typed.limit } : {}),
      },
      ctx,
    );
  },
};

async function invokeSearchPoi(
  env: string,
  input: SearchPoiInput,
  ctx: AgentContext,
): Promise<SkillResult<PoiSearchInfo>> {
  const res: CloudResponse<PoiSearchInfo> = await postContainer<PoiSearchInfo>(
    env,
    '/api/skill/skill.map.tianditu/search_poi',
    input,
    { sessionId: ctx.sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  // 雲端不可用（負數碼）或地圖金鑰均未配置 / 上游全部失敗（業務 503，見
  // skill-map.ts）→ mock 降級：POI 為只讀查詢無副作用，卡片標識
  // 「模擬數據」明示，保證本地演示與自動化驗證鏈路完整。
  // 僅限座標模式——地址模式（用戶明確指定的位置）mock 出假位置會誤導，
  // 如實走失敗分支報錯（見檔頭「查詢中心雙模式」）
  if ((res.code < 0 || res.code === 503) && input.lat !== undefined && input.lng !== undefined) {
    return { success: true, data: mockPoiSearch({ ...input, lat: input.lat, lng: input.lng }, ctx) };
  }
  return {
    success: false,
    error: { code: 'POI_SEARCH_FAILED', message: res.message ?? '附近地點搜尋失敗', retryable: true },
  };
}
