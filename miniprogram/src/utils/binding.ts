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
 * fromField 路徑約定（與 Agent.md § 8.2 / planner prompt 示例對齊）：
 *   - 帶「data.」前綴：強制從來源任務的 result.data 取值
 *     （如 "data.stores.0.storeId"、"data.priceCentByProduct.p_001"）。
 *     歷史缺陷：帶前綴路徑曾直接在 bindings??data 的 payload 根下查找，
 *     根本無 "data" 鍵導致必定解析失敗（實測阻斷咖啡點單與購物/預約
 *     寫操作全鏈路），於此中心修復。
 *   - 無前綴：優先從 result.bindings（協議 § 6.1 SKILL 顯式輸出綁定，
 *     如 train 的 priceCentByTrain）逐鍵取值，缺鍵回退 result.data
 *     同名路徑（bindings 存在但個別鍵缺席時不再整體切斷）
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
    const viaData = ref.fromField.startsWith('data.');
    const path = viaData ? ref.fromField.slice(5) : ref.fromField;
    // 無前綴路徑：bindings 逐鍵優先，缺鍵回退 data 同名路徑；帶 data. 前綴僅查 data
    let value = viaData ? undefined : getByPath(src.result.bindings, path);
    if (value === undefined) value = getByPath(src.result.data, path);
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