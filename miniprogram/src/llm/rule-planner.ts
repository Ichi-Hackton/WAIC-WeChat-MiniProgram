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
 *   3. 下單任務的乘客 / 商品為演示資料，確認彈窗會完整展示入參
 */

import { addDays, formatDate } from '../utils/datetime';
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

/** 從意圖識別飲品名 */
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

/**
 * 從意圖提取預約時段：優先「HH:mm」字面值，其次時段詞映射到
 * 服務目錄的固定時刻槽（10/12/14/16/18/20 點），未點名返回 null
 */
function extractStartTime(intent: string): string | null {
  const literal = intent.match(/([01]?\d|2[0-3]):[0-5]\d/);
  if (literal) return literal[0];
  if (/早上|清晨/.test(intent)) return '10:00';
  if (/上午/.test(intent)) return '10:00';
  if (/中午/.test(intent)) return '12:00';
  if (/下午/.test(intent)) return '14:00';
  if (/傍晚/.test(intent)) return '16:00';
  if (/晚上|夜裡|夜里/.test(intent)) return '18:00';
  return null;
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

  const wantsTrain = /高[铁鐵]|动[车車]|火[车車]|[车車][次票]|12306/.test(intent);
  // 「咖啡(?!豆)」：買咖啡豆屬購物域，避免與商城 SKILL 雙觸發
  const wantsCoffee = /星巴克|咖啡(?!豆)|拿[铁鐵]|美式|摩卡/.test(intent);
  // 買 / 訂 / 下單 / 來一杯 / 幫我點 均視為下單意圖（觸發寫操作任務）
  const wantsBuy = /[买買訂订]|下[单單]|[来來][一]?[杯個份]|[帮幫]我[点點]/.test(intent);
  // 購物域：域詞或商品詞命中（「咖啡豆」歸此域而非咖啡點單）
  const wantsShopping =
    /购物|購物|商城|商品|加[购購]|結[帳账]|结账|結算|结算|買東西|买东西/.test(intent) ||
    PRODUCT_MAP.some(([re]) => re.test(intent));
  // 結算意圖：購物車已有商品，直接結帳（不重搜不加購）
  const wantsCheckout = /結[帳账]|结账|結算|结算/.test(intent);
  // 預約域：域詞或服務詞命中
  const wantsBooking =
    /預約|预约|預訂|预订/.test(intent) || SERVICE_MAP.some(([re]) => re.test(intent));
  // 預約查詢意圖（「我的預約」）：只讀清單，不建預約
  const wantsListReservations = /我的預約|我的预约|查.{0,4}預約|查.{0,4}预约/.test(intent);

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
        summary: `下單 ${trainNo ?? from + '→' + to} 車票（需確認）`,
      });
    }
  }

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
        summary: `下單一杯${drink}（需確認）`,
      });
    }
  }

  if (wantsShopping && !wantsCheckout) {
    const product = extractProduct(intent);
    const searchTaskId = `task_${padTaskNo(tasks.length + 1)}`;
    tasks.push({
      skillId: 'skill.shopping.mall',
      action: 'search_products',
      input: product ? { keyword: product.name } : {},
      inputBindings: {},
      dependsOn: [],
      summary: product ? `查詢「${product.name}」商品` : '瀏覽商城商品',
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

  // 結算：單任務（購物車狀態由雲端 / mock 會話持有，無需先查詢）
  if (wantsShopping && wantsCheckout) {
    tasks.push({
      skillId: 'skill.shopping.mall',
      action: 'checkout',
      input: {},
      inputBindings: {},
      dependsOn: [],
      summary: '結算購物車並建立訂單（需確認）',
    });
  }

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
      if (service) {
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
          summary: `預約${service.name} ${date}${startTime ? ' ' + startTime : '（首個可約時段）'}（需確認）`,
        });
      }
    }
  }

  if (tasks.length === 0) {
    return {
      tasks: [],
      message:
        '尚未支援此意圖。目前可演示：高鐵車次查詢與購票、星巴克門市查詢與點單、' +
        '商品搜索與加購結算、運動場館 / 醫療 / 生活服務預約。',
    };
  }
  return { intent, tasks, message: '' };
}
