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
 * 2026-10 技能收敛：僅保留出行域（火車 / 機票 / 天氣 / 行程），
 * 咖啡 / 購物 / 預約 / 票務 / 陪伴域規則隨 SKILL 下架一併移除；
 * 危機詞短路改為本地靜態關懷文案（不依賴任何 SKILL 與雲端可達性）。
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

/**
 * 行程複合意圖規劃（「什麼時候去什麼地方幹什麼」）
 *
 * 展開策略（2026-10 技能收敛後，票務 / 咖啡 / 預約域已下架，
 * 行程任務組瘦身為出行配套）：
 *   1. 目的地天氣（get_weather，座標命中演示城市表才生成）
 *   2. 城際交通（search_train；出發城市取用戶所在城市，缺失或與目的地
 *      相同時缺省北京）
 *
 * 活動槽位仍為三要素之一（行程建檔標籤），但不再展開活動域任務。
 *
 * 寫操作安全口徑：僅當意圖含買詞（買 / 訂 / 下單）且指向車票
 * （點名「車票 / 高鐵票」）才追加 book_ticket——「想去看看」不直接下單。
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

  // 2. 城際交通查詢（只讀；與既有單域分支同構的查詢參數）
  const userCity = ctx.userProfile.location?.city;
  const from = userCity && userCity !== slots.city ? userCity : '北京';
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

  // 買詞判定：票務域已下架，「買 / 訂」泛詞不再預設指向車票（避免
  // 「去看演唱會把票買了」被誤訂成車票）——僅點名「車票 / 高鐵票 /
  // 火車票」才追加 book_ticket；門票類需求由兜底文案如實告知未支援
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
  // 表達一律以本地靜態關懷文案回應（2026-10 技能收敛：陪伴對話 SKILL
  // 已下架，安全網不隨之下架——不依賴任何 SKILL 與雲端可達性，離線
  // 也能即刻回應；空 tasks + message 走 NEEDS_INPUT 收斂，狀態機零改動）
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

  // 支付意圖短路（2026-10 跳轉模式改版）：獨立短路分支必須優先於各業務域
  // 判定——訂單指令攜帶「高鐵票訂單」等標題詞，若不短路會誤觸發 wantsTrain
  // 等域規則產生錯誤下單任務。跳轉模式下真實支付發生在渠道側（12306 /
  // OTA 收銀台），站內無代付能力（個人主體無法開通微信支付商戶號），
  // 僅回覆引導文案。
  if (/支付|付款/.test(intent)) {
    return {
      tasks: [],
      message: '真實支付在官方渠道完成：請點擊購票卡上的「前往下單 / 複製資訊」按鈕，跳轉 12306 / OTA 小程序完成下單與支付。',
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

  const wantsTrain = /高[铁鐵]|动[车車]|火[车車]|[车車][次票]|12306/.test(intent);
  // 機票域：域詞命中（「飛」單字歧義大，僅收「飛往 / 坐飛 / 搭機」等組合詞）
  const wantsFlight = /機票|机票|航班|飛機|飞机|飛往|飞往|搭機|搭机|坐飛|坐飞/.test(intent);
  // 買 / 訂 / 下單均視為下單意圖（觸發寫操作任務）
  const wantsBuy = /[买買訂订]|下[单單]/.test(intent);
  // 天氣域：只讀查詢；座標由 ctx.userProfile.location 提供（context 構建時
  // wx.getLocation 取得，見 core/context.ts fetchLocation）
  const wantsWeather = /天氣|天气|氣溫|气温|溫度|温度|幾度|几度|下雨/.test(intent);

  if (wantsTrain) {
    const cities = extractCities(intent);
    const from = cities[0] ?? '北京';
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
    const cities = extractCities(intent);
    const from = cities[0] ?? '北京';
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

  // 天氣查詢：只讀單任務；座標寫字面值（城市僅用於展示標籤）。
  // 座標缺失時不生成任務——定位未授權 / 失敗時由末尾分支統一追問定位授權
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

  if (tasks.length === 0) {
    // 天氣意圖但無定位：優先追問定位授權（座標為 get_weather 必填入參）
    if (wantsWeather) {
      return {
        tasks: [],
        message: '查詢天氣需要定位：請確認已允許小程序使用你的位置，然後再試。',
      };
    }
    return {
      tasks: [],
      message:
        '尚未支援此意圖。目前可辦：高鐵車次查詢與跳轉 12306 購票、國內航班查詢與跳轉 OTA 購票、' +
        '實時天氣查詢，以及一句話出行行程規劃（車次 + 天氣 + 行程時間線）。',
    };
  }
  return { intent, tasks, message: '' };
}
