/**
 * 規則式任務規劃器（開發模式降級備援）
 *
 * 規範來源：.qoder/rules/Agent.md § 8.3、§ 13 里程碑 M1
 *
 * 設計理由：雲端 LLM 在開發者工具未開通雲開發 / 遊客模式下不可用，
 * 若 Planner 直接失敗會導致「意圖 → Plan → 確認 → 執行 → 聚合」
 * 全鏈路無法在本地演示。本模組以關鍵詞規則生成與 LLM Planner
 * 完全同構的 PlannerLLMOutput，並統一走 parser.toPlan 補齊欄位，
 * 下游（確認 / 調度 / checkpoint）完全無感。
 *
 * 注意：
 *   1. 僅為降級備援，正式環境一律走雲端 LLM
 *   2. 寫操作的 requiresHumanConfirm 由 capability schema 統一約束，
 *      本規劃器生成的下單任務照常觸發 checkpoint 確認（§ 10 紅線）
 *   3. 下單任務的乘客為演示資料，確認彈窗會完整展示入參
 *
 * 2026-10 六域回補（跳轉模式）：咖啡 / 購物 / 預約 / 票務 / 陪伴 / 支付
 * 規則隨 SKILL 重新上架一併恢復——寫操作任務的語義為「生成需求卡並
 * 跳轉官方渠道」（真實交易在渠道收銀台完成）；危機詞短路仍為本地
 * 靜態關懷文案（安全網不依賴任何 SKILL 與雲端可達性）。
 */

import { addDays, formatDate } from '../utils/datetime';
import { isCrisisMessage } from '../utils/counseling';
import {
  isTripIntent,
  isTripFollowup,
  extractTripSlots,
  missingSlotPrompt,
  extractCity,
} from '../utils/trip';
import type { PlannerLLMOutput } from './parser';
import type { AgentContext } from '../types/context';

/** 常用城市關鍵詞（簡繁並列；先出現者視為出發站） */
const CITIES = [
  '北京', '上海', '廣州', '广州', '深圳', '杭州', '南京', '成都',
  '武漢', '武汉', '西安', '重慶', '重庆', '天津', '長沙', '长沙',
  '鄭州', '郑州', '青島', '青岛', '廈門', '厦门', '昆明',
];

/** 座席關鍵詞 → search_train seatType enum 映射 */
const SEAT_MAP: Array<[RegExp, string]> = [
  [/商務座|商务座|商務艙/, 'business'],
  [/一等座/, 'first_class'],
  [/二等座|二等/, 'second_class'],
  [/硬座/, 'hard_seat'],
];

/** 補零對齊 toPlan 的 Task ID 規則（task_NNN，§ 12.4） */
function padTaskNo(n: number): string {
  return String(n).padStart(3, '0');
}

/**
 * 出發城市取值（2026-10 修訂，用戶指令的取值鏈）：
 *   地址簿默認地址市級 > 定位城市 > 無（追問用戶）
 *
 * ctx.userProfile.location.city 已由 core/context.ts 按此優先級合併並
 * 歸一化（去行政區後綴），此處僅透傳；缺失時由呼叫方以追問收斂，
 * **不再缺省北京**——演示缺省會真實訂錯出發地的票。
 */
function departureCity(ctx: AgentContext): string | null {
  return ctx.userProfile.location?.city ?? null;
}

/** 出發城市追問文案（地址簿 / 定位均無來源時；提示兩條一勞永逸路徑） */
const DEPARTURE_CITY_PROMPT =
  '請問從哪座城市出發？你也可以在「我的」頁填寫常用地址，或開啟定位授權，之後我會自動帶入出發城市。';

/**
 * 從意圖抽取日期：優先取 YYYY-MM-DD 字面值（與 LLM 規劃路徑規則 10 對齊，
 * 快捷預訂指令攜帶具體日期），其次相對詞（今天 / 明天 / 後天），缺省今天
 */
function extractDate(intent: string): string {
  const literal = intent.match(/\d{4}-\d{2}-\d{2}/);
  if (literal) return literal[0];
  if (/後天|后天/.test(intent)) return formatDate(addDays(new Date(), 2));
  if (/明天/.test(intent)) return formatDate(addDays(new Date(), 1));
  return formatDate(new Date());
}

/** 從意圖按出現順序抽取城市（最多取兩個：出發、到達） */
function extractCities(intent: string): string[] {
  const found: string[] = [];
  for (const c of CITIES) {
    if (intent.includes(c) && !found.includes(c)) found.push(c);
    if (found.length >= 2) break;
  }
  return found;
}

/** 從意圖抽取座席類型（缺省二等座） */
function extractSeatType(intent: string): string {
  for (const [re, val] of SEAT_MAP) {
    if (re.test(intent)) return val;
  }
  return 'second_class';
}

/**
 * 從意圖抽取用戶點名的車次號（如 G531 / D3115 / K7731）
 *
 * 與 LLM 規劃路徑的「字面值優先」規則對齊（prompts/planner.ts 規則 8）：
 * 用戶已點名的確定參數直接寫字面值，僅票價用 inputBindings 取即時值。
 * 正則說明：字母后必須跟數字，「5G/Wi-Fi 6」等不會誤匹配。
 */
function extractTrainNo(intent: string): string | null {
  const m = intent.match(/[GDKZC]\d{1,5}/);
  return m ? m[0].toUpperCase() : null;
}

/**
 * 從意圖抽取用戶點名的航班號（如 CA1501 / MU5101 / 9C8882）
 *
 * 航班號形態：航司二字碼（雙字母或數字+字母，如 CA / 9C / 3U）+ 3~4 位
 * 數字，整詞邊界匹配且必須含字母——純數字（日期 / 手機號 / 證件號均為
 * 連續單詞，長度不落於 5~6 字符）不會誤匹配；G531 等車次號缺少後接
 * 數字前的雙字符航司碼形態，亦不會誤判為航班。
 */
