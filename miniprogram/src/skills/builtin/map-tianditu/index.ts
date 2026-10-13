/**
 * 地圖 POI 搜尋 SKILL（skill.map.tianditu）
 *
 * 規範來源：.qoder/rules/Agent.md § 7.1
 *
 * 提供能力：
 *   - search_poi：按關鍵詞搜尋附近地點（便利店 / 藥店 / 列印店…；
 *     idempotent, no confirm, NOT reversible）
 *
 * 座標來源：規劃器從 ctx.userProfile.location 寫入 input（字面值）——
 * 與天氣 SKILL 同構，定位缺失時規劃器直接追問 / 引導授權，不生成任務。
 *
 * 與雲端 skill-map.ts 的端點路徑逐字對齊（雲端雙上游：騰訊位置服務優先、
 * 天地圖兜底，出參 source 標識實際回源方）；雲端不可用（負數碼 = 雲基礎
 * 設施錯誤）或兩把地圖金鑰（TENCENT_LBS_KEY / TIANDITU_KEY）均未配置 /
 * 上游全部失敗（業務 503）時，以確定性模擬數據
 * 降級（djb2 雜湊 seed = 關鍵詞 + 網格座標，同詞同位置演示數據穩定），
 * 卡片以 source='mock' 標識「模擬數據」，不誤導用戶。
 */

import type { AgentContext } from '../../../types/context';
import type { SkillInstance, SkillResult, SkillMeta } from '../../../types/skill';
import { postContainer } from '../../../services/cloud';
import type { CloudResponse } from '../../../services/cloud';

export interface SearchPoiInput {
  /** 搜尋關鍵詞（如「便利店」；規劃器從意圖抽取寫入） */
  keyword: string;
  /** 緯度（gcj02，規劃器從 ctx.userProfile.location 寫入） */
  lat: number;
  /** 經度（gcj02） */
  lng: number;
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
  /** 數據源標識（tencent_lbs / tianditu / mock），卡片以此區分即時 / 模擬 */
  source: 'tencent_lbs' | 'tianditu' | 'mock';
}

export const meta = {
  id: 'skill.map.tianditu',
  name: '附近地點搜尋',
  description:
    '【能做】按關鍵詞搜尋用戶當前位置附近的地點（search_poi：便利店、藥店、銀行、列印店、地鐵站等任意品類，返回名稱 / 地址 / 距離，按距離由近到遠）。' +
    '【不能做】不能查指定城市（僅支援當前定位周邊）、不能提供路線規劃與導航。' +
    '【觸發時機】用戶提到「附近 / 周邊 / 最近」+ 地點品類（如「附近有便利店嗎」「哪裡有打印店」），且非星巴克 / 商城 / 預約等專屬域詞時。',
  version: '1.0.0',
  owner: 'wx-map-tianditu',
  tags: ['地圖', '生活'],
  capabilities: [
    {
      action: 'search_poi',
      description: '按座標 + 關鍵詞搜尋附近地點（按距離升序）',
      inputSchema: {
        type: 'object',
        required: ['keyword', 'lat', 'lng'],
        properties: {
          keyword: { type: 'string', description: '地點品類關鍵詞（如「便利店」）' },
          lat: { type: 'number', description: '緯度（gcj02，規劃器從用戶位置寫入）' },
          lng: { type: 'number', description: '經度（gcj02）' },
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
          source: { type: 'string', description: 'tencent_lbs / tianditu / mock' },
        },
      },
      idempotent: true,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 1500,
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
 */
function mockPoiSearch(input: SearchPoiInput, ctx: AgentContext): PoiSearchInfo {
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
    // 防禦性窄化：入參已過 adapter schema 校驗（required keyword/lat/lng），此處兜底
    const typed = input as Partial<SearchPoiInput>;
    if (
      typeof typed.keyword !== 'string' ||
      !typed.keyword.trim() ||
      typeof typed.lat !== 'number' ||
      typeof typed.lng !== 'number'
    ) {
      return {
        success: false,
        error: {
          code: 'INVALID_LOCATION',
          message: '缺少關鍵詞或定位座標，請開啟定位權限後重試',
          retryable: false,
        },
      };
    }
    return invokeSearchPoi(
      ctx.globals.cloudEnv as string,
      {
        keyword: typed.keyword.trim(),
        lat: typed.lat,
        lng: typed.lng,
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
  // 雲端不可用（負數碼）或 TIANDITU_KEY 未配置 / 上游失敗（業務 503，見
  // skill-map.ts）→ mock 降級：POI 為只讀查詢無副作用，卡片標識
  // 「模擬數據」明示，保證本地演示與自動化驗證鏈路完整
  if (res.code < 0 || res.code === 503) {
    return { success: true, data: mockPoiSearch(input, ctx) };
  }
  return {
    success: false,
    error: { code: 'POI_SEARCH_FAILED', message: res.message ?? '附近地點搜尋失敗', retryable: true },
  };
}
