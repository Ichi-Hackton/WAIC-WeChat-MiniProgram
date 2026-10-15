/**
 * Checkpoint 互動協議型別
 *
 * 規範來源：.qoder/rules/Agent.md § 8.1、§ 12.3
 *
 * 型別下沉至 types/ 最底層的原因：core（Scheduler / Orchestrator）與
 * interaction（checkpoint 實作）都需要引用；若定義在 interaction 層，
 * core 反向依賴互動層將違反「interaction → core → skills → llm 單向不可逆」
 * 規範。core 僅依賴型別宣告（編譯後消失），互動層實作由最上層組裝
 * （app.ts）以依賴注入方式提供。
 */

import type { AgentContext } from './context';
import type { SkillCapability } from './skill';
import type { Task } from './task';

/** 單步寫操作確認入參 */
export interface CheckpointInput {
  /** 待確認的任務 */
  task: Task;
  /** 任務對應的 capability 元資料 */
  capability: SkillCapability;
  /** inputBindings 解析後的最終入參 */
  resolvedInput: Record<string, unknown>;
  /** Agent 上下文 */
  ctx: AgentContext;
}

/** 單步確認回調：resolve true 表示用戶同意執行 */
export type CheckpointFn = (input: CheckpointInput) => Promise<boolean>;

/** 確認卡的面向用戶載荷（第二梯隊·項C：彈窗 → 聊天流結構化確認卡） */
export interface CheckpointCardPayload {
  /** 任務 ID（卡 key 與日誌定位用） */
  taskId: string;
  /** 技能中文名（如「火車票查詢與購票」；無法取得時退化為 skillId） */
  skillName: string;
  /** 卡片標題（如「確認下單：查詢北京→上海高鐵」） */
  title: string;
  /** 明細行（脱敏後的入參中文標籤行 / 金額明細，逐行渲染） */
  detailLines: string[];
  /** 確認按鈕文案（如「確認發送」） */
  confirmText: string;
}

/** 確認應答：UI 點按後回傳（true = 同意執行；Promise 狀態幂等，重複調用無副作用） */
export type CheckpointRespond = (approved: boolean) => void;

/** 確認請求 sink：interaction → UI 的觀察者反轉（app.ts 組裝時注入頁面轉發） */
export type CheckpointSink = (
  payload: CheckpointCardPayload,
  respond: CheckpointRespond,
) => void;

/** Plan 整體確認入參 */
export interface ConfirmPlanInput {
  /** 用戶原始意圖 */
  intent: string;
  /** Plan 內的全部任務 */
  tasks: Task[];
  /** Agent 上下文 */
  ctx: AgentContext;
}

/** Plan 確認回調：resolve true 表示用戶同意執行 */
export type ConfirmPlanFn = (input: ConfirmPlanInput) => Promise<boolean>;
