/**
 * 乘車人信息槽位（純函數）
 *
 * 規範來源：.qoder/rules/Agent.md § 12.3（utils 純函數約束）
 *
 * 背景：planner 的對話上下文是滑動窗口（尾部數條），乘車人信息一旦被擠出，
 *       LLM 會反覆追問或漏填 passengerName → book_ticket 校驗失敗
 *       （「缺少必填值」實測復現，車次卡「預訂」按鈕的自然路徑因此死鎖）。
 *       本模組提供兩個能力：
 *   1. extractPassenger：從對話歷史提取「姓名 + 18 位證件號」（最近一次提供）
 *   2. applyPassengerSlot：規劃後處理——下單任務缺乘車人時代碼級回填
 *      （回填優先級：對話明說 > 乘車人簿默認人 fallback；rule-planner 的
 *      演示佔位值亦會被真實信息覆蓋）
 *
 * 純函數約束：本檔案不得 import wx.*；可被 llm/ 與 core/ 共用
 */

import type { Plan } from '../types/plan';

/** 提取結果：姓名 + 18 位證件號（末位 X 統一大寫） */
export interface PassengerInfo {
  name: string;
  idNo: string;
}

/** 對話訊息的最小結構（避免耦合 context.d.ts 的完整定義） */
interface MsgLike {
  role: string;
  content: string;
}

/** 18 位身份證號（末位可為 X/x；子串匹配語義，供對話提取用） */
const ID_RE = /\d{17}[\dXx]/;

/**
 * 身份證欄位深度校驗（純函數，表單錄入層專用）
 *
 * 三級校驗（逐級短路，返回首個失敗級別；全部通過返回 null）：
 *   1. format     ：18 位格式（前 17 位數字 + 末位數字或 X）
 *   2. birthdate  ：第 7~14 位為真實日曆日（範圍 1900-01-01 ~ 今日）
 *   3. checksum   ：GB 11643-1999 校驗碼（前 17 位加權求和 mod 11 對照表）
 *
 * 設計理由（為何要校驗碼）：僅憑格式正則，亂輸 17 位數字也能建檔；
 * 乘車人簿是下單自動帶入的數據源，錯誤證號會在 12306 / 機票
 * 實名核驗時才失敗（錯誤暴露得太晚）。錄入時擋下，錯誤暴露在最便宜的位置。
 *
 * 分層決策（校驗碼僅限表單層）：extractPassenger 對話提取保持寬鬆
 * （僅格式匹配）——演示句式「身份證110101199001011234」的演示證號
 * 本身不通過校驗碼，若提取層收緊會切斷開發者工具的離線演示鏈路；
 * 對話口誤回填的風險由確認彈窗完整展示入參兜底。
 *
 * 出生日期坑：JS Date 對溢位日（如 1990-02-32）會自動進位到 3 月，
 * 必須以「回拼年月日比對」堵住假陽性，不能只判 Date 建構成功。
 */
export function checkIdNo(idNo: string): 'format' | 'birthdate' | 'checksum' | null {
  const s = idNo.trim().toUpperCase();
  if (!/^\d{17}[\dX]$/.test(s)) return 'format';

  // 第 7~14 位出生日期：真實日曆日回拼比對（範圍 1900-01-01 ~ 今日）
  const y = Number(s.slice(6, 10));
  const m = Number(s.slice(10, 12));
  const d = Number(s.slice(12, 14));
  if (y < 1900 || m < 1 || m > 12 || d < 1 || d > 31) return 'birthdate';
  const date = new Date(y, m - 1, d);
  if (
    date.getFullYear() !== y ||
    date.getMonth() !== m - 1 ||
    date.getDate() !== d ||
    date.getTime() > Date.now()
  ) {
    return 'birthdate';
  }

  // GB 11643-1999 校驗碼：前 17 位逐一乘加權因子求和，mod 11 查對照表
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(s.charAt(i)) * ID_WEIGHTS[i];
  if (ID_CHECK_CHARS[sum % 11] !== s.charAt(17)) return 'checksum';
  return null;
}

/** 校驗碼加權因子（GB 11643-1999：第 1~17 位從左至右） */
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];

/** 加權和 mod 11 → 應有校驗碼對照表（GB 11643-1999 附錄） */
const ID_CHECK_CHARS = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

