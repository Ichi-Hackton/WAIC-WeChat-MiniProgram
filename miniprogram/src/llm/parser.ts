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
import type { TripMeta } from '../types/trip';

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
    /** 時間線標籤（行程 DAG 專用，如「10-11 下周六」） */
    timeLabel?: string;
  }>;
  /** 行程三要素（行程複合意圖時攜帶；四欄位齊全才會落入 Plan.trip） */
  trip?: {
    date?: string;
    dateLabel?: string;
    city?: string;
    activity?: string;
  };
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

/**
 * 佔位符值檢測：LLM 對無法確定的參數偶爾輸出「<需要用戶提供出行日期>」
 * 類佔位符或空字符串（如城市未知時輸出 city:""）而非追問（均實測復現，
 * 空字符串會穿透 validator 的 required 缺席檢查、以髒請求打到雲端才被
 * 400 拒絕）。此類值流入 SKILL 會產生髒請求，在解析層攔截：拋錯走
 * failed 並提示用戶補充參數（Planner prompt 同步引導「缺參數應追問」）。
 * 已被 inputBindings 覆蓋的鍵除外（值會被上游任務輸出替換，佔位符無害）。
 */
/** Planner 輸出的單個任務（佔位符檢測用元素型別） */
type PlannerTask = NonNullable<PlannerLLMOutput['tasks']>[number];

function assertNoPlaceholder(task: PlannerTask, idx: number): void {
  const t = task as { input?: Record<string, unknown>; inputBindings?: Record<string, unknown> };
  if (!t.input) return;
  for (const [key, value] of Object.entries(t.input)) {
    if (key in (t.inputBindings ?? {})) continue; // 該鍵將被 binding 覆蓋
    if (typeof value !== 'string') continue;
    if (
      value.trim() === '' ||
      /^<[^<>]{0,40}>$/.test(value.trim()) ||
      value === 'TBD' ||
      value === 'null' ||
      value === 'undefined'
    ) {
      throw new LLMParserError(
        `缺少必要參數：input.${key} 為空值/佔位符（「${value}」）——請補充該參數後重新描述`,
      );
    }
  }
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
    assertNoPlaceholder(o.tasks[i], i);
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
    // 行程時間線標籤透傳（普通任務缺省）
    ...(t.timeLabel ? { timeLabel: t.timeLabel } : {}),
  }));

  // 行程三要素：四欄位齊全才附著（缺一即非完整行程，不落庫為日程）
  const tripRaw = llm.trip;
  const trip: TripMeta | undefined =
    tripRaw && tripRaw.date && tripRaw.dateLabel && tripRaw.city && tripRaw.activity
      ? {
          date: tripRaw.date,
          dateLabel: tripRaw.dateLabel,
          city: tripRaw.city,
          activity: tripRaw.activity,
        }
      : undefined;

  return {
    id: planId,
    intent: llm.intent ?? intent,
    tasks,
    createdAt: Date.now(),
    status: 'draft',
    // LLM 附注透傳：空 tasks 時的追問文案（orchestrator 據此提示用戶補充參數）
    ...(llm.message ? { note: llm.message } : {}),
    ...(trip ? { trip } : {}),
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