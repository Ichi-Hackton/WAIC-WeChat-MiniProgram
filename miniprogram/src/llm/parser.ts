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
    /** 任務 id（可選，LLM 自編號如 task_001；toPlan 重編號時做引用遷移） */
    id?: string;
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
  /** 能力缺口（動態技能計劃新增，僅 tasks 為空時合法）：意圖超出可用
   *  SKILL 能力範圍且無法靠補參數解決時攜帶；非空 tasks 或畸形形態
   *  時靜默剔除（寬容處理，與 memory 欄位同哲學——不因增強欄位否決 Plan） */
  missingCapability?: {
    skillName?: string;
    suggestion?: string;
  };
  /** 隱式偏好沉澱增量（可選增強欄位，prompt 規則 12）：本輪對話中用戶
   *   顯式表達的長期偏好，鍵限 storage/preferences 白名單域。不進 Plan
   *   （記憶副作用而非任務數據），由 client 規劃後處理寫回 */
  memory?: Record<string, string>;
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
  // memory 為可選增強欄位：寬容處理——非純物件形態直接剔除，不因記憶
  // 欄位畸形否決整個 Plan（白名單鍵過濾與值脫敏在寫回側 updatePreferences，
  // 與分類器「增強而非單點」的容錯哲學同構）
  if (
    o.memory !== undefined &&
    (typeof o.memory !== 'object' || o.memory === null || Array.isArray(o.memory))
  ) {
    delete o.memory;
  }
  // missingCapability 僅在「空 tasks + 合法形態」時保留（skillName /
  // suggestion 均為非空字串）；其餘情況（有任務 / 畸形 / 缺欄位）剔除——
  // 缺口語義只在無法規劃時有意義，與任務並存即為模型輸出噪聲
  const mc = o.missingCapability;
  const mcValid =
    Array.isArray(o.tasks) &&
    (o.tasks as unknown[]).length === 0 &&
    typeof mc === 'object' &&
    mc !== null &&
    !Array.isArray(mc) &&
    typeof (mc as Record<string, unknown>).skillName === 'string' &&
    ((mc as Record<string, unknown>).skillName as string).trim().length > 0 &&
    typeof (mc as Record<string, unknown>).suggestion === 'string' &&
    ((mc as Record<string, unknown>).suggestion as string).trim().length > 0;
  if (!mcValid) delete o.missingCapability;
  return o as PlannerLLMOutput;
}

