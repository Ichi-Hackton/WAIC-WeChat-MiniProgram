/**
 * 人類確認對話框
 *
 * 規範來源：.qoder/rules/Agent.md § 8.1, § 10
 *
 * 提供兩個 hook：
 *   - confirmPlan：給用戶確認整個 Plan
 *   - awaitCheckpoint：寫操作前的單步確認
 *
 * 底層呼叫 wx.showModal；若無 wx API 則降級為 auto-approve（僅測試用）。
 */

import type { CheckpointInput, ConfirmPlanInput } from '../types/checkpoint';
import { BRAND_AI_GENERATED_BY } from '../types/brand';
import { formatCents } from '../services/payment';
import { info as logInfo } from '../utils/logger';

// 型別已下沉至 types/checkpoint.d.ts（core 層依賴注入用），此處 re-export 保持兼容
export type { CheckpointInput, ConfirmPlanInput };

/** 透過 wx.showModal 顯示確認框，resolve 為布爾 */
function showWxModal(opts: {
  title: string;
  content: string;
  confirmText?: string;
  cancelText?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const wxApi = (globalThis as { wx?: {
      showModal?: (o: unknown) => void;
    } }).wx;
    if (!wxApi?.showModal) {
      logInfo(`[fallback] wx.showModal 不可用，預設拒絕：${opts.title}`);
      resolve(false);
      return;
    }
    wxApi.showModal({
      title: opts.title,
      content: opts.content,
      confirmText: opts.confirmText ?? '確認',
      cancelText: opts.cancelText ?? '取消',
      success: (res: { confirm: boolean; cancel: boolean }) => resolve(res.confirm),
      fail: () => resolve(false),
    });
  });
}

/** Plan 確認：列出每個 Task 摘要 */
export async function confirmPlan(input: ConfirmPlanInput): Promise<boolean> {
  const lines: string[] = [];
  lines.push(`意圖：${input.intent}`);
  lines.push('');
  lines.push('將執行以下任務：');
  input.tasks.forEach((t, idx) => {
    const marker = t.dependsOn.length > 0 ? `（依賴 ${t.dependsOn.join(', ')}）` : '';
    lines.push(`${idx + 1}. ${t.skillId}.${t.action} — ${t.summary ?? ''} ${marker}`);
  });
  return showWxModal({
    title: `${BRAND_AI_GENERATED_BY}：確認執行計劃`,
    content: lines.join('\n'),
    confirmText: '執行',
    cancelText: '取消',
  });
}

/** 金額明細項（兼容 orders / orderItems 等鍵名） */
interface AmountItem {
  title?: string;
  amountCent?: number;
  quantity?: number;
}

/** 找出入參中第一個「元素含 amountCent」的陣列（金額明細） */
function findAmountItems(input: Record<string, unknown>): AmountItem[] | undefined {
  for (const v of Object.values(input)) {
    if (
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((it) => it && typeof it === 'object' && 'amountCent' in (it as Record<string, unknown>))
    ) {
      return v as AmountItem[];
    }
  }
  return undefined;
}

/**
 * 入參明細格式化（規範 § 10 紅線：支付前強制展示明細）
 *
 * 金額感知：入參中第一個「元素含 amountCent 欄位」的陣列視為訂單明細，
 * 逐項展示「品名 × 數量 = 金額」並彙總合計——避免 pretty-print JSON
 * 被 slice 截斷導致金額欄位不可見；非訂單入參退化為緊湊 JSON（截 500 字元）。
 */
function formatInputDetail(input: Record<string, unknown>): string {
  const items = findAmountItems(input);
  if (items) {
    const lines = items.map((it) => {
      const qty = it.quantity ?? 1;
      return `· ${it.title ?? '項目'} × ${qty} = ${formatCents((it.amountCent ?? 0) * qty)}`;
    });
    const total = items.reduce((s, it) => s + (it.amountCent ?? 0) * (it.quantity ?? 1), 0);
    lines.push(`合計：${formatCents(total)}`);
    return lines.join('\n');
  }
  const json = JSON.stringify(input);
  return json.length > 500 ? `${json.slice(0, 500)}…` : json;
}

/** 單步寫操作確認 */
export async function awaitCheckpoint(input: CheckpointInput): Promise<boolean> {
  const lines: string[] = [];
  lines.push(`任務：${input.task.summary ?? `${input.task.skillId}.${input.task.action}`}`);
  lines.push(`類型：${input.capability.requiresHumanConfirm ? '寫操作（不可逆）' : '讀操作'}`);
  lines.push('明細：');
  lines.push(formatInputDetail(input.resolvedInput));
  return showWxModal({
    title: `${BRAND_AI_GENERATED_BY}：需要您確認`,
    content: lines.join('\n'),
    confirmText: '同意',
    cancelText: '拒絕',
  });
}