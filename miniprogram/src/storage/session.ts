/**
 * 會話儲存
 *
 * 規範來源：.qoder/rules/Agent.md § 6.3
 *
 * 注意：AgentContext 不跨會話持久化（規範 § 10 紅線），
 * 此模組僅保存脫敏的歷史意圖摘要，供用戶畫像使用。
 */

import { setItem, getItem } from '../services/storage';
import type { ChatMessage } from '../types/context';

const HISTORY_KEY = 'session:history';
const MAX_HISTORY = 50;

/** 會話歷史（含脫敏） */
export interface SessionHistoryEntry {
  intent: string;
  timestamp: number;
  planId?: string;
  state: 'completed' | 'failed' | 'cancelled';
}

export function appendHistory(entry: SessionHistoryEntry): void {
  const list = getHistory();
  list.push(entry);
  if (list.length > MAX_HISTORY) list.shift();
  setItem(HISTORY_KEY, list);
}

export function getHistory(): SessionHistoryEntry[] {
  return getItem<SessionHistoryEntry[]>(HISTORY_KEY, []) ?? [];
}

export function clearHistory(): void {
  setItem(HISTORY_KEY, []);
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