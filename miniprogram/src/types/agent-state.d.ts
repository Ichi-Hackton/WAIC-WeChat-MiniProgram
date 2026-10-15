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

/** 記憶提議條目（AgentResponse.memoryProposal 元素） */
export interface MemoryProposalEntry {
  /** 偏好鍵（storage/preferences 白名單域鍵，如 seat） */
  key: string;
  /** 中文域標籤（如「高鐵座位」） */
  label: string;
  /** 偏好值（已脫敏截斷，如「靠窗」） */
  value: string;
  /** suggested=推斷提議（一次性需求推斷習慣，待確認卡詢問「以後都這樣做嗎？」）；
   * remembered=已直接記住（用戶顯式長期指令，回執卡告知，無按鈕） */
  status: 'suggested' | 'remembered';
}

/**
 * 個人資料保存提議條目（AgentResponse.profileProposal 元素）
 *
 * 對話捕獲（2026-10）：用戶口述乘車人 / 收貨地址 → 顯式指令直接落盤
 * （remembered 回執）或推斷提議（suggested 確認卡，用戶點「保存」才
 * 落盤）。安全設計：提取層寬鬆但落盤前必過全量校驗（checkIdNo /
 * validateAddressForm），證號僅卡面脫敏展示、input 攜完整值供 UI 回傳
 * （所見即所寫；脫敏為展示策略，落盤值 = 提取值 = 卡面 input 值）。
 */
export interface ProfileProposalEntry {
  /** 提議鍵（乘車人 = 'passenger'；地址 = 'address'） */
  key: 'passenger' | 'address';
  /** 中文標籤（「乘車人」/「收貨地址」） */
  label: string;
  /** 卡面展示行（證號 / 手機號已脫敏；invalid 條目僅展示已提取部分） */
  lines: Array<{ label: string; value: string }>;
  /** 完整保存輸入（UI 確認時原樣回傳；僅存活於內存與對話輪次，不落盤） */
  input: Record<string, unknown>;
  /** suggested=推斷提議（確認卡按鈕）；remembered=顯式已保存回執（無按鈕）；
   * invalid=校驗未過告知（顯式指令但提取值不合法，引導手動補錄，無按鈕） */
  status: 'suggested' | 'remembered' | 'invalid';
  /** 回執 / 告知補充說明（如「已在乘車人簿中，無需重複保存」/ 校驗錯誤文案） */
  note?: string;
}

/** Agent 對外回應（給 UI 渲染用） */
export interface AgentResponse {
  /** 主要給用戶看的訊息（已含 ai_generated 標識） */
  message: string;
  /** 結構化卡片（可選） */
  cards?: AgentCard[];
  /** 能力缺口（CAPABILITY_GAP 錯誤碼配套，動態技能計劃新增）：
   *  UI 據此渲染「去技能中心鍛造」引導卡，攜帶意圖預填技能中心 */
  capabilityGap?: {
    /** 觸發缺口的用戶原始意圖（預填鍛造需求） */
    intent: string;
    /** 建議的新技能名 */
    skillName: string;
    /** 給用戶的一句話建議 */
    suggestion: string;
  };
  /** 記憶卡提議（可選）：顯式已記住的回執（remembered）與推斷提議的
   * 確認卡（suggested，「以後都這樣做嗎？」）——用戶確認後經 runtime.
   * confirmMemory / dismissMemory 落盤或丟棄（記憶須用戶知情可控，§ 10 精神） */
  memoryProposal?: MemoryProposalEntry[];
  /** 個人資料保存提議（可選，對話捕獲）：乘車人 / 收貨地址口述 → 顯式
   * 直存回執（remembered）與推斷提議確認卡（suggested）——用戶確認後
   * 經 runtime.confirmProfileSave / dismissProfileProposal 落盤或丟棄；
   * 落盤前雙重校驗 + 查重，證號加密存於本機（隱私 § 10） */
  profileProposal?: ProfileProposalEntry[];
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