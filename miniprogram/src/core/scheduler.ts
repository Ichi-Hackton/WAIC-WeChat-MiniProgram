/**
 * DAG 調度器
 *
 * 規範來源：.qoder/rules/Agent.md § 8.2
 *
 * 核心演算法：
 *   每輪：
 *     1. 找出所有「依賴已滿足且 pending」的 Task
 *     2. 並行執行（Promise.allSettled）
 *     3. 等待所有完成後進入下一輪
 *   直到：
 *     - 全部 Task 都進入終態（succeeded / failed / skipped）
 *     - 或偵測死鎖
 *
 * 寫操作 requiresHumanConfirm：呼叫上層注入的 checkpoint 回調等用戶確認後才執行。
 */

import type { AgentContext } from '../types/context';
import type { Plan } from '../types/plan';
import type { Task, TaskStatus } from '../types/task';
import type { CheckpointFn, CheckpointInput } from '../types/checkpoint';
import { applyBindings, indexTasks } from '../utils/binding';
import { info as logInfo, warn as logWarn, error as logError } from '../utils/logger';
import * as adapter from '../skills/adapter';
import { getCapability } from '../skills/adapter';

export interface SchedulerOptions {
  /**
   * 寫操作 checkpoint 回調（必填）。
   * 由上層組裝時注入 interaction 實作——core 不得反向依賴互動層
   * （規範 § 12.3 依賴方向單向不可逆），型別見 types/checkpoint.d.ts。
   */
  checkpoint: CheckpointFn;
  /** 任務完成回調（給 Orchestrator 推 UI） */
  onTaskUpdate?: (task: Task) => void;
  /** 整體計劃完成回調 */
  onComplete?: (plan: Plan) => void;
  /**
   * 當前執行是否仍然有效（runToken 探測）。
   * Orchestrator 被 reset / 新一輪接管後返回 false，Scheduler 隨即中止，
   * 防止舊流程繼續彈窗、重複下單與併發雙跑。
   */
  isRunActive?: () => boolean;
}

/** 死鎖錯誤 */
export class SchedulerDeadlockError extends Error {
  constructor(public pending: Task[]) {
    super(`Deadlock detected: ${pending.length} tasks pending but none can proceed`);
    this.name = 'SchedulerDeadlockError';
  }
}

/**
 * Checkpoint 序列化互斥鎖
 *
 * 設計理由：wx.showModal 同一時刻只會顯示最後一個彈窗，並行 ready 的
 * 多個寫操作若同時彈確認框，前序彈窗會被頂掉導致確認結果丟失
 * （§ 10 Human-in-the-Loop 紅線）。實作為模組級 Promise 鏈：
 * 新的 checkpoint 排隊等待前一個完成，鏈尾吞錯避免單次失敗卡死後續。
 */
let checkpointChain: Promise<unknown> = Promise.resolve();

