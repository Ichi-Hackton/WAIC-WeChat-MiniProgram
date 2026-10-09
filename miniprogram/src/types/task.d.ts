/**
 * Task 型別定義
 *
 * 規範來源：.qoder/rules/Agent.md § 6.2
 *
 * Task 為 Plan 內最小執行單位，由 Planner 產生、由 Scheduler 調度。
 */

import type { SkillResult } from './skill';

/** Task 生命週期狀態 */
export type TaskStatus =
  | 'pending'       // 等待依賴完成
  | 'running'       // 正在執行
  | 'waiting_human' // 等待人類確認
  | 'succeeded'     // 成功
  | 'failed'        // 失敗
  | 'rolled_back'   // 已回滾
  | 'skipped';      // 被跳過（如依賴任務失敗）

/** 跨 Task 資料流引用 */
export interface InputBinding {
  /** 引用的 Task ID（如 "task_001"） */
  fromTaskId: string;
  /** 引用欄位路徑，支援點號（如 "data.trainNo"） */
  fromField: string;
}

/** Task 定義 */
export interface Task {
  /** Task ID，推薦格式 task_NNN（三位數補零） */
  id: string;
  /** 關聯的 SKILL ID */
  skillId: string;
  /** 呼叫的 capability 名稱 */
  action: string;
  /** 入參（可含 inputBindings 解析後的最終值） */
  input: Record<string, unknown>;
  /**
   * 跨 Task 資料流引用宣告。
   * key = 本 Task 的入參欄位；value = 來源 Task + 欄位路徑。
   * Scheduler 在執行前會把 input 中的對應欄位替換為實際值。
   */
  inputBindings?: Record<string, InputBinding>;
  /** 依賴的前置 Task ID 清單 */
  dependsOn: string[];
  /** 當前狀態 */
  status: TaskStatus;
  /** 執行結果 */
  result?: SkillResult;
  /** 開始時間（epoch ms） */
  startedAt?: number;
  /** 結束時間（epoch ms） */
  finishedAt?: number;
  /** 已重試次數 */
  retryCount: number;
  /** 人類可讀摘要（用於 Plan 預覽） */
  summary?: string;
  /** 時間線標籤（行程 DAG 專用，如「10-11 周六」；普通任務缺省） */
  timeLabel?: string;
}