function extractFlightNo(intent: string): string | null {
  const m = intent.toUpperCase().match(/\b([A-Z0-9]{2}\d{3,4})\b/);
  return m && /[A-Z]/.test(m[1]) ? m[1] : null;
}

/** 從意圖抽取艙位（缺省經濟艙；與火車席別詞不同域，不互斥） */
function extractCabin(intent: string): string {
  if (/頭等|头等/.test(intent)) return 'first';
  if (/商務|商务/.test(intent)) return 'business';
  return 'economy';
}

/** 從意圖識別飲品名（缺省拿鐵） */
function extractDrink(intent: string): string {
  if (/美式/.test(intent)) return '美式咖啡';
  if (/摩卡/.test(intent)) return '摩卡';
  return '拿鐵';
}

/** 商品關鍵詞 → [productId, 商品名]（與商城演示商品表對齊） */
const PRODUCT_MAP: Array<[RegExp, string, string]> = [
  [/耳機|耳机/, 'p_001', '無線降噪耳機 Pro'],
  [/手錶|手表/, 'p_002', '智能手錶 S6'],
  [/保溫杯|保温杯/, 'p_003', '恆溫保溫杯 500ml'],
  [/咖啡豆/, 'p_004', '精品咖啡豆 1kg'],
  [/按摩儀|按摩仪/, 'p_005', '頸部按摩儀'],
  [/跑步鞋/, 'p_006', '輕量跑步鞋'],
];

/** 服務關鍵詞 → [serviceId, 服務名]（與預約中心演示服務目錄對齊） */
const SERVICE_MAP: Array<[RegExp, string, string]> = [
  [/羽毛球/, 'svc_001', '羽毛球場地'],
  [/潔牙|洁牙/, 'svc_002', '口腔潔牙護理'],
  [/體檢|体检/, 'svc_003', '健康體檢套餐 A'],
  [/游泳|泳池/, 'svc_004', '恆溫泳池單次票'],
  [/理髮|理发|剪髮|剪发|剪裁|設計師|设计师/, 'svc_005', '首席設計師剪裁'],
];

/**
 * 演出關鍵詞 → 目錄檢索詞（與票務演示目錄 EVENTS 的繁體名對齊；
 * 用戶口説常用簡體，直接以原文檢索會因繁簡差異落空，故做映射）
 */
const TICKET_KEYWORD_MAP: Array<[RegExp, string]> = [
  [/周杰[伦倫]|杰伦/, '周杰倫'],
  [/五月天/, '五月天'],
  [/草莓/, '草莓'],
  [/暗戀桃花源|暗恋桃花源|桃花源/, '暗戀桃花源'],
  [/劇院魅影|剧院魅影|魅影|歌劇魅影|歌剧魅影/, '劇院魅影'],
  [/音[樂乐][劇剧]/, '音樂劇'],
  [/CBA|籃球|篮球|首[鋼钢]/, 'CBA'],
];

/** 從意圖提取點名的商品（未點名返回 null） */
function extractProduct(intent: string): { productId: string; name: string } | null {
  for (const [re, productId, name] of PRODUCT_MAP) {
    if (re.test(intent)) return { productId, name };
  }
  return null;
}

/** 從意圖提取點名的服務（未點名返回 null） */
function extractService(intent: string): { serviceId: string; name: string } | null {
  for (const [re, serviceId, name] of SERVICE_MAP) {
    if (re.test(intent)) return { serviceId, name };
  }
  return null;
}

/** 從意圖提取點名的演出檢索詞（未點名返回 null） */
function extractTicketKeyword(intent: string): string | null {
  for (const [re, keyword] of TICKET_KEYWORD_MAP) {
    if (re.test(intent)) return keyword;
  }
  return null;
}

/**
 * 從意圖提取附近搜尋品類詞（「附近的便利店」→ 便利店、「哪裡有打印店」→ 打印店）
 *
 * 兩種形態按優先級匹配：修飾詞前置（附近 / 周邊 / 最近 + 的 + 品類）與
 * 品類後置疑問（品類 + 在哪 / 哪裡有）。助詞先剝除（請問 / 幫我 /
 * 查找 / 有沒有 / 哪裡有…），捕獲組取連續漢字 / 字母段；捕獲尾部再剝
 * 「在哪」疑問尾緅（「最近的地铁站在哪」→ 地铁站而非「地铁站在哪」）。
 * 泛指詞（有什麼 / 啥…）視為無品類——由呼叫分支追問，不硬猜關鍵詞
 */
function extractNearbyKeyword(intent: string): string | null {
  const cleaned = intent
    .replace(/請問|请问|幫我|帮我|幫忙|帮忙|麻煩|麻烦|一下|有[没沒]有|哪[裡里]有|哪[裡里]可以找/g, '')
    .replace(/查[一查詢个個]?|找[一找]?|搜[一索尋]?/g, '');
  const m1 = cleaned.match(/(?:附近|周[邊边]|最近)的?([\u4e00-\u9fa5A-Za-z0-9]{2,10})/);
  const cand1 = m1 ? m1[1].replace(/在哪[裡里]?$/, '') : null;
  if (cand1 && !/^(有)?(什[麼么]|甚[麼么]|啥)/.test(cand1)) return cand1;
  const m2 = cleaned.match(/([\u4e00-\u9fa5A-Za-z0-9]{2,10})(?:在哪[裡里]?)/);
  if (m2 && !/^(有)?(什[麼么]|甚[麼么]|啥)/.test(m2[1])) return m2[1];
  return null;
}

/** 中文數字映射（一 ~ 九、兩 = 2）——鐘點解析用 */
const CN_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/**
 * 解析鐘點數字（0-23）：阿拉伯（「8點」）或中文（「三點 / 十點 / 十二點 /
 * 二十點 / 下午三點半」）。未點名鐘點返回 null
 */
