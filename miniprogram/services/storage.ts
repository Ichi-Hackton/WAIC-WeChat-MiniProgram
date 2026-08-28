/**
 * 本地存儲服務（wx API 唯一入口）。
 *
 * 隱私承諾（Agent.md）：
 * - 只存儲引導檔案、對話進度與清單狀態，不存儲身份證號等敏感信息；
 * - 提供 clearAllData() 支撐「一鍵清除」。
 */

import type { ChatMessage, GuideProfile } from '../utils/guidance-flow';
import type { ChecklistState, GeneratedChecklist } from '../utils/checklist-generator';
import { emptyChecklistState } from '../utils/checklist-generator';

export interface GuideSession {
  messages: ChatMessage[];
  profile: GuideProfile;
  finished: boolean;
}

const KEYS = {
  SESSION: 'guide_session',
  CHECKLIST: 'checklist',
  CHECKLIST_STATE: 'checklist_state',
  FIRST_USE_ACK: 'first_use_ack',
} as const;

function read<T>(key: string, fallback: T): T {
  try {
    const value = wx.getStorageSync(key);
    return value === '' || value === undefined || value === null ? fallback : (value as T);
  } catch (_e) {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    wx.setStorageSync(key, value);
  } catch (_e) {
    // 存儲失敗不阻塞主流程（隱私模式下可能不可寫）
  }
}

function remove(key: string): void {
  try {
    wx.removeStorageSync(key);
  } catch (_e) {
    // 忽略
  }
}

// ---------- 引導會話（斷點恢復：用戶已說過的信息不再重複詢問） ----------

export function getGuideSession(): GuideSession | null {
  return read<GuideSession | null>(KEYS.SESSION, null);
}

export function saveGuideSession(session: GuideSession): void {
  write(KEYS.SESSION, session);
}

export function clearGuideSession(): void {
  remove(KEYS.SESSION);
}

// ---------- 辦理清單 ----------

export function getChecklist(): GeneratedChecklist | null {
  return read<GeneratedChecklist | null>(KEYS.CHECKLIST, null);
}

export function saveChecklist(checklist: GeneratedChecklist): void {
  write(KEYS.CHECKLIST, checklist);
}

export function getChecklistState(): ChecklistState {
  const state = read<Partial<ChecklistState> | null>(KEYS.CHECKLIST_STATE, null);
  if (!state) {
    return emptyChecklistState();
  }
  return {
    done: state.done || {},
    claimers: state.claimers || {},
    customItems: state.customItems || [],
  };
}

export function saveChecklistState(state: ChecklistState): void {
  write(KEYS.CHECKLIST_STATE, state);
}

// ---------- 首次使用（隱私政策明確告知） ----------

export function isFirstUse(): boolean {
  return read<boolean>(KEYS.FIRST_USE_ACK, false) === false;
}

export function ackFirstUse(): void {
  write(KEYS.FIRST_USE_ACK, true);
}

// ---------- 一鍵清除 ----------

/** 清除本應用產生的全部本地數據（對話結束後可隨時調用） */
export function clearAllData(): void {
  remove(KEYS.SESSION);
  remove(KEYS.CHECKLIST);
  remove(KEYS.CHECKLIST_STATE);
  remove(KEYS.FIRST_USE_ACK);
}
