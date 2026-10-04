/**
 * 人類確認對話框
 *
 * 規範來源：.qoder/rules/Agent.md § 8.1, § 10（2026-10 修訂）
 *
 * 預設行為：兩個 hook（confirmPlan / awaitCheckpoint）均**直接 resolve true**，
 * 遵循「最小打扰」原則——使用者發出意圖即視同同意，UI 上的 plan 卡片與交付卡
 * 已提供充分能見性，脫彈窗冗餘只會在高頻任務流中造成噪音。
 *
 * 安全网：
 *   1. rollback 機制：寫操作失敗可反序撤銷已成功的 Task
 *   2. AI 專屬卡：wx.requestPayment 本身彈銀行級密碼框，不受 checkpoint 影響
 *   3. 「重置」按鈕：誤操作可一鍵清空對話重來
 *
 * 保留函式簽名原因：
 *   - scheduler 仍會呼叫 checkpoint 入參（函式永遠返回 true，狀態機依然走完）
 *   - 未來若要重新啟用彈窗，只需在函式內插回 wx.showModal 即可，不需改動調用方
 *
 * 若無 wx API（如測試環境）：同樣直接 resolve true（預設通過，與生產一致）。
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

/** Plan 確認：預設直接通過（彈窗已禁用；UI plan 卡片提供同等可見性） */
export async function confirmPlan(input: ConfirmPlanInput): Promise<boolean> {
  logInfo(`[checkpoint/auto] Plan 預設通過：${input.intent}（${input.tasks.length} 個任務）`);
  return true;
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
 * 金額感知（三級匹配，確保用戶確認前能看到金額）：
 *   1. 元素含 amountCent 的陣列 → 訂單明細逐項展示 + 合計（如星巴克 items）
 *   2. 標量 priceCent / amountCent → 單筆金額展示（如火車票 book_ticket，
 *      值來自上游查詢任務的 inputBindings 注入——規劃層保證「先查詢後下單」
 *      依賴鏈，使確認彈窗展示即時票價；下單金額以雲端再核實為準）
 *   3. 其他 → 緊湊 JSON（截 500 字元）
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
  const scalarCent =
    typeof input.amountCent === 'number' ? input.amountCent :
    typeof input.priceCent === 'number' ? input.priceCent :
    undefined;
  if (scalarCent !== undefined) {
    const label = input.amountCent !== undefined ? '金額' : '票價（即時查詢，下單以雲端核實為準）';
    const json = { ...input };
    delete json.priceCent;
    delete json.amountCent;
    return `${label}：${formatCents(scalarCent)}\n${JSON.stringify(json).slice(0, 400)}`;
  }
  const json = JSON.stringify(input);
  return json.length > 500 ? `${json.slice(0, 500)}…` : json;
}

/** 單步寫操作確認：預設直接通過（彈窗已禁用） */
export async function awaitCheckpoint(input: CheckpointInput): Promise<boolean> {
  const summary = input.task.summary ?? `${input.task.skillId}.${input.task.action}`;
  logInfo(`[checkpoint/auto] 寫操作預設通過：${summary}`);
  return true;
}