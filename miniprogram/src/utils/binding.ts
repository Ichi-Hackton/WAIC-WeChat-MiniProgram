/**
 * inputBindings 路徑解析器
 *
 * 規範來源：.qoder/rules/Agent.md § 8.2
 *
 * 用於把「已完成 Task 的輸出」綁定到「待執行 Task 的入參」。
 * 支援點號路徑（如 "data.trainNo"）。
 */

import type { Task } from '../types/task';
import { getByPath, setByPath } from './validator';

/**
 * 將 Task 的成功輸出 bindings 注入到下游 Task 的 input
 *
 * @returns 新的 input 物件（不可變，避免污染原物件）
 */
export function applyBindings(
  baseInput: Record<string, unknown>,
  bindings: Record<string, { fromTaskId: string; fromField: string }> | undefined,
  taskIndex: Map<string, Task>,
): Record<string, unknown> {
  if (!bindings) return { ...baseInput };
  const merged: Record<string, unknown> = { ...baseInput };
  for (const [paramName, ref] of Object.entries(bindings)) {
    const src = taskIndex.get(ref.fromTaskId);
    if (!src || !src.result || !src.result.success) {
      throw new Error(
        `inputBindings 解析失敗：來源任務 ${ref.fromTaskId} 未完成或失敗`,
      );
    }
    const payload = src.result.bindings ?? src.result.data;
    const value = getByPath(payload, ref.fromField);
    if (value === undefined) {
      throw new Error(
        `inputBindings 解析失敗：路徑 ${ref.fromTaskId}.${ref.fromField} 取不到值`,
      );
    }
    // paramName 支援點號深層注入（如 "options.trainNo"）
    setByPath(merged, paramName, value);
  }
  return merged;
}

/** 將任務陣列轉為查詢表 */
export function indexTasks(tasks: Task[]): Map<string, Task> {
  const map = new Map<string, Task>();
  for (const t of tasks) map.set(t.id, t);
  return map;
}