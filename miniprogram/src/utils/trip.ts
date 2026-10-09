/**
 * 行程槽位（純函數）
 *
 * 規範來源：.qoder/rules/Agent.md § 12.3（utils 純函數約束，不得 import wx.*）
 *
 * 「行程規劃工作流」的意圖判定與三要素收集：
 *   - isTripIntent：識別「什麼時候去什麼地方幹什麼」複合意圖
 *   - extractTripSlots：從對話歷史倒序合併 date / city / activity 三槽位
 *     （與 utils/passenger.ts 的 extractPassenger 同構——多輪追問的槽位
 *     累積完全由對話原文承載，不新增運行時狀態，狀態機零改動）
 *   - missingSlotPrompt：槽位缺失時的追問文案（一次只問一個缺口）
 *
 * 活動槽位只存「泛詞描述」（演唱會 / 話劇 / 球賽…），不解析演示目錄——
 * 演示目錄命中（ev_001 等）由規劃層（rule-planner / LLM）在生成任務時
 * 自行判定，本模組與業務目錄解耦。
 */

import { addDays, formatDate, resolveWeekday } from './datetime';

/** 對話訊息的最小結構（避免耦合 context.d.ts 的完整定義） */
interface MsgLike {
  role: string;
  content: string;
}

/** 行程三要素槽位（部分填充形態；齊全判定見 missingSlotPrompt） */
export interface TripSlots {
  /** 活動日 YYYY-MM-DD（已從口語解析） */
  date?: string;
  /** 口語日期標籤（如「下周六」，時間線展示用） */
  dateLabel?: string;
  /** 目標城市（規範名，如「广州」） */
  city?: string;
  /** 活動泛詞描述（如「看一場演唱會」） */
  activity?: string;
}

/* ============ 城市表（別名 → 規範名 + 中心座標） ============ */

/**
 * 城市中心座標演示表（gcj02 近似值）
 *
 * 用途：行程 DAG 的 get_weather 目標城市座標（weather SKILL 僅支援
 * lat/lng 入參）。座標為演示精度，正式環境應由雲端地理編碼服務提供。
 */
const CITY_TABLE: Array<{ keys: string[]; name: string; lat: number; lng: number }> = [
  { keys: ['北京'], name: '北京', lat: 39.9042, lng: 116.4074 },
  { keys: ['上海', '滬', '沪'], name: '上海', lat: 31.2304, lng: 121.4737 },
  { keys: ['廣州', '广州'], name: '广州', lat: 23.1291, lng: 113.2644 },
  { keys: ['深圳', '鵬城', '鹏城'], name: '深圳', lat: 22.5431, lng: 114.0579 },
  { keys: ['杭州'], name: '杭州', lat: 30.2741, lng: 120.1551 },
  { keys: ['南京'], name: '南京', lat: 32.0603, lng: 118.7969 },
  { keys: ['成都', '蓉城'], name: '成都', lat: 30.5728, lng: 104.0668 },
  { keys: ['武漢', '武汉'], name: '武汉', lat: 30.5928, lng: 114.3055 },
  { keys: ['西安'], name: '西安', lat: 34.3416, lng: 108.9398 },
  { keys: ['重慶', '重庆'], name: '重庆', lat: 29.563, lng: 106.5516 },
  { keys: ['天津'], name: '天津', lat: 39.3434, lng: 117.3616 },
  { keys: ['長沙', '长沙'], name: '长沙', lat: 28.2282, lng: 112.9388 },
  { keys: ['鄭州', '郑州'], name: '郑州', lat: 34.7466, lng: 113.6254 },
  { keys: ['青島', '青岛'], name: '青岛', lat: 36.0671, lng: 120.3826 },
  { keys: ['廈門', '厦门', '鷺島', '鹭岛'], name: '厦门', lat: 24.4798, lng: 118.0894 },
  { keys: ['昆明'], name: '昆明', lat: 24.8801, lng: 102.8329 },
];

