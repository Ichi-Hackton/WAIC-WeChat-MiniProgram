/**
 * 微信 AI 專屬卡支付 SKILL
 *
 * 規範來源：.qoder/rules/Agent.md § 11.3
 *
 * 提供能力：
 *   - pay_orders：合併支付多個子訂單（NOT idempotent, requires confirm, reversible）
 *
 * 注意：此 SKILL 為支付閉環樞紐，**所有呼叫必須先經 Planner 產生 Plan**，
 * 並在 Orchestrator 內透過 wx.showModal 二次確認後才可呼叫。
 */

import type { AgentContext } from '../../../types/context';
import type { SkillInstance, SkillResult, SkillMeta } from '../../../types/skill';
import { payWithAICard, type PaymentResult } from '../../../services/payment';
import { error as logError, info as logInfo } from '../../../utils/logger';

export interface PayOrdersInput {
  /** 訂單清單（每筆來自其他 SKILL） */
  orders: Array<{
    orderId: string;
    title: string;
    amountCent: number;
    quantity?: number;
  }>;
  /** 業務場景（如 "trip_train_coffee"） */
  scenario?: string;
}

export interface PayOrdersOutput {
  transactionId: string;
  paidOrders: string[];
  totalCent: number;
  paidAt: number;
}

export const meta = {
  id: 'skill.payment.aicard',
  name: '微信 AI 專屬卡支付',
  description:
    '【能做】合併支付多個子訂單（pay_orders），透過微信 AI 專屬卡一鍵扣款。' +
    '【不能做】不能退款（須走原訂單 SKILL）、不能儲值。' +
    '【觸發時機】當 Plan 中需要付費的 Task（amountCent > 0）已全部 succeeded，且用戶已確認支付時。' +
    '**必須**作為最後一個 Task，依賴所有付費 Task。',
  version: '1.0.0',
  owner: 'wx-micromate',
  tags: ['支付'],
  capabilities: [
    {
      action: 'pay_orders',
      description: '合併支付多個子訂單',
      inputSchema: {
        type: 'object',
        required: ['orders'],
        properties: {
          orders: {
            type: 'array',
            items: {
              type: 'object',
              required: ['orderId', 'title', 'amountCent'],
              properties: {
                orderId: { type: 'string' },
                title: { type: 'string' },
                amountCent: { type: 'integer', minimum: 1 },
                quantity: { type: 'integer', minimum: 1 },
              },
            },
            minItems: 1,
          },
          scenario: { type: 'string' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['transactionId', 'totalCent'],
        properties: {
          transactionId: { type: 'string' },
          totalCent: { type: 'integer' },
        },
      },
      idempotent: false,
      reversible: false, // 退款走原 SKILL，本 SKILL 不可逆
      requiresHumanConfirm: true,
      estimatedLatencyMs: 5000,
    },
  ],
} as unknown as SkillMeta;

export const instance: SkillInstance = {
  meta,
  async invoke(action, input, ctx): Promise<SkillResult> {
    if (action !== 'pay_orders') {
      return {
        success: false,
        error: { code: 'CAPABILITY_NOT_FOUND', message: `${action} 不支援`, retryable: false },
      };
    }
    const req = input as PayOrdersInput;
    if (req.orders.length === 0) {
      return {
        success: false,
        error: { code: 'EMPTY_ORDERS', message: '訂單清單為空', retryable: false },
      };
    }
    const orderIds = req.orders.map((o) => o.orderId);
    const orderItems = req.orders.map((o) => ({
      title: o.title,
      amountCent: o.amountCent,
      quantity: o.quantity ?? 1,
    }));

    const result: PaymentResult = await payWithAICard({
      orderIds,
      orderItems,
      agentSessionId: ctx.sessionId,
      timeStamp: String(Date.now()),
    });

    if (!result.success) {
      // 大額未二次確認屬紅線攔截，錯誤碼獨立於一般支付取消（§ 10）
      const highValueRejected = result.errorMessage?.includes('HIGH_VALUE_REJECTED');
      return {
        success: false,
        error: {
          code: highValueRejected ? 'HIGH_VALUE_REJECTED' : 'PAYMENT_CANCELLED',
          message: result.errorMessage ?? '支付失敗',
          retryable: false,
        },
      };
    }
    const totalCent = orderItems.reduce((s, it) => s + it.amountCent * it.quantity, 0);
    logInfo(`支付成功：${totalCent / 100} 元，訂單數 ${orderIds.length}`);
    return {
      success: true,
      data: {
        transactionId: result.transactionId ?? `tx_${Date.now()}`,
        paidOrders: orderIds,
        totalCent,
        paidAt: Date.now(),
      },
    };
  },
  // 無 rollback：退款須走原訂單 SKILL
  async rollback() {
    logError('AI 卡支付 SKILL 不支援自動 rollback，請走原訂單 SKILL 退款');
  },
};