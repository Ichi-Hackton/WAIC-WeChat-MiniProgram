/**
 * SKILL 協議型別定義
 *
 * 規範來源：.qoder/rules/Agent.md § 6.1, § 7
 *
 * SkillMeta 為 LLM 規劃依據，故 `description` 必須清楚描述：
 *   - 「能做什麼」
 *   - 「不能做什麼」
 *   - 「何時觸發」
 * 這三段缺一不可，否則 Planner 無法正確路由。
 */

import type { AgentContext } from './context';
import type { JSONSchema } from './jsonschema';

/** SKILL 元資訊（給 LLM 閱讀理解用） */
export interface SkillMeta {
  /** 全域唯一，如 "skill.train.12306" */
  id: string;
  /** 人類可讀名稱 */
  name: string;
  /**
   * LLM 可讀描述，**規劃的關鍵依據**。
   * 必須涵蓋：能做什麼 / 不能做什麼 / 何時觸發
   */
  description: string;
  /** 語意化版本 */
  version: string;
  /** 所屬小程序 appid */
  owner: string;
  /** 分類標籤，如 ["出行", "交通"] */
  tags: string[];
  /** 對外可呼叫能力清單 */
  capabilities: SkillCapability[];
}

/** SKILL 對外能力聲明 */
export interface SkillCapability {
  /** 能力動作名，如 "search_train", "book_ticket" */
  action: string;
  /** LLM 可讀描述 */
  description: string;
  /** 入參 JSON Schema */
  inputSchema: JSONSchema;
  /** 出參 JSON Schema */
  outputSchema: JSONSchema;
  /** 是否冪等（相同 input 重複呼叫結果一致） */
  idempotent: boolean;
  /** 是否可回滾 */
  reversible: boolean;
  /**
   * 是否需要人類確認。
   * **所有寫操作必須為 true**（規範 § 10 紅線）
   */
  requiresHumanConfirm: boolean;
  /** 預估延遲（毫秒），用於 Scheduler 排程估算 */
  estimatedLatencyMs: number;
}

/** SKILL 執行結果 */
export interface SkillResult<T = unknown> {
  /** 是否成功 */
  success: boolean;
  /** 業務資料 */
  data?: T;
  /** 錯誤資訊 */
  error?: SkillError;
  /**
   * 供後續 SKILL 引用的輸出綁定。
   * Scheduler 透過此欄解析 inputBindings。
   */
  bindings?: Record<string, unknown>;
}

/** SKILL 錯誤結構 */
export interface SkillError {
  /** 錯誤代碼（如 "NO_TICKET" / "NETWORK_TIMEOUT"） */
  code: string;
  /** 人類可讀訊息 */
  message: string;
  /** 是否可重試（網路類為 true，業務類為 false） */
  retryable: boolean;
}

/** SKILL 實例介面 */
export interface SkillInstance<TInput = unknown, TOutput = unknown> {
  meta: SkillMeta;
  /** 執行 capability */
  invoke(
    capability: string,
    input: TInput,
    ctx: AgentContext,
  ): Promise<SkillResult<TOutput>>;
  /**
   * 回滾 capability。
   * **若 reversible=true 必須實作**，否則丟擲錯誤。
   */
  rollback?(
    capability: string,
    input: TInput,
    result: SkillResult<TOutput>,
    ctx: AgentContext,
  ): Promise<void>;
}

/**
 * 外部渠道跳轉包（2026-10 真實渠道上線）
 *
 * book_ticket / book_flight 等「跳轉下單」
 * 類寫操作的返回 data 均攜帶 jump 欄位，結構與雲端 external-jump.ts 的
 * buildJump 輸出逐字對齊。appId 為空串 = 該渠道暫未接入小程序跳轉，
 * 前端隱藏「前往下單」按鈕、僅保留複製資訊（copy-only 降級）。
 */
export interface JumpPackage {
  /** 跳轉渠道識別字（train_12306 / ota_flight / jd / meituan / taobao / none） */
  target: string;
  /** 目標小程序 appId（空串 = copy-only） */
  appId: string;
  /** 目標頁面路徑（可帶 query，缺省開首頁） */
  path?: string;
  /** 京東聯盟小程序跳轉指令（轉鏈產物，僅 target=jd 攜帶） */
  jCommand?: string;
  /** 複製資訊（購票 / 購物 / 預約需求摘要，跳轉後供官方渠道頁面比對） */
  copyText: string;
  /** 模式說明（展示於跳轉卡底部） */
  note: string;
}

/** 簡化版 SkillMeta，僅保留 LLM 規劃需要的欄位（降低 token 消耗） */
export interface SkillMetaSlim {
  id: string;
  name: string;
  description: string;
  tags: string[];
  capabilities: Array<{
    action: string;
    description: string;
    inputSchema: JSONSchema;
    outputSchema: JSONSchema;
    requiresHumanConfirm: boolean;
  }>;
}