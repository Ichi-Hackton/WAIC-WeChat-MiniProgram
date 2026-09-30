/**
 * AgentState 狀態機型別
 *
 * 規範來源：.qoder/rules/Agent.md § 5.1
 */

export type AgentState =
  | 'idle'              // 閒置，等待輸入
  | 'understanding'     // 意圖識別中
  | 'planning'          // 任務拆解中
  | 'confirming_plan'   // 等待用戶確認 Plan
  | 'executing'         // SKILL 執行中
  | 'awaiting_human'    // 等待人類確認（支付等）
  | 'aggregating'       // 結果聚合中
  | 'completed'         // 完成
  | 'failed'            // 失敗
  | 'rolling_back';     // 回滾中

/**
 * 允許的狀態轉移對映表型別（實值見 src/core/orchestrator.ts）
 *
 * 注意：.d.ts 只能承載型別；值宣告放在此處 runtime 會取不到，
 * 因此 ALLOWED_TRANSITIONS 實值定義於 orchestrator.ts 並由其消費。
 */
export type AgentTransitionTable = Readonly<Record<AgentState, ReadonlyArray<AgentState>>>;

/** Agent 對外回應（給 UI 渲染用） */
export interface AgentResponse {
  /** 主要給用戶看的訊息（已含 ai_generated 標識） */
  message: string;
  /** 結構化卡片（可選） */
  cards?: AgentCard[];
  /** 最終狀態 */
  state: AgentState;
  /** 失敗時的錯誤碼 */
  errorCode?: string;
}

/** Agent 動態卡片 */
export interface AgentCard {
  /** 卡片類型：plan / result / error */
  type: 'plan' | 'result' | 'error' | 'info';
  /** 卡片標題 */
  title: string;
  /** 卡片內容（JSON 序列化） */
  payload: Record<string, unknown>;
}