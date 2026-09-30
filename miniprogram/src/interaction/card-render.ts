/**
 * 動態卡片渲染輔助
 *
 * 規範來源：.qoder/rules/Agent.md § 11.5
 *
 * MVP：負責把 Plan / 結果資料結構轉為 UI 可渲染的卡片 schema
 */

import type { Plan } from '../types/plan';

export interface RenderCard {
  type: 'plan' | 'result' | 'error' | 'info' | 'train' | 'order' | 'payment';
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
  if (skillId.includes('starbucks') || skillId.includes('coffee')) return 'order';
  if (skillId.includes('payment')) return 'payment';
  return 'info';
}