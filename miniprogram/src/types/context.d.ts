/**
 * AgentContext 型別定義
 *
 * 規範來源：.qoder/rules/Agent.md § 6.3
 *
 * Context 為單次會話的全域狀態容器。**不跨會話持久化**（規範 § 10 紅線）。
 */

import type { Plan } from './plan';

/** 用戶位置（城市優先取地址簿默認地址，未填寫時由定位 + 雲端逆地理編碼補全） */
export interface UserLocation {
  /** 緯度（gcj02）；地址簿已填城市而定位未授權 / 失敗時缺失（僅有城市上下文） */
  lat?: number;
  /** 經度（gcj02）；同上可能缺失 */
  lng?: number;
  /** 城市名（如「深圳」；已歸一化去行政區後綴）——優先取地址簿默認地址市級，
   *  未填寫時由雲端 /api/geo/reverse 補全，兩者均無時缺失 */
  city?: string;
  /** 城市來源（出發城市優先級的能見度：地址簿 > 定位） */
  citySource?: 'address_book' | 'geocode' | 'native';
  /** 當前城市（2026-10-16 新增）：定位所得城市（原生 city / 雲端逆地理），
   *  與地址簿無關——「我現在在哪」語義（天氣預報 get_forecast、實況展示
   *  標籤等）取此值，不受出發城市（地址簿優先）壓制；定位不可用或城市
   *  解析失敗時缺失，消費方此時追問用戶而非靜默回退地址簿 */
  currentCity?: string;
}

/** 定位授權狀態（context 構建時由 fetchLocation 寫入；區分「拒絕授權」與「定位失敗」） */
export type LocationAuth =
  | 'granted'    // 已授權且取到座標
  | 'denied'     // 用戶拒絕授權（errMsg 含 auth deny / denied / permission）
  | 'error';     // 非授權原因失敗（系統定位開關關閉 / 網路異常等）

/** 用戶畫像 */
export interface UserProfile {
  location?: UserLocation;
  /** 定位授權狀態；缺失表示本輪未嘗試定位（withLocation=false 或無 wx 環境） */
  locationAuth?: LocationAuth;
  /** 家地址摘要（2026-10-14 新增；地址簿默認收貨地址，空簿缺失）——
 *  「我家附近」類 POI 意圖的查詢中心供給（search_poi 的 address 參數） */
  homeAddress?: { city: string; full: string };
  /** 用戶偏好（長期記憶：storage/preferences 白名單域，如飲食、座位類型；
   *   隱式對話沉澱 + 顯式手動設置雙軌寫入，本地落盤待雲端同步） */
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