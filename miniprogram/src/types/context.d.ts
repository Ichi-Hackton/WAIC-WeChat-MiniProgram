/**
 * AgentContext 型別定義
 *
 * 規範來源：.qoder/rules/Agent.md § 6.3
 *
 * Context 為單次會話的全域狀態容器。**不跨會話持久化**（規範 § 10 紅線）。
 */

import type { Plan } from './plan';

/** 用戶位置（從 wx.getLocation 取得） */
export interface UserLocation {
  lat: number;
  lng: number;
  city?: string;
}

/** 用戶畫像 */
export interface UserProfile {
  location?: UserLocation;
  /** 用戶偏好（如飲食、座位類型） */
  preferences: Record<string, unknown>;
  /** 歷史意圖（脫敏後，僅保留語意摘要） */
  history: Array<{ intent: string; timestamp: number }>;
}

/** 對話訊息（多輪對話用） */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** 訊息內容（純文字或 Markdown） */
  content: string;
  /** 附帶元資料（如 Task ID、卡片 schema） */
  metadata?: Record<string, unknown>;
  /** 時間戳 */
  timestamp: number;
}

/** Agent 全域追蹤資訊 */
export interface TraceInfo {
  llmCalls: number;
  skillCalls: number;
  totalTokens: number;
  startTime: number;
}

/** Agent 會話上下文 */
export interface AgentContext {
  /** 會話 ID */
  sessionId: string;
  /** 用戶 ID（openid） */
  userId: string;
  /** 用戶畫像 */
  userProfile: UserProfile;
  /** 當前 Plan（規劃完成後注入） */
  plan?: Plan;
  /** 全域變數（雲端環境 ID、當前時間等） */
  globals: Record<string, unknown>;
  /** 會話歷史（多輪對話） */
  messages: ChatMessage[];
  /** 追蹤資訊 */
  trace: TraceInfo;
}