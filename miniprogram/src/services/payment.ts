/**
 * 微信支付封裝（含 AI 專屬卡）
 *
 * 規範來源：.qoder/rules/Agent.md § 11.3
 */

import { error as logError, warn as logWarn } from '../utils/logger';

/** 大額支付閾值預設值（分）：1000 元（規範 § 10 紅線） */
const DEFAULT_HIGH_VALUE_THRESHOLD_CENT = 100_000;

export interface AICardPaymentRequest {
  /** 多個子訂單 ID（合併支付） */
  orderIds: string[];
  /** Agent 會話 ID，用於 AI 專屬卡溯源 */
  agentSessionId: string;
  /** 時間戳（字串） */
  timeStamp: string;
  /** 業務訂單資訊（用於展示） */
  orderItems: Array<{
    title: string;
    amountCent: number;
    quantity: number;
  }>;
  /** 金額上限（分），超過需二次確認 */
  highValueThresholdCent?: number;
}

export interface PaymentResult {
  success: boolean;
  /** 第三方支付流水號 */
  transactionId?: string;
  /** 錯誤訊息 */
  errorMessage?: string;
}

/**
 * 顯示大額支付二次確認彈窗（§ 10 紅線：金額 > 閾值需二次確認）
 *
 * wx.showModal 不可用（單元測試 / 開發模式）時保守拒絕，
 * 寫操作預設拒絕是安全預設而非可用性預設。
 */
function confirmHighValue(
  totalCent: number,
  items: AICardPaymentRequest['orderItems'],
): Promise<boolean> {
  return new Promise((resolve) => {
    const wxApi = (globalThis as { wx?: { showModal?: (o: unknown) => void } }).wx;
    if (!wxApi?.showModal) {
      logError('大額支付二次確認：wx.showModal 不可用，保守拒絕');
      resolve(false);
      return;
    }
    const lines = items.map(
      (it) => `· ${it.title} × ${it.quantity} = ${formatCents(it.amountCent * it.quantity)}`,
    );
    lines.push(`合計：${formatCents(totalCent)}`);
    wxApi.showModal({
      title: '大額支付二次確認',
      content: [
        `本次支付總額 ${formatCents(totalCent)}，已超過安全閾值，請再次確認：`,
        ...lines,
      ].join('\n'),
      confirmText: '確認支付',
      cancelText: '取消支付',
      success: (res: { confirm: boolean }) => resolve(res.confirm),
      fail: () => resolve(false),
    });
  });
}

/** 呼叫微信 AI 專屬卡支付 */
export async function payWithAICard(req: AICardPaymentRequest): Promise<PaymentResult> {
  // 高額保護（§ 10 紅線）：超過閾值強制二次確認，未確認即取消支付
  const totalCent = req.orderItems.reduce((s, it) => s + it.amountCent * it.quantity, 0);
  const threshold = req.highValueThresholdCent ?? DEFAULT_HIGH_VALUE_THRESHOLD_CENT;
  if (totalCent > threshold) {
    logWarn(
      `大額支付警告：總額 ${formatCents(totalCent)} 超過閾值 ${formatCents(threshold)}，觸發二次確認`,
    );
    const confirmed = await confirmHighValue(totalCent, req.orderItems);
    if (!confirmed) {
      return { success: false, errorMessage: 'HIGH_VALUE_REJECTED：大額支付未經二次確認，已取消' };
    }
  }

  const wxApi = (globalThis as { wx?: {
    requestPayment?: (o: unknown) => Promise<unknown>;
    showToast?: (o: unknown) => void;
  } }).wx;
  if (!wxApi?.requestPayment) {
    return { success: false, errorMessage: 'wx.requestPayment 不可用（開發模式）' };
  }

  try {
    await wxApi.requestPayment({
      provider: 'ai_card',
      timeStamp: req.timeStamp,
      orderIds: req.orderIds,
      agentSessionId: req.agentSessionId,
      // 業務明細
      orderItems: req.orderItems,
    });
    return { success: true, transactionId: `tx_${Date.now()}` };
  } catch (err) {
    logError('AI 卡支付失敗', err);
    return { success: false, errorMessage: String(err) };
  }
}

/** 金額（分）轉顯示字串 */
export function formatCents(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}