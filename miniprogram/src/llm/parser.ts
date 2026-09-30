/**
 * LLM 結構化輸出解析器
 *
 * 規範來源：.qoder/rules/Agent.md § 8.3
 *
 * 規則：
 *   - LLM 輸出**必須**以正則 /\{[\s\S]*\}/ 抽取 JSON
 *   - 抽取後必須通過 schema 驗證，否則拋錯
 *   - 容錯：允許 LLM 在 JSON 外面夾雜文字（透過正則抽取）
 */

import type { Plan } from '../types/plan';
import type { Task } from '../types/task';

const PLAN_SCHEMA_VERSION = '1.0';

/** 解析失敗錯誤 */
export class LLMParserError extends Error {
  constructor(message: string, public rawText?: string) {
    super(message);
    this.name = 'LLMParserError';
  }
}

/** LLM 原始輸出（尚未驗證） */
export interface PlannerLLMOutput {
  intent?: string;
  tasks?: Array<{
    skillId?: string;
    action?: string;
    input?: Record<string, unknown>;
    inputBindings?: Record<string, { fromTaskId?: string; fromField?: string }>;
    dependsOn?: string[];
    summary?: string;
  }>;
  message?: string;
}

/** 抽取 JSON 對象（含陣列或對象） */
export function extractJson(rawText: string): unknown {
  // 先嘗試 Markdown 包裹 ```json ... ```
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(rawText);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fallthrough */
    }
  }
  // 再嘗試首個 JSON 對象
  const objMatch = /\{[\s\S]*\}/.exec(rawText);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch (e) {
      throw new LLMParserError(`JSON 解析失敗：${String(e)}`, rawText);
    }
  }
  throw new LLMParserError('找不到 JSON 結構', rawText);
}

/** 驗證 Planner 輸出結構 */
export function validatePlannerOutput(raw: unknown): PlannerLLMOutput {
  if (!raw || typeof raw !== 'object') {
    throw new LLMParserError('LLM 輸出不是物件');
  }
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.tasks)) {
    throw new LLMParserError('缺少 tasks 陣列');
  }
  for (let i = 0; i < o.tasks.length; i++) {
    const t = o.tasks[i] as Record<string, unknown>;
    if (typeof t.skillId !== 'string') {
      throw new LLMParserError(`task[${i}] 缺少 skillId`);
    }
    if (typeof t.action !== 'string') {
      throw new LLMParserError(`task[${i}] 缺少 action`);
    }
    if (typeof t.input !== 'object' || t.input === null) {
      throw new LLMParserError(`task[${i}] 缺少 input`);
    }
    if (!Array.isArray(t.dependsOn)) {
      throw new LLMParserError(`task[${i}] 缺少 dependsOn[]`);
    }
  }
  return o as PlannerLLMOutput;
}

/** 將 LLM 輸出轉為標準 Plan（含 Task 補齊欄位） */
export function toPlan(llm: PlannerLLMOutput, intent: string, planId: string): Plan {
  const tasks: Task[] = (llm.tasks ?? []).map((t, idx) => ({
    id: `task_${String(idx + 1).padStart(3, '0')}`,
    skillId: t.skillId ?? '',
    action: t.action ?? '',
    input: t.input ?? {},
    inputBindings: Object.fromEntries(
      Object.entries(t.inputBindings ?? {}).map(([k, v]) => [
        k,
        { fromTaskId: v.fromTaskId ?? '', fromField: v.fromField ?? '' },
      ]),
    ),
    dependsOn: (t.dependsOn ?? []).filter((s): s is string => typeof s === 'string'),
    status: 'pending',
    retryCount: 0,
    summary: t.summary ?? `${t.skillId}.${t.action}`,
  }));

  return {
    id: planId,
    intent: llm.intent ?? intent,
    tasks,
    createdAt: Date.now(),
    status: 'draft',
  };
}

/** 完整 pipeline：raw text → Plan */
export function parsePlannerOutput(rawText: string, intent: string, planId: string): Plan {
  const json = extractJson(rawText);
  const validated = validatePlannerOutput(json);
  return toPlan(validated, intent, planId);
}

/** 對外暴露的版本資訊（供測試用） */
export function getSchemaVersion(): string {
  return PLAN_SCHEMA_VERSION;
}