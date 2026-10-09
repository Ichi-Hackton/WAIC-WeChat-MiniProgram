/**
 * 天氣查詢 SKILL
 *
 * 規範來源：.qoder/rules/Agent.md § 7.1
 *
 * 提供能力：
 *   - get_weather：查當前位置實時天氣（idempotent, no confirm, NOT reversible）
 *
 * 座標來源：規劃器從 ctx.userProfile.location 寫入 input（字面值）
 * ——位置由 core/context.ts 的 fetchLocation
 * 構建（wx.getLocation 座標 + 雲端逆地理編碼城市名）；定位缺失時規劃器
 * 直接追問用戶，不生成任務。
 *
 * 與雲端 skill-weather.ts 的端點路徑逐字對齊；雲端不可用（負數碼 =
 * 雲基礎設施錯誤，見 coffee SKILL 說明）或 WEATHERCN_KEY 未配置 /
 * 上游失敗（業務 503）時，以確定性模擬數據降級（djb2 雜湊 seed = 日期 +
 * 網格座標，同日同位置演示數據穩定），卡片以 source='mock' 標識「模擬數
 * 據」，不誤導用戶。
 */

import type { AgentContext } from '../../../types/context';
import type { SkillInstance, SkillResult, SkillMeta } from '../../../types/skill';
import { postContainer } from '../../../services/cloud';
import type { CloudResponse } from '../../../services/cloud';
import { formatDate } from '../../../utils/datetime';

export interface GetWeatherInput {
  /** 緯度（gcj02，規劃器從 ctx.userProfile.location 寫入） */
  lat: number;
  /** 經度（gcj02） */
  lng: number;
}

export interface WeatherInfo {
  city: string;
  province?: string;
  /** 天氣現象（晴 / 多雲 / 小雨…） */
  weather: string;
  /** 溫度（攝氏度，字串形態） */
  temperature: string;
  /** 濕度（百分比，字串形態） */
  humidity: string;
  windDirection: string;
  /** 風速（上游公制文案，如「12 km/h」） */
  windPower: string;
  /** 數據發布時間（如 "2026-10-09 14:32:00"） */
  reportTime: string;
  /** 數據源標識（weathercn_realtime / mock），卡片以此區分即時 / 模擬 */
  source: 'weathercn_realtime' | 'mock';
}

export const meta = {
  id: 'skill.weather.query',
  name: '天氣查詢',
  description:
    '【能做】查詢用戶當前位置的實時天氣（get_weather：溫度、濕度、天氣現象、風向風力）。' +
    '【不能做】不能查指定城市的天氣（僅支援當前定位）、不能查未來天氣預報。' +
    '【觸發時機】用戶提到「天氣 / 現在幾度 / 濕度 / 會不會下雨」等。',
  version: '1.0.0',
  owner: 'wx-weather-mock',
  tags: ['天氣', '生活'],
  capabilities: [
    {
      action: 'get_weather',
      description: '按座標查當前位置實時天氣（實況）',
      inputSchema: {
        type: 'object',
        required: ['lat', 'lng'],
        properties: {
          lat: { type: 'number', description: '緯度（gcj02，規劃器從用戶位置寫入）' },
          lng: { type: 'number', description: '經度（gcj02）' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['weather', 'temperature'],
        properties: {
          city: { type: 'string', description: '城市名（定位城市未知時可能為佔位文案）' },
          weather: { type: 'string', description: '天氣現象（晴 / 多雲 / 小雨…）' },
          temperature: { type: 'string', description: '溫度（攝氏度）' },
          humidity: { type: 'string', description: '濕度（%）' },
          windDirection: { type: 'string', description: '風向' },
          windPower: { type: 'string', description: '風速（如 12 km/h）' },
          reportTime: { type: 'string', description: '數據發布時間' },
          source: { type: 'string', description: 'weathercn_realtime / mock' },
        },
      },
      idempotent: true,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 1000,
    },
  ],
} as unknown as SkillMeta;

/** 模擬天氣現象池（與實況常見形態對齊） */
const MOCK_CONDITIONS = ['晴', '多雲', '陰', '小雨'] as const;

/** 模擬風向池 */
const MOCK_WINDS = ['東北', '東', '東南', '南'] as const;

/** 座標網格化粒度（度）：mock seed 用，微移座標不改變演示數據 */
const MOCK_GRID_DEG = 0.05;

/** djb2 雜湊（與 booking SKILL 共用同一算法約定，保證 mock 降級可復現） */
function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** 網格化座標（與雲端 geo.ts 同公式，僅供 mock seed 構造） */
function grid(v: number): number {
  return Math.round(v / MOCK_GRID_DEG) * MOCK_GRID_DEG;
}

/**
 * 模擬實況（確定性：seed = 日期 + 網格座標，同日同位置穩定）
 *
 * 城市名取 ctx.userProfile.location.city（context 構建時逆地理編碼補全，
 * 可能缺失——缺失時以「當前位置」佔位，卡片不展示技術性空值）。
 */
function mockWeather(input: GetWeatherInput, ctx: AgentContext): WeatherInfo {
  const now = new Date();
  const date = formatDate(now);
  const seed = hashStr(`${date}|${grid(input.lat)},${grid(input.lng)}`);
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return {
    city: ctx.userProfile.location?.city ?? '當前位置',
    weather: MOCK_CONDITIONS[seed % MOCK_CONDITIONS.length],
    temperature: String(12 + ((seed >>> 3) % 16)),
    humidity: String(40 + ((seed >>> 6) % 40)),
    windDirection: MOCK_WINDS[(seed >>> 9) % MOCK_WINDS.length],
    windPower: '≤3',
    reportTime: `${date} ${hh}:${mm}`,
    source: 'mock',
  };
}

export const instance: SkillInstance = {
  meta,
  async invoke(action, input, ctx): Promise<SkillResult> {
    if (action !== 'get_weather') {
      return {
        success: false,
        error: { code: 'CAPABILITY_NOT_FOUND', message: `${action} 不支援`, retryable: false },
      };
    }
    // 防禦性窄化：入參已過 adapter schema 校驗（required lat/lng），此處兜底
    const typed = input as Partial<GetWeatherInput>;
    if (typeof typed.lat !== 'number' || typeof typed.lng !== 'number') {
      return {
        success: false,
        error: {
          code: 'LOCATION_UNAVAILABLE',
          message: '缺少定位座標，請開啟定位權限後重試',
          retryable: false,
        },
      };
    }
    return invokeGetWeather(ctx.globals.cloudEnv as string, { lat: typed.lat, lng: typed.lng }, ctx);
  },
};

async function invokeGetWeather(
  env: string,
  input: GetWeatherInput,
  ctx: AgentContext,
): Promise<SkillResult<WeatherInfo>> {
  const res: CloudResponse<WeatherInfo> = await postContainer<WeatherInfo>(
    env,
    '/api/skill/skill.weather.query/get_weather',
    input,
    { sessionId: ctx.sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  // 雲端不可用（負數碼）或 WEATHERCN_KEY 未配置 / 上游失敗（業務 503，見
  // skill-weather.ts）→ mock 降級：天氣為只讀查詢無副作用，卡片標識
  // 「模擬數據」明示，保證本地演示與自動化驗證鏈路完整
  if (res.code < 0 || res.code === 503) {
    return { success: true, data: mockWeather(input, ctx) };
  }
  return {
    success: false,
    error: { code: 'WEATHER_QUERY_FAILED', message: res.message ?? '天氣查詢失敗', retryable: true },
  };
}
