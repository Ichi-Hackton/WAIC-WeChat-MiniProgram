/**
 * 支付引導 SKILL 端點（skill.payment.aicard）
 *
 * 端點（與小程序端 payment-aicard SKILL 呼叫路徑逐字對齊）：
 *   POST /api/skill/skill.payment.aicard/pay_orders
 *
 * 2026-10 六域回補後的語義重定義（原 AI 專屬卡合併收款已因個人主體
 * 無法開通微信支付而不可行）：pay_orders 不再發起 wx.requestPayment，
 * 而是「聚合收銀台引導」——拉取該用戶在全部跳轉域（train / flight /
 * coffee / ticket / booking / shop）的 pending_external 訂單，逐單重建
 * 對應渠道跳轉包，前端渲染為「待辦訂單清單 + 逐單前往渠道收銀台」。
 * 真實支付一律發生在渠道側（12306 / OTA / 星巴克 / 大麥 / 美團 / 京東
 * 收銀台），本端點僅做歸集與引導——用戶在哪一單付、怎麼付完全可控。
 *
 * 跳轉包重建：下單時各域已把 jump 包寫進回應但未持久化，此處按
 * domain → JumpTargetKey 映射用 buildJump 重建（appId / path 仍以
 * EXTERNAL_JUMP 單一來源為準），copyText 從 payload 摘要生成，與
 * 下單時的口徑對齊。
 */

import type { RouteHandler } from './api';
import { ok, unauthorized } from './api';
import { listOrders, type ExternalOrder, type OrderDomain } from './db';
import { buildJump, type JumpTargetKey } from './external-jump';

/** 參與聚合的跳轉域 → 渠道映射（shop_cart 為明細不聚合；trip / metrics 非訂單域） */
const DOMAIN_CHANNEL: Partial<Record<OrderDomain, JumpTargetKey>> = {
  train: 'train_12306',
  flight: 'ota_flight',
  coffee: 'starbucks',
  ticket: 'damai',
  booking: 'meituan',
  shop: 'jd',
};

/** 域 → 用戶可讀名（清單行的分類標籤） */
const DOMAIN_LABEL: Partial<Record<OrderDomain, string>> = {
  train: '高鐵票',
  flight: '機票',
  coffee: '咖啡點單',
  ticket: '演出票務',
  booking: '生活預約',
  shop: '網購清單',
};

/**
 * 從各域 payload 窄化出清單標題與金額（分）
 *
 * 各域 payload 結構不同（train: trainNo/from/to；ticket: eventName；
 * shop: items[]…），此處做白名單窄化，缺欄位以訂單號兜底——聚合
 * 展示不做業務決策，寬容降級即可。
 */
function summarize(order: ExternalOrder): { title: string; amountCent: number } {
  const p = order.payload as Record<string, unknown>;
  const amountCent = typeof p.amountCent === 'number' ? p.amountCent : 0;

  if (order.domain === 'train') {
    return { title: `${String(p.trainNo ?? '車次')} ${String(p.from ?? '')}→${String(p.to ?? '')}`, amountCent };
  }
  if (order.domain === 'flight') {
    return { title: `${String(p.flightNo ?? '航班')} ${String(p.from ?? '')}→${String(p.to ?? '')}`, amountCent };
  }
  if (order.domain === 'ticket') {
    return { title: String(p.eventName ?? '演出票'), amountCent };
  }
  if (order.domain === 'booking') {
    return { title: `${String(p.name ?? '預約')} ${String(p.date ?? '')} ${String(p.startTime ?? '')}`, amountCent };
  }
  if (order.domain === 'shop') {
    const items = Array.isArray(p.items) ? (p.items as Array<{ name?: unknown; quantity?: unknown }>) : [];
    const names = items.map((it) => `${String(it.name ?? '商品')}${typeof it.quantity === 'number' ? ' ×' + it.quantity : ''}`);
    return { title: names.length > 0 ? names.join('、').slice(0, 60) : '購物清單', amountCent };
  }
  if (order.domain === 'coffee') {
    const items = Array.isArray(p.items) ? (p.items as Array<{ name?: unknown; quantity?: unknown }>) : [];
    const names = items.map((it) => `${String(it.name ?? '咖啡')}${typeof it.quantity === 'number' ? ' ×' + it.quantity : ''}`);
    return { title: names.length > 0 ? names.join('、').slice(0, 60) : '咖啡點單', amountCent };
  }
  return { title: order.orderId, amountCent };
}

const handlePayOrders: RouteHandler = async (_body, ctx) => {
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕查詢待支付訂單');
  }

  const domains = Object.keys(DOMAIN_CHANNEL) as OrderDomain[];
  const collected: ExternalOrder[] = [];
  for (const domain of domains) {
    collected.push(...(await listOrders(ctx.openid, domain, ['pending_external'])));
  }
  // 新單優先（跨域合併後統一按建立時間排序）
  collected.sort((a, b) => b.createdAt - a.createdAt);

  const orders = collected.map((o) => {
    const { title, amountCent } = summarize(o);
    const channel = DOMAIN_CHANNEL[o.domain] ?? 'none';
    const domainLabel = DOMAIN_LABEL[o.domain] ?? o.domain;
    const copyText = [`【${domainLabel}】${title}`, `金額 ¥${(amountCent / 100).toFixed(2)}（以渠道下單頁為準）`, `訂單號 ${o.orderId}`].join('\n');
    return {
      orderId: o.orderId,
      domain: o.domain,
      domainLabel,
      title,
      amountCent,
      status: o.status,
      createdAt: o.createdAt,
      jump: buildJump(channel, copyText),
    };
  });

  const totalCent = orders.reduce((s, o) => s + o.amountCent, 0);
  return ok({
    orders,
    count: orders.length,
    totalCent,
    message: orders.length === 0 ? '目前沒有待支付的跳轉訂單。下單後可隨時說「我要支付」回到這裡逐單前往渠道。' : '',
  });
};

export const paymentRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/skill/skill.payment.aicard/pay_orders', handlePayOrders],
];