function parseCnHour(intent: string): number | null {
  const arabic = /([01]?\d|2[0-3])(?=[點点时時])/.exec(intent);
  if (arabic) return Number(arabic[1]);
  const m = /([一二兩两三四五六七八九]?十[一二兩两三四五六七八九]?|[一二兩两三四五六七八九])[點点时時]/.exec(
    intent,
  );
  if (!m) return null;
  const s = m[1];
  if (s === '十') return 10;
  if (s.startsWith('十')) return 10 + (CN_DIGITS[s[1]] ?? 0);
  if (s.endsWith('十')) return (CN_DIGITS[s[0]] ?? 0) * 10;
  return CN_DIGITS[s] ?? null;
}

/**
 * 從意圖提取預約時段：優先「HH:mm」字面值，其次時段詞 + 鐘點數字組合
 * （「下午三點」→ 15:00，「晚上八點半」→ 20:30——數字優先於時段詞兜底槽，
 * 用戶點名鐘點被目錄槽覆蓋是實測回歸點），最後時段詞映射到服務目錄的
 * 固定時刻槽（10/12/14/16/18/20 點），未點名返回 null
 */
function extractStartTime(intent: string): string | null {
  const literal = intent.match(/([01]?\d|2[0-3]):[0-5]\d/);
  if (literal) return literal[0];
  const hour = parseCnHour(intent);
  if (hour !== null) {
    const minute = /[點点时時]半/.test(intent) ? 30 : 0;
    let h = hour;
    if (/下午|傍晚/.test(intent)) h = hour <= 12 ? hour + 12 : hour;
    else if (/晚上|夜裡|夜里/.test(intent)) h = hour <= 11 ? hour + 12 : hour;
    else if (!/早上|清晨|上午|中午/.test(intent)) h = hour <= 8 ? hour + 12 : hour;
    if (h >= 0 && h <= 23) return `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  if (/早上|清晨|上午/.test(intent)) return '10:00';
  if (/中午/.test(intent)) return '12:00';
  if (/下午/.test(intent)) return '14:00';
  if (/傍晚/.test(intent)) return '16:00';
  if (/晚上|夜裡|夜里/.test(intent)) return '18:00';
  return null;
}

/** 行程活動槽位的票務詞判定（「看一場演唱會」等泛詞 → 展開演出搜尋） */
const TICKET_ACTIVITY_RE = /演唱[會会]|話劇|话剧|音樂劇|音乐剧|音樂節|音乐节|演出|比[賽赛]|球[賽赛]|門票|门票/;

/** 行程活動槽位的咖啡詞判定（「喝杯咖啡」→ 展開門市查詢） */
const COFFEE_ACTIVITY_RE = /咖啡|星巴克|拿[铁鐵]|美式|摩卡/;

/**
 * 行程複合意圖規劃（「什麼時候去什麼地方幹什麼」）
 *
 * 展開策略（2026-10 六域回補後）：
 *   1. 目的地天氣（get_weather，座標命中演示城市表才生成）
 *   2. 城際交通（search_train；出發城市取用戶所在城市，缺失或與目的地
 *      相同時缺省北京）
 *   3. 活動域只讀搜尋（活動槽位命中票務 / 咖啡詞時並行追加 search_events /
 *      search_store，與天氣 / 交通同層——DAG 展示編排能力，僅查詢）
 *
 * 寫操作安全口徑：僅當意圖含買詞（買 / 訂 / 下單）且指向車票
 * （點名「車票 / 高鐵票」）才追加 book_ticket——「想去看看」不直接下單；
 * 演出 / 咖啡同理，行程語境不自動產生寫操作（下單由單域分支的買詞觸發）。
 *
 * 槽位不齊：回空 tasks + 追問文案（多輪收集；下一輪由
 * extractTripSlots 從對話歷史合併出新槽位，無需內存狀態）
 */
function tripPlan(intent: string, ctx: AgentContext): PlannerLLMOutput {
  const slots = extractTripSlots(ctx.messages, intent);
  const missing = missingSlotPrompt(slots);
  if (missing || !slots.date || !slots.dateLabel || !slots.city || !slots.activity) {
    return { tasks: [], message: missing ?? '請補充行程信息（日期 / 城市 / 活動）。' };
  }

  // 時間線標籤：「10/11 下周六」；dateLabel 為字面日期時不重複展示
  const md = slots.date.slice(5).replace('-', '/');
  const timeLabel = slots.dateLabel !== slots.date ? `${md} ${slots.dateLabel}` : md;
  const tasks: NonNullable<PlannerLLMOutput['tasks']> = [];

  // 1. 目的地天氣（座標命中才生成；天氣 SKILL 僅支援座標入參，
  //    缺座標跳過不阻斷行程）
  const cityInfo = extractCity(slots.city);
  if (cityInfo) {
    tasks.push({
      skillId: 'skill.weather.query',
      action: 'get_weather',
      input: { lat: cityInfo.lat, lng: cityInfo.lng },
      inputBindings: {},
      dependsOn: [],
      timeLabel,
      summary: `查${slots.city}${slots.dateLabel}天氣`,
    });
  }

  // 2. 城際交通查詢（只讀；與既有單域分支同構的查詢參數）。
  //    出發城市按取值鏈（地址簿 > 定位 > 追問）；同城行程不硬造跨城任務，
  //    向用戶確認真實出發地（舊缺省「北京」已廢除）
  const from = departureCity(ctx);
  if (!from) {
    return { tasks: [], message: DEPARTURE_CITY_PROMPT };
  }
  if (from === slots.city) {
    return {
      tasks: [],
      message: `你所在地（${from}）與目的地相同：還需要查從其他城市出發的交通嗎？請告訴我出發城市，或直接說「就在本市逛逛」。`,
    };
  }
  const searchTrainId = `task_${padTaskNo(tasks.length + 1)}`;
  tasks.push({
    skillId: 'skill.train.12306',
    action: 'search_train',
    input: { from, to: slots.city, date: slots.date, seatType: 'second_class' },
    inputBindings: {},
    dependsOn: [],
    timeLabel,
    summary: `查 ${slots.date} ${from}→${slots.city} 車次`,
  });

  // 買詞判定：僅點名「車票 / 高鐵票 / 火車票」才追加 book_ticket——
  // 「去看演唱會把票買了」的門票需求由活動搜尋任務承接（search_events），
  // 單域下單由用戶在票務分支明說（「幫我買周杰倫演唱會的票」）
  const wantsTrainBuy =
    /[买買訂订]|下[单單]/.test(intent) && /車票|车票|高[铁鐵]票|火[车車]票/.test(intent);
  if (wantsTrainBuy) {
    tasks.push({
      skillId: 'skill.train.12306',
      action: 'book_ticket',
      input: {
        date: slots.date,
        seatType: 'second_class',
        // 開發模式演示資料；applyPassengerSlot 後處理以「對話明說 >
        // 乘車人簿默認人」回填真實乘車人，確認卡完整展示入參
        passengerName: '演示乘客',
        passengerIdNo: '110101199001011234',
      },
      inputBindings: {
        trainNo: { fromTaskId: searchTrainId, fromField: 'trainNo' },
        date: { fromTaskId: searchTrainId, fromField: 'date' },
        priceCent: { fromTaskId: searchTrainId, fromField: 'priceCent' },
      },
      dependsOn: [searchTrainId],
      timeLabel,
      summary: `下單 ${from}→${slots.city} 車票（需確認）`,
    });
  }

  // 3. 活動域只讀展開（與天氣 / 交通並行；槽位泛詞命中即追加，不解析目錄）
  if (TICKET_ACTIVITY_RE.test(slots.activity)) {
    tasks.push({
      skillId: 'skill.ticket.show',
      action: 'search_events',
      input: { city: slots.city },
      inputBindings: {},
      dependsOn: [],
      timeLabel,
      summary: `搜${slots.city}演出（${slots.activity}）`,
    });
  }
  if (COFFEE_ACTIVITY_RE.test(slots.activity)) {
    tasks.push({
      skillId: 'skill.coffee.starbucks',
      action: 'search_store',
      input: { city: slots.city, limit: 5 },
      inputBindings: {},
      dependsOn: [],
      timeLabel,
      summary: `查${slots.city}星巴克門市`,
    });
  }

  return {
    intent,
    tasks,
    trip: {
      date: slots.date,
      dateLabel: slots.dateLabel,
      city: slots.city,
      activity: slots.activity,
    },
    message: '',
  };
}

/**
 * 規則式規劃主入口
 *
 * @param intent 用戶自然語言意圖
 * @param ctx Agent 上下文（門市查詢優先取用戶所在城市）
 * @returns 與 LLM Planner 同構的 PlannerLLMOutput（tasks 為空表示無法識別）
 */
export function rulePlan(intent: string, ctx: AgentContext): PlannerLLMOutput {
  const tasks: NonNullable<PlannerLLMOutput['tasks']> = [];

  // 危機信號短路（安全優先於一切業務域，含支付短路）：自傷 / 輕生類
  // 表達一律以本地靜態關懷文案回應（陪伴對話 SKILL 已於 2026-10 六域
  // 回補重新上架，但安全網獨立於 SKILL 存在——不依賴任何 SKILL 與雲端
  // 可達性，離線也能即刻回應；空 tasks + message 走 NEEDS_INPUT 收斂，狀態機零改動）
  if (isCrisisMessage(intent)) {
    return {
      intent,
      tasks: [],
      message:
        '聽到你有這樣的感受，我很捨不得你獨自承受。請立即聯繫專業支持：\n' +
        '· 心理援助熱線 12356（24 小時免費）\n' +
        '· 緊急情況直接撥打 120 或 110\n' +
        '· 告訴一位你信任的人，讓 TA 陪你\n' +
        '你不是一個人。',
    };
  }

  // 支付意圖短路（2026-10 六域回補，聚合收銀台）：獨立短路分支必須優先於
  // 各業務域判定——訂單指令攜帶「高鐵票訂單」等標題詞，若不短路會誤觸發
  // wantsTrain 等域規則產生錯誤下單任務。跳轉模式下真實支付在渠道側
  // （12306 / OTA / 星巴克 / 大麥 / 美團 / 京東收銀台），站內無代付能力
  // （個人主體無法開通微信支付商戶號）——pay_orders 聚合全部
  // pending_external 訂單逐單重建渠道跳轉包，由用戶逐單前往渠道完成支付
  // （純讀無資金流，故無需確認彈窗）。「結帳 / 結算」不在此短路
  // （歸購物域 checkout，渠道為京東），聚合入口詞為「支付 / 付款」。
  if (/支付|付款|付[錢钱]|去付/.test(intent)) {
    return {
      intent,
      tasks: [
        {
          skillId: 'skill.payment.aicard',
          action: 'pay_orders',
          input: {},
          inputBindings: {},
          dependsOn: [],
          summary: '聚合待支付訂單並引導渠道收銀台',
        },
      ],
      message: '',
    };
  }

  // 行程複合意圖（「什麼時候去什麼地方幹什麼」）：短路於單域判定之前。
  // isTripIntent 已排除交通域詞（含高鐵 / 機票詞的意圖走下方單域分支，
  // 天然互斥防雙觸發）；票務詞在行程語境下歸屬活動子任務組，
  // 不再重複走單域票務分支。
  // 多輪補充：上一輪 assistant 發出行程追問（isTripFollowup 錨點）時，
  // 本輪補充如「看話劇」無位移詞不命中 isTripIntent，仍屬行程對話，
  // 繼續走行程規劃從歷史合併槽位（追問其後若已生成行程 / 轉入其他話題，
  // 最後一條 assistant 非追問文案，錨點自然失效）
  const lastAssistant = [...ctx.messages].reverse().find((m) => m.role === 'assistant');
  if (isTripIntent(intent) || (lastAssistant && isTripFollowup(lastAssistant.content))) {
    return tripPlan(intent, ctx);
  }

  // 實名補充輪錨點（與 isTripFollowup 同構）：上一輪 assistant 為「請補充
  // 乘車人 / 觀演人」追問時，本輪純「姓名 + 證號」補充（無任何域詞）
  // 仍屬訂票對話——從歷史最近含下單域詞的用戶意圖恢復規劃（補充信息
  // 由 applyPassengerSlot 從對話歷史回填，佔位判定對真實值放行）。
  // 缺失此錨點時補充輪會落「尚未支援此意圖」兜底，且規劃路由翻轉後
  // message 短路會攔掉 LLM 恢復，多輪體驗斷裂（T4 實測）
  if (
    lastAssistant &&
    /請補充(乘車人|觀演人)姓名/.test(lastAssistant.content) &&
    /身份[證证]/.test(intent)
  ) {
    const origin = [...ctx.messages]
      .reverse()
      .find(
        (m) =>
          m.role === 'user' &&
          /高[铁鐵]|动[车車]|火[车車]|機票|机票|航班|演唱[會会]|音[樂乐][節节]|音[樂乐][劇剧]|話[劇剧]|[門门]票|[購购]票|[買买]票|[搶抢]票/.test(
            m.content,
          ),
      );
    if (origin) return rulePlan(origin.content, ctx);
  }

  const wantsTrain = /高[铁鐵]|动[车車]|火[车車]|[车車][次票]|12306/.test(intent);
  // 機票域：域詞命中（「飛」單字歧義大，僅收「飛往 / 坐飛 / 搭機」等組合詞）
  const wantsFlight = /機票|机票|航班|飛機|飞机|飛往|飞往|搭機|搭机|坐飛|坐飞/.test(intent);
  // 「咖啡(?!豆)」：買咖啡豆屬購物域，避免與商城 SKILL 雙觸發
  const wantsCoffee = /星巴克|咖啡(?!豆)|拿[铁鐵]|美式|摩卡/.test(intent);
  // 買 / 訂 / 下單 / 來一杯 / 幫我點 / 預約 均視為寫入意圖（觸發寫操作任務）。
  // 「預約」必須在此收錄：預約域的 create_reservation 以買詞為觸發條件，
  // 漏收會導致「預約明天羽毛球場地」只查時段不建預約卡（雙字組合收錄，
  // 避免「大約 / 約會」單字誤觸）
  const wantsBuy = /[买買訂订]|[預预][約约]|下[单單]|[来來][一]?[杯個份]|[帮幫]我[点點]/.test(intent);
  // 購物域：域詞或商品詞命中（「咖啡豆」歸此域而非咖啡點單）
  const wantsShopping =
    /购物|購物|商城|商品|加[购購]|買東西|买东西/.test(intent) ||
    PRODUCT_MAP.some(([re]) => re.test(intent));
  // 結算意圖：購物車已有商品，直接結帳（不重搜不加購；「結帳 / 結算」
  // 歸購物域而非支付聚合——聚合入口詞為「支付 / 付款」，見頭部短路）
  const wantsCheckout = /結[帳账]|结账|結算|结算/.test(intent);
  // 預約域：域詞或服務詞命中
  const wantsBooking =
    /預約|预约|預訂|预订/.test(intent) || SERVICE_MAP.some(([re]) => re.test(intent));
  // 預約查詢意圖（「我的預約」）：只讀清單，不建預約
  const wantsListReservations = /我的預約|我的预约|查.{0,4}預約|查.{0,4}预约/.test(intent);
  // 票務域：演出域詞或目錄劇目 / 藝人詞命中（「車票 / 機票」歸出行域，
  // 此處詞表不含，天然互斥；「買票」泛詞指向演出門票——車票需求必須
  // 點名「車票 / 高鐵票 / 火車票」由 wantsTrain 承接）
  // 商品語境排除：藝人 / 劇目詞命中但語義指向實體商品（專輯 / 唱片 /
  // 周邊）且無演出語境詞時，不觸發票務域（「買周杰倫專輯」是購物而非
  // 買演出票，誤觸會生成錯誤下單任務）；同句含演出詞（如「買專輯也
  // 想看演唱會」）仍歸票務
  const wantsMerchOnly = /[專专][輯辑]|唱片|周[邊边]|海[報报]/.test(intent) && !TICKET_ACTIVITY_RE.test(intent);
  const wantsTicket =
    /演唱[會会]|音[樂乐][節节]|話[劇剧]|音[樂乐][劇剧]|演出|看比[賽赛]|CBA|[門门]票|[購购]票|[買买]票|[搶抢]票/.test(intent) ||
    (!wantsMerchOnly && TICKET_KEYWORD_MAP.some(([re]) => re.test(intent)));
  // 諮詢域（兜底對話）：情緒 / 陪聊詞——僅在無任何任務域命中時展開
  // （「煩死了幫我訂杯咖啡」應訂咖啡而非陪聊，見末尾 tasks.length === 0 分支）
  const wantsCounseling =
    /心情|難過|难过|傷心|伤心|焦慮|焦虑|壓[力大]|压[力大]|孤單|孤单|寂寞|[鬱郁][悶闷]|煩|烦|陪我|聊[一]?聊|說說話|说说话|傾訴|倾诉|開心不起來|开心不起来/.test(intent);
  // 天氣域：只讀查詢；座標由 ctx.userProfile.location 提供（context 構建時
  // wx.getLocation 取得，見 core/context.ts fetchLocation）
  const wantsWeather = /天氣|天气|氣溫|气温|溫度|温度|幾度|几度|下雨/.test(intent);
  // 附近地點搜尋域：POI 查詢（便利店 / 藥店 / 列印店…）。「附近 + 專屬域詞」
  // 的組合歸各專屬域（「附近星巴克」歸咖啡域、「附近賣場」歸購物域），
  // 此處以各域旗標排他，僅承接無專屬 SKILL 的品類詞；wantsTrain / wantsFlight
  // 亦排他（「附近的高鐵站」實際語義偏車次查詢域，MVP 不搶接）
  const wantsNearby =
    /附近|周[邊边]|最近|哪[裡里]有|有[没沒]有/.test(intent) &&
    !wantsCoffee &&
    !wantsShopping &&
    !wantsBooking &&
    !wantsTicket &&
    !wantsTrain &&
    !wantsFlight &&
    !wantsWeather;

  // 出發城市（單域分支共用）：用戶點名 > 地址簿默認地址 > 定位；
  // 均無時追問（舊「缺省北京」演示 hack 已廢除——會訂錯出發地）
  const cities = extractCities(intent);
  const from = cities[0] ?? departureCity(ctx);
  if ((wantsTrain || wantsFlight) && !from) {
    return { tasks: [], message: DEPARTURE_CITY_PROMPT };
  }

  if (wantsTrain) {
    const to = cities[1] ?? '上海';
    const date = extractDate(intent);
    const seatType = extractSeatType(intent);

    const searchTaskId = `task_${padTaskNo(tasks.length + 1)}`;
    tasks.push({
      skillId: 'skill.train.12306',
      action: 'search_train',
      input: { from, to, date, seatType },
      inputBindings: {},
      dependsOn: [],
      summary: `查詢 ${date} ${from}→${to} 車次`,
    });

    if (wantsBuy) {
      // 用戶點名車次時直接寫字面值（與 LLM 規劃路徑一致），票價按車次精準
      //繫結；未點名時沿用查詢結果綁定（trainNo/date 由查詢產出）
      const trainNo = extractTrainNo(intent);
      tasks.push({
        skillId: 'skill.train.12306',
        action: 'book_ticket',
        input: {
          ...(trainNo ? { trainNo, from, to } : {}),
          date,
          seatType,
          // 開發模式演示資料；checkpoint 彈窗會完整展示，由用戶確認
          passengerName: '演示乘客',
          passengerIdNo: '110101199001011234',
        },
        inputBindings: trainNo
          ? {
              // 票價注入：按點名車次精準取價，checkpoint 彈窗得以在確認前
              // 展示真實金額；下單金額以雲端再核實為準
              priceCent: { fromTaskId: searchTaskId, fromField: `priceCentByTrain.${trainNo}` },
            }
          : {
              trainNo: { fromTaskId: searchTaskId, fromField: 'trainNo' },
              date: { fromTaskId: searchTaskId, fromField: 'date' },
              priceCent: { fromTaskId: searchTaskId, fromField: 'priceCent' },
            },
        dependsOn: [searchTaskId],
        summary: `生成購票卡跳轉 12306 下單（${trainNo ?? from + '→' + to}，需確認）`,
      });
    }
  }

  if (wantsFlight) {
    const to = cities[1] ?? '上海';
    const date = extractDate(intent);
    const cabin = extractCabin(intent);

    const searchTaskId = `task_${padTaskNo(tasks.length + 1)}`;
    tasks.push({
      skillId: 'skill.flight.variflight',
      action: 'search_flights',
      input: { from, to, date, cabin },
      inputBindings: {},
      dependsOn: [],
      summary: `查詢 ${date} ${from}→${to} 航班`,
    });

    if (wantsBuy) {
      // 與火車分支同構：點名航班寫字面值 + 按航班號精準取價；
      // 未點名沿用查詢結果首班綁定（flightNo / date 由查詢產出）
      const flightNo = extractFlightNo(intent);
      tasks.push({
        skillId: 'skill.flight.variflight',
        action: 'book_flight',
        input: {
          ...(flightNo ? { flightNo, from, to } : {}),
          date,
          cabin,
          // 開發模式演示資料；checkpoint 彈窗會完整展示，由用戶確認
          passengerName: '演示乘客',
          passengerIdNo: '110101199001011234',
        },
        inputBindings: flightNo
          ? {
              // 票價注入：按點名航班精準取價（上游未覆蓋時為 -1，
              // 彈窗特判「暫無即時報價」，下單金額以雲端再核實為準）
              priceCent: { fromTaskId: searchTaskId, fromField: `priceCentByFlight.${flightNo}` },
            }
          : {
              flightNo: { fromTaskId: searchTaskId, fromField: 'flightNo' },
              date: { fromTaskId: searchTaskId, fromField: 'date' },
              priceCent: { fromTaskId: searchTaskId, fromField: 'priceCent' },
            },
        dependsOn: [searchTaskId],
        summary: `生成購票卡跳轉 OTA 下單（${flightNo ?? from + '→' + to}，需確認）`,
      });
    }
  }

  // 咖啡域：門市查詢 →（買詞時）點單需求卡跳轉星巴克。城市取定位 /
  // 地址簿（無城市概念的用户說「來杯咖啡」也成立，門市查詢以當前城市
  // 兜底；無定位時缺省上海——門市查詢為只讀演示，不產生真實扣款）
  if (wantsCoffee) {
    const city = ctx.userProfile.location?.city ?? '上海';
    const searchTaskId = `task_${padTaskNo(tasks.length + 1)}`;
    tasks.push({
      skillId: 'skill.coffee.starbucks',
      action: 'search_store',
      input: { city, limit: 5 },
      inputBindings: {},
      dependsOn: [],
      summary: `查詢${city}附近的星巴克門市`,
    });

    if (wantsBuy) {
      const drink = extractDrink(intent);
      tasks.push({
        skillId: 'skill.coffee.starbucks',
        action: 'place_order',
        input: {
          items: [{ sku: `demo_${drink}`, name: drink, quantity: 1, size: '中杯' }],
          pickupType: 'in_store',
        },
        inputBindings: {
          storeId: { fromTaskId: searchTaskId, fromField: 'data.stores.0.storeId' },
        },
        dependsOn: [searchTaskId],
        summary: `下單一杯${drink}（需確認，跳轉星巴克完成）`,
      });
    }
  }

  // 購物域：搜尋 →（點名商品且買詞時）加購；「結帳 / 結算」直接 checkout
  if (wantsShopping && !wantsCheckout) {
    const product = extractProduct(intent);
    const searchTaskId = `task_${padTaskNo(tasks.length + 1)}`;
    tasks.push({
      skillId: 'skill.shopping.mall',
      action: 'search_products',
      input: product ? { keyword: product.name } : {},
      inputBindings: {},
      dependsOn: [],
      summary: product ? `查詢「${product.name}」商品` : '濟覽商城商品',
    });

    // 購買意圖且點名商品 → 加購（字面 productId，與「字面值優先」規則對齊）
    if (wantsBuy && product) {
      tasks.push({
        skillId: 'skill.shopping.mall',
        action: 'add_to_cart',
        input: { productId: product.productId, quantity: 1, name: product.name },
        inputBindings: {
          // 即時價注入：確認彈窗得以在加購前展示真實價格（與車票同構）
          priceCent: { fromTaskId: searchTaskId, fromField: `data.priceCentByProduct.${product.productId}` },
        },
        dependsOn: [searchTaskId],
        summary: `把${product.name}加入購物車（需確認）`,
      });
    }
  }

  // 結算：單任務（購物車狀態由雲端 / mock 會話持有，無需先查詢）。
  // 「結帳 / 結算」單獨說出即觸發（加購後下一輪「結帳」是最自然指令，
  // 不要求同句再帶購物域詞——上方 wantsShopping && !wantsCheckout 已保證
  // 結算時不重搜不加購）
  if (wantsCheckout) {
    tasks.push({
      skillId: 'skill.shopping.mall',
      action: 'checkout',
      input: {},
      inputBindings: {},
      dependsOn: [],
      summary: '結算購物車並跳轉京東下單（需確認）',
    });
  }

  // 預約域：查清單 / 搜服務 →（點名服務時）建預約需求卡跳轉美團
  if (wantsBooking) {
    // 查我的預約：只讀單任務
    if (wantsListReservations) {
      tasks.push({
        skillId: 'skill.booking.center',
        action: 'list_reservations',
        input: {},
        inputBindings: {},
        dependsOn: [],
        summary: '查詢我的全部預約',
      });
    } else {
      const service = extractService(intent);
      const date = extractDate(intent);
      const searchTaskId = `task_${padTaskNo(tasks.length + 1)}`;
      tasks.push({
        skillId: 'skill.booking.center',
        action: 'search_services',
        input: { date, ...(service ? { keyword: service.name } : {}) },
        inputBindings: {},
        dependsOn: [],
        summary: service ? `查詢 ${date}「${service.name}」可約時段` : `查詢 ${date} 可預約服務`,
      });

      // 預約即寫意圖且點名服務 → 建預約。用戶點名時間寫字面值；
      // 未點名則以 binding 取「首個可約時段」（規避字面時間撞滿約失敗）
      if (wantsBuy && service) {
        const startTime = extractStartTime(intent);
        tasks.push({
          skillId: 'skill.booking.center',
          action: 'create_reservation',
          input: { serviceId: service.serviceId, date, ...(startTime ? { startTime } : {}) },
          inputBindings: startTime
            ? {
                // 服務費注入：確認彈窗在預約前展示真實金額（與車票同構）
                priceCent: { fromTaskId: searchTaskId, fromField: `data.priceCentByService.${service.serviceId}` },
              }
            : {
                startTime: { fromTaskId: searchTaskId, fromField: `data.firstAvailableStartTimeByService.${service.serviceId}` },
                priceCent: { fromTaskId: searchTaskId, fromField: `data.priceCentByService.${service.serviceId}` },
              },
          dependsOn: [searchTaskId],
          summary: `預約${service.name} ${date}${startTime ? ' ' + startTime : '（首個可約時段）'}（需確認，跳轉美團完成）`,
        });
      }
    }
  }

  // 票務域：搜演出 → 查場次 →（買詞時）購票需求卡跳轉大麥（三級鏈依賴）
  if (wantsTicket) {
    const keyword = extractTicketKeyword(intent);
    const searchTaskId = `task_${padTaskNo(tasks.length + 1)}`;
    tasks.push({
      skillId: 'skill.ticket.show',
      action: 'search_events',
      input: keyword ? { keyword } : {},
      inputBindings: {},
      dependsOn: [],
      summary: keyword ? `搜尋「${keyword}」演出` : '搜尋演出',
    });

    // 場次與票檔查詢（依賴搜尋結果；綁定首個命中演出）
    const sessionTaskId = `task_${padTaskNo(tasks.length + 1)}`;
    tasks.push({
      skillId: 'skill.ticket.show',
      action: 'list_sessions',
      input: {},
      inputBindings: { eventId: { fromTaskId: searchTaskId, fromField: 'data.firstEventId' } },
      dependsOn: [searchTaskId],
      summary: '查詢場次與票檔',
    });

    // 買詞 → 購票需求卡（實名觀演人為演示資料；確認彈窗完整展示，
    // applyPassengerSlot 後處理同樣適用——對話明說 > 乘車人簿默認人）
    if (wantsBuy) {
      tasks.push({
        skillId: 'skill.ticket.show',
        action: 'create_order',
        input: {
          quantity: 1,
          viewerName: '演示觀演人',
          viewerIdNo: '110101199001011234',
        },
        inputBindings: {
          eventId: { fromTaskId: searchTaskId, fromField: 'data.firstEventId' },
          sessionId: { fromTaskId: sessionTaskId, fromField: 'data.firstAvailableSessionId' },
          tierId: { fromTaskId: sessionTaskId, fromField: 'data.firstAvailableTierId' },
          priceCent: { fromTaskId: sessionTaskId, fromField: 'data.firstAvailablePriceCent' },
        },
        dependsOn: [sessionTaskId],
        summary: '生成購票卡跳轉大麥下單（需確認）',
      });
    }
  }

  // 天氣查詢：只讀單任務；座標寫字面值（城市僅用於展示標籤）。
  // 座標缺失時不生成任務——按授權狀態分別引導（拒絕授權 → 開授權；
  // 其餘失敗 → 稍後重試），見末尾分支
  const weatherLoc = ctx.userProfile.location;
  if (wantsWeather && weatherLoc?.lat !== undefined && weatherLoc?.lng !== undefined) {
    tasks.push({
      skillId: 'skill.weather.query',
      action: 'get_weather',
      input: { lat: weatherLoc.lat, lng: weatherLoc.lng },
      inputBindings: {},
      dependsOn: [],
      summary: weatherLoc.city ? `查詢${weatherLoc.city}實時天氣` : '查詢當前位置實時天氣',
    });
  }

  // 附近地點搜尋：只讀單任務；座標寫字面值（與天氣分支同構）。
  // 品類詞提取失敗（「附近有什麼」類泛問）→ 追問品類，不硬猜關鍵詞；
  // wantsNearby 已排他全部專屬域，此處直接收斂不影響後續分支
  const nearbyLoc = ctx.userProfile.location;
  if (wantsNearby && nearbyLoc?.lat !== undefined && nearbyLoc?.lng !== undefined) {
    const poiKeyword = extractNearbyKeyword(intent);
    if (!poiKeyword) {
      return {
        tasks: [],
        message: '想找附近什麼地點？例如便利店、藥店、銀行、列印店、地鐵站……告訴我品類，我幫你查最近的。',
      };
    }
    tasks.push({
      skillId: 'skill.map.tianditu',
      action: 'search_poi',
      input: { keyword: poiKeyword, lat: nearbyLoc.lat, lng: nearbyLoc.lng },
      inputBindings: {},
      dependsOn: [],
      summary: nearbyLoc.city
        ? `搜尋${nearbyLoc.city}附近的${poiKeyword}`
        : `搜尋附近的${poiKeyword}`,
    });
  }

  if (tasks.length === 0) {
    // 天氣意圖但無定位：按授權狀態精確引導（座標為 get_weather 必填入參）
    if (wantsWeather) {
      if (ctx.userProfile.locationAuth === 'denied') {
        return {
          tasks: [],
          message: '查詢天氣需要定位，而你尚未授權位置信息：請在小程序設置（右上角⋯ → 設置 → 位置信息）開啟授權後再試。',
        };
      }
      return {
        tasks: [],
        message: '查詢天氣需要定位：請確認已允許小程序使用你的位置，然後再試。',
      };
    }
    // 附近搜尋意圖但無定位：與天氣同構的授權引導（座標為 search_poi 必填入參）
    if (wantsNearby) {
      if (ctx.userProfile.locationAuth === 'denied') {
        return {
          tasks: [],
          message: '搜尋附近地點需要定位，而你尚未授權位置信息：請在小程序設置（右上角⋯ → 設置 → 位置信息）開啟授權後再試。',
        };
      }
      return {
        tasks: [],
        message: '搜尋附近地點需要定位：請確認已允許小程序使用你的位置，然後再試。',
      };
    }
    // 諮詢域兜底：純情緒 / 陪聊表達（無任何任務域詞命中才到這裡——
    // 混合語句已被上方任務分支接管）→ 陪伴對話任務（雲端 LLM 真實
    // 對話，多輪歷史由 SKILL 從 ctx.messages 抽取；危機詞已在頭部短路）
    if (wantsCounseling) {
      return {
        intent,
        tasks: [
          {
            skillId: 'skill.mind.counseling',
            action: 'chat_companion',
            input: { message: intent },
            inputBindings: {},
            dependsOn: [],
            summary: '陪伴對話',
          },
        ],
        message: '',
      };
    }
    // 詞表外兜底（2026-10 修訂）：不再返回「尚未支援」文案——規劃路由
    // 翻轉後 client.plan 以「tasks 或 message 非空」短路，非空 message 會
    // 把詞表外意圖也攔在規則層，LLM 兜底路徑淪為 100% 不可達死代碼
    // （審計 H1：文案聲稱可辦演出票務卻拒絕了「查音樂劇」類詞表外表述）。
    // 規則不認識的意圖以空 tasks + 空 message 誠實透傳交 LLM 規劃；LLM
    // 不可用的開發環境降級由 client.ts 補 UNSUPPORTED_HINT 功能清單
    return { tasks: [], message: '' };
  }
  return { intent, tasks, message: '' };
}

/**
 * 開發環境 LLM 不可用且規則詞表亦未覆蓋時的功能清單引導文案。
 * 隨路由翻轉從本檔兜底分支遷出（詞表外意圖交 LLM 規劃，此文案僅在
 * client.ts 的 DEV 降級路徑出現，release 語義不變）。
 */
export const UNSUPPORTED_HINT =
  '尚未支援此意圖。目前可辦：高鐵車次查詢與跳轉 12306 購票、國內航班查詢與跳轉 OTA 購票、' +
  '實時天氣查詢、附近地點搜尋（便利店 / 藥店 / 列印店等）、星巴克門市查詢與點單、商品搜尋與加購結算、' +
  '生活服務預約、演出票務搜尋與購票、情感陪伴對話、待支付訂單聚合引導，以及一句話出行行程規劃。';