/** 城市資訊（規範名 + 座標） */
export interface CityInfo {
  name: string;
  lat: number;
  lng: number;
}

/** 從文本提取首個命中的城市（規範名 + 演示座標） */
export function extractCity(text: string): CityInfo | null {
  for (const c of CITY_TABLE) {
    for (const k of c.keys) {
      if (text.includes(k)) return { name: c.name, lat: c.lat, lng: c.lng };
    }
  }
  return null;
}

/* ============ 活動詞表（泛詞；目錄解析留給規劃層） ============ */

/**
 * 活動詞 → 展示描述
 *
 * 展示描述用於行程卡 / 追問確認（如「看一場演唱會」）；活動僅存泛詞，
 * 目錄檢索與任務生成由規劃層按泛詞自行展開。
 */
const ACTIVITY_TABLE: Array<{ re: RegExp; label: string }> = [
  { re: /演唱會|演唱会|演出/, label: '看一場演出' },
  { re: /音[樂乐]節|音乐节/, label: '看音樂節' },
  { re: /話[劇剧]/, label: '看話劇' },
  { re: /音[樂乐][劇剧]/, label: '看音樂劇' },
  { re: /球賽|球赛|比賽|比赛|CBA/, label: '看球賽' },
  { re: /咖啡|拿[铁鐵]|美式|摩卡/, label: '喝杯咖啡' },
  { re: /羽毛球|游泳|泳池|潔牙|洁牙|體檢|体检|理髮|理发|剪髮|剪发/, label: '生活服務預約' },
];

/** 活動槽位提取結果：展示描述 */
export interface ActivityInfo {
  label: string;
}

/** 從文本提取活動泛詞（未命中返回 null） */
export function extractActivity(text: string): ActivityInfo | null {
  for (const a of ACTIVITY_TABLE) {
    if (a.re.test(text)) return { label: a.label };
  }
  return null;
}

/* ============ 日期槽位 ============ */

/**
 * 從文本提取日期槽位：字面 YYYY-MM-DD > 星期詞 > 相對詞（今天 / 明天 /
 * 後天），dateLabel 取口語原文片段；未命中返回 null
 */
function extractDateSlot(
  text: string,
  now: Date = new Date(),
): { date: string; dateLabel: string } | null {
  const literal = /\d{4}-\d{2}-\d{2}/.exec(text);
  if (literal) return { date: literal[0], dateLabel: literal[0] };

  const weekday = resolveWeekday(text, now);
  if (weekday) return { date: weekday.date, dateLabel: weekday.label };

  if (/後天|后天/.test(text)) return { date: formatDate(addDays(now, 2)), dateLabel: '後天' };
  if (/明天/.test(text)) return { date: formatDate(addDays(now, 1)), dateLabel: '明天' };
  if (/今天/.test(text)) return { date: formatDate(now), dateLabel: '今天' };
  return null;
}

/* ============ 意圖判定 ============ */

/** 交通域詞：命中走既有單域規劃（用戶已明確交通方式，不展開行程模板） */
const TRANSPORT_RE =
  /高[铁鐵]|动[车車]|火[车車]|[车車][次票]|12306|機票|机票|航班|飛機|飞机|飛往|飞往|搭機|搭机|坐飛|坐飞/;

/** 支付意圖詞：行程判定前的硬排除（訂單卡指令攜帶域詞，防誤展開） */
const PAY_RE = /支付|付款/;

/** 清單查詢詞：只讀列表意圖，非行程 */
const LIST_QUERY_RE = /我的(預約|预约|門票|门票|票務|票务|演出票|行程)/;

/** 天氣域詞：純天氣查詢走單域（「明天上海天氣如何」非行程） */
const WEATHER_RE = /天氣|天气|氣溫|气温|溫度|温度|幾度|几度|下雨/;

/** 位移詞（行程複合意圖的必要條件；「飛往 / 坐飛」已歸交通域詞） */
const MOVE_RE = /去|到|出差/;

