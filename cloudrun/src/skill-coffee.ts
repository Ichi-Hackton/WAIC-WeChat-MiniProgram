/**
 * 星巴克咖啡 SKILL 端點
 *
 * 端點（與小程序端 coffee-starbucks SKILL 呼叫路徑逐字對齊）：
 *   POST /api/skill/skill.coffee.starbucks/search_store
 *   POST /api/skill/skill.coffee.starbucks/place_order
 *   POST /api/skill/skill.coffee.starbucks/place_order/cancel
 *
 * MVP 資料來源說明：與 skill-train.ts 相同，返回確定性模擬數據，
 * 訂單存於記憶體 Map（重啟丟失、實例間不共享，正式版應落庫）。
 */

import type { RouteHandler } from './api';
import { ok, fail, badRequest, unauthorized, forbidden } from './api';

/** SKU → 單價（分），未列舉的 SKU 按預設價 */
const SKU_PRICE_CENT: Record<string, number> = {
  latte: 3300,
  americano: 2700,
  cappuccino: 3200,
  caramel_macchiato: 3800,
};
const DEFAULT_PRICE_CENT = 3000;

/** 記憶體訂單表（MVP：重啟丟失、實例間不共享；owner 用於歸屬鑒權） */
const orders = new Map<string, { storeId: string; amountCent: number; owner: string; createdAt: number }>();

interface SearchStoreInput {
  city?: string;
  limit?: number;
}

const handleSearchStore: RouteHandler = async (body) => {
  const input = (body ?? {}) as SearchStoreInput;
  if (!input.city) {
    return badRequest('city 必填');
  }

  const stores = [
    { storeId: 'sb_001', name: `${input.city}中心門市`, address: `${input.city}中山路 1 號`, distanceM: 350, openNow: true },
    { storeId: 'sb_002', name: `${input.city}高鐵站門市`, address: `${input.city}站前廣場`, distanceM: 1200, openNow: true },
    { storeId: 'sb_003', name: `${input.city}萬象城門市`, address: `${input.city}萬象城 L1`, distanceM: 2300, openNow: false },
  ].slice(0, Math.min(Math.max(input.limit ?? 3, 1), 20));

  return ok({ stores });
};

interface PlaceOrderInput {
  storeId?: string;
  pickupType?: string;
  items?: Array<{ sku?: string; name?: string; quantity?: number; size?: string }>;
}

const handlePlaceOrder: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as PlaceOrderInput;
  if (!input.storeId || !input.pickupType || !Array.isArray(input.items) || input.items.length === 0) {
    return badRequest('storeId / pickupType / items 必填（items 不可為空）');
  }
  if (input.pickupType !== 'in_store' && input.pickupType !== 'takeaway') {
    return badRequest('pickupType 必須為 in_store 或 takeaway');
  }
  for (const it of input.items) {
    if (!it.sku || typeof it.quantity !== 'number' || it.quantity < 1) {
      return badRequest('items[].sku 必填且 quantity 必須 ≥ 1');
    }
  }
  // 歸屬鑒權：寫操作必須攜帶雲托管注入的調用方身份（規範 § 10 SKILL 越權防護）
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕下單');
  }

  const items = input.items.map((it) => {
    const unit = SKU_PRICE_CENT[it.sku as string] ?? DEFAULT_PRICE_CENT;
    return {
      sku: it.sku as string,
      name: it.name ?? it.sku,
      quantity: it.quantity as number,
      amountCent: unit * (it.quantity as number),
    };
  });
  const amountCent = items.reduce((s, it) => s + it.amountCent, 0);

  const orderId = `sbx_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  orders.set(orderId, { storeId: input.storeId, amountCent, owner: ctx.openid, createdAt: Date.now() });

  return ok({
    orderId,
    storeId: input.storeId,
    items,
    amountCent,
    status: 'pending_payment',
  });
};

interface CancelInput {
  orderId?: string;
}

const handleCancel: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as CancelInput;
  if (!input.orderId) {
    return badRequest('orderId 必填');
  }
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕取消');
  }
  const order = orders.get(input.orderId);
  if (!order) {
    return fail(404, `訂單不存在或已取消：${input.orderId}`);
  }
  // 歸屬鑒權：僅訂單擁有者可取消（防 IDOR——枚舉 orderId 越權取消他人訂單）
  if (order.owner !== ctx.openid) {
    return forbidden('無權取消他人訂單');
  }
  orders.delete(input.orderId);
  return ok({ ok: true, orderId: input.orderId });
};

export const coffeeRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/skill/skill.coffee.starbucks/search_store', handleSearchStore],
  ['POST /api/skill/skill.coffee.starbucks/place_order', handlePlaceOrder],
  ['POST /api/skill/skill.coffee.starbucks/place_order/cancel', handleCancel],
];