/**
 * 剝離詞表：前綴稱謂 / 證件類詞 / 動詞短語 / 連接字 / 人稱代詞
 * （長詞必須在前：正則交替從左到右優先匹配，長詞在後會被短詞截斷）
 */
const STOP_WORDS =
  '乘車人|乘车人|乘客|乘員|乘员|姓名|名字|身份證號碼|身份证号码|身份證|身份证|證件號碼|证件号码|證件號|证件号|證號|证号|號碼|号码|買票|买票|訂票|订票|購票|购票|出行|乘車|乘车|幫|帮|给|給|为|為|替|請|请|是|叫|我|你|他|她|的|了|号|號|码|碼';

/** 段內迭代剝離（頭尾同時剥，直到穩定） */
function cleanSeg(seg: string): string {
  const head = new RegExp(`^(?:${STOP_WORDS})`);
  const tail = new RegExp(`(?:${STOP_WORDS})$`);
  let prev = '';
  while (prev !== seg && seg) {
    prev = seg;
    seg = seg.replace(head, '').replace(tail, '');
  }
  return seg;
}

/**
 * 從對話歷史提取乘車人（倒序掃描，取最近一次提供者）
 *
 * 支持句式（演示主路徑）：
 *   「乘車人張三，身份證110101199001011234」「張三 110101199001011234」
 *   「訂票，乘車人是王小明，證件號110101199001011234」
 *
 * 提取不到時返回 null——調用方保持原有「向用戶追問」語義，
 * 寧可不填也不填錯（錯誤姓名下單比缺參更糟）
 */
export function extractPassenger(messages: MsgLike[]): PassengerInfo | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const idMatch = m.content.match(ID_RE);
    if (!idMatch || idMatch.index === undefined) continue;
    const name = extractNameBefore(m.content.slice(0, idMatch.index));
    if (name) return { name, idNo: idMatch[0].toUpperCase() };
  }
  return null;
}

/**
 * 證號左側文本 → 姓名（倒序逐段剝離驗證）
 *
 * 策略：按分隔符切段後從後往前找——每段迭代剝離頭尾的稱謂 / 證件詞 /
 * 動詞短語，剝完仍為 2-4 個純漢字整段者認定為姓名（全匹配防吞詞）。
 * 從後往前：姓名通常是最靠近證號的「人名段」，證件詞獨立成段
 * （如「…張三，身份證110…」的「身份證」段）會被剝空自動跳過
 */
function extractNameBefore(left: string): string | null {
  const parts = left.split(/[，,、。；;:：（）()\s]+/).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = cleanSeg(parts[i]);
    if (/^[\u4e00-\u9fa5]{2,4}$/.test(seg)) return seg;
  }
  return null;
}

/**
 * 規劃後處理：下單任務缺乘車人時回填（火車 / 機票兩域）
 *
 * 背景：LLM 已從上下文槽位「知道」乘車人，但實測可能未寫入任務參數
 * （確認彈窗缺 passengerName → 執行校驗失敗）。此為代碼級兜底，
 * 與 prompt 約束（規則 8 乘車人寫入義務）構成雙保險。
 *
 * 回填優先級：對話提取（本輪明說最準確）> fallback（乘車人簿默認人，
 * 由調用方從 storage 讀入後傳入——本模組保持純函數不碰 wx）。
 *
 * 覆蓋條件（三選一）：
 *   1. 欄位缺失（LLM 漏填）
 *   2. 姓名為 rule-planner 演示佔位（「演示乘客」）
 *   3. 證號為 rule-planner 演示佔位（110101199001011234）
 * 任務已填真實乘車人時不覆蓋（寧可不填也不填錯，錯誤姓名下單比缺參更糟）
 *
 * @param fallback 乘車人簿默認人（無則傳 null；對話提取優先於此值）
 * @returns 是否發生了回填（供調用方記日誌；日誌不得攜帶姓名 / 證號明文）
 */
