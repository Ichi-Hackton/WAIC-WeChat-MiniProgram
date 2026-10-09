/**
 * 動態卡片渲染輔助
 *
 * 規範來源：.qoder/rules/Agent.md § 11.5
 *
 * MVP：負責把 Plan / 結果資料結構轉為 UI 可渲染的卡片 schema
 */

import { taskLabel } from '../llm/client';
import { formatCents } from '../utils/field-labels';
import type { Plan } from '../types/plan';
import type { Task } from '../types/task';

export interface RenderCard {
  type: 'plan' | 'result' | 'error' | 'info' | 'train' | 'weather';
  title: string;
  subtitle?: string;
  /** 主資料 */
  body: Record<string, unknown>;
  /** 操作按鈕（給 UI 渲染） */
  actions?: Array<{ label: string; action: string; primary?: boolean }>;
}

/** 將 Plan 渲染為多張卡片 */
export function renderPlan(plan: Plan): RenderCard[] {
  return plan.tasks.map((t) => ({
    type: 'plan',
    title: `${t.skillId}.${t.action}`,
    subtitle: t.summary,
    body: {
      taskId: t.id,
      input: t.input,
      dependsOn: t.dependsOn,
      status: t.status,
    },
    actions: [{ label: '檢視', action: `view:${t.id}`, primary: false }],
  }));
}

/** 將 Plan 結果渲染為摘要卡片 */
export function renderResult(plan: Plan): RenderCard[] {
  return plan.tasks
    .filter((t) => t.status === 'succeeded')
    .map((t) => ({
      type: pickResultType(t.skillId),
      title: t.summary ?? t.action,
      body: (t.result?.data as Record<string, unknown>) ?? {},
    }));
}

function pickResultType(skillId: string): RenderCard['type'] {
  if (skillId.includes('train')) return 'train';
  if (skillId.includes('weather')) return 'weather';
  return 'info';
}

/**
 * 未知 action 的成功結果 → 通用兜底卡
 *
 * 頁面專用卡（車次 / 訂單 / 門市 / 商品 / 預約）未覆蓋的 action 走此渲染，
 * 保證任何 SKILL 的成功結果都有可視化交付（分層：interaction 提供通用
 * 渲染模型，頁面層負責專用卡片美化）。
 */
export function renderTaskFallback(task: Task): RenderCard {
  return {
    type: pickResultType(task.skillId),
    // 中文展示名（技術形態 summary 由 action 中文名兜底）；不展示 skillId 代碼
    title: taskLabel(task),
    body: (task.result?.data as Record<string, unknown>) ?? {},
  };
}

/** 結果數據鍵名中文標籤（白名單：未映射的內部欄位不對 EndUser 展示） */
const FIELD_LABELS: Record<string, string> = {
  orderId: '訂單號',
  trainNo: '車次',
  date: '日期',
  from: '出發',
  to: '到達',
  amountCent: '金額',
  priceCent: '單價',
  status: '狀態',
  quantity: '數量',
  name: '名稱',
  city: '城市',
  count: '數量',
  weather: '天氣',
  temperature: '溫度',
  humidity: '濕度',
  windDirection: '風向',
  windPower: '風力',
  reportTime: '發布時間',
};

/** status 值 → 中文（未知值原樣展示；pending_external 爲 2026-10 跳轉模式寫操作狀態） */
const STATUS_VALUE_LABELS: Record<string, string> = {
  pending_payment: '待支付',
  paid: '已支付',
  pending_external: '待跳轉下單',
  completed: '已完成',
  confirmed: '已確認',
  cancelled: '已取消',
  active: '生效中',
};

/**
 * 結果體 → 卡片鍵值行（EndUser 友好輸出）
 *
 * 僅展示 FIELD_LABELS 已映射的欄位：標量直取（status 值經中文映射、
 * 金額以分存儲需格式化為元）；陣列以「N 項」計數摘要；未映射鍵與
 * 巢狀物件一律略過——原始 JSON 屬代碼級細節，不直接呈現給 EndUser，
 * 詳細數據應由各專用交付卡（車次 / 訂單卡等）結構化展示。
 */
export function toCardLines(
  body: Record<string, unknown>,
  maxLines = 8,
): Array<{ label: string; value: string }> {
  const lines: Array<{ label: string; value: string }> = [];
  for (const [key, raw] of Object.entries(body)) {
    if (lines.length >= maxLines) break;
    if (raw === null || raw === undefined) continue;
    const label = FIELD_LABELS[key];
    if (!label) continue; // 內部欄位（鍵名未映射）不對 EndUser 展示
    if (key === 'amountCent' || key === 'priceCent') {
      lines.push({ label, value: formatCents(typeof raw === 'number' ? raw : Number(raw)) });
      continue;
    }
    if (typeof raw === 'string') {
      lines.push({ label, value: key === 'status' ? STATUS_VALUE_LABELS[raw] ?? raw : raw });
    } else if (typeof raw === 'number' || typeof raw === 'boolean') {
      lines.push({ label, value: String(raw) });
    } else if (Array.isArray(raw)) {
      lines.push({ label, value: `${raw.length} 項` });
    }
    // 巢狀物件：略過（詳情由專用交付卡呈現）
  }
  return lines;
}