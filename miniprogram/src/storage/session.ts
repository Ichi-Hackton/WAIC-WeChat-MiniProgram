/**
 * 會話儲存
 *
 * 規範來源：.qoder/rules/Agent.md § 6.3
 *
 * 注意：AgentContext 不跨會話持久化（規範 § 10 紅線），
 * 此模組僅保存脫敏的歷史意圖摘要，供用戶畫像使用。
 * 寫入側統一經 sanitizeIntent 打碼強敏感模式（證號 / 手機號）。
 */

import { setItem, getItem } from '../services/storage';
import type { ChatMessage } from '../types/context';

const HISTORY_KEY = 'session:history';
const MAX_HISTORY = 50;

/**
 * 18 位身份證號（末位可 X/x；寬鬆子串匹配，與 utils/passenger.ts 的
 * ID_RE 同構——寧多脫敏不漏，長數字串誤殺無害，僅供 replace 使用）
 */
const ID_NO_RE = /\d{17}[\dXx]/g;

/** 11 位大陸手機號（1 開頭第二位 3-9；寬鬆子串匹配，僅供 replace 使用） */
const PHONE_RE = /1[3-9]\d{9}/g;

/**
 * 意圖摘要脫敏（§ 10 紅線）：把文本中的強敏感模式替換為語義占位符
 *
 * 順序必須先證號（18 位）後手機號（11 位）——18 位數字串含 11 位子串，
 * 先短會把證號部分吞成手機號形態。姓名不脫敏：上下文無關的姓名識別
 * 誤傷率過高（會誤殺地名等同形短詞），且意圖摘要中姓名敏感度低於證號；
 * 消費方（planner「最近意圖」）僅取語義方向，占位符不影響規劃。
 * 消費側截斷（context.ts HISTORY_INTENT_MAX）必須在本函數之後——
 * 截斷可能把 18 位證號切成 15 位脱離正則模式而漏脫敏。
 */
export function sanitizeIntent(intent: string): string {
  return intent
    .replace(ID_NO_RE, '[證件號已脫敏]')
    .replace(PHONE_RE, '[手機號已脫敏]');
}

/** 會話歷史（含脫敏） */
export interface SessionHistoryEntry {
  intent: string;
  timestamp: number;
  planId?: string;
  state: 'completed' | 'failed' | 'cancelled';
}

export function appendHistory(entry: SessionHistoryEntry): void {
  const list = getHistory();
  // 寫入側統一脫敏：調用方（app.ts handleIntent）傳入的是原始用戶輸入，
  // 口述乘車人證號 / 手機號的意圖在此打碼，落盤永不存明文
  list.push({ ...entry, intent: sanitizeIntent(entry.intent) });
  if (list.length > MAX_HISTORY) list.shift();
  setItem(HISTORY_KEY, list);
}

export function getHistory(): SessionHistoryEntry[] {
  return getItem<SessionHistoryEntry[]>(HISTORY_KEY, []) ?? [];
}

export function clearHistory(): void {
  setItem(HISTORY_KEY, []);
}

/** 清空本機對話訊息（隱私控制中心「清除會話歷史」聯動；與 clearHistory 分離——歷史摘要與訊息明細屬不同存儲鍵） */
export function clearMessages(): void {
  setItem('session:messages', []);
}

/** 把當前會話的 ChatMessage 同步到本機（脫敏版） */
export function syncMessages(messages: ChatMessage[]): void {
  // 僅保留 role + timestamp + content 前 100 字
  const slim = messages.map((m) => ({
    role: m.role,
    content: m.content.slice(0, 100),
    timestamp: m.timestamp,
  }));
  setItem('session:messages', slim);
}