export function applyPassengerSlot(
  plan: Plan,
  messages: MsgLike[],
  fallback: PassengerInfo | null = null,
): boolean {
  const fromChat = extractPassenger(messages);
  const p = fromChat ?? fallback;
  if (!p) return false;
  let patched = false;
  for (const t of plan.tasks) {
    const fields = BOOKING_FIELDS.find((f) => f.skillId === t.skillId && f.action === t.action);
    if (!fields) continue;
    const nameVal = typeof t.input[fields.nameField] === 'string' ? (t.input[fields.nameField] as string) : '';
    const idVal = typeof t.input[fields.idField] === 'string' ? (t.input[fields.idField] as string) : '';
    const nameIsPlaceholder = !nameVal || DEMO_NAMES.has(nameVal);
    const idIsPlaceholder = !idVal || idVal.toUpperCase() === DEMO_ID_NO;
    if (nameIsPlaceholder) {
      t.input[fields.nameField] = p.name;
      patched = true;
    }
    if (idIsPlaceholder) {
      t.input[fields.idField] = p.idNo;
      patched = true;
    }
  }
  return patched;
}

/**
 * 下單任務實名信息缺失檢查結果（findFirstMissingBookingPassenger 返回）
 *
 * roleLabel / missingFields 均為中文標籤——本結果會流入 log 與用戶追問
 * 文案，不得攜帶英文欄位名（脱敏規範）與姓名 / 證號明文（隱私 § 10）
 */
export interface MissingPassengerInfo {
  taskId: string;
  /** 角色中文標籤（乘車人 / 觀演人） */
  roleLabel: string;
  /** 缺失項中文標籤（姓名 / 證件號） */
  missingFields: string[];
}

/**
 * 檢查 Plan 中下單任務是否仍缺實名信息（applyPassengerSlot 回填後的最終防線）
 *
 * 背景：LLM 對「缺乘車人」的訂票意圖本應按 prompt 規則 9 回空 tasks 追問，
 * 實測仍會規劃 book_ticket 並「整鍵省略」passengerName / passengerIdNo
 * ——assertNoPlaceholder 只檢查已存在鍵的值，鍵缺席時攔不住；
 * applyPassengerSlot 在對話與乘車人簿均無信息時也無從回填。此類 Plan
 * 帶病執行的結局是：查詢任務成功、下單任務在校驗層失敗（「缺少必填
 * 欄位」實測復現），用戶只看到半途而廢的結果。本函數供規劃後處理調用，
 * 把失敗提前到 planning 階段轉為追問（錯誤暴露在最便宜的位置）。
 *
 * 空字串視同缺失（與 validator 2026-10 收緊語義對齊）；已被 inputBindings
 * 覆蓋的鍵豁免——值將由上游任務輸出填充（與 assertNoPlaceholder 口徑一致）
 *
 * @returns 首個缺失任務的信息；全部齊全返回 null
 */
export function findFirstMissingBookingPassenger(plan: Plan): MissingPassengerInfo | null {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  for (const t of plan.tasks) {
    const f = BOOKING_FIELDS.find((x) => x.skillId === t.skillId && x.action === t.action);
    if (!f) continue;
    const bound = t.inputBindings ?? {};
    const missing: string[] = [];
    if (!(f.nameField in bound) && str(t.input[f.nameField]) === '') missing.push('姓名');
    if (!(f.idField in bound) && str(t.input[f.idField]) === '') missing.push('證件號');
    if (missing.length > 0) return { taskId: t.id, roleLabel: f.roleLabel, missingFields: missing };
  }
  return null;
}

/**
 * 需實名乘車人的下單任務 → 姓名 / 證號欄位映射（skillId + action 精準匹配）
 */
const BOOKING_FIELDS: Array<{
  skillId: string;
  action: string;
  nameField: string;
  idField: string;
  /** 角色中文標籤（追問文案 / 日誌用，不攜帶英文欄位名） */
  roleLabel: string;
}> = [
  { skillId: 'skill.train.12306', action: 'book_ticket', nameField: 'passengerName', idField: 'passengerIdNo', roleLabel: '乘車人' },
  { skillId: 'skill.flight.variflight', action: 'book_flight', nameField: 'passengerName', idField: 'passengerIdNo', roleLabel: '乘車人' },
];

/** rule-planner 演示佔位姓名集（真實乘車人信息應覆蓋之） */
const DEMO_NAMES = new Set(['演示乘客']);

/** rule-planner 演示佔位證號（與 rule-planner.ts 兩處演示數據逐字對齊） */
const DEMO_ID_NO = '110101199001011234';