function serializeCheckpoint(
  checkpoint: CheckpointFn,
  input: CheckpointInput,
): Promise<boolean> {
  const run = checkpointChain.then(() => checkpoint(input));
  checkpointChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 調度主入口 */
export async function run(plan: Plan, ctx: AgentContext, options: SchedulerOptions): Promise<Plan> {
  const taskIndex = indexTasks(plan.tasks);
  const checkpoint = options.checkpoint;
  const onUpdate = options.onTaskUpdate;
  const isRunActive = options.isRunActive ?? (() => true);

  logInfo(`Scheduler 啟動，${plan.tasks.length} 個任務`);

  let guard = 0;
  while (true) {
    // 0. runToken 失效（Orchestrator 已 reset / 新一輪已接管）→ 中止調度
    if (!isRunActive()) {
      abortRun(plan, onUpdate);
      plan.status = 'failed';
      logWarn('Scheduler 中止：執行令牌已失效（run 被 reset）');
      return plan;
    }
    guard += 1;
    if (guard > 1000) {
      throw new Error('Scheduler 迭代次數超限（> 1000 輪），可能存在邏輯錯誤');
    }

    // 1. 找出依賴已滿足且 pending 的 Task
    const ready = plan.tasks.filter((t) => isReady(t, taskIndex));

    // 2. 死鎖偵測
    if (ready.length === 0) {
      const stillPending = plan.tasks.filter((t) => t.status === 'pending');
      const runningOrWaiting = plan.tasks.filter(
        (t) => t.status === 'running' || t.status === 'waiting_human',
      );
      if (stillPending.length > 0 && runningOrWaiting.length === 0) {
        // 全部都已終態或仍有 pending 但無人可執行 → 死鎖
        throw new SchedulerDeadlockError(stillPending);
      }
      // 否則跳出循環（全部完成或都進入終態）
      break;
    }

    // 3. 並行執行這一批 ready 任務
    await Promise.allSettled(
      ready.map((t) => executeOne(t, plan, taskIndex, ctx, checkpoint, onUpdate, () => isRunActive())),
    );
  }

  // 4. 標記 Plan 終態
  const failed = plan.tasks.find((t) => t.status === 'failed');
  plan.status = failed ? 'failed' : 'done';
  options.onComplete?.(plan);
  logInfo(`Scheduler 完成，狀態=${plan.status}`);
  return plan;
}

/** 判斷 Task 是否就緒 */
function isReady(t: Task, taskIndex: Map<string, Task>): boolean {
  if (t.status !== 'pending') return false;
  return t.dependsOn.every((depId) => {
    const dep = taskIndex.get(depId);
    return dep?.status === 'succeeded';
  });
}

/** 執行單個 Task（含 checkpoint） */
async function executeOne(
  task: Task,
  plan: Plan,
  taskIndex: Map<string, Task>,
  ctx: AgentContext,
  checkpoint: CheckpointFn,
  onUpdate?: (t: Task) => void,
  shouldAbort: () => boolean = () => false,
): Promise<void> {
  // 解析 inputBindings
  let resolvedInput: Record<string, unknown>;
  try {
    resolvedInput = applyBindings(task.input, task.inputBindings, taskIndex);
  } catch (e) {
    failTask(task, plan, 'BINDING_FAILED', String(e), onUpdate);
    // 級聯跳過所有依賴此 Task 的下游
    cascadeSkip(task.id, plan, taskIndex, onUpdate);
    return;
  }
  // 寫回最終入參：checkpoint 展示與 rollback 撤銷均需綁定解析後的最終值
  // （協議 § 6.2 Task.input 註釋：可含 inputBindings 解析後的最終值）
  task.input = resolvedInput;

  const cap = getCapability(task.skillId, task.action);

  // 寫操作 checkpoint（序列化，確保同一時刻僅一個確認彈窗）
  if (cap?.requiresHumanConfirm) {
    task.status = 'waiting_human';
    onUpdate?.(task);
    const ok = await serializeCheckpoint(checkpoint, {
      task,
      capability: cap,
      resolvedInput,
      ctx,
    });
    if (!ok) {
      failTask(task, plan, 'USER_CANCELLED', '用戶在 checkpoint 拒絕', onUpdate);
      cascadeSkip(task.id, plan, taskIndex, onUpdate);
      return;
    }
    // checkpoint 等待期間 runToken 可能已失效（用戶 reset），不得再執行寫操作
    if (shouldAbort()) {
      failTask(task, plan, 'RUN_CANCELLED', '執行令牌已失效（run 被 reset）', onUpdate);
      cascadeSkip(task.id, plan, taskIndex, onUpdate);
      return;
    }
  }

  // 執行
  task.status = 'running';
  task.startedAt = Date.now();
  onUpdate?.(task);

  const result = await adapter.invoke(task.skillId, task.action, resolvedInput, ctx);

  task.finishedAt = Date.now();
  task.result = result;
  task.status = result.success ? 'succeeded' : 'failed';
  onUpdate?.(task);

  if (!result.success) {
    logWarn(`Task ${task.id} 失敗：${result.error?.message}`);
    cascadeSkip(task.id, plan, taskIndex, onUpdate);
  }
}

/** 標記任務失敗 */
function failTask(t: Task, plan: Plan, code: string, message: string, onUpdate?: (t: Task) => void): void {
  t.status = 'failed';
  t.finishedAt = Date.now();
  t.result = {
    success: false,
    error: { code, message, retryable: false },
  };
  plan.status = 'failed';
  logError(`Task ${t.id} 失敗 [${code}]: ${message}`);
  onUpdate?.(t);
}

/** runToken 失效時中止：所有非終態任務標記 skipped（已成功任務保持原狀，由 Orchestrator 決定後續） */
function abortRun(plan: Plan, onUpdate?: (t: Task) => void): void {
  for (const t of plan.tasks) {
    if (t.status !== 'pending' && t.status !== 'running' && t.status !== 'waiting_human') continue;
    t.status = 'skipped';
    t.finishedAt = Date.now();
    onUpdate?.(t);
  }
}

/** 級聯標記所有依賴此 Task 的下游為 skipped */
function cascadeSkip(failedId: string, plan: Plan, taskIndex: Map<string, Task>, onUpdate?: (t: Task) => void): void {
  for (const t of plan.tasks) {
    if (t.status !== 'pending') continue;
    if (t.dependsOn.includes(failedId)) {
      t.status = 'skipped';
      onUpdate?.(t);
      cascadeSkip(t.id, plan, taskIndex, onUpdate);
    }
  }
  void taskIndex; // 保留以備後續按 ID 查找
}

/** 依狀態過濾任務 */
export function filterTasks(plan: Plan, status: TaskStatus): Task[] {
  return plan.tasks.filter((t) => t.status === status);
}