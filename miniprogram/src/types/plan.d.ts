/**
 * Plan 型別定義
 *
 * 規範來源：.qoder/rules/Agent.md § 6.2
 *
 * Plan 為 Planner 產出、Orchestrator 執行的 DAG 任務集合。
 */

import type { Task } from './task';

/** Plan 生命週期狀態 */
export type PlanStatus =
  | 'draft'       // 規劃完成，待用戶確認
  | 'confirmed'   // 用戶已確認，待執行
  | 'executing'   // 執行中
  | 'done'        // 全部成功
  | 'failed';     // 任何不可恢復失敗

/** Plan 定義 */
export interface Plan {
  /** Plan ID，推薦格式 plan_{timestamp} */
  id: string;
  /** 用戶原始意圖 */
  intent: string;
  /** 任務清單（構成 DAG） */
  tasks: Task[];
  /** 建立時間（epoch ms） */
  createdAt: number;
  /** 當前狀態 */
  status: PlanStatus;
  /** Planner LLM 呼叫的 traceId（除錯用） */
  traceId?: string;
  /** Planner 附注（tasks 為空時的追問文案，如「請補充出行日期」） */
  note?: string;
}

/** Plan 確認對話框需要的渲染資料 */
export interface PlanPreviewItem {
  taskId: string;
  skillName: string;
  action: string;
  summary: string;
  needsHumanConfirm: boolean;
}

/** Plan 摘要（給用戶檢視用） */
export interface PlanSummary {
  planId: string;
  intent: string;
  items: PlanPreviewItem[];
  /** 是否包含任何寫操作 */
  hasWriteOps: boolean;
}