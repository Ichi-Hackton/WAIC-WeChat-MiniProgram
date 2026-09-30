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
