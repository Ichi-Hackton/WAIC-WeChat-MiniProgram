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

/** 從意圖抽取日期（今天 / 明天 / 後天，缺省今天） */
function extractDate(intent: string): string {
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

/** 從意圖識別飲品名 */
function extractDrink(intent: string): string {
  if (/美式/.test(intent)) return '美式咖啡';
  if (/摩卡/.test(intent)) return '摩卡';
  return '拿鐵';
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
  const wantsCoffee = /星巴克|咖啡|拿[铁鐵]|美式|摩卡/.test(intent);
  // 買 / 訂 / 下單 / 來一杯 / 幫我點 均視為下單意圖（觸發寫操作任務）
  const wantsBuy = /[买買訂订]|下[单單]|[来來][一]?[杯個份]|[帮幫]我[点點]/.test(intent);

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
      tasks.push({
        skillId: 'skill.train.12306',
        action: 'book_ticket',
        input: {
          date,
          seatType,
          // 開發模式演示資料；checkpoint 彈窗會完整展示，由用戶確認
          passengerName: '演示乘客',
          passengerIdNo: '110101199001011234',
        },
        inputBindings: {
          trainNo: { fromTaskId: searchTaskId, fromField: 'trainNo' },
        },
        dependsOn: [searchTaskId],
        summary: `下單 ${from}→${to} 車票（需確認）`,
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

  if (tasks.length === 0) {
    return {
      tasks: [],
      message: '尚未支援此意圖。目前可演示：高鐵車次查詢與購票、星巴克門市查詢與點單。',
    };
  }
  return { intent, tasks, message: '' };
}
