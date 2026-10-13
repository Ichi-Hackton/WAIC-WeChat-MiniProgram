/**
 * 支付引導 SKILL（skill.payment.aicard）
 *
 * 規範來源：.qoder/rules/Agent.md § 7.1；六環節擴展鏈路第 ③ 環
 *
 * 提供能力：
 *   - pay_orders ：聚合待跳轉訂單並引導渠道收銀台（idempotent, no confirm, 純讀無 rollback）
 *
 * 2026-10 六域回補後的語義重定義：原「AI 專屬卡合併收款」因個人主體
 * 無法開通微信支付而不可行，pay_orders 重定義為「聚合收銀台引導」——
 * 拉取該用戶在全部跳轉域（高鐵/機票/咖啡/票務/預約/網購）的
 * pending_external 訂單，逐單附渠道跳轉包，前端渲染為「待辦訂單清單 +
 * 逐單前往渠道收銀台」。真實支付一律發生在渠道側（12306 / OTA / 星巴克
 * / 大麥 / 美團 / 京東），本 SKILL 不碰任何資金流，純讀聚合——因此
 * 無需鑒權寫保護與 rollback，也無需人類確認（展示清單不打擾用戶）。
 */

import type { AgentContext } from '../../../types/context';
import type { SkillInstance, SkillResult, SkillMeta, JumpPackage } from '../../../types/skill';
import { postContainer, type CloudResponse } from '../../../services/cloud';

/** 聚合清單行（與雲端 skill-payment.ts 的回應結構逐字對齊） */
export interface PayGuideOrder {
  orderId: string;
  /** 訂單所屬域（train/flight/coffee/ticket/booking/shop） */
  domain: string;
  domainLabel: string;
  title: string;
  amountCent: number;
  status: string;
  createdAt: number;
  /** 渠道跳轉包（appId 空 = copy-only，EXTERNAL_JUMP 配置後生效） */
  jump?: JumpPackage;
}

export interface PayOrdersOutput {
  orders: PayGuideOrder[];
  count: number;
  totalCent: number;
  message: string;
}

/** 離線降級文案（雲端不可用時返回空清單，不假裝有訂單） */
const MOCK_EMPTY_OUTPUT: PayOrdersOutput = {
  orders: [],
  count: 0,
  totalCent: 0,
  message: '（離線演示）目前讀不到待支付訂單。網路恢復後再說「我要支付」即可逐單前往渠道收銀台。',
};

export const meta = {
  id: 'skill.payment.aicard',
  name: '支付引導（聚合收銀台）',
  description:
    '【能做】聚合全部待跳轉訂單（pay_orders：高鐵票/機票/咖啡點單/演出票務/生活預約/網購清單），逐單生成渠道跳轉包，引導前往對應官方渠道收銀台完成真實支付。\n' +
    '【不能做】不能在本小程序內直接扣款（真實支付一律在渠道側）、不能退款（須走原渠道訂單）。\n' +
    '【觸發時機】用戶說「支付 / 付款 / 去付錢」或想查看待支付訂單清單時。回傳清單供用戶逐單決定是否前往渠道。（「結帳 / 結算」是購物車結算入口，歸 skill.shopping.mall checkout，勿路由至此）',
  version: '2.0.0',
  owner: 'wx-micromate',
  tags: ['支付'],
  capabilities: [
    {
      action: 'pay_orders',
      description: '聚合全域待跳轉訂單並逐單生成渠道跳轉引導（純讀，無資金流）',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      outputSchema: {
        type: 'object',
        required: ['orders', 'count', 'totalCent'],
        properties: {
          orders: {
            type: 'array',
            description: '待支付訂單清單（每筆附渠道跳轉包）',
            items: { type: 'object' },
          },
          count: { type: 'integer' },
          totalCent: { type: 'integer', description: '合計金額（分，僅供參考，以渠道下單頁為準）' },
          message: { type: 'string' },
        },
      },
      idempotent: true,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 1200,
    },
  ],
} as unknown as SkillMeta;

export const instance: SkillInstance = {
  meta,
  async invoke(action, _input, ctx): Promise<SkillResult> {
    if (action !== 'pay_orders') {
      return {
        success: false,
        error: { code: 'CAPABILITY_NOT_FOUND', message: `${action} 不支援`, retryable: false },
      };
    }
    const env = ctx.globals.cloudEnv as string;
    const res: CloudResponse<PayOrdersOutput> = await postContainer<PayOrdersOutput>(
      env,
      '/api/skill/skill.payment.aicard/pay_orders',
      {},
      { sessionId: ctx.sessionId, retry: false },
    );
    if (res.code === 0 && res.data) return { success: true, data: res.data };
    // 雲端不可用（負數碼 = 雲基礎設施錯誤）：空清單降級，不假裝有訂單
    if (res.code < 0) return { success: true, data: MOCK_EMPTY_OUTPUT };
    return {
      success: false,
      error: { code: 'PAY_GUIDE_FAILED', message: res.message ?? '待支付訂單聚合失敗', retryable: true },
    };
  },
  // 無 rollback：pay_orders 為純讀聚合，不產生需撤銷的副作用
};