/**
 * 行程複合意圖判定：什麼時候去什麼地方幹什麼
 *
 * 判定式：位移詞 且（城市詞 或 日期詞），且非以下排除項——
 *   - 支付 / 清單查詢 / 天氣 / 交通域詞（後者已有明確交通意圖，走單域
 *     規劃，避免行程模板與火車 / 機票分支雙觸發產生重複任務鏈）
 *
 * 僅有位移詞而無城市且無日期（如「去樓下買杯咖啡」）不觸發；
 * 有位移 + 城市 / 日期但缺活動（如「下周去北京」）觸發，由上層追問活動。
 */
export function isTripIntent(intent: string): boolean {
  if (PAY_RE.test(intent)) return false;
  if (LIST_QUERY_RE.test(intent)) return false;
  if (WEATHER_RE.test(intent)) return false;
  if (TRANSPORT_RE.test(intent)) return false;
  if (!MOVE_RE.test(intent)) return false;
  return extractCity(intent) !== null || extractDateSlot(intent) !== null;
}

/* ============ 槽位合併提取 ============ */

/**
 * 從對話歷史倒序合併三槽位（最近一次提供的值優先）
 *
 * 與 extractPassenger 同構：多輪追問（「下周去北京」→「看話劇」）的
 * 槽位累積完全由對話原文承載；assistant 追問文案不參與提取（僅掃 user
 * 訊息），避免追問文案中的示例詞反過來污染槽位。
 *
 * @param messages 對話歷史（ctx.messages 或測試構造）
 * @param intent 本輪用戶輸入（等價於最後一條 user 訊息，防呼叫方未先入列）
 */
export function extractTripSlots(messages: MsgLike[], intent: string): TripSlots {
  const slots: TripSlots = {};
  // 倒序掃描：最新的訊息先提取，各槽位取最近一次提供的值
  const userTexts = [intent];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') userTexts.push(messages[i].content);
  }
  for (const text of userTexts) {
    if (!slots.date) {
      const d = extractDateSlot(text);
      if (d) {
        slots.date = d.date;
        slots.dateLabel = d.dateLabel;
      }
    }
    if (!slots.city) {
      const c = extractCity(text);
      if (c) slots.city = c.name;
    }
    if (!slots.activity) {
      const a = extractActivity(text);
      if (a) slots.activity = a.label;
    }
    if (slots.date && slots.city && slots.activity) break;
  }
  return slots;
}

/**
 * 槽位缺失追問文案（一次只問一個缺口：date → city → activity）
 *
 * @returns 追問文案；三要素齊全返回 null
 */
export function missingSlotPrompt(slots: TripSlots): string | null {
  if (!slots.date) {
    return '想安排在哪一天？可以說「周六」「下周三」或具體日期（如 2026-10-11）。';
  }
  if (!slots.city) {
    return '想去哪個城市？目前支持北京、上海、广州、深圳、杭州、南京、成都、武汉、西安、重庆、天津、长沙、郑州、青岛、厦门、昆明。';
  }
  if (!slots.activity) {
    return '到了之後想安排什麼活動？可以說「看演唱會」「看話劇」「看球賽」「喝杯咖啡」等。';
  }
  return null;
}

/** 追問文案特徵片段（與上方三條文案一一同源，改文案時須同步） */
const FOLLOWUP_MARKS = ['想安排在哪一天', '想去哪個城市', '想安排什麼活動'];

/**
 * 判定文本是否為行程槽位追問文案（多輪補充錨點）
 *
 * rule 路徑多輪收斂用：上一輪 assistant 發出行程追問後，本輪補充
 * （如「看話劇」，無位移詞不命中 isTripIntent）仍屬行程對話，
 * rule-planner 據此繼續走行程規劃而非單域分支。
 */
export function isTripFollowup(text: string): boolean {
  return FOLLOWUP_MARKS.some((m) => text.includes(m));
}