/** 將 LLM 輸出轉為標準 Plan（含 Task 補齊欄位） */
export function toPlan(llm: PlannerLLMOutput, intent: string, planId: string): Plan {
  const raw = llm.tasks ?? [];
  // 任務 id 重編號 + 引用遷移：LLM 可能自編任務 id（如 task_e01）並在
  // inputBindings.fromTaskId / dependsOn 中引用；重編號為 task_NNN 後若
  // 不同步遷移引用側，綁定將懸空（實測 BINDING_FAILED：路徑
  // task_e01.xxx 取不到值）。rule-planner 不寫 id 且直接引用 task_NNN
  // 最終編號——映射表為空時引用原樣透傳，兩種來源相容
  const idMap = new Map<string, string>();
  raw.forEach((t, idx) => {
    if (typeof t.id === 'string' && t.id) {
      idMap.set(t.id, `task_${String(idx + 1).padStart(3, '0')}`);
    }
  });
  const remap = (ref: string): string => idMap.get(ref) ?? ref;
  const tasks: Task[] = raw.map((t, idx) => ({
    id: `task_${String(idx + 1).padStart(3, '0')}`,
    skillId: t.skillId ?? '',
    action: t.action ?? '',
    input: t.input ?? {},
    inputBindings: Object.fromEntries(
      Object.entries(t.inputBindings ?? {}).map(([k, v]) => [
        k,
        { fromTaskId: remap(v.fromTaskId ?? ''), fromField: v.fromField ?? '' },
      ]),
    ),
    dependsOn: (t.dependsOn ?? []).filter((s): s is string => typeof s === 'string').map(remap),
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
    // 能力缺口透傳（validatePlannerOutput 已保證僅空 tasks + 合法形態到達此處）
    ...(llm.missingCapability
      ? {
          missingCapability: {
            skillName: llm.missingCapability.skillName!.slice(0, 12),
            suggestion: llm.missingCapability.suggestion!.slice(0, 60),
          },
        }
      : {}),
    ...(trip ? { trip } : {}),
  };
}

/** 完整 pipeline：raw text → Plan */
export function parsePlannerOutput(rawText: string, intent: string, planId: string): Plan {
  const json = extractJson(rawText);
  const validated = validatePlannerOutput(json);
  return toPlan(validated, intent, planId);
}

/**
 * 跨任務綁定 fromField 合法首段白名單（防 LLM 欄位路徑幻覺——實測
 * 自編 firstServiceId 之類幻覺路徑會穿透到 Scheduler 運行時
 * BINDING_FAILED 回滾）。形態兩類：
 *   - data.*：標準容器路徑（六域 SKILL 輸出規範，如
 *     data.stores.0.storeId / data.priceCentByService.svc_001）
 *   - 頂層便利欄位：出行域早期約定（search_train / search_flight
 *     響應頂層的 trainNo / date / priceCent / flightNo 與
 *     priceCentByTrain.* / priceCentByFlight.* 即時價映射）
 * 2026-10-13 起降級為「未登記 BINDING_FIELDS_BY_ACTION 的 action」之回退
 * 檢查（新增 SKILL 未同步全路徑白名單時不誤殺，行為同舊版）
 */
const BINDING_FIELD_ROOTS = new Set([
  'data',
  'trainNo',
  'date',
  'priceCent',
  'flightNo',
  'priceCentByTrain',
  'priceCentByFlight',
]);

/**
 * 按（來源任務 action）登記的可綁定輸出欄位完整路徑白名單，'*' 段為
 * 動態鍵通配（priceCentByTrain.* 匹配 priceCentByTrain.G531）。
 * 數據源 = 雲端 SKILL 真實輸出與小程序 mock 同構契約（2026-10-13 核對：
 * booking / ticket 的 first* 便捷欄位、train / flight 頂層 bindings、
 * 動態鍵映射）。舊版僅校驗首段，data.* 內深層幻覺（編造欄位名 /
 * 鍵名 / 跨域借用）穿透到 Scheduler 運行時 BINDING_FAILED 回滾；
 * 新版按 action 全路徑校驗，規劃期即攔截，錯誤信息附合法路徑清單
 * （直接指導 prompt 修復——調試 LLM 規劃時的反饋回路縮短一輪）。
 * 維護義務：新增 SKILL 的可綁定欄位須同步本表（rule-planner 全部
 * fromField 均在各域清單內，blackbox-planner 斷言共同守護）
 */
const BINDING_FIELDS_BY_ACTION: Readonly<Record<string, readonly string[]>> = {
  search_train: ['from', 'to', 'date', 'trainNo', 'departTime', 'priceCent', 'priceCentByTrain.*'],
  search_flights: ['from', 'to', 'date', 'flightNo', 'departTime', 'priceCent', 'priceCentByFlight.*'],
  search_store: ['data.stores.*.storeId'],
  search_products: ['data.priceCentByProduct.*'],
  search_services: [
    'data.firstServiceId',
    'data.firstAvailableServiceId',
    'data.firstAvailableStartTime',
    'data.firstPriceCent',
    'data.firstAvailableStartTimeByService.*',
    'data.priceCentByService.*',
  ],
  search_events: ['data.firstEventId', 'data.eventIdByName.*'],
  draft_mail: ['data.subject', 'data.body'],
  list_sessions: [
    'data.firstAvailableSessionId',
    'data.firstAvailableTierId',
    'data.firstAvailablePriceCent',
    'data.sessionIdByTime.*',
    'data.tierIdByTime.*',
    'data.priceCentByTime.*',
    'data.priceCentBySession.*',
  ],
};

/** 路徑模式匹配：段數相等；'*' 段匹配任意非空段，其餘段精確相等 */
function matchesFieldPattern(pattern: string, field: string): boolean {
  const ps = pattern.split('.');
  const fs = field.split('.');
  if (ps.length !== fs.length) return false;
  return ps.every((seg, i) => (seg === '*' ? fs[i] !== '' : seg === fs[i]));
}

/**
 * 校驗 Plan 內任務引用一致性：inputBindings.fromTaskId 與 dependsOn
 * 必須指向 Plan 內存在的其他任務（自引用取不到值 / 死鎖，同樣無效）；
 * fromField 校驗分兩級——來源 action 已登記 BINDING_FIELDS_BY_ACTION 時
 * 全路徑嚴格匹配（深層幻覺在此攔截），未登記時回退首段白名單
 * BINDING_FIELD_ROOTS（欄位路徑幻覺與引用幻覺同屬 LLM 規劃缺陷）。
 * 返回錯誤描述列表（空陣列 = 通過）；由呼叫方（client.plan）決定是否
 * 降級規則規劃器兜底
 */
export function validatePlanBindings(p: Plan): string[] {
  const byId = new Map(p.tasks.map((t) => [t.id, t]));
  const errs: string[] = [];
  for (const t of p.tasks) {
    for (const [k, b] of Object.entries(t.inputBindings ?? {})) {
      if (!b.fromTaskId || !byId.has(b.fromTaskId) || b.fromTaskId === t.id) {
        errs.push(`task ${t.id} 的綁定 ${k} 引用無效任務「${b.fromTaskId}」`);
        continue;
      }
      const field = b.fromField ?? '';
      const fromTask = byId.get(b.fromTaskId);
      if (!fromTask) continue; // 前置 byId.has 守衛令此行不可達，僅為 TS 窄化
      const allowed = BINDING_FIELDS_BY_ACTION[fromTask.action];
      if (allowed) {
        if (!allowed.some((pat) => matchesFieldPattern(pat, field))) {
          errs.push(
            `task ${t.id} 的綁定 ${k} 引用 ${fromTask.action} 不存在的欄位路徑「${field}」（合法路徑：${allowed.join('、')}）`,
          );
        }
      } else {
        const root = field.split('.')[0] ?? '';
        if (!root || !BINDING_FIELD_ROOTS.has(root)) {
          errs.push(`task ${t.id} 的綁定 ${k} 引用未知欄位路徑「${field}」`);
        }
      }
    }
    for (const d of t.dependsOn) {
      if (!byId.has(d) || d === t.id) {
        errs.push(`task ${t.id} 依賴無效任務「${d}」`);
      }
    }
  }
  return errs;
}

/** 對外暴露的版本資訊（供測試用） */
export function getSchemaVersion(): string {
  return PLAN_SCHEMA_VERSION;
}