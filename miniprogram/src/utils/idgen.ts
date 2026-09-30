/**
 * ID 生成器
 *
 * 規範來源：.qoder/rules/Agent.md § 12.4
 *
 * 命名格式：
 *   - Task ID:  task_NNN（三位數補零）
 *   - Plan ID:   plan_{timestamp}
 *   - Session ID: sess_{timestamp}_{rand}
 */

let taskCounter = 0;

/** 重置 Task 計數器（每個 Plan 建立前呼叫） */
export function resetTaskCounter(): void {
  taskCounter = 0;
}

/** 產生 Task ID：task_001 / task_042 / ... */
export function genTaskId(): string {
  taskCounter += 1;
  return `task_${String(taskCounter).padStart(3, '0')}`;
}

/** 產生 Plan ID：plan_1737620792400 */
export function genPlanId(): string {
  return `plan_${Date.now()}`;
}

/** 產生 Session ID：sess_{timestamp}_{rand} */
export function genSessionId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 產生 Trace ID：trc_{rand}（LLM 呼叫用） */
export function genTraceId(): string {
  return `trc_${Math.random().toString(36).slice(2, 10)}`;
}