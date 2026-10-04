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
 *   2. applyPassengerSlot：規劃後處理——book_ticket 任務缺乘車人時代碼級回填
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

/** 18 位身份證號（末位可為 X/x） */
const ID_RE = /\d{17}[\dXx]/;

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
 * 規劃後處理：book_ticket 任務缺乘車人時，以對話中已提供的信息回填
 *
 * 背景：LLM 已從上下文槽位「知道」乘車人，但實測可能未寫入任務參數
 * （確認彈窗缺 passengerName → 執行校驗失敗）。此為代碼級兜底，
 * 與 prompt 約束（規則 8 乘車人寫入義務）構成雙保險。
 *
 * @returns 是否發生了回填（供調用方記日誌；日誌不得攜帶姓名 / 證號明文）
 */
export function applyPassengerSlot(plan: Plan, messages: MsgLike[]): boolean {
  const p = extractPassenger(messages);
  if (!p) return false;
  let patched = false;
  for (const t of plan.tasks) {
    if (t.skillId !== 'skill.train.12306' || t.action !== 'book_ticket') continue;
    if (!t.input.passengerName) {
      t.input.passengerName = p.name;
      patched = true;
    }
    if (!t.input.passengerIdNo) {
      t.input.passengerIdNo = p.idNo;
      patched = true;
    }
  }
  return patched;
}
